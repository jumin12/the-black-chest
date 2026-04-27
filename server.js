const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { createGameSimulation, createAntiCheatGate } = require('./simulation-layer.js');
const { createServerNpcWorld } = require('./server/npc-authoritative.cjs');
const { createWorldPoliticsStore, sanitizePlayerPoliticsPatch } = require('./server/world-politics.cjs');
const { createTerrainContext, sampleOffshoreSpawn } = require('./server/terrain-context.cjs');

const PORT = process.env.PORT || 3000;
/** Realm identity for server browsers and the in-game HUD (env-tunable). */
function getRealmConfig() {
  return {
    id: String(process.env.REALM_ID || 'main').slice(0, 48),
    name: String(process.env.REALM_NAME || 'The High Seas').slice(0, 64),
    motd: process.env.REALM_MOTD ? String(process.env.REALM_MOTD).slice(0, 500) : '',
    version: String(process.env.GAME_VERSION || '1').slice(0, 24)
  };
}
/** 0 = unlimited. When exceeded, new WebSockets get `server_full` and are closed. */
const MAX_CONCURRENT_CAPTAINS = Math.max(0, Math.floor(Number(process.env.MAX_CONCURRENT_CAPTAINS) || 0));
/** Monotonic-ish server seconds for wildlife sync (all clients align fish/shark motion to this). */
const SERVER_WORLD_T0_MS = Date.now();
/** World state broadcast rate (Hz); keep client send interval in index.html in sync (~1/TICK_RATE). */
const TICK_RATE = 45;
/** Match client `WORLD_EDGE_CLAMP` (7 * 270 + 135) — reject runaway coordinates from glitched clients. */
const PLAYER_WORLD_EDGE_CLAMP = 7 * 270 + 135;
function clampPlayerWorldX(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return null;
  return Math.max(-PLAYER_WORLD_EDGE_CLAMP, Math.min(PLAYER_WORLD_EDGE_CLAMP, v));
}

/** Per-client interest radius (world units). Massively cuts bandwidth vs full-world snapshots at high player counts. */
const STATE_AOI_RADIUS = Math.max(800, Math.min(20000, Number(process.env.STATE_AOI_RADIUS) || 5200));
const STATE_AOI_RADIUS_SQ = STATE_AOI_RADIUS * STATE_AOI_RADIUS;

/** Authoritative wind + motion integration (see simulation-layer.js). */
let gameSim = null;
let antiCheat = null;
/** Full NPC AI + spawn loop (server/npc-authoritative.cjs); snapshots broadcast as `npc_sync`. */
let npcWorld = null;
let npcWorldHadPlayers = false;
function ensureSimulationLayer() {
  if (!gameSim) {
    gameSim = createGameSimulation({
      worldSeed: WORLD_SEED >>> 0,
      edgeClamp: PLAYER_WORLD_EDGE_CLAMP,
      tickRate: TICK_RATE
    });
    antiCheat = createAntiCheatGate();
  }
}
function ensureNpcWorld() {
  if (!npcWorld) {
    ensureSimulationLayer();
    const pol = ensureWorldPolitics().getNpcPoliticsRef();
    npcWorld = createServerNpcWorld({
      windAt: (x, z) => gameSim.windAt(x, z),
      worldSeed: WORLD_SEED >>> 0,
      edgeClamp: PLAYER_WORLD_EDGE_CLAMP,
      worldMapPayload: currentWorldMapPayloadOrNull(),
      politicsRef: pol
    });
    npcWorld.setBroadcastAll(broadcastAll);
  }
}

function playerBoardingPartnerId(p) {
  if (!p || !p.boarding || typeof p.boarding !== 'object') return null;
  const sid = Math.floor(Number(p.boarding.sid));
  return Number.isFinite(sid) && sid > 0 ? sid : null;
}

function playerIncludedInSnapshot(viewer, target, aoiSq) {
  if (!viewer || !target) return false;
  if (target.id === viewer.id) return true;
  const vb = playerBoardingPartnerId(viewer);
  const tb = playerBoardingPartnerId(target);
  if (vb === target.id || tb === viewer.id) return true;
  const dx = target.x - viewer.x;
  const dz = target.z - viewer.z;
  return dx * dx + dz * dz <= aoiSq;
}

function buildStateRow(p, includeCrew) {
  const row = {
    id: p.id,
    x: p.x,
    z: p.z,
    rotation: p.rotation,
    speed: p.speed,
    health: p.health,
    name: p.name,
    color: p.color,
    shipType: p.shipType,
    shipName: p.shipName,
    captainKey: p.captainKey != null ? String(p.captainKey) : null,
    partyTag: p.partyTag != null ? String(p.partyTag).slice(0, 24) : '',
    flagColor: p.flagColor != null ? p.flagColor : '#1a1a1a',
    flagAssetId: (() => {
      const fa = sanitizeClientFlagAssetId(p.flagAssetId);
      return fa != null ? fa : null;
    })(),
    shipParts: p.shipParts || { hull: 'basic', sail: 'basic', cannon: 'light', figurehead: 'none', flag: 'mast' },
    docked: !!p.docked,
    dockX: p.dockX != null ? p.dockX : null,
    dockZ: p.dockZ != null ? p.dockZ : null,
    dockAngle: p.dockAngle != null ? p.dockAngle : null,
    dockBerthIndex: p.dockBerthIndex != null ? p.dockBerthIndex : null,
    riggingHealth: p.riggingHealth != null ? p.riggingHealth : 100,
    morale: p.morale != null ? p.morale : 100,
    deckWalk: p.deckWalk || null,
    boarding: p.boarding != null ? p.boarding : null,
    rtt: p.rtt != null && Number.isFinite(p.rtt) ? Math.min(120000, Math.round(p.rtt)) : null,
    hullBanner: p.hullBanner != null && typeof p.hullBanner === 'object' ? p.hullBanner : null,
    sailBanner: p.sailBanner != null && typeof p.sailBanner === 'object' ? p.sailBanner : null
  };
  if ((includeCrew || p.boarding != null) && Array.isArray(p.crewData)) row.crewData = p.crewData;
  return row;
}
/** Matches client `RESERVED_PLAYER_FLAG_IDS` — national / reserved hull-flag PNGs. */
const RESERVED_PLAYER_FLAG_ASSET_IDS = new Set([10, 13, 15, 16, 19, 21]);
function sanitizeClientFlagAssetId(v) {
  const x = Math.floor(Number(v));
  if (!Number.isFinite(x) || x < 1 || x > 26) return null;
  if (RESERVED_PLAYER_FLAG_ASSET_IDS.has(x)) return null;
  return x;
}

const BANNER_CUSTOM_FIELD_ALLOW = new Set([
  'assets/customflags/black-flag.png',
  'assets/customflags/creamwhite-flag.png',
  'assets/customflags/darkbrown-flag.png',
  'assets/customflags/darkpurple-flag.png',
  'assets/customflags/green-flag.png',
  'assets/customflags/lightbrown-flag.png',
  'assets/customflags/lightpurple-flag.png',
  'assets/customflags/maroon-flag.png',
  'assets/customflags/mintwhite-flag.png',
  'assets/customflags/navyblue-flag.png',
  'assets/customflags/pink-flag.png',
  'assets/customflags/red-flag.png',
  'assets/customflags/tiel-flag.png',
  'assets/customflags/white-flag.png',
  'assets/customflags/yellow-flag.png'
]);

function sanitizeBannerFromClient(raw) {
  if (raw == null) return null;
  let o = raw;
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }
  if (!o || typeof o !== 'object') return null;
  const bgIn = String(o.bg != null ? o.bg : '#4a3020').trim().slice(0, 32);
  const bg = /^#[0-9A-Fa-f]{6}$/.test(bgIn) ? bgIn : '#4a3020';
  let field = o.field != null ? String(o.field).trim() : '';
  if (field && !BANNER_CUSTOM_FIELD_ALLOW.has(field)) field = '';
  const emblems = [];
  const arr = Array.isArray(o.emblems) ? o.emblems : [];
  for (let i = 0; i < arr.length && emblems.length < 6; i++) {
    const e = arr[i];
    if (!e || typeof e !== 'object') continue;
    const id = Math.floor(Number(e.id));
    if (!Number.isFinite(id) || id < 1 || id > 25) continue;
    const x = Math.max(0, Math.min(1, Number(e.x)));
    const y = Math.max(0, Math.min(1, Number(e.y)));
    const s = Math.max(0.1, Math.min(1.4, Number.isFinite(Number(e.s)) ? Number(e.s) : 0.35));
    let r = Number(e.r);
    if (!Number.isFinite(r)) r = 0;
    r = Math.max(-Math.PI * 2, Math.min(Math.PI * 2, r));
    emblems.push({ id, x, y, s, r });
  }
  return { bg, field, emblems };
}
/** Compact boarding engagement relayed in `update` / `state` for multiplayer sync. */
function sanitizeBoardingFromClient(b) {
  if (b === null) return null;
  if (typeof b !== 'object' || !b) return null;
  const sid = Math.floor(Number(b.sid));
  if (!Number.isFinite(sid) || sid === 0) return null;
  const ph = b.ph === 'e' ? 'e' : b.ph === 'f' ? 'f' : 'h';
  const nx = Number(b.nx);
  const nz = Number(b.nz);
  const nrRaw = Number(b.nr);
  if (!Number.isFinite(nx) || !Number.isFinite(nz)) return null;
  const nr = Number.isFinite(nrRaw) ? nrRaw : 0;
  const ex = Number(b.ex);
  const ez = Number(b.ez);
  const er = Number(b.er);
  const o = {
    sid,
    ph,
    t: Math.max(0, Math.min(999, Number(b.t) || 0)),
    hd: Math.max(0.4, Math.min(60, Number(b.hd) || 2.45)),
    pa: Math.max(0, Math.min(48, Math.floor(Number(b.pa) || 0))),
    pH: Math.max(0, Math.min(48, Math.floor(Number(b.pH) || 0))),
    ea: Math.max(0, Math.min(48, Math.floor(Number(b.ea) || 0))),
    eH: Math.max(0, Math.min(48, Math.floor(Number(b.eH) || 0))),
    pTo: Math.max(0, Math.min(96, Math.floor(Number(b.pTo) || 0))),
    eTo: Math.max(0, Math.min(96, Math.floor(Number(b.eTo) || 0))),
    nx: Math.max(-5e5, Math.min(5e5, nx)),
    nz: Math.max(-5e5, Math.min(5e5, nz)),
    nr: Math.max(-1e4, Math.min(1e4, nr))
  };
  if (Number.isFinite(ex) && Number.isFinite(ez) && Number.isFinite(er)) {
    o.ex = Math.max(-5e5, Math.min(5e5, ex));
    o.ez = Math.max(-5e5, Math.min(5e5, ez));
    o.er = Math.max(-1e4, Math.min(1e4, er));
  }
  if (b.pl != null && Number.isFinite(Number(b.pl))) {
    o.pl = Math.max(0, Math.min(1, Number(b.pl)));
  }
  const atIn = b.at != null && Number.isFinite(Number(b.at)) ? Number(b.at)
    : (b.attackerId != null && Number.isFinite(Number(b.attackerId)) ? Number(b.attackerId) : null);
  if (atIn != null) o.at = Math.max(0, Math.min(0x7fffffff, Math.floor(atIn)));
  return o;
}
/**
 * Persistent JSON directory (leaderboard, clans, world seed, map, bans, accounts).
 * Prefer env `DATA_DIR`. If unset, use a mounted path when present (Render disks often use `/var/data`)
 * so clans survive restarts even when the env var was forgotten.
 */
function resolveDataDir() {
  const env = process.env.DATA_DIR;
  if (env != null && String(env).trim() !== '') return path.resolve(String(env).trim());
  for (const dir of ['/var/data', '/data']) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
    } catch (e) {}
  }
  return __dirname;
}
const DATA_DIR = resolveDataDir();
console.log('[playground] persistent DATA_DIR =', DATA_DIR);
const SEED_FILE = path.join(DATA_DIR, 'world_seed.json');
const WORLD_MAP_FILE = path.join(DATA_DIR, 'world_map.json');
/** Snapshot of the chart before the last successful publish — used for one-step revert. */
const WORLD_MAP_BACKUP_FILE = path.join(DATA_DIR, 'world_map.prev.json');
/** Secondary copy beside server.js (same pattern as leaderboard.shadow) when DATA_DIR is ephemeral. */
const WORLD_MAP_SHADOW = path.join(__dirname, 'world_map.shadow.json');
/** Optional extra copy next to server when DATA_DIR points elsewhere. */
const WORLD_MAP_BESIDE = path.join(__dirname, 'world_map.json');
/** How often to flush seed, leaderboard, clans, captain accounts, and (if due) world map to disk. */
const SERVER_STATE_SAVE_INTERVAL_MS = Math.max(200, Number(process.env.SERVER_STATE_SAVE_INTERVAL_MS) || 60000);
/** Large chart payloads: re-save at most this often unless a new revision was published (override with env). */
const WORLD_MAP_AUTOSAVE_MS = Math.max(SERVER_STATE_SAVE_INTERVAL_MS, Number(process.env.WORLD_MAP_AUTOSAVE_MS) || SERVER_STATE_SAVE_INTERVAL_MS);
let lastWorldMapDiskWriteMs = 0;
/** Full map JSON (same shape as editor export); null if no published chart. */
let WORLD_MAP_PAYLOAD = null;
let WORLD_MAP_REVISION = 0;
/** Primary notorious-pirates store (array JSON); also mirrored inside world_seed.json. */
const LEADERBOARD_FILE = path.join(DATA_DIR, 'leaderboard.json');
/** Secondary copy beside server.js so a cold DATA_DIR (ephemeral volume) can still recover from disk. */
const LEADERBOARD_SHADOW = path.join(__dirname, 'leaderboard.shadow.json');
/** After a full disk load, ignore client `leaderboard_offer` unless admin cleared ranks. */
let leaderboardClientSeeded = false;
/** Stable default when no file/env (matches client `CANONICAL_DEFAULT_WORLD_SEED`). Commit `world_seed.json` so restarts and deploys reload the same archipelago; live rankings persist in the same file under `leaderboard`. */
const DEFAULT_WORLD_SEED = 42;
let WORLD_SEED = DEFAULT_WORLD_SEED >>> 0;
const WORLD_POLITICS_FILE = path.join(DATA_DIR, 'world_politics.json');
let worldPolitics = null;
function ensureWorldPolitics() {
  if (!worldPolitics) {
    worldPolitics = createWorldPoliticsStore({ filePath: WORLD_POLITICS_FILE, worldSeed: WORLD_SEED >>> 0 });
  }
  return worldPolitics;
}

/**
 * Navigator unlock password: prefer `NAVIGATOR_ADMIN_PASSWORD` (hosting secret / env).
 * Otherwise read the first non-comment line from `navigator_admin.secret` next to this file,
 * or from `NAVIGATOR_ADMIN_SECRET_FILE` (absolute or relative to this directory).
 * Keep the secret file out of git; copy it onto the production machine beside server.js.
 */
function resolveNavigatorSecretPath() {
  const p = process.env.NAVIGATOR_ADMIN_SECRET_FILE;
  if (!p || String(p).trim() === '') return path.join(__dirname, 'navigator_admin.secret');
  return path.isAbsolute(p) ? p : path.join(__dirname, p);
}

function readNavigatorAdminPassword() {
  const env = process.env.NAVIGATOR_ADMIN_PASSWORD;
  if (env != null && String(env).trim() !== '') return { pw: String(env).trim(), src: 'env' };
  const secretPath = resolveNavigatorSecretPath();
  try {
    if (!fs.existsSync(secretPath)) return { pw: '', src: 'none' };
    const lines = fs.readFileSync(secretPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const t = String(line || '').trim();
      if (!t || t.startsWith('#')) continue;
      return { pw: t, src: 'file' };
    }
  } catch (e) {}
  return { pw: '', src: 'none' };
}

const _nav = readNavigatorAdminPassword();
const NAVIGATOR_ADMIN_PASSWORD = _nav.pw;
const NAVIGATOR_ADMIN_PASSWORD_SOURCE = _nav.src;
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
const adminSessions = new Map();

function verifyNavigatorPassword(pw) {
  if (!NAVIGATOR_ADMIN_PASSWORD || String(NAVIGATOR_ADMIN_PASSWORD).length === 0) return false;
  const a = crypto.createHash('sha256').update(String(pw || ''), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(NAVIGATOR_ADMIN_PASSWORD), 'utf8').digest();
  try {
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

function pruneAdminSessions() {
  const now = Date.now();
  for (const [tok, exp] of adminSessions) {
    if (exp <= now) adminSessions.delete(tok);
  }
}
setInterval(pruneAdminSessions, 120000);

function readJsonBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const players = new Map();
/** Latest WebSocket per normalized captain key; a new login replaces the previous. */
const captainSocketByKey = new Map();
/** @deprecated kept for old clients; no longer merged globally */
let worldStoryQuest = {
  phase: 'intro',
  step: 0,
  turnInCx: null,
  turnInCz: null,
  turnInTown: null,
  bountyX: null,
  bountyZ: null,
  bountyRot: null
};
/** Per connected captain: main story progress for bounty spawns (not global). */
const playerStories = new Map();
/** Per connected captain: hunt contracts (server-spawned targets). */
const playerQuests = new Map();
/** @type {object[]|null} */
let worldQuests = null;
let nextId = 1;
let nextLootNetId = 1;
let nextSwimmerNetId = 1;
let nextChatMessageId = 1;
const CHAT_HISTORY_MAX = 200;
/** @type {{ id: number, t: number, playerId: number, name: string, text: string, channel?: string, partyId?: string|null, partyTag?: string, clanTag?: string }[]} */
const chatHistory = [];

const CLAN_MAX_MEMBERS = 5;

const PARTIES_FILE = path.join(DATA_DIR, 'parties.json');
/** Secondary copy beside server.js so ephemeral DATA_DIR (e.g. some hosts) still recovers clans after restart. */
const PARTIES_SHADOW = path.join(__dirname, 'parties.shadow.json');
/** @type {{ parties: Record<string, { id: string, tag: string, leaderKey: string, memberKeys: string[], pendingKeys?: string[], pendingInviteFrom?: Record<string, { fromCaptainKey: string, fromName: string }>, officerKeys?: string[] }>, captainParty: Record<string, string>, nextPartyNum: number }} */
let partyStore = { parties: {}, captainParty: {}, nextPartyNum: 1 };

function normalizeClanNameKey(tag) {
  return String(tag || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function clanNameTaken(normKey, excludePartyId) {
  if (!normKey) return false;
  for (const pid of Object.keys(partyStore.parties)) {
    if (excludePartyId && pid === excludePartyId) continue;
    const pr = partyStore.parties[pid];
    if (pr && normalizeClanNameKey(pr.tag) === normKey) return true;
  }
  return false;
}

function migratePartyRecord(pr) {
  if (!pr) return;
  if (!Array.isArray(pr.officerKeys)) pr.officerKeys = [];
  if (!pr.pendingInviteFrom || typeof pr.pendingInviteFrom !== 'object') pr.pendingInviteFrom = {};
  if (!Array.isArray(pr.pendingJoinRequests)) pr.pendingJoinRequests = [];
  if (!('clanHullBanner' in pr)) pr.clanHullBanner = null;
  if (!('clanSailBanner' in pr)) pr.clanSailBanner = null;
}

function deletePendingInviteMeta(pr, captainKey) {
  if (!pr || !captainKey || !pr.pendingInviteFrom) return;
  delete pr.pendingInviteFrom[captainKey];
}

function stripCaptainFromOtherPendingInvites(targetKey, exceptPartyId) {
  if (!targetKey) return;
  for (const pid of Object.keys(partyStore.parties)) {
    if (exceptPartyId && pid === exceptPartyId) continue;
    const o = partyStore.parties[pid];
    if (!o || !o.pendingKeys || !o.pendingKeys.includes(targetKey)) continue;
    o.pendingKeys = o.pendingKeys.filter(k => k !== targetKey);
    deletePendingInviteMeta(o, targetKey);
  }
}

/** Remove this captain from every clan’s application queue (except `exceptPartyId` when set). Re-broadcasts affected clans. */
function stripCaptainFromAllJoinRequestsExcept(targetKey, exceptPartyId) {
  if (!targetKey) return;
  const touched = [];
  for (const pid of Object.keys(partyStore.parties)) {
    if (exceptPartyId && pid === exceptPartyId) continue;
    const o = partyStore.parties[pid];
    migratePartyRecord(o);
    if (!o.pendingJoinRequests.length) continue;
    const next = o.pendingJoinRequests.filter(r => r.captainKey !== targetKey);
    if (next.length !== o.pendingJoinRequests.length) {
      o.pendingJoinRequests = next;
      touched.push(pid);
    }
  }
  if (touched.length) {
    savePartyStore();
    for (const pid of touched) broadcastPartySync(pid);
  }
}

/** When a captain reserves their name, deliver any clan invites received while offline. */
function sendPendingClanInvitesForCaptain(ws, captainKey) {
  if (!ws || ws.readyState !== 1 || !captainKey || getPartyForCaptainKey(captainKey)) return;
  for (const pr of Object.values(partyStore.parties)) {
    migratePartyRecord(pr);
    if (!pr.pendingKeys || !pr.pendingKeys.includes(captainKey)) continue;
    const meta = pr.pendingInviteFrom && pr.pendingInviteFrom[captainKey];
    const fromName = meta && meta.fromName ? meta.fromName : 'A captain';
    const fromCaptainKey = meta && meta.fromCaptainKey ? meta.fromCaptainKey : (pr.leaderKey || '');
    try {
      ws.send(JSON.stringify({
        type: 'party_invite_pending',
        partyId: pr.id,
        tag: pr.tag,
        fromCaptainKey,
        fromName: String(fromName).slice(0, 28)
      }));
    } catch (e) {}
    break;
  }
}

function readPartyStoreFileCandidate(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { data: null, mtime: 0 };
    const st = fs.statSync(filePath);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.parties || !raw.captainParty) return { data: null, mtime: st.mtimeMs };
    return {
      data: {
        parties: typeof raw.parties === 'object' ? raw.parties : {},
        captainParty: typeof raw.captainParty === 'object' ? raw.captainParty : {},
        nextPartyNum: Math.max(1, Math.floor(Number(raw.nextPartyNum) || 1))
      },
      mtime: st.mtimeMs
    };
  } catch (e) {
    console.error('[playground] parties read error:', filePath, e.message);
    return { data: null, mtime: 0 };
  }
}

/** Optional `partyStore` bundled next to leaderboard rows (same files / shadow copies as scores). */
function readPartyStoreFromLeaderboardBundle(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { data: null, mtime: 0 };
    const st = fs.statSync(filePath);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { data: null, mtime: st.mtimeMs };
    const ps = raw.partyStore;
    if (!ps || typeof ps !== 'object' || !ps.parties || !ps.captainParty) return { data: null, mtime: st.mtimeMs };
    return {
      data: {
        parties: typeof ps.parties === 'object' ? { ...ps.parties } : {},
        captainParty: typeof ps.captainParty === 'object' ? { ...ps.captainParty } : {},
        nextPartyNum: Math.max(1, Math.floor(Number(ps.nextPartyNum) || 1))
      },
      mtime: st.mtimeMs
    };
  } catch (e) {
    return { data: null, mtime: 0 };
  }
}

/** Embedded `partyStore` inside world_seed.json (same persistence path as leaderboard). */
function readPartyStoreFromSeedFileCandidate(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { data: null, mtime: 0 };
    const st = fs.statSync(filePath);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.partyStore || typeof raw.partyStore !== 'object') return { data: null, mtime: st.mtimeMs };
    const ps = raw.partyStore;
    if (!ps.parties || !ps.captainParty) return { data: null, mtime: st.mtimeMs };
    return {
      data: {
        parties: typeof ps.parties === 'object' ? { ...ps.parties } : {},
        captainParty: typeof ps.captainParty === 'object' ? { ...ps.captainParty } : {},
        nextPartyNum: Math.max(1, Math.floor(Number(ps.nextPartyNum) || 1))
      },
      mtime: st.mtimeMs
    };
  } catch (e) {
    return { data: null, mtime: 0 };
  }
}

