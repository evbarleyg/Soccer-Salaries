// Colour commentary generator. Turns sim events + standings into short lines.
//
// Deterministic per share link: every variant is drawn from a seeded
// shuffle-bag (one independent RNG stream per category, so the order in which
// categories are used never changes another category's sequence), and
// nothing here touches the global RNG. main.js samples the race at fixed race-clock
// instants, so two viewers of the same link read the same broadcast.

import { createRng, hashString } from './rng.js';

const NOBODY = 'Someone';

export class Commentator {
  /**
   * @param {string[]} names
   * @param {{seed?: number, league?: string, rule?: string}} [opts]
   */
  constructor(names, { seed = 1, league = '', rule = 'winner-first' } = {}) {
    this.names = names;
    this.league = league || '';
    this.rule = rule || 'winner-first';
    this.seed = ((seed >>> 0) ^ 0xc0ffee) >>> 0;
    this.rng = createRng(this.seed);
    this.bags = new Map();
    this.cool = new Map(); // key -> race time until which that line type rests
    this.duel = { pair: '', since: -1 };
    this.gapPrev = 0;
    this.longLead = { duck: -1, said10: false, said20: false };
    this.lastLeader = -1;
    this.tailDuelS = { pair: '', since: -1 }; // back-of-field duel (last place picks first)
    this.gapBackPrev = 0;
    this.xHist = []; // [{t, x: number[]}] positions at the last few grid samples (closer detector)
    // closer detector: with the leader between `maxLeft` and `minLeft` seconds from home (and inside `window` units), a chaser
    // within `gap` units shrinking it by > `closing` u/s and projected to draw level inside `horizon` × the leader's remaining
    // time gets "HERE COMES X!" — once a race (tuned on a 400-seed dry run: ~45% of races, ~4 in 5 name the winner or runner-up)
    this.closerCfg = { window: 200, gap: 25, closing: 4.5, horizon: 0.9, minLeft: 1.2, maxLeft: 3.6, burst: 8, burstGap: 14 };
  }

  n(i) {
    return this.names[i] ?? NOBODY;
  }

  /**
   * Shuffle-bag: returns one of `lines`, never repeating a variant until every
   * variant has been used (and never the same one twice in a row across a
   * refill). Index-based, so the templates may be rebuilt per call.
   */
  bag(key, lines) {
    let b = this.bags.get(key);
    if (!b) {
      b = { rng: createRng((this.seed ^ hashString(key)) >>> 0), queue: [], last: -1 };
      this.bags.set(key, b);
    }
    b.queue = b.queue.filter((i) => i < lines.length);
    if (!b.queue.length) {
      b.queue = b.rng.shuffle(lines.map((_, i) => i));
      // the next draw is queue[last]; don't open a fresh bag with the line we just said
      if (b.queue.length > 1 && b.queue[b.queue.length - 1] === b.last) {
        const k = b.rng.int(0, b.queue.length - 2);
        [b.queue[k], b.queue[b.queue.length - 1]] = [b.queue[b.queue.length - 1], b.queue[k]];
      }
    }
    const i = b.queue.pop();
    b.last = i;
    return lines[i];
  }

  // ---------------------------------------------------------------------------
  // set pieces
  // ---------------------------------------------------------------------------

  intro(count, league = this.league) {
    if (this.rule === 'last-first') {
      return this.bag('intro-lf', [
        'Toilet-bowl rules tonight: the SLOWEST duck drafts first.',
        `${count} ducks, and for once nobody wants to win.`,
        'Last one home takes the 1.01 — let the sandbagging begin.',
      ]);
    }
    if (league) {
      return this.bag('intro-league', [
        `Welcome to the ${league} Duck Derby! ${count} ducks to post.`,
        `${league}: ${count} ducks, one pond, one draft board.`,
        `${count} ducks race for the ${league} draft order. No refunds.`,
        `The ${league} committee has spoken: settle it on the pond.`,
        `${league} draft day. ${count} ducks under starter's orders.`,
        `Live from the pond: the ${league} Duck Derby, ${count} runners.`,
      ]);
    }
    return this.bag('intro', [
      `${count} ducks, one pond, zero mercy. Draft order on the line.`,
      `Welcome to the Duck Derby! ${count} hopefuls, one draft board.`,
      `Conditions: wet. Stakes: enormous. ${count} ducks under orders.`,
      `${count} lanes, ${count} dreams, one first pick. Let's race.`,
      `The pond is glass, the crowd is loud. ${count} ducks to post.`,
      `Feathers preened, snacks confiscated. ${count} ducks are ready.`,
      `A hush over the water. ${count} ducks eye the far bank.`,
      `${count} managers, ${count} ducks, no refunds. Here we go.`,
    ]);
  }

