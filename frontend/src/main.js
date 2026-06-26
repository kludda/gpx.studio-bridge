import '@fontsource-variable/inter'; // same font the editor uses (Inter Variable)
import { createIcons, CloudDownload, Activity } from 'lucide';
import { api } from './api.js';
import { createPoller } from './poll.js';

// Swap any <i data-lucide="…"> in the static markup for inline SVGs. Only the
// icons listed here are bundled (tree-shaken); re-call after injecting new
// data-lucide markup dynamically.
createIcons({ icons: { CloudDownload, Activity } });

const POLL_MS = Number(import.meta.env.VITE_POLL_MS) || 2000;

// --------------------------------------------------------------------------- //
// Config + origins. The shell (this page) and the editor (iframe) are different
// origins; we derive the editor's origin from its URL and only trust messages
// from it. VITE_EDITOR_URL is required — there is no built-in editor.
// --------------------------------------------------------------------------- //
const EDITOR_URL = import.meta.env.VITE_EDITOR_URL;
if (!EDITOR_URL) throw new Error('VITE_EDITOR_URL is required (the editor origin to frame)');
const editorFrame = document.getElementById('editor');
editorFrame.src = EDITOR_URL;
const EDITOR_ORIGIN = new URL(EDITOR_URL, location.href).origin;

function postToEditor(msg) {
  editorFrame.contentWindow?.postMessage(msg, EDITOR_ORIGIN);
}

// --------------------------------------------------------------------------- //
// Host registry: id (relative path) → { version }. `openIds` are the files
// currently framed in the editor (drives polling, and dedupes re-opens).
// --------------------------------------------------------------------------- //
const registry = new Map();
const openIds = new Set();

const statusEl = document.getElementById('status');
function setStatus(text) { statusEl.textContent = text; }

// Collaboration: poll the server for changes to open files → merge.
// onTick keeps the polling popup live: the poll set changes as files open,
// close, or get merged, so re-render whenever it's visible.
const poller = createPoller({
  api, registry, openIds, postToEditor, intervalMs: POLL_MS, setStatus,
  onTick: () => { if (!pollPopup.hidden) renderPollList(); },
});
poller.start();

// --------------------------------------------------------------------------- //
// Open a server file into the editor.
// --------------------------------------------------------------------------- //
async function openFile(path) {
  // Re-opening an already-open file is safe: the editor reuses the existing
  // localId↔hostId binding (no duplicate) and applies a whole-file LWW replace —
  // same as a poll `merge`, plus it re-focuses the file. So no open-guard here;
  // clicking an open file just re-syncs it from the server and brings it forward.
  try {
    const { data, version } = await api.getFile(path);
    registry.set(path, { version });
    openIds.add(path);
    postToEditor({ action: 'load', id: path, data, title: path.split('/').pop(), autosave: 1 });
    setStatus(`opened ${path}`);
    closePopup();
  } catch (err) {
    setStatus(`open failed: ${err.message}`);
  }
}

