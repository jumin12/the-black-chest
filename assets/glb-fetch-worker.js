/**
 * Dedicated fetch worker for `.glb` bytes — run 4+ in parallel from the main thread (see `fetchGlbArrayBuffersWorkerFirst`).
 * Parses stay on the main thread (Three.js GLTFLoader + GPU resources).
 */
self.onmessage = async (evt) => {
  const msg = evt.data || {};
  const id = msg.id;
  const url = msg.url;
  const fo = msg.fetchOpts && typeof msg.fetchOpts === 'object' ? msg.fetchOpts : {};
  if (url == null) {
    self.postMessage({ id, ok: false, err: 'missing url' });
    return;
  }
  const fetchOpts = {
    cache: fo.cache != null ? fo.cache : 'default',
    mode: fo.mode != null ? fo.mode : 'cors',
    credentials: fo.credentials != null ? fo.credentials : 'omit',
    redirect: fo.redirect != null ? fo.redirect : 'follow',
    referrerPolicy: fo.referrerPolicy != null ? fo.referrerPolicy : 'same-origin'
  };
  try {
    const res = await fetch(String(url), fetchOpts);
    if (!res.ok) {
      self.postMessage({ id, ok: false, err: String(res.status), statusText: String(res.statusText || '') });
      return;
    }
    const buf = await res.arrayBuffer();
    self.postMessage({ id, ok: true, ab: buf }, [buf]);
  } catch (e) {
    self.postMessage({ id, ok: false, err: e && e.message ? String(e.message) : String(e) });
  }
};