  go() {
    return this.bag('go', [
      "AND THEY'RE OFF!",
      'QUACK! They are away!',
      "The rope drops — they're racing!",
      'Green light! Paddles churning!',
      'GO GO GO! Water everywhere!',
      "They're off and splashing!",
      'Away they go — a wall of feathers!',
      'And the pond erupts!',
    ]);
  }

  lead(i, from = -1) {
    const name = this.n(i);
    const other = from != null && from >= 0 ? this.n(from) : '';
    this.lastLeader = i;
    return this.bag('lead', [
      `${name} takes the lead!`,
      `${name} surges to the front!`,
      `New leader: ${name}!`,
      `${name} says "my pond" and hits the front.`,
      other ? `${name} sweeps past ${other}!` : `${name} leads!`,
      `It's ${name} in front now!`,
      other ? `${name} mugs ${other} for the lead!` : `${name} noses ahead!`,
      `Lead change! ${name} takes over.`,
    ]);
  }

  burst(i) {
    const name = this.n(i);
    return this.bag('burst', [
      `${name} finds another gear!`,
      `Big move from ${name}!`,
      `${name} is flying — look at that wake!`,
      `${name} puts the webbed foot down.`,
      `Turbo-paddle from ${name}!`,
      `${name} lights the afterburners!`,
      `Here comes ${name}!`,
      `${name} goes full speedboat.`,
    ]);
  }

  stumble(i) {
    const name = this.n(i);
    return this.bag('stumble', [
      `${name} got distracted by some bread.`,
      `Oh no — ${name} hits a lily pad!`,
      `${name} loses rhythm!`,
      `${name} takes on water!`,
      `A wobble from ${name}.`,
      `${name} stops to admire a dragonfly.`,
      `${name} paddles in a small circle. Why.`,
      `${name} forgets which way is forward.`,
    ]);
  }

  /** @param {number} i victim  @param {string} [c] the "culprit" manager whose section of the crowd threw it (seeded, for laughs) */
  hotdog(i, c = '') {
    const name = this.n(i);
    if (c) {
      return this.bag('hotdog-c', [
        `${c}'s cousin in Row G launches lunch at ${name}!`,
        `That frank had ${c}'s fingerprints all over it — ${name} is down!`,
        `${c} denies everything. ${name} wears the mustard.`,
        `Thrown from the ${c} family section — direct hit on ${name}!`,
      ]);
    }
    return this.bag('hotdog', [
      `INCOMING! A hot dog flattens ${name}!`,
      `${name} takes a frankfurter to the face!`,
      `Mustard everywhere! ${name} got hot-dogged!`,
      `Someone in Row G launched lunch at ${name}!`,
      `${name} eats a hot dog the hard way!`,
      `Direct hit! ${name} wears the ketchup!`,
      `A flying frank finds ${name}! Chaos!`,
      `${name} is down! Condiments confirmed!`,
    ]);
  }

  /** "did it actually cost them?" — 2.2 s after the impact. Ordinals are 1-based numbers. */
  hotdogAftermath(name, fromOrd, toOrd) {
    if (toOrd > fromOrd) {
      return this.bag('hd-cost', [
        `${name} drops from ${ordinal(fromOrd)} to ${ordinal(toOrd)}!`,
        `That hot dog cost ${name}: ${ordinal(fromOrd)} to ${ordinal(toOrd)}.`,
        `${name} tumbles to ${ordinal(toOrd)}. Justice for ${name}.`,
        `From ${ordinal(fromOrd)} to ${ordinal(toOrd)} — ${name} is fuming.`,
      ]);
    }
    return this.bag('hd-shrug', [
      `${name} shrugs off the hot dog!`,
      `${name} barely flinched. Still ${ordinal(toOrd)}.`,
      `Sauced but unbothered: ${name} holds ${ordinal(toOrd)}.`,
      `${name} ate it and kept going. Respect.`,
    ]);
  }

