/* global self */
self.onmessage = function (ev) {
  const d = ev.data;
  if (!d || d.type !== 'parse') return;
  const id = d.id | 0;
  try {
    const result = JSON.parse(d.text);
    self.postMessage({ type: 'parsed', id, ok: true, result });
  } catch (e) {
    self.postMessage({
      type: 'parsed',
      id,
      ok: false,
      error: e && e.message ? String(e.message) : String(e)
    });
  }
};
