'use strict';

const { createProceduralTerrain } = require('./procedural-terrain.cjs');

const FACTION_COUNT = 5;
const CHUNK_SIZE = 270;

function decodeHeightsB64(b64) {
  if (b64 == null || typeof b64 !== 'string') return null;
  const t = String(b64).replace(/\s+/g, '');
  if (!t) return null;
  let buf;
  try {
    buf = Buffer.from(t, 'base64');
  } catch (e) {
    return null;
  }
  if (buf.length % 4 !== 0) return null;
  const n = buf.length / 4;
  return new Float32Array(buf.buffer, buf.byteOffset, n);
}

function normalizeCustomTownForServer(t) {
  if (!t || t.dockX == null || t.dockZ == null) return null;
  const id = String(t.id || t.townName || 'town');
  const cx = t.cx != null ? (t.cx | 0) : Math.floor(Number(t.dockX) / CHUNK_SIZE);
  const cz = t.cz != null ? (t.cz | 0) : Math.floor(Number(t.dockZ) / CHUNK_SIZE);
  return {
    id: String(t.id != null ? t.id : id),
    hasTown: true,
    townName: t.townName || 'Port',
    faction: t.faction != null ? (t.faction | 0) % FACTION_COUNT : 0,
    exportGood: t.exportGood,
    dockX: Number(t.dockX),
    dockZ: Number(t.dockZ),
    dockAngle: t.dockAngle != null ? Number(t.dockAngle) : 0,
    worldX: t.worldX != null ? Number(t.worldX) : Number(t.dockX),
    worldZ: t.worldZ != null ? Number(t.worldZ) : Number(t.dockZ),
    cx,
    cz,
    radius: t.radius != null ? Number(t.radius) : 120,
    maxH: t.maxH != null ? Number(t.maxH) : 14,
    customTownId: id
  };
}

/**
 * Unified land test + trading ports: procedural archipelago and/or custom heightmap (matches client rules).
 */
function createTerrainContext(opts) {
  const worldSeed = (opts.worldSeed >>> 0) || 42;
  const edgeClamp = opts.edgeClamp != null ? Number(opts.edgeClamp) : 2025;
  const mapPayload = opts.worldMapPayload && typeof opts.worldMapPayload === 'object' ? opts.worldMapPayload : null;
  const gn = mapPayload && Number.isFinite(Number(mapPayload.gridN)) ? (Number(mapPayload.gridN) | 0) : 0;
  const heights = mapPayload && mapPayload.heightsB64 ? decodeHeightsB64(mapPayload.heightsB64) : null;
  const useCustom = heights && gn >= 16 && heights.length === gn * gn;

  let waterThreshold = 0.12;
  let lim = edgeClamp;
  let customTowns = [];
  const procedural = createProceduralTerrain(worldSeed);

  if (useCustom) {
    waterThreshold = mapPayload.waterThreshold != null ? Number(mapPayload.waterThreshold) : 0.12;
    lim = mapPayload.worldEdgeClamp != null ? Math.max(400, Math.min(8000, Number(mapPayload.worldEdgeClamp))) : edgeClamp;
    const townsRaw = Array.isArray(mapPayload.towns) ? mapPayload.towns : [];
    customTowns = townsRaw.map(normalizeCustomTownForServer).filter(Boolean);
  }

  function sampleCustomHeight01(wx, wz) {
    const u = (wx + lim) / (2 * lim);
    const v = (wz + lim) / (2 * lim);
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
    const gx = u * (gn - 1);
    const gz = v * (gn - 1);
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const x1 = Math.min(gn - 1, x0 + 1);
    const z1 = Math.min(gn - 1, z0 + 1);
    const tx = gx - x0;
    const tz = gz - z0;
    const h00 = heights[z0 * gn + x0];
    const h10 = heights[z0 * gn + x1];
    const h01 = heights[z1 * gn + x0];
    const h11 = heights[z1 * gn + x1];
    const a = h00 * (1 - tx) + h10 * tx;
    const b = h01 * (1 - tx) + h11 * tx;
    return a * (1 - tz) + b * tz;
  }

  function dryLandAtWorldPosition(wx, wz) {
    if (useCustom) {
      return sampleCustomHeight01(wx, wz) > waterThreshold;
    }
    return procedural.dryLandAtWorldPosition(wx, wz);
  }

  function hasMinClearanceFromLand(wx, wz, clear) {
    if (dryLandAtWorldPosition(wx, wz)) return false;
    const rays = 10;
    let open = 0;
    for (let i = 0; i < rays; i++) {
      const ang = (i / rays) * Math.PI * 2;
      if (!dryLandAtWorldPosition(wx + Math.cos(ang) * clear, wz + Math.sin(ang) * clear)) open++;
    }
    return open >= 6;
  }

  function getProceduralIslandMeta(cx, cz) {
    return procedural.getProceduralIslandMeta(cx, cz);
  }

  function collectAllTradingPorts() {
    if (useCustom && customTowns.length) return customTowns.slice();
    return procedural.collectAllTradingPorts();
  }

  function collectAllPirateHideouts() {
    if (useCustom) return [];
    return procedural.collectAllPirateHideouts();
  }

  function forEachProceduralIslandInWorldBounds(minWx, maxWx, minWz, maxWz, fn, centerWx, centerWz) {
    return procedural.forEachProceduralIslandInWorldBounds(minWx, maxWx, minWz, maxWz, fn, centerWx, centerWz);
  }

  return {
    worldSeed,
    edgeClamp: lim,
    useCustom,
    CHUNK_SIZE: procedural.CHUNK_SIZE,
    dryLandAtWorldPosition,
    hasMinClearanceFromLand,
    getProceduralIslandMeta,
    collectAllTradingPorts,
    collectAllPirateHideouts,
    forEachProceduralIslandInWorldBounds,
    sampleCustomHeight01: useCustom ? sampleCustomHeight01 : null
  };
}

