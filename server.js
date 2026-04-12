const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const TICK_RATE = 20;
const SEED_FILE = path.join(__dirname, 'world_seed.json');
/** Stable default when no file/env (matches client `CANONICAL_DEFAULT_WORLD_SEED`). Commit `world_seed.json` so restarts and deploys always reload the same archipelago unless you intentionally change the file or set `WORLD_SEED`. */
const DEFAULT_WORLD_SEED = 42;
let WORLD_SEED;
try {
  const raw = JSON.parse(fs.readFileSync(SEED_FILE, 'utf-8'));
  WORLD_SEED = Number(raw.seed) >>> 0;
} catch (e) {
  const envS = process.env.WORLD_SEED;
  if (envS != null && String(envS).trim() !== '') {
    WORLD_SEED = Number(envS) >>> 0;
  } else {
    WORLD_SEED = DEFAULT_WORLD_SEED >>> 0;
  }
  try { fs.writeFileSync(SEED_FILE, JSON.stringify({ seed: WORLD_SEED })); } catch (e2) {}
}

/** Set `NAVIGATOR_ADMIN_PASSWORD` in the environment so F3 / navigator tools can authenticate without embedding secrets in the client. */
const NAVIGATOR_ADMIN_PASSWORD = process.env.NAVIGATOR_ADMIN_PASSWORD || '';
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

const LB_FILE = path.join(__dirname, 'leaderboard.json');
let leaderboardHistory = [];
try {
  const lbRaw = fs.readFileSync(LB_FILE, 'utf-8');
  const parsed = JSON.parse(lbRaw);
  if (Array.isArray(parsed)) leaderboardHistory = parsed;
} catch (e) {
  leaderboardHistory = [];
  try { fs.writeFileSync(LB_FILE, JSON.stringify(leaderboardHistory)); } catch (e2) {}
}
function saveLeaderboard() {
  try { fs.writeFileSync(LB_FILE, JSON.stringify(leaderboardHistory)); } catch (e) {}
}
setInterval(() => { saveLeaderboard(); }, 60000);
function persistLeaderboardShutdown() {
  saveLeaderboard();
}
process.on('SIGINT', persistLeaderboardShutdown);
process.on('SIGTERM', persistLeaderboardShutdown);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function setWorldSeedAndPersist(newSeed) {
  WORLD_SEED = Number(newSeed) >>> 0;
  try { fs.writeFileSync(SEED_FILE, JSON.stringify({ seed: WORLD_SEED })); } catch (e) {}
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

wss.on('connection', (ws) => {
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
    shipParts: { hull: 'basic', sail: 'basic', cannon: 'none', figurehead: 'none' },
    color: `hsl(${Math.random() * 360}, 70%, 50%)`,
    name: `Pirate_${id}`,
    health: 100,
    crewCount: 3
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
          break;
        }
        case 'set_name': {
          const p = players.get(id);
          if (p && msg.name) p.name = msg.name.slice(0, 28);
          if (p && msg.shipName) p.shipName = msg.shipName.slice(0, 28);
          if (p && msg.crew) p.crewData = msg.crew.slice(0, 6);
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
          broadcast({ type: 'chat', id, name: players.get(id)?.name || 'Unknown', text: msg.text });
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
          broadcastAll({
            type: 'ship_sunk',
            victimId,
            x: msg.x,
            z: msg.z,
            loot,
            name: players.get(victimId)?.name || msg.name || 'Unknown'
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
          const dk = Math.max(0, Math.floor(msg.kills || 0));
          const dl = Math.max(0, Math.floor(msg.loot || 0));
          if (dk === 0 && dl === 0) break;
          const kp = players.get(killerId);
          if (!kp) break;
          kp.kills = (kp.kills || 0) + dk;
          kp.loot = (kp.loot || 0) + dl;
          const capName = (kp.name || kp.shipName || 'Pirate').slice(0, 28);
          let row = leaderboardHistory.find(e => e.name === capName);
          if (!row) {
            row = { name: capName, kills: 0, loot: 0 };
            leaderboardHistory.push(row);
          }
          row.kills += dk;
          row.loot += dl;
          leaderboardHistory.sort((a, b) => b.kills - a.kills || b.loot - a.loot);
          leaderboardHistory = leaderboardHistory.slice(0, 50);
          saveLeaderboard();
          broadcast({ type: 'leaderboard', entries: leaderboardHistory });
          break;
        }
        case 'leaderboard_update': {
          const p = players.get(id);
          if (!p) break;
          const dk = msg.kills || 0;
          const dl = msg.loot || 0;
          p.kills = (p.kills || 0) + dk;
          p.loot = (p.loot || 0) + dl;
          const capName = (p.name || p.shipName || 'Pirate').slice(0, 28);
          let row = leaderboardHistory.find(e => e.name === capName);
          if (!row) {
            row = { name: capName, kills: 0, loot: 0 };
            leaderboardHistory.push(row);
          }
          row.kills += dk;
          row.loot += dl;
          leaderboardHistory.sort((a, b) => b.kills - a.kills || b.loot - a.loot);
          leaderboardHistory = leaderboardHistory.slice(0, 50);
          saveLeaderboard();
          broadcast({ type: 'leaderboard', entries: leaderboardHistory });
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
    name: p.name, color: p.color, shipType: p.shipType, shipName: p.shipName, crewData: p.crewData
  }));
  broadcast({ type: 'state', players: snapshot });
}, 1000 / TICK_RATE);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Pirate game server running on port ${PORT}`);
  console.log(`World seed: ${WORLD_SEED}`);
  console.log(`Navigator admin: ${NAVIGATOR_ADMIN_PASSWORD ? 'password configured (env)' : 'NOT SET — set NAVIGATOR_ADMIN_PASSWORD for F3'}`);
});
