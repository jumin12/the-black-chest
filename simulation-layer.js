'use strict';

/**
 * Authoritative naval simulation + server-side validation (anticheat) for the multiplayer server.
 * Single tick pipeline: merge validated client deltas → integrate motion with wind (same model as clients).
 */

const DEFAULT_TICK_RATE = 60;

/** Internal hull speed scalar — aligned with client `PLAYER_BASE_SPEED_MULT` and sail/hull caps. */
const SPEED_ABS_MAX = 16;
const SPEED_REV_MIN = -5;

class ServerSimplexNoise {
  constructor(seed = 0) {
    this.p = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    let s = seed >>> 0;
    for (let i = 255; i > 0; i--) {
      s = (Math.imul(s, 16807) + 0) >>> 0;
      const j = s % (i + 1);
      const tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }
    for (let i = 0; i < 512; i++) this.p[i] = p[i & 255];
  }
  noise2D(x, y) {
    const F2 = 0.5 * (Math.sqrt(3) - 1);
    const G2 = (3 - Math.sqrt(3)) / 6;
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    const grad = (hash, gx, gy) => {
      const h = hash & 7;
      const u = h < 4 ? gx : gy;
      const v = h < 4 ? gy : gx;
      return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
    };
    let n0 = 0;
    let n1 = 0;
    let n2 = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      t0 *= t0;
      n0 = t0 * t0 * grad(this.p[ii + this.p[jj]], x0, y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      t1 *= t1;
      n1 = t1 * t1 * grad(this.p[ii + i1 + this.p[jj + j1]], x1, y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      t2 *= t2;
      n2 = t2 * t2 * grad(this.p[ii + 1 + this.p[jj + 1]], x2, y2);
    }
    return 70 * (n0 + n1 + n2);
  }
  fbm(x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let max = 0;
    for (let i = 0; i < octaves; i++) {
      sum += this.noise2D(x * freq, y * freq) * amp;
      max += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / max;
  }
}

function windFieldBase(noise, x, z) {
  if (!noise) return { angle: 0, speed: 6 };
  const ux = x * 0.0004 + 401;
  const uz = z * 0.0004 + 203;
  const e = 220;
  const n0 = noise.fbm(ux, uz, 4);
  const dx = noise.fbm(ux + e, uz, 4) - n0;
  const dz = noise.fbm(ux, uz + e, 4) - n0;
  const angle = Math.atan2(dx * 14, dz * 14);
  const speed = 2.4 + noise.fbm(ux * 1.15 + 81, uz * 1.15 - 37, 3) * 9;
  return { angle, speed: Math.max(0.35, Math.min(14, speed)) };
}

function applyWindEffectWithNavigation(baseWindEffect, windDot) {
  const navM = 1;
  let w = 1 + (baseWindEffect - 1) * navM;
  w += (Math.max(0, windDot) * 0.03 + Math.max(0, -windDot) * 0.018) * (navM - 1);
  return Math.max(0.2, w);
}

function moraleEfficiency(morale) {
  const m = morale != null && Number.isFinite(Number(morale)) ? Number(morale) : 100;
  const t = Math.max(0, Math.min(100, m)) / 100;
  return 0.55 + t * 0.45;
}

function effectiveSailingSpeed(p, noise) {
  const spd = p.speed != null && Number.isFinite(Number(p.speed)) ? Number(p.speed) : 0;
  if (Math.abs(spd) < 1e-4) return 0;
  const w = windFieldBase(noise, p.x, p.z);
  const rot = p.rotation != null && Number.isFinite(Number(p.rotation)) ? Number(p.rotation) : 0;
  const windDot = Math.cos(w.angle - rot);
  const windEffect = Math.max(0.25, windDot * 0.35 + 0.65);
  const windTerm = applyWindEffectWithNavigation(windEffect, windDot);
  const rigPct = (p.riggingHealth != null ? Number(p.riggingHealth) : 100) / 100;
  const rigF = Math.max(0.26, Math.pow(Math.max(0.05, rigPct), 1.35));
  const morF = moraleEfficiency(p.morale);
  return spd * windTerm * rigF * morF;
}

function createClampWorld(edgeClamp) {
  return function clampPlayerWorldX(x) {
    const v = Number(x);
    if (!Number.isFinite(v)) return null;
    return Math.max(-edgeClamp, Math.min(edgeClamp, v));
  };
}

/**
 * @param {{ worldSeed: number, edgeClamp: number, tickRate?: number }} opts
 */
function createGameSimulation(opts) {
  const edgeClamp = opts.edgeClamp;
  const tickRate = opts.tickRate || DEFAULT_TICK_RATE;
  const dt = 1 / tickRate;
  let noise = new ServerSimplexNoise(opts.worldSeed >>> 0);
  const clamp = createClampWorld(edgeClamp);

  function setWorldSeed(seed) {
    noise = new ServerSimplexNoise(seed >>> 0);
  }

  function stepPlayer(p) {
    if (p.docked) return;
    if (p.deckWalk && p.deckWalk.active) return;
    /* Grappled/boarding hulls are client-locked; wind step here desyncs server x/z from hints → anticheat denies updates and ships "teleport". */
    if (p.boarding && typeof p.boarding === 'object') return;
    const r = p.rotation != null && Number.isFinite(Number(p.rotation)) ? Number(p.rotation) : 0;
    const eff = effectiveSailingSpeed(p, noise);
    const nx = p.x + Math.sin(r) * eff * dt;
    const nz = p.z + Math.cos(r) * eff * dt;
    const cx = clamp(nx);
    const cz = clamp(nz);
    if (cx != null) p.x = cx;
    if (cz != null) p.z = cz;
  }

  function stepAll(players) {
    for (const p of players.values()) stepPlayer(p);
  }

  function applyClientPositionHint(p, cx, cz) {
    const cx2 = clamp(cx);
    const cz2 = clamp(cz);
    if (cx2 == null || cz2 == null) return;
    if (p.docked) {
      p.x = cx2;
      p.z = cz2;
      return;
    }
    if (p.deckWalk && p.deckWalk.active) {
      p.x += (cx2 - p.x) * 0.62;
      p.z += (cz2 - p.z) * 0.62;
      return;
    }
    const dx = cx2 - p.x;
    const dz = cz2 - p.z;
    const d = Math.hypot(dx, dz);
    /* Idle / hove-to: lock server hull to client-reported xz every tick so AOI snapshots match what
     * captains see locally — gradual merge + broadcast skew looked like remote ships “teleport” while still. */
    const spdAbs = p.speed != null && Number.isFinite(Number(p.speed)) ? Math.abs(Number(p.speed)) : 0;
    if (spdAbs < 0.048) {
      if (d <= 12) {
        p.x = cx2;
        p.z = cz2;
      }
      return;
    }
    if (d < 0.12) return;
    const maxPull = Math.min(28, 3.8 + d * 0.2);
    const k = Math.min(1, maxPull / d);
    p.x += dx * k;
    p.z += dz * k;
  }

  return {
    setWorldSeed,
    stepPlayer,
    stepAll,
    applyClientPositionHint,
    clampWorld: clamp,
    windAt: (x, z) => windFieldBase(noise, x, z),
    effectiveSailingSpeed: p => effectiveSailingSpeed(p, noise)
  };
}

const AC_DEFAULTS = {
  maxUpdatesPerSec: Math.max(40, Number(process.env.AC_MAX_UPDATES_PER_SEC) || 72),
  maxPositionJump: Math.max(8, Number(process.env.AC_MAX_POSITION_JUMP) || 28),
  maxRotationDelta: Math.max(0.2, Number(process.env.AC_MAX_ROTATION_DELTA) || 0.85),
  maxHealthDropPerMsg: Math.max(5, Number(process.env.AC_MAX_HEALTH_DROP) || 38),
  maxRiggingDropPerMsg: Math.max(5, Number(process.env.AC_MAX_RIGGING_DROP) || 45),
  maxMoraleSwingPerMsg: Math.max(2, Number(process.env.AC_MAX_MORALE_SWING) || 22),
  violationKickThreshold: Math.max(5, Number(process.env.AC_VIOLATION_KICK) || 22),
  violationWindowMs: Math.max(3000, Number(process.env.AC_VIOLATION_WINDOW_MS) || 14000),
  rateBurst: Math.max(5, Number(process.env.AC_RATE_BURST) || 24)
};

/**
 * Per-socket rate limiting + soft validation. Hard limits clamp cheats; repeated absurdities → kick.
 */
function createAntiCheatGate(overrides = {}, hooks = {}) {
  const cfg = { ...AC_DEFAULTS, ...overrides };
  const clampResumeXZ = typeof hooks.clampPlayerXZ === 'function' ? hooks.clampPlayerXZ : null;

  function ensureWsAc(ws) {
    if (!ws._ac) {
      ws._ac = {
        tokens: cfg.rateBurst,
        lastRefillMs: Date.now(),
        violations: 0,
        windowStartMs: Date.now()
      };
    }
    return ws._ac;
  }

  /** @returns {boolean} false if message should be dropped (flooding) */
  function allowUpdateMessage(ws) {
    const ac = ensureWsAc(ws);
    const now = Date.now();
    const elapsed = Math.max(0, now - ac.lastRefillMs);
    ac.lastRefillMs = now;
    ac.tokens = Math.min(cfg.rateBurst, ac.tokens + (elapsed / 1000) * cfg.maxUpdatesPerSec);
    if (ac.tokens < 1) {
      ac.tokens -= 2;
      bumpViolation(ws, 'rate');
      return false;
    }
    ac.tokens -= 1;
    return true;
  }

  function bumpViolation(ws, _reason) {
    const ac = ensureWsAc(ws);
    const now = Date.now();
    if (now - ac.windowStartMs > cfg.violationWindowMs) {
      ac.windowStartMs = now;
      ac.violations = 0;
    }
    ac.violations++;
    return ac.violations >= cfg.violationKickThreshold;
  }

  function normalizeAngleRad(r) {
    let a = r;
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  /**
   * Clamp / strip impossible client fields. Mutates `p` only through safe assignments.
   * @returns {{ kick: boolean, stripped: string[] }}
   */
  function validatePlayerUpdate(p, msg, ws) {
    const stripped = [];
    let kick = false;

    if (msg.speed !== undefined) {
      const sp = Number(msg.speed);
      if (Number.isFinite(sp)) {
        const c = Math.max(SPEED_REV_MIN, Math.min(SPEED_ABS_MAX, sp));
        if (Math.abs(c - sp) > 0.01) stripped.push('speed');
        p.speed = c;
      }
    }

    if (msg.rotation !== undefined) {
      const rNew = Number(msg.rotation);
      if (Number.isFinite(rNew)) {
        const r0 = p.rotation != null && Number.isFinite(Number(p.rotation)) ? Number(p.rotation) : rNew;
        let d = normalizeAngleRad(rNew - r0);
        if (Math.abs(d) > cfg.maxRotationDelta) {
          p.rotation = r0 + Math.sign(d) * cfg.maxRotationDelta;
          stripped.push('rotation');
          if (Math.abs(d) > cfg.maxRotationDelta * 4) kick = bumpViolation(ws, 'spin');
        } else {
          p.rotation = Math.max(-1e4, Math.min(1e4, rNew));
        }
      }
    }

    const inBoarding = !!(p.boarding && typeof p.boarding === 'object');

    if (msg.health !== undefined) {
      const h = Number(msg.health);
      if (Number.isFinite(h)) {
        const prev = p.health != null && Number.isFinite(Number(p.health)) ? Number(p.health) : 100;
        const maxDrop = inBoarding ? 80 : cfg.maxHealthDropPerMsg;
        const maxGain = inBoarding ? 60 : 18;
        let nh = h;
        if (h < prev - maxDrop) {
          nh = prev - maxDrop;
          stripped.push('health');
          kick = bumpViolation(ws, 'health') || kick;
        }
        if (h > prev + maxGain) {
          nh = prev + maxGain;
          stripped.push('health_gain');
        }
        p.health = Math.max(-20, Math.min(9999, nh));
      }
    }

    if (msg.riggingHealth !== undefined) {
      const rg = Number(msg.riggingHealth);
      if (Number.isFinite(rg)) {
        const prev = p.riggingHealth != null ? Number(p.riggingHealth) : 100;
        const maxDrop = inBoarding ? 55 : cfg.maxRiggingDropPerMsg;
        let nr = rg;
        if (rg < prev - maxDrop) {
          nr = prev - maxDrop;
          stripped.push('rigging');
          kick = bumpViolation(ws, 'rigging') || kick;
        }
        if (rg > prev + 20) {
          nr = Math.min(100, prev + 20);
          stripped.push('rigging_gain');
        }
        p.riggingHealth = Math.max(0, Math.min(100, nr));
      }
    }

    if (msg.morale !== undefined) {
      const m = Number(msg.morale);
      if (Number.isFinite(m)) {
        const prev = p.morale != null ? Number(p.morale) : 100;
        const swing = cfg.maxMoraleSwingPerMsg;
        let nm = m;
        if (m < prev - swing || m > prev + swing) {
          nm = Math.max(prev - swing, Math.min(prev + swing, m));
          stripped.push('morale');
        }
        p.morale = Math.max(0, Math.min(100, nm));
      }
    }

    let denyPositionHint = false;
    const clientClaimsDocked = msg.docked === true;
    const deckWalkActive = !!(p.deckWalk && p.deckWalk.active) || !!(msg.deckWalk && typeof msg.deckWalk === 'object' && msg.deckWalk.active !== false);
    if (msg.x !== undefined && msg.z !== undefined && !p.docked && !clientClaimsDocked && !deckWalkActive) {
      const cx = Number(msg.x);
      const cz = Number(msg.z);
      if (Number.isFinite(cx) && Number.isFinite(cz)) {
        const d = Math.hypot(cx - p.x, cz - p.z);
        let maxJump = cfg.maxPositionJump;
        if (inBoarding) maxJump = Math.max(maxJump, 96);
        else if (p.speed != null && Number.isFinite(Number(p.speed))) {
          const sp = Math.abs(Number(p.speed));
          maxJump = Math.min(52, maxJump + sp * 0.95);
        }
        if (d > maxJump) {
          /* First huge delta after connect: client continued voyage / reconnect at saved coords while
           * server still has offshore spawn — snap once instead of denying hints and racking up kicks. */
          const maxResumeSnap = 720000;
          if (!ws._acResumePositionTrusted && clampResumeXZ && d <= maxResumeSnap) {
            const c = clampResumeXZ(cx, cz);
            if (c && Number.isFinite(c.x) && Number.isFinite(c.z)) {
              ws._acResumePositionTrusted = true;
              p.x = c.x;
              p.z = c.z;
              stripped.push('position_resume_snap');
            } else {
              stripped.push('position');
              denyPositionHint = true;
              if (d > cfg.maxPositionJump * 3) kick = bumpViolation(ws, 'teleport') || kick;
            }
          } else {
            stripped.push('position');
            denyPositionHint = true;
            if (d > cfg.maxPositionJump * 3) kick = bumpViolation(ws, 'teleport') || kick;
          }
        }
      }
    }

    return { kick, stripped, denyPositionHint };
  }

  return {
    allowUpdateMessage,
    validatePlayerUpdate,
    cfg
  };
}

module.exports = {
  createGameSimulation,
  createAntiCheatGate,
  SPEED_ABS_MAX,
  SPEED_REV_MIN,
  DEFAULT_TICK_RATE
};
