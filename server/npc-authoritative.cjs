'use strict';

const { createTerrainContext } = require('./terrain-context.cjs');

const FACTION_COUNT = 5;
const TRADE_NPC_SYNC_START = 200;
const PATROL_SYNC_MIN = 35000;
const PATROL_SYNC_MAX = 37999;
const NPC_SPAWN_EXTRA_GAP = 12;
const PLAYER_BROADSIDE_COOLDOWN = 2.5;
const CANNONBALL_XY_SPEED = 35;
const TRADE_DOCK_DIST = 40;
const PORT_EXPORT_POOL = ['food', 'cannonballs', 'grapeshot', 'chainshot', 'wood', 'cloth', 'iron', 'rum', 'gunpowder'];
/** Vanilla pirate slots (syncId 0..n-1) respawn this long after removal (matches browser host). */
const VANILLA_PIRATE_RESPAWN_MS = 180000;
/** Match client `factionHostileToPlayer` — only open combat on strong personal standing penalty. */
const COMBAT_HOSTILE_STANDING = -42;

const SHIP_TYPES = {
  cutter: { hullLen: 5, hullW: 1.6, speed: 1.75, turnRate: 1.6, cannonSlots: 1 },
  sloop: { hullLen: 7, hullW: 2.2, speed: 1.5, turnRate: 1.3, cannonSlots: 2 },
  brigantine: { hullLen: 10, hullW: 3.2, speed: 1.25, turnRate: 1.0, cannonSlots: 4 },
  galleon: { hullLen: 14, hullW: 4.5, speed: 0.94, turnRate: 0.7, cannonSlots: 6 },
  warship: { hullLen: 18, hullW: 5.5, speed: 0.69, turnRate: 0.5, cannonSlots: 10 }
};

const FACTION_TRADE_COLORS = ['#c8102e', '#e87722', '#0055a4', '#e6bc0c', '#1a7a3e'];
const FACTION_FLAG_PNG_IDS = [10, 13, 21, 19, 16];
const RESERVED_PLAYER_FLAG_IDS = new Set([10, 13, 15, 16, 19, 21]);
const PLAYER_FLAG_CHOICE_IDS = (() => {
  const a = [];
  for (let i = 1; i <= 26; i++) if (!RESERVED_PLAYER_FLAG_IDS.has(i)) a.push(i);
  return a;
})();
const DEFAULT_PLAYER_FLAG_ASSET = 1;
const FACTION_SHORT_NAMES = ['Britain', 'Netherlands', 'France', 'Spain', 'Portugal'];
const FACTION_MERCHANT_SHIP_NAMES = [
  ['HMS Packet Lark', 'Britannia Merchant', 'Atlantic Factor'],
  ['VOC Vertrouwen', 'Zeelandia', 'Batavia Return'],
  ['Saint Louis', 'Belle Poule Marchande', 'Roi Soleil'],
  ['Nuestra Señora del Rosario', 'San Fernando Merchant', 'Rey Católico'],
  ['Nossa Senhora da Boa Viagem', 'Tejo Trader', 'Índia Portuguesa']
];
const FACTION_PIRATE_SHIP_NAMES = [
  ['Red Jackal', 'Channel Reaver', 'Atlantic Knave', 'Cornish Spectre', 'Thames Cutlass'],
  ['Flying Herring', 'Texel Terror', 'Holland Hook', 'Scheldt Skulker', 'Batavian Banshee'],
  ['Sans-Culotte Fury', 'Belle Mort', 'Marseille Malice', 'Jacobin Jackal', 'Petit Tonnerre'],
  ['Diablo del Plata', 'Rey Negro', 'Costa Oscura', 'Carabela Maldita', 'Muerte Española'],
  ['Cão do Atlântico', 'Fantasma do Tejo', 'Navio da Maldição', 'Estrela Negra', 'Corsário do Sul']
];
const FACTION_PATROL_SHIP_NAMES = [
  ['HMS Vigilant', 'HMS Crescent', 'HMS Seahorse', 'HMS Kingfisher', 'HMS Sparrowhawk', 'HMS Bold', 'HMS Pallas', 'HMS Active', 'HMS Druid', 'HMS Squirrel', 'HMS Cygnet', 'HMS Rose', 'HMS Lynx', 'HMS Porcupine', 'HMS Rattlesnake', 'HMS Cruizer', 'HMS Scout', 'HMS Swallow', 'HMS Zephyr', 'HMS Falcon'],
  ['HNLMS Holland', 'HNLMS Friesland', 'HNLMS Zeeland', 'HNLMS Gelderland', 'HNLMS Utrecht', 'HNLMS Overijssel', 'HNLMS Noord-Brabant', 'HNLMS Groningen', 'HNLMS Drenthe', 'HNLMS Wielingen', 'HNLMS Van Speijk', 'HNLMS Van Galen', 'HNLMS Van Nes', 'HNLMS Evertsen', 'HNLMS Piet Hein', 'HNLMS De Ruyter', 'HNLMS Tromp', 'HNLMS Kortenaer', 'HNLMS Banckert', 'HNLMS Van Kinsbergen'],
  ['La Railleuse', 'La Sérieuse', 'La Volontaire', 'La Prudente', 'La Boudeuse', 'La Junon', 'La Nymphe', 'La Sensible', 'La Résolue', 'La Vénus', 'L\'Hirondelle', 'Le Faucon', 'Le Téméraire', 'Le Hardi', 'Le Brave', 'Le Vigilant', 'Le Tonnant', 'Le Cassard', 'Le Pluton', 'Le Mars'],
  ['Nuestra Señora de Aránzazu', 'Santa Teresa', 'San Julián', 'San Vicente', 'Santa Rufina', 'San Hermenegildo', 'Santa Casilda', 'San Fulgencio', 'Santa Florentina', 'San Leandro', 'La Perla', 'El Rayo', 'La Estrella', 'El Veloz', 'La Brava', 'El Diligente', 'La Fama', 'El Marte', 'La Soledad', 'El Neptuno'],
  ['NRP Príncipe Real', 'NRP Dom João', 'NRP Afonso de Albuquerque', 'NRP Bartolomeu Dias', 'NRP Vasco da Gama', 'NRP Pedro Álvares Cabral', 'NRP Diogo Cão', 'NRP Fernão de Magalhães', 'NRP Sagres', 'NRP Tritão', 'NRP Golfinho', 'NRP Águia', 'NRP Falcão', 'NRP Lince', 'NRP Pantera', 'NRP Leão', 'NRP Tigre', 'NRP Dragão', 'NRP Serpente', 'NRP Estrela do Mar']
];

function tradeShipCannonForType(shipType) {
  if (shipType === 'galleon') return 'heavy';
  if (shipType === 'brigantine') return 'medium';
  return 'light';
}

function shipHullRadius(shipType) {
  const s = SHIP_TYPES[shipType] || SHIP_TYPES.sloop;
  return Math.max(3.1, s.hullLen * 0.5 + s.hullW * 0.42);
}

function factionFlagPngIdForFaction(fid) {
  return FACTION_FLAG_PNG_IDS[(fid | 0) % FACTION_COUNT] || FACTION_FLAG_PNG_IDS[0];
}

function randomChoosableFlagRng(rng) {
  const ids = PLAYER_FLAG_CHOICE_IDS;
  return ids[Math.floor(rng() * ids.length)] || DEFAULT_PLAYER_FLAG_ASSET;
}

function proceduralFactionMerchantShipName(fid, salt) {
  const f = (fid | 0) % FACTION_COUNT;
  const pool = FACTION_MERCHANT_SHIP_NAMES[f] || FACTION_MERCHANT_SHIP_NAMES[0];
  const th = (Math.imul(salt | 0, 1103515245) + 12345 ^ f * 7919) >>> 0;
  return pool[th % pool.length];
}

function proceduralPirateShipName(fid, cx, cz, idx, ws) {
  const f = (fid | 0) % FACTION_COUNT;
  const pool = FACTION_PIRATE_SHIP_NAMES[f] || FACTION_PIRATE_SHIP_NAMES[0];
  const th = ((cx | 0) * 73856093 ^ (cz | 0) * 19349663 ^ (idx | 0) * 83492791 ^ (ws | 0) ^ (f * 50261)) >>> 0;
  return pool[th % pool.length];
}

function proceduralFactionPatrolShipName(fid, cx, cz, pid, ws) {
  const f = (fid | 0) % FACTION_COUNT;
  const pool = FACTION_PATROL_SHIP_NAMES[f] || FACTION_PATROL_SHIP_NAMES[0];
  const th = ((cx | 0) * 73856093 ^ (cz | 0) * 19349663 ^ (pid | 0) * 83492791 ^ (ws | 0) ^ (f * 50261)) >>> 0;
  return pool[th % pool.length];
}

function makePoliticsMatrix(ws) {
  const matrix = [];
  for (let i = 0; i < FACTION_COUNT; i++) {
    const row = [];
    for (let j = 0; j < FACTION_COUNT; j++) {
      if (i === j) row.push(100);
      else row.push(8 + ((i * 17 + j * 31 + (ws | 0)) % 55) - 20);
    }
    matrix.push(row);
  }
  return matrix;
}

function factionsConsideredAtWar(a, b, matrix) {
  const i = (a | 0) % FACTION_COUNT;
  const j = (b | 0) % FACTION_COUNT;
  if (i === j) return false;
  return (matrix[i][j] + matrix[j][i]) / 2 < 18;
}

function townFaction(meta, portController, ws) {
  if (!meta || !meta.hasTown) return 0;
  const k = `${meta.cx},${meta.cz}`;
  if (portController && portController[k] != null) return (portController[k] | 0) % FACTION_COUNT;
  return meta.faction != null ? (meta.faction | 0) % FACTION_COUNT : (((meta.cx * 7919 ^ meta.cz * 9341 ^ (ws >>> 0)) >>> 0) % FACTION_COUNT);
}

function portExportsGood(meta, ws) {
  if (!meta || !meta.hasTown) return 'food';
  const idx = ((meta.cx * 5023 ^ meta.cz * 9839 ^ (ws >>> 0)) >>> 0) % PORT_EXPORT_POOL.length;
  return PORT_EXPORT_POOL[idx];
}

function pickTradeDestination(home, list, rng, ws, portController) {
  const others = list.filter(p => p.cx !== home.cx || p.cz !== home.cz);
  if (!others.length) return null;
  const hf = townFaction(home, portController, ws);
  let cand = others.filter(p => townFaction(p, portController, ws) === hf && portExportsGood(p, ws) !== portExportsGood(home, ws));
  if (!cand.length) cand = others.filter(p => townFaction(p, portController, ws) === hf);
  if (!cand.length) cand = others.filter(p => portExportsGood(p, ws) !== portExportsGood(home, ws));
  if (!cand.length) cand = others;
  return cand[Math.floor(rng() * cand.length)];
}

