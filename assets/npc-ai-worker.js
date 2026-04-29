/**
 * Dedicated NPC steering worker: batch "close ships" avoidance (same math as steerNpcAvoidCloseShips on main thread).
 *
 * Messages from main thread:
 *   { id, op: 'close_avoid', nAll, dt, xz: Float64Array(nAll*2), rad: Float32Array(nAll), rot: Float64Array(nAll),
 *     alive: Uint8Array(nAll), flags: Uint8Array(nAll),
 *     idxList: Uint32Array(M),
 *     turnFactor: Float32Array(M),
 *     syncIds?: Uint32Array(M) optional; echoed back for pairing }
 *
 * Posted back:
 *   { id, ok: true, dRot: Float64Array(M) } Transfers dRot.buffer
 * or
 *   { id, ok: false, err: string }
 */
function computeCloseAvoidPacked(nAll, dt, xz, rad, rot, alive, flags, idxList, turnFactor, dRot) {
  const M = idxList.length;
  for (let li = 0; li < M; li++) dRot[li] = 0;
  const F_ESC = 1;
  const F_LOAD = 2;
  const F_TRADE = 4;
  for (let li = 0; li < M; li++) {
    const iGlob = idxList[li];
    if (iGlob < 0 || iGlob >= nAll) continue;
    const fg = flags[iGlob] | 0;
    if (fg & F_ESC || fg & F_LOAD) continue;
    if (!alive[iGlob]) continue;
    const ix = iGlob * 2;
    const px = xz[ix];
    const pz = xz[ix + 1];
    const myR = rad[iGlob];
    let wx = 0,
      wz = 0,
      wsum = 0;
    for (let k = 0; k < nAll; k++) {
      if (k === iGlob) continue;
      if (!alive[k]) continue;
      const kx = k * 2;
      const dx = px - xz[kx];
      const dz = pz - xz[kx + 1];
      const d = Math.sqrt(dx * dx + dz * dz);
      const need = myR + rad[k] + 3.2;
      if (d > need * 1.35 || d < 0.04) continue;
      const inv = 1 / d;
      const nx = dx * inv;
      const nz = dz * inv;
      const t = Math.max(0, 1 - d / (need * 1.35));
      wx += nx * t;
      wz += nz * t;
      wsum += t;
    }
    if (wsum < 0.2) continue;
    wx /= wsum;
    wz /= wsum;
    const want = Math.atan2(wx, wz);
    let diff = want - rot[iGlob];
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) < 0.038) continue;
    const trade = (fg & F_TRADE) !== 0;
    const gain = (trade ? 0.3 : 0.39) * Math.min(1, wsum * 0.42);
    const tf = turnFactor[li] || 0;
    dRot[li] = diff * gain * dt * tf;
  }
  return M;
}

self.onmessage = function (ev) {
  const d = ev.data || {};
  const id = d.id | 0;
  if (!id) {
    try {
      self.postMessage({ ok: false, err: 'no_id' });
    } catch (e2) {}
    return;
  }
  try {
    if (d.op === 'init') {
      self.postMessage({ id, ok: true });
      return;
    }
    if (d.op !== 'close_avoid') {
      self.postMessage({ id, ok: false, err: 'unknown_op' });
      return;
    }
    const nAll = nAllSafe(d.nAll);
    const dt = Number(d.dt) || 0;
    const xz = d.xz;
    const rad = d.rad;
    const rotBuf = d.rot;
    const alive = d.alive;
    const flags = d.flags;
    const idxList = d.idxList;
    const turnFactor = d.turnFactor;
    if (
      !(xz instanceof Float64Array) ||
      xz.length < nAll * 2 ||
      !(rad instanceof Float32Array) ||
      rad.length < nAll ||
      !(rotBuf instanceof Float64Array) ||
      rotBuf.length < nAll ||
      !(alive instanceof Uint8Array) ||
      alive.length < nAll ||
      !(flags instanceof Uint8Array) ||
      flags.length < nAll ||
      !(idxList instanceof Uint32Array) ||
      !(turnFactor instanceof Float32Array)
    ) {
      self.postMessage({ id, ok: false, err: 'bad_arrays' });
      return;
    }
    const rot = rotBuf;
    const M = idxList.length | 0;
    if (M <= 0) {
      self.postMessage({ id, ok: true, dRot: new Float64Array(0) });
      return;
    }
    const dRot = new Float64Array(M);
    computeCloseAvoidPacked(nAll, dt, xz, rad, rot, alive, flags, idxList, turnFactor, dRot);
    try {
      self.postMessage({ id, ok: true, dRot, syncIds: d.syncIds }, [dRot.buffer]);
    } catch (ePost) {
      self.postMessage({ id, ok: true, dRot });
    }
  } catch (e) {
    const msg = e && e.message != null ? String(e.message) : String(e);
    try {
      self.postMessage({ id: d.id | 0, ok: false, err: msg });
    } catch (e3) {}
  }
};

function nAllSafe(v) {
  const n = v | 0;
  return n > 0 && n < 1e7 ? n : 0;
}
