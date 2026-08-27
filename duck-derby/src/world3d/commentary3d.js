// Seeded colour commentary for the 3D race (deterministic per race so replays
// and shared links read the same). Items, hazards and course features get lines.
import { ordinal } from '../commentary.js';
import { ITEMS } from './items.js';

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class WorldCommentator {
  constructor(names, seed) {
    this.names = names;
    this.seed = seed >>> 0;
    this.rnd = mulberry(seed ^ 0xc0ffee); // intro/go lines only
    this.ev = null;
    this.k = 0;
  }
  /** Deterministic per-event random (independent of who is watching or when). */
  er() {
    if (!this.ev) return this.rnd();
    const x = Math.sin((this.ev.t * 1000 + 1) * 12.9898 + ((this.ev.duck ?? 0) + 2) * 78.233 + (this.k++) * 37.719 + (this.seed % 9973)) * 43758.5453;
    return x - Math.floor(x);
  }
  pick(arr) { return arr[Math.floor(this.er() * arr.length)]; }
  n(i) { return this.names[i] ?? 'Someone'; }

  intro(count) {
    return this.pick([
      `${count} ducks, seven sections, zero mercy. Draft order is on the line.`,
      `Welcome to Duck Derby World! ${count} hopefuls take on the canyon, The Drop and the rapids.`,
      `Conditions: splashy. Stakes: enormous. ${count} ducks are under starter's orders.`,
    ]);
  }
  go() { return this.pick(["AND THEY'RE OFF!", 'QUACK! They are away!', 'The boom swings up — they are racing!']); }

  /** @returns {string|null} */
  forEvent(ev, standings, target) {
    this.ev = ev;
    this.k = 0;
    const out = this._forEvent(ev, standings, target);
    this.ev = null;
    return out;
  }

  _forEvent(ev, standings, target) {
    const name = ev.duck !== undefined && ev.duck >= 0 ? this.n(ev.duck) : '';
    const mine = ev.duck === target;
    switch (ev.type) {
      case 'lead':
        return this.pick([`${name} takes the lead!`, `${name} hits the front!`, `New leader: ${name}!`, ev.from != null && ev.from >= 0 ? `${name} sweeps past ${this.n(ev.from)}!` : `${name} leads!`]);
      case 'burst':
        if (!mine && this.er() < 0.7) return null;
        return ev.section === 'rapids' ? this.pick([`${name} catches a current!`, `${name} rides the white water!`]) : this.pick([`${name} finds another gear!`, `Big move from ${name}!`, `Turbo-paddle from ${name}!`, `${name} is flying — look at that wake!`]);
      case 'stumble':
        if (!mine && this.er() < 0.6) return null;
        return {
          rock: this.pick([`${name} bonks a rock!`, `Ouch — ${name} finds a boulder.`]),
          lilypad: this.pick([`${name} gets tangled in a lily pad!`, `${name} ploughs into a pad!`]),
          log: this.pick([`${name} clips the flume wall!`, `${name} rattles the timbers!`]),
          buoy: this.pick([`${name} clatters a buoy!`, `${name} runs wide in the canyon!`]),
          wave: this.pick([`${name} takes on water!`, `A wobble from ${name}.`, `${name} loses rhythm!`]),
        }[ev.what] || `A wobble from ${name}.`;
      case 'hotdog':
        if (ev.result === 'blocked') return `A hot dog from the crowd — and ${name}'s bubble eats it!`;
        if (ev.result === 'immune') return `Someone threw lunch at ${name}. ${name} is golden and does not care.`;
        return this.pick([`INCOMING! A hot dog from the stands flattens ${name}!`, `${name} takes a frankfurter to the face and barrel-rolls!`, `Mustard everywhere! ${name} has been hot-dogged!`, `Someone on the bridge just launched lunch at the leader!`]);
      case 'pickup':
        if (ev.item === 'seagull') return `Uh oh. ${name} just pulled a SEAGULL from the box…`;
        if (ev.item === 'feather') return `${name} finds the Golden Goose Feather!`;
        if (mine) return `You got: ${ITEMS[ev.item].name}.`;
        return null;
      case 'use':
        switch (ev.item) {
          case 'hornet': return ev.target >= 0 ? `${name} sends a hornet after ${this.n(ev.target)}!` : `${name} wastes a hornet.`;
          case 'seagull': return `SEAGULL STRIKE! It's hunting down the leader!`;
          case 'feather': return `${name} goes GOLDEN — coming through!`;
          case 'mud': return ev.victims && ev.victims.length ? `${name} splatters ${ev.victims.length === 1 ? this.n(ev.victims[0]) : ev.victims.length + ' ducks'} with mud!` : null;
          case 'stone': return mine || this.er() < 0.5 ? `${name} skims a stone up the course…` : null;
          case 'bread': case 'triple': return mine ? this.pick(['Bread boost!', 'Carbs → speed!']) : null;
          default: return null;
        }
      case 'hit': {
        const by = ev.by >= 0 ? this.n(ev.by) : '';
        switch (ev.item) {
          case 'hornet': return `${name} is stung into a spin${by ? ` — courtesy of ${by}` : ''}!`;
          case 'stone': return `Direct hit! ${by ? by + "'s" : 'A'} skipping stone skittles ${name}!`;
          case 'seagull': return `The seagull dive-bombs ${name}! The lead is in tatters!`;
          default: return `${name} spins out!`;
        }
      }
      case 'blocked':
        if (ev.item === 'hotdog') return null;
        return ev.reason === 'shield' ? `${name}'s bubble shield pops — ${ITEMS[ev.item]?.name || 'the hit'} blocked!` : `${name} shrugs off the ${ITEMS[ev.item]?.name || 'hit'} — golden!`;
      case 'projectile-end':
        if (ev.result === 'fizzle' && ev.kind === 'stone') return this.er() < 0.5 ? 'The stone skips out harmlessly.' : null;
        if (ev.result === 'fizzle' && ev.kind === 'hornet') return 'The hornet loses interest and buzzes off.';
        return null;
      case 'kick':
        if (ev.rank <= 2 || mine) return this.pick([`${name} kicks for home!`, `${name} finds a finishing kick!`, `Here comes ${name}!`]);
        return null;
      case 'takeoff':
        if (standings[0] && standings[0].i === ev.duck) return this.pick([`${name} launches off THE DROP!`, `Over the weir goes ${name}!`]);
        return mine ? 'Wheeee!' : null;
      case 'halfway': {
        const leader = standings[0] ? this.n(standings[0].i) : name;
        const last = standings.length ? this.n(standings[standings.length - 1].i) : '';
        return `Halfway! ${leader} leads, ${last} has work to do.`;
      }
      case 'stretch': {
        const a = standings[0] ? this.n(standings[0].i) : name;
        const b = standings[1] ? this.n(standings[1].i) : '';
        return b ? `INTO THE HARBOUR! ${a} and ${b} are neck and neck-feather!` : `FINAL STRETCH! ${a} leads!`;
      }
      default:
        return null;
    }
  }

  finishLine(i, place, photo, count) {
    const name = this.n(i);
    if (place === 1) return photo ? this.pick([`PHOTO FINISH! ${name} takes it by a beak!`, `By a feather — ${name} wins it!`]) : this.pick([`${name} WINS DUCK DERBY WORLD!`, `${name} takes the crown!`, `Dominant. ${name} wins!`]);
    if (place === 2) return this.pick([`${name} home in second.`, `${name} grabs second!`]);
    if (place === 3) return this.pick([`${name} rounds out the podium.`, `Third for ${name}.`]);
    if (place === count) return this.pick([`And ${name} brings up the rear. Someone had to.`, `${name} finishes last — enjoy that pick.`]);
    return (place * 7919 + this.seed) % 10 < 4 ? `${name} finishes ${ordinal(place)}.` : null;
  }
}
