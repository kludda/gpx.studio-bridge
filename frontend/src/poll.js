// Collaboration poll loop (deliberately polling, not WebSocket).
//
// Every `intervalMs`, list the server and, for each currently-open file, compare
// the server `version` (st_mtime_ns) to what we last recorded in the registry.
// A difference means *someone else* wrote the file → fetch it and `merge` it into
// the editor (whole-file last-write-wins).
//
// Echo avoidance: after our own autosave/promotion we adopt the version returned
// by our PUT/POST into the registry, so our own write reads as "unchanged" here.

export function createPoller({ api, registry, openIds, postToEditor, intervalMs, setStatus }) {
  let timer = null;
  let inFlight = false;
  let failures = 0; // consecutive listFiles() failures → drives the disconnected status

  async function tick() {
    if (inFlight) return; // don't stack ticks if a poll is slow
    inFlight = true;
    try {
      let files;
      try {
        files = await api.listFiles();
      } catch (err) {
        // The poll hits the backend every tick even with nothing open, so it's
        // our connectivity heartbeat. Don't swallow failures: an outage (backend
        // down, or an expired auth gateway bouncing us with a CORS error) is
        // otherwise invisible until a save happens to fail.
        failures++;
        const note = failures > 1 ? ` (${failures} failed polls)` : '';
        setStatus?.(`⚠ disconnected — ${err.message}${note}`);
        // Re-sent every tick (not edge-triggered): a lost backend connection is
        // severe and requires the user to act, so keep reporting it until it
        // recovers. Reuse the per-file `status` channel with no `id`; the editor
        // treats an id-less status as a global host notice and renders it as one
        // sticky, de-duplicated toast (so this doesn't stack a toast every tick).
        postToEditor?.({ action: 'status', ok: false, message: 'Connection lost, please reload browser' });
        return; // retry next tick
      }
      if (failures > 0) {
        failures = 0; // recovered
        setStatus?.('reconnected');
      }
      const serverVersion = new Map(files.map((f) => [f.path, f.version]));

      for (const path of [...openIds]) {
        if (!serverVersion.has(path)) {
          // File removed on the server while open → close it in the editor.
          postToEditor({ action: 'remove', id: path });
          openIds.delete(path);
          registry.delete(path);
          setStatus?.(`removed ${path}`);
          continue;
        }
        const known = registry.get(path)?.version;
        const current = serverVersion.get(path);
        if (current !== known) {
          try {
            const { data, version } = await api.getFile(path);
            registry.set(path, { version }); // adopt before merge so we don't re-merge
            postToEditor({ action: 'merge', id: path, data });
            setStatus?.(`merged ${path}`);
          } catch {
            /* keep old version; retry next tick */
          }
        }
      }
    } finally {
      inFlight = false;
    }
  }

  return {
    start() { if (!timer) timer = setInterval(tick, intervalMs); },
    stop() { clearInterval(timer); timer = null; },
    tick, // exposed for tests / manual nudge
  };
}
