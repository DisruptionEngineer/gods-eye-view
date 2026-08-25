import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AREA_ACTIVATION_ALTITUDE_M,
  quantizedBboxKey,
  viewportBboxForAnchor,
  inUsCoverage,
} from './siteAreaLayer.js';

test('activation altitude is the spec value', () => {
  assert.equal(AREA_ACTIVATION_ALTITUDE_M, 15000);
});

test('quantizedBboxKey rounds to the quantum and is stable', () => {
  const bbox = { west: -97.7761, south: 30.2612, east: -97.7699, north: 30.2688 };
  const key = quantizedBboxKey(bbox);
  assert.equal(key, quantizedBboxKey({ ...bbox, west: -97.7758 }));
  assert.notEqual(key, quantizedBboxKey({ ...bbox, west: -97.7861 }));
  assert.match(key, /^-97\.7[89]?\d*,30\.2\d*,-97\.7\d*,30\.2\d*$/);
});

test('viewportBboxForAnchor scales span with altitude and clamps', () => {
  const low = viewportBboxForAnchor({ lat: 30, lon: -97 }, 100);
  const lowSpanM = (low.north - low.south) * 111320;
  assert.ok(Math.abs(lowSpanM - 1000) < 1);

  const mid = viewportBboxForAnchor({ lat: 30, lon: -97 }, 4000);
  const midSpanM = (mid.north - mid.south) * 111320;
  assert.ok(Math.abs(midSpanM - 6000) < 1);

  const high = viewportBboxForAnchor({ lat: 30, lon: -97 }, 500000);
  const highSpanM = (high.north - high.south) * 111320;
  assert.ok(Math.abs(highSpanM - 12000) < 1);
});

test('inUsCoverage accepts CONUS/AK/HI and rejects elsewhere', () => {
  assert.equal(inUsCoverage({ west: -98, south: 30, east: -97.9, north: 30.1 }), true);
  assert.equal(inUsCoverage({ west: -157, south: 21, east: -156.9, north: 21.1 }), true);
  assert.equal(inUsCoverage({ west: 2.2, south: 48.8, east: 2.4, north: 48.9 }), false);
  assert.equal(inUsCoverage({ west: 139.6, south: 35.6, east: 139.8, north: 35.7 }), false);
});