// --------------------------------------------------------------------------- //
// Host half of the protocol: editor → host.
// --------------------------------------------------------------------------- //
window.addEventListener('message', async (e) => {
  if (e.origin !== EDITOR_ORIGIN) return;
  const m = e.data || {};
  switch (m.event) {
    case 'init': {
      // The editor (re)announces its server-backed files (hostId + last-known
      // version) on load. Re-hydrate the poll set and reconcile each against the
      // server *now*, before the user can autosave a stale copy over a newer
      // version — the reload race. Priming openIds/registry first means that even
      // if the server list below fails, the regular poll revalidates on recovery.
      const announced = Array.isArray(m.files) ? m.files : [];
      for (const f of announced) {
        openIds.add(f.id);
        registry.set(f.id, { version: f.version });
      }
      setStatus('editor ready');
      let files;
      try {
        files = await api.listFiles();
      } catch (err) {
        setStatus(`editor ready — backend unreachable: ${err.message}`);
        break; // openIds is primed; poll loop revalidates once the backend is back
      }
      const serverVersion = new Map(files.map((f) => [f.path, f.version]));
      for (const f of announced) {
        const current = serverVersion.get(f.id);
        if (current === undefined) {
          // Gone on the server while the editor was away → drop it editor-side.
          postToEditor({ action: 'remove', id: f.id });
          openIds.delete(f.id);
          registry.delete(f.id);
        } else if (current !== f.version) {
          // Server moved on → push the newer copy down before any edit lands.
          try {
            const { data, version } = await api.getFile(f.id);
            registry.set(f.id, { version });
            postToEditor({ action: 'merge', id: f.id, data });
          } catch { /* leave primed; the poll loop retries */ }
        } else {
          // Already current → confirm so the editor clears its "revalidating" badge.
          postToEditor({ action: 'status', id: f.id, ok: true, version: current });
        }
      }
      if (announced.length) setStatus(`revalidated ${announced.length} file(s)`);
      break;
    }

    case 'load': // editor's ack of a finished load — informational
      break;

    case 'autosave':
    case 'save':
      // `id` present → update an existing file; absent → promotion: create from
      // `tempId`+`name` and bind it back to the editor via `status` (no separate assignId).
      try {
        if (m.id) {
          const base = registry.get(m.id)?.version;
          const { version } = await api.putFile(m.id, m.data, base);
          registry.set(m.id, { version }); // adopt our own write's version → poll won't echo it back
          // Rejoin the poll set: after a shell reload openIds is empty, so an
          // autosave to a still-open file would persist but stop receiving
          // collaboration. Re-adopting it here re-resumes polling (echo-safe — we
          // just took this file's own version, so the next poll reads unchanged).
          openIds.add(m.id);
          postToEditor({ action: 'status', id: m.id, ok: true, version });
          setStatus(`saved ${m.id}`);
        } else {
          const { path, version } = await api.createFile(m.name || 'untitled.gpx', m.data);
          registry.set(path, { version });
          openIds.add(path);
          // tempId tells the editor which local file to bind to the new path.
          postToEditor({ action: 'status', tempId: m.tempId, id: path, ok: true, version });
          setStatus(`created ${path}`);
        }
      } catch (err) {
        // tempId set on a create failure, id set on an update failure — send whichever we have.
        postToEditor({ action: 'status', tempId: m.tempId, id: m.id, ok: false, message: err.message });
        setStatus(`save failed: ${err.message}`);
      }
      break;
  }
});

// --------------------------------------------------------------------------- //
// Open popup — file tree drawn over the iframe.
// --------------------------------------------------------------------------- //
const openBtn = document.getElementById('openBtn');
const popup = document.getElementById('openPopup');
const treeEl = document.getElementById('fileTree');
let lastFiles = [];

function closePopup() { popup.hidden = true; }

openBtn.addEventListener('click', async () => {
  if (popup.hidden) { popup.hidden = false; await refreshTree(); }
  else closePopup();
});
document.getElementById('refreshBtn').addEventListener('click', refreshTree);
document.addEventListener('click', (e) => {
  if (!popup.hidden && !popup.contains(e.target) && e.target !== openBtn) closePopup();
});

async function refreshTree() {
  try {
    lastFiles = await api.listFiles(true); // with_name → show <metadata><name> in labels
    renderTree(lastFiles);
  } catch (err) {
    treeEl.innerHTML = `<div class="empty">list failed: ${err.message}</div>`;
  }
}

// Build a nested tree from flat relative paths (split on '/').
function renderTree(files) {
  treeEl.innerHTML = '';
  if (!files.length) { treeEl.innerHTML = '<div class="empty">no .gpx files</div>'; return; }
  const root = {};
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    parts.forEach((part, i) => {
      const leaf = i === parts.length - 1;
      node[part] = node[part] || (leaf ? { __file: f } : {});
      node = node[part];
    });
  }
  treeEl.append(...renderNode(root, ''));
}

function renderNode(node, prefix) {
  const els = [];
  for (const [name, child] of Object.entries(node).sort(folderFirst)) {
    if (child.__file) {
      const f = child.__file;
      const row = document.createElement('div');
      row.className = 'file';
      row.dataset.path = f.path;
      // Label: "<metadata name> — <filename>" when the file carries a metadata
      // name (the editor's display name), else just the filename.
      const label = f.name
        ? `${esc(f.name)} <span class="dim">— ${esc(name)}</span>`
        : esc(name);
      row.innerHTML = `<span>${label}</span>`;
      row.addEventListener('click', () => openFile(f.path));
      els.push(row);
    } else {
      const folder = document.createElement('div');
      folder.className = 'folder';
      folder.textContent = name + '/';
      els.push(folder, ...renderNode(child, prefix + name + '/'));
    }
  }
  return els;
}

