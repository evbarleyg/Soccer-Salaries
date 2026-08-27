// Duck Derby World — app shell: boot, setup UI, race director (phases +
// timeline), per-frame orchestration of sim playback → ducks → effects →
// cameras → HUD, results + sharing, and the window.__duckWorld capture hooks.
import * as THREE from 'three';
import { assignLooks, SAMPLE_NAMES, MIN_DUCKS, MAX_DUCKS, TOWELS } from '../ducks.js';
import { randomSeed, seedToCode, codeToSeed, clamp, lerp, smoothstep } from '../rng.js';
import { ordinal } from '../commentary.js';
import { getCourse, SECTIONS } from './course.js';
import { createRace, positionAt, lateralAt, speedAt, standingsAt, heldAt, activeWindows } from './race.js';
import { parseParams, buildQuery, resolveCam, draftOrder } from './params.js';
import { detectQuality, createRenderer, makeSky, makeLights, PAL } from './gfx.js';
import { Track } from './track.js';
import { buildTerrain } from './terrain.js';
import { makeWaterMaterial, buildRiver, buildSea, makeFallMaterial } from './water.js';
import { buildScenery } from './scenery.js';
import { buildDuck, makeNameTag, makeYouMarker } from './ducks3d.js';
import { DuckAnimator } from './animate.js';
import { Effects, makeItemSprite } from './effects.js';
import { CameraRig } from './cameras.js';
import { Hud, fmtTime } from './hud.js';
import { WorldAudio } from './audio3d.js';
import { WorldCommentator } from './commentary3d.js';
import { ITEMS } from './items.js';

const $ = (s) => document.querySelector(s);
const STORE_KEY = 'duckworld:v1';
const Q = detectQuality();
Q.reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const params = parseParams(location.search);
const urlFlags = new URLSearchParams(location.search);
const course = getCourse();
const track = new Track(course);
const L = course.length;

// --------------------------------------------------------------------------- state
const stored = loadStore();
const state = {
  phase: 'boot',
  phaseTime: 0,
  realTime: 0,
  t: 0,
  rate: 1,
  names: params.names ? params.names.slice() : stored.names && stored.names.length >= MIN_DUCKS ? stored.names.slice(0, MAX_DUCKS) : new Array(12).fill(''),
  rule: params.names ? params.rule : stored.rule === 'l' ? 'l' : 'w',
  hazards: params.names ? params.hazards : stored.hazards !== false,
  items: params.names ? params.items : stored.items !== false,
  fly: urlFlags.get('intro') === '0' ? false : stored.fly !== false,
  sound: !params.muted && stored.sound !== false,
  view: params.view || (stored.view === 'tv' ? 'tv' : 'chase'),
  camChoice: params.cam ?? stored.cam ?? 'leader', // name | lane | 'leader'
  shared: !!(params.names && params.seed !== null),
  salt: params.salt || 0,
  seed: params.seed,
  race: null,
  looks: [],
  raceNames: [],
  ducks: [], // [{duck, anim, tag, item}]
  duckStates: [],
  standings: [],
  leader: 0,
  target: 0,
  follow: 'leader',
  cursor: 0, // timeline index
  timeline: [],
  finishCount: 0,
  firstFinishT: null,
  slowmo: false,
  photoCalled: false,
  fireworks: false,
  podium: false,
  lastLeaderSwitch: 0,
};

// --------------------------------------------------------------------------- three setup
const canvas = $('#world');
let renderer;
try {
  renderer = createRenderer(canvas, Q);
} catch (err) {
  $('#boot-msg').textContent = 'WebGL is not available on this device/browser — try the 2D Duck Derby (index.html).';
  throw err;
}
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(PAL.fog, 140, 560);
const camera = new THREE.PerspectiveCamera(62, 1, 0.3, 1800);
const sky = makeSky();
scene.add(sky);
const lights = makeLights(scene, camera);
const rig = new CameraRig(camera, track, canvas);
rig.reducedMotion = Q.reducedMotion;
const hud = new Hud(course);
hud.onRank = (dir) => { if (dir > 0) { audio.blip(true); buzz(30); } else audio.blip(false); };
const audio = new WorldAudio();
audio.enabled = state.sound;
let terrain, scenery, fx, waterMat, fallMat;
let commentator = null;
const clock = new THREE.Clock();
const fogBase = new THREE.Color(PAL.fog);
const fogDark = new THREE.Color(0x1a1410);

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (fx) fx.points.material.uniforms.scale.value = h * 0.5 * renderer.getPixelRatio();
}
window.addEventListener('resize', resize);
// browsers only allow audio after a gesture: (re)try on the first one
const unlockOnce = () => { if (state.sound) { audio.unlock(); if (state.race) audio.startAmbience(); } };
window.addEventListener('pointerdown', unlockOnce, { passive: true });
window.addEventListener('touchend', unlockOnce, { passive: true });
window.addEventListener('keydown', unlockOnce);

// --------------------------------------------------------------------------- boot
const bootFill = $('#boot-fill');
const bootMsg = $('#boot-msg');
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
async function bootStep(pct, msg, fn) {
  bootFill.style.width = pct + '%';
  bootMsg.textContent = msg;
  await nextFrame();
  return fn ? fn() : null;
}

async function boot() {
  resize();
  await bootStep(15, 'Carving the canyon…', () => {
    terrain = buildTerrain(course);
    scene.add(terrain.mesh);
    rig.terrainHeight = terrain.heightAt;
  });
  await bootStep(40, 'Filling the river…', () => {
    waterMat = makeWaterMaterial();
    fallMat = makeFallMaterial();
    scene.add(buildRiver(course, waterMat));
    const b = terrain.bounds;
    scene.add(buildSea(waterMat, { x0: b.minX + 380, x1: b.maxX + 700, z0: b.minZ - 500, z1: b.maxZ + 300 }));
  });
  await bootStep(65, 'Building Duck Village, the flume and the harbour…', () => {
    scenery = buildScenery({ track, terrain, quality: Q, fallMat });
    scene.add(scenery.root);
    rig.podiumSpot = { pos: scenery.podium.camPos, look: scenery.podium.camLook };
  });
  await bootStep(85, 'Inflating ducks…', () => {
    fx = new Effects(scene, track, Q);
    resize();
    // warm up shaders with a first render
    rig.setMode('menu');
    rig.update(0.016, frameCtx(0.016));
    renderer.compile(scene, camera);
    renderer.render(scene, camera);
  });
  await bootStep(100, 'Ready!', null);
  $('#boot').classList.add('out');
  setTimeout(() => $('#boot').remove(), 700);
  initSetupUi();
  if (params.names && (params.autostart || urlFlags.get('autostart') === '1')) startRace({ fromUrl: true });
  else setPhase('menu');
  requestAnimationFrame(loop);
}

// --------------------------------------------------------------------------- setup UI
const els = {
  setup: $('#setup'), roster: $('#roster'), countOut: $('#count-out'), start: $('#btn-start'), ctaSub: $('#cta-sub'),
  optRule: $('#opt-rule'), optCam: $('#opt-cam'), optView: $('#opt-view'), optSeed: $('#opt-seed'), optItems: $('#opt-items'), optHotdogs: $('#opt-hotdogs'), optFly: $('#opt-fly'), optSound: $('#opt-sound'),
  shareBanner: $('#share-banner'), results: $('#results'), resBoard: $('#res-board'), resSub: $('#res-sub'), resTitle: $('#res-title'),
  picker: $('#picker'), pickerList: $('#picker-list'),
};

function renderJoin() {
  const grid = $('#join-grid');
  if (!grid) return;
  const names = state.names.map((s, i) => (String(s).trim() || `Duck ${i + 1}`));
  const looks = assignLooks(names, state.salt || 0);
  grid.innerHTML = '';
  names.forEach((n, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'join-card';
    const lk = looks[i];
    b.innerHTML = `<span class="num" style="background:${lk.towel.bg};color:${lk.towel.text}">${i + 1}</span><span class="nm">${escapeHtml(n)}</span><small>${escapeHtml(lk.palette.name)} · ${escapeHtml(lk.hatName)}</small>`;
    b.addEventListener('click', () => { state.camChoice = String(i + 1); state.view = 'chase'; startRace({}); });
    grid.appendChild(b);
  });
  $('#join-tv').onclick = () => { state.camChoice = 'leader'; state.view = 'tv'; startRace({}); };
  $('#join-host').onclick = () => { $('#join').hidden = true; $('#setup-form').hidden = false; };
  $('#join-sub').textContent = `${names.length} ducks · seed ${seedToCode(state.seed)} · ${state.rule === 'l' ? 'last place picks first' : 'winner picks first'}${state.items ? ' · items on' : ''}`;
}

