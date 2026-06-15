# gpx.studio-bridge

A tiny **host** for gpx.studio's embedded mode: a top-bar file menu + an `<iframe>` running
gpx.studio, backed by a folder of `.gpx` files on disk. The bridge is the filesystem ⇄ `postMessage`
translator — it owns storage, identity and versioning; the editor owns no files. Collaboration is
last-write-wins via polling.

- `backend/` — FastAPI folder store (a directory of nested `.gpx`; id = relative path; version = mtime).
- `frontend/` — Vite shell (top bar, Open popup, protocol host half, poll loop).
- `dev/` — protocol mocks (`fake-editor.html`, `fake-host.html`) for testing without the real editor.

## Run (3 processes)

```bash
# 1. Backend — folder store on :3001 (interactive API docs at /docs and /redoc)
cd backend
python -m venv .venv && .venv/bin/pip install -r requirements.txt   # first time
cp .env.example .env                                                # first time; edit GPX_DATA_DIR / ROOT_PATH
.venv/bin/uvicorn main:app --reload --port 3001 --env-file .env
# (or pass vars inline, no .env needed: GPX_DATA_DIR=/scratch .venv/bin/uvicorn main:app --port 3001)

# 2. Editor (the gpx.studio fork, embedded-dev branch) — pinned to :5180
cd ../../gpx.studio/website
npm install                                # first time; needs PUBLIC_MAPTILER_KEY in .env
npm run dev

# 3. Frontend shell — :5174, pointed at the real editor
cd ../../gpx.studio-bridge/frontend
npm install                                # first time
VITE_EDITOR_URL=http://localhost:5180/app?embedded=1 npm run dev
```

Open **http://localhost:5174**. (Leave `VITE_EDITOR_URL` unset to use the mock `fake-editor.html`.)
Config lives in `frontend/.env` — see `frontend/.env.example` (`VITE_API_BASE`, `VITE_EDITOR_URL`,
`VITE_POLL_MS`). Backend config is `backend/.env` — see `backend/.env.example` (`GPX_DATA_DIR`,
`ROOT_PATH`), loaded via uvicorn's `--env-file`.

## The embed protocol (postMessage)

