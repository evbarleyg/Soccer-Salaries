// Duck Derby — app shell: setup UI, race director (state machine + timeline),
// HUD, commentary, results and sharing.
//
// The race itself is precomputed and deterministic (src/sim.js); everything in
// here is playback: the director only ever moves the race clock `state.t` and
// its playback `rate`, so replays and share links stay identical and fair.

import { assignLooks, SAMPLE_NAMES, MIN_DUCKS, MAX_DUCKS, normalizeName } from './ducks.js';
import { createRace, standingsAt, speedAt, TRACK_LENGTH } from './sim.js'; // playback-side reads only: the sim itself is never touched here
import { RaceScene, CONFETTI_COLS, confettiShade, replayBarH } from './scene.js';
import { renderPortrait, drawDuck, roundRectPath } from './draw-duck.js';
import { DuckAudio } from './audio.js';
import { Commentator, ordinal, metres } from './commentary.js';
import { randomSeed, seedToCode, codeToSeed, canonicalSeedCode, clamp, lerp, hashString } from './rng.js';
import { encodeShare, decodeShare, sanitizeName, sanitizeLeague, truncateCodePoints, shortenedCount, NAME_MAX } from './share.js';
import { classifyRunIn, nobodyCatching, hotdogCulprits, raceAwards, hotdogLines, RUNIN_AT } from './awards.js';

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
  pickPin: null, // compact rule-last: the pinned "→ 1.01" chip (built on demand by ensurePickPin)
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
  podiumShelf: $('#podium-shelf'), // cap + podium travel together (beside the hero card / below the board under toilet-bowl rules)
  podiumCap: $('#podium-cap'),
  podium: $('#podium'),
  board: $('#draft-board'),
  resultsScroll: $('#results .panel-scroll'),
  actions: $('#results .results-actions'),
  quietGroup: $('#results .quiet-group'),
  share: $('#btn-share'),
  replay: $('#btn-replay'), // "Watch full race" / "Watch again": re-runs the whole race from the gun
  instant: $('#btn-instant'), // "Replay finish": the slow-motion instant replay again, then back to this board
  clip: $('#btn-clip'), // "Save clip": the replay + celebration recorded off the canvas (only where MediaRecorder can)
  replaySkip: $('#btn-replay-skip'),
  save: $('#btn-save'),
  copy: $('#btn-copy'),
  more: $('#btn-more'), // very short screens: opens the quiet actions as a sheet (CSS shows the button; see setMoreOpen)
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
  tv: $('#btn-tv'),
  topbar: $('.topbar'),
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
const FINISH_HOLD_REPLAY = 2.2; // …a touch shorter when the instant replay follows (its wipe covers the cut)
// Instant replay of the deciding touch (playback only: the scene re-renders past race time off the deterministic sim)
const REPLAY_RATE = 0.35; // slow-motion factor
const REPLAY_PRE = 0.9; // race seconds shown before the touch…
const REPLAY_POST = 0.3; // …and after it (1.2 s of race = 3.4 s on screen)
const REPLAY_FREEZE = 0.3; // wall seconds held on the last frame before the flash out (total stays under 4 s)
const REPLAY_CLOSE_LAST = 0.6; // last place picks first: a battle for last closer than this (s) is THE replay instead of the win
const CLIP_CODA = 2.0; // "Save clip": seconds of real-time celebration recorded after the replay
const CLIP_FPS = 30;
const TV_IDLE_MS = 2000; // big-screen mode: top bar and cursor hide after this long without input

// Compact layout = phones (portrait) and short/landscape viewports. One query, shared with styles.css.
const compactMQ = window.matchMedia('(max-width: 720px), (max-height: 500px)');
const isCompact = () => compactMQ.matches;
const coarseMQ = window.matchMedia('(pointer: coarse)');
const FX_PARAM = new URLSearchParams(location.search).get('fx') || ''; // '0'|'1'|'2' pins the quality tier
const TV_PARAM = new URLSearchParams(location.search).get('tv') || ''; // '1' turns big-screen mode on (and remembers it), '0' off
const REPLAY_PARAM = new URLSearchParams(location.search).get('replay') || ''; // '0': no automatic instant replay before the board (embeds, automation); the board's button stays
// highlight clip export is progressive enhancement: the button only exists where the canvas can be recorded
const CLIP_MIME = (() => {
  try {
    if (typeof HTMLCanvasElement === 'undefined' || !HTMLCanvasElement.prototype.captureStream || typeof window.MediaRecorder !== 'function') return '';
    const ok = (m) => (typeof MediaRecorder.isTypeSupported === 'function' ? MediaRecorder.isTypeSupported(m) : m === 'video/webm');
    return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4'].find(ok) || '';
  } catch {
    return '';
  }
})();

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
  tv: TV_PARAM === '1' ? true : TV_PARAM === '0' ? false : stored.tv === true, // big-screen / cast mode (button "TV", key T, &tv=1)
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
  awards: null, // {byDuck, headline, culprits} from awards.js — computed once per result (board tags, exports, PNG, share text)
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
  culprits: new Map(), // sim.events index -> the manager whose "section" threw that hot dog (awards.js, seeded; for laughs)
  hitBy: new Map(), // victim -> culprit duck of the last hot dog that hit them (the REVENGE line names the section)
  motifT: -9, // race time a leader's jingle last played (4 s cooldown)
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
  replay: null, // the instant replay in progress (see startInstantReplay): {kind, t0, t1, t, wall, dur, back, job…}
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
  chipLead: 138, // compact strip: x offset of chip #2 = the leader chip's width (CSS --lead-w) + 6
  crownSynced: false,
  hudRows: [], // <li> per duck (lane order) with cached child refs
  hudOrder: [], // duck ids as currently displayed, top to bottom
  hudLeader: -1,
  pinDuck: -1, // compact rule-last: the duck the pinned 1.01 chip shows
  pendingSince: new Map(), // "a>b" displayed pair the truth disagrees with -> since when
  rankMeta: new Map(), // duck -> {duck, rank}: the rank each row is displayed at
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
  syncWorldLink();
}

