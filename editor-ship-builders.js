/**
 * Ship mesh + crew placement for map-editor preview (mirrors index.html builders).
 */
import * as THREE from 'three';

export const SHIP_TYPES_ME = {
  cutter: {
    name: 'Cutter', desc: 'Shoal-draft courier — razor entry, single lofty mast',
    hullLen: 6.55, hullW: 2.1, hullH: 1.31, masts: 1, cannonSlots: 1, bowStyle: 'pointed'
  },
  sloop: {
    name: 'Sloop', desc: 'Low freeboard predator — blade bow under one huge spread',
    hullLen: 9.17, hullW: 2.88, hullH: 1.71, masts: 1, cannonSlots: 2, bowStyle: 'pointed'
  },
  brigantine: {
    name: 'Brigantine', desc: 'Square-forward brig rig — muscular waist built for cargoes',
    hullLen: 13.1, hullW: 4.19, hullH: 2.23, masts: 2, cannonSlots: 4, bowStyle: 'wide'
  },
  galleon: {
    name: 'Galleon', desc: 'High-poop Iberian lump — bee-hive stern and laden hold',
    hullLen: 18.35, hullW: 5.9, hullH: 3.05, masts: 3, cannonSlots: 6, bowStyle: 'wide'
  },
  warship: {
    name: 'Man-o-War', desc: 'Three-deck thunder — bluff bows, castles, stepped broadsides',
    hullLen: 23.6, hullW: 7.2, hullH: 3.68, masts: 3, cannonSlots: 10, bowStyle: 'blunt'
  }
};

export const SHIP_PARTS_ME = {
  hull: [
    { id: 'basic', name: 'Oak Hull' },
    { id: 'reinforced', name: 'Ironclad Hull' },
    { id: 'darkwood', name: 'Darkwood Hull' }
  ],
  sail: [
    { id: 'basic', name: 'Canvas Sails' },
    { id: 'silk', name: 'Silk Sails' },
    { id: 'war', name: 'War Sails' }
  ],
  cannon: [
    { id: 'none', name: 'No Cannons' },
    { id: 'light', name: 'Light Cannons' },
    { id: 'heavy', name: 'Heavy Cannons' }
  ],
  figurehead: [
    { id: 'none', name: 'None' },
    { id: 'dragon', name: 'Dragon' },
    { id: 'mermaid', name: 'Mermaid' },
    { id: 'skull', name: 'Skull' }
  ],
  flag: [
    { id: 'mast', name: 'Masthead' },
    { id: 'side', name: 'Quarter gallery' },
    { id: 'stern', name: 'Stern staff' }
  ]
};

