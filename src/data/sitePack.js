import { CITY_POIS } from '../locations.js';

/**
 * Site pack — config-driven knowledge of ONE operator-chosen place.
 *
 * The pack is a gitignored JSON served by the dev server at /api/site (see
 * createSitePackMiddleware in vite.config.js and config/site.example.json).
 * v1 wires the SITE fly-to and the lot anchor for the wind grid; the
 * `sensors[]` / `cameras[]` envelopes are validated and surfaced as counts
 * only — slice 2 (sensor ingestion) fills them in. `version` is the
 * migration point: any value other than 1 disables the site entirely.
 */

const DEG_PER_M_LAT = 1 / 111320;

/** @type {object|null} Normalized pack, set once by initSitePack. */
let _pack = null;

/** Convert meters to degree offsets at a latitude. */
export function metersToDegrees(latDeg, meters) {
  const dLat = meters * DEG_PER_M_LAT;
  const cos = Math.max(0.01, Math.cos((latDeg * Math.PI) / 180));
  return { dLat, dLon: dLat / cos };
}

function finiteInRange(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeRing(raw) {
  if (raw == null) return { ok: true, ring: null };
  if (!Array.isArray(raw)) return { ok: false };
  const ring = [];
  for (const point of raw) {
    if (!Array.isArray(point) || point.length < 2) return { ok: false };
    const lon = finiteInRange(point[0], -180, 180);
    const lat = finiteInRange(point[1], -90, 90);
    if (lon === null || lat === null) return { ok: false };
    ring.push([lon, lat]);
  }
  if (ring.length === 0) return { ok: true, ring: null };
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  if (ring.length < 4) return { ok: false };
  return { ok: true, ring };
}

function normalizeLayerConfig(rawLayers) {
  const raw = rawLayers && typeof rawLayers === 'object' ? rawLayers : {};
  const enabled = (id) => raw[id]?.enabled !== false;
  const rawGrid = Array.isArray(raw['site-wind']?.grid) ? raw['site-wind'].grid : [3, 3];
  return {
    'site-wind': {
      enabled: enabled('site-wind'),
      grid: [
        Math.round(clampNumber(rawGrid[0], 2, 5, 3)),
        Math.round(clampNumber(rawGrid[1], 2, 5, 3)),
      ],
    },
    'site-flood': { enabled: enabled('site-flood') },
    'site-hydro': { enabled: enabled('site-hydro') },
  };
}

function normalizeSensorEnvelopes(raw) {
  if (!Array.isArray(raw)) return [];
  const result = [];
  for (const entry of raw) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
    if (typeof entry.kind !== 'string' || !entry.kind) continue;
    const position = entry.position
      && finiteInRange(entry.position.lat, -90, 90) !== null
      && finiteInRange(entry.position.lon, -180, 180) !== null
      ? { lat: Number(entry.position.lat), lon: Number(entry.position.lon) }
      : null;
    result.push({
      id: entry.id,
      kind: entry.kind,
      label: typeof entry.label === 'string' ? entry.label : null,
      position,
      transport: entry.transport && typeof entry.transport === 'object' ? entry.transport : null,
    });
  }
  return result;
}

/**
 * Validate and normalize a raw site pack.
 * @param {object|null|undefined} raw Parsed /api/site JSON.
 * @returns {{ok: true, pack: object}|{ok: false, reason: string}}
 */
export function normalizeSitePack(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'pack must be an object' };
  if (raw.version !== 1) return { ok: false, reason: `unsupported version: ${raw.version}` };
  const lat = finiteInRange(raw.home?.lat, -90, 90);
  const lon = finiteInRange(raw.home?.lon, -180, 180);
  if (lat === null || lon === null) return { ok: false, reason: 'home.lat/home.lon required' };
  const ring = normalizeRing(raw.lotPolygon);
  if (!ring.ok) return { ok: false, reason: 'lotPolygon must be a ring of >=3 [lon,lat] points' };
  const camera = raw.camera && typeof raw.camera === 'object' ? raw.camera : {};
  return {
    ok: true,
    pack: {
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'SITE',
      home: { lat, lon },
      lotPolygon: ring.ring,
      neighborhoodHalfM: clampNumber(raw.neighborhoodHalfM, 100, 2000, 500),
      camera: {
        headingDeg: clampNumber(camera.headingDeg, 0, 360, 0),
        pitchDeg: clampNumber(camera.pitchDeg, -90, 0, -35),
        rangeM: clampNumber(camera.rangeM, 100, 20000, 400),
      },
      layers: normalizeLayerConfig(raw.layers),
      sensors: normalizeSensorEnvelopes(raw.sensors),
      cameras: normalizeSensorEnvelopes(raw.cameras),
    },
  };
}

/** Inject the site as a fly-to "city" so the existing pill row renders it. */
function registerSiteLocation(pack) {
  const { dLat, dLon } = metersToDegrees(pack.home.lat, pack.neighborhoodHalfM);
  CITY_POIS.site = {
    name: pack.name,
    groundElevation: 0,
    viewBounds: {
      southwest: { lat: pack.home.lat - dLat, lng: pack.home.lon - dLon },
      northeast: { lat: pack.home.lat + dLat, lng: pack.home.lon + dLon },
    },
    pois: [{
      name: pack.name,
      lat: pack.home.lat,
      lon: pack.home.lon,
      alt: pack.camera.rangeM,
      pitch: pack.camera.pitchDeg,
      heading: pack.camera.headingDeg,
      buildingHeight: 10,
    }],
  };
}

/**
 * Fetch and install the site pack. Any failure — 404, network, invalid
 * schema — resolves to null and leaves the app in stock (siteless) shape.
 * Call once during boot, BEFORE the UI builds its location pills.
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] Injected fetch for tests.
 * @returns {Promise<object|null>} The normalized pack, or null.
 */
export async function initSitePack({ fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl('/api/site', {
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(2000)
        : undefined,
    });
    if (!response.ok) return null;
    const raw = await response.json();
    const result = normalizeSitePack(raw);
    if (!result.ok) {
      console.warn(`[SitePack] Invalid pack — site disabled: ${result.reason}`);
      return null;
    }
    _pack = result.pack;
    registerSiteLocation(_pack);
    console.log(
      `[SitePack] Loaded "${_pack.name}" `
      + `(${_pack.sensors.length} planned sensors, ${_pack.cameras.length} planned cameras)`,
    );
    return _pack;
  } catch (e) {
    console.warn('[SitePack] Unavailable:', e?.message || e);
    return null;
  }
}

/** @returns {object|null} The normalized site pack, or null when siteless. */
export function getSitePack() {
  return _pack;
}

/** @returns {{west:number,south:number,east:number,north:number}|null} */
export function siteBounds() {
  if (!_pack) return null;
  const { dLat, dLon } = metersToDegrees(_pack.home.lat, _pack.neighborhoodHalfM);
  return {
    west: _pack.home.lon - dLon,
    south: _pack.home.lat - dLat,
    east: _pack.home.lon + dLon,
    north: _pack.home.lat + dLat,
  };
}

/** Whether a lat/lon falls inside the site neighborhood. */
export function isOverSite(lat, lon) {
  const bounds = siteBounds();
  if (!bounds) return false;
  return lat >= bounds.south && lat <= bounds.north
    && lon >= bounds.west && lon <= bounds.east;
}

/** Test-only: clear module state between cases. */
export function _resetSitePackForTest() {
  _pack = null;
  delete CITY_POIS.site;
}
