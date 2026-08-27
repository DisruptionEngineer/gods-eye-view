import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  floodColorBytes,
  zoneDescription,
  buildNfhlUrl,
  parseArcGisFeatureCollection,
} from './siteFlood.js';

test('floodColorBytes: coastal red, 100-yr orange, water blue, default light', () => {
  assert.deepEqual(floodColorBytes('VE'), [220, 38, 38, 110]);
  assert.deepEqual(floodColorBytes('V'), [220, 38, 38, 110]);
  assert.deepEqual(floodColorBytes('AE'), [251, 146, 60, 110]);
  assert.deepEqual(floodColorBytes('AO'), [251, 146, 60, 110]);
  assert.deepEqual(floodColorBytes('0.2 PCT ANNUAL CHANCE FLOOD HAZARD'), [251, 191, 36, 90]);
  assert.deepEqual(floodColorBytes('OPEN WATER'), [56, 189, 248, 90]);
  assert.deepEqual(floodColorBytes('X'), [125, 211, 252, 70]);
});

test('zoneDescription covers the NFHL zone table with a fallback', () => {
  assert.equal(zoneDescription('AE'), '100-yr floodplain (BFE determined)');
  assert.equal(zoneDescription('V'), '100-yr coastal high-hazard (no BFE)');
  assert.equal(zoneDescription('MYSTERY'), 'MYSTERY');
});

test('buildNfhlUrl shapes the ArcGIS envelope query', () => {
  const url = buildNfhlUrl({ west: -97.8, south: 30.2, east: -97.7, north: 30.3 });
  assert.ok(url.startsWith('https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?'));
  assert.ok(url.includes('geometryType=esriGeometryEnvelope'));
  assert.ok(url.includes('f=geojson'));
  assert.ok(url.includes('FLD_ZONE'));
});

test('parseArcGisFeatureCollection surfaces embedded ArcGIS errors and tolerates empties', () => {
  assert.throws(
    () => parseArcGisFeatureCollection({ error: { code: 400, message: 'bad envelope' } }),
    /bad envelope/,
  );
  assert.deepEqual(parseArcGisFeatureCollection({}).features, []);
  const fc = parseArcGisFeatureCollection({
    features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: { FLD_ZONE: 'AE' } }],
  });
  assert.equal(fc.features.length, 1);
});
