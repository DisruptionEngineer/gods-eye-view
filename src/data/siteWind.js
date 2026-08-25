import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import { screenProjectedRotation } from './iconOrientation.js';
import { getSitePack, isOverSite, metersToDegrees } from './sitePack.js';

/**
 * Site wind grid — Open-Meteo point samples rendered as ground-clamped
 * arrows with speed cards.
 *
 * MODELED data, and labeled that way: Open-Meteo interpolates forecast
 * model output; nothing here is a measurement. Slice 2 replaces samples
 * with MEASURED sensor readings at the same seam.
 *
 * Anchoring: over the site (sitePack.isOverSite) the pack's N-by-N lattice
 * covers the lot polygon; elsewhere a 3x3 lattice tracks the camera target.
 * Camera-driven via camera.moveEnd (fetch-on-settle) — deliberately NOT the
 * traffic layer's camera.changed + percentageChanged pattern, which mutates
 * a shared camera global that concurrent layers would fight over.
 *
 * No per-frame animator: arrows are static between refreshes, and the
 * billboard rotation CallbackProperty is only re-evaluated on frames some
 * other source already scheduled. No render-governor hold.
 */

export const WIND_ACTIVATION_ALTITUDE_M = 6000;
export const SITE_WIND_OVERLAY_SOURCE_ID = 'site-wind';
const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
const DEG_PER_M_LAT = 1 / 111320;

/** Inclusive nx-by-ny lattice over a [lon,lat] ring's bounding box. */
export function gridPointsForRing(ring, [nx, ny]) {
  let west = Infinity; let south = Infinity; let east = -Infinity; let north = -Infinity;
  for (const [lon, lat] of ring) {
    west = Math.min(west, lon); east = Math.max(east, lon);
    south = Math.min(south, lat); north = Math.max(north, lat);
  }
  const points = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      points.push({
        lat: south + ((north - south) * j) / (ny - 1),
        lon: west + ((east - west) * i) / (nx - 1),
      });
    }
  }
  return points;
}

/** nx-by-ny lattice spanning spanM meters, centered on an anchor. */
export function gridPointsForViewport(anchor, spanM, [nx, ny]) {
  const { dLat, dLon } = metersToDegrees(anchor.lat, spanM / 2);
  const points = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      points.push({
        lat: anchor.lat - dLat + ((2 * dLat) * j) / (ny - 1),
        lon: anchor.lon - dLon + ((2 * dLon) * i) / (nx - 1),
      });
    }
  }
  return points;
}

/** One multi-point Open-Meteo request for all lattice points. */
export function buildWindGridUrl(points) {
  const params = new URLSearchParams({
    latitude: points.map((p) => p.lat).join(','),
    longitude: points.map((p) => p.lon).join(','),
    current: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    wind_speed_unit: 'ms',
  });
  return `${OPEN_METEO_URL}?${params.toString()}`;
}

/**
 * Map an Open-Meteo multi-point response onto the request lattice.
 * wind_direction_10m is meteorological (blowing FROM); arrows point TO:
 * toDeg = (fromDeg + 180) % 360. Points with no `current` block are skipped.
 */
export function parseOpenMeteoSamples(json, points) {
  const rows = Array.isArray(json) ? json : [json];
  const samples = [];
  for (let i = 0; i < points.length && i < rows.length; i++) {
    const current = rows[i]?.current;
    const speed = Number(current?.wind_speed_10m);
    const fromDeg = Number(current?.wind_direction_10m);
    if (!Number.isFinite(speed) || !Number.isFinite(fromDeg)) continue;
    const gust = Number(current?.wind_gusts_10m);
    samples.push({
      lat: points[i].lat,
      lon: points[i].lon,
      speedMs: speed,
      gustMs: Number.isFinite(gust) ? gust : null,
      fromDeg,
      toDeg: (fromDeg + 180) % 360,
    });
  }
  return samples;
}

