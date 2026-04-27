'use strict';

const fs = require('fs');
const path = require('path');

const FACTION_COUNT = 5;

function makeDefaultMatrix(ws) {
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

function createWorldPoliticsStore(opts) {
  const filePath = opts.filePath;
  const worldSeed = (opts.worldSeed >>> 0) || 42;
  let matrix = makeDefaultMatrix(worldSeed);
  let portController = Object.create(null);
  let factionWealth = [1400, 1400, 1400, 1400, 1400];
  let inflation = 1;
  let portGarrison = Object.create(null);
  let playerStandings = Object.create(null);
  let _econAcc = 0;
  let _dirty = false;

  function markDirty() {
    _dirty = true;
  }

  function consumeDirty() {
    const d = _dirty;
    _dirty = false;
    return d;
  }

  function snapshot() {
    return {
      matrix: matrix.map(r => r.slice()),
      portController: { ...portController },
      factionWealth: factionWealth.slice(),
      inflation,
      portGarrison: JSON.parse(JSON.stringify(portGarrison)),
      playerStandings: JSON.parse(JSON.stringify(playerStandings))
    };
  }

  function load() {
    try {
      if (!filePath || !fs.existsSync(filePath)) return;
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!raw || typeof raw !== 'object') return;
      if (Array.isArray(raw.matrix) && raw.matrix.length === FACTION_COUNT) {
        matrix = raw.matrix.map((row, i) => {
          if (!Array.isArray(row)) return makeDefaultMatrix(worldSeed)[i];
          const out = [];
          for (let j = 0; j < FACTION_COUNT; j++) {
            const v = row[j];
            out.push(Number.isFinite(Number(v)) ? Math.max(-100, Math.min(100, Number(v))) : makeDefaultMatrix(worldSeed)[i][j]);
          }
          return out;
        });
      }
      if (raw.portController && typeof raw.portController === 'object') portController = { ...raw.portController };
      if (Array.isArray(raw.factionWealth) && raw.factionWealth.length >= FACTION_COUNT) {
        for (let i = 0; i < FACTION_COUNT; i++) {
          const w = raw.factionWealth[i];
          factionWealth[i] = Number.isFinite(Number(w)) ? Math.max(200, Math.floor(Number(w))) : factionWealth[i];
        }
      }
      if (raw.inflation != null && Number.isFinite(Number(raw.inflation))) {
        inflation = Math.max(0.82, Math.min(1.38, Number(raw.inflation)));
      }
      if (raw.portGarrison && typeof raw.portGarrison === 'object') portGarrison = raw.portGarrison;
      if (raw.playerStandings && typeof raw.playerStandings === 'object') {
        const next = Object.create(null);
        for (const k of Object.keys(raw.playerStandings)) {
          const s = sanitizePlayerPoliticsPatch(raw.playerStandings[k]);
          if (s) next[k] = s;
        }
        playerStandings = next;
      }
    } catch (e) {
      console.warn('[playground] world politics load failed:', e && e.message ? e.message : e);
    }
  }

  function save() {
    if (!filePath) return;
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({
        v: 2,
        matrix,
        portController,
        factionWealth,
        inflation,
        portGarrison,
        playerStandings
      }));
    } catch (e) {
      console.warn('[playground] world politics save failed:', e && e.message ? e.message : e);
    }
  }

  function tickEconomy(dt) {
    _econAcc += dt;
    if (_econAcc < 14) return;
    _econAcc = 0;
    inflation = Math.max(0.82, Math.min(1.38, inflation + (Math.random() - 0.48) * 0.012));
    for (let i = 0; i < FACTION_COUNT; i++) {
      factionWealth[i] = Math.max(200, (factionWealth[i] | 0) + ((Math.random() * 28 - 11) | 0));
    }
    for (let k = 0; k < 2; k++) {
      const i = (Math.random() * FACTION_COUNT) | 0;
      const j = (Math.random() * FACTION_COUNT) | 0;
      if (i === j) continue;
      const d = (Math.random() - 0.5) * 6;
      matrix[i][j] = Math.max(-100, Math.min(100, (matrix[i][j] || 0) + d));
    }
    markDirty();
  }

  function getNpcPoliticsRef() {
    return { matrix, portController, factionWealth };
  }

  function mergePortControllerFromClient(pc) {
    if (!pc || typeof pc !== 'object') return;
    for (const k of Object.keys(pc)) {
      const v = pc[k];
      if (v != null && Number.isFinite(Number(v))) portController[k] = (Number(v) | 0) % FACTION_COUNT;
    }
    markDirty();
  }

  function resetToSeed(newSeed) {
    const s = (Number(newSeed) >>> 0) || 42;
    matrix = makeDefaultMatrix(s);
    portController = Object.create(null);
    factionWealth = [1400, 1400, 1400, 1400, 1400];
    inflation = 1;
    portGarrison = Object.create(null);
    playerStandings = Object.create(null);
    _econAcc = 0;
    markDirty();
    save();
  }

  function setPlayerStanding(pid, raw) {
    const s = sanitizePlayerPoliticsPatch(raw);
    if (!s) return;
    playerStandings[String(pid)] = s;
    markDirty();
  }

  function getPlayerStanding(pid) {
    return playerStandings[String(pid)] || null;
  }

  load();

  return {
    snapshot,
    load,
    save,
    tickEconomy,
    getNpcPoliticsRef,
    mergePortControllerFromClient,
    resetToSeed,
    setPlayerStanding,
    getPlayerStanding,
    consumeDirty,
    get matrix() {
      return matrix;
    },
    get portController() {
      return portController;
    },
    get factionWealth() {
      return factionWealth;
    },
    get inflation() {
      return inflation;
    },
    set inflation(v) {
      if (Number.isFinite(Number(v))) inflation = Math.max(0.82, Math.min(1.38, Number(v)));
    }
  };
}

function sanitizePlayerPoliticsPatch(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const relations = [];
  if (Array.isArray(raw.relations)) {
    for (let i = 0; i < FACTION_COUNT; i++) {
      const r = raw.relations[i];
      relations.push(Number.isFinite(Number(r)) ? Math.max(-100, Math.min(100, Math.round(Number(r)))) : 0);
    }
  } else {
    for (let i = 0; i < FACTION_COUNT; i++) relations.push(0);
  }
  const crimes = Math.max(0, Math.min(999, Math.floor(Number(raw.crimes) || 0)));
  let joinedFaction = null;
  if (raw.joinedFaction != null && Number.isFinite(Number(raw.joinedFaction))) {
    joinedFaction = Math.max(0, Math.min(FACTION_COUNT - 1, Math.floor(Number(raw.joinedFaction))));
  }
  return { relations, crimes, joinedFaction };
}

module.exports = { createWorldPoliticsStore, sanitizePlayerPoliticsPatch, FACTION_COUNT };
