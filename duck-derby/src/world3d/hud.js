// DOM HUD: position, gap, progress dots, minimap, item slot with roulette,
// commentary line, section names, toasts/popups/banners, countdown, mud splat.
import { ITEMS, ITEM_ORDER } from './items.js';
import { drawItemIcon } from './icons.js';
import { SECTIONS } from './course.js';
import { ordinal } from '../commentary.js';

const $ = (s) => document.querySelector(s);

export class Hud {
  constructor(course) {
    this.course = course;
    this.el = {
      hud: $('#hud'), posNum: $('#pos-num'), posOf: $('#pos-of'), gap: $('#hud-gap'), name: $('#hud-name-text'), swatch: $('#hud-swatch'),
      item: $('#hud-item'), itemCanvas: $('#item-canvas'), itemLabel: $('#item-label'), section: $('#hud-section'), comm: $('#hud-comm'),
      leader: $('#leader-name'), clock: $('#hud-clock'), fill: $('#progress-fill'), dots: $('#progress-dots'), secs: $('#progress-secs'),
      minimap: $('#minimap'), toast: $('#toast'), popup: $('#popup'), countdown: $('#countdown'), banner: $('#banner'), mud: $('#mud'),
      speed: $('#speedlines'), drops: $('#drops'), incoming: $('#incoming'), incWhat: $('#inc-what'), incDist: $('#inc-dist'), flyCap: $('#fly-cap'), flyTitle: $('#fly-title'), flySub: $('#fly-sub'), camBtn: $('#btn-cam'), muteBtn: $('#btn-mute'), ladder: $('#hud-ladder'),
    };
    this.itemCtx = this.el.itemCanvas.getContext('2d');
    this.lastRank = -1;
    this.lastSection = '';
    this.itemState = { key: null, rollUntil: 0, shown: null };
    this.commUntil = 0;
    this.sectionUntil = 0;
    this.toastUntil = 0;
    this.dots = [];
    this._buildMinimap();
    this._buildSectionTicks();
    this.lastMini = 0;
  }

  show(on) { this.el.hud.hidden = !on; }

  setRoster(looks) {
    this.looks = looks;
    this.el.dots.innerHTML = '';
    this.dots = looks.map((lk) => {
      const i = document.createElement('i');
      i.style.background = lk.towel.bg;
      i.style.color = lk.towel.text;
      i.textContent = lk.number;
      this.el.dots.appendChild(i);
      return i;
    });
    this.el.posOf.textContent = '/' + looks.length;
    this.lastRank = -1;
    this.itemState = { key: null, rollUntil: 0, shown: null };
    this._drawItem(null);
  }

  _buildSectionTicks() {
    const L = this.course.length;
    this.el.secs.innerHTML = '';
    for (const sec of this.course.sections) {
      if (sec.s0 <= 0) continue;
      const i = document.createElement('i');
      i.style.left = `${(sec.s0 / L) * 100}%`;
      i.dataset.n = sec.id === 'drop' ? 'Drop' : sec.id === 'harbor' ? 'Harbour' : sec.name.split(' ')[0].replace('Lily-Pad', 'Lily');
      this.el.secs.appendChild(i);
    }
  }

  _buildMinimap() {
    const c = this.el.minimap;
    const W = c.width;
    const H = c.height;
    const pts = this.course.outline(5);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
    const pad = 16;
    const sc = Math.min((W - pad * 2) / (maxX - minX), (H - pad * 2) / (maxZ - minZ));
    const ox = (W - (maxX - minX) * sc) / 2;
    const oy = (H - (maxZ - minZ) * sc) / 2;
    this.mapXform = (x, z) => [ox + (x - minX) * sc, oy + (z - minZ) * sc];
    const bg = document.createElement('canvas');
    bg.width = W;
    bg.height = H;
    const g = bg.getContext('2d');
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // course line coloured by section
    const secColor = { marina: '#66d6ff', canyon: '#e39b6d', lily: '#7fd36b', drop: '#ff6f61', tunnel: '#b08a5a', rapids: '#c9e8ff', harbor: '#ffd23f' };
    g.lineWidth = 9;
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.beginPath();
    pts.forEach((p, i) => { const [x, y] = this.mapXform(p.x, p.z); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.stroke();
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (a.s < 0 || a.s > this.course.length) { g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 3; } else { g.strokeStyle = secColor[a.section] || '#fff'; g.lineWidth = 5; }
      const [x0, y0] = this.mapXform(a.x, a.z);
      const [x1, y1] = this.mapXform(b.x, b.z);
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    }
    // start / finish marks, item boxes
    const mark = (s, col, r) => { const p = this.course.at(s); const [x, y] = this.mapXform(p.x, p.z); g.fillStyle = col; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); };
    mark(0, '#fff', 5);
    for (const b of this.course.features.itemBoxes) mark(b, '#c58cff', 3.5);
    const pf = this.course.at(this.course.length);
    const [fx, fy] = this.mapXform(pf.x, pf.z);
    g.fillStyle = '#111';
    g.fillRect(fx - 6, fy - 6, 12, 12);
    g.fillStyle = '#fff';
    g.fillRect(fx - 6, fy - 6, 6, 6);
    g.fillRect(fx, fy, 6, 6);
    this.mapBg = bg;
  }

