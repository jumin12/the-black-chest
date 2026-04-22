/**
 * Off-main-thread A* on a coarse occupancy grid (land / reef / shoal cells).
 * The game builds `occ` on the main thread; this worker only runs the search.
 */
self.onmessage = function (ev) {
  const d = ev.data || {};
  const rid = d.rid | 0;
  const gw = d.gw | 0;
  const gh = d.gh | 0;
  const occ = d.occ;
  if (!occ || !gw || !gh || occ.length < gw * gh) {
    self.postMessage({ rid, ok: false, wps: [] });
    return;
  }
  const six = d.six | 0;
  const siz = d.siz | 0;
  const gix = d.gix | 0;
  const giz = d.giz | 0;
  const x0 = +d.x0;
  const z0 = +d.z0;
  const cell = +d.cell;
  const toI = (ix, iz) => iz * gw + ix;
  const si = toI(six, siz);
  const gi = toI(gix, giz);
  const N = gw * gh;
  const open = [];
  const came = new Int32Array(N);
  const gscore = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    came[i] = -1;
    gscore[i] = 1e20;
  }
  const h = (ix, iz) => Math.abs(ix - gix) + Math.abs(iz - giz);
  const inOpen = new Uint8Array(N);
  gscore[si] = 0;
  open.push(si);
  inOpen[si] = 1;
  let expansions = 0;
  const MAX_EXP = 900;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (open.length && expansions < MAX_EXP) {
    expansions++;
    let bi = 0;
    let bf = 1e21;
    for (let oi = 0; oi < open.length; oi++) {
      const o = open[oi];
      const ox = o % gw;
      const oz = (o / gw) | 0;
      const f = gscore[o] + h(ox, oz);
      if (f < bf) {
        bf = f;
        bi = oi;
      }
    }
    const cur = open[bi];
    open.splice(bi, 1);
    inOpen[cur] = 0;
    if (cur === gi) {
      const idxs = [];
      let c = cur;
      while (c >= 0) {
        idxs.push(c);
        c = came[c];
      }
      idxs.reverse();
      const wps = [];
      for (let i = 0; i < idxs.length; i++) {
        const id = idxs[i];
        const ix = id % gw;
        const iz = (id / gw) | 0;
        wps.push({ x: x0 + (ix + 0.5) * cell, z: z0 + (iz + 0.5) * cell });
      }
      self.postMessage({ rid, ok: wps.length > 0, wps });
      return;
    }
    const cx = cur % gw;
    const cz = (cur / gw) | 0;
    for (let di = 0; di < 4; di++) {
      const nx = cx + dirs[di][0];
      const nz = cz + dirs[di][1];
      if (nx < 0 || nx >= gw || nz < 0 || nz >= gh) continue;
      const ni = toI(nx, nz);
      if (occ[ni]) continue;
      const tent = gscore[cur] + 1;
      if (tent < gscore[ni]) {
        came[ni] = cur;
        gscore[ni] = tent;
        if (!inOpen[ni]) {
          open.push(ni);
          inOpen[ni] = 1;
        }
      }
    }
  }
  self.postMessage({ rid, ok: false, wps: [] });
};
