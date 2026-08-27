// Stylised animated water: one ribbon mesh that follows the course (banked in
// the turns, falling over the weir, choppy in the rapids) plus open-water
// sheets for the sea, all sharing a procedural toon-water shader (no textures).
import * as THREE from 'three';
import { PAL } from './gfx.js';
import { profileAt, SEA_LEVEL } from './terrain.js';
import { WATER_BANK } from './track.js';
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

export function makeWaterMaterial() {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      time: { value: 0 },
      deep: { value: new THREE.Color(PAL.waterDeep) },
      shallow: { value: new THREE.Color(PAL.waterShallow) },
      foamCol: { value: new THREE.Color(PAL.waterFoam) },
      skyCol: { value: new THREE.Color(PAL.skyMid) },
      sunDir: { value: PAL.sunDir.clone() },
      sunCol: { value: new THREE.Color(PAL.sun) },
      darkness: { value: 0 },
    },
  ]);
  const mat = new THREE.ShaderMaterial({
    uniforms,
    fog: true,
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      attribute vec2 aSL;   // (distance along course, lateral offset)
      attribute vec3 aFx;   // (foam, chop, edge distance)
      uniform float time;
      varying vec2 vSL;
      varying vec3 vFx;
      varying vec3 vWorld;
      varying vec3 vView;
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
        vec4 mvPosition = viewMatrix * world;
        vView = -mvPosition.xyz;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      ${NOISE_GLSL}
      uniform float time;
      uniform vec3 deep, shallow, foamCol, skyCol, sunDir, sunCol;
      uniform float darkness;
      varying vec2 vSL;
      varying vec3 vFx;
      varying vec3 vWorld;
      varying vec3 vView;
      void main() {
        float foamAmt = vFx.x;
        float chop = vFx.y;
        float edge = vFx.z;           // metres to the nearest bank (large in open water)
        float flow = time * (5.5 + chop * 6.0);
        vec2 q = vec2(vSL.x - flow, vSL.y);
        // two octaves of drifting value noise -> soft cell pattern
        float n1 = vnoise(q * vec2(0.16, 0.42));
        float n2 = vnoise(q * vec2(0.41, 1.1) + vec2(time * 0.7, -time * 0.3));
        float n = n1 * 0.65 + n2 * 0.35;
        // fake normal from noise gradient for glints / fresnel
        float e = 0.35;
        float nx = vnoise((q + vec2(e, 0.0)) * vec2(0.41, 1.1)) - n2;
        float nz = vnoise((q + vec2(0.0, e)) * vec2(0.41, 1.1)) - n2;
        vec3 nrm = normalize(vec3(nx * (0.6 + chop), 1.0, nz * (0.6 + chop)));
        vec3 viewDir = normalize(cameraPosition - vWorld);
        // base colour: shallow band near banks, deep in the middle
        float shallowMix = 1.0 - smoothstep(0.0, 5.0, edge);
        vec3 col = mix(deep, shallow, 0.18 + 0.5 * shallowMix + 0.22 * n);
        // toon caustic streaks
        float streak = smoothstep(0.62, 0.68, n) * 0.16 + smoothstep(0.8, 0.82, n1) * 0.12;
        col += vec3(streak);
        // foam: edges, rapids, weir face
        float foamNoise = vnoise(vec2(vSL.x * 0.9 - flow * 1.8, vSL.y * 2.3)) * 0.6 + vnoise(vec2(vSL.x * 2.2 - flow * 3.1, vSL.y * 5.0)) * 0.4;
        float edgeFoam = (1.0 - smoothstep(0.15, 1.1, edge)) * 0.7;
        float f = clamp(foamAmt + edgeFoam, 0.0, 0.92);
        float foamMask = smoothstep(1.0 - f, 1.0 - f + 0.12, foamNoise) * step(0.02, f);
        col = mix(col, mix(col, foamCol, 0.88), clamp(foamMask, 0.0, 1.0));
        // brighten churned water a touch even between foam streaks
        col = mix(col, shallow, foamAmt * 0.25);
        // fresnel sky reflection + sun glint
        float fres = pow(1.0 - max(dot(nrm, viewDir), 0.0), 5.0);
        col = mix(col, skyCol, fres * 0.28);
        vec3 h = normalize(viewDir + normalize(sunDir));
        float spec = pow(max(dot(nrm, h), 0.0), 90.0);
        col += sunCol * spec * 0.9;
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
  const tmp = {};
  for (let r = 0; r < rows; r++) {
    const s = stations[r];
    const prof = profileAt(course, clamp(s, F.minS, F.maxS));
    const p = course.at(s, tmp);
    const latL = prof.visL + 3.5;
    const latR = prof.visR + 3.5;
    // foam & chop along the course
    const dropFace = smoothstep(F.dropLipS - 1.5, F.dropLipS + 0.5, s) * (1 - smoothstep(F.dropLipS + 4, F.dropLipS + 8, s));
    const pool = smoothstep(F.dropLipS + 2, F.dropLipS + 6, s) * (1 - smoothstep(F.dropLandS + 2, F.dropLandS + 26, s));
    const chop = 0.12 + prof.canyon * 0.25 + prof.rapids * 0.95 + prof.harbor * 0.3 + dropFace + pool * 0.6 + prof.tunnel * 0.3;
    const foamBase = prof.rapids * 0.3 + dropFace * 0.95 + pool * 0.55 + prof.lily * 0.03;
    for (let c = 0; c < cols; c++) {
      const u = c / across; // 0 = right bank, 1 = left bank
      // bias samples toward the channel so the racing line gets more vertices
      const w = u * 2 - 1; // -1..1
      const shaped = Math.sign(w) * Math.pow(Math.abs(w), 1.35);
      const lat = shaped >= 0 ? shaped * latL : -shaped * -latR;
      const k = r * cols + c;
      const y = p.y - clamp(lat, -prof.half - 2, prof.half + 2) * Math.tan(p.bank) * WATER_BANK - 0.02;
      pos[k * 3] = p.x + p.nx * lat;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = p.z + p.nz * lat;
      aSL[k * 2] = s;
      aSL[k * 2 + 1] = lat;
      const vis = lat >= 0 ? prof.visL : prof.visR;
      const edge = Math.max(0, vis - Math.abs(lat));
      // open basins (marina/harbour/lily pond) have no foamy bank line far from the racing channel
      const openness = Math.max(prof.marina, prof.harbor);
      aFx[k * 3] = foamBase;
      aFx[k * 3 + 1] = chop;
      // in open basins, fade the shallow band/bank foam except right at the quay wall
      aFx[k * 3 + 2] = openness > 0.5 ? (edge < 1.2 ? edge : lerp(edge, 50, openness)) : edge;
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
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = x0 + i * cell;
      const z = z0 + j * cell;
      pos[k * 3] = x;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = z;
      aSL[k * 2] = x * 0.8;
      aSL[k * 2 + 1] = z * 0.8;
      aFx[k * 3] = 0;
      aFx[k * 3 + 1] = 0.45;
      aFx[k * 3 + 2] = 50;
    }
  }
  const idx = [];
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) { const a = j * nx + i; idx.push(a, a + nx, a + 1, a + 1, a + nx, a + nx + 1); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSL', new THREE.BufferAttribute(aSL, 2));
  geo.setAttribute('aFx', new THREE.BufferAttribute(aFx, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'sea';
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

/** Vertical falling-water sheet material (waterfalls on cliffs, weir curtain). */
export function makeFallMaterial() {
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { time: { value: 0 }, col: { value: new THREE.Color(PAL.waterShallow) }, foamCol: { value: new THREE.Color(PAL.waterFoam) } }]);
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
        float streak = smoothstep(0.35, 0.8, n * 0.7 + n2 * 0.5);
        vec3 c = mix(col, foamCol, streak);
        float edge = smoothstep(0.0, 0.12, vUv.x) * smoothstep(0.0, 0.12, 1.0 - vUv.x);
        gl_FragColor = vec4(c, (0.55 + 0.45 * streak) * edge);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}
