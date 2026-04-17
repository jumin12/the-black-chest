const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
/** World state broadcast rate (Hz); keep client send interval in index.html in sync (~1/TICK_RATE). */
const TICK_RATE = 45;
/** Optional directory for persistent JSON (e.g. Docker volume). Defaults next to server.js. */
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
const SEED_FILE = path.join(DATA_DIR, 'world_seed.json');
const WORLD_MAP_FILE = path.join(DATA_DIR, 'world_map.json');
/** Snapshot of the chart before the last successful publish — used for one-step revert. */
const WORLD_MAP_BACKUP_FILE = path.join(DATA_DIR, 'world_map.prev.json');
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
/** Shared narrative + contracts for all captains on this server (merged from clients, broadcast on change). */
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
/** @type {object[]|null} */
let worldQuests = null;
let nextId = 1;
let nextLootNetId = 1;
let nextSwimmerNetId = 1;
let nextChatMessageId = 1;
const CHAT_HISTORY_MAX = 200;
/** @type {{ id: number, t: number, playerId: number, name: string, text: string }[]} */
const chatHistory = [];

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
    return { name: 'Unknown', gold: 0, sinksAi: 0, sinksPlayer: 0, ransoms: 0, deaths: 0, playerId: null, captainKey: null, shipName: '' };
  }
  const name = String(e.name || 'Pirate').slice(0, 28);
  const shipName = e.shipName != null ? String(e.shipName).slice(0, 28) : '';
  const gold = Math.max(0, Math.floor(
    e.gold != null ? Number(e.gold) : (e.loot != null ? Number(e.loot) : 0)
  ));
  const sinksAi = Math.max(0, Math.floor(
    e.sinksAi != null ? Number(e.sinksAi) : (e.kills != null ? Number(e.kills) : 0)
  ));
  const sinksPlayer = Math.max(0, Math.floor(Number(e.sinksPlayer) || 0));
  const ransoms = Math.max(0, Math.floor(Number(e.ransoms) || 0));
  const deaths = Math.max(0, Math.floor(Number(e.deaths) || 0));
  const rawPid = e.playerId != null && e.playerId !== '' ? Number(e.playerId) : null;
  const playerId = Number.isFinite(rawPid) ? rawPid : null;
  let captainKey = null;
  if (e.captainKey != null && String(e.captainKey).trim() !== '') {
    const ck = normalizeCaptainKey(String(e.captainKey));
    if (ck) captainKey = ck;
  }
  return { name, gold, sinksAi, sinksPlayer, ransoms, deaths, playerId, captainKey, shipName };
}

/**
 * Fold duplicate rows that belong to the same captain account (`captainKey`) or same numeric id.
 * Does not merge different people who only share a display name.
 */
function mergeLeaderboardByIdentity() {
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
      o.gold += e.gold;
      o.sinksAi += e.sinksAi;
      o.sinksPlayer += e.sinksPlayer;
      o.ransoms += e.ransoms;
      o.deaths += e.deaths;
      if (e.name && e.name !== 'Pirate' && e.name !== 'Unknown') o.name = e.name;
      if (e.shipName && String(e.shipName).trim()) o.shipName = String(e.shipName).slice(0, 28);
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
    const ta = na.sinksAi + na.sinksPlayer + na.ransoms * 0.25;
    const tb = nb.sinksAi + nb.sinksPlayer + nb.ransoms * 0.25;
    if (tb !== ta) return tb - ta;
    if (nb.gold !== na.gold) return nb.gold - na.gold;
    return String(na.name).localeCompare(String(nb.name));
  });
}

