/**
 * Off-main-thread JSON.stringify for large save payloads.
 * Mirrors assets/json-parse-worker.js — paired job id contract.
 */
self.onmessage = function (ev) {
  const d = ev.data || {};
  const token = d.token;
  const payload = d.data;
  if (payload === undefined || token === undefined) {
    self.postMessage({ token, ok: false, err: 'bad_payload' });
    return;
  }
  try {
    self.postMessage({ token, ok: true, s: JSON.stringify(payload) });
  } catch (e) {
    const err = e && e.message != null ? String(e.message) : String(e);
    self.postMessage({ token, ok: false, err });
  }
};
