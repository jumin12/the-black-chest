/**
 * Fetches one GLB URL per message; returns ArrayBuffer with transfer.
 * Used in a small pool on the main thread for parallel cold-cache loading.
 */
self.onmessage = (e) => {
  const d = e.data || {};
  const id = d.id;
  const url = d.url;
  if (!url) {
    self.postMessage({ id, ok: false, err: 'no url' });
    return;
  }
  fetch(String(url), { credentials: 'same-origin', cache: 'force-cache', mode: 'cors' })
    .then((r) =>
      r.arrayBuffer().then((ab) => {
        self.postMessage({ id, ok: r.ok, status: r.status, ab }, ab.byteLength ? [ab] : []);
      })
    )
    .catch((err) => {
      self.postMessage({ id, ok: false, err: String(err && err.message != null ? err.message : err) });
    });
};