/** Lexicographic richness: real clans/members first; `nextPartyNum` is last tie-breaker only (high counter must not beat non-empty rosters). */
function partyStoreRichnessTuple(s) {
  if (!s || typeof s.parties !== 'object') return [-1, 0, 0, 0, 0];
  const nPart = Object.keys(s.parties).length;
  const cap = s.captainParty && typeof s.captainParty === 'object' ? s.captainParty : {};
  const nCap = Object.keys(cap).length;
  let members = 0, pending = 0;
  for (const pr of Object.values(s.parties)) {
    if (!pr) continue;
    if (Array.isArray(pr.memberKeys)) members += pr.memberKeys.length;
    if (Array.isArray(pr.pendingKeys)) pending += pr.pendingKeys.length;
  }
  const npn = Math.max(1, Math.floor(Number(s.nextPartyNum) || 1));
  return [nPart, nCap, members, pending, npn];
}
/** >0 if a is strictly richer than b */
function comparePartyStoreSnapshots(a, b) {
  const ta = partyStoreRichnessTuple(a);
  const tb = partyStoreRichnessTuple(b);
  for (let i = 0; i < ta.length; i++) {
    const d = ta[i] - tb[i];
    if (d !== 0) return d;
  }
  return 0;
}

function loadPartyStore() {
  const tryPaths = [...new Set([PARTIES_FILE, PARTIES_SHADOW, path.join(__dirname, 'parties.json')])];
  let best = null;
  let bestMtime = -1;
  for (const p of tryPaths) {
    const { data, mtime } = readPartyStoreFileCandidate(p);
    if (!data) continue;
    const cmp = best ? comparePartyStoreSnapshots(data, best) : 1;
    if (!best || cmp > 0 || (cmp === 0 && mtime > bestMtime)) {
      best = data;
      bestMtime = mtime;
    }
  }
  const seedCand = readPartyStoreFromSeedFileCandidate(SEED_FILE);
  if (seedCand.data) {
    const { data, mtime } = seedCand;
    const cmp = best ? comparePartyStoreSnapshots(data, best) : 1;
    if (!best || cmp > 0 || (cmp === 0 && mtime > bestMtime)) {
      best = data;
      bestMtime = mtime;
    }
  }
  const lbPartyPaths = [...new Set([LEADERBOARD_FILE, LEADERBOARD_SHADOW, path.join(__dirname, 'leaderboard.json')])];
  for (const p of lbPartyPaths) {
    const { data, mtime } = readPartyStoreFromLeaderboardBundle(p);
    if (!data) continue;
    const cmp = best ? comparePartyStoreSnapshots(data, best) : 1;
    if (!best || cmp > 0 || (cmp === 0 && mtime > bestMtime)) {
      best = data;
      bestMtime = mtime;
    }
  }
  if (!best) return;
  try {
    partyStore = {
      parties: typeof best.parties === 'object' ? { ...best.parties } : {},
      captainParty: typeof best.captainParty === 'object' ? { ...best.captainParty } : {},
      nextPartyNum: Math.max(1, Math.floor(Number(best.nextPartyNum) || 1))
    };
    for (const pid of Object.keys(partyStore.parties)) {
      migratePartyRecord(partyStore.parties[pid]);
    }
  } catch (e) {
    console.error('[playground] parties load error:', e.message);
  }
}
function savePartyStore() {
  const json = JSON.stringify(partyStore);
  try {
    writeFileAtomic(PARTIES_FILE, json);
  } catch (e) {
    console.error('[playground] parties save (primary) error:', PARTIES_FILE, e.message);
  }
  try {
    writeFileAtomic(PARTIES_SHADOW, json);
  } catch (e) {
    console.error('[playground] parties save (shadow) error:', PARTIES_SHADOW, e.message);
  }
  try {
    persistWorldSeedFile();
  } catch (e) {
    console.error('[playground] persistWorldSeedFile after parties error:', e.message);
  }
}

/** Defer full disk flush to the next idle turn so 45Hz `state` + WS I/O are not blocked in the timer callback. */
let idlePersistCoalesced = false;
function scheduleIdlePersistedStateFlush() {
  if (idlePersistCoalesced) return;
  idlePersistCoalesced = true;
  setImmediate(() => {
    idlePersistCoalesced = false;
    try {
      savePartyStore();
      flushCaptainAccountsIfDirty();
      saveWorldPresenceIfDirty();
      const now = Date.now();
      if (WORLD_MAP_PAYLOAD && validateWorldMapPayload(WORLD_MAP_PAYLOAD) && (WORLD_MAP_REVISION >>> 0) > 0) {
        if (now - lastWorldMapDiskWriteMs >= WORLD_MAP_AUTOSAVE_MS) {
          persistWorldMapToDisk();
          lastWorldMapDiskWriteMs = now;
        }
      }
      try {
        const pol = ensureWorldPolitics();
        if (typeof pol.consumeDirty === 'function' && pol.consumeDirty()) pol.save();
      } catch (e) {}
    } catch (e) {}
  });
}

/** If `world_seed.json` carries a richer clan snapshot than `parties.json` (e.g. ephemeral DATA_DIR), restore from it. */
function tryMergePartyStoreFromWorldSeedBlob(blob) {
  if (!blob || !blob.partyStore || typeof blob.partyStore !== 'object') return;
  const ps = blob.partyStore;
  const candidate = {
    parties: typeof ps.parties === 'object' && ps.parties ? { ...ps.parties } : {},
    captainParty: typeof ps.captainParty === 'object' && ps.captainParty ? { ...ps.captainParty } : {},
    nextPartyNum: Math.max(1, Math.floor(Number(ps.nextPartyNum) || 1))
  };
  if (comparePartyStoreSnapshots(candidate, partyStore) <= 0) return;
  partyStore = candidate;
  for (const pid of Object.keys(partyStore.parties)) {
    migratePartyRecord(partyStore.parties[pid]);
  }
  savePartyStore();
}

/**
 * Re-read every clan snapshot path (primary DATA_DIR + shadows beside server.js).
 * Picks the richest `partyStore` so clans survive restarts when one path is wiped on deploy
 * but another copy (e.g. leaderboard.shadow) still has `partyStore`.
 */
function augmentPartyStoreFromRichestOnDisk() {
  const candidates = [];
  const push = (data) => {
    if (data && typeof data.parties === 'object' && typeof data.captainParty === 'object') candidates.push(data);
  };
  try { push(readPartyStoreFileCandidate(PARTIES_FILE).data); } catch (e) {}
  try { push(readPartyStoreFileCandidate(PARTIES_SHADOW).data); } catch (e) {}
  try { push(readPartyStoreFileCandidate(path.join(__dirname, 'parties.json')).data); } catch (e) {}
  try { push(readPartyStoreFromSeedFileCandidate(SEED_FILE).data); } catch (e) {}
  try { push(readPartyStoreFromLeaderboardBundle(LEADERBOARD_FILE).data); } catch (e) {}
  try { push(readPartyStoreFromLeaderboardBundle(LEADERBOARD_SHADOW).data); } catch (e) {}
  try { push(readPartyStoreFromLeaderboardBundle(path.join(__dirname, 'leaderboard.json')).data); } catch (e) {}
  let best = partyStore;
  for (const c of candidates) {
    if (comparePartyStoreSnapshots(c, best) > 0) best = c;
  }
  if (comparePartyStoreSnapshots(best, partyStore) <= 0) return;
  try {
    partyStore = JSON.parse(JSON.stringify({
      parties: best.parties || {},
      captainParty: best.captainParty || {},
      nextPartyNum: Math.max(1, Math.floor(Number(best.nextPartyNum) || 1))
    }));
    for (const pid of Object.keys(partyStore.parties)) {
      migratePartyRecord(partyStore.parties[pid]);
    }
    savePartyStore();
  } catch (e) {
    console.error('[playground] augmentPartyStoreFromRichestOnDisk failed:', e.message);
  }
}
loadPartyStore();

/** Refresh clan rosters (online/offline) for all connected members; complements event-driven broadcastPartySync. */
setInterval(() => {
  try {
    for (const partyId of Object.keys(partyStore.parties)) {
      broadcastPartySync(partyId);
    }
  } catch (e) {}
}, 8000);

function sanitizePartyTag(t) {
  return String(t != null ? t : '').trim().slice(0, 24);
}

function findPlayerIdByCaptainKey(ck) {
  if (!ck) return null;
  const nck = normalizeCaptainKey(String(ck));
  for (const [pid, pl] of players) {
    if (!pl) continue;
    if (pl.captainKey && normalizeCaptainKey(String(pl.captainKey)) === nck) return pid;
  }
  /** Invite targets may still be on a placeholder id before `captainKey` is committed; match reserved display name. */
  for (const [pid, pl] of players) {
    if (!pl || pl.captainKey) continue;
    const nm = String(pl.name || '').trim();
    if (isAutoGeneratedPirateName(nm)) continue;
    if (normalizeCaptainKey(nm) === nck) return pid;
  }
  return null;
}

function refreshPlayerPartyTag(pl) {
  if (!pl) return;
  const ck = pl.captainKey || null;
  if (!ck) {
    pl.partyTag = '';
    return;
  }
  const pr = getPartyForCaptainKey(ck);
  pl.partyTag = pr && pr.tag ? String(pr.tag).slice(0, 24) : '';
}

function refreshPartyTagsForMemberKeys(keys) {
  if (!Array.isArray(keys)) return;
  for (const ck of keys) {
    const pid = findPlayerIdByCaptainKey(ck);
    if (pid == null) continue;
    const pl = players.get(pid);
    if (pl) refreshPlayerPartyTag(pl);
  }
}

function canInviteToClan(pr, ck) {
  if (!pr || !ck) return false;
  if (pr.leaderKey === ck) return true;
  migratePartyRecord(pr);
  return Array.isArray(pr.officerKeys) && pr.officerKeys.includes(ck);
}

function broadcastPartySync(partyId) {
  const p = partyStore.parties[partyId];
  if (!p || !Array.isArray(p.memberKeys)) return;
  refreshPartyTagsForMemberKeys(p.memberKeys);
  for (const ck of p.memberKeys) {
    const pid = findPlayerIdByCaptainKey(ck);
    if (pid == null) continue;
    const cws = findWsByPlayerId(pid);
    if (cws && cws.readyState === 1) {
      try {
        const payload = buildPartySyncPayload(p, ck);
        cws.send(JSON.stringify({ type: 'party_sync', party: payload }));
      } catch (e) {}
    }
  }
}

function buildPartySyncPayload(p, viewerCaptainKey) {
  migratePartyRecord(p);
  const officerKeys = Array.isArray(p.officerKeys) ? p.officerKeys.slice() : [];
  const memberKeys = Array.isArray(p.memberKeys) ? p.memberKeys.slice() : [];
  const members = memberKeys.map(ck => {
    const pid = findPlayerIdByCaptainKey(ck);
    const pl = pid != null ? players.get(pid) : null;
    const acc = captainAccounts[ck];
    const online = pl != null;
    const name = pl && pl.name ? String(pl.name).slice(0, 28) : (acc && acc.displayName ? String(acc.displayName).slice(0, 28) : ck);
    let role = 'member';
    if (ck === p.leaderKey) role = 'leader';
    else if (officerKeys.includes(ck)) role = 'officer';
    return {
      captainKey: ck,
      playerId: pid != null ? pid : null,
      name,
      online,
      role
    };
  });
  const out = {
    id: p.id,
    tag: p.tag,
    leaderCaptainKey: p.leaderKey,
    officerCaptainKeys: officerKeys,
    memberKeys,
    members,
    clanHullBanner: p.clanHullBanner != null && typeof p.clanHullBanner === 'object' ? p.clanHullBanner : null,
    clanSailBanner: p.clanSailBanner != null && typeof p.clanSailBanner === 'object' ? p.clanSailBanner : null
  };
  if (viewerCaptainKey && canInviteToClan(p, viewerCaptainKey)) {
    out.pendingJoinRequests = (p.pendingJoinRequests || []).map(r => ({
      captainKey: String(r.captainKey),
      name: r.name != null ? String(r.name).slice(0, 28) : '',
      t: r.t != null ? Number(r.t) : 0
    }));
  }
  return out;
}

function getPartyForCaptainKey(ck) {
  if (!ck) return null;
  const partyId = partyStore.captainParty[ck];
  if (!partyId) return null;
  return partyStore.parties[partyId] || null;
}

function disbandParty(partyId) {
  const p = partyStore.parties[partyId];
  if (!p) return;
  const keys = (p.memberKeys || []).slice();
  for (const ck of keys) {
    delete partyStore.captainParty[ck];
  }
  delete partyStore.parties[partyId];
  savePartyStore();
  for (const ck of keys) {
    const pid = findPlayerIdByCaptainKey(ck);
    if (pid != null) {
      const pl = players.get(pid);
      if (pl) refreshPlayerPartyTag(pl);
      sendToPlayerId(pid, { type: 'party_sync', party: null });
    }
  }
}

function sendToPlayerId(pid, obj) {
  const cws = findWsByPlayerId(pid);
  if (cws && cws.readyState === 1) {
    try {
      cws.send(JSON.stringify(obj));
    } catch (e) {}
  }
}

const BANS_FILE = path.join(DATA_DIR, 'bans.json');
let leaderboardHistory = [];
/** Max rows kept after merge/sort (large enough for full roster; still bounded for memory). */
const LEADERBOARD_CAP = 2000;
/** @type {Set<string>} */
let bannedIps = new Set();
/** @type {Set<number>} */
const mutedPlayerIds = new Set();

function normalizeLbEntry(e) {
  if (!e || typeof e !== 'object') {
    return { name: 'Unknown', gold: 0, sinksAi: 0, sinksPlayer: 0, ransoms: 0, deaths: 0, boardings: 0, playerId: null, captainKey: null, shipName: '', partyTag: '' };
  }
  const name = String(e.name || 'Pirate').slice(0, 28);
  const shipName = e.shipName != null ? String(e.shipName).slice(0, 28) : '';
  const partyTag = e.partyTag != null ? String(e.partyTag).slice(0, 24) : '';
  const gold = Math.max(0, Math.floor(
    e.gold != null ? Number(e.gold) : (e.loot != null ? Number(e.loot) : 0)
  ));
  const sinksAi = Math.max(0, Math.floor(
    e.sinksAi != null ? Number(e.sinksAi) : (e.kills != null ? Number(e.kills) : 0)
  ));
  const sinksPlayer = Math.max(0, Math.floor(Number(e.sinksPlayer) || 0));
  const ransoms = Math.max(0, Math.floor(Number(e.ransoms) || 0));
  const deaths = Math.max(0, Math.floor(Number(e.deaths) || 0));
  const boardings = Math.max(0, Math.floor(Number(e.boardings) || 0));
  const rawPid = e.playerId != null && e.playerId !== '' ? Number(e.playerId) : null;
  const playerId = Number.isFinite(rawPid) ? rawPid : null;
  let captainKey = null;
  if (e.captainKey != null && String(e.captainKey).trim() !== '') {
    const ck = normalizeCaptainKey(String(e.captainKey));
    if (ck) captainKey = ck;
  }
  return { name, gold, sinksAi, sinksPlayer, ransoms, deaths, boardings, playerId, captainKey, shipName, partyTag };
}

/**
 * Fold duplicate rows that belong to the same captain account (`captainKey`) or same numeric id.
 * Does not merge different people who only share a display name.
 */
function mergeLeaderboardByIdentity() {
  /** Same captain often has one row keyed by `captainKey` and a stale row keyed only by `playerId`. */
  const pidToCk = new Map();
  for (const raw of leaderboardHistory) {
    const e = normalizeLbEntry(raw);
    if (e.captainKey && e.playerId != null && Number.isFinite(Number(e.playerId))) {
      pidToCk.set(Number(e.playerId), e.captainKey);
    }
  }
  for (let i = 0; i < leaderboardHistory.length; i++) {
    const e = normalizeLbEntry(leaderboardHistory[i]);
    if (!e.captainKey && e.playerId != null && pidToCk.has(Number(e.playerId))) {
      e.captainKey = pidToCk.get(Number(e.playerId));
      leaderboardHistory[i] = e;
    }
  }
  const m = new Map();
  let orphanSeq = 0;
  for (const raw of leaderboardHistory) {
    const e = normalizeLbEntry(raw);
    let key;
    if (e.captainKey) {
      key = `k:${e.captainKey}`;
    } else if (e.playerId != null) {
      key = `i:${e.playerId}`;
    } else {
      key = `o:${orphanSeq++}`;
    }
    if (!m.has(key)) {
      m.set(key, { ...e });
    } else {
      const o = m.get(key);
      /** Use max so duplicate rows for the same captain (reconnect / bad merge) do not double-count stats. */
      o.gold = Math.max(o.gold, e.gold);
      o.sinksAi = Math.max(o.sinksAi, e.sinksAi);
      o.sinksPlayer = Math.max(o.sinksPlayer, e.sinksPlayer);
      o.ransoms = Math.max(o.ransoms, e.ransoms);
      o.deaths = Math.max(o.deaths, e.deaths);
      o.boardings = Math.max(o.boardings || 0, e.boardings || 0);
      if (e.name && e.name !== 'Pirate' && e.name !== 'Unknown') o.name = e.name;
      if (e.shipName && String(e.shipName).trim()) o.shipName = String(e.shipName).slice(0, 28);
      if (e.partyTag != null && String(e.partyTag).trim()) o.partyTag = String(e.partyTag).slice(0, 24);
      if (o.captainKey == null && e.captainKey != null) o.captainKey = e.captainKey;
      if (o.playerId == null && e.playerId != null) o.playerId = e.playerId;
      else if (o.playerId != null && e.playerId != null && o.playerId !== e.playerId) o.playerId = null;
    }
  }
  leaderboardHistory = Array.from(m.values());
}

