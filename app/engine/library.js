'use strict';
// Chooses the actual line to say. Knows which lines are recorded (or can be rendered),
// how long each one is, and what has been said already:
// - no line is said more than twice in a match (a hard rule)
// - a line not yet said in this match (better: in this series) beats one that was
// - the same template isn't used again for a while, even with a different name in it
// - when nothing fresh fits, saying something twice beats saying nothing

const C = require('./catalog');

const MAX_PER_MATCH = 2;
const rand = (a) => a[Math.floor(Math.random() * a.length)];

class Library {
  constructor({ tts, log, now = () => Date.now() }) {
    Object.assign(this, { tts, log, now });
    this.matchUses = new Map(); // text -> times said this match
    this.seriesUsed = new Map(); // text -> when it was last said (this series)
    this.recentTpl = []; // templates said lately
    this.lastCat = null;
    this.catAt = new Map(); // category -> when last said
    this.saidTotal = 0;
  }

  newMatch() { this.matchUses = new Map(); this.recentTpl = []; this.catAt = new Map(); this.lastCat = null; }
  newSeries() { this.seriesUsed = new Map(); }

  // a clip is { role, mood, text }; the pack (or live voice) tells us if it exists
  clipOf(cat, text, tpl) { return { role: C.roleOf(cat), mood: C.moodOf(cat), text, cat, tpl }; }
  recorded(clip) { return this.tts.strict ? this.tts.has(clip) : true; }
  ready(clip) { return this.tts.has(clip); }

  // how long a line takes to say, in ms
  ms(clip) {
    const d = this.tts.durationOf ? this.tts.durationOf(clip) : 0;
    if (d > 0) return d;
    // the pack voice is unhurried: about a second, plus ~0.1 s a character (fitted on real recordings)
    const c = String(clip.text).length;
    return Math.round(470 + 97.5 * Math.min(c, 40) + 42.6 * Math.max(c - 40, 0));
  }

  // every usable line for these categories: [cat, vars] pairs or plain category names
  options(cats, vars = {}) {
    const out = [];
    for (const entry of cats) {
      const [cat, v] = Array.isArray(entry) ? entry : [entry, vars];
      for (const tpl of C.LINES[cat] || []) {
        const text = C.fill(tpl, v);
        if (!text) continue;
        const clip = this.clipOf(cat, text, tpl);
        if (this.recorded(clip)) out.push(clip);
      }
    }
    return out;
  }

  has(cats, vars) { return this.options(cats, vars).some((c) => (this.matchUses.get(c.text) || 0) < MAX_PER_MATCH); }

  // opts: maxMs / minMs (the time there is to say it), needReady (it must play right now),
  // filter(clip), order: 'first' (use the first category that has anything) or 'any'
  pick(cats, vars = {}, opts = {}) {
    const lists = [];
    for (const entry of cats) {
      const list = this.options([entry], vars).filter((c) => (this.matchUses.get(c.text) || 0) < MAX_PER_MATCH)
        .filter((c) => !opts.needReady || this.ready(c))
        .filter((c) => !opts.filter || opts.filter(c));
      const all = list.map((c) => ({ ...c, ms: this.ms(c) }));
      const sized = all.filter((c) => (!opts.maxMs || c.ms <= opts.maxMs) && (!opts.minMs || c.ms >= opts.minMs));
      if (sized.length) lists.push(sized);
      else if (opts.fallbackMs && all.length) {
        // nothing short enough: the shortest line that still fits the fallback beats saying nothing
        const shortest = all.filter((c) => c.ms <= opts.fallbackMs).sort((a, b) => a.ms - b.ms).slice(0, 3);
        if (shortest.length) lists.push(shortest);
      }
    }
    if (!lists.length) {
      if (opts.needReady && !this.tts.strict) this.warm(cats, vars);
      return null;
    }
    // not the same kind of line twice running, when there's another kind to say
    if (opts.avoidLastCat && lists.length > 1) lists.sort((a, b) => (a[0].cat === this.lastCat ? 1 : 0) - (b[0].cat === this.lastCat ? 1 : 0));
    // freshness: 3 = new this series, 2 = new this match, 1 = said once this match
    const fresh = (c) => {
      const n = this.matchUses.get(c.text) || 0;
      if (n > 0) return 1;
      return this.seriesUsed.has(c.text) ? 2 : 3;
    };
    const tplPenalty = (c) => (this.recentTpl.includes(c.tpl) ? 1 : 0);
    const score = (c) => fresh(c) * 2 - tplPenalty(c);
    // categories are listed best first: a fresh line from a later one beats a repeat from the first
    let pool;
    if (opts.order === 'any') pool = lists.flat();
    else {
      const best = lists.find((l) => l.some((c) => fresh(c) >= 2 && !tplPenalty(c)));
      pool = best || lists.find((l) => l.some((c) => fresh(c) >= 2)) || lists[0];
    }
    const top = Math.max(...pool.map(score));
    let choice;
    if (top <= 2) {
      // nothing fresh: the line said longest ago
      const said = pool.filter((c) => score(c) === top).sort((a, b) => (this.seriesUsed.get(a.text) || 0) - (this.seriesUsed.get(b.text) || 0));
      choice = said[0];
    } else choice = rand(pool.filter((c) => score(c) === top));
    return choice;
  }

  // the line was actually said
  said(clip) {
    if (!clip) return;
    this.matchUses.set(clip.text, (this.matchUses.get(clip.text) || 0) + 1);
    this.seriesUsed.delete(clip.text);
    this.seriesUsed.set(clip.text, this.now());
    if (clip.tpl) { this.recentTpl.push(clip.tpl); if (this.recentTpl.length > 14) this.recentTpl.shift(); }
    if (clip.cat) { this.catAt.set(clip.cat, this.now()); this.lastCat = clip.cat; }
    this.saidTotal++;
  }
  usesThisMatch(text) { return this.matchUses.get(text) || 0; }
  sinceCat(cat) { const t = this.catAt.get(cat); return t ? this.now() - t : Infinity; }

  // live voices: get these lines rendered for next time
  warm(cats, vars) {
    if (this.tts.strict || !this.tts.prefetch) return;
    for (const c of this.options(cats, vars).slice(0, 3)) this.tts.prefetch({ role: c.role, mood: c.mood, text: c.text }, 1);
  }

  // series memory on disk: the lines said in this series (most recent 3000)
  dump() { return [...this.seriesUsed.entries()].slice(-3000); }
  load(entries) { this.seriesUsed = new Map(entries || []); }
}

module.exports = { Library, MAX_PER_MATCH };