function initSetupUi() {
  if (state.shared) { $('#join').hidden = false; $('#setup-form').hidden = true; renderJoin(); }
  els.optRule.value = state.rule;
  els.optView.value = state.view === 'tv' ? 'tv' : 'chase';
  els.optItems.checked = state.items;
  els.optHotdogs.checked = state.hazards;
  els.optFly.checked = state.fly;
  els.optSound.checked = state.sound;
  els.optSeed.value = state.seed != null ? seedToCode(state.seed) : '';
  els.shareBanner.hidden = !state.shared;
  renderRoster();
  document.querySelectorAll('.sizes button').forEach((b) => b.addEventListener('click', () => setRosterSize(Number(b.dataset.size))));
  $('#btn-add').addEventListener('click', () => { if (state.names.length < MAX_DUCKS) { state.names.push(''); renderRoster(); els.roster.querySelector('li:last-child input')?.focus(); } });
  $('#btn-sample').addEventListener('click', () => { fillSamples(); renderRoster(); });
  $('#btn-clear').addEventListener('click', () => { state.names = state.names.map(() => ''); renderRoster(); });
  $('#btn-reseed').addEventListener('click', () => { state.seed = randomSeed(); els.optSeed.value = seedToCode(state.seed); state.shared = false; els.shareBanner.hidden = true; updateCta(); });
  els.optSeed.addEventListener('change', () => { const s = codeToSeed(els.optSeed.value); state.seed = s; els.optSeed.value = s != null ? seedToCode(s) : ''; updateCta(); });
  els.optRule.addEventListener('change', () => (state.rule = els.optRule.value));
  els.optView.addEventListener('change', () => (state.view = els.optView.value));
  els.optCam.addEventListener('change', () => { state.camChoice = els.optCam.value; renderRoster(); });
  els.optItems.addEventListener('change', () => { state.items = els.optItems.checked; updateCta(); });
  els.optHotdogs.addEventListener('change', () => (state.hazards = els.optHotdogs.checked));
  els.optFly.addEventListener('change', () => (state.fly = els.optFly.checked));
  els.optSound.addEventListener('change', () => { state.sound = els.optSound.checked; audio.setEnabled(state.sound); hud.setMuted(!state.sound); });
  els.start.addEventListener('click', () => startRace({}));
  // results
  $('#btn-replay').addEventListener('click', () => replay());
  $('#btn-newrace').addEventListener('click', () => { if (!confirm('Start a NEW race with a new seed? (A shared link will no longer match this result.)')) return; state.seed = randomSeed(); state.shared = false; startRace({ names: state.raceNames }); });
  $('#btn-switch').addEventListener('click', () => openPicker());
  $('#btn-share').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const data = { title: 'Duck Derby World — draft order', text: draftText(false), url: shareUrl() };
    if (navigator.share && Q.mobile) { try { await navigator.share(data); return; } catch { /* fall back to clipboard */ } }
    copyText(shareUrl(), btn, 'Link copied!');
  });
  $('#btn-copy').addEventListener('click', (e) => copyText(draftText(), e.currentTarget, 'Copied!'));
  $('#btn-setup').addEventListener('click', () => { els.results.hidden = true; setPhase('menu'); });
  $('#btn-2d').href = 'index.html' + (state.raceNames.length ? '?' + twoDQuery() : '');
  $('#link-2d').href = 'index.html' + location.search;
  // hud buttons
  $('#btn-cam').addEventListener('click', () => cycleView());
  $('#btn-duck').addEventListener('click', () => openPicker());
  $('#hud-name').addEventListener('click', () => openPicker());
  if (Q.mobile && urlFlags.get('dev') !== '1') $('#btn-fly').hidden = true;
  $('#btn-fly').addEventListener('click', () => toggleFree());
  $('#btn-mute').addEventListener('click', () => toggleSound());
  $('#btn-more').addEventListener('click', () => $('#hud-tr').classList.toggle('open'));
  if (Q.mobile && 'DeviceOrientationEvent' in window) {
    const tb = $('#btn-tilt');
    tb.hidden = false;
    tb.addEventListener('click', () => toggleTilt());
  }
  document.querySelectorAll('#hud-menu button').forEach((b) => b.addEventListener('click', () => $('#hud-tr').classList.remove('open')));
  $('#btn-skip').addEventListener('click', () => skipIntro());
  $('#picker-close').addEventListener('click', () => (els.picker.hidden = true));
  els.picker.addEventListener('click', (e) => { if (e.target === els.picker) els.picker.hidden = true; });
  hud.setMuted(!state.sound);
  updateCta();
}

function setRosterSize(n) {
  n = clamp(n, MIN_DUCKS, MAX_DUCKS);
  while (state.names.length < n) state.names.push('');
  if (state.names.length > n) state.names.length = n;
  renderRoster();
}
function fillSamples() {
  const used = new Set(state.names.map((s) => s.trim().toLowerCase()).filter(Boolean));
  const pool = SAMPLE_NAMES.filter((s) => !used.has(s.toLowerCase()));
  state.names = state.names.map((s) => (s.trim() ? s : pool.shift() || s));
}
function renderRoster() {
  els.roster.innerHTML = '';
  const camIdx = resolveCam(state.camChoice, state.names.map((s, i) => s.trim() || `Duck ${i + 1}`));
  state.names.forEach((name, i) => {
    const li = document.createElement('li');
    const towel = TOWELS[i % TOWELS.length];
    li.innerHTML = `<span class="num" style="background:${towel.bg};color:${towel.text}">${i + 1}</span><input maxlength="22" placeholder="Duck ${i + 1}" value="${escapeHtml(name)}" aria-label="Duck ${i + 1} name"><button class="ride" type="button" title="Ride with this duck">RIDE</button><button class="del" type="button" title="Remove" aria-label="Remove">×</button>`;
    if (i === camIdx) li.classList.add('me');
    const input = li.querySelector('input');
    input.addEventListener('input', () => { state.names[i] = input.value; updateCamOptions(); updateCta(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const next = li.nextElementSibling?.querySelector('input'); if (next) next.focus(); else els.start.focus(); } });
    li.querySelector('.ride').addEventListener('click', () => { state.camChoice = String(i + 1); state.view = 'chase'; els.optView.value = 'chase'; renderRoster(); });
    li.querySelector('.del').addEventListener('click', () => { if (state.names.length > MIN_DUCKS) { state.names.splice(i, 1); renderRoster(); } });
    els.roster.appendChild(li);
  });
  els.countOut.textContent = state.names.length;
  document.querySelectorAll('.sizes button').forEach((b) => b.classList.toggle('on', Number(b.dataset.size) === state.names.length));
  updateCamOptions();
  updateCta();
}
function updateCamOptions() {
  const names = state.names.map((s, i) => s.trim() || `Duck ${i + 1}`);
  const camIdx = resolveCam(state.camChoice, names);
  els.optCam.innerHTML = `<option value="leader">Whoever leads (auto)</option>` + names.map((n, i) => `<option value="${i + 1}">${i + 1}. ${escapeHtml(n)}</option>`).join('');
  els.optCam.value = camIdx >= 0 ? String(camIdx + 1) : 'leader';
}
function updateCta() {
  const n = state.names.length;
  els.ctaSub.textContent = `${n} ducks · ${state.seed != null ? 'seed ' + seedToCode(state.seed) : 'random seed'} · ~40 s${state.items ? ' · items on' : ''}`;
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
function loadStore() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { return {}; } }
function saveStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ coached: stored.coached || state.coached || false, flySeen: !!stored.flySeen, names: state.names, rule: state.rule, hazards: state.hazards, items: state.items, fly: state.fly, sound: state.sound, view: state.view === 'free' ? 'chase' : state.view, cam: state.camChoice })); } catch { /* private mode */ }
}

// --------------------------------------------------------------------------- race lifecycle
function clearDucks() {
  for (const d of state.ducks) {
    scene.remove(d.duck.group);
    const shared = d.duck.shared;
    if (!shared) continue; // builder didn't tell us what is shared: leak rather than break the next race
    d.duck.group.traverse((o) => {
      if (!(o.isMesh || o.isSprite)) return;
      if (o.geometry && !shared.has(o.geometry) && !o.isSprite) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mt of mats) {
        if (!mt || shared.has(mt)) continue;
        if (mt.map && !shared.has(mt.map)) mt.map.dispose();
        mt.dispose();
      }
    });
  }
  state.ducks = [];
}

