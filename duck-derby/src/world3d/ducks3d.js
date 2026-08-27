// 3D racing ducks built from primitives: plump ellipsoid body + neck, big
// sphere head, rubber-duck bill with nostrils, big eyes with flat white glints,
// low-relief folded wings, perky tail, webbed feet, a racing cloth over the
// back with ONE number roundel (upright for the chase camera), small numerals
// on the towel-coloured rubber ring at 10 and 2 o'clock, a hat, and
// water-contact decals (wake V + waterline foam).
// Local space: +Z forward, +Y up, +X = the duck's left. Waterline at y ≈ 0.
//
// Draw calls per duck (11 + 2 sprites; was 12–14 + 2): body statics (1; 2 on
// the metallic duck), number decals (1), head + face + hat statics (1; +1
// metal bucket for gold/silver hat parts, + propeller spinner / snorkel lens),
// wings (2), tail (1), feet (2), shadow, wake, foam (3). `lod.far` lists the
// six small ones main.js may hide beyond ~45 m. Every lit part is a
// vertex-coloured MeshStandardMaterial with the same rim-light patch, so all
// ducks share one program (+1 for the alpha-tested decals). ≈3.4k triangles
// per duck plus 0.3–3k for the hat (was ≈6.8k).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildHat, HAT_SHARED_MATERIALS } from './hats3d.js';
import { mergeMeshes, colorize } from './builders.js';

// ---- shared geometry. Tessellation is deliberately modest (≈3.4k triangles per duck + hat): a 12–16 duck
// pack is CPU/vertex-bound on phones and the facets are invisible at chase distance.
const bodyGeo = new THREE.SphereGeometry(1, 14, 10); // body + skull
const smallGeo = new THREE.SphereGeometry(1, 10, 8); // chest, neck, bill
const EYE_R = 0.085;
const eyeGeo = new THREE.SphereGeometry(EYE_R, 10, 8);
// tail: a plump wedge (sphere tapered to a point and curled forward at the tip) whose root pole sits at the
// origin so the animator's rotation.z wags it from the root; y runs 0 (root) .. 2 (tip) before scaling
const tailGeo = (() => {
  const g = new THREE.SphereGeometry(1, 10, 8);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) + 1) / 2; // 0 at the root, 1 at the tip
    const w = 1 - 0.6 * t;
    p.setXYZ(i, p.getX(i) * w, p.getY(i) + 1, p.getZ(i) * w + 0.35 * t * t);
  }
  g.computeVertexNormals();
  return g;
})();
const footGeo = (() => {
  // little webbed paddle: a flat box whose front edge fans out
  const g = new THREE.BoxGeometry(0.12, 0.03, 0.2, 2, 1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) if (p.getZ(i) > 0) p.setX(i, p.getX(i) * 1.7);
  g.computeVertexNormals();
  return g;
})();
const neckRingGeo = new THREE.TorusGeometry(0.235, 0.035, 6, 16);

const HR = 0.36; // skull radius
const HEAD_OFF = new THREE.Vector3(0, -0.03, -0.04); // skull centre inside the (animator-driven) head group
const EYE = { x: 0.2, y: 0.07, z: 0.265, sy: 1.15 }; // eye centre relative to the skull centre (x mirrored) + vertical stretch
const BILL = { y: -0.075, z: 0.34, rx: -0.14, sx: 0.23, sy: 0.075, sz: 0.21 }; // upper bill ellipsoid, relative to the skull centre
// body ellipsoid (shared by the cloth/roundel patches so they hug it exactly)
const BODY = { rx: 0.52, ry: 0.42, rz: 0.64, cy: 0.3, cz: -0.02 };
// rubber ring: torus at the waterline, stretched fore–aft
const RING = { R: 0.6, r: 0.14, y: 0.07, sz: 1.14 };
const ringGeo = new THREE.TorusGeometry(RING.R, RING.r, 12, 36); // 12 radial keeps the tube round in close-ups
const ringMatrix = new THREE.Matrix4().compose(new THREE.Vector3(0, RING.y, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)), new THREE.Vector3(1, RING.sz, 1));

/**
 * Curved rectangular patch: fn(u, v, out) gives the surface point for u, v ∈ [0, 1]; the faces are wound to
 * look away from `inside`; uv(u, v) → [U, V] lays the texture out (defaults to the unit square).
 */
