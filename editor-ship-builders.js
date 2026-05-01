/**
 * Ship mesh + crew placement for map-editor preview (mirrors index.html builders).
 */
import * as THREE from 'three';

export const SHIP_TYPES_ME = {
  cutter: { name: 'Cutter', desc: 'Shallow-draft Navy scout — razor bow, single pole mast', hullLen: 7.5, hullW: 2.35, hullH: 1.42, masts: 1, cannonSlots: 1, bowStyle: 'pointed' },
  sloop: { name: 'Sloop', desc: 'Lean privateer hull — low freeboard, raked mast & long jib', hullLen: 10.5, hullW: 3.35, hullH: 1.92, masts: 1, cannonSlots: 2, bowStyle: 'pointed' },
  brigantine: { name: 'Brigantine', desc: 'Two-mast cargo clipper — wide waist, square driver & fore course', hullLen: 15, hullW: 4.85, hullH: 2.55, masts: 2, cannonSlots: 4, bowStyle: 'wide' },
  galleon: { name: 'Galleon', desc: 'High-castled trade galleon — bluff bow, capacious hold & galleries', hullLen: 21, hullW: 6.9, hullH: 3.45, masts: 3, cannonSlots: 6, bowStyle: 'wide' },
  warship: { name: 'Man-o-War', desc: 'Two-decker line ship — tumblehome sides, castles & fighting tops', hullLen: 27, hullW: 8.35, hullH: 4.08, masts: 3, cannonSlots: 10, bowStyle: 'blunt' }
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

function attachPirateFlagToShipME(g, spec, flagColor, flagPlace, mastRigForMastFlag) {
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x3d2e1a });
  const mH = spec.hullLen * 0.7;
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

