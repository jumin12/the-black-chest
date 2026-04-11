const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const TICK_RATE = 20;
const WORLD_SEED = Math.floor(Math.random() * 999999);

const players = new Map();
let nextId = 1;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ status: 'ok', players: players.size, seed: WORLD_SEED }));
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
          broadcast({ type: 'cannonball', id, x: msg.x, z: msg.z, dx: msg.dx, dz: msg.dz }, id);
          break;
        }
        case 'npc_sync': {
          broadcast({ type: 'npc_sync', npcs: msg.npcs }, id);
          break;
        }
        case 'ship_sunk': {
          broadcast({ type: 'ship_sunk', id, x: msg.x, z: msg.z, loot: msg.loot, name: players.get(id)?.name || 'Unknown' });
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
    name: p.name, color: p.color, shipType: p.shipType, shipName: p.shipName
  }));
  broadcast({ type: 'state', players: snapshot });
}, 1000 / TICK_RATE);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Pirate game server running on port ${PORT}`);
  console.log(`World seed: ${WORLD_SEED}`);
});
