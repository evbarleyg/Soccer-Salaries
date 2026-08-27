// 3D racing ducks built from primitives: plump ellipsoid body + neck, big
// sphere head, rubber-duck bill, eyes with glints, slim wing ellipsoids, perky
// tail, webbed feet, a racing cloth with a number roundel on each flank, the
// towel-coloured rubber ring, a hat, and water-contact decals (wake V + foam).
// Local space: +Z forward, +Y up, +X = the duck's left. Waterline at y ≈ 0.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildHat } from './hats3d.js';
import { mergeMeshes } from './builders.js';

const bodyGeo = new THREE.SphereGeometry(1, 22, 16);
const headGeo = new THREE.SphereGeometry(1, 22, 16);
const eyeGeo = new THREE.SphereGeometry(0.072, 12, 10);
const glintGeo = new THREE.SphereGeometry(0.032, 8, 6);
const wingGeo = new THREE.SphereGeometry(1, 16, 12);
// tail: an ellipsoid whose root sits at the origin so the animator's rotation.z wags it from the root
const tailGeo = new THREE.SphereGeometry(1, 14, 10);
tailGeo.translate(0, 0.78, 0);
const billGeo = new THREE.SphereGeometry(1, 16, 10);
const footGeo = (() => {
  // little webbed paddle: a flat box whose front edge fans out
  const g = new THREE.BoxGeometry(0.12, 0.03, 0.2, 2, 1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) if (p.getZ(i) > 0) p.setX(i, p.getX(i) * 1.7);
  g.computeVertexNormals();
  return g;
})();
const HEAD_OFF = new THREE.Vector3(0, -0.03, -0.04); // skull centre inside the (animator-driven) head group
// both blush cheeks in one geometry (one transparent draw call per duck instead of two)
const cheekGeo = mergeGeometries([-1, 1].map((side) => new THREE.CircleGeometry(0.075, 12).rotateY(side * 1.0).translate(HEAD_OFF.x + side * 0.3, HEAD_OFF.y - 0.07, HEAD_OFF.z + 0.2)));
// body ellipsoid (shared by the cloth/roundel patches so they hug it exactly)
const BODY = { rx: 0.52, ry: 0.42, rz: 0.64, cy: 0.3, cz: -0.02 };
/**
 * A patch of the body surface, `lift` metres proud of it: phi is the angle from the spine (0 = top,
 * + = toward `side`), z0..z1 along the body. UVs are laid out for the chase camera behind the duck:
 * image-up points to the head, image-right to the duck's right, on both flanks.
 */
function bodyPatchGeo(side, phi0, phi1, z0, z1, lift, nphi = 8, nz = 6) {
  const pos = [];
  const uvs = [];
  const idx = [];
  for (let j = 0; j <= nphi; j++) {
    const phi = phi0 + (phi1 - phi0) * (j / nphi);
    for (let i = 0; i <= nz; i++) {
      const z = z0 + (z1 - z0) * (i / nz);
      const k = Math.sqrt(Math.max(0, 1 - ((z - BODY.cz) / BODY.rz) ** 2));
      pos.push(side * (BODY.rx * k + lift) * Math.sin(phi), BODY.cy + (BODY.ry * k + lift) * Math.cos(phi), z);
      uvs.push(side > 0 ? 1 - j / nphi : j / nphi, i / nz);
    }
  }
  for (let j = 0; j < nphi; j++) {
    for (let i = 0; i < nz; i++) {
      const a = j * (nz + 1) + i;
      const b = a + 1;
      const c = a + nz + 1;
      const d = c + 1;
      if (side > 0) idx.push(a, b, c, b, d, c);
      else idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
// racing cloth over the back between the wings (towel colour), symmetric: two halves
const clothGeoL = bodyPatchGeo(1, 0, 0.84, -0.36, 0.1, 0.012, 6, 6);
const clothGeoR = bodyPatchGeo(-1, 0, 0.84, -0.36, 0.1, 0.012, 6, 6);
// number roundels: curved square patches on the cloth, one per flank, tilted up so the chase cam reads them
const roundelGeoL = bodyPatchGeo(1, 0.2, 0.78, -0.29, 0.03, 0.024);
const roundelGeoR = bodyPatchGeo(-1, 0.2, 0.78, -0.29, 0.03, 0.024);
const ringGeo = new THREE.TorusGeometry(0.6, 0.14, 10, 30);
const shadowGeo = new THREE.CircleGeometry(1.0, 22);
const foamGeo = new THREE.PlaneGeometry(2.5, 2.5);
foamGeo.rotateX(-Math.PI / 2);
// wake: a flat V of two thin quads trailing behind the stern (duck local: +Z forward)
const WAKE_LEN = 4.2;
const wakeGeo = (() => {
  const half = (18 * Math.PI) / 180;
  const pos = [];
  const uv = [];
  const idx = [];
  for (const side of [-1, 1]) {
    const dx = Math.sin(half) * side;
    const dz = -Math.cos(half);
    // perpendicular (in the water plane), pointing outward
    const nx = -dz * side;
    const nz = dx * side;
    const ox = side * 0.28;
    const oz = -0.3;
    const w0 = 0.22;
    const w1 = 0.75;
    const base = pos.length / 3;
    const segs = 4;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const w = w0 + (w1 - w0) * t;
      const cx = ox + dx * WAKE_LEN * t;
      const cz = oz + dz * WAKE_LEN * t;
      pos.push(cx - nx * w * 0.5, 0, cz - nz * w * 0.5, cx + nx * w * 0.5, 0, cz + nz * w * 0.5);
      uv.push(0, t, 1, t);
      if (k < segs) {
        const a = base + k * 2;
        if (side < 0) idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); // keep both arms facing +Y
        else idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
})();

const blackMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.3 });
const whiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, emissive: 0x666666 });
const cheekMat = new THREE.MeshBasicMaterial({ color: 0xff7a9a, transparent: true, opacity: 0.5, depthWrite: false });
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x0d3550, transparent: true, opacity: 0.35, depthWrite: false });

