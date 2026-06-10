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

gpx.studio's backend services (`styles/tiles/fonts/sprites/graphhopper.gpx.studio`) only send CORS
headers for the `https://gpx.studio` origin, so from any other origin the basemap/routing/elevation
silently fail ("tools dead"). For local/dev use, open the shell in a **dedicated throwaway** browser
profile with web security off (never your normal browser):

```bash
chromium --user-data-dir=/tmp/gpxdev --disable-web-security http://localhost:5174
```

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