  /** The hot-dog victim just lost the lead to `a`: one line instead of a lead line plus an aftermath line. */
  leadFromVictim(a, v) {
    return this.bag('lead-victim', [`${a} inherits the lead — ${v} is still wearing the mustard!`, `${v} bonked, ${a} pounces: new leader!`, `Hot dog down, ${a} up front!`]);
  }

  revenge(name, c = '') {
    const lines = [`Covered in mustard and back in front — ${name}!`, `REVENGE! ${name} retakes the lead!`, `${name} answers the hot dog the only way: from the front.`, `You cannot keep ${name} down. Or clean.`];
    if (c) return this.bag('revenge-c', [...lines, `REVENGE on the ${c} section — ${name} retakes the lead!`]);
    return this.bag('revenge', lines);
  }

  halfway(standings) {
    const live = standings.length ? standings : [];
    if (!live.length) return 'Halfway!';
    const a = this.n(live[0].i);
    const last = live.length > 2 ? live[live.length - 1] : null;
    if (!live[1]) return `Halfway! ${a} all alone out there.`;
    if (!last) return `Halfway: ${a} leads ${this.n(live[1].i)} by ${metres(live[0].x - live[1].x)}m.`;
    const m = metres(live[0].x - last.x);
    if (this.rule === 'last-first') return `Halfway: ${this.n(last.i)} is LAST — pick 1 as it stands — ${m}m off. ${a} leads.`;
    return `Halfway: ${a} leads, ${this.n(last.i)} last, ${m}m back.`;
  }

  stretch(standings, gapUnits) {
    const a = standings[0] ? this.n(standings[0].i) : NOBODY;
    const b = standings[1] ? this.n(standings[1].i) : '';
    if (!b) return `FINAL STRETCH! ${a} leads them home!`;
    const gap = gapUnits ?? (standings[1] ? standings[0].x - standings[1].x : 99);
    let line;
    if (gap < 2) {
      line = this.bag('stretch-tight', [`FINAL STRETCH! ${a} and ${b} — half a beak in it!`, `FINAL STRETCH! Nothing between ${a} and ${b}!`]);
    } else if (gap > 10) {
      line = this.bag('stretch-clear', [`FINAL STRETCH! ${a} is a length clear of ${b}!`, `FINAL STRETCH! ${a} has this under control… surely.`]);
    } else {
      line = this.bag('stretch', [`FINAL STRETCH! ${a} and ${b}, neck and neck-feather!`, `FINAL STRETCH! ${a} from ${b} — it's on!`]);
    }
    if (this.rule === 'last-first') {
      const live = standings.filter((r) => !r.done);
      if (live.length >= 4) line += ` At the back: ${this.n(live[live.length - 2].i)} vs ${this.n(live[live.length - 1].i)} for the 1.01!`;
    }
    return line;
  }

  /** Run-in with the first two still together (CONTESTED beat). `gapUnits` picks how breathless to be. */
  atTheLine(a, b, gapUnits = 10) {
    if (gapUnits < 5) return this.bag('at-line-tight', [`Half a beak in it — ${a}, ${b}!`, `${a} has ${b} all over the back of him!`, `${a}, ${b} — NOTHING in it!`]);
    return this.bag('at-line', [`To the wall — ${a} from ${b}!`, `${b} is coming hard at ${a}!`, `${a} leads ${b} to the wall — not over yet!`]);
  }

  /** main.js saw a called lead change: don't follow it with a redundant "up to 1st" mover line. */
  noteLead(i, t) {
    this.lastLeader = i;
    this.cool.set(`mv${i}`, Math.max(this.cool.get(`mv${i}`) ?? -1, t + 6));
  }

  /** Run-in with daylight second (CLEAR beat). `m` is the metres text. */
  clearRun(a, m) {
    return this.bag('clear-run', [`Nobody is catching ${a} — ${m}m up.`, `${a} has this sewn up, ${m}m clear.`, `Daylight second: ${a} by ${m}m.`]);
  }

  tailBattle(names) {
    const [a, b] = names;
    if (!a) return null;
    if (!b) return `${a} needs a miracle back there.`;
    if (this.rule === 'last-first') {
      return this.bag('tail-lf', [
        `${a} and ${b} fight for LAST — and the first pick!`,
        `Lose this and win the draft: ${a} or ${b}?`,
        `The slow-off for first pick: ${a} vs ${b}.`,
      ]);
    }
    return this.bag('tail', [
      `${a} and ${b} — somebody has to be last.`,
      `At the back: ${a} vs ${b}. Dignity on the line.`,
      `The race for last is ON: ${a} vs ${b}.`,
      `${b} needs a miracle back there.`,
    ]);
  }