function startRace({ fromUrl = false, names = null } = {}) {
  if (state.sound) audio.unlock();
  audio.setEnabled(state.sound);
  const raw = names || state.names;
  const raceNames = raw.map((s, i) => { const n = String(s).replace(/~/g, '-').trim().slice(0, 22); return n || `Duck ${i + 1}`; });
  if (raceNames.length < MIN_DUCKS) return;
  if (!names) state.names = raw.slice();
  if (state.seed == null) state.seed = randomSeed();
  state.raceNames = raceNames;
  state.race = createRace({ count: raceNames.length, seed: state.seed, hazards: state.hazards, items: state.items });
  state.looks = assignLooks(raceNames, state.salt || 0);
  commentator = new WorldCommentator(raceNames, state.seed);
  rig.setSeed(state.seed);
  // per-duck splashdown times for the landing squash
  state.splashTimes = raceNames.map(() => []);
  for (const e of state.race.events) if (e.type === 'splashdown') state.splashTimes[e.duck].push(e.t);
  buildTimeline();
  // ducks
  clearDucks();
  state.looks.forEach((look, i) => {
    const duck = buildDuck(look);
    const anim = new DuckAnimator(duck, track, i);
    const tag = makeNameTag(raceNames[i], look.towel, look.number);
    tag.position.set(0, 2.25, 0);
    duck.group.add(tag);
    const item = makeItemSprite();
    item.position.set(0, 3.15, 0);
    duck.group.add(item);
    scene.add(duck.group);
    state.ducks.push({ duck, anim, tag, item });
  });
  if (!state.youMarker) {
    state.youMarker = makeYouMarker();
    scene.add(state.youMarker);
  }
  state.youMarker.visible = false;
  state.youKey = null;
  // target
  const camIdx = state.camChoice === 'leader' ? -1 : resolveCam(state.camChoice, raceNames);
  state.follow = camIdx >= 0 ? 'fixed' : 'leader';
  state.target = camIdx >= 0 ? camIdx : 0;
  if (state.view === 'free') { state.view = 'chase'; state.wantFree = true; }
  hud.setRoster(state.looks);
  hud.clearTransient();
  for (const b of scenery.itemBoxes) b.visible = state.items;
  fx.planHotdogs(state.race, scenery.throwerSpots, (i, t, out) => track.toWorld(positionAt(state.race, i, t), lateralAt(state.race, i, t), 0.6, out), (i, t) => positionAt(state.race, i, t));
  resetPlayback();
  saveStore();
  if (!fromUrl || !params.autostart) history.replaceState(null, '', '?' + shareQuery(true));
  els.setup.hidden = true;
  els.results.hidden = true;
  hud.show(true);
  $('#btn-2d').href = 'index.html?' + twoDQuery();
  audio.startAmbience();
  audio.setCrowd(0.3);
  audio.startMusic();
  audio.setMusicIntensity(0.25);
  if (params.t != null && fromUrl) {
    setPhase('race');
    jump(params.t);
  } else setPhase(state.fly ? 'flythrough' : 'grid');
}

function resetPlayback() {
  state.t = 0;
  state.rate = 1;
  state.freezeUntil = 0;
  state.letterboxed = false;
  letterbox(false);
  $('#finish-card').hidden = true;
  state.cursor = 0;
  state.finishCount = 0;
  state.firstFinishT = null;
  state.slowmo = false;
  state.photoCalled = false;
  state.fireworks = false;
  state.podium = false;
  for (const d of state.ducks) { d.anim.prevLat = null; }
  computeDuckStates(0, 1 / 60);
}

function buildTimeline() {
  const race = state.race;
  const cues = [];
  for (const e of race.events) {
    if (e.type === 'hotdog') cues.push({ t: e.t - 0.72, type: 'cue-hotdog', duck: e.duck });
  }
  for (const p of race.projectiles) if (p.type === 'seagull' && p.diveT) cues.push({ t: p.diveT, type: 'cue-dive', duck: p.target });
  state.timeline = race.events.concat(cues).sort((a, b) => a.t - b.t);
}

function replay() {
  els.results.hidden = true;
  hud.clearTransient();
  resetPlayback();
  hud.show(true);
  setPhase('grid');
}

function setPhase(phase) {
  state.phase = phase;
  state.phaseTime = 0;
  document.body.className = `phase-${phase} view-${state.view}`;
  els.setup.hidden = phase !== 'menu';
  if (phase === 'menu') {
    hud.show(false);
    $('#finish-card').hidden = true;
    letterbox(false);
    state.fireworks = false;
    lowerThird(null);
    audio.setCrowd(0.1);
    audio.setMusicIntensity(0.15);
    els.results.hidden = true;
    rig.setMode('menu');
    renderRoster();
  }
  $('#title-card').classList.toggle('show', phase === 'flythrough');
  if (phase === 'flythrough') {
    $('#title-card .tc-sub').textContent = `${state.raceNames.length} ducks · ${Math.round(L)} m · seed ${seedToCode(state.seed)}`;
    setTimeout(() => $('#title-card').classList.remove('show'), 3200);
    FLY_T = stored.flySeen ? 6.5 : 12;
    if (!stored.flySeen) { stored.flySeen = true; try { localStorage.setItem(STORE_KEY, JSON.stringify({ ...loadStore(), flySeen: true })); } catch { /* ignore */ } }
    rig.setMode('flythrough');
    hud.say(commentator.intro(state.raceNames.length), state.realTime, 5, 3);
  }
  if (phase === 'grid') {
    rig.setMode('grid');
    hud.flyCaption(null);
    showGridNames(true);
    if (!stored.coached && !state.coached) {
      state.coached = true;
      hud.say(Q.mobile ? 'Tap any duck to ride with it · drag to look · pinch to zoom' : 'Click a duck to ride with it · drag to look · C toggles TV view', state.realTime, 3, 3);
      try { localStorage.setItem(STORE_KEY, JSON.stringify({ ...loadStore(), coached: true })); } catch { /* ignore */ }
    }
  }
  if (phase === 'countdown') { state.countStep = -1; applyView(false); }
  if (phase === 'race') { showGridNames(false); if (state.wantFree) { state.wantFree = false; state.prevView = state.view; state.view = 'free'; } applyView(false); }
  if (phase === 'finish') {
    rig.setMode(state.view === 'free' ? 'free' : 'orbit');
    state.replay = null;
    const w = state.race.order[0];
    lowerThird('Winner', state.raceNames[w], `${fmtTime(state.race.finishTimes[w])} · ${state.race.photoFinish ? 'photo finish' : 'by ' + state.race.margin.toFixed(2) + ' s'} · picks ${state.rule === 'l' ? 'last' : 'first'}`);
  }
  if (phase === 'results') { lowerThird(null); showResults(); }
}

function skipIntro() {
  if (state.phase === 'flythrough') setPhase('grid');
  else if (state.phase === 'grid') setPhase('countdown');
}

function applyView(snap) {
  document.body.className = `phase-${state.phase} view-${state.view}`;
  if (state.phase === 'menu' || state.phase === 'flythrough' || state.phase === 'grid' || state.phase === 'results') return;
  if (state.phase === 'finish') { rig.setMode(state.view === 'free' ? 'free' : 'orbit'); return; }
  rig.setMode(state.view === 'tv' ? 'tv' : state.view === 'free' ? 'free' : 'chase');
  if (snap) rig.cut();
  hud.setCamLabel(state.view === 'chase' ? 'TV view' : 'Ride');
  $('#btn-fly').classList.toggle('on', state.view === 'free');
}
function cycleView() {
  state.view = state.view === 'chase' ? 'tv' : 'chase';
  applyView(true);
  saveStore();
}
function toggleFree() {
  if (state.view === 'free') state.view = state.prevView || 'chase';
  else { state.prevView = state.view; state.view = 'free'; }
  applyView(true);
}
// Tilt-to-look on phones: device orientation nudges the camera yaw/pitch around its follow target.
const tilt = { on: false, base: null, yaw: 0, pitch: 0 };
async function toggleTilt() {
  const btn = $('#btn-tilt');
  if (tilt.on) { tilt.on = false; btn.classList.remove('on'); rig.userYaw = 0; rig.userPitch = 0; return; }
  try {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      const res = await DOE.requestPermission();
      if (res !== 'granted') { hud.toast('Motion access denied', state.realTime, 1.5); return; }
    }
  } catch { /* older browsers: just try */ }
  tilt.on = true;
  tilt.base = null;
  btn.classList.add('on');
  hud.toast('Tilt to look around', state.realTime, 1.5);
}
window.addEventListener('deviceorientation', (e) => {
  if (!tilt.on || e.beta == null || e.gamma == null) return;
  const portrait = window.innerHeight >= window.innerWidth;
  const yawSrc = portrait ? e.gamma : e.beta;
  const pitchSrc = portrait ? e.beta : -e.gamma;
  if (!tilt.base) tilt.base = { yaw: yawSrc, pitch: pitchSrc };
  let dy = yawSrc - tilt.base.yaw;
  if (dy > 180) dy -= 360;
  if (dy < -180) dy += 360;
  const dp = pitchSrc - tilt.base.pitch;
  tilt.yaw = lerp(tilt.yaw, clamp(-dy * 0.03, -1.3, 1.3), 0.25);
  tilt.pitch = lerp(tilt.pitch, clamp(-dp * 0.015, -0.35, 0.6), 0.25);
  rig.userYaw = tilt.yaw;
  rig.userPitch = tilt.pitch;
});

