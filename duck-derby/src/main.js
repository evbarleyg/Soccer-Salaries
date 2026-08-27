// Duck Derby — app shell: setup UI, race director (state machine + timeline),
// HUD, commentary, results and sharing.
//
// The race itself is precomputed and deterministic (src/sim.js); everything in
// here is playback: the director only ever moves the race clock `state.t` and
// its playback `rate`, so replays and share links stay identical and fair.

import { assignLooks, SAMPLE_NAMES, MIN_DUCKS, MAX_DUCKS, normalizeName } from './ducks.js';
import { createRace, standingsAt, TRACK_LENGTH } from './sim.js';
import { RaceScene } from './scene.js';
import { renderPortrait, drawDuck } from './draw-duck.js';
import { DuckAudio } from './audio.js';
import { Commentator, ordinal } from './commentary.js';
import { randomSeed, seedToCode, codeToSeed, canonicalSeedCode, clamp, lerp } from './rng.js';
import { encodeShare, decodeShare, sanitizeName, sanitizeLeague, truncateCodePoints, NAME_MAX } from './share.js';

const $ = (sel) => document.querySelector(sel);
const els = {
  scene: $('#scene'),
  setup: $('#setup'),
  roster: $('#roster'),
  sizeOut: $('#size-out'),
  ctaSub: $('#cta-sub'),
  start: $('#btn-start'),
  hud: $('#hud'),
  hudLeague: $('#hud-league'),
  standings: $('#standings'),
  clock: $('#race-clock'),
  progressBar: $('#progress-bar'),
  progressDots: $('#progress-dots'),
  pause: $('#btn-pause'),
  skip: $('#btn-skip'),
  ticker: $('#ticker'),
  callout: $('#callout'),
  srLive: $('#sr-live'),
  results: $('#results'),
  resultsTitle: $('#results-title'),
  resultsOverline: $('#results-overline'),
  resultsSub: $('#results-sub'),
  hero: $('#hero'),
  podiumCap: $('#podium-cap'),
  podium: $('#podium'),
  board: $('#draft-board'),
  actions: $('#results .results-actions'),
  confirmNew: $('#confirm-new'),
  seedBadge: $('#seed-badge'),
  brandTag: $('#brand-tag'),
  toast: $('#toast'),
  optLeague: $('#opt-league'),
  optLength: $('#opt-length'),
  optSeed: $('#opt-seed'),
  optHazards: $('#opt-hazards'),
  optMotion: $('#opt-motion'),
  ruleHelp: $('#rule-help'),
  shareBanner: $('#share-banner'),
  sound: $('#btn-sound'),
  fullscreen: $('#btn-fullscreen'),
  safeProbe: $('#safe-probe'),
};
const ruleChips = [...document.querySelectorAll('.chip[data-rule]')];
const sizeChips = [...document.querySelectorAll('.chip[data-size]')];

const STORE_KEY = 'duckderby:v1';
const DEFAULT_TITLE = document.title;
const DEFAULT_TAG = 'Draft Order Decider';
const LENGTH_LABEL = { 24: 'sprint distance', 38: 'classic distance', 55: 'epic distance' };
const RACE_PHASES = ['intro', 'countdown', 'race', 'finish'];
const PAUSABLE = ['countdown', 'race', 'finish'];

/** Draft conventions. The race is identical under every rule; only the mapping to picks changes. */
const RULES = {
  'winner-first': {
    help: '1st across the line drafts 1.01, 2nd drafts 1.02…',
    h2: 'Official Draft Order',
    sentence: 'Winner takes the 1.01',
    header: 'Pick',
    pill: 'WINNER PICKS FIRST',
  },
  'winner-choice': {
    help: '1st across the line chooses any draft slot, then 2nd chooses…',
    h2: 'Draft Slot Selection Order',
    sentence: 'Winner chooses a slot first',
    header: 'Chooses',
    pill: 'WINNER CHOOSES FIRST',
  },
  'last-first': {
    help: 'Dead last drafts 1.01 — the race winner picks last (toilet-bowl rules)',
    h2: 'Official Draft Order — Last Place Picks First',
    sentence: 'Last duck home gets the 1.01',
    header: 'Pick',
    pill: 'LAST PLACE PICKS FIRST',
  },
};
const normRule = (rule) => (Object.prototype.hasOwnProperty.call(RULES, rule) ? rule : 'winner-first');

// Director timing (seconds). Playback-side only — none of this touches the sim.
const INTRO_SEC = 2.2; // 'intro' phase length; scene.introDur mirrors it for the camera
const COUNT_STEP = 0.92; // seconds per countdown light
const TELEGRAPH_LEAD = 1.5; // hot dog: thrower/reticle beat this long before impact
const LAUNCH_LEAD = 0.8; // hot dog: projectile flight time
const FOLLOWUP_DELAY = 2.2; // hot dog: "drops from 1st to 4th" line this long after impact
const FINISH_HOLD = 2.6; // 'finish' phase length before the results panel

// Compact layout = phones (portrait) and short/landscape viewports. One query, shared with styles.css.
const compactMQ = window.matchMedia('(max-width: 720px), (max-height: 500px)');
const isCompact = () => compactMQ.matches;
const coarseMQ = window.matchMedia('(pointer: coarse)');
const FX_PARAM = new URLSearchParams(location.search).get('fx') || ''; // '0'|'1'|'2' pins the quality tier

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const stored = loadStore();
const state = {
  phase: 'setup',
  phaseTime: 0,
  names: stored.names?.length >= MIN_DUCKS ? stored.names : new Array(12).fill(''),
  duration: [24, 38, 55].includes(stored.duration) ? stored.duration : 38,
  rule: normRule(stored.rule),
  salt: Number.isSafeInteger(stored.salt) ? stored.salt : 0,
  hazards: stored.hazards !== false,
  sound: stored.sound !== false,
  calm: stored.calm === true,
  league: stored.league || '',
  shared: false, // roster + seed came from a share link and are untouched
  sharedSeed: null,
  sharedRun: false, // the race on screen replays a shared link (results offer "Watch again" / guarded "New race")
  entry: { autoplay: false, view: '' }, // deep-link flags (only honoured together with a valid shared race)
  seedTyped: false, // the code in #opt-seed was typed by the user this session (not from a link, not yet raced)
  seed: null,
  sim: null,
  looks: [],
  raceNames: [],
  lastRoster: null, // snapshot for the Undo toast
  startWarnAt: 0, // first Start press with unnamed ducks (second press within 8 s races anyway)
  // director (reset per race by resetDirector)
  t: 0,
  rate: 1,
  eventIdx: 0,
  hotdogIdx: 0,
  finished: 0,
  countdownStep: -1,
  photoCalled: false,
  winnerAt: null,
  telegraphed: new Set(), // event indices whose hot dog has been telegraphed (never mutate sim.events)
  followUps: [], // {t, duck, rankBefore}: hot-dog aftermath lines
  victims: new Set(), // ducks hit by a hot dog this race
  avenged: new Set(), // victims who retook the lead (REVENGE! fires once each)
  tailCalled: false,
  tailDuel: false,
  holdLeft: 0, // wall-clock hold (hit-stop): seconds remaining
  holdMul: 0.05,
  calloutFreeAt: 0, // performance.now() after which a wide callout may be replaced politely (informational; ribbons are ranked)
  paused: false,
  // live-order board (display side; see updateHud)
  lastHud: 0,
  lastGap: 0,
  lastReorder: 0,
  rowH: 32,
  hudRows: [], // <li> per duck (lane order) with cached child refs
  hudOrder: [], // duck ids as currently displayed, top to bottom
  hudLeader: -1,
  pendingSince: new Map(), // "a>b" displayed pair the truth disagrees with -> since when
  rankMeta: new Map(), // duck -> {rank, dir, at}
  tickerH: 0,
  // broadcast (commentary sampling at fixed race-clock instants — deterministic per share link)
  pollT: 0, // last 0.25 s grid instant sampled
  rankHist: [], // ranks[] per sample, newest last (13 samples = 3 s)
  timeLed: [], // seconds each duck has led (accumulated on the grid)
  lastChatterT: -9, // race time of the last pri-1 line that aired
  lastSpokenT: 0, // race time of the last line of any priority
  transcript: [], // {t, pri, text} for every line handed to the ticker this race
  leadStreak: 0, // seconds the current leader has led without interruption (grid-accumulated)
  streakDuck: -1,
  slowmoSent: 0, // last slow-mo amount pushed to the audio engine
  homeTimer: 0, // "everyone home" fanfare tag
  // results ceremony
  revealTimers: [],
  roll: null, // drumroll handle
  podiumRaf: 0,
  ambienceTimer: 0, // stops the crowd/water beds 20 s into the results
};

const scene = new RaceScene(els.scene);
scene.setCalm(state.calm);
const audio = new DuckAudio();
audio.enabled = state.sound;
let commentator = null;
let raceGen = 0; // bumps every startDerby; guards deferred work from a superseded race
let safe = { top: 0, right: 0, bottom: 0, left: 0 }; // resolved env(safe-area-inset-*) in px

// The automated-capture hook (window.__duckDerby.jump) replays past events with
// sound off and, for stale events, without banners/ticker lines.
const mute = { sfx: false, ui: false };
const SILENT = new Proxy(Object.freeze({}), { get: () => () => undefined });
const sfx = () => (mute.sfx ? SILENT : audio);

// ---------------------------------------------------------------------------
// Setup UI
// ---------------------------------------------------------------------------
/**
 * Race names exactly as both ends of a share link will see (and hash) them:
 * sanitised, blanks become "Duck 7", and the 2nd+ occurrence of a name gets
 * " (2)", " (3)"… so the HUD, board, PNG and commentary can tell them apart.
 */
function effectiveNames() {
  const base = state.names.map((n, i) => sanitizeName(n) || `Duck ${i + 1}`);
  const seen = new Map();
  return base.map((name) => {
    const key = normalizeName(name);
    const c = (seen.get(key) || 0) + 1;
    seen.set(key, c);
    if (c === 1) return name;
    const suffix = ` (${c})`;
    return truncateCodePoints(name, NAME_MAX - suffix.length) + suffix;
  });
}

/** Indices of roster rows whose typed name repeats an earlier row. */
function duplicateRows() {
  const seen = new Set();
  const dups = new Set();
  state.names.forEach((n, i) => {
    const key = normalizeName(sanitizeName(n));
    if (!key) return;
    if (seen.has(key)) dups.add(i);
    seen.add(key);
  });
  return dups;
}

function refreshLooks() {
  const names = effectiveNames();
  state.looks = assignLooks(names, state.salt);
  scene.setLooks(state.looks);
  const dups = duplicateRows();
  // avatars + lane chips
  const rows = els.roster.children;
  for (let i = 0; i < rows.length; i++) {
    const look = state.looks[i];
    if (!look) continue;
    const cv = rows[i].querySelector('canvas');
    const key = `${look.palette.id}|${look.hat}|${look.towel.bg}|${look.cheeks ? 1 : 0}`;
    if (cv._key !== key) {
      renderPortrait(cv, look, { w: 44, h: 40, t: 0.4 + i * 0.2 });
      cv._key = key;
    }
    const chip = rows[i].querySelector('.lane-no');
    chip.style.background = look.towel.bg;
    chip.style.color = look.towel.text;
    const dup = dups.has(i);
    rows[i].classList.toggle('dup', dup);
    rows[i].title = dup ? `Same name twice — shown as "${names[i]}"` : '';
  }
  updateCta();
}

function blankRows() {
  const out = [];
  state.names.forEach((n, i) => {
    if (!sanitizeName(n)) out.push(i);
  });
  return out;
}

