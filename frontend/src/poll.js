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

  async function tick() {
    if (inFlight) return; // don't stack ticks if a poll is slow
    inFlight = true;
    try {
      let files;
      try {
        files = await api.listFiles();
      } catch {
        return; // transient backend hiccup; try again next tick
      }
      const serverVersion = new Map(files.map((f) => [f.path, f.version]));

      for (const path of [...openIds]) {
        if (!serverVersion.has(path)) {
          // File removed on the server while open → close it in the editor.
          postToEditor({ action: 'removeFile', id: path });
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