function buildShipHullPlanShapeME(type, hw, hl) {
  const shape = new THREE.Shape();
  if (type === 'cutter') {
    shape.moveTo(-hw * 0.92, -hl);
    shape.lineTo(-hw * 1.04, -hl * 0.24); shape.lineTo(-hw * 0.82, hl * 0.46); shape.lineTo(-hw * 0.46, hl * 0.86);
    shape.lineTo(0, hl * 0.94); shape.lineTo(hw * 0.46, hl * 0.86); shape.lineTo(hw * 0.82, hl * 0.46);
    shape.lineTo(hw * 1.04, -hl * 0.24); shape.lineTo(hw * 0.92, -hl); shape.lineTo(0, -hl * 1.06);
    shape.closePath();
  } else if (type === 'sloop') {
    shape.moveTo(-hw * 0.94, -hl);
    shape.lineTo(-hw * 1.08, -hl * 0.29); shape.lineTo(-hw * 0.9, hl * 0.52); shape.lineTo(-hw * 0.55, hl * 0.9);
    shape.lineTo(0, hl); shape.lineTo(hw * 0.55, hl * 0.9); shape.lineTo(hw * 0.9, hl * 0.52);
    shape.lineTo(hw * 1.08, -hl * 0.29); shape.lineTo(hw * 0.94, -hl); shape.lineTo(0, -hl * 1.05);
    shape.closePath();
  } else if (type === 'brigantine') {
    shape.moveTo(-hw, -hl);
    shape.lineTo(-hw * 1.16, -hl * 0.34); shape.lineTo(-hw * 1.04, hl * 0.22); shape.lineTo(-hw, hl * 0.53);
    shape.lineTo(-hw * 0.58, hl * 0.92); shape.lineTo(0, hl); shape.lineTo(hw * 0.58, hl * 0.92);
    shape.lineTo(hw, hl * 0.53); shape.lineTo(hw * 1.04, hl * 0.22); shape.lineTo(hw * 1.16, -hl * 0.34); shape.lineTo(hw, -hl);
    shape.lineTo(0, -hl * 1.06); shape.closePath();
  } else if (type === 'galleon') {
    shape.moveTo(-hw * 0.98, -hl);
    shape.lineTo(-hw * 1.22, -hl * 0.38); shape.lineTo(-hw * 1.1, hl * 0.12); shape.lineTo(-hw * 0.98, hl * 0.52);
    shape.lineTo(-hw * 0.62, hl * 0.94); shape.lineTo(0, hl * 0.995); shape.lineTo(hw * 0.62, hl * 0.94);
    shape.lineTo(hw * 0.98, hl * 0.52); shape.lineTo(hw * 1.1, hl * 0.12); shape.lineTo(hw * 1.22, -hl * 0.38); shape.lineTo(hw * 0.98, -hl);
    shape.lineTo(0, -hl * 1.02); shape.closePath();
  } else if (type === 'warship') {
    shape.moveTo(-hw * 1.02, -hl * 0.97);
    shape.lineTo(-hw * 1.05, -hl * 0.18); shape.lineTo(-hw * 0.96, hl * 0.38); shape.lineTo(-hw * 0.64, hl * 0.88);
    shape.lineTo(0, hl * 0.988); shape.lineTo(hw * 0.64, hl * 0.88); shape.lineTo(hw * 0.96, hl * 0.38);
    shape.lineTo(hw * 1.05, -hl * 0.18); shape.lineTo(hw * 1.02, -hl * 0.97); shape.lineTo(0, -hl);
    shape.closePath();
  } else {
    shape.moveTo(-hw, -hl); shape.lineTo(-hw * 1.1, -hl * 0.3); shape.lineTo(-hw, hl * 0.5);
    shape.lineTo(-hw * 0.6, hl * 0.9); shape.lineTo(0, hl); shape.lineTo(hw * 0.6, hl * 0.9);
    shape.lineTo(hw, hl * 0.5); shape.lineTo(hw * 1.1, -hl * 0.3); shape.lineTo(hw, -hl);
    shape.lineTo(0, -hl * 1.05); shape.closePath();
  }
  return shape;
}

function shipClassMastHeightMulME(shipType) {
  switch (shipType) {
    case 'cutter': return 0.63;
    case 'sloop': return 0.69;
    case 'brigantine': return 0.745;
    case 'galleon': return 0.785;
    case 'warship': return 0.825;
    default: return 0.72;
  }
}

export function normalizeShipPartsME(parts) {
  const d = { hull: 'basic', sail: 'basic', cannon: 'light', figurehead: 'none', flag: 'mast' };
  if (!parts || typeof parts !== 'object') return { ...d };
  const rawFlag = parts.flag != null ? parts.flag : parts.flagPosition;
  const flag = rawFlag === 'side' || rawFlag === 'stern' || rawFlag === 'mast' ? rawFlag : d.flag;
  return {
    hull: parts.hull || d.hull,
    sail: parts.sail || d.sail,
    cannon: parts.cannon === undefined || parts.cannon === null || parts.cannon === '' ? d.cannon : parts.cannon,
    figurehead: parts.figurehead === undefined || parts.figurehead === null || parts.figurehead === '' ? d.figurehead : parts.figurehead,
    flag
  };
}

function resolveShipVisualClassME(spec) {
  if (!spec || !SHIP_TYPES_ME) return 'sloop';
  let best = 'sloop', bd = Infinity;
  for (const k of Object.keys(SHIP_TYPES_ME)) {
    const s = SHIP_TYPES_ME[k];
    const d = Math.abs((spec.hullLen || 0) - s.hullLen) + Math.abs((spec.hullW || 0) - s.hullW) * 0.45;
    if (d < bd) {
      bd = d;
      best = k;
    }
  }
  return best;
}