/** Fold duplicate captain rows (same `captainKey` or same `playerId`) after backfilling keys from display names. */
function reconcileLeaderboardRows() {
  stripMergePoisonousCaptainKeys();
  backfillLeaderboardCaptainKeys();
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
  const worldPayload = JSON.stringify({ seed: WORLD_SEED, leaderboard: leaderboardHistory });
  const lbOnly = JSON.stringify(leaderboardHistory);
  try {
    writeFileAtomic(SEED_FILE, worldPayload);
    writeFileAtomic(LEADERBOARD_FILE, lbOnly);
    writeFileAtomic(LEADERBOARD_SHADOW, lbOnly);
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
        writeFileAtomic(SEED_FILE, JSON.stringify({ seed: WORLD_SEED, leaderboard: leaderboardHistory }));
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
}

loadPersistedState();

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

function loadWorldMapFromDisk() {
  WORLD_MAP_PAYLOAD = null;
  WORLD_MAP_REVISION = 0;
  try {
    if (!fs.existsSync(WORLD_MAP_FILE)) return;
    const raw = fs.readFileSync(WORLD_MAP_FILE, 'utf8');
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || !o.map) return;
    if (!validateWorldMapPayload(o.map)) return;
    WORLD_MAP_PAYLOAD = o.map;
    WORLD_MAP_REVISION = Number(o.revision) >>> 0;
    if (!WORLD_MAP_REVISION) WORLD_MAP_REVISION = 1;
  } catch (e) {
    WORLD_MAP_PAYLOAD = null;
    WORLD_MAP_REVISION = 0;
  }
}

function persistWorldMapToDisk() {
  if (!WORLD_MAP_PAYLOAD || !validateWorldMapPayload(WORLD_MAP_PAYLOAD)) return;
  try {
    writeFileAtomic(WORLD_MAP_FILE, JSON.stringify({
      revision: WORLD_MAP_REVISION,
      updatedAt: Date.now(),
      map: WORLD_MAP_PAYLOAD
    }));
  } catch (e) {
    console.error('[playground] persist world_map.json failed:', e.message);
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
  broadcastAll({ type: 'world_map', revision: WORLD_MAP_REVISION });
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
    broadcastAll({ type: 'world_map', revision: WORLD_MAP_REVISION });
    return true;
  } catch (e) {
    console.error('[playground] world_map revert failed:', e.message);
    return false;
  }
}

loadWorldMapFromDisk();
reconcileLeaderboardRows();
leaderboardClientSeeded = leaderboardHistory.length > 0;
if (leaderboardHistory.length) persistWorldSeedFile();

setInterval(() => {
  if (leaderboardHistory.length > 0) persistWorldSeedFile();
}, 20000);

process.on('beforeExit', () => {
  try {
    if (leaderboardHistory.length > 0) persistWorldSeedFile();
  } catch (e) {}
});

function saveLeaderboard() {
  persistWorldSeedFile();
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
pruneStaleCaptainAccounts();
setInterval(() => {
  pruneStaleCaptainAccounts();
}, 60 * 60 * 1000);
setInterval(flushCaptainAccountsIfDirty, 15000);

setInterval(() => { saveLeaderboard(); }, 60000);
function persistLeaderboardShutdown() {
  saveLeaderboard();
}
function persistCaptainAccountsShutdown() {
  flushCaptainAccountsIfDirty();
}
process.on('SIGINT', () => {
  persistLeaderboardShutdown();
  persistCaptainAccountsShutdown();
});
process.on('SIGTERM', () => {
  persistLeaderboardShutdown();
  persistCaptainAccountsShutdown();
});

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function setWorldSeedAndPersist(newSeed) {
  WORLD_SEED = Number(newSeed) >>> 0;
  persistWorldSeedFile();
  broadcastAll({ type: 'world_seed', seed: WORLD_SEED });
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
      navigatorAuthConfigured: !!(NAVIGATOR_ADMIN_PASSWORD && String(NAVIGATOR_ADMIN_PASSWORD).length > 0)
    }));
    return;
  }

  const reqPath = String(req.url || '').split('?')[0];
  if (req.method === 'GET' && reqPath === '/favicon.ico') {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
      + '<rect width="32" height="32" rx="5" fill="#1a140c"/>'
      + '<path fill="#d4a848" d="M16 5l2.2 7.2H26l-5.8 4.4L22.4 26 16 21.7 9.6 26l2.2-9.4L6 12.2h7.8L16 5z"/>'
      + '</svg>'
    );
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
      ...CORS_HEADERS
    });
    res.end(svg);
    return;
  }

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

