'use strict';

/**
 * Procedural island / land sampling aligned with index.html (same hashes, noise, thresholds).
 * No THREE, no G — pure functions for the Node NPC authority.
 */

const CHUNK_SIZE = 270;
const WORLD_CHUNK_HALF = 7;
const WORLD_EDGE_CLAMP = WORLD_CHUNK_HALF * CHUNK_SIZE + CHUNK_SIZE * 0.5;
const ISLAND_CHANCE = 0.25;
const ISLAND_HEIGHT_FALLOFF_POW = 1.48;
const PROC_LAND_HT_MIN = 0.22;
const PROC_LAND_WARP_MAX = 0.865;
const PROC_COLLIDE_LAND_EXTRA_HT = 0.11;
const PROC_COLLIDE_WARP_SHRINK = 0.034;
const PROC_EDGE_WARP_AMP1 = 0.10;
const PROC_EDGE_WARP_AMP2 = 0.038;
const PROC_COAST_WOBBLE = 0.045;
const FACTION_COUNT = 5;

const FACTION_TOWN_STEMS = [
  ['Whitstable', 'Penzance', 'Falmouth'],
  ['Vlissingen', 'Terneuzen', 'Harlingen'],
  ['Calais Roads', 'Boulogne', 'Dunkerque'],
  ['Cádiz Bay', 'Málaga', 'Almería'],
  ['Lisboa Tejo', 'Porto Douro', 'Aveiro']
];
const TOWN_NAME_TAGS = [' Reach', ' Roads', ' Haven', ' Bay', ' Sound'];

function isChunkInWorld(cx, cz) {
  return cx >= -WORLD_CHUNK_HALF && cx <= WORLD_CHUNK_HALF && cz >= -WORLD_CHUNK_HALF && cz <= WORLD_CHUNK_HALF;
}

function hashChunk(cx, cz, worldSeedOpt) {
  const ws = worldSeedOpt !== undefined ? (Number(worldSeedOpt) >>> 0) : 0;
  let h = ws | 0;
  h = ((h << 5) - h + cx * 374761393) | 0;
  h = ((h << 5) - h + cz * 668265263) | 0;
  h = ((h ^ (h >> 13)) * 1274126177) | 0;
  return (h >>> 0) / 4294967296;
}

class SimplexNoise {
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
    let n0 = 0, n1 = 0, n2 = 0;
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
    let sum = 0, amp = 1, freq = 1, max = 0;
    for (let i = 0; i < octaves; i++) {
      sum += this.noise2D(x * freq, y * freq) * amp;
      max += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / max;
  }
}