function attachPirateFlagToShipME(g, spec, flagColor, flagPlace, mastRigForMastFlag) {
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x3d2e1a });
  const mH = spec.hullLen * shipClassMastHeightMulME(resolveShipVisualClassME(spec));
  const mastIdx = Math.max(0, spec.masts - 1);
  const mZ = (mastIdx - (spec.masts - 1) / 2) * (spec.hullLen * 0.3);
  const mastBaseY = spec.hullH * 0.6;
  const fc = document.createElement('canvas'); fc.width = 64; fc.height = 48;
  const ctx = fc.getContext('2d');
  ctx.fillStyle = flagColor || '#1a1a1a'; ctx.fillRect(0, 0, 64, 48);
  ctx.fillStyle = flagColor ? '#1a1008' : '#ddd'; ctx.font = 'bold 28px Georgia, serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('\u2620', 32, 26);
  const ftex = new THREE.CanvasTexture(fc);
  const flagRig = new THREE.Group();
  let poleH = spec.hullLen * 0.36;
  let hingeZ = 0.02;
  let parent = g;
  if (flagPlace === 'mast' && mastRigForMastFlag) {
    poleH = Math.max(0.48, spec.hullLen * 0.1);
    flagRig.position.set(0, mH, 0);
    parent = mastRigForMastFlag;
  } else if (flagPlace === 'mast') {
    poleH = Math.max(0.48, spec.hullLen * 0.1);
    flagRig.position.set(0, mastBaseY + mH, mZ);
  } else if (flagPlace === 'side') {
    flagRig.position.set(spec.hullW * 0.42, spec.hullH * 0.58, -spec.hullLen * 0.4);
  } else {
    poleH = spec.hullLen * 0.34;
    flagRig.position.set(spec.hullW * 0.36, spec.hullH * 0.68, -spec.hullLen * 0.5);
    hingeZ = 0.04;
  }
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.054, poleH, 6), poleMat);
  pole.position.y = poleH * 0.5;
  flagRig.add(pole);
  const flagHinge = new THREE.Group();
  flagHinge.position.set(0, poleH * 0.94, hingeZ);
  flagHinge.userData.isFlagHinge = true;
  const fmesh = new THREE.Mesh(new THREE.PlaneGeometry(1.12, 0.78),
    new THREE.MeshBasicMaterial({ map: ftex, side: THREE.DoubleSide }));
  fmesh.position.set(0.56, 0, 0);
  flagHinge.add(fmesh);
  flagRig.add(flagHinge);
  parent.add(flagRig);
}