function toggleSound() {
  state.sound = !state.sound;
  audio.unlock();
  audio.setEnabled(state.sound);
  if (state.sound) audio.startAmbience();
  hud.setMuted(!state.sound);
  els.optSound.checked = state.sound;
  saveStore();
}
function setTarget(i, userChosen = true) {
  if (!Number.isInteger(i) || i < 0 || i >= state.ducks.length) return;
  state.target = i;
  if (userChosen) { state.follow = 'fixed'; state.camChoice = String(i + 1); }
  hud.lastRank = -1;
}
function openPicker() {
  if (!state.raceNames.length) return;
  els.pickerList.innerHTML = '';
  const mk = (label, i, towel) => {
    const li = document.createElement('li');
    li.innerHTML = towel ? `<span class="num" style="background:${towel.bg};color:${towel.text}">${i + 1}</span><span class="nm">${escapeHtml(label)}</span>` : `<span class="nm">${escapeHtml(label)}</span>`;
    if ((i === -1 && state.follow === 'leader') || (i === state.target && state.follow === 'fixed')) li.classList.add('me');
    li.addEventListener('click', () => {
      if (i === -1) { state.follow = 'leader'; state.camChoice = 'leader'; }
      else setTarget(i, true);
      if (state.view === 'free' || state.view === 'tv') { state.view = 'chase'; }
      applyView(false);
      els.picker.hidden = true;
      saveStore();
    });
    els.pickerList.appendChild(li);
  };
  mk('★ Whoever leads', -1, null);
  state.raceNames.forEach((n, i) => mk(n, i, state.looks[i].towel));
  els.picker.hidden = false;
}

// --------------------------------------------------------------------------- per-frame race state
const winBuf = [];
function computeDuckStates(t, dt) {
  const race = state.race;
  if (!race) return;
  const n = race.count;
  state.standings = standingsAt(race, t);
  const ranks = new Array(n);
  state.standings.forEach((r, k) => (ranks[r.i] = k));
  state.leader = state.standings[0].i;
  if (!state.duckStates.length || state.duckStates.length !== n) state.duckStates = new Array(n).fill(0).map(() => ({ pos: new THREE.Vector3(), win: {} }));
  for (let i = 0; i < n; i++) {
    const ds = state.duckStates[i];
    ds.i = i;
    ds.t = t;
    ds.s = positionAt(race, i, t);
    ds.lat = lateralAt(race, i, t);
    ds.v = t <= 0 ? 0 : speedAt(race, i, t);
    ds.v0 = race.v0;
    ds.hop = course.hopAt(ds.s);
    track.toWorld(ds.s, ds.lat, ds.hop, ds.pos);
    ds.airborne = ds.hop > 0.02;
    ds.rank = ranks[i];
    ds.finished = race.finishTimes[i] !== null && t >= race.finishTimes[i];
    ds.held = heldAt(race, i, t);
    ds.section = course.sectionIdAt(ds.s);
    activeWindows(race, i, t, winBuf);
    const w = ds.win;
    w.boost = w.burst = w.stumble = w.spin = w.shield = w.star = w.mud = w.wobble = w.splash = null;
    for (const x of winBuf) w[x.kind] = x;
    const sp = state.splashTimes[i];
    for (let k = 0; k < sp.length; k++) if (t >= sp[k] && t < sp[k] + 0.3) w.splash = { t0: sp[k] };
    ds.boosting = !!(w.boost || w.burst);
    ds.star = !!w.star;
  }
  // podium override: top three stand on the barge
  if (state.podium) {
    const order = state.race.order;
    for (let k = 0; k < Math.min(3, order.length); k++) {
      const ds = state.duckStates[order[k]];
      ds.podiumSpot = scenery.podium.spots[k];
    }
  } else for (const ds of state.duckStates) ds.podiumSpot = null;
  void dt;
}

function frameCtx(dt) {
  return {
    dt, t: state.t, realTime: state.realTime, phase: state.phase, phaseTime: state.phaseTime, race: state.race, ducks: state.duckStates, target: state.target, leader: state.leader,
    standings: state.standings, names: state.raceNames, looks: state.looks, view: state.view, follow: state.follow, fx, camPos: camera.position, flyDuration: FLY_T, gridDuration: GRID_T,
    leaderS: state.duckStates[state.leader] ? state.duckStates[state.leader].s : 0, excite: state.excite || 0.3, orbitTarget: state.race ? state.race.order[0] : 0,
  };
}

let FLY_T = 12;
const GRID_T = 3.2;
const FLY_SECTIONS = [
  ['marina', 'Duck Village Marina', 'Pontoon start · grandstands · the blimp'],
  ['canyon', 'Canyon S-Bends', 'Banked turns, buoy lines, waterfalls'],
  ['lily', 'Lily-Pad Chicane', 'Weave the pads — mind the frogs'],
  ['drop', 'The Drop', 'Everyone gets air'],
  ['tunnel', 'Log-Flume Tunnel', 'Dark, fast, glow-worms'],
  ['rapids', 'Rocky Rapids', 'White water and bonkable rocks'],
  ['harbor', 'Harbour Finish', 'Lighthouse, chequered arch, fireworks'],
];

// --------------------------------------------------------------------------- timeline events -> one-shot effects
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
function duckPos(i) { return state.ducks[i] ? state.ducks[i].duck.group.position : tmpV.set(0, 0, 0); }
function nearCam(i, r = 45) { return duckPos(i).distanceTo(camera.position) < r; }