function patchGeo(nu, nv, fn, inside, uv = (u, v) => [u, v]) {
  const pos = [];
  const uvs = [];
  const idx = [];
  const p = new THREE.Vector3();
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      fn(i / nu, j / nv, p);
      pos.push(p.x, p.y, p.z);
      uvs.push(...uv(i / nu, j / nv));
    }
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i;
      idx.push(a, a + nu + 1, a + 1, a + 1, a + nu + 1, a + nu + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = Math.floor(((nu + 1) * (nv + 1)) / 2);
  const n = new THREE.Vector3().fromBufferAttribute(g.attributes.normal, m);
  const out = new THREE.Vector3().fromBufferAttribute(g.attributes.position, m).sub(inside);
  if (n.dot(out) < 0) {
    for (let k = 0; k < idx.length; k += 3) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]];
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  return g;
}
const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** Point on the body ellipsoid, `lift` proud: phi = angle from the spine (+ = duck's left), z along the body. */
function bodyPoint(phi, z, lift, out) {
  const k = Math.sqrt(Math.max(0, 1 - ((z - BODY.cz) / BODY.rz) ** 2));
  return out.set((BODY.rx * k + lift) * Math.sin(phi), BODY.cy + (BODY.ry * k + lift) * Math.cos(phi), z);
}
/** Body-surface patch from phiL (duck's left edge) to phiR, z0 (rear) .. z1 (front). Texture: left→right = the chase camera's left→right, up = toward the head. */
function bodyPatchGeo(phiL, phiR, z0, z1, lift, nu, nv, uv) {
  return patchGeo(nu, nv, (u, v, p) => bodyPoint(phiL + (phiR - phiL) * u, z0 + (z1 - z0) * v, lift, p), new THREE.Vector3(0, BODY.cy, BODY.cz), uv);
}
/** Point on the rubber ring: major angle a (0 = duck's left, π/2 = dead ahead), minor angle b (0 = outer equator, −π/2 = top of the tube). */
function ringPoint(a, b, lift, out) {
  const rr = RING.r + lift;
  return out.set((RING.R + rr * Math.cos(b)) * Math.cos(a), (RING.R + rr * Math.cos(b)) * Math.sin(a), rr * Math.sin(b)).applyMatrix4(ringMatrix);
}
/** Small patch on the upper-outer face of the ring centred at major angle ac, reading upright for someone standing outside the ring. */
function ringPatchGeo(ac, da, b0, b1, lift, uv) {
  const inside = new THREE.Vector3(RING.R * Math.cos(ac), RING.R * Math.sin(ac), 0).applyMatrix4(ringMatrix);
  return patchGeo(6, 6, (u, v, p) => ringPoint(ac + da - 2 * da * u, b0 + (b1 - b0) * v, lift, p), inside, uv);
}
/**
 * Spherical-cap decal of radius ≈ r hugging the ellipsoid (centre c, semi-axes a, optional euler e) around the
 * unit-sphere direction n, `lift` proud of the surface (glints, pupils, nostrils, cheeks).
 */
function capOn(r, c, a, e, n, lift = 0.003, seg = 12) {
  const nn = new THREE.Vector3(n[0], n[1], n[2]).normalize();
  const rho = new THREE.Vector3(nn.x * a[0], nn.y * a[1], nn.z * a[2]).length();
  const g = new THREE.SphereGeometry(1, seg, 2, 0, Math.PI * 2, 0, Math.asin(Math.min(0.95, r / rho)));
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), nn));
  g.scale(a[0] + lift, a[1] + lift, a[2] + lift);
  if (e) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(e[0], e[1], e[2])));
  g.translate(c[0], c[1], c[2]);
  return g;
}

