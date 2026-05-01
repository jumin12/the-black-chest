/**
 * Dedicated worker — fetches scenic `.glb` bytes off the main thread and transfers ArrayBuffers back.
 * Main thread passes `fetchInit` (subset of RequestInit): cache / mode / credentials / redirect /
 * referrerPolicy. Omit credentials keeps CORS + anonymous reads reliable for workers/blobs.
 */
self.onmessage = async (evt) => {
  const msg = evt.data || {};
  const id = msg.id;
  const url = msg.url;
  if (url == null) {
    self.postMessage({ id, ok: false, err: 'missing url' });
    return;
  }
  const fi = msg.fetchInit && typeof msg.fetchInit === 'object' ? msg.fetchInit : {};
  try {
    const res = await fetch(String(url), {
      cache: fi.cache !== undefined ? fi.cache : 'default',
      mode: fi.mode !== undefined ? fi.mode : 'cors',
      credentials: fi.credentials !== undefined ? fi.credentials : 'omit',
      redirect: fi.redirect !== undefined ? fi.redirect : 'follow',
      referrerPolicy: fi.referrerPolicy !== undefined ? fi.referrerPolicy : 'same-origin'
    });
    if (!res.ok) {
      self.postMessage({
        id,
        ok: false,
        err: String(res.status),
        statusText: String(res.statusText || '')
      });
      return;
    }
    const buf = await res.arrayBuffer();
    self.postMessage({ id, ok: true, ab: buf }, [buf]);
  } catch (e) {
    self.postMessage({ id, ok: false, err: e && e.message ? String(e.message) : String(e) });
  }
};