/** Card accent by speed band: calm cyan, moderate green, strong amber. */
export function windAccent(speedMs) {
  if (speedMs < 3) return 'rgba(140, 220, 255, 0.95)';
  if (speedMs < 8) return 'rgba(120, 235, 170, 0.95)';
  return 'rgba(255, 196, 110, 0.95)';
}

/** Whether the anchor moved far enough (a third of the span) to refetch. */
export function windRefetchNeeded(prevAnchor, nextAnchor, spanM) {
  if (!prevAnchor) return true;
  const dLatM = (nextAnchor.lat - prevAnchor.lat) / DEG_PER_M_LAT;
  const cos = Math.max(0.01, Math.cos((prevAnchor.lat * Math.PI) / 180));
  const dLonM = ((nextAnchor.lon - prevAnchor.lon) / DEG_PER_M_LAT) * cos;
  return Math.hypot(dLatM, dLonM) > spanM / 3;
}

/** Up-pointing arrow sprite; billboard rotation supplies the bearing. */
function buildArrowImage() {
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.translate(size / 2, size / 2);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(6, 20, 26, 0.9)';
  ctx.lineWidth = 7;
  const arrow = () => {
    ctx.beginPath();
    ctx.moveTo(0, 16);
    ctx.lineTo(0, -14);
    ctx.moveTo(-8, -5);
    ctx.lineTo(0, -16);
    ctx.lineTo(8, -5);
    ctx.stroke();
  };
  arrow();
  ctx.strokeStyle = 'rgba(200, 240, 255, 0.95)';
  ctx.lineWidth = 3;
  arrow();
  return canvas;
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

/** Create the site-wind layer module (Open-Meteo grid, camera-gated). @returns {object} Layer module for DataLayerManager. */
export function createSiteWindLayer() {
  let _viewer = null;
  let _dataSource = null;
  let _arrowImage = null;
  let _enabled = false;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _lastAnchor = null;
  let _lastSpanM = 0;
  let _lastFailureAt = 0;
  let _moveEndRemover = null;
  const FAILURE_COOLDOWN_MS = 30000;

  const overlayHost = {
    setEntries: setOverlayEntries,
    setVisible: setOverlaySourceVisible,
    clearSource: clearOverlaySource,
  };

  function altitudeM() {
    const carto = _viewer?.camera?.positionCartographic;
    return carto ? carto.height : Infinity;
  }

  function currentPlan() {
    const pack = getSitePack();
    const anchor = viewportAnchor(_viewer);
    if (!anchor) return null;
    if (pack && isOverSite(anchor.lat, anchor.lon)) {
      const grid = pack.layers['site-wind'].grid;
      const points = pack.lotPolygon
        ? gridPointsForRing(pack.lotPolygon, grid)
        : gridPointsForViewport(pack.home, pack.neighborhoodHalfM * 2, grid);
      return { anchor: pack.home, spanM: pack.neighborhoodHalfM * 2, points };
    }
    const spanM = Math.min(4000, Math.max(500, altitudeM() * 0.8));
    return { anchor, spanM, points: gridPointsForViewport(anchor, spanM, [3, 3]) };
  }

  function clearSamples() {
    if (_dataSource) _dataSource.entities.removeAll();
    overlayHost.clearSource(SITE_WIND_OVERLAY_SOURCE_ID);
    _count = 0;
  }

  function renderSamples(samples) {
    if (!_dataSource) return;
    _dataSource.entities.removeAll();
    const overlayEntries = [];
    const scene = _viewer.scene;
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      const position = Cesium.Cartesian3.fromDegrees(sample.lon, sample.lat);
      let previousRotation = 0;
      _dataSource.entities.add({
        id: `site-wind:${i}`,
        position,
        billboard: {
          image: _arrowImage,
          rotation: new Cesium.CallbackProperty(() => {
            previousRotation = screenProjectedRotation(
              scene, position, sample.toDeg, previousRotation,
            ) ?? previousRotation;
            return previousRotation;
          }, false),
          alignedAxis: Cesium.Cartesian3.ZERO,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          scale: 0.6 + Math.min(0.5, sample.speedMs / 16),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      const gust = sample.gustMs != null ? ` G ${sample.gustMs.toFixed(1)}` : '';
      overlayEntries.push({
        id: `site-wind:${i}`,
        position,
        variant: 'label',
        title: `${sample.speedMs.toFixed(1)} m/s${gust}`,
        accent: windAccent(sample.speedMs),
        priority: Math.round(sample.speedMs * 100),
        collisionGroup: 'ambient-label',
        paintLane: 'ambient-label',
        interactive: false,
        edgeFade: 'keyhole',
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 18,
        verticalOnly: true,
        placement: 'above',
      });
    }
    overlayHost.setEntries(SITE_WIND_OVERLAY_SOURCE_ID, overlayEntries, {
      cohortLimit: 25,
      collisionCapacity: 16,
      moving: false,
    });
    _count = samples.length;
  }

  // Direct fetch, NOT createRetryableLoader: that helper memoizes success
  // permanently (one-shot catalog loads) and would pin the first grid
  // forever. Failure cooldown keeps a panning camera from hammering a
  // broken upstream; the 10-min manager tick forces past it.
  async function refetch(plan) {
    const response = await fetch(buildWindGridUrl(plan.points));
    if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
    const samples = parseOpenMeteoSamples(await response.json(), plan.points);
    _lastAnchor = plan.anchor;
    _lastSpanM = plan.spanM;
    renderSamples(samples);
    _lastUpdate = Date.now();
    _lastError = null;
  }

  async function refresh({ force = false } = {}) {
    if (!_enabled) return;
    if (altitudeM() > WIND_ACTIVATION_ALTITUDE_M) {
      clearSamples();
      _lastAnchor = null;
      return;
    }
    const plan = currentPlan();
    if (!plan) return;
    if (!force && !windRefetchNeeded(_lastAnchor, plan.anchor, _lastSpanM || plan.spanM)) return;
    if (!force && Date.now() - _lastFailureAt < FAILURE_COOLDOWN_MS) return;
    try {
      await refetch(plan);
    } catch (e) {
      _lastFailureAt = Date.now();
      _lastError = e?.message || 'Open-Meteo error';
      console.warn('[Data:SiteWind]', _lastError);
    }
  }

  const onMoveEnd = () => { void refresh(); };

  const layer = {
    id: 'site-wind',
    name: 'Wind Grid',
    icon: '💨',
    source: 'Open-Meteo (modeled)',
    updateInterval: 600000,

    init(viewer) {
      _viewer = viewer;
      _arrowImage = buildArrowImage();
      _dataSource = new Cesium.CustomDataSource('site-wind');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      overlayHost.setVisible(SITE_WIND_OVERLAY_SOURCE_ID, false);
      console.log('[Data:SiteWind] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(SITE_WIND_OVERLAY_SOURCE_ID, true);
      viewer.camera.moveEnd.addEventListener(onMoveEnd);
      _moveEndRemover = () => viewer.camera.moveEnd.removeEventListener(onMoveEnd);
      void refresh({ force: true });
    },

    disable(viewer) {
      _enabled = false;
      if (_moveEndRemover) { _moveEndRemover(); _moveEndRemover = null; }
      if (_dataSource) _dataSource.show = false;
      clearSamples();
      overlayHost.setVisible(SITE_WIND_OVERLAY_SOURCE_ID, false);
      _lastAnchor = null;
    },

    async update() {
      await refresh({ force: true });
      return _lastError === null;
    },

    destroy(viewer) {
      this.disable(viewer);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
  return layer;
}

const siteWindLayer = createSiteWindLayer();

export default siteWindLayer;