// racing cloth over the back between the wings (towel colour) and the single number roundel on it
const clothGeo = bodyPatchGeo(0.72, -0.72, -0.45, 0.12, 0.012, 10, 6);
const roundelGeo = bodyPatchGeo(0.39, -0.39, -0.38, -0.04, 0.022, 8, 8, (u, v) => [u * 0.5, v]);
// numerals on the ring at 10 and 2 o'clock (major angle π/2 ∓ 60°), on the tube's upper-outer face
const ringNumGeoL = ringPatchGeo(Math.PI / 2 - 1.05, 0.11, -0.02, -1.12, 0.008, (u, v) => [0.5 + u * 0.5, v]);
const ringNumGeoR = ringPatchGeo(Math.PI / 2 + 1.05, 0.11, -0.02, -1.12, 0.008, (u, v) => [0.5 + u * 0.5, v]);
// folded wings: low-relief teardrop "blisters" on the body surface (so they hug it from every angle), converging
// toward the tail with the pointed tips lifted off the rump. Built in body space, then moved into the shoulder
// group's space (the animator rolls the shoulder about z to flap) and pre-rolled by the animator's idle roll so
// they sit flush at rest. uv = (t along the wing, q across) drives the per-duck two-tone vertex colours.
const SHOULDER = new THREE.Vector3(0.4, 0.5, 0.14);
const WING = { zF: 0.24, zR: -0.54, T: 0.05, phiF: 1.1, dphi: -0.25, hw: 0.42, tipLift: 0.05, idleRoll: 0.09 };
function wingSurface(side, top) {
  const inside = top ? new THREE.Vector3(0, BODY.cy, BODY.cz) : new THREE.Vector3(side * 5, 0.45, -0.15);
  const g = patchGeo(9, 5, (u, v, p) => {
    const t = u;
    const q = v * 2 - 1;
    const hw = WING.hw * Math.pow(Math.sin(Math.PI * t), 0.6) * (1 - 0.5 * t) + 1e-4;
    const phi = (WING.phiF + WING.dphi * t + q * hw) * side;
    const z = WING.zF + (WING.zR - WING.zF) * t;
    const d = top ? WING.T * Math.sqrt(Math.max(0, 1 - q * q)) * (0.85 + 0.15 * q) * Math.pow(Math.sin(Math.PI * t), 0.5) * (1 - 0.3 * t) : -0.002; // fullest a bit below the centre line
    bodyPoint(phi, z, 0.006 + WING.tipLift * smooth(0.7, 1, t) + d, p);
  }, inside);
  g.translate(-side * SHOULDER.x, -SHOULDER.y, -SHOULDER.z);
  g.applyMatrix4(new THREE.Matrix4().makeRotationZ(-side * WING.idleRoll));
  return g;
}
const wingBase = { '-1': mergeGeometries([wingSurface(-1, true), wingSurface(-1, false)]), '1': mergeGeometries([wingSurface(1, true), wingSurface(1, false)]) };
/** Per-duck wing colours: main colour blending to `shade` at the tip, optional speculum band (`accent`) on the lower rear half. */
function paintWing(g, main, shade, accent) {
  const uv = g.attributes.uv;
  const n = uv.count;
  const arr = new Float32Array(n * 3);
  const c = new THREE.Color();
  const acc = accent ? new THREE.Color(accent) : null;
  for (let i = 0; i < n; i++) {
    const t = uv.getX(i);
    const q = uv.getY(i) * 2 - 1;
    c.copy(main).lerp(shade, smooth(0.6, 0.82, t));
    if (acc && t > 0.4 && t < 0.64 && q > 0.05) c.copy(acc);
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}
// face decals (all relative to the head group, so they are shared): glints + tiny secondary dots, nostrils, cheeks, pupils
const glintGeo = (() => {
  const parts = [];
  for (const side of [-1, 1]) {
    const c = [HEAD_OFF.x + side * EYE.x, HEAD_OFF.y + EYE.y, HEAD_OFF.z + EYE.z];
    const a = [EYE_R, EYE_R * EYE.sy, EYE_R];
    parts.push(capOn(0.028, c, a, null, [side * 0.42, 0.55, 0.72], 0.006, 12));
    parts.push(capOn(0.012, c, a, null, [side * 0.8, -0.28, 0.53], 0.006, 8));
  }
  return mergeGeometries(parts);
})();
const pupilGeo = mergeGeometries([-1, 1].map((side) => capOn(0.05, [HEAD_OFF.x + side * EYE.x, HEAD_OFF.y + EYE.y, HEAD_OFF.z + EYE.z], [EYE_R, EYE_R * EYE.sy, EYE_R], null, [side * 0.5, 0.12, 0.86], 0.003, 12)));
const nostrilGeo = mergeGeometries([-1, 1].map((side) => capOn(0.01, [HEAD_OFF.x, HEAD_OFF.y + BILL.y, HEAD_OFF.z + BILL.z], [BILL.sx, BILL.sy, BILL.sz], [BILL.rx, 0, 0], [side * 0.24, 0.87, 0.43], 0.004, 8)));
const cheekGeo = mergeGeometries([-1, 1].map((side) => capOn(0.075, [HEAD_OFF.x, HEAD_OFF.y, HEAD_OFF.z], [HR, HR * 0.97, HR], null, [side * 0.817, -0.19, 0.545], 0.004, 12)));

const shadowGeo = new THREE.CircleGeometry(1.0, 22);
const foamGeo = new THREE.PlaneGeometry(2.5, 2.5);
foamGeo.rotateX(-Math.PI / 2);
// wake: a flat V of two thin quads trailing behind the stern (duck local: +Z forward); both arms are wound to face +Y
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
        if (side < 0) idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
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

// Source materials for the merged buckets (mergeMeshes bakes their colours into vertex colours and drops them).
const blackMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.3 });
// Glints must render pure white, not lit grey ("cataract"). They live in the lit head bucket, so they carry an
// out-of-range vertex colour (2,2,2) that the shared rim-light shader patch turns into flat white — see addRimLight.
const GLINT_SENTINEL = new THREE.Color(2, 2, 2);
const glintMat = new THREE.MeshStandardMaterial({ color: GLINT_SENTINEL });
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