function handleEvent(ev) {
  const race = state.race;
  const i = ev.duck;
  const isT = i === state.target;
  const name = i >= 0 ? state.raceNames[i] : '';
  const line = commentator.forEvent(ev, state.standings, state.target);
  switch (ev.type) {
    case 'pickup':
      scenery.popItemBox(ev.box, lateralAt(race, i, ev.t), ev.t);
      if (isT) { audio.itemGet(); buzz(25); }
      else if (nearCam(i, 25)) audio.tick();
      break;
    case 'use':
      if (isT) hud.itemUsed();
      if (ev.item === 'bread' || ev.item === 'triple') { if (isT) { audio.whoosh(0.35); rig.kick(0.15); hud.callout('BOOST!', ITEMS.bread.color); } else if (nearCam(i, 30)) audio.whoosh(0.12); }
      else if (ev.item === 'hornet') { audio.buzz(1.0, isT || ev.target === state.target ? 0.16 : 0.07); if (ev.target === state.target) hud.popup('HORNET INCOMING!', ITEMS.hornet.color); }
      else if (ev.item === 'seagull') { audio.screech(); if (state.duckStates[state.target] && state.duckStates[state.target].rank === 0) hud.callout('SEAGULL INCOMING!', ITEMS.seagull.color); else hud.popup('SEAGULL STRIKE!', ITEMS.seagull.color); }
      else if (ev.item === 'feather') { audio.stinger(); if (isT) hud.callout('GOLDEN!', ITEMS.feather.color); }
      else if (ev.item === 'mud') { audio.splash(0.3); if (ev.victims && ev.victims.includes(state.target)) hud.callout('MUD!', ITEMS.mud.color); }
      else if (ev.item === 'stone') { audio.itemUse(); }
      break;
    case 'hit':
      fx.splash(tmpV.copy(duckPos(i)), 1.2);
      if (ev.item === 'hotdog') fx.mustard(tmpV.copy(duckPos(i)).setY(duckPos(i).y + 0.8));
      if (isT) { rig.kick(1.0); audio.bonk(); buzz([50, 40, 50]); hud.callout(ev.item === 'hornet' ? 'STUNG!' : ev.item === 'seagull' ? 'DIVE-BOMBED!' : ev.item === 'stone' ? 'BONK!' : 'HOT-DOGGED!', '#ff6f61'); flash(0.25); }
      else if (nearCam(i)) audio.bonk();
      if (ev.rank <= 2) audio.ooh();
      if (ev.rank <= 3 && nearCam(i, 70)) rig.tvEvent('hit', { duck: i }, state.t);
      break;
    case 'hotdog':
      if (ev.result !== 'hit') { fx.mustard(tmpV.copy(duckPos(i)).setY(duckPos(i).y + 1.5)); audio.pop(); }
      break;
    case 'cue-hotdog':
      audio.whistle(0.7);
      if (i === state.target) hud.popup('INCOMING!', '#ffd23f');
      break;
    case 'cue-dive':
      audio.screech();
      break;
    case 'blocked':
      audio.pop();
      if (isT) hud.callout(ev.reason === 'shield' ? 'BLOCKED!' : 'NO EFFECT!', ITEMS.shield.color);
      fx.sparkle(tmpV.copy(duckPos(i)).setY(duckPos(i).y + 0.6), 0xbdf0ff, 4);
      break;
    case 'plow':
      if (isT) rig.kick(0.4);
      break;
    case 'lead':
      if (isT && state.t > 3) { hud.toast('1st!', state.realTime); audio.cheer(0.25, 1.2); }
      if (state.t > 4 && ev.from >= 0) { rig.tvEvent('lead', { a: i, b: ev.from }, state.t); audio.cheer(0.18, 1.0); }
      break;
    case 'burst':
      if (isT) audio.whoosh(0.14);
      break;
    case 'stumble':
      if (isT) { rig.kick(0.35); audio.bonk(); }
      else if (nearCam(i, 20)) audio.splash(0.15);
      break;
    case 'takeoff':
      if (isT) audio.whoosh(0.2);
      break;
    case 'splashdown':
      fx.splash(tmpV.copy(duckPos(i)).setY(track.surfaceY(state.duckStates[i].s, state.duckStates[i].lat) + 0.2), 1.6);
      if (isT) { audio.bigSplash(); rig.kick(Q.reducedMotion ? 0.2 : 0.7); buzz(40); if (state.view === 'chase') hud.splashLens(); } else if (nearCam(i)) audio.splash(0.3);
      break;
    case 'halfway':
      break;
    case 'stretch':
      hud.banner('FINAL STRETCH');
      audio.stinger();
      audio.setCrowd(0.9);
      break;
    case 'finish': {
      state.finishCount++;
      const place = race.order.indexOf(i) + 1;
      const fl = commentator.finishLine(i, place, race.photoFinish, race.count);
      if (place === 1) {
        state.firstFinishT = ev.t;
        flash(0.35);
        audio.cameraFlash();
        audio.horn();
        audio.cheer(0.5, 2.5);
        setTimeout(() => { audio.duckMusic(2.2); audio.fanfare(); }, 700);
        // freeze-frame: hold the clock for a beat with letterbox bars and the verdict
        if (state.phase === 'race' && !state.jumping) {
          state.freezeUntil = state.realTime + (Q.reducedMotion ? 0.2 : 0.38);
          state.letterboxed = true;
          letterbox(true, race.photoFinish ? `PHOTO FINISH · ${name} by ${race.margin.toFixed(2)} s` : `${name} WINS · ${fmtTime(ev.t)}`);
        }
        hud.card(race.photoFinish ? `${name} BY A BEAK!` : `${name} WINS!`, 1.6);
        const arch = track.toWorld(L, 0, 6);
        fx.confetti(arch, 1.2);
        fx.confetti(track.toWorld(L, 8, 2), 0.7);
        fx.confetti(track.toWorld(L, -8, 2), 0.7);
        state.fireworks = true;
        state.excite = 1;
      }
      if (isT && state.follow === 'fixed') {
        const pick = draftOrder(race.order, state.rule).indexOf(i) + 1;
        showFinishCard(place, pick);
        buzz(200);
      } else if (isT) hud.toast(place === 1 ? 'WINNER!' : ordinal(place), state.realTime, 2);
      if (fl) hud.say(fl, state.realTime, 3);
      return;
    }
    default:
      break;
  }
  if (line) {
    const pri = isT || (ev.victims && ev.victims.includes(state.target)) || ev.target === state.target ? 3 : ev.type === 'lead' || ev.duck === state.leader ? 2 : ev.type === 'hit' || ev.type === 'hotdog' ? 1 : 0;
    hud.say(line, state.realTime, 3.0, pri);
  }
}

let lastFlash = -10;
function flash(strength = 1) {
  if (state.realTime - lastFlash < 0.5) return; // never strobe
  lastFlash = state.realTime;
  const f = $('#flash');
  f.style.setProperty('--f', String(Math.min(Q.reducedMotion ? 0.2 : 0.4, strength)));
  f.classList.remove('on');
  void f.offsetWidth;
  f.classList.add('on');
}
function letterbox(on, caption = '') {
  const lb = $('#letterbox');
  lb.classList.toggle('on', on);
  if (caption) $('#lb-caption').textContent = caption;
}
function lowerThird(kicker, title, sub) {
  const el = $('#lower-third');
  if (!kicker) { el.hidden = true; return; }
  el.querySelector('.lt-kicker').textContent = kicker;
  el.querySelector('.lt-title').textContent = title;
  el.querySelector('.lt-sub').textContent = sub || '';
  el.hidden = true;
  void el.offsetWidth;
  el.hidden = false;
}
function showFinishCard(place, pick) {
  const card = $('#finish-card');
  const lk = state.looks[state.target];
  card.style.setProperty('--me', lk.towel.bg);
  card.querySelector('.fc-place').textContent = place === 1 ? 'YOU WON!' : `YOU FINISHED ${ordinal(place).toUpperCase()}`;
  card.querySelector('.fc-pick').textContent = `→ DRAFT PICK #${pick}`;
  card.hidden = false;
}
function buzz(pattern) {
  try { if (navigator.vibrate && Q.mobile) navigator.vibrate(pattern); } catch { /* ignore */ }
}

// --------------------------------------------------------------------------- results
function showResults() {
  const race = state.race;
  const order = race.order;
  const picks = draftOrder(order, state.rule);
  const winner = state.raceNames[order[0]];
  els.resTitle.textContent = 'Draft order';
  $('#res-rule').textContent = state.rule === 'l' ? 'Last place picks first' : 'Winner picks first';
  $('#res-seed').textContent = 'seed ' + seedToCode(state.seed);
  els.resSub.textContent = `${winner} ${race.photoFinish ? 'won a photo finish' : `won by ${race.margin.toFixed(2)} s`} · ${race.count} ducks · ${race.leadChanges} lead change${race.leadChanges === 1 ? '' : 's'}`;
  els.resBoard.innerHTML = '';
  const mine = state.follow === 'fixed' ? state.target : -1;
  let myRow = null;
  picks.forEach((i, k) => {
    const place = order.indexOf(i) + 1;
    const li = document.createElement('li');
    li.style.animationDelay = `${(picks.length - 1 - k) * 45}ms`; // reveal from the last pick up to pick 1
    const lk = state.looks[i];
    const tt = race.finishTimes[i];
    li.className = (place === 1 ? 'first ' : '') + (i === mine ? 'me' : '');
    li.style.setProperty('--me', lk.towel.bg);
    li.title = `${lk.palette.name} · ${lk.hatName}`;
    li.innerHTML = `<span class="pick">Pick <b>${k + 1}</b></span><span class="num" style="background:${lk.towel.bg};color:${lk.towel.text}">${lk.number}</span><span class="nm">${escapeHtml(state.raceNames[i])}${i === mine ? '<span class="you">YOU</span>' : ''}</span><span class="res">${ordinal(place)} · ${fmtTime(tt)}</span>`;
    li.addEventListener('click', () => { setTarget(i, true); });
    els.resBoard.appendChild(li);
    if (i === mine) myRow = li;
  });
  $('#btn-newrace').hidden = state.shared;
  els.results.hidden = false;
  $('#finish-card').hidden = true;
  if (myRow) setTimeout(() => myRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 700);
  history.replaceState(null, '', '?' + shareQuery(true));
}
function shareQuery(withCam = false) {
  return buildQuery({ names: state.raceNames, seed: state.seed, rule: state.rule, hazards: state.hazards, items: state.items, salt: state.salt, cam: withCam && state.follow === 'fixed' ? state.target + 1 : null, view: withCam && state.view === 'tv' ? 'tv' : null });
}
function shareUrl() {
  const u = new URL(location.href);
  u.search = '?' + shareQuery(false);
  u.hash = '';
  return u.toString();
}
function twoDQuery() {
  const p = new URLSearchParams();
  p.set('names', state.raceNames.join('~'));
  if (state.seed != null) p.set('seed', seedToCode(state.seed));
  p.set('rule', state.rule);
  if (!state.hazards) p.set('hz', '0');
  if (state.salt) p.set('salt', String(state.salt));
  return p.toString();
}
function draftText(withUrl = true) {
  const race = state.race;
  const picks = draftOrder(race.order, state.rule);
  const lines = picks.map((i, k) => `Pick ${k + 1} — ${state.raceNames[i]} (${ordinal(race.order.indexOf(i) + 1)}, ${fmtTime(race.finishTimes[i])})`);
  return `Duck Derby World draft order (${state.rule === 'l' ? 'last place picks first, ' : ''}seed ${seedToCode(state.seed)})\n${lines.join('\n')}${withUrl ? '\n' + shareUrl() : ''}`;
}
async function copyText(text, btn, done) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
  if (btn) { const old = btn.textContent; btn.textContent = done; setTimeout(() => (btn.textContent = old), 1400); }
}