// Escape text before it goes into innerHTML — metadata names are arbitrary
// user-entered strings and must not break (or inject) markup.
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function folderFirst([an, av], [bn, bv]) {
  const af = av.__file ? 1 : 0, bf = bv.__file ? 1 : 0;
  return af - bf || an.localeCompare(bn);
}

// --------------------------------------------------------------------------- //
// Polling popup — dev view of the files the poll loop is currently watching
// (the `openIds` set). Re-rendered live from onTick while open.
// --------------------------------------------------------------------------- //
const pollBtn = document.getElementById('pollBtn');
const pollPopup = document.getElementById('pollPopup');
const pollList = document.getElementById('pollList');
const pollMeta = document.getElementById('pollMeta');

pollBtn.addEventListener('click', () => {
  if (pollPopup.hidden) { pollPopup.hidden = false; renderPollList(); }
  else pollPopup.hidden = true;
});
document.addEventListener('click', (e) => {
  if (!pollPopup.hidden && !pollPopup.contains(e.target) && e.target !== pollBtn && !pollBtn.contains(e.target)) {
    pollPopup.hidden = true;
  }
});

function renderPollList() {
  const paths = [...openIds].sort((a, b) => a.localeCompare(b));
  pollMeta.textContent = `· every ${POLL_MS}ms · ${paths.length} file(s)`;
  if (!paths.length) {
    pollList.innerHTML = '<div class="empty">no files open — nothing polled</div>';
    return;
  }
  pollList.innerHTML = paths.map((p) => {
    const v = registry.get(p)?.version;
    return `<div class="poll-row"><span>${esc(p)}</span><span class="ver">v ${v ?? '?'}</span></div>`;
  }).join('');
}

// --------------------------------------------------------------------------- //
// Maps link field — an inline box in the top bar. Convert posts the link to the
// backend's /convert endpoint and drops the resulting GPX <wpt> into a popup.
// "Add to file" then splices that <wpt> into an open file (the server stays the
// source of truth): GET the target, insert the wpt, PUT it back, and push a
// `merge` to the editor — reusing the existing open-file API + collaboration
// path. The host can't know which file is *selected* in the editor (selection
// never crosses postMessage), so the user picks from the open files (`openIds`).
// --------------------------------------------------------------------------- //
const mapsPopup = document.getElementById('mapsPopup');
const mapsInput = document.getElementById('mapsInput');
const convertBtn = document.getElementById('convertBtn');
const mapsResult = document.getElementById('mapsResult');
const mapsAdd = document.getElementById('mapsAdd');
const mapsTarget = document.getElementById('mapsTarget');
const addWptBtn = document.getElementById('addWptBtn');

let lastConvert = null; // {lat, lng, name, gpx} from the most recent successful convert

// Dismiss the result popup on an outside click (but not when clicking the field
// or Convert — those drive it).
document.addEventListener('click', (e) => {
  if (!mapsPopup.hidden && !mapsPopup.contains(e.target)
      && e.target !== mapsInput && e.target !== convertBtn && !convertBtn.contains(e.target)) {
    mapsPopup.hidden = true;
  }
});

// Reflect the current open-file set into the "Add to file" controls.
//   0 open → no picker; the button opens the pin as a new file.
//   1 open → no picker (preselected); the button names that file.
//  ≥2 open → a <select> of the open paths.
function renderAddTarget() {
  if (!lastConvert) { mapsAdd.hidden = true; return; }
  const paths = [...openIds].sort((a, b) => a.localeCompare(b));
  mapsAdd.hidden = false;
  if (paths.length >= 2) {
    mapsTarget.hidden = false;
    mapsTarget.innerHTML = paths.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    addWptBtn.textContent = 'Add to file';
  } else {
    mapsTarget.hidden = true;
    mapsTarget.innerHTML = paths.length ? `<option value="${esc(paths[0])}">${esc(paths[0])}</option>` : '';
    addWptBtn.textContent = paths.length ? `Add to ${paths[0]}` : 'Add as new file';
  }
}

