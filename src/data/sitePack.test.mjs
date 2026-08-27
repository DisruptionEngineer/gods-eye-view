import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSitePack,
  metersToDegrees,
  initSitePack,
  getSitePack,
  siteBounds,
  isOverSite,
  _resetSitePackForTest,
} from './sitePack.js';

const VALID = () => ({
  version: 1,
  name: 'Test Site',
  home: { lat: 30.2669, lon: -97.7729 },
  lotPolygon: [[-97.774, 30.266], [-97.772, 30.266], [-97.772, 30.268], [-97.774, 30.268], [-97.774, 30.266]],
  neighborhoodHalfM: 500,
  camera: { headingDeg: 90, pitchDeg: -40, rangeM: 300 },
  layers: { 'site-wind': { enabled: true, grid: [3, 3] } },
  sensors: [],
  cameras: [],
});

test('accepts a valid pack and preserves fields', () => {
  const result = normalizeSitePack(VALID());
  assert.equal(result.ok, true);
  assert.equal(result.pack.name, 'Test Site');
  assert.equal(result.pack.home.lat, 30.2669);
  assert.equal(result.pack.camera.headingDeg, 90);
  assert.deepEqual(result.pack.layers['site-wind'].grid, [3, 3]);
});

test('rejects missing home and non-1 versions', () => {
  const noHome = VALID();
  delete noHome.home;
  assert.equal(normalizeSitePack(noHome).ok, false);
  const v2 = VALID();
  v2.version = 2;
  assert.equal(normalizeSitePack(v2).ok, false);
  assert.equal(normalizeSitePack(null).ok, false);
  assert.equal(normalizeSitePack({ version: 1, home: { lat: 999, lon: 0 } }).ok, false);
});

test('defaults: name, layers, camera, neighborhoodHalfM, null polygon', () => {
  const result = normalizeSitePack({ version: 1, home: { lat: 10, lon: 20 } });
  assert.equal(result.ok, true);
  const p = result.pack;
  assert.equal(p.name, 'SITE');
  assert.equal(p.lotPolygon, null);
  assert.equal(p.neighborhoodHalfM, 500);
  assert.deepEqual(p.camera, { headingDeg: 0, pitchDeg: -35, rangeM: 400 });
  assert.equal(p.layers['site-wind'].enabled, true);
  assert.deepEqual(p.layers['site-wind'].grid, [3, 3]);
  assert.equal(p.layers['site-flood'].enabled, true);
  assert.equal(p.layers['site-hydro'].enabled, true);
});

test('closes an unclosed ring; rejects rings under 4 points after closing', () => {
  const open = VALID();
  open.lotPolygon = [[-97.774, 30.266], [-97.772, 30.266], [-97.772, 30.268]];
  const result = normalizeSitePack(open);
  assert.equal(result.ok, true);
  const ring = result.pack.lotPolygon;
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.equal(ring.length, 4);

  const tiny = VALID();
  tiny.lotPolygon = [[-97.774, 30.266], [-97.772, 30.266]];
  assert.equal(normalizeSitePack(tiny).ok, false);
});

test('clamps neighborhoodHalfM to 100..2000 and grid axes to 2..5', () => {
  const p = VALID();
  p.neighborhoodHalfM = 99999;
  p.layers['site-wind'].grid = [1, 9];
  const result = normalizeSitePack(p);
  assert.equal(result.pack.neighborhoodHalfM, 2000);
  assert.deepEqual(result.pack.layers['site-wind'].grid, [2, 5]);
});

test('tolerates unknown sensor kinds; rejects sensors without id/kind', () => {
  const p = VALID();
  p.sensors = [
    { id: 'anem-1', kind: 'quantum-flux-anemometer', position: { lat: 30.2, lon: -97.7 } },
    { kind: 'no-id' },
  ];
  const result = normalizeSitePack(p);
  assert.equal(result.ok, true);
  assert.equal(result.pack.sensors.length, 1);
  assert.equal(result.pack.sensors[0].kind, 'quantum-flux-anemometer');
});

test('metersToDegrees is symmetric at the equator and widens with latitude', () => {
  const eq = metersToDegrees(0, 111320);
  assert.ok(Math.abs(eq.dLat - 1) < 0.01);
  assert.ok(Math.abs(eq.dLon - 1) < 0.01);
  const north = metersToDegrees(60, 111320);
  assert.ok(north.dLon > 1.9);
});

test('initSitePack: 404 → null pack, no site helpers', async () => {
  _resetSitePackForTest();
  const pack = await initSitePack({
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  assert.equal(pack, null);
  assert.equal(getSitePack(), null);
  assert.equal(siteBounds(), null);
  assert.equal(isOverSite(30, -97), false);
});

test('initSitePack: valid pack → helpers live + CITY_POIS.site injected', async () => {
  _resetSitePackForTest();
  const pack = await initSitePack({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => VALID() }),
  });
  assert.equal(pack.name, 'Test Site');
  const bounds = siteBounds();
  assert.ok(bounds.west < -97.7729 && bounds.east > -97.7729);
  assert.equal(isOverSite(30.2669, -97.7729), true);
  assert.equal(isOverSite(31.5, -97.7729), false);
  const { CITY_POIS } = await import('../locations.js');
  assert.equal(CITY_POIS.site.name, 'Test Site');
  assert.equal(CITY_POIS.site.pois[0].lat, 30.2669);
  assert.equal(CITY_POIS.site.pois[0].alt, 300);
  assert.equal(CITY_POIS.site.pois[0].heading, 90);
  delete CITY_POIS.site;
});

test('initSitePack: invalid pack disables everything with a warning', async () => {
  _resetSitePackForTest();
  const pack = await initSitePack({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ version: 7 }) }),
  });
  assert.equal(pack, null);
  assert.equal(getSitePack(), null);
});

test('initSitePack: network error → null, never throws', async () => {
  _resetSitePackForTest();
  const pack = await initSitePack({
    fetchImpl: async () => { throw new Error('boom'); },
  });
  assert.equal(pack, null);
});
