# gpx.studio-bridge (reference host) — Claude Code working rules

The host half of the embed POC: a FastAPI folder store + a Vite shell that frames the editor. Usage,
the architecture, the poll-based collaboration design, CORS, and reverse-proxy setup live in
**`README.md`**. This file is only how to work in this repo.

## Layout
- `backend/` — FastAPI folder store (nested `.gpx`; id = relative path; version = mtime).
- `frontend/` — Vite shell (top bar, Open popup, protocol host half, poll loop).
- `dev/` — protocol mocks (`fake-editor.html`, `fake-host.html`) for testing without the real editor.

## Branches & commits
- `dev` — **default working branch**; commit at will, push often (remote backup).
- `main` — tidy; **only squashed large commits, and only when explicitly asked.**
- Keep bridge changes in their own commits, separate from the editor.

## Invariants (never violate — see `README.md` for the why)
- The host owns **storage, identity and versioning**; the editor owns no files.
- Only `id` (the file's store-relative path) crosses postMessage — the editor's `gpx-N` local ids
  never reach the host.
- Collaboration is by **polling, not WebSocket** — deliberate.
- Apply inbound updates as whole-file last-write-wins; conflicts are caught by `baseVersion` (409),
  not field-merged.
