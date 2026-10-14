/* GET /v/<Drive file id> -> the Drive video, streamed with the visitor's Range header (Cloudflare Pages Function).
   Drive answers a cross-site <video> request with 403; requested from here it is a plain server request.
   Only allowlisted ids are served, so the domain is not an open proxy for any Drive file. */
import listed from '../../videos.json' with { type: 'json' };

const DRIVE = 'https://drive.usercontent.google.com/download?id={id}&export=download&confirm=t';
const PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
const HEADERS_TIMEOUT_MS = 15_000;

/* videos.json plus the VIDEO_IDS variable (ids separated by commas, spaces or new lines) */
export function allowedIds(env = {}) {
  return new Set([...listed, ...String(env.VIDEO_IDS ?? '').split(/[\s,]+/)].filter(Boolean));
}

/* only the headers a <video> element needs, plus our own cache policy */
export function responseHeaders(upstream, cacheSeconds) {
  const maxAge = /^\d+$/.test(cacheSeconds ?? '') ? cacheSeconds : 3600;
  const headers = new Headers({ 'cache-control': `public, max-age=${maxAge}` });
  for (const h of PASS) { const v = upstream.get(h); if (v) headers.set(h, v); }
  return headers;
}

export async function onRequestGet({ params, request, env }) {
  if (!allowedIds(env).has(params.id)) return new Response('Not found', { status: 404 });
  const range = request.headers.get('Range');
  /* the timer only covers waiting for Drive's headers; it is cleared before the body streams */
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), HEADERS_TIMEOUT_MS);
  let res;
  try {
    /* UPSTREAM_URL is for tests; leave it unset to stream from Drive */
    res = await fetch((env.UPSTREAM_URL || DRIVE).replace('{id}', encodeURIComponent(params.id)), {
      headers: range ? { Range: range } : {},
      signal: abort.signal,
    });
  } catch {
    return new Response('Video unavailable', { status: abort.signal.aborted ? 504 : 502 });
  } finally {
    clearTimeout(timer);
  }
  /* Drive sends an HTML page (quota, virus-scan notice, no access) with 200, so check the type too */
  if (!res.ok || !(res.headers.get('content-type') || '').startsWith('video/')) {
    await res.body?.cancel();
    return new Response('Video unavailable', { status: 502 });
  }
  return new Response(res.body, { status: res.status, headers: responseHeaders(res.headers, env.CACHE_SECONDS) });
}

/* without this, HEAD falls through to the static site and gets index.html with 200 */
export const onRequestHead = () => new Response(null, { status: 405, headers: { allow: 'GET' } });
