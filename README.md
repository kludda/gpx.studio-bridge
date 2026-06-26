# gpx.studio-bridge

A tiny **host** for gpx.studio's embedded mode: a top-bar file menu + an `<iframe>` running
gpx.studio, backed by a folder of `.gpx` files on disk. The bridge is the filesystem ⇄ `postMessage`
translator — it owns storage, identity and versioning; the editor owns no files. Collaboration is
last-write-wins via polling.

- `backend/` — FastAPI folder store (a directory of nested `.gpx`; id = relative path; version = mtime).
- `frontend/` — Vite shell (top bar, Open popup, protocol host half, poll loop).

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
gpx.studio services and `/api` are proxied same-origin by the two Vite servers). `VITE_EDITOR_URL`
is required — the shell frames whatever editor origin it points at.

Config: `frontend/.env` (`VITE_API_BASE`, `VITE_EDITOR_URL`, `VITE_POLL_MS`) and `backend/.env`
(`GPX_DATA_DIR`, `ROOT_PATH`, loaded via uvicorn's `--env-file`); see the `.env.example` files.

## The embed protocol (postMessage)

The editor↔host `postMessage` protocol — handshake, the `event`/`action` message tables, and
promotion — is documented with the editor, in
**[`../gpx.studio/README-EMBEDDED.md`](../gpx.studio/README-EMBEDDED.md)**. The bridge implements the
**host** half: `frontend/src/main.js` handles inbound `event`s over the FastAPI folder store
(`backend/`).

### Collaboration (poll-based, no websocket)

Storage, identity and versioning are the host's. `version` is the file's **mtime in microseconds**
(`st_mtime_ns // 1000`) — coarser than nanoseconds but under JS's `Number.MAX_SAFE_INTEGER`, so it
round-trips through the shell's JSON intact (a raw `st_mtime_ns` would round in JS and break the
conflict check below). The host keeps a `registry` (`hostId → version`) and an `openIds` set of files
currently framed in the editor; **only open files are synced.**

**Steady-state poll.** Every `VITE_POLL_MS` the host `GET /files` and, per open file, compares the
server `version` to the registry. Newer on the server → `GET /file` → `{action:'merge', id, data}`
(whole-file replace). Gone → `{action:'remove', id}`. The same loop doubles as the connectivity
heartbeat (see **Connection loss** below).

**Local edits + echo avoidance.** `autosave` → `PUT /file` with `baseVersion` = the registry's
version → `{action:'status', id, ok:true, version}`. The host **adopts its own write's version** into
the registry, so the next poll reads "unchanged" and doesn't bounce the edit back as a `merge`.

**Reload reconciliation.** `openIds` is in-memory, so after a shell/editor reload it's empty and the
editor's restored (Dexie) copies may be behind the server. Without reconciliation a first edit would
`autosave` a stale copy *over* a newer server version. So on `{event:'init'}` the editor re-announces
its server-backed files (`[{id, version}]`); the host primes `openIds`/registry from them and
immediately reconciles each against the server — **newer → merge down, in-sync → status confirm,
deleted → remove** — *before* the user can edit. Restored files show a "revalidating" badge until
that reply lands (not a falsely-confident "Saved"). Priming `openIds` first means the regular poll
still revalidates on recovery even if that initial list call fails.

**Conflict detection.** `PUT` enforces `baseVersion`: if the file changed on the server since the
base the edit was built on, the write is **rejected with 409** instead of clobbering the newer
content. So when two sessions edit concurrently, the **first to reach the server wins**; the loser's
`autosave` 409s (red badge + error toast) and its next poll merges the winner's version down — the
losing edit is **discarded** (whole-file LWW, no field-level merge). `baseVersion: null` skips the
check (a first/forced save). This is the one deliberate departure from pure last-write-wins, traded
for not silently losing an already-committed save.

**Connection loss.** If the backend (or an auth gateway in front of it — e.g. an expired Cloudflare
tunnel) becomes unreachable, the poll's `GET /files` fails: the shell shows `⚠ disconnected (N failed
polls)` and re-sends a **global notice every tick** — `{action:'status', ok:false, message}` with
**no `id`** — which the editor renders as one sticky toast ("Connection lost, please reload browser")
that auto-clears on recovery. The `frontend/src/api.js` client treats redirected, non-JSON, and
network-error responses as failures (and validates the response shape), so a save attempted while
down fails loudly instead of masquerading as saved.

Whole-file replace throughout — deliberately simple. A real platform host (OpenCloud/Nextcloud) is
the same protocol with WebDAV storage and an ETag `version`.

## CORS (gpx.studio services)

gpx.studio's `graphhopper`/`overpass` services are CORS-locked to `https://gpx.studio`. The **editor**
fixes this itself by proxying them through its own Vite dev server (same-origin fetch → no CORS) —
see the CORS-fix section in
**[`../gpx.studio/README-EMBEDDED.md`](../gpx.studio/README-EMBEDDED.md)**. The bridge does the
analogous thing for its own store: `frontend/vite.config.js` proxies `/api` → `:3001` so the shell
calls the backend same-origin. Because both are handled inside Vite, the external reverse proxy below
only has to route the two app domains.

## Reverse proxy

To serve the app over real hostnames in any browser (no flags), put a reverse proxy in front routing
the **two app domains** — `gpxstudio.example.com` → the editor (`:5180`) and `gpx.example.com` → the
bridge shell (`:5174`) — to their Vite dev servers. The gpx.studio services and the bridge backend
are proxied *inside* Vite (see [CORS](#cors-gpxstudio-services) above), so the external proxy is just
those two routes. Plain HTTP by default; HTTPS (incl. the DNS challenge) is a one-line change.

See **[`Caddyfile.example`](Caddyfile.example)** for the ready-to-edit config and TLS notes.

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
