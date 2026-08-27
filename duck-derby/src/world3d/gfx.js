// Renderer, quality tier, palette, sky dome, lights and fog.
import * as THREE from 'three';

/** Art-direction palette (sRGB hex). Late-afternoon "golden hour" over a toy world. */
export const PAL = {
  skyTop: 0x3d8fd9,
  skyMid: 0x8cc8f0,
  skyHorizon: 0xffe0b8,
  sun: 0xfff1cc,
  sunDir: new THREE.Vector3(-0.55, 0.62, 0.56).normalize(),
  fog: 0xcfe3ee,
  ambientSky: 0xcfe6ff,
  ambientGround: 0x5a4a2c,
  grass: 0x79c05a,
  grassDark: 0x4f9a45,
  grassLight: 0xa8d86a,
  meadow: 0x93cf5d,
  sand: 0xe9d29c,
  mud: 0x8a6a45,
  rock: 0x9a8f86,
  rockDark: 0x6f645d,
  rockWarm: 0xb98f6a,
  cliff: 0xc98b5c,
  cliffDark: 0x8e5f43,
  snow: 0xffffff,
  wood: 0x9c6b3c,
  woodDark: 0x6b4423,
  woodLight: 0xc99555,
  quay: 0xd9cdb8,
  roofRed: 0xd9493b,
  roofBlue: 0x3c6fd1,
  wall: 0xf3ead8,
  waterDeep: 0x1c6fa6,
  waterShallow: 0x3fb9c9,
  waterFoam: 0xf4fbff,
  marsh: 0x4d8f55,
  lily: 0x5fbf4a,
  lilyDark: 0x3f8f3a,
  buoyRed: 0xe8412e,
  buoyWhite: 0xf5f1e6,
  bunting: [0xe8412e, 0xffd23f, 0x3d7be0, 0x5fbf4a, 0xff7fb0, 0xffffff],
};

export function detectQuality() {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const small = Math.min(screen.width, screen.height) < 500;
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;
  const mobile = coarse || small;
  const low = mobile && (cores <= 4 || mem <= 3);
  const q = new URLSearchParams(location.search).get('q');
  const tier = q === 'low' || q === 'high' || q === 'mid' ? q : low ? 'low' : mobile ? 'mid' : 'high';
  return {
    tier,
    mobile,
    maxDpr: tier === 'high' ? 2 : tier === 'mid' ? 1.75 : 1.25,
    antialias: tier !== 'low',
    crowd: tier === 'high' ? 1 : tier === 'mid' ? 0.7 : 0.45,
    particles: tier === 'high' ? 1 : tier === 'mid' ? 0.7 : 0.5,
    trees: tier === 'high' ? 1 : 0.7,
    shadows: false,
  };
}

export function createRenderer(canvas, quality) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality.antialias, powerPreference: 'high-performance', alpha: false, stencil: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.maxDpr));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(PAL.fog, 1);
  renderer.info.autoReset = true;
  return renderer;
}

/** Gradient sky dome with a sun disc and soft glow. Follows the camera. */
export function makeSky() {
  const geo = new THREE.SphereGeometry(1, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(PAL.skyTop) },
      mid: { value: new THREE.Color(PAL.skyMid) },
      horizon: { value: new THREE.Color(PAL.skyHorizon) },
      fogCol: { value: new THREE.Color(PAL.fog) },
      sunCol: { value: new THREE.Color(PAL.sun) },
      sunDir: { value: PAL.sunDir.clone() },
      dim: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * p;
        gl_Position.z = gl_Position.w; // always at the far plane
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform vec3 top, mid, horizon, fogCol, sunCol, sunDir;
      uniform float dim;
      void main() {
        float h = clamp(vDir.y, -1.0, 1.0);
        vec3 col = mix(horizon, mid, smoothstep(0.0, 0.28, h));
        col = mix(col, top, smoothstep(0.25, 0.9, h));
        col = mix(fogCol, col, smoothstep(-0.08, 0.06, h)); // blend into fog at the horizon and below
        float sd = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
        col += sunCol * (0.35 * pow(sd, 24.0) + 0.9 * smoothstep(0.9975, 0.999, sd));
        col = mix(col, col * 0.25, dim);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.setScalar(900);
  mesh.renderOrder = -100;
  mesh.frustumCulled = false;
  mesh.name = 'sky';
  return mesh;
}

export function makeLights(scene) {
  const hemi = new THREE.HemisphereLight(PAL.ambientSky, PAL.ambientGround, 1.15);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(PAL.sun, 2.1);
  sun.position.copy(PAL.sunDir).multiplyScalar(300);
  scene.add(sun);
  scene.add(sun.target);
  return { hemi, sun };
}

/** Cheap deterministic value-noise helpers shared by procedural builders. */
export function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
export function noise2(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm2(x, y, oct = 4) {
  let amp = 0.5;
  let f = 1;
  let sum = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * noise2(x * f, y * f);
    f *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

/** Lambert material helper. */
export function lambert(color, extra = {}) {
  return new THREE.MeshLambertMaterial({ color, ...extra });
}
