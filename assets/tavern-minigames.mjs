/**
 * Port tavern minigames: Seelow (Ship, Captain & Crew) with lightweight Three.js table,
 * and Texas Hold'em vs AI with optional multiplayer lobby sync via `gamble_relay`.
 */

const _roomListeners = new Map(); // roomId -> Set<(payload)=>void>

export function subscribeGambleRoom(roomId, fn) {
  const id = String(roomId || '');
  if (!id) return () => {};
  if (!_roomListeners.has(id)) _roomListeners.set(id, new Set());
  const s = _roomListeners.get(id);
  s.add(fn);
  return () => {
    s.delete(fn);
    if (!s.size) _roomListeners.delete(id);
  };
}

export function handleGambleRelay(msg) {
  if (!msg || typeof msg !== 'object') return;
  const roomId = msg.roomId != null ? String(msg.roomId) : '';
  if (!roomId) return;
  const set = _roomListeners.get(roomId);
  if (!set) return;
  const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
  for (const fn of set) {
    try {
      fn({ fromId: msg.fromId, game: msg.game, payload });
    } catch (e) {}
  }
}

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashRoomSeed(roomId, salt) {
  const s = String(roomId) + ':' + String(salt);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/* ---- Ship, Captain & Crew (Seelow table) ---- */

function sccCargoScore(rng) {
  const dice = [1, 1, 1];
  const kept = [false, false, false];
  let ship = false;
  let cap = false;
  let crew = false;
  for (let roll = 0; roll < 3; roll++) {
    for (let i = 0; i < 3; i++) if (!kept[i]) dice[i] = 1 + Math.floor(rng() * 6);
    for (let i = 0; i < 3; i++) {
      if (kept[i]) continue;
      if (!ship && dice[i] === 6) {
        kept[i] = true;
        ship = true;
      }
    }
    for (let i = 0; i < 3; i++) {
      if (kept[i]) continue;
      if (ship && !cap && dice[i] === 5) {
        kept[i] = true;
        cap = true;
      }
    }
    for (let i = 0; i < 3; i++) {
      if (kept[i]) continue;
      if (ship && cap && !crew && dice[i] === 4) {
        kept[i] = true;
        crew = true;
      }
    }
    if (ship && cap && crew) break;
  }
  if (!ship || !cap || !crew) return { cargo: 0, dice: dice.slice(), kept: kept.slice() };
  let cargo = 0;
  for (let i = 0; i < 3; i++) if (!kept[i]) cargo += dice[i];
  return { cargo, dice: dice.slice(), kept: kept.slice() };
}

function buildDiceTableScene(THREE, mountEl, finalPips) {
  const w = mountEl.clientWidth || 400;
  const h = mountEl.clientHeight || 260;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1510);
  const camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 80);
  camera.position.set(0, 6.2, 7.4);
  camera.lookAt(0, 0, 0);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  mountEl.appendChild(renderer.domElement);
  const hemi = new THREE.HemisphereLight(0xdcc8a8, 0x221811, 0.9);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffe8c8, 0.85);
  dir.position.set(4, 12, 6);
  scene.add(dir);
  const table = new THREE.Mesh(
    new THREE.BoxGeometry(9, 0.35, 5.5),
    new THREE.MeshStandardMaterial({ color: 0x4a3020, roughness: 0.55, metalness: 0.08 })
  );
  table.position.y = -0.2;
  scene.add(table);
  const felt = new THREE.Mesh(
    new THREE.PlaneGeometry(8.2, 4.8),
    new THREE.MeshStandardMaterial({ color: 0x1e6b45, roughness: 0.95 })
  );
  felt.rotation.x = -Math.PI / 2;
  felt.position.y = 0.06;
  scene.add(felt);
  const pipColors = [0xc94c4c, 0x4c7ac9, 0xe0c040];
  const diceMeshes = [];
  for (let i = 0; i < 3; i++) {
    const g = new THREE.BoxGeometry(0.62, 0.62, 0.62);
    const mat = new THREE.MeshStandardMaterial({
      color: pipColors[i % pipColors.length],
      roughness: 0.45,
      metalness: 0.12
    });
    const m = new THREE.Mesh(g, mat);
    m.position.set((i - 1) * 1.35, 0.45, 0);
    scene.add(m);
    diceMeshes.push(m);
  }
  let animT = 0;
  const targets = (finalPips || [3, 3, 3]).map(p => Math.max(1, Math.min(6, p | 0)));
  let settled = false;
  function step() {
    if (settled) {
      renderer.render(scene, camera);
      return;
    }
    animT += 0.022;
    if (animT < 1.15) {
      for (let i = 0; i < diceMeshes.length; i++) {
        const m = diceMeshes[i];
        m.rotation.x += 0.31 + i * 0.07;
        m.rotation.y += 0.26;
        m.position.y = 0.45 + Math.sin(animT * 20 + i) * 0.08;
      }
    } else {
      settled = true;
      for (let i = 0; i < diceMeshes.length; i++) {
        const m = diceMeshes[i];
        m.rotation.set(0.15 * i, 0.2 * i, 0.1 * i);
        m.position.y = 0.45;
      }
    }
    renderer.render(scene, camera);
  }
  const iv = setInterval(step, 1000 / 45);
  function dispose() {
    clearInterval(iv);
    try { mountEl.removeChild(renderer.domElement); } catch (e) {}
    try { renderer.dispose(); } catch (e) {}
    scene.traverse(o => {
      if (o.geometry) try { o.geometry.dispose(); } catch (e) {}
      if (o.material) try { o.material.dispose(); } catch (e) {}
    });
  }
  return { dispose, step, diceMeshes, setFinalPips: pips => pips.forEach((p, i) => (targets[i] = p)) };
}