  drawMinimap(ducks, target, leader, camPos) {
    const c = this.el.minimap;
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(this.mapBg, 0, 0);
    const order = ducks.map((d, i) => i).sort((a, b) => (a === target ? 1 : 0) - (b === target ? 1 : 0) || (a === leader ? 1 : 0) - (b === leader ? 1 : 0));
    for (const i of order) {
      const d = ducks[i];
      const [x, y] = this.mapXform(d.pos.x, d.pos.z);
      const r = i === target ? 7 : i === leader ? 6 : 4.5;
      g.fillStyle = this.looks[i].towel.bg;
      g.strokeStyle = i === target ? '#ffd23f' : '#fff';
      g.lineWidth = i === target ? 3 : 1.5;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    if (camPos) {
      const [x, y] = this.mapXform(camPos.x, camPos.z);
      g.strokeStyle = 'rgba(255,255,255,0.8)';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(x - 5, y); g.lineTo(x + 5, y); g.moveTo(x, y - 5); g.lineTo(x, y + 5);
      g.stroke();
    }
  }

  /** Main per-frame update (cheap DOM writes are diffed). */
  update(ctx) {
    const { ducks, target, leader, standings, t, race, looks, realTime, view } = ctx;
    const L = this.course.length;
    const d = ducks[target];
    if (d) {
      const rank = d.rank;
      if (rank !== this.lastRank) {
        const prev = this.lastRank;
        this.el.posNum.textContent = rank + 1;
        this.el.posNum.classList.remove('bump', 'up', 'down');
        void this.el.posNum.offsetWidth;
        const racing = ctx.phase === 'race' && t > 1.5 && prev >= 0 && this.lastTarget === target;
        this.el.posNum.classList.add(racing ? (rank < prev ? 'up' : 'down') : 'bump');
        clearTimeout(this._rankTimer);
        this._rankTimer = setTimeout(() => this.el.posNum.classList.remove('bump', 'up', 'down'), 620);
        if (racing && realTime - (this.lastRankCall || 0) > 0.7 && !d.finished) {
          this.lastRankCall = realTime;
          if (rank < prev) {
            const passed = standings[rank + 1] ? ctx.names[standings[rank + 1].i] : '';
            this.callout(rank === 0 ? '▲ 1st!' : `▲ passed ${passed}`, '#7dff8a');
            if (this.onRank) this.onRank(1);
          } else {
            const by = standings[rank - 1] ? ctx.names[standings[rank - 1].i] : '';
            this.callout(`▼ ${by} got you`, '#ff6f61');
            if (this.onRank) this.onRank(-1);
          }
        }
        this.lastRank = rank;
        this.lastTarget = target;
      }
      const leadD = ducks[leader];
      let gapTxt;
      if (ctx.phase !== 'race' && ctx.phase !== 'finish' && t <= 0) gapTxt = `Lane ${target + 1} · ${ducks.length} ducks`;
      else if (d.finished) gapTxt = `${ordinal(rank + 1)} · ${fmtTime(race.finishTimes[target])}`;
      else if (rank === 0) {
        const second = standings[1] ? ducks[standings[1].i] : null;
        gapTxt = second ? `leading by ${(d.s - second.s).toFixed(1)} m` : 'leader';
      } else gapTxt = `+${Math.max(0, leadD.s - d.s).toFixed(1)} m · ${ctx.names[leader]} leads`;
      setText(this.el.gap, gapTxt);
      setText(this.el.name, (ctx.follow === 'leader' ? '★ ' : '') + ctx.names[target] + ' ▾');
      const lk = looks[target];
      if (this.el.swatch.dataset.k !== String(target)) {
        this.el.swatch.dataset.k = String(target);
        this.el.swatch.style.background = lk.towel.bg;
        this.el.swatch.style.color = lk.towel.text;
        this.el.swatch.textContent = lk.number;
      }
      // item slot
      this._itemSlot(d, t, realTime);
      // section name
      if (d.section !== this.lastSection && ctx.phase === 'race') {
        this.lastSection = d.section;
        const sec = SECTIONS[d.section];
        if (sec && d.s > 5) {
          this.el.section.textContent = sec.name;
          this.el.section.classList.add('show');
          this.sectionUntil = realTime + 3.2;
        }
      }
      // mud + speed lines (chase view only)
      const muddy = view === 'chase' && !!d.win.mud;
      if (muddy !== !!this._muddy) { this._muddy = muddy; this.el.mud.classList.remove('show'); if (muddy) { void this.el.mud.offsetWidth; this.el.mud.classList.add('show'); } }
      this.el.speed.classList.toggle('show', view === 'chase' && (!!d.win.boost || !!d.win.star || (d.section === 'tunnel' && d.v > 20)));
    }
    if (this.sectionUntil && realTime > this.sectionUntil) { this.el.section.classList.remove('show'); this.sectionUntil = 0; }
    this._pumpQueue(realTime);
    if (this.commUntil && realTime > this.commUntil) { this.el.comm.classList.remove('show'); this.commUntil = 0; }
    if (this.toastUntil && realTime > this.toastUntil) { this.el.toast.classList.remove('show'); this.toastUntil = 0; }
    setText(this.el.leader, ctx.names[leader] || '');
    setText(this.el.clock, fmtTime(Math.max(0, t)));
    // progress
    const leadS = ducks[leader] ? Math.min(L, ducks[leader].s) : 0;
    const fw = ((leadS / L) * 100).toFixed(1);
    if (this._fw !== fw) { this._fw = fw; this.el.fill.style.width = fw + '%'; }
    for (let i = 0; i < ducks.length; i++) {
      const el = this.dots[i];
      if (!el) continue;
      const left = Math.min(100, (Math.max(0, ducks[i].s) / L) * 100).toFixed(1);
      if (el._left !== left) { el._left = left; el.style.left = left + '%'; }
      const me = i === target;
      const ld = i === leader;
      if (el._me !== me) { el._me = me; el.classList.toggle('me', me); }
      if (el._ld !== ld) { el._ld = ld; el.classList.toggle('lead', ld); }
    }
    if (realTime - this.lastMini > 0.066) {
      this.lastMini = realTime;
      if (this.el.minimap.offsetParent !== null) this.drawMinimap(ducks, target, leader, ctx.camPos);
    }
    if (realTime - (this.lastLadder || 0) > 0.2) {
      this.lastLadder = realTime;
      this._ladder(ctx);
    }
  }

  /** Mini standings: top rows + a window around my duck (contextual on phones). */
  _ladder(ctx) {
    const { ducks, target, standings, names, looks, view } = ctx;
    if (!standings || !standings.length) return;
    const n = standings.length;
    const myRank = ducks[target] ? ducks[target].rank : 0;
    const compact = window.innerWidth <= 760;
    let rows;
    if (view === 'tv' && !compact) rows = standings.slice(0, Math.min(8, n)).map((r, k) => k);
    else if (compact) {
      const set = new Set([0, myRank - 1, myRank, myRank + 1, n - 1].filter((k) => k >= 0 && k < n));
      rows = [...set].sort((a, b) => a - b);
    } else {
      const set = new Set([0, 1, 2, 3, myRank - 1, myRank, myRank + 1].filter((k) => k >= 0 && k < n));
      rows = [...set].sort((a, b) => a - b);
    }
    const leadS = ducks[standings[0].i].s;
    let html = '';
    let prev = -1;
    for (const k of rows) {
      if (prev >= 0 && k > prev + 1) html += '<li class="sep"></li>';
      prev = k;
      const i = standings[k].i;
      const d = ducks[i];
      const lk = looks[i];
      const gap = k === 0 ? (d.finished ? 'FIN' : 'leader') : d.finished ? 'FIN' : `+${Math.max(0, leadS - d.s).toFixed(0)}m`;
      html += `<li class="${i === target ? 'me' : ''}"><span class="rk">${k + 1}</span><span class="sw" style="background:${lk.towel.bg};color:${lk.towel.text}">${lk.number}</span><span class="nm">${esc(names[i])}</span><span class="gp">${gap}</span></li>`;
    }
    if (html !== this._ladderHtml) { this._ladderHtml = html; this.el.ladder.innerHTML = html; }
  }

  _itemSlot(d, t, realTime) {
    const st = this.itemState;
    const held = d.held; // {item, charges} | null
    const key = held ? `${held.item}` : null;
    if (key !== st.key) {
      // new pickup -> roulette
      if (key && !st.key) {
        st.rollUntil = realTime + 0.75;
        this.el.item.classList.add('rolling');
        this.el.item.classList.remove('empty');
      }
      st.key = key;
      if (!key) {
        this.el.item.classList.add('empty');
        this.el.item.classList.remove('rolling', 'got');
        this._drawItem(null);
        this.el.itemLabel.textContent = 'NO ITEM';
        st.shown = null;
      }
    }
    if (key) {
      if (realTime < st.rollUntil) {
        const idx = Math.floor(realTime * 14) % ITEM_ORDER.length;
        const rid = ITEM_ORDER[idx];
        if (st.shown !== rid) { this._drawItem(rid); st.shown = rid; }
        this.el.itemLabel.textContent = ITEMS[rid].short;
      } else {
        const sk = held.item + (held.charges || 1);
        if (st.shown !== sk) {
          this._drawItem(held.item, held.charges);
          st.shown = sk;
          this.el.item.classList.remove('rolling');
          this.el.item.classList.remove('got');
          void this.el.item.offsetWidth;
          this.el.item.classList.add('got');
          this.el.itemLabel.textContent = ITEMS[held.item].short + (held.item === 'triple' ? ` ×${held.charges}` : '');
        }
      }
    }
  }

  _drawItem(id, charges) {
    const g = this.itemCtx;
    const c = this.el.itemCanvas;
    g.clearRect(0, 0, c.width, c.height);
    if (!id) return;
    drawItemIcon(g, id, c.width / 2, c.height / 2, c.width * 0.86);
    void charges;
  }

  /**
   * Headline lane: one line at a time, min hold 1.4 s, max 3 s, queue of 2,
   * stale (>2 s queued) lines dropped, higher priority may pre-empt after the min hold.
   * priority: 3 = my duck, 2 = leader/lead change, 1 = hits, 0 = flavour.
   */
  say(text, realTime, dur = 3.0, priority = 0) {
    if (!text) return;
    this.queue = this.queue || [];
    const showing = this.commUntil && realTime < this.commUntil;
    const held = realTime - (this.commSince || 0);
    if (!showing || (held > 1.4 && priority >= (this.commPri || 0)) || priority > (this.commPri || 0) + 1) {
      this._show(text, realTime, dur, priority);
      return;
    }
    this.queue.push({ text, dur, priority, at: realTime });
    this.queue.sort((a, b) => b.priority - a.priority || a.at - b.at);
    if (this.queue.length > 2) this.queue.length = 2;
  }

  _show(text, realTime, dur, priority) {
    this.el.comm.textContent = text;
    this.el.comm.classList.remove('show');
    void this.el.comm.offsetWidth;
    this.el.comm.classList.add('show');
    this.commUntil = realTime + Math.min(3, dur);
    this.commSince = realTime;
    this.commPri = priority;
  }

  _pumpQueue(realTime) {
    if (!this.queue || !this.queue.length) return;
    const held = realTime - (this.commSince || 0);
    if (held < 1.4 && this.commUntil && realTime < this.commUntil) return;
    // drop stale
    this.queue = this.queue.filter((q) => realTime - q.at < 2.2);
    const next = this.queue.shift();
    if (next) this._show(next.text, realTime, next.dur, next.priority);
  }

  toast(text, realTime, dur = 1.4) {
    this.el.toast.textContent = text;
    this.el.toast.classList.add('show');
    this.toastUntil = realTime + dur;
  }

  setAnchor(x, y) { this.anchorX = x; this.anchorY = y; }

  /** Personal callout anchored above my duck (screen space): BOOST!, STUNG!, ▲ passed X … */
  callout(text, color = '#fff') {
    const div = document.createElement('div');
    div.className = 'callout';
    div.style.setProperty('--c', color);
    div.textContent = text;
    const x = this.anchorX ?? window.innerWidth / 2;
    const y = (this.anchorY ?? window.innerHeight * 0.6) - 70;
    div.style.left = `${Math.round(Math.max(60, Math.min(window.innerWidth - 60, x)))}px`;
    div.style.top = `${Math.round(Math.max(80, y - (this.el.callouts ? this.el.callouts.children.length * 30 : 0)))}px`;
    if (!this.el.callouts) { this.el.callouts = document.createElement('div'); this.el.callouts.id = 'callouts'; this.el.hud.appendChild(this.el.callouts); }
    this.el.callouts.appendChild(div);
    setTimeout(() => div.remove(), 1250);
  }

  popup(text, color = '#fff') {
    const div = document.createElement('div');
    div.className = 'pop';
    div.style.setProperty('--c', color);
    div.textContent = text;
    this.el.popup.appendChild(div);
    setTimeout(() => div.remove(), 2700);
    while (this.el.popup.children.length > 3) this.el.popup.firstChild.remove();
  }

  banner(text) { this.card(text); }

  /** Moment card: slim skewed band near the top; never two within 2 s (the later one waits). */
  card(text, hold = 1.1) {
    const now = performance.now() / 1000;
    const wait = Math.max(0, (this.cardBusyUntil || 0) - now);
    clearTimeout(this._cardTimer);
    this._cardTimer = setTimeout(() => {
      const b = this.el.banner;
      b.textContent = text;
      b.style.setProperty('--hold', hold + 's');
      b.classList.remove('show');
      void b.offsetWidth;
      b.classList.add('show');
      this.cardBusyUntil = performance.now() / 1000 + hold + 0.9;
    }, wait * 1000);
  }

  countdown(label, go = false) {
    const c = this.el.countdown;
    c.textContent = label;
    c.classList.remove('tick', 'go');
    void c.offsetWidth;
    c.classList.add(go ? 'go' : 'tick');
  }

  flyCaption(title, sub) {
    if (!title) { this.el.flyCap.classList.remove('show'); return; }
    this.el.flyTitle.textContent = title;
    this.el.flySub.textContent = sub || '';
    this.el.flyCap.classList.add('show');
  }

  /** The held item leaves the slot with a little fling. */
  itemUsed() {
    const c = this.el.itemCanvas;
    const ghost = document.createElement('canvas');
    ghost.width = c.width;
    ghost.height = c.height;
    ghost.className = 'ghost';
    ghost.style.width = c.clientWidth + 'px';
    ghost.style.height = c.clientHeight + 'px';
    ghost.getContext('2d').drawImage(c, 0, 0);
    this.el.item.appendChild(ghost);
    setTimeout(() => ghost.remove(), 340);
  }

  splashLens() {
    const d = this.el.drops;
    d.classList.remove('show');
    void d.offsetWidth;
    d.classList.add('show');
  }

  /** Incoming projectile warning (null hides). */
  incoming(what, dist) {
    const el = this.el.incoming;
    if (!what) { if (this._inc) { el.classList.remove('show'); this._inc = null; } return; }
    if (this._inc !== what) { this._inc = what; this.el.incWhat.textContent = what; el.classList.add('show'); }
    const d = `${Math.max(0, Math.round(dist))} m`;
    if (this.el.incDist.textContent !== d) this.el.incDist.textContent = d;
    el.style.setProperty('--p', `${Math.max(0.12, Math.min(0.6, dist / 80))}s`);
  }

  setCamLabel(view) { this.el.camBtn.textContent = view.toUpperCase(); }
  setMuted(muted) { this.el.muteBtn.classList.toggle('off', muted); }

  clearTransient() {
    this.el.popup.innerHTML = '';
    this.el.banner.classList.remove('show');
    this.el.comm.classList.remove('show');
    this.el.section.classList.remove('show');
    this.el.mud.classList.remove('show');
    this._muddy = false;
    this.el.speed.classList.remove('show');
    this.incoming(null);
    this.lastSection = '';
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function setText(el, txt) {
  if (el.textContent !== txt) el.textContent = txt;
}
export function fmtTime(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}