// Number decal atlas per (number, towel), 256×128: left cell = white roundel with a towel-coloured rim and the
// number (back cloth), right cell = the bare numeral in the towel's text colour (rubber ring). Hard-edged, so the
// decal material uses alphaTest instead of blending. Cached across races → listed in `shared`.
const decalTexCache = new Map();
function decalTexture(number, towel) {
  const key = `${number}|${towel.bg}|${towel.text}`;
  if (decalTexCache.has(key)) return decalTexCache.get(key);
  const label = String(number);
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(64, 64, 57, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 7;
  g.strokeStyle = towel.bg;
  g.stroke();
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#161616';
  g.font = `900 ${label.length > 1 ? 60 : 74}px system-ui, -apple-system, Segoe UI, sans-serif`;
  g.fillText(label, 64, 69);
  g.fillStyle = towel.text;
  g.font = `900 ${label.length > 1 ? 78 : 98}px system-ui, -apple-system, Segoe UI, sans-serif`;
  g.fillText(label, 192, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  decalTexCache.set(key, tex);
  return tex;
}

function std(color, o = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0, ...o });
}
/** Vertex-coloured material matching what mergeMeshes produces (so separately animated parts share its program). */
function vcMat(metal = false) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: metal ? 0.32 : 0.55, metalness: metal ? 0.55 : 0 });
  if (metal) {
    mat.emissive = new THREE.Color(0x2a1c00);
    mat.emissiveIntensity = 0.25;
  }
  return mat;
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
/** Rec.709 luma of the sRGB-encoded colour, 0..1 — the "is this a dark duck" test. */
function luma(color) {
  const c = { r: 0, g: 0, b: 0 };
  new THREE.Color(color).getRGB(c, THREE.SRGBColorSpace);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}
