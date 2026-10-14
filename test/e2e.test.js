/* End-to-end: runs `wrangler pages dev` against a local fake Drive and checks routing, Range and the allowlist.
   Skipped when wrangler is not installed. Another binary: WRANGLER="npx wrangler@4" npm run test:e2e */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const [cmd, ...pre] = (process.env.WRANGLER || 'wrangler').split(' ');
const root = fileURLToPath(new URL('..', import.meta.url));
const found = spawnSync(cmd, [...pre, '--version'], { stdio: 'ignore' }).status === 0;
const opts = { skip: found ? false : 'wrangler not found (set WRANGLER="npx wrangler@4")' };

const VIDEO = randomBytes(300_000);

/* fake Drive: /file/<id> serves VIDEO with Range support; html-page answers like Drive's quota page */
const drive = createServer((req, res) => {
  if (req.url === '/file/html-page') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>quota</html>'); }
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (!m) {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': VIDEO.length, 'accept-ranges': 'bytes', 'set-cookie': 'NID=1' });
    return res.end(VIDEO);
  }
  const start = Number(m[1]), end = m[2] ? Math.min(Number(m[2]), VIDEO.length - 1) : VIDEO.length - 1;
  res.writeHead(206, { 'content-type': 'video/mp4', 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${VIDEO.length}`, 'accept-ranges': 'bytes' });
  res.end(VIDEO.subarray(start, end + 1));
});

async function freePort() {
  const s = createServer().listen(0, '127.0.0.1');
  await once(s, 'listening');
  const { port } = s.address();
  s.close();
  return port;
}

let base, wrangler, log = '';

before(async () => {
  if (!found) return;
  drive.listen(0, '127.0.0.1');
  await once(drive, 'listening');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  wrangler = spawn(cmd, [...pre, 'pages', 'dev', 'public', '--ip', '127.0.0.1', '--port', String(port),
    '--compatibility-date=2026-10-01', '--show-interactive-dev-session=false',
    '--binding', 'VIDEO_IDS=good-id,html-page',
    '--binding', `UPSTREAM_URL=http://127.0.0.1:${drive.address().port}/file/{id}`,
    '--binding', 'CACHE_SECONDS=60',
  ], { cwd: root, detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  wrangler.stdout.on('data', d => { log += d; });
  wrangler.stderr.on('data', d => { log += d; });
  for (const t0 = Date.now(); Date.now() - t0 < 60_000;) {
    if (wrangler.exitCode !== null) break;
    try { if ((await fetch(base)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`wrangler pages dev did not start:\n${log}`);
});

after(() => {
  if (wrangler?.exitCode === null) process.kill(-wrangler.pid, 'SIGTERM');
  drive.close();
});

test('example page is served', opts, async () => {
  const res = await fetch(base);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<video/);
});

test('Range request returns 206 with the exact bytes', opts, async () => {
  const res = await fetch(`${base}/v/good-id`, { headers: { Range: 'bytes=1000-1999' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 1000-1999/${VIDEO.length}`);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), VIDEO.subarray(1000, 2000));
});

test('request without Range returns the whole file without Drive cookies', opts, async () => {
  const res = await fetch(`${base}/v/good-id`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), VIDEO);
});

test('id outside the allowlist is 404', opts, async () => {
  assert.equal((await fetch(`${base}/v/someone-elses-file`)).status, 404);
});

test('Drive HTML page becomes 502', opts, async () => {
  assert.equal((await fetch(`${base}/v/html-page`)).status, 502);
});
