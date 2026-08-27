// Small geometry/texture helpers shared by the scenery modules.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Paint a solid vertex colour onto a (non-indexed or indexed) geometry. Returns the geometry. */
export function colorize(geo, color) {
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Apply a Matrix4 built from position/rotation/scale to a geometry (in place) and return it. */
export function place(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
  geo.applyMatrix4(m);
  return geo;
}

/** Merge coloured geometries into one mesh with a vertex-coloured Lambert material. */
export function mergedMesh(geos, { flat = true, material } = {}) {
  const prepared = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  for (const g of prepared) {
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'color', 'uv'].includes(name)) g.deleteAttribute(name);
    if (!g.attributes.uv) {
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    }
    if (!g.attributes.color) colorize(g, 0xffffff);
    if (!g.attributes.normal) g.computeVertexNormals();
  }
  const merged = mergeGeometries(prepared, false);
  merged.computeBoundingSphere();
  const mat = material || new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: flat });
  const mesh = new THREE.Mesh(merged, mat);
  return mesh;
}

/** Collect instance transforms, then build an InstancedMesh. */
export class Instancer {
  constructor(geo, mat, { colors = false } = {}) {
    this.geo = geo;
    this.mat = mat;
    this.items = [];
    this.useColors = colors;
  }
  add(pos, rotY = 0, scale = 1, color = null, rot = null) {
    this.items.push({ pos: pos.clone ? pos.clone() : new THREE.Vector3(pos[0], pos[1], pos[2]), rotY, scale, color, rot });
    return this;
  }
  build(name = '') {
    const n = this.items.length;
    const mesh = new THREE.InstancedMesh(this.geo, this.mat, Math.max(1, n));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const e = new THREE.Euler();
    for (let i = 0; i < n; i++) {
      const it = this.items[i];
      if (it.rot) e.set(it.rot[0], it.rot[1], it.rot[2]);
      else e.set(0, it.rotY, 0);
      q.setFromEuler(e);
      if (typeof it.scale === 'number') sc.setScalar(it.scale);
      else sc.set(it.scale[0], it.scale[1], it.scale[2]);
      m.compose(it.pos, q, sc);
      mesh.setMatrixAt(i, m);
      if (this.useColors) mesh.setColorAt(i, new THREE.Color(it.color ?? 0xffffff));
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.name = name;
    mesh.frustumCulled = false;
    return mesh;
  }
}

/** Canvas text/graphic texture. draw(ctx, w, h) paints; returns a CanvasTexture. */
export function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function bannerTexture(text, { w = 1024, h = 256, bg = '#14202e', fg = '#ffffff', accent = '#ffd23f', font = '900 150px system-ui, -apple-system, Segoe UI, sans-serif', chequer = false } = {}) {
  return canvasTexture(w, h, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    if (chequer) {
      const n = 32;
      const sz = w / n;
      for (let y = 0; y < h / sz; y++) for (let x = 0; x < n; x++) if ((x + y) % 2 === 0) { g.fillStyle = '#111'; g.fillRect(x * sz, y * sz, sz, sz); } else { g.fillStyle = '#fff'; g.fillRect(x * sz, y * sz, sz, sz); }
      g.fillStyle = bg;
      g.fillRect(w * 0.18, h * 0.18, w * 0.64, h * 0.64);
    }
    g.fillStyle = accent;
    g.fillRect(0, h - 18, w, 18);
    g.fillRect(0, 0, w, 18);
    g.fillStyle = fg;
    g.font = font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2 + 6, w * 0.92);
  });
}

/** Points along a hanging cable between a and b with sag (metres). */
export function catenary(a, b, sag, n = 12) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = new THREE.Vector3().lerpVectors(a, b, t);
    p.y -= sag * 4 * t * (1 - t);
    pts.push(p);
  }
  return pts;
}

/** Deterministic scenery RNG (separate from the race seed: the world always looks the same). */
export function sceneryRng(seed = 20240607) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, range: (lo, hi) => lo + (hi - lo) * next(), int: (lo, hi) => Math.floor(lo + (hi - lo + 1) * next()), pick: (arr) => arr[Math.floor(next() * arr.length)], chance: (p) => next() < p };
}