export function buildShipMeshME(type, parts, flagColor, meshOpts) {
  meshOpts = meshOpts || {};
  parts = normalizeShipPartsME(parts);
  const flagPlace = parts.flag || 'mast';
  const isMerchantHull = !!meshOpts.merchantHull;
  const honorPlayerLoadout = !!meshOpts.honorPlayerLoadout;
  let cannonTier = parts.cannon;
  if (!isMerchantHull && !honorPlayerLoadout && (!cannonTier || cannonTier === 'none')) {
    cannonTier = 'light';
  }
  const g = new THREE.Group();
  const spec = SHIP_TYPES_ME[type] || SHIP_TYPES_ME.sloop;
  let hc = 0x6b3a1f;
  if (parts.hull === 'reinforced') hc = 0x4a4a4a;
  else if (parts.hull === 'darkwood') hc = 0x2a1a0a;

  const hw = spec.hullW / 2, hl = spec.hullLen / 2;
  const hullShape = buildShipHullPlanShapeME(type, hw, hl);
  const bm = Math.min(0.095, Math.max(0.06, Math.min(spec.hullW, spec.hullLen) * 0.016));
  const hull = new THREE.Mesh(
    new THREE.ExtrudeGeometry(hullShape, { depth: spec.hullH, bevelEnabled: true, bevelThickness: bm, bevelSize: bm * 0.94, bevelSegments: 2 }),
    new THREE.MeshPhongMaterial({ color: hc, shininess: type === 'warship' ? 14 : type === 'galleon' ? 18 : 20 })
  );
  hull.geometry.rotateX(-Math.PI / 2); hull.castShadow = true; hull.receiveShadow = true;
  hull.position.y = -spec.hullH * 0.3; g.add(hull);

  const dg = new THREE.PlaneGeometry(spec.hullW * 0.85, spec.hullLen * 0.9); dg.rotateX(-Math.PI / 2);
  const deck = new THREE.Mesh(dg, new THREE.MeshLambertMaterial({ color: 0xa0825a }));
  deck.position.y = spec.hullH * 0.65; deck.receiveShadow = true; g.add(deck);

  if (type === 'brigantine' || type === 'galleon' || type === 'warship') {
    const wMat = new THREE.MeshPhongMaterial({ color: 0x493324, shininess: 24 });
    for (let sgn = -1; sgn <= 1; sgn += 2) {
      const wale = new THREE.Mesh(new THREE.BoxGeometry(0.11, spec.hullH * 0.068, spec.hullLen * 0.875), wMat);
      wale.position.set(sgn * spec.hullW * 0.443, spec.hullH * 0.566, spec.hullLen * 0.015);
      wale.castShadow = true; g.add(wale);
    }
  }

  const rg = new THREE.BoxGeometry(0.085, Math.max(0.36, spec.hullH * 0.32), spec.hullLen * 0.82);
  const rm = new THREE.MeshLambertMaterial({ color: 0x5a3a1a });
  const rl = new THREE.Mesh(rg, rm); rl.position.set(-spec.hullW * 0.42, spec.hullH * 0.85, 0); g.add(rl);
  const rr = new THREE.Mesh(rg.clone(), rm); rr.position.set(spec.hullW * 0.42, spec.hullH * 0.85, 0); g.add(rr);

  const qDeckScale =
    type === 'cutter'
      ? { h: 0.52, len: 0.62, w: 0.82 }
      : type === 'sloop'
        ? { h: 0.78, len: 0.84, w: 0.92 }
        : { h: 1, len: 1, w: 1 };
  const qdH = spec.hullH * 0.55 * qDeckScale.h;
  const qdLen = spec.hullLen * 0.25 * qDeckScale.len;
  const qdMat = new THREE.MeshPhongMaterial({ color: 0x5a3010, shininess: 12 });
  const qDeck = new THREE.Mesh(new THREE.BoxGeometry(spec.hullW * 0.88 * qDeckScale.w, qdH, qdLen), qdMat);
  qDeck.position.set(0, spec.hullH * 0.65 + qdH / 2, -spec.hullLen * 0.38); qDeck.castShadow = true; g.add(qDeck);
  const qdFloor = new THREE.Mesh(new THREE.PlaneGeometry(spec.hullW * 0.8 * qDeckScale.w, qdLen * 0.9), new THREE.MeshLambertMaterial({ color: 0x8a6a40 }));
  qdFloor.rotation.x = -Math.PI / 2; qdFloor.position.set(0, spec.hullH * 0.65 + qdH + 0.02, -spec.hullLen * 0.38); g.add(qdFloor);
  for (let si = 0; si < 3; si++) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(spec.hullW * 0.4 * qDeckScale.w, 0.08, 0.2), new THREE.MeshLambertMaterial({ color: 0x6a4a28 }));
    step.position.set(0, spec.hullH * 0.65 + si * (qdH / 3), -spec.hullLen * 0.24 - si * 0.15); g.add(step);
  }
  const wheelPost = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.8, 6), rm);
  wheelPost.position.set(0, spec.hullH * 0.65 + qdH + 0.4, -spec.hullLen * 0.42); g.add(wheelPost);
  const wheelRim = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.03, 6, 12), new THREE.MeshPhongMaterial({ color: 0x5a3a1a, shininess: 30 }));
  wheelRim.position.set(0, spec.hullH * 0.65 + qdH + 0.8, -spec.hullLen * 0.42); wheelRim.rotation.x = Math.PI * 0.15; g.add(wheelRim);
  for (let sp = 0; sp < 8; sp++) {
    const spokeA = (sp / 8) * Math.PI * 2;
    const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.28, 3), new THREE.MeshLambertMaterial({ color: 0x5a3a1a }));
    spoke.position.set(Math.sin(spokeA) * 0.14, spec.hullH * 0.65 + qdH + 0.8, -spec.hullLen * 0.42 + Math.cos(spokeA) * 0.04);
    spoke.rotation.z = spokeA; g.add(spoke);
  }
  const sternWall = new THREE.Mesh(new THREE.BoxGeometry(spec.hullW * 0.88 * qDeckScale.w, spec.hullH * 0.5 + qdH, spec.hullLen * 0.06),
    new THREE.MeshPhongMaterial({ color: 0x4a2810, shininess: 10 }));
  sternWall.position.set(0, spec.hullH * 0.4 + qdH * 0.3, -spec.hullLen * 0.49); sternWall.castShadow = true; g.add(sternWall);

  let sc = 0xf5f0e0;
  if (parts.sail === 'silk') sc = 0xfff8e8;
  else if (parts.sail === 'war') sc = 0x2a2a2a;

  let lastMainMastRig = null;
  const mhMulME = shipClassMastHeightMulME(type);
  const mastRb = Math.max(0.055, Math.min(0.11, hw * 0.11));
  for (let m = 0; m < spec.masts; m++) {
    const mH = spec.hullLen * mhMulME, mZ = (m - (spec.masts - 1) / 2) * (spec.hullLen * 0.3);
    const mastRig = new THREE.Group();
    mastRig.position.set(0, spec.hullH * 0.6, mZ);
    mastRig.userData.isMastRig = true;
    mastRig.userData.mastLeanSign = m % 2 === 0 ? 1 : -1;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(mastRb * 0.92, mastRb + 0.036, mH, 6), rm);
    mast.userData.isMast = true;
    mast.userData.mastLeanSign = mastRig.userData.mastLeanSign;
    mast.position.set(0, mH / 2, 0);
    mast.castShadow = true;
    mastRig.add(mast);

    const sW = spec.hullW * 1.2, sH = mH * 0.55;
    const sailPivot = new THREE.Group();
    sailPivot.position.set(0, mH, 0);
    sailPivot.userData.isSailWindPivot = true;
    sailPivot.userData.windAngleScale = 1;

    const yg = new THREE.CylinderGeometry(0.04, 0.04, sW + 0.4, 4); yg.rotateZ(Math.PI / 2);
    const yard = new THREE.Mesh(yg, rm);
    yard.position.set(0, 0, 0);
    yard.userData.isYard = true;
    sailPivot.add(yard);

    const sg = new THREE.PlaneGeometry(sW, sH, 6, 6);
    const sail = new THREE.Mesh(sg, new THREE.MeshLambertMaterial({ color: sc, side: THREE.DoubleSide }));
    sail.position.set(0, -sH / 2, 0.08);
    sail.userData.isSail = true;
    sail.userData.windYawOnParent = true;
    sail.userData.basePositions = sg.attributes.position.array.slice();
    sail.userData.sailYardY = sH / 2;
    sail.userData.sailFootY = -sH / 2;
    sail.userData.sailHalfWidth = sW / 2;
    sail.castShadow = true;
    sailPivot.add(sail);
    mastRig.add(sailPivot);
    g.add(mastRig);
    lastMainMastRig = mastRig;
  }

  if (spec.bowStyle === 'blunt') {
    const bw = type === 'warship' ? 0.8 : 0.7;
    const bh = type === 'warship' ? 0.74 : 0.6;
    const bz = type === 'warship' ? 0.1 : 0.08;
    const bowGeo = new THREE.BoxGeometry(spec.hullW * bw, spec.hullH * bh, spec.hullLen * bz);
    const bow = new THREE.Mesh(bowGeo, new THREE.MeshPhongMaterial({ color: hc, shininess: 15 }));
    bow.position.set(0, spec.hullH * 0.24, spec.hullLen * 0.48); bow.castShadow = true; g.add(bow);
  }

  if (type === 'warship') {
    const qdb = new THREE.BoxGeometry(spec.hullW * 0.85, spec.hullH * 1.0, spec.hullLen * 0.22);
    const quarter = new THREE.Mesh(qdb, new THREE.MeshPhongMaterial({ color: 0x4a2a10, shininess: 15 }));
    quarter.position.set(0, spec.hullH * 0.7, -spec.hullLen * 0.35); quarter.castShadow = true; g.add(quarter);
    const wg = new THREE.CylinderGeometry(0.06, 0.06, spec.hullW * 0.6, 4); wg.rotateZ(Math.PI / 2);
    for (let wi = 0; wi < 3; wi++) {
      const win = new THREE.Mesh(wg, new THREE.MeshBasicMaterial({ color: 0x888844 }));
      win.position.set(0, spec.hullH * 0.3, -spec.hullLen * (0.1 + wi * 0.12)); g.add(win);
    }
    const fcME = new THREE.Mesh(
      new THREE.BoxGeometry(spec.hullW * 0.64, spec.hullH * 0.5, spec.hullLen * 0.14),
      new THREE.MeshPhongMaterial({ color: 0x4d3018, shininess: 12 })
    );
    fcME.position.set(0, spec.hullH * 0.74, spec.hullLen * 0.38);
    fcME.castShadow = true;
    g.add(fcME);
  }

  if (type === 'galleon' || type === 'warship') {
    const cb = new THREE.BoxGeometry(spec.hullW * 0.55, spec.hullH * 0.3, spec.hullLen * 0.08);
    const crows = new THREE.Mesh(cb, rm);
    crows.position.set(0, spec.hullH * 0.6 + spec.hullLen * 0.7 * 0.95, 0); g.add(crows);
  }

  if (type === 'galleon') {
    const galaME = new THREE.Mesh(
      new THREE.BoxGeometry(spec.hullW * 0.64, spec.hullH * 0.13, spec.hullLen * 0.21),
      new THREE.MeshPhongMaterial({ color: 0x3e2818, shininess: 28 })
    );
    galaME.position.set(0, spec.hullH * 0.4, -spec.hullLen * 0.46);
    galaME.castShadow = true;
    g.add(galaME);
  }

  if (cannonTier && cannonTier !== 'none') {
    let cc = spec.cannonSlots || 2;
    if (cc < 1) cc = 1;
    const visualCount = cc === 1 ? 2 : cc;
    const barrelScale = cc === 1 ? 0.88 : 1;
    const cg = new THREE.CylinderGeometry(0.1 * barrelScale, 0.15 * barrelScale, 1.15 * barrelScale, 6); cg.rotateZ(Math.PI / 2);
    const cm = new THREE.MeshPhongMaterial({ color: 0x333333, shininess: 60 });
    const gunAlongME = Math.max(1.48, spec.hullLen * 0.064);
    for (let c = 0; c < visualCount; c++) {
      const side = c % 2 === 0 ? 1 : -1, idx = Math.floor(c / 2);
      const cn = new THREE.Mesh(c === 0 ? cg : cg.clone(), cm);
      cn.position.set(side * spec.hullW * 0.5, spec.hullH * 0.6, (idx - Math.floor(visualCount / 4) + 0.5) * gunAlongME);
      cn.castShadow = true; g.add(cn);
    }
  }

  const fmHM =
    type === 'cutter' ? 0.41 : type === 'sloop' ? 0.43 : type === 'brigantine' ? 0.448 : type === 'galleon' ? 0.465 : 0.475;
  const fmH = spec.hullLen * fmHM;
  const foreRig = new THREE.Group();
  foreRig.position.set(0, spec.hullH * 0.5, spec.hullLen * 0.35);
  foreRig.userData.isMastRig = true;
  foreRig.userData.isForemastRig = true;
  foreRig.userData.mastLeanSign = -1;
  const foremast = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, fmH, 4), rm);
  foremast.userData.isMast = true;
  foremast.userData.mastLeanSign = -1;
  foremast.position.set(0, fmH / 2, 0);
  foremast.castShadow = true;
  foreRig.add(foremast);
  const jibPivot = new THREE.Group();
  jibPivot.position.set(0, fmH, 0);
  jibPivot.userData.isSailWindPivot = true;
  jibPivot.userData.windAngleScale = 0.88;
  const jibW = spec.hullW * 0.5, jibH = fmH * 0.5;
  const jibGeo = new THREE.PlaneGeometry(jibW, jibH, 3, 3);
  const jib = new THREE.Mesh(jibGeo, new THREE.MeshLambertMaterial({ color: sc, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
  jib.position.set(0, -jibH / 2, 0.08);
  jib.rotation.y = 0.22;
  jib.userData.isSail = true;
  jib.userData.isJib = true;
  jib.userData.windYawOnParent = true;
  jib.userData.basePositions = jibGeo.attributes.position.array.slice();
  jib.userData.sailYardY = jibH / 2;
  jib.userData.sailFootY = -jibH / 2;
  jib.userData.sailHalfWidth = jibW / 2;
  jibPivot.add(jib);
  foreRig.add(jibPivot);
  g.add(foreRig);
  const bowsprit = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, spec.hullLen * 0.35, 4), rm);
  bowsprit.position.set(0, spec.hullH * 0.35, spec.hullLen * 0.55);
  bowsprit.rotation.x = 0.45; g.add(bowsprit);

  if (parts.figurehead && parts.figurehead !== 'none') {
    const fg = new THREE.ConeGeometry(0.3, 1.2, 6); fg.rotateX(Math.PI * 0.3);
    const fh = new THREE.Mesh(fg, new THREE.MeshPhongMaterial({ color: 0xd4a848, shininess: 40 }));
    fh.position.set(0, spec.hullH * 0.3, spec.hullLen * 0.55); fh.castShadow = true; g.add(fh);
  }

  const mastForFlag = flagPlace === 'mast' ? (lastMainMastRig || null) : null;
  attachPirateFlagToShipME(g, spec, flagColor, flagPlace, mastForFlag);

  if (flagColor) {
    const fc = new THREE.Color(flagColor);
    g.traverse(ch => {
      if (ch.userData && ch.userData.isSail && ch.material && ch.material.color) {
        const b = ch.material.color.clone();
        b.lerp(fc, 0.2);
        ch.material.color.copy(b);
      }
    });
  }
  return g;
}