/** Keep the "race these ducks in 3D" link carrying the current roster (world.html reads names=a~b~c). */
function syncWorldLink() {
  const a = document.getElementById('link-world');
  if (!a) return;
  const names = state.names.map((n) => String(n || '').replace(/~/g, '-').trim()).filter(Boolean);
  const p = new URLSearchParams();
  if (names.length >= 2) p.set('names', names.join('~'));
  if (state.rule === 'last-first') p.set('rule', 'l');
  a.href = 'world.html' + (p.toString() ? `?${p}` : '');
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
/** "1. Alice\n2. Bob…" / comma / semicolon / tab separated text -> clean names (list markers stripped). `.shortened`: how many the 22-character rule cut. */
function splitNameList(text) {
  const raw = String(text)
    .split(/[\n\r,;\t]+/)
    .map((s) => s.replace(LIST_PREFIX, ''))
    .filter((s) => sanitizeName(s));
  const names = raw.map(sanitizeName);
  names.shortened = shortenedCount(raw);
  return names;
}
/** "2 names were shortened to 22 characters" (or '' when none were). */
function shortenedNote(k) {
  return k > 0 ? `${k === 1 ? '1 name was' : `${k} names were`} shortened to ${NAME_MAX} characters` : '';
}
/**
 * The one name-length rule, live: whatever share.js's sanitizer would make of the typed text replaces it (beyond
 * trailing whitespace, so a space before the next word can still be typed), caret preserved. No maxlength attribute:
 * that counts UTF-16 units and would cut an emoji name at 11.
 */
function enforceClean(input, sanitize) {
  const typed = input.value;
  const clean = sanitize(typed);
  if (clean === typed.replace(/\s+$/, '')) return;
  const caret = input.selectionStart ?? clean.length;
  input.value = clean;
  try {
    input.setSelectionRange(Math.min(caret, clean.length), Math.min(caret, clean.length));
  } catch {
    /* not focusable / type mismatch */
  }
}

function renderRoster() {
  els.roster.innerHTML = '';
  const locked = state.locked; // a shared race: names are read-only (no remove buttons) until "Make my own race"
  state.names.forEach((name, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="lane-no" aria-hidden="true">${i + 1}</span>
      <canvas width="44" height="40" aria-hidden="true"></canvas>
      <input type="text" placeholder="Duck ${i + 1} name" aria-label="Name for duck ${i + 1}" autocomplete="off" spellcheck="false" enterkeyhint="next" />
      ${locked ? '' : `<button type="button" class="remove" aria-label="Remove duck ${i + 1}" title="Remove">×</button>`}`;
    const input = li.querySelector('input');
    input.value = name;
    input.readOnly = locked;
    if (i === 0 && !locked) input.placeholder = 'Type a name — or paste your whole league';
    input.addEventListener('input', () => {
      if (state.locked) return;
      enforceClean(input, sanitizeName);
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
    const cut = shortenedNote(parts.shortened | 0);
    toast((skipped ? `${MAX_DUCKS} ducks max — ${skipped} name${skipped === 1 ? '' : 's'} left out` : `Added ${k} names · league size set to ${k}`) + (cut ? ` · ${cut}` : ''), {
      ms: cut ? 6500 : undefined,
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
  const cut = shortenedNote(parts.shortened | 0);
  toast((skipped ? `${MAX_DUCKS} ducks max — ${skipped} name${skipped === 1 ? '' : 's'} left out` : `Added ${k} name${k === 1 ? '' : 's'}`) + (cut ? ` · ${cut}` : ''), { ms: cut ? 3000 : undefined });
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
  enforceClean(els.optLeague, sanitizeLeague);
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
    // nothing may pile up behind a hidden tab: the ceremony completes silently, pending stings are dropped;
    // a replay ends (a clip recording is cancelled: no frames are painted while hidden)
    if (state.replay) finishInstantReplay(true);
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

// big-screen / cast mode ("TV", key T, &tv=1): a couch-readable board, ticker and ribbons (CSS body.tv + taller rows
// from sizeStandings + bigger name pills in the scene); the top bar and the cursor hide after TV_IDLE_MS without input
// (body.tv-idle; never on the setup screen) and come back on any mouse move, touch or key. Remembered per browser.
let tvIdleTimer = 0;
let tvWokeAt = 0;
function tvWake() {
  if (!state.tv) return;
  const now = performance.now();
  const cl = document.body.classList;
  if (cl.contains('tv-idle')) cl.remove('tv-idle');
  else if (now - tvWokeAt < 250) return; // mousemove storms: the pending timer is fresh enough
  tvWokeAt = now;
  clearTimeout(tvIdleTimer);
  tvIdleTimer = setTimeout(tvIdle, TV_IDLE_MS);
}
function tvIdle() {
  tvIdleTimer = 0;
  if (!state.tv) return;
  // never hide the bar from under a hovering pointer or a focused control
  if (els.topbar.matches(':hover') || els.topbar.contains(document.activeElement)) {
    tvWokeAt = 0;
    tvWake();
    return;
  }
  document.body.classList.add('tv-idle');
}
function applyTv() {
  const on = state.tv;
  document.body.classList.toggle('tv', on);
  if (!on) {
    clearTimeout(tvIdleTimer);
    document.body.classList.remove('tv-idle');
  } else {
    tvWokeAt = 0;
    tvWake();
  }
  els.tv.setAttribute('aria-pressed', String(on));
  scene.bigScreen = on;
  // the board's rows, the ticker's height and the panel's width all changed: re-measure so the lanes use what is left
  if (state.sim && !els.hud.hidden) buildStandings();
  else updateInsets();
  if (state.phase === 'results') {
    layoutBoard();
    arrangeActions();
  }
}
function setTv(on, { quiet = false } = {}) {
  state.tv = !!on;
  saveStore();
  applyTv();
  if (!quiet) toast(state.tv ? 'Big-screen mode — bigger board, chrome hides when idle (T)' : 'Big-screen mode off', { ms: 2400 });
  announce(state.tv ? 'Big-screen mode on' : 'Big-screen mode off', { now: true });
}
els.tv.addEventListener('click', () => setTv(!state.tv));
for (const type of ['mousemove', 'pointerdown', 'touchstart', 'wheel', 'keydown']) window.addEventListener(type, tvWake, { passive: true, capture: true });
els.topbar.addEventListener('focusin', tvWake);

// ---------------------------------------------------------------------------
// Persistence + share links
// ---------------------------------------------------------------------------
function loadStore() {
  let o;
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
    tv: o.tv === true,
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
        tv: state.tv || undefined,
      }),
    );
  } catch {
    /* private mode etc. */
  }
}

function readShareParams({ boot = false } = {}) {
  const data = decodeShare(location.search);
  if (!data) {
    if (/[?&](n|names)=/.test(location.search)) toast('That share link looks broken — check it was copied whole', { ms: 3500 });
    return;
  }
  state.names = data.names;
  if (boot) {
    // a hand-edited (or foreign) link with over-long names: say so once — both ends race the shortened names
    const p = new URLSearchParams(location.search);
    const cut = shortenedNote(shortenedCount(p.has('n') ? p.getAll('n') : String(p.get('names') ?? '').split('~')));
    if (cut) toast(cut, { ms: 3000 });
  }
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
  // a replay started from the board keeps the board in the DOM (CSS hides it) so nothing re-runs its ceremony on return
  els.results.hidden = !(phase === 'results' || (phase === 'replay' && !!state.replay && state.replay.back === 'results'));
  els.replaySkip.hidden = phase !== 'replay';
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
  else if (phase === 'countdown') {
    // landscape phones have no sky band to park the card in, and a crowded one could not clear lane 1: the lights take over
    if (landscapeCompact() || titleCard.crowded) hideTitleCard(1); // fade now: the first light is already on
  } else if (phase !== 'intro') hideTitleCard(0);
  updateInsets();
  if (phase === 'intro') els.hud.focus({ preventScroll: true });
}

/** Landscape phone layout (the CSS block `(max-height: 500px) and (min-width: 560px)`): two-column panels, no sky band. */
const landscapeCompact = () => isCompact() && window.innerHeight <= 500 && window.innerWidth >= 560;

// title card (league · ducks · rule · code) during intro + countdown: in the sky band on wide screens, under the live
// strip on portrait phones, bottom-right over open water on landscape phones (intro only) ---------------------------
let titleCardTimer = 0;
const titleCard = { crowded: false }; // even the tight card would reach lane 1: the countdown hides it
function showTitleCard() {
  const tc = els.titleCard;
  clearTimeout(titleCardTimer);
  tc.querySelector('.tc-1').textContent = state.league || 'DUCK DERBY';
  tc.querySelector('.tc-2').textContent = `${state.raceNames.length} DUCKS · ${RULES[state.rule].pill}`;
  tc.querySelector('.tc-3').textContent = `CODE ${seedToCode(state.seed)} · ${SOURCE_LABEL[state.seedSource].toUpperCase()}`;
  tc.classList.remove('out', 'tc-tight');
  titleCard.crowded = false;
  tc.hidden = false;
  fitTitleCard();
}
/** Keep the card clear of lane 1's pills: first the tight one-line-details form; if even that reaches the top rope, the countdown hides it. */
function fitTitleCard() {
  const tc = els.titleCard;
  if (tc.hidden || tc.classList.contains('out') || !scene.ropeYs.length || landscapeCompact()) return;
  const limit = scene.ropeYs[0] - 4;
  if (!tc.classList.contains('tc-tight') && tc.getBoundingClientRect().bottom > limit) tc.classList.add('tc-tight');
  titleCard.crowded = tc.getBoundingClientRect().bottom > limit;
  if (titleCard.crowded && state.phase === 'countdown') hideTitleCard(1);
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
    // layout box, not the bounding rect: the strip's 0.4 s entrance transform must not leak into the lanes or the CSS vars
    const hr = { top: els.hud.offsetTop, left: els.hud.offsetLeft, bottom: els.hud.offsetTop + els.hud.offsetHeight };
    if (compact) insets.top = Math.ceil(hr.bottom) + 6;
    else insets.right = Math.max(safe.right, Math.round(W - hr.left) + 6);
    const tr = els.ticker.getBoundingClientRect();
    if (tr.height) {
      const covered = Math.max(0, H - tr.top);
      // short landscape screens, and big fields on short laptops / tablets, have no height to spare for open water between
      // the last rope and the bar: let the scene's own bottom margin absorb the gap above the ticker (the lanes run down to it)
      const tight = (H <= 500 && W >= 560) || (!compact && state.looks.length >= 12 && H < 800);
      insets.bottom = tight ? Math.max(0, covered - 9) : covered + 4;
    }
  } else if (state.phase === 'replay') {
    insets.bottom = replayBarH(H) - 6; // the lanes end above the replay's bottom letterbox bar (the top one only ever covers sky)
  }
  scene.topBarH = Math.round(document.querySelector('.topbar')?.getBoundingClientRect().bottom || 0) || 0; // hero push-ins keep the venue below the bar
  scene.setInsets(insets);
  scene.layout();
  // ribbon / digit geometry lives on the callout layer (not :root — no document-wide style recalc per write)
  const skyH = scene.skyH || Math.round(H * 0.28);
  setCssPx(els.callout.style, '--sky-h0', skyH); // unzoomed: sizes the ribbon font, which must not breathe with the camera
  setCssPx(els.callout.style, '--water-mid', Math.round(skyH + (H - skyH - insets.bottom) / 2)); // the countdown digit: mid-water, above the ticker
  publishSkyBand(true);
  const hud = els.hud.hidden ? null : { top: els.hud.offsetTop, height: els.hud.offsetHeight };
  const st = document.documentElement.style;
  setCssPx(st, '--hud-top', hud ? Math.round(hud.top) : 0);
  setCssPx(st, '--hud-h', hud ? Math.round(hud.height) : 0);
  state.tickerH = els.ticker.hidden ? 0 : els.ticker.offsetHeight;
  setCssPx(st, '--ticker-h', state.tickerH);
  publishFooterH();
  fitTitleCard(); // lane 1 may have moved under the card (strip height, rotation)
}

/** Toasts on compact layouts sit just above the visible panel's action footer (setup / results): publish its height. */
function publishFooterH() {
  const panel = state.phase === 'setup' ? els.setup : state.phase === 'results' ? els.results : null;
  if (!panel) return;
  const foot = panel.querySelector('.panel-footer');
  setCssPx(document.documentElement.style, '--footer-h', foot ? foot.offsetHeight : 0);
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
  state.hitBy = new Map();
  state.motifT = -9;
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
  state.crownSynced = false; // the board's top row snaps to the scene's first crowned leader the frame the crown lands
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
  for (const look of state.looks) look.motif = hashString(normalizeName(look.name)) & 0x1ff; // name-keyed jingle: the same three notes every season
  state.sim = null;
  state.awards = null;
  state.culprits = new Map();
  teardownReplay();
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
  document.fonts?.load?.('40px Bungee').catch(() => {}); // the countdown digits want the display face; the 2.2 s intro covers the fetch
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
      state.culprits = hotdogCulprits(state.sim, opts.count); // empty when hazards are off (no hot-dog events)
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
  state.culprits = hotdogCulprits(state.sim, opts.count);
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
  if (state.replay) {
    finishInstantReplay(true); // Skip / Esc during the instant replay: straight to the board
    return;
  }
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
  if (tk.els) tk.els.tally.textContent = on ? 'PAUSED' : 'LIVE'; // the bar's LIVE tally goes grey and says so (CSS: body.paused)
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
    if (tk.head && tk.head.kind === 'pause') hideTickerLine('head'); // the phone bar then fades by itself until the next line
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
// into a permanent blur of half-swapped rows. Every board change is applied as
// ONE move pass (FLIP-style: the new ranks of all rows are decided first, then
// every transform, plate and z-index is written in the same frame — transform-
// only motion, no layout work): climbing rows ride ABOVE as lifted opaque cards,
// rows giving way slide BELOW them slightly dimmed, so two names never render
// through each other. When a row comes to rest after gaining or losing places a
// ▲n / ▼n badge holds its gap cell for a beat. styles.css owns the look (.mv /
// .up / .dn / .gap.delta) and reads the same duration and curve (--row-move).
//
// Cadence & hysteresis (race-clock semantics unchanged since round 2):
const HUD_PASS_MS = 1000; // min interval between reorder passes — well beyond the glide, so every swap lands and rests
const HUD_GAP_UNITS = 10; // swap a displayed pair at once when they are this far apart (1 m)…
const HUD_PERSIST_MS = 1200; // …or when the truth has disagreed this long
const HUD_LEAD_PERSIST_MS = 300; // the leader row still reacts fast (checked every tick, not per pass)
const HUD_REVERSE_COOLDOWN_MS = 2500; // a row won't move back the way it came this soon (no ping-pong)
const HUD_MAX_SWAPS = 2; // adjacent swaps per pass
const HUD_RESYNC_MS = 3000; // big reshuffles (start scramble, hot-dog tumbles) glide all rows at once, at most this often
const HUD_HOTDOG_LOCK = 2.2; // race seconds the board holds still after a hot dog
const LEAD_HYST_UNITS = 4; // = the sim's lead-call hysteresis (0.004 × track): the called leader keeps the top row inside it
// Set-piece locks (updateHud): the photo run-in (photoCalled, nobody home yet), the tail watch and a hot dog's
// aftermath hold the board; called lead changes and finishes still snap it (force).
// Motion (one pass per change; CSS: .standings --row-move / cubic-bezier(.2,.8,.2,1)):
const HUD_MOVE_MS = 280; // transform glide
const HUD_SETTLE_MS = 70; // rest after the glide before the lift, plates and z-order release and badges post
const HUD_BADGE_MS = 1600; // a ▲n / ▼n badge holds the row's gap cell this long, then the gap fades back
const HUD_GAP_FAST_MS = 250; // gap text cadence per row: the front three (exact tenths)…
const HUD_GAP_SLOW_MS = 600; // …and the rest (half-metre steps)
const CHIP_PITCH = 28; // compact strip: slot width of a chip (chip 26 px + 2) — sixteen fit a 844 px landscape phone
const CHIP_LEAD_GAP = 4; // compact strip: gap between the leader chip and chip #2

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
  let chrome = 0;
  const plausible = (c) => c > 60 && c <= 260; // head + foot + gaps + padding; anything else is a mid-transition or clipped read
  if (!els.hud.hidden && els.hud.offsetHeight) {
    hudTop = els.hud.getBoundingClientRect().top;
    const listH = els.standings.offsetHeight;
    if (listH > 0) chrome = els.hud.offsetHeight - listH; // the list keeps its size: nothing collapses, nothing can be caught mid-transition
    if (!plausible(chrome)) {
      st.transition = 'none'; // (Calm / reduced motion give every element a 10 ms transition: a collapsed read must not race it)
      st.height = '0px';
      chrome = els.hud.offsetHeight;
      st.transition = '';
    }
    if (plausible(chrome)) state.hudChrome = chrome;
    else chrome = state.hudChrome || 132;
  } else {
    hudTop = 62 + safe.top;
    chrome = state.hudChrome || 132;
  }
  const tv = state.tv && window.innerWidth > 860 && window.innerHeight >= 560; // = the CSS big-screen block
  const avail = window.innerHeight - hudTop - (tv ? 82 : 64) - chrome; // 64 (82 in TV mode): keep clear of the ticker row
  const rowH = clamp(Math.floor(avail / Math.max(1, n)), 22, tv ? 46 : 34);
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
    // the gap cell stacks the live gap (.gv) and the places-gained badge (.dl): fixed width, so neither reflows the name
    li.innerHTML = `<span class="pos"></span><span class="num"></span><span class="name"></span><span class="gap"><i class="gv"></i><b class="dl" aria-hidden="true"></b></span>`;
    const num = li.children[1];
    num.textContent = String(look.number);
    num.style.background = look.towel.bg;
    num.style.color = look.towel.text;
    li.children[2].textContent = look.name;
    li._pos = li.children[0];
    li._gap = li.children[3]; // the cell (class: gap | gap lead | gap fin | gap pick1, + badge)
    li._gv = li._gap.children[0]; // its text
    li._dl = li._gap.children[1]; // ▲n / ▼n
    li._last = { tf: '', pos: '', gap: null, gapCls: '', gapD: -1, leader: false, done: false, rank0: false, pick1: false };
    li._movedAt = 0; // hysteresis: when this row last moved…
    li._dir = 0; // …and which way (-1 up, 1 down, 0 bulk)
    li._rank = i; // displayed rank (set by updateHud's move pass)
    li._pass = 0; // motion: the move pass that currently owns the row's plate / lift / z-index
    li._acc = 0; // badge: net places gained since its badge window opened…
    li._accUntil = 0; // …which closes at this timestamp
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
  state.pinDuck = -1;
  const pin = ensurePickPin();
  pin.hidden = !compact || state.rule !== 'last-first'; // compact: measureStrip has the final say (it sizes the strip around it)
  pin._num.textContent = '';
  pin._num.style.background = '';
  syncHudChrome();
  if (compact) measureStrip(); // after syncHudChrome: the Skip pill has its compact label by now
  // every viewer of a shared link who picked their duck once is auto-followed in every later race with that name
  state.focus = -1;
  scene.focusDuck = -1;
  const me = stored.me ? state.raceNames.findIndex((nm) => normalizeName(nm) === stored.me) : -1;
  if (me >= 0) setFocus(me, { silent: true });
  updateHud(true);
  syncStripOverflow();
  updateInsets(); // the compact strip's height depends on its content
}

/**
 * Compact strip geometry: where chip #2 parks (behind the leader chip, whose width CSS owns) and the Skip column the
 * ribbon must leave free. Last takes 1.01: the pinned chip holds its column from the build, and when what is left of
 * the strip cannot hold a named leader chip (narrow phones) the HUD goes `tight` — the leader chip keeps "1" + disc.
 */
function measureStrip() {
  const leadW = () => parseFloat(getComputedStyle(els.standings).getPropertyValue('--lead-w')) || 132;
  const lastFirst = state.rule === 'last-first';
  ensurePickPin().hidden = !lastFirst;
  els.hud.classList.remove('tight');
  let w = leadW();
  if (lastFirst && els.standings.clientWidth < w + 2) {
    els.hud.classList.add('tight');
    w = leadW();
  }
  state.chipLead = Math.round(w) + CHIP_LEAD_GAP;
  setCssPx(document.documentElement.style, '--skip-w', els.skip.offsetWidth || 64);
}

/**
 * Compact strip: `overflow` marks a field that does not fit (16 ducks on a narrow phone) — the strip swipes (momentum,
 * slot snap: snapStrip) and a short edge fade marks the side(s) more chips continue on (syncStripEdges keeps it current).
 */
function syncStripOverflow() {
  if (!isCompact()) {
    els.standings.classList.remove('overflow', 'more-l', 'more-r');
    return;
  }
  const n = state.hudRows.length;
  const need = n <= 1 ? 0 : state.chipLead + (n - 2) * CHIP_PITCH + 26; // right edge of the last chip
  els.standings.classList.toggle('overflow', need > els.standings.clientWidth + 2);
  syncStripEdges();
}
function syncStripEdges() {
  const el = els.standings;
  const over = el.classList.contains('overflow');
  const max = el.scrollWidth - el.clientWidth;
  el.classList.toggle('more-l', over && el.scrollLeft > 1);
  el.classList.toggle('more-r', over && el.scrollLeft < max - 1);
}

/**
 * Compact strip, last place picks first: the duck currently sitting on the 1.01 is the story on a phone, but its chip is
 * the LAST one — usually scrolled out of a strip that only fits the leaders. A pinned chip at the strip's right end
 * mirrors it ([disc] → 1.01); tapping it follows that duck. Created once; CSS shows it only in the compact rule-last HUD.
 */
function ensurePickPin() {
  if (els.pickPin) return els.pickPin;
  const pin = document.createElement('button');
  pin.id = 'pick-pin';
  pin.className = 'pick-pin';
  pin.type = 'button';
  pin.hidden = true;
  pin.innerHTML = '<span class="num"></span><span class="lbl">\u2192 1.01</span>';
  pin.classList.add('idle');
  pin._idle = true;
  pin.tabIndex = -1;
  pin.setAttribute('aria-label', 'On the first pick: nobody yet');
  pin._num = pin.children[0];
  pin.addEventListener('click', () => {
    if (state.pinDuck >= 0 && state.pinDuck !== state.focus) setFocus(state.pinDuck);
    else if (state.pinDuck >= 0) flashRow(state.pinDuck, 'rise', 480);
  });
  els.hud.insertBefore(pin, els.standings.nextSibling);
  els.pickPin = pin;
  return pin;
}

/** Point the pinned 1.01 chip at duck `i` (idle until the race is live and someone is last); a new holder lands with the row's gold flash. */
function syncPickPin(i, live) {
  const pin = els.pickPin;
  if (!pin || pin.hidden) return; // desktop, or not last-takes-1.01 (measureStrip decides)
  const show = live && i >= 0;
  if (pin._idle !== !show) {
    pin._idle = !show;
    pin.classList.toggle('idle', !show);
    pin.tabIndex = show ? 0 : -1;
  }
  if (!show || i === state.pinDuck) return;
  const look = state.looks[i];
  const had = state.pinDuck >= 0;
  state.pinDuck = i;
  pin._num.textContent = String(look.number);
  pin._num.style.background = look.towel.bg;
  pin._num.style.color = look.towel.text;
  pin.title = `${look.name} is last \u2014 on the first pick`;
  pin.setAttribute('aria-label', `On the first pick: ${look.name}. Follow`);
  if (had && !mute.ui) {
    pin.classList.remove('newpick');
    void pin.offsetWidth;
    pin.classList.add('newpick');
  }
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
    if (next >= 0) {
      stored.tip = true; // found it: the "follow your duck" tip never needs to air (again)
      hideTip();
    }
    saveStore();
    announce(next >= 0 ? `Following ${name}` : 'Not following anyone', { now: true });
    if (next >= 0 && !isCompact()) flashRow(next, 'rise', 480);
  }
}

/** The duck under a canvas point, or -1 (the beak is the anchor: the body trails behind it). */
function duckAt(x, y) {
  if (!state.sim || !scene.sim) return -1;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < state.hudRows.length; i++) {
    const a = scene.duckScreen(i, state.t, state.phase);
    if (!a) continue;
    const dy = Math.abs(y - a.y);
    const dx = x - a.x;
    if (dy > Math.max(40 * a.scale, a.h / 2) || dx > 60 * a.scale || dx < -120 * a.scale) continue;
    const d = dy + Math.abs(dx + 30 * a.scale) * 0.25;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
// tap a duck on the water to follow it (release, so a press that merely resumed a paused race doesn't count);
// tap YOUR duck and it quacks back; press and hold it (450 ms) to stop following
const LONG_PRESS_MS = 450;
const press = { duck: -1, at: 0, x: 0, y: 0, timer: 0, done: false };
let lastPokeAt = 0;
function cancelPress() {
  clearTimeout(press.timer);
  press.timer = 0;
}
els.scene.addEventListener('pointerdown', (e) => {
  cancelPress();
  press.done = false;
  press.duck = -1;
  if (swallowPointerUp || state.paused || !RACE_PHASES.includes(state.phase)) return; // a press that resumes the race is only that
  press.at = performance.now();
  press.x = e.clientX;
  press.y = e.clientY;
  press.duck = duckAt(e.clientX, e.clientY);
  if (press.duck >= 0 && press.duck === state.focus) {
    press.timer = setTimeout(() => {
      press.timer = 0;
      press.done = true; // a long press on my duck: unfollow (the release then does nothing)
      if (state.focus === press.duck) setFocus(press.duck);
    }, LONG_PRESS_MS);
  }
});
els.scene.addEventListener('pointermove', (e) => {
  if (press.timer && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
});
els.scene.addEventListener('pointercancel', cancelPress);
els.scene.addEventListener('pointerup', (e) => {
  cancelPress();
  if (swallowPointerUp) {
    swallowPointerUp = false;
    return;
  }
  if (press.done || state.paused || !RACE_PHASES.includes(state.phase) || !state.sim || !scene.sim) return;
  const best = duckAt(e.clientX, e.clientY);
  if (best < 0) return;
  if (best === state.focus && best === press.duck) {
    // a quick tap on the duck I already follow: it answers (rate-limited; a slow release is neither a tap nor a hold)
    const now = performance.now();
    if (now - press.at < LONG_PRESS_MS && now - lastPokeAt >= 350) {
      lastPokeAt = now;
      scene.poke(best, state.t);
      sfx().quack(state.looks[best]?.quackPitch || 1, 0.45);
    }
    return;
  }
  setFocus(best);
});

let standingsTouchedAt = 0;
let hudAutoScrolling = false;
els.standings.addEventListener('scroll', () => {
  if (isCompact()) syncStripEdges();
  if (hudAutoScrolling) return;
  standingsTouchedAt = performance.now();
  if (!('onscrollend' in window)) scheduleStripSnap(140); // no scrollend (older Safari): settle once the momentum goes quiet
});
// Compact strip: a swipe comes to rest on a chip slot (x = 0, then chipLead + k·CHIP_PITCH). Done here rather than with
// CSS scroll-snap, which re-snaps to the snapped chip ELEMENT whenever it changes slot and would drag the strip along
// with every reorder. scrollend waits for the finger to lift and the momentum to end; the fallback debounces.
let stripSnapT = 0;
let stripHeld = false;
function scheduleStripSnap(ms) {
  clearTimeout(stripSnapT);
  stripSnapT = setTimeout(snapStrip, ms);
}
function snapStrip() {
  if (!isCompact() || hudAutoScrolling) return;
  if (stripHeld) return scheduleStripSnap(140);
  const el = els.standings;
  const x = el.scrollLeft;
  const max = el.scrollWidth - el.clientWidth;
  if (max <= 0 || x <= 0.5 || x >= max - 0.5) return; // at either end: leave it there
  const lead = state.chipLead;
  const target = x < lead / 2 ? 0 : Math.min(max, lead + Math.max(0, Math.round((x - lead) / CHIP_PITCH)) * CHIP_PITCH);
  if (Math.abs(target - x) < 1) return;
  hudAutoScrolling = true;
  el.scrollTo({ left: target, behavior: scene.reduceMotion ? 'auto' : 'smooth' });
  setTimeout(() => (hudAutoScrolling = false), 320);
}
els.standings.addEventListener('scrollend', () => {
  if (!hudAutoScrolling) scheduleStripSnap(0);
});
els.standings.addEventListener('touchstart', () => (stripHeld = true), { passive: true });
for (const type of ['touchend', 'touchcancel']) els.standings.addEventListener(type, () => (stripHeld = false), { passive: true });

let hudPass = 0; // move-pass sequence: the pass that last touched a row owns its release

/**
 * ONE move pass for a board change. `moves` are the rows whose slot changed ({li, from, to, tf}); everything is written
 * in this call (no reads in between), so a twelve-row resync costs one style recalculation, not twelve.
 *  - animate: climbers get .mv.up (opaque lifted card, z 20+ — the biggest gain rides highest), rows giving way .mv.dn
 *    (opaque, dimmed, z < 10 — the biggest drop sinks lowest), so any two rows that cross occlude cleanly instead of
 *    printing name over name; HUD_MOVE_MS + HUD_SETTLE_MS later the pass releases them together and posts badges.
 *  - !animate (build, jump, reduced motion): rows are committed to their slots with transitions off for that one write.
 *  - badges: accumulate the places gained per row; a there-and-back inside one badge window nets to nothing, and a
 *    net move smaller than minBadge places posts nothing (bulk passes only badge the notable movers).
 */
function movePass(moves, { animate, badges, minBadge = 1 }) {
  const now = performance.now();
  const pass = ++hudPass;
  for (const m of moves) {
    const li = m.li;
    const gained = m.from - m.to; // + climbed, - dropped
    li._pass = pass;
    if (badges && gained) {
      if (now > li._accUntil) li._acc = 0;
      li._acc += gained;
      li._accUntil = now + HUD_MOVE_MS + HUD_SETTLE_MS + HUD_BADGE_MS;
    }
    if (animate) {
      li.classList.add('mv');
      li.classList.toggle('up', gained > 0);
      li.classList.toggle('dn', gained < 0);
      li.style.zIndex = String(gained > 0 ? 20 + Math.min(gained, 19) : gained < 0 ? Math.max(1, 10 + Math.max(gained, -9)) : 10);
    } else {
      releaseRow(li);
      li.style.transition = 'none';
    }
    li.style.transform = li._last.tf = m.tf;
  }
  if (!animate) {
    void els.standings.offsetWidth; // one reflow commits the snap; the stylesheet's transitions are back for the next pass
    for (const m of moves) m.li.style.transition = '';
    if (badges) for (const m of moves) postBadge(m.li, now, minBadge);
    return;
  }
  setTimeout(() => {
    const t1 = performance.now();
    for (const m of moves) {
      if (m.li._pass !== pass) continue; // a newer pass owns this row (it will release it)
      releaseRow(m.li);
      if (badges) postBadge(m.li, t1, minBadge);
    }
  }, HUD_MOVE_MS + HUD_SETTLE_MS);
}

/** Drop a row's motion dressing (plate, lift, dim, z-order); CSS eases the plate and scale out. */
function releaseRow(li) {
  if (li.classList.contains('mv')) li.classList.remove('mv', 'up', 'dn');
  if (li.style.zIndex) li.style.zIndex = '';
}

/**
 * ▲n / ▼n: post the row's accumulated places gained into its gap cell for HUD_BADGE_MS (desktop rows; finished rows
 * keep their time and the 1.01 row keeps its marker — those ARE the story). CSS cross-fades gap ↔ badge.
 */
function postBadge(li, now, minBadge = 1) {
  const d = li._acc;
  // the final stretch recedes the also-rans (setRecede): only the front three post badges then
  if (Math.abs(d) < minBadge || isCompact() || li._last.done || li._last.pick1 || mute.ui || (state.recede && li._rank >= 3)) {
    hideBadge(li);
    return;
  }
  li._accUntil = now + HUD_BADGE_MS; // a move inside the window adds to this badge (net gain) instead of starting over
  const txt = `${d > 0 ? '\u25B2' : '\u25BC'}${Math.abs(d)}`;
  if (li._dl.textContent !== txt) li._dl.textContent = txt;
  li._dl.className = d > 0 ? 'dl up' : 'dl down';
  li._gap.classList.add('delta');
  clearTimeout(li._dlT);
  li._dlT = setTimeout(() => hideBadge(li), HUD_BADGE_MS);
}

/** Take a row's badge down (its gap fades back) and close its accumulation window. */
function hideBadge(li) {
  clearTimeout(li._dlT);
  li._acc = 0;
  li._accUntil = 0;
  if (li._gap.classList.contains('delta')) li._gap.classList.remove('delta');
}

/**
 * Live order tick. `force` sends every row to its true rank at once (build,
 * called lead changes, finishes, jump); otherwise the displayed order converges
 * on the truth by at most two adjacent swaps per pass, and a swap only happens
 * once the pair is clearly apart, has disagreed for a while, or one of them has
 * finished (finishers go straight to their final slot). Set pieces (photo
 * run-in, race for last, a hot dog's aftermath) hold the board still. However
 * many rows change, they move in one pass (movePass). `snap` (jump / build)
 * commits the board without motion or badges: a time cut is not a move;
 * `badges: false` (a finish) glides the rows but posts no ▲▼ — the also-rans
 * catching up with the truth behind a finisher is bookkeeping, not a story.
 */
function updateHud(force = false, { snap = false, badges = true } = {}) {
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
  // the first crowned leader: the top row agrees with the crown the very frame it lands (scene.update ran before this tick)
  if (!state.crownSynced && scene.leaderIdx >= 0 && live) {
    state.crownSynced = true;
    force = true;
  }
  const compact = isCompact();
  const lastFirst = state.rule === 'last-first';

  // set pieces hold the board (called lead changes and finishes still snap it via `force`)
  const locked = (state.photoCalled && state.finished === 0) || state.tailWatch || state.t < state.lastHotdogT + HUD_HOTDOG_LOCK;
  if (state.hudLock && !locked) state.lastResync = 0; // coming out of a lock, one coordinated glide may catch up at once
  state.hudLock = locked;

  let order = state.hudOrder;
  let changed = false;
  let bulk = force; // whole-board placement (force / resync): no pair swaps this tick
  const placement = order.length !== n; // first tick after a build: rows take their slots, nothing "moved"
  if (force || placement) {
    order = truth.map((r) => r.i);
    state.pendingSince.clear();
    state.lastReorder = now;
    changed = true;
  } else if (!locked && t >= 1.5) {
    const pass = now - state.lastReorder >= HUD_PASS_MS; // pair swaps start at most once per pass; the leader row reacts on every tick
    if (pass) state.lastReorder = now;
    const done = [];
    for (const r of truth) {
      if (!r.done) break;
      done.push(r.i); // finished ducks snap straight to their final slots
    }
    let rest = order.filter((i) => !info[i].done);
    // far from the truth? one coordinated glide beats a long chain of pair swaps
    let drift = 0;
    rest.forEach((duck, k) => (drift += Math.abs(info[duck].rank - (done.length + k))));
    let swaps = pass ? 0 : HUD_MAX_SWAPS;
    if (pass && drift >= Math.max(6, rest.length) && now - state.lastResync >= HUD_RESYNC_MS) {
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
    // the leader row is the one everybody reads: promote the true leader directly (not one place per pass), and fast —
    // this runs on every tick with its own short persistence gate, not just inside a pass
    const trueLead = truth[done.length]?.i;
    if (!bulk && trueLead !== undefined && rest[0] !== trueLead) {
      const key = `lead>${trueLead}`;
      let since = state.pendingSince.get(key);
      if (since === undefined) state.pendingSince.set(key, (since = now));
      if (info[trueLead].x - info[rest[0]].x > 3 || now - since >= HUD_LEAD_PERSIST_MS) {
        rest.splice(rest.indexOf(trueLead), 1);
        rest.unshift(trueLead);
        rows[trueLead]._movedAt = now;
        rows[trueLead]._dir = -1;
        state.pendingSince.delete(key);
        if (pass) swaps++;
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
    const quiet = snap || placement; // a build or a time cut places rows; it is not a move (no glide, no badge)
    if (quiet) for (const li of rows) hideBadge(li);
    const moves = [];
    order.forEach((duck, rank) => {
      const li = rows[duck];
      const L = li._last;
      let meta = state.rankMeta.get(duck);
      if (!meta) state.rankMeta.set(duck, (meta = { duck, rank }));
      const from = meta.rank;
      meta.rank = li._rank = rank;
      const tf = compact ? `translateX(${rank === 0 ? 0 : state.chipLead + (rank - 1) * CHIP_PITCH}px)` : `translateY(${rank * state.rowH}px)`;
      if (L.tf !== tf || quiet) moves.push({ li, from: L.tf ? from : rank, to: rank, tf }); // quiet: every row is (re)committed with motion off
      const rank0 = compact && rank === 0;
      if (L.rank0 !== rank0) li.classList.toggle('rank-0', (L.rank0 = rank0));
      const pos = String(rank + 1);
      if (L.pos !== pos) li._pos.textContent = L.pos = pos;
    });
    // bulk passes (resync, called lead change) badge only the notable movers (2+ places): the ±1 churn around them is noise
    if (moves.length) movePass(moves, { animate: !quiet && !scene.reduceMotion, badges: badges && !quiet && t > 0.5, minBadge: bulk ? 2 : 1 });
    if (compact && order[0] !== state.hudLeader && now - standingsTouchedAt > 2500 && els.standings.scrollLeft > 0) {
      hudAutoScrolling = true;
      els.standings.scrollLeft = 0;
      requestAnimationFrame(() => (hudAutoScrolling = false));
    }
    state.hudLeader = order[0];
  }

  // row states every tick (cheap, cached); gap text per row: front three every 250 ms, the rest every 600 ms in half metres
  const writeFast = force || now - state.lastGap >= HUD_GAP_FAST_MS;
  const writeSlow = force || now - state.lastGapSlow >= HUD_GAP_SLOW_MS;
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
  syncPickPin(pickDuck, t > 0);
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
    if ((r.done || pick1) && li._acc) postBadge(li, now); // clears a standing badge: the time / the 1.01 marker takes the cell
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
      if (L.gapCls !== cls) {
        L.gapCls = cls;
        li._gap.className = li._gap.classList.contains('delta') ? `${cls} delta` : cls;
      }
      if (L.gap !== txt) li._gv.textContent = L.gap = txt;
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
const tk = { head: null, sub: null, tip: null, fill: null, lastFillT: -1e9, fillIdx: 0, quietSince: 0, els: null, idle: false, headOffAt: -1e9, subOffAt: -1e9 };
const TICKER_HOLD = { 1: 1300, 2: 2000, 3: 2200 }; // min time on air before an equal/lower priority line may replace it
const TICKER_LINGER = { 1: 2400, 2: 4200, 3: 6000 }; // faded out after this long if nothing replaces it
const TICKER_LEAD_PREEMPT = 800; // a lead change makes any standing story-beat headline old news this fast
const TICKER_WIN_PROTECT = 1800; // nothing replaces the winner's headline sooner than this
const TICKER_STALE = { 2: 2, 3: 3 }; // race seconds after which a queued line is no longer true enough to air
const TICKER_IDLE_MS = 1200; // phones: the empty bar fades away after this long…
const TICKER_IDLE_WIDE_MS = 2500; // …wide layouts a little later (a filler fact usually arrives first mid-race)
const TIP_RACE_S = 1.2; // the one-time "follow your duck" tip owns its slot from the last countdown light until this much racing…
const TIP_MS = 4000; // …then yields to the first line that wants the slot, or leaves after this long at most
const FILL_QUIET_MS = 2500; // wide: a low-key filler fact after this much dead air…
const FILL_EVERY = 8; // …rotating to the next fact every 8 s of racing
const FILL_REFRESH_MS = 500; // a filler's number follows the race clock

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
  els.ticker.innerHTML =
    '<span class="tally" aria-hidden="true"><i class="dot"></i><b>LIVE</b></span><span class="lines"><span class="headline"></span><span class="sub"></span><span class="tip"></span></span>';
  const q = (s) => els.ticker.querySelector(s);
  tk.els = { head: q('.headline'), sub: q('.sub'), tip: q('.tip'), tally: q('.tally b') };
  tk.els.tally.textContent = state.paused ? 'PAUSED' : 'LIVE';
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
  tk.headOffAt = tk.subOffAt = -1e9; // nothing on air: the bar may fade right away
  tk.quietSince = performance.now(); // …but a filler fact waits for a real quiet stretch, not a cut
  const d = ensureTickerDom();
  hideTip(false);
  hideFiller(false);
  tk.lastFillT = -1e9;
  tk.fillIdx = 0;
  for (const el of [d.head, d.sub, d.tip]) {
    el.textContent = '';
    el.classList.remove('in', 'out', 'p3', 'p1', 'fill');
  }
  setTickerIdle(true);
}
function showTickerLine(tier, line, now) {
  const d = ensureTickerDom();
  const el = tier === 'head' ? d.head : d.sub;
  setTickerIdle(false);
  // a real line takes the slot back from the tip (phones: the single tier; wide: the sub line) and from any filler fact
  if (tk.tip && (tier === 'sub' || isCompact())) hideTip();
  if (tk.fill) hideFiller(tier !== 'sub');
  el.textContent = line.text;
  el.classList.remove('in', 'out', 'fill');
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
  else tk.subOffAt = performance.now();
  if (!tk.els) return;
  const el = tier === 'head' ? tk.els.head : tk.els.sub;
  el.classList.remove('in');
  el.classList.add('out');
}

// The once-per-browser "follow your duck" tip: a quiet one-liner INSIDE the bar (never a floating box over the lanes) with
// a slot of its own — the last countdown light through the first TIP_RACE_S of racing, before any launch chatter can air
// (phones: even the GO line waits for it; a set piece would still cut in). It is not commentary: not queued, not in the
// transcript; once its slot closes any real line takes it over (phones: the single tier, wide: the sub line).
function showTip(text) {
  const d = ensureTickerDom();
  const now = performance.now();
  if (isCompact() && tk.head) hideTickerLine('head'); // the single tier is the tip's: the intro line makes way for good
  d.tip.textContent = text;
  d.tip.classList.remove('out');
  void d.tip.offsetWidth;
  d.tip.classList.add('in');
  els.ticker.classList.add('has-tip');
  tk.tip = { shownAt: now, until: now + TIP_MS };
  setTickerIdle(false);
  if (!els.ticker.hidden && els.ticker.offsetHeight !== state.tickerH) updateInsets();
}
function hideTip(animate = true) {
  if (!tk.tip) return;
  tk.tip = null;
  tk.subOffAt = Math.max(tk.subOffAt, performance.now()); // the bar had something on it: idle counts from now
  els.ticker.classList.remove('has-tip');
  if (!tk.els) return;
  tk.els.tip.classList.remove('in');
  if (animate) tk.els.tip.classList.add('out');
  else tk.els.tip.classList.remove('out');
}
/** The tip's slot is open: the last countdown light is on, or the race is younger than TIP_RACE_S. */
function tipSlotOpen() {
  return (state.phase === 'countdown' && state.countdownStep >= 2) || (state.phase === 'race' && state.t < TIP_RACE_S);
}
/** Called on the last countdown light: once per browser, and never for someone who already follows a duck (they found it). */
function maybeShowTip() {
  if (stored.tip || mute.ui || els.ticker.hidden) return;
  stored.tip = true;
  saveStore();
  if (state.focus >= 0) return;
  showTip(coarseMQ.matches ? 'Tip: tap your name to follow your duck' : 'Tip: click your name (or a duck) to follow it');
}

// Wide layouts: instead of an empty bar through a quiet stretch, one low-key fact that follows the race clock
// (pure functions of the sim + race time, so every replay shows the same number at the same moment). Never logged.
function fillerText(k) {
  const sim = state.sim;
  const t = state.t;
  let leadX = 0;
  for (let i = 0; i < sim.count; i++) leadX = Math.max(leadX, scene.duckX(i, t));
  leadX = Math.min(leadX, TRACK_LENGTH);
  switch (k % 3) {
    case 0:
      return `${metres(TRACK_LENGTH - leadX)}m to go`;
    case 1: {
      let n = 0;
      for (const ev of sim.events) {
        if (ev.t > t) break;
        if (ev.type === 'lead') n++;
      }
      return n ? `${n} lead change${n === 1 ? '' : 's'} so far` : 'No lead changes yet';
    }
    default:
      return `Leader's pace ${(leadX / 10 / Math.max(1, t)).toFixed(1)} m/s`;
  }
}
function fillerAllowed() {
  return !isCompact() && state.phase === 'race' && state.sim && state.t >= 6 && !state.climax && state.winnerAt === null && !state.paused && !mute.ui;
}
function showFiller(now) {
  const d = ensureTickerDom();
  const k = tk.fillIdx++;
  d.sub.textContent = fillerText(k);
  d.sub.classList.remove('in', 'out');
  d.sub.classList.add('fill');
  void d.sub.offsetWidth;
  d.sub.classList.add('in');
  tk.fill = { k, shownAt: now, t: state.t, refreshAt: now + FILL_REFRESH_MS };
  tk.lastFillT = state.t;
  setTickerIdle(false);
}
/** Take the filler off: silently when a real sub line is about to reuse the element, with a fade otherwise. */
function hideFiller(animate = true) {
  if (!tk.fill) return;
  tk.fill = null;
  tk.subOffAt = Math.max(tk.subOffAt, performance.now());
  if (!tk.els) return;
  const el = tk.els.sub;
  if (animate) {
    el.classList.remove('in');
    el.classList.add('out');
  } else el.classList.remove('in', 'out', 'fill');
}
function pumpFiller(now) {
  if (tk.fill) {
    if (!fillerAllowed()) {
      hideFiller();
      return;
    }
    if (state.t - tk.fill.t >= FILL_EVERY || state.t < tk.fill.t) showFiller(now); // rotate (or a rewind): next fact
    else if (now >= tk.fill.refreshAt) {
      tk.fill.refreshAt = now + FILL_REFRESH_MS;
      const txt = fillerText(tk.fill.k);
      if (tk.els.sub.textContent !== txt) tk.els.sub.textContent = txt;
    }
    return;
  }
  if (!fillerAllowed() || tk.head || tk.sub || tk.tip || tickerQueue.length) return;
  if (now - Math.max(tk.headOffAt, tk.subOffAt, tk.quietSince) < FILL_QUIET_MS) return;
  if (state.t - tk.lastFillT < FILL_EVERY && state.t >= tk.lastFillT) return;
  showFiller(now);
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
  // the one-time tip owns its slot (phones: the single tier, wide: the sub line) while it is open; only a set piece cuts in
  const tipLock = !!tk.tip && tipSlotOpen();
  if (hi < 0) hi = hLead >= 0 ? hLead : h2 >= 0 ? h2 : single && !tipLock ? h1 : -1;
  const H = tk.head;
  if (hi >= 0) {
    const line = tickerQueue[hi];
    const up = H ? now - H.shownAt : Infinity;
    let can;
    if (single && tipLock && line.pri < 3) can = false; // phones: the GO line waits the second out for the tip
    else if (H && H.kind === 'win' && up < TICKER_WIN_PROTECT) can = false; // the winner's line is never trampled
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
  if (tk.tip && !tipLock && now >= tk.tip.until) hideTip();
  // sub tier: chatter, in order (wide layouts only)
  const S = tk.sub;
  if (single) {
    if (S) hideTickerLine('sub');
    if (tk.fill) hideFiller();
    setTickerIdle(!tk.head && !tk.tip && now - Math.max(tk.headOffAt, tk.subOffAt) >= TICKER_IDLE_MS);
    return;
  }
  const si = tickerQueue.findIndex((l) => l.pri <= 1);
  if (si >= 0) {
    if (!tipLock && (!S || now - S.shownAt >= TICKER_HOLD[1])) showTickerLine('sub', tickerQueue.splice(si, 1)[0], now); // (a line here retires the tip)
  } else if (S && now - S.shownAt > TICKER_LINGER[1]) hideTickerLine('sub');
  pumpFiller(now);
  setTickerIdle(!tk.head && !tk.sub && !tk.tip && !tk.fill && now - Math.max(tk.headOffAt, tk.subOffAt) >= TICKER_IDLE_WIDE_MS);
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
const RIBBON_COMPACT_MAX = 1500; // phones: a ribbon covers the live strip, so it never outstays this
const cal = { wide: null, queued: [], winAt: -1e9 };

/** Phones: while a ribbon sits on the HUD strip its chips, clock and pause step out (CSS body.ribbon-live); Skip stays. */
let ribbonLiveTimer = 0;
function setRibbonLive(on, ms) {
  clearTimeout(ribbonLiveTimer);
  document.body.classList.toggle('ribbon-live', !!on);
  if (on && Number.isFinite(ms)) ribbonLiveTimer = setTimeout(() => document.body.classList.remove('ribbon-live'), Math.max(0, ms));
}

/** Take the current ribbon off air: with a short exit when something replaces it live, instantly otherwise. */
function retireRibbon(cur, animate) {
  clearTimeout(cur.timer);
  clearTimeout(cur.handoff);
  setRibbonLive(false);
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
  const pauseCard = kinds.includes('pause');
  const overStrip = wide && !pauseCard && isCompact(); // phones: the ribbon takes the live strip's slot
  let ttl = opts.ttl ?? (wide ? 1400 : 850);
  if (overStrip) ttl = Math.min(ttl, RIBBON_COMPACT_MAX);
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
  if (kinds.includes('win')) cal.winAt = entry.shownAt;
  if (overStrip) setRibbonLive(true, lag + ttl - RIBBON_OUT_MS); // the strip is back for the ribbon's exit
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
  cal.winAt = -1e9;
  setRibbonLive(false);
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
  // optional thin progress bar under the text (clip recording)
  const prog = Number.isFinite(opts.progress);
  box.classList.toggle('progress', prog);
  if (prog) box.style.setProperty('--p', `${clamp(opts.progress, 0, 100)}%`);
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
/** Screen change (results / back to setup): a plain toast about the old screen goes; one carrying an Undo stays. */
toast.clear = () => {
  const box = els.toast;
  if (box.classList.contains('actionable')) return;
  clearTimeout(toast.timer);
  box.classList.remove('show');
};

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
        case 'replay':
          tickReplay(dt);
          break;
        default:
          break;
      }
    }
    if (scene.pendingHoldMs) {
      hold(scene.pendingHoldMs);
      scene.pendingHoldMs = 0;
    }
    // while paused the scene still ticks (water, bobbing) but the race clock holds; during the instant replay the scene
    // renders the replay clock as a live 'finish' frame (state.t itself is untouched: the board and results keep their time)
    const rp = state.replay;
    const tScene = rp ? rp.t : state.t;
    const phScene = rp ? 'finish' : state.phase;
    scene.update(dt, tScene, phScene, state.phaseTime);
    // idle screens (setup / results): draw every other frame (~30 fps); the sim side still ticks every frame
    const idle = state.phase === 'setup' || state.phase === 'results';
    perf.skip = idle ? !perf.skip : false;
    if (!perf.skip) scene.render(tScene, phScene);
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

/**
 * Park the countdown digit over open water: 58% of the way from the start line to the track's right edge (right of the
 * start-list pills, left of the live-order panel), clamped so the glyph never leaves the track; centred when the start
 * line is off screen. Reads the digit's own font size, so it runs right after callout() has put the element up; on a
 * wide layout whose track is narrow (portrait tablet, small laptop window) the digit shrinks — down to the CSS floor —
 * so its disc starts right of the pill column instead of sitting on the names people are looking for.
 */
function placeCountdownDigit() {
  const el = els.callout.querySelector('.big');
  let x = '50%';
  const sx0 = scene.sx(0);
  const compact = isCompact();
  const trackRight = window.innerWidth - (compact ? 0 : scene.insets.right || 0);
  if (el && sx0 > 0 && sx0 < trackRight - 100) {
    const k = compact ? 0.68 : 0.85; // the ring's radius per font px (CSS: 1.36em / 1.7em across)
    let fs = parseFloat(getComputedStyle(el).fontSize) || 120;
    let pillRight = sx0; // right edge of the start-list pill column, as drawn last frame
    for (const q of scene._pillRects || []) if (q.kind === 'side' && q.a > 0.3) pillRight = Math.max(pillRight, q.x + q.w);
    if (!compact) {
      const room = trackRight - 4 - (pillRight + 6);
      if (2 * k * fs > room) {
        fs = Math.max(84, room / (2 * k));
        el.style.fontSize = `${Math.round(fs)}px`;
      }
    }
    const half = Math.max(k * fs, el.offsetWidth / 2); // the ring, or the word when it is wider ("GO!" on a phone must not run off the track)
    x = `${Math.round(clamp(Math.max(sx0 + 0.58 * (trackRight - sx0), pillRight + 6 + half), half + 4, trackRight - half - 4))}px`;
  }
  els.callout.style.setProperty('--count-x', x);
}

function stepCountdown() {
  const step = Math.floor(state.phaseTime / COUNT_STEP);
  if (step === state.countdownStep || step > 3) return;
  state.countdownStep = step;
  if (step < 3) {
    const digit = String(3 - step);
    callout(digit, `big d${digit}`, { ttl: 920 });
    placeCountdownDigit();
    scene.punch?.(0.02); // a beat you can feel (no-op under reduced motion)
    announce(digit, { now: true });
    audio.beep(false);
    scene.startLights = step + 1;
    if (step === 2) maybeShowTip(); // the last light: the bar is quiet from here to the first launch chatter (TIP_RACE_S in)
    return;
  }
  callout('GO!', 'big go', { ttl: 1000 });
  placeCountdownDigit();
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
          if (!scene.reduceMotion) scene.zoomTo(Math.min(1.12, scene.zoomCap()), scene.sx(TRACK_LENGTH) - 60 * scene.ui, scene._zoomFloorY(), 2200);
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
      const culprit = state.culprits.get(idx);
      scene.telegraphHotdog?.(ev.duck, state.t, ev.t, culprit !== undefined ? state.looks[culprit] : null); // the thrower wears the culprit's colours
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
  if (state.phase === 'finish') {
    // the instant replay of the touch bridges the finish hold and the board (skipped under reduced motion / Calm or &replay=0)
    const replayable = !scene.reduceMotion && REPLAY_PARAM !== '0';
    if (state.phaseTime > (replayable ? FINISH_HOLD_REPLAY : FINISH_HOLD) && !(replayable && startInstantReplay('show'))) showResults();
  }
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
// The run-in programme is decided once, when the leader is RUNIN_AT units (4.5 m) out, by awards.js's classifyRunIn — in
// TIME, not distance: 'photo' (heavy slow-mo, PHOTO FINISH) only for a finish that will really be tight, 'contested'
// (mild slow-mo, "to the wall — A from B!") for a fight, 'clear' (a push-in, "nobody is catching X") for daylight.

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

  // --- the run-in: classified once, 45 units out, by time (live gap in seconds + how tight the touch will really be) ---
  if (!state.runIn && done === 0 && live.length >= 2 && remaining < RUNIN_AT) state.runIn = classifyRunIn(sim, tq);
  if (!state.photoCalled && done === 0 && state.runIn === 'photo') {
    state.photoCalled = true;
    callout('PHOTO FINISH!', 'wide photo');
    say('It is desperately close — PHOTO FINISH!', 3, { duck: leader.i, t: tq, kind: 'photo' });
    announce('Photo finish!');
    au.riser(3.2);
  }
  if (!state.lineCalled && !state.photoCalled && !lastFirst && done === 0 && live.length >= 2 && remaining < 40 && state.runIn === 'contested') {
    state.lineCalled = true; // CONTESTED: still together at the wall (also a live picture that looks like a photo but won't be one)
    say(commentator.atTheLine(nm(live[0]), nm(live[1]), gap), 3, { duck: live[1].i, t: tq, kind: 'photo' });
    au.riser(2.4);
  }
  const closerFresh = state.closerT >= 0 && tq - state.closerT < 2.5; // "here comes X!" was only just said: don't contradict it yet
  if (!state.clearCalled && !closerFresh && done === 0 && live.length >= 2 && remaining < 90 && nobodyCatching(sim, tq)) {
    state.clearCalled = true; // CLEAR: call it early (daylight now AND at the line) and let the winner enjoy the run-in
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
      // phones: straight after the winner's ribbon a second one would keep the live strip covered — the line alone carries it
      const crowdsStrip = isCompact() && performance.now() - cal.winAt < 1200;
      if (!crowdsStrip) callout(lastFirst ? 'PHOTO FOR FIRST PICK!' : 'PHOTO FOR LAST!', lastFirst ? 'wide gold photo' : 'wide photo', { maxWait: 2500, polite: true, rank: lastFirst ? 4 : 3 });
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
      if (chatterRelevant(ev.duck, standings)) chatter(commentator.forEvent(ev, standings), 1, meta);
      break;
    case 'stumble':
      au.splash(0.12);
      if (chatterRelevant(ev.duck, standings)) chatter(commentator.forEvent(ev, standings), 1, meta);
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
      // whose section threw it? (a seeded pick among the other managers — the target is always whoever leads)
      const culprit = state.culprits.get(state.sim.events.indexOf(ev));
      const culpritName = culprit !== undefined ? state.raceNames[culprit] : '';
      if (culprit !== undefined) state.hitBy.set(ev.duck, culprit);
      say(commentator.hotdog(ev.duck, culpritName), 3, { ...meta, kind: 'hotdog' });
      const rankBefore = Math.max(0, standings.findIndex((r) => r.i === ev.duck));
      if (culpritName) announce(`Hot dog from the ${culpritName} section hits ${name}${rankBefore === 0 ? ', the leader' : ''}`);
      else announce(rankBefore === 0 ? `Hot dog hits ${name}, the leader` : `Hot dog hits ${name}`);
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
      if (!mute.sfx && !state.climax && ev.t - state.motifT >= 4) {
        // the new leader's own jingle, just after the whoosh (not during the run-in: that belongs to the tension bed)
        state.motifT = ev.t;
        const gen = raceGen;
        setTimeout(() => {
          if (gen === raceGen && !state.paused) audio.motif(look.motif);
        }, 120);
      }
      flashRow(ev.duck, 'newlead', 900);
      const lm = { ...meta, kind: 'lead' };
      commentator.noteLead(ev.duck, ev.t);
      const pri = state.climax && state.finished === 0 ? 3 : 2; // a lead change inside the set piece IS the set piece
      const fu = ev.from >= 0 ? state.followUps.findIndex((f) => f.duck === ev.from) : -1;
      if (state.victims.has(ev.duck) && !state.avenged.has(ev.duck)) {
        state.avenged.add(ev.duck);
        callout('REVENGE!', 'wide gold revenge');
        hushChatter(ev.t);
        const by = state.hitBy.get(ev.duck);
        say(commentator.revenge(name, by !== undefined ? state.raceNames[by] : ''), 3, lm);
        au.cheer(0.4, 2);
      } else if (fu >= 0) {
        // the victim just lost the lead to this duck: one headline instead of a lead line plus an aftermath line
        state.followUps.splice(fu, 1);
        say(commentator.leadFromVictim(name, state.raceNames[ev.from]), pri, lm);
      } else {
        say(commentator.forEvent(ev, standings), pri, lm);
      }
      if (state.t > 1) announce(`${name} takes the lead`);
      updateHud(true); // a called lead change is definitive: snap the board to it
      break;
    }
    case 'halfway': {
      say(commentator.forEvent(ev, standings), 2, { duck: standings[0]?.i ?? ev.duck, t: ev.t, kind: 'halfway' });
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
      say(commentator.forEvent(ev, standings), 3, { duck: standings[0]?.i ?? ev.duck, t: ev.t, kind: 'stretch' });
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
      const lineOpts = { photo, margin: state.sim.margin, victim: state.victims.has(ev.duck), rule: state.rule, n, photoCalled: state.photoCalled };
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
      updateHud(true, { badges: false }); // the finisher takes its final slot now; the pack's catch-up behind it posts no badges
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Instant replay: the deciding touch again at 0.35x from the line camera, TV furniture drawn in-canvas by the scene
// (letterbox, REPLAY bug, winner card, a wipe off the frame we left). Playback only — the director re-drives a private
// replay clock (state.replay.t) across [t0, t1] and hands the scene the sim events inside the window; state.t, the
// board, the ticker and the sound one-shots stay out of it. Three ways in: the finish hold hands over to it before the
// board ('show'), the board's "Replay finish" plays it again ('results'), and "Save clip" plays it with a recorder on
// the canvas plus CLIP_CODA seconds of real-time celebration. Click / Space / Enter / Esc / Skip end it early.
// ---------------------------------------------------------------------------

/**
 * What the replay shows — a pure function of the sim + rule, so a shared link and its clip agree: the winner's touch,
 * or under last-place-picks-first a battle for last closer than REPLAY_CLOSE_LAST (that touch decided the 1.01; a lone
 * straggler paddling home is not worth four seconds, and two replays back to back would keep the board waiting).
 * null = nothing to replay (no race, reduced motion / Calm).
 */
function replayPlan() {
  const sim = state.sim;
  if (!sim || !scene.sim || scene.reduceMotion) return null;
  const n = sim.count;
  const order = sim.order;
  const fts = sim.finishTimes;
  const lastFirst = state.rule === 'last-first';
  let kind = 'win';
  let duck = order[0];
  if (lastFirst && n >= 3 && fts[order[n - 1]] - fts[order[n - 2]] < REPLAY_CLOSE_LAST) {
    kind = 'tail';
    duck = order[n - 1];
  }
  const tMark = fts[duck];
  const t0 = Math.max(0, tMark - REPLAY_PRE);
  const t1 = tMark + REPLAY_POST;
  let ducks;
  if (kind === 'tail') ducks = [order[n - 2], order[n - 1]];
  else {
    ducks = [duck];
    for (let k = 1; k < n && ducks.length < 4; k++) if (fts[order[k]] - tMark <= 0.9) ducks.push(order[k]); // the chasers in the same shot
    if (ducks.length === 1 && n >= 2) ducks.push(order[1]); // a clear win: frame the daylight
  }
  const look = state.looks[duck];
  let card;
  if (kind === 'tail') {
    const gap = fts[order[n - 1]] - fts[order[n - 2]];
    card = { kicker: 'LAST', name: look.name, meta: `${tMark.toFixed(2)}s · last by ${gap.toFixed(2)}s · takes the 1.01`, look, gold: true };
  } else {
    const how = n < 2 ? '' : sim.photoFinish ? ' · photo finish' : ` · by ${sim.margin.toFixed(2)}s`;
    card = { kicker: '1ST', name: look.name, meta: `${tMark.toFixed(2)}s${how}${lastFirst ? ' · picks last' : ''}`, look, gold: !lastFirst };
  }
  const sub = kind === 'tail' ? 'RACE FOR THE 1.01' : sim.photoFinish ? 'PHOTO FINISH' : 'THE FINISH';
  return { kind, duck, tMark, t0, t1, ducks, sub, card };
}

/**
 * Start the replay. `back`: 'show' = the finish hold is handing over (the board is built when it ends);
 * 'results' = from the board (kept in the DOM, hidden by CSS, shown again as it was). `job`: a clip recording
 * ({rec, cancelled}) — no wipe (the clip opens clean on a white blink) and a real-time coda after the slow motion.
 * @returns {boolean} false when there is nothing to replay
 */
function startInstantReplay(back = 'show', { job = null } = {}) {
  const plan = replayPlan();
  if (!plan) return false;
  if (state.paused) setPaused(false);
  teardownReplay();
  clearCallouts();
  clearTicker();
  hideTitleCard(0);
  if (!job) toast.clear();
  const sim = state.sim;
  let evIdx = 0;
  while (evIdx < sim.events.length && sim.events[evIdx].t < plan.t0) evIdx++;
  const dur = (plan.t1 - plan.t0) / REPLAY_RATE; // wall seconds of slow motion
  state.replay = { ...plan, back, job, t: plan.t0, wall: 0, dur, total: dur + (job ? CLIP_CODA : REPLAY_FREEZE), evIdx, marked: false, pct: -1, coda: false };
  if (back === 'results' && state.podiumRaf) {
    cancelAnimationFrame(state.podiumRaf); // the champion can stop hopping while nobody sees the podium
    state.podiumRaf = 0;
  }
  els.replaySkip.querySelector('.lbl').textContent = job ? 'Cancel' : 'Skip';
  els.replaySkip.setAttribute('aria-label', job ? 'Cancel the clip' : 'Skip the replay');
  setPhase('replay'); // hides the board / HUD / ticker, reserves the letterbox (updateInsets), shows the Skip pill
  scene.beginReplay({ t0: plan.t0, t1: plan.t1, kind: plan.kind, ducks: plan.ducks, label: 'REPLAY', sub: plan.sub, wipe: !job });
  if (job) scene.flash = 0.8; // the clip opens on a white blink instead of a wipe off the board's backdrop
  audio.replaySwoosh(false);
  audio.setSlowmo(0.85); // the world goes under water for the slow motion (whoomp + muffled beds)
  state.slowmoSent = 0.85;
  announce(plan.kind === 'tail' ? `Replay: the race for the first pick` : `Replay: ${plan.card.name} at the line`, { now: true });
  return true;
}

/** Per frame in phase 'replay': advance the replay clock, hand the scene the events inside the window, card on the touch. */
function tickReplay(dt) {
  const r = state.replay;
  if (!r) {
    showResults();
    return;
  }
  r.wall += dt;
  const sim = state.sim;
  if (r.wall <= r.dur) r.t = Math.min(r.t1, r.t0 + r.wall * REPLAY_RATE);
  else if (r.job) {
    // clip coda: ease back to real time and let the celebration play (confetti lands, the champion hops)
    const k = clamp((r.wall - r.dur) / 0.6, 0, 1);
    r.t += dt * lerp(REPLAY_RATE, 1, k * k * (3 - 2 * k));
  } // else: frozen on the last frame for REPLAY_FREEZE, then the flash out
  const evs = sim.events;
  while (r.evIdx < evs.length && evs[r.evIdx].t <= r.t) scene.onEvent(evs[r.evIdx++], r.t); // scene side only: no sound, no lines, no board
  if (!r.marked && r.t >= r.tMark) {
    r.marked = true;
    scene.setReplayCard(r.card);
    scene.cheer = 1;
    sfx().cheer(0.32, 1.8); // one muffled roar under the slow-mo bed; every other one-shot stays silent
  }
  scene.slowmo = lerp(scene.slowmo, r.wall <= r.dur ? 0.85 : 0, 1 - Math.exp(-dt * 5));
  if (r.job) {
    const pct = Math.round(100 * clamp(r.wall / r.total, 0, 1));
    if (pct >= r.pct + 3 || (pct === 100 && r.pct !== 100)) {
      r.pct = pct;
      toast(`Recording clip… ${pct}%`, { ms: 1500, progress: pct });
    }
    if (r.wall > r.dur && !r.coda) {
      r.coda = true; // the slow motion is over: surface the sound, widen the shot so the champion's coast and the confetti stay in frame
      audio.setSlowmo(0);
      state.slowmoSent = 0;
      scene.relaxReplayCamera();
    }
  }
  if (r.wall >= r.total) finishInstantReplay(false);
}

/** End of the replay (played out or skipped): flash out, then the board — built fresh after the race, shown again as it was otherwise. */
function finishInstantReplay(skipped = false) {
  const r = state.replay;
  if (!r) return;
  const back = r.back;
  if (r.job && skipped) r.job.cancelled = true;
  teardownReplay();
  audio.replaySwoosh(true);
  if (back === 'show') showResults();
  else {
    setPhase('results'); // the panel glides back in (its entry animation re-runs); rows and plinths stay as they were
    if (!state.podiumRaf) startPodiumLoop();
    layoutBoard(); // (a resize during the replay skipped the hidden board)
    arrangeActions();
    if (!coarseMQ.matches) (r.job ? els.clip : els.instant).focus({ preventScroll: true });
  }
  if (!scene.reduceMotion) scene.flash = skipped ? 0.5 : 0.9; // (after showResults: its resetPresentation zeroes the channel)
}

/** Drop replay state without navigating (a new race, back to setup, the jump() hook, the end of a replay). Stops a recorder. */
function teardownReplay() {
  const r = state.replay;
  if (!r) return;
  state.replay = null;
  const rec = r.job && r.job.rec;
  if (rec && rec.state !== 'inactive') {
    try {
      rec.stop(); // saveClip() resumes from the recorder's stop event (and reads job.cancelled)
    } catch {
      /* already stopped */
    }
  }
  scene.endReplay();
  scene.slowmo = 0;
  audio.setSlowmo(0);
  state.slowmoSent = 0;
}

function skipReplay() {
  if (state.phase === 'replay') finishInstantReplay(true);
}
els.replaySkip.addEventListener('click', skipReplay);
els.scene.addEventListener('click', () => {
  if (state.phase === 'replay') skipReplay(); // click / tap anywhere on the picture
});

/**
 * "Save clip": the replay + CLIP_CODA seconds of celebration recorded off the main canvas at CLIP_FPS (the card, bug and
 * letterbox are drawn in-canvas, so the clip is self-contained), then handed to the share sheet (touch devices that
 * take files) or downloaded as duck-derby-<code>.webm|mp4. The board's state is untouched throughout.
 */
async function saveClip() {
  if (state.phase !== 'results' || state.replay || !CLIP_MIME || !state.sim) return;
  if (ceremonyRunning()) finishCeremony(true);
  const type = CLIP_MIME.split(';')[0];
  const ext = type === 'video/mp4' ? 'mp4' : 'webm';
  const filename = `duck-derby-${seedToCode(state.seed)}.${ext}`;
  let rec;
  let stream = null;
  const chunks = [];
  try {
    // a 2x backing store is four times the encoder's work for a clip people watch on a phone: record CSS pixels
    scene.forceDpr = window.innerWidth * window.innerHeight > 1.3e6 ? 1 : 1.5;
    scene.resize();
    stream = els.scene.captureStream(CLIP_FPS);
    rec = new MediaRecorder(stream, { mimeType: CLIP_MIME, videoBitsPerSecond: 6_000_000 });
  } catch {
    if (stream) for (const tr of stream.getTracks()) tr.stop();
    scene.forceDpr = 0;
    scene.resize();
    els.clip.hidden = true; // the feature test passed but the recorder refused: don't offer it again this session
    toast('This browser could not record the clip — Save image still works');
    return;
  }
  const job = { rec, cancelled: false };
  const stopped = new Promise((resolve) => {
    rec.onstop = resolve;
    rec.onerror = () => {
      job.cancelled = true;
      job.failed = true;
      resolve();
    };
  });
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  try {
    rec.start(250);
  } catch {
    job.cancelled = job.failed = true;
  }
  if (job.failed || !startInstantReplay('results', { job })) {
    if (rec.state !== 'inactive') rec.stop();
    for (const tr of stream.getTracks()) tr.stop();
    scene.forceDpr = 0;
    scene.resize();
    toast(job.failed ? 'This browser could not record the clip — Save image still works' : 'Nothing to replay yet');
    return;
  }
  await stopped; // the replay runs; teardownReplay() stops the recorder when it ends (or is cancelled)
  for (const tr of stream.getTracks()) tr.stop();
  scene.forceDpr = 0;
  scene.resize(); // back to the device's pixel ratio (behind the board: nobody sees the reallocation)
  if (job.cancelled || !chunks.length) {
    toast(job.failed ? 'Recording failed — Save image still works' : 'Clip cancelled', { ms: 2200 });
    return;
  }
  const blob = new Blob(chunks, { type });
  if (coarseMQ.matches && typeof navigator.share === 'function' && typeof File === 'function') {
    try {
      const file = new File([blob], filename, { type });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: `${state.league || 'Duck Derby'} — the finish` });
        state.resultExported = true;
        toast('Clip shared');
        return;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      /* refused: fall back to a download */
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
  }, 4000);
  state.resultExported = true;
  toast(`Clip saved · ${filename}`, { ms: 2600 });
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
function draftOrder() {
  const order = state.sim.order.slice();
  return state.rule === 'last-first' ? order.reverse() : order; // winner-choice picks slots in finish order
}

/** The result's facts as parts: [ducks, margin, lead changes] + the code (which must never wrap at its hyphen) + provenance. */
function resultFactParts() {
  const sim = state.sim;
  const n = sim.count;
  const close = sim.photoFinish ? 'photo finish' : `won by ${sim.margin.toFixed(2)}s`;
  return {
    facts: `${n} ducks · ${close} · ${sim.leadChanges} lead change${sim.leadChanges === 1 ? '' : 's'}`,
    code: `code ${seedToCode(state.seed)}`,
    source: SOURCE_LABEL[state.seedSource],
  };
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
  toast.clear();
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
  const winnerT = sim.finishTimes[order[0]];
  const league = state.league;
  els.results.classList.toggle('rule-last', lastFirst);
  els.results.classList.toggle('from-share', state.sharedRun);
  els.results.classList.toggle('results--short', picks.length <= 5); // a small field gets a content-height panel, not a slab of empty glass
  els.replay.textContent = state.sharedRun ? 'Watch again' : 'Watch full race';
  // the instant replay and its clip are motion by definition: neither is offered under reduced motion / Calm
  els.instant.hidden = scene.reduceMotion;
  els.clip.hidden = scene.reduceMotion || !CLIP_MIME;
  els.rulePill.textContent = R.pill;
  arrangeActions();

  // header: league name (with an overline) or the rule-aware title
  els.resultsOverline.hidden = !league;
  els.resultsOverline.textContent = R.h2;
  els.resultsTitle.textContent = league || R.h2;
  // the race story (awards.js: pure of the sim, so every replay of the link tells it the same way)
  const AW = (state.awards = raceAwards(sim, state.raceNames, rule));
  els.resultsSub.replaceChildren();
  const story = document.createElement('span');
  story.className = 'story';
  story.textContent = AW.headline;
  const b = document.createElement('b');
  b.textContent = R.sentence;
  const fp = resultFactParts();
  const codeEl = document.createElement('span');
  codeEl.className = 'nowrap'; // "3GQ-M2XD" never breaks at its hyphen
  codeEl.textContent = fp.code;
  els.resultsSub.append(story, ' ', b, ` · ${fp.facts} · `, codeEl, ` (${fp.source})`);
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
    requestAnimationFrame(() => renderPortrait(cv, look, { standing: true, t: 2.2, crown: true, mood: 'joy' }));
  }

  // podium: 2nd, 1st, 3rd (two ducks: 2nd, 1st — centred, no phantom third slot); the medals hang on the ducks themselves
  els.podium.innerHTML = '';
  els.podium.style.gridTemplateColumns = order.length >= 3 ? '' : `repeat(${order.length}, minmax(0, 230px))`;
  const podiumIdx = [order[1], order[0], order[2]].filter((v) => v !== undefined);
  const places = order.length >= 3 ? [2, 1, 3] : order.length === 2 ? [2, 1] : [1];
  podiumIdx.forEach((duck, k) => {
    const place = places[k];
    const look = state.looks[duck];
    const card = document.createElement('div');
    card.className = `step-card place-${place}`;
    card.innerHTML = `<canvas aria-hidden="true"></canvas><div class="plinth"><div class="pl-place">${ordinal(place)}</div><div class="pl-plaque"><span class="pl-name"></span><span class="pl-time">${sim.finishTimes[duck].toFixed(2)}s</span></div></div>`;
    card.querySelector('.pl-name').textContent = look.name;
    els.podium.appendChild(card);
    const cv = card.querySelector('canvas');
    cv._look = look;
    cv._place = place;
    cv._medal = PODIUM_MEDAL[place];
    requestAnimationFrame(() => renderPortrait(cv, look, { standing: true, t: 1 + k, crown: place === 1, mood: place === 1 ? 'joy' : '', medal: cv._medal }));
  });

  // draft board (layoutBoard adds the second column + header on wide screens with 7+ picks, and again on resize)
  els.board.innerHTML = '';
  els.board.appendChild(boardHeadRow(R));
  const staged = !scene.reduceMotion; // the ceremony will reveal the board: rows arrive sealed
  picks.forEach((duck, k) => {
    const look = state.looks[duck];
    const place = order.indexOf(duck) + 1;
    const ft = sim.finishTimes[duck];
    const li = document.createElement('li');
    li._duck = duck;
    if (k === 0) li.className = 'first-pick';
    if (staged) {
      li.classList.add('sealed');
      li.style.animationDelay = `${k * 45}ms`;
    }
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
    // awards: up to two deterministic superlatives beside the name (a narrow slot shows one, in its short form — CSS)
    const awards = AW.byDuck.get(duck) || [];
    if (awards.length) {
      const box = document.createElement('span');
      box.className = 'awards';
      for (const a of awards) {
        const t = document.createElement('span');
        t.className = 'tag award';
        t.title = a.detail;
        t.innerHTML = '<span class="aw-full"></span><span class="aw-short"></span>';
        t.firstChild.textContent = `${a.icon} ${a.label}`;
        t.lastChild.textContent = `${a.icon} ${a.short}`;
        box.appendChild(t);
      }
      li.querySelector('.who').appendChild(box);
    }
    els.board.appendChild(li);
    renderPortrait(li.querySelector('canvas'), look, { w: 46, h: 40, t: k * 0.3 });
  });
  layoutBoard();
  els.resultsScroll.scrollTop = 0;
  requestAnimationFrame(syncResultsOverflow);
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

/**
 * Board columns follow the viewport: two columns (each with its own header row) for 7+ picks on screens >= 1000 px,
 * one otherwise. Runs on show and again whenever the layout changes; the pick rows keep whatever state they are in.
 */
function layoutBoard() {
  if (state.phase !== 'results' || !state.sim) return;
  const rows = [...els.board.children].filter((li) => !li.classList.contains('board-head'));
  const n = rows.length;
  const wide = n >= 7 && window.innerWidth >= 1000;
  els.results.classList.toggle('results--wide', wide);
  els.results.classList.toggle('results--dense', wide && (n >= 13 || window.innerHeight <= 740)); // a smaller podium gives the rows the height
  const heads = els.board.querySelectorAll('.board-head');
  const half = Math.ceil(n / 2);
  els.board.style.gridTemplateRows = wide ? `repeat(${half + 1}, auto)` : '';
  if (wide && heads.length < 2 && rows[half]) els.board.insertBefore(boardHeadRow(RULES[normRule(state.rule)]), rows[half]);
  else if (!wide && heads.length >= 2) for (let k = 1; k < heads.length; k++) heads[k].remove();
  // phones: a row is the name plus at most one more line — a name that already wraps keeps its award in the exports only
  for (const li of rows) li.classList.remove('no-awards');
  if (isCompact()) for (const li of rows) if (li.querySelector('.awards') && li.querySelector('.who').getBoundingClientRect().height > 44) li.classList.add('no-awards');
  // last place picks first: the (bragging-rights) podium is a small shelf beside the hero card on wide screens, else demoted below the board
  const shelf = els.podiumShelf;
  const anchor = state.rule === 'last-first' && !wide ? els.board : els.hero;
  if (shelf.previousElementSibling !== anchor) anchor.after(shelf);
  syncResultsOverflow();
}

/** Scroll cue: while more of the board sits below the fold, the panel's bottom edge fades (CSS [data-overflow="more"]). */
function syncResultsOverflow() {
  const sc = els.resultsScroll;
  const more = state.phase === 'results' && sc.scrollHeight - sc.scrollTop - sc.clientHeight > 12;
  if ((sc.dataset.overflow === 'more') !== more) {
    if (more) sc.dataset.overflow = 'more';
    else delete sc.dataset.overflow;
  }
}
els.resultsScroll.addEventListener('scroll', syncResultsOverflow, { passive: true });
const PODIUM_MEDAL = { 1: 'gold', 2: 'silver', 3: 'bronze' };

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
  // the board: rows nobody can see right now (below the fold on a phone) open silently; the visible ones flip open
  // bottom-up, last pick first, with a breath before the top three — #1 lands last with the cymbal
  const step = rows.length > 12 ? 110 : 150;
  const top = rows[0];
  later(2950, () => {
    const box = els.resultsScroll.getBoundingClientRect();
    const visible = [];
    for (const li of rows.slice().reverse()) {
      const r = li.getBoundingClientRect();
      if (r.bottom <= box.top + 4 || r.top >= box.bottom - 4) unsealRow(li, false);
      else visible.push(li);
    }
    let at = 0;
    visible.forEach((li, k) => {
      const left = visible.length - k; // rows still to open, counting this one
      if (left === 3 && visible.length > 4) at += 450; // …and the top three
      later(at, () => {
        unsealRow(li, true);
        const look = left <= 3 ? state.looks[li._duck] : null; // the top three land with their own jingle
        if (li === top) {
          li.classList.add('gold-sweep');
          audio.cymbal();
          if (look) setTimeout(() => state.phase === 'results' && audio.motif(look.motif, 0.2), 160);
          if (lastFirst) flashResults(`${firstPickName} PICKS FIRST`);
        } else if (look) audio.motif(look.motif, 0.12);
        else audio.tick();
      });
      at += step;
    });
    later(at + 450, () => finishCeremony(false));
  });
}

/** Open a sealed board row: with the flip when the viewer can see it, silently otherwise. */
function unsealRow(li, animate) {
  li.classList.remove('sealed');
  li.style.animationDelay = '';
  li.classList.add('in');
  if (animate) li.classList.add('flip');
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
  for (const el of R.querySelectorAll('.step-card')) el.classList.add('in');
  for (const li of R.querySelectorAll('.draft-board li:not(.board-head)')) if (!li.classList.contains('in')) unsealRow(li, false);
  R.classList.add('revealed');
  if (instant) R.classList.add('shine');
  const revealBtn = $('#btn-reveal-all');
  if (revealBtn) revealBtn.hidden = true;
  if (state.phase === 'results' && !state.podiumRaf) startPodiumLoop();
  syncResultsOverflow();
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
          mood: sec % 5 < 3 ? 'joy' : '', // beaming, then a look around
          medal: cv._medal,
        });
      } else if (do23) {
        renderPortrait(cv, cv._look, { standing: true, t: sec * (lively ? 1 : 0.5) + cv._place, medal: cv._medal });
      }
    }
  };
  state.podiumRaf = requestAnimationFrame(loop);
}

