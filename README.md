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
# 1. Backend — folder store on :3001
cd backend
python -m venv .venv && .venv/bin/pip install -r requirements.txt   # first time
GPX_DATA_DIR=/path/to/scratch .venv/bin/uvicorn main:app --reload --port 3001

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
`VITE_POLL_MS`).

## CORS "fix" (required)

gpx.studio's backend services (`styles/tiles/fonts/sprites/graphhopper/overpass.gpx.studio`) only
send CORS headers for the `https://gpx.studio` origin, so from any other origin the
basemap/routing/elevation/POIs silently fail ("tools dead"). Two ways to deal with it:

### Option A — reverse proxy (works in normal browsers; recommended)

Put a reverse proxy in front that re-points each upstream service to your own hostname and rewrites
the CORS header to `*`. This is the only option that works in everyday browsers (Chrome, Firefox,
Edge, mobile) with no flags. See **[Reverse proxy (Caddy)](#reverse-proxy-caddy)** below.

### Option B — throwaway browser with web security off (quick local hack)

For a one-off local check, open the shell in a **dedicated throwaway** browser profile with web
security off (never your normal browser):

```bash
chromium --user-data-dir=/tmp/gpxdev --disable-web-security http://localhost:5174
```

## Reverse proxy (Caddy)

Serve both apps over two hostnames so the proxy can rewrite the upstreams' CORS headers, and the app
runs in any browser unmodified:

- **`gpxstudio.example.com`** → the editor (whole domain to itself, so its root-relative
  `/_app`, `/@vite` … assets resolve cleanly with no path mangling).
- **`gpx.example.com`** → the bridge shell at `/`, the bridge backend at `/api`, and the
  CORS-proxied gpx.studio services at `/gh`, `/tiles`, `/styles`, `/overpass`.

The editor is cross-origin from the services (different host), so the `Access-Control-Allow-Origin: *`
override is load-bearing. The bridge shell and its backend are **same-origin** (both
`gpx.example.com`), so no CORS override is needed for `/api`.

```caddy
# Reusable CORS-proxy to a real gpx.studio backend.
# Usage:  import gpxsvc <upstream-host>
# Requires Caddy v2.7+ for {args[0]} (older builds: use {args.0}).
# NOTE: each `import gpxsvc …` must be on its own line for the Caddyfile parser.
(gpxsvc) {
	reverse_proxy https://{args[0]} {
		# Present the gpx.studio vhost name to the upstream (TLS SNI + Host routing).
		header_up Host {args[0]}
		# Drop the upstream CORS header so it can't conflict with ours below.
		header_down -Access-Control-Allow-Origin
	}
	# Force-allow any origin (the editor is cross-origin on gpxstudio.example.com).
	header {
		Access-Control-Allow-Origin "*"
		Access-Control-Allow-Methods "GET, POST, OPTIONS"
		Access-Control-Allow-Headers "Content-Type"
	}
	# Answer CORS preflight directly with 204 (don't bother the upstream).
	@preflight method OPTIONS
	respond @preflight 204
}

# --- Editor: whole domain to itself, so root-relative assets just work ---
http://gpxstudio.example.com {
	reverse_proxy <server-ip>:5180
}

# --- Bridge + proxied services ---
http://gpx.example.com {
	handle_path /gh/* {
		import gpxsvc graphhopper.gpx.studio
	}
	handle_path /tiles/* {
		import gpxsvc tiles.gpx.studio
	}
	handle_path /styles/* {
		import gpxsvc styles.gpx.studio
	}
	handle_path /overpass/* {
		import gpxsvc overpass.gpx.studio
	}

	# Bridge backend (FastAPI folder store on :3001), same-origin -> plain proxy.
	handle_path /api/* {
		reverse_proxy <server-ip>:3001
	}

	# Bridge host shell --- everything else.
	handle {
		reverse_proxy <server-ip>:5174
	}
}
```

Replace `<server-ip>` with the machine running the three dev servers (e.g. `hostname -I`), and
`example.com` with your domain. The blocks use `http://` so Caddy serves plain HTTP; drop the scheme
(or use `https://`) to get automatic certificates — see the TLS note at the end.

### Matching env

**Editor** (`gpx.studio/website/.env`) — point each service at the proxy, and lock the embed origin
to the bridge:

```ini
VITE_GRAPHHOPPER_URL=http://gpx.example.com/gh
VITE_STYLES_URL=http://gpx.example.com/styles
VITE_TILES_URL=http://gpx.example.com/tiles
VITE_OVERPASS_URL=http://gpx.example.com/overpass
# postMessage allowlist — the bridge's origin (unset = trust-on-first-use, POC default)
VITE_EMBED_ALLOWED_ORIGINS=http://gpx.example.com
```

**Bridge shell** (`frontend/.env`) — backend is same-origin (relative path), editor is its own host:

```ini
VITE_API_BASE=/api
VITE_EDITOR_URL=http://gpxstudio.example.com/app?embedded=1
```

`VITE_EDITOR_URL` is also the source of the bridge's `EDITOR_ORIGIN` (used to target outbound
postMessage and to validate inbound), so it must be the editor's real origin. Each side allows the
**other's** origin, never its own.

### Vite host check

Vite's dev server rejects `Host` headers it isn't told to trust (`Blocked request. This host … is
not allowed.`). Add your proxied hostnames to `server.allowedHosts` in **both** Vite configs —
`gpx.studio/website/vite.config.ts` and `frontend/vite.config.js`. A leading-dot wildcard covers a
domain and all its subdomains:

```js
server: { /* … */ allowedHosts: ['.example.com'] }
```

### Coverage caveat

The proxy covers `graphhopper`, `tiles`, `styles`, `overpass` — **not** `fonts`/`sprites`, and the
style JSON served from `styles.gpx.studio` still references `tiles`/`fonts`/`sprites` by their
original absolute URLs internally. So basic functionality (routing, elevation, terrain, POIs, most
basemaps) works, but **some map styles render imperfectly**. Fully fixing them means also proxying
fonts/sprites and rewriting the URLs inside the style JSON — out of scope for this POC.

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
When you switch to HTTPS, update the `VITE_*` URLs above to `https://`.

## Access from other machines (`--host`)

Bind all three servers to all interfaces and use the host machine's LAN IP/hostname in the URLs
(the iframe and API calls run in the *remote* browser, so `localhost` won't resolve there):

```bash
HOST=192.168.1.50    # this machine's LAN IP (e.g. `hostname -I`)

# backend
GPX_DATA_DIR=/path/to/scratch .venv/bin/uvicorn main:app --host 0.0.0.0 --port 3001
# editor
npm run dev -- --host
# shell — point API + editor at $HOST
VITE_API_BASE=http://$HOST:3001 VITE_EDITOR_URL=http://$HOST:5180/app?embedded=1 npm run dev -- --host
```

Then on the other machine open `http://$HOST:5174` in a `--disable-web-security` browser (the CORS
note above still applies). The backend already allows all origins (`allow_origins=["*"]`, POC only).
