'use strict';

/**
 * Authoritative tavern mini-games: Seelowe dice (street Cee-lo, 3 dice) and Texas Hold'em.
 * Gold flows via `tavern_inventory_delta` — clients apply to cargo gold.
 */

const crypto = require('crypto');

const MAX_DICE_PLAYERS = 4;
const MAX_POKER_PLAYERS = 5;

const DEFAULT_DICE_ANTE = 1;
const DEFAULT_POKER_SB = 5;
const DEFAULT_POKER_BB = 10;

const NAMES_GIVEN = ['Barnaby', 'Cullen', 'Darius', 'Elias', 'Fletcher', 'Gideon', 'Jory', 'Kellan', 'Merrick', 'Silas', 'Torin', 'Uriah', 'Zeb', 'Briggs', 'Drake', 'Rafe'];
const NAMES_EPITHET = ['Saltjaw', 'Crowfoot', 'Thornwave', 'Deephaul', 'Greywake', 'Stormwright', 'Redbay', 'Brineborn', 'Copperkeel'];
const HATS = ['tricorn', 'bandana', 'bicorne'];
const CREW_COLORS = ['#8b4513', '#4a6a8a', '#6b4c3b', '#3d5c5c', '#7a5c8a', '#5c4033'];

function rollDie() {
  return crypto.randomInt(1, 7);
}

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleDeck(deck, rnd) {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = d[i];
    d[i] = d[j];
    d[j] = t;
  }
  return d;
}

function makeDeck() {
  const d = [];
  for (let i = 0; i < 52; i++) d.push(i);
  return d;
}

function combinations5(arr7) {
  const out = [];
  const n = arr7.length;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      for (let c = b + 1; c < n; c++) {
        for (let d = c + 1; d < n; d++) {
          for (let e = d + 1; e < n; e++) {
            out.push([arr7[a], arr7[b], arr7[c], arr7[d], arr7[e]]);
          }
        }
      }
    }
  }
  return out;
}

function rankCategoryAndKey(ranksSortedDesc, flush, straightHigh) {
  const r = ranksSortedDesc;
  const cnt = {};
  for (const x of r) cnt[x] = (cnt[x] | 0) + 1;
  const freq = Object.entries(cnt).map(([k, v]) => ({ k: Number(k), v }));
  freq.sort((a, b) => (b.v !== a.v ? b.v - a.v : b.k - a.k));

  if (flush && straightHigh >= 0) return { cat: 8, key: [straightHigh] };
  if (freq[0].v === 4) return { cat: 7, key: [freq[0].k, freq[1].k] };
  if (freq[0].v === 3 && freq[1].v === 2) return { cat: 6, key: [freq[0].k, freq[1].k] };
  if (flush) return { cat: 5, key: r.slice() };
  if (straightHigh >= 0) return { cat: 4, key: [straightHigh] };
  if (freq[0].v === 3) {
    const trip = freq[0].k;
    const ks = r.filter(x => x !== trip).sort((a, b) => b - a);
    return { cat: 3, key: [trip, ...ks] };
  }
  if (freq[0].v === 2 && freq[1].v === 2) {
    const hi = Math.max(freq[0].k, freq[1].k);
    const lo = Math.min(freq[0].k, freq[1].k);
    const kick = r.find(x => x !== hi && x !== lo);
    return { cat: 2, key: [hi, lo, kick] };
  }
  if (freq[0].v === 2) {
    const pair = freq[0].k;
    const ks = r.filter(x => x !== pair);
    return { cat: 1, key: [pair, ...ks] };
  }
  return { cat: 0, key: r.slice() };
}

function analyze5(ids5) {
  const ranks = ids5.map(c => Math.floor(c / 4)).sort((a, b) => b - a);
  const suits = ids5.map(c => c % 4);
  const flush = suits[1] === suits[0] && suits[2] === suits[0] && suits[3] === suits[0] && suits[4] === suits[0];
  const rc = [...new Set(ranks)].sort((a, b) => b - a);
  let straightHigh = -1;
  if (rc.length === 5) {
    let seq = true;
    for (let i = 1; i < rc.length; i++) {
      if (rc[i - 1] - rc[i] !== 1) seq = false;
    }
    if (seq) straightHigh = rc[0];
    else if (rc[0] === 12 && rc[1] === 3 && rc[2] === 2 && rc[3] === 1 && rc[4] === 0) straightHigh = 3;
  }
  return rankCategoryAndKey(ranks, flush, straightHigh);
}

