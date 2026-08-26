import * as Cesium from 'cesium';
import { siteBounds, isOverSite, metersToDegrees } from './sitePack.js';
import { governorRequestRender } from '../renderGovernor.js';

/**
 * Shared skeleton for camera-driven, bbox-fetching area layers (site-flood,
 * site-hydro). Fetch-on-settle via camera.moveEnd — see siteWind.js for why
 * NOT camera.changed + percentageChanged. updateInterval stays 0: the
 * manager treats that as "camera-driven, repaint stats only"
 * (src/data/manager.js _armUpdateLoop).
 */

export const AREA_ACTIVATION_ALTITUDE_M = 15000;

/** Session cache key: bbox rounded to quantDeg so tiny pans coalesce. */
export function quantizedBboxKey(bbox, quantDeg = 0.01) {
  const q = (v) => (Math.round(v / quantDeg) * quantDeg).toFixed(4);
  return `${q(bbox.west)},${q(bbox.south)},${q(bbox.east)},${q(bbox.north)}`;
}

/** Viewport bbox: span 1.5x altitude, clamped to 1..12 km. */
export function viewportBboxForAnchor(anchor, altitudeM) {
  const spanM = Math.min(12000, Math.max(1000, altitudeM * 1.5));
  const { dLat, dLon } = metersToDegrees(anchor.lat, spanM / 2);
  return {
    west: anchor.lon - dLon,
    south: anchor.lat - dLat,
    east: anchor.lon + dLon,
    north: anchor.lat + dLat,
  };
}

/** Rough NFHL/NHD coverage envelope (CONUS + AK + HI + PR). */
export function inUsCoverage(bbox) {
  return bbox.south <= 72 && bbox.north >= 17 && bbox.west <= -64 && bbox.east >= -180;
}

function viewportAnchor(viewer) {
  const camera = viewer?.camera;
  const scene = viewer?.scene;
  if (!camera) return null;
  let cartographic = null;
  const canvas = scene?.canvas;
  if (canvas && typeof camera.pickEllipsoid === 'function') {
    const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const position = camera.pickEllipsoid(center, scene.globe?.ellipsoid || Cesium.Ellipsoid.WGS84);
    if (position) cartographic = Cesium.Cartographic.fromCartesian(position);
  }
  cartographic ||= camera.positionCartographic || null;
  if (!cartographic) return null;
  return {
    lat: Cesium.Math.toDegrees(cartographic.latitude),
    lon: Cesium.Math.toDegrees(cartographic.longitude),
  };
}

/**
 * Build a camera-driven area layer.
 * @param {object} config
 * @param {string} config.id Layer id (kebab).
 * @param {string} config.name Toggle-row name.
 * @param {string} config.icon Toggle-row emoji.
 * @param {string} config.source Attribution string.
 * @param {number} [config.gateAltitudeM] Activation ceiling (default 15 km).
 * @param {Function} config.fetchArea async (bbox) => payload.
 * @param {Function} config.buildDataSources async (payload) => Cesium.DataSource[].
 * @param {Function} config.countFeatures (payload) => {count, error}.
 * @returns {object} Layer module for DataLayerManager.
 */
export function createSiteAreaLayer({
  id, name, icon, source,
  gateAltitudeM = AREA_ACTIVATION_ALTITUDE_M,
  fetchArea, buildDataSources, countFeatures,
}) {
  let _viewer = null;
  let _enabled = false;
  let _dataSources = [];
  let _lastKey = null;
  let _fetching = false;
  let _pendingRefresh = false;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _moveEndRemover = null;
  const _cache = new Map();

  function altitudeM() {
    const carto = _viewer?.camera?.positionCartographic;
    return carto ? carto.height : Infinity;
  }

  async function removeDataSources() {
    for (const ds of _dataSources) {
      _viewer.dataSources.remove(ds, true);
    }
    _dataSources = [];
  }

  async function present(payload) {
    await removeDataSources();
    const sources = await buildDataSources(payload);
    for (const ds of sources) {
      await _viewer.dataSources.add(ds);
      ds.show = _enabled;
    }
    _dataSources = sources;
    const { count, error } = countFeatures(payload);
    _count = count;
    _lastError = error;
    _lastUpdate = Date.now();
  }

  async function refresh() {
    if (!_enabled) return;
    if (_fetching) {
      // A camera settle during an in-flight fetch must not be dropped:
      // re-evaluate the viewport once the current fetch completes.
      _pendingRefresh = true;
      return;
    }

    if (altitudeM() > gateAltitudeM) {
      // Clear the key gate too: without this, re-descending into the SAME
      // bbox would hit the key-unchanged skip and never reload (traffic H5).
      await removeDataSources();
      _lastKey = null;
      _count = 0;
      _lastError = null;
      governorRequestRender(`${id}-data`);
      return;
    }

    const anchor = viewportAnchor(_viewer);
    if (!anchor) return;
    const bbox = isOverSite(anchor.lat, anchor.lon)
      ? siteBounds()
      : viewportBboxForAnchor(anchor, altitudeM());
    const key = quantizedBboxKey(bbox);
    if (key === _lastKey) return;

    if (!inUsCoverage(bbox)) {
      await removeDataSources();
      _lastKey = key;
      _count = 0;
      _lastError = null;
      governorRequestRender(`${id}-data`);
      console.log(`[Data:${name}] Outside US coverage — nothing to fetch`);
      return;
    }

    _fetching = true;
    try {
      let payload = _cache.get(key);
      if (!payload) {
        payload = await fetchArea(bbox);
        _cache.set(key, payload);
      }
      _lastKey = key;
      await present(payload);
      governorRequestRender(`${id}-data`);
    } catch (e) {
      _lastError = e?.message || `${source} error`;
      console.warn(`[Data:${name}]`, _lastError);
    } finally {
      _fetching = false;
      if (_pendingRefresh) {
        _pendingRefresh = false;
        void refresh();
      }
    }
  }

  const onMoveEnd = () => { void refresh(); };

  return {
    id,
    name,
    icon,
    source,
    updateInterval: 0,

    init(viewer) {
      _viewer = viewer;
      console.log(`[Data:${name}] Initialized`);
    },

    enable(viewer) {
      _enabled = true;
      for (const ds of _dataSources) ds.show = true;
      viewer.camera.moveEnd.addEventListener(onMoveEnd);
      _moveEndRemover = () => viewer.camera.moveEnd.removeEventListener(onMoveEnd);
      void refresh();
    },

    disable() {
      _enabled = false;
      if (_moveEndRemover) { _moveEndRemover(); _moveEndRemover = null; }
      for (const ds of _dataSources) ds.show = false;
    },

    async update() {
      return _lastError === null;
    },

    destroy(viewer) {
      this.disable();
      for (const ds of _dataSources) viewer.dataSources.remove(ds, true);
      _dataSources = [];
      _cache.clear();
      _lastKey = null;
      _viewer = null;
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
}