/** Value-noise-ish hash for the procedural foam textures (deterministic). */
function hash01(i, j) {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
// wake strip texture: u across (soft edges, bright rims of the V), v along (fades out astern), streaky
const wakeTex = (() => {
  const w = 64;
  const h = 256;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1); // 0 at the duck .. 1 far astern
    const fade = Math.pow(1 - v, 1.4) * Math.min(1, v * 9 + 0.15);
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1);
      const edge = Math.sin(Math.PI * u);
      const crest = 0.5 + 0.5 * Math.pow(Math.abs(u - 0.5) * 2, 0.6); // brighter along the outer edges
      const n = 0.55 + 0.45 * hash01(Math.floor(x / 3), Math.floor(y / 5)) * (0.6 + 0.4 * hash01(x, y));
      const a = Math.max(0, Math.min(0.85, edge * 1.2)) * fade * crest * n;
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
})();
// waterline foam: a broken-up soft ring peaking just outside the rubber ring
const foamTex = (() => {
  const n = 128;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d');
  const img = g.createImageData(n, n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = (x + 0.5) / n * 2 - 1;
      const py = (y + 0.5) / n * 2 - 1;
      const r = Math.hypot(px, py); // 1 = 1.25 m
      const ang = Math.atan2(py, px);
      const wob = 0.04 * Math.sin(ang * 7) + 0.03 * Math.sin(ang * 13 + 1.7);
      const band = Math.exp(-Math.pow((r - 0.68 - wob) / 0.09, 2)) + 0.45 * Math.exp(-Math.pow((r - 0.84 - wob * 1.5) / 0.06, 2));
      const blobs = 0.55 + 0.45 * hash01(Math.floor((ang + 4) * 9), Math.floor(r * 14));
      const a = Math.max(0, Math.min(1, band * blobs * 1.1)) * (r < 0.98 ? 1 : 0);
      const i = (y * n + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
})();

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

/** sRGB-space HSL of a colour (perceptually saner than the linear working space for small tweaks). */
function hslOf(color) {
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(color).getHSL(hsl, THREE.SRGBColorSpace);
  return hsl;
}
function withLightness(color, dl) {
  const hsl = hslOf(color);
  return new THREE.Color().setHSL(hsl.h, hsl.s, Math.max(0, Math.min(1, hsl.l + dl)), THREE.SRGBColorSpace);
}
/** Wing tint: a lighter version of the body unless the palette's wing is deliberately different (mallard). */
function wingColours(pal) {
  const b = hslOf(pal.body);
  const w = hslOf(pal.wing || pal.body);
  const dh = Math.min(Math.abs(b.h - w.h), 1 - Math.abs(b.h - w.h));
  const distinct = dh > 0.08 || Math.abs(b.l - w.l) > 0.16 || Math.abs(b.s - w.s) > 0.3;
  if (distinct) return { wing: new THREE.Color(pal.wing), shade: new THREE.Color(pal.wingShade || pal.wing) };
  return { wing: withLightness(pal.body, b.l > 0.8 ? -0.06 : 0.12), shade: withLightness(pal.body, b.l > 0.8 ? -0.12 : 0.04) };
}

/** Cheap sky-coloured rim light on a MeshStandardMaterial (view-dependent fresnel added to the lit colour). */
function addRimLight(mat) {
  if (!mat || !mat.isMeshStandardMaterial) return;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    if (!shader.fragmentShader.includes('#include <opaque_fragment>')) return;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      'float duckRim = pow(1.0 - clamp(abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0), 2.5);\n  outgoingLight += vec3(0.75, 0.88, 1.0) * duckRim * 0.3;\n  #include <opaque_fragment>'
    );
  };
  mat.customProgramCacheKey = () => 'duck-rim-v1';
  mat.needsUpdate = true;
}

