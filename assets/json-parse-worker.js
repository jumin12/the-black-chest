/**
 * Off-main-thread JSON.parse for large map/editor payloads to reduce frame hitches.
 */
self.onmessage = function (ev) {
  const d = ev.data || {};
  const id = d.id;
  const s = d.s;
  if (typeof s !== 'string') {
    self.postMessage({ id, ok: false, err: 'bad_input' });
    return;
  }
  try {
    self.postMessage({ id, ok: true, data: JSON.parse(s) });
  } catch (e) {
    const err = e && e.message != null ? String(e.message) : String(e);
    self.postMessage({ id, ok: false, err });
  }
};