function pushOutOfCircleXZME(x, z, cx, cz, rInner, rOuter) {
  const dx = x - cx, dz = z - cz;
  const d = Math.hypot(dx, dz);
  if (d < rInner && d > 1e-5) {
    const push = (rOuter - d) / d;
    return { x: x + dx * push * 1.06, z: z + dz * push * 1.06 };
  }
  return { x, z };
}

function pushOutOfAabbXZME(x, z, minX, maxX, minZ, maxZ) {
  if (x < minX || x > maxX || z < minZ || z > maxZ) return { x, z };
  const dL = x - minX, dR = maxX - x, dF = z - minZ, dB = maxZ - z;
  const m = Math.min(dL, dR, dF, dB);
  if (m === dL) return { x: minX - 0.07, z };
  if (m === dR) return { x: maxX + 0.07, z };
  if (m === dF) return { x, z: minZ - 0.07 };
  return { x, z: maxZ + 0.07 };
}

function repelCrewFromMastsXZME(px, pz, spec, shipType) {
  const st = shipType || 'sloop';
  const hl = spec.hullLen;
  const hw = spec.hullW;
  let x = px;
  let z = pz;
  for (let m = 0; m < spec.masts; m++) {
    const mZ = (m - (spec.masts - 1) / 2) * (hl * 0.3);
    const p = pushOutOfCircleXZME(x, z, 0, mZ, 0.54, 0.64);
    x = p.x; z = p.z;
  }
  const pf = pushOutOfCircleXZME(x, z, 0, hl * 0.35, 0.38, 0.5);
  x = pf.x; z = pf.z;
  if (st === 'warship') {
    const pb = pushOutOfAabbXZME(x, z, -hw * 0.41, hw * 0.41, -hl * 0.45, -hl * 0.17);
    x = pb.x; z = pb.z;
  }
  if (st === 'galleon' || st === 'warship') {
    const pc = pushOutOfCircleXZME(x, z, 0, 0, 0.3, 0.44);
    x = pc.x; z = pc.z;
  }
  x = Math.max(-hw * 0.44, Math.min(hw * 0.44, x));
  z = Math.max(-hl * 0.48, Math.min(hl * 0.44, z));
  return { x, z };
}