/** Same plan-view outlines as `index.html` ship builder (editor preview). */
function buildShipHullExtrudeShape(spec, type) {
  const hw = spec.hullW * 0.5;
  const hl = spec.hullLen * 0.5;
  const shape = new THREE.Shape();
  const stemN =
    type === 'cutter' ? 0.06 : type === 'sloop' ? 0.07 : type === 'brigantine' ? 0.1 : type === 'galleon' ? 0.12 : 0.16;
  const stem = hw * stemN;

  if (type === 'cutter') {
    shape.moveTo(-hw * 0.78, -hl);
    shape.lineTo(-hw * 0.95, -hl * 0.42);
    shape.lineTo(-hw * 0.72, hl * 0.2);
    shape.lineTo(-hw * 0.36, hl * 0.96);
    shape.lineTo(-stem, hl * 1.02);
    shape.lineTo(stem, hl * 1.02);
    shape.lineTo(hw * 0.36, hl * 0.96);
    shape.lineTo(hw * 0.72, hl * 0.2);
    shape.lineTo(hw * 0.95, -hl * 0.42);
    shape.lineTo(hw * 0.78, -hl);
  } else if (type === 'sloop') {
    shape.moveTo(-hw * 0.87, -hl);
    shape.lineTo(-hw * 1.06, -hl * 0.32);
    shape.lineTo(-hw * 0.94, hl * 0.4);
    shape.lineTo(-hw * 0.56, hl * 0.93);
    shape.lineTo(-stem, hl * 1.0);
    shape.lineTo(stem, hl * 1.0);
    shape.lineTo(hw * 0.56, hl * 0.93);
    shape.lineTo(hw * 0.94, hl * 0.4);
    shape.lineTo(hw * 1.06, -hl * 0.32);
    shape.lineTo(hw * 0.87, -hl);
  } else if (type === 'brigantine') {
    shape.moveTo(-hw * 0.9, -hl);
    shape.lineTo(-hw * 1.08, -hl * 0.26);
    shape.lineTo(-hw * 1.04, hl * 0.08);
    shape.lineTo(-hw * 0.64, hl * 0.88);
    shape.lineTo(-stem * 1.35, hl * 0.98);
    shape.lineTo(stem * 1.35, hl * 0.98);
    shape.lineTo(hw * 0.64, hl * 0.88);
    shape.lineTo(hw * 1.04, hl * 0.08);
    shape.lineTo(hw * 1.08, -hl * 0.26);
    shape.lineTo(hw * 0.9, -hl);
  } else if (type === 'galleon') {
    shape.moveTo(-hw * 0.86, -hl);
    shape.lineTo(-hw * 1.04, -hl * 0.36);
    shape.lineTo(-hw * 1.02, hl * 0.44);
    shape.lineTo(-hw * 0.6, hl * 0.8);
    shape.lineTo(-stem * 1.55, hl * 0.94);
    shape.lineTo(stem * 1.55, hl * 0.94);
    shape.lineTo(hw * 0.6, hl * 0.8);
    shape.lineTo(hw * 1.02, hl * 0.44);
    shape.lineTo(hw * 1.04, -hl * 0.36);
    shape.lineTo(hw * 0.86, -hl);
  } else if (type === 'warship') {
    shape.moveTo(-hw * 0.9, -hl);
    shape.lineTo(-hw * 1.01, -hl * 0.18);
    shape.lineTo(-hw * 0.98, hl * 0.14);
    shape.lineTo(-hw * 0.76, hl * 0.66);
    shape.lineTo(-stem * 2.05, hl * 0.78);
    shape.lineTo(stem * 2.05, hl * 0.78);
    shape.lineTo(hw * 0.76, hl * 0.66);
    shape.lineTo(hw * 0.98, hl * 0.14);
    shape.lineTo(hw * 1.01, -hl * 0.18);
    shape.lineTo(hw * 0.9, -hl);
  } else {
    shape.moveTo(-hw * 0.87, -hl);
    shape.lineTo(-hw * 1.06, -hl * 0.32);
    shape.lineTo(-hw * 0.94, hl * 0.4);
    shape.lineTo(-hw * 0.56, hl * 0.93);
    shape.lineTo(-stem, hl * 1.0);
    shape.lineTo(stem, hl * 1.0);
    shape.lineTo(hw * 0.56, hl * 0.93);
    shape.lineTo(hw * 0.94, hl * 0.4);
    shape.lineTo(hw * 1.06, -hl * 0.32);
    shape.lineTo(hw * 0.87, -hl);
  }
  shape.lineTo(0, -hl * (type === 'galleon' ? 0.96 : type === 'warship' ? 0.94 : 1.02));
  shape.closePath();
  return shape;
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

  const rgScale = Math.min(1.62, Math.max(0.88, spec.hullW / 2.35));
  const hullShape = buildShipHullExtrudeShape(spec, type);
  const bev = Math.min(0.22, Math.max(0.075, spec.hullW * 0.036));
  const hullMat = new THREE.MeshStandardMaterial({ color: hc, roughness: 0.54, metalness: 0.09 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x4a3520, roughness: 0.72, metalness: 0.04 });
  const deckMat = new THREE.MeshStandardMaterial({ color: 0xb08d68, roughness: 0.76, metalness: 0.03 });
  const rm = new THREE.MeshLambertMaterial({ color: 0x5a3a1a });

  const hull = new THREE.Mesh(
    new THREE.ExtrudeGeometry(hullShape, {
      depth: spec.hullH,
      bevelEnabled: true,
      bevelThickness: bev * 0.5,
      bevelSize: bev * 0.5,
      bevelSegments: 2
    }),
    hullMat
  );
  hull.geometry.rotateX(-Math.PI / 2);
  hull.castShadow = true;
  hull.receiveShadow = true;
  hull.position.y = -spec.hullH * 0.3;
  g.add(hull);

  const dg = new THREE.PlaneGeometry(spec.hullW * 0.86, spec.hullLen * 0.9);
  dg.rotateX(-Math.PI / 2);
  const deck = new THREE.Mesh(dg, deckMat);
  deck.position.y = spec.hullH * 0.65;
  deck.receiveShadow = true;
  g.add(deck);

  if (type === 'sloop' || type === 'brigantine') {
    const forecastle = new THREE.Mesh(
      new THREE.BoxGeometry(spec.hullW * 0.66, spec.hullH * (type === 'sloop' ? 0.2 : 0.26), spec.hullLen * 0.14),
      hullMat.clone()
    );
    forecastle.position.set(0, spec.hullH * 0.72, spec.hullLen * 0.34);
    forecastle.castShadow = true;
    g.add(forecastle);
  }

  if (type === 'galleon') {
    const poop = new THREE.Mesh(
      new THREE.BoxGeometry(spec.hullW * 0.58, spec.hullH * 0.38, spec.hullLen * 0.1),
      trimMat
    );
    poop.position.set(0, spec.hullH * 0.78, -spec.hullLen * 0.44);
    poop.castShadow = true;
    g.add(poop);
  }

  const rg = new THREE.BoxGeometry(0.09 * rgScale, 0.42 * rgScale, spec.hullLen * 0.8);
  const rl = new THREE.Mesh(rg, rm);
  rl.position.set(-spec.hullW * 0.42, spec.hullH * 0.86, 0);
  g.add(rl);
  const rr = new THREE.Mesh(rg.clone(), rm);
  rr.position.set(spec.hullW * 0.42, spec.hullH * 0.86, 0);
  g.add(rr);

  const qdH = spec.hullH * 0.55, qdLen = spec.hullLen * 0.25;
  const qdMat = new THREE.MeshStandardMaterial({ color: 0x5a3010, roughness: 0.5, metalness: 0.06 });
  const qDeck = new THREE.Mesh(new THREE.BoxGeometry(spec.hullW * 0.88, qdH, qdLen), qdMat);
  qDeck.position.set(0, spec.hullH * 0.65 + qdH / 2, -spec.hullLen * 0.38);
  qDeck.castShadow = true;
  g.add(qDeck);
  const qdFloor = new THREE.Mesh(new THREE.PlaneGeometry(spec.hullW * 0.8, qdLen * 0.9), deckMat);
  qdFloor.rotation.x = -Math.PI / 2;
  qdFloor.position.set(0, spec.hullH * 0.65 + qdH + 0.02, -spec.hullLen * 0.38);
  g.add(qdFloor);
  for (let si = 0; si < 3; si++) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(spec.hullW * 0.4, 0.08 * rgScale, 0.2 * rgScale), new THREE.MeshLambertMaterial({ color: 0x6a4a28 }));
    step.position.set(0, spec.hullH * 0.65 + si * (qdH / 3), -spec.hullLen * 0.24 - si * 0.15);
    g.add(step);
  }
  const wheelPost = new THREE.Mesh(new THREE.CylinderGeometry(0.05 * rgScale, 0.05 * rgScale, 0.72 * rgScale, 8), rm);
  wheelPost.position.set(0, spec.hullH * 0.65 + qdH + 0.36 * rgScale, -spec.hullLen * 0.42);
  g.add(wheelPost);
  const wheelRim = new THREE.Mesh(
    new THREE.TorusGeometry(0.28 * rgScale, 0.028 * rgScale, 8, 18),
    new THREE.MeshStandardMaterial({ color: 0x5a3a1a, roughness: 0.45, metalness: 0.2 })
  );
  wheelRim.position.set(0, spec.hullH * 0.65 + qdH + 0.72 * rgScale, -spec.hullLen * 0.42);
  wheelRim.rotation.x = Math.PI * 0.15;
  g.add(wheelRim);
  for (let sp = 0; sp < 8; sp++) {
    const spokeA = (sp / 8) * Math.PI * 2;
    const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.017 * rgScale, 0.017 * rgScale, 0.26 * rgScale, 4), rm);
    spoke.position.set(
      Math.sin(spokeA) * 0.14 * rgScale,
      spec.hullH * 0.65 + qdH + 0.72 * rgScale,
      -spec.hullLen * 0.42 + Math.cos(spokeA) * 0.036 * rgScale
    );
    spoke.rotation.z = spokeA;
    g.add(spoke);
  }
  const sternWall = new THREE.Mesh(
    new THREE.BoxGeometry(spec.hullW * 0.88, spec.hullH * 0.5 + qdH, spec.hullLen * 0.06),
    new THREE.MeshStandardMaterial({ color: 0x4a2810, roughness: 0.52, metalness: 0.05 })
  );
  sternWall.position.set(0, spec.hullH * 0.4 + qdH * 0.3, -spec.hullLen * 0.49);
  sternWall.castShadow = true;
  g.add(sternWall);

  if (type === 'galleon' || type === 'warship') {
    const lamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.1 * rgScale, 10, 10),
      new THREE.MeshStandardMaterial({ color: 0xffcc88, emissive: 0x331800, emissiveIntensity: 0.35, roughness: 0.35, metalness: 0.1 })
    );
    lamp.position.set(0, spec.hullH * 0.55 + qdH + 0.15 * rgScale, -spec.hullLen * 0.52);
    g.add(lamp);
  }

  let sc = 0xf5f0e0;
  if (parts.sail === 'silk') sc = 0xfff8e8;
  else if (parts.sail === 'war') sc = 0x2a2a2a;

  let lastMainMastRig = null;
  const gunRowZ = 1.75 * (spec.hullLen / 14);
  for (let m = 0; m < spec.masts; m++) {
    const mH = spec.hullLen * (type === 'cutter' ? 0.78 : 0.7),
      mZ = (m - (spec.masts - 1) / 2) * (spec.hullLen * 0.3);
    const mastRig = new THREE.Group();
    mastRig.position.set(0, spec.hullH * 0.6, mZ);
    mastRig.userData.isMastRig = true;
    mastRig.userData.mastLeanSign = m % 2 === 0 ? 1 : -1;
    const mastRadTop = 0.07 * rgScale;
    const mastRadDeck = 0.11 * rgScale;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(mastRadTop, mastRadDeck, mH, type === 'warship' ? 8 : 6), rm);
    mast.userData.isMast = true;
    mast.userData.mastLeanSign = mastRig.userData.mastLeanSign;
    mast.position.set(0, mH / 2, 0);
    mast.castShadow = true;
    mastRig.add(mast);

    const sW = spec.hullW * (type === 'brigantine' && m === 0 ? 1.32 : type === 'galleon' || type === 'warship' ? 1.15 : 1.2),
      sH = mH * (type === 'cutter' ? 0.62 : type === 'warship' ? 0.48 : 0.55);
    const sailPivot = new THREE.Group();
    sailPivot.position.set(0, mH, 0);
    sailPivot.userData.isSailWindPivot = true;
    sailPivot.userData.windAngleScale = 1;

    const yRad = (0.038 + (type === 'galleon' || type === 'warship' ? 0.012 : 0)) * rgScale;
    const yg = new THREE.CylinderGeometry(yRad, yRad, sW + 0.4 * rgScale, 6);
    yg.rotateZ(Math.PI / 2);
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
    const bowGeo = new THREE.BoxGeometry(spec.hullW * 0.72, spec.hullH * 0.64, spec.hullLen * 0.09);
    const bow = new THREE.Mesh(bowGeo, hullMat);
    bow.position.set(0, spec.hullH * 0.22, spec.hullLen * 0.48);
    bow.castShadow = true;
    g.add(bow);
  }

  if (type === 'warship') {
    const qdb = new THREE.BoxGeometry(spec.hullW * 0.85, spec.hullH * 1.0, spec.hullLen * 0.22);
    const quarter = new THREE.Mesh(qdb, new THREE.MeshStandardMaterial({ color: 0x4a2a10, roughness: 0.48, metalness: 0.08 }));
    quarter.position.set(0, spec.hullH * 0.7, -spec.hullLen * 0.35);
    quarter.castShadow = true;
    g.add(quarter);
    const wg = new THREE.CylinderGeometry(0.06 * rgScale, 0.06 * rgScale, spec.hullW * 0.6, 4);
    wg.rotateZ(Math.PI / 2);
    for (let wi = 0; wi < 3; wi++) {
      const win = new THREE.Mesh(wg, new THREE.MeshBasicMaterial({ color: 0x888844 }));
      win.position.set(0, spec.hullH * 0.3, -spec.hullLen * (0.1 + wi * 0.12));
      g.add(win);
    }
  }

  if (type === 'galleon' || type === 'warship') {
    const cb = new THREE.BoxGeometry(spec.hullW * 0.55, spec.hullH * 0.3, spec.hullLen * 0.08);
    const crows = new THREE.Mesh(cb, rm);
    crows.position.set(0, spec.hullH * 0.6 + spec.hullLen * 0.7 * 0.95, 0);
    g.add(crows);
  }

  if (cannonTier && cannonTier !== 'none') {
    let cc = spec.cannonSlots || 2;
    if (cc < 1) cc = 1;
    const visualCount = cc === 1 ? 2 : cc;
    const barrelScale = cc === 1 ? 0.88 : 1;
    const cg = new THREE.CylinderGeometry(0.1 * barrelScale, 0.15 * barrelScale, 1.15 * barrelScale, 6); cg.rotateZ(Math.PI / 2);
    const cm = new THREE.MeshPhongMaterial({ color: 0x333333, shininess: 60 });
    for (let c = 0; c < visualCount; c++) {
      const side = c % 2 === 0 ? 1 : -1, idx = Math.floor(c / 2);
      const cn = new THREE.Mesh(c === 0 ? cg : cg.clone(), cm);
      cn.position.set(side * spec.hullW * 0.5, spec.hullH * 0.6, (idx - Math.floor(visualCount / 4) + 0.5) * gunRowZ);
      cn.castShadow = true; g.add(cn);
    }
  }

  const fmH = spec.hullLen * 0.45;
  const foreRig = new THREE.Group();
  foreRig.position.set(0, spec.hullH * 0.5, spec.hullLen * 0.35);
  foreRig.userData.isMastRig = true;
  foreRig.userData.isForemastRig = true;
  foreRig.userData.mastLeanSign = -1;
  const foremast = new THREE.Mesh(new THREE.CylinderGeometry(0.04 * rgScale, 0.06 * rgScale, fmH, 5), rm);
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
  const bowsprit = new THREE.Mesh(new THREE.CylinderGeometry(0.03 * rgScale, 0.05 * rgScale, spec.hullLen * 0.35, 5), rm);
  bowsprit.position.set(0, spec.hullH * 0.35, spec.hullLen * 0.55);
  bowsprit.rotation.x = 0.45; g.add(bowsprit);

  if (parts.figurehead && parts.figurehead !== 'none') {
    const fg = new THREE.ConeGeometry(0.34 * rgScale, 1.25 * rgScale, 7);
    fg.rotateX(Math.PI * 0.3);
    const fh = new THREE.Mesh(fg, new THREE.MeshStandardMaterial({ color: 0xd4a848, roughness: 0.35, metalness: 0.25 }));
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
