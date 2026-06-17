// API client for the FastAPI folder store (backend/main.py).

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';

async function json(res) {
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail ?? detail; } catch {}
    throw new Error(`${res.status} ${detail}`);
  }
  return res.json();
}

export const api = {
  // → [{ path, version, name? }]  (name = <metadata><name>, only with withName)
  listFiles(withName = false) {
    const qs = withName ? '?with_name=1' : '';
    return fetch(`${API_BASE}/files${qs}`).then(json);
  },
  // → { path, version, data }
  getFile(path) {
    return fetch(`${API_BASE}/file?path=${encodeURIComponent(path)}`).then(json);
  },
  // create (promotion) → { path, version }  (path may be auto-suffixed on collision)
  createFile(path, data) {
    return fetch(`${API_BASE}/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, data }),
    }).then(json);
  },
  // save (autosave/save) → { path, version }
  putFile(path, data, baseVersion) {
    return fetch(`${API_BASE}/file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, data, baseVersion: baseVersion ?? null }),
    }).then(json);
  },
};
