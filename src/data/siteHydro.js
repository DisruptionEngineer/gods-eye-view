import * as Cesium from 'cesium';
import { createSiteAreaLayer } from './siteAreaLayer.js';
import { parseArcGisFeatureCollection } from './siteFlood.js';

/**
 * USGS NHDPlus HR hydrology: flowlines (layer 3 — NetworkNHDFlowline, the
 * connected stream network; layer 4 is disconnected fragments, do not
 * "fix" this to 4) and waterbodies (layer 9), fetched in parallel with
 * degraded-but-honest partial results. Ported from lot-lens
 * src/lib/sources/usgsNhd.ts.
 */

const NHD_BASE = 'https://hydro.nationalmap.gov/arcgis/rest/services/NHDPlus_HR/MapServer';
const LEGS = Object.freeze({
  flowlines: { layer: 3, outFields: 'GNIS_NAME,FCODE' },
  waterbodies: { layer: 9, outFields: 'GNIS_NAME,FCODE,AREASQKM' },
});

const FCODE_DESC = Object.freeze({
  46000: 'Stream/River',
  46003: 'Stream/River, intermittent',
  46006: 'Stream/River, perennial',
  46007: 'Stream/River, ephemeral',
  55800: 'Artificial path',
  33600: 'Canal/Ditch',
  33601: 'Canal/Ditch, aqueduct',
  39000: 'Lake/Pond',
  39004: 'Lake/Pond, perennial',
  39005: 'Lake/Pond, intermittent',
  43600: 'Reservoir',
  46600: 'Swamp/Marsh',
});

/** Human description for an NHD FCODE, or undefined. */
export function describeFcode(code) {
  return FCODE_DESC[code];
}

/** ArcGIS envelope query URL for one hydro leg. */
export function buildNhdUrl(leg, bbox) {
  const spec = LEGS[leg];
  const params = new URLSearchParams({
    geometry: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: spec.outFields,
    returnGeometry: 'true',
    f: 'geojson',
  });
  return `${NHD_BASE}/${spec.layer}/query?${params.toString()}`;
}

const EMPTY_FC = () => ({ type: 'FeatureCollection', features: [] });

/**
 * Fetch both hydro legs in parallel. One failed leg degrades (empty features
 * + partialError naming the leg); both failing throws.
 */
export async function fetchHydro(bbox, { fetchImpl = fetch } = {}) {
  const fetchLeg = async (leg) => {
    const response = await fetchImpl(buildNhdUrl(leg, bbox), { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`NHD ${leg} HTTP ${response.status}`);
    return parseArcGisFeatureCollection(await response.json());
  };
  const [flow, water] = await Promise.allSettled([fetchLeg('flowlines'), fetchLeg('waterbodies')]);
  if (flow.status === 'rejected' && water.status === 'rejected') throw flow.reason;
  const failed = [];
  if (flow.status === 'rejected') failed.push(`flowlines: ${flow.reason?.message}`);
  if (water.status === 'rejected') failed.push(`waterbodies: ${water.reason?.message}`);
  return {
    flowlines: flow.status === 'fulfilled' ? flow.value : EMPTY_FC(),
    waterbodies: water.status === 'fulfilled' ? water.value : EMPTY_FC(),
    partialError: failed.length ? `PARTIAL — ${failed.join('; ')}` : null,
  };
}

const FLOWLINE_COLOR = Cesium.Color.fromBytes(103, 232, 249, 200);
const WATERBODY_COLOR = Cesium.Color.fromBytes(56, 189, 248, 90);

async function buildHydroDataSources(payload) {
  const sources = [];
  if (payload.waterbodies.features.length) {
    const ds = await Cesium.GeoJsonDataSource.load(payload.waterbodies, { clampToGround: true });
    for (const entity of ds.entities.values) {
      if (!entity.polygon) continue;
      entity.polygon.material = new Cesium.ColorMaterialProperty(WATERBODY_COLOR);
      entity.polygon.outline = false;
    }
    sources.push(ds);
  }
  if (payload.flowlines.features.length) {
    const ds = await Cesium.GeoJsonDataSource.load(payload.flowlines, { clampToGround: true });
    for (const entity of ds.entities.values) {
      if (!entity.polyline) continue;
      entity.polyline.material = new Cesium.ColorMaterialProperty(FLOWLINE_COLOR);
      entity.polyline.width = 3;
    }
    sources.push(ds);
  }
  return sources;
}

/**
 * Creates a Cesium layer for USGS NHDPlus HR hydrology data.
 */
export function createSiteHydroLayer() {
  return createSiteAreaLayer({
    id: 'site-hydro',
    name: 'Hydrology',
    icon: '💧',
    source: 'USGS NHD',
    fetchArea: (bbox) => fetchHydro(bbox),
    buildDataSources: buildHydroDataSources,
    countFeatures: (payload) => ({
      count: payload.flowlines.features.length + payload.waterbodies.features.length,
      error: payload.partialError,
    }),
  });
}

const siteHydroLayer = createSiteHydroLayer();

export default siteHydroLayer;