export function openSeelowDiceTable(ctx) {
  const root = document.createElement('div');
  root.style.cssText =
    'position:fixed;inset:0;z-index:95;display:flex;align-items:center;justify-content:center;background:rgba(6,4,3,0.78);padding:12px;font-family:Georgia,serif;';
  const panel = document.createElement('div');
  panel.style.cssText =
    'max-width:520px;width:100%;background:linear-gradient(165deg,rgba(34,24,16,0.98),rgba(12,9,6,0.99));border:1px solid rgba(200,150,80,0.45);border-radius:12px;padding:14px 16px;color:#e8dcc8;box-shadow:0 12px 44px rgba(0,0,0,0.55);';
  const bet = Math.min(50, Math.max(5, ctx.getGold() >= 10 ? 10 : 5));
  const roomId = `dice-${ctx.myId != null ? ctx.myId : 'solo'}-${Date.now()}`;
  let seed = hashRoomSeed(roomId, 'seelow');
  let remoteIds = [];

  panel.innerHTML = `<h3 style="margin:0 0 8px;font-size:18px;color:#e0c890;">Seelow — Ship, Captain &amp; Crew</h3>
    <div style="font-size:11px;color:#9a8a78;line-height:1.45;margin-bottom:8px;">Three six-sided dice on the felt. Build <strong>Ship (6)</strong>, <strong>Captain (5)</strong>, and <strong>Crew (4)</strong>, then your <strong>cargo</strong> is the sum of any remaining dice. Highest cargo wins the pot; unfinished hands score 0.</div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap;">
      <label style="font-size:11px;">Ante <input id="tavern-dice-bet" type="number" min="5" max="200" value="${bet}" style="width:72px;background:#1a1510;border:1px solid #5a4030;color:#e8dcc8;padding:4px;border-radius:4px;"/></label>
      <span id="tavern-dice-gold" style="font-size:11px;color:#d4a848;"></span>
    </div>
    <div id="tavern-dice-3d" style="width:100%;height:260px;border-radius:8px;overflow:hidden;border:1px solid rgba(80,60,40,0.5);background:#0e0c0a;"></div>
    <pre id="tavern-dice-log" style="margin:10px 0 0;font-size:11px;color:#c8bba8;white-space:pre-wrap;max-height:120px;overflow:auto;line-height:1.4;"></pre>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
      <button type="button" id="tavern-dice-start" style="flex:1;min-width:120px;padding:8px 10px;border-radius:8px;border:1px solid #c9a24a;background:linear-gradient(180deg,#6a4a20,#3a2208);color:#f0e0c8;cursor:pointer;font-family:Georgia,serif;">Start table</button>
      <button type="button" id="tavern-dice-close" style="padding:8px 12px;border-radius:8px;border:1px solid #555;background:#2a2220;color:#ccc;cursor:pointer;font-family:Georgia,serif;">Leave</button>
    </div>`;
  root.appendChild(panel);
  document.body.appendChild(root);

  const logEl = panel.querySelector('#tavern-dice-log');
  const goldEl = panel.querySelector('#tavern-dice-gold');
  const mount3d = panel.querySelector('#tavern-dice-3d');

  function refreshGold() {
    goldEl.textContent = `Your gold: ${ctx.getGold()}`;
  }
  refreshGold();

  const log = t => {
    logEl.textContent += (logEl.textContent ? '\n' : '') + t;
    logEl.scrollTop = logEl.scrollHeight;
  };

  const unsub = subscribeGambleRoom(roomId, ({ fromId, payload }) => {
    if (!payload || payload.action !== 'dice_join') return;
    if (fromId == null || fromId === ctx.myId) return;
    if (remoteIds.includes(fromId)) return;
    remoteIds.push(fromId);
    log(`Captain (player ${fromId}) joins the table.`);
  });

  let sceneHandle = null;
  function closeAll() {
    unsub();
    if (sceneHandle) sceneHandle.dispose();
    sceneHandle = null;
    try { root.remove(); } catch (e) {}
  }

  panel.querySelector('#tavern-dice-close').onclick = () => closeAll();

  panel.querySelector('#tavern-dice-start').onclick = () => {
    const inp = panel.querySelector('#tavern-dice-bet');
    const ante = Math.max(5, Math.min(500, Number(inp && inp.value) || 10));
    const maxPlayers = 4;
    if (!ctx.trySpendGold(ante)) {
      ctx.notify('Not enough gold for that ante.');
      return;
    }
    refreshGold();
    log(`Ante ${ante}g paid. Inviting captains (${maxPlayers} seats max)…`);
    try {
      ctx.sendRelay({ roomId, game: 'dice', payload: { action: 'dice_table_open', bet: ante, max: maxPlayers } });
    } catch (e) {}

    let waitMs = 12000;
    const t0 = Date.now();
    const tickWait = () => {
      const left = Math.max(0, waitMs - (Date.now() - t0));
      if (left > 0) requestAnimationFrame(tickWait);
      else runRound(ante);
    };
    requestAnimationFrame(tickWait);

    function runRound(anteEach) {
      if (sceneHandle) sceneHandle.dispose();
      sceneHandle = buildDiceTableScene(ctx.THREE, mount3d, [3, 3, 3]);
      const humanName = ctx.captainName || 'You';
      const peers = remoteIds.slice(0, maxPlayers - 1);
      const aiCount = Math.max(0, maxPlayers - 1 - peers.length);
      const seats = [{ id: 'h', name: humanName, isAi: false }];
      peers.forEach((pid, i) => seats.push({ id: 'p' + pid, name: `Captain #${pid}`, isAi: false }));
      for (let i = 0; i < aiCount; i++) seats.push({ id: 'ai' + i, name: ['One-Eyed Ruiz', 'Mad Mallery', 'Black Bilbao'][i % 3], isAi: true });

      seed = (hashRoomSeed(roomId, 'round' + Date.now()) ^ (ctx.myId | 0)) >>> 0;
      try {
        ctx.sendRelay({
          roomId,
          game: 'dice',
          payload: { action: 'dice_start', seed, seats: seats.length, ante: anteEach }
        });
      } catch (e) {}

      const results = seats.map((s, idx) => {
        const rng = mulberry32(seed + idx * 9973);
        const r = sccCargoScore(rng);
        return { seat: s, cargo: r.cargo, dice: r.dice };
      });
      log('\n— Roll! —');
      results.forEach(r => log(`${r.seat.name}: cargo ${r.cargo}  (dice ${r.dice.join(',')})`));
      const best = Math.max(...results.map(r => r.cargo));
      const winners = results.filter(r => r.cargo === best && best > 0);
      const pot = anteEach * seats.length;
      if (!winners.length) {
        log('No completed hands — pot stays with the house barkeep (ante lost).');
      } else {
        const share = Math.floor(pot / winners.length);
        const yours = winners.some(w => w.seat.id === 'h');
        if (yours) ctx.addGold(share);
        log(`Winner${winners.length > 1 ? 's (split)' : ''}: ${winners.map(w => w.seat.name).join(', ')} · each takes ${share}g (pot ${pot}g).`);
        if (yours) ctx.notify(`Seelow: won ${share}g!`);
        refreshGold();
      }
      const lastDice = results.find(r => r.seat.id === 'h');
      if (lastDice && sceneHandle && sceneHandle.diceMeshes)
        lastDice.dice.forEach((p, i) => {
          /* visual approximation: map pip total to mesh wobble only */
        });
    }
  };

  try {
    ctx.sendRelay({ roomId, game: 'dice', payload: { action: 'dice_join', bet: bet } });
  } catch (e) {}
}

