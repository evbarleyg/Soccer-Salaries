// 3D racing ducks built from primitives: ellipsoid body, chest, tail wedge,
// sphere head, two-part beak, eyes with highlights, flapping wing ellipsoids,
// paddling feet, saddle towel with a number roundel on each flank, and a hat.
// Local space: +Z forward, +Y up, +X = the duck's left. Waterline at y ≈ 0.
import * as THREE from 'three';
import { buildHat } from './hats3d.js';
import { mergeMeshes } from './builders.js';

const bodyGeo = new THREE.SphereGeometry(1, 22, 16);
const headGeo = new THREE.SphereGeometry(1, 20, 14);
const eyeGeo = new THREE.SphereGeometry(0.06, 10, 8);
const glintGeo = new THREE.SphereGeometry(0.02, 6, 4);
const wingGeo = new THREE.SphereGeometry(1, 16, 10);
const tailGeo = new THREE.ConeGeometry(0.28, 0.55, 4);
const beakTopGeo = new THREE.CylinderGeometry(0.05, 0.15, 0.36, 12);
const beakBotGeo = new THREE.CylinderGeometry(0.04, 0.13, 0.3, 12);
const footGeo = new THREE.BoxGeometry(0.2, 0.04, 0.28);
const cheekGeo = new THREE.CircleGeometry(0.07, 12);
const towelGeo = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true, Math.PI * 0.94, Math.PI * 1.12); // draped over the back
const roundelGeo = new THREE.CircleGeometry(0.17, 20);
const ringGeo = new THREE.TorusGeometry(0.6, 0.14, 10, 30);
const shadowGeo = new THREE.CircleGeometry(0.9, 20);

const blackMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.35 });
const whiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
const cheekMat = new THREE.MeshBasicMaterial({ color: 0xff7a9a, transparent: true, opacity: 0.55, depthWrite: false });
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x0a2030, transparent: true, opacity: 0.28, depthWrite: false });