// --------------------------------------------------------------------------- grid name boards (bigger tags during line-up)
function showGridNames(on) {
  state.ducks.forEach((d, i) => {
    d.tag.scale.set(on ? 1.9 : 2.6, on ? 0.48 : 0.65, 1);
    d.tag.position.y = on ? (i % 2 ? 2.75 : 2.05) : 2.25; // stagger so neighbours don't overlap on the line
  });
}

// --------------------------------------------------------------------------- main loop
let inTunnel = 0;
// Adaptive resolution: if the device can't hold ~50 fps, trade sharpness for smoothness (and give it back later).
const perf = { acc: 0, frames: 0, scale: 1, min: 0.6, lastChange: 0 };
function adaptQuality(rawDt) {
  perf.acc += rawDt;
  perf.frames++;
  if (perf.acc < 2) return;
  const avg = perf.acc / perf.frames;
  perf.acc = 0;
  perf.frames = 0;
  if (document.hidden || state.realTime - perf.lastChange < 4) return;
  const base = Math.min(window.devicePixelRatio || 1, Q.maxDpr);
  let s = perf.scale;
  if (avg > 1 / 45 && s > perf.min) s = Math.max(perf.min, s - 0.15);
  else if (avg < 1 / 57 && s < 1) s = Math.min(1, s + 0.1);
  if (s !== perf.scale) {
    perf.scale = s;
    perf.lastChange = state.realTime;
    renderer.setPixelRatio(base * s);
    resize();
  }
}

function loop() {
  requestAnimationFrame(loop);
  const raw = clock.getDelta();
  const dt = Math.min(raw, 0.05);
  state.realTime += dt;
  state.phaseTime += dt;
  step(dt);
  renderer.render(scene, camera);
  if (state.phase !== 'menu' && !urlFlags.has('noadapt')) adaptQuality(raw);
}