  /** The last two reach the line together: [second-last, backmarker]. */
  tailPhoto(names, rule = this.rule) {
    const [a, b] = names;
    if (!a || !b) return null;
    if (rule === 'last-first') {
      return this.bag('tail-photo-lf', [
        `${a} and ${b} crawling for the 1.01 — nobody wants to win this!`,
        `Photo for FIRST PICK: ${a} or ${b}? Slowest bill wins!`,
        `${a}, ${b} — whoever touches last drafts first!`,
      ]);
    }
    return this.bag('tail-photo', [`The wooden spoon goes to a photo — ${a} or ${b}?`, `${a} and ${b} hit the wall together — who is LAST?`, `Photo for last place! ${a}… ${b}… somebody blink!`]);
  }

  /**
   * @param {number} i duck
   * @param {number} place 1-based finishing position
   * @param {boolean|{photo?: boolean, margin?: number, victim?: boolean, rule?: string, n?: number, steal?: boolean, lastMargin?: number, photoCalled?: boolean}} [opts]
   *   photoCalled: the PHOTO FINISH beat aired — if the margin then says otherwise, the line acknowledges the late break
   */
  finishLine(i, place, opts = {}) {
    if (typeof opts === 'boolean') opts = { photo: opts };
    const { photo = false, margin = null, victim = false, rule = this.rule, n = this.names.length, steal = false, lastMargin = null, photoCalled = false } = opts;
    const name = this.n(i);
    if (place === 1) {
      let line;
      if (photoCalled && !photo && margin !== null && Number.isFinite(margin) && margin >= 0.35) {
        // we called a photo and then somebody found half a length: own it
        const m = margin.toFixed(2);
        line = this.bag('win-latebreak', [`Looked like a photo — then ${name} found half a length. ${m}s.`, `${name} breaks them late! Clear by ${m}s in the end.`, `Not so close after all: ${name} kicks away to win by ${m}s.`]);
      } else if (steal) {
        // the winner was not the long-time leader: it was taken on the run-in
        line = this.bag('win-steal', [`${name} STEALS IT ON THE LINE!`, `From nowhere — ${name}!`, `${name} mugs them at the wall!`]);
        if (photo) line += ' Check the photo!';
      } else if (photo) {
        line = this.bag('win-photo', [
          `PHOTO FINISH! ${name} takes it by a beak!`,
          `By a feather — ${name} wins it!`,
          `${name} by a bill-tip! Check the photo!`,
          `Inches! ${name} steals it on the line!`,
        ]);
      } else {
        line = this.bag('win', [
          `${name} WINS THE DUCK DERBY!`,
          `${name} takes the crown!`,
          `Dominant. ${name} wins!`,
          `It's ${name}! What a swim!`,
          `${name} gets there first!`,
          `Champion: ${name}!`,
          `${name} hits the line — victory!`,
          `Nobody catches ${name} today!`,
        ]);
        if (margin !== null && Number.isFinite(margin) && margin >= 0.18) line += ` By ${margin.toFixed(2)}s.`;
      }
      if (victim) line += this.bag('win-victim', [' Mustard and all!', ' Hot dog? What hot dog.']);
      return line;
    }
    if (place === 2) {
      // "so close" only when it was: a 1.4 s beating is not close
      if (margin !== null && Number.isFinite(margin) && margin < 0.6) return this.bag('p2-close', [`${name} takes second — so close.`, `${name} grabs second, a beak behind!`, `Silver for ${name}. Agonizingly close.`]);
      return this.bag('p2', [`${name} home in second.`, `${name} grabs second!`, `Silver for ${name}.`, `${name} takes second, well beaten.`]);
    }
    if (place === 3) return this.bag('p3', [`${name} rounds out the podium.`, `Third for ${name}.`, `${name} sneaks onto the podium.`, `Bronze goes to ${name}.`]);
    if (place === n) {
      let line;
      if (rule === 'last-first') {
        line = this.bag('last-lf', [
          `${name} is last home… and with it the first pick!`,
          `Dead last, first pick: ${name} plays the long game.`,
          `${name} trails in last — and drafts FIRST.`,
          `Slowest duck, biggest prize: ${name} picks first!`,
        ]);
      } else {
        line = this.bag('last', [
          `And ${name} brings up the rear. Someone had to.`,
          `${name} finishes last — enjoy that final pick.`,
          `${name} completes the course. Eventually.`,
          `Last home: ${name}. The pond thanks you.`,
        ]);
      }
      if (lastMargin !== null && Number.isFinite(lastMargin) && lastMargin < 0.4) line += ` Only ${lastMargin.toFixed(2)}s in it!`;
      else if (victim) line += ' Blame the hot dog.';
      return line;
    }
    return `${name} finishes ${ordinal(place)}.`;
  }