// Pull the single <wpt>…</wpt> block out of the converter's standalone GPX. Safe
// because that document is built by maps_convert.py's _build_wpt (format we own).
function extractWpt(gpx) {
  return gpx.match(/<wpt[\s\S]*?<\/wpt>/)?.[0] ?? null;
}

// Splice a <wpt> into an existing GPX. GPX 1.1 orders children metadata, wpt*,
// rte*, trk* — so insert *before the first rte/trk* (else before </gpx>) to keep
// the file schema-valid rather than appending the waypoint after the tracks.
function insertWpt(gpx, wpt) {
  const at = gpx.search(/<(rte|trk)[\s>]/);
  const pos = at !== -1 ? at : gpx.lastIndexOf('</gpx>');
  if (pos === -1) return gpx; // not a GPX document we recognise — leave untouched
  // Back up over the anchor's own-line indentation so the inserted <wpt> adopts
  // it (and the anchor keeps it), rather than landing flush-left.
  let start = pos;
  while (start > 0 && (gpx[start - 1] === ' ' || gpx[start - 1] === '\t')) start--;
  const indent = gpx.slice(start, pos);
  return gpx.slice(0, start) + `${indent}${wpt}\n${indent}` + gpx.slice(pos);
}

async function addWptToFile() {
  if (!lastConvert) return;
  const wpt = extractWpt(lastConvert.gpx);
  if (!wpt) { setStatus('add failed: no <wpt> in converted GPX'); return; }
  const path = mapsTarget.value || null; // null when no file is open

  addWptBtn.disabled = true;
  try {
    if (!path) {
      // No open file → create the pin as a real server file *first*, then load it
      // by that id. A `load` must always carry a hostId: the editor's load handler
      // registers the file as server-backed, so an id-less load would bind it to
      // `hostId: undefined` — which the editor drops on reload (demoting it to a
      // browser-local file) and which routes its autosaves into the host's
      // promotion branch (spawning stray files). Creating on the server up front
      // gives a proper, syncing file that also appears in the picker next time.
      const base = (lastConvert.name || 'Google Maps Pin').replace(/[\\/]+/g, '-');
      const { path: newPath, version } = await api.createFile(`${base}.gpx`, lastConvert.gpx);
      registry.set(newPath, { version });
      openIds.add(newPath);
      postToEditor({ action: 'load', id: newPath, data: lastConvert.gpx, title: newPath.split('/').pop() });
      setStatus(`created ${newPath}`);
      mapsPopup.hidden = true;
      return;
    }
    const { data, version } = await api.getFile(path);
    const merged = insertWpt(data, wpt);
    const { version: newVersion } = await api.putFile(path, merged, version);
    registry.set(path, { version: newVersion }); // adopt our own write → poll won't echo it back as a merge
    openIds.add(path);
    postToEditor({ action: 'merge', id: path, data: merged });
    setStatus(`added waypoint to ${path}`);
    mapsPopup.hidden = true;
  } catch (err) {
    // 409 here means someone wrote between our GET and PUT; the poll loop will
    // merge their copy, after which the user can retry the add.
    setStatus(`add failed: ${err.message}`);
  } finally {
    addWptBtn.disabled = false;
  }
}

async function convertMaps() {
  const input = mapsInput.value.trim();
  if (!input) return;
  convertBtn.disabled = true;
  mapsResult.textContent = 'converting…';
  mapsAdd.hidden = true;
  lastConvert = null;
  mapsPopup.hidden = false;
  try {
    const res = await api.convertMapsLink(input);
    lastConvert = res;
    mapsResult.textContent = `${res.name || '(no name)'} — ${res.lat}, ${res.lng}\n\n${res.gpx}`;
    renderAddTarget();
    setStatus(`converted: ${res.lat}, ${res.lng}`);
  } catch (err) {
    mapsResult.textContent = `convert failed: ${err.message}`;
    setStatus(`convert failed: ${err.message}`);
  } finally {
    convertBtn.disabled = false;
  }
}

convertBtn.addEventListener('click', convertMaps);
addWptBtn.addEventListener('click', addWptToFile);
mapsInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); convertMaps(); }
});