function step(dt) {
  const race = state.race;
  // ---- phase logic
  switch (state.phase) {
    case 'flythrough': {
      const e = state.phaseTime / FLY_T;
      // caption for the section under the camera
      const s = lerp(course.features.minS + 30, L + 40, clamp(e, 0, 1) ** 2 * (3 - 2 * clamp(e, 0, 1)));
      const sec = course.sectionIdAt(s + 25);
      const def = FLY_SECTIONS.find((x) => x[0] === sec);
      if (def && hud._flySec !== sec) { hud._flySec = sec; hud.flyCaption(def[1], def[2]); }
      if (state.phaseTime >= FLY_T) { hud._flySec = null; setPhase('grid'); }
      break;
    }
    case 'grid':
      if (state.phaseTime >= GRID_T) setPhase('countdown');
      break;
    case 'countdown': {
      const stepN = Math.floor(state.phaseTime / 0.8);
      if (stepN !== state.countStep && stepN <= 3) {
        state.countStep = stepN;
        if (stepN < 3) {
          hud.countdown(String(3 - stepN));
          audio.beep(false);
          audio.tom();
          rig.fovPunch(-1.5 * (stepN + 1)); // tighten a little each tick
          state.squashAll = state.realTime;
          audio.setCrowd(0.35 + stepN * 0.15);
        } else {
          hud.countdown('GO!', true);
          audio.beep(true);
          audio.horn();
          hud.say(commentator.go(), state.realTime, 2.5);
          for (let k = 0; k < 3; k++) setTimeout(() => audio.quack(0.9 + Math.random() * 0.4, 0.3), k * 120);
          rig.fovPunch(4.5);
          rig.kick(0.3);
          state.goBurst = state.realTime;
          const half0 = course.widthAt(0) / 2;
          fx.confetti(track.toWorld(0, half0 + 2.2, 3), 0.5);
          fx.confetti(track.toWorld(0, -(half0 + 2.2), 3), 0.5);
          audio.setCrowd(1);
          setPhase('race');
        }
      }
      break;
    }
    case 'race': {
      // shaped slow-motion into the line, then a freeze-frame "photo" when the winner crosses
      const lead = state.duckStates[state.leader];
      let rate = 1;
      let ease = 6;
      if (race && state.firstFinishT === null && lead) {
        const second = state.standings[1] ? state.duckStates[state.standings[1].i] : null;
        const gap = second ? lead.s - second.s : 99;
        if (lead.s > L - 18 && gap < 7 && !Q.reducedMotion) {
          rate = race.photoFinish && lead.s > L - 5 ? 0.25 : 0.55;
          ease = 10;
          if (!state.photoCalled && race.photoFinish) { state.photoCalled = true; hud.card('PHOTO FINISH'); }
        }
        if (state.view === 'tv' && lead.s > L - 60 && rig.mode === 'tv') rig.setMode('finish');
      }
      if (state.freezeUntil && state.realTime < state.freezeUntil) rate = 0;
      state.rate = rate === 0 ? 0 : lerp(state.rate, rate, Math.min(1, dt * ease));
      state.t += dt * state.rate;
      if (state.freezeUntil && state.realTime >= state.freezeUntil && state.letterboxed) { state.letterboxed = false; letterbox(false); state.rate = 0.6; }
      // done? keep riding with my duck until it is home (capped), then the winner's orbit
      const lastT = race ? Math.max(...race.finishTimes) : 0;
      if (race && state.firstFinishT !== null) {
        const myT = race.finishTimes[state.target];
        const holdUntil = state.view === 'chase' && myT !== null ? Math.min(myT + 1.6, state.firstFinishT + 14) : state.firstFinishT + 7;
        if (state.t > lastT + 1.5 || state.t > Math.max(holdUntil, state.firstFinishT + 3.5)) setPhase('finish');
      }
      break;
    }
    case 'finish': {
      // winner orbit (3 s) -> instant replay of the line in slow motion (3.6 s) -> podium + results
      const ORBIT = 3.2;
      const REPLAY = 3.6;
      if (state.phaseTime < ORBIT || Q.reducedMotion) {
        state.t += dt;
        if (Q.reducedMotion && state.phaseTime > 5) { state.podium = true; setPhase('results'); rig.setMode(state.view === 'free' ? 'free' : 'podium'); }
      } else if (!state.replay) {
        state.replay = { t0: state.firstFinishT - 1.6 };
        state.t = state.replay.t0;
        for (const d of state.ducks) d.anim.prevLat = null;
        if (state.view !== 'free') rig.setMode('finish');
        rig.cut();
        letterbox(true, 'INSTANT REPLAY');
        audio.cameraFlash();
      } else if (state.phaseTime < ORBIT + REPLAY) {
        state.t += dt * 0.42;
      } else {
        letterbox(false);
        state.replay = null;
        state.t = Math.max(...race.finishTimes) + 2;
        state.podium = true;
        lowerThird(null);
        setPhase('results');
        rig.setMode(state.view === 'free' ? 'free' : 'podium');
      }
      break;
    }
    case 'results':
      state.t += dt;
      break;
    default:
      break;
  }

  if (race) {
    computeDuckStates(state.t, dt);
    // follow-the-leader chase target (with a little hysteresis)
    if (state.follow === 'leader' && state.phase === 'race') {
      const cur = state.duckStates[state.target];
      const lead = state.duckStates[state.leader];
      if (state.leader !== state.target && cur && lead && (lead.s - cur.s > 2.5 || cur.finished) && state.realTime - state.lastLeaderSwitch > 1.5) {
        state.target = state.leader;
        state.lastLeaderSwitch = state.realTime;
        hud.lastRank = -1;
      }
    }
    // "THE DROP" anticipation for my duck + incoming projectile warning
    const me = state.duckStates[state.target];
    if (me && state.phase === 'race') {
      if (!state.dropCalled && me.s > course.features.dropApproachS - 25 && me.s < course.features.dropLipS) {
        state.dropCalled = true;
        hud.say('THE DROP ▸▸▸ hold on!', state.realTime, 2.2, 3);
        audio.setCrowd(0.95);
      }
      let warn = null;
      let wd = 0;
      for (const p of race.projectiles) {
        if (state.t < p.t0 || state.t > p.t1) continue;
        if ((p.type === 'hornet' && p.target === state.target) || (p.type === 'seagull' && me.rank === 0 && !me.finished)) {
          const k = Math.min(Math.floor((state.t - p.t0) / race.dt), p.path.length / 2 - 1);
          const ps = p.path[k * 2];
          const dist = me.s - ps;
          if (!warn || dist < wd) { warn = p.type === 'hornet' ? 'HORNET' : 'SEAGULL'; wd = dist; }
        }
      }
      hud.incoming(warn, wd);
    } else hud.incoming(null);
    // timeline
    while (state.cursor < state.timeline.length && state.timeline[state.cursor].t <= state.t) {
      const ev = state.timeline[state.cursor++];
      if (state.phase === 'race' || state.phase === 'finish' || ev.type === 'finish') handleEvent(ev);
    }
  }

  // ---- camera
  const ctx = frameCtx(dt);
  rig.update(dt, ctx);

  // ---- ducks
  if (race) {
    const camP = camera.position;
    for (let i = 0; i < state.ducks.length; i++) {
      const d = state.ducks[i];
      const ds = state.duckStates[i];
      const dist = d.duck.group.position.distanceTo(camP);
      ctx.near = dist < 60;
      if (ds.podiumSpot) {
        // stand on the podium, face the camera, idle bob
        d.duck.group.position.copy(ds.podiumSpot);
        d.duck.group.position.y += 0.05 + Math.abs(Math.sin(state.realTime * 3 + i)) * 0.08;
        d.duck.group.rotation.set(0, scenery.podium.yaw, 0);
        d.duck.group.quaternion.setFromEuler(d.duck.group.rotation);
        d.duck.pivot.rotation.set(0, Math.sin(state.realTime * 1.5 + i) * 0.2, 0);
        d.duck.pivot.scale.setScalar(d.duck.look.scale || 1);
        for (const wng of d.duck.wings) wng.rotation.z = wng.userData.side * (0.5 + Math.sin(state.realTime * 20 + i) * 0.5) * (i === race.order[0] ? 1 : 0.2);
        d.duck.shadow.visible = false;
        d.tag.visible = true;
        d.tag.scale.set(3, 0.75, 1);
        d.item.visible = false;
        continue;
      }
      d.duck.shadow.visible = true;
      // ducks right on top of the camera would fill the screen: hide them (Mario Kart-style ghosting, cheap version)
      d.duck.group.visible = !(rig.mode === 'chase' && i !== state.target && dist < 3.2 && state.phase === 'race');
      ctx.isTarget = i === state.target;
      d.anim.update(dt, ds, ctx);
      if (state.goBurst && state.realTime - state.goBurst < 0.6 && fx) fx.spray(tmpV.copy(d.duck.group.position).setY(d.duck.group.position.y + 0.15), tmpV2.copy(d.anim.frame.flat).negate(), 1.4);
      // name tag + held item sprite (visibility decided by the declutter pass below)
      d.dist = dist;
      const k = clamp(dist * 0.07, 0.42, 2.8); // roughly constant on-screen size
      if (state.phase !== 'grid') {
        d.tag.scale.set(0.55 * k * d.tag.userData.aspect, 0.55 * k, 1);
        d.tag.position.y = 1.85 + k * 0.35;
      }
      d.tag.material.opacity = clamp(1.25 - dist / 60, 0.3, 1);
      if (state.phase === 'results') { d.tag.visible = false; d.item.visible = false; continue; }
      const held = ds.held;
      d.item.userData.setItem(held ? held.item : null, held ? held.charges : 1);
      if (held) {
        d.item.visible = dist < 90 && dist > 4;
        const ki = clamp(dist * 0.055, 0.5, 2.4);
        d.item.scale.setScalar(ki);
        d.item.material.opacity = 0.85;
        d.item.position.y = d.tag.position.y + 0.32 * k + 0.45 * ki;
      }
    }
    // gentle lateral separation so ducks don't visibly interpenetrate (render-only)
    separateDucks();
    declutterTags();
    updateYouMarker();
  }

  // ---- world updates
  const camS = track.nearestS(camera.position.x, camera.position.z);
  const cp = course.at(camS);
  const lateral = Math.hypot(camera.position.x - cp.x, camera.position.z - cp.z);
  const tun = scenery.tunnel;
  const inside = camS > tun.s0 && camS < tun.s1 && lateral < cp.width / 2 + 1.5 && camera.position.y < cp.y + 6 ? 1 : 0;
  inTunnel = lerp(inTunnel, inside, Math.min(1, dt * (inside ? 6 : 3)));
  lights.hemi.intensity = lerp(1.15, 0.32, inTunnel);
  lights.sun.intensity = lerp(2.1, 0.12, inTunnel);
  lights.fill.intensity = lerp(0.55, 0.25, inTunnel);
  scene.fog.color.copy(fogBase).lerp(fogDark, inTunnel * 0.85);
  scene.fog.near = lerp(140, 20, inTunnel);
  scene.fog.far = lerp(560, 160, inTunnel);
  sky.material.uniforms.dim.value = inTunnel;
  waterMat.uniforms.darkness.value = inTunnel;
  waterMat.uniforms.time.value = state.realTime;
  fallMat.uniforms.time.value = state.realTime;
  audio.setTunnel(inTunnel);
  sky.position.copy(camera.position);
  state.excite = state.phase === 'race' ? lerp(0.35, 1, smoothstep(L * 0.75, L, ctx.leaderS)) : state.phase === 'finish' || state.phase === 'results' ? 1 : 0.25;
  scenery.update(dt, ctx);
  fx.updateRace(dt, ctx);
  if (state.fireworks) {
    const burst = fx.fireworksTick(dt, scenery.fireworkBarges, true);
    if (burst) audio.boom();
  }
  if (state.phase === 'results' && state.podium && Math.floor(state.phaseTime / 2.2) !== Math.floor((state.phaseTime - dt) / 2.2)) {
    fx.confetti(tmpV.copy(scenery.podium.spots[0]).setY(scenery.podium.spots[0].y + 2.5), 0.5);
  }
  if (audio.crowdGain && state.phase === 'race') audio.setCrowd(0.3 + 0.6 * (state.excite || 0));
  audio.setMusicIntensity(state.phase === 'race' ? 0.45 + 0.55 * smoothstep(0.3, 1, state.excite || 0) : state.phase === 'countdown' ? 0.35 : state.phase === 'finish' ? 0.7 : state.phase === 'results' ? 0.4 : 0.22);
  audio.setRate(state.phase === 'race' ? state.rate : 1);
  audio.pumpMusic();

  // ---- HUD
  if (race && state.phase !== 'menu') hud.update(ctx);
}

// Name-tag declutter: priority order, greedy screen-space placement, capped count.
const tagV = new THREE.Vector3();
const placedRects = [];
function declutterTags() {
  const n = state.ducks.length;
  if (state.phase === 'grid' || state.phase === 'countdown') {
    for (const d of state.ducks) d.tag.visible = true;
    return;
  }
  if (state.phase === 'flythrough' || state.phase === 'results') {
    for (const d of state.ducks) d.tag.visible = false;
    return;
  }
  const tv = rig.mode !== 'chase';
  const cap = tv ? 8 : 5;
  const me = state.target;
  const myRank = state.duckStates[me] ? state.duckStates[me].rank : 0;
  const pri = (i) => {
    const r = state.duckStates[i].rank;
    if (!tv && (r === myRank - 1 || r === myRank + 1)) return 0;
    if (r === 0) return 1;
    return 2 + state.ducks[i].dist * 0.01 + r * 0.1;
  };
  const order = [];
  for (let i = 0; i < n; i++) {
    const d = state.ducks[i];
    const hideMine = !tv && i === me && state.phase === 'race';
    const ok = d.dist > 3.5 && d.dist < 75 && !hideMine && d.duck.group.visible;
    d.tag.visible = false;
    if (ok) order.push(i);
  }
  order.sort((a, b) => pri(a) - pri(b));
  placedRects.length = 0;
  const W = renderer.domElement.clientWidth;
  const H = renderer.domElement.clientHeight;
  const th = 0.036 * H; // approx on-screen tag height in px (constant by construction)
  let shown = 0;
  for (const i of order) {
    if (shown >= cap) break;
    const d = state.ducks[i];
    tagV.copy(d.duck.group.position);
    tagV.y += d.tag.position.y;
    tagV.project(camera);
    if (tagV.z > 1 || Math.abs(tagV.x) > 1.1 || Math.abs(tagV.y) > 1.1) continue;
    const cx = (tagV.x * 0.5 + 0.5) * W;
    const cy = (-tagV.y * 0.5 + 0.5) * H;
    const tw = th * d.tag.userData.aspect;
    let clash = false;
    for (const r of placedRects) {
      const ox = Math.min(cx + tw / 2, r.x + r.w / 2) - Math.max(cx - tw / 2, r.x - r.w / 2);
      const oy = Math.min(cy + th / 2, r.y + r.h / 2) - Math.max(cy - th / 2, r.y - r.h / 2);
      if (ox > 0 && oy > 0 && ox * oy > 0.25 * tw * th) { clash = true; break; }
    }
    if (clash) continue;
    placedRects.push({ x: cx, y: cy, w: tw, h: th });
    d.tag.visible = true;
    shown++;
  }
}

