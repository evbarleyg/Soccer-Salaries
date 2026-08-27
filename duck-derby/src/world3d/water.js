// Stylised animated water: one ribbon mesh that follows the course (banked in
// the turns, falling over the weir, choppy in the rapids) plus open-water
// sheets for the sea, all sharing a procedural toon-water shader (no textures):
// thin bright cell-edge lines drifting with the flow, a turquoise shallow band
// along the banks, fresnel sky tint, thresholded sun twinkles, two thin
// animated shoreline foam lines (distance to the bank is evaluated per
// fragment), flow-stretched churn streaks in white water and a solid curtain
// down the weir face. Inside the flume tunnel the water is tinted dark by
// position (on top of the camera-driven `darkness` uniform).
import * as THREE from 'three';
import { PAL } from './gfx.js';
import { profileAt, shorelineAt, SEA_LEVEL } from './terrain.js';
import { CANYON_FALLS } from './cliffs.js';
import { getCourse } from './course.js';
import { WATER_BANK, bankLat } from './track.js';
import { clamp, smoothstep } from '../rng.js';

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
  const mat = new THREE.ShaderMaterial({
    defines: opts.low ? { LOWQ: 1 } : {},
    uniforms,
    fog: true,
    extensions: { derivatives: true }, // fwidth() on WebGL1; built in on WebGL2
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      attribute vec2 aSL;   // (distance along course, lateral offset; + = left)
      attribute vec3 aFx;   // (churn foam, chop, weir curtain)
      attribute vec2 aBank; // lateral distance to the nominal shoreline (left, right) for this row
      uniform float time;
      varying vec2 vSL;
      varying vec3 vFx;
      varying vec2 vBank;
      varying vec3 vWorld;
      void main() {
        vec3 p = position;
        float chop = aFx.y;
        float amp = 0.05 + chop * 0.22;
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
      varying vec3 vFx;
      varying vec2 vBank;
      varying vec3 vWorld;
      void main() {
        float s = vSL.x;
        float lat = vSL.y;
        float foamAmt = vFx.x;
        float chop = vFx.y;
        float curtain = vFx.z;
        float edge = max(lat >= 0.0 ? vBank.x - lat : vBank.y + lat, 0.0); // metres to this side's shoreline
        vec3 viewDir = normalize(cameraPosition - vWorld);
        float flow = time * (2.5 + chop * 7.0); // calm reaches drift, white water races
        vec2 q = vec2(s - flow, lat);
        // toon cells: two octaves of drifting value noise drawn as thin bright iso-lines (derivative anti-aliased,
        // so toward the horizon they thin out and settle instead of smearing into stripes)
        vec2 f1 = vec2(0.25, 0.52);
        vec2 f2 = vec2(0.7, 1.3);
        vec2 drift = vec2(time * 0.5, -time * 0.27);
        float n1 = vnoise(q * f1 + vec2(0.0, time * 0.11));
        float n2 = vnoise(q * f2 + drift);
        float a1 = fwidth(n1) * 1.2;
        float a2 = fwidth(n2) * 1.2;
        float line1 = (1.0 - smoothstep(0.022, 0.034 + a1, abs(n1 - 0.5))) * clamp(0.06 / (a1 + 1e-4), 0.0, 1.0);
        float line2 = (1.0 - smoothstep(0.018, 0.03 + a2, abs(n2 - 0.55))) * clamp(0.05 / (a2 + 1e-4), 0.0, 1.0);
        float lines = line1 * 0.16 + line2 * 0.07;
        // fake normal from the fine octave's gradient for fresnel / glints
        #ifdef LOWQ
        vec3 nrm = normalize(vec3((n2 - 0.5) * (0.3 + 0.6 * chop), 1.0, (n1 - 0.5) * (0.3 + 0.6 * chop)));
        #else
        float e = 0.4;
        float gx = vnoise((q + vec2(e, 0.0)) * f2 + drift) - n2;
        float gz = vnoise((q + vec2(0.0, e)) * f2 + drift) - n2;
        vec3 nrm = normalize(vec3(gx * (0.3 + 0.6 * chop), 1.0, gz * (0.3 + 0.6 * chop)));
        #endif
        // base colour: turquoise band along the banks, deep blue mid-channel
        float shallowMix = 1.0 - smoothstep(0.0, 6.5, edge);
        vec3 col = mix(deep, shallow, 0.08 + 0.6 * shallowMix + 0.1 * n1);
        col += vec3(lines) * (0.8 + 0.6 * chop);
        // inside the flume tunnel (by position, soft edges)
        float tun = smoothstep(tunnelS.x - 2.0, tunnelS.x + 8.0, s) * (1.0 - smoothstep(tunnelS.y - 8.0, tunnelS.y + 2.0, s));
        col = mix(col, tunnelCol, tun * 0.82);
        // --- foam
        // shoreline: two thin animated lines with noise break-up
        float w1 = 0.25 + 0.1 * sin(s * 0.8 + time * 1.5);
        float w2 = 0.9 + 0.3 * sin(s * 0.4 - time * 1.2);
        float ea = min(fwidth(edge), 0.25); // (clamped: the left/right switch at the centre line is a false edge)
        float l1 = 1.0 - smoothstep(0.1, 0.14 + ea, abs(edge - w1));
        float l2 = 1.0 - smoothstep(0.08, 0.12 + ea, abs(edge - w2));
        float b1 = smoothstep(0.28, 0.5, vnoise(vec2(s * 0.6 - time * 0.5, lat * 0.25)));
        #ifdef LOWQ
        float b2 = b1;
        #else
        float b2 = smoothstep(0.4, 0.68, vnoise(vec2(s * 0.33 + time * 0.35, lat * 0.25 + 3.0)));
        #endif
        float shore = max(l1 * b1, l2 * b2 * 0.7) * (1.0 - tun);
        // churned white water: streaks stretched along the flow, two layers at different speeds, clumped
        float c1 = vnoise(vec2(s * 0.36 - flow * 0.8, lat * 2.2));
        #ifdef LOWQ
        float c2 = c1;
        float clump = 1.0;
        #else
        float c2 = vnoise(vec2(s * 0.62 - flow * 1.3 + 9.0, lat * 3.1 + 4.0));
        float clump = 0.75 + 0.5 * vnoise(vec2(s * 0.12 - flow * 0.25, lat * 0.35));
        #endif
        float cn = (c1 * 0.6 + c2 * 0.52) * clump;
        float ca = fwidth(cn);
        float churn = smoothstep(1.0 - foamAmt, 1.1 - foamAmt + ca, cn) * step(0.02, foamAmt);
        // weir face: solid curtain that breaks into streaks down the pool
        float cur = clamp(curtain * 1.35 - 0.3 + 0.35 * vnoise(vec2(lat * 2.5, s * 1.5 - time * 6.0)), 0.0, 1.0) * step(0.02, curtain);
        float foam = clamp(max(max(shore, churn * 0.8), cur), 0.0, 1.0);
        vec3 foamShade = mix(foamShadow, foamCol, clamp(0.4 + 0.75 * c2, 0.0, 1.0));
        col = mix(col, foamShade, foam);
        col = mix(col, shallow, foamAmt * 0.25 * (1.0 - foam)); // aerated water reads lighter between streaks
        // fresnel sky tint + thresholded sun twinkles
        float fres = pow(1.0 - max(dot(nrm, viewDir), 0.0), 5.0);
        col = mix(col, skyCol, clamp(fres, 0.0, 1.0) * 0.45 * (1.0 - tun) * (1.0 - 0.6 * foam));
        vec3 hv = normalize(viewDir + normalize(sunDir));
        float spec = pow(max(dot(nrm, hv), 0.0), 120.0) * (0.55 + 0.9 * n2);
        float twinkle = smoothstep(0.4, 0.48, spec) * clamp(0.05 / (a2 + 1e-4), 0.0, 1.0);
        col += sunCol * twinkle * 0.9 * (1.0 - tun);
        col *= 1.0 - darkness * 0.72;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  return mat;
}

/**
 * Build the river ribbon. Cross-sections every `step` metres from before the
 * marina basin to beyond the harbour run-out, wide enough per side to tuck
 * under the banks (per-side visual widths from the terrain profile).
 */
export function buildRiver(course, material, { step = 2, across = 14 } = {}) {
  const F = course.features;
  const s0 = F.minS - 70;
  const s1 = F.maxS + 160;
  // row stations: every `step` m, but every 0.4 m over the weir so the sheet is smooth
  const stations = [];
  for (let s = s0; s <= s1; s += (s > F.dropLipS - 6 && s < F.dropLandS + 6 ? 0.4 : step)) stations.push(s);
  const rows = stations.length;
  const cols = across + 1;
  const pos = new Float32Array(rows * cols * 3);
  const aSL = new Float32Array(rows * cols * 2);
  const aFx = new Float32Array(rows * cols * 3);
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
    // foam & chop along the course
    const dropFace = smoothstep(F.dropLipS - 1.5, F.dropLipS + 0.5, s) * (1 - smoothstep(F.dropLipS + 4, F.dropLipS + 8, s));
    const pool = smoothstep(F.dropLipS + 2, F.dropLipS + 6, s) * (1 - smoothstep(F.dropLandS + 2, F.dropLandS + 26, s));
    const curtain = smoothstep(F.dropLipS - 0.4, F.dropLipS + 0.5, s) * (1 - smoothstep(F.dropLipS + 3.5, F.dropLipS + 16, s));
    const chop = 0.12 + prof.canyon * 0.25 + prof.rapids * 0.95 + prof.harbor * 0.3 + dropFace + pool * 0.6 + prof.tunnel * 0.3;
    const foamBase = prof.rapids * 0.3 + dropFace * 0.95 + pool * 0.55 + prof.lily * 0.03;
    for (let c = 0; c < cols; c++) {
      const u = c / across; // 0 = right bank, 1 = left bank
      // bias samples toward the channel so the racing line gets more vertices
      const w = u * 2 - 1; // -1..1
      const shaped = Math.sign(w) * Math.pow(Math.abs(w), 1.35);
      const lat = shaped >= 0 ? shaped * latL : -shaped * -latR;
      const k = r * cols + c;
      const y = p.y - bankLat(lat, prof.half * 2) * Math.tan(p.bank) * WATER_BANK - 0.02;
      pos[k * 3] = p.x + p.nx * lat;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = p.z + p.nz * lat;
      aSL[k * 2] = s;
      aSL[k * 2 + 1] = lat;
      // white water boiling at the foot of the canyon waterfalls
      let fallFoam = 0;
      for (const fl of CANYON_FALLS) {
        const ds = (s - fl.s) / (fl.w * 0.5 + 2.5);
        const dl = (lat - fl.side * ((fl.side > 0 ? prof.visL : prof.visR) - 1.2)) / 3.2;
        fallFoam = Math.max(fallFoam, 0.6 * Math.exp(-(ds * ds + dl * dl)));
      }
      aFx[k * 3] = Math.min(0.95, foamBase + fallFoam);
      aFx[k * 3 + 1] = Math.min(1.6, chop + fallFoam * 0.8);
      aFx[k * 3 + 2] = curtain;
      aBank[k * 2] = shoreL;
      aBank[k * 2 + 1] = shoreR;
    }
  }
  const idx = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSL', new THREE.BufferAttribute(aSL, 2));
  geo.setAttribute('aFx', new THREE.BufferAttribute(aFx, 3));
  geo.setAttribute('aBank', new THREE.BufferAttribute(aBank, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'river';
  mesh.frustumCulled = false; // it spans the world; culling per-chunk isn't worth it
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

/** Big open-water sheet (sea beyond the harbour) using the same shader. */
export function buildSea(material, { x0, x1, z0, z1, y = SEA_LEVEL - 0.06, cell = 12 } = {}) {
  const nx = Math.ceil((x1 - x0) / cell) + 1;
  const nz = Math.ceil((z1 - z0) / cell) + 1;
  const pos = new Float32Array(nx * nz * 3);
  const aSL = new Float32Array(nx * nz * 2);
  const aFx = new Float32Array(nx * nz * 3);
  const aBank = new Float32Array(nx * nz * 2);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = x0 + i * cell;
      const z = z0 + j * cell;
      pos[k * 3] = x;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = z;
      aSL[k * 2] = x * 0.8 - 4000; // far from the course's s range so the tunnel tint never applies
      aSL[k * 2 + 1] = z * 0.8;
      aFx[k * 3] = 0;
      aFx[k * 3 + 1] = 0.45;
      aFx[k * 3 + 2] = 0;
      aBank[k * 2] = NO_BANK;
      aBank[k * 2 + 1] = NO_BANK;
    }
  }
  const idx = [];
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) { const a = j * nx + i; idx.push(a, a + nx, a + 1, a + 1, a + nx, a + nx + 1); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSL', new THREE.BufferAttribute(aSL, 2));
  geo.setAttribute('aFx', new THREE.BufferAttribute(aFx, 3));
  geo.setAttribute('aBank', new THREE.BufferAttribute(aBank, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'sea';
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
        float n = vnoise(vec2(vUv.x * 9.0, vUv.y * 3.0 + time * 3.2));
        float n2 = vnoise(vec2(vUv.x * 22.0, vUv.y * 8.0 + time * 5.0));
        float streak = smoothstep(0.45, 0.7, n * 0.7 + n2 * 0.5);
        vec3 c = mix(col, foamCol, streak);
        float edge = smoothstep(0.0, 0.1, vUv.x) * smoothstep(0.0, 0.1, 1.0 - vUv.x);
        gl_FragColor = vec4(c, (0.8 + 0.15 * streak) * edge);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}
