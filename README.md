# drive-video-proxy

Play Google Drive videos in your own `<video>` element. A Cloudflare Pages Function streams the file from your domain, passes the `Range` header through so seeking works, and serves only the Drive ids you allowlist.

## Why

- Drive's embed player is an iframe with Drive's own controls and branding. You cannot style it, and on phones it shows two layers of controls.
- A `<video src>` that points straight at Drive gets `403` when the request comes from another site. The same URL requested by a server works.
- This function is that server. It is one file of about 35 lines, runs on the Cloudflare free plan, and the video stays in Drive, so there is no storage bill.
- The allowlist keeps your domain from becoming an open proxy for any public Drive file.

## How it works

```
<video src="/v/ID">  -- Range: bytes=... -->  functions/v/[id].js  -- Range -->  drive.usercontent.google.com
                     <-- 206 + video bytes --                      <-- 206 --
```

- **Id not in the allowlist:** `404`. Drive is never contacted.
- **Drive answers with an error, or with an HTML page instead of a video** (download quota, virus-scan notice, file not shared): `502`. Your page can catch the `<video>` error and fall back to Drive's player, as `public/index.html` does.
- **Headers:** only `content-type`, `content-length`, `content-range`, `accept-ranges`, `etag` and `last-modified` are passed on. Drive's cookies, CSP and `content-disposition: attachment` are dropped, and `cache-control: public, max-age=3600` is added.

## Quick start

Requirements: Node 22 or newer and [wrangler](https://developers.cloudflare.com/workers/wrangler/) 4 (`npm i -g wrangler`, or prefix the commands with `npx`).

1. In Drive, share the video as **Anyone with the link: Viewer**.
2. Copy its file id, the part of the share link between `/file/d/` and `/view`:
   `https://drive.google.com/file/d/<FILE ID>/view`
3. Replace the placeholder in `videos.json` with your id. Add as many as you need:
   ```json
   [
     "<FILE ID>",
     "<ANOTHER FILE ID>"
   ]
   ```
4. Run it locally:
   ```sh
   npm run dev
   ```
   Then open `http://localhost:8788/?id=<FILE ID>`. The video should play and seek.
5. Use it on your own pages:
   ```html
   <video controls playsinline preload="metadata" src="/v/<FILE ID>"></video>
   ```

## Deploy to Cloudflare Pages

From Git: in the Cloudflare dashboard go to **Workers & Pages > Create > Pages > Connect to Git** and pick this repository. Framework preset: **None**, build command: empty, build output directory: **`public`**. Cloudflare picks up the `functions/` folder on its own.

From the command line:

```sh
wrangler pages project create drive-video-proxy --production-branch main
wrangler pages deploy public --project-name drive-video-proxy
```

Attach a custom domain afterwards: `*.pages.dev` addresses are blocked in some countries.

## Configuration

| Setting | Where | Default | Purpose |
|---|---|---|---|
| `videos.json` | file in the repo | one placeholder | Allowlisted Drive file ids, deployed with the code. |
| `VIDEO_IDS` | environment variable | empty | More ids, separated by commas, spaces or new lines. Merged with `videos.json`. Use it when you don't want the ids in the repository. |
| `CACHE_SECONDS` | environment variable | `3600` | `max-age` of the `cache-control` header sent to browsers. |
| `UPSTREAM_URL` | environment variable | Drive's download URL | Where to fetch from, with `{id}` replaced by the file id. The e2e test points it at a local fake Drive. Leave it unset in production. |

In production, set the variables in the Pages project's settings (Variables and Secrets). Locally, put them in a `.dev.vars` file next to `package.json` (it is git-ignored):

```
VIDEO_IDS=<FILE ID>,<ANOTHER FILE ID>
CACHE_SECONDS=86400
```

## Tests

```sh
npm test           # unit tests (node:test), no network needed
npm run test:e2e   # starts `wrangler pages dev` against a local fake Drive
```

The unit tests cover the allowlist, header filtering, cache settings, `Range` forwarding and the `502` cases with a mocked `fetch`. The e2e test runs the real function in `wrangler pages dev` and checks byte-exact `206` responses, the `404` for unknown ids and the `502` for an HTML answer. It is skipped when wrangler is not installed; to use npx instead, run `WRANGLER="npx wrangler@4" npm run test:e2e`.

## Limitations

- **Download quota.** Drive limits how often a single file can be downloaded. When a popular video hits the limit, Drive sends an HTML page instead of the video for a while. The function then answers `502` and the example page falls back to Drive's player.
- **No edge cache.** Every request goes through the function to Drive. `cache-control` only helps the visitor's browser, and each seek is a new request that counts toward your Cloudflare Workers request limits.
- **Not an official API.** `drive.usercontent.google.com/download?id=...&export=download&confirm=t` is not a documented Google API. Google can change it without notice.
- **Public files only.** Files must be shared as "Anyone with the link". Private files would need the Drive API with OAuth, which is out of scope.
- **File size.** Tested with files up to about 50 MB. Multi-gigabyte files are untested.
- **GET only.** `HEAD` requests are not handled.

## Project layout

```
functions/v/[id].js   the proxy (Cloudflare Pages Function)
videos.json           allowlist of Drive file ids
public/index.html     example page with <video> and the Drive fallback
test/proxy.test.js    unit tests
test/e2e.test.js      end-to-end test with wrangler pages dev
```

## License

TBD (private for now).