// DOM confetti for the results: two cannons arc over the card (canvas above the panel for 1.2 s), then the canvas
// drops BEHIND the glass so the drizzle shows through the backdrop blur and never speckles the headline. Paper in
// the first pick's colours (scene._winPalette) mixed with the house palette, two-tone as it tumbles; its own rAF,
// removed with the last piece. Where the panel has no blur to show through (phones, low-fx, old browsers) the
// drizzle only falls beside the panel.
const FX_FRONT_MS = 1200;
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
  const born = performance.now();
  cv.style.zIndex = '26';
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  const W = window.innerWidth;
  const H = window.innerHeight;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d');
  const halve = scene.qualityTier >= 2 ? 0.5 : scene.qualityTier === 1 ? 0.75 : 1;
  const ui = scene.ui || 1;
  const glass = !isCompact() && !document.body.classList.contains('lowfx') && !!window.CSS?.supports?.('backdrop-filter', 'blur(1px)');
  const champ = scene._winPalette ? scene._winPalette(draftOrder()[0]) : CONFETTI_COLS;
  const pieces = cv._pieces || (cv._pieces = []);
  const spawn = (x, y, angDeg, spreadDeg, spMin, spMax) => {
    const a = ((angDeg + (Math.random() - 0.5) * 2 * spreadDeg) * Math.PI) / 180;
    const sp = spMin + Math.random() * (spMax - spMin);
    const pal = Math.random() < 0.5 ? champ : CONFETTI_COLS;
    const color = pal[(Math.random() * pal.length) | 0] || CONFETTI_COLS[0];
    pieces.push({
      x,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      rot: Math.random() * 6.28,
      vr: (Math.random() - 0.5) * 12,
      seed: Math.random() * 6.28,
      streamer: Math.random() < 0.25,
      w: (9 + Math.random() * 3) * ui,
      h: (5 + Math.random() * 2) * ui,
      color,
      shade: confettiShade(color),
      age: 0,
      life: 2.4 + Math.random(),
    });
  };
  const nCannon = Math.round(110 * halve);
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
    if (cv.style.zIndex !== '19' && now - born > FX_FRONT_MS) cv.style.zIndex = '19'; // behind the .panel (z 20) from here on
    if (drizzleLeft > 0 && !cv._kill) {
      drizzleLeft -= dt;
      drizzleAcc += dt * 20 * halve;
      while (drizzleAcc >= 1) {
        drizzleAcc -= 1;
        let x = panel.left + Math.random() * panel.width;
        if (!glass) {
          // nothing to show through: fall in the margins beside the panel instead (none on a full-width phone panel)
          const leftW = Math.max(0, panel.left);
          const rightW = Math.max(0, W - panel.right);
          if (leftW + rightW < 24) continue;
          const r = Math.random() * (leftW + rightW);
          x = r < leftW ? r : panel.right + (r - leftW);
        }
        spawn(x, -10, 90, 20, 40, 120);
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = 'round';
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
      const flip = Math.cos(q.age * 7 + q.seed); // tumbling: edge-on at 0, the back face when negative
      ctx.globalAlpha = Math.min(1, (q.life - q.age) * 2.5);
      ctx.save();
      ctx.translate(fx, q.y);
      ctx.rotate(q.rot);
      if (q.streamer) {
        const bend = Math.sin(q.age * 5 + q.seed) * 8 * ui;
        ctx.strokeStyle = flip < 0 ? q.shade : q.color;
        ctx.lineWidth = 3 * ui;
        ctx.beginPath();
        ctx.moveTo(0, -11 * ui);
        ctx.quadraticCurveTo(bend, 0, 0, 11 * ui);
        ctx.stroke();
      } else {
        ctx.fillStyle = flip < 0 ? q.shade : q.color;
        ctx.scale(0.2 + 0.8 * Math.abs(flip), 1);
        ctx.fillRect(-q.w / 2, -q.h / 2, q.w, q.h);
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
  const AW = state.awards || raceAwards(sim, state.raceNames, rule);
  const lines = [
    `🦆 ${state.league || 'Duck Derby'} — ${R.h2} · ${new Date().toLocaleDateString()}`,
    AW.headline,
    `${R.sentence}. Race finish in brackets.`,
    ...draftOrder().map((d, k) => {
      const aw = (AW.byDuck.get(d) || [])[0];
      const who = `${state.looks[d].name}  (${placeWords(order.indexOf(d) + 1, n, sim.finishTimes[d])})${aw ? ` — ${aw.icon} ${aw.label}` : ''}`;
      return choice ? `${ordinal(k + 1)} to choose — ${who}` : `Pick ${slotNo(k)} — ${who}`;
    }),
    ...hotdogLines(sim, state.raceNames, AW.culprits),
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
  // phones fit four quiet chips a row: short labels there (the titles carry the long form)
  const compact = isCompact();
  els.instant.lastElementChild.textContent = compact ? 'Replay' : 'Replay finish';
  if (!state.sharedRun) els.replay.textContent = compact ? 'Full race' : 'Watch full race';
  els.replay.title = state.sharedRun ? 'Watch the whole race again' : 'Watch the whole race again from the start';
  els.copy.textContent = compact ? 'Copy text' : 'Copy as text';
  if (compact) {
    if (state.sharedRun) els.actions.insertBefore(els.replay, els.share);
    else strip.insertBefore(els.replay, strip.firstChild);
    strip.insertBefore(els.instant, strip.firstChild); // the strip opens with "Replay finish"
    strip.insertBefore(els.save, edit);
    strip.insertBefore(els.clip, edit);
    strip.insertBefore(els.copy, edit);
  } else {
    els.actions.insertBefore(els.save, strip);
    els.actions.insertBefore(els.clip, strip);
    els.actions.insertBefore(els.copy, strip);
    strip.insertBefore(els.replay, strip.firstChild);
    strip.insertBefore(els.instant, strip.firstChild);
  }
  setMoreOpen(false);
  // landscape phones: the chips ride beside the primary button(s) when they fit; when they don't (six or seven chips on
  // most phones) they take a row of their own, and only if even that row overflows does the strip scroll, with a fade
  // marking it. Measured from a clean slate each time (the classes themselves change the widths). Toasts learn the
  // footer's height; the board's scroll cue learns its new fold.
  els.actions.classList.remove('stacked');
  strip.classList.remove('overflow');
  let over = landscapeCompact() && strip.scrollWidth > strip.clientWidth + 2;
  if (over) {
    els.actions.classList.add('stacked');
    over = strip.scrollWidth > strip.clientWidth + 2;
  }
  strip.classList.toggle('overflow', over);
  publishFooterH();
  syncResultsOverflow();
}

/** @param {{keepShared?: boolean}} [opts] keepShared: arriving on a shared link via browser Back — stay locked to it */
function backToSetup({ keepShared = false } = {}) {
  if (state.paused) setPaused(false);
  teardownReplay();
  hideConfirm();
  setMoreOpen(false);
  if (!keepShared) leaveSharedMode(true); // back to setup = a new race: never re-run the seed we just watched
  clearCallouts();
  clearTicker();
  toast.clear();
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
  setMoreOpen(false);
  els.actions.classList.add('confirming');
  els.confirmNew.hidden = false;
  $('#btn-cancel-new').focus();
}

// Very short screens (CSS: at most 559 x 600): the quiet actions sit behind a "More" button, in a sheet over the footer's
// top edge; anywhere else the button is display:none and the class is inert. Any action in the sheet, a tap outside it,
// Esc or a layout change closes it.
function setMoreOpen(on) {
  on = !!on;
  if (els.actions.classList.contains('more-open') === on) return;
  els.actions.classList.toggle('more-open', on);
  els.more.setAttribute('aria-expanded', String(on));
}
els.more.addEventListener('click', () => setMoreOpen(!els.actions.classList.contains('more-open')));
els.quietGroup.addEventListener('click', (e) => {
  if (e.target instanceof Element && e.target.closest('button')) setMoreOpen(false); // (bubbles after the action's own handler)
});
document.addEventListener('pointerdown', (e) => {
  if (!els.actions.classList.contains('more-open')) return;
  if (!(e.target instanceof Element && e.target.closest('.quiet-group, #btn-more'))) setMoreOpen(false);
});
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
els.instant.addEventListener('click', () => {
  if (state.phase === 'results' && !state.replay && !startInstantReplay('results')) toast('Nothing to replay');
});
els.clip.addEventListener('click', saveClip);
$('#btn-edit').addEventListener('click', () => backToSetup());
els.copy.addEventListener('click', () => copyText(resultText(), 'Draft order copied', { exported: true }));
$('#btn-copylink').addEventListener('click', () => copyText(shareUrl(), 'Share link copied — anyone can replay this exact race', { exported: true }));
els.share.addEventListener('click', async () => {
  const url = shareUrl();
  if (typeof navigator.share === 'function') {
    try {
      const story = (state.awards || raceAwards(state.sim, state.raceNames, normRule(state.rule))).headline;
      await navigator.share({ title: `${state.league || 'Duck Derby'} draft order`, text: `${story} ${RULES[normRule(state.rule)].sentence}.`, url });
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
function fitText(ctx, text, maxW, size, weight, family, floor = 12) {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  while (s > floor && ctx.measureText(text).width > maxW) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${family}`;
  }
  return s;
}

/** Shrink to `floor` px, then ellipsize by code points until it fits; leaves ctx.font set. Returns the text to draw. */
function fitName(ctx, text, maxW, size, floor, weight, family) {
  fitText(ctx, text, maxW, size, weight, family, floor);
  if (ctx.measureText(text).width <= maxW) return text;
  let cps = Array.from(text);
  while (cps.length > 1) {
    cps = cps.slice(0, -1);
    const t = `${cps.join('').trimEnd()}…`;
    if (ctx.measureText(t).width <= maxW) return t;
  }
  return '…';
}

/** Greedy word wrap into at most `maxLines` lines at the current font, shrinking from `size` to `floor` first; the last line ellipsizes. */
function wrapLines(ctx, text, maxW, maxLines, size, floor, weight, family) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const layout = () => {
    const lines = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? `${cur} ${w}` : w;
      if (cur && ctx.measureText(t).width > maxW) {
        lines.push(cur);
        cur = w;
      } else cur = t;
    }
    if (cur) lines.push(cur);
    return lines;
  };
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  let lines = layout();
  while (lines.length > maxLines && s > floor) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${family}`;
    lines = layout();
  }
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = fitName(ctx, `${lines[maxLines - 1]} …`, maxW, s, s, weight, family);
  }
  return { lines, size: s };
}

/** Render the shareable result card. @returns {Promise<Blob>} */
async function renderResultImage() {
  const picks = draftOrder();
  const sim = state.sim;
  const order = sim.order;
  const rule = normRule(state.rule);
  const R = RULES[rule];
  const lastFirst = rule === 'last-first';
  const league = state.league;
  const AW = state.awards || raceAwards(sim, state.raceNames, rule);
  const DISPLAY = 'Bungee, ui-rounded, "Arial Rounded MT Bold", system-ui, sans-serif';
  const UI = 'Nunito, ui-rounded, system-ui, sans-serif';
  // the self-hosted display face may still be in flight (font-display: block): give it a moment so the PNG uses it
  if (document.fonts?.load) {
    try {
      await Promise.race([Promise.all([document.fonts.load(`40px ${DISPLAY}`), document.fonts.load(`800 22px ${UI}`)]), new Promise((r) => setTimeout(r, 700))]);
    } catch {
      /* renders with the fallback stack */
    }
  }
  const W = 1080;
  const rowH = 74;
  const textW = W - 60 - 300; // header text leaves room for the hero portrait on the right
  const probe = document.createElement('canvas').getContext('2d');
  const story = wrapLines(probe, AW.headline, textW, 2, 22, 16, 800, UI); // the one-line race story, wrapped to two
  const storyH = story.lines.length * (story.size + 6) + 10;
  const top = 300 + storyH;
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
  // header text
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
  // the race story
  ctx.fillStyle = '#fff';
  ctx.font = `800 ${story.size}px ${UI}`;
  story.lines.forEach((ln, k) => ctx.fillText(ln, 62, 206 + k * (story.size + 6)));
  // rule pill
  ctx.font = `900 20px ${UI}`;
  const pill = R.pill;
  const pw = ctx.measureText(pill).width + 32;
  ctx.fillStyle = lastFirst ? '#FFD23F' : 'rgba(255,255,255,0.18)';
  roundRectPath(ctx, 60, 210 + storyH, pw, 38, 19);
  ctx.fill();
  ctx.fillStyle = lastFirst ? '#3b2400' : '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(pill, 76, 230 + storyH);
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
    roundRectPath(ctx, 50, y, W - 100, rowH - 10, 18);
    ctx.fill();
    ctx.fillStyle = look.towel.bg;
    roundRectPath(ctx, 50, y, 10, rowH - 10, 5);
    ctx.fill();
    ctx.fillStyle = '#FFD23F';
    ctx.textAlign = 'center';
    const pickTxt = rule === 'winner-choice' ? String(k + 1) : slotNo(k); // slots read "1.01"; a choosing order is just 1, 2, 3…
    if (rule === 'winner-choice') ctx.font = `400 34px ${DISPLAY}`;
    else fitText(ctx, pickTxt, 84, 28, 400, DISPLAY);
    ctx.fillText(pickTxt, 100, y + rowH / 2 - 4);
    ctx.textAlign = 'left';
    drawDuck(ctx, look, { x: 190, y: y + rowH / 2 + 6, scale: 0.62, t: k, effort: 0.2 });
    // the finish column (time, and the first award under it) is measured first; the name shrinks (and, past 16 px,
    // ellipsizes) to stop 28 px short of whichever is wider
    const place = order.indexOf(duck) + 1;
    const ft = sim.finishTimes[duck];
    const meta = `${ordinal(place)} · ${ft.toFixed(2)}s${place > 1 ? `  (+${(ft - winnerT).toFixed(2)})` : ''}`;
    const aw = (AW.byDuck.get(duck) || [])[0];
    const awText = aw ? `${aw.icon} ${aw.label}` : '';
    ctx.font = `800 16px ${UI}`;
    const awW = aw ? ctx.measureText(awText).width : 0;
    ctx.font = `800 22px ${UI}`;
    const metaW = ctx.measureText(meta).width;
    const nameMax = W - 80 - Math.max(metaW, awW) - 28 - 250;
    ctx.fillStyle = '#fff';
    const name = fitName(ctx, look.name, nameMax, 30, 16, 900, UI);
    ctx.fillText(name, 250, y + rowH / 2 - 4);
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    ctx.font = `800 22px ${UI}`;
    ctx.textAlign = 'right';
    ctx.fillText(meta, W - 80, y + rowH / 2 - (aw ? 14 : 4));
    if (aw) {
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = `800 16px ${UI}`;
      ctx.fillText(awText, W - 80, y + rowH / 2 + 11);
    }
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

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
let autoplayTimer = 0;
function cancelAutoplay() {
  if (!autoplayTimer) return;
  clearTimeout(autoplayTimer);
  autoplayTimer = 0;
}

readShareParams({ boot: true });
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
      // before the gun the ducks sit on the start line: reframe them for the new size (a rotation mid-countdown used to
      // leave the camera where the old viewport had it)
      if (state.phase === 'intro' || state.phase === 'countdown') {
        scene.snapCamera(0);
        if (state.phase === 'intro' && state.sim && scene.beginIntro) scene.beginIntro();
      }
    });
  }
  // rebuild the live-order rows once the resize settles (row height depends on it)
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.sim && !els.hud.hidden) buildStandings();
    else updateInsets();
    if (state.phase === 'results') {
      layoutBoard();
      arrangeActions();
    }
    fitTitleCard();
  }, 120);
});
const onCompactChange = () => {
  updateInsets();
  if (state.sim && !els.hud.hidden) buildStandings();
  else syncHudChrome();
  if (state.phase === 'results') {
    layoutBoard();
    arrangeActions();
  }
};
// browser Back / Forward: a result URL reopens its board, a shared link its locked setup, a bare URL the plain setup
window.addEventListener('popstate', (e) => {
  const data = decodeShare(location.search);
  if (state.phase === 'replay') finishInstantReplay(true); // Back / Forward during the instant replay: settle on the board first, then navigate
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
  if (state.phase === 'replay' && (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    skipReplay(); // the instant replay: any of these goes straight to the board
    return;
  }
  const live = PAUSABLE.includes(state.phase);
  switch (e.key) {
    case 'Escape':
      if (els.actions.classList.contains('more-open')) {
        setMoreOpen(false);
        els.more.focus();
      } else if (!els.confirmNew.hidden) {
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
    case 't':
    case 'T':
      setTv(!state.tv);
      break;
    default:
      break;
  }
});
scene.resize();
applyTv(); // big-screen mode from the store / &tv= (before the first layout pass)
if (TV_PARAM === '1' || TV_PARAM === '0') saveStore(); // a link that says tv=1 is remembered like the button
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
  setTv,
  /** Testing hook: play the instant replay now (from the board it returns to the board; mid-race it ends on the board). */
  replayFinish: () => startInstantReplay(state.phase === 'results' ? 'results' : 'show'),
  replayPlan,
  /**
   * Testing hook: put the race clock at `t` seconds. Idempotent — jumping
   * backwards (or from finish/results/the replay) rewinds the director and replays.
   * Events before `t` are applied with sound off; banners/ticker lines only
   * for the last 2.5 s so a capture shows what a viewer would see at `t`.
   */
  jump(t) {
    const sim = state.sim;
    if (!sim || !scene.sim) return;
    t = Math.max(0, Number(t) || 0);
    if (state.paused) setPaused(false);
    const wasReplay = !!state.replay;
    teardownReplay();
    if (state.phase === 'intro' || state.phase === 'countdown') setPhase('race');
    if (t < state.t || wasReplay || state.phase === 'results' || state.phase === 'finish' || state.phase === 'replay') {
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
    updateHud(true, { snap: true }); // a time cut places the board; nothing glides, no badges
  },
};