/* ---- Texas Hold'em ---- */

const SUITS = ['c', 'd', 'h', 's'];
const RANK_STR = {
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: '10',
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A'
};

export function cardSvgDataUrl(rank, suit) {
  if (!rank || rank < 2) {
    const back = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="100" viewBox="0 0 72 100"><rect rx="6" ry="6" x="1" y="1" width="70" height="98" fill="#142a48" stroke="#333"/><path d="M12 18h48v64H12z" fill="none" stroke="#c9a24a" stroke-width="1.5" opacity="0.85"/><circle cx="36" cy="50" r="9" fill="none" stroke="#8a7048" stroke-width="1.2"/></svg>`;
    return 'data:image/svg+xml,' + encodeURIComponent(back);
  }
  const r = RANK_STR[rank] || '?';
  const red = suit === 'h' || suit === 'd';
  const sym = { c: '♣', d: '♦', h: '♥', s: '♠' }[suit] || '?';
  const fill = red ? '#c44' : '#222';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="100" viewBox="0 0 72 100">
  <rect rx="6" ry="6" x="1" y="1" width="70" height="98" fill="#f9f5ec" stroke="#333" stroke-width="1.2"/>
  <text x="10" y="26" font-size="18" fill="${fill}" font-family="Georgia,serif">${r}</text>
  <text x="10" y="46" font-size="18" fill="${fill}" font-family="Georgia,serif">${sym}</text>
  <text x="36" y="64" text-anchor="middle" font-size="28" fill="${fill}" font-family="Georgia,serif">${sym}</text>
  <text x="62" y="90" text-anchor="end" font-size="18" fill="${fill}" font-family="Georgia,serif">${r}</text>
</svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

function makeDeck(rng) {
  const d = [];
  for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) d.push({ r, s: SUITS[s] });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function isStraightRankSeq(ranksSortedDesc) {
  const u = [...new Set(ranksSortedDesc)];
  if (u.length < 5) return false;
  for (let i = 0; i <= u.length - 5; i++) {
    let ok = true;
    for (let k = 1; k < 5; k++) if (u[i + k - 1] - u[i + k] !== 1) ok = false;
    if (ok) return true;
  }
  /* wheel */
  if (u.includes(14) && u.includes(2) && u.includes(3) && u.includes(4) && u.includes(5)) return true;
  return false;
}

function handValue5(cards) {
  const ranks = cards.map(c => c.r).sort((a, b) => b - a);
  const suits = cards.map(c => c.s);
  const flush = suits.every(s => s === suits[0]);
  let straight = isStraightRankSeq(ranks);
  const cnt = {};
  for (const r of ranks) cnt[r] = (cnt[r] || 0) + 1;
  const groups = Object.entries(cnt)
    .map(([r, n]) => [Number(r), n])
    .sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const freq = groups.map(g => g[1]).sort((a, b) => b - a);
  /* straight flush */
  if (flush && straight) {
    /* adjust for wheel high card 5 */
    let hi = ranks[0];
    if (ranks.includes(14) && ranks.includes(2) && ranks.includes(3) && ranks.includes(4) && ranks.includes(5)) hi = 5;
    return { cat: 8, tie: [hi], name: 'Straight flush' };
  }
  if (freq[0] === 4) {
    const quad = groups.find(g => g[1] === 4)[0];
    const kicker = groups.find(g => g[1] === 1)[0];
    return { cat: 7, tie: [quad, kicker], name: 'Four of a kind' };
  }
  if (freq[0] === 3 && freq[1] === 2) {
    const trip = groups.find(g => g[1] === 3)[0];
    const pair = groups.find(g => g[1] === 2)[0];
    return { cat: 6, tie: [trip, pair], name: 'Full house' };
  }
  if (flush) return { cat: 5, tie: ranks.slice(), name: 'Flush' };
  if (straight) {
    let hi = ranks[0];
    if (ranks.includes(14) && ranks.includes(2) && ranks.includes(3) && ranks.includes(4) && ranks.includes(5)) hi = 5;
    return { cat: 4, tie: [hi], name: 'Straight' };
  }
  if (freq[0] === 3) {
    const trip = groups.find(g => g[1] === 3)[0];
    const kickers = groups.filter(g => g[1] === 1).map(g => g[0]).sort((a, b) => b - a);
    return { cat: 3, tie: [trip, ...kickers.slice(0, 2)], name: 'Three of a kind' };
  }
  if (freq[0] === 2 && freq[1] === 2) {
    const pairs = groups.filter(g => g[1] === 2).map(g => g[0]).sort((a, b) => b - a);
    const kicker = groups.find(g => g[1] === 1)[0];
    return { cat: 2, tie: [...pairs, kicker], name: 'Two pair' };
  }
  if (freq[0] === 2) {
    const pr = groups.find(g => g[1] === 2)[0];
    const kickers = groups.filter(g => g[1] === 1).map(g => g[0]).sort((a, b) => b - a);
    return { cat: 1, tie: [pr, ...kickers.slice(0, 3)], name: 'Pair' };
  }
  return { cat: 0, tie: ranks.slice(), name: 'High card' };
}

/** Best 5-card hand from 2–7 cards (preflop through river). */
function handValueBest(cards) {
  const n = cards.length;
  if (n < 5) return { cat: -1, tie: [], name: '—' };
  if (n === 5) return handValue5(cards);
  let best = null;
  const pick = (start, acc) => {
    if (acc.length === 5) {
      const v = handValue5(acc);
      if (!best || compareHands(v, best) > 0) best = v;
      return;
    }
    const need = 5 - acc.length;
    for (let i = start; i <= n - need; i++) {
      acc.push(cards[i]);
      pick(i + 1, acc);
      acc.pop();
    }
  };
  pick(0, []);
  return best;
}

function compareHands(a, b) {
  if (a.cat !== b.cat) return a.cat - b.cat;
  const la = a.tie.length;
  const lb = b.tie.length;
  for (let i = 0; i < Math.max(la, lb); i++) {
    const da = a.tie[i] || 0;
    const db = b.tie[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

function aiDecide(strength, street, facingBet, stack, pot, rng) {
  if (stack <= 0) return 'check';
  if (facingBet === 0) {
    if (street === 'preflop' && strength < 2 && rng() < 0.35) return 'check';
    if (strength >= 4 && rng() < 0.55) return 'bet';
    return 'check';
  }
  if (strength >= 5 || (strength >= 3 && rng() > 0.25)) return facingBet <= stack ? 'call' : 'fold';
  if (strength <= 1 && rng() < 0.65) return 'fold';
  return facingBet <= stack * 0.4 ? 'call' : 'fold';
}

export function openTexasHoldemPoker(ctx) {
  const root = document.createElement('div');
  root.style.cssText =
    'position:fixed;inset:0;z-index:95;display:flex;align-items:center;justify-content:center;background:rgba(6,4,3,0.78);padding:12px;font-family:Georgia,serif;';
  const panel = document.createElement('div');
  panel.style.cssText =
    'max-width:720px;width:100%;max-height:96vh;overflow:auto;background:linear-gradient(165deg,rgba(34,24,16,0.98),rgba(12,9,6,0.99));border:1px solid rgba(200,150,80,0.45);border-radius:12px;padding:14px 16px;color:#e8dcc8;box-shadow:0 12px 44px rgba(0,0,0,0.55);';
  const roomId = `poker-${ctx.myId != null ? ctx.myId : 'solo'}-${Date.now()}`;

  panel.innerHTML = `<h3 style="margin:0 0 8px;font-size:18px;color:#e0c890;">Texas Hold'em — gold table</h3>
    <div style="font-size:11px;color:#9a8a78;line-height:1.45;margin-bottom:8px;">Up to five captains; antes and bets are in <strong>gold coins</strong> (no clay chips). Play a full hand against AI unless other players join your lobby ping. SVG cards below.</div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap;">
      <label style="font-size:11px;">Buy-in <input id="pk-buyin" type="number" min="20" max="800" value="80" style="width:72px;background:#1a1510;border:1px solid #5a4030;color:#e8dcc8;padding:4px;border-radius:4px;"/></label>
      <span id="pk-gold" style="font-size:11px;color:#d4a848;"></span>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin:6px 0;flex-wrap:wrap;font-size:11px;color:#c0b090;">
      <span>Pot:</span><span id="pk-pot" style="color:#f0d868;font-weight:bold;">0</span>
      <img src="assets/items/gold_0001.png" width="16" height="16" alt="" style="vertical-align:middle;opacity:0.95;"/>
      <span id="pk-street" style="margin-left:8px;color:#a8d898;"></span>
    </div>
    <div id="pk-board" style="min-height:104px;display:flex;gap:6px;flex-wrap:wrap;margin:8px 0;"></div>
    <div style="margin:8px 0;font-size:11px;color:#b8a898;">Your hole cards</div>
    <div id="pk-hole" style="display:flex;gap:6px;margin-bottom:8px;"></div>
    <pre id="pk-log" style="margin:0;font-size:11px;color:#c8bba8;white-space:pre-wrap;max-height:140px;overflow:auto;line-height:1.4;"></pre>
    <div id="pk-actions" style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;"></div>
    <button type="button" id="pk-close" style="margin-top:10px;padding:8px 12px;border-radius:8px;border:1px solid #555;background:#2a2220;color:#ccc;cursor:pointer;font-family:Georgia,serif;">Leave table</button>`;
  root.appendChild(panel);
  document.body.appendChild(root);

  const logEl = panel.querySelector('#pk-log');
  const goldEl = panel.querySelector('#pk-gold');
  const potEl = panel.querySelector('#pk-pot');
  const streetEl = panel.querySelector('#pk-street');
  const boardEl = panel.querySelector('#pk-board');
  const holeEl = panel.querySelector('#pk-hole');
  const actEl = panel.querySelector('#pk-actions');

  const log = t => {
    logEl.textContent += (logEl.textContent ? '\n' : '') + t;
    logEl.scrollTop = logEl.scrollHeight;
  };

  const unsub = subscribeGambleRoom(roomId, ({ fromId, payload }) => {
    if (!payload || payload.action !== 'poker_join') return;
    if (fromId == null || fromId === ctx.myId) return;
    log(`Captain (player ${fromId}) sits in.`);
  });

  function refreshGold() {
    goldEl.textContent = `Your gold: ${ctx.getGold()}`;
  }
  refreshGold();

  function closeAll() {
    unsub();
    try {
      root.remove();
    } catch (e) {}
  }
  panel.querySelector('#pk-close').onclick = () => closeAll();

  function renderCards(container, cards, hideSecond) {
    container.innerHTML = '';
    cards.forEach((c, i) => {
      const back = hideSecond && i === 1;
      const img = document.createElement('img');
      img.width = 72;
      img.height = 100;
      img.style.borderRadius = '6px';
      img.style.boxShadow = '0 2px 6px rgba(0,0,0,0.45)';
      img.src = back ? cardSvgDataUrl(0, 's') : cardSvgDataUrl(c.r, c.s);
      if (back) img.style.filter = 'brightness(0.35)';
      if (back) img.alt = 'hidden';
      container.appendChild(img);
    });
  }

  const dealBtn = document.createElement('button');
  dealBtn.type = 'button';
  dealBtn.textContent = 'Deal hand';
  dealBtn.style.cssText =
    'padding:8px 14px;border-radius:8px;border:1px solid #c9a24a;background:linear-gradient(180deg,#6a4a20,#3a2208);color:#f0e0c8;cursor:pointer;font-family:Georgia,serif;';
  dealBtn.onclick = () => runHand();
  actEl.appendChild(dealBtn);

  function runHand() {
    actEl.innerHTML = '';
    actEl.appendChild(dealBtn);
    dealBtn.disabled = true;
    const buyIn = Math.max(20, Math.min(800, Number(panel.querySelector('#pk-buyin').value) || 80));
    if (!ctx.trySpendGold(buyIn)) {
      ctx.notify('Not enough gold for buy-in.');
      dealBtn.disabled = false;
      return;
    }
    refreshGold();
    try {
      ctx.sendRelay({ roomId, game: 'poker', payload: { action: 'poker_table_open', buyIn } });
      ctx.sendRelay({ roomId, game: 'poker', payload: { action: 'poker_join', buyIn } });
    } catch (e) {}

    const rng = mulberry32(hashRoomSeed(roomId, 'hand' + Date.now()) ^ (ctx.myId | 0));
    const maxP = 5;
    const peerN = 0;
    const nAi = Math.max(1, maxP - 1 - peerN);
    const players = [
      { name: ctx.captainName || 'You', stack: buyIn, human: true, hole: [], folded: false },
      ...Array.from({ length: nAi }, (_, i) => ({
        name: ['Rascal Riley', 'Calico Jen', 'Don Santiago', 'Mara the Knife'][i % 4],
        stack: buyIn,
        human: false,
        hole: [],
        folded: false
      }))
    ];

    const deck = makeDeck(rng);
    players.forEach(p => {
      p.hole = [deck.pop(), deck.pop()];
    });
    const community = [];
    let pot = 0;
    const ante = Math.max(2, Math.floor(buyIn * 0.05));
    for (const p of players) {
      const payC = Math.min(ante, p.stack);
      p.stack -= payC;
      pot += payC;
    }
    const bb = Math.max(4, ante * 2);
    potEl.textContent = String(pot);
    log(`Each pays ${ante}g ante — pot ${pot}g.`);

    function bettingRound(street, communityCards) {
      streetEl.textContent = street;
      renderCards(boardEl, communityCards, false);
      renderCards(holeEl, players[0].hole, false);
      let toCall = 0;
      let raises = 0;
      const contrib = players.map(() => 0);

      function advanceAi() {
        for (let i = 1; i < players.length; i++) {
          const p = players[i];
          if (p.folded || p.stack <= 0) continue;
          const board = [...communityCards];
          const hv = handValueBest([...p.hole, ...board]);
          const str = Math.max(0, hv.cat) * 2 + (hv.tie[0] || 0) / 14;
          const facing = Math.max(0, toCall - contrib[i]);
          const act = aiDecide(str, street, facing, p.stack, pot, rng);
          if (act === 'fold') {
            p.folded = true;
            log(`${p.name} folds.`);
          } else if (act === 'call' || act === 'check') {
            const pay = act === 'check' ? 0 : Math.min(facing, p.stack);
            if (pay > 0) {
              p.stack -= pay;
              pot += pay;
              contrib[i] += pay;
            }
          } else if (act === 'bet' && raises < 3 && street !== 'showdown') {
            const bump = Math.min(bb, p.stack);
            if (bump > 0) {
              p.stack -= bump;
              pot += bump;
              contrib[i] += bump;
              toCall = contrib[i];
              raises++;
              log(`${p.name} raises ${bump}g.`);
            }
          }
        }
        potEl.textContent = String(pot);
      }

      function humanTurn(resolve) {
        actEl.innerHTML = '';
        const p = players[0];
        if (p.folded || p.stack <= 0) return resolve();
        const facing = Math.max(0, toCall - contrib[0]);
        const mk = (label, fn) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = label;
          b.style.cssText =
            'padding:8px 12px;border-radius:8px;border:1px solid rgba(200,150,80,0.45);background:rgba(60,45,28,0.85);color:#e8dcc8;cursor:pointer;font-family:Georgia,serif;font-size:11px;';
          b.onclick = fn;
          actEl.appendChild(b);
        };
        if (facing === 0) {
          mk('Check', () => resolve());
          mk(`Bet ${bb}g`, () => {
            const pay = Math.min(bb, p.stack);
            p.stack -= pay;
            pot += pay;
            contrib[0] += pay;
            toCall = contrib[0];
            potEl.textContent = String(pot);
            resolve();
          });
        } else {
          mk(`Fold`, () => {
            p.folded = true;
            resolve();
          });
          mk(`Call ${Math.min(facing, p.stack)}g`, () => {
            const pay = Math.min(facing, p.stack);
            p.stack -= pay;
            pot += pay;
            contrib[0] += pay;
            potEl.textContent = String(pot);
            resolve();
          });
        }
      }

      return new Promise(res => {
        advanceAi();
        if (players.filter(pl => !pl.folded).length < 2) return res();
        humanTurn(() => {
          advanceAi();
          res();
        });
      });
    }

    (async () => {
      await bettingRound('preflop', []);
      if (players.filter(pl => !pl.folded).length < 2) {
        const alive = players.find(pl => !pl.folded);
        if (alive && pot > 0) {
          if (alive.human) {
            ctx.addGold(pot);
            ctx.notify('Won the pot uncontested.');
            refreshGold();
          }
          log(`${alive.name} takes the pot (${pot}g).`);
        }
        dealBtn.disabled = false;
        actEl.appendChild(dealBtn);
        return;
      }
      community.push(deck.pop(), deck.pop(), deck.pop());
      await bettingRound('flop', community.slice());
      community.push(deck.pop());
      await bettingRound('turn', community.slice());
      community.push(deck.pop());
      await bettingRound('river', community.slice());

      const active = players.filter(pl => !pl.folded);
      renderCards(boardEl, community, false);
      actEl.innerHTML = '';
      if (active.length === 1) {
        const w = active[0];
        if (w.human && pot > 0) {
          ctx.addGold(pot);
          ctx.notify('Hand won — take the gold.');
          refreshGold();
        }
        log(`Everyone else folded — ${w.name} wins ${pot}g.`);
        dealBtn.disabled = false;
        actEl.appendChild(dealBtn);
        return;
      }
      streetEl.textContent = 'Showdown';
      const scores = active.map(p => ({
        p,
        v: handValueBest([...p.hole, ...community])
      }));
      scores.forEach(s => log(`${s.p.name}: ${s.v.name}`));
      scores.sort((a, b) => compareHands(b.v, a.v));
      const bestV = scores[0].v;
      const winners = scores.filter(s => compareHands(s.v, bestV) === 0);
      const share = Math.floor(pot / winners.length);
      winners.forEach(w => {
        if (w.p.human) {
          ctx.addGold(share);
          ctx.notify(`Showdown: won ${share}g`);
          refreshGold();
        }
        log(`${w.p.name} wins ${share}g (${bestV.name}).`);
      });
      const spare = pot - share * winners.length;
      if (spare > 0) {
        const w0 = winners.find(x => x.p.human) || winners[0];
        if (w0 && w0.p.human) {
          ctx.addGold(spare);
          refreshGold();
        }
      }
      dealBtn.disabled = false;
      actEl.appendChild(dealBtn);
    })();
  }
}