/** Deterministic spawn: prefer open water offshore of a trading port/island (~165–295u from docks), fallback to legacy random ocean clearance. */
function sampleOffshoreSpawn(ctx, salt) {
  let h = ((ctx.worldSeed ^ (Number(salt) | 0)) >>> 0) + 2463534242;
  const rnd = () => {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    return h / 4294967296;
  };
  const edgeClamp = ctx.edgeClamp;
  const lim = edgeClamp * 0.86;
  const dryLand = (x, z) => ctx.dryLandAtWorldPosition(x, z);
  const minClear = 96;
  const ok = (nx, nz) => {
    if (dryLand(nx, nz)) return false;
    return ctx.hasMinClearanceFromLand(nx, nz, minClear);
  };
  const ports = typeof ctx.collectAllTradingPorts === 'function' ? ctx.collectAllTradingPorts() : [];
  for (let attempt = 0; attempt < 160; attempt++) {
    if (!ports.length) break;
    const p = ports[(Math.floor(rnd() * ports.length) + attempt) % ports.length];
    const cx = p.dockX != null ? Number(p.dockX) : (p.worldX != null ? Number(p.worldX) : 0);
    const cz = p.dockZ != null ? Number(p.dockZ) : (p.worldZ != null ? Number(p.worldZ) : 0);
    const ang = rnd() * Math.PI * 2;
    const dist = 165 + rnd() * 130;
    const nx = cx + Math.cos(ang) * dist;
    const nz = cz + Math.sin(ang) * dist;
    if (Math.abs(nx) > lim || Math.abs(nz) > lim) continue;
    if (ok(nx, nz)) {
      const face = ang + Math.PI + (rnd() - 0.5) * 0.75;
      return { x: nx, z: nz, rotation: face };
    }
  }
  for (let attempt = 0; attempt < 170; attempt++) {
    const bias = 0.36 + rnd() * 0.64;
    const nx = (rnd() * 2 - 1) * lim * bias;
    const nz = (rnd() * 2 - 1) * lim * bias;
    if (ok(nx, nz)) return { x: nx, z: nz, rotation: rnd() * Math.PI * 2 };
  }
  for (let attempt = 0; attempt < 90; attempt++) {
    const nx = (rnd() * 2 - 1) * lim;
    const nz = (rnd() * 2 - 1) * lim;
    if (ok(nx, nz)) return { x: nx, z: nz, rotation: rnd() * Math.PI * 2 };
  }
  return { x: (rnd() * 2 - 1) * 620, z: (rnd() * 2 - 1) * 620, rotation: rnd() * Math.PI * 2 };
}

module.exports = { createTerrainContext, decodeHeightsB64, normalizeCustomTownForServer, sampleOffshoreSpawn };
