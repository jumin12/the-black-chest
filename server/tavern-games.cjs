'use strict';

const crypto = require('crypto');

const MAX_SYNC_GOLD = 999999;
const MIN_BUY_IN = 20;
const DICE_MAX_SEATS = 5;
const POKER_MAX_SEATS = 5;
const PORT_JOIN_RADIUS = 28;
const NPC_NAMES = ['Long Tom', 'Silver Mac', 'Anne Bonny', 'Calico Jack', 'One-Eyed Ned'];

function randInt(max) {
  if (max <= 0) return 0;
  return crypto.randomBytes(4).readUInt32BE(0) % max;
}

function rollDie() {
  return 1 + randInt(6);
}

function genLobbyId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 7; i++) s += alphabet[randInt(alphabet.length)];
  return s;
}

function cardRank(c) {
  return c % 13;
}

function makeDeck() {
  const d = [];
  for (let i = 0; i < 52; i++) d.push(i);
  return d;
}

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    const t = deck[i];
    deck[i] = deck[j];
    deck[j] = t;
  }
}

function combinations5of7(cards7) {
  const out = [];
  const n = cards7.length;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      for (let c = b + 1; c < n; c++) {
        for (let d = c + 1; d < n; d++) {
          for (let e = d + 1; e < n; e++) {
            out.push([cards7[a], cards7[b], cards7[c], cards7[d], cards7[e]]);
          }
        }
      }
    }
  }
  return out;
}

function rankFiveCards(c5) {
  const ranks = c5.map(cardRank).sort((x, y) => x - y);
  const suits = c5.map(c => Math.floor(c / 13));
  const rc = {};
  for (const r of ranks) rc[r] = (rc[r] || 0) + 1;
  const groups = Object.entries(rc).map(([r, cnt]) => ({ r: Number(r), cnt }));
  groups.sort((a, b) => (b.cnt - a.cnt) || (b.r - a.r));

  const isFlush = suits.every(s => s === suits[0]);
  const uniqR = [...new Set(ranks)];
  let isStraight = false;
  let straightHigh = -1;
  if (uniqR.length === 5) {
    let seq = true;
    for (let i = 1; i < ranks.length; i++) {
      if (ranks[i] !== ranks[i - 1] + 1) seq = false;
    }
    if (seq) {
      isStraight = true;
      straightHigh = ranks[4];
    }
    if (!isStraight && ranks[0] === 0 && ranks[1] === 1 && ranks[2] === 2 && ranks[3] === 3 && ranks[4] === 12) {
      isStraight = true;
      straightHigh = 3;
    }
  }

  const kickDesc = () => ranks.slice().sort((a, b) => b - a);

  if (isFlush && isStraight) return { cat: 8, tie: [straightHigh] };
  if (groups[0].cnt === 4) {
    const quad = groups[0].r;
    const k = groups.find(g => g.cnt === 1).r;
    return { cat: 7, tie: [quad, k] };
  }
  if (groups[0].cnt === 3 && groups[1].cnt === 2) return { cat: 6, tie: [groups[0].r, groups[1].r] };
  if (isFlush) return { cat: 5, tie: kickDesc() };
  if (isStraight) return { cat: 4, tie: [straightHigh] };
  if (groups[0].cnt === 3) {
    const kick = groups.filter(g => g.cnt === 1).map(g => g.r).sort((a, b) => b - a);
    return { cat: 3, tie: [groups[0].r, ...kick] };
  }
  if (groups[0].cnt === 2 && groups[1].cnt === 2) {
    const ps = [groups[0].r, groups[1].r].sort((a, b) => b - a);
    const k = groups.find(g => g.cnt === 1).r;
    return { cat: 2, tie: [...ps, k] };
  }
  if (groups[0].cnt === 2) {
    const kick = groups.filter(g => g.cnt === 1).map(g => g.r).sort((a, b) => b - a);
    return { cat: 1, tie: [groups[0].r, ...kick] };
  }
  return { cat: 0, tie: kickDesc() };
}

function cmpRank(a, b) {
  if (a.cat !== b.cat) return a.cat - b.cat;
  const n = Math.max(a.tie.length, b.tie.length);
  for (let i = 0; i < n; i++) {
    const x = a.tie[i] != null ? a.tie[i] : -1;
    const y = b.tie[i] != null ? b.tie[i] : -1;
    if (x !== y) return x - y;
  }
  return 0;
}

