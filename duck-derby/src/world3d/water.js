// Stylised animated water: one ribbon mesh that follows the course (banked in
// the turns, falling over the weir, choppy in the rapids) plus open-water
// sheets for the sea, all sharing a procedural toon-water shader (no textures):
// thin bright cell-edge lines drifting with the flow, a turquoise shallow band
// along the banks, fresnel sky tint, small dense sun twinkles, two thin
// animated shoreline foam lines (distance to the bank is evaluated per
// fragment), cellular churn clumps in white water and a ribbed white sheet down
// the weir face with a dark crest line. Inside the flume tunnel the water is
// tinted dark by position (on top of the camera-driven `darkness` uniform). In
// the harbour the ribbon's sea-side columns blend into the open-sea sheet's
// parameterisation so the two meshes meet without a visible seam.
import * as THREE from 'three';
import { PAL } from './gfx.js';
import { profileAt, shorelineAt, SEA_LEVEL } from './terrain.js';
import { CANYON_FALLS } from './cliffs.js';
import { getCourse } from './course.js';
import { WATER_BANK, bankLat } from './track.js';
import { clamp, smoothstep, lerp } from '../rng.js';

const NOISE_GLSL = /* glsl */ `
  float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float vnoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    float a = hash21(i), b = hash21(i + vec2(1.0, 0.0)), c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }
`;

const NO_BANK = 1e4; // aBank value for open water (no shoreline on that side)