/**
 * Build a duck for `look` (from assignLooks). Returns { group, pivot, body,
 * head, wings, feet, hat, shadow, tail, wake, foam, mats, glowMats, look, shared }
 * — `pivot` is what the animator rolls, pitches and squashes; `group` is
 * placed on the water by the renderer; `wake`/`foam` are translucent water
 * decals whose opacity the animator may modulate.
 */
export function buildDuck(look) {
  const pal = look.palette;
  const metallic = !!pal.metallic;
  const wc = wingColours(pal);
  const mats = {
    body: std(pal.body, metallic ? { metalness: 0.55, roughness: 0.32 } : {}),
    light: std(pal.light || pal.body),
    head: std(pal.head || pal.body, metallic ? { metalness: 0.55, roughness: 0.32 } : {}),
    wing: std(wc.wing),
    wingShade: std(wc.shade),
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

  // body: plump and short so the big head overlaps it
  const body = new THREE.Mesh(bodyGeo, mats.body);
  body.scale.set(BODY.rx, BODY.ry, BODY.rz);
  body.position.set(0, BODY.cy, BODY.cz);
  pivot.add(body);
  // lighter chest/belly bulge
  const chest = new THREE.Mesh(bodyGeo, mats.light);
  chest.scale.set(0.4, 0.3, 0.38);
  chest.position.set(0, 0.24, 0.33);
  pivot.add(chest);
  // neck: fills the gap between body and head from every angle (the head pumps above it)
  const neck = new THREE.Mesh(bodyGeo, mats.body);
  neck.scale.set(0.25, 0.22, 0.25);
  neck.position.set(0, 0.62, 0.34);
  pivot.add(neck);
  // mallard-style speculum flash on the flanks
  if (mats.accent) {
    for (const side of [-1, 1]) {
      const flash = new THREE.Mesh(bodyGeo, mats.accent);
      flash.scale.set(0.06, 0.09, 0.18);
      flash.position.set(side * 0.48, 0.34, -0.3);
      pivot.add(flash);
    }
  }
  // tail: smooth perky ellipsoid, root buried in the rump, pointing back and up ~45°
  const tail = new THREE.Mesh(tailGeo, mats.body);
  tail.scale.set(0.17, 0.27, 0.13);
  tail.position.set(0, 0.43, -0.5);
  tail.rotation.x = -0.82;
  pivot.add(tail);

  // towel-coloured rubber ring at the waterline: the duck's ID colour, readable from any camera
  const ring = new THREE.Mesh(ringGeo, mats.towel);
  ring.rotation.x = Math.PI / 2;
  ring.position.set(0, 0.07, 0.0);
  ring.scale.set(1, 1.14, 1);
  pivot.add(ring);
  // racing cloth over the back (towel colour) with a number roundel on each side
  const towel = new THREE.Mesh(clothGeoL, mats.towel);
  const towelR = new THREE.Mesh(clothGeoR, mats.towel);
  pivot.add(towel, towelR);
  const roundelMat = new THREE.MeshBasicMaterial({ map: roundelTexture(look.number, look.towel), transparent: true });
  pivot.add(new THREE.Mesh(roundelGeoL, roundelMat), new THREE.Mesh(roundelGeoR, roundelMat));

  // neck ring (mallard)
  if (mats.ring) {
    const nr = new THREE.Mesh(new THREE.TorusGeometry(0.235, 0.035, 8, 24), mats.ring);
    nr.position.set(0, 0.66, 0.36);
    nr.rotation.x = Math.PI / 2 - 0.45;
    pivot.add(nr);
  }

  // head group (head pump animates this; the animator keeps it near (0, 0.9, 0.45))
  const head = new THREE.Group();
  head.position.set(0, 0.9, 0.45);
  pivot.add(head);
  const HR = 0.36;
  const skull = new THREE.Mesh(headGeo, mats.head);
  skull.scale.set(HR, HR * 0.97, HR);
  skull.position.copy(HEAD_OFF); // big head sits low and slightly back so it overlaps body + neck
  head.add(skull);
  const hc = skull.position;
  // bill: friendly rubber-duck bill from two squashed spheres (upper smiles up a touch, lower tucked under)
  const billTop = new THREE.Mesh(billGeo, mats.beak);
  billTop.scale.set(0.2, 0.07, 0.2);
  billTop.position.set(hc.x, hc.y - 0.075, hc.z + 0.34);
  billTop.rotation.x = -0.14;
  head.add(billTop);
  const billBot = new THREE.Mesh(billGeo, mats.beakShade);
  billBot.scale.set(0.165, 0.05, 0.16);
  billBot.position.set(hc.x, hc.y - 0.14, hc.z + 0.3);
  billBot.rotation.x = 0.1;
  head.add(billBot);
  // eyes + glints, upper-front so they read from the chase cam swinging round and from the front
  for (const side of [-1, 1]) {
    const ex = side * 0.2;
    const ey = 0.09;
    const ez = 0.265;
    const eye = new THREE.Mesh(eyeGeo, mats.eye);
    eye.position.set(hc.x + ex, hc.y + ey, hc.z + ez);
    eye.scale.set(1, 1.15, 1);
    head.add(eye);
    const glint = new THREE.Mesh(glintGeo, whiteMat);
    glint.position.set(hc.x + ex + side * 0.03, hc.y + ey + 0.04, hc.z + ez + 0.048);
    head.add(glint);
  }
  if (look.cheeks) head.add(new THREE.Mesh(cheekGeo, cheekMat));
  // hat (built around the head centre)
  const hat = buildHat(look.hat);
  hat.position.add(hc);
  head.add(hat);

  // wings: slim, tucked high on the flanks, rolled out a little with the tips raised
  const wings = [];
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.43, 0.5, 0.14);
    const wing = new THREE.Mesh(wingGeo, mats.wing);
    wing.scale.set(0.07, 0.17, 0.38);
    wing.position.set(side * 0.02, -0.1, -0.27);
    wing.rotation.set(0.24, side * 0.06, side * 0.26);
    shoulder.add(wing);
    const tip = new THREE.Mesh(wingGeo, mats.wingShade);
    tip.scale.set(0.05, 0.09, 0.17);
    tip.position.set(side * 0.03, -0.02, -0.55);
    tip.rotation.set(0.5, side * 0.06, side * 0.26);
    shoulder.add(tip);
    shoulder.userData.side = side;
    pivot.add(shoulder);
    wings.push(shoulder);
  }

  // feet: small webbed paddles tucked under the body (under the opaque water at rest; the animator dangles them when airborne)
  const feet = [];
  for (const side of [-1, 1]) {
    const foot = new THREE.Mesh(footGeo, mats.beak);
    foot.position.set(side * 0.17, -0.07, -0.1);
    pivot.add(foot);
    feet.push(foot);
  }

  // blob shadow on the water (stays level, placed at the waterline by the animator)
  const shadow = new THREE.Mesh(shadowGeo, shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.scale.set(0.75, 1.05, 1);
  shadow.renderOrder = 2;
  group.add(shadow);
  shadow.position.y = 0.06;
  // water contact decals ride on the shadow (which the animator keeps glued to the water and hides on the
  // podium), inside a group that undoes the shadow's tilt/stretch so they are authored in duck axes (+Z fwd).
  const onWater = new THREE.Group();
  onWater.rotation.x = Math.PI / 2;
  onWater.scale.set(1 / 0.75, 1, 1 / 1.05);
  onWater.position.z = 0.02; // shadow-local z = up: a whisker above the shadow disc (itself 6 cm over the water)
  shadow.add(onWater);
  const wake = new THREE.Mesh(wakeGeo, new THREE.MeshLambertMaterial({ color: 0xf2f8fb, emissive: 0x1a2024, map: wakeTex, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide }));
  wake.renderOrder = 3;
  wake.name = 'wake';
  onWater.add(wake);
  const foam = new THREE.Mesh(foamGeo, new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x30393f, map: foamTex, transparent: true, opacity: 0.5, depthWrite: false }));
  foam.renderOrder = 3;
  foam.position.y = 0.01;
  foam.name = 'foam';
  onWater.add(foam);

  // ---- collapse into a handful of draw calls (body statics, head, hat, each wing, roundels)
  const statics = [body, chest, neck, towel, towelR, ring];
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
  for (const m of [...glowMats, ...hatMerged.map((h) => h.material), tail.material]) addRimLight(m);

  group.traverse((o) => {
    if (o.isMesh) o.frustumCulled = true;
  });
  const shared = new Set([bodyGeo, headGeo, eyeGeo, glintGeo, wingGeo, tailGeo, billGeo, footGeo, cheekGeo, clothGeoL, clothGeoR, roundelGeoL, roundelGeoR, ringGeo, shadowGeo, foamGeo, wakeGeo, blackMat, whiteMat, cheekMat, shadowMat, wakeTex, foamTex, roundelMat.map]);
  return { group, pivot, body: bodyMerged[0] || body, head, wings, feet, hat, shadow, tail, wake, foam, mats, glowMats, look, shared };
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
