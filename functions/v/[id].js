/* GET /v/<name> -> the Drive video, streamed with the visitor's Range header (Cloudflare Pages Function).
   Drive answers a cross-site <video> request with 403; requested from here it is a plain server request.
   Only listed videos are served, so the domain is not an open proxy for any Drive file. */
import listed from '../../videos.json' with { type: 'json' };

const DRIVE = 'https://drive.usercontent.google.com/download?id={id}&export=download&confirm=t';
const PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
const HEADERS_TIMEOUT_MS = 15_000;

/* name -> Drive file id, from videos.json (an array of ids, or {"name": "id"}) plus the VIDEO_IDS variable
   (entries "id" or "name=id", separated by commas, spaces or new lines). A bare id is served under its own id. */
export function videos(env = {}, list = listed) {
  const entries = Array.isArray(list) ? list.map(id => [id, id]) : Object.entries(list);
  for (const entry of String(env.VIDEO_IDS ?? '').split(/[\s,]+/).filter(Boolean)) {
    const [name, id = name] = entry.split('=');
    entries.push([name, id]);
  }
  return new Map(entries.filter(([name, id]) => name && id));
}

/* only the headers a <video> element needs, plus our own cache policy */
export function responseHeaders(upstream, cacheSeconds) {
  const maxAge = /^\d+$/.test(cacheSeconds ?? '') ? cacheSeconds : 3600;
  const headers = new Headers({ 'cache-control': `public, max-age=${maxAge}` });
  for (const h of PASS) { const v = upstream.get(h); if (v) headers.set(h, v); }
  return headers;
}

export async function onRequestGet({ params, request, env }) {
  const id = videos(env).get(params.id);
  if (!id) return new Response('Not found', { status: 404 });
  const range = request.headers.get('Range');
  /* the timer only covers waiting for Drive's headers; it is cleared before the body streams */
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), HEADERS_TIMEOUT_MS);
  let res;
  try {
    /* UPSTREAM_URL is for tests; leave it unset to stream from Drive */
    res = await fetch((env.UPSTREAM_URL || DRIVE).replace('{id}', encodeURIComponent(id)), {
      headers: range ? { Range: range } : {},
      signal: abort.signal,
    });
  } catch {
    return unavailable(abort.signal.aborted ? 504 : 502, id);
  } finally {
    clearTimeout(timer);
  }
  /* Drive sends an HTML page (quota, virus-scan notice, no access) with 200, so check the type too */
  if (!res.ok || !(res.headers.get('content-type') || '').startsWith('video/')) {
    await res.body?.cancel();
    return unavailable(502, id);
  }
  return new Response(res.body, { status: res.status, headers: responseHeaders(res.headers, env.CACHE_SECONDS) });
}

/* the Link header lets a page fall back to Drive's own player without knowing the Drive id in advance */
const unavailable = (status, id) => new Response('Video unavailable', {
  status, headers: { link: `<https://drive.google.com/file/d/${encodeURIComponent(id)}/preview>; rel="alternate"` },
});

/* without this, HEAD falls through to the static site and gets index.html with 200 */
export const onRequestHead = () => new Response(null, { status: 405, headers: { allow: 'GET' } });
