"""Bridge backend — a FastAPI folder store for the embedded-gpx.studio POC.

The host owns the files. This serves a directory of nested ``.gpx`` files where
the **file id is its relative path** (no sidecar). ``version`` is ``st_mtime_ns``,
used by the shell's poll loop for last-write-wins collaboration.

Run:  GPX_DATA_DIR=/path/to/scratch uvicorn main:app --reload --port 3001
"""

from __future__ import annotations

import html
import os
import re
import threading
from collections import defaultdict
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

DATA_DIR = Path(os.environ.get("GPX_DATA_DIR", "./gpx-data")).resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)

# Public path prefix when served behind a reverse proxy that strips it
# (e.g. Caddy `handle_path /api/*`). Lets the auto-docs reference the correct
# `<ROOT_PATH>/openapi.json` instead of `/openapi.json` at the site root.
# Leave unset for direct access (uvicorn on :3001) — docs then live at `/docs`.
ROOT_PATH = os.environ.get("ROOT_PATH", "")

app = FastAPI(
    title="gpx.studio bridge store",
    version="0.1.0",
    root_path=ROOT_PATH,
    description=(
        "Folder store for the embedded-gpx.studio POC. The host owns the files; "
        "this serves a directory of nested `.gpx` files where the **file id is its "
        "relative path** (no sidecar) and `version` is the file's `st_mtime_ns`.\n\n"
        "The Vite shell's poll loop reads `version` to detect out-of-band edits and "
        "apply **last-write-wins** collaboration. Interactive docs: `/docs` "
        "(Swagger UI) and `/redoc`."
    ),
)

# The Vite shell runs on a different origin (port). Allow it (and dev tooling).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # POC, local only
    allow_methods=["*"],
    allow_headers=["*"],
)

# Per-path write locks so concurrent PUT/POST on the same file serialize.
_locks: dict[str, threading.Lock] = defaultdict(threading.Lock)


# --------------------------------------------------------------------------- #
# Path safety: every request path is resolved against DATA_DIR and must stay
# inside it, and must be a ``.gpx`` file. Anything else is rejected.
# --------------------------------------------------------------------------- #
def _resolve(rel: str) -> Path:
    rel = (rel or "").strip().lstrip("/")
    if not rel:
        raise HTTPException(400, "empty path")
    if not rel.lower().endswith(".gpx"):
        raise HTTPException(400, "only .gpx files are allowed")
    target = (DATA_DIR / rel).resolve()
    try:
        target.relative_to(DATA_DIR)
    except ValueError:
        raise HTTPException(400, "path traversal rejected")
    return target


def _relpath(p: Path) -> str:
    return p.relative_to(DATA_DIR).as_posix()


def _version(p: Path) -> int:
    # Microsecond mtime (ns // 1000). Coarser than full st_mtime_ns but it stays
    # under JS Number.MAX_SAFE_INTEGER (~9e15), so it round-trips through the
    # shell's JSON without precision loss. That matters now that PUT enforces
    # baseVersion: an ns value would round in JS and a rounded base would
    # false-positive as a conflict on an otherwise-clean save.
    return p.stat().st_mtime_ns // 1000


# The editor writes the open file's display name to `<metadata><name>` (renaming
# a file edits this, not the filename). Match the metadata block first, then the
# `<name>` *within* it, so a block without a name doesn't fall through to a later
# `<trk><name>`.
_METADATA = re.compile(r"<metadata\b[^>]*>(.*?)</metadata>", re.DOTALL | re.IGNORECASE)
_NAME = re.compile(r"<name\b[^>]*>(.*?)</name>", re.DOTALL | re.IGNORECASE)


def _metadata_name(p: Path) -> str | None:
    """Extract `<metadata><name>` for the Open popup's label, or None.

    Reads only a bounded prefix (metadata sits at the top of a GPX file, before
    the track points) so this stays cheap even for large files, and unescapes
    XML entities so the raw display name is returned.
    """
    try:
        with p.open("r", encoding="utf-8", errors="replace") as fh:
            head = fh.read(65536)
    except OSError:
        return None
    block = _METADATA.search(head)
    if not block:
        return None
    m = _NAME.search(block.group(1))
    if not m:
        return None
    name = html.unescape(m.group(1)).strip()
    return name or None


# --------------------------------------------------------------------------- #
# Models
# --------------------------------------------------------------------------- #
class FileEntry(BaseModel):
    path: str = Field(description="File id: path relative to the data root, e.g. `trips/day1.gpx`.")
    version: int = Field(description="Opaque version token (`st_mtime_ns`); compared by the poll loop.")
    name: str | None = Field(
        default=None,
        description=(
            "The file's `<metadata><name>` (the editor's display name), or null if "
            "absent. Only populated when listed with `?with_name=1`."
        ),
    )


class FileContent(BaseModel):
    path: str = Field(description="File id: path relative to the data root.")
    version: int = Field(description="Opaque version token (`st_mtime_ns`) at read time.")
    data: str = Field(description="Raw GPX XML contents of the file.")