function bestHandFromSeven(cards7) {
  let best = null;
  for (const c5 of combinations5of7(cards7)) {
    const r = rankFiveCards(c5);
    if (!best || cmpRank(r, best) > 0) best = r;
  }
  return best;
}

function createTavernGames(deps) {
  const players = deps.players;
  const sendToPlayerId = deps.sendToPlayerId;
  const normalizeCaptainKey = deps.normalizeCaptainKey;
  const findWsByPlayerId = deps.findWsByPlayerId;
  const getLeaderboardRank =
    deps.getLeaderboardRank && typeof deps.getLeaderboardRank === 'function' ? deps.getLeaderboardRank : () => null;

  const anchorGold = new Map();
  const playerLobby = new Map();
  const lobbies = new Map();

  function ckFromWs(ws) {
    const k = ws && ws.captainAccountKey ? normalizeCaptainKey(String(ws.captainAccountKey)) : '';
    return k || '';
  }

  function getAnchor(ck) {
    const k = normalizeCaptainKey(ck);
    return anchorGold.has(k) ? anchorGold.get(k) : null;
  }

  function setAnchor(ck, g) {
    anchorGold.set(normalizeCaptainKey(ck), Math.max(0, Math.min(MAX_SYNC_GOLD, Math.floor(g))));
  }

  function portNear(lobby, p) {
    if (!lobby || !p) return false;
    if (lobby.portDockX == null || lobby.portDockZ == null) return true;
    if (p.dockX == null || p.dockZ == null) return false;
    const dx = lobby.portDockX - p.dockX;
    const dz = lobby.portDockZ - p.dockZ;
    return Math.hypot(dx, dz) <= PORT_JOIN_RADIUS;
  }

  function augmentSeat(seat) {
    const out = {
      kind: seat.kind,
      seatIndex: seat.seatIndex,
      name: seat.name || '',
      playerId: seat.playerId != null ? seat.playerId : null,
      stack: seat.stack | 0
    };
    if (seat.kind === 'npc') {
      out.isNpc = true;
      out.label = 'NPC';
      out.npcFaceSeed = seat.npcFaceSeed != null ? seat.npcFaceSeed | 0 : 0;
    }
    if (seat.kind === 'player' && seat.playerId != null) {
      const pl = players.get(seat.playerId);
      out.displayName =
        pl && (pl.name || pl.shipName)
          ? String(pl.name || pl.shipName).slice(0, 28)
          : String(seat.name || 'Captain').slice(0, 28);
      out.flagColor = pl && pl.flagColor ? String(pl.flagColor) : '#6a5840';
      const fk = pl && pl.shipParts && pl.shipParts.flag != null ? String(pl.shipParts.flag) : 'mast';
      out.flagKey = fk;
      const rk = getLeaderboardRank(seat.playerId);
      out.lbRank = rk != null ? rk : null;
    }
    return out;
  }

  function fillRemainingSeatsWithNpcs(lobby) {
    for (let i = 1; i < lobby.seats.length; i++) {
      const s = lobby.seats[i];
      if (s.kind !== 'empty') continue;
      s.kind = 'npc';
      s.name = NPC_NAMES[randInt(NPC_NAMES.length)];
      s.playerId = null;
      s.stack = 0;
      s.npcFaceSeed = randInt(0x7fffffff);
    }
  }

  function serializeLobby(lobby, forPlayerId) {
    const o = {
      id: lobby.id,
      name: lobby.name || 'Table',
      gameType: lobby.gameType,
      hostPlayerId: lobby.hostPlayerId,
      phase: lobby.phase,
      seats: lobby.seats.map(s => augmentSeat(s))
    };
    if (lobby.game) {
      if (lobby.gameType === 'dice') {
        const g = lobby.game;
        o.game = {
          type: 'dice',
          sub: g.sub,
          pot: g.pot | 0,
          ante: g.ante | 0,
          round: g.round | 0,
          dice: g.diceShown ? g.dice : null,
          winners: g.winners || null,
          message: g.message || ''
        };
      } else {
        const g = lobby.game;
        o.game = {
          type: 'poker',
          street: g.street,
          pot: g.pot | 0,
          sb: g.sb,
          bb: g.bb,
          community: (g.community || []).slice(),
          dealerSeat: g.dealerSeat,
          actorSeat: g.actorSeat,
          facingBet: g.facingBet | 0,
          folded: (g.folded || []).slice(),
          streetCommitted: (g.streetCommitted || []).map(x => x | 0),
          winners: g.winners || null,
          message: g.message || ''
        };
        if (forPlayerId != null && g.hole) {
          const seat = lobby.seats.find(st => st.kind === 'player' && st.playerId === forPlayerId);
          if (seat && g.hole[seat.seatIndex]) o.yourHole = g.hole[seat.seatIndex].slice();
        }
      }
    }
    return o;
  }

  function broadcastLobby(lobby, extra) {
    const seen = new Set();
    for (const s of lobby.seats) {
      if (s.kind !== 'player' || s.playerId == null) continue;
      const pid = s.playerId;
      if (seen.has(pid)) continue;
      seen.add(pid);
      sendToPlayerId(pid, {
        type: 'tavern_push',
        lobby: serializeLobby(lobby, pid),
        ...(extra || {})
      });
    }
  }

  function leaveLobby(playerId, refund) {
    const lid = playerLobby.get(playerId);
    if (!lid) return;
    const lobby = lobbies.get(lid);
    playerLobby.delete(playerId);
    if (!lobby) return;

    let ck = '';
    const ws = findWsByPlayerId(playerId);
    if (ws) ck = ckFromWs(ws);

    for (const s of lobby.seats) {
      if (s.kind === 'player' && s.playerId === playerId) {
        const stk = s.stack | 0;
        if (refund && stk > 0 && ck) {
          const cur = getAnchor(ck);
          if (cur != null) setAnchor(ck, cur + stk);
          sendToPlayerId(playerId, { type: 'tavern_wallet', gold: getAnchor(ck) });
        }
        s.kind = 'empty';
        s.playerId = null;
        s.name = '';
        s.stack = 0;
        break;
      }
    }

    if (lobby.hostPlayerId === playerId) {
      const nx = lobby.seats.find(st => st.kind === 'player' && st.playerId != null);
      lobby.hostPlayerId = nx ? nx.playerId : null;
    }

    const anyHuman = lobby.seats.some(st => st.kind === 'player' && st.playerId != null);
    if (!anyHuman) {
      lobbies.delete(lid);
      return;
    }
    lobby.phase = 'lobby';
    lobby.game = null;
    broadcastLobby(lobby);
  }

  function ensureDocked(playerId) {
    const p = players.get(playerId);
    return p && p.docked === true;
  }

  function startDiceRound(lobby) {
    const ante = lobby.game && lobby.game.ante ? lobby.game.ante : 10;
    let pot = 0;
    const maxIx = Math.max(...lobby.seats.map(s => s.seatIndex));
    const dice = [];
    for (let i = 0; i <= maxIx; i++) dice[i] = null;

    for (const s of lobby.seats) {
      if (s.kind === 'empty') continue;
      const st = s.stack | 0;
      if (st <= 0) continue;
      const pay = Math.min(ante, st);
      s.stack = st - pay;
      pot += pay;
      dice[s.seatIndex] = [rollDie(), rollDie()];
    }

    let bestSum = -1;
    for (const s of lobby.seats) {
      if (s.kind === 'empty') continue;
      const dr = dice[s.seatIndex];
      if (!dr) continue;
      bestSum = Math.max(bestSum, dr[0] + dr[1]);
    }
    const winners = [];
    for (const s of lobby.seats) {
      if (s.kind === 'empty') continue;
      const dr = dice[s.seatIndex];
      if (!dr) continue;
      if (dr[0] + dr[1] === bestSum) winners.push(s.seatIndex);
    }
    const share = Math.floor(pot / Math.max(1, winners.length));
    let rem = pot - share * winners.length;
    for (const wi of winners) {
      const seat = lobby.seats.find(ss => ss.seatIndex === wi);
      if (!seat) continue;
      let add = share;
      if (rem > 0) {
        add++;
        rem--;
      }
      seat.stack = (seat.stack | 0) + add;
    }

    lobby.game = {
      sub: 'showdown',
      pot: 0,
      ante,
      round: (lobby.game && lobby.game.round ? lobby.game.round : 0) + 1,
      diceShown: true,
      dice,
      winners,
      message: bestSum >= 0 ? `Highest total ${bestSum}` : ''
    };
    broadcastLobby(lobby);
  }

  function pokerBettingRoundDone(g, lobby) {
    const occ = lobby.seats.filter(s => s.kind !== 'empty' && !g.folded[s.seatIndex]).map(s => s.seatIndex).sort((a, b) => a - b);
    for (const si of occ) {
      const need = g.facingBet - (g.streetCommitted[si] | 0);
      if (need > 0) return false;
    }
    return true;
  }

  function pokerNextActorAfter(g, lobby, fromSeat) {
    const occ = lobby.seats.filter(s => s.kind !== 'empty' && !g.folded[s.seatIndex]).map(s => s.seatIndex).sort((a, b) => a - b);
    if (!occ.length) return null;
    const idx = occ.indexOf(fromSeat);
    const base = idx >= 0 ? idx : 0;
    return occ[(base + 1) % occ.length];
  }

  function pokerAwardSingleSurvivor(lobby, g) {
    const alive = lobby.seats.filter(s => s.kind !== 'empty' && !g.folded[s.seatIndex]);
    if (alive.length !== 1) return false;
    const w = alive[0];
    w.stack = (w.stack | 0) + g.pot;
    g.winners = [{ seatIndex: w.seatIndex, pot: g.pot }];
    g.message = `${w.name} wins the pot`;
    g.pot = 0;
    g.street = 'showdown';
    g.actorSeat = null;
    return true;
  }

  function pokerAdvanceStreet(lobby, g) {
    const occ = lobby.seats.filter(s => s.kind !== 'empty' && !g.folded[s.seatIndex]).map(s => s.seatIndex).sort((a, b) => a - b);
    const live = occ.filter(si => !g.folded[si]);
    if (live.length < 2) {
      const w = lobby.seats.find(s => s.kind !== 'empty' && !g.folded[s.seatIndex]);
      if (w) w.stack = (w.stack | 0) + g.pot;
      g.winners = [{ seatIndex: w.seatIndex, pot: g.pot }];
      g.message = `${w.name} wins`;
      g.pot = 0;
      g.street = 'showdown';
      g.actorSeat = null;
      return;
    }

    if (g.street === 'preflop') {
      g.street = 'flop';
      g.deck.pop();
      g.community.push(g.deck.pop(), g.deck.pop(), g.deck.pop());
    } else if (g.street === 'flop') {
      g.street = 'turn';
      g.deck.pop();
      g.community.push(g.deck.pop());
    } else if (g.street === 'turn') {
      g.street = 'river';
      g.deck.pop();
      g.community.push(g.deck.pop());
    } else if (g.street === 'river') {
      pokerShowdown(lobby, g);
      return;
    }

    const maxIx = Math.max(...lobby.seats.map(s => s.seatIndex));
    for (let i = 0; i <= maxIx; i++) g.streetCommitted[i] = 0;
    g.facingBet = 0;
    g.raisesThisStreet = 0;

    const iDealer = occ.indexOf(g.dealerSeat);
    const first = occ[(iDealer + 1) % occ.length];
    g.actorSeat = first;
  }

  function pokerShowdown(lobby, g) {
    g.street = 'showdown';
    const board = g.community;
    const live = lobby.seats.filter(s => s.kind !== 'empty' && !g.folded[s.seatIndex]);
    if (live.length === 1) {
      const w = live[0];
      w.stack = (w.stack | 0) + g.pot;
      g.winners = [{ seatIndex: w.seatIndex, pot: g.pot }];
      g.message = `${w.name} wins`;
      g.pot = 0;
      g.actorSeat = null;
      return;
    }
    let best = null;
    const winIdx = [];
    for (const s of live) {
      const hi = g.hole[s.seatIndex];
      if (!hi) continue;
      const seven = [...hi, ...board];
      const rank = bestHandFromSeven(seven);
      if (!best || cmpRank(rank, best.rank) > 0) {
        best = { seatIndex: s.seatIndex, rank };
        winIdx.length = 0;
        winIdx.push(s.seatIndex);
      } else if (best && cmpRank(rank, best.rank) === 0) {
        winIdx.push(s.seatIndex);
      }
    }
    const share = Math.floor(g.pot / winIdx.length);
    let rem = g.pot - share * winIdx.length;
    g.winners = [];
    for (const wi of winIdx) {
      const seat = lobby.seats.find(ss => ss.seatIndex === wi);
      let add = share;
      if (rem > 0) {
        add++;
        rem--;
      }
      if (seat) seat.stack += add;
      g.winners.push({ seatIndex: wi, pot: add });
    }
    g.pot = 0;
    g.actorSeat = null;
    g.message = 'Showdown';
  }

  function initPokerHand(lobby) {
    const occ0 = lobby.seats.filter(s => s.kind !== 'empty' && (s.stack | 0) > 0).map(s => s.seatIndex).sort((a, b) => a - b);
    if (occ0.length < 2) return null;

    const deck = makeDeck();
    shuffleDeck(deck);

    const prev = lobby.game && Number.isFinite(lobby.game.dealerSeat) ? lobby.game.dealerSeat : occ0[0];
    let ix = occ0.indexOf(prev);
    if (ix < 0) ix = 0;
    const dealerSeat = occ0[(ix + 1) % occ0.length];

    const SB = 5;
    const BB = 10;
    const maxIx = Math.max(...lobby.seats.map(s => s.seatIndex));

    const hole = [];
    const folded = [];
    for (let i = 0; i <= maxIx; i++) {
      hole[i] = null;
      folded[i] = true;
    }
    for (const s of lobby.seats) {
      if (s.kind === 'empty' || (s.stack | 0) <= 0) continue;
      folded[s.seatIndex] = false;
      hole[s.seatIndex] = [deck.pop(), deck.pop()];
    }

    const occ = lobby.seats.filter(s => s.kind !== 'empty' && !folded[s.seatIndex]).map(s => s.seatIndex).sort((a, b) => a - b);
    const iDealer = occ.indexOf(dealerSeat);
    const sbIdx = occ[(iDealer + 1) % occ.length];
    const bbIdx = occ[(iDealer + 2) % occ.length];

    const streetCommitted = [];
    for (let i = 0; i <= maxIx; i++) streetCommitted[i] = 0;

    function collect(si, amt) {
      const seat = lobby.seats.find(ss => ss.seatIndex === si && ss.kind !== 'empty');
      if (!seat) return 0;
      const pay = Math.min(seat.stack | 0, amt);
      seat.stack -= pay;
      return pay;
    }

    const paidSb = collect(sbIdx, SB);
    const paidBb = collect(bbIdx, BB);
    streetCommitted[sbIdx] = paidSb;
    streetCommitted[bbIdx] = paidBb;
    const pot = paidSb + paidBb;

    const utg = occ[(occ.indexOf(bbIdx) + 1) % occ.length];

    return {
      type: 'poker',
      deck,
      hole,
      community: [],
      folded,
      pot,
      sb: SB,
      bb: BB,
      dealerSeat,
      sbSeat: sbIdx,
      bbSeat: bbIdx,
      street: 'preflop',
      streetCommitted,
      facingBet: BB,
      raisesThisStreet: 0,
      maxRaises: 4,
      actorSeat: utg,
      winners: null,
      message: ''
    };
  }

  function applyPokerAction(lobby, g, seatIdx, action, raiseAmt) {
    const seat = lobby.seats.find(s => s.seatIndex === seatIdx);
    if (!seat) return;
    const committed = g.streetCommitted[seatIdx] | 0;
    const callNeed = Math.max(0, g.facingBet - committed);

    if (action === 'fold') {
      g.folded[seatIdx] = true;
      if (pokerAwardSingleSurvivor(lobby, g)) return;
      if (pokerBettingRoundDone(g, lobby)) pokerAdvanceStreet(lobby, g);
      else g.actorSeat = pokerNextActorAfter(g, lobby, seatIdx);
      return;
    }
    if (action === 'check') {
      if (callNeed > 0) return;
    } else if (action === 'call') {
      const pay = Math.min(seat.stack | 0, callNeed);
      seat.stack -= pay;
      g.pot += pay;
      g.streetCommitted[seatIdx] = committed + pay;
    } else if (action === 'raise') {
      const add = Math.max(g.bb, Math.floor(raiseAmt || g.bb));
      const total = callNeed + add;
      const pay = Math.min(seat.stack | 0, total);
      seat.stack -= pay;
      g.pot += pay;
      g.streetCommitted[seatIdx] = committed + pay;
      g.facingBet = Math.max(g.facingBet, g.streetCommitted[seatIdx]);
      g.raisesThisStreet++;
    }

    if (pokerAwardSingleSurvivor(lobby, g)) return;
    if (pokerBettingRoundDone(g, lobby)) pokerAdvanceStreet(lobby, g);
    else g.actorSeat = pokerNextActorAfter(g, lobby, seatIdx);
  }

  function processNpcPoker(lobby) {
    const g = lobby.game;
    if (!g || g.street === 'showdown') return;
    for (let guard = 0; guard < 80; guard++) {
      const actor = g.actorSeat;
      if (actor == null) break;
      const seat = lobby.seats.find(s => s.seatIndex === actor);
      if (!seat || seat.kind !== 'npc') break;

      const committed = g.streetCommitted[actor] | 0;
      const callNeed = Math.max(0, g.facingBet - committed);
      const hole = g.hole[actor];
      let sVal = 0.35;
      if (hole) {
        sVal = ((cardRank(hole[0]) + cardRank(hole[1])) / 24) * (cardRank(hole[0]) === cardRank(hole[1]) ? 1.3 : 1);
      }

      if (callNeed > (seat.stack | 0) * 0.35 && randInt(100) < 42) {
        applyPokerAction(lobby, g, actor, 'fold', 0);
      } else if (callNeed === 0 && randInt(100) < 60) {
        applyPokerAction(lobby, g, actor, 'check', 0);
      } else if (g.raisesThisStreet < g.maxRaises && sVal > 0.52 && randInt(100) < 38) {
        applyPokerAction(lobby, g, actor, 'raise', g.bb);
      } else if (callNeed > 0) {
        applyPokerAction(lobby, g, actor, 'call', 0);
      } else {
        applyPokerAction(lobby, g, actor, 'check', 0);
      }

      broadcastLobby(lobby);
      if (g.street === 'showdown') break;
    }
  }

  function runCmd(ws, playerId, msg) {
    const cmd = msg.cmd;
    const ck = ckFromWs(ws);

    if (cmd === 'wallet_sync') {
      if (!ensureDocked(playerId)) {
        sendToPlayerId(playerId, { type: 'tavern_err', error: 'Dock at a port to play tavern games.' });
        return;
      }
      const g = Math.max(0, Math.min(MAX_SYNC_GOLD, Math.floor(Number(msg.gold) || 0)));
      setAnchor(ck, g);
      sendToPlayerId(playerId, { type: 'tavern_wallet', gold: getAnchor(ck) });
      return;
    }

    if (cmd === 'list') {
      if (!ensureDocked(playerId)) {
        sendToPlayerId(playerId, { type: 'tavern_list', poker: [], dice: [] });
        return;
      }
      const p = players.get(playerId);
      const pokerRows = [];
      const diceRows = [];
      if (p && p.dockX != null && p.dockZ != null) {
        for (const lobby of lobbies.values()) {
          if (!portNear(lobby, p)) continue;
          const occ = lobby.seats.filter(s => s.kind !== 'empty').length;
          const hs = lobby.seats.find(st => st.playerId === lobby.hostPlayerId && st.kind === 'player');
          const row = {
            id: lobby.id,
            name: lobby.name || 'Table',
            gameType: lobby.gameType,
            phase: lobby.phase,
            seatsTaken: occ,
            seatsMax: lobby.seats.length,
            hostName: hs ? hs.name || '' : ''
          };
          if (lobby.gameType === 'poker') pokerRows.push(row);
          else diceRows.push(row);
        }
      }
      sendToPlayerId(playerId, { type: 'tavern_list', poker: pokerRows, dice: diceRows });
      return;
    }

    if (cmd === 'create') {
      if (!ensureDocked(playerId)) {
        sendToPlayerId(playerId, { type: 'tavern_err', error: 'Dock first.' });
        return;
      }
      const gameType = msg.gameType === 'poker' ? 'poker' : 'dice';
      const maxSeats = gameType === 'poker' ? POKER_MAX_SEATS : DICE_MAX_SEATS;
      const id = genLobbyId();
      const seats = [];
      for (let i = 0; i < maxSeats; i++) seats.push({ kind: 'empty', seatIndex: i, name: '', playerId: null, stack: 0 });
      const rawName = msg.lobbyName != null ? String(msg.lobbyName) : msg.name != null ? String(msg.name) : '';
      let lobbyName = rawName.trim().slice(0, 32);
      if (!lobbyName) lobbyName = 'Table';
      const p0 = players.get(playerId);
      const lobby = {
        id,
        name: lobbyName,
        gameType,
        hostPlayerId: playerId,
        phase: 'lobby',
        seats,
        game: null,
        portDockX: p0 && p0.dockX != null ? p0.dockX : null,
        portDockZ: p0 && p0.dockZ != null ? p0.dockZ : null
      };
      lobbies.set(id, lobby);
      const capName = (p0 && (p0.name || p0.shipName)) ? String(p0.name || p0.shipName).slice(0, 28) : 'Captain';
      lobby.seats[0].kind = 'player';
      lobby.seats[0].playerId = playerId;
      lobby.seats[0].name = capName;
      fillRemainingSeatsWithNpcs(lobby);
      playerLobby.set(playerId, id);
      sendToPlayerId(playerId, { type: 'tavern_push', lobby: serializeLobby(lobby, playerId) });
      return;
    }

    if (cmd === 'join') {
      const lobby = lobbies.get(String(msg.lobbyId || ''));
      if (!lobby) {
        sendToPlayerId(playerId, { type: 'tavern_err', error: 'Lobby not found.' });
        return;
      }
      const joiner = players.get(playerId);
      if (!portNear(lobby, joiner)) {
        sendToPlayerId(playerId, { type: 'tavern_err', error: 'That table was started in another harbor.' });
        return;
      }
      if (playerLobby.has(playerId)) {
        sendToPlayerId(playerId, { type: 'tavern_err', error: 'Already seated.' });
        return;
      }
      let seatIdx = lobby.seats.findIndex((s, idx) => idx > 0 && s.kind === 'empty');
      if (seatIdx < 0) seatIdx = lobby.seats.findIndex((s, idx) => idx > 0 && s.kind === 'npc');
      if (seatIdx < 0) {
        sendToPlayerId(playerId, { type: 'tavern_err', error: 'Full.' });
        return;
      }
      const p = players.get(playerId);
      const name = (p && (p.name || p.shipName)) ? String(p.name || p.shipName).slice(0, 28) : 'Captain';
      lobby.seats[seatIdx].kind = 'player';
      lobby.seats[seatIdx].playerId = playerId;
      lobby.seats[seatIdx].name = name;
      lobby.seats[seatIdx].npcFaceSeed = null;
      playerLobby.set(playerId, lobby.id);
      broadcastLobby(lobby);
      return;
    }

    if (cmd === 'add_npc') {
      const lobby = lobbies.get(String(msg.lobbyId || ''));
      if (!lobby || lobby.hostPlayerId !== playerId) {
        sendToPlayerId(playerId, { type: 'tavern_err', error: 'Host only.' });
        return;
      }
      const si = msg.seatIndex != null ? Math.floor(Number(msg.seatIndex)) : lobby.seats.findIndex(s => s.kind === 'empty');
      if (si < 0 || si >= lobby.seats.length || lobby.seats[si].kind !== 'empty') {
        sendToPlayerId(playerId, { type: 'tavern_err', error: 'Bad seat.' });
        return;
      }
      lobby.seats[si].kind = 'npc';
      lobby.seats[si].name = NPC_NAMES[randInt(NPC_NAMES.length)];
      lobby.seats[si].stack = 500;
      broadcastLobby(lobby);
      return;
    }

    if (cmd === 'buy_chips') {
      const lobby = lobbies.get(String(msg.lobbyId || ''));
      if (!lobby) return;
      const seat = lobby.seats.find(s => s.kind === 'player' && s.playerId === playerId);
      if (!seat) return;
      const amt = Math.max(0, Math.floor(Number(msg.amount) || 0));
      if (amt < MIN_BUY_IN) {
        sendToPlayerId(playerId, { type: 'tavern_err', error: `Minimum ${MIN_BUY_IN}g.` });
        return;
      }
      const cur = getAnchor(ck);
      if (msg.holdGold != null && cur == null) {
        setAnchor(ck, Math.max(0, Math.floor(Number(msg.holdGold) || 0)));
      }
      const cur2 = getAnchor(ck);
      if (cur2 == null || cur2 < amt) {
        sendToPlayerId(playerId, { type: 'tavern_err', error: 'Not enough gold.' });
        return;
      }
      setAnchor(ck, cur - amt);
      seat.stack = (seat.stack | 0) + amt;
      sendToPlayerId(playerId, { type: 'tavern_wallet', gold: getAnchor(ck) });
      broadcastLobby(lobby);
      return;
    }

    if (cmd === 'cash_out') {
      const lobby = lobbies.get(String(msg.lobbyId || ''));
      if (!lobby) return;
      const seat = lobby.seats.find(s => s.kind === 'player' && s.playerId === playerId);
      if (!seat) return;
      const playing = lobby.phase === 'playing';
      const g = lobby.game;
      let ok = !playing;
      if (playing && lobby.gameType === 'dice' && g && g.sub === 'showdown') ok = true;
      if (playing && lobby.gameType === 'poker' && g && g.folded && g.folded[seat.seatIndex]) ok = true;
      if (playing && lobby.gameType === 'poker' && g && g.street === 'showdown') ok = true;
      if (!ok) {
        sendToPlayerId(playerId, { type: 'tavern_err', error: 'Fold, wait for showdown, or finish between hands.' });
        return;
      }
      const stk = seat.stack | 0;
      if (stk > 0 && ck) {
        const cur = getAnchor(ck);
        if (cur != null) setAnchor(ck, cur + stk);
        seat.stack = 0;
        sendToPlayerId(playerId, { type: 'tavern_wallet', gold: getAnchor(ck) });
      }
      broadcastLobby(lobby);
      return;
    }

    if (cmd === 'start') {
      const lobby = lobbies.get(String(msg.lobbyId || ''));
      if (!lobby || lobby.hostPlayerId !== playerId) return;
      if (lobby.phase === 'playing') {
        sendToPlayerId(playerId, {
          type: 'tavern_err',
          error: 'A round is in progress — use Next roll / Next hand after the showdown.'
        });
        return;
      }
      const ready = lobby.seats.filter(s => s.kind !== 'empty' && (s.stack | 0) > 0).length;
      if (ready < 2) {
        sendToPlayerId(playerId, { type: 'tavern_err', error: 'Need two stacks with chips.' });
        return;
      }
      lobby.phase = 'playing';
      if (lobby.gameType === 'dice') {
        lobby.game = { ante: 10, round: 0, sub: 'idle' };
        startDiceRound(lobby);
      } else {
        const gh = initPokerHand(lobby);
        if (!gh) {
          lobby.phase = 'lobby';
          sendToPlayerId(playerId, { type: 'tavern_err', error: 'Cannot deal.' });
          return;
        }
        lobby.game = gh;
        broadcastLobby(lobby);
        processNpcPoker(lobby);
      }
      return;
    }

    if (cmd === 'dice_next') {
      const lobby = lobbies.get(String(msg.lobbyId || ''));
      if (!lobby || lobby.gameType !== 'dice' || lobby.hostPlayerId !== playerId) return;
      startDiceRound(lobby);
      return;
    }

    if (cmd === 'poker_action') {
      const lobby = lobbies.get(String(msg.lobbyId || ''));
      if (!lobby || lobby.gameType !== 'poker' || !lobby.game) return;
      const g = lobby.game;
      const seat = lobby.seats.find(s => s.playerId === playerId);
      if (!seat || seat.seatIndex !== g.actorSeat) return;
      const action = String(msg.action || '');
      applyPokerAction(lobby, g, seat.seatIndex, action, Math.floor(Number(msg.raiseBy) || 0));
      broadcastLobby(lobby);
      processNpcPoker(lobby);
      return;
    }

    if (cmd === 'poker_next_hand') {
      const lobby = lobbies.get(String(msg.lobbyId || ''));
      if (!lobby || lobby.hostPlayerId !== playerId || lobby.gameType !== 'poker') return;
      const g0 = lobby.game;
      if (g0 && g0.type === 'poker' && g0.street && g0.street !== 'showdown') {
        sendToPlayerId(playerId, { type: 'tavern_err', error: 'Wait for showdown before dealing the next hand.' });
        return;
      }
      const gh = initPokerHand(lobby);
      if (!gh) return;
      lobby.game = gh;
      broadcastLobby(lobby);
      processNpcPoker(lobby);
      return;
    }

    if (cmd === 'leave') {
      leaveLobby(playerId, true);
      sendToPlayerId(playerId, { type: 'tavern_left' });
    }
  }

  return {
    handleCmd(ws, playerId, msg) {
      try {
        runCmd(ws, playerId, msg);
      } catch (e) {
        console.error('[tavern]', e);
      }
    },
    onDisconnect(playerId) {
      leaveLobby(playerId, true);
    }
  };
}

module.exports = { createTavernGames };
