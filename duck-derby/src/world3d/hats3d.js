// Sixteen procedural 3D hats, matched to the 2D catalogue ids in ../ducks.js.
// Each builder returns an Object3D positioned relative to the head centre
// (head radius ~0.3, +Z forward, +Y up, +X = duck's left). Parts that animate
// are exposed via userData: { spin } for the propeller.
import * as THREE from 'three';

const M = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0, ...o });
const shared = {
  black: M(0x161616, { roughness: 0.5 }),
  white: M(0xf7f4ec),
  gold: M(0xf2c230, { metalness: 0.65, roughness: 0.32, emissive: 0x3a2800, emissiveIntensity: 0.25 }),
  silver: M(0xc9d1d9, { metalness: 0.7, roughness: 0.3 }),
  red: M(0xd93838),
  brown: M(0x7a4a22),
  tan: M(0xc8935a),
  pink: M(0xff6fae),
  purple: M(0x6b3fb8),
  blue: M(0x2f6fd6),
  green: M(0x3faa59),
  yellow: M(0xffd23f),
  glass: M(0x1b2330, { roughness: 0.15, metalness: 0.3 }),
  lens: M(0x88d8f0, { roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.55 }),
};
const HEAD_R = 0.3;

function mesh(geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.scale.set(sx, sy, sz);
  return m;
}
const G = {
  cyl: (rt, rb, h, seg = 20, open = false) => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open),
  cone: (r, h, seg = 20) => new THREE.ConeGeometry(r, h, seg),
  sphere: (r, ws = 16, hs = 12) => new THREE.SphereGeometry(r, ws, hs),
  hemi: (r, ws = 18, hs = 9) => new THREE.SphereGeometry(r, ws, hs, 0, Math.PI * 2, 0, Math.PI / 2),
  torus: (r, t, rs = 10, ts = 28, arc = Math.PI * 2) => new THREE.TorusGeometry(r, t, rs, ts, arc),
  box: (w, h, d) => new THREE.BoxGeometry(w, h, d),
};