export function buildCrewMeshesME(group, crewList, shipType) {
  for (let ci = group.children.length - 1; ci >= 0; ci--) {
    const ch = group.children[ci];
    if (ch.userData && ch.userData.isCrew) group.remove(ch);
  }
  const spec = SHIP_TYPES_ME[shipType] || SHIP_TYPES_ME.sloop;
  const sailors = crewList.filter(m => m.role !== 'prisoner');
  const brigIdx = { n: 0 };
  crewList.forEach((member, idx) => {
    const cg = new THREE.Group(); cg.userData.isCrew = true; cg.userData.crewIdx = idx;
    cg.userData.animKey = idx * 2.17 + (member.name || '').length * 0.31;
    const dcols = { captain: 0x8b0000, gunner: 0x4a4a4a, navigator: 0x2a2a6a, sailor: 0x2a4a6a, prisoner: 0x3a3a3a };
    const bc = member.role === 'prisoner'
      ? new THREE.Color(0x555555)
      : (member.color ? new THREE.Color(member.color) : new THREE.Color(dcols[member.role] || 0x2a4a6a));
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, member.outfit === 'coat' ? 0.5 : 0.4, 4, 5), new THREE.MeshLambertMaterial({ color: bc }));
    body.position.y = member.outfit === 'coat' ? 0.3 : 0.35;
    if (member.role === 'prisoner') body.scale.set(0.95, 0.92, 0.95);
    cg.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 6), new THREE.MeshLambertMaterial({ color: member.role === 'prisoner' ? 0xb8a090 : 0xd4a070 }));
    head.position.y = 0.7; cg.add(head);

    if (member.role === 'prisoner') {
      const chain = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.02, 6, 12), new THREE.MeshLambertMaterial({ color: 0x444444 }));
      chain.position.set(0, 0.45, 0.1); chain.rotation.x = Math.PI / 2; cg.add(chain);
    } else if (member.hat === 'tricorn') {
      const hatBrim = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.2, 0.04, 6), new THREE.MeshLambertMaterial({ color: 0x1a1008 }));
      hatBrim.position.y = 0.82; cg.add(hatBrim);
      const hatTop = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.1, 6), new THREE.MeshLambertMaterial({ color: 0x1a1008 }));
      hatTop.position.y = 0.88; cg.add(hatTop);
    } else if (member.hat === 'bandana') {
      const band = new THREE.Mesh(new THREE.SphereGeometry(0.13, 6, 4, 0, Math.PI * 2, 0, Math.PI * 0.5), new THREE.MeshLambertMaterial({ color: 0xcc2222 }));
      band.position.y = 0.72; cg.add(band);
    } else if (member.hat === 'captain') {
      const capHat = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 0.18), new THREE.MeshLambertMaterial({ color: 0x0a0a2a }));
      capHat.position.y = 0.86; cg.add(capHat);
      const goldBand = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.03, 0.12), new THREE.MeshLambertMaterial({ color: 0xd4a848 }));
      goldBand.position.y = 0.83; cg.add(goldBand);
    } else if (member.hat === 'hood') {
      const hood = new THREE.Mesh(new THREE.SphereGeometry(0.15, 6, 6), new THREE.MeshLambertMaterial({ color: 0x3a3a3a }));
      hood.position.y = 0.73; hood.scale.set(1, 0.8, 1.1); cg.add(hood);
    }

    if (member.parrot) {
      const pBody = new THREE.Mesh(new THREE.SphereGeometry(0.06, 5, 5), new THREE.MeshLambertMaterial({ color: 0x22aa22 }));
      pBody.position.set(0.2, 0.65, 0); cg.add(pBody);
      const pHead = new THREE.Mesh(new THREE.SphereGeometry(0.04, 4, 4), new THREE.MeshLambertMaterial({ color: 0xff3333 }));
      pHead.position.set(0.2, 0.72, 0); cg.add(pHead);
      const beak = new THREE.Mesh(new THREE.ConeGeometry(0.015, 0.04, 3), new THREE.MeshLambertMaterial({ color: 0xffaa00 }));
      beak.position.set(0.24, 0.72, 0); beak.rotation.z = -Math.PI / 2; cg.add(beak);
    }
    let px, pz, py;
    const qdH = spec.hullH * 0.55;
    const deckY = spec.hullH * 0.65;
    if (member.role === 'prisoner') {
      const pi = brigIdx.n++;
      px = (pi % 4 - 1.5) * spec.hullW * 0.2;
      pz = spec.hullLen * 0.36;
      py = deckY;
    } else if (member.task === 'helm') { px = 0; pz = -spec.hullLen * 0.46; py = deckY + qdH + 0.05; }
    else if (member.task === 'sails') {
      const si = sailors.indexOf(member);
      px = spec.hullW * 0.12 + (si % 2) * 0.08; pz = spec.hullLen * 0.05 + (si * 0.15) % 1.2; py = deckY;
    } else if (member.task === 'cannons') {
      const si = sailors.indexOf(member);
      px = (si % 2 === 0 ? 1 : -1) * spec.hullW * 0.38; pz = -spec.hullLen * 0.05 + (si * 0.9) % (spec.hullLen * 0.5); py = deckY;
    } else if (member.task === 'lookout') { px = 0; pz = spec.hullLen * 0.35; py = deckY + 0.1; }
    else if (member.task === 'clean') {
      const si = sailors.indexOf(member);
      px = (si % 2 === 0 ? -1 : 1) * spec.hullW * 0.26;
      pz = -spec.hullLen * 0.08 + (si % 4) * 0.45;
      py = deckY;
    } else { px = (Math.random() - 0.5) * spec.hullW * 0.5; pz = (Math.random() - 0.5) * spec.hullLen * 0.4; py = deckY; }
    const rp0 = repelCrewFromMastsXZME(px, pz, spec, shipType);
    px = rp0.x;
    pz = rp0.z;
    cg.position.set(px, py, pz);
    cg.userData.basePos = { x: px, y: py, z: pz };
    cg.userData.crewSm = { x: px, y: py, z: pz, ry: 0 };
    cg.userData.wanderTimer = Math.random() * 5;
    group.add(cg);
  });
}
