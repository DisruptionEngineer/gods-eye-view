import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gridPointsForRing,
  gridPointsForViewport,
  buildWindGridUrl,
  parseOpenMeteoSamples,
  windAccent,
  windRefetchNeeded,
  WIND_ACTIVATION_ALTITUDE_M,
} from './siteWind.js';

const RING = [[-97.774, 30.266], [-97.770, 30.266], [-97.770, 30.270], [-97.774, 30.270], [-97.774, 30.266]];

test('gridPointsForRing lays an inclusive nx-by-ny lattice over the ring bbox', () => {
  const points = gridPointsForRing(RING, [3, 3]);
  assert.equal(points.length, 9);
  assert.deepEqual(points[0], { lat: 30.266, lon: -97.774 });
  assert.deepEqual(points[8], { lat: 30.270, lon: -97.770 });
  assert.deepEqual(points[4], { lat: 30.268, lon: -97.77199999999999 });
});

test('gridPointsForViewport centers a 3x3 lattice on the anchor', () => {
  const points = gridPointsForViewport({ lat: 30, lon: -97 }, 2000, [3, 3]);
  assert.equal(points.length, 9);
  assert.deepEqual(points[4], { lat: 30, lon: -97 });
  assert.ok(points[0].lat < 30 && points[0].lon < -97);
  const spanLat = points[8].lat - points[0].lat;
  assert.ok(Math.abs(spanLat - 2000 / 111320) < 1e-6);
});

test('buildWindGridUrl packs points into one multi-point request', () => {
  const url = buildWindGridUrl([{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }]);
  assert.ok(url.startsWith('https://api.open-meteo.com/v1/forecast?'));
  assert.ok(url.includes('latitude=1%2C3') || url.includes('latitude=1,3'));
  assert.ok(url.includes('longitude=2%2C4') || url.includes('longitude=2,4'));
  assert.ok(url.includes('wind_speed_10m'));
  assert.ok(url.includes('wind_gusts_10m'));
  assert.ok(url.includes('wind_speed_unit=ms'));
});

test('parseOpenMeteoSamples handles array responses and flips FROM to TO bearing', () => {
  const points = [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }];
  const json = [
    { current: { wind_speed_10m: 3.2, wind_direction_10m: 90, wind_gusts_10m: 5.1 } },
    { current: { wind_speed_10m: 1.0, wind_direction_10m: 350, wind_gusts_10m: 2.0 } },
  ];
  const samples = parseOpenMeteoSamples(json, points);
  assert.equal(samples.length, 2);
  assert.equal(samples[0].lat, 1);
  assert.equal(samples[0].speedMs, 3.2);
  assert.equal(samples[0].fromDeg, 90);
  assert.equal(samples[0].toDeg, 270);
  assert.equal(samples[1].toDeg, 170);
});

test('parseOpenMeteoSamples handles a single-object response and skips missing current', () => {
  const one = parseOpenMeteoSamples(
    { current: { wind_speed_10m: 2, wind_direction_10m: 0, wind_gusts_10m: 3 } },
    [{ lat: 5, lon: 6 }],
  );
  assert.equal(one.length, 1);
  assert.equal(one[0].toDeg, 180);
  const none = parseOpenMeteoSamples([{}], [{ lat: 5, lon: 6 }]);
  assert.equal(none.length, 0);
});

test('windAccent tiers by speed', () => {
  assert.equal(windAccent(1), windAccent(2.9));
  assert.notEqual(windAccent(2.9), windAccent(3.1));
  assert.notEqual(windAccent(7.9), windAccent(8.1));
});

test('windRefetchNeeded triggers on anchor moves beyond a third of the span', () => {
  const prev = { lat: 30, lon: -97 };
  assert.equal(windRefetchNeeded(prev, { lat: 30, lon: -97 }, 3000), false);
  assert.equal(windRefetchNeeded(null, prev, 3000), true);
  const farLat = 30 + (1100 / 111320);
  assert.equal(windRefetchNeeded(prev, { lat: farLat, lon: -97 }, 3000), true);
  const nearLat = 30 + (500 / 111320);
  assert.equal(windRefetchNeeded(prev, { lat: nearLat, lon: -97 }, 3000), false);
});

test('activation altitude is the spec value', () => {
  assert.equal(WIND_ACTIVATION_ALTITUDE_M, 6000);
});