function updateCta() {
  const n = state.names.length;
  els.sizeOut.textContent = String(n);
  const blanks = blankRows().length;
  const typed = n - blanks;
  els.setup.classList.toggle('compact-head', typed > 0);
  const code = state.shared ? null : canonicalSeedCode(els.optSeed.value.trim());
  let sub;
  let warn = false;
  if (code) sub = `${n} ducks · replaying code ${code}`;
  else if (!state.shared && blanks && typed) {
    sub = `${n} ducks · ${blanks} unnamed`;
    warn = true;
  } else sub = `${n} ducks · ${LENGTH_LABEL[state.duration] || 'classic distance'}`;
  els.ctaSub.textContent = sub;
  els.ctaSub.classList.toggle('warn', warn);
  sizeChips.forEach((b) => {
    const on = Number(b.dataset.size) === n;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  els.start.querySelector('.cta-main').textContent = state.shared ? 'Replay shared race' : 'Start the Derby';
}

/**
 * Any change to the roster or race options means "a new race": forget the
 * shared seed, hide the banner and drop the share params from the URL so Start
 * rolls a fresh seed instead of silently re-running the same lanes. A code that
 * arrived via a link (or has already been raced) is cleared from the seed box;
 * one the user typed themselves this session survives unless `dropCode`.
 */
function leaveSharedMode(dropCode = false) {
  const hasCode = !!els.optSeed.value;
  const clearBox = hasCode && (dropCode || !state.seedTyped);
  if (!state.shared && !clearBox && !location.search) return;
  state.shared = false;
  state.sharedSeed = null;
  state.entry = { autoplay: false, view: '' };
  cancelAutoplay();
  if (clearBox) {
    els.optSeed.value = '';
    state.seedTyped = false;
  }
  els.shareBanner.hidden = true;
  if (location.search) {
    try {
      history.replaceState(null, '', location.pathname);
    } catch {
      /* sandboxed iframe */
    }
  }
  updateCta();
}

const LIST_PREFIX = /^\s*(\d+[.):\-]?|[-•*@])\s*/;

function renderRoster() {
  els.roster.innerHTML = '';
  state.names.forEach((name, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="lane-no" aria-hidden="true">${i + 1}</span>
      <canvas width="44" height="40" aria-hidden="true"></canvas>
      <input type="text" maxlength="22" placeholder="Duck ${i + 1} name" aria-label="Name for duck ${i + 1}" autocomplete="off" spellcheck="false" enterkeyhint="next" />
      <button type="button" class="remove" aria-label="Remove duck ${i + 1}" title="Remove">×</button>`;
    const input = li.querySelector('input');
    input.value = name;
    input.addEventListener('input', () => {
      state.names[i] = input.value;
      leaveSharedMode();
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
    // paste a whole list ("1. Alice\n2. Bob…", comma/semicolon/tab separated) into any row
    input.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text') ?? '';
      if (!/[\n,;\t]/.test(text)) return;
      const parts = text
        .split(/[\n\r,;\t]+/)
        .map((s) => sanitizeName(s.replace(LIST_PREFIX, '')))
        .filter(Boolean);
      if (!parts.length) return;
      e.preventDefault();
      const whole = input.selectionStart === 0 && input.selectionEnd === input.value.length;
      pasteNames(parts, i, whole);
    });
    li.querySelector('.remove').addEventListener('click', () => {
      if (state.names.length <= MIN_DUCKS) {
        toast(`Need at least ${MIN_DUCKS} ducks`);
        return;
      }
      const snapshot = state.names.slice();
      const removed = sanitizeName(state.names[i]);
      state.names.splice(i, 1);
      leaveSharedMode();
      renderRoster();
      saveStore();
      if (removed) offerUndo({ names: [removed], snapshot });
      els.roster.querySelectorAll('input')[Math.min(i, state.names.length - 1)]?.focus();
    });
    els.roster.appendChild(li);
  });
  refreshLooks();
}

/** Fill pasted names into blank rows from row `at` down, then other blanks, then new rows (≤16). */
function pasteNames(parts, at, replaceAt = false) {
  const names = state.names.slice();
  let k = 0;
  for (let i = at; i < names.length && k < parts.length; i++) {
    if (!sanitizeName(names[i]) || (i === at && replaceAt)) names[i] = parts[k++];
  }
  for (let i = 0; i < names.length && k < parts.length; i++) {
    if (!sanitizeName(names[i])) names[i] = parts[k++];
  }
  while (k < parts.length && names.length < MAX_DUCKS) names.push(parts[k++]);
  const skipped = parts.length - k;
  state.names = names;
  leaveSharedMode();
  renderRoster();
  saveStore();
  toast(skipped ? `${MAX_DUCKS} max — ${skipped} skipped` : `Added ${k} name${k === 1 ? '' : 's'}`);
  els.roster.querySelectorAll('input')[Math.min(at, state.names.length - 1)]?.focus();
}

let looksTimer = 0;
function scheduleLooks() {
  clearTimeout(looksTimer);
  looksTimer = setTimeout(refreshLooks, 140);
}

function listNames(arr) {
  const shown = arr.slice(0, 3).join(', ');
  return arr.length > 3 ? `${shown} +${arr.length - 3} more` : shown;
}

/**
 * Toast with an inline Undo that restores a roster snapshot. Consecutive
 * removals while the toast is up coalesce: the oldest snapshot is kept and the
 * names are merged ("Removed Yolanda, Xavier · Undo").
 * @param {{names?: string[], label?: string, snapshot: string[]}} u
 */
let undoLive = null; // {names, until}
function offerUndo({ names = [], label = '', snapshot }) {
  const now = performance.now();
  if (undoLive && now < undoLive.until && state.lastRoster) {
    names = undoLive.names.concat(names);
  } else {
    state.lastRoster = snapshot;
  }
  undoLive = { names, until: now + 5000 };
  toast(names.length ? `Removed ${listNames(names)}` : label, {
    action: {
      label: 'Undo',
      onClick: () => {
        undoLive = null;
        if (!state.lastRoster) return;
        state.names = state.lastRoster.slice();
        state.lastRoster = null;
        leaveSharedMode();
        renderRoster();
        saveStore();
        toast('Restored');
      },
    },
  });
}

function setSize(n) {
  n = clamp(Math.round(n), MIN_DUCKS, MAX_DUCKS);
  if (n === state.names.length) return;
  if (n > state.names.length) {
    while (state.names.length < n) state.names.push('');
  } else {
    // non-destructive shrink: drop empty rows (bottom-up) first, then named rows off the end — with Undo
    const snapshot = state.names.slice();
    const names = state.names.slice();
    let need = names.length - n;
    for (let i = names.length - 1; i >= 0 && need > 0; i--) {
      if (!sanitizeName(names[i])) {
        names.splice(i, 1);
        need--;
      }
    }
    const removed = [];
    while (need > 0) {
      removed.unshift(sanitizeName(names.pop()));
      need--;
    }
    state.names = names;
    if (removed.length) offerUndo({ names: removed, snapshot });
  }
  leaveSharedMode();
  renderRoster();
  saveStore();
}

function setRule(rule, { fromUser = false } = {}) {
  state.rule = normRule(rule);
  for (const chip of ruleChips) {
    const on = chip.dataset.rule === state.rule;
    chip.setAttribute('aria-checked', String(on));
    chip.tabIndex = on ? 0 : -1; // roving tabindex: the group is one Tab stop, arrows move within
  }
  els.ruleHelp.textContent = RULES[state.rule].help;
  if (fromUser) saveStore();
}

function syncOptionInputs() {
  els.optLength.value = String(state.duration);
  els.optHazards.value = state.hazards ? 'on' : 'off';
  els.optMotion.value = state.calm ? 'calm' : 'full';
  els.optLeague.value = state.league;
  setRule(state.rule);
}

sizeChips.forEach((b) => b.addEventListener('click', () => setSize(Number(b.dataset.size))));
$('#size-minus').addEventListener('click', () => setSize(state.names.length - 1));
$('#size-plus').addEventListener('click', () => setSize(state.names.length + 1));
ruleChips.forEach((chip, idx) => {
  chip.addEventListener('click', () => setRule(chip.dataset.rule, { fromUser: true }));
  chip.addEventListener('keydown', (e) => {
    let to = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = (idx + 1) % ruleChips.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = (idx - 1 + ruleChips.length) % ruleChips.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = ruleChips.length - 1;
    if (to < 0) return;
    e.preventDefault();
    setRule(ruleChips[to].dataset.rule, { fromUser: true });
    ruleChips[to].focus();
  });
});
els.optLeague.addEventListener('input', () => {
  state.league = sanitizeLeague(els.optLeague.value);
  saveStore();
});
$('#btn-sample').addEventListener('click', () => {
  // fill blanks only, never repeating a name already on the roster
  const present = new Set(state.names.map((n) => normalizeName(sanitizeName(n))).filter(Boolean));
  const pool = SAMPLE_NAMES.filter((n) => !present.has(normalizeName(n))).sort(() => Math.random() - 0.5);
  let k = 0;
  state.names = state.names.map((n) => (sanitizeName(n) ? n : (pool[k++] ?? '')));
  leaveSharedMode();
  renderRoster();
  saveStore();
});
$('#btn-clear').addEventListener('click', () => {
  const hadNames = state.names.some((n) => sanitizeName(n));
  const snapshot = state.names.slice();
  state.names = state.names.map(() => '');
  leaveSharedMode();
  renderRoster();
  saveStore();
  if (hadNames) offerUndo({ label: 'Cleared every name', snapshot });
  els.roster.querySelector('input')?.focus();
});
$('#btn-shuffle-looks').addEventListener('click', () => {
  // cosmetic only: does not leave shared mode
  state.salt = (state.salt + 1) % 1000;
  refreshLooks();
  saveStore();
  toast('Fresh feathers!');
});
els.optLength.addEventListener('change', () => {
  state.duration = Number(els.optLength.value);
  leaveSharedMode();
  updateCta();
  saveStore();
});
els.optHazards.addEventListener('change', () => {
  state.hazards = els.optHazards.value === 'on';
  leaveSharedMode();
  saveStore();
});
els.optMotion.addEventListener('change', () => {
  state.calm = els.optMotion.value === 'calm';
  scene.setCalm(state.calm);
  syncBodyClasses();
  saveStore();
});
els.optSeed.addEventListener('input', () => {
  state.seedTyped = true; // the user owns this code now (even if a link put it there)
  leaveSharedMode();
  updateCta();
});
els.optSeed.addEventListener('change', () => {
  const v = els.optSeed.value.trim();
  const canon = canonicalSeedCode(v);
  if (v && canon === null) {
    toast('Not a valid race code — 7 letters/digits, e.g. 3GQ-M2XD');
    els.optSeed.value = '';
  } else if (canon) {
    els.optSeed.value = canon;
  } else {
    els.optSeed.value = '';
  }
  state.seedTyped = !!els.optSeed.value;
  updateCta();
});

/** Start button: the first press with unnamed ducks points at the blank; a second press within 8 s races. */
function requestStart() {
  cancelAutoplay();
  if (!state.shared) {
    const blanks = blankRows();
    const warned = state.startWarnAt && performance.now() - state.startWarnAt < 8000;
    if (blanks.length && !warned) {
      state.startWarnAt = performance.now();
      const first = blanks[0];
      const row = els.roster.children[first];
      row?.querySelector('input')?.focus();
      if (row) {
        row.classList.remove('shake');
        void row.offsetWidth; // restart the animation
        row.classList.add('shake');
        setTimeout(() => row.classList.remove('shake'), 400);
      }
      toast(`Name every duck — or press Start again to race with "Duck ${first + 1}"`, { ms: 3200 });
      return;
    }
  }
  state.startWarnAt = 0;
  startDerby();
}
els.start.addEventListener('click', requestStart);

// sound + fullscreen
function syncSoundButton() {
  els.sound.setAttribute('aria-pressed', String(state.sound));
}
els.sound.addEventListener('click', () => {
  state.sound = !state.sound;
  audio.setEnabled(state.sound); // creates/resumes the context from this gesture; muted = no audio graph at all
  if (state.sound) audio.unlock();
  syncSoundButton();
  saveStore();
});
// background tab: silence, and don't let the race clock jump a whole hidden interval on return
document.addEventListener('visibilitychange', () => {
  if (document.hidden) audio.suspend();
  else {
    audio.resume();
    lastFrame = performance.now();
  }
});
syncSoundButton();

const fullscreenSupported = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
if (!fullscreenSupported) els.fullscreen.hidden = true;
function toggleFullscreen() {
  try {
    const active = document.fullscreenElement || document.webkitFullscreenElement;
    let p;
    if (active) p = document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen?.();
    else {
      const root = document.documentElement;
      p = root.requestFullscreen ? root.requestFullscreen() : root.webkitRequestFullscreen?.();
    }
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    /* denied / unsupported */
  }
}
els.fullscreen.addEventListener('click', toggleFullscreen);

// ---------------------------------------------------------------------------
// Persistence + share links
// ---------------------------------------------------------------------------
function loadStore() {
  let o = null;
  try {
    o = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  } catch {
    o = null;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) o = {};
  return {
    names: Array.isArray(o.names)
      ? o.names.slice(0, MAX_DUCKS).map((x) => truncateCodePoints(typeof x === 'string' || typeof x === 'number' ? String(x) : '', 22))
      : null,
    duration: typeof o.duration === 'number' ? o.duration : undefined,
    rule: typeof o.rule === 'string' ? o.rule : undefined,
    salt: typeof o.salt === 'number' ? o.salt : undefined,
    sound: typeof o.sound === 'boolean' ? o.sound : undefined,
    hazards: typeof o.hazards === 'boolean' ? o.hazards : undefined,
    calm: typeof o.calm === 'boolean' ? o.calm : false,
    league: typeof o.league === 'string' ? sanitizeLeague(o.league) : '',
    qtier: o.qtier === 1 || o.qtier === 2 ? o.qtier : 0,
  };
}
function saveStore() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        names: state.names,
        duration: state.duration,
        rule: state.rule,
        salt: state.salt,
        sound: state.sound,
        hazards: state.hazards,
        calm: state.calm,
        league: state.league,
        qtier: scene.qualityTier | 0,
      }),
    );
  } catch {
    /* private mode etc. */
  }
}

function readShareParams() {
  const data = decodeShare(location.search);
  if (!data) {
    if (/[?&](n|names)=/.test(location.search)) toast('That share link looks broken — check it was copied whole', { ms: 3500 });
    return;
  }
  state.names = data.names;
  if (data.seed !== null) {
    state.sharedSeed = data.seed;
    state.shared = true;
    state.seedTyped = false;
    els.optSeed.value = seedToCode(data.seed);
    els.shareBanner.hidden = false;
    const p = new URLSearchParams(location.search);
    state.entry = { autoplay: p.get('autoplay') === '1', view: p.get('view') || '' };
  }
  state.duration = data.duration;
  state.rule = normRule(data.rule);
  state.salt = data.salt;
  state.hazards = data.hazards;
  state.league = sanitizeLeague(data.league); // a link's league (even none) wins over the stored one
}

function shareUrl() {
  const qs = encodeShare({
    names: state.raceNames,
    seed: state.seed,
    duration: state.duration,
    rule: state.rule,
    salt: state.salt,
    hazards: state.hazards,
    league: state.league,
  });
  const u = new URL(location.href);
  u.search = qs;
  u.hash = '';
  return u.toString();
}

// ---------------------------------------------------------------------------
// Race director
// ---------------------------------------------------------------------------
function syncBodyClasses() {
  const cl = document.body.classList;
  for (const c of [...cl]) if (c.startsWith('phase-')) cl.remove(c);
  cl.add(`phase-${state.phase}`);
  cl.toggle('paused', state.paused);
  cl.toggle('calm', state.calm);
}

function setPhase(phase) {
  state.phase = phase;
  state.phaseTime = 0;
  syncBodyClasses();
  els.setup.hidden = phase !== 'setup';
  els.hud.hidden = !RACE_PHASES.includes(phase);
  els.ticker.hidden = els.hud.hidden;
  els.results.hidden = phase !== 'results';
  els.seedBadge.hidden = phase === 'setup' || state.seed === null;
  // league name rides in the top bar while racing (compact screens show it in the HUD strip)
  const racing = RACE_PHASES.includes(phase);
  els.brandTag.textContent = racing && state.league ? state.league : DEFAULT_TAG;
  els.hudLeague.hidden = !(racing && state.league);
  els.hudLeague.textContent = state.league;
  if (phase === 'setup') document.title = DEFAULT_TITLE;
  updateInsets();
  if (phase === 'intro') els.hud.focus({ preventScroll: true });
}

function measureSafeAreas() {
  const cs = getComputedStyle(els.safeProbe);
  safe = {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
  };
}

/** Tell the scene which screen regions the UI covers, then publish the live geometry to CSS. */
function updateInsets() {
  const compact = isCompact();
  const W = window.innerWidth;
  const H = window.innerHeight;
  const insets = { left: safe.left, right: safe.right, top: 0, bottom: 0 };
  if (state.phase === 'setup' && !compact) {
    const r = els.setup.getBoundingClientRect();
    insets.left = Math.min(r.right + 10, W * 0.55);
  } else if (RACE_PHASES.includes(state.phase)) {
    const hr = els.hud.getBoundingClientRect();
    if (compact) insets.top = Math.ceil(hr.bottom) + 6;
    else insets.right = Math.max(safe.right, Math.round(W - hr.left) + 6);
    const tr = els.ticker.getBoundingClientRect();
    if (tr.height) {
      const covered = Math.max(0, H - tr.top);
      // short landscape screens: let the scene's own bottom margin absorb the gap above the ticker
      insets.bottom = H <= 500 ? Math.max(0, covered - 9) : covered + 4;
    }
  }
  scene.setInsets(insets);
  scene.layout();
  const st = document.documentElement.style;
  const skyH = scene.skyH || Math.round(H * 0.28);
  st.setProperty('--sky-h', `${skyH}px`);
  publishedSky = skyH;
  st.setProperty('--water-mid', `${Math.round(skyH + (H - skyH) / 2)}px`);
  const hud = els.hud.hidden ? null : els.hud.getBoundingClientRect();
  st.setProperty('--hud-top', `${hud ? Math.round(hud.top) : 0}px`);
  st.setProperty('--hud-h', `${hud ? Math.round(hud.height) : 0}px`);
  state.tickerH = els.ticker.hidden ? 0 : els.ticker.offsetHeight;
  st.setProperty('--ticker-h', `${state.tickerH}px`);
}

/**
 * The event ribbon lives in the sky band. Camera zooms (countdown push-in, hero
 * zoom on the winner) crop the sky on screen, so publish the *apparent* sky
 * height while a zoom is active; otherwise --sky-h is whatever updateInsets set.
 */
let publishedSky = -1;
function publishSkyBand() {
  const sky = scene.skyH || 0;
  const zc = scene._zc;
  let apparent = sky;
  if (zc && zc.zf > 1.0005) apparent = clamp(Math.round(zc.cy + (sky - zc.cy) * zc.zf), 0, sky);
  if (apparent !== publishedSky) {
    publishedSky = apparent;
    document.documentElement.style.setProperty('--sky-h', `${apparent}px`);
  }
}

/** Reset every per-race director field (used by startDerby and the jump() rewind). */
function resetDirector() {
  state.t = 0;
  state.rate = 1;
  state.eventIdx = 0;
  state.hotdogIdx = 0;
  state.finished = 0;
  state.countdownStep = -1;
  state.photoCalled = false;
  state.winnerAt = null;
  state.telegraphed = new Set();
  state.followUps = [];
  state.victims = new Set();
  state.avenged = new Set();
  state.tailCalled = false;
  state.tailDuel = false;
  state.holdLeft = 0;
  state.holdMul = 0.05;
  state.calloutFreeAt = 0;
  state.hudOrder = [];
  state.hudLeader = -1;
  state.pendingSince = new Map();
  state.rankMeta = new Map();
  state.lastReorder = 0;
  state.lastResync = 0;
  state.lastGap = 0;
  state.pollT = 0;
  state.rankHist = [];
  state.timeLed = [];
  state.leadStreak = 0;
  state.streakDuck = -1;
  state.lastChatterT = -9;
  state.lastSpokenT = 0;
  state.transcript = [];
  state.slowmoSent = 0;
  clearTimeout(state.homeTimer);
  state.homeTimer = 0;
  scene.slowmo = 0;
  scene.camMode = '';
  scene.startLights = 0;
  scene.pendingHoldMs = 0;
  scene.projectiles.length = 0;
  audio.stopTension(false); // never leave a drone humming across a rewind / restart
  audio.setSlowmo(0);
}

/**
 * Wall-clock hold ("hit-stop"): for `ms` the race clock creeps at `rateMul` of
 * its current rate. The rate lerp itself keeps running, so playback eases back.
 * The scene may request one by setting scene.pendingHoldMs (polled per frame).
 */
function hold(ms, rateMul = 0.05) {
  state.holdLeft = Math.max(state.holdLeft, ms / 1000);
  state.holdMul = rateMul;
}

/** Synchronous part of starting a race: roster, seed, looks, director reset. Returns the sim options. */
function prepareRace(forcedSeed = null) {
  const names = effectiveNames();
  let seed = forcedSeed;
  if (seed === null || seed === undefined) {
    const typed = codeToSeed(els.optSeed.value);
    seed = typed ?? (state.shared && state.sharedSeed !== null ? state.sharedSeed : randomSeed());
  }
  state.seed = seed >>> 0;
  state.seedTyped = false; // a raced code is "used": Edit ducks / any change clears it
  state.sharedRun = state.shared;
  state.raceNames = names;
  state.looks = assignLooks(names, state.salt);
  state.sim = null;
  resetDirector();
  stopCeremony();
  clearTimeout(state.ambienceTimer);
  state.ambienceTimer = 0;
  commentator = new Commentator(names, { seed: state.seed, league: state.league, rule: state.rule });
  scene.sim = null;
  scene.setLooks(state.looks);
  scene.introDur = INTRO_SEC;
  els.standings.replaceChildren();
  els.progressDots.replaceChildren();
  state.hudRows = [];
  clearCallouts();
  clearTicker();
  els.seedBadge.textContent = `CODE ${seedToCode(state.seed)}`;
  return { count: names.length, seed: state.seed, duration: state.duration, hazards: state.hazards };
}

function startDerby({ seed: forcedSeed } = {}) {
  cancelAutoplay();
  hideConfirm();
  audio.unlock();
  audio.startAmbience();
  if (state.paused) setPaused(false);
  const opts = prepareRace(forcedSeed ?? null);
  setPhase('intro');
  scene.snapCamera(0);
  say(commentator.intro(opts.count, state.league), 2, { t: 0 });
  audio.setCrowd(0.25);

  // Build the sim *after* the panel has gone: six candidate sims cost 70–300 ms
  // on a laptop and up to ~1.5 s on a budget phone, so doing it inside the
  // click would freeze the button. The intro covers it; countdown waits for it.
  const gen = ++raceGen;
  requestAnimationFrame(() =>
    setTimeout(() => {
      if (gen !== raceGen || state.phase !== 'intro') return; // superseded
      state.sim = createRace(opts);
      scene.setRace(state.sim, state.looks);
      // Optional scene hook (intro dolly): called once per race, after setRace,
      // while phase === 'intro'. scene.update() receives phaseTime, so the move
      // can be timed against scene.introDur even if the sim arrived late.
      if (scene.beginIntro) scene.beginIntro();
      else scene.snapCamera(0);
      buildStandings();
    }, 0),
  );
}

/** Deep link `view=board`: race the shared field off-screen and land straight on the draft board. */
function showBoardDirect() {
  const opts = prepareRace(state.sharedSeed);
  raceGen++;
  state.sim = createRace(opts);
  scene.setRace(state.sim, state.looks);
  const sim = state.sim;
  state.t = Math.max(...sim.finishTimes) + 0.5;
  state.eventIdx = sim.events.length;
  state.hotdogIdx = sim.events.length;
  state.finished = sim.count;
  scene.snapCamera(state.t);
  showResults();
}

function skipToResults() {
  if (!state.sim || !scene.sim) return;
  if (state.paused) setPaused(false);
  // fast-forward silently
  const sim = state.sim;
  state.t = Math.max(...sim.finishTimes) + 0.5;
  state.eventIdx = sim.events.length;
  state.hotdogIdx = sim.events.length;
  state.finished = sim.count;
  state.followUps = [];
  state.holdLeft = 0;
  scene.projectiles.length = 0;
  clearCallouts();
  clearTicker();
  showResults();
}
els.skip.addEventListener('click', skipToResults);

function setPaused(on) {
  on = !!on;
  if (on === state.paused) return;
  if (on && !PAUSABLE.includes(state.phase)) return;
  state.paused = on;
  syncBodyClasses();
  els.pause.setAttribute('aria-pressed', String(on));
  els.pause.querySelector('.lbl').textContent = on ? 'Resume' : 'Pause';
  els.pause.title = on ? 'Resume (P)' : 'Pause (P)';
  audio.pauseTension(on); // the drone hums on, but no heartbeats while frozen
  if (on) {
    callout('PAUSED', 'wide pause', { persist: true });
    audio.setCrowd(0.1);
    announce('Paused', { now: true });
  } else {
    dropPersistentCallout();
  }
}
els.pause.addEventListener('click', () => {
  if (PAUSABLE.includes(state.phase)) setPaused(!state.paused);
});

// ---------------------------------------------------------------------------
// HUD — live order board
// ---------------------------------------------------------------------------
// Rows are positioned by *displayed* rank, which follows the true running order
// with hysteresis (see updateHud) so mid-pack jostling doesn't turn the board
// into a permanent blur of half-swapped rows.
function buildStandings() {
  els.standings.replaceChildren();
  els.progressDots.replaceChildren();
  const n = state.looks.length;
  const compact = isCompact();
  let avail = els.standings.clientHeight;
  if (!avail) avail = Math.max(0, window.innerHeight - els.standings.getBoundingClientRect().top - 150);
  const rowH = compact ? 30 : clamp(Math.floor(avail / Math.max(1, n)), 22, 34);
  els.standings.style.setProperty('--row-h', `${rowH - 2}px`);
  state.rowH = rowH;
  state.hudRows = state.looks.map((look, i) => {
    const li = document.createElement('li');
    li.dataset.duck = String(i);
    li.title = look.name;
    if (!compact) li.style.borderLeft = `4px solid ${look.towel.bg}`;
    li.innerHTML = `<span class="pos"></span><span class="num"></span><span class="name"></span><span class="gap"></span><b class="arrow" aria-hidden="true"></b>`;
    const num = li.children[1];
    num.textContent = String(look.number);
    num.style.background = look.towel.bg;
    num.style.color = look.towel.text;
    li.children[2].textContent = look.name;
    li._pos = li.children[0];
    li._gap = li.children[3];
    li._arrow = li.children[4];
    li._last = { tf: '', pos: '', gap: null, gapCls: '', arrow: '', arrowCls: 'arrow', leader: false, done: false, rank0: false };
    li._movedAt = 0;
    li._dir = 0;
    els.standings.appendChild(li);
    const dot = document.createElement('i');
    dot.style.background = look.towel.bg;
    dot.title = look.name;
    dot._left = '';
    els.progressDots.appendChild(dot);
    li._dot = dot;
    return li;
  });
  state.hudOrder = [];
  state.hudLeader = -1;
  state.pendingSince = new Map();
  state.rankMeta = new Map();
  state.lastReorder = 0;
  state.lastGap = 0;
  state.lastHud = 0;
  updateHud(true);
  updateInsets(); // the compact strip's height depends on its content
}

let standingsTouchedAt = 0;
els.standings.addEventListener('scroll', () => {
  if (!hudAutoScrolling) standingsTouchedAt = performance.now();
});
let hudAutoScrolling = false;

/** A row on the move is opaque (and above the rows it passes when climbing) so two names never blend mid-glide. */
function glideRow(li, up) {
  li.classList.add('mv');
  li.classList.toggle('up', !!up);
  clearTimeout(li._mvT);
  li._mvT = setTimeout(() => li.classList.remove('mv', 'up'), 360);
}

function riseRow(li) {
  li.classList.remove('rise');
  void li.offsetWidth;
  li.classList.add('rise');
  clearTimeout(li._riseT);
  li._riseT = setTimeout(() => li.classList.remove('rise'), 400);
}

// Board hysteresis. A pass may start at most every PASS_MS — longer than the
// .32 s row transition, so every swap lands and rests before the next begins.
const HUD_PASS_MS = 450; // min interval between reorder passes
const HUD_GAP_UNITS = 6; // swap at once when the pair is this far apart (0.6 m)…
const HUD_PERSIST_MS = 350; // …or when the truth has disagreed this long
const HUD_REVERSE_COOLDOWN_MS = 900; // a row won't move back the way it came this soon (no ping-pong)
const HUD_MAX_SWAPS = 2; // adjacent swaps per pass
const HUD_RESYNC_MS = 1200; // big reshuffles (start scramble, hot-dog tumbles) glide all rows at once, at most this often

/**
 * Live order tick. `force` places every row at its true rank immediately
 * (build, lead/finish events, jump); otherwise the displayed order converges on
 * the truth by at most two adjacent swaps per pass, and a swap only happens
 * once the pair is clearly apart, has disagreed for a while, or one of them has
 * finished (finishers snap straight to their final slot).
 */
function updateHud(force = false) {
  const now = performance.now();
  if (!force && now - state.lastHud < 90) return;
  state.lastHud = now;
  const sim = state.sim;
  const rows = state.hudRows;
  if (!sim || !rows.length || rows.length !== sim.count) return;
  const live = state.phase === 'race' || state.phase === 'finish' || state.phase === 'results';
  const t = live ? state.t : 0;
  const clock = t.toFixed(1);
  if (els.clock._last !== clock) els.clock.textContent = els.clock._last = clock;

  const truth = standingsAt(sim, t);
  const n = truth.length;
  const info = state.hudInfo || (state.hudInfo = []);
  truth.forEach((r, rank) => {
    r.rank = rank;
    info[r.i] = r;
  });
  const compact = isCompact();

  let order = state.hudOrder;
  let changed = false;
  let bulk = force; // whole-board placement (force / resync): rows glide together, no per-row 'rise' highlight
  if (force || order.length !== n) {
    order = truth.map((r) => r.i);
    state.pendingSince.clear();
    state.lastReorder = now;
    changed = true;
  } else if (t >= 1.5 && now - state.lastReorder >= HUD_PASS_MS) {
    state.lastReorder = now;
    const done = [];
    for (const r of truth) {
      if (!r.done) break;
      done.push(r.i); // finished ducks snap straight to their final slots
    }
    let rest = order.filter((i) => !info[i].done);
    // far from the truth? one coordinated glide beats a long chain of pair swaps
    let drift = 0;
    rest.forEach((duck, k) => (drift += Math.abs(info[duck].rank - (done.length + k))));
    let swaps = 0;
    if (drift >= Math.max(6, rest.length) && now - (state.lastResync || 0) >= HUD_RESYNC_MS) {
      state.lastResync = now;
      const synced = truth.filter((r) => !r.done).map((r) => r.i);
      synced.forEach((duck, k) => {
        if (rest[k] !== duck) {
          rows[duck]._movedAt = now;
          rows[duck]._dir = 0;
        }
      });
      rest = synced;
      bulk = true;
      state.pendingSince.clear();
      swaps = HUD_MAX_SWAPS; // no pair swaps this pass
    }
    // the leader row is the one everybody reads: promote the true leader directly (not one place per pass)
    const trueLead = truth[done.length]?.i;
    if (swaps < HUD_MAX_SWAPS && trueLead !== undefined && rest[0] !== trueLead) {
      const key = `lead>${trueLead}`;
      let since = state.pendingSince.get(key);
      if (since === undefined) state.pendingSince.set(key, (since = now));
      if (info[trueLead].x - info[rest[0]].x > 3 || now - since >= HUD_PERSIST_MS) {
        rest.splice(rest.indexOf(trueLead), 1);
        rest.unshift(trueLead);
        rows[trueLead]._movedAt = now;
        rows[trueLead]._dir = -1;
        state.pendingSince.delete(key);
        swaps++;
      }
    }
    for (let k = 0; k < rest.length - 1 && swaps < HUD_MAX_SWAPS; k++) {
      const a = rest[k];
      const b = rest[k + 1];
      const key = `${a}>${b}`;
      if (info[a].rank > info[b].rank) {
        let since = state.pendingSince.get(key);
        if (since === undefined) state.pendingSince.set(key, (since = now));
        // a goes down, b comes up — unless that reverses a move either just made
        const pingPong =
          (rows[a]._dir === -1 && now - rows[a]._movedAt < HUD_REVERSE_COOLDOWN_MS) ||
          (rows[b]._dir === 1 && now - rows[b]._movedAt < HUD_REVERSE_COOLDOWN_MS);
        if (!pingPong && (info[b].x - info[a].x > HUD_GAP_UNITS || now - since >= HUD_PERSIST_MS)) {
          rest[k] = b;
          rest[k + 1] = a;
          rows[a]._movedAt = rows[b]._movedAt = now;
          rows[a]._dir = 1;
          rows[b]._dir = -1;
          state.pendingSince.delete(key);
          swaps++;
        }
      } else state.pendingSince.delete(key);
    }
    if (state.pendingSince.size > 64) state.pendingSince.clear();
    const next = done.concat(rest);
    for (let k = 0; k < n; k++) {
      if (next[k] !== order[k]) {
        changed = true;
        break;
      }
    }
    order = next;
  }
  state.hudOrder = order;

  if (changed || force) {
    order.forEach((duck, rank) => {
      const li = rows[duck];
      const L = li._last;
      let meta = state.rankMeta.get(duck);
      if (!meta) state.rankMeta.set(duck, (meta = { rank, dir: '', at: -1e9 }));
      else if (meta.rank !== rank) {
        meta.dir = rank < meta.rank ? 'up' : 'down';
        meta.at = now;
        if (rank < meta.rank && !compact && !bulk) riseRow(li);
        meta.rank = rank;
      }
      const tf = compact ? `translateX(${rank === 0 ? 0 : 138 + (rank - 1) * 30}px)` : `translateY(${rank * state.rowH}px)`;
      if (L.tf !== tf) {
        if (!compact && L.tf) glideRow(li, meta.dir === 'up'); // opaque while it crosses other rows
        li.style.transform = L.tf = tf;
      }
      const rank0 = compact && rank === 0;
      if (L.rank0 !== rank0) li.classList.toggle('rank-0', (L.rank0 = rank0));
      const pos = String(rank + 1);
      if (L.pos !== pos) li._pos.textContent = L.pos = pos;
    });
    if (compact && order[0] !== state.hudLeader && now - standingsTouchedAt > 2500 && els.standings.scrollLeft > 0) {
      hudAutoScrolling = true;
      els.standings.scrollLeft = 0;
      requestAnimationFrame(() => (hudAutoScrolling = false));
    }
    state.hudLeader = order[0];
  }

  // row states + arrows (cheap, cached) every tick; gap text every 200 ms
  const writeGaps = force || now - state.lastGap >= 200;
  if (writeGaps) state.lastGap = now;
  const leaderX = truth[0].x;
  order.forEach((duck, rank) => {
    const li = rows[duck];
    const L = li._last;
    const r = info[duck];
    const leader = rank === 0 && !r.done && t > 0;
    if (L.leader !== leader) li.classList.toggle('leader', (L.leader = leader));
    if (L.done !== r.done) li.classList.toggle('done', (L.done = r.done));
    const meta = state.rankMeta.get(duck);
    const showArrow = !!meta && meta.dir !== '' && now - meta.at < 1400 && t > 0.5 && !r.done;
    const arrowCls = showArrow ? `arrow ${meta.dir}` : 'arrow';
    if (L.arrowCls !== arrowCls) {
      li._arrow.className = L.arrowCls = arrowCls;
      const glyph = showArrow ? (meta.dir === 'up' ? '▲' : '▼') : '';
      if (L.arrow !== glyph) li._arrow.textContent = L.arrow = glyph;
    }
    if (writeGaps || r.done !== (L.gapCls === 'gap fin')) {
      let cls;
      let txt;
      if (r.done) {
        cls = 'gap fin';
        txt = `${r.ft.toFixed(2)}s`;
      } else if (rank === 0) {
        cls = 'gap lead';
        txt = t > 0 ? 'LEADER' : '';
      } else {
        cls = 'gap';
        txt = t > 0 ? `+${Math.max(0, (leaderX - r.x) / 10).toFixed(1)}m` : '';
      }
      if (L.gapCls !== cls) li._gap.className = L.gapCls = cls;
      if (L.gap !== txt) li._gap.textContent = L.gap = txt;
      const left = `${clamp((r.x / TRACK_LENGTH) * 100, 0, 100).toFixed(1)}%`;
      if (li._dot._left !== left) li._dot.style.left = li._dot._left = left;
    }
  });
  if (writeGaps) {
    const w = `${clamp((leaderX / TRACK_LENGTH) * 100, 0, 100).toFixed(1)}%`;
    if (els.progressBar._w !== w) els.progressBar.style.width = els.progressBar._w = w;
  }
}

/** Briefly tag a live-order row (e.g. 'hit', 'newlead'); CSS owns the look. */
function flashRow(i, cls, ms = 900) {
  const li = state.hudRows[i];
  if (!li || mute.ui) return;
  li.classList.remove(cls);
  void li.offsetWidth;
  li.classList.add(cls);
  clearTimeout(li[`_t_${cls}`]);
  li[`_t_${cls}`] = setTimeout(() => li.classList.remove(cls), ms);
}

// ticker ------------------------------------------------------------------
// Two tiers: priority >= 2 lines are HEADLINES (bold, a tab in the subject
// duck's towel colour, held >= 2 s; a priority-3 line goes up immediately) and
// priority-1 chatter flows through the SUB line independently (held >= 1.3 s).
// Every queued line carries a TTL so nothing stale ever reaches the air, and
// every accepted line is logged to state.transcript (deterministic per link:
// callers stamp lines with race-clock times, see samplePoll).
const tickerQueue = [];
const tk = { head: null, sub: null, els: null };
const TICKER_HOLD = { 1: 1300, 2: 2000, 3: 2200 }; // min time on air before an equal/lower priority line may replace it
const TICKER_LINGER = { 1: 3600, 2: 5200, 3: 6000 }; // faded out after this long if nothing replaces it

/**
 * @param {string|null} text
 * @param {number} [pri] 1 chatter, 2 story beat, 3 set piece
 * @param {{duck?: number, t?: number}} [meta] subject duck (headline colour tab) and the race time the line refers to
 */
function say(text, pri = 1, meta = {}) {
  if (!text || mute.ui) return;
  const now = performance.now();
  const expires = now + (meta.ttl ?? (pri >= 3 ? 3500 : pri === 2 ? 2000 : 1100));
  tickerQueue.push({ text, pri, duck: meta.duck ?? -1, at: now, expires });
  if (tickerQueue.length > 8) tickerQueue.splice(0, tickerQueue.length - 8);
  const tRef = meta.t ?? state.t;
  state.lastSpokenT = Math.max(state.lastSpokenT, tRef);
  state.transcript.push({ t: Math.round(tRef * 100) / 100, pri, text });
  pumpTicker();
}

/** Chatter gate: at most one priority-1 line per 2.5 s of racing (tRef = the race time it refers to). */
function chatter(text, pri, meta = {}) {
  if (!text) return;
  const tRef = meta.t ?? state.t;
  if (pri <= 1) {
    if (tRef - state.lastChatterT < 2.5) return;
    state.lastChatterT = tRef;
  }
  say(text, pri, meta);
}

function ensureTickerDom() {
  if (tk.els && tk.els.head.isConnected) return tk.els;
  els.ticker.innerHTML = '<span class="mic" aria-hidden="true">🎙️</span><span class="lines"><span class="headline"></span><span class="sub"></span></span>';
  tk.els = { head: els.ticker.querySelector('.headline'), sub: els.ticker.querySelector('.sub') };
  return tk.els;
}
function clearTicker() {
  tickerQueue.length = 0;
  tk.head = tk.sub = null;
  const d = ensureTickerDom();
  for (const el of [d.head, d.sub]) {
    el.textContent = '';
    el.classList.remove('in', 'out', 'p3');
  }
}
function showTickerLine(tier, line, now) {
  const d = ensureTickerDom();
  const el = tier === 'head' ? d.head : d.sub;
  el.textContent = line.text;
  el.classList.remove('in', 'out');
  void el.offsetWidth; // restart the line-in animation
  el.classList.add('in');
  if (tier === 'head') {
    const look = state.looks[line.duck];
    el.style.setProperty('--tc', look ? look.towel.bg : 'rgba(255,255,255,0.4)');
    el.classList.toggle('p3', line.pri >= 3);
    el.classList.toggle('p1', line.pri <= 1); // chatter sharing the single phone tier
  }
  tk[tier] = { pri: line.pri, shownAt: now };
  // a taller ticker must keep the last lane clear of it
  if (!els.ticker.hidden && els.ticker.offsetHeight !== state.tickerH) updateInsets();
}
function hideTickerLine(tier) {
  tk[tier] = null;
  if (!tk.els) return;
  const el = tier === 'head' ? tk.els.head : tk.els.sub;
  el.classList.remove('in');
  el.classList.add('out');
}
function pumpTicker() {
  const now = performance.now();
  for (let k = tickerQueue.length - 1; k >= 0; k--) if (now > tickerQueue[k].expires) tickerQueue.splice(k, 1);
  // phones get one (two-line) tier: chatter shares it, and a story beat pre-empts chatter that has had 600 ms
  const single = isCompact();
  // headline tier: the first pri-3 line jumps the queue and pre-empts; a pri-2 waits for the hold
  let hi = -1;
  let h2 = -1;
  let h1 = -1;
  for (let k = 0; k < tickerQueue.length; k++) {
    const l = tickerQueue[k];
    if (l.pri >= 3) {
      hi = k;
      break;
    }
    if (l.pri === 2 && h2 < 0) h2 = k;
    if (l.pri <= 1 && h1 < 0) h1 = k;
  }
  if (hi < 0) hi = h2 >= 0 ? h2 : single ? h1 : -1;
  const H = tk.head;
  if (hi >= 0) {
    const line = tickerQueue[hi];
    const up = H ? now - H.shownAt : Infinity;
    let can;
    if (!H || line.pri >= 3) can = true;
    else if (line.pri === 2 && H.pri <= 1) can = up >= 600;
    else can = up >= TICKER_HOLD[Math.min(3, H.pri)];
    if (can) {
      tickerQueue.splice(hi, 1);
      showTickerLine('head', line, now);
    }
  } else if (H && now - H.shownAt > TICKER_LINGER[Math.min(3, H.pri)]) hideTickerLine('head');
  // sub tier: chatter, in order (wide layouts only)
  const S = tk.sub;
  if (single) {
    if (S) hideTickerLine('sub');
    return;
  }
  const si = tickerQueue.findIndex((l) => l.pri <= 1);
  if (si >= 0) {
    if (!S || now - S.shownAt >= TICKER_HOLD[1]) showTickerLine('sub', tickerQueue.splice(si, 1)[0], now);
  } else if (S && now - S.shownAt > TICKER_LINGER[1]) hideTickerLine('sub');
}

// callouts ----------------------------------------------------------------
// Two slots: '.big' (countdown digits, centred on the water) and one '.wide'
// ribbon in the sky band. Ribbons are ranked: a lower-rank banner arriving
// while a higher-rank one is still up waits in a single-slot queue (dropped if
// it waited > 1.2 s); equal or higher rank replaces immediately.
const CALLOUT_RANK = { pause: 9, go: 5, win: 4, pick: 4, photo: 4, revenge: 3, hotdog: 3, tail: 3, stretch: 2 };
const cal = { wide: null, queued: null };

function fillCallout(holder, content) {
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object') {
        const span = document.createElement('span');
        span.className = 'nm';
        span.textContent = part.nm;
        holder.appendChild(span);
      } else {
        const span = document.createElement('span');
        span.className = 'tx'; // own element so the compact (flex) ribbon keeps "NAME WINS!" on one line when it fits
        span.textContent = String(part);
        holder.appendChild(span);
      }
    }
  } else holder.textContent = String(content);
}

/**
 * Show a banner. kind: 'big [d3|d2|d1|go]' or 'wide [gold] [win|pick|photo|revenge|hotdog|tail|stretch|pause]'.
 * @param {string|Array<string|{nm:string}>} content text, or parts where {nm} is an ellipsizing name
 * @param {string} [kind]
 * @param {{ttl?: number, rank?: number, persist?: boolean}} [opts]
 */
function callout(content, kind = 'big', opts = {}) {
  if (mute.ui) return;
  const kinds = kind.split(' ').filter(Boolean);
  const wide = kinds.includes('wide');
  const persist = !!opts.persist;
  let rank = opts.rank;
  if (rank === undefined) {
    rank = 1;
    for (const k of kinds) if (CALLOUT_RANK[k] > rank) rank = CALLOUT_RANK[k];
  }
  const ttl = opts.ttl ?? (wide ? 1400 : 850);
  const now = performance.now();
  if (wide) {
    const cur = cal.wide;
    if (cur && cur.el.isConnected && now < cur.until && rank < cur.rank) {
      cal.queued = { content, kind, opts: { ...opts, rank }, at: now };
      return;
    }
    if (cur) {
      clearTimeout(cur.timer);
      cur.el.remove();
      cal.wide = null;
    }
  } else {
    for (const old of els.callout.querySelectorAll('.big')) old.remove();
  }
  const el = document.createElement('div');
  el.className = kind + (persist ? ' persist' : '');
  el.style.setProperty('--ttl', `${ttl}ms`);
  let holder = el;
  if (wide) {
    const rb = document.createElement('span');
    rb.className = 'rb';
    holder = document.createElement('span');
    holder.className = 'txt';
    rb.appendChild(holder);
    el.appendChild(rb);
  }
  fillCallout(holder, content);
  // banner length (code points) drives the ribbon's fit-to-width font size in CSS
  if (wide) el.style.setProperty('--chars', String(Math.max(6, [...holder.textContent].length)));
  els.callout.appendChild(el);
  if (!wide) {
    setTimeout(() => el.remove(), ttl);
    return;
  }
  const entry = { el, rank, until: persist ? Infinity : now + ttl, timer: 0, persist };
  cal.wide = entry;
  if (!persist) {
    state.calloutFreeAt = now + ttl * 0.8;
    entry.timer = setTimeout(() => {
      el.remove();
      if (cal.wide === entry) cal.wide = null;
      pumpCalloutQueue();
    }, ttl);
  }
}
function pumpCalloutQueue() {
  const q = cal.queued;
  cal.queued = null;
  if (q && performance.now() - q.at <= 1200) callout(q.content, q.kind, q.opts);
}
function dropPersistentCallout() {
  const cur = cal.wide;
  if (cur && cur.persist) {
    cur.el.remove();
    cal.wide = null;
    pumpCalloutQueue();
  }
  for (const el of els.callout.querySelectorAll('.persist')) el.remove();
}
function clearCallouts() {
  if (cal.wide) clearTimeout(cal.wide.timer);
  cal.wide = null;
  cal.queued = null;
  els.callout.replaceChildren();
}

// screen-reader announcements --------------------------------------------
let announcedAt = -1e9;
let announceTimer = 0;
let announceQueued = '';
/** Polite live-region line, at most one per 4 s unless `now` (the latest queued line wins). */
function announce(text, { now = false } = {}) {
  if (!text || mute.ui) return;
  const t = performance.now();
  const write = (s) => {
    els.srLive.textContent = s;
    announcedAt = performance.now();
  };
  if (now || t - announcedAt >= 4000) {
    clearTimeout(announceTimer);
    announceQueued = '';
    write(text);
    return;
  }
  announceQueued = text;
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    if (announceQueued) write(announceQueued);
    announceQueued = '';
  }, 4000 - (t - announcedAt));
}

/**
 * @param {string} msg
 * @param {{ms?: number, action?: {label: string, onClick: () => void}}} [opts]
 */
function toast(msg, opts = {}) {
  const box = els.toast;
  box.replaceChildren();
  const span = document.createElement('span');
  span.textContent = msg;
  box.appendChild(span);
  box.classList.toggle('actionable', !!opts.action);
  if (opts.action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = opts.action.label;
    b.addEventListener('click', () => {
      box.classList.remove('show', 'actionable');
      opts.action.onClick();
    });
    box.appendChild(b);
  }
  box.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => box.classList.remove('show', 'actionable'), opts.ms ?? (opts.action ? 5000 : 1800));
}

// ---------------------------------------------------------------------------
// Main loop + performance governor
// ---------------------------------------------------------------------------
// The governor watches real frame cadence (rAF-to-rAF, which includes raster
// and compositing — scene.frameMsAvg only times the scene's own JS), sheds
// quality tiers when a device can't hold ~45 fps while racing, and gives one
// tier back per race after a long clean run. Idle screens render at ~30 fps.
const perf = { dtAvg: 16.7, slowSince: 0, fastSince: 0, improved: false, skip: false, pinned: false };

function applyQualityTier(tier, { persist = true } = {}) {
  tier = clamp(tier | 0, 0, 2);
  if (tier !== scene.qualityTier) scene.setQualityTier(tier);
  document.body.classList.toggle('lowfx', scene.qualityTier >= 1);
  if (persist) saveStore();
}

function governor(now, dtMs) {
  perf.dtAvg = lerp(perf.dtAvg, Math.min(dtMs, 200), 0.05);
  if (perf.pinned) return;
  const racing = (state.phase === 'race' || state.phase === 'finish') && !state.paused && state.holdLeft <= 0 && !document.hidden;
  if (!racing) {
    perf.slowSince = 0;
    perf.fastSince = 0;
    return;
  }
  if (perf.dtAvg > 22) {
    perf.fastSince = 0;
    if (!perf.slowSince) perf.slowSince = now;
    else if (now - perf.slowSince > 1500 && scene.qualityTier < 2) {
      applyQualityTier(scene.qualityTier + 1);
      perf.slowSince = 0;
      perf.dtAvg = 18; // give the new tier a fresh look
    }
  } else {
    perf.slowSince = 0;
    if (perf.dtAvg < 17.5 && scene.qualityTier > 0 && !perf.improved) {
      if (!perf.fastSince) perf.fastSince = now;
      else if (now - perf.fastSince > 6000) {
        perf.improved = true; // once per race
        perf.fastSince = 0;
        applyQualityTier(scene.qualityTier - 1);
      }
    } else perf.fastSince = 0;
  }
}

let lastFrame = performance.now();
function frame(now) {
  try {
    const dtMs = Math.max(0, now - lastFrame);
    const dt = Math.min(0.05, dtMs / 1000);
    lastFrame = now;
    governor(now, dtMs);
    if (!state.paused) {
      state.phaseTime += dt;
      switch (state.phase) {
        case 'intro':
          if (state.sim && state.phaseTime > INTRO_SEC) setPhase('countdown');
          break;
        case 'countdown':
          stepCountdown();
          break;
        case 'race':
        case 'finish':
          advanceRace(dt);
          break;
        default:
          break;
      }
    }
    if (scene.pendingHoldMs) {
      hold(scene.pendingHoldMs);
      scene.pendingHoldMs = 0;
    }
    // while paused the scene still ticks (water, bobbing) but the race clock holds
    scene.update(dt, state.t, state.phase, state.phaseTime);
    // idle screens (setup / results): draw every other frame (~30 fps); the sim side still ticks every frame
    const idle = state.phase === 'setup' || state.phase === 'results';
    perf.skip = idle ? !perf.skip : false;
    if (!perf.skip) scene.render(state.t, state.phase);
    publishSkyBand();
    if (!els.hud.hidden) {
      updateHud();
      if (!state.paused) pumpTicker();
    }
  } catch (err) {
    if (!frame.failed) {
      frame.failed = true;
      console.error('[duck-derby] frame error', err);
      toast('Something hiccuped — reload if the race looks stuck');
    }
  } finally {
    requestAnimationFrame(frame);
  }
}

function stepCountdown() {
  const step = Math.floor(state.phaseTime / COUNT_STEP);
  if (step === state.countdownStep || step > 3) return;
  state.countdownStep = step;
  if (step < 3) {
    const digit = String(3 - step);
    callout(digit, `big d${digit}`, { ttl: 920 });
    announce(digit, { now: true });
    audio.beep(false);
    scene.startLights = step + 1;
    return;
  }
  callout('GO!', 'big go', { ttl: 1000 });
  announce(`Go! ${state.looks.length} ducks are racing`, { now: true });
  audio.beep(true);
  audio.horn();
  audio.cheer(0.45, 1.8);
  scene.startLights = 4;
  const gen = raceGen;
  setTimeout(() => {
    if (gen === raceGen && scene.startLights === 4) scene.startLights = 0;
  }, 1200);
  scene.cheer = 1;
  if (!scene.reduceMotion) {
    scene.flash = 0.35;
    scene.shake = 0.6;
  }
  setPhase('race');
  perf.improved = false;
  say(commentator.go(), 2, { t: 0 });
  for (let i = 0; i < state.looks.length; i++) scene.splash(i, 0, 6, true);
}

function advanceRace(dt) {
  const sim = state.sim;
  const n = sim.count;
  const t0 = state.t;

  // --- survey the field: leader + the unfinished ducks (U), front to back ---
  let leadX = -Infinity;
  const xs = new Array(n);
  const U = [];
  for (let i = 0; i < n; i++) {
    const x = scene.duckX(i, t0);
    xs[i] = x;
    if (x > leadX) leadX = x;
    const ft = sim.finishTimes[i];
    if (ft === null || t0 < ft) U.push(i);
  }
  U.sort((a, b) => xs[b] - xs[a]);
  let nextFt = Infinity;
  for (const i of U) {
    const ft = sim.finishTimes[i];
    if (ft !== null && ft < nextFt) nextFt = ft;
  }

  // --- playback rate: photo-finish slow-mo, hurry through empty water, tail duel ---
  let target = 1;
  const remaining = TRACK_LENGTH - leadX;
  if (state.finished === 0 && sim.photoFinish && remaining < TRACK_LENGTH * 0.055) {
    target = remaining < TRACK_LENGTH * 0.03 ? 0.28 : 0.5; // the PHOTO FINISH call itself fires on the broadcast grid (samplePoll)
  } else if (state.finished === 0 && remaining < TRACK_LENGTH * 0.02) {
    target = 0.6; // a little hang-time at the line for everyone
  }
  if (state.winnerAt !== null && t0 - state.winnerAt > 0.35) target = 1;
  // podium settled: fast-forward only while nobody is about to finish (every finish plays at ~1x)
  if (state.finished >= Math.min(3, n) && U.length > 3 && nextFt - t0 > 2.5) target = 2.2;
  // last two, close together, nearly home: milk it
  state.tailDuel = U.length === 2 && TRACK_LENGTH - xs[U[0]] < 45 && Math.abs(xs[U[0]] - xs[U[1]]) < 12;
  if (state.tailDuel) target = 0.5;

  scene.slowmo = lerp(scene.slowmo, target < 0.7 && (state.finished === 0 || state.tailDuel) ? 1 : 0, 1 - Math.exp(-dt * 4));
  state.rate = lerp(state.rate, target, 1 - Math.exp(-dt * 5));
  if (state.holdLeft > 0) {
    state.holdLeft -= dt;
    state.t += dt * state.rate * state.holdMul;
  } else {
    state.t += dt * state.rate;
  }

  // --- sound: run-in tension bed follows the leader through the last 20%; slow-mo muffles the world ---
  if (audio.tensionActive) audio.setTensionProgress(clamp(1 - remaining / (TRACK_LENGTH * 0.2), 0, 1));
  if (Math.abs(scene.slowmo - state.slowmoSent) > 0.05 || (scene.slowmo < 0.01 && state.slowmoSent !== 0)) {
    state.slowmoSent = scene.slowmo < 0.01 ? 0 : scene.slowmo;
    audio.setSlowmo(state.slowmoSent);
  }

  // --- hot dogs: telegraph at 1.5 s, launch the (visual) projectile at 0.8 s ---
  const events = sim.events;
  while (state.hotdogIdx < events.length) {
    const idx = state.hotdogIdx;
    const ev = events[idx];
    if (ev.type !== 'hotdog') {
      state.hotdogIdx++;
      continue;
    }
    const lead = ev.t - state.t;
    if (lead > TELEGRAPH_LEAD) break;
    if (!state.telegraphed.has(idx)) {
      state.telegraphed.add(idx);
      scene.telegraphHotdog?.(ev.duck, state.t, ev.t);
      audio.uhoh();
    }
    if (lead > LAUNCH_LEAD) break;
    scene.launchHotdog(ev.duck, state.t, ev.t);
    audio.whistle(Math.max(0.2, lead));
    state.hotdogIdx++;
  }

  // --- sim events ---
  while (state.eventIdx < events.length && events[state.eventIdx].t <= state.t) {
    handleEvent(events[state.eventIdx++]);
  }

  // --- hot-dog aftermath: did it actually cost them? (ranked at the follow-up instant, not the frame) ---
  for (let k = state.followUps.length - 1; k >= 0; k--) {
    const f = state.followUps[k];
    if (state.t < f.t) continue;
    state.followUps.splice(k, 1);
    const rankNow = standingsAt(sim, f.t).findIndex((r) => r.i === f.duck);
    const name = state.raceNames[f.duck];
    const line = commentator.hotdogAftermath?.(name, f.rankBefore + 1, rankNow + 1) ?? (rankNow > f.rankBefore ? `${name} drops from ${ordinal(f.rankBefore + 1)} to ${ordinal(rankNow + 1)}!` : `${name} shrugs off the hot dog!`);
    say(line, 2, { duck: f.duck, t: f.t, ttl: 4500 }); // still true a few seconds later: let it queue behind a lead change
  }

  // --- broadcast sampling on a fixed race-clock grid: ranks, time led, director beats, situational lines ---
  while (state.pollT + POLL_STEP <= state.t + 1e-9) {
    state.pollT += POLL_STEP;
    samplePoll(state.pollT);
  }

  // crowd excitement follows the race
  audio.setCrowd(clamp(0.3 + (leadX / TRACK_LENGTH) * 0.5 + scene.cheer * 0.4, 0, 1));

  if (state.phase === 'race' && state.finished >= n) setPhase('finish');
  if (state.phase === 'finish' && state.phaseTime > FINISH_HOLD) showResults();
}

const POLL_STEP = 0.25; // race-clock seconds between broadcast samples
const RANK_SAMPLES = 13; // 12 intervals = 3 s of rank history

/**
 * Everything the commentary says about the *shape* of the race is decided here,
 * at exact multiples of 0.25 s of race time with standings computed at that
 * instant — so frame timing never changes what gets said (share links replay
 * the same broadcast). Also hosts the director beats whose trigger is a
 * position threshold (PHOTO FINISH call, race-for-last).
 */
function samplePoll(tq) {
  const sim = state.sim;
  const n = sim.count;
  const names = state.raceNames;
  const standings = standingsAt(sim, tq);
  const ranks = new Array(n);
  let done = 0;
  standings.forEach((r, k) => {
    ranks[r.i] = k;
    if (r.done) done++;
  });
  const hist = state.rankHist;
  hist.push(ranks);
  if (hist.length > RANK_SAMPLES) hist.shift();
  const leader = standings[0];
  if (leader && !leader.done && tq > 0) {
    state.timeLed[leader.i] = (state.timeLed[leader.i] || 0) + POLL_STEP;
    state.leadStreak = state.streakDuck === leader.i ? state.leadStreak + POLL_STEP : POLL_STEP;
    state.streakDuck = leader.i;
  }
  if (state.phase !== 'race' && state.phase !== 'finish') return;
  const live = standings.filter((r) => !r.done);
  const leadX = leader ? (leader.done ? TRACK_LENGTH : leader.x) : 0;

  // PHOTO FINISH call (the slow-mo itself is per-frame in advanceRace)
  if (!state.photoCalled && sim.photoFinish && done === 0 && TRACK_LENGTH - leadX < TRACK_LENGTH * 0.055) {
    state.photoCalled = true;
    callout('PHOTO FINISH!', 'wide photo');
    say('It is desperately close — PHOTO FINISH!', 3, { duck: leader.i, t: tq });
    announce('Photo finish!');
  }
  // race-for-last beat: once, after the podium (and 1.5 s clear of the winner's banner)
  if (!state.tailCalled && n >= 3 && done >= Math.min(3, n - 2) && live.length >= 2 && state.winnerAt !== null && tq - state.winnerAt >= 1.5) {
    state.tailCalled = true;
    scene.camMode = 'tail';
    const pickOne = state.rule === 'last-first';
    callout(pickOne ? 'RACE FOR PICK #1' : 'RACE FOR LAST', pickOne ? 'wide gold tail' : 'wide tail');
    const backNames = live.slice(-2).map((r) => names[r.i]); // [second-last, backmarker]
    say(commentator.tailBattle?.(backNames) ?? `${backNames[0]} and ${backNames[1]} — somebody has to be last.`, 3, { duck: live[live.length - 1].i, t: tq });
  }

  // situational lines: duels, breakaways, movers, long leads, dead air (not in the start scramble)
  if (tq < 4 || !commentator?.poll || mute.ui) return;
  if (state.winnerAt !== null && tq - state.winnerAt < 2.5) return; // the winner owns the air
  const line = commentator.poll(
    {
      standings,
      timeLed: state.timeLed,
      rankNow: ranks,
      rankAgo: hist.length >= RANK_SAMPLES ? hist[0] : null,
      victims: state.victims,
      n,
      sinceSpoken: tq - state.lastSpokenT,
      chatterOK: tq - state.lastChatterT >= 2.5, // don't burn a variant on a line the chatter gate would drop
      streak: state.leadStreak,
      finished: done,
      trackLength: TRACK_LENGTH,
    },
    tq,
  );
  if (line) chatter(line.text, line.pri, { duck: line.duck, t: tq });
}

/** Relevance gate for burst/stumble chatter: front two, the back marker, or a duck on the move. */
function chatterRelevant(duck, standings) {
  const n = standings.length;
  const rank = standings.findIndex((r) => r.i === duck);
  if (rank < 0) return false;
  if (rank <= 1 || rank === n - 1) return true;
  const hist = state.rankHist;
  const ago = hist.length > 8 ? hist[hist.length - 9] : null; // 2 s back on the grid
  return !!ago && ago[duck] !== undefined && Math.abs(rank - ago[duck]) >= 2;
}

function handleEvent(ev) {
  const look = state.looks[ev.duck]; // ev.duck may be -1 for field-wide events
  const name = look ? look.name : 'Someone';
  const pitch = look ? look.quackPitch : 1;
  const au = sfx();
  scene.onEvent(ev, state.t);
  const standings = standingsAt(state.sim, Math.min(state.t, ev.t));
  const meta = { duck: ev.duck, t: ev.t };
  switch (ev.type) {
    case 'burst':
      if (Math.random() < 0.7) au.quack(pitch, 0.35);
      au.splash(0.18);
      if (chatterRelevant(ev.duck, standings)) chatter(commentator.forEvent(ev, standings, state.t), 1, meta);
      break;
    case 'stumble':
      au.splash(0.12);
      if (chatterRelevant(ev.duck, standings)) chatter(commentator.forEvent(ev, standings, state.t), 1, meta);
      break;
    case 'hotdog': {
      if (!look) break;
      au.bonk();
      au.splat();
      au.ooh();
      au.quack(pitch * 1.3, 0.5);
      au.duckAmbience(1200);
      if (!mute.sfx) {
        const gen = raceGen;
        setTimeout(() => {
          if (gen === raceGen) audio.boing();
        }, 150);
      }
      if (!scene.reduceMotion) hold(90);
      const a = scene.duckScreen(ev.duck, state.t, 'race');
      scene.punch?.(0.06, a?.x, a?.y);
      callout('HOT DOG!', 'wide hotdog', { ttl: 1200 });
      say(commentator.forEvent(ev, standings, state.t), 3, meta);
      const rankBefore = Math.max(0, standings.findIndex((r) => r.i === ev.duck));
      announce(rankBefore === 0 ? `Hot dog hits ${name}, the leader` : `Hot dog hits ${name}`);
      state.victims.add(ev.duck);
      state.followUps.push({ t: ev.t + FOLLOWUP_DELAY, duck: ev.duck, rankBefore });
      flashRow(ev.duck, 'hit', 900);
      break;
    }
    case 'lead': {
      if (!look) break;
      au.whooshDing();
      au.cheer(0.22, 1.2);
      flashRow(ev.duck, 'newlead', 900);
      const a = scene.duckScreen(ev.duck, state.t, 'race');
      scene.punch?.(0.025, a?.x, a?.y);
      const line = commentator.forEvent(ev, standings, state.t);
      if (state.victims.has(ev.duck) && !state.avenged.has(ev.duck)) {
        state.avenged.add(ev.duck);
        callout('REVENGE!', 'wide gold revenge');
        say(commentator.revenge?.(name) ?? `Covered in mustard and back in front — ${name}!`, 3, meta);
        au.cheer(0.4, 2);
      } else {
        say(line, 2, meta);
      }
      if (state.t > 1) announce(`${name} takes the lead`);
      updateHud(true); // a called lead change is definitive: snap the board to it
      break;
    }
    case 'halfway': {
      say(commentator.forEvent(ev, standings, state.t), 2, { duck: standings[0]?.i ?? ev.duck, t: ev.t });
      const top = standings.slice(0, 3).map((r) => state.raceNames[r.i]);
      announce(`Halfway: ${top.join(', then ')}`);
      break;
    }
    case 'stretch':
      scene.camMode = 'stretch';
      callout('FINAL STRETCH', 'wide stretch');
      au.cheer(0.3, 2.5);
      au.startTension(); // drone + heartbeat until the winner touches the wall
      say(commentator.forEvent(ev, standings, state.t), 3, { duck: standings[0]?.i ?? ev.duck, t: ev.t });
      break;
    case 'finish': {
      if (!look) break;
      state.finished++;
      const place = state.finished;
      const n = state.sim.count;
      const lane = scene.lanes[ev.duck];
      const photo = state.sim.photoFinish;
      const lastFirst = state.rule === 'last-first';
      const lineOpts = { photo, margin: state.sim.margin, victim: state.victims.has(ev.duck), rule: state.rule, n };
      if (place === 1) {
        state.winnerAt = ev.t;
        if (!scene.reduceMotion) {
          scene.flash = photo ? 1 : 0.6;
          scene.shake = 0.5;
        }
        au.stopTension(true); // cymbal crash exactly on the touch
        au.fanfareSting();
        au.cameraFlash();
        au.cheer(0.6, 3);
        au.quack(pitch, 0.5);
        au.duckAmbience(1200);
        clearTicker();
        say(commentator.finishLine(ev.duck, 1, lineOpts), 3, meta);
        if (lastFirst) callout([{ nm: name }, ' wins the race'], 'wide win');
        else callout([{ nm: name }, ' WINS!'], 'wide gold win');
        announce(lastFirst ? `${name} wins the race — and picks last` : `${name} wins!`, { now: true });
        scene.punch?.(0.08, scene.sx(TRACK_LENGTH), lane?.y);
      } else if (place === n) {
        if (lastFirst) {
          callout([{ nm: name }, ': LAST — PICKS FIRST!'], 'wide gold pick');
          au.fanfareSting();
          au.cymbal();
          au.cheer(0.5, 3);
          if (!scene.reduceMotion) scene.confettiBurst(TRACK_LENGTH, lane ? lane.top : scene.waterTop, 40);
          say(commentator.finishLine(ev.duck, place, lineOpts), 3, meta);
          announce(`${name} is last — and gets the first pick`, { now: true });
        } else {
          au.wahwah(); // sad trombone for the wooden spoon
          say(commentator.finishLine(ev.duck, place, lineOpts), 2, meta);
        }
      } else {
        if (place <= 3) au.cheer(0.25, 1.2);
        if (place === 3) {
          const order = state.sim.order;
          say(`${state.raceNames[order[1]]} 2nd, ${state.raceNames[order[2]]} 3rd — podium locked`, 2, { duck: order[1], t: ev.t });
        }
      }
      if (place === n && !mute.sfx) {
        // everyone home: resolve the race with the fanfare's tag once the last beat has breathed
        clearTimeout(state.homeTimer);
        const gen = raceGen;
        state.homeTimer = setTimeout(() => {
          if (gen === raceGen && state.phase === 'finish') audio.fanfareTag();
        }, lastFirst ? 1200 : 1700);
      }
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
  return state.rule === 'last-first' ? order.reverse() : order; // winner-choice picks slots in finish order
}

function resultFacts() {
  const sim = state.sim;
  const n = sim.count;
  const close = sim.photoFinish ? 'photo finish' : `won by ${sim.margin.toFixed(2)}s`;
  return `${n} ducks · ${close} · ${sim.leadChanges} lead change${sim.leadChanges === 1 ? '' : 's'} · code ${seedToCode(state.seed)}`;
}

function boardHeadRow(R) {
  const li = document.createElement('li');
  li.className = 'board-head';
  li.setAttribute('aria-hidden', 'true');
  li.innerHTML = `<span></span><span>Manager</span><span>Finish</span>`;
  li.firstChild.textContent = R.header;
  return li;
}

function showResults() {
  if (state.paused) setPaused(false);
  clearCallouts();
  clearTicker();
  hideConfirm();
  stopCeremony();
  setPhase('results');
  audio.stopTension(false);
  audio.setSlowmo(0);
  audio.setCrowd(0.15);
  // the crowd murmurs on under the ceremony, then the venue empties (unless a new race starts)
  clearTimeout(state.ambienceTimer);
  state.ambienceTimer = setTimeout(() => {
    state.ambienceTimer = 0;
    if (state.phase === 'results') audio.stopAmbience();
  }, 20000);
  const sim = state.sim;
  const order = sim.order; // by finish
  const picks = draftOrder();
  const n = order.length;
  const rule = normRule(state.rule);
  const R = RULES[rule];
  const lastFirst = rule === 'last-first';
  const wide = picks.length >= 9 && window.innerWidth >= 1100;
  const winnerT = sim.finishTimes[order[0]];
  const league = state.league;
  els.results.classList.toggle('results--wide', wide);
  els.results.classList.toggle('rule-last', lastFirst);
  els.results.classList.toggle('from-share', state.sharedRun);
  $('#btn-replay').textContent = state.sharedRun ? 'Watch again' : 'Watch replay';

  // header: league name (with an overline) or the rule-aware title
  els.resultsOverline.hidden = !league;
  els.resultsOverline.textContent = R.h2;
  els.resultsTitle.textContent = league || R.h2;
  els.resultsSub.replaceChildren();
  const b = document.createElement('b');
  b.textContent = R.sentence;
  els.resultsSub.append(b, ` · ${resultFacts()}`);
  document.title = league ? `${league} draft order — Duck Derby` : DEFAULT_TITLE;

  // last-place-first: the last finisher is the story — hero card above a demoted podium
  els.hero.hidden = !lastFirst;
  els.podiumCap.hidden = !lastFirst;
  els.hero.replaceChildren();
  if (lastFirst) {
    const duck = picks[0];
    const look = state.looks[duck];
    els.hero.innerHTML = `<canvas aria-hidden="true"></canvas><div><div class="hero-kicker">DEAD LAST. FIRST PICK.</div><div class="hero-name"></div><div class="hero-meta"></div></div>`;
    els.hero.querySelector('.hero-name').textContent = look.name;
    els.hero.querySelector('.hero-meta').textContent = `Finished ${ordinal(n)} of ${n} · ${sim.finishTimes[duck].toFixed(2)}s`;
    const cv = els.hero.querySelector('canvas');
    requestAnimationFrame(() => renderPortrait(cv, look, { standing: true, t: 2.2, crown: true }));
  }

  // podium: 2nd, 1st, 3rd
  els.podium.innerHTML = '';
  const podiumIdx = [order[1], order[0], order[2]].filter((v) => v !== undefined);
  const places = order.length >= 3 ? [2, 1, 3] : order.length === 2 ? [2, 1] : [1];
  podiumIdx.forEach((duck, k) => {
    const place = places[k];
    const look = state.looks[duck];
    const card = document.createElement('div');
    card.className = `step-card place-${place}`;
    card.innerHTML = `<canvas aria-hidden="true"></canvas><div class="plinth"><span class="medal m${place}" aria-hidden="true"></span><div class="pl-place">${ordinal(place)}</div><div class="pl-name"></div><div class="pl-time">${sim.finishTimes[duck].toFixed(2)}s</div></div>`;
    card.querySelector('.pl-name').textContent = look.name;
    els.podium.appendChild(card);
    const cv = card.querySelector('canvas');
    cv._look = look;
    cv._place = place;
    requestAnimationFrame(() => renderPortrait(cv, look, { standing: true, t: 1 + k, crown: place === 1 }));
  });

  // draft board (one header per column; two columns on wide screens with 9+ picks)
  els.board.innerHTML = '';
  const half = Math.ceil(n / 2);
  els.board.style.gridTemplateRows = wide ? `repeat(${half + 1}, auto)` : '';
  picks.forEach((duck, k) => {
    if (k === 0 || (wide && k === half)) els.board.appendChild(boardHeadRow(R));
    const look = state.looks[duck];
    const place = order.indexOf(duck) + 1;
    const ft = sim.finishTimes[duck];
    const li = document.createElement('li');
    if (k === 0) li.className = 'first-pick';
    if (!scene.reduceMotion) li.style.animationDelay = `${k * 45}ms`;
    li.style.borderLeft = `6px solid ${look.towel.bg}`;
    let tag = '';
    if (lastFirst) {
      if (k === 0) tag = '<span class="tag gold">Last in → first pick</span>';
      else if (k === n - 1) tag = '<span class="tag">Won the race → last pick</span>';
    } else if (place === 1) tag = '<span class="tag gold">🏆 Champion</span>';
    else if (place === n) tag = '<span class="tag">🥄 Last in</span>';
    const gap = place > 1 ? ` <span class="gp">+${(ft - winnerT).toFixed(2)}s</span>` : '';
    li.innerHTML = `<div class="pick"></div><canvas aria-hidden="true"></canvas><div class="who"><span class="id"><span class="lane"></span><span class="nm"></span></span>${tag}</div><div class="meta">${ordinal(place)} · ${ft.toFixed(2)}s${gap}</div>`;
    const pick = li.querySelector('.pick');
    pick.textContent = String(k + 1);
    pick.setAttribute('aria-label', `${R.header} ${k + 1}`);
    const laneEl = li.querySelector('.lane');
    laneEl.textContent = String(look.number);
    laneEl.style.background = look.towel.bg;
    laneEl.style.color = look.towel.text;
    li.querySelector('.nm').textContent = look.name;
    els.board.appendChild(li);
    renderPortrait(li.querySelector('canvas'), look, { w: 46, h: 40, t: k * 0.3 });
  });
  els.results.querySelector('.panel-scroll').scrollTop = 0;
  try {
    history.replaceState(null, '', shareUrl());
  } catch {
    /* SecurityError in sandboxed iframes */
  }
  announce(`${R.h2}: ${picks.map((d, k) => `${k + 1} ${state.looks[d].name}`).join(', ')}`, { now: true });
  els.resultsTitle.focus({ preventScroll: true });
  runCeremony({ lastFirst, firstPickName: state.looks[picks[0]].name });
}

// ---------------------------------------------------------------------------
// Results ceremony: plinths rise 3-2-1 (thunk, thunk, drumroll, fanfare),
// portraits drop in, the board reveals from the last pick up to #1, confetti
// falls over the panel and the champion keeps celebrating. Any click / Space /
// Enter inside the panel (or "Reveal all") completes it instantly.
// ---------------------------------------------------------------------------
function later(ms, fn) {
  const id = setTimeout(() => {
    const k = state.revealTimers.indexOf(id);
    if (k >= 0) state.revealTimers.splice(k, 1);
    fn();
  }, ms);
  state.revealTimers.push(id);
}

function runCeremony({ lastFirst = false, firstPickName = '' } = {}) {
  const R = els.results;
  const cards = [3, 2, 1].map((pl) => R.querySelector(`.step-card.place-${pl}`));
  const rows = [...els.board.querySelectorAll('li:not(.board-head)')];
  const revealBtn = $('#btn-reveal-all');
  if (scene.reduceMotion) {
    // reduced motion / calm: final state at once, one fanfare
    R.classList.remove('ceremony', 'shine');
    if (revealBtn) revealBtn.hidden = true;
    audio.fanfare();
    startPodiumLoop();
    return;
  }
  R.classList.add('ceremony');
  R.classList.remove('shine', 'revealed');
  if (revealBtn) revealBtn.hidden = false;
  const [c3, c2, c1] = cards;
  later(250, () => {
    if (c3) {
      c3.classList.add('in');
      audio.thunk();
    }
  });
  later(550, () => {
    if (c2) {
      c2.classList.add('in');
      audio.thunk();
    }
  });
  later(600, () => {
    state.roll = audio.drumroll(0.4); // crescendo into the gold plinth
  });
  later(1000, () => {
    state.roll = null;
    if (c1) c1.classList.add('in');
    audio.fanfare();
    audio.cheer(0.4, 2);
    launchDomConfetti();
    startPodiumLoop();
  });
  later(1500, () => R.classList.add('shine'));
  const step = rows.length > 12 ? 120 : 170;
  const ordered = rows.slice().reverse(); // last pick first, #1 lands last
  ordered.forEach((li, k) => {
    later(1500 + k * step, () => {
      li.classList.add('in');
      if (k === ordered.length - 1) {
        li.classList.add('gold-sweep');
        audio.cymbal();
        if (lastFirst) flashResults(`${firstPickName} PICKS FIRST`);
      } else audio.tick();
    });
  });
  later(1500 + ordered.length * step + 450, () => finishCeremony(false));
}

/** End state: everything revealed, no timers or drumroll left behind. `instant` = skipped by the user. */
function finishCeremony(instant) {
  for (const id of state.revealTimers) clearTimeout(id);
  state.revealTimers = [];
  if (state.roll) {
    state.roll.stop();
    state.roll = null;
  }
  const R = els.results;
  for (const el of R.querySelectorAll('.step-card, .draft-board li')) el.classList.add('in');
  R.classList.add('revealed');
  if (instant) R.classList.add('shine');
  const revealBtn = $('#btn-reveal-all');
  if (revealBtn) revealBtn.hidden = true;
  if (state.phase === 'results' && !state.podiumRaf) startPodiumLoop();
}

/** Leaving the results (new race / edit): kill timers, loops and confetti. */
function stopCeremony() {
  for (const id of state.revealTimers) clearTimeout(id);
  state.revealTimers = [];
  if (state.roll) {
    state.roll.stop();
    state.roll = null;
  }
  if (state.podiumRaf) cancelAnimationFrame(state.podiumRaf);
  state.podiumRaf = 0;
  els.results.classList.remove('ceremony', 'shine', 'revealed');
  const fx = document.getElementById('fx-confetti');
  if (fx) fx._kill = true;
}

function ceremonyRunning() {
  return state.phase === 'results' && state.revealTimers.length > 0;
}

// skip: any click, Space or Enter inside the panel completes the reveal (the click still does its own job)
els.results.addEventListener(
  'click',
  () => {
    if (ceremonyRunning()) finishCeremony(true);
  },
  true,
);
els.results.addEventListener('keydown', (e) => {
  if ((e.key === ' ' || e.key === 'Enter') && ceremonyRunning()) {
    finishCeremony(true);
    if (!(e.target instanceof Element && e.target.closest('button, a, input, select'))) e.preventDefault();
  }
});

/** Gold banner inside the results head (the sky-band callouts are hidden in this phase). */
function flashResults(text) {
  const head = els.results.querySelector('.results-head');
  if (!head) return;
  head.querySelector('.results-flash')?.remove();
  const el = document.createElement('div');
  el.className = 'results-flash';
  el.setAttribute('aria-hidden', 'true');
  el.textContent = text;
  head.appendChild(el);
  setTimeout(() => el.remove(), 1600);
}

/** The champion keeps hopping/flapping under its crown (<=30 fps); 2nd/3rd just blink and sway (15 fps). */
function startPodiumLoop() {
  if (state.podiumRaf) cancelAnimationFrame(state.podiumRaf);
  const cvs = [...els.podium.querySelectorAll('canvas')].filter((c) => c._look);
  if (!cvs.length) return;
  let last1 = 0;
  let last23 = 0;
  const loop = (now) => {
    if (state.phase !== 'results') {
      state.podiumRaf = 0;
      return;
    }
    state.podiumRaf = requestAnimationFrame(loop);
    if (document.hidden) return;
    const sec = now / 1000;
    const lively = !scene.reduceMotion;
    const do1 = now - last1 >= 33;
    const do23 = now - last23 >= 66;
    if (do1) last1 = now;
    if (do23) last23 = now;
    for (const cv of cvs) {
      if (cv._place === 1) {
        if (!do1) continue;
        renderPortrait(cv, cv._look, {
          standing: true,
          t: sec,
          flap: lively && sec % 2.2 < 0.45 ? 1 : 0,
          beakOpen: lively && sec % 3.1 < 0.25 ? 1 : 0,
          hopY: lively ? Math.abs(Math.sin(Math.PI * 1.2 * sec)) * 6 : 0,
          crown: true,
        });
      } else if (do23) {
        renderPortrait(cv, cv._look, { standing: true, t: sec * (lively ? 1 : 0.5) + cv._place });
      }
    }
  };
  state.podiumRaf = requestAnimationFrame(loop);
}

// DOM confetti over the results panel (its own canvas + rAF; removed when the last piece dies)
const FX_COLS = ['#FF3CAC', '#2BD2FF', '#FFE066', '#7CFF6B', '#FF7A2F', '#B18AF0', '#FFFFFF'];
function launchDomConfetti() {
  if (scene.reduceMotion) return;
  const panel = els.results.getBoundingClientRect();
  let cv = document.getElementById('fx-confetti');
  if (!cv) {
    cv = document.createElement('canvas');
    cv.id = 'fx-confetti';
    cv.setAttribute('aria-hidden', 'true');
    document.body.appendChild(cv);
  }
  cv._kill = false;
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  const W = window.innerWidth;
  const H = window.innerHeight;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d');
  const halve = scene.qualityTier >= 2 ? 0.5 : 1;
  const pieces = cv._pieces || (cv._pieces = []);
  const spawn = (x, y, angDeg, spreadDeg, spMin, spMax) => {
    const a = ((angDeg + (Math.random() - 0.5) * 2 * spreadDeg) * Math.PI) / 180;
    const sp = spMin + Math.random() * (spMax - spMin);
    pieces.push({
      x,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      rot: Math.random() * 6.28,
      vr: (Math.random() - 0.5) * 12,
      seed: Math.random() * 6.28,
      streamer: Math.random() < 0.3,
      color: FX_COLS[(Math.random() * FX_COLS.length) | 0],
      age: 0,
      life: 2.4 + Math.random(),
    });
  };
  const nCannon = Math.round(70 * halve);
  for (let k = 0; k < nCannon; k++) {
    spawn(panel.left + 10, panel.top + 6, -65, 15, 380, 640);
    spawn(panel.right - 10, panel.top + 6, -115, 15, 380, 640);
  }
  let drizzleLeft = 4; // seconds of 20/s drizzle from above the panel
  let drizzleAcc = 0;
  if (cv._raf) return; // a loop is already running; it picks up the new pieces
  let prev = performance.now();
  const tick = (now) => {
    const dt = Math.min(0.05, (now - prev) / 1000);
    prev = now;
    if (cv._kill) pieces.length = 0;
    if (drizzleLeft > 0 && !cv._kill) {
      drizzleLeft -= dt;
      drizzleAcc += dt * 20 * halve;
      while (drizzleAcc >= 1) {
        drizzleAcc -= 1;
        spawn(panel.left + Math.random() * panel.width, -10, 90, 20, 40, 120);
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    for (let k = pieces.length - 1; k >= 0; k--) {
      const q = pieces[k];
      q.age += dt;
      if (q.age >= q.life || q.y > H + 30) {
        pieces[k] = pieces[pieces.length - 1];
        pieces.pop();
        continue;
      }
      const drag = 1 - 1.4 * dt;
      q.vx *= drag;
      if (q.vy < 0) q.vy *= drag; // air drag eats the launch; gravity brings it back over the panel
      q.vy = Math.min(q.vy + 260 * dt, q.streamer ? 140 : 190); // terminal flutter speed
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.rot += q.vr * dt;
      const fx = q.x + Math.sin(q.age * 6 + q.seed) * 18;
      const fade = Math.min(1, (q.life - q.age) * 2.5);
      ctx.globalAlpha = fade;
      ctx.fillStyle = q.color;
      ctx.save();
      ctx.translate(fx, q.y);
      ctx.rotate(q.rot);
      if (q.streamer) {
        ctx.scale(1, 0.6 + 0.4 * Math.cos(q.age * 5 + q.seed));
        ctx.fillRect(-1.25, -8, 2.5, 16);
      } else {
        ctx.scale(0.25 + 0.75 * Math.abs(Math.cos(q.age * 7 + q.seed)), 1); // tumbling flip
        ctx.fillRect(-3.5, -2, 7, 4);
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    if (pieces.length || (drizzleLeft > 0 && !cv._kill)) cv._raf = requestAnimationFrame(tick);
    else {
      cv._raf = 0;
      cv.remove();
    }
  };
  cv._raf = requestAnimationFrame(tick);
}

/** Plain-text summary for Copy / native share. */
function resultText({ withUrl = true } = {}) {
  const R = RULES[normRule(state.rule)];
  const sim = state.sim;
  const order = sim.order;
  const lines = [
    `🦆 ${state.league || 'Duck Derby'} — ${R.h2} (${new Date().toLocaleDateString()})`,
    R.sentence,
    ...draftOrder().map((d, k) => `${k + 1}. ${state.looks[d].name} — finished ${ordinal(order.indexOf(d) + 1)} (${sim.finishTimes[d].toFixed(2)}s)`),
  ];
  if (withUrl) lines.push('', `Replay: ${shareUrl()}`);
  return lines.join('\n');
}

function backToSetup() {
  if (state.paused) setPaused(false);
  hideConfirm();
  leaveSharedMode(true); // back to setup = a new race: never re-run the seed we just watched
  clearCallouts();
  clearTicker();
  stopCeremony();
  clearTimeout(state.ambienceTimer);
  state.ambienceTimer = 0;
  audio.stopTension(false);
  audio.stopAmbience(); // the venue falls silent on the setup screen
  raceGen++;
  state.sim = null;
  state.sharedRun = false;
  scene.sim = null;
  scene.camMode = '';
  scene.setLooks(state.looks);
  setPhase('setup');
  refreshLooks();
  scene.snapCamera(0);
  // keyboard/desktop users land in the roster; on touch that would pop the keyboard uninvited
  if (!coarseMQ.matches) els.roster.querySelector('input')?.focus({ preventScroll: true });
}

function newRace() {
  hideConfirm();
  leaveSharedMode(true);
  state.sharedRun = false;
  startDerby({ seed: randomSeed() });
}
function showConfirm() {
  els.actions.classList.add('confirming');
  els.confirmNew.hidden = false;
  $('#btn-cancel-new').focus();
}
function hideConfirm() {
  els.actions.classList.remove('confirming');
  els.confirmNew.hidden = true;
}

$('#btn-again').addEventListener('click', () => {
  if (state.sharedRun) showConfirm(); // from a shared link: don't silently replace tonight's race
  else newRace();
});
$('#btn-confirm-new').addEventListener('click', newRace);
$('#btn-cancel-new').addEventListener('click', () => {
  hideConfirm();
  $('#btn-again').focus();
});
$('#btn-replay').addEventListener('click', () => startDerby({ seed: state.seed }));
$('#btn-edit').addEventListener('click', backToSetup);
$('#btn-copy').addEventListener('click', () => copyText(resultText(), 'Draft order copied'));
$('#btn-copylink').addEventListener('click', () => copyText(shareUrl(), 'Share link copied — anyone can replay this exact race'));
$('#btn-share').addEventListener('click', async () => {
  const url = shareUrl();
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: `${state.league || 'Duck Derby'} draft order`, text: resultText({ withUrl: false }), url });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      /* NotAllowed / unsupported payload: fall back to the clipboard */
    }
  }
  copyText(url, 'Share link copied — anyone can replay this exact race');
});
$('#btn-save').addEventListener('click', saveImage);

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg, { ms: 2600 });
  } catch {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast(okMsg, { ms: 2600 });
    } catch {
      toast('Copy failed — long-press to copy from the address bar', { ms: 3000 });
    }
    ta.remove();
  }
}

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}
function isoDate(d = new Date()) {
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function imageFileName() {
  return `${slug(state.league) || 'duck-derby'}-draft-order-${isoDate()}.png`;
}

/** Shrink-to-fit single-line text. */
function fitText(ctx, text, maxW, size, weight, family) {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  while (s > 12 && ctx.measureText(text).width > maxW) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${family}`;
  }
  return s;
}

/** Render the shareable result card. @returns {Promise<Blob>} */
function renderResultImage() {
  const picks = draftOrder();
  const sim = state.sim;
  const order = sim.order;
  const rule = normRule(state.rule);
  const R = RULES[rule];
  const lastFirst = rule === 'last-first';
  const league = state.league;
  const DISPLAY = 'Bungee, ui-rounded, "Arial Rounded MT Bold", system-ui, sans-serif';
  const UI = 'Nunito, ui-rounded, system-ui, sans-serif';
  const W = 1080;
  const rowH = 74;
  const top = 300;
  const H = top + 30 + picks.length * rowH + 70;
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
  for (let i = 0; i < 40; i++) ctx.fillRect((i * 97) % W, 240 + ((i * 53) % (H - 240)), 60, 3);
  // chequered strip
  for (let x = 0; x < W; x += 28) {
    ctx.fillStyle = '#111';
    ctx.fillRect(x, 0, 14, 14);
    ctx.fillRect(x + 14, 14, 14, 14);
    ctx.fillStyle = '#fff';
    ctx.fillRect(x + 14, 0, 14, 14);
    ctx.fillRect(x, 14, 14, 14);
  }
  // header text (leaves room for the hero portrait on the right)
  const textW = W - 60 - 300;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';
  fitText(ctx, league || 'DUCK DERBY', textW, 56, 400, DISPLAY);
  ctx.fillText(league || 'DUCK DERBY', 60, 58);
  ctx.fillStyle = '#FFD23F';
  const line2 = league ? `${R.h2.toUpperCase()} · DUCK DERBY` : R.h2.toUpperCase();
  fitText(ctx, line2, textW, 28, 900, UI);
  ctx.fillText(line2, 62, 132);
  ctx.fillStyle = 'rgba(255,255,255,0.82)';
  ctx.font = `800 22px ${UI}`;
  ctx.fillText(`${new Date().toLocaleDateString()} · ${sim.count} ducks · ${sim.photoFinish ? 'photo finish' : `won by ${sim.margin.toFixed(2)}s`} · code ${seedToCode(state.seed)}`, 62, 172);
  // rule pill
  ctx.font = `900 20px ${UI}`;
  const pill = R.pill;
  const pw = ctx.measureText(pill).width + 32;
  ctx.fillStyle = lastFirst ? '#FFD23F' : 'rgba(255,255,255,0.18)';
  roundRect(ctx, 60, 210, pw, 38, 19);
  ctx.fill();
  ctx.fillStyle = lastFirst ? '#3b2400' : '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(pill, 76, 230);
  // hero portrait top-right: the first PICK (not necessarily the race winner)
  const heroLook = state.looks[picks[0]];
  const hg = ctx.createRadialGradient(W - 170, 150, 10, W - 170, 150, 130);
  hg.addColorStop(0, 'rgba(255,236,150,0.55)');
  hg.addColorStop(1, 'rgba(255,236,150,0)');
  ctx.fillStyle = hg;
  ctx.fillRect(W - 320, 30, 300, 260);
  drawDuck(ctx, heroLook, { x: W - 170, y: 160, scale: 2.4, t: 1, standing: true, effort: 0, crown: !lastFirst });
  ctx.textAlign = 'center';
  ctx.font = `900 18px ${UI}`;
  ctx.fillStyle = '#FFD23F';
  ctx.fillText(lastFirst ? 'LAST IN · FIRST PICK' : rule === 'winner-choice' ? 'WINNER · CHOOSES FIRST' : 'CHAMPION · FIRST PICK', W - 170, 262);
  // column headers
  ctx.textBaseline = 'middle';
  ctx.font = `900 16px ${UI}`;
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText(R.header.toUpperCase(), 100, top + 4);
  ctx.textAlign = 'left';
  ctx.fillText('MANAGER', 250, top + 4);
  ctx.textAlign = 'right';
  ctx.fillText('FINISH', W - 80, top + 4);
  ctx.textAlign = 'left';
  const winnerT = sim.finishTimes[order[0]];
  picks.forEach((duck, k) => {
    const y = top + 24 + k * rowH;
    const look = state.looks[duck];
    ctx.fillStyle = k % 2 ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.16)';
    roundRect(ctx, 50, y, W - 100, rowH - 10, 18);
    ctx.fill();
    ctx.fillStyle = look.towel.bg;
    roundRect(ctx, 50, y, 10, rowH - 10, 5);
    ctx.fill();
    ctx.fillStyle = '#FFD23F';
    ctx.font = `400 34px ${DISPLAY}`;
    ctx.textAlign = 'center';
    ctx.fillText(String(k + 1), 100, y + rowH / 2 - 4);
    ctx.textAlign = 'left';
    drawDuck(ctx, look, { x: 190, y: y + rowH / 2 + 6, scale: 0.62, t: k, effort: 0.2 });
    ctx.fillStyle = '#fff';
    fitText(ctx, look.name, W - 250 - 300, 30, 900, UI);
    ctx.fillText(look.name, 250, y + rowH / 2 - 4);
    const place = order.indexOf(duck) + 1;
    const ft = sim.finishTimes[duck];
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    ctx.font = `800 22px ${UI}`;
    ctx.textAlign = 'right';
    ctx.fillText(`${ordinal(place)} · ${ft.toFixed(2)}s${place > 1 ? `  (+${(ft - winnerT).toFixed(2)})` : ''}`, W - 80, y + rowH / 2 - 4);
    ctx.textAlign = 'left';
  });
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = `700 18px ${UI}`;
  ctx.textBaseline = 'bottom';
  ctx.fillText(location.host ? `${location.host}${location.pathname}` : 'Duck Derby', 60, H - 24);
  ctx.textAlign = 'right';
  ctx.fillText(R.sentence, W - 60, H - 24);
  return new Promise((resolve, reject) => {
    c.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png');
  });
}

async function saveImage() {
  let blob;
  try {
    blob = await renderResultImage();
  } catch {
    toast('Could not render the image');
    return;
  }
  const filename = imageFileName();
  // touch devices: hand the PNG to the share sheet (Photos, Messages…) when the browser allows files
  if (coarseMQ.matches && typeof navigator.share === 'function' && typeof File === 'function') {
    try {
      const file = new File([blob], filename, { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: `${state.league || 'Duck Derby'} draft order` });
        return;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 500);
  toast('Image saved');
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
let autoplayTimer = 0;
function cancelAutoplay() {
  if (!autoplayTimer) return;
  clearTimeout(autoplayTimer);
  autoplayTimer = 0;
}

readShareParams();
syncOptionInputs();
measureSafeAreas();
renderRoster();
let resizeTimer = 0;
window.addEventListener('resize', () => {
  measureSafeAreas();
  scene.resize();
  updateInsets();
  // rebuild the live-order rows once the resize settles (row height depends on it)
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.sim && !els.hud.hidden) buildStandings();
    else updateInsets();
  }, 120);
});
const onCompactChange = () => {
  updateInsets();
  if (state.sim && !els.hud.hidden) buildStandings();
};
if (compactMQ.addEventListener) compactMQ.addEventListener('change', onCompactChange);
else compactMQ.addListener?.(onCompactChange);

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.altKey) return;
  const inField = e.target instanceof Element && !!e.target.closest('input,select,textarea');
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && state.phase === 'setup') {
    if (!inField) {
      e.preventDefault();
      startDerby(); // power-user start: races unnamed ducks as "Duck 7" without the nudge
    }
    return;
  }
  if (e.ctrlKey || e.metaKey || inField) return;
  const live = PAUSABLE.includes(state.phase);
  switch (e.key) {
    case 'Escape':
      if (!els.confirmNew.hidden) {
        hideConfirm();
        $('#btn-again').focus();
      } else if (live || state.phase === 'intro') skipToResults();
      break;
    case 'p':
    case 'P':
      if (live) {
        e.preventDefault();
        setPaused(!state.paused);
      }
      break;
    case ' ': {
      // Space pauses like a video player — unless it would steal a focused control's click
      const ae = document.activeElement;
      const free = !ae || ae === document.body || (!!ae.closest('#hud') && !ae.matches('button,a,input,select,textarea'));
      if (live && free) {
        e.preventDefault();
        setPaused(!state.paused);
      }
      break;
    }
    case 'm':
    case 'M':
      els.sound.click();
      break;
    case 'f':
    case 'F':
      if (!els.fullscreen.hidden) toggleFullscreen();
      break;
    default:
      break;
  }
});
scene.resize();
// quality tier: ?fx=0|1|2 pins it (captures, debugging); otherwise last session's tier, and weak devices start at 1
{
  const pinned = /^[012]$/.test(FX_PARAM) ? Number(FX_PARAM) : null;
  let tier = pinned ?? stored.qtier ?? 0;
  if (pinned === null) {
    const weak = (navigator.hardwareConcurrency || 8) <= 4 || (isCompact() && (window.devicePixelRatio || 1) >= 2.5);
    if (weak) tier = Math.max(tier, 1);
  } else perf.pinned = true;
  applyQualityTier(tier, { persist: false });
}
setPhase('setup');
scene.snapCamera(0);
requestAnimationFrame((t) => {
  lastFrame = t;
  frame(t);
});