// "YOU" chevron over the followed duck (any camera), constant screen size, gentle bob.
function updateYouMarker() {
  const mk = state.youMarker;
  if (!mk) return;
  const d = state.ducks[state.target];
  const show = d && state.phase !== 'flythrough' && state.phase !== 'results' && state.phase !== 'menu' && rig.mode !== 'free';
  mk.visible = !!show;
  if (!show) return;
  const key = `${state.target}|${state.follow}`;
  if (state.youKey !== key) {
    state.youKey = key;
    const lk = state.looks[state.target];
    mk.userData.paint({ ...lk.towel, number: lk.number }, state.follow === 'leader' ? 'LEADER' : 'YOU');
  }
  const dist = d.dist || 10;
  const chase = rig.mode === 'chase' && state.phase === 'race';
  const k = clamp(dist * (chase ? 0.07 : 0.085), 0.45, 4.5);
  mk.scale.set(1.2 * k, 1.2 * k, 1);
  mk.position.copy(d.duck.group.position);
  mk.position.y += (chase ? 1.45 : 2.3) + k * 0.6 + Math.sin(state.realTime * 3.8) * 0.05 * k;
  mk.material.opacity = chase ? 0.92 : 1;
  // screen anchor for personal callouts
  tagV.copy(d.duck.group.position).setY(d.duck.group.position.y + 1.2).project(camera);
  if (tagV.z < 1) hud.setAnchor((tagV.x * 0.5 + 0.5) * renderer.domElement.clientWidth, (-tagV.y * 0.5 + 0.5) * renderer.domElement.clientHeight);
}

const sepTmp = new THREE.Vector3();
function separateDucks() {
  const n = state.ducks.length;
  for (let a = 0; a < n; a++) {
    const pa = state.ducks[a].duck.group.position;
    const sa = state.duckStates[a];
    if (sa.podiumSpot) continue;
    for (let b = a + 1; b < n; b++) {
      const sb = state.duckStates[b];
      if (sb.podiumSpot) continue;
      if (Math.abs(sa.s - sb.s) > 1.6) continue;
      const pb = state.ducks[b].duck.group.position;
      sepTmp.subVectors(pb, pa);
      sepTmp.y = 0;
      const d = sepTmp.length();
      const min = 1.15;
      if (d < min && d > 1e-4) {
        const push = (min - d) * 0.5;
        sepTmp.multiplyScalar(push / d);
        pb.add(sepTmp);
        pa.sub(sepTmp);
      }
    }
  }
}

// --------------------------------------------------------------------------- input
window.addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;
  if (state.phase === 'menu') return;
  const k = e.key;
  if (k === 'c' || k === 'C') cycleView();
  else if (k === 'f' || k === 'F') toggleFree();
  else if (k === 'm' || k === 'M') toggleSound();
  else if (k === ']' && state.ducks.length) { setTarget((state.target + 1) % state.ducks.length); }
  else if (k === '[' && state.ducks.length) { setTarget((state.target - 1 + state.ducks.length) % state.ducks.length); }
  else if (/^[1-9]$/.test(k)) setTarget(Number(k) - 1);
  else if ((k === ' ' || k === 'Enter') && rig.mode !== 'free') { if (state.phase === 'flythrough' || state.phase === 'grid') { skipIntro(); e.preventDefault(); } }
  else if (k === 'Escape') els.picker.hidden = true;
  else if ((k === 'r' || k === 'R') && state.phase === 'results') replay();
});
// tap a duck to ride with it
let downAt = null;
canvas.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY, t: performance.now() }));
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || !state.race) return;
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 8 || performance.now() - downAt.t > 400) return;
  if (state.phase === 'flythrough') { skipIntro(); return; }
  const rect = canvas.getBoundingClientRect();
  let best = -1;
  let bestD = 48;
  const v = new THREE.Vector3();
  state.ducks.forEach((d, i) => {
    v.copy(d.duck.group.position).setY(d.duck.group.position.y + 0.6).project(camera);
    if (v.z > 1) return;
    const sx = (v.x * 0.5 + 0.5) * rect.width + rect.left;
    const sy = (-v.y * 0.5 + 0.5) * rect.height + rect.top;
    const dd = Math.hypot(sx - e.clientX, sy - e.clientY);
    if (dd < bestD) { bestD = dd; best = i; }
  });
  if (best >= 0) { setTarget(best, true); if (state.view !== 'chase') { state.view = 'chase'; } applyView(false); hud.toast(state.raceNames[best], state.realTime, 1); }
});

// --------------------------------------------------------------------------- capture / debug hooks
function jump(t) {
  if (!state.race) return;
  els.results.hidden = true;
  state.podium = false;
  const lastT = Math.max(...state.race.finishTimes);
  const want = t > lastT + 1.5 ? 'finish' : 'race';
  if (state.phase !== want) setPhase(want);
  applyView(true);
  state.t = t;
  state.rate = 1;
  state.freezeUntil = 0;
  state.letterboxed = false;
  state.dropCalled = t > 15;
  state.replay = null;
  lowerThird(null);
  letterbox(false);
  $('#finish-card').hidden = true;
  state.jumping = true;
  state.cursor = state.timeline.findIndex((e) => e.t > t - 0.0001);
  if (state.cursor < 0) state.cursor = state.timeline.length;
  state.finishCount = state.race.finishTimes.filter((ft) => ft !== null && ft <= t).length;
  state.firstFinishT = state.finishCount ? Math.min(...state.race.finishTimes) : null;
  state.photoCalled = false;
  state.fireworks = state.finishCount > 0;
  state.podium = false;
  hud.clearTransient();
  computeDuckStates(t, 1 / 60);
  hud.settleItem(state.duckStates[state.target] && state.duckStates[state.target].held);
  hud.lastRank = -1; // forces a silent refresh of the position readout
  hud.lastTarget = state.target;
  for (const d of state.ducks) d.anim.prevLat = null;
  rig.cut();
  // settle springs
  for (let k = 0; k < 3; k++) rig.update(0.5, frameCtx(0.5));
  state.jumping = false;
}
window.__duckWorld = {
  get state() { return state; },
  get course() { return course; },
  get track() { return track; },
  get camera() { return camera; },
  get renderer() { return renderer; },
  get scene() { return scene; },
  jump,
  setTarget: (i) => { setTarget(i, true); applyView(false); },
  setView: (v) => { state.view = v; applyView(true); for (let k = 0; k < 3; k++) rig.update(0.5, frameCtx(0.5)); },
  setPhase: (p, time = 0) => { setPhase(p); state.phaseTime = time; rig.cut(); rig.update(0.5, frameCtx(0.5)); },
  start: (opts = {}) => { Object.assign(state, opts); startRace({}); },
  skip: skipIntro,
  results: () => { if (!state.race) return; jump(Math.max(...state.race.finishTimes) + 1); state.podium = true; setPhase('results'); rig.setMode('podium'); rig.cut(); rig.update(0.5, frameCtx(0.5)); },
  freeCam: (x, y, z, lx, ly, lz) => { state.prevView = state.view === 'free' ? state.prevView : state.view; state.view = 'free'; rig.setMode('free'); document.body.className = `phase-${state.phase} view-free`; rig.pos.set(x, y, z); rig.look.set(lx, ly, lz); const d = rig.look.clone().sub(rig.pos).normalize(); rig.free.yaw = Math.atan2(d.x, d.z); rig.free.pitch = Math.asin(clamp(d.y, -0.99, 0.99)); rig.free.vel.set(0, 0, 0); },
  eventsOf: (type) => (state.race ? state.race.events.filter((e) => e.type === type) : []),
};

boot().catch((err) => {
  console.error(err);
  bootMsg.textContent = /webgl|context/i.test(String(err && err.message)) ? 'WebGL is not available on this device/browser — try the 2D Duck Derby (index.html).' : 'Something went wrong: ' + err.message;
});
