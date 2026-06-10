"""Bridge backend — a FastAPI folder store for the embedded-gpx.studio POC.

The host owns the files. This serves a directory of nested ``.gpx`` files where
the **file id is its relative path** (no sidecar). ``version`` is ``st_mtime_ns``,
used by the shell's poll loop for last-write-wins collaboration.

Run:  GPX_DATA_DIR=/path/to/scratch uvicorn main:app --reload --port 3001
"""

from __future__ import annotations

import os
import threading
from collections import defaultdict
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

DATA_DIR = Path(os.environ.get("GPX_DATA_DIR", "./gpx-data")).resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="gpx.studio bridge store")

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
    return p.stat().st_mtime_ns


# --------------------------------------------------------------------------- #
# Models
# --------------------------------------------------------------------------- #
class FileEntry(BaseModel):
    path: str
    version: int


class FileContent(BaseModel):
    path: str
    version: int
    data: str


class CreateBody(BaseModel):
    path: str
    data: str


class SaveBody(BaseModel):
    path: str
    data: str
    baseVersion: int | None = None


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@app.get("/files", response_model=list[FileEntry])
def list_files() -> list[FileEntry]:
    """Walk the tree → ``[{path, version}]`` for the Open popup."""
    out: list[FileEntry] = []
    for p in sorted(DATA_DIR.rglob("*.gpx")):
        if p.is_file():
            out.append(FileEntry(path=_relpath(p), version=_version(p)))
    return out


@app.get("/file", response_model=FileContent)
def get_file(path: str = Query(...)) -> FileContent:
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
    """Create (promotion). Auto-suffixes on collision so a POST never clobbers."""
    target = _resolve(body.path)
    with _locks[_relpath(target)]:
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            target = _unique_path(target)
        target.write_text(body.data, encoding="utf-8")
        return FileEntry(path=_relpath(target), version=_version(target))


@app.put("/file", response_model=FileEntry)
def save_file(body: SaveBody) -> FileEntry:
    """Save an existing file (autosave/save). Whole-file LWW.

    ``baseVersion`` is accepted for echo bookkeeping but, by design, this is
    last-write-wins: a stale base does not block the write.
    """
    target = _resolve(body.path)
    rel = _relpath(target)
    with _locks[rel]:
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
    return {"ok": True, "dataDir": str(DATA_DIR)}
