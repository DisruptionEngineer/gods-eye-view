import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeFcode, buildNhdUrl, fetchHydro } from './siteHydro.js';

const BBOX = { west: -97.8, south: 30.2, east: -97.7, north: 30.3 };

test('describeFcode decodes the NHD table with undefined fallback', () => {
  assert.equal(describeFcode(46006), 'Stream/River, perennial');
  assert.equal(describeFcode(39004), 'Lake/Pond, perennial');
  assert.equal(describeFcode(33600), 'Canal/Ditch');
  assert.equal(describeFcode(1), undefined);
});

test('buildNhdUrl targets layer 3 for flowlines and layer 9 for waterbodies', () => {
  const flow = buildNhdUrl('flowlines', BBOX);
  assert.ok(flow.includes('/NHDPlus_HR/MapServer/3/query?'));
  assert.ok(flow.includes('GNIS_NAME%2CFCODE') || flow.includes('GNIS_NAME,FCODE'));
  const water = buildNhdUrl('waterbodies', BBOX);
  assert.ok(water.includes('/NHDPlus_HR/MapServer/9/query?'));
  assert.ok(water.includes('AREASQKM'));
});

test('fetchHydro returns both legs on success', async () => {
  const fc = (n) => ({
    ok: true,
    json: async () => ({ features: Array.from({ length: n }, () => ({ type: 'Feature', geometry: null, properties: {} })) }),
  });
  const payload = await fetchHydro(BBOX, {
    fetchImpl: async (url) => (url.includes('/3/query') ? fc(5) : fc(2)),
  });
  assert.equal(payload.flowlines.features.length, 5);
  assert.equal(payload.waterbodies.features.length, 2);
  assert.equal(payload.partialError, null);
});

test('fetchHydro degrades on one failed leg: keeps the other, reports partial', async () => {
  const payload = await fetchHydro(BBOX, {
    fetchImpl: async (url) => {
      if (url.includes('/9/query')) throw new Error('waterbodies down');
      return { ok: true, json: async () => ({ features: [{ type: 'Feature', geometry: null, properties: {} }] }) };
    },
  });
  assert.equal(payload.flowlines.features.length, 1);
  assert.equal(payload.waterbodies.features.length, 0);
  assert.match(payload.partialError, /waterbodies/);
});

test('fetchHydro throws only when BOTH legs fail', async () => {
  await assert.rejects(
    fetchHydro(BBOX, { fetchImpl: async () => { throw new Error('all down'); } }),
    /all down/,
  );
});