export function makeWaterMaterial(opts = {}) {
  const F = getCourse().features;
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      time: { value: 0 },
      deep: { value: new THREE.Color(PAL.waterDeep) },
      shallow: { value: new THREE.Color(PAL.waterShallow) },
      foamCol: { value: new THREE.Color(PAL.waterFoam) },
      foamShadow: { value: new THREE.Color(0xcfe6f0) },
      skyCol: { value: new THREE.Color(PAL.waterSky) },
      tunnelCol: { value: new THREE.Color(PAL.waterTunnel) },
      sunDir: { value: PAL.sunDir.clone() },
      sunCol: { value: new THREE.Color(PAL.sun) },
      tunnelS: { value: new THREE.Vector2(F.tunnelInS, F.tunnelOutS) },
      darkness: { value: 0 },
    },
  ]);
  const build = (defines) => new THREE.ShaderMaterial({
    defines,
    uniforms, // shared object: main.js drives time/darkness on the base material and every variant follows
    fog: true,
    extensions: { derivatives: true }, // fwidth() on WebGL1; built in on WebGL2
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      attribute vec2 aSL;   // (distance along course, lateral offset; + = left) -- pattern coordinates
      attribute vec4 aFx;   // (churn foam, chop, weir curtain, weir crest line)
      attribute vec2 aBank; // lateral distance to the nominal shoreline (left, right) for this row
      uniform float time;
      varying vec2 vSL;
      varying vec4 vFx;
      varying vec2 vBank;
      varying vec3 vWorld;
      void main() {
        vec3 p = position;
        float chop = aFx.y;
        // open water (no shoreline either side: the sea sheet and the ribbon columns blended into it) only
        // ripples gently, so the coarse sea grid and the fine ribbon never disagree by more than a few cm
        float open = step(5000.0, aBank.x) * step(5000.0, aBank.y);
        float amp = (0.05 + chop * 0.22) * (1.0 - 0.7 * open);
        p.y += sin(aSL.x * 0.35 - time * 2.4 + aSL.y * 0.31) * amp + sin(aSL.x * 0.93 - time * 4.3 - aSL.y * 0.77) * amp * 0.55
             + sin(aSL.y * 1.7 + time * 3.1 + aSL.x * 0.21) * amp * 0.35;
        vec4 world = modelMatrix * vec4(p, 1.0);
        vWorld = world.xyz;
        vSL = aSL;
        vFx = aFx;
        vBank = aBank;
        vec4 mvPosition = viewMatrix * world;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      ${NOISE_GLSL}
      uniform float time;
      uniform vec3 deep, shallow, foamCol, foamShadow, skyCol, tunnelCol, sunDir, sunCol;
      uniform vec2 tunnelS;
      uniform float darkness;
      varying vec2 vSL;
      varying vec4 vFx;
      varying vec2 vBank;
      varying vec3 vWorld;
      void main() {
        float s = vSL.x;
        float lat = vSL.y;
        float foamAmt = vFx.x;
        float chop = vFx.y;
        float curtain = vFx.z;
        float crest = vFx.w;
        float edge = max(lat >= 0.0 ? vBank.x - lat : vBank.y + lat, 0.0); // metres to this side's shoreline
        vec3 toCam = cameraPosition - vWorld;
        float camDist = length(toCam);
        vec3 viewDir = toCam / max(camDist, 1e-3);
        float nearK = (0.4 + 0.6 * smoothstep(2.0, 10.0, camDist)) * (1.0 - 0.35 * smoothstep(60.0, 220.0, camDist)); // big octaves calm right under the camera, everything settles far off
        float flow = time * (2.5 + chop * 7.0); // calm reaches drift, white water races
        vec2 q = vec2(s - flow, lat);
        vec2 dSL = fwidth(vSL); // pixel footprint in pattern space (taken here, in uniform control flow, for AA inside the branches below)
        #ifdef SEA
        float tun = 0.0;
        #else
        // inside the flume tunnel (by position, soft edges)
        float tun = smoothstep(tunnelS.x - 2.0, tunnelS.x + 8.0, s) * (1.0 - smoothstep(tunnelS.y - 8.0, tunnelS.y + 2.0, s));
        #endif
        // toon cells: three octaves of drifting value noise drawn as thin bright iso-lines (derivative anti-aliased,
        // so toward the horizon they thin out and settle instead of smearing into stripes)
        vec2 f1 = vec2(0.25, 0.52);
        vec2 f2 = vec2(0.7, 1.3);
        vec2 f3 = vec2(2.2, 3.4);
        vec2 drift = vec2(time * 0.5, -time * 0.27);
        float n1 = vnoise(q * f1 + vec2(0.0, time * 0.11));
        float n2 = vnoise(q * f2 + drift);
        float a1 = fwidth(n1) * 1.2;
        float a2 = fwidth(n2) * 1.2;
        float line1 = (1.0 - smoothstep(0.022, 0.034 + a1, abs(n1 - 0.5))) * clamp(0.06 / (a1 + 1e-4), 0.0, 1.0);
        float line2 = (1.0 - smoothstep(0.018, 0.03 + a2, abs(n2 - 0.55))) * clamp(0.05 / (a2 + 1e-4), 0.0, 1.0);
        #ifdef LOWQ
        float n3 = n2;
        float a3 = a2;
        float lines = (line1 * 0.11 + line2 * 0.07) * nearK;
        #else
        float n3 = vnoise(q * f3 - drift * 1.7);
        float a3 = fwidth(n3) * 1.2;
        float line3 = (1.0 - smoothstep(0.03, 0.046 + a3, abs(n3 - 0.5))) * clamp(0.035 / (a3 + 1e-4), 0.0, 1.0);
        float lines = (line1 * 0.11 + line2 * 0.07) * nearK + line3 * 0.05 * sqrt(nearK);
        #endif
        // fake normals from the noise gradients: the middle octave drives the fresnel, the fine one the sun glints
        #ifdef LOWQ
        vec3 nrm = normalize(vec3((n2 - 0.5) * (0.3 + 0.6 * chop), 1.0, (n1 - 0.5) * (0.3 + 0.6 * chop)));
        vec3 nrmF = nrm;
        #else
        float e = 0.4;
        float gx = vnoise((q + vec2(e, 0.0)) * f2 + drift) - n2;
        float gz = vnoise((q + vec2(0.0, e)) * f2 + drift) - n2;
        vec3 nrm = normalize(vec3(gx * (0.3 + 0.6 * chop), 1.0, gz * (0.3 + 0.6 * chop)));
        float ef = 0.12;
        float hx = vnoise((q + vec2(ef, 0.0)) * f3 - drift * 1.7) - n3;
        float hz = vnoise((q + vec2(0.0, ef)) * f3 - drift * 1.7) - n3;
        // far away the fine octave is sub-pixel: fall back to the middle one there (no shimmering noise)
        vec3 nrmF = normalize(mix(nrm, normalize(vec3(hx * (0.4 + 0.5 * chop), 1.0, hz * (0.4 + 0.5 * chop))), 1.0 - smoothstep(0.25, 0.6, a3 * 8.0)));
        #endif
        // base colour: turquoise band along the banks, deep blue mid-channel
        float shallowMix = 1.0 - smoothstep(0.0, 6.5, edge);
        vec3 col = mix(deep, shallow, 0.08 + 0.6 * shallowMix);
        col += vec3(lines) * (0.8 + 0.6 * chop) * (1.0 - 0.7 * tun);
        // macro variation (fake cloud shadows) so big sheets seen from above are not one flat tone
        col *= 0.92 + 0.08 * vnoise(vWorld.xz * 0.015 + time * 0.01);
        col = mix(col, tunnelCol, tun * 0.9);
        // --- foam (the open-sea variant has none; elsewhere each part only runs where its input is present --
        // the branches are coherent over large screen areas, and their anti-aliasing widths come from dSL above)
        float foam = 0.0;
        float c2 = 0.5;
        #ifndef SEA
        if (edge < 8.0) {
          // shoreline: two thin animated lines with noise break-up
          float w1 = 0.25 + 0.1 * sin(s * 0.8 + time * 1.5);
          float w2 = 0.9 + 0.3 * sin(s * 0.4 - time * 1.2);
          float ea = min(dSL.y, 0.25);
          float l1 = 1.0 - smoothstep(0.1, 0.14 + ea, abs(edge - w1));
          float l2 = 1.0 - smoothstep(0.08, 0.12 + ea, abs(edge - w2));
          float b1 = smoothstep(0.28, 0.5, vnoise(vec2(s * 0.6 - time * 0.5, lat * 0.25)));
          #ifdef LOWQ
          float b2 = b1;
          #else
          float b2 = smoothstep(0.4, 0.68, vnoise(vec2(s * 0.33 + time * 0.35, lat * 0.25 + 3.0)));
          #endif
          foam = max(l1 * b1, l2 * b2 * 0.7) * (1.0 - tun);
        }
        if (foamAmt > 0.02) {
          // churned white water: cellular clumps -- two thresholded noise layers (union, not sum) at a mild 1:2
          // stretch along the flow; more foam lowers the threshold until the sheet is nearly solid
          float c1 = vnoise(vec2(s * 0.7 - flow * 0.8, lat * 1.3));
          #ifdef LOWQ
          c2 = c1;
          float clump = 1.0;
          #else
          c2 = vnoise(vec2(s * 1.2 - flow * 1.25 + 9.0, lat * 2.2 + 4.0));
          float clump = 0.8 + 0.45 * vnoise(vec2(s * 0.12 - flow * 0.25, lat * 0.3));
          #endif
          float cn = max(c1, c2 * 0.92) * clump;
          float ca = dot(dSL, vec2(0.7, 1.3)) * 0.6;
          float thr = 1.03 - foamAmt * 0.82;
          float churn = smoothstep(thr - 0.04, thr + 0.04 + ca, cn) * smoothstep(0.02, 0.08, foamAmt) * (0.7 + 0.3 * smoothstep(1.5, 8.0, camDist));
          foam = max(foam, churn * 0.85);
        }
        vec3 foamShade = mix(foamShadow, foamCol, clamp(0.4 + 0.75 * c2, 0.0, 1.0));
        col = mix(col, foamShade, foam);
        col = mix(col, shallow, foamAmt * 0.25 * (1.0 - foam)); // aerated water reads lighter between clumps
        if (max(curtain, crest) > 0.02) {
          // weir face: a solid white sheet with a few wide vertical ribs, grading to the aerated turquoise between
          // them, plus a dark line along the crest so the lip reads from upstream
          float rib = smoothstep(0.35, 0.65, vnoise(vec2(lat * 0.6, s * 0.2 - time * 2.5)));
          float cur = smoothstep(0.05, 0.5, curtain);
          col = mix(col, mix(shallow, foamCol, 0.62 + 0.38 * rib), cur);
          col = mix(col, deep * 0.6, smoothstep(0.02, 0.12, crest) * crest * 0.85);
          foam = max(foam, cur);
        }
        #endif
        // fresnel sky tint + small dense sun twinkles (fine-octave normal, faded near the lens and toward the horizon)
        float fres = pow(1.0 - max(dot(nrm, viewDir), 0.0), 5.0);
        col = mix(col, skyCol, clamp(fres, 0.0, 1.0) * 0.45 * (1.0 - tun) * (1.0 - 0.6 * foam));
        vec3 hv = normalize(viewDir + normalize(sunDir));
        float spec = pow(max(dot(nrmF, hv), 0.0), 400.0) * (0.55 + 0.9 * n2);
        float twinkle = smoothstep(0.4, 0.48, spec) * (1.0 - smoothstep(0.25, 0.6, a2 * 8.0)) * smoothstep(1.5, 6.0, camDist);
        col += sunCol * twinkle * 0.9 * (1.0 - tun);
        col *= 1.0 - darkness * 0.8;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const baseDefines = opts.low ? { LOWQ: 1 } : {};
  const mat = build(baseDefines);
  /** Trivial open-sea variant (no shoreline / churn / weir / tunnel work) sharing this material's uniforms. */
  let seaMat = null;
  mat.userData.seaVariant = () => (seaMat = seaMat || build({ ...baseDefines, SEA: 1 }));
  return mat;
}

/**
 * Open-sea pattern parameterisation: the finish line's track frame extended over the whole plane, so through
 * the harbour it is (very nearly) the ribbon's own (s, lateral) and blending between the two warps nothing.
 */
let _seaFrame = null;
function seaFrame() {
  if (!_seaFrame) {
    const c = getCourse();
    const p = c.at(c.length);
    _seaFrame = { x: p.x, z: p.z, tx: p.tx, tz: p.tz, nx: p.nx, nz: p.nz, s: c.length };
  }
  return _seaFrame;
}
const seaPatS = (x, z) => { const f = seaFrame(); return f.s + (x - f.x) * f.tx + (z - f.z) * f.tz; };
const seaPatL = (x, z) => { const f = seaFrame(); return (x - f.x) * f.nx + (z - f.z) * f.nz; };
const SEA_Y = SEA_LEVEL - 0.1; // the sea sheet sits a touch under the ribbon so the two never z-fight where they overlap

/**
 * Build the river ribbon. Cross-sections every `step` metres from before the
 * marina basin to well beyond the harbour run-out (its far end is always deep
 * in the fog), wide enough per side to tuck under the banks (per-side visual
 * widths from the terrain profile). Through the harbour the sea-side columns
 * blend into the sea sheet's parameterisation, height and chop so the pattern
 * runs across the seam unchanged.
 */
export function buildRiver(course, material, { step = 2, across = 14, chunks = 8 } = {}) {
  const F = course.features;
  const s0 = F.minS - 70;
  const s1 = F.maxS + 520;
  // row stations: every `step` m, but every 0.4 m over the weir so the sheet is smooth (and sparse far out to sea)
  const stations = [];
  for (let s = s0; s <= s1; s += (s > F.dropLipS - 6 && s < F.dropLandS + 6 ? 0.4 : s > F.maxS + 40 ? step * 3 : step)) stations.push(s);
  const rows = stations.length;
  const cols = across + 1;
  const pos = new Float32Array(rows * cols * 3);
  const aSL = new Float32Array(rows * cols * 2);
  const aFx = new Float32Array(rows * cols * 4);
  const aBank = new Float32Array(rows * cols * 2);
  const tmp = {};
  for (let r = 0; r < rows; r++) {
    const s = stations[r];
    const prof = profileAt(course, clamp(s, F.minS, F.maxS));
    const p = course.at(s, tmp);
    const latL = prof.visL + 3.5;
    const latR = prof.visR + 3.5;
    // nominal shoreline per side (the harbour's sea side has none)
    const shoreL = prof.harbor > 0.6 ? NO_BANK : shorelineAt(course, prof, 1);
    const shoreR = shorelineAt(course, prof, -1);
    const seaRow = smoothstep(0.6, 0.95, prof.harbor); // rows whose left side is open sea
    // foam & chop along the course
    const dropFace = smoothstep(F.dropLipS - 1.5, F.dropLipS + 0.5, s) * (1 - smoothstep(F.dropLipS + 4, F.dropLipS + 8, s));
    const pool = smoothstep(F.dropLipS + 2, F.dropLipS + 6, s) * (1 - smoothstep(F.dropLandS + 2, F.dropLandS + 26, s));
    const curtain = smoothstep(F.dropLipS - 0.4, F.dropLipS + 0.5, s) * (1 - smoothstep(F.dropLipS + 3.5, F.dropLipS + 7.5, s)); // the weir face itself
    const crest = 0.7 * Math.exp(-(((s - (F.dropLipS - 0.15)) / 0.38) ** 2)); // dark line along the lip
    const chop = 0.12 + prof.canyon * 0.25 + prof.rapids * 0.95 + prof.harbor * 0.3 + dropFace + pool * 0.6 + prof.tunnel * 0.3;
    const foamBase = prof.rapids * 0.3 + dropFace * 0.95 + pool * 0.55 + prof.lily * 0.03;
    for (let c = 0; c < cols; c++) {
      const u = c / across; // 0 = right bank, 1 = left bank
      // bias samples toward the channel so the racing line gets more vertices
      const w = u * 2 - 1; // -1..1
      const shaped = Math.sign(w) * Math.pow(Math.abs(w), 1.35);
      const lat = shaped >= 0 ? shaped * latL : -shaped * -latR;
      const k = r * cols + c;
      const x = p.x + p.nx * lat;
      const z = p.z + p.nz * lat;
      let y = p.y - bankLat(lat, prof.half * 2) * Math.tan(p.bank) * WATER_BANK - 0.02;
      // white water boiling at the foot of the canyon waterfalls
      let fallFoam = 0;
      for (const fl of CANYON_FALLS) {
        const ds = (s - fl.s) / (fl.w * 0.5 + 2.5);
        const dl = (lat - fl.side * ((fl.side > 0 ? prof.visL : prof.visR) - 1.2)) / 2.0;
        fallFoam = Math.max(fallFoam, 0.9 * Math.exp(-(ds * ds + dl * dl)));
      }
      let patS = s;
      let patL = lat;
      let foamV = Math.min(0.95, foamBase + fallFoam);
      let chopV = Math.min(1.6, chop + fallFoam * 0.8);
      let bankL = shoreL;
      let bankR = shoreR;
      // harbour, sea side: blend everything toward the sea sheet over the outer columns (open water anyway);
      // far beyond the run-out (no land either side any more) the whole width becomes open sea
      const tail = smoothstep(F.maxS + 90, F.maxS + 150, s);
      const sea = Math.max(tail, lat > 0 ? seaRow * smoothstep(prof.half + 6, latL - 5, lat) : 0);
      if (sea > 0) {
        patS = lerp(s, seaPatS(x, z), sea);
        patL = lerp(lat, seaPatL(x, z), sea);
        y = lerp(y, SEA_Y + 0.08, sea);
        chopV = lerp(chopV, 0.45, sea);
        foamV *= 1 - sea;
        bankL = NO_BANK; // pattern-space "lat" is no longer a lateral distance: treat these columns as open water
        bankR = NO_BANK;
      }
      pos[k * 3] = x;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = z;
      aSL[k * 2] = patS;
      aSL[k * 2 + 1] = patL;
      aFx[k * 4] = foamV;
      aFx[k * 4 + 1] = chopV;
      aFx[k * 4 + 2] = curtain;
      aFx[k * 4 + 3] = crest;
      aBank[k * 2] = bankL;
      aBank[k * 2 + 1] = bankR;
    }
  }
  // emit the ribbon as `chunks` meshes over consecutive row ranges (sharing the boundary row) so the renderer
  // can frustum-cull the stretches behind the camera; all share the one material
  const group = new THREE.Group();
  group.name = 'river';
  const per = Math.ceil((rows - 1) / chunks);
  for (let ci = 0; ci < chunks; ci++) {
    const r0 = ci * per;
    const r1 = Math.min(rows - 1, r0 + per);
    if (r1 <= r0) break;
    const n = (r1 - r0 + 1) * cols;
    const off = r0 * cols;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.slice(off * 3, (off + n) * 3), 3));
    geo.setAttribute('aSL', new THREE.BufferAttribute(aSL.slice(off * 2, (off + n) * 2), 2));
    geo.setAttribute('aFx', new THREE.BufferAttribute(aFx.slice(off * 4, (off + n) * 4), 4));
    geo.setAttribute('aBank', new THREE.BufferAttribute(aBank.slice(off * 2, (off + n) * 2), 2));
    const idx = [];
    for (let r = 0; r < r1 - r0; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a0 = r * cols + c;
        const b0 = a0 + 1;
        const d0 = a0 + cols;
        const e0 = d0 + 1;
        idx.push(a0, d0, b0, b0, d0, e0);
      }
    }
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    geo.boundingBox.min.y -= 0.5; // vertex waves
    geo.boundingBox.max.y += 0.5;
    geo.boundingSphere.radius += 0.5;
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = 'river-chunk';
    mesh.renderOrder = 10; // after the opaque scenery, so most water fragments fail the depth test early
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
  }
  group.matrixAutoUpdate = false;
  group.updateMatrix();
  return group;
}

