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
    /**
     * Omit credentials: DedicatedWorkers from blob: URLs have an opaque origin; with
     * `Access-Control-Allow-Origin: *` the server rejects credentialed CORS reads.
     * Same-origin file/http pages still succeed with cors+omit for anonymous assets.
     */
    const res = await fetch(String(url), {
      cache: 'force-cache',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
      referrerPolicy: 'same-origin'
    });
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