// deep links: ?…&view=board lands on the draft board; ?…&autoplay=1 starts by itself
if (state.shared && state.entry.view === 'board') {
  showBoardDirect();
} else if (state.shared && state.entry.autoplay) {
  autoplayTimer = setTimeout(() => {
    autoplayTimer = 0;
    if (state.phase === 'setup' && state.shared) startDerby();
  }, 1200);
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, cancelAutoplay, { once: true, passive: true, capture: true });
  }
}

// expose for debugging / automated capture (tools/shots.mjs)
window.__duckDerby = {
  state,
  scene,
  audio,
  perf,
  applyQualityTier,
  startDerby,
  skipToResults,
  hold,
  setPaused,
  showResults,
  /**
   * Testing hook: put the race clock at `t` seconds. Idempotent — jumping
   * backwards (or from finish/results) rewinds the director and replays.
   * Events before `t` are applied with sound off; banners/ticker lines only
   * for the last 2.5 s so a capture shows what a viewer would see at `t`.
   */
  jump(t) {
    const sim = state.sim;
    if (!sim || !scene.sim) return;
    t = Math.max(0, Number(t) || 0);
    if (state.paused) setPaused(false);
    if (state.phase === 'intro' || state.phase === 'countdown') setPhase('race');
    if (t < state.t || state.phase === 'results' || state.phase === 'finish') {
      resetDirector();
      scene.setRace(sim, state.looks);
      setPhase('race');
      buildStandings();
    }
    // a time jump invalidates whatever the banner/ticker were saying
    clearCallouts();
    clearTicker();
    mute.sfx = true;
    try {
      state.t = t;
      while (state.eventIdx < sim.events.length && sim.events[state.eventIdx].t <= t) {
        const ev = sim.events[state.eventIdx++];
        mute.ui = t - ev.t > 2.5;
        handleEvent(ev);
      }
    } finally {
      mute.sfx = false;
      mute.ui = false;
    }
    let k = 0;
    while (k < sim.events.length && sim.events[k].t <= t) k++;
    state.hotdogIdx = k; // first event still in the future: past hot dogs are never re-thrown
    state.followUps = state.followUps.filter((f) => f.t > t);
    state.holdLeft = 0;
    // broadcast grid: resume sampling from here (history before the jump is meaningless)
    state.pollT = Math.floor(t / POLL_STEP) * POLL_STEP;
    state.rankHist = [];
    state.lastSpokenT = t;
    state.lastChatterT = t;
    state.slowmoSent = 0;
    audio.setSlowmo(0);
    scene.projectiles.length = 0;
    scene.snapCamera(t);
    state.lastHud = 0;
    updateHud(true);
  },
};