/** Legacy rows lacked `captainKey`; infer from display name unless it is the auto `Pirate_<id>` pattern. */
function backfillLeaderboardCaptainKeys() {
  for (let i = 0; i < leaderboardHistory.length; i++) {
    const row = normalizeLbEntry(leaderboardHistory[i]);
    if (row.captainKey) {
      leaderboardHistory[i] = row;
      continue;
    }
    const n = String(row.name || '').trim();
    if (/^pirate_\d+$/i.test(n)) {
      leaderboardHistory[i] = row;
      continue;
    }
    const ck = normalizeCaptainKey(n);
    if (ck && !captainKeyFromDisplayNameIsAmbiguous(n)) row.captainKey = ck;
    leaderboardHistory[i] = row;
  }
}

/**
 * When the same display name appears on multiple rows and only some rows carry `captainKey`,
 * copy the key onto the rest so `mergeLeaderboardByIdentity` can fold them (reconnect / race artifacts).
 * If the same name maps to more than one distinct key, treat as ambiguous and skip.
 */
function linkLeaderboardCaptainKeysByDisplayName() {
  const nameToCk = new Map();
  for (const raw of leaderboardHistory) {
    const e = normalizeLbEntry(raw);
    const n = String(e.name || '').trim();
    if (!e.captainKey || captainKeyFromDisplayNameIsAmbiguous(n)) continue;
    const ck = e.captainKey;
    if (!nameToCk.has(n)) nameToCk.set(n, ck);
    else if (nameToCk.get(n) !== ck) nameToCk.set(n, null);
  }
  for (let i = 0; i < leaderboardHistory.length; i++) {
    const e = normalizeLbEntry(leaderboardHistory[i]);
    const n = String(e.name || '').trim();
    if (e.captainKey || captainKeyFromDisplayNameIsAmbiguous(n)) {
      leaderboardHistory[i] = e;
      continue;
    }
    const ck = nameToCk.get(n);
    if (ck) e.captainKey = ck;
    leaderboardHistory[i] = e;
  }
}

function isAutoGeneratedPirateName(name) {
  return /^pirate_\d+$/i.test(String(name || '').trim());
}

/**
 * Display names that normalize to generic keys (`pirate`, `unknown`, etc.) must not become `captainKey`,
 * or `mergeLeaderboardByIdentity` folds unrelated captains into one row when scores update / reconcile runs.
 */
function captainKeyFromDisplayNameIsAmbiguous(capName) {
  const n = String(capName || '').trim();
  if (!n || isAutoGeneratedPirateName(n)) return true;
  const k = normalizeCaptainKey(n);
  if (!k) return true;
  if (k === 'pirate' || k === 'unknown') return true;
  return false;
}

/** Drop poisonous placeholder keys so rows merge by `playerId` or orphan id instead of one shared bucket. */
function stripMergePoisonousCaptainKeys() {
  for (let i = 0; i < leaderboardHistory.length; i++) {
    const row = normalizeLbEntry(leaderboardHistory[i]);
    if (!row.captainKey) {
      leaderboardHistory[i] = row;
      continue;
    }
    const ck = String(row.captainKey);
    if (ck === 'pirate' || ck === 'unknown') {
      row.captainKey = null;
      leaderboardHistory[i] = row;
      continue;
    }
    const nm = String(row.name || '').trim();
    if (captainKeyFromDisplayNameIsAmbiguous(nm) && ck === normalizeCaptainKey(nm)) {
      row.captainKey = null;
    }
    leaderboardHistory[i] = row;
  }
}

/**
 * One row per captain account (`captainKey`); reclaim offline rows by account key, never by name alone.
 */
function getLeaderboardRowIndex(socketId, capName, accountCaptainKey, shipNameOpt) {
  capName = String(capName || 'Pirate').slice(0, 28);
  const shipSnap = shipNameOpt != null && String(shipNameOpt).trim() !== ''
    ? String(shipNameOpt).slice(0, 28)
    : null;
  const hasReservedAccount = accountCaptainKey != null && String(accountCaptainKey).trim() !== '';
  let rowCaptainKey = null;
  if (hasReservedAccount) {
    rowCaptainKey = normalizeCaptainKey(String(accountCaptainKey)) || null;
  } else if (!captainKeyFromDisplayNameIsAmbiguous(capName)) {
    rowCaptainKey = normalizeCaptainKey(capName) || null;
  }

  let idx = leaderboardHistory.findIndex(r => normalizeLbEntry(r).playerId === socketId);
  if (idx >= 0) {
    const row = normalizeLbEntry(leaderboardHistory[idx]);
    row.playerId = socketId;
    row.name = capName;
    if (rowCaptainKey) row.captainKey = rowCaptainKey;
    if (shipSnap) row.shipName = shipSnap;
    leaderboardHistory[idx] = row;
    return idx;
  }

  if (rowCaptainKey) {
    idx = leaderboardHistory.findIndex(r => {
      const row = normalizeLbEntry(r);
      if (row.captainKey !== rowCaptainKey) return false;
      return row.playerId == null || row.playerId === socketId || !players.has(row.playerId);
    });
    if (idx >= 0) {
      const row = normalizeLbEntry(leaderboardHistory[idx]);
      row.playerId = socketId;
      row.name = capName;
      row.captainKey = rowCaptainKey;
      if (shipSnap) row.shipName = shipSnap;
      leaderboardHistory[idx] = row;
      return idx;
    }
  }

  const row = normalizeLbEntry({ name: capName, playerId: socketId, captainKey: rowCaptainKey, shipName: shipSnap || '' });
  leaderboardHistory.push(row);
  return leaderboardHistory.length - 1;
}

function sortLeaderboardHistory() {
  leaderboardHistory.sort((a, b) => {
    const na = normalizeLbEntry(a);
    const nb = normalizeLbEntry(b);
    const ta = na.sinksAi + na.sinksPlayer + na.ransoms * 0.25 + (na.boardings || 0) * 1.35;
    const tb = nb.sinksAi + nb.sinksPlayer + nb.ransoms * 0.25 + (nb.boardings || 0) * 1.35;
    if (tb !== ta) return tb - ta;
    if (nb.gold !== na.gold) return nb.gold - na.gold;
    return String(na.name).localeCompare(String(nb.name));
  });
}

/** Fold duplicate captain rows (same `captainKey` or same `playerId`) after backfilling keys from display names. */
function reconcileLeaderboardRows() {
  stripMergePoisonousCaptainKeys();
  backfillLeaderboardCaptainKeys();
  linkLeaderboardCaptainKeysByDisplayName();
  mergeLeaderboardByIdentity();
  sortLeaderboardHistory();
  leaderboardHistory = leaderboardHistory.slice(0, LEADERBOARD_CAP);
}

