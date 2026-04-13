const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const TICK_RATE = 20;
/** Optional directory for persistent JSON (e.g. Docker volume). Defaults next to server.js. */
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
const SEED_FILE = path.join(DATA_DIR, 'world_seed.json');
const LB_FILE_LEGACY = path.join(DATA_DIR, 'leaderboard.json');
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
let nextId = 1;
let nextLootNetId = 1;
let nextSwimmerNetId = 1;
let nextChatMessageId = 1;
const CHAT_HISTORY_MAX = 200;
/** @type {{ id: number, t: number, playerId: number, name: string, text: string }[]} */
const chatHistory = [];

const BANS_FILE = path.join(DATA_DIR, 'bans.json');
let leaderboardHistory = [];
/** @type {Set<string>} */
let bannedIps = new Set();
/** @type {Set<number>} */
const mutedPlayerIds = new Set();

function normalizeLbEntry(e) {
  if (!e || typeof e !== 'object') {
    return { name: 'Unknown', gold: 0, sinksAi: 0, sinksPlayer: 0, ransoms: 0, deaths: 0, playerId: null, captainKey: null };
  }
  const name = String(e.name || 'Pirate').slice(0, 28);
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
  return { name, gold, sinksAi, sinksPlayer, ransoms, deaths, playerId, captainKey };
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
      if (e.name && e.name !== 'Pirate') o.name = e.name;
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
    if (ck) row.captainKey = ck;
    leaderboardHistory[i] = row;
  }
}

function isAutoGeneratedPirateName(name) {
  return /^pirate_\d+$/i.test(String(name || '').trim());
}

/**
 * One row per captain account (`captainKey`); reclaim offline rows by account key, never by name alone.
 */
function getLeaderboardRowIndex(socketId, capName, accountCaptainKey) {
  capName = String(capName || 'Pirate').slice(0, 28);
  const hasReservedAccount = accountCaptainKey != null && String(accountCaptainKey).trim() !== '';
  let rowCaptainKey = null;
  if (hasReservedAccount) {
    rowCaptainKey = normalizeCaptainKey(String(accountCaptainKey)) || null;
  } else if (!isAutoGeneratedPirateName(capName)) {
    rowCaptainKey = normalizeCaptainKey(capName) || null;
  }

  let idx = leaderboardHistory.findIndex(r => normalizeLbEntry(r).playerId === socketId);
  if (idx >= 0) {
    const row = normalizeLbEntry(leaderboardHistory[idx]);
    row.playerId = socketId;
    row.name = capName;
    if (rowCaptainKey) row.captainKey = rowCaptainKey;
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
      leaderboardHistory[idx] = row;
      return idx;
    }
  }

  const row = normalizeLbEntry({ name: capName, playerId: socketId, captainKey: rowCaptainKey });
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

function persistWorldSeedFile() {
  try {
    fs.writeFileSync(SEED_FILE, JSON.stringify({ seed: WORLD_SEED, leaderboard: leaderboardHistory }));
  } catch (e) {}
}

function migrateLegacyStandaloneLeaderboard() {
  if (leaderboardHistory.length > 0) return;
  try {
    const lbRaw = fs.readFileSync(LB_FILE_LEGACY, 'utf-8');
    const parsed = JSON.parse(lbRaw);
    if (!Array.isArray(parsed) || parsed.length === 0) return;
    leaderboardHistory = parsed.map(normalizeLbEntry);
    persistWorldSeedFile();
  } catch (e) {}
}

