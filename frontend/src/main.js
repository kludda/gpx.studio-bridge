import { api } from './api.js';
import { createPoller } from './poll.js';

const POLL_MS = Number(import.meta.env.VITE_POLL_MS) || 2000;

// --------------------------------------------------------------------------- //
// Config + origins. The shell (this page) and the editor (iframe) are different
// origins in M8; in the M1–M4 mock the fake-editor is served same-origin from
// publicDir. Either way we derive the editor's origin from its URL and only
// trust messages from it.
// --------------------------------------------------------------------------- //
const EDITOR_URL = import.meta.env.VITE_EDITOR_URL || '/fake-editor.html';
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
const poller = createPoller({ api, registry, openIds, postToEditor, intervalMs: POLL_MS, setStatus });
poller.start();

// --------------------------------------------------------------------------- //
// Open a server file into the editor.
// --------------------------------------------------------------------------- //
async function openFile(path) {
  if (openIds.has(path)) { closePopup(); return; }
  try {
    const { data, version } = await api.getFile(path);
    registry.set(path, { version });
    openIds.add(path);
    postToEditor({ action: 'load', id: path, data, title: path.split('/').pop(), autosave: 1 });
    setStatus(`opened ${path}`);
    renderTreeOpenState();
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
    case 'init':
      setStatus('editor ready');
      break;

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
        renderTreeOpenState();
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
    lastFiles = await api.listFiles();
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
      row.className = 'file' + (openIds.has(f.path) ? ' open' : '');
      row.dataset.path = f.path;
      row.innerHTML = `<span>${name}</span><span class="badge">${openIds.has(f.path) ? 'open' : ''}</span>`;
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

function folderFirst([an, av], [bn, bv]) {
  const af = av.__file ? 1 : 0, bf = bv.__file ? 1 : 0;
  return af - bf || an.localeCompare(bn);
}

function renderTreeOpenState() {
  if (!popup.hidden) renderTree(lastFiles);
}
