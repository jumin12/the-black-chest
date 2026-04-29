/**
 * Numeric batch helpers (sea surface height stacks) — MUST stay aligned with index.html `displaceSeaLocalY`.
 * Loaded by a small pool so Gerstner + chop work can overlap the main gameplay thread during heavy scenes.
 */

const WATER_SURFACE_BASE = -0.5; // SEA_LEVEL 0 - 0.5

/** Chop layer matching main thread `seaChopAtXZ` / waterVS `seaChop`. */
function seaChopAtXZ(x, z, time) {
  const t = time;
  return 0.019 * Math.sin(x * 0.103 + z * 0.071 + t * 1.37) * Math.cos(z * 0.127 - x * 0.089 - t * 1.08)
    + 0.015 * Math.sin(x * 0.151 + t * 1.9) * Math.sin(z * 0.163 + t * 1.43)
    + 0.012 * Math.cos((x * 0.087 - z * 0.112) * 2.15 + t * 0.97 + Math.sin(z * 0.05 + x * 0.031));
}

function displaceSeaLocalY(lx, lz, time) {
  let px = lx;
  let py = 0;
  let pz = lz;
  function addGw(s, wl, dx, dz, sp) {
    const k = (Math.PI * 2) / wl;
    const c = Math.sqrt(9.8 / k);
    const a = s / k;
    const len = Math.hypot(dx, dz) || 1;
    const nx = dx / len;
    const nz = dz / len;
    const f = k * (nx * px + nz * pz - c * sp * time);
    const cf = Math.cos(f);
    const sf = Math.sin(f);
    px += nx * a * cf;
    py += a * sf;
    pz += nz * a * cf;
  }
  addGw(0.055, 62, 1, 0.22, 0.58);
  addGw(0.036, 36, 0.41, 0.97, 0.5);
  addGw(0.024, 20, -0.58, 0.76, 0.72);
  addGw(0.017, 12, 0.84, -0.38, 0.88);
  addGw(0.011, 7.2, -0.28, -0.86, 1.12);
  addGw(0.008, 4.8, 0.88, 0.44, 1.42);
  addGw(0.032, 48, -0.72, 0.62, 0.52);
  addGw(0.021, 28, 0.55, -0.82, 0.68);
  addGw(0.014, 9, -0.9, 0.35, 0.92);
  addGw(0.01, 5.5, 0.33, 0.94, 1.35);
  py += seaChopAtXZ(px, pz, time);
  return py;
}

/** Same as client `worldSeaSurfaceY(wx, wz, time)` excluding SHIP_FREEBOARD additions. */
function worldSeaSurfaceY(wx, wz, time, wfx, wfz) {
  const tf = Number(time);
  const lx = wx - wfx;
  const lz = wz - wfz;
  return WATER_SURFACE_BASE + displaceSeaLocalY(lx, lz, tf);
}

function runBulkSeaY(wxArr, wzArr, waterFollowX, waterFollowZ, time) {
  const n = wxArr.length | 0;
  const out = new Float64Array(n);
  let i = 0;
  for (; i < n; i++) {
    const wx = wxArr[i];
    const wz = wzArr[i];
    out[i] = worldSeaSurfaceY(wx, wz, time, waterFollowX, waterFollowZ);
  }
  return out;
}

self.onmessage = function (ev) {
  const d = ev.data || {};
  const id = d.id;
  const op = d.op || 'bulk_sea_y';
  try {
    if (op === 'bulk_sea_y') {
      const wxArr = d.wx;
      const wzArr = d.wz;
      const wfx = Number(d.waterFollowX) || 0;
      const wfz = Number(d.waterFollowZ) || 0;
      const time = Number(d.time);
      if (!wxArr || !wzArr || wxArr.length !== wzArr.length) {
        self.postMessage({ id, ok: false, err: 'bad_arrays' });
        return;
      }
      const ys = runBulkSeaY(wxArr, wzArr, wfx, wfz, Number.isFinite(time) ? time : 0);
      self.postMessage({ id, ok: true, ys }, [ys.buffer]);
      return;
    }
    self.postMessage({ id, ok: false, err: 'unknown_op' });
  } catch (e) {
    const msg = e && e.message != null ? String(e.message) : String(e);
    self.postMessage({ id, ok: false, err: msg });
  }
};
