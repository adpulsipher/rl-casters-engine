'use strict';
// Chooses the actual line to say. Knows which lines are recorded (or can be rendered),
// how long each one is, and what has been said already:
// - no line is said twice in three games in a row (this one and the two before), and no
//   template either: "{name} with the save!" said for one player is used up, even with
//   another name in it. So in a best of seven a sentence can come up three times at most.
//   If a call would otherwise have no line, one from the last two games is used again
//   (never one from this game).
//   Short calls ("Shot!", "Aerial!", "{name} takes it.") are the exception: like a real
//   caster's, they come up as often as the play does (2.1.2: not just twice), only not the
//   same one again within 30 seconds.
//   When it's that or dead air (pick's allowRepeat), a sentence can come up a second time,
//   never a third. A pack without the 2.0 lines is too small for any of this: there the
//   1.x rule stays (any line twice, never three times).
// - a line not yet said in this series beats one said in an earlier game
// (2.1: tested on 76 matches with the full bank, never repeating costs about a second more
// of the longest silence in a match, and nothing else of note)

const C = require('./catalog');

const MAX_PER_MATCH = 1; // a sentence
const WINDOW = 3; // games a sentence isn't said twice in (this one and the two before)
const MAX_SHORT = 2; // any other line, when it's that or dead air
const MAX_SHORT_CALL = 5; // a match
const SHORT_GAP = 30000; // a short call (three words or fewer, not counting the name) isn't said again sooner
const words = (t) => String(t).replace(/\{\w+\}/g, ' ').split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;
const isShort = (c) => words(c.tpl || c.text) <= 3;
const rand = (a) => a[Math.floor(Math.random() * a.length)];

class Library {
  constructor({ tts, log, now = () => Date.now() }) {
    Object.assign(this, { tts, log, now });
    this.matchUses = new Map(); // text -> times said this match
    this.seriesUsed = new Map(); // text -> when it was last said (this series)
    this.recentTpl = []; // templates said lately
    this.tplUsed = new Set(); // templates said this match
    this.past = []; // the two games before: { texts, tpls } (Sets), newest first
    this.lastCat = null;
    this.catAt = new Map(); // category -> when last said
    this.saidTotal = 0;
  }

  newMatch() { this.past = this.window(); this.matchUses = new Map(); this.tplUsed = new Set(); this.recentTpl = []; this.catAt = new Map(); this.lastCat = null; }
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

  // not said yet this match: neither the line nor its template
  // is the bank big enough to never repeat? (the 2.0 lines are recorded)
  get strict() {
    if (this._strict === undefined) this._strict = this.options(['filler_g_color', 'pbp_flow_g', 'pbp_defend_g']).length >= 20;
    return this._strict;
  }
  // the games a sentence must not come back from: this one (if anything was said) and before
  window() {
    const now = this.matchUses.size ? [{ texts: new Set(this.matchUses.keys()), tpls: new Set(this.tplUsed) }] : [];
    return [...now, ...this.past].slice(0, WINDOW - 1);
  }
  // level 0: not said in this game or the two before; 1: not said in this game; 2: said at
  // most once in this game (only when it's that or dead air)
  unused(c, level = 0) {
    const n = this.matchUses.get(c.text) || 0;
    if (isShort(c) && this.strict) return !n || (n < MAX_SHORT_CALL && this.now() - (this.seriesUsed.get(c.text) || 0) >= SHORT_GAP);
    if (isShort(c) || level >= 2 || !this.strict) return n < MAX_SHORT;
    if (n >= MAX_PER_MATCH || (c.tpl && this.tplUsed.has(c.tpl))) return false;
    if (level === 0) for (const p of this.past) if (p.texts.has(c.text) || (c.tpl && p.tpls.has(c.tpl))) return false;
    return true;
  }
  has(cats, vars) { return this.options(cats, vars).some((c) => this.unused(c, 1)); }

  // opts: maxMs / minMs (the time there is to say it), needReady (it must play right now),
  // filter(clip), order: 'first' (use the first category that has anything) or 'any',
  // fresh (nothing from the last three games), allowRepeat (a second time beats dead air)
  pick(cats, vars = {}, opts = {}) {
    let lists = this.candidates(cats, vars, opts, 0);
    // fresh: only a line not said in the last three games (filler, which there's never a need for)
    if (!lists.length && !opts.fresh) lists = this.candidates(cats, vars, opts, 1);
    if (!lists.length && opts.allowRepeat) lists = this.candidates(cats, vars, opts, 2);
    return this.choose(lists, cats, vars, opts);
  }

  candidates(cats, vars, opts, level) {
    const lists = [];
    for (const entry of cats) {
      const list = this.options([entry], vars).filter((c) => this.unused(c, level))
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
    return lists;
  }

  choose(lists, cats, vars, opts) {
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
    if (clip.tpl) { this.tplUsed.add(clip.tpl); this.recentTpl.push(clip.tpl); if (this.recentTpl.length > 14) this.recentTpl.shift(); }
    if (clip.cat) { this.catAt.set(clip.cat, this.now()); this.lastCat = clip.cat; }
    if (clip.cat && /^series_/.test(clip.cat)) this.lastSeriesAt = this.now(); // kept across matches
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
  // what survives a restart: when lines were last said this series, and the last two games
  dump() {
    return { used: [...this.seriesUsed.entries()].slice(-3000), past: this.window().map((p) => ({ texts: [...p.texts], tpls: [...p.tpls] })) };
  }
  load(saved) {
    const old = Array.isArray(saved); // 2.0 saved only the list
    this.seriesUsed = new Map((old ? saved : saved && saved.used) || []);
    this.past = old || !saved ? [] : (saved.past || []).map((p) => ({ texts: new Set(p.texts || []), tpls: new Set(p.tpls || []) })).slice(0, WINDOW - 1);
  }
}

module.exports = { Library, MAX_PER_MATCH, MAX_SHORT, isShort };