function createProceduralTerrain(worldSeed) {
  const ws = Number(worldSeed) >>> 0;
  const globalNoise = new SimplexNoise(ws);
  const chunkIslandNoise = Object.create(null);
  function getCachedIslandNoise(cx, cz) {
    const key = cx + ',' + cz;
    if (!chunkIslandNoise[key]) chunkIslandNoise[key] = new SimplexNoise(cx * 777 + cz * 333);
    return chunkIslandNoise[key];
  }
  function proceduralIslandNormDistCore(px, pz, worldX, worldZ, islandRadius, islandNoise) {
    const e1 = 0.58 + Math.abs(islandNoise.noise2D(worldX * 0.0019, worldZ * 0.0019)) * 0.46;
    const e2 = 0.58 + Math.abs(islandNoise.noise2D(worldX * 0.0019 + 12.2, worldZ * 0.0019 - 8.4)) * 0.46;
    const ellA = islandRadius * e1;
    const ellB = islandRadius * e2;
    const ang0 = islandNoise.noise2D(worldX * 0.0016, worldZ * 0.0016) * Math.PI;
    const c = Math.cos(ang0), s = Math.sin(ang0);
    const rx = px * c - pz * s;
    const rz = px * s + pz * c;
    let d0 = Math.sqrt((rx / ellA) * (rx / ellA) + (rz / ellB) * (rz / ellB));
    d0 += islandNoise.noise2D(px * 0.062 + worldX * 0.007, pz * 0.062 + worldZ * 0.007) * 0.12;
    d0 += islandNoise.noise2D(px * 0.018 - 2.2, pz * 0.018 + 1.7) * 0.06;
    return d0;
  }
  function dryLandCollisionSampleForMeta(wx, wz, meta) {
    const worldX = meta.worldX, worldZ = meta.worldZ;
    const islandRadius = meta.radius, islandHeight = meta.maxH;
    const px = wx - worldX, pz = wz - worldZ;
    if (px * px + pz * pz > islandRadius * islandRadius * 2.45) return false;
    const islandNoise = getCachedIslandNoise(meta.cx, meta.cz);
    const dist = proceduralIslandNormDistCore(px, pz, worldX, worldZ, islandRadius, islandNoise);
    const n1 = globalNoise.fbm((worldX + px) * 0.015, (worldZ + pz) * 0.015, 4);
    const n2 = islandNoise.noise2D((worldX + px) * 0.025, (worldZ + pz) * 0.025) * 0.25;
    const ridges = Math.abs(islandNoise.noise2D((worldX + px) * 0.04, (worldZ + pz) * 0.04)) * 0.2;
    const combined = n1 * 0.6 + n2 + ridges;
    const edgeWarp = islandNoise.noise2D(px * 0.02, pz * 0.02) * PROC_EDGE_WARP_AMP1 + islandNoise.noise2D(px * 0.05, pz * 0.05) * PROC_EDGE_WARP_AMP2;
    const coastWobble = islandNoise.noise2D(px * 0.11, pz * 0.11) * PROC_COAST_WOBBLE;
    const warpedDist = dist + edgeWarp + coastWobble;
    const falloff = Math.max(0, 1 - warpedDist * warpedDist);
    const ht = (combined * 0.5 + 0.5) * islandHeight * Math.pow(falloff, ISLAND_HEIGHT_FALLOFF_POW);
    return ht > PROC_LAND_HT_MIN + PROC_COLLIDE_LAND_EXTRA_HT && warpedDist < PROC_LAND_WARP_MAX - PROC_COLLIDE_WARP_SHRINK;
  }
  function proceduralTownNameCore(cx, cz, prefixFaction) {
    const fi = (prefixFaction | 0) % FACTION_COUNT;
    const stems = FACTION_TOWN_STEMS[fi] || FACTION_TOWN_STEMS[0];
    let th = (cx * 73856093 ^ cz * 19349663 ^ ws ^ (cx * 374761393) ^ (cz * 668265263)) >>> 0;
    const baseIdx = th % stems.length;
    th = Math.imul(th, 1103515245) + 12345 >>> 0;
    const tagIdx = th % TOWN_NAME_TAGS.length;
    const body = stems[baseIdx];
    return (body + TOWN_NAME_TAGS[tagIdx]).replace(/\s{2,}/g, ' ').trim();
  }
  function placeTownDockSeaward(meta) {
    if (!meta || !meta.hasTown) return;
    const wx0 = meta.worldX, wz0 = meta.worldZ;
    const R = meta.radius;
    const da = meta.dockAngle || 0;
    const dirX = Math.cos(da), dirZ = Math.sin(da);
    let lo = R * 0.22;
    if (!dryLandCollisionSampleForMeta(wx0 + dirX * lo, wz0 + dirZ * lo, meta)) lo = Math.max(4, R * 0.06);
    let hi = R * 1.05;
    let guard = 0;
    while (dryLandCollisionSampleForMeta(wx0 + dirX * hi, wz0 + dirZ * hi, meta) && hi < R * 1.78 && guard++ < 28) hi += R * 0.055;
    if (dryLandCollisionSampleForMeta(wx0 + dirX * hi, wz0 + dirZ * hi, meta)) {
      meta.dockX = wx0 + dirX * (R * 1.02);
      meta.dockZ = wz0 + dirZ * (R * 1.02);
    } else {
      for (let i = 0; i < 26; i++) {
        const mid = (lo + hi) * 0.5;
        if (dryLandCollisionSampleForMeta(wx0 + dirX * mid, wz0 + dirZ * mid, meta)) lo = mid;
        else hi = mid;
      }
      const seaDist = hi + Math.min(11, R * 0.085);
      meta.dockX = wx0 + dirX * seaDist;
      meta.dockZ = wz0 + dirZ * seaDist;
    }
    let nudge = 0;
    const step = Math.max(2.6, R * 0.034);
    while (dryLandCollisionSampleForMeta(meta.dockX, meta.dockZ, meta) && nudge < 44) {
      meta.dockX += dirX * step;
      meta.dockZ += dirZ * step;
      nudge++;
    }
    const ox = meta.dockX - wx0, oz = meta.dockZ - wz0;
    if (Math.abs(ox) + Math.abs(oz) > 0.25) meta.dockAngle = Math.atan2(ox, oz);
  }
  function getProceduralIslandMeta(cx, cz) {
    if (!isChunkInWorld(cx, cz)) return null;
    const h = hashChunk(cx, cz, ws);
    if (h > ISLAND_CHANCE) return null;
    const jitter = CHUNK_SIZE * 0.17;
    const jx = (hashChunk(cx + 31, cz + 17, ws) * 2 - 1) * jitter;
    const jz = (hashChunk(cx - 19, cz + 83, ws) * 2 - 1) * jitter;
    const worldX = cx * CHUNK_SIZE + jx, worldZ = cz * CHUNK_SIZE + jz;
    const sizeFactor = (hashChunk(cx + 11, cz + 29, ws) * 0.55 + hashChunk(cx - 17, cz + 41, ws) * 0.45);
    const sizeClass = hashChunk(cx + 5, cz + 23, ws);
    let islandRadius = 15 + sizeFactor * 100 + h * 30;
    let islandHeight = 2.2 + sizeFactor * 12 + h * 5.5;
    if (sizeClass < 0.34) {
      islandRadius *= 0.38 + hashChunk(cx, cz + 1, ws) * 0.28;
      islandHeight *= 0.72 + hashChunk(cx - 3, cz + 8, ws) * 0.22;
    } else if (sizeClass > 0.86) {
      islandRadius *= 1.08 + hashChunk(cx + 9, cz - 2, ws) * 0.38;
      islandHeight *= 1.05 + hashChunk(cx - 1, cz + 4, ws) * 0.25;
    }
    const meta = { cx, cz, worldX, worldZ, radius: islandRadius, maxH: islandHeight, hasTown: false, h };
    if (islandRadius > 50 && h < 0.12) {
      meta.hasTown = true;
      meta.faction = ((cx * 7919 ^ cz * 9341 ^ ws) >>> 0) % FACTION_COUNT;
      meta.townName = proceduralTownNameCore(cx, cz, meta.faction % FACTION_COUNT);
      meta.dockAngle = (hashChunk(cx + 99, cz + 99, ws) * 2 - 1) * Math.PI;
      placeTownDockSeaward(meta);
    }
    return meta;
  }
  function dryLandAtWorldPosition(wx, wz) {
    const cxi = Math.floor(wx / CHUNK_SIZE), czi = Math.floor(wz / CHUNK_SIZE);
    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        const meta = getProceduralIslandMeta(cxi + dc, czi + dr);
        if (!meta) continue;
        if (dryLandCollisionSampleForMeta(wx, wz, meta)) return true;
      }
    }
    return false;
  }
  function forEachProceduralIslandInWorldBounds(minWx, maxWx, minWz, maxWz, fn, centerWx, centerWz) {
    let minCx = Math.floor(minWx / CHUNK_SIZE), maxCx = Math.floor(maxWx / CHUNK_SIZE);
    let minCz = Math.floor(minWz / CHUNK_SIZE), maxCz = Math.floor(maxWz / CHUNK_SIZE);
    const spanX = maxCx - minCx + 1, spanZ = maxCz - minCz + 1;
    const maxSpan = 100;
    const ccx = Math.floor(((centerWx != null ? centerWx : (minWx + maxWx) * 0.5)) / CHUNK_SIZE);
    const ccz = Math.floor(((centerWz != null ? centerWz : (minWz + maxWz) * 0.5)) / CHUNK_SIZE);
    const half = maxSpan >> 1;
    if (spanX > maxSpan) { minCx = ccx - half; maxCx = ccx + half; }
    if (spanZ > maxSpan) { minCz = ccz - half; maxCz = ccz + half; }
    for (let cxi = minCx; cxi <= maxCx; cxi++) {
      for (let czi = minCz; czi <= maxCz; czi++) {
        const meta = getProceduralIslandMeta(cxi, czi);
        if (meta) fn(meta);
      }
    }
  }
  function collectAllTradingPorts() {
    const out = [];
    const lim = WORLD_EDGE_CLAMP;
    forEachProceduralIslandInWorldBounds(-lim, lim, -lim, lim, m => {
      if (m.hasTown && m.dockX != null) out.push(m);
    }, 0, 0);
    return out;
  }
  return {
    CHUNK_SIZE,
    WORLD_EDGE_CLAMP,
    FACTION_COUNT,
    ws,
    globalNoise,
    dryLandAtWorldPosition,
    getProceduralIslandMeta,
    forEachProceduralIslandInWorldBounds,
    collectAllTradingPorts
  };
}

module.exports = { createProceduralTerrain };
