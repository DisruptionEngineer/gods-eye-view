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

import * as Cesium from 'cesium';
import { createSiteAreaLayer } from './siteAreaLayer.js';

function fakeViewer({ heightM, latDeg = 30.2, lonDeg = -97.7 }) {
  const listeners = new Set();
  return {
    state: { heightM, latDeg, lonDeg },
    fire() { for (const fn of [...listeners]) fn(); },
    camera: {
      get positionCartographic() {
        return {
          height: this._owner.state.heightM,
          latitude: Cesium.Math.toRadians(this._owner.state.latDeg),
          longitude: Cesium.Math.toRadians(this._owner.state.lonDeg),
        };
      },
      moveEnd: {
        addEventListener: (fn) => listeners.add(fn),
        removeEventListener: (fn) => listeners.delete(fn),
      },
    },
    scene: { canvas: null },
    dataSources: { add: async (ds) => ds, remove: () => true },
  };
}

function makeViewer(opts) {
  const v = fakeViewer(opts);
  v.camera._owner = v;
  return v;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('contract: gate-exit clears counts and re-descend re-presents', async () => {
  let fetches = 0;
  const layer = createSiteAreaLayer({
    id: 't', name: 'T', icon: 'x', source: 'S',
    fetchArea: async () => { fetches += 1; return { n: 3 }; },
    buildDataSources: async () => [],
    countFeatures: (p) => ({ count: p.n, error: null }),
  });
  const viewer = makeViewer({ heightM: 5000 });
  layer.init(viewer);
  layer.enable(viewer);
  await tick(); await tick();
  assert.equal(fetches, 1);
  assert.equal(layer.getStats().count, 3);
  viewer.state.heightM = 20000;
  viewer.fire();
  await tick(); await tick();
  assert.equal(layer.getStats().count, 0);
  viewer.state.heightM = 5000;
  viewer.fire();
  await tick(); await tick();
  assert.equal(layer.getStats().count, 3);
  layer.disable(viewer);
});

test('contract: outside US coverage skips fetch, count 0, no error', async () => {
  let fetches = 0;
  const layer = createSiteAreaLayer({
    id: 't1', name: 'T1', icon: 'x', source: 'S',
    fetchArea: async () => { fetches += 1; return { n: 3 }; },
    buildDataSources: async () => [],
    countFeatures: (p) => ({ count: p.n, error: null }),
  });
  const viewer = makeViewer({ heightM: 5000, latDeg: 35.6, lonDeg: 139.7 });
  layer.init(viewer);
  layer.enable(viewer);
  await tick(); await tick();
  assert.equal(fetches, 0);
  assert.equal(layer.getStats().count, 0);
  assert.equal(layer.getStats().error, null);
  layer.disable(viewer);
});

test('contract: a settle during an in-flight fetch is not dropped', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let fetches = 0;
  const layer = createSiteAreaLayer({
    id: 't2', name: 'T2', icon: 'x', source: 'S',
    fetchArea: async (bbox) => { fetches += 1; if (fetches === 1) await gate; return { n: 1 }; },
    buildDataSources: async () => [],
    countFeatures: (p) => ({ count: p.n, error: null }),
  });
  const viewer = makeViewer({ heightM: 5000 });
  layer.init(viewer);
  layer.enable(viewer);
  await tick();
  viewer.state.latDeg = 30.25;
  viewer.fire();
  await tick();
  release();
  await tick(); await tick(); await tick();
  assert.equal(fetches, 2);
  layer.disable(viewer);
});
