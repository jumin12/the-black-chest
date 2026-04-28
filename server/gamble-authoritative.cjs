'use strict';

const crypto = require('crypto');

const MAX_STAKE = 500;
const MIN_DICE_STAKE = 5;
const MIN_POKER_BUYIN = 20;
const MAX_DICE_PLAYERS = 4;
const MAX_POKER_PLAYERS = 5;
function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(String(p));
  return h.digest().readUInt32BE(0) >>> 0;
}

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
  if (!ship || !cap || !crew) return { cargo: 0, dice: dice.slice() };
  let cargo = 0;
  for (let i = 0; i < 3; i++) if (!kept[i]) cargo += dice[i];
  return { cargo, dice: dice.slice() };
}

const SUITS = ['c', 'd', 'h', 's'];

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
  const u = [...new Set(ranksSortedDesc)].sort((a, b) => b - a);
  if (u.length < 5) return false;
  for (let i = 0; i <= u.length - 5; i++) {
    let ok = true;
    for (let k = 1; k < 5; k++) if (u[i + k - 1] - u[i + k] !== 1) ok = false;
    if (ok) return true;
  }
  if (u.includes(14) && u.includes(2) && u.includes(3) && u.includes(4) && u.includes(5)) return true;
  return false;
}

function handValue5(cards) {
  const ranks = cards.map(c => c.r).sort((a, b) => b - a);
  const suits = cards.map(c => c.s);
  const flush = suits.every(s => s === suits[0]);
  const straight = isStraightRankSeq(ranks);
  const cnt = {};
  for (const r of ranks) cnt[r] = (cnt[r] || 0) + 1;
  const groups = Object.entries(cnt)
    .map(([r, n]) => [Number(r), n])
    .sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const freq = groups.map(g => g[1]).sort((a, b) => b - a);
  if (flush && straight) {
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

function compareHands(a, b) {
  if (!a || !b) return 0;
  if (a.cat !== b.cat) return a.cat - b.cat;
  for (let i = 0; i < Math.max(a.tie.length, b.tie.length); i++) {
    const da = a.tie[i] || 0;
    const db = b.tie[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

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

function genRoomId() {
  return 'gr_' + crypto.randomBytes(10).toString('hex');
}

function sanitizeName(p) {
  return String((p && (p.name || p.shipName)) || 'Captain').slice(0, 28);
}

function createGambleManager({ players, sendToPlayerId }) {
  const rooms = new Map();
  const playerRoom = new Map();

  function getPlayer(pid) {
    return players.get(pid);
  }

  function dockedOk(pid) {
    const p = getPlayer(pid);
    return !!(p && p.docked);
  }

  function requireRoom(roomId) {
    const rid = String(roomId || '').slice(0, 80);
    return rooms.get(rid) || null;
  }

  function broadcastRoom(room, payload) {
    for (const m of room.members) {
      sendToPlayerId(m.playerId, payload);
    }
  }

  function leaveRoom(pid, refundStacks) {
    const rid = playerRoom.get(pid);
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room) return;
    if (room.game === 'dice' && room.phase === 'running') {
      abortDiceRoom(room, 'player_left');
      playerRoom.delete(pid);
      return;
    }
    if (refundStacks && room.game === 'poker' && room.stacks && room.stacks.has(pid)) {
      const s = room.stacks.get(pid) || 0;
      if (s > 0) sendToPlayerId(pid, { type: 'gamble_settle', roomId: rid, game: 'poker', payouts: { [pid]: s }, reason: 'leave' });
      room.stacks.delete(pid);
    }
    playerRoom.delete(pid);
    room.members = room.members.filter(x => x.playerId !== pid);
    if (!room.members.length) {
      rooms.delete(rid);
      return;
    }
    if (room.creatorId === pid) room.creatorId = room.members[0].playerId;
    broadcastRoom(room, { type: 'gamble_room', room: exportRoomPublic(room) });
  }

  function abortDiceRoom(room, reason) {
    const rid = room.id;
    const payouts = {};
    for (const m of room.members) {
      if (m.committed) payouts[m.playerId] = room.stake;
    }
    broadcastRoom(room, { type: 'gamble_settle', roomId: rid, game: 'dice', payouts, results: [], reason: reason || 'abort' });
    for (const m of room.members) playerRoom.delete(m.playerId);
    rooms.delete(rid);
  }

  function exportRoomPublic(room) {
    const base = {
      id: room.id,
      game: room.game,
      stake: room.stake,
      maxPlayers: room.maxPlayers,
      phase: room.phase,
      creatorId: room.creatorId,
      members: room.members.map(m => ({
        playerId: m.playerId,
        name: m.name,
        committed: !!m.committed
      }))
    };
    if (room.game === 'poker') {
      base.stacks = {};
      if (room.stacks) for (const [k, v] of room.stacks) base.stacks[k] = v;
      base.poker = exportPokerPublic(room);
    }
    return base;
  }

  function exportPokerPublic(room) {
    const h = room.hand;
    if (!h) return null;
    return {
      street: h.street,
      pot: h.pot,
      board: h.board.map(c => ({ r: c.r, s: c.s })),
      currentBet: h.currentBet,
      actorId: h.actorId,
      folded: [...h.folded],
      raisesThisRound: h.raisesThisRound
    };
  }

  function sendPokerStates(room) {
    const rid = room.id;
    const h = room.hand;
    for (const m of room.members) {
      const pid = m.playerId;
      const pub = {
        type: 'gamble_state',
        roomId: rid,
        game: 'poker',
        room: exportRoomPublic(room),
        you: { stack: room.stacks.get(pid) || 0 }
      };
      if (h && h.holes && h.holes.has(pid)) {
        pub.you.hole = h.holes.get(pid).map(c => ({ r: c.r, s: c.s }));
      }
      sendToPlayerId(pid, pub);
    }
  }

  function resolveDice(room) {
    const rid = room.id;
    const seed = hashSeed([rid, room.startTs || Date.now(), room.members.map(m => m.playerId).join(',')]);
    const results = [];
    let idx = 0;
    for (const m of room.members) {
      if (!m.committed) continue;
      const rng = mulberry32(((seed + idx * 9973) ^ (m.playerId | 0)) >>> 0);
      const r = sccCargoScore(rng);
      results.push({ playerId: m.playerId, name: m.name, cargo: r.cargo, dice: r.dice });
      idx++;
    }
    const committed = room.members.filter(m => m.committed);
    const n = committed.length;
    const pot = room.stake * n;
    const bestCargo = Math.max(0, ...results.map(r => r.cargo));
    const payouts = {};
    if (bestCargo <= 0 || !results.some(r => r.cargo > 0)) {
      for (const m of committed) payouts[m.playerId] = room.stake;
      broadcastRoom(room, { type: 'gamble_settle', roomId: rid, game: 'dice', payouts, results, reason: 'no_score' });
    } else {
      const winners = results.filter(r => r.cargo === bestCargo);
      const share = Math.floor(pot / winners.length);
      const spare = pot - share * winners.length;
      for (const w of winners) payouts[w.playerId] = (payouts[w.playerId] || 0) + share;
      if (spare > 0 && winners[0]) payouts[winners[0].playerId] = (payouts[winners[0].playerId] || 0) + spare;
      broadcastRoom(room, { type: 'gamble_settle', roomId: rid, game: 'dice', payouts, results, reason: 'done' });
    }
    for (const m of room.members) playerRoom.delete(m.playerId);
    rooms.delete(rid);
  }

  function isPokerBettingComplete(h, room) {
    const active = room.members.map(m => m.playerId).filter(pid => !h.folded.has(pid));
    if (active.length < 2) return true;
    let maxC = 0;
    for (const pid of active) maxC = Math.max(maxC, h.roundContrib.get(pid) || 0);
    for (const pid of active) {
      if (h.allIn.has(pid)) continue;
      const c = h.roundContrib.get(pid) || 0;
      if (c < maxC) return false;
      if (!h.actedThisRound.has(pid)) return false;
    }
    return true;
  }

  function pickNextPokerActor(room) {
    const h = room.hand;
    if (!h) return;
    const order = room.members.map(m => m.playerId);
    const si = h.actorId != null ? order.indexOf(h.actorId) : 0;
    for (let step = 1; step <= order.length; step++) {
      const pid = order[(si + step + order.length) % order.length];
      if (h.folded.has(pid) || h.allIn.has(pid)) continue;
      const need = h.needsToCall.get(pid) || 0;
      if (need > 0 || !h.actedThisRound.has(pid)) {
        h.actorId = pid;
        sendPokerStates(room);
        return;
      }
    }
    nextPokerStreet(room);
  }

  function nextPokerStreet(room) {
    const h = room.hand;
    if (!h) return;
    h.currentBet = 0;
    h.raisesThisRound = 0;
    h.actedThisRound = new Set();
    h.needsToCall = new Map();
    for (const m of room.members) {
      const pid = m.playerId;
      if (h.folded.has(pid)) continue;
      h.roundContrib.set(pid, 0);
      h.needsToCall.set(pid, 0);
    }
    if (h.street === 'preflop') {
      h.street = 'flop';
      h.board.push(h.deck.pop(), h.deck.pop(), h.deck.pop());
    } else if (h.street === 'flop') {
      h.street = 'turn';
      h.board.push(h.deck.pop());
    } else if (h.street === 'turn') {
      h.street = 'river';
      h.board.push(h.deck.pop());
    } else {
      showdownPoker(room);
      return;
    }
    /* first to act: first active after button */
    const order = room.members.map(m => m.playerId);
    let idx = (h.buttonIdx + 1) % order.length;
    for (let s = 0; s < order.length * 2; s++) {
      const pid = order[(idx + s) % order.length];
      if (!h.folded.has(pid) && !h.allIn.has(pid)) {
        h.actorId = pid;
        sendPokerStates(room);
        return;
      }
    }
    nextPokerStreet(room);
  }

  function showdownPoker(room) {
    const h = room.hand;
    const active = room.members.map(m => m.playerId).filter(pid => !h.folded.has(pid));
    if (active.length === 1) {
      endPokerHand(room, active[0]);
      return;
    }
    const scores = active.map(pid => ({
      pid,
      v: handValueBest([...h.holes.get(pid), ...h.board])
    }));
    scores.sort((a, b) => compareHands(b.v, a.v));
    const best = scores[0].v;
    const winners = scores.filter(s => compareHands(s.v, best) === 0).map(s => s.pid);
    const pot = h.pot;
    const share = Math.floor(pot / winners.length);
    let spare = pot - share * winners.length;
    for (const w of winners) {
      room.stacks.set(w, (room.stacks.get(w) || 0) + share);
    }
    if (spare > 0 && winners.length) {
      const w0 = winners[0];
      room.stacks.set(w0, (room.stacks.get(w0) || 0) + spare);
    }
    h.pot = 0;
    broadcastRoom(room, {
      type: 'gamble_poker_showdown',
      roomId: room.id,
      board: h.board.map(c => ({ r: c.r, s: c.s })),
      winners,
      hands: scores.map(s => ({ playerId: s.pid, name: room.members.find(m => m.playerId === s.pid)?.name || '', rank: s.v.name }))
    });
    room.hand = null;
    room.phase = 'between_hands';
    broadcastRoom(room, { type: 'gamble_room', room: exportRoomPublic(room) });
    sendPokerStates(room);
  }

  /** @param {number|null} soleWinner */
  function endPokerHand(room, soleWinner) {
    const h = room.hand;
    if (soleWinner != null && h) {
      room.stacks.set(soleWinner, (room.stacks.get(soleWinner) || 0) + h.pot);
      h.pot = 0;
    }
    room.hand = null;
    room.phase = 'between_hands';
    broadcastRoom(room, { type: 'gamble_room', room: exportRoomPublic(room) });
    sendPokerStates(room);
  }

  function startPokerHand(room) {
    const committed = room.members.filter(m => m.committed);
    if (committed.length < 2) return;
    const seed = hashSeed([room.id, Date.now(), ...committed.map(m => m.playerId)]);
    const rng = mulberry32(seed);
    const deck = makeDeck(rng);
    room.buttonIdx = (room.buttonIdx + 1) % Math.max(1, committed.length);
    const h = {
      deck,
      holes: new Map(),
      board: [],
      pot: 0,
      street: 'preflop',
      currentBet: 0,
      raisesThisRound: 0,
      roundContrib: new Map(),
      folded: new Set(),
      allIn: new Set(),
      actedThisRound: new Set(),
      needsToCall: new Map(),
      actorId: null,
      buttonIdx: room.buttonIdx
    };
    for (const m of committed) {
      h.holes.set(m.playerId, [deck.pop(), deck.pop()]);
      h.roundContrib.set(m.playerId, 0);
      h.needsToCall.set(m.playerId, 0);
    }
    const bb = Math.max(2, Math.floor(room.stake * 0.06));
    const sb = Math.max(1, Math.floor(bb / 2));
    const order = room.members.map(m => m.playerId).filter(pid => committed.some(c => c.playerId === pid));
    const btn = order[room.buttonIdx % order.length];
    const si = order.indexOf(btn);
    let pidSb;
    let pidBb;
    if (order.length === 2) {
      pidSb = btn;
      pidBb = order[(si + 1) % 2];
    } else {
      pidSb = order[(si + 1) % order.length];
      pidBb = order[(si + 2) % order.length];
    }
    const pay = (pid, amt) => {
      const st = room.stacks.get(pid) || 0;
      const payAmt = Math.min(amt, st);
      room.stacks.set(pid, st - payAmt);
      h.pot += payAmt;
      h.roundContrib.set(pid, (h.roundContrib.get(pid) || 0) + payAmt);
    };
    pay(pidSb, sb);
    pay(pidBb, bb);
    h.currentBet = Math.max(h.roundContrib.get(pidBb) || 0, h.roundContrib.get(pidSb) || 0);
    for (const pid of order) {
      const my = h.roundContrib.get(pid) || 0;
      h.needsToCall.set(pid, h.currentBet - my);
    }
    h.actorId = order[(order.indexOf(pidBb) + 1) % order.length];
    room.hand = h;
    room.phase = 'play';
    sendPokerStates(room);
  }

  function pokerApplyAction(room, pid, action, raiseAmt) {
    const h = room.hand;
    if (!h || h.actorId !== pid) return { ok: false, err: 'not_your_turn' };
    if (h.folded.has(pid)) return { ok: false, err: 'folded' };
    const stack = room.stacks.get(pid) || 0;
    const need = h.needsToCall.get(pid) || 0;

    if (action === 'fold') {
      h.folded.add(pid);
      h.actedThisRound.add(pid);
      h.needsToCall.set(pid, 0);
    } else if (action === 'check') {
      if (need > 0) return { ok: false, err: 'check_not_allowed' };
      h.actedThisRound.add(pid);
    } else if (action === 'call') {
      if (need <= 0) return { ok: false, err: 'call_not_needed' };
      const pay = Math.min(need, stack);
      room.stacks.set(pid, stack - pay);
      h.pot += pay;
      h.roundContrib.set(pid, (h.roundContrib.get(pid) || 0) + pay);
      h.needsToCall.set(pid, 0);
      h.actedThisRound.add(pid);
      if (stack - pay === 0 && pay > 0) h.allIn.add(pid);
    } else if (action === 'raise') {
      const minRaise = Math.max(2, Math.floor(room.stake * 0.06));
      const extra = Math.max(minRaise, Math.floor(raiseAmt || minRaise));
      const add = Math.min(need + extra, stack);
      if (add < need) {
        room.stacks.set(pid, 0);
        h.pot += stack;
        h.roundContrib.set(pid, (h.roundContrib.get(pid) || 0) + stack);
        h.allIn.add(pid);
        h.needsToCall.set(pid, 0);
        h.actedThisRound.add(pid);
      } else {
        room.stacks.set(pid, stack - add);
        h.pot += add;
        h.roundContrib.set(pid, (h.roundContrib.get(pid) || 0) + add);
        const newHigh = h.roundContrib.get(pid) || 0;
        if (newHigh > h.currentBet) {
          h.currentBet = newHigh;
          h.raisesThisRound++;
          for (const m of room.members) {
            const op = m.playerId;
            if (h.folded.has(op)) continue;
            const rc = h.roundContrib.get(op) || 0;
            const ntc = h.currentBet - rc;
            h.needsToCall.set(op, ntc);
            if (ntc > 0) h.actedThisRound.delete(op);
          }
        }
        h.needsToCall.set(pid, 0);
        h.actedThisRound.add(pid);
        if ((room.stacks.get(pid) || 0) === 0) h.allIn.add(pid);
      }
    } else return { ok: false, err: 'bad_action' };

    const active = room.members.map(m => m.playerId).filter(id => !h.folded.has(id));
    if (active.length < 2) {
      endPokerHand(room, active[0]);
      return { ok: true };
    }

    if (isPokerBettingComplete(h, room)) {
      nextPokerStreet(room);
    } else {
      pickNextPokerActor(room);
    }
    return { ok: true };
  }

  const api = {
    handle(id, msg) {
      const t = msg && msg.type;
      if (t === 'gamble_create') return api.create(id, msg);
      if (t === 'gamble_join') return api.join(id, msg);
      if (t === 'gamble_leave') return api.leave(id, msg);
      if (t === 'gamble_commit') return api.commit(id, msg);
      if (t === 'gamble_start') return api.start(id, msg);
      if (t === 'gamble_poker_action') return api.pokerAction(id, msg);
      if (t === 'gamble_poker_next_hand') return api.pokerNextHand(id, msg);
      return false;
    },

    create(id, msg) {
      if (!dockedOk(id)) {
        sendToPlayerId(id, { type: 'gamble_error', code: 'not_docked' });
        return true;
      }
      if (playerRoom.has(id)) {
        sendToPlayerId(id, { type: 'gamble_error', code: 'already_in_room' });
        return true;
      }
      const game = String(msg.game || '').toLowerCase() === 'poker' ? 'poker' : 'dice';
      const stake = Math.max(game === 'poker' ? MIN_POKER_BUYIN : MIN_DICE_STAKE, Math.min(MAX_STAKE, Math.floor(Number(msg.stake) || 0)));
      const maxPlayers = Math.min(game === 'poker' ? MAX_POKER_PLAYERS : MAX_DICE_PLAYERS, Math.max(2, Math.floor(Number(msg.maxPlayers) || (game === 'poker' ? 5 : 4))));
      const roomId = genRoomId();
      const p = getPlayer(id);
      const room = {
        id: roomId,
        game,
        stake,
        maxPlayers,
        phase: 'lobby',
        creatorId: id,
        createdAt: Date.now(),
        members: [{ playerId: id, name: sanitizeName(p), committed: false }],
        stacks: game === 'poker' ? new Map() : null,
        buttonIdx: 0,
        hand: null
      };
      rooms.set(roomId, room);
      playerRoom.set(id, roomId);
      sendToPlayerId(id, { type: 'gamble_created', roomId, room: exportRoomPublic(room) });
      broadcastRoom(room, { type: 'gamble_room', room: exportRoomPublic(room) });
      return true;
    },

    join(id, msg) {
      if (!dockedOk(id)) {
        sendToPlayerId(id, { type: 'gamble_error', code: 'not_docked' });
        return true;
      }
      const room = requireRoom(msg.roomId);
      if (!room || room.phase !== 'lobby') {
        sendToPlayerId(id, { type: 'gamble_error', code: 'no_room' });
        return true;
      }
      if (playerRoom.has(id)) {
        sendToPlayerId(id, { type: 'gamble_error', code: 'already_in_room' });
        return true;
      }
      if (room.members.length >= room.maxPlayers) {
        sendToPlayerId(id, { type: 'gamble_error', code: 'room_full' });
        return true;
      }
      if (room.members.some(m => m.playerId === id)) return true;
      const p = getPlayer(id);
      room.members.push({ playerId: id, name: sanitizeName(p), committed: false });
      playerRoom.set(id, room.id);
      broadcastRoom(room, { type: 'gamble_room', room: exportRoomPublic(room) });
      return true;
    },

    leave(id, msg) {
      const room = requireRoom(msg.roomId || playerRoom.get(id));
      if (!room || !playerRoom.has(id)) return true;
      if (room.phase === 'play' && room.game === 'poker') {
        leaveRoom(id, true);
        return true;
      }
      const m = room.members.find(x => x.playerId === id);
      if (m && m.committed) {
        sendToPlayerId(id, { type: 'gamble_settle', roomId: room.id, game: room.game, payouts: { [id]: room.stake }, reason: 'leave_refund' });
      }
      room.members = room.members.filter(x => x.playerId !== id);
      playerRoom.delete(id);
      if (!room.members.length) {
        rooms.delete(room.id);
        return true;
      }
      if (room.creatorId === id) room.creatorId = room.members[0].playerId;
      broadcastRoom(room, { type: 'gamble_room', room: exportRoomPublic(room) });
      return true;
    },

    commit(id, msg) {
      const room = requireRoom(msg.roomId || playerRoom.get(id));
      if (!room || room.phase !== 'lobby') {
        sendToPlayerId(id, { type: 'gamble_commit_ack', ok: false, reason: 'bad_phase' });
        return true;
      }
      const m = room.members.find(x => x.playerId === id);
      if (!m) {
        sendToPlayerId(id, { type: 'gamble_commit_ack', ok: false, reason: 'not_member' });
        return true;
      }
      if (m.committed) {
        sendToPlayerId(id, { type: 'gamble_commit_ack', ok: true, roomId: room.id, stake: room.stake });
        return true;
      }
      m.committed = true;
      if (room.game === 'poker') room.stacks.set(id, room.stake);
      sendToPlayerId(id, { type: 'gamble_commit_ack', ok: true, roomId: room.id, stake: room.stake });
      broadcastRoom(room, { type: 'gamble_room', room: exportRoomPublic(room) });
      return true;
    },

    start(id, msg) {
      const room = requireRoom(msg.roomId || playerRoom.get(id));
      if (!room || room.creatorId !== id) {
        sendToPlayerId(id, { type: 'gamble_error', code: 'not_creator' });
        return true;
      }
      const committed = room.members.filter(m => m.committed);
      if (committed.length < 2) {
        sendToPlayerId(id, { type: 'gamble_error', code: 'need_two' });
        return true;
      }
      if (room.game === 'dice') {
        room.phase = 'running';
        room.startTs = Date.now();
        broadcastRoom(room, { type: 'gamble_room', room: exportRoomPublic(room) });
        resolveDice(room);
        return true;
      }
      if (room.game === 'poker') {
        startPokerHand(room);
        return true;
      }
      return true;
    },

    pokerAction(id, msg) {
      const room = requireRoom(msg.roomId || playerRoom.get(id));
      if (!room || room.game !== 'poker' || room.phase !== 'play') return true;
      const act = String(msg.action || '').toLowerCase();
      const r = pokerApplyAction(room, id, act, Number(msg.raise) || 0);
      if (!r.ok) sendToPlayerId(id, { type: 'gamble_error', code: r.err || 'move' });
      return true;
    },

    pokerNextHand(id, msg) {
      const room = requireRoom(msg.roomId || playerRoom.get(id));
      if (!room || room.game !== 'poker' || room.creatorId !== id) return true;
      if (room.phase !== 'between_hands') return true;
      startPokerHand(room);
      return true;
    },

    disconnect(pid) {
      try {
        leaveRoom(pid, true);
      } catch (e) {}
    }
  };

  return api;
}

module.exports = { createGambleManager };
