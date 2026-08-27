// Duck Derby — app shell: setup UI, race director (state machine + timeline),
// HUD, commentary, results and sharing.
//
// The race itself is precomputed and deterministic (src/sim.js); everything in
// here is playback: the director only ever moves the race clock `state.t` and
// its playback `rate`, so replays and share links stay identical and fair.

import { assignLooks, SAMPLE_NAMES, MIN_DUCKS, MAX_DUCKS, normalizeName } from './ducks.js';
import { createRace, standingsAt, speedAt, TRACK_LENGTH } from './sim.js'; // playback-side reads only: the sim itself is never touched here
import { RaceScene } from './scene.js';
import { renderPortrait, drawDuck } from './draw-duck.js';
import { DuckAudio } from './audio.js';
import { Commentator, ordinal, metres } from './commentary.js';
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
  hudTitle: $('#hud .hud-title'),
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
  quietGroup: $('#results .quiet-group'),
  share: $('#btn-share'),
  replay: $('#btn-replay'),
  save: $('#btn-save'),
  copy: $('#btn-copy'),
  again: $('#btn-again'),
  rulePill: $('#rule-pill'),
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
  fairBtn: $('#btn-fair'),
  fairText: $('#fair-text'),
  shareBanner: $('#share-banner'),
  shareTitle: $('#share-title'),
  shareMeta: $('#share-meta'),
  lastResult: $('#last-result'),
  lastResultLabel: $('#last-result-label'),
  titleCard: $('#title-card'),
  names: $('#btn-names'),
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
const SOURCE_LABEL = { random: 'random draw', custom: 'custom code', shared: 'shared replay' }; // where this race's code came from (shown on the badge, title card, results and exports)
const LABEL_MODES = ['smart', 'all', 'off']; // scene.labelMode cycle (N / the Names button)
const LABEL_MODE_NAME = { smart: 'Auto', all: 'All', off: 'Off' };
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
    sentence: 'Winner chooses a slot first — go down the list, each manager names their slot',
    header: 'Choice',
    pill: 'WINNER CHOOSES FIRST',
  },
  'last-first': {
    help: 'Dead last drafts 1.01 — the race winner picks last (toilet-bowl rules)',
    h2: 'Official Draft Order',
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
  locked: false, // …and the setup is read-only until "Make my own race" (body.shared-lock mirrors it)
  sharedSeed: null,
  sharedRun: false, // the race on screen replays a shared link (results offer "Watch again" / guarded "New race")
  entry: { autoplay: false, view: '' }, // deep-link flags (only honoured together with a valid shared race)
  seedTyped: false, // the code in #opt-seed was typed by the user this session (not from a link, not yet raced)
  seed: null,
  seedSource: 'random', // 'random' | 'custom' | 'shared': provenance of state.seed (SOURCE_LABEL)
  resultPushed: false, // this race's result URL has its own history entry (browser Back reopens the board)
  resultExported: false, // the result left the building (copied / saved / shared): "New race" needs no confirm
  lastResult: null, // {url, label} of the last board shown, offered on the setup screen as "Reopen board"
  focus: -1, // "my duck": followed on the water (halo + tag) and on the board; remembered by name (store.me)
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
  photoCalled: false, // PHOTO FINISH beat fired (grid)
  runIn: '', // '' | 'photo' | 'contested' | 'clear': how the last 45 units are programmed, classified once on the grid
  lineCalled: false, // CONTESTED "to the wall" beat fired
  clearCalled: false, // CLEAR "nobody is catching X" beat fired
  closerT: -1, // race time the commentator called a closer (so "nobody is catching X" can't follow it straight away)
  preRolled: false, // clear run: the gentle push-in toward the line has been requested
  winnerAt: null,
  telegraphed: new Set(), // event indices whose hot dog has been telegraphed (never mutate sim.events)
  followUps: [], // {t, duck, rankBefore}: hot-dog aftermath lines
  victims: new Set(), // ducks hit by a hot dog this race
  avenged: new Set(), // victims who retook the lead (REVENGE! fires once each)
  lastHotdogT: -9, // race time of the last hot-dog impact (the board holds still while the victim tumbles)
  impactAt: null, // race time of an in-flight hot dog's impact (arms the undercrank bracket)
  impactUntil: -9, // race time until which the hot-dog bracket keeps the clock slow
  tailCalled: false, // RACE FOR LAST beat decided (fired or skipped) on the grid
  tailAired: false, // …and it fired (ribbon + line); the tail camera follows once the winner has had his moment
  tailWatch: false, // director is watching the back pair (arms the scene's tail still + pills)
  tailDuel: false, // back pair close and nearly home: slow-mo (per frame, with hysteresis)
  tailPhotoCalled: false, // PHOTO FOR LAST / FIRST PICK beat fired (grid)
  soloHurry: false, // a lone distant straggler is being hurried home
  climax: false, // set-piece lock (grid): only priority-3 lines reach the ticker
  calledLeader: -1, // duck of the last sim 'lead' event (the board's top row honours it inside the sim's hysteresis)
  holdLeft: 0, // wall-clock hold (hit-stop): seconds remaining
  holdMul: 0.05,
  paused: false,
  // live-order board (display side; see updateHud)
  lastHud: 0,
  lastGap: 0,
  lastGapSlow: 0,
  lastReorder: 0,
  lastResync: 0,
  hudLock: false, // a set piece is holding the board still
  hudInfo: [], // truth rows by duck id (reused every tick)
  hudChrome: 0, // measured head + foot + padding height of the desktop panel
  recede: false, // rows dimmed during the final stretch (desktop)
  rowH: 32,
  hudRows: [], // <li> per duck (lane order) with cached child refs
  hudOrder: [], // duck ids as currently displayed, top to bottom
  hudLeader: -1,
  pendingSince: new Map(), // "a>b" displayed pair the truth disagrees with -> since when
  rankMeta: new Map(), // duck -> {rank, dir, delta, at}
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
// a freeze-frame still lifting (winner or race-for-last photo): shutter + roar as the live celebration resumes
scene.onPhotoDone = () => {
  const au = sfx();
  au.cameraFlash();
  au.cheer(0.5, 2);
};
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
  if (code) {
    sub = `${n} ducks · replaying code ${code}${state.seedTyped ? ' (custom)' : ''}`;
    warn = state.seedTyped; // a typed code fixes the result: make sure that is a deliberate choice
  } else if (!state.shared && blanks && typed) {
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
  if (!state.shared && !state.locked && !clearBox && !location.search) return;
  const wasLocked = state.locked;
  state.shared = false;
  state.sharedSeed = null;
  state.locked = false;
  document.body.classList.remove('shared-lock');
  state.entry = { autoplay: false, view: '' };
  cancelAutoplay();
  if (clearBox) {
    els.optSeed.value = '';
    state.seedTyped = false;
  }
  els.shareBanner.hidden = true;
  if (location.search) {
    try {
      // the URL we are leaving (a shared race, or a result) stays one step back in history: browser Back restores it
      history.pushState(null, '', location.href);
      history.replaceState(null, '', location.pathname);
    } catch {
      /* sandboxed iframe */
    }
  }
  if (wasLocked) renderRoster(); // editable rows again (renderRoster ends in updateCta)
  else updateCta();
}

/** A material roster change: a new race (leave shared mode) and the "Reopen last board" row no longer applies. */
function touchRoster() {
  leaveSharedMode();
  els.lastResult.hidden = true;
}

/** The shared-link card: what this is, and the three honest things to do with it. */
function renderShareBanner() {
  els.shareBanner.hidden = !state.shared;
  if (!state.shared) return;
  els.shareTitle.textContent = state.league ? `${state.league} — draft order race` : 'Shared draft order race';
  // the race code sits in a no-wrap span: a narrow card must never break "3GQ-M2XD" at its hyphen
  const codeEl = document.createElement('span');
  codeEl.className = 'nowrap';
  codeEl.textContent = `code ${seedToCode(state.sharedSeed)}`;
  els.shareMeta.replaceChildren(`${state.names.length} ducks · ${RULES[state.rule].pill.toLowerCase()} · `, codeEl, ' · replays identically on every device');
}

/** "Make my own race": unlock the setup as an editable copy; the shared race stays one browser-Back away. */
function unlockShared() {
  const back = location.href;
  leaveSharedMode(true);
  if (!coarseMQ.matches) els.roster.querySelector('input')?.focus({ preventScroll: true });
  toast('Now editing your own copy — the shared race is untouched', { action: { label: 'Undo', onClick: () => location.assign(back) }, ms: 6000 });
}

const LIST_PREFIX = /^\s*(\d+[.):\-]?|[-•*@])\s*/;
/** "1. Alice\n2. Bob…" / comma / semicolon / tab separated text -> clean names (list markers stripped). */
function splitNameList(text) {
  return String(text)
    .split(/[\n\r,;\t]+/)
    .map((s) => sanitizeName(s.replace(LIST_PREFIX, '')))
    .filter(Boolean);
}