  /** Event → line. main.js decides whether a chatter line is relevant enough to air. */
  forEvent(ev, standings) {
    switch (ev.type) {
      case 'lead':
        return this.lead(ev.duck, ev.from);
      case 'burst':
        return this.burst(ev.duck);
      case 'stumble':
        return this.stumble(ev.duck);
      case 'hotdog':
        return this.hotdog(ev.duck);
      case 'halfway':
        return this.halfway(standings);
      case 'stretch':
        return this.stretch(standings, standings[1] ? standings[0].x - standings[1].x : 99);
      default:
        return null; // 'finish' is handled by the caller (knows the place)
    }
  }

  // ---------------------------------------------------------------------------
  // situational lines, polled at fixed race-clock instants
  // ---------------------------------------------------------------------------

  /**
   * @param {{standings: Array<{i:number,x:number,done:boolean}>, timeLed: number[], rankNow: number[], rankAgo: number[]|null,
   *   victims?: Set<number>, n: number, sinceSpoken?: number, finished?: number, trackLength?: number}} ctx
   * @param {number} t race clock (a multiple of the 0.25 s broadcast grid)
   * @returns {{text: string, pri: number, duck: number, kind?: string}|null}
   */
  poll(ctx, t) {
    const h0 = this.xHist;
    if (h0.length && t <= h0[h0.length - 1].t) this.rewind();
    const out = this._poll(ctx, t);
    // remember where everyone was at this instant (the closer detector reads 0.5 s back)
    const x = [];
    for (const r of ctx.standings) x[r.i] = r.done ? Infinity : r.x;
    const h = this.xHist;
    h.push({ t, x });
    if (h.length > 2) h.shift(); // [t - 0.25, t]: the next sample reads h[0] = 0.5 s back
    return out;
  }

  /** The race clock went backwards (testing hook / replay from a jump): forget every detector's memory. */
  rewind() {
    this.xHist = [];
    this.cool.clear();
    this.duel = { pair: '', since: -1 };
    this.tailDuelS = { pair: '', since: -1 };
    this.gapPrev = 0;
    this.gapBackPrev = 0;
    this.longLead = { duck: -1, said10: false, said20: false };
  }

