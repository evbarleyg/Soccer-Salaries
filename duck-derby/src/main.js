// Duck Derby — app shell: setup UI, race director (state machine + timeline),
// HUD, commentary, results and sharing.

import { assignLooks, SAMPLE_NAMES, MIN_DUCKS, MAX_DUCKS, TOWELS } from './ducks.js';
import { createRace, standingsAt, TRACK_LENGTH } from './sim.js';
import { RaceScene } from './scene.js';
import { renderPortrait, drawDuck } from './draw-duck.js';
import { DuckAudio } from './audio.js';
import { Commentator, ordinal } from './commentary.js';
import { randomSeed, seedToCode, codeToSeed, clamp, lerp } from './rng.js';

const $ = (sel) => document.querySelector(sel);
const els = {
  scene: $('#scene'),
  setup: $('#setup'),
  roster: $('#roster'),
  sizeOut: $('#size-out'),
  ctaSub: $('#cta-sub'),
  start: $('#btn-start'),
  hud: $('#hud'),
  standings: $('#standings'),
  clock: $('#race-clock'),
  progressBar: $('#progress-bar'),
  progressDots: $('#progress-dots'),
  ticker: $('#ticker'),
  callout: $('#callout'),
  results: $('#results'),
  podium: $('#podium'),
  board: $('#draft-board'),
  resultsSub: $('#results-sub'),
  seedBadge: $('#seed-badge'),
  toast: $('#toast'),
  optLength: $('#opt-length'),
  optRule: $('#opt-rule'),
  optSeed: $('#opt-seed'),
  optHazards: $('#opt-hazards'),
  shareBanner: $('#share-banner'),
  sound: $('#btn-sound'),
};

const STORE_KEY = 'duckderby:v1';
const LENGTH_LABEL = { 24: 'sprint distance', 38: 'classic distance', 55: 'epic distance' };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const stored = loadStore();
const state = {
  phase: 'setup',
  phaseTime: 0,
  names: stored.names && stored.names.length >= MIN_DUCKS ? stored.names.slice(0, MAX_DUCKS) : new Array(12).fill(''),
  duration: [24, 38, 55].includes(stored.duration) ? stored.duration : 38,
  rule: stored.rule === 'last-first' ? 'last-first' : 'winner-first',
  salt: Number.isInteger(stored.salt) ? stored.salt : 0,
  hazards: stored.hazards !== false,
  sound: stored.sound !== false,
  shared: false,
  sharedSeed: null,
  seed: null,
  sim: null,
  looks: [],
  raceNames: [],
  t: 0,
  rate: 1,
  eventIdx: 0,
  hotdogIdx: 0,
  finished: 0,
  countdownStep: -1,
  photoCalled: false,
  winnerAt: null,
  lastHud: 0,
  prevRanks: new Map(),
};

const scene = new RaceScene(els.scene);
const audio = new DuckAudio();
audio.enabled = state.sound;
let commentator = null;

// ---------------------------------------------------------------------------
// Setup UI
// ---------------------------------------------------------------------------
function effectiveNames() {
  return state.names.map((n, i) => (n && n.trim() ? n.trim() : `Duck ${i + 1}`));
}

function refreshLooks() {
  state.looks = assignLooks(effectiveNames(), state.salt);
  scene.setLooks(state.looks);
  // avatars + lane chips
  const rows = els.roster.children;
  for (let i = 0; i < rows.length; i++) {
    const look = state.looks[i];
    if (!look) continue;
    const cv = rows[i].querySelector('canvas');
    renderPortrait(cv, look, { size: 44, t: 0.4 + i * 0.2 });
    const chip = rows[i].querySelector('.lane-no');
    chip.style.background = look.towel.bg;
    chip.style.color = look.towel.text;
  }
  updateCta();
}