function renderRoster() {
  els.roster.innerHTML = '';
  const locked = state.locked; // a shared race: names are read-only (no remove buttons) until "Make my own race"
  state.names.forEach((name, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="lane-no" aria-hidden="true">${i + 1}</span>
      <canvas width="44" height="40" aria-hidden="true"></canvas>
      <input type="text" maxlength="22" placeholder="Duck ${i + 1} name" aria-label="Name for duck ${i + 1}" autocomplete="off" spellcheck="false" enterkeyhint="next" />
      ${locked ? '' : `<button type="button" class="remove" aria-label="Remove duck ${i + 1}" title="Remove">×</button>`}`;
    const input = li.querySelector('input');
    input.value = name;
    input.readOnly = locked;
    if (i === 0 && !locked) input.placeholder = 'Type a name — or paste your whole league';
    input.addEventListener('input', () => {
      if (state.locked) return;
      state.names[i] = input.value;
      touchRoster();
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
        else if (state.names.length < MAX_DUCKS && !state.locked) {
          setSize(state.names.length + 1);
          els.roster.querySelectorAll('input')[i + 1]?.focus();
        } else els.start.focus();
      }
    });
    // paste a whole list ("1. Alice\n2. Bob…", comma/semicolon/tab separated) into any row
    input.addEventListener('paste', (e) => {
      if (state.locked) return;
      const text = e.clipboardData?.getData('text') ?? '';
      if (!/[\n,;\t]/.test(text)) return;
      const parts = splitNameList(text);
      if (!parts.length) return;
      e.preventDefault();
      const whole = input.selectionStart === 0 && input.selectionEnd === input.value.length;
      pasteNames(parts, i, whole);
    });
    li.querySelector('.remove')?.addEventListener('click', () => {
      if (state.names.length <= MIN_DUCKS) {
        toast(`Need at least ${MIN_DUCKS} ducks`);
        return;
      }
      const snapshot = state.names.slice();
      const removed = sanitizeName(state.names[i]);
      state.names.splice(i, 1);
      touchRoster();
      renderRoster();
      saveStore();
      if (removed) offerUndo({ names: [removed], snapshot });
      els.roster.querySelectorAll('input')[Math.min(i, state.names.length - 1)]?.focus();
    });
    els.roster.appendChild(li);
  });
  refreshLooks();
}

/**
 * Fill pasted names into blank rows from row `at` down, then other blanks, then new rows (≤16).
 * Pasting a whole league (≥2 names) into an EMPTY roster makes the roster exactly that list: league size = pasted count.
 */
function pasteNames(parts, at, replaceAt = false) {
  const allBlank = state.names.every((n) => !sanitizeName(n));
  if (allBlank && parts.length >= MIN_DUCKS) {
    const snapshot = state.names.slice();
    state.names = parts.slice(0, MAX_DUCKS);
    const k = state.names.length;
    const skipped = parts.length - k;
    touchRoster();
    renderRoster();
    saveStore();
    toast(skipped ? `${MAX_DUCKS} ducks max — ${skipped} name${skipped === 1 ? '' : 's'} left out` : `Added ${k} names · league size set to ${k}`, {
      action: {
        label: 'Undo',
        onClick: () => {
          state.names = snapshot;
          touchRoster();
          renderRoster();
          saveStore();
        },
      },
    });
    return;
  }
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
  touchRoster();
  renderRoster();
  saveStore();
  toast(skipped ? `${MAX_DUCKS} ducks max — ${skipped} name${skipped === 1 ? '' : 's'} left out` : `Added ${k} name${k === 1 ? '' : 's'}`);
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
        touchRoster();
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
  touchRoster();
  renderRoster();
  saveStore();
}

function setRule(rule, { fromUser = false } = {}) {
  if (fromUser && state.shared) return; // a shared race races under the rule in the link (else the same code yields a contradictory "official" board)
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
  touchRoster();
  renderRoster();
  saveStore();
});
$('#btn-clear').addEventListener('click', () => {
  const hadNames = state.names.some((n) => sanitizeName(n));
  const snapshot = state.names.slice();
  state.names = state.names.map(() => '');
  touchRoster();
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
$('#btn-paste').addEventListener('click', () => {
  const fallback = () => {
    els.roster.querySelector('input')?.focus();
    toast('Press Ctrl/⌘+V (or long-press → Paste) in the first row', { ms: 3200 });
  };
  const read = navigator.clipboard?.readText;
  if (typeof read !== 'function') {
    fallback();
    return;
  }
  read
    .call(navigator.clipboard)
    .then((t) => {
      const parts = splitNameList(t || '');
      if (parts.length >= 2) {
        const firstBlank = state.names.findIndex((n) => !sanitizeName(n));
        pasteNames(parts, Math.max(0, firstBlank), false);
      } else toast("Clipboard has no list — copy your league's names first", { ms: 2600 });
    })
    .catch(fallback);
});
els.fairBtn.addEventListener('click', () => {
  const open = els.fairText.hidden;
  els.fairText.hidden = !open;
  els.fairBtn.setAttribute('aria-expanded', String(open));
});
$('#btn-share-watch').addEventListener('click', () => requestStart());
$('#btn-share-board').addEventListener('click', () => showBoardDirect('push'));
$('#btn-share-own').addEventListener('click', unlockShared);
$('#btn-last-open').addEventListener('click', () => {
  if (!state.lastResult) return;
  location.assign(`${state.lastResult.url}&view=board`);
});
$('#btn-last-copy').addEventListener('click', () => {
  if (state.lastResult) copyText(state.lastResult.url, 'Link copied — it reopens that exact board');
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
  if (document.hidden) {
    audio.suspend();
    // nothing may pile up behind a hidden tab: the ceremony completes silently, pending stings are dropped
    if (ceremonyRunning()) finishCeremony(true);
    clearTimeout(state.homeTimer);
    state.homeTimer = 0;
  } else {
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
    me: typeof o.me === 'string' ? o.me.slice(0, 40) : '',
    tip: o.tip === true,
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
        qtier: perf.storedTier | 0, // only a tier that provably bought frame rate is remembered (never a pinned or trial tier)
        me: stored.me || undefined,
        tip: stored.tip || undefined,
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
    state.locked = true; // read-only roster/rule until "Make my own race" (renderRoster + CSS body.shared-lock)
    document.body.classList.add('shared-lock');
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
  // a quality-tier change asked for a new canvas resolution mid-race: realise it now that nobody is looking
  if ((phase === 'results' || phase === 'setup') && scene._dprDirty) scene.resize();
  if (phase === 'race') hideTitleCard(600);
  else if (phase !== 'intro' && phase !== 'countdown') hideTitleCard(0);
  updateInsets();
  if (phase === 'intro') els.hud.focus({ preventScroll: true });
}

// lower-third title card (league · ducks · rule · code) during intro + countdown -------------
let titleCardTimer = 0;
function showTitleCard() {
  const tc = els.titleCard;
  clearTimeout(titleCardTimer);
  tc.querySelector('.tc-1').textContent = state.league || 'DUCK DERBY';
  tc.querySelector('.tc-2').textContent = `${state.raceNames.length} DUCKS · ${RULES[state.rule].pill}`;
  tc.querySelector('.tc-3').textContent = `CODE ${seedToCode(state.seed)} · ${SOURCE_LABEL[state.seedSource].toUpperCase()}`;
  tc.classList.remove('out');
  tc.hidden = false;
}
/** Hide the title card: after `delay` ms with its exit animation, or at once (delay 0). */
function hideTitleCard(delay = 0) {
  const tc = els.titleCard;
  clearTimeout(titleCardTimer);
  if (tc.hidden) return;
  if (!delay || scene.reduceMotion) {
    tc.hidden = true;
    tc.classList.remove('out');
    return;
  }
  titleCardTimer = setTimeout(() => {
    tc.classList.add('out');
    titleCardTimer = setTimeout(() => {
      tc.hidden = true;
      tc.classList.remove('out');
    }, 300);
  }, delay);
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
  // ribbon / digit geometry lives on the callout layer (not :root — no document-wide style recalc per write)
  const skyH = scene.skyH || Math.round(H * 0.28);
  setCssPx(els.callout.style, '--sky-h0', skyH); // unzoomed: sizes the ribbon font, which must not breathe with the camera
  setCssPx(els.callout.style, '--water-mid', Math.round(skyH + (H - skyH) / 2));
  publishSkyBand(true);
  const hud = els.hud.hidden ? null : els.hud.getBoundingClientRect();
  const st = document.documentElement.style;
  setCssPx(st, '--hud-top', hud ? Math.round(hud.top) : 0);
  setCssPx(st, '--hud-h', hud ? Math.round(hud.height) : 0);
  state.tickerH = els.ticker.hidden ? 0 : els.ticker.offsetHeight;
  setCssPx(st, '--ticker-h', state.tickerH);
}

/** setProperty only when the value changed (each write on :root restyles the whole document). */
const cssPx = new Map();
function setCssPx(style, name, px) {
  const key = (style === els.callout.style ? 'c' : 'r') + name;
  if (cssPx.get(key) === px) return;
  cssPx.set(key, px);
  style.setProperty(name, `${px}px`);
}

/**
 * The event ribbon lives in the sky band. Held camera zooms (countdown push-in,
 * clear-run pre-roll, hero zoom on the winner) crop the sky on screen, so the
 * ribbon rides on the *apparent* sky height of the zoom's TARGET framing — CSS
 * eases `top` over the same ~0.7 s the camera spring takes, which costs one
 * style write per zoom cue instead of one per frame. Impact punches never move
 * it, and its font is sized from the unzoomed --sky-h0.
 */
let publishedSky = -1;
function publishSkyBand(force = false) {
  const sky = scene.skyH || Math.round(window.innerHeight * 0.28);
  const z = scene.zoom;
  const zb = Math.max(1, z.baseTarget || 1);
  let apparent = zb > 1.0005 && Number.isFinite(z.bcy) ? clamp(Math.round(z.bcy + (sky - z.bcy) * zb), 0, sky) : sky;
  apparent = Math.round(apparent / 2) * 2;
  if (force || apparent !== publishedSky) {
    publishedSky = apparent;
    setCssPx(els.callout.style, '--sky-h', apparent);
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
  state.runIn = '';
  state.lineCalled = false;
  state.clearCalled = false;
  state.closerT = -1;
  state.tailAired = false;
  state.preRolled = false;
  state.winnerAt = null;
  state.telegraphed = new Set();
  state.followUps = [];
  state.victims = new Set();
  state.avenged = new Set();
  state.lastHotdogT = -9;
  state.impactAt = null;
  state.impactUntil = -9;
  state.tailCalled = false;
  state.tailWatch = false;
  state.tailDuel = false;
  state.tailPhotoCalled = false;
  state.soloHurry = false;
  state.climax = false;
  state.calledLeader = -1;
  state.holdLeft = 0;
  state.holdMul = 0.05;
  state.hudOrder = [];
  state.hudLeader = -1;
  state.pendingSince = new Map();
  state.rankMeta = new Map();
  state.lastReorder = 0;
  state.lastResync = 0;
  state.hudLock = false;
  state.lastGap = 0;
  state.lastGapSlow = 0;
  setRecede(false);
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
  scene.startLights = 0; // the scene's own transient channels are cleared by scene.resetPresentation() / setRace()
  audio.stopTension(false); // never leave a drone humming across a rewind / restart
  audio.setSlowmo(0);
}

/** Final-stretch recede: the desktop board dims its also-rans so the water owns the eye. */
function setRecede(on) {
  on = !!on;
  if (state.recede === on) return;
  state.recede = on;
  els.hud.classList.toggle('recede', on);
}

/**
 * Wall-clock hold ("hit-stop"): for `ms` the race clock creeps at `rateMul` of
 * its current rate; the rate itself is frozen meanwhile, so playback resumes at
 * exactly the pre-freeze speed. The scene may request one by setting
 * scene.pendingHoldMs (polled per frame).
 */
function hold(ms, rateMul = 0.05) {
  state.holdLeft = Math.max(state.holdLeft, ms / 1000);
  state.holdMul = rateMul;
}

/** Synchronous part of starting a race: roster, seed, looks, director reset. Returns the sim options. */
function prepareRace(forcedSeed = null, source = null) {
  const names = effectiveNames();
  let seed = forcedSeed;
  const typed = codeToSeed(els.optSeed.value);
  if (seed === null || seed === undefined) {
    seed = typed ?? (state.shared && state.sharedSeed !== null ? state.sharedSeed : randomSeed());
  }
  // provenance, shown wherever the code is: a random draw at Start, a code the user typed, or a shared link's replay
  state.seedSource = source ?? (typed !== null && state.seedTyped ? 'custom' : state.shared ? 'shared' : 'random');
  state.seed = seed >>> 0;
  state.seedTyped = false; // a raced code is "used": Edit ducks / any change clears it
  state.sharedRun = state.shared;
  state.resultPushed = false;
  state.resultExported = false;
  els.lastResult.hidden = true;
  state.raceNames = names;
  state.looks = assignLooks(names, state.salt);
  state.sim = null;
  resetDirector();
  stopCeremony();
  clearTimeout(state.ambienceTimer);
  state.ambienceTimer = 0;
  commentator = new Commentator(names, { seed: state.seed, league: state.league, rule: state.rule });
  scene.sim = null;
  scene.resetPresentation();
  scene.setLooks(state.looks);
  scene.introDur = INTRO_SEC;
  els.standings.replaceChildren();
  els.progressDots.replaceChildren();
  state.hudRows = [];
  // rule-aware board chrome + a panel pre-sized for this field (buildStandings measures again once the rows exist)
  const lastFirst = state.rule === 'last-first';
  els.hud.classList.toggle('rule-last', lastFirst);
  if (els.hudTitle) els.hudTitle.textContent = lastFirst ? 'LIVE · LAST TAKES 1.01' : 'LIVE ORDER';
  state.rowH = sizeStandings(names.length);
  clearCallouts();
  clearTicker();
  els.seedBadge.textContent = `CODE ${seedToCode(state.seed)} · ${SOURCE_LABEL[state.seedSource].toUpperCase()}`;
  els.seedBadge.classList.toggle('custom', state.seedSource === 'custom');
  return { count: names.length, seed: state.seed, duration: state.duration, hazards: state.hazards };
}

/** @param {{seed?: number|null, source?: 'random'|'custom'|'shared'|null}} [opts] force a seed (and say where it came from) */
function startDerby({ seed: forcedSeed = null, source = null } = {}) {
  cancelAutoplay();
  hideConfirm();
  audio.unlock();
  audio.startAmbience();
  if (state.paused) setPaused(false);
  const opts = prepareRace(forcedSeed, source);
  setPhase('intro');
  showTitleCard(); // league · ducks · rule · code (+ provenance) — phones never used to see the code before the results
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

/**
 * Race the shared field off-screen and land straight on the draft board (deep link `view=board`, the share
 * card's "Skip to draft board", browser Back onto a result URL). `nav`: how showResults treats history.
 */
function showBoardDirect(nav = 'replace', source = 'shared') {
  cancelAutoplay();
  hideConfirm();
  if (state.paused) setPaused(false);
  const opts = prepareRace(state.sharedSeed, source);
  raceGen++;
  state.sim = createRace(opts);
  scene.setRace(state.sim, state.looks);
  const sim = state.sim;
  state.t = Math.max(...sim.finishTimes) + 0.5;
  state.eventIdx = sim.events.length;
  state.hotdogIdx = sim.events.length;
  state.finished = sim.count;
  scene.snapCamera(state.t);
  showResults({ nav });
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
    // phones: the ribbon sits below the strip (CSS) so ▶ stays visible, and says what to do; it, the water and ▶ all resume
    callout(isCompact() ? 'PAUSED — TAP TO RESUME' : 'PAUSED', 'wide pause', { persist: true });
    audio.setCrowd(0.1);
    announce('Paused', { now: true });
    // a how-to-resume line on the ticker (not commentary: never logged to the transcript); cleared on resume
    showTickerLine('head', { text: coarseMQ.matches ? 'Paused · tap ▶, the banner or the water to resume' : 'Paused · press P or Space, or click ▶ to resume', pri: 2, duck: -1, kind: 'pause' }, performance.now());
  } else {
    dropPersistentCallout();
    if (tk.head && tk.head.kind === 'pause') hideTickerLine('head'); // the phone bar then fades by itself (B6) until the next line
  }
}
els.pause.addEventListener('click', () => {
  if (PAUSABLE.includes(state.phase)) setPaused(!state.paused);
});
// tap-anywhere resume: the PAUSED ribbon itself and the water
let swallowPointerUp = false; // a press that resumed the race must not also pick a duck to follow on release
els.callout.addEventListener('click', (e) => {
  if (state.paused && e.target instanceof Element && e.target.closest('.pause')) setPaused(false);
});
els.scene.addEventListener('pointerdown', () => {
  if (!state.paused) return;
  swallowPointerUp = true;
  setPaused(false);
});

// ---------------------------------------------------------------------------
// HUD — live order board
// ---------------------------------------------------------------------------
// Rows are positioned by *displayed* rank, which follows the true running order
// with hysteresis (see updateHud) so mid-pack jostling doesn't turn the board
// into a permanent blur of half-swapped rows.

/**
 * Desktop: the panel is only as tall as the field needs (two ducks = two rows, sixteen still fit);
 * returns the row pitch. Phones use the fixed one-line strip (CSS) and get their inline sizing cleared.
 */
function sizeStandings(n) {
  const st = els.standings.style;
  if (isCompact()) {
    st.height = '';
    st.flex = '';
    return 30;
  }
  let hudTop;
  let chrome;
  if (!els.hud.hidden && els.hud.offsetHeight) {
    hudTop = els.hud.getBoundingClientRect().top;
    st.height = '0px';
    chrome = els.hud.offsetHeight; // head + foot + gaps + padding, measured with the list collapsed
    state.hudChrome = chrome;
  } else {
    hudTop = 62 + safe.top;
    chrome = state.hudChrome || 132;
  }
  const avail = window.innerHeight - hudTop - 64 - chrome; // 64: keep clear of the ticker row
  const rowH = clamp(Math.floor(avail / Math.max(1, n)), 22, 34);
  st.height = `${n * rowH}px`;
  st.flex = '0 0 auto';
  return rowH;
}

function buildStandings() {
  els.standings.replaceChildren();
  els.progressDots.replaceChildren();
  const n = state.looks.length;
  const compact = isCompact();
  const rowH = sizeStandings(n);
  els.standings.style.setProperty('--row-h', `${rowH - 2}px`);
  state.rowH = rowH;
  state.hudInfo.length = 0;
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
    li._last = { tf: '', pos: '', gap: null, gapCls: '', gapD: -1, arrow: '', arrowCls: 'arrow', leader: false, done: false, rank0: false, pick1: false };
    li._movedAt = 0;
    li._dir = 0;
    els.standings.appendChild(li);
    const dot = document.createElement('i');
    dot.style.background = look.towel.bg;
    dot.title = look.name;
    dot._left = '';
    els.progressDots.appendChild(dot);
    li._dot = dot;
    // "which duck is mine?": click / Enter / Space on a row (or a chip on phones) follows that duck
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-label', `Follow ${look.name}`);
    li.addEventListener('click', () => setFocus(i));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); // (also keeps Space from pausing: the global handler skips defaultPrevented keys)
        setFocus(i);
      }
    });
    return li;
  });
  state.hudOrder = [];
  state.hudLeader = -1;
  state.pendingSince = new Map();
  state.rankMeta = new Map();
  state.lastReorder = 0;
  state.lastGap = 0;
  state.lastGapSlow = 0;
  state.lastHud = 0;
  syncHudChrome();
  // every viewer of a shared link who picked their duck once is auto-followed in every later race with that name
  state.focus = -1;
  scene.focusDuck = -1;
  const me = stored.me ? state.raceNames.findIndex((nm) => normalizeName(nm) === stored.me) : -1;
  if (me >= 0) setFocus(me, { silent: true });
  updateHud(true);
  updateInsets(); // the compact strip's height depends on its content
}

/** HUD foot labels that depend on the layout: the Skip pill text and the Names toggle. */
function syncHudChrome() {
  const lbl = els.skip.querySelector('.lbl');
  const txt = isCompact() || window.innerWidth <= 860 ? 'Skip' : 'Skip to results';
  if (lbl && lbl.textContent !== txt) lbl.textContent = txt;
  const mode = LABEL_MODE_NAME[scene.labelMode] || 'Auto';
  els.names.textContent = `Names: ${mode}`;
  els.names.setAttribute('aria-label', `Name tags: ${mode}`);
}

/** Cycle the on-water name tags: Auto (story-aware) → All → Off. */
function cycleLabelMode() {
  const k = LABEL_MODES.indexOf(scene.labelMode);
  scene.labelMode = LABEL_MODES[(k + 1) % LABEL_MODES.length];
  syncHudChrome();
  if (els.hud.hidden) toast(`Name tags: ${LABEL_MODE_NAME[scene.labelMode]}`);
  announce(`Name tags ${LABEL_MODE_NAME[scene.labelMode]}`, { now: true });
}
els.names.addEventListener('click', cycleLabelMode);

/**
 * Follow duck `i` ("my duck"): halo on the water, its tag always on, its row starred; the same index again
 * clears it. Remembered by NAME so replays / next week's race pick it up. `silent`: no announcement (auto-follow).
 */
function setFocus(i, { silent = false } = {}) {
  i = i | 0;
  const next = i === state.focus || i < 0 || i >= state.hudRows.length ? -1 : i;
  state.focus = next;
  scene.focusDuck = next;
  state.hudRows.forEach((li, k) => li.classList.toggle('me', k === next));
  const name = next >= 0 ? state.raceNames[next] : '';
  if (!silent) {
    stored.me = next >= 0 ? normalizeName(name) : '';
    saveStore();
    announce(next >= 0 ? `Following ${name}` : 'Not following anyone', { now: true });
    if (next >= 0 && !isCompact()) flashRow(next, 'rise', 480);
  }
}

// tap a duck on the water to follow it (release, so a press that merely resumed a paused race doesn't count)
els.scene.addEventListener('pointerup', (e) => {
  if (swallowPointerUp) {
    swallowPointerUp = false;
    return;
  }
  if (state.paused || !RACE_PHASES.includes(state.phase) || !state.sim || !scene.sim) return;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < state.hudRows.length; i++) {
    const a = scene.duckScreen(i, state.t, state.phase);
    if (!a) continue;
    const dy = Math.abs(e.clientY - a.y);
    const dx = e.clientX - a.x; // a.x is the beak: the body trails behind it
    if (dy > Math.max(40 * a.scale, a.h / 2) || dx > 60 * a.scale || dx < -120 * a.scale) continue;
    const d = dy + Math.abs(dx + 30 * a.scale) * 0.25;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best >= 0) setFocus(best);
});

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
  li._mvT = setTimeout(() => li.classList.remove('mv', 'up'), 460);
}

/** Pop highlight for a row that climbed into the front three (callers batch the reflow: remove 'rise', one offsetWidth, then this). */
function riseRow(li) {
  li.classList.add('rise');
  clearTimeout(li._riseT);
  li._riseT = setTimeout(() => li.classList.remove('rise'), 480);
}

// Board hysteresis. A pass may start at most every PASS_MS — well beyond the
// .42 s row transition, so every swap lands and rests before the next begins.
const HUD_PASS_MS = 1000; // min interval between reorder passes
const HUD_GAP_UNITS = 10; // swap at once when the pair is this far apart (1 m)…
const HUD_PERSIST_MS = 1200; // …or when the truth has disagreed this long
const HUD_LEAD_PERSIST_MS = 300; // the leader row still reacts fast
const HUD_REVERSE_COOLDOWN_MS = 2500; // a row won't move back the way it came this soon (no ping-pong)
const HUD_MAX_SWAPS = 2; // adjacent swaps per pass
const HUD_RESYNC_MS = 3000; // big reshuffles (start scramble, hot-dog tumbles) glide all rows at once, at most this often
const HUD_ARROW_MS = 1000; // an arrow marks a move for this long…
const HUD_MAX_ARROWS = 3; // …on at most this many rows (the most recent moves)
const HUD_HOTDOG_LOCK = 2.2; // race seconds the board holds still after a hot dog
const LEAD_HYST_UNITS = 4; // = the sim's lead-call hysteresis (0.004 × track): the called leader keeps the top row inside it

/**
 * Live order tick. `force` places every row at its true rank immediately
 * (build, lead/finish events, jump); otherwise the displayed order converges on
 * the truth by at most two adjacent swaps per pass, and a swap only happens
 * once the pair is clearly apart, has disagreed for a while, or one of them has
 * finished (finishers snap straight to their final slot). Set pieces (photo
 * run-in, race for last, a hot dog's aftermath) hold the board still.
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
  const info = state.hudInfo;
  // the called leader (the sim's lead calls carry 0.4 m of hysteresis) keeps the top row until someone is clearly past,
  // so the board, the crown and the commentary never disagree about who "leads" in a hair's-breadth duel
  const cl = state.calledLeader;
  if (cl >= 0) {
    const f = truth.findIndex((r) => !r.done);
    const k = truth.findIndex((r) => r.i === cl);
    if (f >= 0 && k > f && !truth[k].done && truth[f].x - truth[k].x <= LEAD_HYST_UNITS) truth.splice(f, 0, truth.splice(k, 1)[0]);
  }
  truth.forEach((r, rank) => {
    r.rank = rank;
    info[r.i] = r;
  });
  const compact = isCompact();
  const lastFirst = state.rule === 'last-first';

  // set pieces hold the board (called lead changes and finishes still snap it via `force`)
  const locked = (state.photoCalled && state.finished === 0) || state.tailWatch || state.t < state.lastHotdogT + HUD_HOTDOG_LOCK;
  if (state.hudLock && !locked) state.lastResync = 0; // coming out of a lock, one coordinated glide may catch up at once
  state.hudLock = locked;

  let order = state.hudOrder;
  let changed = false;
  let bulk = force; // whole-board placement (force / resync): rows glide together, no arrows, no 'rise' highlight
  if (force || order.length !== n) {
    order = truth.map((r) => r.i);
    state.pendingSince.clear();
    state.lastReorder = now;
    changed = true;
  } else if (!locked && t >= 1.5 && now - state.lastReorder >= HUD_PASS_MS) {
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
    if (drift >= Math.max(6, rest.length) && now - state.lastResync >= HUD_RESYNC_MS) {
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
    // the leader row is the one everybody reads: promote the true leader directly (not one place per pass), and fast
    const trueLead = truth[done.length]?.i;
    if (swaps < HUD_MAX_SWAPS && trueLead !== undefined && rest[0] !== trueLead) {
      const key = `lead>${trueLead}`;
      let since = state.pendingSince.get(key);
      if (since === undefined) state.pendingSince.set(key, (since = now));
      if (info[trueLead].x - info[rest[0]].x > 3 || now - since >= HUD_LEAD_PERSIST_MS) {
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
    const toRise = [];
    order.forEach((duck, rank) => {
      const li = rows[duck];
      const L = li._last;
      let meta = state.rankMeta.get(duck);
      let up = false;
      if (!meta) state.rankMeta.set(duck, (meta = { duck, rank, dir: '', delta: 0, at: -1e9 }));
      else if (meta.rank !== rank) {
        up = rank < meta.rank;
        if (!bulk) {
          meta.dir = up ? 'up' : 'down';
          meta.delta = rank - meta.rank;
          meta.at = now;
          if (up && rank < 3 && !compact) toRise.push(li);
        }
        meta.rank = rank;
      }
      const tf = compact ? `translateX(${rank === 0 ? 0 : 138 + (rank - 1) * 30}px)` : `translateY(${rank * state.rowH}px)`;
      if (L.tf !== tf) {
        if (!compact && L.tf) glideRow(li, up); // opaque while it crosses other rows
        li.style.transform = L.tf = tf;
      }
      const rank0 = compact && rank === 0;
      if (L.rank0 !== rank0) li.classList.toggle('rank-0', (L.rank0 = rank0));
      const pos = String(rank + 1);
      if (L.pos !== pos) li._pos.textContent = L.pos = pos;
    });
    if (toRise.length) {
      // one reflow for the batch restarts every 'rise' animation together
      for (const li of toRise) li.classList.remove('rise');
      void els.standings.offsetWidth;
      for (const li of toRise) riseRow(li);
    }
    if (compact && order[0] !== state.hudLeader && now - standingsTouchedAt > 2500 && els.standings.scrollLeft > 0) {
      hudAutoScrolling = true;
      els.standings.scrollLeft = 0;
      requestAnimationFrame(() => (hudAutoScrolling = false));
    }
    state.hudLeader = order[0];
  }

  // arrows are an attention budget: recent genuine moves only, front three or big swings, at most three lit
  let arrowSet = null;
  if (t > 0.5) {
    const cand = [];
    for (const duck of order) {
      const meta = state.rankMeta.get(duck);
      if (!meta || !meta.dir || info[duck].done || now - meta.at >= HUD_ARROW_MS) continue;
      if (meta.rank < 3 || Math.abs(meta.delta) >= 2) cand.push(meta);
    }
    if (cand.length) {
      if (cand.length > HUD_MAX_ARROWS) cand.sort((a, b) => b.at - a.at);
      arrowSet = new Set();
      for (let k = 0; k < cand.length && k < HUD_MAX_ARROWS; k++) arrowSet.add(cand[k].duck);
    }
  }

  // row states every tick (cheap, cached); gap text: front three every 200 ms, the rest every 600 ms in half metres
  const writeFast = force || now - state.lastGap >= 200;
  const writeSlow = force || now - state.lastGapSlow >= 600;
  if (writeFast) state.lastGap = now;
  if (writeSlow) state.lastGapSlow = now;
  const leaderX = truth[0].x;
  // last place picks first: the last unfinished row on the board (displayed order, so it obeys the hysteresis) sits on the 1.01
  let pickDuck = -1;
  if (lastFirst && t > 0) {
    for (let k = order.length - 1; k >= 0; k--) {
      if (!info[order[k]].done) {
        pickDuck = order[k];
        break;
      }
    }
  }
  order.forEach((duck, rank) => {
    const li = rows[duck];
    const L = li._last;
    const r = info[duck];
    const leader = rank === 0 && !r.done && t > 0;
    if (L.leader !== leader) li.classList.toggle('leader', (L.leader = leader));
    if (L.done !== r.done) li.classList.toggle('done', (L.done = r.done));
    const pick1 = duck === pickDuck;
    if (L.pick1 !== pick1) {
      li.classList.toggle('pick1', (L.pick1 = pick1));
      li._dot.classList.toggle('pick1', pick1);
    }
    const meta = state.rankMeta.get(duck);
    const showArrow = !!arrowSet && !!meta && arrowSet.has(duck);
    const arrowCls = showArrow ? `arrow ${meta.dir}` : 'arrow';
    if (L.arrowCls !== arrowCls) {
      li._arrow.className = L.arrowCls = arrowCls;
      const glyph = showArrow ? (meta.dir === 'up' ? '▲' : '▼') : '';
      if (L.arrow !== glyph) li._arrow.textContent = L.arrow = glyph;
    }
    // gap column
    let cls = null;
    let txt = '';
    if (r.done) {
      if (L.gapCls !== 'gap fin') {
        cls = 'gap fin';
        txt = `${r.ft.toFixed(2)}s`;
      }
    } else if (pick1) {
      if (L.gapCls !== 'gap pick1') {
        cls = 'gap pick1';
        txt = '→ 1.01';
      }
    } else if (rank === 0) {
      if (writeFast || L.gapCls !== 'gap lead') {
        cls = 'gap lead';
        txt = t > 0 ? 'LEADER' : '';
      }
    } else if (rank < 3 || L.gapCls !== 'gap') {
      if (writeFast || L.gapCls !== 'gap') {
        const d = Math.max(0, (leaderX - r.x) / 10);
        cls = 'gap';
        txt = t > 0 ? `+${d.toFixed(1)}m` : '';
        L.gapD = d;
      }
    } else if (writeSlow) {
      // half-metre steps, rounded up so a row never shows less than the (exact) rows above it
      const d = Math.max(0, (leaderX - r.x) / 10);
      cls = 'gap';
      txt = t > 0 ? `+${(Math.ceil(d * 2 - 1e-6) / 2).toFixed(1)}m` : '';
      L.gapD = d;
    }
    if (cls !== null) {
      if (L.gapCls !== cls) li._gap.className = L.gapCls = cls;
      if (L.gap !== txt) li._gap.textContent = L.gap = txt;
    }
    if (writeFast) {
      const left = `${clamp((r.x / TRACK_LENGTH) * 100, 0, 100).toFixed(1)}%`;
      if (li._dot._left !== left) li._dot.style.left = li._dot._left = left;
    }
  });
  if (writeFast) {
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
// duck's towel colour, held >= 2 s; a priority-3 line goes up immediately, and
// a lead change may replace a standing headline after 0.8 s) and priority-1
// chatter flows through the SUB line independently (held >= 1.3 s). Every
// queued line carries a wall-clock TTL *and* the race time it refers to, so
// nothing stale ever reaches the air, and every accepted line is logged to
// state.transcript (deterministic per link: callers stamp lines with race-clock
// times, see samplePoll). On phones the single tier fades away when idle.
const tickerQueue = [];
const tk = { head: null, sub: null, els: null, idle: false, headOffAt: -1e9 };
const TICKER_HOLD = { 1: 1300, 2: 2000, 3: 2200 }; // min time on air before an equal/lower priority line may replace it
const TICKER_LINGER = { 1: 2400, 2: 4200, 3: 6000 }; // faded out after this long if nothing replaces it
const TICKER_LEAD_PREEMPT = 800; // a lead change makes any standing story-beat headline old news this fast
const TICKER_WIN_PROTECT = 1800; // nothing replaces the winner's headline sooner than this
const TICKER_STALE = { 2: 2, 3: 3 }; // race seconds after which a queued line is no longer true enough to air
const TICKER_IDLE_MS = 1200; // phones: the empty bar fades away after this long

/**
 * @param {string|null} text
 * @param {number} [pri] 1 chatter, 2 story beat, 3 set piece
 * @param {{duck?: number, t?: number, ttl?: number, kind?: string}} [meta] subject duck (headline colour tab), the race time the
 *   line refers to, and what kind of beat it is ('lead' | 'aftermath' | 'closer' | 'photo' | 'win' | 'tail' | 'fill' | …)
 */
function say(text, pri = 1, meta = {}) {
  if (!text || mute.ui) return;
  const now = performance.now();
  const kind = meta.kind || '';
  if (pri === 1 && meta.duck !== undefined && meta.duck >= 0 && meta.duck === state.focus) pri = 2; // news about MY duck is a headline (viewer-local; the sim is untouched)
  const expires = now + (meta.ttl ?? (kind === 'lead' ? 3000 : pri >= 3 ? 3500 : pri === 2 ? 2000 : 1100));
  const tRef = meta.t ?? state.t;
  tickerQueue.push({ text, pri, kind, duck: meta.duck ?? -1, at: now, expires, tRef });
  if (tickerQueue.length > 8) tickerQueue.splice(0, tickerQueue.length - 8);
  state.lastSpokenT = Math.max(state.lastSpokenT, tRef);
  state.transcript.push({ t: Math.round(tRef * 100) / 100, pri, text, kind });
  pumpTicker();
}

/**
 * Chatter gate: at most one priority-1 line per 2.5 s of racing (tRef = the race time it refers to), and during a
 * set piece (photo run-in, the last metres, the race for last) only priority-3 lines get through at all.
 */
function chatter(text, pri, meta = {}) {
  if (!text) return;
  if (state.climax && pri < 3) return;
  const tRef = meta.t ?? state.t;
  if (pri <= 1) {
    if (tRef - state.lastChatterT < 2.5) return;
    state.lastChatterT = tRef;
  }
  say(text, pri, meta);
}

/** A set piece just landed: retire chatter that has had its moment and keep the sub line quiet for 2.5 s of racing. */
function hushChatter(tEv) {
  const S = tk.sub;
  if (S && performance.now() - S.shownAt > 600) hideTickerLine('sub');
  for (let k = tickerQueue.length - 1; k >= 0; k--) if (tickerQueue[k].pri <= 1) tickerQueue.splice(k, 1);
  state.lastChatterT = Math.max(state.lastChatterT, tEv);
}

function ensureTickerDom() {
  if (tk.els && tk.els.head.isConnected) return tk.els;
  els.ticker.innerHTML = '<span class="mic" aria-hidden="true">🎙️</span><span class="lines"><span class="headline"></span><span class="sub"></span></span>';
  tk.els = { head: els.ticker.querySelector('.headline'), sub: els.ticker.querySelector('.sub') };
  return tk.els;
}
function setTickerIdle(on) {
  on = !!on;
  if (tk.idle === on) return;
  tk.idle = on;
  els.ticker.classList.toggle('idle', on); // opacity only: the layout keeps reserving the strip, nothing reflows
}
function clearTicker() {
  tickerQueue.length = 0;
  tk.head = tk.sub = null;
  tk.headOffAt = -1e9; // nothing on air: a phone's bar may fade right away
  const d = ensureTickerDom();
  for (const el of [d.head, d.sub]) {
    el.textContent = '';
    el.classList.remove('in', 'out', 'p3', 'p1');
  }
  if (isCompact()) setTickerIdle(true);
}
function showTickerLine(tier, line, now) {
  const d = ensureTickerDom();
  const el = tier === 'head' ? d.head : d.sub;
  setTickerIdle(false);
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
  tk[tier] = { pri: line.pri, kind: line.kind, shownAt: now };
  // a taller ticker must keep the last lane clear of it
  if (!els.ticker.hidden && els.ticker.offsetHeight !== state.tickerH) updateInsets();
}
function hideTickerLine(tier) {
  tk[tier] = null;
  if (tier === 'head') tk.headOffAt = performance.now();
  if (!tk.els) return;
  const el = tier === 'head' ? tk.els.head : tk.els.sub;
  el.classList.remove('in');
  el.classList.add('out');
}
function pumpTicker() {
  const now = performance.now();
  const tNow = state.t;
  for (let k = tickerQueue.length - 1; k >= 0; k--) {
    const e = tickerQueue[k];
    // two guards: wall-clock TTL, and race-clock truth (a line about 2 s ago is history, not news)
    if (now > e.expires || (e.pri >= 2 && tNow - e.tRef > TICKER_STALE[Math.min(3, e.pri)])) tickerQueue.splice(k, 1);
  }
  // phones get one (two-line) tier: chatter shares it, and a story beat pre-empts chatter that has had 600 ms
  const single = isCompact();
  // headline tier: the first pri-3 line jumps the queue and pre-empts; then the first lead change; then story beats in order
  let hi = -1;
  let h2 = -1;
  let hLead = -1;
  let h1 = -1;
  for (let k = 0; k < tickerQueue.length; k++) {
    const l = tickerQueue[k];
    if (l.pri >= 3) {
      hi = k;
      break;
    }
    if (l.pri === 2 && h2 < 0) h2 = k;
    if (l.pri === 2 && l.kind === 'lead' && hLead < 0) hLead = k;
    if (l.pri <= 1 && h1 < 0) h1 = k;
  }
  if (hi < 0) hi = hLead >= 0 ? hLead : h2 >= 0 ? h2 : single ? h1 : -1;
  const H = tk.head;
  if (hi >= 0) {
    const line = tickerQueue[hi];
    const up = H ? now - H.shownAt : Infinity;
    let can;
    if (H && H.kind === 'win' && up < TICKER_WIN_PROTECT) can = false; // the winner's line is never trampled
    else if (!H || line.pri >= 3) can = true;
    else if (line.pri === 2 && H.pri <= 1) can = up >= 600;
    else if (line.kind === 'lead' && H.pri === 2) can = up >= TICKER_LEAD_PREEMPT;
    else if (line.kind === 'lead' && (H.kind === 'hotdog' || H.kind === 'aftermath')) can = up >= 1200; // same story, next beat
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
    setTickerIdle(!tk.head && now - tk.headOffAt >= TICKER_IDLE_MS);
    return;
  }
  setTickerIdle(false);
  const si = tickerQueue.findIndex((l) => l.pri <= 1);
  if (si >= 0) {
    if (!S || now - S.shownAt >= TICKER_HOLD[1]) showTickerLine('sub', tickerQueue.splice(si, 1)[0], now);
  } else if (S && now - S.shownAt > TICKER_LINGER[1]) hideTickerLine('sub');
}

// callouts ----------------------------------------------------------------
// Two slots: '.big' (countdown digits, centred on the water) and one '.wide'
// ribbon in the sky band. Ribbons are ranked: a lower-rank banner arriving
// while a higher-rank one is still up waits in a short queue (dropped if it
// waited > opts.maxWait, default 1.2 s); equal or higher rank replaces
// immediately unless the newcomer is `polite` (then it queues too, so set
// pieces hand off one after another instead of trampling each other).
const CALLOUT_RANK = { pause: 9, go: 5, win: 4, pick: 4, photo: 4, revenge: 3, hotdog: 3, tail: 3, stretch: 2 };
const RIBBON_DWELL = 900; // ms a ribbon is guaranteed before an EQUAL-rank newcomer may take the band (it waits, then hands off)
const RIBBON_OUT_MS = 180; // exit animation of a ribbon that is being replaced (.wide.out)
const cal = { wide: null, queued: [] };

/** Take the current ribbon off air: with a short exit when something replaces it live, instantly otherwise. */
function retireRibbon(cur, animate) {
  clearTimeout(cur.timer);
  clearTimeout(cur.handoff);
  const el = cur.el;
  if (animate && el.isConnected && !scene.reduceMotion) {
    el.classList.add('out');
    setTimeout(() => el.remove(), RIBBON_OUT_MS);
  } else el.remove();
  if (cal.wide === cur) cal.wide = null;
}

/** An equal-rank ribbon is waiting: once the one on air has had RIBBON_DWELL, hand the band over. */
function scheduleHandoff(cur, ms) {
  if (cur.handoff) return; // already armed (earliest deadline stands)
  cur.handoff = setTimeout(
    () => {
      cur.handoff = 0;
      if (cal.wide === cur) pumpCalloutQueue(cur.rank);
    },
    Math.max(0, ms),
  );
}

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
 * @param {{ttl?: number, rank?: number, persist?: boolean, polite?: boolean, maxWait?: number}} [opts]
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
  let handoff = false; // replacing a ribbon that is still on air: it exits (.out) while the newcomer sweeps in 90 ms later
  if (wide) {
    const cur = cal.wide;
    const live = !!cur && cur.el.isConnected && now < cur.until;
    if (live && !persist) {
      // lower rank waits; so does a polite one; so does an EQUAL rank while the current one is younger than its dwell
      const young = rank === cur.rank && !cur.persist && now - cur.shownAt < RIBBON_DWELL;
      if (rank < cur.rank || opts.polite || young) {
        cal.queued.push({ content, kind, opts: { ...opts, rank, polite: false }, at: now });
        if (cal.queued.length > 3) cal.queued.shift();
        if (young) scheduleHandoff(cur, RIBBON_DWELL - (now - cur.shownAt));
        return;
      }
    }
    if (cur) {
      handoff = live;
      retireRibbon(cur, live);
    }
  } else {
    for (const old of els.callout.querySelectorAll('.big')) old.remove();
  }
  const lag = handoff ? RIBBON_OUT_MS / 2 : 0;
  const el = document.createElement('div');
  el.className = kind + (persist ? ' persist' : '');
  el.style.setProperty('--ttl', `${ttl}ms`);
  if (lag) el.style.animationDelay = `${lag}ms`;
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
  const entry = { el, rank, until: persist ? Infinity : now + lag + ttl, timer: 0, handoff: 0, persist, shownAt: now + lag };
  cal.wide = entry;
  if (!persist) {
    entry.timer = setTimeout(() => {
      el.remove();
      if (cal.wide === entry) cal.wide = null;
      pumpCalloutQueue();
    }, ttl + lag);
  }
}
/** Show the best waiting ribbon (rank >= minRank), the rest queue up again behind it. */
function pumpCalloutQueue(minRank = -1) {
  const now = performance.now();
  const live = cal.queued.filter((q) => now - q.at <= (q.opts.maxWait ?? 1200));
  cal.queued = [];
  if (!live.length) return;
  // highest rank first (earliest among equals); the rest wait behind it again
  let best = 0;
  for (let k = 1; k < live.length; k++) if (live[k].opts.rank > live[best].opts.rank) best = k;
  if (live[best].opts.rank < minRank) {
    cal.queued = live; // nothing waiting may take the band from what is on air yet
    return;
  }
  const q = live.splice(best, 1)[0];
  callout(q.content, q.kind, q.opts);
  for (const r of live) cal.queued.push({ ...r, opts: { ...r.opts, polite: true } });
}
function dropPersistentCallout() {
  const cur = cal.wide;
  if (cur && cur.persist) {
    retireRibbon(cur, false);
    pumpCalloutQueue();
  }
  for (const el of els.callout.querySelectorAll('.persist')) el.remove();
}
function clearCallouts() {
  if (cal.wide) {
    clearTimeout(cal.wide.timer);
    clearTimeout(cal.wide.handoff);
  }
  cal.wide = null;
  cal.queued = [];
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
//
// A capped refresh rate (iOS Low Power Mode, a 30 Hz TV, battery savers) is
// NOT a slow device: `vsync` estimates the display's frame interval (fast
// attack toward shorter frames, slow release so a 60 -> 30 Hz switch re-locks),
// and every shed is a TRIAL — if the lower tier doesn't buy >= 12 % cadence
// within 2.5 s it is undone, the display is treated as capped, and nothing is
// persisted. Only a tier that provably helped is remembered (perf.storedTier).
const perf = {
  dtAvg: 16.7,
  vsync: 16.7, // estimated display frame interval (ms)
  slowSince: 0,
  fastSince: 0,
  improved: false,
  skip: false,
  pinned: false, // ?fx= pins the tier: the governor and the store stay out of it
  trial: null, // {from, before, at}: a shed under evaluation
  capped: false, // a shed bought nothing: frame time is the display's, not ours
  storedTier: stored.qtier ?? 0, // what saveStore() writes as qtier
};

function applyQualityTier(tier, { persist = true } = {}) {
  tier = clamp(tier | 0, 0, 2);
  if (tier !== scene.qualityTier) scene.setQualityTier(tier);
  document.body.classList.toggle('lowfx', scene.qualityTier >= 1);
  if (persist && !perf.pinned) {
    perf.storedTier = scene.qualityTier;
    saveStore();
  }
}

function governor(now, dtMs) {
  perf.dtAvg = lerp(perf.dtAvg, Math.min(dtMs, 200), 0.05);
  if (dtMs > 4 && dtMs < 60) perf.vsync = dtMs < perf.vsync ? lerp(perf.vsync, dtMs, 0.3) : Math.min(40, perf.vsync + 0.004);
  if (perf.pinned) return;
  const racing = (state.phase === 'race' || state.phase === 'finish') && !state.paused && state.holdLeft <= 0 && !document.hidden;
  if (!racing) {
    perf.slowSince = 0;
    perf.fastSince = 0;
    return;
  }
  if (perf.trial) {
    if (now - perf.trial.at < 2500) return; // let the lower tier show what it buys
    if (perf.dtAvg > perf.trial.before * 0.88) {
      // it bought (next to) nothing: the frame interval is the display's cadence — undo, remember, never persist
      applyQualityTier(perf.trial.from, { persist: false });
      perf.capped = true;
      perf.vsync = Math.max(perf.vsync, Math.min(40, perf.dtAvg)); // re-lock the estimate to the cap we just proved
    } else {
      perf.storedTier = scene.qualityTier; // a shed that paid for itself is worth remembering
      saveStore();
    }
    perf.trial = null;
    perf.slowSince = perf.fastSince = 0;
    return;
  }
  const slowT = perf.capped ? Math.max(22, perf.vsync * 1.3) : 22;
  const fastT = Math.max(17.5, perf.vsync * 1.06); // "clean" is relative to the display: a 30 Hz cap hands back an old session's tier too
  if (perf.dtAvg > slowT) {
    perf.fastSince = 0;
    if (!perf.slowSince) perf.slowSince = now;
    else if (now - perf.slowSince > 1500 && scene.qualityTier < 2) {
      perf.trial = { from: scene.qualityTier, before: perf.dtAvg, at: now };
      applyQualityTier(scene.qualityTier + 1, { persist: false });
      perf.slowSince = 0;
    }
  } else {
    perf.slowSince = 0;
    if (perf.dtAvg < fastT && scene.qualityTier > 0 && !perf.improved) {
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
  say(commentator.go(), 2, { t: 0, kind: 'go' }); // each duck's launch splash comes from the scene at its own reaction time
  // once per browser: how to find "my duck" (skipped if they already follow one)
  if (!stored.tip && state.focus < 0) {
    setTimeout(() => {
      if (gen !== raceGen || state.phase !== 'race' || stored.tip || state.focus >= 0) return;
      stored.tip = true;
      saveStore();
      toast(`Tip: ${coarseMQ.matches ? 'tap' : 'click'} your name (or your duck) to follow it`, { ms: 3800 });
    }, 1500);
  }
}

function advanceRace(dt) {
  const sim = state.sim;
  const n = sim.count;
  const t0 = state.t;
  const lastFirst = state.rule === 'last-first';

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

  // --- playback rate: the last five seconds are programmed by live margin (classified on the grid in samplePoll) ---
  let target = 1;
  let bracket = false; // hot-dog undercrank: slows the clock without the slow-mo "look" (vignette / muffle)
  const remaining = TRACK_LENGTH - leadX;
  if (state.finished === 0 && U.length >= 2) {
    const gap12 = xs[U[0]] - xs[U[1]];
    switch (state.runIn) {
      case 'photo':
        target = remaining < 18 ? (gap12 < 5 ? 0.3 : 0.42) : 0.55;
        if (lastFirst) target = Math.max(target, 0.5); // under toilet-bowl rules the back gets the drama budget
        break;
      case 'contested':
        if (!lastFirst) target = remaining < 30 ? 0.65 : 1;
        break;
      case 'clear':
        if (!state.preRolled && remaining < 35) {
          state.preRolled = true; // a gentle push-in toward the wall; the scene's hero zoom extends it on the touch
          if (!scene.reduceMotion) scene.zoomTo(1.12, scene.sx(TRACK_LENGTH) - 60 * scene.ui, scene._zoomFloorY(), 2200);
        }
        break;
      default:
        break;
    }
  }
  if (state.winnerAt !== null) {
    // no release on the winner's touch: stay under while the podium places arrive on his heels
    const closeBehind = state.finished < 3 && U.some((i) => sim.finishTimes[i] !== null && sim.finishTimes[i] - t0 < 0.45);
    target = t0 - state.winnerAt < 0.35 || closeBehind ? (state.runIn === 'photo' ? 0.35 : 0.6) : 1;
  }
  // podium settled: fast-forward only while nobody is about to finish (every finish plays at ~1x)
  if (state.finished >= Math.min(3, n) && U.length > 3 && nextFt - t0 > 2.5) target = 2.2;
  // a lone straggler well adrift: hurry them home, easing off before their touch
  if (U.length === 1 && state.finished >= 1) {
    if (nextFt - t0 > 1.5) state.soloHurry = true;
    else if (nextFt - t0 < 0.8) state.soloHurry = false;
    if (state.soloHurry) target = 1.8;
  } else state.soloHurry = false;
  // race for last (or for the FIRST pick): watch the back pair once the front is settled; duel slow-mo with hysteresis
  if (n >= 3 && U.length >= 2) {
    const B0 = U[U.length - 1]; // backmarker
    const B1 = U[U.length - 2];
    const d1 = TRACK_LENGTH - xs[B1];
    if (!state.tailWatch && state.finished >= 1 && d1 < 70 && d1 > 12) {
      state.tailWatch = true; // (never before the winner: the front's moment is not to be shared)
      scene.tailStakes = lastFirst ? 'pick1' : 'last'; // arms the scene's freeze-frame for a tight finish at the back
    }
    const gapB = xs[B1] - xs[B0];
    if (state.tailDuel) state.tailDuel = gapB < 16; // holds until the second-last touches (U shrinks) or the gap opens
    else {
      // engage only for a genuine duel with enough runway left to be worth slowing for: a detached pair or the last two —
      // or any tight back pair under toilet-bowl rules, where that pair IS the result
      const detached = lastFirst || U.length <= 2 || xs[U[U.length - 3]] - xs[B1] > 12;
      state.tailDuel = state.tailWatch && detached && d1 < 32 && d1 > 14 && gapB < 10;
    }
    if (state.tailDuel && !scene.tailPair) scene.tailPair = [B1, B0]; // lit pills + the 'tail' camera's set (the beat may have set it already)
  } else state.tailDuel = false;
  if (state.tailDuel) target = Math.min(target, lastFirst ? 0.38 : 0.5);
  // hot dog: undercrank the impact and the tumble (no vignette: this is a gag, not the climax)
  if (state.impactAt !== null && t0 >= state.impactAt - 0.22) {
    state.impactUntil = state.impactAt + 0.32; // ~1.6 s of wall time around the hit, then ease back up
    state.impactAt = null;
  }
  if (state.finished === 0 && t0 < state.impactUntil && target > 0.38) {
    target = 0.38;
    bracket = true;
  }

  scene.slowmo = lerp(scene.slowmo, target < 0.7 && !bracket ? 1 : 0, 1 - Math.exp(-dt * 4));
  if (state.holdLeft > 0) {
    // hit-stop: the clock creeps and the rate itself is frozen, so playback resumes exactly where it was
    state.holdLeft -= dt;
    state.t += dt * state.rate * state.holdMul;
  } else {
    const kRate = target > state.rate ? 2.5 : 5; // fall into slow-mo quickly, climb out of it gently
    state.rate = lerp(state.rate, target, 1 - Math.exp(-dt * kRate));
    state.t += dt * state.rate;
  }
  setRecede(scene.camMode === 'stretch' && !isCompact());

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
    state.impactAt = ev.t;
    state.hotdogIdx++;
  }

  // --- sim events, hot-dog aftermaths and broadcast samples, strictly in race-clock order ---
  // (interleaving them by time means what a 0.25 s grid sample "knows" never depends on frame timing)
  for (;;) {
    const tEv = state.eventIdx < events.length ? events[state.eventIdx].t : Infinity;
    const tPoll = state.pollT + POLL_STEP;
    let tFu = Infinity;
    let kFu = -1;
    for (let k = 0; k < state.followUps.length; k++) {
      if (state.followUps[k].t < tFu) {
        tFu = state.followUps[k].t;
        kFu = k;
      }
    }
    const tNext = Math.min(tEv, tPoll, tFu);
    if (tNext > state.t + 1e-9) break;
    if (tEv === tNext) handleEvent(events[state.eventIdx++]);
    else if (tFu === tNext) airFollowUp(state.followUps.splice(kFu, 1)[0]);
    else {
      state.pollT = tPoll;
      samplePoll(tPoll);
    }
  }

  // crowd excitement follows the race (and leans in for a photo)
  audio.setCrowd(clamp(0.3 + (leadX / TRACK_LENGTH) * 0.5 + scene.cheer * 0.4 + (state.photoCalled && state.finished === 0 ? 0.15 : 0), 0, 1));

  if (state.phase === 'race' && state.finished >= n) setPhase('finish');
  if (state.phase === 'finish' && state.phaseTime > FINISH_HOLD) showResults();
}

/** Hot-dog aftermath: did it actually cost them? (ranked at the follow-up instant, not the frame) */
function airFollowUp(f) {
  const rankNow = standingsAt(state.sim, f.t).findIndex((r) => r.i === f.duck);
  const name = state.raceNames[f.duck];
  const line = commentator.hotdogAftermath(name, f.rankBefore + 1, rankNow + 1);
  say(line, 3, { duck: f.duck, t: f.t, ttl: 2500, kind: 'aftermath' }); // the punchline of the gag: one consolidated headline
}

const POLL_STEP = 0.25; // race-clock seconds between broadcast samples
const RANK_SAMPLES = 13; // 12 intervals = 3 s of rank history
// The run-in programme, decided once when the leader is RUNIN_AT units out, by the live gap to second (10 units = 1 m ≈ 0.4 s):
const RUNIN_AT = 45;
const GAP_PHOTO = 6; // closer than this (or a true photo finish): heavy slow-mo, PHOTO FINISH
const GAP_CONTESTED = 15; // closer than this: a fight to the wall, mild slow-mo, "to the wall — A from B!"
const GAP_CLEAR = 20; // wider than this 90 units out: call it ("nobody is catching X") and let the winner enjoy the run-in

/**
 * Everything the commentary says about the *shape* of the race is decided here,
 * at exact multiples of 0.25 s of race time with standings computed at that
 * instant — so frame timing never changes what gets said (share links replay
 * the same broadcast). Also hosts the director beats whose trigger is a
 * position threshold: the run-in programme (PHOTO / CONTESTED / CLEAR), the
 * race for last (and its photo), and the set-piece lock on chatter.
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
  const remaining = TRACK_LENGTH - leadX;
  const gap = live.length >= 2 ? live[0].x - live[1].x : Infinity;
  const lastFirst = state.rule === 'last-first';
  const nm = (r) => names[r.i];
  const au = sfx();

  // --- the run-in: classified once, 45 units out, by live margin ---
  if (!state.runIn && done === 0 && live.length >= 2 && remaining < RUNIN_AT) {
    state.runIn = sim.photoFinish || gap < GAP_PHOTO ? 'photo' : gap < GAP_CONTESTED ? 'contested' : 'clear';
  }
  if (!state.photoCalled && done === 0 && state.runIn === 'photo') {
    state.photoCalled = true;
    callout('PHOTO FINISH!', 'wide photo');
    say('It is desperately close — PHOTO FINISH!', 3, { duck: leader.i, t: tq, kind: 'photo' });
    announce('Photo finish!');
    au.riser(3.2);
  }
  if (!state.lineCalled && !state.photoCalled && !lastFirst && done === 0 && live.length >= 2 && remaining < 40 && gap < GAP_CONTESTED) {
    state.lineCalled = true; // CONTESTED: still together at the wall
    say(commentator.atTheLine(nm(live[0]), nm(live[1]), gap), 3, { duck: live[1].i, t: tq, kind: 'photo' });
    au.riser(2.4);
  }
  const closerFresh = state.closerT >= 0 && tq - state.closerT < 2.5; // "here comes X!" was only just said: don't contradict it yet
  if (!state.clearCalled && !closerFresh && done === 0 && live.length >= 2 && remaining < 90 && gap > GAP_CLEAR) {
    state.clearCalled = true; // CLEAR: call it early and let the winner enjoy the run-in
    say(commentator.clearRun(nm(live[0]), metres(gap)), 2, { duck: live[0].i, t: tq, kind: 'clear' });
  }

  // --- race for last (or for the first pick): a real set piece, called early enough to matter or not at all ---
  // rule w waits for the winner's moment to pass; under toilet-bowl rules the back IS the story, so the call may come while
  // the leader runs in (camera and set piece still let him finish first) — unless the front is itself a photo
  const sinceWin = state.winnerAt === null ? -1 : tq - state.winnerAt;
  const tailGate = lastFirst ? (done >= 1 ? sinceWin >= 0.75 : remaining < 25 && !state.photoCalled) : done >= 1 && sinceWin >= 1.5;
  if (!state.tailCalled && n >= 3 && live.length >= 2 && tailGate) {
    const b1 = live[live.length - 2];
    const b0 = live[live.length - 1];
    const d1 = TRACK_LENGTH - b1.x;
    if (d1 < 70) {
      state.tailCalled = true;
      const secsLeft = d1 / Math.max(speedAt(sim, b1.i, tq), 8);
      if (secsLeft >= 2) {
        state.tailAired = true;
        if (!scene.tailPair) scene.tailPair = [b1.i, b0.i]; // pills on the pair now; the camera's set is captured when the mode flips
        callout(lastFirst ? 'RACE FOR FIRST PICK' : 'RACE FOR LAST', lastFirst ? 'wide gold tail' : 'wide tail', { maxWait: 2500, polite: true, rank: lastFirst ? 4 : undefined });
        say(commentator.tailBattle([nm(b1), nm(b0)]), 3, { duck: b0.i, t: tq, kind: 'tail' });
      } // else: under two seconds of racing left at the back — a ribbon now would only flash; stay quiet
    }
  }
  if (state.tailAired && done >= 1 && sinceWin >= 0.75 && scene.camMode !== 'tail') scene.camMode = 'tail';
  let tailTight = false;
  if (n >= 3 && live.length >= 2 && done >= 1 && sinceWin >= 0.75) {
    const b1 = live[live.length - 2];
    const b0 = live[live.length - 1];
    const d1 = TRACK_LENGTH - b1.x;
    tailTight = d1 < 32 && b1.x - b0.x < 10;
    if (!state.tailPhotoCalled && d1 < 32 && b1.x - b0.x < 6) {
      if (!scene.tailPair) scene.tailPair = [b1.i, b0.i];
      state.tailPhotoCalled = true;
      callout(lastFirst ? 'PHOTO FOR FIRST PICK!' : 'PHOTO FOR LAST!', lastFirst ? 'wide gold photo' : 'wide photo', { maxWait: 2500, polite: true, rank: lastFirst ? 4 : 3 });
      say(commentator.tailPhoto([nm(b1), nm(b0)], state.rule), 3, { duck: b0.i, t: tq, kind: 'tail' });
    }
  }

  // --- set-piece lock: the photo run-in, the last metres and the tail duel belong to priority-3 lines only ---
  state.climax = (done === 0 && (state.photoCalled || remaining < 60)) || tailTight;

  // situational lines: duels, breakaways, movers, the closer, long leads, dead air (not in the start scramble)
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
      chatterOK: tq - state.lastChatterT >= 2.5 && !state.climax, // don't burn a variant on a line the gate would drop
      streak: state.leadStreak,
      finished: done,
      trackLength: TRACK_LENGTH,
    },
    tq,
  );
  // detectors keep running under the lock (they have memory); only set-piece lines are allowed out
  if (line) {
    if (line.kind === 'closer') state.closerT = tq;
    chatter(line.text, line.pri, { duck: line.duck, t: tq, kind: line.kind || '' });
  }
}

/** Relevance gate for burst/stumble chatter: front two, the back marker, or a duck on the move. */
function chatterRelevant(duck, standings) {
  const n = standings.length;
  const rank = standings.findIndex((r) => r.i === duck);
  if (rank < 0) return false;
  if (rank <= 1 || rank === n - 1 || duck === state.focus) return true;
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
      hushChatter(ev.t);
      say(commentator.forEvent(ev, standings, state.t), 3, { ...meta, kind: 'hotdog' });
      const rankBefore = Math.max(0, standings.findIndex((r) => r.i === ev.duck));
      announce(rankBefore === 0 ? `Hot dog hits ${name}, the leader` : `Hot dog hits ${name}`);
      state.victims.add(ev.duck);
      state.lastHotdogT = ev.t; // the board holds still while the victim tumbles (the 'hit' flash tells the story)
      state.followUps.push({ t: ev.t + FOLLOWUP_DELAY, duck: ev.duck, rankBefore });
      flashRow(ev.duck, 'hit', 900);
      break;
    }
    case 'lead': {
      if (!look) break;
      state.calledLeader = ev.duck;
      au.whooshDing();
      au.cheer(0.22, 1.2);
      flashRow(ev.duck, 'newlead', 900);
      const lm = { ...meta, kind: 'lead' };
      commentator.noteLead(ev.duck, ev.t);
      const pri = state.climax && state.finished === 0 ? 3 : 2; // a lead change inside the set piece IS the set piece
      const fu = ev.from >= 0 ? state.followUps.findIndex((f) => f.duck === ev.from) : -1;
      if (state.victims.has(ev.duck) && !state.avenged.has(ev.duck)) {
        state.avenged.add(ev.duck);
        callout('REVENGE!', 'wide gold revenge');
        hushChatter(ev.t);
        say(commentator.revenge(name), 3, lm);
        au.cheer(0.4, 2);
      } else if (fu >= 0) {
        // the victim just lost the lead to this duck: one headline instead of a lead line plus an aftermath line
        state.followUps.splice(fu, 1);
        say(commentator.leadFromVictim(name, state.raceNames[ev.from]), pri, lm);
      } else {
        say(commentator.forEvent(ev, standings, state.t), pri, lm);
      }
      if (state.t > 1) announce(`${name} takes the lead`);
      updateHud(true); // a called lead change is definitive: snap the board to it
      break;
    }
    case 'halfway': {
      say(commentator.forEvent(ev, standings, state.t), 2, { duck: standings[0]?.i ?? ev.duck, t: ev.t, kind: 'halfway' });
      const top = standings.slice(0, 3).map((r) => state.raceNames[r.i]);
      announce(`Halfway: ${top.join(', then ')}`);
      break;
    }
    case 'stretch':
      scene.camMode = 'stretch';
      callout('FINAL STRETCH', 'wide stretch');
      au.cheer(0.3, 2.5);
      au.startTension(); // drone + heartbeat until the winner touches the wall
      hushChatter(ev.t);
      say(commentator.forEvent(ev, standings, state.t), 3, { duck: standings[0]?.i ?? ev.duck, t: ev.t, kind: 'stretch' });
      break;
    case 'finish': {
      if (!look) break;
      state.finished++;
      const place = state.finished;
      const n = state.sim.count;
      const lane = scene.lanes[ev.duck];
      const photo = state.sim.photoFinish;
      const lastFirst = state.rule === 'last-first';
      const fts = state.sim.finishTimes;
      const lineOpts = { photo, margin: state.sim.margin, victim: state.victims.has(ev.duck), rule: state.rule, n };
      if (place === 1) {
        state.winnerAt = ev.t;
        // a steal: the winner was not in front for the whole of the last second (read off the sim, so every replay agrees)
        const steal = n >= 2 && [0.25, 0.5, 0.75, 1].some((d) => standingsAt(state.sim, Math.max(0, ev.t - d))[0].i !== ev.duck);
        lineOpts.steal = steal;
        if (!scene.reduceMotion) {
          scene.flash = photo ? 1 : 0.6;
          scene.shake = 0.5;
        }
        au.stopTension(true); // cymbal crash exactly on the touch (also resolves the riser)
        au.fanfareSting();
        au.cameraFlash();
        au.cheer(0.6, 3);
        au.quack(pitch, 0.5);
        au.duckAmbience(1200);
        clearTicker();
        say(commentator.finishLine(ev.duck, 1, lineOpts), 3, { ...meta, kind: 'win' });
        if (lastFirst) callout([{ nm: name }, ' WINS THE RACE'], 'wide win', { polite: true, maxWait: 1600 }); // behind RACE FOR FIRST PICK, if that is up (navy, not gold: the gold moment is the last duck's)
        else callout([{ nm: name }, steal ? ' STEALS IT!' : ' WINS!'], 'wide gold win', { ttl: 2200 }); // the headline of the race: readable through the still + confetti, not a 1.4 s blink
        announce(lastFirst ? `${name} wins the race — and picks last` : steal ? `${name} steals it!` : `${name} wins!`, { now: true });
        scene.punch?.(0.08, scene.sx(TRACK_LENGTH), lane?.y);
      } else if (place === n) {
        const order = state.sim.order;
        const lastMargin = n >= 2 ? fts[order[n - 1]] - fts[order[n - 2]] : Infinity;
        lineOpts.lastMargin = lastMargin;
        if (lastFirst) {
          callout([{ nm: name }, ': LAST — PICKS FIRST!'], 'wide gold pick', { ttl: 2200 });
          au.fanfareSting();
          au.cymbal();
          au.cheer(0.5, 3);
          if (!scene.reduceMotion) scene.confettiBurst(TRACK_LENGTH, lane ? lane.top : scene.waterTop, 40);
          say(commentator.finishLine(ev.duck, place, lineOpts), 3, { ...meta, kind: 'tail' });
          announce(`${name} is last — and gets the first pick`, { now: true });
        } else {
          if (lastMargin < 0.25 && n >= 3) {
            // a photo for last: shutter now, sad trombone once the still has had its beat
            au.cameraFlash();
            if (!mute.sfx) {
              const gen = raceGen;
              setTimeout(() => {
                if (gen === raceGen && state.phase === 'finish') audio.wahwah();
              }, 600);
            }
          } else au.wahwah(); // sad trombone for the wooden spoon
          say(commentator.finishLine(ev.duck, place, lineOpts), lastMargin < 0.4 ? 3 : 2, { ...meta, kind: 'tail' });
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
  return `${n} ducks · ${close} · ${sim.leadChanges} lead change${sim.leadChanges === 1 ? '' : 's'} · code ${seedToCode(state.seed)} (${SOURCE_LABEL[state.seedSource]})`;
}

/** How duck-with-`place` did, in words: "won the race, 36.87s" / "finished 8th, 39.51s" / "last, 12th, 39.90s". */
function placeWords(place, n, ft) {
  const w = place === 1 ? 'won the race' : place === n ? `last, ${ordinal(n)}` : `finished ${ordinal(place)}`;
  return `${w}, ${ft.toFixed(2)}s`;
}

/** Draft slot in house style: 1.01, 1.02 … (round 1, two-digit pick). */
const slotNo = (k) => `1.${String(k + 1).padStart(2, '0')}`;

function boardHeadRow(R) {
  const li = document.createElement('li');
  li.className = 'board-head';
  li.setAttribute('aria-hidden', 'true');
  li.innerHTML = `<span></span><span>Manager</span><span>Race finish</span>`;
  li.firstChild.textContent = R.header;
  return li;
}

/** @param {{nav?: 'push'|'replace'|'none'}} [opts] how the result URL enters history (a browser Back/Forward arrival: 'none') */
function showResults({ nav = 'push' } = {}) {
  if (state.paused) setPaused(false);
  clearCallouts();
  clearTicker();
  hideConfirm();
  stopCeremony();
  setPhase('results');
  audio.stopTension(false);
  audio.setSlowmo(0);
  scene.resetPresentation({ keepParticles: true }); // no vignette / zoom / stills behind the board; confetti may keep falling
  state.rate = 1;
  setRecede(false);
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
  const wide = picks.length >= 7 && window.innerWidth >= 1000;
  const winnerT = sim.finishTimes[order[0]];
  const league = state.league;
  els.results.classList.toggle('results--wide', wide);
  els.results.classList.toggle('rule-last', lastFirst);
  els.results.classList.toggle('from-share', state.sharedRun);
  els.replay.textContent = state.sharedRun ? 'Watch again' : 'Watch replay';
  els.rulePill.textContent = R.pill;
  arrangeActions();
  // last place picks first: hero card on top, the (bragging-rights) podium demoted below the board
  if (lastFirst) els.board.after(els.podiumCap, els.podium);
  else els.hero.after(els.podiumCap, els.podium);

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
      if (k === 0) tag = '<span class="tag gold">Dead last → first pick</span>';
      else if (k === n - 1) tag = '<span class="tag">Won the race → last pick</span>';
    } else if (place === 1) tag = '<span class="tag gold">🏆 Champion</span>';
    else if (place === n) tag = '<span class="tag">Last place</span>';
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
  const url = shareUrl();
  // the official result gets its own history entry: browser Back from wherever the user goes next reopens this board
  try {
    const st = { dd: 'result', src: state.seedSource };
    if (nav === 'push' && !state.resultPushed && location.href !== url) history.pushState(st, '', url);
    else if (nav !== 'none') history.replaceState(st, '', url);
  } catch {
    /* SecurityError in sandboxed iframes */
  }
  state.resultPushed = true;
  state.lastResult = { url, label: `${league || 'Last race'} · code ${seedToCode(state.seed)}` };
  announce(`${R.h2}: ${picks.map((d, k) => `${k + 1} ${state.looks[d].name}`).join(', ')}`, { now: true });
  els.resultsTitle.focus({ preventScroll: true });
  runCeremony({ lastFirst, firstPickName: state.looks[picks[0]].name });
}

// ---------------------------------------------------------------------------
// Results ceremony: plinths rise 3-2-1 (thunk, thunk, a 1.35 s drumroll, GOLD
// on the fanfare hit), the board reveals from the last pick up to #1, confetti
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
  // bronze… silver… a proper drumroll… GOLD on the fanfare hit, then the board lands from the last pick up
  later(300, () => {
    if (c3) {
      c3.classList.add('in');
      audio.thunk();
    }
  });
  later(900, () => {
    if (c2) {
      c2.classList.add('in');
      audio.thunk();
    }
  });
  later(1000, () => {
    state.roll = audio.drumroll(1.35); // crescendo into the gold plinth
  });
  later(2350, () => {
    state.roll = null; // the roll ends itself on the hit
    if (c1) c1.classList.add('in');
    audio.fanfare();
    audio.cheer(0.45, 2.2);
    launchDomConfetti();
    startPodiumLoop();
  });
  later(2850, () => R.classList.add('shine'));
  const step = rows.length > 12 ? 110 : 150;
  const ordered = rows.slice().reverse(); // last pick first, #1 lands last
  ordered.forEach((li, k) => {
    later(2950 + k * step, () => {
      li.classList.add('in');
      if (k === ordered.length - 1) {
        li.classList.add('gold-sweep');
        audio.cymbal();
        if (lastFirst) flashResults(`${firstPickName} PICKS FIRST`);
      } else audio.tick();
    });
  });
  later(2950 + ordered.length * step + 450, () => finishCeremony(false));
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
  const rule = normRule(state.rule);
  const R = RULES[rule];
  const sim = state.sim;
  const order = sim.order;
  const n = order.length;
  const choice = rule === 'winner-choice';
  const lines = [
    `🦆 ${state.league || 'Duck Derby'} — ${R.h2} · ${new Date().toLocaleDateString()}`,
    `${R.sentence}. Race finish in brackets.`,
    ...draftOrder().map((d, k) => {
      const who = `${state.looks[d].name}  (${placeWords(order.indexOf(d) + 1, n, sim.finishTimes[d])})`;
      return choice ? `${ordinal(k + 1)} to choose — ${who}` : `Pick ${slotNo(k)} — ${who}`;
    }),
  ];
  lines.push(`Race code ${seedToCode(state.seed)} (${SOURCE_LABEL[state.seedSource]}).${withUrl ? ' Verify: open the link on any device — it re-runs this exact race from the code.' : ''}`);
  if (withUrl) lines.push('', `Replay / verify: ${shareUrl()}`);
  return lines.join('\n');
}

/**
 * Results footer layout. Phones get two rows: the primary action(s) full width (from a shared link: "Watch again"
 * beside "Share result"), then one scrollable strip of quiet chips; desktop keeps share actions left, navigation right.
 * (The replay / save / copy buttons move between the row and the strip, so this runs on show and on layout change.)
 */
function arrangeActions() {
  const strip = els.quietGroup;
  const edit = $('#btn-edit');
  if (isCompact()) {
    if (state.sharedRun) els.actions.insertBefore(els.replay, els.share);
    else strip.insertBefore(els.replay, strip.firstChild);
    strip.insertBefore(els.save, edit);
    strip.insertBefore(els.copy, edit);
  } else {
    els.actions.insertBefore(els.save, strip);
    els.actions.insertBefore(els.copy, strip);
    strip.insertBefore(els.replay, strip.firstChild);
  }
}

/** @param {{keepShared?: boolean}} [opts] keepShared: arriving on a shared link via browser Back — stay locked to it */
function backToSetup({ keepShared = false } = {}) {
  if (state.paused) setPaused(false);
  hideConfirm();
  if (!keepShared) leaveSharedMode(true); // back to setup = a new race: never re-run the seed we just watched
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
  scene.resetPresentation();
  scene.setLooks(state.looks);
  setPhase('setup');
  refreshLooks();
  scene.snapCamera(0);
  // the board we just left stays one tap away (until the roster changes or a race starts)
  const lr = state.lastResult;
  els.lastResult.hidden = !lr;
  if (lr) els.lastResultLabel.textContent = `↩ ${lr.label}`;
  // keyboard/desktop users land in the roster; on touch that would pop the keyboard uninvited
  if (!coarseMQ.matches && !state.locked) els.roster.querySelector('input')?.focus({ preventScroll: true });
}

function newRace() {
  hideConfirm();
  leaveSharedMode(true);
  state.sharedRun = false;
  startDerby({ seed: randomSeed(), source: 'random' });
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
  // a shared replay, or a result nobody has copied / saved / shared yet: don't silently roll a new "official" race over it
  if (state.sharedRun || !state.resultExported) showConfirm();
  else newRace();
});
$('#btn-confirm-new').addEventListener('click', newRace);
$('#btn-confirm-copy').addEventListener('click', async () => {
  await copyText(shareUrl(), 'Link to this board copied — starting a new race');
  newRace();
});
$('#btn-cancel-new').addEventListener('click', () => {
  hideConfirm();
  els.again.focus();
});
els.replay.addEventListener('click', () => startDerby({ seed: state.seed, source: state.seedSource }));
$('#btn-edit').addEventListener('click', () => backToSetup());
els.copy.addEventListener('click', () => copyText(resultText(), 'Draft order copied', { exported: true }));
$('#btn-copylink').addEventListener('click', () => copyText(shareUrl(), 'Share link copied — anyone can replay this exact race', { exported: true }));
els.share.addEventListener('click', async () => {
  const url = shareUrl();
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: `${state.league || 'Duck Derby'} draft order`, text: resultText({ withUrl: false }), url });
      state.resultExported = true;
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      /* NotAllowed / unsupported payload: fall back to the clipboard */
    }
  }
  copyText(url, 'Share link copied — anyone can replay this exact race', { exported: true });
});
els.save.addEventListener('click', saveImage);

/** @param {{exported?: boolean}} [opts] exported: a successful copy counts as "the result left the building" */
async function copyText(text, okMsg, { exported = false } = {}) {
  const ok = () => {
    if (exported && state.phase === 'results') state.resultExported = true;
    toast(okMsg, { ms: 2600 });
  };
  try {
    await navigator.clipboard.writeText(text);
    ok();
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
      if (!document.execCommand('copy')) throw new Error('copy refused');
      ok();
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
  const facts = `${new Date().toLocaleDateString()} · ${sim.count} ducks · ${sim.photoFinish ? 'photo finish' : `won by ${sim.margin.toFixed(2)}s`} · code ${seedToCode(state.seed)} (${SOURCE_LABEL[state.seedSource]})`;
  fitText(ctx, facts, textW, 22, 800, UI);
  ctx.fillText(facts, 62, 172);
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
  ctx.fillText(lastFirst ? 'DEAD LAST · FIRST PICK' : rule === 'winner-choice' ? 'WINNER · CHOOSES FIRST' : 'CHAMPION · FIRST PICK', W - 170, 262);
  // column headers
  ctx.textBaseline = 'middle';
  ctx.font = `900 16px ${UI}`;
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText(R.header.toUpperCase(), 100, top + 4);
  ctx.textAlign = 'left';
  ctx.fillText('MANAGER', 250, top + 4);
  ctx.textAlign = 'right';
  ctx.fillText('RACE FINISH', W - 80, top + 4);
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
    ctx.textAlign = 'center';
    const pickTxt = rule === 'winner-choice' ? String(k + 1) : slotNo(k); // slots read "1.01"; a choosing order is just 1, 2, 3…
    if (rule === 'winner-choice') ctx.font = `400 34px ${DISPLAY}`;
    else fitText(ctx, pickTxt, 84, 28, 400, DISPLAY);
    ctx.fillText(pickTxt, 100, y + rowH / 2 - 4);
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
        state.resultExported = true;
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
  state.resultExported = true;
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
renderShareBanner();
measureSafeAreas();
renderRoster();
let resizeTimer = 0;
let resizeRaf = 0;
window.addEventListener('resize', () => {
  // resize storms (rotation, dev-tools drags, soft keyboards) coalesce into one pass per frame + one settled pass
  if (!resizeRaf) {
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      measureSafeAreas();
      scene.resize();
      updateInsets();
    });
  }
  // rebuild the live-order rows once the resize settles (row height depends on it)
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.sim && !els.hud.hidden) buildStandings();
    else updateInsets();
    if (state.phase === 'results') arrangeActions();
  }, 120);
});
const onCompactChange = () => {
  updateInsets();
  if (state.sim && !els.hud.hidden) buildStandings();
  else syncHudChrome();
  if (state.phase === 'results') arrangeActions();
};
// browser Back / Forward: a result URL reopens its board, a shared link its locked setup, a bare URL the plain setup
window.addEventListener('popstate', (e) => {
  const data = decodeShare(location.search);
  const ph = state.phase;
  if (data && data.seed !== null) {
    if (ph !== 'setup' && ph !== 'results') return; // mid-race: the race owns the screen (its result is pushed when it ends)
    hideConfirm();
    readShareParams();
    syncOptionInputs();
    renderRoster();
    renderShareBanner();
    const st = e.state && typeof e.state === 'object' ? e.state : null;
    if ((st && st.dd === 'result') || state.entry.view === 'board') showBoardDirect('none', st && SOURCE_LABEL[st.src] ? st.src : 'shared');
    else backToSetup({ keepShared: true });
  } else if (!data && ph === 'results') backToSetup();
  else if (!data && ph === 'setup' && state.shared) {
    // Forward/Back past the shared link onto the bare page: the user's own (stored) roster, editable
    const own = loadStore().names;
    if (own && own.length >= MIN_DUCKS) state.names = own;
    leaveSharedMode(true); // (re-renders the roster editable)
    renderShareBanner();
  }
});
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
    case 'n':
    case 'N':
      if (RACE_PHASES.includes(state.phase)) cycleLabelMode();
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

syncHudChrome();
// deep links: ?…&view=board lands on the draft board; ?…&autoplay=1 starts by itself
if (state.shared && state.entry.view === 'board') {
  showBoardDirect('replace');
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
  setFocus,
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
    // a time jump invalidates whatever the banner/ticker/title card were saying
    clearCallouts();
    clearTicker();
    hideTitleCard(0);
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