/** True for the catalogue's generic orange bills (which all get the warm rubber-duck orange); deliberately yellow, green-yellow or dark bills are kept. */
function isGenericOrange(color) {
  const { h, s, l } = hslOf(color);
  const deg = h * 360;
  return deg >= 20 && deg <= 41.5 && s >= 0.6 && l >= 0.5 && l <= 0.72;
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

/**
 * Cheap sky-coloured rim light on a MeshStandardMaterial (view-dependent fresnel added to the lit colour), plus
 * the glint rule: vertex colours above 1.5 (GLINT_SENTINEL) render flat white. The patch and cache key are
 * identical for every duck material, so they all share one compiled program.
 */
function addRimLight(mat) {
  if (!mat || !mat.isMeshStandardMaterial) return;
  mat.onBeforeCompile = rimCompile;
  mat.customProgramCacheKey = rimCacheKey;
  mat.needsUpdate = true;
}
const RIM_GLSL = [
  'float duckRim = pow(1.0 - clamp(abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0), 2.5);',
  '  outgoingLight += vec3(0.75, 0.88, 1.0) * duckRim * 0.3;',
  '  #if defined( USE_COLOR ) && ! defined( USE_COLOR_ALPHA )',
  '  outgoingLight = vColor.r > 1.5 ? vec3(1.0) : outgoingLight;',
  '  #endif',
  '  #include <opaque_fragment>',
].join('\n');
function rimCompile(shader) {
  if (!shader.fragmentShader.includes('#include <opaque_fragment>')) return;
  shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', RIM_GLSL);
}
function rimCacheKey() {
  return 'duck-rim-v2';
}

/**
 * Build a duck for `look` (from assignLooks). Returns { group, pivot, body,
 * head, wings, feet, hat, shadow, tail, wake, foam, mats, glowMats, look, shared, lod }
 * — `pivot` is what the animator rolls, pitches and squashes; `group` is
 * placed on the water by the renderer; `wake`/`foam` are translucent water
 * decals with PER-DUCK material instances (the animator drives their opacity
 * from this duck's speed); `lod.far` lists small meshes that can be hidden
 * beyond ~45 m; `shared` is the set of module-level geometries/materials/
 * textures that must survive clearDucks() between races.
 */
export function buildDuck(look) {
  const pal = look.palette;
  const metallic = !!pal.metallic;
  const wc = wingColours(pal);
  const genericBill = isGenericOrange(pal.beak);
  const dark = luma(pal.body) < 0.45;
  const mats = {
    body: std(pal.body, metallic ? { metalness: 0.55, roughness: 0.32 } : {}),
    // chest: only a touch lighter than the body (a distinct light ellipsoid reads as a two-ball seam)
    light: std(withLightness(pal.body, 0.06)),
    head: std(pal.head || pal.body, metallic ? { metalness: 0.55, roughness: 0.32 } : {}),
    wing: std(wc.wing),
    wingShade: std(wc.shade),
    beak: std(genericBill ? 0xf5a623 : pal.beak, { roughness: 0.45 }),
    beakShade: std(genericBill ? 0xd98a1c : pal.beakShade || pal.beak, { roughness: 0.45 }),
    eye: pal.eye && pal.eye !== '#1B1B1B' && pal.eye !== '#111' ? std(pal.eye, { roughness: 0.3 }) : blackMat,
    towel: std(look.towel.bg, { roughness: 0.85 }),
    ring: pal.ring ? std(pal.ring) : null,
    accent: pal.accent ? std(pal.accent) : null,
  };
  // soft blush: pink blended ≈35 % into the head colour (opaque, so it lives in the merged head bucket). A plain 35 %
  // blend of pink over teal/blue/green is grey, so the blend grows with hue distance from pink; subtler on dark heads.
  if (!metallic) {
    const headCol = pal.head || pal.body;
    const hh = hslOf(headCol);
    const dh = Math.abs(((hh.h - hslOf(0xff7a9a).h + 1.5) % 1) - 0.5) * 2; // 0 = same hue .. 1 = complementary
    const a = (0.35 + 0.3 * smooth(0.25, 0.9, dh) * smooth(0.15, 0.5, hh.s)) * (luma(headCol) < 0.45 ? 0.6 : 1);
    mats.cheek = std(new THREE.Color(headCol).lerp(new THREE.Color(0xff7a9a), a));
  } else mats.cheek = null;

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
  const statics = [body];
  // subtle chest bulge just above the ring (skipped on dark ducks, where any lighter patch shows a seam)
  if (!dark) {
    const chest = new THREE.Mesh(smallGeo, mats.light);
    chest.scale.set(0.34, 0.26, 0.3);
    chest.position.set(0, 0.26, 0.36);
    pivot.add(chest);
    statics.push(chest);
  }
  // neck: fills the gap between body and head from every angle (the head pumps above it)
  const neck = new THREE.Mesh(smallGeo, mats.body);
  neck.scale.set(0.25, 0.22, 0.25);
  neck.position.set(0, 0.62, 0.34);
  pivot.add(neck);
  statics.push(neck);
  // tail: fuller perky ellipsoid, root buried in the rump, pitched up ~50°. Stays its own mesh (the animator
  // wags tail.rotation.z) but is vertex-coloured like the merged parts so it shares their program.
  const tail = new THREE.Mesh(colorize(tailGeo.clone(), pal.body), vcMat(metallic));
  tail.scale.set(0.22, 0.19, 0.13); // ≈0.33 wide at the root, 0.38 long, 0.2 thick → a perky wedge, not a ball, from the chase cam
  tail.position.set(0, 0.4, -0.53);
  tail.rotation.x = -0.55;
  pivot.add(tail);

  // towel-coloured rubber ring at the waterline: the duck's ID colour, readable from any camera
  const ring = new THREE.Mesh(ringGeo, mats.towel);
  ringMatrix.decompose(ring.position, ring.quaternion, ring.scale);
  pivot.add(ring);
  statics.push(ring);
  // racing cloth over the back (towel colour)
  const towel = new THREE.Mesh(clothGeo, mats.towel);
  pivot.add(towel);
  statics.push(towel);
  // neck ring (mallard)
  if (mats.ring) {
    const nr = new THREE.Mesh(neckRingGeo, mats.ring);
    nr.position.set(0, 0.66, 0.36);
    nr.rotation.x = Math.PI / 2 - 0.45;
    pivot.add(nr);
    statics.push(nr);
  }
  // number decals: one roundel centred on the back cloth (upright from the chase camera) + numerals on the
  // ring at 10 and 2 o'clock — one textured draw call
  const decalMat = new THREE.MeshBasicMaterial({ map: decalTexture(look.number, look.towel) });
  const decalSrc = [roundelGeo, ringNumGeoL, ringNumGeoR].map((g) => new THREE.Mesh(g, decalMat));
  pivot.add(...decalSrc);

  // head group (head pump animates this; the animator keeps it near (0, 0.9, 0.45))
  const head = new THREE.Group();
  head.position.set(0, 0.9, 0.45);
  pivot.add(head);
  const skull = new THREE.Mesh(bodyGeo, mats.head);
  skull.scale.set(HR, HR * 0.97, HR);
  skull.position.copy(HEAD_OFF); // big head sits low and slightly back so it overlaps body + neck
  head.add(skull);
  const hc = HEAD_OFF;
  const headStatics = [skull];
  // bill: friendly rubber-duck bill from two squashed spheres (upper wide and smiling up a touch; the lower
  // mandible tucked up under it so the crease reads as a shadow line, not a gap)
  const billTop = new THREE.Mesh(smallGeo, mats.beak);
  billTop.scale.set(BILL.sx, BILL.sy, BILL.sz);
  billTop.position.set(hc.x, hc.y + BILL.y, hc.z + BILL.z);
  billTop.rotation.x = BILL.rx;
  const billBot = new THREE.Mesh(smallGeo, mats.beakShade);
  billBot.scale.set(0.18, 0.05, 0.16);
  billBot.position.set(hc.x, hc.y - 0.13, hc.z + 0.29);
  billBot.rotation.x = 0.1;
  head.add(billTop, billBot);
  headStatics.push(billTop, billBot);
  // eyes: big, glossy, upper-front so they read from the chase cam swinging round and from the front
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeo, mats.eye);
    eye.position.set(hc.x + side * EYE.x, hc.y + EYE.y, hc.z + EYE.z);
    eye.scale.set(1, EYE.sy, 1);
    head.add(eye);
    headStatics.push(eye);
  }
  // light irises (cayuga yellow, navy white) get a black pupil; every duck gets flat white glints + nostrils
  if (mats.eye !== blackMat) headStatics.push(new THREE.Mesh(pupilGeo, blackMat));
  headStatics.push(new THREE.Mesh(glintGeo, glintMat), new THREE.Mesh(nostrilGeo, blackMat));
  if (mats.cheek) headStatics.push(new THREE.Mesh(cheekGeo, mats.cheek));
  for (const m of headStatics) if (!m.parent) head.add(m);
  // hat (built around the head centre); its band, if any, in the towel colour (yellow numerals colour on the black towel)
  const band = luma(look.towel.bg) < 0.1 ? look.towel.text : look.towel.bg;
  const hat = buildHat(look.hat, { band });
  hat.position.add(hc);
  head.add(hat);

  // wings: body-hugging reliefs (see wingBase); one vertex-coloured mesh per shoulder group
  const wings = [];
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * SHOULDER.x, SHOULDER.y, SHOULDER.z);
    const wing = new THREE.Mesh(paintWing(wingBase[side].clone(), wc.wing, wc.shade, pal.accent), vcMat(false));
    shoulder.add(wing);
    shoulder.userData.side = side;
    pivot.add(shoulder);
    wings.push(shoulder);
  }

  // feet: small webbed paddles tucked under the body (under the opaque water at rest; the animator dangles them when airborne)
  const feet = [];
  const footG = colorize(footGeo.clone(), mats.beak.color);
  const footMat = vcMat(false);
  for (const side of [-1, 1]) {
    const foot = new THREE.Mesh(footG, footMat);
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
  // Their materials are per-duck instances: animate.js modulates wake/foam opacity with this duck's speed.
  const onWater = new THREE.Group();
  onWater.rotation.x = Math.PI / 2;
  onWater.scale.set(1 / 0.75, 1, 1 / 1.05);
  onWater.position.z = 0.02; // shadow-local z = up: a whisker above the shadow disc (itself 6 cm over the water)
  shadow.add(onWater);
  const wake = new THREE.Mesh(wakeGeo, new THREE.MeshLambertMaterial({ color: 0xf2f8fb, emissive: 0x1a2024, map: wakeTex, transparent: true, opacity: 0.28, depthWrite: false }));
  wake.renderOrder = 3;
  wake.name = 'wake';
  onWater.add(wake);
  const foam = new THREE.Mesh(foamGeo, new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x30393f, map: foamTex, transparent: true, opacity: 0.4, depthWrite: false }));
  foam.renderOrder = 3;
  foam.position.y = 0.01;
  foam.name = 'foam';
  onWater.add(foam);

  // ---- collapse into a handful of draw calls: body statics, decals, head (+ face + hat statics)
  const bodyMerged = mergeMeshes(pivot, statics);
  const decalMerged = mergeMeshes(pivot, decalSrc);
  for (const m of decalMerged) {
    // hard-edged canvas art: alpha-test instead of blending (no sorting, no double transparent pass)
    Object.assign(m.material, { transparent: false, alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    m.renderOrder = 1;
  }
  const hatMeshes = [];
  hat.traverse((o) => {
    if (!o.isMesh || o.material.transparent) return;
    let p = o.parent;
    while (p && p !== hat) { if (p === hat.userData.spin) return; p = p.parent; }
    hatMeshes.push(o);
  });
  const metalRough = Math.max(0.32, ...hatMeshes.filter((m) => (m.material.metalness || 0) > 0.3).map((m) => m.material.roughness || 0));
  const headMerged = mergeMeshes(head, [...headStatics, ...hatMeshes], { roughness: 0.5 });
  for (const m of headMerged) if (m.material.metalness > 0) m.material.roughness = metalRough; // e.g. brushed viking silver
  // whatever is left in the hat (propeller spinner, snorkel lens) keeps its own draw calls
  const spin = hat.userData.spin;
  if (spin) mergeMeshes(spin, spin.children.filter((o) => o.isMesh), { roughness: 0.6 });
  const hatRest = [];
  hat.traverse((o) => { if (o.isMesh) hatRest.push(o); });
  const wingMerged = wings.map((w) => w.children[0]);
  const litMats = [...bodyMerged, ...headMerged, ...wingMerged, tail].map((m) => m.material);
  for (const m of [...litMats, footMat]) addRimLight(m);
  hat.traverse((o) => { if (o.isMesh && !o.material.transparent) addRimLight(o.material); });
  // everything the animator's golden glow and main.js's ghost-fade should affect (decals un-rimmed, but they fade too)
  const glowMats = [...litMats, footMat, ...decalMerged.map((m) => m.material)];

  group.traverse((o) => {
    if (o.isMesh) o.frustumCulled = true;
  });
  const lod = { far: [shadow, foam, wake, ...decalMerged, ...feet, ...hatRest] };
  const shared = new Set([bodyGeo, smallGeo, wingBase[-1], wingBase[1], eyeGeo, tailGeo, footGeo, neckRingGeo, ringGeo, clothGeo, roundelGeo, ringNumGeoL, ringNumGeoR, glintGeo, pupilGeo, nostrilGeo, cheekGeo, shadowGeo, foamGeo, wakeGeo, blackMat, glintMat, shadowMat, wakeTex, foamTex, decalMat.map, ...HAT_SHARED_MATERIALS]);
  return { group, pivot, body: bodyMerged[0] || body, head, wings, feet, hat, shadow, tail, wake, foam, mats, glowMats, look, shared, lod };
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