function syncTradeShipName(npc, homeMeta, ws, portController) {
  const shortLab = (npc.cargoGood || 'cargo').split(/\s+/)[0];
  const homeFac = townFaction(homeMeta, portController, ws) % FACTION_COUNT;
  const vessel = proceduralFactionMerchantShipName(homeFac, (npc.syncId | 0) ^ ((homeMeta.cx | 0) * 31 + (homeMeta.cz | 0) * 17));
  let tradeName = `${vessel} · ${shortLab}`;
  if (tradeName.length > 28) tradeName = tradeName.slice(0, 27) + '…';
  npc.name = tradeName;
}

function assignTradeRouteFromHome(npc, homeMeta, list, rng, ws, portController) {
  npc.homeDockX = homeMeta.dockX;
  npc.homeDockZ = homeMeta.dockZ;
  npc.homeCx = homeMeta.cx;
  npc.homeCz = homeMeta.cz;
  npc.cargoGood = portExportsGood(homeMeta, ws);
  let dest = pickTradeDestination(homeMeta, list, rng, ws, portController);
  if (!dest) {
    const others = list.filter(p => p.cx !== homeMeta.cx || p.cz !== homeMeta.cz);
    if (others.length) dest = others[Math.floor(rng() * others.length)];
  }
  if (!dest) return;
  npc.destCx = dest.cx;
  npc.destCz = dest.cz;
  npc.tradeDestX = dest.dockX;
  npc.tradeDestZ = dest.dockZ;
  npc.cargoUnits = 10 + ((Math.floor(rng() * 10) | 0));
  syncTradeShipName(npc, homeMeta, ws, portController);
  npc.flagColor = FACTION_TRADE_COLORS[townFaction(homeMeta, portController, ws) % FACTION_COUNT];
  npc.targetCruise = null;
  npc.tradeCruiseSpeed = null;
}

function findMerchantSpawnOffCoast(home, rng, shipTypeOpt, dryLand, edgeClamp) {
  if (!home || home.dockX == null) return null;
  const spec = SHIP_TYPES[shipTypeOpt || 'brigantine'] || SHIP_TYPES.sloop;
  const da = home.dockAngle || 0;
  const longX = Math.sin(da);
  const longZ = Math.cos(da);
  const widX = Math.cos(da);
  const widZ = -Math.sin(da);
  const along0 = Math.max(44, spec.hullLen * 5);
  const landClear = Math.max(54, spec.hullLen * 2.5, along0 * 0.62);
  const hasClear = (cx, cz) => {
    if (dryLand(cx, cz)) return false;
    let open = 0;
    for (let i = 0; i < 10; i++) {
      const ang = (i / 10) * Math.PI * 2;
      if (!dryLand(cx + Math.cos(ang) * landClear, cz + Math.sin(ang) * landClear)) open++;
    }
    return open >= 6;
  };
  for (let attempt = 0; attempt < 64; attempt++) {
    const along = along0 + rng() * 26 + (attempt % 20) * 2.9;
    const lateral = (rng() - 0.5) * 16 + Math.sin(attempt * 0.29) * 7;
    const nx = home.dockX + longX * along + widX * lateral;
    const nz = home.dockZ + longZ * along + widZ * lateral;
    const cx = Math.max(-edgeClamp, Math.min(edgeClamp, nx));
    const cz = Math.max(-edgeClamp, Math.min(edgeClamp, nz));
    if (!dryLand(cx, cz) && hasClear(cx, cz)) return { nx: cx, nz: cz };
  }
  return null;
}

function sampleOpenOceanPointInWorld(rng, dryLand, edgeClamp, hasClearFn) {
  const lim = edgeClamp * 0.86;
  const minClear = 92;
  const ok = (nx, nz) => {
    if (dryLand(nx, nz)) return false;
    if (hasClearFn) return hasClearFn(nx, nz, minClear);
    let open = 0;
    for (let i = 0; i < 10; i++) {
      const ang = (i / 10) * Math.PI * 2;
      if (!dryLand(nx + Math.cos(ang) * minClear, nz + Math.sin(ang) * minClear)) open++;
    }
    return open >= 6;
  };
  for (let attempt = 0; attempt < 140; attempt++) {
    const bias = 0.42 + rng() * 0.58;
    const nx = (rng() * 2 - 1) * lim * bias;
    const nz = (rng() * 2 - 1) * lim * bias;
    if (ok(nx, nz)) return { nx, nz };
  }
  for (let attempt = 0; attempt < 70; attempt++) {
    const nx = (rng() * 2 - 1) * lim;
    const nz = (rng() * 2 - 1) * lim;
    if (ok(nx, nz)) return { nx, nz };
  }
  return { nx: (rng() * 2 - 1) * 600, nz: (rng() * 2 - 1) * 600 };
}

function getNpcRiggingHealth(npc) {
  if (!npc) return 100;
  if (npc.riggingHealth != null) return Math.max(0, Math.min(100, Number(npc.riggingHealth)));
  return 100;
}

function npcSailBonus(npc) {
  if (npc.sailBonus != null) return npc.sailBonus;
  if (npc.isTradeShip) return npc.sailPick === 'silk' ? 0.6 : 0.3;
  return 0.35;
}

function npcMaxForwardSpeed(npc) {
  const spec = SHIP_TYPES[npc.type] || SHIP_TYPES.sloop;
  const rm = Math.max(0.1, getNpcRiggingHealth(npc) / 100);
  const rigF = Math.max(0.26, Math.pow(rm, 1.32));
  /* ~player-scale top speed (+50% vs legacy tuning). */
  return 14.25 * (spec.speed + npcSailBonus(npc)) * rigF * 1.09 * 1.5;
}

function npcWindEffect(npc, windAt) {
  const w = windAt(npc.x, npc.z);
  const windDot = Math.cos(w.angle - npc.rotation);
  return Math.max(0.25, windDot * 0.35 + 0.65);
}

function npcEffectiveForwardSpeed(npc, windAt) {
  const maxF = npcMaxForwardSpeed(npc);
  const v = Math.min(Math.abs(npc.speed || 0), maxF);
  return v * npcWindEffect(npc, windAt);
}

function npcSailingTurnFactor(npc, windAt) {
  const v = npcEffectiveForwardSpeed(npc, windAt);
  const t = Math.min(1, Math.max(0, (v - 0.06) / 5.4));
  return 0.11 + 0.89 * t * t;
}

function accelerateNpcToward(npc, dt, target) {
  const spec = SHIP_TYPES[npc.type] || SHIP_TYPES.sloop;
  const speedMult = spec.speed + npcSailBonus(npc);
  const maxF = npcMaxForwardSpeed(npc);
  const t = Math.min(maxF, Math.max(0, target));
  let spd = npc.speed || 0;
  if (spd < t - 0.03) {
    spd = Math.min(spd + 6.2 * dt * speedMult, t, maxF);
  } else if (spd > t + 0.03) {
    spd *= (1 - 0.3 * dt);
    if (spd < t) spd = t;
  }
  npc.speed = Math.max(-maxF * 0.2, Math.min(maxF, spd));
}

function npcShouldUseOffshoreRoutingServer(npc) {
  if (!npc) return true;
  if (!npc.isTradeShip) return true;
  const ph = npc.tradePhase || 'to_dest';
  return ph !== 'dock_dest' && ph !== 'dock_home' && ph !== 'loading_home';
}

function npcLooseCoastalRoom(x, z, dryLand) {
  if (dryLand(x, z)) return false;
  let ok = 0;
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    if (!dryLand(x + Math.cos(ang) * 34, z + Math.sin(ang) * 34)) ok++;
  }
  return ok >= 5;
}

function npcForwardRayClear(npc, dist, segments, dryLand) {
  const n = Math.max(2, segments | 0);
  const step = dist / n;
  const offshore = npcShouldUseOffshoreRoutingServer(npc);
  for (let s = 1; s <= n; s++) {
    const x = npc.x + Math.sin(npc.rotation) * step * s;
    const z = npc.z + Math.cos(npc.rotation) * step * s;
    if (dryLand(x, z)) return false;
    if (offshore && s >= 2 && (s & 1) === 0 && !npcLooseCoastalRoom(x, z, dryLand)) return false;
  }
  return true;
}

function steerNpcClearanceAhead(npc, dt, turnSharp, windAt, dryLand) {
  if (npc.escapeMode) return;
  if (dryLand(npc.x, npc.z)) return;
  const look = npc.isTradeShip ? 76 : 80;
  if (npcForwardRayClear(npc, look, npc.isTradeShip ? 14 : 13, dryLand)) return;
  const turn = turnSharp != null ? turnSharp : 2.35;
  const arc = npc.isTradeShip ? 1.38 : 1.34;
  const turnMul = npc.isTradeShip ? 0.88 : 0.82;
  const offshore = npcShouldUseOffshoreRoutingServer(npc);
  const oceanW = offshore;
  let bestScore = -1;
  const cand = [];
  for (let i = -16; i <= 16; i++) {
    const a = npc.rotation + (i / 16) * arc;
    let score = 0;
    const rayStep = npc.isTradeShip ? 10.2 : 9.6;
    const rayLen = npc.isTradeShip ? 10 : 11;
    for (let s = 1; s <= rayLen; s++) {
      const x = npc.x + Math.sin(a) * rayStep * s;
      const z = npc.z + Math.cos(a) * rayStep * s;
      if (dryLand(x, z)) break;
      if (oceanW && s >= 3 && (s === 5 || s === 9) && !npcLooseCoastalRoom(x, z, dryLand)) break;
      score++;
    }
    if (score > bestScore) {
      bestScore = score;
      cand.length = 0;
      cand.push(a);
    } else if (score === bestScore) {
      cand.push(a);
    }
  }
  const needScore = npc.isTradeShip ? 4 : offshore ? 3 : 2;
  if (bestScore < needScore || !cand.length) return;
  let bestAng = cand[0];
  if (cand.length > 1) {
    let bestAbs = Infinity;
    for (let ci = 0; ci < cand.length; ci++) {
      const ca = cand[ci];
      let d0 = ca - npc.rotation;
      while (d0 > Math.PI) d0 -= Math.PI * 2;
      while (d0 < -Math.PI) d0 += Math.PI * 2;
      const ad = Math.abs(d0);
      if (ad < bestAbs - 1e-7) {
        bestAbs = ad;
        bestAng = ca;
      }
    }
  }
  let diff = bestAng - npc.rotation;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  npc.rotation += diff * turn * dt * turnMul * npcSailingTurnFactor(npc, windAt);
  npc.wanderAngle = npc.rotation;
}