function updateCta() {
  const n = state.names.length;
  els.sizeOut.textContent = String(n);
  els.ctaSub.textContent = `${n} ducks · ${LENGTH_LABEL[state.duration] || 'classic distance'}`;
  document.querySelectorAll('.chip[data-size]').forEach((b) => b.classList.toggle('active', Number(b.dataset.size) === n));
  els.start.querySelector('.cta-main').textContent = state.shared ? 'Replay shared race' : 'Start the Derby';
}

function renderRoster() {
  els.roster.innerHTML = '';
  state.names.forEach((name, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="lane-no" aria-hidden="true">${i + 1}</span>
      <canvas width="44" height="40" aria-hidden="true"></canvas>
      <input type="text" maxlength="22" placeholder="Duck ${i + 1} name" aria-label="Name for duck ${i + 1}" autocomplete="off" spellcheck="false" />
      <button type="button" class="remove" aria-label="Remove duck ${i + 1}" title="Remove">×</button>`;
    const input = li.querySelector('input');
    input.value = name;
    input.addEventListener('input', () => {
      state.names[i] = input.value;
      scheduleLooks();
      saveStore();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.metaKey || e.ctrlKey) {
          startDerby();
          return;
        }
        const inputs = [...els.roster.querySelectorAll('input')];
        const next = inputs[i + 1];
        if (next) next.focus();
        else if (state.names.length < MAX_DUCKS) {
          setSize(state.names.length + 1);
          els.roster.querySelectorAll('input')[i + 1]?.focus();
        } else els.start.focus();
      }
    });
    li.querySelector('.remove').addEventListener('click', () => {
      if (state.names.length <= MIN_DUCKS) {
        toast(`Need at least ${MIN_DUCKS} ducks`);
        return;
      }
      state.names.splice(i, 1);
      renderRoster();
      saveStore();
    });
    els.roster.appendChild(li);
  });
  refreshLooks();
}

let looksTimer = 0;
function scheduleLooks() {
  clearTimeout(looksTimer);
  looksTimer = setTimeout(refreshLooks, 140);
}

function setSize(n) {
  n = clamp(Math.round(n), MIN_DUCKS, MAX_DUCKS);
  if (n === state.names.length) return;
  if (n > state.names.length) {
    while (state.names.length < n) state.names.push('');
  } else {
    state.names.length = n;
  }
  renderRoster();
  saveStore();
}

document.querySelectorAll('.chip[data-size]').forEach((b) => b.addEventListener('click', () => setSize(Number(b.dataset.size))));
$('#size-minus').addEventListener('click', () => setSize(state.names.length - 1));
$('#size-plus').addEventListener('click', () => setSize(state.names.length + 1));
$('#btn-sample').addEventListener('click', () => {
  const pool = SAMPLE_NAMES.slice().sort(() => Math.random() - 0.5);
  state.names = state.names.map((n, i) => (n && n.trim() ? n : pool[i % pool.length]));
  renderRoster();
  saveStore();
});
$('#btn-clear').addEventListener('click', () => {
  state.names = state.names.map(() => '');
  renderRoster();
  saveStore();
});
$('#btn-shuffle-looks').addEventListener('click', () => {
  state.salt = (state.salt + 1) % 1000;
  refreshLooks();
  saveStore();
  toast('Fresh feathers!');
});
els.optLength.value = String(state.duration);
els.optRule.value = state.rule;
els.optLength.addEventListener('change', () => {
  state.duration = Number(els.optLength.value);
  updateCta();
  saveStore();
});
els.optRule.addEventListener('change', () => {
  state.rule = els.optRule.value;
  saveStore();
});
els.optHazards.value = state.hazards ? 'on' : 'off';
els.optHazards.addEventListener('change', () => {
  state.hazards = els.optHazards.value === 'on';
  saveStore();
});
els.start.addEventListener('click', () => startDerby());

// sound + fullscreen
function syncSoundButton() {
  els.sound.setAttribute('aria-pressed', String(state.sound));
}
els.sound.addEventListener('click', () => {
  state.sound = !state.sound;
  audio.unlock();
  audio.setEnabled(state.sound);
  syncSoundButton();
  saveStore();
});
syncSoundButton();
$('#btn-fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});

// ---------------------------------------------------------------------------
// Persistence + share links
// ---------------------------------------------------------------------------
function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
function saveStore() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ names: state.names, duration: state.duration, rule: state.rule, salt: state.salt, sound: state.sound, hazards: state.hazards }),
    );
  } catch {
    /* private mode etc. */
  }
}

function readShareParams() {
  const p = new URLSearchParams(location.search);
  const namesRaw = p.get('names');
  if (!namesRaw) return;
  const names = namesRaw.split('~').map((s) => s.slice(0, 22));
  if (names.length < MIN_DUCKS || names.length > MAX_DUCKS) return;
  state.names = names;
  const seed = codeToSeed(p.get('seed'));
  if (seed !== null) {
    state.sharedSeed = seed;
    state.shared = true;
    els.optSeed.value = seedToCode(seed);
  }
  const len = Number(p.get('len'));
  if ([24, 38, 55].includes(len)) state.duration = len;
  state.rule = p.get('rule') === 'l' ? 'last-first' : 'winner-first';
  const salt = Number(p.get('salt'));
  if (Number.isInteger(salt)) state.salt = salt;
  state.hazards = p.get('hz') !== '0';
  els.optLength.value = String(state.duration);
  els.optRule.value = state.rule;
  els.optHazards.value = state.hazards ? 'on' : 'off';
  els.shareBanner.hidden = false;
}

function shareUrl() {
  const u = new URL(location.href);
  u.search = '';
  u.hash = '';
  const p = new URLSearchParams();
  p.set('names', state.raceNames.join('~'));
  p.set('seed', seedToCode(state.seed));
  p.set('len', String(state.duration));
  p.set('rule', state.rule === 'last-first' ? 'l' : 'w');
  if (state.salt) p.set('salt', String(state.salt));
  if (!state.hazards) p.set('hz', '0');
  u.search = p.toString();
  return u.toString();
}

// ---------------------------------------------------------------------------
// Race director
// ---------------------------------------------------------------------------
function setPhase(phase) {
  state.phase = phase;
  state.phaseTime = 0;
  document.body.className = `phase-${phase}`;
  els.setup.hidden = phase !== 'setup';
  els.hud.hidden = !(phase === 'intro' || phase === 'countdown' || phase === 'race' || phase === 'finish');
  els.ticker.hidden = els.hud.hidden;
  els.results.hidden = phase !== 'results';
  els.seedBadge.hidden = phase === 'setup' || !state.seed;
  updateInsets();
}

function updateInsets() {
  const mobile = window.innerWidth <= 720;
  const insets = { left: 0, right: 0, top: 0, bottom: 0 };
  if (state.phase === 'setup' && !mobile) {
    const r = els.setup.getBoundingClientRect();
    insets.left = Math.min(r.right + 10, window.innerWidth * 0.55);
  } else if (['intro', 'countdown', 'race', 'finish'].includes(state.phase)) {
    if (mobile) insets.top = 120;
    else insets.right = (els.hud.getBoundingClientRect().width || 250) + 20;
    const tr = els.ticker.getBoundingClientRect();
    insets.bottom = Math.max(0, window.innerHeight - tr.top) + 4;
  }
  scene.setInsets(insets);
  scene.layout();
}

function startDerby({ seed: forcedSeed, keepSeedInput = true } = {}) {
  audio.unlock();
  audio.startAmbience();
  const names = effectiveNames();
  let seed = forcedSeed ?? null;
  if (seed === null) {
    const typed = keepSeedInput ? codeToSeed(els.optSeed.value) : null;
    seed = typed ?? (state.shared && state.sharedSeed !== null ? state.sharedSeed : randomSeed());
  }
  state.seed = seed >>> 0;
  state.raceNames = names;
  state.sim = createRace({ count: names.length, seed: state.seed, duration: state.duration, hazards: state.hazards });
  state.looks = assignLooks(names, state.salt);
  state.t = 0;
  state.rate = 1;
  state.eventIdx = 0;
  state.hotdogIdx = 0;
  state.finished = 0;
  state.countdownStep = -1;
  state.photoCalled = false;
  state.winnerAt = null;
  state.prevRanks = new Map();
  commentator = new Commentator(names);
  scene.setRace(state.sim, state.looks);
  scene.slowmo = 0;
  buildStandings();
  els.seedBadge.textContent = `SEED ${seedToCode(state.seed)}`;
  setPhase('intro');
  scene.snapCamera(0);
  clearTicker();
  say(commentator.intro(names.length), 2);
  audio.setCrowd(0.25);
}

function skipToResults() {
  if (!state.sim) return;
  // fast-forward silently
  const lastT = Math.max(...state.sim.finishTimes) + 0.5;
  state.t = lastT;
  state.eventIdx = state.sim.events.length;
  state.finished = state.sim.count;
  showResults();
}
$('#btn-skip').addEventListener('click', skipToResults);

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
function buildStandings() {
  els.standings.innerHTML = '';
  els.progressDots.innerHTML = '';
  const n = state.looks.length;
  const mobile = window.innerWidth <= 720;
  const avail = els.standings.clientHeight || 400;
  const rowH = mobile ? 29 : clamp(Math.floor(avail / n), 22, 34);
  els.standings.style.setProperty('--row-h', `${rowH - 2}px`);
  state.rowH = rowH;
  state.looks.forEach((look, i) => {
    const li = document.createElement('li');
    li.dataset.duck = String(i);
    li.innerHTML = `<span class="pos">${i + 1}</span><span class="num" style="background:${look.towel.bg};color:${look.towel.text}">${look.number}</span><span class="name"></span><span class="gap"></span>`;
    li.querySelector('.name').textContent = look.name;
    li.style.transform = mobile ? `translateX(${i * 136}px)` : `translateY(${i * rowH}px)`;
    els.standings.appendChild(li);
    const dot = document.createElement('i');
    dot.style.background = look.towel.bg;
    dot.title = look.name;
    els.progressDots.appendChild(dot);
  });
}

function updateHud(force = false) {
  const now = performance.now();
  if (!force && now - state.lastHud < 90) return;
  state.lastHud = now;
  const sim = state.sim;
  if (!sim) return;
  const t = state.phase === 'race' || state.phase === 'finish' ? state.t : 0;
  const rows = standingsAt(sim, t);
  const mobile = window.innerWidth <= 720;
  const leaderX = rows[0].x;
  const items = els.standings.children;
  const dots = els.progressDots.children;
  rows.forEach((r, rank) => {
    const li = items[r.i];
    if (!li) return;
    li.style.transform = mobile ? `translateX(${rank * 136}px)` : `translateY(${rank * state.rowH}px)`;
    li.classList.toggle('leader', rank === 0 && !r.done && t > 0);
    li.classList.toggle('done', r.done);
    li.querySelector('.pos').textContent = String(rank + 1);
    const gapEl = li.querySelector('.gap');
    const prev = state.prevRanks.get(r.i);
    let arrow = '';
    if (prev !== undefined && prev !== rank && t > 0.5) arrow = prev > rank ? '<b class="arrow up">▲</b>' : '<b class="arrow down">▼</b>';
    if (r.done) {
      gapEl.className = 'gap fin';
      gapEl.innerHTML = `${r.ft.toFixed(2)}s`;
    } else if (rank === 0) {
      gapEl.className = 'gap lead';
      gapEl.innerHTML = t > 0 ? `LEADER${arrow}` : '';
    } else {
      gapEl.className = 'gap';
      const meters = (leaderX - r.x) / 10;
      gapEl.innerHTML = t > 0 ? `+${meters.toFixed(1)}m${arrow}` : '';
    }
    state.prevRanks.set(r.i, rank);
    if (dots[r.i]) dots[r.i].style.left = `${clamp((r.x / TRACK_LENGTH) * 100, 0, 100)}%`;
  });
  els.progressBar.style.width = `${clamp((leaderX / TRACK_LENGTH) * 100, 0, 100)}%`;
  els.clock.textContent = t.toFixed(1);
}

// ticker ------------------------------------------------------------------
const tickerQueue = [];
let tickerShownAt = 0;
let tickerCurrentPri = 0;
function say(text, priority = 1) {
  if (!text) return;
  tickerQueue.push({ text, priority, at: performance.now() });
  // keep the queue fresh: drop stale low-priority lines
  while (tickerQueue.length > 3) {
    const idx = tickerQueue.findIndex((l) => l.priority < 2);
    tickerQueue.splice(idx >= 0 ? idx : 0, 1);
  }
  pumpTicker();
}
function clearTicker() {
  tickerQueue.length = 0;
  els.ticker.innerHTML = '';
  tickerShownAt = 0;
}
function pumpTicker() {
  const now = performance.now();
  if (!tickerQueue.length) return;
  const minHold = tickerCurrentPri >= 2 ? 2200 : 1500;
  if (now - tickerShownAt < minHold && els.ticker.innerHTML) return;
  const line = tickerQueue.shift();
  tickerShownAt = now;
  tickerCurrentPri = line.priority;
  els.ticker.innerHTML = `<span class="mic" aria-hidden="true">🎙️</span><span class="line"></span>`;
  els.ticker.querySelector('.line').textContent = line.text;
}

// callouts ----------------------------------------------------------------
function callout(text, kind = 'big') {
  const el = document.createElement('div');
  el.className = kind;
  el.textContent = text;
  els.callout.innerHTML = '';
  els.callout.appendChild(el);
  const ttl = kind.startsWith('wide') ? 1900 : 850;
  setTimeout(() => el.remove(), ttl);
}

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove('show'), 1800);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  state.phaseTime += dt;

  switch (state.phase) {
    case 'intro':
      if (state.phaseTime > 1.7) {
        setPhase('countdown');
      }
      break;
    case 'countdown': {
      const step = Math.floor(state.phaseTime / 0.92);
      if (step !== state.countdownStep && step <= 3) {
        state.countdownStep = step;
        if (step < 3) {
          callout(String(3 - step));
          audio.beep(false);
        } else {
          callout('GO!', 'big go');
          audio.beep(true);
          audio.horn();
          scene.shake = 0.6;
          setPhase('race');
          say(commentator.go(), 2);
          for (let i = 0; i < state.looks.length; i++) scene.splash(i, 0, 6, true);
        }
      }
      break;
    }
    case 'race':
    case 'finish':
      advanceRace(dt);
      break;
    default:
      break;
  }

  scene.update(dt, state.t, state.phase);
  scene.render(state.t, state.phase);
  if (!els.hud.hidden) {
    updateHud();
    pumpTicker();
  }
  requestAnimationFrame(frame);
}

function advanceRace(dt) {
  const sim = state.sim;
  const n = sim.count;
  // --- playback rate: photo-finish slow-mo, tail-end speed-up ---
  let target = 1;
  let leadX = 0;
  let leader = 0;
  for (let i = 0; i < n; i++) {
    const x = scene.duckX(i, state.t);
    if (x > leadX) {
      leadX = x;
      leader = i;
    }
  }
  const remaining = TRACK_LENGTH - leadX;
  if (state.finished === 0 && sim.photoFinish && remaining < TRACK_LENGTH * 0.055) {
    target = remaining < TRACK_LENGTH * 0.03 ? 0.28 : 0.5;
    if (!state.photoCalled) {
      state.photoCalled = true;
      callout('PHOTO FINISH!', 'wide');
      say('It is desperately close — PHOTO FINISH!', 3);
    }
  } else if (state.finished === 0 && remaining < TRACK_LENGTH * 0.02) {
    target = 0.6; // a little hang-time at the line for everyone
  }
  if (state.winnerAt !== null && state.t - state.winnerAt > 0.35) target = 1;
  if (state.finished >= Math.min(3, n) && state.finished < n) {
    const lastT = Math.max(...sim.finishTimes);
    if (lastT - state.t > 2.5) target = 2.2;
  }
  scene.slowmo = lerp(scene.slowmo, target < 0.7 && state.finished === 0 ? 1 : 0, 1 - Math.exp(-dt * 4));
  state.rate = lerp(state.rate, target, 1 - Math.exp(-dt * 5));
  state.t += dt * state.rate;

  // --- hot dogs need flight time: launch the projectile ahead of the impact ---
  const events = sim.events;
  while (state.hotdogIdx < events.length) {
    const ev = events[state.hotdogIdx];
    if (ev.type !== 'hotdog') {
      state.hotdogIdx++;
      continue;
    }
    if (ev.t - state.t > 0.8) break;
    scene.launchHotdog(ev.duck, state.t, ev.t);
    audio.whistle(Math.max(0.2, ev.t - state.t));
    state.hotdogIdx++;
  }

  // --- events ---
  while (state.eventIdx < events.length && events[state.eventIdx].t <= state.t) {
    const ev = events[state.eventIdx++];
    handleEvent(ev);
  }

  // crowd excitement follows the race
  audio.setCrowd(clamp(0.3 + (leadX / TRACK_LENGTH) * 0.5 + scene.cheer * 0.4, 0, 1));

  if (state.phase === 'race' && state.finished >= n) {
    setPhase('finish');
    audio.fanfare();
  }
  if (state.phase === 'finish' && state.phaseTime > 2.6) showResults();
}

function handleEvent(ev) {
  const look = state.looks[ev.duck];
  scene.onEvent(ev, state.t);
  const standings = standingsAt(state.sim, state.t);
  switch (ev.type) {
    case 'burst':
      if (Math.random() < 0.7) audio.quack(look.quackPitch, 0.35);
      audio.splash(0.18);
      say(commentator.forEvent(ev, standings, state.t), 1);
      break;
    case 'stumble':
      audio.splash(0.12);
      say(commentator.forEvent(ev, standings, state.t), 1);
      break;
    case 'hotdog':
      audio.bonk();
      audio.ooh();
      audio.quack(look.quackPitch * 1.3, 0.5);
      callout('HOT DOG!', 'wide');
      say(commentator.forEvent(ev, standings, state.t), 3);
      break;
    case 'lead':
      audio.cheer(0.22, 1.2);
      say(commentator.forEvent(ev, standings, state.t), 2);
      break;
    case 'halfway':
      say(commentator.forEvent(ev, standings, state.t), 2);
      break;
    case 'stretch':
      callout('FINAL STRETCH', 'wide');
      audio.cheer(0.3, 2.5);
      say(commentator.forEvent(ev, standings, state.t), 3);
      break;
    case 'finish': {
      state.finished++;
      const place = state.finished;
      if (place === 1) {
        state.winnerAt = state.t;
        scene.flash = state.sim.photoFinish ? 1 : 0.6;
        scene.shake = 0.5;
        audio.cameraFlash();
        audio.cheer(0.5, 3);
        audio.quack(look.quackPitch, 0.5);
        setTimeout(() => callout(`${look.name} WINS!`, 'wide gold'), 350);
      } else if (place <= 3) {
        audio.cheer(0.25, 1.2);
      }
      say(commentator.finishLine(ev.duck, place, state.sim.photoFinish), place === 1 ? 3 : 1);
      updateHud(true);
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
function draftOrder() {
  const order = state.sim.order.slice();
  return state.rule === 'last-first' ? order.reverse() : order;
}

function showResults() {
  setPhase('results');
  audio.setCrowd(0.15);
  const sim = state.sim;
  const order = sim.order; // by finish
  const picks = draftOrder();
  const winnerT = sim.finishTimes[order[0]];
  els.resultsSub.textContent = `${state.raceNames.length} ducks · ${sim.photoFinish ? 'photo finish' : `won by ${(sim.margin).toFixed(2)}s`} · ${sim.leadChanges} lead change${sim.leadChanges === 1 ? '' : 's'} · seed ${seedToCode(state.seed)}${state.rule === 'last-first' ? ' · last place picks first' : ''}`;

  // podium: 2nd, 1st, 3rd
  els.podium.innerHTML = '';
  const podiumIdx = [order[1], order[0], order[2]].filter((v) => v !== undefined);
  const places = order.length >= 3 ? [2, 1, 3] : order.length === 2 ? [2, 1] : [1];
  podiumIdx.forEach((duck, k) => {
    const place = places[k];
    const look = state.looks[duck];
    const card = document.createElement('div');
    card.className = `step-card place-${place}`;
    card.innerHTML = `<canvas></canvas><div class="plinth"><div class="pl-place">${ordinal(place)}</div><div class="pl-name"></div><div class="pl-time">${sim.finishTimes[duck].toFixed(2)}s</div></div>`;
    card.querySelector('.pl-name').textContent = look.name;
    els.podium.appendChild(card);
    const cv = card.querySelector('canvas');
    requestAnimationFrame(() => renderPortrait(cv, look, { standing: true, t: 1 + k }));
  });

  // draft board
  els.board.innerHTML = '';
  picks.forEach((duck, k) => {
    const look = state.looks[duck];
    const place = order.indexOf(duck) + 1;
    const li = document.createElement('li');
    li.style.animationDelay = `${k * 45}ms`;
    const tag = place === 1 ? '<span class="tag">🏆 Champion</span>' : place === order.length ? '<span class="tag">🥄 Last in</span>' : '';
    li.innerHTML = `<div class="pick"><small>PICK</small>${k + 1}</div><canvas></canvas><div class="who"><span class="nm"></span>${tag}</div><div class="meta">${ordinal(place)} · ${sim.finishTimes[duck].toFixed(2)}s${place > 1 ? `<br>+${(sim.finishTimes[duck] - winnerT).toFixed(2)}s` : ''}</div>`;
    li.querySelector('.nm').textContent = look.name;
    els.board.appendChild(li);
    renderPortrait(li.querySelector('canvas'), look, { size: 46, t: k * 0.3 });
  });
  history.replaceState(null, '', shareUrl());
}

$('#btn-again').addEventListener('click', () => {
  els.optSeed.value = '';
  state.shared = false;
  startDerby({ seed: randomSeed() });
});
$('#btn-replay').addEventListener('click', () => startDerby({ seed: state.seed }));
$('#btn-edit').addEventListener('click', () => {
  state.shared = false;
  els.shareBanner.hidden = true;
  scene.sim = null;
  scene.setLooks(state.looks);
  setPhase('setup');
  refreshLooks();
  scene.snapCamera(0);
});
$('#btn-copy').addEventListener('click', () => {
  const picks = draftOrder();
  const lines = picks.map((d, k) => `${k + 1}. ${state.looks[d].name}`);
  const text = `🦆 Duck Derby — Official Draft Order (seed ${seedToCode(state.seed)})\n${lines.join('\n')}\nReplay: ${shareUrl()}`;
  copyText(text, 'Draft order copied');
});
$('#btn-share').addEventListener('click', () => copyText(shareUrl(), 'Share link copied — anyone can replay this exact race'));
$('#btn-save').addEventListener('click', saveImage);

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast(okMsg);
    } catch {
      toast('Copy failed — long-press to copy from the address bar');
    }
    ta.remove();
  }
}

function saveImage() {
  const picks = draftOrder();
  const order = state.sim.order;
  const W = 1080;
  const rowH = 74;
  const H = 260 + picks.length * rowH + 60;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#2F7FD8');
  g.addColorStop(1, '#1560A8');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  for (let i = 0; i < 40; i++) ctx.fillRect(((i * 97) % W), 200 + ((i * 53) % (H - 200)), 60, 3);
  ctx.fillStyle = '#fff';
  ctx.font = '400 64px Bungee, ui-rounded, system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText('DUCK DERBY', 60, 50);
  ctx.fillStyle = '#FFD23F';
  ctx.font = '900 30px Nunito, ui-rounded, system-ui, sans-serif';
  ctx.fillText('OFFICIAL DRAFT ORDER', 64, 128);
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.font = '800 22px Nunito, ui-rounded, system-ui, sans-serif';
  ctx.fillText(`Seed ${seedToCode(state.seed)} · ${new Date().toLocaleDateString()}${state.rule === 'last-first' ? ' · last place picks first' : ''}`, 64, 170);
  // winner portrait top-right
  drawDuck(ctx, state.looks[order[0]], { x: W - 170, y: 150, scale: 2.4, t: 1, standing: true, effort: 0 });
  picks.forEach((duck, k) => {
    const y = 230 + k * rowH;
    const look = state.looks[duck];
    ctx.fillStyle = k % 2 ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.16)';
    roundRect(ctx, 50, y, W - 100, rowH - 10, 18);
    ctx.fill();
    ctx.fillStyle = '#FFD23F';
    ctx.font = '400 34px Bungee, ui-rounded, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(String(k + 1), 100, y + rowH / 2 - 4);
    ctx.textAlign = 'left';
    drawDuck(ctx, look, { x: 190, y: y + rowH / 2 + 6, scale: 0.62, t: k, effort: 0.2 });
    ctx.fillStyle = '#fff';
    ctx.font = '900 30px Nunito, ui-rounded, system-ui, sans-serif';
    ctx.fillText(look.name, 250, y + rowH / 2 - 4);
    const place = order.indexOf(duck) + 1;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '800 22px Nunito, ui-rounded, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${ordinal(place)} · ${state.sim.finishTimes[duck].toFixed(2)}s`, W - 80, y + rowH / 2 - 4);
    ctx.textAlign = 'left';
  });
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '700 18px Nunito, ui-rounded, system-ui, sans-serif';
  ctx.textBaseline = 'bottom';
  ctx.fillText(location.host ? `${location.host}${location.pathname}` : 'Duck Derby', 60, H - 24);
  c.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `duck-derby-draft-order-${seedToCode(state.seed)}.png`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 500);
    toast('Image saved');
  }, 'image/png');
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
readShareParams();
renderRoster();
window.addEventListener('resize', () => {
  scene.resize();
  updateInsets();
  if (state.sim && !els.hud.hidden) buildStandings();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && (state.phase === 'race' || state.phase === 'countdown' || state.phase === 'intro')) skipToResults();
});
scene.resize();
setPhase('setup');
scene.snapCamera(0);
requestAnimationFrame((t) => {
  lastFrame = t;
  frame(t);
});
// expose for debugging / automated capture
window.__duckDerby = {
  state,
  scene,
  startDerby,
  skipToResults,
  /** testing hook: jump the race clock (events in between are applied without sound) */
  jump(t) {
    if (!state.sim) return;
    if (state.phase === 'intro' || state.phase === 'countdown') setPhase('race');
    const wasEnabled = audio.enabled;
    audio.enabled = false;
    if (audio.master) audio.master.gain.value = 0;
    state.t = t;
    const events = state.sim.events;
    while (state.eventIdx < events.length && events[state.eventIdx].t <= state.t) handleEvent(events[state.eventIdx++]);
    state.hotdogIdx = state.eventIdx;
    audio.enabled = wasEnabled;
    scene.snapCamera(state.t);
    updateHud(true);
  },
};