/** Big open-water sheet (sea beyond the harbour) using the same shader. */
export function buildSea(material, { x0, x1, z0, z1, y = SEA_Y, cell = 24 } = {}) {
  const nx = Math.ceil((x1 - x0) / cell) + 1;
  const nz = Math.ceil((z1 - z0) / cell) + 1;
  const pos = new Float32Array(nx * nz * 3);
  const aSL = new Float32Array(nx * nz * 2);
  const aFx = new Float32Array(nx * nz * 4);
  const aBank = new Float32Array(nx * nz * 2);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = x0 + i * cell;
      const z = z0 + j * cell;
      pos[k * 3] = x;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = z;
      aSL[k * 2] = seaPatS(x, z);
      aSL[k * 2 + 1] = seaPatL(x, z);
      aFx[k * 4] = 0;
      aFx[k * 4 + 1] = 0.45;
      aFx[k * 4 + 2] = 0;
      aFx[k * 4 + 3] = 0;
      aBank[k * 2] = NO_BANK;
      aBank[k * 2 + 1] = NO_BANK;
    }
  }
  const idx = [];
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) { const a = j * nx + i; idx.push(a, a + nx, a + 1, a + 1, a + nx, a + nx + 1); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSL', new THREE.BufferAttribute(aSL, 2));
  geo.setAttribute('aFx', new THREE.BufferAttribute(aFx, 4));
  geo.setAttribute('aBank', new THREE.BufferAttribute(aBank, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, material.userData && material.userData.seaVariant ? material.userData.seaVariant() : material);
  mesh.name = 'sea';
  mesh.renderOrder = 10;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

/** Vertical falling-water sheet material (waterfalls on cliffs, weir curtain): reads as a white sheet with streaks. */
export function makeFallMaterial() {
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { time: { value: 0 }, col: { value: new THREE.Color(PAL.waterShallow).lerp(new THREE.Color(PAL.waterFoam), 0.35) }, foamCol: { value: new THREE.Color(PAL.waterFoam) } }]);
  return new THREE.ShaderMaterial({
    uniforms,
    fog: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      ${NOISE_GLSL}
      uniform float time; uniform vec3 col, foamCol; varying vec2 vUv;
      void main() {
        // vUv.y: 0 at the foot, 1 at the lip
        float n = vnoise(vec2(vUv.x * 9.0, vUv.y * 3.0 + time * 3.2));
        float n2 = vnoise(vec2(vUv.x * 22.0, vUv.y * 8.0 + time * 5.0));
        float streak = smoothstep(0.45, 0.7, n * 0.7 + n2 * 0.5);
        float lip = smoothstep(0.0, 0.2, 1.0 - vUv.y); // smooth glassy water going over the lip, whitening as it falls
        vec3 c = mix(col, foamCol, streak * (0.35 + 0.65 * lip));
        float edge = smoothstep(0.0, 0.2, vUv.x) * smoothstep(0.0, 0.2, 1.0 - vUv.x);
        float alpha = (0.55 + 0.25 * lip + 0.15 * streak) * edge * smoothstep(0.0, 0.15, vUv.y) * (0.75 + 0.25 * smoothstep(0.0, 0.06, 1.0 - vUv.y));
        gl_FragColor = vec4(c, alpha);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}
