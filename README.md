# gpx.studio-bridge

A tiny **host** for gpx.studio's embedded mode: a top-bar file menu + an `<iframe>` running
gpx.studio, backed by a folder of `.gpx` files on disk. The bridge is the filesystem ⇄ `postMessage`
translator — it owns storage, identity and versioning; the editor owns no files. Collaboration is
last-write-wins via polling.

- `backend/` — FastAPI folder store (a directory of nested `.gpx`; id = relative path; version = mtime).
- `frontend/` — Vite shell (top bar, Open popup, protocol host half, poll loop).
- `dev/` — protocol mocks (`fake-editor.html`, `fake-host.html`) for testing without the real editor.

## Run

The bridge is two processes — the **backend** store and the **frontend** shell. The commands below
bind to all interfaces so other machines on the LAN can reach the shell; for a single-machine run set
`HOST=localhost` and drop `--host`. The backend stays on `localhost` — only the shell's Vite `/api`
proxy reaches it, server-side.

```bash
HOST=192.168.1.50    # this machine's LAN IP (e.g. `hostname -I`); use localhost for a local-only run

# 1. Backend — folder store on :3001 (interactive API docs at /api/docs and /api/redoc)
cd backend
python -m venv .venv && .venv/bin/pip install -r requirements.txt   # first time
cp .env.example .env                                                # first time; edit GPX_DATA_DIR / ROOT_PATH=/api
.venv/bin/uvicorn main:app --reload --port 3001 --env-file .env

# 2. Frontend shell — :5174, point the iframe at $HOST's editor
cd ../frontend
npm install                                                         # first time
VITE_API_BASE=/api VITE_EDITOR_URL=http://$HOST:5180/app?embedded=1 npm run dev -- --host
```

Run the **editor** (the gpx.studio fork, `embedded-dev`) separately, with `--host` — see
[`../gpx.studio/README-EMBEDDED.md`](../gpx.studio/README-EMBEDDED.md). Add `$HOST` (or a
`.`-prefixed domain) to `server.allowedHosts` in both Vite configs if Vite rejects the `Host` header.

Then open **`http://$HOST:5174`** in a normal browser (no `--disable-web-security` needed — the
gpx.studio services and `/api` are proxied same-origin by the two Vite servers). Leave
`VITE_EDITOR_URL` unset to use the mock `fake-editor.html` instead of the real editor.

Config: `frontend/.env` (`VITE_API_BASE`, `VITE_EDITOR_URL`, `VITE_POLL_MS`) and `backend/.env`
(`GPX_DATA_DIR`, `ROOT_PATH`, loaded via uvicorn's `--env-file`); see the `.env.example` files.

## The embed protocol (postMessage)

The editor↔host `postMessage` protocol — handshake, the `event`/`action` message tables, and
promotion — is documented with the editor, in
**[`../gpx.studio/README-EMBEDDED.md`](../gpx.studio/README-EMBEDDED.md)**. The bridge implements the
**host** half: `frontend/src/main.js` handles inbound `event`s over the FastAPI folder store
(`backend/`).

### Collaboration (last-write-wins, poll-based — no websocket)

The host polls `GET /files` every `VITE_POLL_MS`. When an **open** file's `version` is newer than the
registry's, it `GET /file`s the bytes and pushes `{action:'merge', id, data}`. Local edits flow the
other way as `autosave` → `PUT /file` → `{action:'status', id, ok:true, version}`; the host adopts its own
write's version so it doesn't immediately re-`merge` its own change. Whole-file replace throughout —
deliberately simple. A real platform host (OpenCloud/Nextcloud) is the same protocol with WebDAV
storage and an ETag `version`.

## CORS (gpx.studio services)

gpx.studio's `graphhopper`/`overpass` services are CORS-locked to `https://gpx.studio`. The **editor**
fixes this itself by proxying them through its own Vite dev server (same-origin fetch → no CORS) —
see the CORS-fix section in
**[`../gpx.studio/README-EMBEDDED.md`](../gpx.studio/README-EMBEDDED.md)**. The bridge does the
analogous thing for its own store: `frontend/vite.config.js` proxies `/api` → `:3001` so the shell
calls the backend same-origin. Because both are handled inside Vite, the external reverse proxy below
only has to route the two app domains.

## Reverse proxy (two app domains)

To run the app over real hostnames in any browser (no flags), put a reverse proxy in front that
routes the **two app domains** to their dev servers. The gpx.studio services and the bridge backend
are proxied *inside* Vite now (see [CORS](#cors-gpxstudio-services) above), so the external proxy is
just two dumb routes:

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

**Editor** (`gpx.studio/website/.env`) — relative service paths + the postMessage allowlist; see
[`../gpx.studio/README-EMBEDDED.md`](../gpx.studio/README-EMBEDDED.md) (set
`VITE_EMBED_ALLOWED_ORIGINS` to this shell's origin, e.g. `http://gpx.example.com`).

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
`frontend/vite.config.js` (this shell) and `gpx.studio/website/vite.config.ts` (the editor). A
leading-dot wildcard covers a domain and all its subdomains:

```js
server: { /* … */ allowedHosts: ['.example.com'] }
```

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