const roundelCache = new Map();
function roundelTexture(number, towel) {
  const key = `${number}|${towel.bg}|${towel.text}`;
  if (roundelCache.has(key)) return roundelCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(64, 64, 62, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 6;
  g.strokeStyle = towel.bg;
  g.stroke();
  g.fillStyle = '#161616';
  g.font = `900 ${String(number).length > 1 ? 66 : 80}px system-ui, -apple-system, Segoe UI, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(number), 64, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  roundelCache.set(key, tex);
  return tex;
}

function std(color, o = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0, ...o });
}

/**
 * Build a duck for `look` (from assignLooks). Returns { group, pivot, body,
 * head, wings, feet, hat, shadow, mats } — `pivot` is what the animator rolls,
 * pitches and squashes; `group` is placed on the water by the renderer.
 */
export function buildDuck(look) {
  const pal = look.palette;
  const metallic = !!pal.metallic;
  const mats = {
    body: std(pal.body, metallic ? { metalness: 0.55, roughness: 0.32 } : {}),
    light: std(pal.light || pal.body),
    head: std(pal.head || pal.body, metallic ? { metalness: 0.55, roughness: 0.32 } : {}),
    wing: std(pal.wing),
    wingShade: std(pal.wingShade || pal.wing),
    beak: std(pal.beak, { roughness: 0.45 }),
    beakShade: std(pal.beakShade || pal.beak, { roughness: 0.45 }),
    eye: pal.eye && pal.eye !== '#1B1B1B' && pal.eye !== '#111' ? std(pal.eye, { roughness: 0.3 }) : blackMat,
    towel: std(look.towel.bg, { roughness: 0.85 }),
    ring: pal.ring ? std(pal.ring) : null,
    accent: pal.accent ? std(pal.accent) : null,
  };

  const group = new THREE.Group();
  group.name = `duck-${look.number}`;
  const pivot = new THREE.Group(); // roll/pitch/squash happen here, about the waterline
  group.add(pivot);
  const s = look.scale || 1;
  pivot.scale.setScalar(s);

  // body
  const body = new THREE.Mesh(bodyGeo, mats.body);
  body.scale.set(0.5, 0.4, 0.72);
  body.position.set(0, 0.3, 0);
  pivot.add(body);
  // lighter chest/belly bulge
  const chest = new THREE.Mesh(bodyGeo, mats.light);
  chest.scale.set(0.4, 0.3, 0.42);
  chest.position.set(0, 0.22, 0.36);
  pivot.add(chest);
  // mallard-style speculum flash on the flanks
  if (mats.accent) {
    for (const side of [-1, 1]) {
      const flash = new THREE.Mesh(bodyGeo, mats.accent);
      flash.scale.set(0.06, 0.09, 0.2);
      flash.position.set(side * 0.47, 0.33, -0.28);
      pivot.add(flash);
    }
  }
  // tail wedge, perky
  const tail = new THREE.Mesh(tailGeo, mats.body);
  tail.position.set(0, 0.5, -0.68);
  tail.rotation.set(-2.2, Math.PI / 4, 0);
  tail.scale.set(1, 1, 0.55);
  pivot.add(tail);

  // towel-coloured rubber ring at the waterline: the duck's ID colour, readable from any camera
  const ring = new THREE.Mesh(ringGeo, mats.towel);
  ring.rotation.x = Math.PI / 2;
  ring.position.set(0, 0.07, 0.02);
  ring.scale.set(1, 1.18, 1);
  pivot.add(ring);
  // saddle towel + roundels
  const towel = new THREE.Mesh(towelGeo, mats.towel);
  towel.rotation.x = Math.PI / 2;
  towel.scale.set(0.515, 0.5, 0.415);
  towel.position.set(0, 0.305, -0.06);
  pivot.add(towel);
  const roundelMat = new THREE.MeshBasicMaterial({ map: roundelTexture(look.number, look.towel), transparent: true });
  for (const side of [-1, 1]) {
    const r = new THREE.Mesh(roundelGeo, roundelMat);
    r.position.set(side * 0.505, 0.36, -0.06);
    r.rotation.y = side * Math.PI / 2;
    r.rotation.z = 0;
    // tilt to hug the flank
    r.rotateX(-0.18 * 0);
    pivot.add(r);
  }

  // neck ring (mallard)
  if (mats.ring) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.035, 8, 20), mats.ring);
    ring.position.set(0, 0.72, 0.4);
    ring.rotation.x = Math.PI / 2 - 0.5;
    pivot.add(ring);
  }

  // head group (head pump animates this)
  const head = new THREE.Group();
  head.position.set(0, 0.9, 0.45);
  pivot.add(head);
  const skull = new THREE.Mesh(headGeo, mats.head);
  skull.scale.set(0.3, 0.3, 0.31);
  head.add(skull);
  // beak: upper + lower mandible
  const beakTop = new THREE.Mesh(beakTopGeo, mats.beak);
  beakTop.rotation.x = Math.PI / 2;
  beakTop.scale.set(1.25, 1, 0.42);
  beakTop.position.set(0, -0.03, 0.38);
  head.add(beakTop);
  const beakBot = new THREE.Mesh(beakBotGeo, mats.beakShade);
  beakBot.rotation.x = Math.PI / 2 + 0.12;
  beakBot.scale.set(1.1, 1, 0.3);
  beakBot.position.set(0, -0.09, 0.33);
  head.add(beakBot);
  // eyes + highlights
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeo, mats.eye);
    eye.position.set(side * 0.2, 0.07, 0.2);
    eye.scale.set(1, 1.15, 1);
    head.add(eye);
    const glint = new THREE.Mesh(glintGeo, whiteMat);
    glint.position.set(side * 0.245, 0.1, 0.225);
    head.add(glint);
    if (look.cheeks) {
      const cheek = new THREE.Mesh(cheekGeo, cheekMat);
      cheek.position.set(side * 0.27, -0.06, 0.15);
      cheek.rotation.y = side * 1.2;
      head.add(cheek);
    }
  }
  // hat
  const hat = buildHat(look.hat);
  head.add(hat);

  // wings (pivot at the shoulder so they can lift and flap)
  const wings = [];
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.44, 0.46, 0.12);
    const wing = new THREE.Mesh(wingGeo, mats.wing);
    wing.scale.set(0.1, 0.24, 0.46);
    wing.position.set(side * 0.04, -0.08, -0.3);
    shoulder.add(wing);
    const tip = new THREE.Mesh(wingGeo, mats.wingShade);
    tip.scale.set(0.07, 0.15, 0.25);
    tip.position.set(side * 0.06, -0.13, -0.6);
    shoulder.add(tip);
    shoulder.userData.side = side;
    pivot.add(shoulder);
    wings.push(shoulder);
  }

  // feet (visible when airborne / paddling splashes)
  const feet = [];
  for (const side of [-1, 1]) {
    const foot = new THREE.Mesh(footGeo, mats.beak);
    foot.position.set(side * 0.2, -0.06, -0.1);
    pivot.add(foot);
    feet.push(foot);
  }

  // blob shadow on the water (stays level, placed by the animator)
  const shadow = new THREE.Mesh(shadowGeo, shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.scale.set(0.75, 1.05, 1);
  shadow.renderOrder = 2;
  group.add(shadow);
  shadow.position.y = 0.06;

  // ---- collapse into a handful of draw calls (body statics, head, hat, each wing, roundels)
  const statics = [body, chest, towel, ring];
  pivot.children.filter((o) => o.isMesh && (o.material === mats.accent || o.material === mats.ring)).forEach((o) => statics.push(o));
  const bodyMerged = mergeMeshes(pivot, statics);
  const roundels = pivot.children.filter((o) => o.isMesh && o.material === roundelMat);
  mergeMeshes(pivot, roundels);
  const headStatics = head.children.filter((o) => o.isMesh && !o.material.transparent);
  const headMerged = mergeMeshes(head, headStatics, { roughness: 0.45 });
  const hatMeshes = [];
  hat.traverse((o) => {
    if (!o.isMesh || o.material.transparent) return;
    let p = o.parent;
    while (p && p !== hat) { if (p === hat.userData.spin) return; p = p.parent; }
    hatMeshes.push(o);
  });
  const hatMerged = mergeMeshes(hat, hatMeshes, { roughness: 0.6 });
  const wingMerged = wings.map((w) => mergeMeshes(w, w.children.filter((o) => o.isMesh))).flat();
  const glowMats = [...bodyMerged, ...headMerged, ...wingMerged].map((m) => m.material);

  group.traverse((o) => {
    if (o.isMesh) o.frustumCulled = true;
  });
  const shared = new Set([bodyGeo, headGeo, eyeGeo, glintGeo, wingGeo, tailGeo, beakTopGeo, beakBotGeo, footGeo, cheekGeo, towelGeo, roundelGeo, ringGeo, shadowGeo, blackMat, whiteMat, cheekMat, shadowMat, roundelMat.map]);
  return { group, pivot, body: bodyMerged[0] || body, head, wings, feet, hat, shadow, tail, mats, glowMats, look, shared };
}

/** Small canvas name tag sprite shown above a duck. */
export function makeNameTag(name, towel, number) {
  const label = name.length > 18 ? name.slice(0, 17) + '…' : name;
  const font = '700 30px system-ui, -apple-system, Segoe UI, sans-serif';
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = font;
  const textW = Math.ceil(probe.measureText(label).width);
  const w = Math.min(480, textW + 62);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(12,22,34,0.8)';
  roundRect(g, 1, 8, w - 2, 48, 24);
  g.fill();
  // number roundel in the towel colours
  g.fillStyle = towel.bg;
  g.beginPath();
  g.arc(26, 32, 15, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 2.5;
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.stroke();
  g.fillStyle = towel.text;
  g.font = '900 17px system-ui, -apple-system, Segoe UI, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(number ?? ''), 26, 33);
  g.fillStyle = '#fff';
  g.font = font;
  g.textAlign = 'left';
  g.fillText(label, 48, 34, w - 56);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: true, fog: false });
  const sprite = new THREE.Sprite(mat);
  sprite.userData.aspect = w / 64;
  sprite.scale.set(0.65 * sprite.userData.aspect, 0.65, 1);
  sprite.renderOrder = 10;
  return sprite;
}

/** "YOU" chevron marker shown over the duck the camera follows. */
export function makeYouMarker() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, fog: false });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 12;
  sprite.userData.paint = (towel, text = 'YOU') => {
    const g = c.getContext('2d');
    g.clearRect(0, 0, 128, 128);
    g.fillStyle = 'rgba(12,22,34,0.85)';
    roundRect(g, 14, 6, 100, 46, 14);
    g.fill();
    g.fillStyle = '#fff';
    g.font = '900 30px system-ui, -apple-system, Segoe UI, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 64, 30);
    // chevron
    g.beginPath();
    g.moveTo(30, 62);
    g.lineTo(98, 62);
    g.lineTo(64, 112);
    g.closePath();
    g.fillStyle = towel.bg;
    g.fill();
    g.lineWidth = 6;
    g.strokeStyle = '#ffffff';
    g.stroke();
    g.fillStyle = towel.text;
    g.font = '900 26px system-ui, -apple-system, Segoe UI, sans-serif';
    g.fillText(String(towel.number ?? ''), 64, 80);
    tex.needsUpdate = true;
  };
  return sprite;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