function nudgeNpcOffIsland(npc, dryLand, edgeClamp) {
  if (!dryLand(npc.x, npc.z)) return;
  const step = npc.isTradeShip ? 44 : 26;
  const push = npc.isTradeShip ? 16 : 5;
  let bestA = null;
  let best = -1;
  const nRay = npc.isTradeShip ? 32 : 26;
  const nSeg = npc.isTradeShip ? 5 : 4;
  for (let i = 0; i < nRay; i++) {
    const ang = (i / nRay) * Math.PI * 2;
    let ok = 0;
    for (let s = 1; s <= nSeg; s++) {
      const tx = npc.x + Math.sin(ang) * step * s;
      const tz = npc.z + Math.cos(ang) * step * s;
      if (!dryLand(tx, tz)) ok++;
      else break;
    }
    if (ok > best) {
      best = ok;
      bestA = ang;
    }
  }
  if (best >= 1 && bestA != null) {
    npc.x += Math.sin(bestA) * push;
    npc.z += Math.cos(bestA) * push;
    npc.rotation = bestA;
    npc.wanderAngle = bestA;
    return;
  }
  npc.x = Math.max(-edgeClamp, Math.min(edgeClamp, npc.x * 0.92));
  npc.z = Math.max(-edgeClamp, Math.min(edgeClamp, npc.z * 0.92));
}

function applyNpcMoveWithIslandEscape(npc, dt, sharp, windAt, dryLand, edgeClamp) {
  if (npcShouldUseOffshoreRoutingServer(npc) && !npcLooseCoastalRoom(npc.x, npc.z, dryLand)) {
    steerNpcClearanceAhead(npc, dt, sharp, windAt, dryLand);
  }
  const eff = npcEffectiveForwardSpeed(npc, windAt);
  const nx = npc.x + Math.sin(npc.rotation) * eff * dt;
  const nz = npc.z + Math.cos(npc.rotation) * eff * dt;
  if (!dryLand(nx, nz)) {
    npc.x = nx;
    npc.z = nz;
    return;
  }
  steerNpcClearanceAhead(npc, dt, sharp, windAt, dryLand);
  const eff2 = npcEffectiveForwardSpeed(npc, windAt);
  const nx2 = npc.x + Math.sin(npc.rotation) * eff2 * dt * 0.35;
  const nz2 = npc.z + Math.cos(npc.rotation) * eff2 * dt * 0.35;
  if (!dryLand(nx2, nz2)) {
    npc.x = nx2;
    npc.z = nz2;
  } else {
    nudgeNpcOffIsland(npc, dryLand, edgeClamp);
  }
}