class CreateBody(BaseModel):
    path: str = Field(description="Desired file id (relative `.gpx` path); auto-suffixed on collision.")
    data: str = Field(description="Raw GPX XML to write.")


class SaveBody(BaseModel):
    path: str = Field(description="File id (relative `.gpx` path) to overwrite.")
    data: str = Field(description="Raw GPX XML to write.")
    baseVersion: int | None = Field(
        default=None,
        description=(
            "Version the edit was based on. When provided, the write is rejected "
            "with **409** if the file has since changed on the server (the edit "
            "was based on a stale copy). Pass `null` to skip the check and force a "
            "last-write-wins overwrite (e.g. a first save with no known base)."
        ),
    )


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@app.get("/files", response_model=list[FileEntry])
def list_files(
    with_name: bool = Query(
        False,
        description=(
            "Also read each file's `<metadata><name>` into `name`. The Open popup "
            "sets this; the 2s poll loop leaves it off to avoid reading every file."
        ),
    ),
) -> list[FileEntry]:
    """List every file in the store.

    Walks the data directory recursively and returns one ``{path, version}``
    entry per ``.gpx`` file, sorted by path. ``path`` is the file id (its path
    relative to the data root); ``version`` is ``st_mtime_ns``. With
    ``?with_name=1`` each entry also carries the file's ``<metadata><name>`` in
    ``name`` (for the Open popup's label). Drives the shell's Open popup and the
    poll loop that detects out-of-band changes for last-write-wins collaboration.
    """
    out: list[FileEntry] = []
    for p in sorted(DATA_DIR.rglob("*.gpx")):
        if p.is_file():
            name = _metadata_name(p) if with_name else None
            out.append(FileEntry(path=_relpath(p), version=_version(p), name=name))
    return out


@app.get("/file", response_model=FileContent)
def get_file(path: str = Query(...)) -> FileContent:
    """Read one file's contents by path.

    Returns ``{path, version, data}`` where ``data`` is the raw GPX XML. The
    ``path`` query parameter is the file id; it is resolved against the data
    root and rejected with **400** if it is empty, not a ``.gpx`` file, or
    escapes the root (path traversal), and **404** if it does not exist.
    """
    target = _resolve(path)
    if not target.is_file():
        raise HTTPException(404, "not found")
    return FileContent(
        path=_relpath(target),
        version=_version(target),
        data=target.read_text(encoding="utf-8"),
    )


@app.post("/file", response_model=FileEntry)
def create_file(body: CreateBody) -> FileEntry:
    """Create a new file (promotion of an unsaved editor doc).

    Writes ``data`` to ``path``, creating parent folders as needed. To guarantee
    a create never clobbers an existing file, the path is **auto-suffixed on
    collision** (``name (1).gpx``, ``name (2).gpx``, …) and the path actually
    written is returned in the response. Use ``PUT /file`` to overwrite a known
    file. Same path validation (and 400s) as ``GET /file``.
    """
    target = _resolve(body.path)
    with _locks[_relpath(target)]:
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            target = _unique_path(target)
        target.write_text(body.data, encoding="utf-8")
        return FileEntry(path=_relpath(target), version=_version(target))


@app.put("/file", response_model=FileEntry)
def save_file(body: SaveBody) -> FileEntry:
    """Save a file (autosave or explicit save).

    Whole-file overwrite of ``path`` with ``data`` (parent folders created as
    needed). If ``baseVersion`` is given and the file's current version differs,
    the edit was based on a stale copy and is rejected with **409** rather than
    clobbering the newer content — the guard against an out-of-date editor (e.g.
    just after a browser reload) overwriting someone else's later save. A ``null``
    ``baseVersion`` skips the check (last-write-wins). Returns the new
    ``{path, version}``. Same path validation (and 400s) as ``GET /file``.
    """
    target = _resolve(body.path)
    rel = _relpath(target)
    with _locks[rel]:
        if body.baseVersion is not None and target.exists():
            current = _version(target)
            if current != body.baseVersion:
                raise HTTPException(
                    409,
                    f"version conflict: file changed on the server "
                    f"(base {body.baseVersion}, current {current})",
                )
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body.data, encoding="utf-8")
        return FileEntry(path=rel, version=_version(target))


def _unique_path(target: Path) -> Path:
    stem, suffix, parent = target.stem, target.suffix, target.parent
    i = 1
    while True:
        cand = parent / f"{stem} ({i}){suffix}"
        if not cand.exists():
            return cand
        i += 1


@app.get("/health")
def health() -> dict:
    """Liveness probe → ``{ok, dataDir}``.

    Cheap readiness check for the dev startup scripts; also reports the resolved
    data directory so you can confirm the backend is serving the folder you
    expect.
    """
    return {"ok": True, "dataDir": str(DATA_DIR)}