  _poll(ctx, t) {
    const { standings, timeLed, rankNow, rankAgo, n, sinceSpoken = 0, finished = 0, trackLength = 1000, chatterOK = true, streak = 0 } = ctx;
    const live = standings.filter((r) => !r.done);
    if (live.length < 2) return null;
    const ready = (key) => t >= (this.cool.get(key) ?? -1);
    const arm = (key, secs) => this.cool.set(key, t + secs);
    const a = live[0];
    const b = live[1];
    const gap = a.x - b.x;
    const lastFirst = this.rule === 'last-first';

    if (finished === 0) {
      // the closer: somebody in the front four is reeling the leader in fast enough to matter before the line
      const past = this.xHist.length ? this.xHist[0] : null;
      const K = this.closerCfg;
      if (past && t - past.t >= 0.45 && t - past.t <= 0.8 && trackLength - a.x < K.window && ready('closer')) {
        const dt = t - past.t;
        const px = past.x;
        const aPast = px[a.i];
        if (Number.isFinite(aPast)) {
          const vLead = (a.x - aPast) / dt;
          const toLine = (trackLength - a.x) / Math.max(vLead, 1); // leader's seconds to the wall
          for (const r of live.slice(1, 4)) {
            const rPast = px[r.i];
            if (!Number.isFinite(rPast)) continue;
            const g = a.x - r.x;
            const closing = (aPast - rPast - g) / dt; // units per second the gap is shrinking
            if (closing <= K.closing || g >= K.gap || toLine <= K.minLeft || toLine >= K.maxLeft) continue;
            if (closing > K.burst && g > K.burstGap) continue; // a burst from well back flatters to deceive: wait and see
            // projected to draw level before the wall (bursts far out are ignored: the window opens ~3.5 s from home)
            if (g / closing < K.horizon * toLine) {
              arm('closer', 99); // once a race
              arm('break', 20); // …and no "pulling away" line may contradict it on the run-in
              const X = this.n(r.i);
              const A = this.n(a.i);
              return { text: this.bag('closer', [`HERE COMES ${X}!`, `${X} is eating up the gap on ${A}!`, `Look out ${A} — ${X} is flying!`]), pri: 3, duck: r.i, kind: 'closer' };
            }
          }
        }
      }
      // duel: the same two at the front within 0.3 m for 3 s running
      const pair = a.i < b.i ? `${a.i}|${b.i}` : `${b.i}|${a.i}`;
      if (gap < 3) {
        if (this.duel.pair !== pair) this.duel = { pair, since: t };
        else if (t - this.duel.since >= 3 && ready('duel')) {
          arm('duel', 8);
          this.duel.since = t; // needs another 3 s glued together before repeating
          return {
            text: this.bag('duel', [
              `${this.n(a.i)} and ${this.n(b.i)} — nothing between them!`,
              `${this.n(a.i)} vs ${this.n(b.i)}: stroke for stroke!`,
              `Side by side: ${this.n(a.i)} and ${this.n(b.i)}!`,
              `${this.n(b.i)} is all over ${this.n(a.i)}!`,
            ]),
            pri: 2,
            duck: a.i,
          };
        }
      } else if (this.duel.pair) this.duel = { pair: '', since: -1 };
      if (!lastFirst) {
        // breakaway: two metres of daylight and stretching
        if (gap > 20 && gap > this.gapPrev + 0.1 && ready('break')) {
          arm('break', 12);
          this.gapPrev = gap;
          const m = metres(gap);
          return {
            text: this.bag('break', [`${this.n(a.i)} has daylight: ${m}m clear.`, `${this.n(a.i)} is ${m}m up and pulling away!`, `Nobody wants to go with ${this.n(a.i)} — ${m}m clear.`]),
            pri: 2,
            duck: a.i,
          };
        }
        this.gapPrev = gap;
      }
    }

    // last place picks first: the money is at the back — watch the last two all race
    if (lastFirst && t > 8 && live.length >= 3) {
      const z0 = live[live.length - 1]; // backmarker (pick 1 as it stands)
      const z1 = live[live.length - 2];
      const gapBack = z1.x - z0.x;
      const pairB = z0.i < z1.i ? `${z0.i}|${z1.i}` : `${z1.i}|${z0.i}`;
      if (gapBack < 3) {
        if (this.tailDuelS.pair !== pairB) this.tailDuelS = { pair: pairB, since: t };
        else if (t - this.tailDuelS.since >= 3 && ready('tail-duel')) {
          arm('tail-duel', 8);
          this.tailDuelS.since = t;
          return {
            text: this.bag('tail-duel', [`${this.n(z1.i)} and ${this.n(z0.i)} are fighting NOT to win this…`, `Nothing between ${this.n(z1.i)} and ${this.n(z0.i)} at the back — and that is where the money is.`, `${this.n(z0.i)} and ${this.n(z1.i)}, dead level in the race for the 1.01.`]),
            pri: 2,
            duck: z0.i,
            kind: 'tail',
          };
        }
      } else if (this.tailDuelS.pair) this.tailDuelS = { pair: '', since: -1 };
      // adrift at the back = the dream scenario under these rules
      if (gapBack > 20 && gapBack > this.gapBackPrev + 0.1 && ready('break')) {
        arm('break', 12);
        this.gapBackPrev = gapBack;
        return { text: this.bag('break-lf', [`${this.n(z0.i)} is ${metres(gapBack)}m adrift — dream scenario under these rules.`, `${this.n(z0.i)} has ${metres(gapBack)}m of clear water BEHIND everyone. Suspiciously slow.`]), pri: 2, duck: z0.i, kind: 'tail' };
      }
      this.gapBackPrev = gapBack;
    }

    // movers and faders over the last three seconds (big fields jostle more, so ask for a bigger swing)
    const swing = n >= 10 ? 4 : 3;
    if (rankAgo && ready('mv')) {
      for (const r of live) {
        const now = rankNow[r.i];
        const ago = rankAgo[r.i];
        if (now === undefined || ago === undefined) continue;
        const d = now - ago;
        const pri = now <= 1 ? 2 : 1;
        if (d <= -swing && ready(`mv${r.i}`) && (pri >= 2 || chatterOK)) {
          arm(`mv${r.i}`, 8);
          arm('mv', 5);
          const x = this.n(r.i);
          return {
            text: this.bag('mover', [
              `${x} storms from ${ordinal(ago + 1)} to ${ordinal(now + 1)}!`,
              `${x} is carving through: ${ordinal(ago + 1)} to ${ordinal(now + 1)}.`,
              `Look at ${x} go — up to ${ordinal(now + 1)}!`,
              `${x} finds a lane of clear water: ${ordinal(now + 1)} now.`,
              `Big gains for ${x} — ${ordinal(ago + 1)} to ${ordinal(now + 1)}.`,
              `${x} is on a charge! Up to ${ordinal(now + 1)}.`,
            ]),
            pri,
            duck: r.i,
          };
        }
        if (d >= swing && ready(`fd${r.i}`) && chatterOK) {
          arm(`fd${r.i}`, 8);
          arm('mv', 5);
          const x = this.n(r.i);
          return {
            text: this.bag('fade', [
              `${x} is going backwards: ${ordinal(ago + 1)} to ${ordinal(now + 1)}.`,
              `${x} has hit the wall — down to ${ordinal(now + 1)}.`,
              `Trouble for ${x}: ${ordinal(ago + 1)} to ${ordinal(now + 1)}.`,
              `${x} is paddling through molasses — ${ordinal(now + 1)} and sliding.`,
              `The pack swallows ${x}: down to ${ordinal(now + 1)}.`,
            ]),
            pri: 1,
            duck: r.i,
          };
        }
      }
    }

    // bossing it: the leader has been in front, unbroken, for a long time
    if (finished === 0 && chatterOK) {
      const led = streak || 0;
      const LL = this.longLead;
      if (LL.duck !== a.i) this.longLead = { duck: a.i, said10: led >= 10, said20: led >= 20 };
      else if (!LL.said20 && led >= 20) {
        LL.said20 = LL.said10 = true;
        return { text: lastFirst ? `${this.n(a.i)} has led for 20 seconds — and will pick LAST for it.` : `${this.n(a.i)} has bossed this for 20 seconds. Pressure on.`, pri: 1, duck: a.i };
      } else if (!LL.said10 && led >= 10) {
        LL.said10 = true;
        return { text: this.bag('led10', [`${this.n(a.i)} has led for 10 seconds straight.`, `Ten unbroken seconds in front for ${this.n(a.i)}.`]), pri: 1, duck: a.i };
      }
    } else if (this.longLead.duck !== a.i) this.longLead = { duck: a.i, said10: false, said20: false };

    // dead air: a fact about the shape of the race
    if (sinceSpoken >= 3.5 && chatterOK && ready('fill')) {
      arm('fill', 5);
      const last = live[live.length - 1];
      const facts = [];
      if (live.length >= 3) facts.push(`Top three covered by ${metres(a.x - live[2].x)}m.`);
      if (live.length >= 4 && a.x - last.x > 25) facts.push(lastFirst ? `${this.n(last.i)} sits last, ${metres(a.x - last.x)}m off the lead — holding the 1.01.` : `${this.n(last.i)} is ${metres(a.x - last.x)}m adrift — that is a lot of pond.`);
      if (finished === 0) facts.push(`${metres(trackLength - a.x)}m to swim for ${this.n(a.i)}.`);
      else facts.push(`${live.length} ducks still out there, ${this.n(a.i)} best of them.`);
      if (finished === 0 && (timeLed[a.i] || 0) >= 4) facts.push(`${this.n(a.i)} in front, ${this.n(b.i)} stalking, ${metres(gap)}m in it.`);
      facts.push(`${n} ducks, and every one of them means it.`);
      return { text: this.bag('filler', facts), pri: 1, duck: a.i, kind: 'fill' };
    }
    return null;
  }
}

/** Track units → metres text (10 units = 1 m). */
export function metres(units) {
  const m = Math.max(0, units) / 10;
  return m >= 10 ? m.toFixed(0) : m.toFixed(1);
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