function nearestCaptain(npcx, npcz, players) {
  let best = null;
  let bd = 1e9;
  for (const p of players.values()) {
    if (!p || p.docked) continue;
    const d = Math.hypot((p.x || 0) - npcx, (p.z || 0) - npcz);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best ? { p: best, d: bd } : null;
}

function clearBoardLocks(npcs) {
  for (const n of npcs) {
    n._boardLock = false;
  }
}

function applyNpcBoardingLocks(npcs, players) {
  for (const p of players.values()) {
    const b = p && p.boarding;
    if (!b || typeof b !== 'object') continue;
    const sid = Math.floor(Number(b.sid));
    if (!Number.isFinite(sid) || sid >= 0) continue;
    const syncId = -(sid + 1);
    const npc = npcs.find(n => n.syncId === syncId);
    if (!npc || npc.sinking) continue;
    if (b.ex != null && b.ez != null && b.er != null && Number.isFinite(Number(b.ex)) && Number.isFinite(Number(b.ez))) {
      npc.x = Number(b.ex);
      npc.z = Number(b.ez);
      npc.rotation = Number.isFinite(Number(b.er)) ? Number(b.er) : npc.rotation;
      npc.speed = 0;
      npc._boardLock = true;
    }
  }
}

function isSpawnFree(wx, wz, shipType, npcs, players, dryLand, edgeClamp) {
  if (dryLand(wx, wz)) return false;
  const pr = shipHullRadius(shipType);
  for (const p of players.values()) {
    const pR = shipHullRadius(p.shipType || 'sloop');
    if (Math.hypot(wx - (p.x || 0), wz - (p.z || 0)) < pr + pR + NPC_SPAWN_EXTRA_GAP + 4) return false;
  }
  for (const ex of npcs) {
    if (ex.sinking || (ex.health != null && ex.health <= 0)) continue;
    if (Math.hypot(wx - ex.x, wz - ex.z) < pr + shipHullRadius(ex.type) + NPC_SPAWN_EXTRA_GAP) return false;
  }
  return Math.abs(wx) <= edgeClamp && Math.abs(wz) <= edgeClamp;
}

function emitBroadside(broadcastAll, npc, targetX, targetZ, tvx, tvz) {
  const npcSpec = SHIP_TYPES[npc.type] || SHIP_TYPES.sloop;
  const cc = Math.max(1, npcSpec.cannonSlots || 2);
  const perSide = Math.ceil(cc / 2);
  let px = targetX;
  let pz = targetZ;
  for (let iter = 0; iter < 4; iter++) {
    const dx = px - npc.x;
    const dz = pz - npc.z;
    const dist = Math.hypot(dx, dz);
    const t = dist / CANNONBALL_XY_SPEED;
    px = targetX + tvx * t;
    pz = targetZ + tvz * t;
  }
  const dx = px - npc.x;
  const dz = pz - npc.z;
  const dist = Math.hypot(dx, dz);
  if (dist > 78 || dist < 2) return;
  const toTargetAngle = Math.atan2(dx, dz);
  const relAngle = toTargetAngle - npc.rotation;
  const normRel = ((relAngle % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
  const absRel = Math.abs(normRel);
  let side = absRel > Math.PI / 10 && absRel < Math.PI * 0.82 ? Math.sign(normRel) : 0;
  if (side === 0 && absRel >= Math.PI * 0.82) side = Math.sign(normRel) || 1;
  if (side === 0) return;

  const sinR = Math.sin(npc.rotation);
  const cosR = Math.cos(npc.rotation);
  const aimLen0 = dist;
  const baseDirX = dx / aimLen0;
  const baseDirZ = dz / aimLen0;
  const nVelX = Math.sin(npc.rotation) * (npc.speed || 0);
  const nVelZ = Math.cos(npc.rotation) * (npc.speed || 0);
  const fallbackY = 1.85;

  for (let g = 0; g < perSide; g++) {
    if (Math.random() < 0.14) continue;
    const jitter = (Math.random() - 0.5) * 0.62;
    const wide = (Math.random() - 0.5) * (0.38 + Math.random() * 0.35);
    const ang = jitter + wide;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    let dirX = baseDirX * c - baseDirZ * s;
    let dirZ = baseDirX * s + baseDirZ * c;
    const nL = Math.hypot(dirX, dirZ) || 1;
    dirX /= nL;
    dirZ /= nL;
    const localZ = (g - Math.floor(perSide / 2) + 0.5) * 1.45;
    const localX = side * (npcSpec.hullW * 0.55 + 0.6);
    const wx = npc.x + localX * cosR + localZ * sinR;
    const wz = npc.z - localX * sinR + localZ * cosR;
    const wy = fallbackY;
    try {
      broadcastAll({ type: 'npc_cannon', x: wx, z: wz, dx: dirX, dz: dirZ, y: wy });
      broadcastAll({ type: 'cannon_fx', x: wx, y: wy, z: wz, dx: dirX, dz: dirZ });
    } catch (e) {}
  }
}

const STORY_SHIP_ORDER = ['cutter', 'sloop', 'brigantine', 'galleon', 'warship'];
const STORY_BOUNTY_SYNC_MIN = 62000;
const STORY_BOUNTY_SYNC_SPAN = 32;
const HUNT_MARK_SYNC_MIN = 30000;
const HUNT_MARK_SYNC_MAX = 31999;
const STORY_BOUNTY_CAPTAIN_POOLS = {
  cutter: ['Silas "Shiv" Rackham', 'Nessa "Needle" Croft'],
  sloop: ['Mara Duskwind', 'Finn Crowsbeak'],
  brigantine: ['Iron Tom Corsair', 'Bram Blackjib'],
  galleon: ['Vex Blackwater', 'Cordelia Ashprow'],
  warship: ['Admiral Scarlett Graves', 'Commodore Jareth Pike']
};

function storyBountySyncId(ownerPlayerId, step) {
  const oid = Math.max(1, Math.floor(Number(ownerPlayerId) || 1));
  const st = Math.max(0, Math.min(STORY_SHIP_ORDER.length + 2, Math.floor(Number(step) || 0)));
  return STORY_BOUNTY_SYNC_MIN + oid * STORY_BOUNTY_SYNC_SPAN + st;
}

function pickStoryBountyCaptainName(shipType, ownerPlayerId, step) {
  const pool = STORY_BOUNTY_CAPTAIN_POOLS[shipType] || STORY_BOUNTY_CAPTAIN_POOLS.sloop;
  const oid = Math.max(0, Math.floor(Number(ownerPlayerId) || 0));
  const st = Math.max(0, Math.floor(Number(step) || 0));
  return pool[(oid * 31 + st * 17) % pool.length] || 'Notorious Pirate';
}

function computeStoryBountySpawn(sq, ctx, ws) {
  let h = (ws >>> 0) + (sq.step | 0) * 978689 + 1337;
  if (sq.turnInCx != null) h = (h + Math.imul(sq.turnInCx | 0, 1103515245)) >>> 0;
  if (sq.turnInCz != null) h = (h + Math.imul(sq.turnInCz | 0, 1225012097)) >>> 0;
  const rnd = () => {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    return h / 4294967296;
  };
  const meta = sq.turnInCx != null && sq.turnInCz != null ? ctx.getProceduralIslandMeta(sq.turnInCx | 0, sq.turnInCz | 0) : null;
  const ax = meta && meta.dockX != null ? meta.dockX : 0;
  const az = meta && meta.dockZ != null ? meta.dockZ : 0;
  const lim = ctx.edgeClamp - 55;
  const dryLand = (x, z) => ctx.dryLandAtWorldPosition(x, z);
  const hasCl = (x, z, c) => ctx.hasMinClearanceFromLand(x, z, c);
  for (let attempt = 0; attempt < 80; attempt++) {
    const ang = rnd() * Math.PI * 2;
    const dist = 220 + rnd() * 520;
    let x = ax + Math.sin(ang) * dist;
    let z = az + Math.cos(ang) * dist;
    x = Math.max(-lim, Math.min(lim, x));
    z = Math.max(-lim, Math.min(lim, z));
    if (!dryLand(x, z) && hasCl(x, z, 46)) return { x, z, rot: rnd() * Math.PI * 2 };
  }
  const pt = sampleOpenOceanPointInWorld(rnd, dryLand, ctx.edgeClamp, (wx, wz, c) => ctx.hasMinClearanceFromLand(wx, wz, c));
  return { x: pt.nx, z: pt.nz, rot: rnd() * Math.PI * 2 };
}

function syncStoryBountyNpcs(npcs, playerStories, ctx, ws, edgeClamp) {
  const active = new Set();
  if (playerStories && typeof playerStories.forEach === 'function') {
    playerStories.forEach((story, pid) => {
      if (!story || String(story.phase) !== 'active') return;
      const step = Math.max(0, Math.min(STORY_SHIP_ORDER.length - 1, Math.floor(Number(story.step) || 0)));
      const sid = storyBountySyncId(pid, step);
      active.add(sid);
      let bx = story.bountyX;
      let bz = story.bountyZ;
      let rot = story.bountyRot;
      if (!Number.isFinite(Number(bx)) || !Number.isFinite(Number(bz))) {
        const sp = computeStoryBountySpawn(story, ctx, ws);
        bx = sp.x;
        bz = sp.z;
        rot = sp.rot;
      } else {
        bx = Math.max(-edgeClamp, Math.min(edgeClamp, Number(bx)));
        bz = Math.max(-edgeClamp, Math.min(edgeClamp, Number(bz)));
        if (ctx.dryLandAtWorldPosition(bx, bz) || !ctx.hasMinClearanceFromLand(bx, bz, 40)) {
          const sp = computeStoryBountySpawn(story, ctx, ws);
          bx = sp.x;
          bz = sp.z;
          rot = sp.rot;
        }
      }
      const shipType = STORY_SHIP_ORDER[step] || 'sloop';
      const existing = npcs.find(n => n.syncId === sid);
      const hp = shipType === 'warship' ? 125 : shipType === 'galleon' ? 105 : shipType === 'brigantine' ? 90 : 72;
      if (existing) {
        if (!existing.sinking) {
          existing.health = hp;
          existing.type = shipType;
          existing.name = pickStoryBountyCaptainName(shipType, pid, step);
          existing.isStoryBounty = true;
          existing.storyStep = step;
          existing.missionOwnerPlayerId = pid;
          const stuck =
            ctx.dryLandAtWorldPosition(existing.x, existing.z) || !ctx.hasMinClearanceFromLand(existing.x, existing.z, 38);
          if (stuck) {
            existing.x = bx;
            existing.z = bz;
            existing.rotation = Number.isFinite(Number(rot)) ? Number(rot) : existing.rotation;
          }
        }
      } else {
        const newbie = {
          syncId: sid,
          missionOwnerPlayerId: pid,
          x: bx,
          z: bz,
          rotation: Number.isFinite(Number(rot)) ? Number(rot) : 0,
          speed: 0,
          health: hp,
          type: shipType,
          name: pickStoryBountyCaptainName(shipType, pid, step),
          wanderAngle: Math.random() * Math.PI * 2,
          wanderTimer: 6,
          underFireTimer: 0,
          riggingHealth: 100,
          isStoryBounty: true,
          storyStep: step,
          factionId: ((Math.floor(bx / 270) * 31 + Math.floor(bz / 270) * 17 + (ws | 0)) >>> 0) % FACTION_COUNT,
          flagColor: FACTION_TRADE_COLORS[0],
          flagAssetId: randomChoosableFlagRng(() => {
            const t = Math.imul(sid | 0, 1103515245) + 12345;
            return ((t >>> 0) % 1000001) / 1000001;
          }),
          flagPosition: 'mast',
          sailBonus: 0.1,
          attackNpcSyncId: null,
          returnFireSyncId: null,
          fireCooldown: 0,
          aggro: false
        };
        newbie.speed = npcMaxForwardSpeed(newbie) * 0.52;
        npcs.push(newbie);
      }
    });
  }
  for (let j = npcs.length - 1; j >= 0; j--) {
    const n = npcs[j];
    if (!n.isStoryBounty) continue;
    if (!active.has(n.syncId)) npcs.splice(j, 1);
  }
}

function huntSyncIdForQuest(pid, qidx, target) {
  const t = String(target || '').split('').reduce((a, c) => ((a * 31 + c.charCodeAt(0)) >>> 0), 7);
  return HUNT_MARK_SYNC_MIN + ((Math.floor(Number(pid) || 1) % 900) * 20 + (qidx % 20) + (t % 80)) % (HUNT_MARK_SYNC_MAX - HUNT_MARK_SYNC_MIN);
}

function syncQuestContractNpcs(npcs, playerQuests, ctx, players) {
  const wantHunt = new Set();
  if (playerQuests && typeof playerQuests.forEach === 'function') {
  playerQuests.forEach((quests, pid) => {
    if (!Array.isArray(quests)) return;
    for (let qi = 0; qi < quests.length; qi++) {
      const q = quests[qi];
      if (!q || !q.accepted || q.type !== 'hunt') continue;
      const tgt = String(q.target || '').trim();
      if (!tgt) continue;
      const sid = q.huntTargetSyncId != null && Number.isFinite(Number(q.huntTargetSyncId))
        ? Math.floor(Number(q.huntTargetSyncId))
        : huntSyncIdForQuest(pid, qi, tgt);
      wantHunt.add(sid);
      let placed = npcs.find(n => n.syncId === sid && !n.sinking && (n.health == null || n.health > 0));
      if (placed) continue;
      const player = players.get(pid);
      const px = player && Number.isFinite(Number(player.x)) ? Number(player.x) : 0;
      const pz = player && Number.isFinite(Number(player.z)) ? Number(player.z) : 0;
      const typePool = ['cutter', 'sloop', 'brigantine', 'galleon'];
      const npcType = typePool[Math.floor(Math.random() * typePool.length)];
      let nx = px;
      let nz = pz;
      let ok = false;
      for (let attempt = 0; attempt < 55; attempt++) {
        const a = Math.random() * Math.PI * 2;
        const d = 160 + Math.random() * 380 + (attempt % 12) * 8;
        nx = Math.max(-ctx.edgeClamp, Math.min(ctx.edgeClamp, px + Math.cos(a) * d));
        nz = Math.max(-ctx.edgeClamp, Math.min(ctx.edgeClamp, pz + Math.sin(a) * d));
        if (!ctx.dryLandAtWorldPosition(nx, nz) && ctx.hasMinClearanceFromLand(nx, nz, 80)) {
          ok = true;
          break;
        }
      }
      if (!ok) {
        const sr = () => Math.random();
        const pt = sampleOpenOceanPointInWorld(sr, (x, z) => ctx.dryLandAtWorldPosition(x, z), ctx.edgeClamp, (wx, wz, c) => ctx.hasMinClearanceFromLand(wx, wz, c));
        nx = pt.nx;
        nz = pt.nz;
      }
      const chunkX = Math.floor(nx / ctx.CHUNK_SIZE);
      const chunkZ = Math.floor(nz / ctx.CHUNK_SIZE);
      const pirateFaction = (q.huntTargetFaction != null && Number.isFinite(Number(q.huntTargetFaction)))
        ? (q.huntTargetFaction | 0) % FACTION_COUNT
        : ((chunkX * 31 + chunkZ * 17) & 0x7fffffff) % FACTION_COUNT;
      npcs.push({
        syncId: sid,
        x: nx,
        z: nz,
        rotation: Math.random() * Math.PI * 2,
        speed: 0,
        health: 58 + Math.random() * 36,
        type: npcType,
        name: tgt,
        wanderAngle: Math.random() * Math.PI * 2,
        wanderTimer: 6,
        underFireTimer: 0,
        riggingHealth: 100,
        flagPosition: 'mast',
        isHuntContract: true,
        factionId: pirateFaction,
        flagColor: FACTION_TRADE_COLORS[pirateFaction],
        flagAssetId: randomChoosableFlagRng(Math.random),
        sailBonus: 0.1,
        attackNpcSyncId: null,
        returnFireSyncId: null,
        fireCooldown: 0,
        aggro: false
      });
      const last = npcs[npcs.length - 1];
      last.speed = npcMaxForwardSpeed(last) * (0.48 + Math.random() * 0.18);
    }
  });
  }
  for (let j = npcs.length - 1; j >= 0; j--) {
    const n = npcs[j];
    if (!n.isHuntContract) continue;
    if (!wantHunt.has(n.syncId)) npcs.splice(j, 1);
  }
}

function buildSyncRows(npcs, portController, ws) {
  return npcs
    .filter(n => {
      const h = n.health != null && Number.isFinite(Number(n.health)) ? Number(n.health) : 0;
      if (n.sinking) return true;
      return h > -900;
    })
    .map(n => {
      const ffi = n.isTradeShip
        ? ((n.homeFaction != null ? n.homeFaction : townFaction({ cx: n.homeCx, cz: n.homeCz, hasTown: true }, portController, ws)) | 0) % FACTION_COUNT
        : ((n.factionId | 0) % FACTION_COUNT);
      let atk = null;
      if (n.isTradeShip) {
        if (n.returnFireSyncId != null && Number.isFinite(Number(n.returnFireSyncId))) atk = Number(n.returnFireSyncId);
      } else {
        if (n.returnFireSyncId != null && Number.isFinite(Number(n.returnFireSyncId))) atk = Number(n.returnFireSyncId);
        else if (n.attackNpcSyncId != null && Number.isFinite(Number(n.attackNpcSyncId))) atk = Number(n.attackNpcSyncId);
      }
      const row = {
        id: n.syncId,
        x: Math.round(n.x * 20) / 20,
        z: Math.round(n.z * 20) / 20,
        r: Math.round(n.rotation * 1000) / 1000,
        h: Math.round(n.health != null && Number.isFinite(Number(n.health)) ? Number(n.health) : 0),
        rg: Math.round(getNpcRiggingHealth(n)),
        aggro: !!n.aggro,
        sinking: !!n.sinking,
        t: n.type,
        n: n.name,
        fc: n.flagColor,
        fa: n.flagAssetId != null ? n.flagAssetId : undefined,
        mer: !!n.isTradeShip,
        pat: !!(n.isFactionPatrol && !n.isTradeShip),
        ffi,
        sp: Math.round((n.speed || 0) * 100) / 100,
        atk: atk != null ? atk : null
      };
      if (n.missionOwnerPlayerId != null && Number.isFinite(Number(n.missionOwnerPlayerId))) {
        row.mo = Math.floor(Number(n.missionOwnerPlayerId));
      }
      if (n.flagPosition === 'mast' || n.flagPosition === 'side' || n.flagPosition === 'stern') {
        row.flag = n.flagPosition;
      }
      if (n.isTradeShip) {
        row.hcx = n.homeCx | 0;
        row.hcz = n.homeCz | 0;
        if (n.homeDockX != null) row.hdx = Math.round(n.homeDockX * 10) / 10;
        if (n.homeDockZ != null) row.hdz = Math.round(n.homeDockZ * 10) / 10;
      }
      return row;
    });
}

/** Authoritative hull/rig damage from a player cannon hit (matches client `applyAuthorizedNpcDamageFromPlayerShot` tiers). */
function applyPlayerCannonHitAuthoritative(npcs, fromPlayerId, npcSyncId, ammoType, isPellet, players) {
  const pid = Math.floor(Number(fromPlayerId));
  const sid = Math.floor(Number(npcSyncId));
  const out = { ok: false, popup: null, award: null };
  if (!Number.isFinite(pid) || !Number.isFinite(sid) || !(players instanceof Map)) return out;
  const pl = players.get(pid);
  if (!pl || pl.docked) return out;
  const px = Number(pl.x);
  const pz = Number(pl.z);
  if (!Number.isFinite(px) || !Number.isFinite(pz)) return out;
  const idx = npcs.findIndex(n => n.syncId === sid);
  if (idx < 0) return out;
  const npc = npcs[idx];
  if (!npc || npc.sinking) return out;
  const h0 = npc.health != null && Number.isFinite(Number(npc.health)) ? Number(npc.health) : 72;
  if (h0 <= 0) return out;
  const d = Math.hypot(px - npc.x, pz - npc.z);
  if (d > 260) return out;
  const at = ammoType === 'chain' ? 'chain' : ammoType === 'grape' || ammoType === 'grape_pellet' ? 'grape' : 'ball';
  let dh = 15;
  if (isPellet) dh = 4 + Math.floor(Math.random() * 3);
  else if (at === 'grape') dh = 10;
  else if (at === 'chain') dh = 8;
  npc.health = h0 - dh;
  npc.aggro = true;
  npc.underFireTimer = Math.max(npc.underFireTimer || 0, 14);
  const hullAfter = Math.max(0, Math.round(npc.health));
  const popName = npc.name || 'ship';
  let popMsg = `−${dh} hull`;
  if (at === 'chain') popMsg = `Chain · −${dh} hull · sails`;
  else if (at === 'grape') popMsg = isPellet ? `Grape · −${dh}` : `Grapeshot · −${dh}`;
  else if (at === 'ball') popMsg = `Round shot · −${dh}`;
  const cssClass = at === 'chain' ? 'chain' : at === 'grape' ? 'grape' : '';
  out.popup = {
    wx: npc.x,
    wz: npc.z,
    wy: null,
    text: `${popName}: ${popMsg} (${hullAfter} HP)`,
    cssClass,
    life: 2.1
  };
  if (at === 'chain') {
    const rigBefore = getNpcRiggingHealth(npc);
    npc.riggingHealth = Math.max(0, rigBefore - (30 + Math.random() * 14));
  }
  if (npc.health <= 0) {
    const victimName = popName;
    const missionOwner = npc.missionOwnerPlayerId != null ? Math.floor(Number(npc.missionOwnerPlayerId)) : null;
    const storyMission = !!(npc.isStoryBounty && missionOwner != null && Number.isFinite(missionOwner));
    let storyOutcome = 'none';
    if (storyMission) {
      const op = players.get(missionOwner);
      const ox = op && Number(op.x);
      const oz = op && Number(op.z);
      const ownerNear = Number.isFinite(ox) && Number.isFinite(oz) && Math.hypot(npc.x - ox, npc.z - oz) <= 118;
      storyOutcome = ownerNear ? 'complete' : 'reroll';
    }
    const goldLoot = storyMission ? 0 : 30;
    const sinksAi = !storyMission && pid != null ? 1 : 0;
    out.award = {
      killerId: pid,
      gold: goldLoot,
      sinksAi,
      huntNpcName: '',
      victimName,
      storyOwnerId: storyMission ? missionOwner : null,
      storyOutcome
    };
    /* Let clients run the same sink animation as solo/host; remove from sim after ~4s (see step()). */
    npc.health = 0;
    npc.speed = 0;
    npc.sinking = true;
    npc.sinkTimer = 0;
  }
  out.ok = true;
  return out;
}

/** Remove an NPC after a boarding scuttle / prize sink (validated vs. player position). */
function applyBoardingScuttleAuthoritative(npcs, fromPlayerId, npcSyncId, players) {
  const pid = Math.floor(Number(fromPlayerId));
  const sid = Math.floor(Number(npcSyncId));
  const out = { ok: false, award: null };
  if (!Number.isFinite(pid) || !Number.isFinite(sid) || !(players instanceof Map)) return out;
  const pl = players.get(pid);
  if (!pl || pl.docked) return out;
  const px = Number(pl.x);
  const pz = Number(pl.z);
  if (!Number.isFinite(px) || !Number.isFinite(pz)) return out;
  const idx = npcs.findIndex(n => n.syncId === sid);
  if (idx < 0) return out;
  const npc = npcs[idx];
  if (!npc || npc.sinking) return out;
  const d = Math.hypot(px - npc.x, pz - npc.z);
  if (d > 260) return out;
  const victimName = npc.name || 'ship';
  const missionOwner = npc.missionOwnerPlayerId != null ? Math.floor(Number(npc.missionOwnerPlayerId)) : null;
  const storyMission = !!(npc.isStoryBounty && missionOwner != null && Number.isFinite(missionOwner));
  let storyOutcome = 'none';
  if (storyMission) {
    const op = players.get(missionOwner);
    const ox = op && Number(op.x);
    const oz = op && Number(op.z);
    const ownerNear = Number.isFinite(ox) && Number.isFinite(oz) && Math.hypot(npc.x - ox, npc.z - oz) <= 118;
    storyOutcome = ownerNear ? 'complete' : 'reroll';
  }
  const goldLoot = storyMission ? 0 : 30;
  const sinksAi = !storyMission ? 1 : 0;
  out.award = {
    killerId: pid,
    gold: goldLoot,
    sinksAi,
    huntNpcName: '',
    victimName,
    storyOwnerId: storyMission ? missionOwner : null,
    storyOutcome
  };
  npcs.splice(idx, 1);
  out.ok = true;
  return out;
}

function createServerNpcWorld(opts) {
  const windAt = opts.windAt;
  const getPlayerStanding = typeof opts.getPlayerStanding === 'function' ? opts.getPlayerStanding : null;
  const baseEdgeClamp = opts.edgeClamp != null ? opts.edgeClamp : 2025;
  let ws = (opts.worldSeed >>> 0) || 42;
  let worldMapPayloadRef = opts.worldMapPayload && typeof opts.worldMapPayload === 'object' ? opts.worldMapPayload : null;
  let politics =
    opts.politicsRef && opts.politicsRef.matrix && opts.politicsRef.portController
      ? opts.politicsRef
      : { matrix: makePoliticsMatrix(ws), portController: Object.create(null), factionWealth: [1400, 1400, 1400, 1400, 1400] };
  let ctx = createTerrainContext({ worldSeed: ws, edgeClamp: baseEdgeClamp, worldMapPayload: worldMapPayloadRef });
  let dryLand = (x, z) => ctx.dryLandAtWorldPosition(x, z);
  let edgeClamp = ctx.edgeClamp;
  let npcs = [];
  let pirateSlotCount = 0;
  const pirateRespawnAt = new Map();
  let nextPatrolId = PATROL_SYNC_MIN;
  let broadcastAll = typeof opts.broadcastAll === 'function' ? opts.broadcastAll : () => {};

  function setBroadcastAll(fn) {
    broadcastAll = fn;
  }

  function setWorldMapPayload(payload) {
    worldMapPayloadRef = payload && typeof payload === 'object' ? payload : null;
    ctx = createTerrainContext({ worldSeed: ws, edgeClamp: baseEdgeClamp, worldMapPayload: worldMapPayloadRef });
    dryLand = (x, z) => ctx.dryLandAtWorldPosition(x, z);
    edgeClamp = ctx.edgeClamp;
  }

  function setWorldSeed(newSeed) {
    ws = (Number(newSeed) >>> 0) || 42;
    ctx = createTerrainContext({ worldSeed: ws, edgeClamp: baseEdgeClamp, worldMapPayload: worldMapPayloadRef });
    dryLand = (x, z) => ctx.dryLandAtWorldPosition(x, z);
    edgeClamp = ctx.edgeClamp;
    if (!opts.politicsRef || !opts.politicsRef.matrix) {
      politics = { matrix: makePoliticsMatrix(ws), portController: Object.create(null), factionWealth: [1400, 1400, 1400, 1400, 1400] };
    }
  }

  function collectAllPorts() {
    return ctx.collectAllTradingPorts();
  }

  function tryAddMerchant(home, allPorts, tradeSyncIdx, seedSalt, playerMap) {
    const tBase = (ws * 31 + 22411) >>> 0;
    let s = (tBase + (seedSalt | 0) + Math.imul(home.cx * 7919 + home.cz * 9341, 2654435761)) >>> 0;
    const sr = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const dest = pickTradeDestination(home, allPorts, sr, ws, politics.portController);
    if (!dest) return false;
    const shipTypes = ['cutter', 'sloop', 'brigantine', 'galleon'];
    const st = shipTypes[Math.floor(sr() * shipTypes.length)];
    let nx = 0;
    let nz = 0;
    let haveSpawn = false;
    for (let trySp = 0; trySp < 22; trySp++) {
      const spawn = findMerchantSpawnOffCoast(home, sr, st, dryLand, edgeClamp);
      if (!spawn) break;
      nx = spawn.nx;
      nz = spawn.nz;
      if (isSpawnFree(nx, nz, st, npcs, playerMap, dryLand, edgeClamp)) {
        haveSpawn = true;
        break;
      }
    }
    if (!haveSpawn) return false;
    const sailPick = sr() > 0.55 ? 'silk' : 'basic';
    const cannonPart = tradeShipCannonForType(st);
    const homeFac = townFaction(home, politics.portController, ws) % FACTION_COUNT;
    const npc = {
      syncId: TRADE_NPC_SYNC_START + tradeSyncIdx,
      x: nx,
      z: nz,
      rotation: 0,
      speed: 0,
      health: 48 + sr() * 42,
      type: st,
      tradeCannon: cannonPart,
      name: '',
      homeFaction: homeFac,
      flagColor: FACTION_TRADE_COLORS[homeFac],
      flagAssetId: factionFlagPngIdForFaction(homeFac),
      isTradeShip: true,
      aggro: false,
      homeDockX: home.dockX,
      homeDockZ: home.dockZ,
      homeCx: home.cx,
      homeCz: home.cz,
      sailPick,
      sailBonus: sailPick === 'silk' ? 0.3 : 0,
      wanderAngle: 0,
      wanderTimer: 99,
      underFireTimer: 0,
      riggingHealth: 100,
      fireCooldown: 0,
      tradePhase: 'loading_home',
      tradeTimer: 6 + sr() * 14
    };
    assignTradeRouteFromHome(npc, home, allPorts, sr, ws, politics.portController);
    npc.homeEmbarkX = nx;
    npc.homeEmbarkZ = nz;
    npc.rotation = Math.atan2((npc.tradeDestX || nx) - nx, (npc.tradeDestZ || nz) - nz);
    npcs.push(npc);
    return true;
  }

  function spawnPatrol(fid, playerMap) {
    const allPorts = collectAllPorts().filter(p => townFaction(p, politics.portController, ws) % FACTION_COUNT === fid);
    if (!allPorts.length) return false;
    if (nextPatrolId > PATROL_SYNC_MAX) return false;
    const tBase = (ws ^ Math.imul(fid, 977)) >>> 0;
    const pick = allPorts[(tBase + npcs.length * 13) % allPorts.length];
    let s = (tBase + Math.imul(pick.cx * 7919 + pick.cz * 9341, 2654435761)) >>> 0;
    const sr = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const pid = nextPatrolId++;
    const typePool = ['brigantine', 'warship', 'galleon'];
    const st = typePool[Math.floor(sr() * typePool.length)];
    let nx = 0;
    let nz = 0;
    let haveSpawn = false;
    for (let trySp = 0; trySp < 26; trySp++) {
      const spawn = findMerchantSpawnOffCoast(pick, sr, st, dryLand, edgeClamp);
      if (!spawn) break;
      nx = spawn.nx;
      nz = spawn.nz;
      if (isSpawnFree(nx, nz, st, npcs, playerMap, dryLand, edgeClamp)) {
        haveSpawn = true;
        break;
      }
    }
    if (!haveSpawn) return false;
    const patrolName = proceduralFactionPatrolShipName(fid, pick.cx | 0, pick.cz | 0, pid, ws);
    const npc = {
      syncId: pid,
      x: nx,
      z: nz,
      rotation: sr() * Math.PI * 2,
      speed: 0,
      health: 72 + sr() * 48,
      type: st,
      name: patrolName,
      factionId: fid,
      isFactionPatrol: true,
      patrolCannon: tradeShipCannonForType(st),
      flagColor: FACTION_TRADE_COLORS[fid],
      flagAssetId: factionFlagPngIdForFaction(fid),
      sailBonus: 0.12,
      wanderAngle: sr() * Math.PI * 2,
      wanderTimer: 4 + sr() * 8,
      underFireTimer: 0,
      riggingHealth: 100,
      attackNpcSyncId: null,
      returnFireSyncId: null,
      fireCooldown: 0,
      aggro: false
    };
    npc.speed = npcMaxForwardSpeed(npc) * (0.52 + sr() * 0.24);
    npcs.push(npc);
    return true;
  }

  function isVanillaReplenishablePirateShip(n) {
    if (!n || n.isTradeShip || n.isFactionPatrol || n.isStoryBounty || n.isHuntContract) return false;
    const sid = n.syncId | 0;
    return pirateSlotCount > 0 && sid >= 0 && sid < pirateSlotCount && sid < 46;
  }

  function spawnVanillaPirateAtSlotIndex(i, playerMap) {
    if (i < 0 || i >= pirateSlotCount) return;
    if (npcs.some(n => (n.syncId | 0) === i)) return;
    const npcSeed = (ws | 0) * 7 + 13;
    const typePool = ['cutter', 'sloop', 'brigantine', 'galleon', 'warship'];
    let s = npcSeed + i * 997;
    const sr = () => {
      s = ((s * 16807) % 2147483647 + 2147483647) % 2147483647;
      return s / 2147483647;
    };
    const npcType = typePool[Math.floor(sr() * 5)];
    let nx = 0;
    let nz = 0;
    let placed = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      const pt = sampleOpenOceanPointInWorld(sr, dryLand, edgeClamp, (wx, wz, c) => ctx.hasMinClearanceFromLand(wx, wz, c));
      nx = pt.nx;
      nz = pt.nz;
      if (isSpawnFree(nx, nz, npcType, npcs, playerMap, dryLand, edgeClamp)) {
        placed = true;
        break;
      }
    }
    if (!placed) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const pt = sampleOpenOceanPointInWorld(sr, dryLand, edgeClamp, (wx, wz, c) => ctx.hasMinClearanceFromLand(wx, wz, c));
        nx = pt.nx;
        nz = pt.nz;
        if (isSpawnFree(nx, nz, npcType, npcs, playerMap, dryLand, edgeClamp)) {
          placed = true;
          break;
        }
      }
    }
    if (!placed) return;
    const chunkX = Math.floor(nx / ctx.CHUNK_SIZE);
    const chunkZ = Math.floor(nz / ctx.CHUNK_SIZE);
    const pirateFaction = ((chunkX * 31 + chunkZ * 17 + npcSeed * 3 + i * 13) & 0x7fffffff) % FACTION_COUNT;
    npcs.push({
      syncId: i,
      x: nx,
      z: nz,
      rotation: sr() * Math.PI * 2,
      speed: 0,
      health: 60 + sr() * 40,
      type: npcType,
      name: proceduralPirateShipName(pirateFaction, chunkX, chunkZ, i, ws),
      wanderAngle: sr() * Math.PI * 2,
      wanderTimer: 5 + sr() * 10,
      underFireTimer: 0,
      riggingHealth: 100,
      factionId: pirateFaction,
      flagColor: FACTION_TRADE_COLORS[pirateFaction],
      flagAssetId: randomChoosableFlagRng(sr),
      sailBonus: 0.1,
      attackNpcSyncId: null,
      returnFireSyncId: null,
      fireCooldown: 0,
      aggro: false
    });
    const last = npcs[npcs.length - 1];
    last.speed = npcMaxForwardSpeed(last) * (0.56 + sr() * 0.22);
  }

  function reset(players) {
    npcs = [];
    nextPatrolId = PATROL_SYNC_MIN;
    const playerMap = players instanceof Map ? players : new Map();
    const npcSeed = (ws | 0) * 7 + 13;
    const typePool = ['cutter', 'sloop', 'brigantine', 'galleon', 'warship'];
    const portCount = collectAllPorts().length;
    const nPirates = Math.min(46, 10 + Math.floor(portCount * 0.48));
    pirateSlotCount = nPirates;
    pirateRespawnAt.clear();
    for (let i = 0; i < nPirates; i++) {
      let s = npcSeed + i * 997;
      const sr = () => {
        s = ((s * 16807) % 2147483647 + 2147483647) % 2147483647;
        return s / 2147483647;
      };
      const npcType = typePool[Math.floor(sr() * 5)];
      let nx = 0;
      let nz = 0;
      let placed = false;
      for (let attempt = 0; attempt < 90; attempt++) {
        const pt = sampleOpenOceanPointInWorld(sr, dryLand, edgeClamp, (wx, wz, c) => ctx.hasMinClearanceFromLand(wx, wz, c));
        nx = pt.nx;
        nz = pt.nz;
        if (isSpawnFree(nx, nz, npcType, npcs, playerMap, dryLand, edgeClamp)) {
          placed = true;
          break;
        }
      }
      if (!placed) continue;
      const chunkX = Math.floor(nx / ctx.CHUNK_SIZE);
      const chunkZ = Math.floor(nz / ctx.CHUNK_SIZE);
      const pirateFaction = ((chunkX * 31 + chunkZ * 17 + npcSeed * 3 + i * 13) & 0x7fffffff) % FACTION_COUNT;
      npcs.push({
        syncId: i,
        x: nx,
        z: nz,
        rotation: sr() * Math.PI * 2,
        speed: 0,
        health: 60 + sr() * 40,
        type: npcType,
        name: proceduralPirateShipName(pirateFaction, chunkX, chunkZ, i, ws),
        wanderAngle: sr() * Math.PI * 2,
        wanderTimer: 5 + sr() * 10,
        underFireTimer: 0,
        riggingHealth: 100,
        factionId: pirateFaction,
        flagColor: FACTION_TRADE_COLORS[pirateFaction],
        flagAssetId: randomChoosableFlagRng(sr),
        sailBonus: 0.1,
        attackNpcSyncId: null,
        returnFireSyncId: null,
        fireCooldown: 0,
        aggro: false
      });
      const last = npcs[npcs.length - 1];
      last.speed = npcMaxForwardSpeed(last) * (0.56 + sr() * 0.22);
    }
    const allPorts = collectAllPorts();
    if (allPorts.length >= 2) {
      const portsSorted = allPorts.slice().sort((a, b) => a.cx - b.cx || a.cz - b.cz);
      const order = portsSorted.map((_, i) => i);
      let shuf = (ws ^ 0x9e3779b9) >>> 0;
      for (let ii = order.length - 1; ii > 0; ii--) {
        shuf = (Math.imul(shuf, 1664525) + 1013904223) >>> 0;
        const jj = shuf % (ii + 1);
        const tmp = order[ii];
        order[ii] = order[jj];
        order[jj] = tmp;
      }
      let tradeSyncIdx = 0;
      for (let pi = 0; pi < order.length; pi++) {
        const home = portsSorted[order[pi]];
        if (tryAddMerchant(home, allPorts, tradeSyncIdx, pi * 997, playerMap)) tradeSyncIdx++;
      }
      const extraMerchants = Math.min(40, Math.max(0, Math.floor(allPorts.length * 0.45)));
      const tBase = (ws * 31 + 22411) >>> 0;
      for (let ex = 0; ex < extraMerchants; ex++) {
        const home = allPorts[(tBase + ex * 31337) % allPorts.length];
        if (tryAddMerchant(home, allPorts, tradeSyncIdx, 800000 + ex * 131, playerMap)) tradeSyncIdx++;
      }
    }
    for (let f = 0; f < FACTION_COUNT; f++) {
      const wealth = politics.factionWealth[f] | 0;
      let wars = 0;
      for (let j = 0; j < FACTION_COUNT; j++) {
        if (j !== f && factionsConsideredAtWar(f, j, politics.matrix)) wars++;
      }
      const n = Math.min(7, 1 + Math.floor(wealth / 620) + wars);
      for (let k = 0; k < n; k++) spawnPatrol(f, playerMap);
    }
  }

  function updateHuntAi(npc, isPatrol, players) {
    if (npc.isTradeShip || npc.sinking) return;
    npc._huntAcc = (npc._huntAcc || 0) + 0.022;
    if (npc._huntAcc < 0.65) return;
    npc._huntAcc = 0;
    const myF = (npc.factionId | 0) % FACTION_COUNT;
    const near = nearestCaptain(npc.x, npc.z, players);
    if (near && near.d < 95 && npc.aggro) return;
    if (npc.attackNpcSyncId != null) {
      const prey = npcs.find(n => n.syncId === npc.attackNpcSyncId && !n.sinking && (n.health == null || n.health > 0));
      if (prey && Math.hypot(prey.x - npc.x, prey.z - npc.z) < 620) return;
      npc.attackNpcSyncId = null;
    }
    const huntRoll = Math.random();
    let bestId = null;
    let bestScore = -1e9;
    for (const m of npcs) {
      if (m === npc || m.sinking || (m.health != null && m.health <= 0)) continue;
      const d = Math.hypot(m.x - npc.x, m.z - npc.z);
      if (d > 540) continue;
      if (m.isTradeShip) {
        const mf = townFaction({ cx: m.homeCx, cz: m.homeCz, hasTown: true }, politics.portController, ws) % FACTION_COUNT;
        if (isPatrol) {
          if (!factionsConsideredAtWar(myF, mf, politics.matrix)) continue;
          const score = 1300 - d;
          if (score > bestScore) {
            bestScore = score;
            bestId = m.syncId;
          }
        } else {
          const war = factionsConsideredAtWar(myF, mf, politics.matrix);
          if (!war && huntRoll > 0.072) continue;
          const score = (war ? 1200 : 140) - d;
          if (score > bestScore) {
            bestScore = score;
            bestId = m.syncId;
          }
        }
      } else if (!m.isFactionPatrol && m.factionId != null && !m.isTradeShip) {
        const of = (m.factionId | 0) % FACTION_COUNT;
        if (of === myF) continue;
        if (!factionsConsideredAtWar(myF, of, politics.matrix) && huntRoll > 0.045) continue;
        const score = 900 - d;
        if (score > bestScore) {
          bestScore = score;
          bestId = m.syncId;
        }
      } else if (m.isFactionPatrol && isPatrol) {
        const of = (m.factionId | 0) % FACTION_COUNT;
        if (of === myF) continue;
        if (!factionsConsideredAtWar(myF, of, politics.matrix) && huntRoll > 0.07) continue;
        const score = 950 - d;
        if (score > bestScore) {
          bestScore = score;
          bestId = m.syncId;
        }
      }
    }
    if (bestId != null) npc.attackNpcSyncId = bestId;
  }

  function hostileStandingToFaction(playerId, factionIdx) {
    if (getPlayerStanding == null || playerId == null) return false;
    const st = getPlayerStanding(Math.floor(Number(playerId)));
    if (!st || !Array.isArray(st.relations)) return false;
    const f = (factionIdx | 0) % FACTION_COUNT;
    const r = Number(st.relations[f]);
    return Number.isFinite(r) && r <= COMBAT_HOSTILE_STANDING;
  }

  function updateMerchantThreat(npc) {
    if (!npc.isTradeShip || npc.sinking) return;
    npc._merThreatAcc = (npc._merThreatAcc || 0) + 0.022;
    if (npc._merThreatAcc < 0.38) return;
    npc._merThreatAcc = 0;
    if (npc.returnFireSyncId != null) return;
    const mf = townFaction({ cx: npc.homeCx, cz: npc.homeCz, hasTown: true }, politics.portController, ws) % FACTION_COUNT;
    for (const p of npcs) {
      if (!p || p === npc || p.sinking || p.isTradeShip) continue;
      if (p.attackNpcSyncId === npc.syncId) {
        npc.returnFireSyncId = p.syncId;
        npc.underFireTimer = Math.max(npc.underFireTimer || 0, 4.5);
        return;
      }
      const d = Math.hypot(p.x - npc.x, p.z - npc.z);
      if (d > 85) continue;
      const pf = p.factionId != null ? (p.factionId | 0) % FACTION_COUNT : -1;
      if (pf >= 0 && factionsConsideredAtWar(mf, pf, politics.matrix)) {
        npc.returnFireSyncId = p.syncId;
        npc.underFireTimer = Math.max(npc.underFireTimer || 0, 4.2);
        return;
      }
    }
  }

  function stepMerchant(npc, dt, players) {
    if (!npc.fireCooldown) npc.fireCooldown = 0;
    npc.fireCooldown -= dt;
    if (npc.underFireTimer > 0) npc.underFireTimer -= dt;
    updateMerchantThreat(npc);
    let atkShip = npc.returnFireSyncId != null ? npcs.find(n => n.syncId === npc.returnFireSyncId && !n.sinking && (n.health == null || n.health > 0)) : null;
    if (atkShip) {
      const da = Math.hypot(atkShip.x - npc.x, atkShip.z - npc.z);
      if (da > 205 && npc.underFireTimer <= 0) {
        npc.returnFireSyncId = null;
        atkShip = null;
      }
    }
    const near = nearestCaptain(npc.x, npc.z, players);
    const distToPlayer = near ? near.d : 1e9;
    const mPfid = (townFaction({ cx: npc.homeCx, cz: npc.homeCz, hasTown: true }, politics.portController, ws) | 0) % FACTION_COUNT;
    const pid = near && near.p && near.p.id != null ? Math.floor(Number(near.p.id)) : null;
    let provoked = false;
    if (near && pid != null) {
      if (distToPlayer < 142 && hostileStandingToFaction(pid, mPfid)) provoked = true;
      else if (distToPlayer < 148 && npc.underFireTimer != null && npc.underFireTimer > 0.05) provoked = true;
    }
    if (!npc.aggro && provoked) {
      npc.aggro = true;
      npc.underFireTimer = Math.max(npc.underFireTimer || 0, 3.6);
    }
    if (npc.aggro && (distToPlayer > 210 || (npc.underFireTimer <= 0 && distToPlayer > 125))) npc.aggro = false;
    const fighting = npc.aggro && distToPlayer < 135;
    const fightingNpc = !!atkShip && Math.hypot(atkShip.x - npc.x, atkShip.z - npc.z) < 128;
    const tgtC = npc.targetCruise != null ? npc.targetCruise : npcMaxForwardSpeed(npc) * 0.92;
    if (fightingNpc) {
      const sharp = Math.hypot(atkShip.x - npc.x, atkShip.z - npc.z) < 92 ? 2.55 : 2.12;
      if (!npc.escapeMode) {
        const dx = atkShip.x - npc.x;
        const dz = atkShip.z - npc.z;
        const toT = Math.atan2(dx, dz);
        const starboardBroadside = toT + Math.PI / 2;
        const portBroadside = toT - Math.PI / 2;
        const dStar = Math.abs(((starboardBroadside - npc.rotation + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        const dPort = Math.abs(((portBroadside - npc.rotation + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        const targetAngle = dStar < dPort ? starboardBroadside : portBroadside;
        let diff = targetAngle - npc.rotation;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        npc.rotation += diff * (npc.underFireTimer > 0 ? 1.85 : 1.32) * dt * npcSailingTurnFactor(npc, windAt);
        const distAtk = Math.hypot(atkShip.x - npc.x, atkShip.z - npc.z);
        if (npc.fireCooldown <= 0 && distAtk < 74) {
          const tvx = Math.sin(atkShip.rotation) * (atkShip.speed || 0);
          const tvz = Math.cos(atkShip.rotation) * (atkShip.speed || 0);
          emitBroadside(broadcastAll, npc, atkShip.x, atkShip.z, tvx, tvz);
          npc.fireCooldown = PLAYER_BROADSIDE_COOLDOWN;
        }
      }
      steerNpcClearanceAhead(npc, dt, sharp, windAt, dryLand);
      nudgeNpcOffIsland(npc, dryLand, edgeClamp);
      const maxF = npcMaxForwardSpeed(npc);
      const distAtk = Math.hypot(atkShip.x - npc.x, atkShip.z - npc.z);
      const tgtSpd = npc.underFireTimer > 0 && distAtk < 95 ? maxF * 0.38 : maxF * 0.62;
      accelerateNpcToward(npc, dt, tgtSpd);
      applyNpcMoveWithIslandEscape(npc, dt, sharp, windAt, dryLand, edgeClamp);
    } else if (fighting && near) {
      const sharp = distToPlayer < 110 ? 2.55 : 2.05;
      if (!npc.escapeMode) {
        const dx = near.p.x - npc.x;
        const dz = near.p.z - npc.z;
        const toPlayer = Math.atan2(dx, dz);
        const starboardBroadside = toPlayer + Math.PI / 2;
        const portBroadside = toPlayer - Math.PI / 2;
        const dStar = Math.abs(((starboardBroadside - npc.rotation + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        const dPort = Math.abs(((portBroadside - npc.rotation + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        const targetAngle = dStar < dPort ? starboardBroadside : portBroadside;
        let diff = targetAngle - npc.rotation;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        npc.rotation += diff * (npc.underFireTimer > 0 ? 1.95 : 1.35) * dt * npcSailingTurnFactor(npc, windAt);
        if (npc.fireCooldown <= 0 && distToPlayer < 72) {
          const pvx = Math.sin(near.p.rotation || 0) * (near.p.speed || 0);
          const pvz = Math.cos(near.p.rotation || 0) * (near.p.speed || 0);
          emitBroadside(broadcastAll, npc, near.p.x, near.p.z, pvx, pvz);
          npc.fireCooldown = PLAYER_BROADSIDE_COOLDOWN;
        }
      }
      steerNpcClearanceAhead(npc, dt, sharp, windAt, dryLand);
      nudgeNpcOffIsland(npc, dryLand, edgeClamp);
      const maxF = npcMaxForwardSpeed(npc);
      const tgtSpd = npc.underFireTimer > 0 && distToPlayer < 92 ? maxF * 0.32 : maxF * 0.58;
      accelerateNpcToward(npc, dt, tgtSpd);
      applyNpcMoveWithIslandEscape(npc, dt, sharp, windAt, dryLand, edgeClamp);
    } else {
      const phase = npc.tradePhase || 'to_dest';
      const dockTx = npc.tradeDestX;
      const dockTz = npc.tradeDestZ;
      let tx = dockTx;
      let tz = dockTz;
      if ((phase === 'to_dest' || phase === 'to_home') && dockTx != null && dockTz != null) {
        const pcx = phase === 'to_dest' ? (npc.destCx | 0) : (npc.homeCx | 0);
        const pcz = phase === 'to_dest' ? (npc.destCz | 0) : (npc.homeCz | 0);
        const isl = ctx.getProceduralIslandMeta(pcx, pcz);
        if (isl && isl.hasTown && isl.worldX != null) {
          const dsx = dockTx - isl.worldX;
          const dsz = dockTz - isl.worldZ;
          const dlen = Math.hypot(dsx, dsz) || 1;
          const seaX = dsx / dlen;
          const seaZ = dsz / dlen;
          const vx = npc.x - dockTx;
          const vz = npc.z - dockTz;
          const vlen = Math.hypot(vx, vz) || 1;
          const dot = (vx / vlen) * seaX + (vz / vlen) * seaZ;
          if (dot < Math.cos((56 * Math.PI) / 180) && vlen >= 88) {
            const off = 165 + Math.min(130, vlen * 0.42);
            tx = dockTx + seaX * off;
            tz = dockTz + seaZ * off;
          }
        }
      }
      if (phase === 'loading_home') {
        npc.speed = 0;
        npc.tradeTimer -= dt;
        if (npc.homeEmbarkX != null && npc.homeEmbarkZ != null) {
          const hx = npc.homeEmbarkX;
          const hz = npc.homeEmbarkZ;
          npc.x += (hx - npc.x) * Math.min(1, 5 * dt);
          npc.z += (hz - npc.z) * Math.min(1, 5 * dt);
        }
        if (npc.tradeTimer <= 0) {
          npc.tradePhase = 'to_dest';
          npc.targetCruise = npcMaxForwardSpeed(npc) * (0.55 + Math.random() * 0.22);
        }
      } else if (phase === 'to_dest' || phase === 'to_home') {
        if (tx != null && tz != null && dockTx != null && dockTz != null) {
          const ddx = dockTx - npc.x;
          const ddz = dockTz - npc.z;
          const distDock = Math.hypot(ddx, ddz);
          if (distDock < TRADE_DOCK_DIST) {
            npc.tradePhase = phase === 'to_dest' ? 'dock_dest' : 'dock_home';
            npc.tradeTimer = 4.2;
            npc.speed = 0;
          } else {
            const dx = tx - npc.x;
            const dz = tz - npc.z;
            if (!npc.escapeMode) {
              const targetAngle = Math.atan2(dx, dz);
              let tdiff = targetAngle - npc.rotation;
              while (tdiff > Math.PI) tdiff -= Math.PI * 2;
              while (tdiff < -Math.PI) tdiff += Math.PI * 2;
              npc.rotation += tdiff * 0.62 * dt * npcSailingTurnFactor(npc, windAt);
            }
            accelerateNpcToward(npc, dt, tgtC);
          }
        }
      } else if (phase === 'dock_dest' || phase === 'dock_home') {
        npc.speed = 0;
        npc.tradeTimer -= dt;
        if (dockTx != null && dockTz != null) {
          const dx = dockTx - npc.x;
          const dz = dockTz - npc.z;
          const d = Math.hypot(dx, dz) || 0.01;
          const step = Math.min(10 * dt, d);
          npc.x += (dx / d) * step;
          npc.z += (dz / d) * step;
          npc.rotation = Math.atan2(dx, dz);
        }
        if (npc.tradeTimer <= 0) {
          if (phase === 'dock_dest') {
            npc.tradeDestX = npc.homeDockX;
            npc.tradeDestZ = npc.homeDockZ;
            npc.tradePhase = 'to_home';
            const homeM = ctx.getProceduralIslandMeta(npc.homeCx | 0, npc.homeCz | 0);
            if (homeM && homeM.hasTown) {
              npc.cargoGood = portExportsGood(homeM, ws);
              syncTradeShipName(npc, homeM, ws, politics.portController);
            }
          } else {
            const homeFull = ctx.getProceduralIslandMeta(npc.homeCx | 0, npc.homeCz | 0);
            const list = collectAllPorts();
            if (list.length >= 2 && homeFull) {
              assignTradeRouteFromHome(npc, homeFull, list, Math.random, ws, politics.portController);
              npc.homeEmbarkX = npc.x;
              npc.homeEmbarkZ = npc.z;
              npc.tradePhase = 'loading_home';
              npc.tradeTimer = 5 + Math.random() * 10;
              npc.speed = 0;
            }
          }
        }
      }
      if (phase === 'to_dest' || phase === 'to_home') steerNpcClearanceAhead(npc, dt, 2.45, windAt, dryLand);
      nudgeNpcOffIsland(npc, dryLand, edgeClamp);
      applyNpcMoveWithIslandEscape(npc, dt, 2.45, windAt, dryLand, edgeClamp);
    }
  }

  function stepCombatNpc(npc, dt, players, isPatrol) {
    if (!npc.fireCooldown) npc.fireCooldown = 0;
    npc.fireCooldown -= dt;
    if (npc.underFireTimer > 0) npc.underFireTimer -= dt;
    if (isPatrol) updateHuntAi(npc, true, players);
    else updateHuntAi(npc, false, players);
    let focus = null;
    if (npc.returnFireSyncId != null) {
      const retal = npcs.find(n => n.syncId === npc.returnFireSyncId && !n.sinking && (n.health == null || n.health > 0));
      if (retal) {
        const dr = Math.hypot(retal.x - npc.x, retal.z - npc.z);
        if (dr < 228 && (npc.underFireTimer > 0 || dr < 98)) focus = retal;
        else npc.returnFireSyncId = null;
      } else npc.returnFireSyncId = null;
    }
    if (!focus && npc.attackNpcSyncId != null) {
      focus = npcs.find(n => n.syncId === npc.attackNpcSyncId && !n.sinking && (n.health == null || n.health > 0));
      if (!focus) npc.attackNpcSyncId = null;
    }
    const near = nearestCaptain(npc.x, npc.z, players);
    const distToPlayer = near ? near.d : 1e9;
    const aimx = focus ? focus.x : near ? near.p.x : 0;
    const aimz = focus ? focus.z : near ? near.p.z : 0;
    const distToTarget = focus ? Math.hypot(focus.x - npc.x, focus.z - npc.z) : distToPlayer;
    const pirFid = (npc.factionId | 0) % FACTION_COUNT;
    const nid = near && near.p && near.p.id != null ? Math.floor(Number(near.p.id)) : null;
    if (!focus && near && nid != null && distToPlayer < 118
      && (hostileStandingToFaction(nid, pirFid) || (npc.underFireTimer != null && npc.underFireTimer > 0.05))) {
      npc.aggro = true;
      npc.underFireTimer = Math.max(npc.underFireTimer || 0, 2.9);
    }
    if (!focus && (!near || distToPlayer > 175)) npc.aggro = false;
    const sharp = (focus && distToTarget < 115) || (!focus && npc.aggro && distToPlayer < 110) ? 2.55 : 2.05;
    if (!npc.escapeMode) {
      if (focus) {
        const dx = focus.x - npc.x;
        const dz = focus.z - npc.z;
        const toT = Math.atan2(dx, dz);
        const starboardBroadside = toT + Math.PI / 2;
        const portBroadside = toT - Math.PI / 2;
        const dStar = Math.abs(((starboardBroadside - npc.rotation + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        const dPort = Math.abs(((portBroadside - npc.rotation + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        const targetAngle = dStar < dPort ? starboardBroadside : portBroadside;
        let diff = targetAngle - npc.rotation;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        npc.rotation += diff * (npc.underFireTimer > 0 ? 1.95 : 1.35) * dt * npcSailingTurnFactor(npc, windAt);
        if (npc.fireCooldown <= 0 && distToTarget < 74) {
          const tvx = Math.sin(focus.rotation) * (focus.speed || 0);
          const tvz = Math.cos(focus.rotation) * (focus.speed || 0);
          emitBroadside(broadcastAll, npc, focus.x, focus.z, tvx, tvz);
          npc.fireCooldown = PLAYER_BROADSIDE_COOLDOWN;
        }
      } else if (npc.aggro && near && distToPlayer < 110) {
        const dx = near.p.x - npc.x;
        const dz = near.p.z - npc.z;
        const toPlayer = Math.atan2(dx, dz);
        const starboardBroadside = toPlayer + Math.PI / 2;
        const portBroadside = toPlayer - Math.PI / 2;
        const dStar = Math.abs(((starboardBroadside - npc.rotation + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        const dPort = Math.abs(((portBroadside - npc.rotation + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        const targetAngle = dStar < dPort ? starboardBroadside : portBroadside;
        let diff = targetAngle - npc.rotation;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        npc.rotation += diff * (npc.underFireTimer > 0 ? 1.95 : 1.35) * dt * npcSailingTurnFactor(npc, windAt);
        if (npc.fireCooldown <= 0 && distToPlayer < 72) {
          const pvx = Math.sin(near.p.rotation || 0) * (near.p.speed || 0);
          const pvz = Math.cos(near.p.rotation || 0) * (near.p.speed || 0);
          emitBroadside(broadcastAll, npc, near.p.x, near.p.z, pvx, pvz);
          npc.fireCooldown = PLAYER_BROADSIDE_COOLDOWN;
        }
      } else {
        npc.wanderTimer -= dt;
        if (npc.wanderTimer <= 0) {
          npc.wanderAngle += (Math.random() - 0.5) * 1.5;
          npc.wanderTimer = 4 + Math.random() * 8;
        }
        let diff = npc.wanderAngle - npc.rotation;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        npc.rotation += diff * 0.5 * dt * npcSailingTurnFactor(npc, windAt);
      }
    }
    steerNpcClearanceAhead(npc, dt, sharp, windAt, dryLand);
    nudgeNpcOffIsland(npc, dryLand, edgeClamp);
    const maxF = npcMaxForwardSpeed(npc);
    const tgtSpd = (focus && distToTarget < 120) || (!focus && npc.aggro && distToPlayer < 110) ? maxF * 0.88 : maxF * 0.72;
    accelerateNpcToward(npc, dt, tgtSpd);
    applyNpcMoveWithIslandEscape(npc, dt, sharp, windAt, dryLand, edgeClamp);
  }

  function step(dt, players, playerStories, playerQuests) {
    const playerMap = players instanceof Map ? players : new Map();
    syncStoryBountyNpcs(npcs, playerStories, ctx, ws, ctx.edgeClamp);
    syncQuestContractNpcs(npcs, playerQuests, ctx, playerMap);
    clearBoardLocks(npcs);
    applyNpcBoardingLocks(npcs, playerMap);
    const nowMs = Date.now();
    for (const [sid, when] of [...pirateRespawnAt.entries()]) {
      if (nowMs < when) continue;
      if (npcs.some(n => (n.syncId | 0) === sid)) {
        pirateRespawnAt.delete(sid);
        continue;
      }
      pirateRespawnAt.delete(sid);
      spawnVanillaPirateAtSlotIndex(sid, playerMap);
    }
    /* Match client `updateNpcs`: cannon kills stay in roster with sinking=true until animation completes. */
    for (const n of npcs) {
      if (!n.sinking) continue;
      n.sinkTimer = (n.sinkTimer || 0) + dt;
      if (n.sinkTimer > 4.25) n.health = -1000;
    }
    for (const npc of npcs) {
      if (npc.sinking) continue;
      if (npc._boardLock) continue;
      if (npc.health != null && npc.health <= 0) continue;
      if (npc.isTradeShip) stepMerchant(npc, dt, playerMap);
      else stepCombatNpc(npc, dt, playerMap, !!npc.isFactionPatrol);
    }
    npcs = npcs.filter(n => {
      const h = n.health != null && Number.isFinite(Number(n.health)) ? Number(n.health) : 0;
      if (h > -900) return true;
      if (isVanillaReplenishablePirateShip(n)) pirateRespawnAt.set(n.syncId | 0, Date.now() + VANILLA_PIRATE_RESPAWN_MS);
      return false;
    });
  }

  function getWindSample() {
    return windAt(0, 0);
  }

  function getNpcs() {
    return npcs;
  }

  function applyPlayerCannonHitClaim(fromPlayerId, npcSyncId, ammoType, isPellet, players) {
    return applyPlayerCannonHitAuthoritative(npcs, fromPlayerId, npcSyncId, ammoType, !!isPellet, players);
  }

  function applyBoardingScuttle(fromPlayerId, npcSyncId, players) {
    return applyBoardingScuttleAuthoritative(npcs, fromPlayerId, npcSyncId, players);
  }

  return {
    setBroadcastAll,
    setWorldSeed,
    setWorldMapPayload,
    reset,
    step,
    buildSyncRows: () => buildSyncRows(npcs, politics.portController, ws),
    getWindSample,
    getNpcs,
    applyPlayerCannonHitClaim,
    applyBoardingScuttle
  };
}

module.exports = { createServerNpcWorld };