function compareHandRank(a, b) {
  if (!b || b.cat == null) return 1;
  if ((a.cat | 0) > (b.cat | 0)) return 1;
  if ((a.cat | 0) < (b.cat | 0)) return -1;
  const ka = a.key || [];
  const kb = b.key || [];
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const va = ka[i] != null ? ka[i] : -1;
    const vb = kb[i] != null ? kb[i] : -1;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function bestHandFrom7(ids7) {
  let best = null;
  for (const subset of combinations5(ids7)) {
    const a = analyze5(subset);
    if (!best || compareHandRank(a, best.rank) > 0) best = { rank: a, cards: subset };
  }
  return best;
}

function cmpHands7(a7, b7) {
  const ba = bestHandFrom7(a7);
  const bb = bestHandFrom7(b7);
  return compareHandRank(ba.rank, bb.rank);
}

function diceTupleRank(d1, d2, d3) {
  const roll = [d1, d2, d3].slice().sort((a, b) => a - b);
  const [x, y, z] = roll;
  if (x === 1 && y === 2 && z === 3) return [-2];
  if (x === 4 && y === 5 && z === 6) return [100];
  if (x === y && y === z) return [50 + z];
  if (x === y || y === z) {
    const pair = y === z ? z : x;
    const kicker = y === z ? x : z;
    return [25 + pair * 4 + kicker];
  }
  return [10 + z * 10 + y * 100 + x * 1000];
}

function compareDiceRolls(a1, a2, a3, b1, b2, b3) {
  const ta = diceTupleRank(a1, a2, a3);
  const tb = diceTupleRank(b1, b2, b3);
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const va = ta[i] != null ? ta[i] : -9999;
    const vb = tb[i] != null ? tb[i] : -9999;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function generateNpcProfile(seed) {
  const rnd = mulberry32(seed >>> 0);
  const ng = NAMES_GIVEN[Math.floor(rnd() * NAMES_GIVEN.length)];
  const ep = NAMES_EPITHET[Math.floor(rnd() * NAMES_EPITHET.length)];
  const gold = 40 + Math.floor(rnd() * 560);
  const hat = HATS[Math.floor(rnd() * HATS.length)];
  const color = CREW_COLORS[Math.floor(rnd() * CREW_COLORS.length)];
  const crewModels = [];
  const nMembers = 3 + Math.floor(rnd() * 4);
  for (let i = 0; i < nMembers; i++) {
    crewModels.push({
      name: `${NAMES_GIVEN[Math.floor(rnd() * NAMES_GIVEN.length)]} ${NAMES_EPITHET[Math.floor(rnd() * NAMES_EPITHET.length)]}`,
      role: i === 0 ? 'captain' : rnd() > 0.6 ? 'gunner' : 'sailor',
      hat: HATS[Math.floor(rnd() * HATS.length)],
      color: CREW_COLORS[Math.floor(rnd() * CREW_COLORS.length)]
    });
  }
  return {
    npcKey: seed,
    name: `${ng} "${ep}"`,
    stack: gold,
    crewModels,
    avatar: { hat, color }
  };
}

function sanitizeRoomPublic(room, viewerPid) {
  const seats = (room.seats || []).map((s, idx) => {
    const row = {
      index: idx,
      kind: s.kind,
      name: s.name,
      stack: s.stack | 0,
      crewModels: s.crewModels || null,
      avatar: s.avatar || null,
      folded: !!s.folded,
      connected: s.kind === 'npc' ? true : !!s.connected,
      isHost: !!s.isHost,
      pendingLeave: !!s.pendingLeave,
      allIn: !!s.allIn
    };
    if (room.game === 'poker' && room.poker) {
      row.contribStreet = s.contribStreet != null ? s.contribStreet | 0 : 0;
      if (typeof viewerPid === 'number' && s.kind === 'player' && s.playerId === viewerPid) {
        row.hole = Array.isArray(s.hole) ? s.hole.slice() : null;
      } else if (room.poker.phase === 'showdown' || room.poker.phase === 'complete') {
        row.hole = Array.isArray(s.hole) ? s.hole.slice() : null;
      }
    }
    return row;
  });
  return {
    id: room.id,
    townKey: room.townKey,
    game: room.game,
    name: room.name,
    hostPlayerId: room.hostPlayerId,
    stakes: room.stakes || {},
    seats,
    phase: room.phase,
    dice: room.dice ? { ...room.dice } : null,
    poker: room.poker ? sanitizePokerPublic(room.poker, room.seats) : null
  };
}

function sanitizePokerPublic(poker, seats) {
  return {
    phase: poker.phase,
    street: poker.street || null,
    board: poker.board ? poker.board.slice() : [],
    pot: poker.pot | 0,
    toAct: poker.toAct | 0,
    facingBet: poker.facingBet | 0,
    minRaise: poker.minRaise | 0,
    dealer: poker.dealer | 0,
    sbSeat: poker.sbSeat | 0,
    bbSeat: poker.bbSeat | 0,
    winners: poker.winners ? poker.winners.slice() : null,
    msg: poker.msg || '',
    sbAmt: poker.sbAmt | 0,
    bbAmt: poker.bbAmt | 0
  };
}

function createTavernGames(deps) {
  const players = deps.players;
  const findWsByPlayerId = deps.findWsByPlayerId;

  let nextRoomId = 1;
  const rooms = new Map();
  const playerRoom = new Map();

  function send(pid, obj) {
    const ws = findWsByPlayerId(pid);
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(obj));
      } catch (e) {}
    }
  }

  function sendGold(pid, delta, why) {
    const d = Math.floor(Number(delta) || 0);
    if (!d) return;
    send(pid, { type: 'tavern_inventory_delta', delta: d, reason: why || '' });
  }

  function broadcastRoom(room, msgFactory) {
    const seen = new Set();
    for (const s of room.seats || []) {
      if (s.kind !== 'player' || s.playerId == null) continue;
      const pid = s.playerId;
      if (seen.has(pid)) continue;
      seen.add(pid);
      send(pid, msgFactory(pid));
    }
  }

  function sameDock(p, msg) {
    if (!p || !p.docked) return false;
    const mx = Number(msg.dockX);
    const mz = Number(msg.dockZ);
    const px = Number(p.dockX);
    const pz = Number(p.dockZ);
    if (!Number.isFinite(mx) || !Number.isFinite(mz) || !Number.isFinite(px) || !Number.isFinite(pz)) return false;
    return Math.abs(px - mx) < 2 && Math.abs(pz - mz) < 2;
  }

  function townKeyFromMsg(msg) {
    const cx = Math.floor(Number(msg.townCx));
    const cz = Math.floor(Number(msg.townCz));
    if (!Number.isFinite(cx) || !Number.isFinite(cz)) return null;
    return `${cx}|${cz}`;
  }

  function ensureNpcSeat(room, idx) {
    const seed = ((room.id | 0) * 1315423911 + idx * 9737333 + (room._npcSeedCounter++ | 0)) >>> 0;
    const prof = generateNpcProfile(seed);
    room.seats[idx] = {
      kind: 'npc',
      playerId: null,
      name: prof.name,
      stack: prof.stack,
      crewModels: prof.crewModels,
      avatar: prof.avatar,
      npcKey: prof.npcKey,
      folded: false,
      hole: null,
      contribStreet: 0,
      allIn: false,
      connected: true,
      isHost: false,
      pendingLeave: false
    };
  }

  function fillEmptyWithNpc(room) {
    room._npcSeedCounter = (room._npcSeedCounter | 0) + 1;
    const max = room.game === 'dice' ? MAX_DICE_PLAYERS : MAX_POKER_PLAYERS;
    for (let i = 0; i < max && i < room.seats.length; i++) {
      const s = room.seats[i];
      if (!s || s.kind === 'empty') ensureNpcSeat(room, i);
    }
    broadcastRoom(room, pid => ({ type: 'tavern_state', room: sanitizeRoomPublic(room, pid) }));
  }

  function leaveSeat(room, seatIdx, pid, refundStack) {
    const s = room.seats[seatIdx];
    if (!s || s.kind !== 'player' || s.playerId !== pid) return false;
    const pk = room.poker;
    if (room.game === 'poker' && pk && pk.phase === 'betting') return false;
    if (room.game === 'dice' && room.phase === 'playing' && room.dice && room.dice.status === 'rolling') return false;
    const stk = s.stack | 0;
    if (refundStack && stk > 0) sendGold(pid, stk, 'leave_table');
    room.seats[seatIdx] = {
      kind: 'empty',
      stack: 0,
      folded: false,
      contribStreet: 0,
      allIn: false
    };
    playerRoom.delete(pid);
    return true;
  }

  function pkGet(room) {
    return room.poker;
  }

  /** ---------- Dice ---------- */
  function scheduleDiceRound(room) {
    if (!room || room.game !== 'dice') return;
    room.dice = room.dice || { status: 'idle', pot: 0, rolls: [], msg: '' };
    clearTimeout(room._diceTimer);
    room._diceTimer = setTimeout(() => runDiceRound(room.id), 420);
  }

  function runDiceRound(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.game !== 'dice' || room.phase !== 'playing') return;
    const ante = Math.max(1, Math.floor(Number(room.stakes.diceAnte) || DEFAULT_DICE_ANTE));
    room.dice.status = 'rolling';
    room.dice.pot = 0;
    room.dice.rolls = [];
    room.dice.msg = '';
    const active = [];
    for (let i = 0; i < room.seats.length; i++) {
      const s = room.seats[i];
      if (!s || s.kind === 'empty') continue;
      if ((s.stack | 0) < ante) {
        room.dice.rolls.push({ seat: i, name: s.name, d: [0, 0, 0], out: true, reason: 'short_stack' });
        continue;
      }
      s.stack -= ante;
      room.dice.pot += ante;
      active.push(i);
    }
    if (active.length === 0) {
      room.dice.status = 'idle';
      room.dice.msg = 'Nobody could cover the ante.';
      broadcastRoom(room, pid => ({ type: 'tavern_state', room: sanitizeRoomPublic(room, pid) }));
      return;
    }
    let bestRoll = null;
    for (const si of active) {
      const s = room.seats[si];
      const d = [rollDie(), rollDie(), rollDie()];
      room.dice.rolls.push({ seat: si, name: s.name, d: d.slice(), out: false });
      if (!bestRoll || compareDiceRolls(d[0], d[1], d[2], bestRoll[0], bestRoll[1], bestRoll[2]) > 0) {
        bestRoll = d;
      }
    }
    const winners = [];
    for (const si of active) {
      const r = room.dice.rolls.find(x => x.seat === si && !x.out);
      if (!r) continue;
      if (compareDiceRolls(r.d[0], r.d[1], r.d[2], bestRoll[0], bestRoll[1], bestRoll[2]) === 0) winners.push(si);
    }
    const pot = room.dice.pot | 0;
    const share = Math.floor(pot / winners.length);
    let rem = pot - share * winners.length;
    for (const si of winners.slice().sort((a, b) => a - b)) {
      let pay = share + (rem > 0 ? 1 : 0);
      if (rem > 0) rem--;
      room.seats[si].stack += pay;
      const pid = room.seats[si].playerId;
      if (room.seats[si].kind === 'player' && pid != null) sendGold(pid, pay, 'dice_win');
    }
    room.dice.status = 'resolved';
    const nm = winners.length ? room.seats[winners[0]].name : 'Nobody';
    room.dice.msg = winners.length ? `${nm} takes ${pot}g.` : 'Round void.';
    broadcastRoom(room, pid => ({ type: 'tavern_state', room: sanitizeRoomPublic(room, pid) }));
    clearTimeout(room._diceTimer);
    room._diceTimer = setTimeout(() => {
      const rr = rooms.get(roomId);
      if (!rr || rr.phase !== 'playing') return;
      rr.dice.status = 'idle';
      broadcastRoom(rr, pid => ({ type: 'tavern_state', room: sanitizeRoomPublic(rr, pid) }));
    }, 2600);
  }

  /** ---------- Poker ---------- */
  function seatsInHand(room) {
    const out = [];
    for (let i = 0; i < room.seats.length; i++) {
      const s = room.seats[i];
      if (!s || s.kind === 'empty') continue;
      if (!s.folded) out.push(i);
    }
    return out;
  }

  function aliveBetting(room) {
    return seatsInHand(room).filter(i => !room.seats[i].folded && !room.seats[i].allIn);
  }

  function resetStreetContribs(room) {
    for (const s of room.seats) {
      if (!s || s.kind === 'empty') continue;
      s.contribStreet = 0;
    }
  }

  function maxContrib(room) {
    let m = 0;
    for (const i of aliveBetting(room)) m = Math.max(m, room.seats[i].contribStreet | 0);
    return m;
  }

  function bettingResolved(room) {
    const mx = maxContrib(room);
    const ix = aliveBetting(room);
    return ix.every(si => {
      const s = room.seats[si];
      return (s.contribStreet | 0) >= mx || (s.stack | 0) === 0;
    });
  }

  function pushChips(room, seatIdx, addToPot) {
    const s = room.seats[seatIdx];
    const pay = Math.max(0, Math.floor(addToPot));
    const actual = Math.min(pay, s.stack | 0);
    s.stack -= actual;
    s.contribStreet = (s.contribStreet | 0) + actual;
    const pk0 = pkGet(room);
    pk0.pot += actual;
    if ((s.stack | 0) === 0) s.allIn = true;
    return actual;
  }

  function rotateDealer(room) {
    const pk0 = pkGet(room);
    const occupied = [];
    for (let i = 0; i < room.seats.length; i++) {
      const s = room.seats[i];
      if (s && s.kind !== 'empty' && (s.stack | 0) > 0) occupied.push(i);
    }
    if (!occupied.length) return;
    const cur = pk0.dealer | 0;
    let ix = occupied.indexOf(cur);
    if (ix < 0) ix = 0;
    else ix = (ix + 1) % occupied.length;
    pk0.dealer = occupied[ix];
  }

  function needGap(room, seatIdx) {
    const pk0 = pkGet(room);
    const s = room.seats[seatIdx];
    return Math.max(0, pk0.facingBet - (s.contribStreet | 0)) > 0;
  }

  function dealNewHand(room) {
    const pk0 = pkGet(room);
    pk0.phase = 'betting';
    pk0.board = [];
    pk0.pot = 0;
    pk0.winners = null;
    pk0.msg = '';
    pk0.deck = shuffleDeck(makeDeck(), mulberry32(((room.id | 0) ^ Date.now()) >>> 0));
    pk0.deckIdx = 0;
    resetStreetContribs(room);
    rotateDealer(room);
    const sbAmt = Math.max(1, Math.floor(Number(room.stakes.pokerSb) || DEFAULT_POKER_SB));
    const bbAmt = Math.max(sbAmt + 1, Math.floor(Number(room.stakes.pokerBb) || DEFAULT_POKER_BB));
    pk0.sbAmt = sbAmt;
    pk0.bbAmt = bbAmt;
    pk0.minRaise = bbAmt;

    const occupied = [];
    for (let i = 0; i < room.seats.length; i++) {
      const s = room.seats[i];
      if (s && s.kind !== 'empty' && (s.stack | 0) > 1) occupied.push(i);
    }
    if (occupied.length < 2) {
      pk0.phase = 'idle';
      pk0.msg = 'Need two stacks with gold.';
      return;
    }

    let di = pk0.dealer | 0;
    if (!occupied.includes(di)) di = occupied[0];
    const ix = occupied.indexOf(di);
    const sbSeat = occupied[(ix + 1) % occupied.length];
    const bbSeat = occupied[(ix + 2) % occupied.length];
    pk0.sbSeat = sbSeat;
    pk0.bbSeat = bbSeat;

    for (const i of occupied) {
      const s = room.seats[i];
      s.folded = false;
      s.allIn = false;
      s.contribStreet = 0;
      s.hole = [pk0.deck[pk0.deckIdx++], pk0.deck[pk0.deckIdx++]];
    }

    pushChips(room, sbSeat, sbAmt);
    pushChips(room, bbSeat, bbAmt);
    pk0.facingBet = bbAmt;
    pk0.street = 'preflop';

    pk0.toAct = occupied[(occupied.indexOf(bbSeat) + 1) % occupied.length];
    pk0.actionSeq = (pk0.actionSeq | 0) + 1;

    resolveNpcActions(room);
  }

  function advanceStreet(room) {
    const pk0 = pkGet(room);
    resetStreetContribs(room);
    pk0.facingBet = 0;
    let idx = pk0.deckIdx;
    const deck = pk0.deck;
    if (pk0.street === 'preflop') {
      idx++;
      pk0.board.push(deck[idx++], deck[idx++], deck[idx++]);
      pk0.street = 'flop';
    } else if (pk0.street === 'flop') {
      idx++;
      pk0.board.push(deck[idx++]);
      pk0.street = 'turn';
    } else if (pk0.street === 'turn') {
      idx++;
      pk0.board.push(deck[idx++]);
      pk0.street = 'river';
    }
    pk0.deckIdx = idx;
    const active = seatsInHand(room).filter(i => !room.seats[i].folded);
    pk0.toAct = active[0] != null ? active[0] : 0;
    pk0.actionSeq++;
    resolveNpcActions(room);
  }

  function showdown(room) {
    const pk0 = pkGet(room);
    pk0.phase = 'showdown';
    const contenders = seatsInHand(room).filter(i => !room.seats[i].folded);
    if (contenders.length <= 1) {
      awardPot(room, contenders);
      return;
    }
    let bestIdx = contenders[0];
    let bestSeven = room.seats[bestIdx].hole.concat(pk0.board);
    for (const i of contenders) {
      const seven = room.seats[i].hole.concat(pk0.board);
      if (cmpHands7(seven, bestSeven) > 0) {
        bestIdx = i;
        bestSeven = seven;
      }
    }
    const winners = contenders.filter(i => cmpHands7(room.seats[i].hole.concat(pk0.board), bestSeven) === 0);
    awardPot(room, winners);
  }

  function awardPot(room, winnerSeats) {
    const pk0 = pkGet(room);
    const pot = pk0.pot | 0;
    pk0.phase = 'complete';
    pk0.winners = winnerSeats.slice().sort((a, b) => a - b);
    const ws = pk0.winners.slice();
    const share = ws.length ? Math.floor(pot / ws.length) : 0;
    let rem = pot - share * ws.length;
    pk0.msg = ws.length ? `${room.seats[ws[0]].name} wins ${pot}g.` : '';
    for (const si of ws) {
      let pay = share + (rem > 0 ? 1 : 0);
      if (rem > 0) rem--;
      room.seats[si].stack += pay;
      const pid = room.seats[si].playerId;
      if (room.seats[si].kind === 'player' && pid != null) sendGold(pid, pay, 'poker_win');
    }
    pk0.pot = 0;
    broadcastRoom(room, pid => ({ type: 'tavern_state', room: sanitizeRoomPublic(room, pid) }));
    clearTimeout(room._pokerDoneTimer);
    room._pokerDoneTimer = setTimeout(() => {
      const rr = rooms.get(room.id);
      if (!rr || rr.phase !== 'playing') return;
      pkGet(rr).phase = 'idle';
      pkGet(rr).msg = '';
      pkGet(rr).winners = null;
      pkGet(rr).board = [];
      broadcastRoom(rr, pid => ({ type: 'tavern_state', room: sanitizeRoomPublic(rr, pid) }));
    }, 3800);
  }

  function npcDecision(room, seatIdx) {
    const pk0 = pkGet(room);
    const s = room.seats[seatIdx];
    const rnd = mulberry32(((seatIdx + 9) * 1664525 + (pk0.actionSeq | 0)) >>> 0);
    const hole = s.hole || [0, 0];
    const hr = Math.floor(hole[0] / 4) + Math.floor(hole[1] / 4);
    const strength = hr / 24;
    const need = Math.max(0, pk0.facingBet - (s.contribStreet | 0));
    const stack = s.stack | 0;
    if (need === 0) {
      if (rnd() < 0.66 || strength > 0.45) return { type: 'check' };
      const raiseAmt = pk0.minRaise + Math.floor(rnd() * Math.min(stack, pk0.bbAmt * 3));
      return { type: 'raise_total', total: (s.contribStreet | 0) + raiseAmt };
    }
    if (need >= stack) {
      return rnd() < 0.35 && strength < 0.42 ? { type: 'fold' } : { type: 'call' };
    }
    if (rnd() < 0.12 && strength < 0.35 && need > pk0.bbAmt) return { type: 'fold' };
    if (rnd() < 0.2 && strength > 0.55) {
      const bump = pk0.minRaise + Math.floor(rnd() * stack * 0.25);
      return { type: 'raise_total', total: Math.min((s.contribStreet | 0) + need + bump, (s.contribStreet | 0) + stack) };
    }
    return { type: 'call' };
  }

  function applyPlayerAction(room, seatIdx, action, raiseTotal) {
    const pk0 = pkGet(room);
    const s = room.seats[seatIdx];
    const need = Math.max(0, pk0.facingBet - (s.contribStreet | 0));
    if (action === 'fold') {
      s.folded = true;
      return true;
    }
    if (action === 'call' || action === 'check') {
      pushChips(room, seatIdx, need);
      return true;
    }
    if (action === 'raise_total') {
      let tgt = Math.floor(Number(raiseTotal) || 0);
      tgt = Math.max((s.contribStreet | 0) + need, tgt);
      const add = tgt - (s.contribStreet | 0);
      pushChips(room, seatIdx, add);
      if ((s.contribStreet | 0) > (pk0.facingBet | 0)) {
        pk0.facingBet = s.contribStreet | 0;
      }
      return true;
    }
    return false;
  }

  function rotateTurn(room) {
    const pk0 = pkGet(room);
    const order = aliveBetting(room);
    if (!order.length) return;
    const ti = pk0.toAct | 0;
    const ix = Math.max(0, order.indexOf(ti));
    pk0.toAct = order[(ix + 1) % order.length];
  }

  function advanceIfNeeded(room) {
    const pk0 = pkGet(room);
    if (!bettingResolved(room)) return false;
    const contenders = seatsInHand(room).filter(i => !room.seats[i].folded);
    if (contenders.length <= 1) {
      awardPot(room, contenders);
      return true;
    }
    if (pk0.street === 'river') {
      showdown(room);
      return true;
    }
    advanceStreet(room);
    broadcastRoom(room, pid => ({ type: 'tavern_state', room: sanitizeRoomPublic(room, pid) }));
    return true;
  }

  function resolveNpcActions(room) {
    clearTimeout(room._npcLoopTimer);
    const pk0 = pkGet(room);
    if (!pk0 || pk0.phase !== 'betting') return;
    const ti = pk0.toAct | 0;
    const s = room.seats[ti];
    if (s && s.kind === 'player') return;

    const step = () => {
      const pk1 = pkGet(room);
      if (!pk1 || pk1.phase !== 'betting') return;
      const t2 = pk1.toAct | 0;
      const sx = room.seats[t2];
      if (!sx || sx.kind === 'empty' || sx.folded || sx.allIn) {
        rotateTurn(room);
        advanceIfNeeded(room);
        resolveNpcActions(room);
        return;
      }
      if (sx.kind === 'npc') {
        const dec = npcDecision(room, t2);
        if (dec.type === 'fold') applyPlayerAction(room, t2, 'fold');
        else if (dec.type === 'check') applyPlayerAction(room, t2, needGap(room, t2) ? 'call' : 'check');
        else if (dec.type === 'call') applyPlayerAction(room, t2, 'call');
        else if (dec.type === 'raise_total') applyPlayerAction(room, t2, 'raise_total', dec.total);
        rotateTurn(room);
        broadcastRoom(room, pid => ({ type: 'tavern_state', room: sanitizeRoomPublic(room, pid) }));
        advanceIfNeeded(room);
        resolveNpcActions(room);
        return;
      }
    };
    room._npcLoopTimer = setTimeout(step, 160);
  }

  /** ---------- Incoming messages ---------- */

  function handle(ws, msg, playerId) {
    const type = msg && msg.type;
    if (!type || typeof type !== 'string' || !type.startsWith('tavern_')) return;

    const p = players.get(playerId);
    if (!p && type !== 'tavern_leave_room') return;

    function okDock(m) {
      return sameDock(p, m);
    }

    if (type === 'tavern_list_rooms') {
      if (!okDock(msg)) return send(playerId, { type: 'tavern_error', error: 'Dock at this harbor.' });
      const tk = townKeyFromMsg(msg);
      const filterGame = msg.game || null;
      const list = [];
      for (const r of rooms.values()) {
        if (r.townKey !== tk) continue;
        if (filterGame && r.game !== filterGame) continue;
        list.push(sanitizeRoomPublic(r, playerId));
      }
      send(playerId, { type: 'tavern_room_list', townKey: tk, rooms: list });
      return;
    }

    if (type === 'tavern_create_room') {
      if (!okDock(msg)) return send(playerId, { type: 'tavern_error', error: 'Dock at this harbor.' });
      const tk = townKeyFromMsg(msg);
      const game = msg.game === 'poker' ? 'poker' : 'dice';
      const max = game === 'dice' ? MAX_DICE_PLAYERS : MAX_POKER_PLAYERS;
      const name = String(msg.name || 'Table').slice(0, 28).trim() || 'Table';
      const roomId = nextRoomId++;
      const seats = [];
      for (let i = 0; i < max; i++) seats.push({ kind: 'empty', stack: 0, folded: false });
      const room = {
        id: roomId,
        townKey: tk,
        game,
        name,
        hostPlayerId: playerId,
        stakes: {
          diceAnte: Math.max(1, Math.min(500, Math.floor(Number(msg.stakes?.diceAnte) || DEFAULT_DICE_ANTE))),
          pokerSb: Math.max(1, Math.min(500, Math.floor(Number(msg.stakes?.pokerSb) || DEFAULT_POKER_SB))),
          pokerBb: Math.max(2, Math.min(1000, Math.floor(Number(msg.stakes?.pokerBb) || DEFAULT_POKER_BB)))
        },
        seats,
        phase: 'lobby',
        dice: null,
        poker: null,
        _npcSeedCounter: (playerId | 0) * 997
      };
      rooms.set(roomId, room);
      send(playerId, { type: 'tavern_created', room: sanitizeRoomPublic(room, playerId) });
      return;
    }

    if (type === 'tavern_join_room') {
      if (!okDock(msg)) return send(playerId, { type: 'tavern_error', error: 'Dock at this harbor.' });
      const roomId = Math.floor(Number(msg.roomId));
      const room = rooms.get(roomId);
      if (!room) return send(playerId, { type: 'tavern_error', error: 'Room gone.' });
      const max = room.game === 'dice' ? MAX_DICE_PLAYERS : MAX_POKER_PLAYERS;
      let seatIdx = msg.seatIndex != null ? Math.floor(Number(msg.seatIndex)) : -1;
      if (!Number.isFinite(seatIdx) || seatIdx < 0) seatIdx = room.seats.findIndex(ss => ss && ss.kind === 'empty');
      if (seatIdx < 0 || seatIdx >= max) return send(playerId, { type: 'tavern_error', error: 'No seat.' });
      const seat = room.seats[seatIdx];
      if (!seat || seat.kind !== 'empty') return send(playerId, { type: 'tavern_error', error: 'Seat taken.' });
      const bring = Math.max(1, Math.min(100000, Math.floor(Number(msg.bringGold) || 0)));
      const crewModels = Array.isArray(msg.crewModels) ? msg.crewModels.slice(0, 16) : [];
      const dispName = String(msg.displayName || p.name || 'Captain').slice(0, 28);
      seat.kind = 'player';
      seat.playerId = playerId;
      seat.name = dispName;
      seat.stack = bring;
      seat.crewModels = crewModels.length ? crewModels : null;
      seat.connected = true;
      seat.isHost = room.hostPlayerId === playerId;
      seat.folded = false;
      seat.hole = null;
      seat.contribStreet = 0;
      seat.allIn = false;
      playerRoom.set(playerId, roomId);
      sendGold(playerId, -bring, 'tavern_buy_in');
      broadcastRoom(room, pid => ({ type: 'tavern_state', room: sanitizeRoomPublic(room, pid) }));
      return;
    }

    if (type === 'tavern_leave_room') {
      const roomId = playerRoom.get(playerId);
      const room = roomId != null ? rooms.get(roomId) : rooms.get(Math.floor(Number(msg.roomId)));
      if (!room) {
        playerRoom.delete(playerId);
        return;
      }
      const idx = room.seats.findIndex(s => s && s.kind === 'player' && s.playerId === playerId);
      if (idx < 0) return;
      const ok = leaveSeat(room, idx, playerId, true);
      if (!ok) return send(playerId, { type: 'tavern_error', error: 'Finish betting or dice roll first.' });
      broadcastRoom(room, pid => ({ type: 'tavern_state', room: sanitizeRoomPublic(room, pid) }));
      return;
    }

    if (type === 'tavern_host_update_room') {
      const room = rooms.get(Math.floor(Number(msg.roomId)));
      if (!room || room.hostPlayerId !== playerId) return send(playerId, { type: 'tavern_error', error: 'Host only.' });
      if (msg.name != null) room.name = String(msg.name).slice(0, 28).trim() || room.name;
      if (msg.stakes && typeof msg.stakes === 'object') {
        if (msg.stakes.diceAnte != null) room.stakes.diceAnte = Math.max(1, Math.min(500, Math.floor(Number(msg.stakes.diceAnte))));
        if (msg.stakes.pokerSb != null) room.stakes.pokerSb = Math.max(1, Math.min(500, Math.floor(Number(msg.stakes.pokerSb))));
        if (msg.stakes.pokerBb != null) room.stakes.pokerBb = Math.max(2, Math.min(1000, Math.floor(Number(msg.stakes.pokerBb))));
      }
      broadcastRoom(room, pid => ({ type: 'tavern_state', room: sanitizeRoomPublic(room, pid) }));
      return;
    }

    if (type === 'tavern_fill_npcs') {
      const room = rooms.get(Math.floor(Number(msg.roomId)));
      if (!room || room.hostPlayerId !== playerId) return send(playerId, { type: 'tavern_error', error: 'Host only.' });
      fillEmptyWithNpc(room);
      return;
    }

    if (type === 'tavern_start_game') {
      const room = rooms.get(Math.floor(Number(msg.roomId)));
      if (!room || room.hostPlayerId !== playerId) return send(playerId, { type: 'tavern_error', error: 'Host only.' });
      const occupied = room.seats.filter(s => s && s.kind !== 'empty').length;
      if (occupied < 2) return send(playerId, { type: 'tavern_error', error: 'Need at least two seated players.' });
      room.phase = 'playing';
      if (room.game === 'dice') {
        room.dice = { status: 'idle', pot: 0, rolls: [], msg: '' };
        scheduleDiceRound(room);
      } else {
        room.poker = {
          phase: 'idle',
          street: null,
          board: [],
          pot: 0,
          deck: [],
          deckIdx: 0,
          facingBet: 0,
          minRaise: 0,
          dealer: room.seats.findIndex(s => s && s.kind !== 'empty'),
          sbSeat: 0,
          bbSeat: 0,
          toAct: 0,
          winners: null,
          msg: '',
          sbAmt: 0,
          bbAmt: 0,
          actionSeq: 0
        };
        dealNewHand(room);
      }
      broadcastRoom(room, pid => ({ type: 'tavern_state', room: sanitizeRoomPublic(room, pid) }));
      return;
    }

    if (type === 'tavern_sync_room') {
      const room = rooms.get(Math.floor(Number(msg.roomId)));
      if (!room) return send(playerId, { type: 'tavern_error', error: 'Room gone.' });
      send(playerId, { type: 'tavern_state', room: sanitizeRoomPublic(room, playerId) });
      return;
    }

    if (type === 'tavern_dice_next_round') {
      const room = rooms.get(Math.floor(Number(msg.roomId)));
      if (!room || room.game !== 'dice' || room.phase !== 'playing') return;
      scheduleDiceRound(room);
      broadcastRoom(room, pid => ({ type: 'tavern_state', room: sanitizeRoomPublic(room, pid) }));
      return;
    }

    if (type === 'tavern_poker_action') {
      const room = rooms.get(Math.floor(Number(msg.roomId)));
      if (!room || room.game !== 'poker' || !room.poker) return;
      const seatIdx = Math.floor(Number(msg.seatIndex));
      const s = room.seats[seatIdx];
      if (!s || s.playerId !== playerId) return send(playerId, { type: 'tavern_error', error: 'Not your seat.' });
      const pk0 = pkGet(room);
      if (pk0.phase !== 'betting' || pk0.toAct !== seatIdx) return send(playerId, { type: 'tavern_error', error: 'Not your turn.' });
      const action = String(msg.action || '');
      if (action === 'fold') applyPlayerAction(room, seatIdx, 'fold');
      else if (action === 'call') applyPlayerAction(room, seatIdx, 'call');
      else if (action === 'check') applyPlayerAction(room, seatIdx, needGap(room, seatIdx) ? 'call' : 'check');
      else if (action === 'raise_total') applyPlayerAction(room, seatIdx, 'raise_total', msg.raiseTo);
      rotateTurn(room);
      broadcastRoom(room, pid => ({ type: 'tavern_state', room: sanitizeRoomPublic(room, pid) }));
      advanceIfNeeded(room);
      resolveNpcActions(room);
      return;
    }

    if (type === 'tavern_cash_out') {
      const room = rooms.get(Math.floor(Number(msg.roomId)));
      if (!room) return send(playerId, { type: 'tavern_error', error: 'Room gone.' });
      const idx = room.seats.findIndex(s => s && s.kind === 'player' && s.playerId === playerId);
      if (idx < 0) return;
      if (room.game === 'poker' && room.poker && room.poker.phase === 'betting') {
        return send(playerId, { type: 'tavern_error', error: 'Finish the betting round.' });
      }
      const stk = room.seats[idx].stack | 0;
      if (stk > 0) sendGold(playerId, stk, 'tavern_cashout');
      leaveSeat(room, idx, playerId, false);
      broadcastRoom(room, pid => ({ type: 'tavern_state', room: sanitizeRoomPublic(room, pid) }));
      return;
    }
  }

  function onPlayerDisconnect(playerId) {
    const rid = playerRoom.get(playerId);
    if (rid == null) return;
    const room = rooms.get(rid);
    if (!room) {
      playerRoom.delete(playerId);
      return;
    }
    const idx = room.seats.findIndex(s => s && s.kind === 'player' && s.playerId === playerId);
    if (idx >= 0) {
      const stk = room.seats[idx].stack | 0;
      if (stk > 0) sendGold(playerId, stk, 'disconnect_refund');
      leaveSeat(room, idx, playerId, false);
      broadcastRoom(room, pid => ({ type: 'tavern_state', room: sanitizeRoomPublic(room, pid) }));
    }
  }

  return { handle, onPlayerDisconnect };
}

module.exports = { createTavernGames };