const builders = {
  tophat() {
    const g = new THREE.Group();
    g.add(mesh(G.cyl(0.36, 0.36, 0.05, 24), shared.black, 0, 0.22, 0));
    g.add(mesh(G.cyl(0.25, 0.23, 0.5, 24), shared.black, 0, 0.49, 0));
    g.add(mesh(G.cyl(0.255, 0.245, 0.09, 24), shared.red, 0, 0.31, 0));
    g.rotation.z = -0.12;
    g.rotation.x = -0.1;
    return g;
  },
  crown() {
    const g = new THREE.Group();
    g.add(mesh(G.cyl(0.27, 0.25, 0.18, 24, true), shared.gold, 0, 0.3, 0));
    (g.children[0].material = shared.gold), (g.children[0].material.side = THREE.DoubleSide);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      g.add(mesh(G.cone(0.075, 0.17, 4), shared.gold, Math.cos(a) * 0.26, 0.47, Math.sin(a) * 0.26));
      const gem = mesh(G.sphere(0.035, 8, 6), i % 2 ? shared.red : shared.blue, Math.cos(a + 0.52) * 0.272, 0.32, Math.sin(a + 0.52) * 0.272);
      g.add(gem);
    }
    g.add(mesh(G.cyl(0.25, 0.25, 0.02, 24), shared.red, 0, 0.23, 0)); // velvet cap peeking through
    return g;
  },
  cowboy() {
    const g = new THREE.Group();
    const brim = mesh(G.cyl(0.52, 0.52, 0.03, 28), shared.tan, 0, 0.2, 0);
    // curl the brim: bend vertices up at the sides
    const p = brim.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      p.setY(i, p.getY(i) + Math.pow(Math.abs(x) / 0.52, 2.2) * 0.16);
    }
    p.needsUpdate = true;
    brim.geometry.computeVertexNormals();
    g.add(brim);
    const crown = mesh(G.cyl(0.2, 0.26, 0.3, 20), shared.tan, 0, 0.36, 0, 0, 0, 0, 1, 1, 1.15);
    g.add(crown);
    g.add(mesh(G.cyl(0.262, 0.262, 0.05, 20), shared.brown, 0, 0.25, 0, 0, 0, 0, 1, 1, 1.15));
    g.add(mesh(G.box(0.16, 0.04, 0.5), shared.tan, 0, 0.515, 0)); // pinch ridge
    return g;
  },
  viking() {
    const g = new THREE.Group();
    // helmet sits high and tipped back so the brow band never hides the eyes
    g.add(mesh(G.hemi(0.31), shared.silver, 0, 0.13, 0));
    g.add(mesh(G.torus(0.31, 0.032, 8, 28), shared.brown, 0, 0.135, 0, Math.PI / 2));
    g.add(mesh(G.box(0.045, 0.26, 0.045), shared.silver, 0, 0.27, 0.27, 0.42)); // nose guard stub up on the brow
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      g.add(mesh(G.sphere(0.022, 6, 4), shared.gold, Math.sin(a) * 0.325, 0.135, Math.cos(a) * 0.325)); // rivets
    }
    for (const side of [-1, 1]) {
      const horn = mesh(G.cone(0.075, 0.34, 12), shared.white, side * 0.36, 0.35, -0.02, 0, 0, -side * 0.7);
      g.add(horn);
      const tip = mesh(G.cone(0.04, 0.16, 12), shared.white, side * 0.5, 0.53, -0.02, 0, 0, -side * 0.15);
      g.add(tip);
    }
    g.rotation.x = -0.2;
    return g;
  },
  pirate() {
    const g = new THREE.Group();
    const band = mesh(G.sphere(0.315, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.42), shared.red, 0, 0.02, 0);
    band.rotation.x = -0.25;
    g.add(band);
    for (let i = 0; i < 7; i++) g.add(mesh(G.sphere(0.03, 6, 4), shared.white, Math.sin(i * 2.1) * 0.2, 0.2 + Math.cos(i * 1.7) * 0.06, Math.cos(i * 2.1) * 0.2)); // polka dots
    g.add(mesh(G.sphere(0.07, 8, 6), shared.red, 0.12, 0.05, -0.33)); // knot
    g.add(mesh(G.cone(0.06, 0.25, 8), shared.red, 0.2, -0.08, -0.4, -2.2, 0, -0.5));
    g.add(mesh(G.cone(0.05, 0.22, 8), shared.red, 0.08, -0.12, -0.42, -2.5, 0, 0.2));
    // eye patch on the duck's right eye + strap
    g.add(mesh(G.cyl(0.085, 0.085, 0.02, 14), shared.black, -0.19, 0.08, 0.235, 1.2, -0.5, 0));
    g.add(mesh(G.torus(0.305, 0.012, 6, 30), shared.black, 0, 0.08, 0, 1.25, 0, 0.35));
    return g;
  },
  shades() {
    const g = new THREE.Group();
    for (const side of [-1, 1]) {
      const lensM = mesh(G.sphere(0.1, 14, 10), shared.glass, side * 0.15, 0.06, 0.28, 0, 0, 0, 1, 0.85, 0.25);
      g.add(lensM);
      g.add(mesh(G.torus(0.1, 0.012, 6, 20), shared.gold, side * 0.15, 0.06, 0.3, 0, 0, 0, 1, 0.85, 1));
      g.add(mesh(G.cyl(0.01, 0.01, 0.34, 6), shared.gold, side * 0.27, 0.07, 0.12, Math.PI / 2, 0, 0));
    }
    g.add(mesh(G.cyl(0.012, 0.012, 0.1, 6), shared.gold, 0, 0.08, 0.305, 0, 0, Math.PI / 2));
    return g;
  },
  headband() {
    const g = new THREE.Group();
    g.add(mesh(G.torus(0.3, 0.045, 8, 30), shared.white, 0, 0.1, 0, Math.PI / 2 - 0.25, 0, 0));
    g.add(mesh(G.torus(0.302, 0.02, 6, 30), shared.red, 0, 0.1, 0, Math.PI / 2 - 0.25, 0, 0));
    // little sweat drops? keep it clean: a terry-cloth tab at the back
    g.add(mesh(G.box(0.12, 0.08, 0.04), shared.white, 0, 0.03, -0.31, -0.25));
    return g;
  },
  bow() {
    const g = new THREE.Group();
    for (const side of [-1, 1]) {
      const loop = mesh(G.sphere(0.16, 14, 10), shared.pink, side * 0.15, 0.32, -0.02, 0, 0, side * 0.5, 1, 0.75, 0.45);
      g.add(loop);
    }
    g.add(mesh(G.sphere(0.07, 10, 8), M(0xe0457f), 0, 0.31, 0));
    g.add(mesh(G.cone(0.06, 0.22, 8), shared.pink, 0.07, 0.14, -0.06, 0.3, 0, 2.6));
    g.add(mesh(G.cone(0.06, 0.22, 8), shared.pink, -0.07, 0.14, -0.06, 0.3, 0, -2.6));
    g.position.x = 0.06;
    return g;
  },
  propeller() {
    const g = new THREE.Group();
    const cols = [shared.red, shared.blue, shared.yellow, shared.green];
    for (let i = 0; i < 4; i++) {
      const wedge = new THREE.Mesh(new THREE.SphereGeometry(0.31, 8, 8, (i * Math.PI) / 2, Math.PI / 2, 0, Math.PI * 0.42), cols[i]);
      wedge.position.y = 0.04;
      g.add(wedge);
    }
    g.add(mesh(G.cyl(0.015, 0.015, 0.12, 6), shared.silver, 0, 0.4, 0));
    const spin = new THREE.Group();
    spin.position.y = 0.46;
    spin.add(mesh(G.box(0.42, 0.012, 0.07), shared.red, 0, 0, 0, 0, 0, 0.15));
    spin.add(mesh(G.box(0.07, 0.012, 0.42), shared.yellow, 0, 0, 0, 0.15, 0, 0));
    spin.add(mesh(G.sphere(0.03, 8, 6), shared.silver));
    g.add(spin);
    g.userData.spin = spin;
    return g;
  },
  snorkel() {
    const g = new THREE.Group();
    // mask
    g.add(mesh(G.box(0.46, 0.2, 0.06), M(0x20b7c9), 0, 0.07, 0.29));
    g.add(mesh(G.box(0.4, 0.15, 0.03), shared.lens, 0, 0.07, 0.325));
    g.add(mesh(G.torus(0.3, 0.02, 6, 30), M(0x20b7c9), 0, 0.07, 0, Math.PI / 2, 0, 0));
    // tube up the left side
    g.add(mesh(G.cyl(0.035, 0.035, 0.55, 10), M(0xff8a2a), 0.33, 0.3, 0.05, 0.15, 0, 0));
    g.add(mesh(G.torus(0.08, 0.035, 8, 12, Math.PI), M(0xff8a2a), 0.33, 0.02, 0.13, 0, Math.PI / 2, Math.PI));
    g.add(mesh(G.cyl(0.045, 0.045, 0.06, 10), M(0x333333), 0.33, 0.59, 0.09, 0.15, 0, 0));
    return g;
  },
  chef() {
    const g = new THREE.Group();
    g.add(mesh(G.cyl(0.26, 0.27, 0.22, 24), shared.white, 0, 0.32, 0));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      g.add(mesh(G.sphere(0.17, 12, 10), shared.white, Math.cos(a) * 0.15, 0.52, Math.sin(a) * 0.15));
    }
    g.add(mesh(G.sphere(0.19, 12, 10), shared.white, 0, 0.58, 0));
    return g;
  },
  wizard() {
    const g = new THREE.Group();
    g.add(mesh(G.cyl(0.44, 0.44, 0.025, 28), shared.purple, 0, 0.2, 0));
    const cone = mesh(G.cone(0.28, 0.75, 24), shared.purple, 0, 0.58, -0.02, -0.18, 0, 0.1);
    g.add(cone);
    for (let i = 0; i < 5; i++) {
      const a = i * 1.9;
      const y = 0.3 + i * 0.1;
      const r = 0.27 * (1 - (y - 0.2) / 0.78) + 0.012;
      g.add(mesh(new THREE.OctahedronGeometry(0.045), shared.yellow, Math.cos(a) * r, y, Math.sin(a) * r - 0.02 - (y - 0.2) * 0.15, 0, a, 0, 1, 1, 0.4));
    }
    g.add(mesh(G.sphere(0.04, 8, 6), shared.yellow, 0.02, 0.97, -0.17));
    return g;
  },
  party() {
    const g = new THREE.Group();
    const cone = mesh(G.cone(0.22, 0.55, 24), M(0x3d7be0), 0, 0.5, 0, -0.1, 0, 0.12);
    g.add(cone);
    for (let i = 0; i < 3; i++) g.add(mesh(G.torus(0.2 - i * 0.06, 0.018, 6, 24), i % 2 ? shared.yellow : shared.pink, 0.012 * i, 0.3 + i * 0.15, -0.01 * i, Math.PI / 2 - 0.1, 0.12, 0));
    g.add(mesh(G.sphere(0.06, 10, 8), shared.pink, 0.065, 0.79, -0.055));
    g.add(mesh(G.cyl(0.005, 0.005, 0.7, 4), shared.white, 0.02, -0.05, 0.05, 0.2, 0, 0.5)); // chin elastic
    return g;
  },
  flower() {
    const g = new THREE.Group();
    g.add(mesh(G.torus(0.29, 0.035, 6, 30), shared.green, 0, 0.16, 0, Math.PI / 2 - 0.15, 0, 0));
    const cols = [0xff6fae, 0xffd23f, 0xffffff, 0xff7a2f, 0xb18af0, 0x5ec8ff];
    const petalGeo = G.sphere(0.05, 7, 5);
    const centreGeo = G.sphere(0.032, 6, 5);
    const n = 11;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const c = M(cols[i % cols.length]);
      const y = 0.16 + Math.sin(a) * 0.045 * -1;
      const fx = Math.cos(a) * 0.31;
      const fz = Math.sin(a) * 0.31;
      // petals ring around the outward normal (radial), so every flower faces out from the head
      const rx = Math.cos(a);
      const rz = Math.sin(a);
      for (let k = 0; k < 5; k++) {
        const b = (k / 5) * Math.PI * 2;
        const t = Math.cos(b) * 0.052; // tangential offset
        const up = Math.sin(b) * 0.052; // vertical offset
        g.add(mesh(petalGeo, c, fx - rz * t, y + up, fz + rx * t, 0, -a, 0, 0.75, 1, 1));
      }
      g.add(mesh(centreGeo, i % 3 === 1 ? shared.white : shared.yellow, fx + rx * 0.03, y, fz + rz * 0.03));
    }
    // a few leaves tucked between flowers
    for (let i = 0; i < n; i++) {
      const a = ((i + 0.5) / n) * Math.PI * 2;
      g.add(mesh(G.sphere(0.045, 6, 4), shared.green, Math.cos(a) * 0.31, 0.15 - Math.sin(a) * 0.045, Math.sin(a) * 0.31, 0, -a, 0.5, 0.4, 1, 1.3));
    }
    return g;
  },
  headphones() {
    const g = new THREE.Group();
    g.add(mesh(G.torus(0.33, 0.03, 8, 24, Math.PI), shared.black, 0, 0.02, 0, 0, 0, 0));
    for (const side of [-1, 1]) {
      g.add(mesh(G.cyl(0.12, 0.12, 0.08, 18), shared.red, side * 0.33, 0.0, 0, 0, 0, Math.PI / 2));
      g.add(mesh(G.cyl(0.09, 0.09, 0.1, 18), shared.black, side * 0.3, 0.0, 0, 0, 0, Math.PI / 2));
    }
    return g;
  },
  helmet() {
    // jockey cap: quartered blue/yellow silks, white centre stripe from peak to nape, peak tipped down, strap at the back
    const g = new THREE.Group();
    const cy = 0.06;
    for (let q = 0; q < 4; q++) {
      const quad = new THREE.Mesh(new THREE.SphereGeometry(0.315, 8, 10, (q * Math.PI) / 2, Math.PI / 2, 0, Math.PI / 2), q % 2 ? shared.yellow : shared.blue);
      quad.position.y = cy;
      g.add(quad);
    }
    // centre stripe: thin open cylinder band bent over the crown (axis across the head)
    g.add(mesh(new THREE.CylinderGeometry(0.322, 0.322, 0.09, 24, 1, true, 0, Math.PI), shared.white, 0, cy, 0, 0, 0, Math.PI / 2));
    const visor = mesh(new THREE.CylinderGeometry(0.3, 0.4, 0.035, 24, 1, false, -Math.PI / 3, (Math.PI * 2) / 3), shared.blue, 0, cy + 0.01, 0.1, 0.34, 0, 0);
    g.add(visor);
    g.add(mesh(G.sphere(0.045, 8, 6), shared.white, 0, cy + 0.325, 0)); // button
    // elastic strap round the back of the cap, dipping toward the nape
    g.add(mesh(G.torus(0.318, 0.018, 6, 32, Math.PI), shared.black, 0, cy + 0.05, 0, -(Math.PI / 2 + 0.3), 0, 0));
    return g;
  },
};

/** Build hat `id`. Returns an Object3D to add at the head centre. */
export function buildHat(id) {
  const b = builders[id] || builders.tophat;
  const hat = b();
  hat.name = `hat-${id}`;
  // hats were modelled for a 0.3 m head; the duck's head is bigger now, so scale up and sit a touch higher
  hat.scale.multiplyScalar(1.15);
  hat.position.y += 0.03;
  hat.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = false;
      o.matrixAutoUpdate = true;
    }
  });
  return hat;
}
export const HAT_IDS = Object.keys(builders);
export { HEAD_R };