Modelled on [draw.io's embed protocol](https://github.com/jgraph/drawio/discussions/5612):
JSON objects over `window.postMessage`, activated by loading the editor with **`?embedded=1`**
(not `?embed=1` — that hits upstream's legacy read-only map-embed redirect). The editor owns no
files; it receives GPX bytes and emits GPX bytes, and the bridge (host) owns storage, identity and
versioning. The two run in the same browser at **different origins** (editor iframe vs. shell), so
every message is origin-checked.

**Field convention (draw.io-style, note the asymmetry):**

- **Editor → host** messages carry an **`event`** field. The host ignores any message whose
  `origin` isn't the editor's, and switches on `msg.event`.
- **Host → editor** messages carry an **`action`** field. The editor ignores any object without an
  `action`, pins the host's origin on the first accepted message (trust-on-first-use unless
  `VITE_EMBED_ALLOWED_ORIGINS` is set), and switches on `msg.action`.

**Identity.** The host **`id` is the file's path relative to the store root** (e.g.
`trips/day1.gpx`). Inside the iframe the editor uses its own local ids (`gpx-N`) and keeps a
`localId ↔ hostId` registry — only `id`/`hostId` ever crosses `postMessage`. **`version`** is an
opaque token (the backend's `st_mtime_ns`) used for last-write-wins.

### Handshake

```
editor (iframe, ?embedded=1)                 host (bridge shell)
  │  restore registry, attach listeners        │
  │ ──{event:'init'}──────────────────────────▶│  "editor ready"
  │                                             │  GET /file  → bytes+version
  │ ◀─{action:'load', id, data, title?, ───────│  (one per opened file)
  │      autosave:1}                            │
  │  parseGPX, open, map id↔localId             │
  │ ──{event:'load', id}──────────────────────▶│  (ack; informational)
```

Until the first inbound message arrives the editor doesn't yet know the host's origin, so its
`init` is announced with `targetOrigin: '*'`; thereafter it targets the pinned host origin.

### Editor → host (`event`)

| Message | When |
| --- | --- |
| `{event:'init'}` | Editor mounted and ready; expects `load`. |
| `{event:'load', id}` | Ack of a finished `load`. |
| `{event:'autosave', id, data}` | Debounced (~`AUTOSAVE_DEBOUNCE_MS`) on any local change to a **server-backed** file. `data` = full `buildGPX` text. |
| `{event:'save', id, data}` | Explicit save of a server-backed file. Host treats it identically to `autosave`; the editor currently emits `autosave` for all local edits. |
| `{event:'save', tempId, data, name?}` | **Promotion** — "Save to server" on a browser-only file: a `save` with **no `id`**. `tempId` is the editor's local id; `name` is derived from the file metadata (`<name>.gpx`, else `untitled.gpx`). Host creates the resource and binds it back via `status` (carrying `tempId`). |

### Host → editor (`action`)

| Message | Effect |
| --- | --- |
| `{action:'load', id, data, title?, autosave:1}` | Open a file (one per opened file — multi-file): editor `parseGPX`s, opens it, maps `id ↔ localId`, and **selects** it. |
| `{action:'merge', id, data}` | Whole-file LWW replace of an already-open file (collaboration inbound from the poll loop). Preserves the map viewport. |
| `{action:'remove', id}` | Host removed file `id`; editor closes it. |
| `{action:'status', id, ok, version?, message?, tempId?}` | **Ack** of a write outcome (`autosave`/`save`/promotion). `ok:true` carries the new `version` (adopted so the next poll won't echo the write back) → "Saved"; `ok:false` carries `message` → "Error". On a **promotion** ack it also carries `tempId` — no `id↔localId` binding exists yet, so this is how the editor binds its local file to the new path. |

The `status` ack is the only real addition beyond draw.io's set — it powers the status badge
without a websocket: the host just relays the result of its write back into the iframe. A
promotion needs no extra message: it is a `save` with no `id`, and `status` (carrying `tempId`)
both acks the write and delivers the binding.

### Promotion (browser-only file → server)

```
editor ──{event:'save', tempId, data, name}──────────────▶ host  POST /file  (auto-suffix on collision)
editor ◀──{action:'status', tempId, id, ok:true, version}── host  (bind localId → path; "Saved"; host starts polling id)
```

### Collaboration (last-write-wins, poll-based — no websocket)

The host polls `GET /files` every `VITE_POLL_MS`. When an **open** file's `version` is newer than the
registry's, it `GET /file`s the bytes and pushes `{action:'merge', id, data}`. Local edits flow the
other way as `autosave` → `PUT /file` → `{action:'status', id, ok:true, version}`; the host adopts its own
write's version so it doesn't immediately re-`merge` its own change. Whole-file replace throughout —
deliberately simple. A real platform host (OpenCloud/Nextcloud) is the same protocol with WebDAV
storage and an ETag `version`.

## CORS "fix" (required)

gpx.studio's backend services (`styles/tiles/fonts/sprites/graphhopper/overpass.gpx.studio`) only
send CORS headers for the `https://gpx.studio` origin, so from any other origin the
basemap/routing/elevation/POIs silently fail ("tools dead"). The fix is to fetch them
**same-origin** — proxy them through the editor's own Vite dev server, so the browser never makes a
cross-origin request and CORS simply never applies.

### Option A — Vite dev-server proxy (recommended; self-contained)

The editor's `vite.config.ts` proxies each service under a relative path on its own origin, and
`.env` points the `VITE_*_URL` vars at those paths:

| service | proxy path (`vite.config.ts`) | env (`.env`) |
| --- | --- | --- |
| graphhopper | `/graphhopper` → `graphhopper.gpx.studio` | `VITE_GRAPHHOPPER_URL=/graphhopper` |
| styles | `/styles` → `styles.gpx.studio` | `VITE_STYLES_URL=/styles` |
| tiles | `/tiles` → `tiles.gpx.studio` | `VITE_TILES_URL=/tiles` |
| overpass | `/overpass` → `overpass.gpx.studio` | `VITE_OVERPASS_URL=/overpass` |

Because the fetch is same-origin, there's **no CORS, no preflight, and no mixed-content** to manage —
the whole fix lives in the repo (`vite.config.ts` + `.env`). The bridge backend is handled the same
way (`frontend/vite.config.js` proxies `/api` → `:3001`), so the external reverse proxy only has to
route the two app domains — it no longer touches the gpx.studio services. See
**[Reverse proxy (two app domains)](#reverse-proxy-two-app-domains)**.

> **Limitation — dev only.** `server.proxy` is a feature of the Vite *dev server*. A production
> `vite build` (static files) has no proxy, so a real deployment must move the service-proxying back
> to infrastructure (Caddy/nginx). Fine for this POC, which runs the dev servers.

### Option B — throwaway browser with web security off (quick local hack)

To poke at the app without configuring the proxy/env, open the shell in a **dedicated throwaway**
browser profile with web security off (never your normal browser):

```bash
chromium --user-data-dir=/tmp/gpxdev --disable-web-security http://localhost:5174
```

## Reverse proxy (two app domains)

To run the app over real hostnames in any browser (no flags), put a reverse proxy in front that
routes the **two app domains** to their dev servers. The gpx.studio services and the bridge backend
are proxied *inside* Vite now (see the [CORS fix](#cors-fix-required) and the bridge's
`frontend/vite.config.js` `/api` proxy), so the external proxy is just two dumb routes:

- **`gpxstudio.example.com`** → the editor (`:5180`). Whole domain to itself so its root-relative
  `/_app`, `/@vite` … assets resolve cleanly with no path mangling.
- **`gpx.example.com`** → the bridge shell (`:5174`), which serves the host UI and proxies `/api` to
  the FastAPI backend itself.

```caddy
# --- Editor: whole domain to itself, so root-relative assets just work ---
http://gpxstudio.example.com {
	reverse_proxy <server-ip>:5180
}

# --- Bridge shell (proxies /api → backend internally via Vite) ---
http://gpx.example.com {
	reverse_proxy <server-ip>:5174
}
```

Replace `<server-ip>` with the machine running the dev servers (e.g. `hostname -I`), and
`example.com` with your domain. The blocks use `http://` so Caddy serves plain HTTP; drop the scheme
(or use `https://`) to get automatic certificates — see the TLS note at the end.

### Matching env

**Editor** (`gpx.studio/website/.env`) — services are relative paths (proxied by Vite, scheme-
agnostic), and lock the embed origin to the bridge:

```ini
VITE_GRAPHHOPPER_URL=/graphhopper
VITE_STYLES_URL=/styles
VITE_TILES_URL=/tiles
VITE_OVERPASS_URL=/overpass
# postMessage allowlist — the bridge's origin (unset = trust-on-first-use, POC default)
VITE_EMBED_ALLOWED_ORIGINS=http://gpx.example.com
```

**Bridge shell** (`frontend/.env`) — backend is same-origin via the Vite `/api` proxy, editor is its
own host:

```ini
VITE_API_BASE=/api
VITE_EDITOR_URL=http://gpxstudio.example.com/app?embedded=1
```

`VITE_EDITOR_URL` is also the source of the bridge's `EDITOR_ORIGIN` (used to target outbound
postMessage and to validate inbound), so it must be the editor's real origin. Each side allows the
**other's** origin, never its own.

**Backend** — the bridge's `/api` Vite proxy strips the `/api` prefix, so tell FastAPI its public
prefix so the auto-generated docs reference `/api/openapi.json` (not `/openapi.json` at the site
root). Set `ROOT_PATH` on launch:

```bash
GPX_DATA_DIR=/path/to/scratch ROOT_PATH=/api .venv/bin/uvicorn main:app --port 3001
```

The interactive docs are then at **`http://gpx.example.com/api/docs`** (Swagger UI) and
`…/api/redoc` (ReDoc); the schema is at `…/api/openapi.json`. Leave `ROOT_PATH` unset for direct
access (`localhost:3001/docs`). Equivalent without the env var: `uvicorn … --root-path /api`.

### Vite host check

Vite's dev server rejects `Host` headers it isn't told to trust (`Blocked request. This host … is
not allowed.`). Add your proxied hostnames to `server.allowedHosts` in **both** Vite configs —
`gpx.studio/website/vite.config.ts` and `frontend/vite.config.js`. A leading-dot wildcard covers a
domain and all its subdomains:

```js
server: { /* … */ allowedHosts: ['.example.com'] }
```

### Coverage caveat

The Vite proxy covers `graphhopper`, `tiles`, `styles`, `overpass` — **not** `fonts`/`sprites`, and
the style JSON served from `styles.gpx.studio` still references `tiles`/`fonts`/`sprites` by their
original absolute URLs internally. So basic functionality (routing, elevation, terrain, POIs, most
basemaps) works, but **some map styles render imperfectly**. Fully fixing them means also proxying
fonts/sprites and rewriting the URLs inside the style JSON — out of scope for this POC. (This caveat
is identical whichever proxy does the work; it is a property of the upstream style JSON, not the
proxy choice.)

### TLS

To serve over HTTPS, drop the `http://` scheme from the site addresses and Caddy auto-provisions
Let's Encrypt certs (needs ports 80/443 reachable). For a wildcard or when port 80 is closed, use the
DNS challenge, e.g. with the Cloudflare plugin:

```caddy
(tls) {
	tls {
		dns cloudflare {env.CF_API_TOKEN}
		resolvers 1.1.1.1
	}
}
# then `import tls` inside each site block
```

(The DNS plugin must be compiled into your Caddy binary — `caddy list-modules | grep cloudflare`.)
The service `VITE_*_URL`s are relative paths, so they're scheme-agnostic; when you switch to HTTPS
only update the origin-bearing vars (`VITE_EDITOR_URL`, `VITE_EMBED_ALLOWED_ORIGINS`) to `https://`.

## Access from other machines (`--host`)

Without Caddy, bind the two Vite servers to all interfaces and use the host machine's LAN
IP/hostname for the *editor* (the iframe runs in the remote browser, so `localhost` won't resolve
there). The backend stays on `localhost` — only the bridge's Vite `/api` proxy reaches it, and that
hop is server-side:

```bash
HOST=192.168.1.50    # this machine's LAN IP (e.g. `hostname -I`)

# backend (local only; reached via the shell's /api proxy)
GPX_DATA_DIR=/path/to/scratch ROOT_PATH=/api .venv/bin/uvicorn main:app --port 3001
# editor
npm run dev -- --host
# shell — backend is same-origin (/api), point the iframe at $HOST
VITE_API_BASE=/api VITE_EDITOR_URL=http://$HOST:5180/app?embedded=1 npm run dev -- --host
```

Then on the other machine open `http://$HOST:5174` in a **normal** browser — no
`--disable-web-security` needed, because the gpx.studio services and `/api` are proxied same-origin
by the two Vite servers. Add `$HOST` (or a `.`-prefixed domain) to `server.allowedHosts` in both
Vite configs if Vite rejects the `Host` header.
