// API client for the FastAPI folder store (backend/main.py).

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';

// Turn a fetch Response into our backend's JSON, or throw. This is the single
// chokepoint that decides "did the backend actually answer?", so it has to be
// strict: when an auth gateway / reverse proxy sits in front of the backend
// (e.g. a Cloudflare Access session that expired), it can intercept the request
// and reply with a *200* login/redirect page. If we trusted that, a write would
// look like it succeeded. So we reject anything that doesn't look like our API:
//   - a response that was redirected (bounced to a login page),
//   - a non-JSON content-type (an HTML interstitial),
//   - a non-2xx status.
async function json(res) {
  if (res.redirected) {
    // CORS-followed redirects only reach us when the final hop allows our
    // origin; same-origin proxies bouncing to a login page land here.
    throw new Error('request was redirected (auth/proxy gateway?) — backend unreachable');
  }
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail ?? detail; } catch {}
    throw new Error(`${res.status} ${detail}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    // A 200 that isn't JSON is not our backend — almost certainly an interstitial.
    throw new Error(`expected JSON, got "${ct || 'no content-type'}" — backend unreachable`);
  }
  return res.json();
}

// Shape guards: even a JSON 200 from something-that-isn't-our-backend must not
// pass as a real result. A write that "succeeded" without a numeric version is
// the silent-failure we're guarding against.
function expect(cond, what) {
  if (!cond) throw new Error(`unexpected backend response (${what})`);
}

// Single request chokepoint. fetch() *rejects* (TypeError) only on network-level
// failures — backend down, DNS, or a cross-origin redirect to an auth gateway
// (Cloudflare Access) whose login page sends no CORS headers. That last case is
// our "tunnel auth expired" symptom: it shows up as a CORS error in the console
// and a `TypeError: Failed to fetch` here. Translate it into a clear message so
// the bridge status and the editor toast say something actionable instead of
// "Failed to fetch".
async function request(url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new Error('backend unreachable (network/CORS — auth gateway may have expired)');
  }
  return json(res);
}

export const api = {
  // → [{ path, version, name? }]  (name = <metadata><name>, only with withName)
  async listFiles(withName = false) {
    const qs = withName ? '?with_name=1' : '';
    const data = await request(`${API_BASE}/files${qs}`);
    expect(Array.isArray(data), 'expected a file array');
    return data;
  },
  // → { path, version, data }
  async getFile(path) {
    const data = await request(`${API_BASE}/file?path=${encodeURIComponent(path)}`);
    expect(typeof data?.data === 'string' && Number.isFinite(data?.version), 'missing data/version');
    return data;
  },
  // create (promotion) → { path, version }  (path may be auto-suffixed on collision)
  async createFile(path, data) {
    const res = await request(`${API_BASE}/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, data }),
    });
    expect(typeof res?.path === 'string' && Number.isFinite(res?.version), 'missing path/version');
    return res;
  },
  // save (autosave/save) → { path, version }
  async putFile(path, data, baseVersion) {
    const res = await request(`${API_BASE}/file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, data, baseVersion: baseVersion ?? null }),
    });
    expect(Number.isFinite(res?.version), 'missing version');
    return res;
  },
  // Google Maps link/share-text → { lat, lng, name, source, gpx }
  async convertMapsLink(input) {
    const res = await request(`${API_BASE}/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    });
    expect(typeof res?.gpx === 'string' && Number.isFinite(res?.lat), 'missing gpx/lat');
    return res;
  },
};
