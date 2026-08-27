import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSitePackMiddleware } from '../../vite.config.js';

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) { res.statusCode = code; res.headers = headers; },
    end(chunk) { res.body = String(chunk ?? ''); res.ended = true; },
  };
  return res;
}

test('serves the site file as JSON with no-store', async () => {
  const body = JSON.stringify({ version: 1, home: { lat: 30.2, lon: -97.7 } });
  const middleware = createSitePackMiddleware({
    readFileImpl: async (path) => {
      assert.equal(path, 'config/site.local.json');
      return body;
    },
  });
  const res = fakeRes();
  await middleware({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'application/json');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.body, body);
});

test('honors GEV_SITE_FILE override', async () => {
  const middleware = createSitePackMiddleware({
    env: { GEV_SITE_FILE: 'C:/somewhere/else.json' },
    readFileImpl: async (path) => {
      assert.equal(path, 'C:/somewhere/else.json');
      return '{"version":1,"home":{"lat":1,"lon":2}}';
    },
  });
  const res = fakeRes();
  await middleware({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200);
});

test('404 when the file is absent, without leaking the path', async () => {
  const enoent = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
  const middleware = createSitePackMiddleware({
    readFileImpl: async () => { throw enoent; },
  });
  const res = fakeRes();
  await middleware({ method: 'GET' }, res);
  assert.equal(res.statusCode, 404);
  assert.ok(!res.body.includes('ENOENT'));
  assert.deepEqual(JSON.parse(res.body), { error: 'no site pack configured' });
});

test('500 with sanitized body on unparseable JSON', async () => {
  const middleware = createSitePackMiddleware({
    readFileImpl: async () => 'not json {',
  });
  const res = fakeRes();
  await middleware({ method: 'GET' }, res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(res.body), { error: 'site pack unreadable' });
});

test('405 on non-GET', async () => {
  const middleware = createSitePackMiddleware({
    readFileImpl: async () => '{}',
  });
  const res = fakeRes();
  await middleware({ method: 'POST' }, res);
  assert.equal(res.statusCode, 405);
});
