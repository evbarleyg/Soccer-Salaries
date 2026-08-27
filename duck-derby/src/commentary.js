// Colour commentary generator. Turns sim events + standings into short lines.

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export class Commentator {
  constructor(names) {
    this.names = names;
    this.lastLineAt = -10;
    this.lastLeader = -1;
    this.saidStretch = false;
  }

  n(i) {
    return this.names[i] ?? 'Someone';
  }

  intro(count) {
    return pick([
      `${count} ducks, one pond, zero mercy. Draft order is on the line.`,
      `Welcome to the Duck Derby! ${count} hopefuls paddle for draft-day glory.`,
      `Conditions: wet. Stakes: enormous. ${count} ducks are under starter's orders.`,
    ]);
  }

  go() {
    return pick(["AND THEY'RE OFF!", 'QUACK! They are away!', "The rope drops — they're racing!"]);
  }

  forEvent(ev, standings, t) {
    const name = this.n(ev.duck);
    switch (ev.type) {
      case 'lead':
        this.lastLeader = ev.duck;
        return pick([
          `${name} takes the lead!`,
          `${name} surges to the front!`,
          `New leader: ${name}!`,
          `${name} says "my pond" and hits the front.`,
          ev.from != null && ev.from >= 0 ? `${name} sweeps past ${this.n(ev.from)}!` : `${name} leads!`,
        ]);
      case 'burst':
        if (Math.random() < 0.45) return null;
        return pick([
          `${name} finds another gear!`,
          `Big move from ${name}!`,
          `${name} is flying — look at that wake!`,
          `${name} puts the webbed foot down.`,
          `Turbo-paddle from ${name}!`,
        ]);
      case 'stumble':
        if (Math.random() < 0.35) return null;
        return pick([
          `${name} got distracted by some bread.`,
          `Oh no — ${name} hits a lily pad!`,
          `${name} loses rhythm!`,
          `${name} takes on water!`,
          `A wobble from ${name}.`,
        ]);
      case 'hotdog':
        return pick([
          `INCOMING! A hot dog from the stands flattens ${name}!`,
          `${name} takes a frankfurter to the face and spins out!`,
          `Mustard everywhere! ${name} has been hot-dogged!`,
          `Someone in Row G just launched lunch at ${name}!`,
          `${name} eats a hot dog the hard way. The lead is in danger!`,
        ]);
      case 'halfway': {
        const leader = standings[0] ? this.n(standings[0].i) : name;
        const last = standings.length ? this.n(standings[standings.length - 1].i) : '';
        return `Halfway! ${leader} leads, ${last} has work to do.`;
      }
      case 'stretch': {
        const a = standings[0] ? this.n(standings[0].i) : name;
        const b = standings[1] ? this.n(standings[1].i) : '';
        return b ? `FINAL STRETCH! ${a} and ${b} are neck and neck-feather!` : `FINAL STRETCH! ${a} leads!`;
      }
      case 'finish':
        return null; // handled by the caller (knows the place)
      default:
        return null;
    }
  }

  finishLine(i, place, photo) {
    const name = this.n(i);
    if (place === 1) {
      return photo
        ? pick([`PHOTO FINISH! ${name} takes it by a beak!`, `By a feather — ${name} wins it!`])
        : pick([`${name} WINS THE DUCK DERBY!`, `${name} takes the crown!`, `Dominant. ${name} wins!`]);
    }
    if (place === 2) return pick([`${name} home in second.`, `${name} grabs second!`]);
    if (place === 3) return pick([`${name} rounds out the podium.`, `Third for ${name}.`]);
    if (place === this.names.length) return pick([`And ${name} brings up the rear. Someone had to.`, `${name} finishes last — enjoy that final pick.`]);
    return Math.random() < 0.5 ? `${name} finishes ${ordinal(place)}.` : null;
  }
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
