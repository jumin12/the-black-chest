/**
 * Fetches `.glb` binaries in parallel threads; transfers ArrayBuffers to the main thread.
 * Used alongside GLTFLoader.parse() on main (Three.js parsers are not threaded here).
 */
self.onmessage = async (evt) => {
  const msg = evt.data || {};
  const id = msg.id;
  const url = msg.url;
  if (url == null) {
    self.postMessage({ id, ok: false, err: 'missing url' });
    return;
  }
  try {
    const res = await fetch(String(url), { cache: 'force-cache', credentials: 'same-origin', mode: 'cors' });
    if (!res.ok) {
      self.postMessage({ id, ok: false, err: String(res.status), statusText: String(res.statusText || '') });
      return;
    }
    const buf = await res.arrayBuffer();
    self.postMessage({ id, ok: true, ab: buf }, [buf]);
  } catch (e) {
    self.postMessage({ id, ok: false, err: (e && e.message) ? String(e.message) : String(e) });
  }
};
