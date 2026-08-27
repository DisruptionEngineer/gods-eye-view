import * as Cesium from 'cesium';
import { createSiteAreaLayer } from './siteAreaLayer.js';

/**
 * FEMA NFHL flood hazard areas (layer 28), ground-clamped and colored by
 * zone. Near-static data: the shared skeleton's session bbox cache does the
 * heavy lifting. US coverage only — outside it the skeleton skips fetching.
 * Ported from lot-lens src/lib/sources/femaNfhl.ts.
 */

const NFHL_QUERY = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query';

const ZONE_DESCRIPTIONS = Object.freeze({
  AE: '100-yr floodplain (BFE determined)',
  A: '100-yr floodplain (no BFE)',
  AH: '100-yr shallow flooding (1-3ft, BFE)',
  AO: '100-yr shallow flooding (sheet flow)',
  V: '100-yr coastal high-hazard (no BFE)',
  VE: '100-yr coastal high-hazard (BFE)',
  X: 'Outside 100-yr flood zone',
  '0.2 PCT ANNUAL CHANCE FLOOD HAZARD': '500-yr flood hazard',
  D: 'Undetermined risk',
  'OPEN WATER': 'Open water',
});

/** Human description for an NFHL zone code (fallback: the code itself). */
export function zoneDescription(zone) {
  return ZONE_DESCRIPTIONS[zone] || zone;
}

/** [r,g,b,a] bytes per zone family (port of lot-lens colorForZone). */
export function floodColorBytes(zone) {
  const z = String(zone || '').toUpperCase();
  if (z.startsWith('V')) return [220, 38, 38, 110];
  if (z.startsWith('AE') || z === 'A' || z.startsWith('AH') || z.startsWith('AO')) {
    return [251, 146, 60, 110];
  }
  if (z.includes('0.2')) return [251, 191, 36, 90];
  if (z === 'OPEN WATER') return [56, 189, 248, 90];
  return [125, 211, 252, 70];
}

/** ArcGIS envelope query URL for a bbox. */
export function buildNfhlUrl(bbox) {
  const params = new URLSearchParams({
    geometry: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'FLD_ZONE,ZONE_SUBTY,STATIC_BFE,FLD_AR_ID',
    returnGeometry: 'true',
    f: 'geojson',
  });
  return `${NFHL_QUERY}?${params.toString()}`;
}

/**
 * ArcGIS "f=geojson" responses can be HTTP 200 with an embedded error —
 * surface it. Missing features tolerated as empty.
 */
export function parseArcGisFeatureCollection(json) {
  if (json?.error) {
    throw new Error(`ArcGIS ${json.error.code}: ${json.error.message}`);
  }
  return { type: 'FeatureCollection', features: Array.isArray(json?.features) ? json.features : [] };
}

async function fetchFloodZones(bbox, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(buildNfhlUrl(bbox), { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`FEMA NFHL HTTP ${response.status}`);
  return parseArcGisFeatureCollection(await response.json());
}

async function buildFloodDataSources(featureCollection) {
  if (!featureCollection.features.length) return [];
  const ds = await Cesium.GeoJsonDataSource.load(featureCollection, { clampToGround: true });
  for (const entity of ds.entities.values) {
    if (!entity.polygon) continue;
    const zone = entity.properties?.FLD_ZONE?.getValue?.() ?? 'X';
    const [r, g, b, a] = floodColorBytes(zone);
    const color = Cesium.Color.fromBytes(r, g, b, a);
    entity.polygon.material = new Cesium.ColorMaterialProperty(color);
    entity.polygon.outline = true;
    entity.polygon.outlineColor = Cesium.Color.fromBytes(r, g, b, 220);
  }
  return [ds];
}

/**
 * Creates a Cesium layer for FEMA NFHL flood hazard areas.
 */
export function createSiteFloodLayer() {
  return createSiteAreaLayer({
    id: 'site-flood',
    name: 'Flood Zones',
    icon: '🌊',
    source: 'FEMA NFHL',
    fetchArea: (bbox) => fetchFloodZones(bbox),
    buildDataSources: buildFloodDataSources,
    countFeatures: (fc) => ({ count: fc.features.length, error: null }),
  });
}

const siteFloodLayer = createSiteFloodLayer();

export default siteFloodLayer;