function loadPersistedState() {
  let raw = null;
  const seedFileExists = fs.existsSync(SEED_FILE);
  if (seedFileExists) {
    try {
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
    leaderboardHistory = [];
    if (!seedFileExists) {
      try {
        fs.writeFileSync(SEED_FILE, JSON.stringify({ seed: WORLD_SEED, leaderboard: [] }));
      } catch (e2) {}
    }
    migrateLegacyStandaloneLeaderboard();
    return;
  }
  WORLD_SEED = raw.seed != null ? Number(raw.seed) >>> 0 : DEFAULT_WORLD_SEED >>> 0;
  leaderboardHistory = Array.isArray(raw.leaderboard)
    ? raw.leaderboard.map(normalizeLbEntry)
    : [];
  migrateLegacyStandaloneLeaderboard();
}

loadPersistedState();
backfillLeaderboardCaptainKeys();
mergeLeaderboardByIdentity();
sortLeaderboardHistory();

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
      navigatorAuthConfigured: !!(NAVIGATOR_ADMIN_PASSWORD && String(NAVIGATOR_ADMIN_PASSWORD).length > 0)
    }));
    return;
  }

  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('Error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html', ...CORS_HEADERS });
      res.end(data);
    });
  } else {
    res.writeHead(404, CORS_HEADERS);
    res.end('Not found');
  }
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
    shipType: 'sloop',
    shipParts: { hull: 'basic', sail: 'basic', cannon: 'light', figurehead: 'none' },
    color: `hsl(${Math.random() * 360}, 70%, 50%)`,
    name: `Pirate_${id}`,
    health: 100,
    crewCount: 3,
    clientIp
  };

  players.set(id, playerData);

  ws.send(JSON.stringify({
    type: 'init',
    id,
    seed: WORLD_SEED,
    player: playerData,
    players: Array.from(players.values()).filter(p => p.id !== id)
  }));
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
          if (msg.crew) p.crewData = msg.crew.slice(0, 6);
          ws.captainAccountKey = newKey;
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
          broadcast({ type: 'cannonball', shooterId: id, x: msg.x, z: msg.z, dx: msg.dx, dz: msg.dz }, id);
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
            const swimmers = msg.swimmers.map(s => ({
              x: s.x,
              z: s.z,
              restore: s.restore || null,
              id: nextSwimmerNetId++
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
          const idx = getLeaderboardRowIndex(killerId, capName, kp.captainKey || null);
          const row = normalizeLbEntry(leaderboardHistory[idx]);
          row.sinksPlayer += dk;
          row.gold += dl;
          leaderboardHistory[idx] = row;
          sortLeaderboardHistory();
          leaderboardHistory = leaderboardHistory.slice(0, 50);
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
          const idx = getLeaderboardRowIndex(id, capName, ws.captainAccountKey || p.captainKey || null);
          const row = normalizeLbEntry(leaderboardHistory[idx]);
          row.gold += dg;
          row.sinksAi += dAi;
          row.sinksPlayer += dPl;
          row.ransoms += dr;
          row.deaths += dd;
          leaderboardHistory[idx] = row;
          sortLeaderboardHistory();
          leaderboardHistory = leaderboardHistory.slice(0, 50);
          saveLeaderboard();
          broadcast({ type: 'leaderboard', entries: leaderboardHistory });
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
          if (action === 'reset_leaderboard') {
            leaderboardHistory = [];
            sortLeaderboardHistory();
            saveLeaderboard();
            broadcast({ type: 'leaderboard', entries: leaderboardHistory });
            ws.send(JSON.stringify({ type: 'admin_ok', action: 'reset_leaderboard' }));
            break;
          }
          if (action === 'reset_all_time_data') {
            leaderboardHistory = [];
            sortLeaderboardHistory();
            saveLeaderboard();
            broadcast({ type: 'leaderboard', entries: leaderboardHistory });
            broadcastAll({ type: 'reset_local_career_data' });
            ws.send(JSON.stringify({ type: 'admin_ok', action: 'reset_all_time_data' }));
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
          ws.send(JSON.stringify({ type: 'leaderboard', entries: leaderboardHistory }));
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
    shipParts: p.shipParts || { hull: 'basic', sail: 'basic', cannon: 'light', figurehead: 'none' },
    crewData: p.crewData
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