function writeFileAtomic(filePath, dataStr) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(dir, `.${base}.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmp, dataStr, 'utf-8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.copyFileSync(tmp, filePath);
    } catch (e2) {
      throw e2;
    } finally {
      try { fs.unlinkSync(tmp); } catch (e3) {}
    }
  }
}

function parseLeaderboardArrayFromJsonText(t) {
  try {
    const p = JSON.parse(t);
    if (Array.isArray(p)) return p;
    if (p && Array.isArray(p.leaderboard)) return p.leaderboard;
  } catch (e) {}
  return null;
}

function readLeaderboardFileCandidate(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { arr: null, mtime: 0 };
    const st = fs.statSync(filePath);
    const text = fs.readFileSync(filePath, 'utf-8');
    const arr = parseLeaderboardArrayFromJsonText(text);
    return { arr, mtime: st.mtimeMs };
  } catch (e) {
    console.error('[playground] leaderboard read error:', filePath, e.message);
    return { arr: null, mtime: 0 };
  }
}

/** Prefer the longest list; tie-break by newer file mtime. */
function pickBestLeaderboardArrays(candidates) {
  let best = [];
  let bestLen = -1;
  let bestMtime = -1;
  for (const { arr, mtime } of candidates) {
    const a = Array.isArray(arr) ? arr : [];
    const len = a.length;
    const mt = Number(mtime) || 0;
    if (len > bestLen) {
      best = a;
      bestLen = len;
      bestMtime = mt;
    } else if (len === bestLen && len > 0 && mt > bestMtime) {
      best = a;
      bestMtime = mt;
    }
  }
  return best;
}

function collectLeaderboardCandidatesFromDisk(worldRaw, worldMtimeMs) {
  const c = [];
  if (worldRaw && Array.isArray(worldRaw.leaderboard)) {
    c.push({ arr: worldRaw.leaderboard, mtime: worldMtimeMs || 0 });
  }
  c.push(readLeaderboardFileCandidate(LEADERBOARD_FILE));
  c.push(readLeaderboardFileCandidate(LEADERBOARD_SHADOW));
  const lbBesideServer = path.join(__dirname, 'leaderboard.json');
  if (lbBesideServer !== LEADERBOARD_FILE) c.push(readLeaderboardFileCandidate(lbBesideServer));
  return c;
}

function persistWorldSeedFile() {
  const worldPayload = JSON.stringify({ seed: WORLD_SEED, leaderboard: leaderboardHistory, partyStore });
  /** Mirror clans into the same JSON files as leaderboard rows so both survive identical deploy paths. */
  const lbBundle = JSON.stringify({ leaderboard: leaderboardHistory, partyStore });
  try {
    writeFileAtomic(SEED_FILE, worldPayload);
    writeFileAtomic(LEADERBOARD_FILE, lbBundle);
    writeFileAtomic(LEADERBOARD_SHADOW, lbBundle);
  } catch (e) {
    console.error('[playground] persist world/leaderboard failed:', e.message);
  }
}

function migrateLegacyStandaloneLeaderboard() {
  if (leaderboardHistory.length > 0) return;
  const tryPaths = [...new Set([LEADERBOARD_FILE, LEADERBOARD_SHADOW, path.join(__dirname, 'leaderboard.json')])];
  for (const p of tryPaths) {
    try {
      if (!fs.existsSync(p)) continue;
      const lbRaw = fs.readFileSync(p, 'utf-8');
      const arr = parseLeaderboardArrayFromJsonText(lbRaw);
      if (!arr || !arr.length) continue;
      leaderboardHistory = arr.map(normalizeLbEntry);
      persistWorldSeedFile();
      return;
    } catch (e) {}
  }
}

function loadPersistedState() {
  let raw = null;
  let worldMtime = 0;
  const seedFileExists = fs.existsSync(SEED_FILE);
  if (seedFileExists) {
    try {
      worldMtime = fs.statSync(SEED_FILE).mtimeMs;
      const o = JSON.parse(fs.readFileSync(SEED_FILE, 'utf-8'));
      raw = o && typeof o === 'object' ? o : null;
    } catch (e) {
      console.error('[playground] world_seed.json invalid JSON:', e.message);
    }
  }
  if (raw == null) {
    const envS = process.env.WORLD_SEED;
    if (envS != null && String(envS).trim() !== '') {
      WORLD_SEED = Number(envS) >>> 0;
    } else {
      WORLD_SEED = DEFAULT_WORLD_SEED >>> 0;
    }
    const picked = pickBestLeaderboardArrays(collectLeaderboardCandidatesFromDisk(null, 0));
    leaderboardHistory = picked.map(normalizeLbEntry);
    if (!seedFileExists) {
      try {
        persistWorldSeedFile();
      } catch (e2) {}
    }
    migrateLegacyStandaloneLeaderboard();
    return;
  }
  WORLD_SEED = raw.seed != null ? Number(raw.seed) >>> 0 : DEFAULT_WORLD_SEED >>> 0;
  // Merge `world_seed.leaderboard` with standalone files and pick the best copy by length/mtime.
  // Treating repo `leaderboard: []` as sole authority used to wipe live rankings on deploy/restart
  // when longer data existed only in `leaderboard.json` / shadow on disk.
  const picked = pickBestLeaderboardArrays(collectLeaderboardCandidatesFromDisk(raw, worldMtime));
  leaderboardHistory = picked.map(normalizeLbEntry);
  migrateLegacyStandaloneLeaderboard();
  tryMergePartyStoreFromWorldSeedBlob(raw);
}

loadPersistedState();
ensureSimulationLayer();
augmentPartyStoreFromRichestOnDisk();

function validateWorldMapPayload(map) {
  if (!map || typeof map !== 'object') return false;
  if (map.version == null) return false;
  const gn = Number(map.gridN);
  if (!Number.isFinite(gn) || gn < 16 || gn > 768) return false;
  const b64 = map.heightsB64;
  if (typeof b64 !== 'string' || b64.length < 64) return false;
  if (b64.length > 14 * 1024 * 1024) return false;
  return true;
}

function currentWorldMapPayloadOrNull() {
  return WORLD_MAP_PAYLOAD && validateWorldMapPayload(WORLD_MAP_PAYLOAD) ? WORLD_MAP_PAYLOAD : null;
}

function sanitizePlayerQuestsForServer(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const q of arr) {
    if (!q || q.type !== 'hunt' || !q.accepted) continue;
    const target = String(q.target != null ? q.target : '').trim().slice(0, 64);
    if (!target) continue;
    const o = { type: 'hunt', accepted: true, target };
    if (q.huntTargetSyncId != null && Number.isFinite(Number(q.huntTargetSyncId))) o.huntTargetSyncId = Math.floor(Number(q.huntTargetSyncId));
    if (q.huntTargetFaction != null && Number.isFinite(Number(q.huntTargetFaction))) o.huntTargetFaction = Math.floor(Number(q.huntTargetFaction));
    out.push(o);
  }
  return out.slice(0, 24);
}

/** If saved/open-sea coords sit on land or in a tight channel, snap back to deep water. */
function repositionUndockedPlayerIfInShallowLand(p, salt) {
  if (!p || p.docked) return;
  const ctx = createTerrainContext({
    worldSeed: WORLD_SEED >>> 0,
    edgeClamp: PLAYER_WORLD_EDGE_CLAMP,
    worldMapPayload: currentWorldMapPayloadOrNull()
  });
  if (!ctx.dryLandAtWorldPosition(p.x, p.z) && ctx.hasMinClearanceFromLand(p.x, p.z, 52)) return;
  const sp = sampleOffshoreSpawn(ctx, (p.id | 0) ^ (salt | 0));
  p.x = sp.x;
  p.z = sp.z;
  p.rotation = sp.rotation;
}

function readWorldMapDiskBundle(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || !o.map) return null;
    if (!validateWorldMapPayload(o.map)) return null;
    let revision = Number(o.revision) >>> 0;
    if (!revision) revision = 1;
    return { map: o.map, revision, filePath };
  } catch (e) {
    return null;
  }
}

function worldMapSourceRank(p) {
  if (p === WORLD_MAP_FILE) return 0;
  if (p === WORLD_MAP_BESIDE) return 1;
  if (p === WORLD_MAP_BACKUP_FILE) return 2;
  if (p === WORLD_MAP_SHADOW) return 3;
  return 4;
}

function loadWorldMapFromDisk() {
  WORLD_MAP_PAYLOAD = null;
  WORLD_MAP_REVISION = 0;
  const searchPaths = [...new Set([
    WORLD_MAP_FILE,
    WORLD_MAP_BESIDE,
    WORLD_MAP_BACKUP_FILE,
    WORLD_MAP_SHADOW
  ])];
  const candidates = [];
  for (const p of searchPaths) {
    const c = readWorldMapDiskBundle(p);
    if (c) candidates.push(c);
  }
  if (!candidates.length) return;
  candidates.sort((a, b) => {
    if (b.revision !== a.revision) return b.revision - a.revision;
    return worldMapSourceRank(a.filePath) - worldMapSourceRank(b.filePath);
  });
  const picked = candidates[0];
  WORLD_MAP_PAYLOAD = picked.map;
  WORLD_MAP_REVISION = picked.revision;
  if (!WORLD_MAP_REVISION) WORLD_MAP_REVISION = 1;
  if (picked.filePath !== WORLD_MAP_FILE) {
    console.warn('[playground] world map loaded from', picked.filePath, '(primary missing or invalid); rewriting canonical files.');
  }
  try {
    persistWorldMapToDisk();
    lastWorldMapDiskWriteMs = Date.now();
  } catch (e) {}
}

function persistWorldMapToDisk() {
  if (!WORLD_MAP_PAYLOAD || !validateWorldMapPayload(WORLD_MAP_PAYLOAD)) return;
  const bundle = JSON.stringify({
    revision: WORLD_MAP_REVISION,
    updatedAt: Date.now(),
    map: WORLD_MAP_PAYLOAD
  });
  try {
    writeFileAtomic(WORLD_MAP_FILE, bundle);
  } catch (e) {
    console.error('[playground] persist world_map.json failed:', e.message);
    return;
  }
  try {
    writeFileAtomic(WORLD_MAP_SHADOW, bundle);
  } catch (e) {
    console.error('[playground] persist world_map.shadow failed:', e.message);
  }
  if (WORLD_MAP_BESIDE !== WORLD_MAP_FILE) {
    try {
      writeFileAtomic(WORLD_MAP_BESIDE, bundle);
    } catch (e) {
      console.error('[playground] persist world_map (beside server) failed:', e.message);
    }
  }
}

function setWorldMapAndBroadcast(mapObj) {
  if (!validateWorldMapPayload(mapObj)) return false;
  if (WORLD_MAP_PAYLOAD && validateWorldMapPayload(WORLD_MAP_PAYLOAD) && (WORLD_MAP_REVISION >>> 0) > 0) {
    try {
      writeFileAtomic(WORLD_MAP_BACKUP_FILE, JSON.stringify({
        revision: WORLD_MAP_REVISION >>> 0,
        updatedAt: Date.now(),
        map: WORLD_MAP_PAYLOAD
      }));
    } catch (e) {
      console.error('[playground] world_map.prev backup failed:', e.message);
    }
  }
  WORLD_MAP_PAYLOAD = mapObj;
  WORLD_MAP_REVISION = (WORLD_MAP_REVISION >>> 0) + 1;
  if (!WORLD_MAP_REVISION) WORLD_MAP_REVISION = 1;
  persistWorldMapToDisk();
  lastWorldMapDiskWriteMs = Date.now();
  broadcastAll({ type: 'world_map', revision: WORLD_MAP_REVISION });
  try {
    ensureNpcWorld();
    if (npcWorld && typeof npcWorld.setWorldMapPayload === 'function') {
      npcWorld.setWorldMapPayload(currentWorldMapPayloadOrNull());
      npcWorld.reset(players);
    }
  } catch (e) {}
  return true;
}

function revertWorldMapFromBackupAndBroadcast() {
  try {
    if (!fs.existsSync(WORLD_MAP_BACKUP_FILE)) return false;
    const raw = fs.readFileSync(WORLD_MAP_BACKUP_FILE, 'utf8');
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || !o.map) return false;
    if (!validateWorldMapPayload(o.map)) return false;
    WORLD_MAP_PAYLOAD = o.map;
    WORLD_MAP_REVISION = (WORLD_MAP_REVISION >>> 0) + 1;
    if (!WORLD_MAP_REVISION) WORLD_MAP_REVISION = 1;
    persistWorldMapToDisk();
    lastWorldMapDiskWriteMs = Date.now();
    broadcastAll({ type: 'world_map', revision: WORLD_MAP_REVISION });
    try {
      ensureNpcWorld();
      if (npcWorld && typeof npcWorld.setWorldMapPayload === 'function') {
        npcWorld.setWorldMapPayload(currentWorldMapPayloadOrNull());
        npcWorld.reset(players);
      }
    } catch (e2) {}
    return true;
  } catch (e) {
    console.error('[playground] world_map revert failed:', e.message);
    return false;
  }
}

loadWorldMapFromDisk();
reconcileLeaderboardRows();
leaderboardClientSeeded = leaderboardHistory.length > 0;
/** Old `world_seed.json` / repo snapshots often omitted `partyStore`; re-bundle so clans survive the same deploy path as scores. */
if (leaderboardHistory.length > 0 || Object.keys(partyStore.parties || {}).length > 0) {
  try {
    persistWorldSeedFile();
  } catch (e) {}
}

setInterval(() => {
  try {
    scheduleIdlePersistedStateFlush();
  } catch (e) {}
}, SERVER_STATE_SAVE_INTERVAL_MS);

function flushAllPersistedStateSync() {
  try {
    savePartyStore();
    flushCaptainAccountsIfDirty();
    saveWorldPresenceIfDirty();
    saveBans();
    if (WORLD_MAP_PAYLOAD && validateWorldMapPayload(WORLD_MAP_PAYLOAD) && (WORLD_MAP_REVISION >>> 0) > 0) {
      persistWorldMapToDisk();
      lastWorldMapDiskWriteMs = Date.now();
    }
  } catch (e) {
    console.error('[playground] flushAllPersistedStateSync:', e.message);
  }
}
process.on('beforeExit', flushAllPersistedStateSync);
process.on('SIGTERM', () => {
  flushAllPersistedStateSync();
  process.exit(0);
});
process.on('SIGINT', () => {
  flushAllPersistedStateSync();
  process.exit(0);
});

/** Keeps parties.json / shadows in lockstep with leaderboard.json (same bundle as persistWorldSeedFile). */
function saveLeaderboard() {
  savePartyStore();
}

/** After F3 navigator mutations: flush everything durable so the next process start matches what the dev saw. */
function flushNavigatorMutationToDisk() {
  try {
    savePartyStore();
    flushCaptainAccountsIfDirty();
    saveWorldPresenceIfDirty();
    saveBans();
    if (WORLD_MAP_PAYLOAD && validateWorldMapPayload(WORLD_MAP_PAYLOAD) && (WORLD_MAP_REVISION >>> 0) > 0) {
      persistWorldMapToDisk();
      lastWorldMapDiskWriteMs = Date.now();
    }
  } catch (e) {}
}

function loadBans() {
  try {
    const raw = fs.readFileSync(BANS_FILE, 'utf-8');
    const o = JSON.parse(raw);
    const arr = Array.isArray(o.ips) ? o.ips : Array.isArray(o) ? o : [];
    bannedIps = new Set(arr.map(x => String(x || '').trim()).filter(Boolean));
  } catch (e) {
    bannedIps = new Set();
  }
}
function saveBans() {
  try {
    fs.writeFileSync(BANS_FILE, JSON.stringify({ ips: Array.from(bannedIps) }));
  } catch (e) {}
}
loadBans();

const CAPTAIN_ACCOUNTS_FILE = path.join(DATA_DIR, 'captain_accounts.json');
const CAPTAIN_ACCOUNT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** @type {Record<string, { token: string, displayName: string, lastActiveMs: number }>} */
let captainAccounts = {};
let captainAccountsDirty = false;

function normalizeCaptainKey(name) {
  return String(name || '').trim().toLowerCase().slice(0, 28);
}

function secureTokenEquals(a, b) {
  try {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  } catch (e) {
    return false;
  }
}

/** Same captain token may map to a different normalized key after a display-name change; remap clan rows so getPartyForCaptainKey(newKey) works on reconnect. */
function findCaptainKeyByToken(token) {
  if (!token || typeof token !== 'string') return null;
  let found = null;
  for (const [k, a] of Object.entries(captainAccounts)) {
    if (!a || typeof a.token !== 'string') continue;
    try {
      if (secureTokenEquals(a.token, token)) {
        if (found) return null;
        found = k;
      }
    } catch (e) {}
  }
  return found;
}

/** @returns {boolean} false if newKey is already indexed to a different clan (data conflict). */
function remapCaptainAccountKeyInParties(oldKey, newKey) {
  if (!oldKey || !newKey || oldKey === newKey) return true;
  const pidOld = partyStore.captainParty[oldKey];
  const pidNew = partyStore.captainParty[newKey];
  if (pidNew != null && pidOld != null && pidNew !== pidOld) return false;
  if (pidNew != null && pidOld == null) return false;
  let touched = false;
  for (const pr of Object.values(partyStore.parties)) {
    if (!pr) continue;
    migratePartyRecord(pr);
    if (pr.leaderKey === oldKey) {
      pr.leaderKey = newKey;
      touched = true;
    }
    if (Array.isArray(pr.memberKeys)) {
      const i = pr.memberKeys.indexOf(oldKey);
      if (i !== -1) {
        if (pr.memberKeys.includes(newKey)) pr.memberKeys.splice(i, 1);
        else pr.memberKeys[i] = newKey;
        touched = true;
      }
    }
    if (Array.isArray(pr.officerKeys)) {
      const i = pr.officerKeys.indexOf(oldKey);
      if (i !== -1) {
        if (pr.officerKeys.includes(newKey)) pr.officerKeys.splice(i, 1);
        else pr.officerKeys[i] = newKey;
        touched = true;
      }
    }
    if (Array.isArray(pr.pendingKeys)) {
      const i = pr.pendingKeys.indexOf(oldKey);
      if (i !== -1) {
        if (pr.pendingKeys.includes(newKey)) pr.pendingKeys.splice(i, 1);
        else pr.pendingKeys[i] = newKey;
        touched = true;
      }
    }
    if (pr.pendingInviteFrom && pr.pendingInviteFrom[oldKey]) {
      const meta = pr.pendingInviteFrom[oldKey];
      delete pr.pendingInviteFrom[oldKey];
      if (!pr.pendingInviteFrom[newKey]) pr.pendingInviteFrom[newKey] = meta;
      touched = true;
    }
  }
  if (pidOld) {
    delete partyStore.captainParty[oldKey];
    partyStore.captainParty[newKey] = pidOld;
    touched = true;
  }
  if (touched) savePartyStore();
  return true;
}

const WORLD_PRESENCE_FILE = path.join(DATA_DIR, 'world_presence.json');
/** Last known open-sea state per registered captain (MMO resume / crash recovery). */
let worldPresenceStore = { v: 1, captains: {} };
let worldPresenceDirty = false;

function loadWorldPresence() {
  try {
    const raw = fs.readFileSync(WORLD_PRESENCE_FILE, 'utf-8');
    const o = JSON.parse(raw);
    if (o && typeof o.captains === 'object') worldPresenceStore = { v: 1, captains: { ...o.captains } };
    else worldPresenceStore = { v: 1, captains: {} };
  } catch (e) {
    worldPresenceStore = { v: 1, captains: {} };
  }
}

function saveWorldPresenceIfDirty() {
  if (!worldPresenceDirty) return;
  try {
    writeFileAtomic(WORLD_PRESENCE_FILE, JSON.stringify(worldPresenceStore));
    worldPresenceDirty = false;
  } catch (e) {}
}

function persistCaptainWorldPresenceFromPlayer(captainKey, p) {
  if (!captainKey || !p) return;
  if (p.docked) return;
  const ck = normalizeCaptainKey(String(captainKey));
  if (!ck) return;
  const cx = clampPlayerWorldX(p.x);
  const cz = clampPlayerWorldX(p.z);
  if (cx == null || cz == null) return;
  worldPresenceStore.captains[ck] = {
    savedAtMs: Date.now(),
    worldSeed: WORLD_SEED >>> 0,
    worldMapRevision: WORLD_MAP_REVISION >>> 0,
    x: cx,
    z: cz,
    rotation: p.rotation,
    docked: !!p.docked,
    dockX: p.dockX != null ? p.dockX : null,
    dockZ: p.dockZ != null ? p.dockZ : null,
    dockAngle: p.dockAngle != null ? p.dockAngle : null,
    dockBerthIndex: p.dockBerthIndex != null ? p.dockBerthIndex : null,
    shipType: p.shipType != null ? String(p.shipType).slice(0, 24) : 'cutter',
    shipName: p.shipName != null ? String(p.shipName).slice(0, 28) : '',
    shipParts: p.shipParts && typeof p.shipParts === 'object' ? { ...p.shipParts } : { hull: 'basic', sail: 'basic', cannon: 'light', figurehead: 'none', flag: 'mast' },
    health: p.health,
    riggingHealth: p.riggingHealth != null ? p.riggingHealth : 100,
    morale: p.morale != null ? p.morale : 100,
    flagAssetId: p.flagAssetId,
    flagColor: p.flagColor != null ? String(p.flagColor).slice(0, 32) : '#1a1a1a'
  };
  worldPresenceDirty = true;
}

/** @returns {object|null} payload for `world_resume` */
function tryApplyWorldPresenceToPlayer(captainKey, p) {
  const ck = normalizeCaptainKey(String(captainKey || ''));
  if (!ck || !p) return null;
  const raw = worldPresenceStore.captains[ck];
  if (!raw || typeof raw !== 'object') return null;
  if ((raw.worldSeed >>> 0) !== (WORLD_SEED >>> 0)) return null;
  if ((raw.worldMapRevision >>> 0) !== (WORLD_MAP_REVISION >>> 0)) return null;
  const x = clampPlayerWorldX(raw.x);
  const z = clampPlayerWorldX(raw.z);
  if (x == null || z == null) return null;
  p.x = x;
  p.z = z;
  if (raw.rotation != null && Number.isFinite(Number(raw.rotation))) p.rotation = Number(raw.rotation);
  p.speed = 0;
  if (raw.docked != null) p.docked = !!raw.docked;
  if (raw.dockX !== undefined) p.dockX = raw.dockX;
  if (raw.dockZ !== undefined) p.dockZ = raw.dockZ;
  if (raw.dockAngle !== undefined) p.dockAngle = raw.dockAngle;
  if (raw.dockBerthIndex !== undefined) p.dockBerthIndex = raw.dockBerthIndex;
  if (raw.shipType) {
    const st = String(raw.shipType).trim().slice(0, 24);
    if (st) p.shipType = st;
  }
  if (raw.shipName != null) p.shipName = String(raw.shipName).slice(0, 28);
  if (raw.shipParts && typeof raw.shipParts === 'object') {
    p.shipParts = {
      hull: 'basic', sail: 'basic', cannon: 'light', figurehead: 'none', flag: 'mast',
      ...p.shipParts,
      ...raw.shipParts
    };
  }
  if (raw.health != null && Number.isFinite(Number(raw.health))) p.health = Math.max(-20, Math.min(9999, Number(raw.health)));
  if (raw.riggingHealth != null) p.riggingHealth = Math.max(0, Math.min(100, Number(raw.riggingHealth) || 0));
  if (raw.morale != null) p.morale = Math.max(0, Math.min(100, Number(raw.morale) || 0));
  if (raw.flagAssetId !== undefined) {
    if (raw.flagAssetId === null) p.flagAssetId = null;
    else {
      const fa = sanitizeClientFlagAssetId(raw.flagAssetId);
      if (fa != null) p.flagAssetId = fa;
    }
  }
  if (raw.flagColor != null) p.flagColor = String(raw.flagColor).slice(0, 32);
  repositionUndockedPlayerIfInShallowLand(p, 0x5eede1);
  return {
    x: p.x, z: p.z, rotation: p.rotation,
    docked: !!p.docked,
    dockX: p.dockX, dockZ: p.dockZ, dockAngle: p.dockAngle, dockBerthIndex: p.dockBerthIndex,
    shipType: p.shipType, shipName: p.shipName,
    shipParts: p.shipParts ? { ...p.shipParts } : null,
    health: p.health, riggingHealth: p.riggingHealth, morale: p.morale,
    flagAssetId: p.flagAssetId, flagColor: p.flagColor
  };
}

function loadCaptainAccounts() {
  try {
    const raw = fs.readFileSync(CAPTAIN_ACCOUNTS_FILE, 'utf-8');
    const o = JSON.parse(raw);
    const acc = o && typeof o.accounts === 'object' ? o.accounts : null;
    captainAccounts = acc && typeof acc === 'object' ? acc : {};
  } catch (e) {
    captainAccounts = {};
  }
}

function saveCaptainAccounts() {
  try {
    fs.writeFileSync(CAPTAIN_ACCOUNTS_FILE, JSON.stringify({ accounts: captainAccounts }));
    captainAccountsDirty = false;
  } catch (e) {}
}

function pruneStaleCaptainAccounts() {
  const now = Date.now();
  let changed = false;
  for (const k of Object.keys(captainAccounts)) {
    const a = captainAccounts[k];
    if (!a || now - (a.lastActiveMs || 0) > CAPTAIN_ACCOUNT_TTL_MS) {
      delete captainAccounts[k];
      changed = true;
    }
  }
  if (changed) saveCaptainAccounts();
  return changed;
}

function markCaptainAccountsDirty() {
  captainAccountsDirty = true;
}

function flushCaptainAccountsIfDirty() {
  if (!captainAccountsDirty) return;
  saveCaptainAccounts();
}

loadCaptainAccounts();
loadWorldPresence();
pruneStaleCaptainAccounts();
setInterval(() => {
  pruneStaleCaptainAccounts();
}, 60 * 60 * 1000);
function persistLeaderboardShutdown() {
  saveLeaderboard();
}
function persistCaptainAccountsShutdown() {
  flushCaptainAccountsIfDirty();
}
function persistPartiesShutdown() {
  try {
    savePartyStore();
  } catch (e) {}
}
process.on('SIGINT', () => {
  persistLeaderboardShutdown();
  persistCaptainAccountsShutdown();
  persistPartiesShutdown();
});
process.on('SIGTERM', () => {
  persistLeaderboardShutdown();
  persistCaptainAccountsShutdown();
  persistPartiesShutdown();
});

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function setWorldSeedAndPersist(newSeed) {
  WORLD_SEED = Number(newSeed) >>> 0;
  ensureSimulationLayer();
  gameSim.setWorldSeed(WORLD_SEED >>> 0);
  try {
    ensureWorldPolitics().resetToSeed(WORLD_SEED >>> 0);
  } catch (e) {}
  persistWorldSeedFile();
  const wt = (Date.now() - SERVER_WORLD_T0_MS) / 1000;
  broadcastAll({ type: 'world_seed', seed: WORLD_SEED, worldT: wt, wildlifeWorldT: wt });
  if (npcWorld) {
    npcWorld.setWorldSeed(WORLD_SEED >>> 0);
    npcWorld.reset(players);
  }
}

/** Static game assets (audio, models, maps). Render/VPS hosts must serve these; SPA fallback is only on Vercel. */
const ASSETS_ROOT = path.resolve(__dirname, 'assets');
function mimeTypeForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.json': 'application/json; charset=utf-8',
    '.woff2': 'font/woff2',
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.ico': 'image/x-icon',
    '.md': 'text/markdown; charset=utf-8'
  };
  return map[ext] || 'application/octet-stream';
}
function sendAssetFile(filePath, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
      res.end('Error reading file');
      return;
    }
    res.writeHead(200, {
      'Content-Type': mimeTypeForFile(filePath),
      'Cache-Control': 'public, max-age=3600',
      ...CORS_HEADERS
    });
    res.end(data);
  });
}
/** GET /assets/... only; blocks path traversal. */
function tryServeGameAssets(reqPath, res) {
  if (!reqPath.startsWith('/assets/')) return false;
  const rel = reqPath.slice(1);
  const resolved = path.resolve(__dirname, rel);
  const prefix = ASSETS_ROOT + path.sep;
  if (resolved !== ASSETS_ROOT && !resolved.startsWith(prefix)) {
    res.writeHead(403, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
    res.end('Forbidden');
    return true;
  }
  fs.stat(resolved, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
      res.end('Not found');
      return;
    }
    sendAssetFile(resolved, res);
  });
  return true;
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/navigator-auth') {
    readJsonBody(req).then(body => {
      if (!verifyNavigatorPassword(body.password)) {
        res.writeHead(401, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ ok: false, error: 'Invalid password or navigator admin not configured on server.' }));
        return;
      }
      pruneAdminSessions();
      const token = crypto.randomBytes(32).toString('hex');
      adminSessions.set(token, Date.now() + ADMIN_SESSION_MS);
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: true, token, expiresInSec: Math.floor(ADMIN_SESSION_MS / 1000) }));
    }).catch(() => {
      res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: false, error: 'Bad request' }));
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/world-map') {
    if (!WORLD_MAP_PAYLOAD || !WORLD_MAP_REVISION) {
      res.writeHead(404, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: false, error: 'No world map published' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ ok: true, revision: WORLD_MAP_REVISION, map: WORLD_MAP_PAYLOAD }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/world-map') {
    readJsonBody(req, 32 * 1024 * 1024).then(body => {
      pruneAdminSessions();
      const token = body.token;
      const exp = token ? adminSessions.get(token) : 0;
      if (!token || !exp || exp <= Date.now()) {
        res.writeHead(401, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ ok: false, error: 'Session expired or missing. Unlock the navigator console again.' }));
        return;
      }
      const mapObj = body.map;
      if (!validateWorldMapPayload(mapObj)) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ ok: false, error: 'Invalid map (need version, gridN 16–768, heightsB64).' }));
        return;
      }
      if (!setWorldMapAndBroadcast(mapObj)) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ ok: false, error: 'Could not persist world map.' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: true, revision: WORLD_MAP_REVISION }));
    }).catch(e => {
      const tooBig = e && String(e.message || '').includes('too large');
      res.writeHead(tooBig ? 413 : 400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: false, error: tooBig ? 'Map JSON too large' : 'Bad request' }));
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/world-map-revert') {
    readJsonBody(req).then(body => {
      pruneAdminSessions();
      const token = body.token;
      const exp = token ? adminSessions.get(token) : 0;
      if (!token || !exp || exp <= Date.now()) {
        res.writeHead(401, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ ok: false, error: 'Session expired or missing. Unlock the navigator console again.' }));
        return;
      }
      if (!revertWorldMapFromBackupAndBroadcast()) {
        res.writeHead(404, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ ok: false, error: 'No previous chart on disk (nothing published yet, or backup missing).' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: true, revision: WORLD_MAP_REVISION }));
    }).catch(() => {
      res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: false, error: 'Bad request' }));
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/world-seed') {
    readJsonBody(req).then(body => {
      pruneAdminSessions();
      const token = body.token;
      const exp = token ? adminSessions.get(token) : 0;
      if (!token || !exp || exp <= Date.now()) {
        res.writeHead(401, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ ok: false, error: 'Session expired or missing. Unlock the navigator console again.' }));
        return;
      }
      const seed = Number(body.seed);
      if (!Number.isFinite(seed)) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ ok: false, error: 'Invalid seed' }));
        return;
      }
      setWorldSeedAndPersist(seed >>> 0);
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: true, seed: WORLD_SEED }));
    }).catch(() => {
      res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: false, error: 'Bad request' }));
    });
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({
      status: 'ok',
      players: players.size,
      seed: WORLD_SEED,
      worldMapRevision: WORLD_MAP_REVISION >>> 0,
      navigatorAuthConfigured: !!(NAVIGATOR_ADMIN_PASSWORD && String(NAVIGATOR_ADMIN_PASSWORD).length > 0),
      realm: getRealmConfig(),
      maxPlayers: MAX_CONCURRENT_CAPTAINS > 0 ? MAX_CONCURRENT_CAPTAINS : null,
      registeredCaptains: Object.keys(captainAccounts || {}).length,
      aoiRadius: STATE_AOI_RADIUS
    }));
    return;
  }

  const reqPath = String(req.url || '').split('?')[0];
  if (req.method === 'GET' && reqPath === '/api/realm') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({
      realm: getRealmConfig(),
      online: players.size,
      registered: Object.keys(captainAccounts || {}).length,
      seed: WORLD_SEED,
      worldMapRevision: WORLD_MAP_REVISION >>> 0,
      maxPlayers: MAX_CONCURRENT_CAPTAINS > 0 ? MAX_CONCURRENT_CAPTAINS : null,
      aoiRadius: STATE_AOI_RADIUS
    }));
    return;
  }
  if (req.method === 'GET' && (reqPath === '/favicon.ico' || reqPath === '/favicon.svg')) {
    const sendSvg = (buf) => {
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
        ...CORS_HEADERS
      });
      res.end(buf);
    };
    if (reqPath === '/favicon.svg') {
      const fp = path.join(__dirname, 'favicon.svg');
      fs.readFile(fp, (err, data) => {
        if (!err && data && data.length) {
          sendSvg(data);
          return;
        }
        const fallback = Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
          + '<rect width="32" height="32" rx="5" fill="#1a140c"/>'
          + '<path fill="#d4a848" d="M16 5l2.2 7.2H26l-5.8 4.4L22.4 26 16 21.7 9.6 26l2.2-9.4L6 12.2h7.8L16 5z"/>'
          + '</svg>'
        );
        sendSvg(fallback);
      });
      return;
    }
    const flagPng = path.join(__dirname, 'assets', 'flags', 'flag23.png');
    fs.readFile(flagPng, (err, data) => {
      if (!err && data && data.length) {
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400',
          ...CORS_HEADERS
        });
        res.end(data);
        return;
      }
      const svg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
        + '<rect width="32" height="32" rx="5" fill="#1a140c"/>'
        + '<path fill="#d4a848" d="M16 5l2.2 7.2H26l-5.8 4.4L22.4 26 16 21.7 9.6 26l2.2-9.4L6 12.2h7.8L16 5z"/>'
        + '</svg>'
      );
      sendSvg(svg);
    });
    return;
  }

  if (req.method === 'GET' && tryServeGameAssets(reqPath, res)) return;

  if (req.url === '/' || req.url === '/index.html' || req.url.startsWith('/index.html?')) {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('Error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html', ...CORS_HEADERS });
      res.end(data);
    });
    return;
  }
  if (req.url === '/map-editor.html' || req.url.startsWith('/map-editor.html?')) {
    fs.readFile(path.join(__dirname, 'map-editor.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('Error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html', ...CORS_HEADERS });
      res.end(data);
    });
    return;
  }
  if (req.url === '/editor-ship-builders.js' || req.url.startsWith('/editor-ship-builders.js?')) {
    fs.readFile(path.join(__dirname, 'editor-ship-builders.js'), (err, data) => {
      if (err) { res.writeHead(500); res.end('Error'); return; }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', ...CORS_HEADERS });
      res.end(data);
    });
    return;
  }
  res.writeHead(404, CORS_HEADERS);
  res.end('Not found');
});

const _wsMaxPayload = Number(process.env.WS_MAX_PAYLOAD);
const wss = new WebSocketServer({
  server,
  perMessageDeflate: false,
  maxPayload: Number.isFinite(_wsMaxPayload) && _wsMaxPayload > 0 ? _wsMaxPayload : 16 * 1024 * 1024
});

function broadcast(data, excludeId) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1 && client.playerId !== excludeId) {
      client.send(msg);
    }
  });
}

function broadcastAll(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

/** Legacy no-op: NPC simulation runs on the server (`server/npc-authoritative.cjs`). */
function sendNpcSimulationDelegates() {}

function serverPopulationPayload() {
  return {
    type: 'server_pop',
    online: players.size,
    registered: Object.keys(captainAccounts || {}).length,
    realm: getRealmConfig(),
    maxPlayers: MAX_CONCURRENT_CAPTAINS > 0 ? MAX_CONCURRENT_CAPTAINS : null
  };
}

/** Broadcast online / registered captain counts (chat header). */
function broadcastServerPopulation() {
  try {
    broadcastAll(serverPopulationPayload());
  } catch (e) {}
}

function normalizeClientIp(req) {
  let ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip || 'unknown';
}

function isNavigatorAdminTokenOk(token) {
  if (!token || typeof token !== 'string') return false;
  pruneAdminSessions();
  const exp = adminSessions.get(token);
  return !!(exp && exp > Date.now());
}

function findWsByPlayerId(pid) {
  for (const c of wss.clients) {
    if (c.readyState === 1 && c.playerId === pid) return c;
  }
  return null;
}

function findWsByCaptainKey(ck) {
  if (!ck) return null;
  const pid = findPlayerIdByCaptainKey(ck);
  return pid != null ? findWsByPlayerId(pid) : null;
}

function clearCaptainSocketSlot(ws) {
  if (!ws) return;
  for (const [ck, cws] of captainSocketByKey) {
    if (cws === ws) captainSocketByKey.delete(ck);
  }
}

function closeWsWithSessionReplaced(ow, reason) {
  if (!ow || ow.readyState !== 1) return;
  const text = reason || 'This captain signed in from another browser or tab. Only one session may sail at a time.';
  try {
    ow.send(JSON.stringify({ type: 'session_replaced', reason: text }));
  } catch (e) {}
  try {
    ow.close(4000, 'session_replaced');
  } catch (e) {}
}

/** End any other connection for this captain; then claim `ws` as the active session. */
function registerCaptainSessionSocket(ws, playerId, oldCaptainKey, newCaptainKey) {
  if (!ws || !newCaptainKey) return;
  const nck = normalizeCaptainKey(String(newCaptainKey));
  if (!nck) return;
  if (oldCaptainKey) {
    const ock = normalizeCaptainKey(String(oldCaptainKey));
    if (ock && captainSocketByKey.get(ock) === ws) captainSocketByKey.delete(ock);
  }
  const dupPid = findPlayerIdByCaptainKey(nck);
  if (dupPid != null && dupPid !== playerId) {
    const ow = findWsByPlayerId(dupPid);
    if (ow && ow !== ws) closeWsWithSessionReplaced(ow);
  }
  const prevWs = captainSocketByKey.get(nck);
  if (prevWs && prevWs !== ws) closeWsWithSessionReplaced(prevWs);
  captainSocketByKey.set(nck, ws);
}

function storyProgressRank(st) {
  if (!st || typeof st !== 'object') return -1;
  const ph = String(st.phase || 'intro');
  const step = Math.max(0, Math.min(99, Math.floor(Number(st.step) || 0)));
  const tier = ph === 'complete' ? 4 : ph === 'report' ? 3 : ph === 'active' ? 2 : ph === 'intro' ? 1 : 0;
  return tier * 100 + step;
}

function sanitizeWorldStory(st) {
  const def = {
    phase: 'intro',
    step: 0,
    turnInCx: null,
    turnInCz: null,
    turnInTown: null,
    bountyX: null,
    bountyZ: null,
    bountyRot: null
  };
  if (!st || typeof st !== 'object') return { ...def };
  const phase = ['intro', 'active', 'report', 'complete'].includes(String(st.phase)) ? String(st.phase) : 'intro';
  const step = Math.max(0, Math.min(10, Math.floor(Number(st.step) || 0)));
  return {
    phase,
    step,
    turnInCx: st.turnInCx != null && Number.isFinite(Number(st.turnInCx)) ? Math.floor(Number(st.turnInCx)) : null,
    turnInCz: st.turnInCz != null && Number.isFinite(Number(st.turnInCz)) ? Math.floor(Number(st.turnInCz)) : null,
    turnInTown: st.turnInTown != null ? String(st.turnInTown).slice(0, 48) : null,
    bountyX: st.bountyX != null && Number.isFinite(Number(st.bountyX)) ? Number(st.bountyX) : null,
    bountyZ: st.bountyZ != null && Number.isFinite(Number(st.bountyZ)) ? Number(st.bountyZ) : null,
    bountyRot: st.bountyRot != null && Number.isFinite(Number(st.bountyRot)) ? Number(st.bountyRot) : null
  };
}

function mergeWorldStory(cur, inc) {
  const a = sanitizeWorldStory(cur);
  const b = sanitizeWorldStory(inc);
  const ra = storyProgressRank(a);
  const rb = storyProgressRank(b);
  if (rb > ra) return b;
  if (rb < ra) return a;
  if (b.bountyX != null && b.bountyZ != null && (a.bountyX == null || a.bountyZ == null)) return { ...a, ...b };
  return a;
}

function sanitizeWorldQuests(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (let i = 0; i < arr.length && out.length < 12; i++) {
    const q = arr[i];
    if (!q || typeof q !== 'object') continue;
    const type = q.type === 'hunt' || q.type === 'delivery' ? q.type : null;
    if (!type) continue;
    const row = {
      type,
      desc: String(q.desc != null ? q.desc : '').slice(0, 220),
      reward: Math.max(0, Math.floor(Number(q.reward) || 0)),
      accepted: !!q.accepted
    };
    if (type === 'hunt') row.target = String(q.target != null ? q.target : '').slice(0, 48);
    if (type === 'delivery') {
      row.item = String(q.item != null ? q.item : 'wood').slice(0, 24);
      row.count = Math.max(1, Math.min(99, Math.floor(Number(q.count) || 1)));
      row.originCx = q.originCx != null ? Math.floor(Number(q.originCx)) : null;
      row.originCz = q.originCz != null ? Math.floor(Number(q.originCz)) : null;
      row.originTown = q.originTown != null ? String(q.originTown).slice(0, 48) : '';
      row.destCx = q.destCx != null ? Math.floor(Number(q.destCx)) : null;
      row.destCz = q.destCz != null ? Math.floor(Number(q.destCz)) : null;
      row.destTown = q.destTown != null ? String(q.destTown).slice(0, 48) : '';
      row.destDockX = q.destDockX != null ? Number(q.destDockX) : null;
      row.destDockZ = q.destDockZ != null ? Number(q.destDockZ) : null;
    }
    out.push(row);
  }
  return out;
}

function collectAdminPlayerList() {
  const out = [];
  for (const c of wss.clients) {
    if (c.readyState !== 1) continue;
    const pid = c.playerId;
    if (pid == null) continue;
    const p = players.get(pid);
    if (!p) continue;
    out.push({
      id: pid,
      name: p.name || 'Unknown',
      x: p.x,
      z: p.z,
      ip: c.clientIp || '',
      muted: mutedPlayerIds.has(pid)
    });
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const clientIp = normalizeClientIp(req);
  ws.clientIp = clientIp;
  if (bannedIps.has(clientIp)) {
    try {
      ws.send(JSON.stringify({ type: 'banned', reason: 'You are banned from this server.' }));
    } catch (e) {}
    ws.close();
    return;
  }
  if (MAX_CONCURRENT_CAPTAINS > 0) {
    let n = 0;
    for (const c of wss.clients) {
      if (c.readyState === 1) n++;
    }
    if (n > MAX_CONCURRENT_CAPTAINS) {
      try {
        ws.send(JSON.stringify({
          type: 'server_full',
          message: 'This realm is at capacity. Try again in a moment.',
          realm: getRealmConfig(),
          max: MAX_CONCURRENT_CAPTAINS
        }));
      } catch (e) {}
      try {
        ws.close();
      } catch (e2) {}
      return;
    }
  }

  const id = nextId++;
  ws.playerId = id;

  const spawnCtx = createTerrainContext({
    worldSeed: WORLD_SEED >>> 0,
    edgeClamp: PLAYER_WORLD_EDGE_CLAMP,
    worldMapPayload: currentWorldMapPayloadOrNull()
  });
  const sp0 = sampleOffshoreSpawn(spawnCtx, id);

  const playerData = {
    id,
    x: sp0.x,
    z: sp0.z,
    rotation: sp0.rotation,
    speed: 0,
    shipType: 'cutter',
    shipName: '',
    shipParts: { hull: 'basic', sail: 'basic', cannon: 'light', figurehead: 'none', flag: 'mast' },
    flagColor: '#1a1a1a',
    flagAssetId: null,
    color: `hsl(${Math.random() * 360}, 70%, 50%)`,
    name: `Pirate_${id}`,
    health: 100,
    crewCount: 3,
    crewData: null,
    docked: false,
    dockX: null,
    dockZ: null,
    dockAngle: null,
    dockBerthIndex: null,
    riggingHealth: 100,
    morale: 100,
    deckWalk: null,
    boarding: null,
    partyTag: '',
    clientIp,
    rtt: null,
    lastNetSeq: 0,
    hullBanner: null,
    sailBanner: null
  };

  players.set(id, playerData);

  const storySnap = [];
  for (const [pid, st] of playerStories) {
    storySnap.push({ playerId: pid, story: sanitizeWorldStory(st) });
  }
  let partyPayload = null;
  const myCkInit = ws.captainAccountKey || null;
  if (myCkInit) {
    const pr = getPartyForCaptainKey(myCkInit);
    if (pr) partyPayload = buildPartySyncPayload(pr, myCkInit);
  }
  const initWorldT = (Date.now() - SERVER_WORLD_T0_MS) / 1000;
  const wpSnap = ensureWorldPolitics().snapshot();
  const politicsWorldPayload = {
    matrix: wpSnap.matrix,
    fw: wpSnap.factionWealth,
    pc: wpSnap.portController,
    inf: wpSnap.inflation,
    pg: wpSnap.portGarrison
  };
  ws.send(JSON.stringify({
    type: 'init',
    id,
    seed: WORLD_SEED,
    worldT: initWorldT,
    wildlifeWorldT: initWorldT,
    worldMapRevision: WORLD_MAP_REVISION >>> 0,
    player: playerData,
    players: Array.from(players.values()).filter(p => p.id !== id && playerIncludedInSnapshot(playerData, p, STATE_AOI_RADIUS_SQ)),
    worldStory: sanitizeWorldStory(worldStoryQuest),
    worldQuests: null,
    playerStories: storySnap,
    party: partyPayload,
    politicsWorld: politicsWorldPayload,
    myPlayerPolitics: ensureWorldPolitics().getPlayerStanding(id),
    npcSimFromServer: true,
    youAreNpcStepper: false,
    serverPop: {
      online: players.size,
      registered: Object.keys(captainAccounts || {}).length,
      realm: getRealmConfig(),
      maxPlayers: MAX_CONCURRENT_CAPTAINS > 0 ? MAX_CONCURRENT_CAPTAINS : null
    }
  }));
  reconcileLeaderboardRows();
  ws.send(JSON.stringify({ type: 'leaderboard', entries: leaderboardHistory }));

  const myCkChat = ws.captainAccountKey || null;
  const myPartyForChat = myCkChat ? getPartyForCaptainKey(myCkChat) : null;
  for (const m of chatHistory.slice(-40)) {
    if (m.channel === 'party') {
      if (!myPartyForChat || m.partyId !== myPartyForChat.id) continue;
    }
    try {
      ws.send(JSON.stringify({
        type: 'chat',
        chatId: m.id,
        id: m.playerId,
        name: m.name,
        text: m.text,
        channel: m.channel || 'global',
        partyId: m.partyId || null,
        partyTag: m.partyTag || '',
        clanTag: m.clanTag != null ? String(m.clanTag).slice(0, 24) : ''
      }));
    } catch (e) {}
  }

  broadcast({ type: 'player_join', player: playerData }, id);
  broadcastServerPopulation();
  sendNpcSimulationDelegates();

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      switch (msg.type) {
        case 'update': {
          const p = players.get(id);
          if (!p) break;
          ensureSimulationLayer();
          if (!antiCheat.allowUpdateMessage(ws)) break;
          if (msg.seq != null && Number.isFinite(Number(msg.seq))) {
            const ns = Math.floor(Number(msg.seq));
            if (ns > 0) p.lastNetSeq = ns;
          }
          const ac = antiCheat.validatePlayerUpdate(p, msg, ws);
          if (ac.kick) {
            try {
              ws.send(JSON.stringify({
                type: 'kicked',
                reason: 'Fair sailing: this session sent impossible movement or damage (anticheat). You may rejoin.'
              }));
            } catch (e) {}
            try { ws.close(); } catch (e2) {}
            break;
          }
          if (msg.x !== undefined && msg.z !== undefined) {
            const cx = Number(msg.x);
            const cz = Number(msg.z);
            if (Number.isFinite(cx) && Number.isFinite(cz) && (p.docked || !ac.denyPositionHint)) {
              gameSim.applyClientPositionHint(p, cx, cz);
            }
          }
          if (msg.docked !== undefined) p.docked = !!msg.docked;
          if (msg.dockX !== undefined) p.dockX = msg.dockX;
          if (msg.dockZ !== undefined) p.dockZ = msg.dockZ;
          if (msg.dockAngle !== undefined) p.dockAngle = msg.dockAngle;
          if (msg.dockBerthIndex !== undefined) {
            if (msg.dockBerthIndex == null) p.dockBerthIndex = null;
            else {
              const bi = Math.floor(Number(msg.dockBerthIndex));
              p.dockBerthIndex = Number.isFinite(bi) ? bi : null;
            }
          }
          if (msg.riggingHealth !== undefined) p.riggingHealth = Math.max(0, Math.min(100, Number(msg.riggingHealth) || 0));
          if (msg.morale !== undefined) p.morale = Math.max(0, Math.min(100, Number(msg.morale) || 0));
          if (msg.shipType !== undefined && msg.shipType !== null) {
            const st = String(msg.shipType).trim().slice(0, 24);
            if (st) p.shipType = st;
          }
          if (msg.shipName !== undefined) p.shipName = String(msg.shipName || '').slice(0, 28);
          if (msg.flagColor !== undefined) p.flagColor = String(msg.flagColor || '').slice(0, 32);
          if (msg.flagAssetId !== undefined) {
            if (msg.flagAssetId === null) p.flagAssetId = null;
            else {
              const a = sanitizeClientFlagAssetId(msg.flagAssetId);
              if (a != null) p.flagAssetId = a;
            }
          }
          if (msg.hullBanner !== undefined) {
            p.hullBanner = sanitizeBannerFromClient(msg.hullBanner);
          }
          if (msg.sailBanner !== undefined) {
            p.sailBanner = sanitizeBannerFromClient(msg.sailBanner);
          }
          if (msg.shipParts !== undefined && msg.shipParts !== null && typeof msg.shipParts === 'object') {
            p.shipParts = {
              hull: 'basic', sail: 'basic', cannon: 'light', figurehead: 'none',
              ...p.shipParts,
              ...msg.shipParts
            };
          }
          if (msg.crewData && Array.isArray(msg.crewData)) p.crewData = msg.crewData.slice(0, 32);
          if (msg.deckWalk !== undefined) {
            if (msg.deckWalk && typeof msg.deckWalk === 'object') {
              p.deckWalk = {
                active: true,
                x: Number(msg.deckWalk.x) || 0,
                z: Number(msg.deckWalk.z) || 0,
                yaw: Number(msg.deckWalk.yaw) || 0,
                airY: Math.max(0, Math.min(3.5, Number(msg.deckWalk.airY) || 0)),
                deckTier: msg.deckWalk.deckTier === 'qd' || msg.deckWalk.tier === 'qd' ? 'qd' : 'main'
              };
            } else {
              p.deckWalk = null;
            }
          }
          if (msg.boarding !== undefined) {
            if (msg.boarding === null) {
              p.boarding = null;
            } else {
              const s = sanitizeBoardingFromClient(msg.boarding);
              if (s != null) p.boarding = s;
            }
          }
          if (msg.playerPolitics != null && typeof msg.playerPolitics === 'object') {
            const s = sanitizePlayerPoliticsPatch(msg.playerPolitics);
            if (s) ensureWorldPolitics().setPlayerStanding(id, s);
          }
          const ck = ws.captainAccountKey;
          if (ck && captainAccounts[ck]) {
            const now = Date.now();
            if (!ws._captainTouchAt || now - ws._captainTouchAt > 120000) {
              ws._captainTouchAt = now;
              captainAccounts[ck].lastActiveMs = now;
              markCaptainAccountsDirty();
            }
          }
          break;
        }
        case 'world_checkpoint': {
          const pl = players.get(id);
          const ck = ws.captainAccountKey;
          if (ck && pl) persistCaptainWorldPresenceFromPlayer(ck, pl);
          break;
        }
        case 'set_name': {
          const p = players.get(id);
          if (!p) break;
          pruneStaleCaptainAccounts();

          const hadPlaceholderName = isAutoGeneratedPirateName(p.name);
          const displayName = msg.name ? String(msg.name).slice(0, 28).trim() : 'Pirate';
          const newKey = normalizeCaptainKey(displayName);
          if (!newKey) {
            try {
              ws.send(JSON.stringify({ type: 'name_rejected', error: 'Captain name cannot be empty.' }));
            } catch (e) {}
            break;
          }

          const tokenOffered = msg.captainToken && String(msg.captainToken).trim() !== ''
            ? String(msg.captainToken).trim()
            : null;

          const oldKey = ws.captainAccountKey || null;

          if (tokenOffered && !captainAccounts[newKey]) {
            const kTok = findCaptainKeyByToken(tokenOffered);
            if (kTok && kTok !== newKey && captainAccounts[kTok] && secureTokenEquals(captainAccounts[kTok].token, tokenOffered)) {
              if (!remapCaptainAccountKeyInParties(kTok, newKey)) {
                try {
                  ws.send(JSON.stringify({
                    type: 'name_rejected',
                    error: 'That name conflicts with another captain’s clan record on this server. Try a different name.'
                  }));
                } catch (e) {}
                break;
              }
              captainAccounts[newKey] = {
                ...captainAccounts[kTok],
                displayName,
                lastActiveMs: Date.now()
              };
              delete captainAccounts[kTok];
              saveCaptainAccounts();
            }
          }

          const acc = captainAccounts[newKey];
          if (acc) {
            if (!tokenOffered || !secureTokenEquals(acc.token, tokenOffered)) {
              try {
                ws.send(JSON.stringify({
                  type: 'name_rejected',
                  error: 'That captain name is taken. Choose another, or wait until it frees after 14 days without sailing this server.'
                }));
              } catch (e) {}
              break;
            }
            acc.lastActiveMs = Date.now();
            acc.displayName = displayName;
            saveCaptainAccounts();
          } else {
            if (oldKey && oldKey !== newKey && captainAccounts[oldKey] && tokenOffered
              && secureTokenEquals(captainAccounts[oldKey].token, tokenOffered)) {
              if (!remapCaptainAccountKeyInParties(oldKey, newKey)) {
                try {
                  ws.send(JSON.stringify({
                    type: 'name_rejected',
                    error: 'Clan record conflict while renaming. Try another name or use your previous captain name.'
                  }));
                } catch (e) {}
                break;
              }
              captainAccounts[newKey] = {
                ...captainAccounts[oldKey],
                displayName,
                lastActiveMs: Date.now()
              };
              delete captainAccounts[oldKey];
              saveCaptainAccounts();
              try {
                ws.send(JSON.stringify({
                  type: 'name_reserved',
                  captainKey: newKey,
                  captainToken: captainAccounts[newKey].token,
                  name: displayName
                }));
              } catch (e) {}
            } else {
              const newTok = crypto.randomBytes(24).toString('hex');
              captainAccounts[newKey] = {
                token: newTok,
                displayName,
                lastActiveMs: Date.now()
              };
              saveCaptainAccounts();
              try {
                ws.send(JSON.stringify({
                  type: 'name_reserved',
                  captainKey: newKey,
                  captainToken: newTok,
                  name: displayName
                }));
              } catch (e) {}
            }
          }

          registerCaptainSessionSocket(ws, id, oldKey, newKey);
          p.name = displayName;
          p.captainKey = newKey;
          if (msg.shipName) p.shipName = String(msg.shipName).slice(0, 28);
          if (msg.shipType !== undefined && msg.shipType !== null) {
            const st = String(msg.shipType).trim().slice(0, 24);
            if (st) p.shipType = st;
          }
          if (msg.flagColor !== undefined) p.flagColor = String(msg.flagColor || '').slice(0, 32);
          if (msg.flagAssetId !== undefined) {
            if (msg.flagAssetId === null) p.flagAssetId = null;
            else {
              const a = sanitizeClientFlagAssetId(msg.flagAssetId);
              if (a != null) p.flagAssetId = a;
            }
          }
          if (msg.hullBanner !== undefined) {
            p.hullBanner = sanitizeBannerFromClient(msg.hullBanner);
          }
          if (msg.sailBanner !== undefined) {
            p.sailBanner = sanitizeBannerFromClient(msg.sailBanner);
          }
          if (msg.shipParts !== undefined && msg.shipParts !== null && typeof msg.shipParts === 'object') {
            p.shipParts = {
              hull: 'basic', sail: 'basic', cannon: 'light', figurehead: 'none',
              ...p.shipParts,
              ...msg.shipParts
            };
          }
          if (msg.crew) p.crewData = msg.crew.slice(0, 32);
          ws.captainAccountKey = newKey;
          refreshPlayerPartyTag(p);
          broadcastAll({
            type: 'player_identity',
            id,
            name: displayName,
            captainKey: newKey,
            shipName: p.shipName != null ? String(p.shipName).slice(0, 28) : '',
            partyTag: p.partyTag != null ? String(p.partyTag).slice(0, 24) : '',
            joinAnnounce: hadPlaceholderName
          });
          const prSync = getPartyForCaptainKey(newKey);
          if (prSync) {
            broadcastPartySync(prSync.id);
            const syncPayload = buildPartySyncPayload(prSync, newKey);
            try { ws.send(JSON.stringify({ type: 'party_sync', party: syncPayload })); } catch (e) {}
          } else {
            try { ws.send(JSON.stringify({ type: 'party_sync', party: null })); } catch (e) {}
          }
          sendPendingClanInvitesForCaptain(ws, newKey);
          broadcastServerPopulation();
          const preferLocalVoyage = !!msg.preferLocalVoyage;
          const resume = preferLocalVoyage ? null : tryApplyWorldPresenceToPlayer(newKey, p);
          if (resume) {
            try {
              ws.send(JSON.stringify({ type: 'world_resume', realm: getRealmConfig(), ...resume }));
            } catch (e) {}
          }
          break;
        }
        case 'ship_update': {
          const p = players.get(id);
          if (!p) break;
          if (msg.shipType) p.shipType = msg.shipType;
          if (msg.shipParts) p.shipParts = { ...p.shipParts, ...msg.shipParts };
          broadcast({ type: 'ship_update', id, shipType: p.shipType, shipParts: p.shipParts }, id);
          break;
        }
        case 'chat': {
          if (mutedPlayerIds.has(id)) {
            try {
              ws.send(JSON.stringify({ type: 'chat_error', error: 'You are muted by the navigator.' }));
            } catch (e) {}
            break;
          }
          const text = String(msg.text != null ? msg.text : '').slice(0, 500);
          if (!text.trim()) break;
          const name = players.get(id)?.name || 'Unknown';
          const channel = msg.channel === 'party' ? 'party' : 'global';
          let partyId = null;
          let partyTag = '';
          let partyRef = null;
          if (channel === 'party') {
            const ck = ws.captainAccountKey || players.get(id)?.captainKey || null;
            partyRef = getPartyForCaptainKey(ck);
            if (!partyRef) {
              try {
                ws.send(JSON.stringify({ type: 'chat_error', error: 'You are not in a clan.' }));
              } catch (e) {}
              break;
            }
            partyId = partyRef.id;
            partyTag = partyRef.tag || '';
          }
          const mid = nextChatMessageId++;
          const plChat = players.get(id);
          const clanTag = (plChat && plChat.partyTag) ? String(plChat.partyTag).slice(0, 24) : '';
          const row = { id: mid, t: Date.now(), playerId: id, name, text, channel, partyId, partyTag, clanTag };
          chatHistory.push(row);
          if (chatHistory.length > CHAT_HISTORY_MAX) chatHistory.shift();
          const out = { type: 'chat', chatId: mid, id, name, text, channel, partyId, partyTag, clanTag };
          if (channel === 'global') {
            broadcastAll(out);
          } else if (partyRef) {
            for (const mck of partyRef.memberKeys || []) {
              const pid = findPlayerIdByCaptainKey(mck);
              if (pid == null) continue;
              sendToPlayerId(pid, out);
            }
          }
          break;
        }
        case 'cannonball': {
          const a = msg.ammoType;
          const ammoType = a === 'grape' || a === 'chain' || a === 'grape_pellet' ? a : 'ball';
          const cy = msg.y != null && Number.isFinite(Number(msg.y)) ? Number(msg.y) : null;
          broadcast({ type: 'cannonball', shooterId: id, x: msg.x, z: msg.z, y: cy, dx: msg.dx, dz: msg.dz, ammoType }, id);
          break;
        }
        case 'sea_debris': {
          const n = Math.max(1, Math.min(14, Math.floor(Number(msg.n) || 4)));
          const x = Number(msg.x);
          const z = Number(msg.z);
          if (!Number.isFinite(x) || !Number.isFinite(z)) break;
          broadcast({ type: 'sea_debris', x, z, n }, id);
          break;
        }
        case 'ship_hit_fx': {
          const x = Number(msg.x);
          const z = Number(msg.z);
          const y = Number(msg.y);
          if (!Number.isFinite(x) || !Number.isFinite(z)) break;
          broadcast({ type: 'ship_hit_fx', x, z, y: Number.isFinite(y) ? y : null }, id);
          break;
        }
        case 'npc_damage_popup': {
          const wx = Number(msg.wx);
          const wz = Number(msg.wz);
          if (!Number.isFinite(wx) || !Number.isFinite(wz)) break;
          const wy = msg.wy != null && Number.isFinite(Number(msg.wy)) ? Number(msg.wy) : null;
          const text = msg.text != null ? String(msg.text).slice(0, 220) : '';
          if (!text) break;
          const cssClass = msg.cssClass != null ? String(msg.cssClass).slice(0, 24) : '';
          const life = msg.life != null && Number.isFinite(Number(msg.life)) ? Math.max(0.5, Math.min(8, Number(msg.life))) : 2.1;
          broadcast({ type: 'npc_damage_popup', wx, wz, wy, text, cssClass, life }, id);
          break;
        }
        case 'world_story_push': {
          const st = sanitizeWorldStory(msg.story);
          playerStories.set(id, st);
          broadcastAll({ type: 'player_story', playerId: id, story: st });
          break;
        }
        case 'world_quests_push': {
          playerQuests.set(id, sanitizePlayerQuestsForServer(msg.quests));
          break;
        }
        case 'npc_sync': {
          break;
        }
        case 'npc_cannon': {
          broadcast({ type: 'npc_cannon', x: msg.x, z: msg.z, dx: msg.dx, dz: msg.dz, y: msg.y }, id);
          break;
        }
        case 'npc_ram_report': {
          const hull = Math.max(0, Math.floor(Number(msg.hull) || 0));
          const rig = Math.max(0, Math.floor(Number(msg.rigging) || 0));
          if (hull === 0 && rig === 0) break;
          if (msg.npcId === undefined || msg.npcId === null) break;
          broadcastAll({
            type: 'npc_ram_report',
            fromId: id,
            npcId: msg.npcId,
            hull,
            rigging: rig
          });
          break;
        }
        case 'npc_hit_claim': {
          if (msg.npcId === undefined || msg.npcId === null) break;
          const a = msg.ammoType;
          const ammoType = a === 'grape' || a === 'chain' || a === 'grape_pellet' ? a : 'ball';
          const hx = msg.hx != null && Number.isFinite(Number(msg.hx)) ? Number(msg.hx) : null;
          const hy = msg.hy != null && Number.isFinite(Number(msg.hy)) ? Number(msg.hy) : null;
          const hz = msg.hz != null && Number.isFinite(Number(msg.hz)) ? Number(msg.hz) : null;
          broadcastAll({
            type: 'npc_hit_claim',
            fromId: id,
            npcId: msg.npcId,
            ammoType,
            isPellet: msg.isPellet === true || ammoType === 'grape_pellet',
            hx,
            hy,
            hz
          });
          break;
        }
        case 'npc_boarding_sink': {
          const npcSyncId = msg.npcSyncId != null ? Math.floor(Number(msg.npcSyncId)) : NaN;
          const fromId = msg.fromId != null ? Math.floor(Number(msg.fromId)) : NaN;
          if (!Number.isFinite(npcSyncId) || !Number.isFinite(fromId)) break;
          if (fromId !== id) break;
          broadcastAll({ type: 'npc_boarding_sink', npcSyncId, fromId });
          break;
        }
        case 'delete_captain_career': {
          const stripPid = msg.stripLeaderboardPlayerId != null ? Math.floor(Number(msg.stripLeaderboardPlayerId)) : null;
          /** Session-only captains (no server account): drop their leaderboard row by socket player id. */
          if (msg.abandonUnregistered === true) {
            if (!Number.isFinite(stripPid) || stripPid !== id) {
              try {
                ws.send(JSON.stringify({ type: 'captain_career_delete_failed', error: 'bad_strip' }));
              } catch (e) {}
              break;
            }
            const beforeU = leaderboardHistory.length;
            leaderboardHistory = leaderboardHistory.filter(r => {
              const n = normalizeLbEntry(r);
              return !(n.playerId != null && Number(n.playerId) === id);
            });
            const removedU = beforeU - leaderboardHistory.length;
            reconcileLeaderboardRows();
            saveLeaderboard();
            flushNavigatorMutationToDisk();
            broadcast({ type: 'leaderboard', entries: leaderboardHistory });
            try {
              ws.send(JSON.stringify({
                type: 'captain_career_deleted',
                captainKey: null,
                abandonUnregistered: true,
                stripLeaderboardPlayerId: id,
                leaderboardRowsRemoved: removedU
              }));
            } catch (e) {}
            break;
          }
          const ck = msg.captainKey != null ? normalizeCaptainKey(String(msg.captainKey)) : '';
          const tok = msg.captainToken != null ? String(msg.captainToken).trim() : '';
          if (!ck || !tok) {
            try {
              ws.send(JSON.stringify({ type: 'captain_career_delete_failed', error: 'missing_fields' }));
            } catch (e) {}
            break;
          }
          const acc = captainAccounts[ck];
          if (!acc || !secureTokenEquals(acc.token, tok)) {
            try {
              ws.send(JSON.stringify({ type: 'captain_career_delete_failed', error: 'invalid_or_unknown_captain' }));
            } catch (e) {}
            break;
          }
          delete captainAccounts[ck];
          captainAccountsDirty = true;
          saveCaptainAccounts();
          const before = leaderboardHistory.length;
          /** Strip stale socket ids from rows even after reconnect (new `id`); token proves account ownership. */
          const pidStrip = Number.isFinite(stripPid) ? stripPid : null;
          leaderboardHistory = leaderboardHistory.filter(r => {
            const n = normalizeLbEntry(r);
            if (n.captainKey && normalizeCaptainKey(String(n.captainKey)) === ck) return false;
            if (n.captainKey === ck) return false;
            if (pidStrip != null && n.playerId != null && Number(n.playerId) === pidStrip) return false;
            const nk = normalizeCaptainKey(n.name);
            if (nk === ck && !isAutoGeneratedPirateName(n.name)) return false;
            return true;
          });
          const removedLb = before - leaderboardHistory.length;
          reconcileLeaderboardRows();
          saveLeaderboard();
          flushNavigatorMutationToDisk();
          broadcast({ type: 'leaderboard', entries: leaderboardHistory });
          try {
            ws.send(JSON.stringify({
              type: 'captain_career_deleted',
              captainKey: ck,
              stripLeaderboardPlayerId: Number.isFinite(stripPid) ? stripPid : null,
              leaderboardRowsRemoved: removedLb
            }));
          } catch (e) {}
          break;
        }
        case 'cannon_fx': {
          broadcast({ type: 'cannon_fx', x: msg.x, y: msg.y, z: msg.z, dx: msg.dx, dz: msg.dz }, id);
          break;
        }
        case 'ship_sunk': {
          const victimId = id;
          const loot = (msg.loot || []).map(l => ({
            type: l.type,
            x: l.x,
            z: l.z,
            count: l.count,
            id: nextLootNetId++
          }));
          const _v = players.get(victimId);
          let _sinkName = _v?.name || msg.name || 'Unknown';
          if (_v?.crewData && Array.isArray(_v.crewData) && _v.crewData[0]?.name) {
            _sinkName = String(_v.crewData[0].name).slice(0, 28);
          }
          broadcastAll({
            type: 'ship_sunk',
            victimId,
            x: msg.x,
            z: msg.z,
            loot,
            name: _sinkName
          });
          break;
        }
        case 'loot_spawn': {
          const lid = nextLootNetId++;
          broadcastAll({
            type: 'loot_spawn',
            id: lid,
            x: msg.x,
            z: msg.z,
            loot: msg.loot || { type: msg.type, count: msg.count }
          });
          break;
        }
        case 'loot_collect': {
          if (msg.id != null) broadcastAll({ type: 'loot_collect', id: msg.id });
          break;
        }
        case 'swimmer_spawn': {
          if (msg.swimmers && Array.isArray(msg.swimmers)) {
            const spawnAt = Date.now();
            const swimmers = msg.swimmers.map(s => ({
              x: s.x,
              z: s.z,
              restore: s.restore || null,
              id: nextSwimmerNetId++,
              spawnAt
            }));
            broadcastAll({ type: 'swimmer_spawn', swimmers });
          }
          break;
        }
        case 'swimmer_collect': {
          if (msg.id != null) {
            broadcastAll({
              type: 'swimmer_collect',
              id: msg.id,
              rescueEscort: !!msg.rescueEscort,
              rescuerPlayerId: msg.rescuerPlayerId != null ? Number(msg.rescuerPlayerId) : null
            });
          }
          break;
        }
        case 'pvp_kill_credit': {
          const killerId = msg.killerId;
          if (!killerId || killerId === id) break;
          const dk = Math.max(0, Math.floor(Number(msg.sinksPlayer != null ? msg.sinksPlayer : msg.kills) || 0));
          const dl = Math.max(0, Math.floor(Number(msg.gold != null ? msg.gold : msg.loot) || 0));
          if (dk === 0 && dl === 0) break;
          const kp = players.get(killerId);
          if (!kp) break;
          kp.kills = (kp.kills || 0) + dk;
          kp.loot = (kp.loot || 0) + dl;
          const capName = (kp.name || kp.shipName || 'Pirate').slice(0, 28);
          const killerWs = findWsByPlayerId(killerId);
          const killerCk = killerWs && killerWs.captainAccountKey ? killerWs.captainAccountKey : (kp.captainKey || null);
          const idx = getLeaderboardRowIndex(killerId, capName, killerCk, kp.shipName);
          const row = normalizeLbEntry(leaderboardHistory[idx]);
          row.sinksPlayer += dk;
          row.gold += dl;
          leaderboardHistory[idx] = row;
          reconcileLeaderboardRows();
          saveLeaderboard();
          broadcast({ type: 'leaderboard', entries: leaderboardHistory });
          break;
        }
        case 'leaderboard_update': {
          const p = players.get(id);
          if (!p) break;
          const dg = Math.max(0, Math.floor(Number(msg.gold != null ? msg.gold : msg.loot) || 0));
          const dAi = Math.max(0, Math.floor(Number(msg.sinksAi != null ? msg.sinksAi : msg.kills) || 0));
          const dPl = Math.max(0, Math.floor(Number(msg.sinksPlayer) || 0));
          const dr = Math.max(0, Math.floor(Number(msg.ransoms) || 0));
          const dd = Math.max(0, Math.floor(Number(msg.deaths) || 0));
          const dBo = Math.max(0, Math.floor(Number(msg.boardings) || 0));
          if (dg === 0 && dAi === 0 && dPl === 0 && dr === 0 && dd === 0 && dBo === 0) break;
          p.kills = (p.kills || 0) + dAi + dPl;
          p.loot = (p.loot || 0) + dg;
          const capName = (p.name || p.shipName || 'Pirate').slice(0, 28);
          const idx = getLeaderboardRowIndex(id, capName, ws.captainAccountKey || p.captainKey || null, p.shipName);
          const row = normalizeLbEntry(leaderboardHistory[idx]);
          row.gold += dg;
          row.sinksAi += dAi;
          row.sinksPlayer += dPl;
          row.ransoms += dr;
          row.deaths += dd;
          row.boardings = (row.boardings || 0) + dBo;
          leaderboardHistory[idx] = row;
          reconcileLeaderboardRows();
          saveLeaderboard();
          broadcast({ type: 'leaderboard', entries: leaderboardHistory });
          break;
        }
        case 'party_tag_sync': {
          const p = players.get(id);
          if (!p) break;
          const capName = (p.name || p.shipName || 'Pirate').slice(0, 28);
          const idx = getLeaderboardRowIndex(id, capName, ws.captainAccountKey || p.captainKey || null, p.shipName);
          const row = normalizeLbEntry(leaderboardHistory[idx]);
          const nextTag = String(msg.partyTag != null ? msg.partyTag : '').slice(0, 24);
          if (row.partyTag === nextTag) break;
          row.partyTag = nextTag;
          leaderboardHistory[idx] = row;
          reconcileLeaderboardRows();
          saveLeaderboard();
          broadcast({ type: 'leaderboard', entries: leaderboardHistory });
          break;
        }
        case 'boarding_hold_snapshot': {
          const targetId = msg.targetId != null ? Math.floor(Number(msg.targetId)) : NaN;
          if (!Number.isFinite(targetId) || !players.has(targetId) || targetId === id) break;
          const tws = findWsByPlayerId(targetId);
          if (!tws || tws.readyState !== 1) break;
          const st = msg.shipType != null ? String(msg.shipType).slice(0, 24) : 'sloop';
          const slots = Array.isArray(msg.cargoSlots) ? msg.cargoSlots.slice(0, 48) : [];
          const inv = Array.isArray(msg.inventory) ? msg.inventory.slice(0, 64) : [];
          try {
            tws.send(JSON.stringify({
              type: 'boarding_hold_snapshot',
              fromPlayerId: id,
              shipType: st,
              cargoSlots: slots,
              inventory: inv
            }));
          } catch (e) {}
          break;
        }
        case 'boarding_spoils': {
          const targetId = msg.targetId != null ? Math.floor(Number(msg.targetId)) : NaN;
          const gold = Math.max(0, Math.min(8000, Math.floor(Number(msg.gold) || 0)));
          const scuttle = msg.scuttle === true;
          const keepHull = msg.keepHull === true && !scuttle;
          if (!Number.isFinite(targetId) || !players.has(targetId)) break;
          if (targetId === id) break;
          const spoilItems = (() => {
            const raw = msg.items;
            if (!Array.isArray(raw)) return [];
            const out = [];
            for (let i = 0; i < raw.length && out.length < 48; i++) {
              const it = raw[i];
              if (!it || typeof it !== 'object') continue;
              const sid = String(it.id || '').trim().slice(0, 32);
              if (!sid) continue;
              const cnt = Math.max(0, Math.min(9999, Math.floor(Number(it.count) || 0)));
              if (cnt <= 0) continue;
              out.push({ id: sid, count: cnt });
            }
            return out;
          })();
          const spoilItemsGift = (() => {
            const raw = msg.itemsGift;
            if (!Array.isArray(raw)) return [];
            const out = [];
            for (let i = 0; i < raw.length && out.length < 48; i++) {
              const it = raw[i];
              if (!it || typeof it !== 'object') continue;
              const sid = String(it.id || '').trim().slice(0, 32);
              if (!sid) continue;
              const cnt = Math.max(0, Math.min(9999, Math.floor(Number(it.count) || 0)));
              if (cnt <= 0) continue;
              out.push({ id: sid, count: cnt });
            }
            return out;
          })();
          const captivesTaken = (() => {
            const raw = msg.captivesTaken;
            if (!Array.isArray(raw)) return [];
            const out = [];
            for (let i = 0; i < raw.length && out.length < 16; i++) {
              const n = Math.floor(Number(raw[i]));
              if (Number.isFinite(n) && n >= 0 && n < 24) out.push(n);
            }
            return out;
          })();
          const spoilsSurrenderPool = msg.spoilsSurrenderPool != null && Number.isFinite(Number(msg.spoilsSurrenderPool))
            ? Math.max(0, Math.min(24, Math.floor(Number(msg.spoilsSurrenderPool))))
            : null;
          /* Keep-ship: only the victor's *former* hull should sink (they sail the prize). Exclude victor so they don't double-spawn (client spawns locally). */
          if (keepHull) {
            const atk = players.get(id);
            if (atk) {
              const cd = Array.isArray(atk.crewData) ? atk.crewData.slice(0, 24) : null;
              broadcast({
                type: 'boarding_prize_hull_sink',
                victorPlayerId: id,
                namelessHull: true,
                abandonedLingerSec: 10,
                emptyCrew: true,
                x: Number.isFinite(Number(atk.x)) ? Number(atk.x) : 0,
                z: Number.isFinite(Number(atk.z)) ? Number(atk.z) : 0,
                rotation: Number.isFinite(Number(atk.rotation)) ? Number(atk.rotation) : 0,
                shipType: atk.shipType != null ? String(atk.shipType).slice(0, 24) : 'sloop',
                shipParts: atk.shipParts && typeof atk.shipParts === 'object'
                  ? { hull: 'basic', sail: 'basic', cannon: 'light', figurehead: 'none', flag: 'mast', ...atk.shipParts }
                  : { hull: 'basic', sail: 'basic', cannon: 'light', figurehead: 'none', flag: 'mast' },
                shipName: atk.shipName != null ? String(atk.shipName).slice(0, 28) : '',
                flagAssetId: atk.flagAssetId,
                name: atk.name != null ? String(atk.name).slice(0, 28) : '',
                partyTag: atk.partyTag != null ? String(atk.partyTag).slice(0, 24) : '',
                crewData: cd
              }, id);
            }
            const vic = players.get(targetId);
            if (vic) {
              /* Victim's abandoned hull: decoy for everyone; no captain toast (victim already got boarding_spoils; victorPlayerId was wrongly the victim and confused clients). */
              broadcastAll({
                type: 'boarding_prize_hull_sink',
                suppressCaptainNotify: true,
                namelessHull: true,
                abandonedLingerSec: 10,
                emptyCrew: true,
                x: Number.isFinite(Number(vic.x)) ? Number(vic.x) : 0,
                z: Number.isFinite(Number(vic.z)) ? Number(vic.z) : 0,
                rotation: Number.isFinite(Number(vic.rotation)) ? Number(vic.rotation) : 0,
                shipType: vic.shipType != null ? String(vic.shipType).slice(0, 24) : 'sloop',
                shipParts: vic.shipParts && typeof vic.shipParts === 'object'
                  ? { hull: 'basic', sail: 'basic', cannon: 'light', figurehead: 'none', flag: 'mast', ...vic.shipParts }
                  : { hull: 'basic', sail: 'basic', cannon: 'light', figurehead: 'none', flag: 'mast' },
                flagAssetId: vic.flagAssetId
              });
            }
          }
          /* Mercy with 0 gold must still notify the victim (client used to block and left them stuck). */
          const tws = findWsByPlayerId(targetId);
          if (tws && tws.readyState === 1) {
            try {
              const spoilPayload = { type: 'boarding_spoils', victimId: targetId, from: id, gold, scuttle, keepHull };
              if (spoilItems.length) spoilPayload.items = spoilItems;
              if (spoilItemsGift.length) spoilPayload.itemsGift = spoilItemsGift;
              if (captivesTaken.length) spoilPayload.captivesTaken = captivesTaken;
              if (spoilsSurrenderPool != null && spoilsSurrenderPool > 0) spoilPayload.spoilsSurrenderPool = spoilsSurrenderPool;
              tws.send(JSON.stringify(spoilPayload));
            } catch (e) {}
          }
          /* Scuttle: victim client sends ship_sunk with hold loot (authoritative). */
          break;
        }
        case 'party_chart_markers': {
          const pl = players.get(id);
          if (!pl) break;
          const ck = ws.captainAccountKey || pl.captainKey || null;
          if (!ck) break;
          const pr = getPartyForCaptainKey(ck);
          if (!pr || !Array.isArray(pr.memberKeys)) break;
          const raw = Array.isArray(msg.markers) ? msg.markers : [];
          const markers = [];
          for (let i = 0; i < raw.length && markers.length < 24; i++) {
            const m = raw[i];
            if (!m || typeof m !== 'object') continue;
            const x = Number(m.x);
            const z = Number(m.z);
            if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
            const idM = m.id != null ? Number(m.id) : i;
            markers.push({
              id: Number.isFinite(idM) ? idM : i,
              x: Math.max(-5e5, Math.min(5e5, x)),
              z: Math.max(-5e5, Math.min(5e5, z))
            });
          }
          const payload = JSON.stringify({ type: 'party_chart_markers', fromCaptainKey: String(ck), markers });
          for (const memberCk of pr.memberKeys) {
            if (memberCk === ck) continue;
            const opid = findPlayerIdByCaptainKey(memberCk);
            if (opid == null) continue;
            const cws = findWsByPlayerId(opid);
            if (cws && cws.readyState === 1) {
              try { cws.send(payload); } catch (e) {}
            }
          }
          break;
        }
        case 'npc_kill_credit': {
          let hostId = null;
          for (const pid of players.keys()) {
            if (hostId === null || pid < hostId) hostId = pid;
          }
          if (hostId === null || id !== hostId) break;
          const storyOwnerId = msg.storyOwnerId != null ? Math.floor(Number(msg.storyOwnerId)) : null;
          const so = msg.storyOutcome != null ? String(msg.storyOutcome) : 'none';
          if (Number.isFinite(storyOwnerId) && players.has(storyOwnerId) && (so === 'complete' || so === 'reroll')) {
            sendToPlayerId(storyOwnerId, { type: 'story_bounty_outcome', outcome: so === 'complete' ? 'complete' : 'reroll' });
          }
          const killerId = msg.killerId != null ? Math.floor(Number(msg.killerId)) : NaN;
          const dg = Math.max(0, Math.floor(Number(msg.gold) || 0));
          const dAi = Math.max(0, Math.floor(Number(msg.sinksAi) || 0));
          const huntNpcName = msg.huntNpcName != null ? String(msg.huntNpcName).trim().slice(0, 48) : '';
          if (!Number.isFinite(killerId) || !players.has(killerId)) break;
          if (dg === 0 && dAi === 0 && !huntNpcName) break;
          const kp = players.get(killerId);
          if (dg > 0 || dAi > 0) {
            kp.kills = (kp.kills || 0) + dAi;
            kp.loot = (kp.loot || 0) + dg;
            const capName = (kp.name || kp.shipName || 'Pirate').slice(0, 28);
            const killerWs = findWsByPlayerId(killerId);
            const killerCk = killerWs && killerWs.captainAccountKey ? killerWs.captainAccountKey : (kp.captainKey || null);
            const idx = getLeaderboardRowIndex(killerId, capName, killerCk, kp.shipName);
            const row = normalizeLbEntry(leaderboardHistory[idx]);
            row.gold += dg;
            row.sinksAi += dAi;
            leaderboardHistory[idx] = row;
            reconcileLeaderboardRows();
            saveLeaderboard();
            broadcast({ type: 'leaderboard', entries: leaderboardHistory });
          }
          broadcastAll({
            type: 'npc_kill_award',
            killerId,
            gold: dg,
            sinksAi: dAi,
            storyBounty: false,
            huntNpcName: huntNpcName,
            victimName: msg.victimName != null ? String(msg.victimName).slice(0, 48) : 'ship'
          });
          break;
        }
        case 'party_create': {
          const ck = ws.captainAccountKey || players.get(id)?.captainKey || null;
          if (!ck) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'Reserve a captain name on this server before forming a clan.' })); } catch (e) {}
            break;
          }
          if (getPartyForCaptainKey(ck)) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'Already in a clan. Leave or disband first.' })); } catch (e) {}
            break;
          }
          const tag = sanitizePartyTag(msg.tag);
          if (!tag) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'Enter a clan name to create one.' })); } catch (e) {}
            break;
          }
          const nameKey = normalizeClanNameKey(tag);
          if (clanNameTaken(nameKey, null)) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'That clan name is already taken.' })); } catch (e) {}
            break;
          }
          const pid = `p${partyStore.nextPartyNum++}`;
          partyStore.parties[pid] = { id: pid, tag, leaderKey: ck, memberKeys: [ck], pendingKeys: [], pendingInviteFrom: {}, officerKeys: [], pendingJoinRequests: [] };
          partyStore.captainParty[ck] = pid;
          savePartyStore();
          broadcastPartySync(pid);
          break;
        }
        case 'party_invite': {
          const ck = ws.captainAccountKey || players.get(id)?.captainKey || null;
          const pr = getPartyForCaptainKey(ck);
          migratePartyRecord(pr);
          if (!pr || !canInviteToClan(pr, ck)) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'Only the captain or a clan officer can invite.' })); } catch (e) {}
            break;
          }
          const tck = normalizeCaptainKey(String(msg.targetCaptainKey != null ? msg.targetCaptainKey : msg.targetName || ''));
          if (!tck || tck === ck) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'Pick another captain to invite.' })); } catch (e) {}
            break;
          }
          if (getPartyForCaptainKey(tck)) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'That captain is already in a clan.' })); } catch (e) {}
            break;
          }
          if (pr.memberKeys.length + (pr.pendingKeys || []).length >= CLAN_MAX_MEMBERS) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'Clan is full (5 captains max).' })); } catch (e) {}
            break;
          }
          stripCaptainFromOtherPendingInvites(tck, pr.id);
          if (!pr.pendingKeys) pr.pendingKeys = [];
          if (!pr.pendingInviteFrom) pr.pendingInviteFrom = {};
          if (!pr.pendingKeys.includes(tck)) pr.pendingKeys.push(tck);
          const fromName = players.get(id)?.name || 'Captain';
          pr.pendingInviteFrom[tck] = { fromCaptainKey: ck, fromName: String(fromName).slice(0, 28) };
          migratePartyRecord(pr);
          pr.pendingJoinRequests = (pr.pendingJoinRequests || []).filter(r => r.captainKey !== tck);
          savePartyStore();
          const tws = findWsByCaptainKey(tck);
          if (tws) {
            try {
              tws.send(JSON.stringify({
                type: 'party_invite_pending',
                partyId: pr.id,
                tag: pr.tag,
                fromCaptainKey: ck,
                fromName: String(fromName).slice(0, 28)
              }));
            } catch (e) {}
          }
          try { ws.send(JSON.stringify({ type: 'party_ok', action: 'invite_sent' })); } catch (e) {}
          break;
        }
        case 'party_invite_accept':
        case 'party_accept': {
          const tck = ws.captainAccountKey || players.get(id)?.captainKey || null;
          const partyId = String(msg.partyId || '').trim();
          const pr = partyStore.parties[partyId];
          if (!tck || !pr || !Array.isArray(pr.pendingKeys) || !pr.pendingKeys.includes(tck)) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'No pending invite for that crew.' })); } catch (e) {}
            break;
          }
          if (getPartyForCaptainKey(tck)) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'Already in a clan.' })); } catch (e) {}
            break;
          }
          if (pr.memberKeys.length >= CLAN_MAX_MEMBERS) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'Clan is full (5 captains max).' })); } catch (e) {}
            break;
          }
          pr.pendingKeys = pr.pendingKeys.filter(k => k !== tck);
          deletePendingInviteMeta(pr, tck);
          if (!pr.memberKeys.includes(tck)) pr.memberKeys.push(tck);
          partyStore.captainParty[tck] = partyId;
          savePartyStore();
          broadcastPartySync(partyId);
          break;
        }
        case 'party_invite_decline':
        case 'party_decline': {
          const tck = ws.captainAccountKey || players.get(id)?.captainKey || null;
          const partyId = String(msg.partyId || '').trim();
          const pr = partyStore.parties[partyId];
          if (tck && pr && pr.pendingKeys) {
            pr.pendingKeys = pr.pendingKeys.filter(k => k !== tck);
            deletePendingInviteMeta(pr, tck);
            savePartyStore();
          }
          break;
        }
        case 'party_leave': {
          const ck = ws.captainAccountKey || players.get(id)?.captainKey || null;
          const pr = getPartyForCaptainKey(ck);
          if (!pr) break;
          migratePartyRecord(pr);
          if (pr.leaderKey === ck) {
            disbandParty(pr.id);
          } else {
            pr.memberKeys = pr.memberKeys.filter(k => k !== ck);
            if (pr.officerKeys) pr.officerKeys = pr.officerKeys.filter(k => k !== ck);
            delete partyStore.captainParty[ck];
            if (pr.pendingKeys) pr.pendingKeys = pr.pendingKeys.filter(k => k !== ck);
            deletePendingInviteMeta(pr, ck);
            if (pr.memberKeys.length === 0) disbandParty(pr.id);
            else {
              savePartyStore();
              broadcastPartySync(pr.id);
            }
            refreshPlayerPartyTag(players.get(id));
            try { ws.send(JSON.stringify({ type: 'party_sync', party: null })); } catch (e) {}
          }
          break;
        }
        case 'party_kick': {
          const ck = ws.captainAccountKey || players.get(id)?.captainKey || null;
          const pr = getPartyForCaptainKey(ck);
          if (!pr || pr.leaderKey !== ck) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'Only the clan captain can remove members. Officers may invite only.' })); } catch (e) {}
            break;
          }
          const kickKey = normalizeCaptainKey(String(msg.targetCaptainKey || ''));
          if (!kickKey || kickKey === ck) break;
          pr.memberKeys = pr.memberKeys.filter(k => k !== kickKey);
          if (pr.officerKeys) pr.officerKeys = pr.officerKeys.filter(k => k !== kickKey);
          delete partyStore.captainParty[kickKey];
          if (pr.pendingKeys) pr.pendingKeys = pr.pendingKeys.filter(k => k !== kickKey);
          deletePendingInviteMeta(pr, kickKey);
          savePartyStore();
          const kickedPid = findPlayerIdByCaptainKey(kickKey);
          const kickedPl = kickedPid != null ? players.get(kickedPid) : null;
          if (kickedPl) refreshPlayerPartyTag(kickedPl);
          const kickedWs = findWsByCaptainKey(kickKey);
          if (kickedWs) {
            try { kickedWs.send(JSON.stringify({ type: 'party_sync', party: null })); } catch (e) {}
          }
          if (pr.memberKeys.length === 0) disbandParty(pr.id);
          else broadcastPartySync(pr.id);
          break;
        }
        case 'party_disband': {
          const ck = ws.captainAccountKey || players.get(id)?.captainKey || null;
          const pr = getPartyForCaptainKey(ck);
          if (!pr || pr.leaderKey !== ck) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'Only the leader can disband.' })); } catch (e) {}
            break;
          }
          disbandParty(pr.id);
          break;
        }
        case 'party_set_tag': {
          const ck = ws.captainAccountKey || players.get(id)?.captainKey || null;
          const pr = getPartyForCaptainKey(ck);
          if (!pr || pr.leaderKey !== ck) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'Only the captain can rename the clan.' })); } catch (e) {}
            break;
          }
          const newTag = sanitizePartyTag(msg.tag);
          if (!newTag) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'Clan name cannot be empty.' })); } catch (e) {}
            break;
          }
          const nk = normalizeClanNameKey(newTag);
          if (clanNameTaken(nk, pr.id)) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'That clan name is already taken.' })); } catch (e) {}
            break;
          }
          pr.tag = newTag;
          savePartyStore();
          broadcastPartySync(pr.id);
          break;
        }
        case 'party_set_banners': {
          const ckB = ws.captainAccountKey || players.get(id)?.captainKey || null;
          const prB = getPartyForCaptainKey(ckB);
          migratePartyRecord(prB);
          if (!prB || prB.leaderKey !== ckB) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'Only the clan captain may set crew jacks and sails.' })); } catch (e) {}
            break;
          }
          if (msg.hullBanner !== undefined) prB.clanHullBanner = sanitizeBannerFromClient(msg.hullBanner);
          if (msg.sailBanner !== undefined) prB.clanSailBanner = sanitizeBannerFromClient(msg.sailBanner);
          savePartyStore();
          broadcastPartySync(prB.id);
          try { ws.send(JSON.stringify({ type: 'party_ok', action: 'clan_banners_set' })); } catch (e) {}
          break;
        }
        case 'party_promote_officer': {
          const ck = ws.captainAccountKey || players.get(id)?.captainKey || null;
          const pr = getPartyForCaptainKey(ck);
          migratePartyRecord(pr);
          if (!pr || pr.leaderKey !== ck) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'Only the captain can promote officers.' })); } catch (e) {}
            break;
          }
          const tck = normalizeCaptainKey(String(msg.targetCaptainKey || ''));
          if (!tck || tck === ck || !pr.memberKeys.includes(tck)) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'Pick a clan member to promote.' })); } catch (e) {}
            break;
          }
          if (!pr.officerKeys) pr.officerKeys = [];
          if (!pr.officerKeys.includes(tck)) pr.officerKeys.push(tck);
          savePartyStore();
          broadcastPartySync(pr.id);
          try { ws.send(JSON.stringify({ type: 'party_ok', action: 'officer_promoted' })); } catch (e) {}
          break;
        }
        case 'party_demote_officer': {
          const ck = ws.captainAccountKey || players.get(id)?.captainKey || null;
          const pr = getPartyForCaptainKey(ck);
          migratePartyRecord(pr);
          if (!pr || pr.leaderKey !== ck) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'Only the captain can demote officers.' })); } catch (e) {}
            break;
          }
          const tck = normalizeCaptainKey(String(msg.targetCaptainKey || ''));
          if (!tck || !pr.officerKeys || !pr.officerKeys.includes(tck)) break;
          pr.officerKeys = pr.officerKeys.filter(k => k !== tck);
          savePartyStore();
          broadcastPartySync(pr.id);
          try { ws.send(JSON.stringify({ type: 'party_ok', action: 'officer_demoted' })); } catch (e) {}
          break;
        }
        case 'party_list_public': {
          const rows = [];
          for (const pr of Object.values(partyStore.parties)) {
            migratePartyRecord(pr);
            if (!pr || !pr.id) continue;
            rows.push({
              id: pr.id,
              tag: pr.tag != null ? String(pr.tag).slice(0, 24) : '',
              members: Array.isArray(pr.memberKeys) ? pr.memberKeys.length : 0,
              max: CLAN_MAX_MEMBERS
            });
          }
          rows.sort((a, b) => String(a.tag).localeCompare(String(b.tag), undefined, { sensitivity: 'base' }));
          try { ws.send(JSON.stringify({ type: 'party_public_list', clans: rows })); } catch (e) {}
          break;
        }
        case 'party_request_join': {
          const ck = ws.captainAccountKey || players.get(id)?.captainKey || null;
          if (!ck) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'Reserve a captain name before applying to a clan.' })); } catch (e) {}
            break;
          }
          if (getPartyForCaptainKey(ck)) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'Already in a clan.' })); } catch (e) {}
            break;
          }
          const partyId = String(msg.partyId || '').trim();
          const pr = partyStore.parties[partyId];
          if (!pr) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'That clan was not found.' })); } catch (e) {}
            break;
          }
          migratePartyRecord(pr);
          if (pr.memberKeys.length >= CLAN_MAX_MEMBERS) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'That clan is full.' })); } catch (e) {}
            break;
          }
          stripCaptainFromAllJoinRequestsExcept(ck, partyId);
          const pl = players.get(id);
          const name = pl && pl.name ? String(pl.name).slice(0, 28) : 'Captain';
          const dup = (pr.pendingJoinRequests || []).some(r => r.captainKey === ck);
          if (!dup) pr.pendingJoinRequests.push({ captainKey: ck, name, t: Date.now() });
          savePartyStore();
          broadcastPartySync(partyId);
          try { ws.send(JSON.stringify({ type: 'party_ok', action: 'join_request_sent' })); } catch (e) {}
          break;
        }
        case 'party_approve_join': {
          const ck = ws.captainAccountKey || players.get(id)?.captainKey || null;
          const pr = getPartyForCaptainKey(ck);
          migratePartyRecord(pr);
          if (!pr || !canInviteToClan(pr, ck)) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'Only the captain or an officer may approve applications.' })); } catch (e) {}
            break;
          }
          const tck = normalizeCaptainKey(String(msg.targetCaptainKey || ''));
          if (!tck) break;
          const pj = pr.pendingJoinRequests || [];
          const idx = pj.findIndex(r => r.captainKey === tck);
          if (idx < 0) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'No pending application from that captain.' })); } catch (e) {}
            break;
          }
          if (getPartyForCaptainKey(tck)) {
            pr.pendingJoinRequests.splice(idx, 1);
            savePartyStore();
            broadcastPartySync(pr.id);
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'That captain already joined another clan.' })); } catch (e) {}
            break;
          }
          if (pr.memberKeys.length >= CLAN_MAX_MEMBERS) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'Clan is full.' })); } catch (e) {}
            break;
          }
          pr.pendingJoinRequests.splice(idx, 1);
          stripCaptainFromOtherPendingInvites(tck, pr.id);
          if (!pr.memberKeys.includes(tck)) pr.memberKeys.push(tck);
          partyStore.captainParty[tck] = pr.id;
          stripCaptainFromAllJoinRequestsExcept(tck, pr.id);
          savePartyStore();
          broadcastPartySync(pr.id);
          const newPid = findPlayerIdByCaptainKey(tck);
          if (newPid != null) {
            const plJ = players.get(newPid);
            if (plJ) refreshPlayerPartyTag(plJ);
          }
          break;
        }
        case 'party_reject_join': {
          const ck = ws.captainAccountKey || players.get(id)?.captainKey || null;
          const pr = getPartyForCaptainKey(ck);
          migratePartyRecord(pr);
          if (!pr || !canInviteToClan(pr, ck)) {
            try { ws.send(JSON.stringify({ type: 'party_error', error: 'Only the captain or an officer may reject applications.' })); } catch (e) {}
            break;
          }
          const tck = normalizeCaptainKey(String(msg.targetCaptainKey || ''));
          if (!tck) break;
          const before = (pr.pendingJoinRequests || []).length;
          pr.pendingJoinRequests = (pr.pendingJoinRequests || []).filter(r => r.captainKey !== tck);
          if (pr.pendingJoinRequests.length !== before) {
            savePartyStore();
            broadcastPartySync(pr.id);
          }
          break;
        }
        case 'admin_nav': {
          const token = msg.token;
          if (!isNavigatorAdminTokenOk(token)) {
            try {
              ws.send(JSON.stringify({ type: 'admin_error', error: 'Navigator session expired or invalid.' }));
            } catch (e) {}
            break;
          }
          const action = String(msg.action || '');
          const targetId = msg.targetId != null ? Number(msg.targetId) : null;
          if (action === 'list_players') {
            ws.send(JSON.stringify({ type: 'admin_players', players: collectAdminPlayerList() }));
            break;
          }
          if (action === 'clear_leaderboard_entry') {
            const lbCk = msg.lbCaptainKey != null ? normalizeCaptainKey(String(msg.lbCaptainKey)) : '';
            const lbPid = msg.lbPlayerId != null ? Number(msg.lbPlayerId) : null;
            if (!lbCk && !Number.isFinite(lbPid)) {
              ws.send(JSON.stringify({ type: 'admin_error', error: 'Missing captain key or player id for leaderboard row.' }));
              break;
            }
            const before = leaderboardHistory.length;
            leaderboardHistory = leaderboardHistory.filter(r => {
              const n = normalizeLbEntry(r);
              if (lbCk && n.captainKey === lbCk) return false;
              if (Number.isFinite(lbPid) && n.playerId != null && Number(n.playerId) === lbPid) return false;
              return true;
            });
            const removed = before - leaderboardHistory.length;
            if (removed > 0) {
              reconcileLeaderboardRows();
              flushNavigatorMutationToDisk();
              broadcast({ type: 'leaderboard', entries: leaderboardHistory });
            }
            ws.send(JSON.stringify({ type: 'admin_ok', action: 'clear_leaderboard_entry', removed }));
            break;
          }
          if (action === 'reset_leaderboard') {
            leaderboardHistory = [];
            leaderboardClientSeeded = true;
            sortLeaderboardHistory();
            flushNavigatorMutationToDisk();
            broadcast({ type: 'leaderboard', entries: leaderboardHistory, cleared: true });
            ws.send(JSON.stringify({ type: 'admin_ok', action: 'reset_leaderboard' }));
            break;
          }
          if (action === 'reset_all_time_data') {
            leaderboardHistory = [];
            leaderboardClientSeeded = true;
            sortLeaderboardHistory();
            flushNavigatorMutationToDisk();
            broadcast({ type: 'leaderboard', entries: leaderboardHistory, cleared: true });
            broadcastAll({ type: 'reset_local_career_data' });
            ws.send(JSON.stringify({ type: 'admin_ok', action: 'reset_all_time_data' }));
            break;
          }
          if (action === 'wipe_all_client_voyage_data') {
            captainAccounts = {};
            captainAccountsDirty = true;
            saveCaptainAccounts();
            worldPresenceStore = { v: 1, captains: {} };
            worldPresenceDirty = true;
            flushNavigatorMutationToDisk();
            broadcastAll({ type: 'navigator_wipe_local_voyage_data' });
            ws.send(JSON.stringify({ type: 'admin_ok', action: 'wipe_all_client_voyage_data' }));
            break;
          }
          if (action === 'world_announce') {
            const text = msg.text != null ? String(msg.text).slice(0, 600) : '';
            if (!text) {
              ws.send(JSON.stringify({ type: 'admin_error', error: 'Empty announcement.' }));
              break;
            }
            broadcastAll({ type: 'world_announce', text, t: Date.now() });
            ws.send(JSON.stringify({ type: 'admin_ok', action: 'world_announce' }));
            break;
          }
          if (action === 'list_registered_captains') {
            const list = Object.keys(captainAccounts).map((k) => {
              const a = captainAccounts[k];
              return {
                key: k,
                displayName: a && a.displayName ? String(a.displayName).slice(0, 28) : k,
                lastActiveMs: a && a.lastActiveMs ? a.lastActiveMs : 0
              };
            }).sort((a, b) => (b.lastActiveMs || 0) - (a.lastActiveMs || 0));
            ws.send(JSON.stringify({ type: 'admin_registered_captains', accounts: list }));
            break;
          }
          if (action === 'delete_registered_captain') {
            const ck = msg.captainKey != null ? normalizeCaptainKey(String(msg.captainKey)) : '';
            if (!ck) {
              ws.send(JSON.stringify({ type: 'admin_error', error: 'Missing captain key.' }));
              break;
            }
            if (captainAccounts[ck]) {
              delete captainAccounts[ck];
              captainAccountsDirty = true;
              saveCaptainAccounts();
            }
            if (worldPresenceStore.captains && worldPresenceStore.captains[ck]) {
              delete worldPresenceStore.captains[ck];
              worldPresenceDirty = true;
            }
            flushNavigatorMutationToDisk();
            ws.send(JSON.stringify({ type: 'admin_ok', action: 'delete_registered_captain', captainKey: ck }));
            break;
          }
          if (action === 'list_bans') {
            ws.send(JSON.stringify({ type: 'admin_bans', ips: Array.from(bannedIps).sort() }));
            break;
          }
          if (action === 'unban') {
            const ip = msg.ip != null ? String(msg.ip).trim() : '';
            if (!ip) {
              ws.send(JSON.stringify({ type: 'admin_error', error: 'Missing IP to unban.' }));
              break;
            }
            bannedIps.delete(ip);
            saveBans();
            flushNavigatorMutationToDisk();
            ws.send(JSON.stringify({ type: 'admin_ok', action: 'unban' }));
            break;
          }
          if (action === 'get_chat_log') {
            ws.send(JSON.stringify({ type: 'admin_chat_log', messages: chatHistory.slice() }));
            break;
          }
          if (action === 'delete_chat_message') {
            const cid = msg.chatId != null ? Number(msg.chatId) : NaN;
            if (!Number.isFinite(cid)) {
              ws.send(JSON.stringify({ type: 'admin_error', error: 'Invalid chat message id.' }));
              break;
            }
            const ix = chatHistory.findIndex(m => m.id === cid);
            if (ix >= 0) chatHistory.splice(ix, 1);
            broadcastAll({ type: 'chat_removed', chatId: cid });
            ws.send(JSON.stringify({ type: 'admin_ok', action: 'delete_chat_message' }));
            break;
          }
          if (action === 'clear_chat') {
            chatHistory.length = 0;
            broadcastAll({ type: 'chat_cleared' });
            ws.send(JSON.stringify({ type: 'admin_ok', action: 'clear_chat' }));
            break;
          }
          if (action === 'list_clans') {
            const clans = [];
            for (const pr of Object.values(partyStore.parties)) {
              if (!pr) continue;
              migratePartyRecord(pr);
              clans.push({
                id: pr.id,
                tag: pr.tag,
                leaderKey: pr.leaderKey,
                memberKeys: (pr.memberKeys || []).slice(),
                officerKeys: (pr.officerKeys || []).slice(),
                pendingKeys: (pr.pendingKeys || []).slice()
              });
            }
            clans.sort((a, b) => String(a.tag || '').localeCompare(String(b.tag || '')));
            try {
              ws.send(JSON.stringify({ type: 'admin_clans', clans }));
            } catch (e) {}
            break;
          }
          if (action === 'delete_clan') {
            const partyId = msg.partyId != null ? String(msg.partyId).trim() : '';
            if (!partyId || !partyStore.parties[partyId]) {
              try {
                ws.send(JSON.stringify({ type: 'admin_error', error: 'Unknown clan id.' }));
              } catch (e) {}
              break;
            }
            disbandParty(partyId);
            flushNavigatorMutationToDisk();
            try {
              ws.send(JSON.stringify({ type: 'admin_ok', action: 'delete_clan', partyId }));
            } catch (e) {}
            break;
          }
          if (targetId == null || !Number.isFinite(targetId)) {
            ws.send(JSON.stringify({ type: 'admin_error', error: 'Missing target.' }));
            break;
          }
          if (action === 'mute') {
            mutedPlayerIds.add(targetId);
            ws.send(JSON.stringify({ type: 'admin_players', players: collectAdminPlayerList() }));
            break;
          }
          if (action === 'unmute') {
            mutedPlayerIds.delete(targetId);
            ws.send(JSON.stringify({ type: 'admin_players', players: collectAdminPlayerList() }));
            break;
          }
          if (action === 'kick') {
            const tw = findWsByPlayerId(targetId);
            if (tw) {
              try {
                tw.send(JSON.stringify({ type: 'kicked', reason: 'Removed by navigator (kick). You may rejoin.' }));
              } catch (e) {}
              tw.close();
            }
            ws.send(JSON.stringify({ type: 'admin_players', players: collectAdminPlayerList() }));
            break;
          }
          if (action === 'ban') {
            const tw = findWsByPlayerId(targetId);
            const banIp = tw && tw.clientIp ? tw.clientIp : (players.get(targetId)?.clientIp || '');
            if (banIp && banIp !== 'unknown') {
              bannedIps.add(banIp);
              saveBans();
            }
            if (tw) {
              try {
                tw.send(JSON.stringify({ type: 'banned', reason: 'Banned from this server.' }));
              } catch (e) {}
              tw.close();
            }
            flushNavigatorMutationToDisk();
            ws.send(JSON.stringify({ type: 'admin_players', players: collectAdminPlayerList() }));
            break;
          }
          ws.send(JSON.stringify({ type: 'admin_error', error: 'Unknown admin action.' }));
          break;
        }
        case 'client_ping': {
          const t0 = msg.t != null && Number.isFinite(Number(msg.t)) ? Number(msg.t) : null;
          try {
            ws.send(JSON.stringify(t0 != null
              ? { type: 'client_pong', t: t0 }
              : { type: 'client_pong', t: Date.now() }));
          } catch (e) {}
          break;
        }
        case 'rtt_update': {
          const raw = msg.ms != null ? Number(msg.ms) : NaN;
          if (!Number.isFinite(raw) || raw < 0 || raw > 120000) break;
          const pl = players.get(id);
          if (pl) pl.rtt = Math.min(120000, Math.round(raw));
          break;
        }
        case 'get_leaderboard': {
          reconcileLeaderboardRows();
          ws.send(JSON.stringify({ type: 'leaderboard', entries: leaderboardHistory }));
          break;
        }
        case 'leaderboard_offer': {
          if (leaderboardClientSeeded || leaderboardHistory.length > 0) break;
          const entries = msg.entries;
          if (!Array.isArray(entries) || entries.length === 0) break;
          leaderboardHistory = entries.slice(0, LEADERBOARD_CAP).map(normalizeLbEntry);
          reconcileLeaderboardRows();
          saveLeaderboard();
          leaderboardClientSeeded = true;
          broadcast({ type: 'leaderboard', entries: leaderboardHistory });
          break;
        }
      }
    } catch (e) {
      console.error('[playground] ws message error:', e && e.message ? e.message : e);
    }
  });

  ws.on('close', () => {
    try {
    clearCaptainSocketSlot(ws);
    const left = players.get(id);
    const leftCk = left && left.captainKey ? normalizeCaptainKey(String(left.captainKey))
      : (ws.captainAccountKey ? normalizeCaptainKey(String(ws.captainAccountKey)) : null);
    /* Drop boarding engagements that referenced this captain so peers do not follow stale grapple state. */
    for (const pl of players.values()) {
      if (!pl.boarding) continue;
      const sid = Math.floor(Number(pl.boarding.sid));
      if (Number.isFinite(sid) && sid === id) pl.boarding = null;
    }
    playerStories.delete(id);
    playerQuests.delete(id);
    if (leftCk && left && !left.docked) {
      persistCaptainWorldPresenceFromPlayer(leftCk, left);
      try {
        writeFileAtomic(WORLD_PRESENCE_FILE, JSON.stringify(worldPresenceStore));
        worldPresenceDirty = false;
      } catch (e) {}
    }
    players.delete(id);
    broadcast({ type: 'player_leave', id });
    broadcastServerPopulation();
    sendNpcSimulationDelegates();
    if (leftCk) {
      const prLeft = getPartyForCaptainKey(leftCk);
      if (prLeft) broadcastPartySync(prLeft.id);
    }
    try {
      reconcileLeaderboardRows();
      savePartyStore();
      if (WORLD_MAP_PAYLOAD && validateWorldMapPayload(WORLD_MAP_PAYLOAD) && (WORLD_MAP_REVISION >>> 0) > 0) {
        persistWorldMapToDisk();
        lastWorldMapDiskWriteMs = Date.now();
      }
      broadcast({ type: 'leaderboard', entries: leaderboardHistory });
    } catch (e) {}
    } catch (e) {
      console.error('[playground] ws close handler error:', e && e.message ? e.message : e);
    }
  });
});

/** Detect frozen/crashed browser tabs that never send TCP close — terminate stale sockets. */
const WS_PING_INTERVAL_MS = Math.max(15000, Number(process.env.WS_PING_INTERVAL_MS) || 38000);
const wsHeartbeat = setInterval(() => {
  try {
    wss.clients.forEach(ws => {
      if (ws.readyState !== 1) return;
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch (e) {}
        return;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) {}
    });
  } catch (e) {
    console.error('[playground] ws ping sweep error:', e && e.message ? e.message : e);
  }
}, WS_PING_INTERVAL_MS);

let serverStateTickSeq = 0;
setInterval(() => {
  try {
  if (players.size === 0) {
    npcWorldHadPlayers = false;
    return;
  }
  serverStateTickSeq++;
  ensureSimulationLayer();
  gameSim.stepAll(players);
  ensureNpcWorld();
  if (!npcWorldHadPlayers) {
    npcWorld.setWorldSeed(WORLD_SEED >>> 0);
    npcWorld.reset(players);
    npcWorldHadPlayers = true;
  }
  try {
    ensureWorldPolitics().tickEconomy(1 / TICK_RATE);
  } catch (e) {}
  npcWorld.step(1 / TICK_RATE, players, playerStories, playerQuests);
  if (serverStateTickSeq % 4 === 0) {
    try {
      broadcastAll({
        type: 'npc_sync',
        npcs: npcWorld.buildSyncRows(),
        wind: npcWorld.getWindSample(),
        srvTick: serverStateTickSeq
      });
    } catch (e) {}
  }
  if (serverStateTickSeq % 540 === 0) {
    try {
      const wp = ensureWorldPolitics().snapshot();
      broadcastAll({
        type: 'politics_snap',
        matrix: wp.matrix,
        fw: wp.factionWealth,
        pc: wp.portController,
        inf: wp.inflation,
        pg: wp.portGarrison
      });
    } catch (e) {}
  }
  const includeCrew = (serverStateTickSeq % 2 === 0);
  const tickWorldT = (Date.now() - SERVER_WORLD_T0_MS) / 1000;
  const all = Array.from(players.values());
  for (const client of wss.clients) {
    if (client.readyState !== 1 || client.playerId == null) continue;
    const viewer = players.get(client.playerId);
    if (!viewer) continue;
    const snap = [];
    for (const p of all) {
      if (!playerIncludedInSnapshot(viewer, p, STATE_AOI_RADIUS_SQ)) continue;
      snap.push(buildStateRow(p, includeCrew || !!p.boarding));
    }
    try {
      client.send(JSON.stringify({
        type: 'state',
        players: snap,
        worldT: tickWorldT,
        wildlifeWorldT: tickWorldT,
        srvTick: serverStateTickSeq,
        aoiR: STATE_AOI_RADIUS
      }));
    } catch (e) {}
  }
  } catch (e) {
    console.error('[playground] state tick error:', e && e.message ? e.message : e);
  }
}, 1000 / TICK_RATE);

process.on('uncaughtException', err => {
  console.error('[playground] uncaughtException — process will exit (restart via PM2/systemd):', err);
  try { clearInterval(wsHeartbeat); } catch (e) {}
  process.exit(1);
});
process.on('unhandledRejection', reason => {
  console.error('[playground] unhandledRejection:', reason);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Pirate game server running on port ${PORT}`);
  console.log(`World seed: ${WORLD_SEED}`);
  ensureSimulationLayer();
  const ac = antiCheat && antiCheat.cfg;
  if (ac) {
    console.log(`[playground] simulation: authoritative wind + hull integration @ ${TICK_RATE}Hz (simulation-layer.js)`);
    console.log(`[playground] anticheat: max ${ac.maxUpdatesPerSec}/s updates · Δpos≤${ac.maxPositionJump} · kick after ${ac.violationKickThreshold} violations / ${ac.violationWindowMs}ms (override AC_* env in simulation-layer.js)`);
  }
  const rc = getRealmConfig();
  console.log(`[playground] realm: «${rc.name}» (${rc.id}) — REALM_NAME / REALM_ID env`);
  console.log(`[playground] multiplayer AOI radius (world units): ${STATE_AOI_RADIUS} — set STATE_AOI_RADIUS env to tune; per-client state lists only nearby captains (+ boarding partners).`);
  if (MAX_CONCURRENT_CAPTAINS > 0) console.log(`[playground] concurrent captain cap: ${MAX_CONCURRENT_CAPTAINS} (MAX_CONCURRENT_CAPTAINS)`);
  const navMsg = NAVIGATOR_ADMIN_PASSWORD
    ? `password configured (${NAVIGATOR_ADMIN_PASSWORD_SOURCE === 'env' ? 'NAVIGATOR_ADMIN_PASSWORD' : 'navigator_admin.secret'})`
    : 'NOT SET — set NAVIGATOR_ADMIN_PASSWORD or add navigator_admin.secret beside server.js for F3';
  console.log(`Navigator admin: ${navMsg}`);
});