const wss = new WebSocketServer({ server });

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
    const type = q.type === 'hunt' || q.type === 'explore' || q.type === 'delivery' ? q.type : null;
    if (!type) continue;
    const row = {
      type,
      desc: String(q.desc != null ? q.desc : '').slice(0, 220),
      reward: Math.max(0, Math.floor(Number(q.reward) || 0)),
      accepted: !!q.accepted
    };
    if (type === 'hunt') row.target = String(q.target != null ? q.target : '').slice(0, 48);
    if (type === 'explore') {
      row.x = q.x != null ? Math.round(Number(q.x)) : 0;
      row.z = q.z != null ? Math.round(Number(q.z)) : 0;
    }
    if (type === 'delivery') {
      row.item = String(q.item != null ? q.item : 'wood').slice(0, 24);
      row.count = Math.max(1, Math.min(99, Math.floor(Number(q.count) || 1)));
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
  const clientIp = normalizeClientIp(req);
  ws.clientIp = clientIp;
  if (bannedIps.has(clientIp)) {
    try {
      ws.send(JSON.stringify({ type: 'banned', reason: 'You are banned from this server.' }));
    } catch (e) {}
    ws.close();
    return;
  }

  const id = nextId++;
  ws.playerId = id;

  const spawnAngle = Math.random() * Math.PI * 2;
  const spawnDist = 50 + Math.random() * 100;

  const playerData = {
    id,
    x: Math.cos(spawnAngle) * spawnDist,
    z: Math.sin(spawnAngle) * spawnDist,
    rotation: 0,
    speed: 0,
    shipType: 'cutter',
    shipName: '',
    shipParts: { hull: 'basic', sail: 'basic', cannon: 'light', figurehead: 'none', flag: 'mast' },
    flagColor: '#1a1a1a',
    color: `hsl(${Math.random() * 360}, 70%, 50%)`,
    name: `Pirate_${id}`,
    health: 100,
    crewCount: 3,
    crewData: null,
    docked: false,
    dockX: null,
    dockZ: null,
    dockAngle: null,
    riggingHealth: 100,
    morale: 100,
    clientIp
  };

  players.set(id, playerData);

  ws.send(JSON.stringify({
    type: 'init',
    id,
    seed: WORLD_SEED,
    worldMapRevision: WORLD_MAP_REVISION >>> 0,
    player: playerData,
    players: Array.from(players.values()).filter(p => p.id !== id),
    worldStory: sanitizeWorldStory(worldStoryQuest),
    worldQuests: worldQuests && worldQuests.length ? worldQuests : null
  }));
  reconcileLeaderboardRows();
  ws.send(JSON.stringify({ type: 'leaderboard', entries: leaderboardHistory }));

  for (const m of chatHistory.slice(-40)) {
    try {
      ws.send(JSON.stringify({
        type: 'chat',
        chatId: m.id,
        id: m.playerId,
        name: m.name,
        text: m.text
      }));
    } catch (e) {}
  }

  broadcast({ type: 'player_join', player: playerData }, id);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      switch (msg.type) {
        case 'update': {
          const p = players.get(id);
          if (!p) break;
          if (msg.x !== undefined) p.x = msg.x;
          if (msg.z !== undefined) p.z = msg.z;
          if (msg.rotation !== undefined) p.rotation = msg.rotation;
          if (msg.speed !== undefined) p.speed = msg.speed;
          if (msg.health !== undefined) p.health = msg.health;
          if (msg.docked !== undefined) p.docked = !!msg.docked;
          if (msg.dockX !== undefined) p.dockX = msg.dockX;
          if (msg.dockZ !== undefined) p.dockZ = msg.dockZ;
          if (msg.dockAngle !== undefined) p.dockAngle = msg.dockAngle;
          if (msg.riggingHealth !== undefined) p.riggingHealth = Math.max(0, Math.min(100, Number(msg.riggingHealth) || 0));
          if (msg.morale !== undefined) p.morale = Math.max(0, Math.min(100, Number(msg.morale) || 0));
          if (msg.shipType !== undefined && msg.shipType !== null) {
            const st = String(msg.shipType).trim().slice(0, 24);
            if (st) p.shipType = st;
          }
          if (msg.shipName !== undefined) p.shipName = String(msg.shipName || '').slice(0, 28);
          if (msg.flagColor !== undefined) p.flagColor = String(msg.flagColor || '').slice(0, 32);
          if (msg.shipParts !== undefined && msg.shipParts !== null && typeof msg.shipParts === 'object') {
            p.shipParts = {
              hull: 'basic', sail: 'basic', cannon: 'light', figurehead: 'none',
              ...p.shipParts,
              ...msg.shipParts
            };
          }
          if (msg.crewData && Array.isArray(msg.crewData)) p.crewData = msg.crewData.slice(0, 32);
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

          let duplicateOnline = false;
          for (const [pid, pl] of players) {
            if (pid === id) continue;
            if (normalizeCaptainKey(pl.name) === newKey) duplicateOnline = true;
          }
          if (duplicateOnline) {
            try {
              ws.send(JSON.stringify({ type: 'name_rejected', error: 'That captain name is already in use by a connected player.' }));
            } catch (e) {}
            break;
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
              delete captainAccounts[oldKey];
            }
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

          p.name = displayName;
          p.captainKey = newKey;
          if (msg.shipName) p.shipName = String(msg.shipName).slice(0, 28);
          if (msg.shipType !== undefined && msg.shipType !== null) {
            const st = String(msg.shipType).trim().slice(0, 24);
            if (st) p.shipType = st;
          }
          if (msg.flagColor !== undefined) p.flagColor = String(msg.flagColor || '').slice(0, 32);
          if (msg.shipParts !== undefined && msg.shipParts !== null && typeof msg.shipParts === 'object') {
            p.shipParts = {
              hull: 'basic', sail: 'basic', cannon: 'light', figurehead: 'none',
              ...p.shipParts,
              ...msg.shipParts
            };
          }
          if (msg.crew) p.crewData = msg.crew.slice(0, 32);
          ws.captainAccountKey = newKey;
          broadcastAll({
            type: 'player_identity',
            id,
            name: displayName,
            shipName: p.shipName != null ? String(p.shipName).slice(0, 28) : '',
            joinAnnounce: hadPlaceholderName
          });
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
          const mid = nextChatMessageId++;
          chatHistory.push({ id: mid, t: Date.now(), playerId: id, name, text });
          if (chatHistory.length > CHAT_HISTORY_MAX) chatHistory.shift();
          broadcastAll({ type: 'chat', chatId: mid, id, name, text });
          break;
        }
        case 'cannonball': {
          const a = msg.ammoType;
          const ammoType = a === 'grape' || a === 'chain' || a === 'grape_pellet' ? a : 'ball';
          broadcast({ type: 'cannonball', shooterId: id, x: msg.x, z: msg.z, dx: msg.dx, dz: msg.dz, ammoType }, id);
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
        case 'world_story_push': {
          const merged = mergeWorldStory(worldStoryQuest, msg.story);
          const before = JSON.stringify(worldStoryQuest);
          worldStoryQuest = merged;
          if (JSON.stringify(worldStoryQuest) !== before) {
            broadcastAll({ type: 'world_story', story: sanitizeWorldStory(worldStoryQuest) });
          }
          break;
        }
        case 'world_quests_push': {
          const next = sanitizeWorldQuests(msg.quests);
          worldQuests = next;
          broadcastAll({ type: 'world_quests', quests: next });
          break;
        }
        case 'npc_sync': {
          broadcast({ type: 'npc_sync', npcs: msg.npcs, wind: msg.wind }, id);
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
            broadcast({ type: 'leaderboard', entries: leaderboardHistory });
            try {
              ws.send(JSON.stringify({
                type: 'captain_career_deleted',
                captainKey: null,
                abandonUnregistered: true,
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
          const pidSelf = Number.isFinite(stripPid) && stripPid === id ? id : null;
          leaderboardHistory = leaderboardHistory.filter(r => {
            const n = normalizeLbEntry(r);
            if (n.captainKey === ck) return false;
            if (pidSelf != null && n.playerId != null && Number(n.playerId) === pidSelf) return false;
            const nk = normalizeCaptainKey(n.name);
            if (nk === ck && !isAutoGeneratedPirateName(n.name)) return false;
            return true;
          });
          const removedLb = before - leaderboardHistory.length;
          reconcileLeaderboardRows();
          saveLeaderboard();
          broadcast({ type: 'leaderboard', entries: leaderboardHistory });
          try {
            ws.send(JSON.stringify({
              type: 'captain_career_deleted',
              captainKey: ck,
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
          if (msg.id != null) broadcastAll({ type: 'swimmer_collect', id: msg.id });
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
          if (dg === 0 && dAi === 0 && dPl === 0 && dr === 0 && dd === 0) break;
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
          leaderboardHistory[idx] = row;
          reconcileLeaderboardRows();
          saveLeaderboard();
          broadcast({ type: 'leaderboard', entries: leaderboardHistory });
          break;
        }
        case 'npc_kill_credit': {
          let hostId = null;
          for (const pid of players.keys()) {
            if (hostId === null || pid < hostId) hostId = pid;
          }
          if (hostId === null || id !== hostId) break;
          const killerId = Math.floor(Number(msg.killerId));
          if (!Number.isFinite(killerId) || !players.has(killerId)) break;
          const dg = Math.max(0, Math.floor(Number(msg.gold) || 0));
          const dAi = Math.max(0, Math.floor(Number(msg.sinksAi) || 0));
          if (dg === 0 && dAi === 0) break;
          const kp = players.get(killerId);
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
          broadcastAll({
            type: 'npc_kill_award',
            killerId,
            gold: dg,
            sinksAi: dAi,
            storyBounty: !!msg.storyBounty,
            huntNpcName: msg.huntNpcName != null ? String(msg.huntNpcName).slice(0, 48) : '',
            victimName: msg.victimName != null ? String(msg.victimName).slice(0, 48) : 'ship'
          });
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
              sortLeaderboardHistory();
              saveLeaderboard();
              broadcast({ type: 'leaderboard', entries: leaderboardHistory });
            }
            ws.send(JSON.stringify({ type: 'admin_ok', action: 'clear_leaderboard_entry', removed }));
            break;
          }
          if (action === 'reset_leaderboard') {
            leaderboardHistory = [];
            leaderboardClientSeeded = true;
            sortLeaderboardHistory();
            saveLeaderboard();
            broadcast({ type: 'leaderboard', entries: leaderboardHistory, cleared: true });
            ws.send(JSON.stringify({ type: 'admin_ok', action: 'reset_leaderboard' }));
            break;
          }
          if (action === 'reset_all_time_data') {
            leaderboardHistory = [];
            leaderboardClientSeeded = true;
            sortLeaderboardHistory();
            saveLeaderboard();
            broadcast({ type: 'leaderboard', entries: leaderboardHistory, cleared: true });
            broadcastAll({ type: 'reset_local_career_data' });
            ws.send(JSON.stringify({ type: 'admin_ok', action: 'reset_all_time_data' }));
            break;
          }
          if (action === 'wipe_all_client_voyage_data') {
            captainAccounts = {};
            captainAccountsDirty = true;
            saveCaptainAccounts();
            broadcastAll({ type: 'navigator_wipe_local_voyage_data' });
            ws.send(JSON.stringify({ type: 'admin_ok', action: 'wipe_all_client_voyage_data' }));
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
            ws.send(JSON.stringify({ type: 'admin_players', players: collectAdminPlayerList() }));
            break;
          }
          ws.send(JSON.stringify({ type: 'admin_error', error: 'Unknown admin action.' }));
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
    } catch (e) { }
  });

  ws.on('close', () => {
    players.delete(id);
    broadcast({ type: 'player_leave', id });
  });
});

setInterval(() => {
  if (players.size === 0) return;
  const snapshot = Array.from(players.values()).map(p => ({
    id: p.id, x: p.x, z: p.z, rotation: p.rotation, speed: p.speed, health: p.health,
    name: p.name, color: p.color, shipType: p.shipType, shipName: p.shipName,
    flagColor: p.flagColor != null ? p.flagColor : '#1a1a1a',
    shipParts: p.shipParts || { hull: 'basic', sail: 'basic', cannon: 'light', figurehead: 'none', flag: 'mast' },
    crewData: p.crewData,
    docked: !!p.docked,
    dockX: p.dockX != null ? p.dockX : null,
    dockZ: p.dockZ != null ? p.dockZ : null,
    dockAngle: p.dockAngle != null ? p.dockAngle : null,
    riggingHealth: p.riggingHealth != null ? p.riggingHealth : 100,
    morale: p.morale != null ? p.morale : 100
  }));
  broadcast({ type: 'state', players: snapshot });
}, 1000 / TICK_RATE);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Pirate game server running on port ${PORT}`);
  console.log(`World seed: ${WORLD_SEED}`);
  const navMsg = NAVIGATOR_ADMIN_PASSWORD
    ? `password configured (${NAVIGATOR_ADMIN_PASSWORD_SOURCE === 'env' ? 'NAVIGATOR_ADMIN_PASSWORD' : 'navigator_admin.secret'})`
    : 'NOT SET — set NAVIGATOR_ADMIN_PASSWORD or add navigator_admin.secret beside server.js for F3';
  console.log(`Navigator admin: ${navMsg}`);
});
