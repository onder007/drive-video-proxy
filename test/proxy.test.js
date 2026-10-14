import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { videos, responseHeaders, onRequestGet } from '../functions/v/[id].js';
import listed from '../videos.json' with { type: 'json' };

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/* records every upstream call and answers with the given response */
function mockFetch(response) {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return response; };
  return calls;
}

const get = (id, env = {}, headers = {}) =>
  onRequestGet({ params: { id }, env, request: new Request(`https://example.test/v/${id}`, { headers }) });

test('videos merges videos.json with VIDEO_IDS', () => {
  const map = videos({ VIDEO_IDS: 'aaa, bbb\nccc  ddd,' });
  for (const id of ['aaa', 'bbb', 'ccc', 'ddd', ...listed]) assert.equal(map.get(id), id, id);
  assert.equal(map.has(''), false);
  assert.deepEqual([...videos().keys()], [...new Set(listed)]);
});

test('VIDEO_IDS name=id entries serve the id under the name only', () => {
  const map = videos({ VIDEO_IDS: 'demo=1AbC_d-9, =nameless, empty=' });
  assert.equal(map.get('demo'), '1AbC_d-9');
  assert.equal(map.has('1AbC_d-9'), false);
  assert.equal(map.has(''), false);
  assert.equal(map.has('empty'), false);
});

test('videos.json as {"name": "id"} serves names, not ids', () => {
  const map = videos({ VIDEO_IDS: 'extra' }, { demo: '1AbC', intro: '2XyZ' });
  assert.deepEqual([...map], [['demo', '1AbC'], ['intro', '2XyZ'], ['extra', 'extra']]);
});

test('a name streams its Drive id', async () => {
  const calls = mockFetch(new Response('x', { headers: { 'content-type': 'video/mp4' } }));
  assert.equal((await get('demo', { VIDEO_IDS: 'demo=1AbC' })).status, 200);
  assert.equal(calls[0].url, 'https://drive.usercontent.google.com/download?id=1AbC&export=download&confirm=t');
  assert.equal((await get('1AbC', { VIDEO_IDS: 'demo=1AbC' })).status, 404);
});

test('responseHeaders keeps video headers only and sets cache-control', () => {
  const upstream = new Headers({
    'content-type': 'video/mp4', 'content-length': '100', 'content-range': 'bytes 0-99/5000',
    'accept-ranges': 'bytes', 'set-cookie': 'NID=1', 'x-guploader-uploadid': 'x', 'content-disposition': 'attachment',
  });
  const h = responseHeaders(upstream);
  assert.equal(h.get('cache-control'), 'public, max-age=3600');
  assert.equal(h.get('content-range'), 'bytes 0-99/5000');
  assert.equal(h.get('accept-ranges'), 'bytes');
  for (const dropped of ['set-cookie', 'x-guploader-uploadid', 'content-disposition']) assert.equal(h.get(dropped), null, dropped);
});

test('CACHE_SECONDS sets max-age, invalid values fall back to 3600', () => {
  assert.equal(responseHeaders(new Headers(), '0').get('cache-control'), 'public, max-age=0');
  assert.equal(responseHeaders(new Headers(), '86400').get('cache-control'), 'public, max-age=86400');
  assert.equal(responseHeaders(new Headers(), '1h').get('cache-control'), 'public, max-age=3600');
});

test('unknown id is 404 and never reaches Drive', async () => {
  const calls = mockFetch(new Response('should not be used'));
  const res = await get('not-listed');
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
});

test('allowed id streams from Drive and passes the Range header both ways', async () => {
  const calls = mockFetch(new Response('0123456789', {
    status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-9/5000', 'set-cookie': 'NID=1' },
  }));
  const res = await get('abc_DEF-123', { VIDEO_IDS: 'abc_DEF-123' }, { Range: 'bytes=0-9' });
  assert.equal(calls[0].url, 'https://drive.usercontent.google.com/download?id=abc_DEF-123&export=download&confirm=t');
  assert.equal(calls[0].init.headers.Range, 'bytes=0-9');
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 0-9/5000');
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(await res.text(), '0123456789');
});

test('no Range from the visitor means no Range upstream', async () => {
  const calls = mockFetch(new Response('x', { headers: { 'content-type': 'video/webm' } }));
  const res = await get('abc', { VIDEO_IDS: 'abc' });
  assert.deepEqual(calls[0].init.headers, {});
  assert.equal(res.status, 200);
});

test('Drive HTML page (quota or no access) becomes 502 with a link to Drive\'s player', async () => {
  mockFetch(new Response('<html>quota exceeded</html>', { headers: { 'content-type': 'text/html' } }));
  const res = await get('demo', { VIDEO_IDS: 'demo=1AbC' });
  assert.equal(res.status, 502);
  assert.equal(res.headers.get('link'), '<https://drive.google.com/file/d/1AbC/preview>; rel="alternate"');
});

test('Drive error status becomes 502', async () => {
  mockFetch(new Response('denied', { status: 403, headers: { 'content-type': 'video/mp4' } }));
  assert.equal((await get('abc', { VIDEO_IDS: 'abc' })).status, 502);
});

test('UPSTREAM_URL replaces the Drive address', async () => {
  const calls = mockFetch(new Response('x', { headers: { 'content-type': 'video/mp4' } }));
  await get('abc', { VIDEO_IDS: 'abc', UPSTREAM_URL: 'http://127.0.0.1:9999/file/{id}' });
  assert.equal(calls[0].url, 'http://127.0.0.1:9999/file/abc');
});

test('Drive unreachable becomes 502 instead of an uncaught exception', async () => {
  globalThis.fetch = async () => { throw new TypeError('Network connection lost.'); };
  assert.equal((await get('abc', { VIDEO_IDS: 'abc' })).status, 502);
});

test('no headers from Drive within 15 s becomes 504', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.fetch = (url, init) => new Promise((_, reject) =>
    init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const pending = get('abc', { VIDEO_IDS: 'abc' });
  t.mock.timers.tick(15_000);
  assert.equal((await pending).status, 504);
});
