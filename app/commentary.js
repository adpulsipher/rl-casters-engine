'use strict';
// The commentary engine (2.0). Rocket League's Stats API messages go in; the caster talks.
//   model    - what's happening in the match (engine/model.js)
//   director - what to say and when (engine/director.js)
//   library  - which recorded line to use, and what was already said (engine/library.js)
// This file wires them together and keeps what lives longer than one match: the series
// (which game this is, who leads it), the lines said in the series, and RL Career Hub.

const fs = require('fs');
const W = require('./words');
const C = require('./engine/catalog');
const { GameModel } = require('./engine/model');
const { Library } = require('./engine/library');
const { Director } = require('./engine/director');

const chance = (p) => Math.random() < p;
const rand = (a) => a[Math.floor(Math.random() * a.length)];
const SERIES_GAP = 30 * 60 * 1000;

class Commentary {
  constructor({ tts, speaker, config, log, statePath, hub, trace }) {
    Object.assign(this, { tts, speaker, config: config || {}, log, statePath, hub: hub || null });
    this.model = new GameModel({ log });
    this.lib = new Library({ tts, log });
    this.director = new Director({ model: this.model, lib: this.lib, speaker, config: this.config, log, trace });
    this.director.ctx.teamName = (t) => this.teamName(t);
    this.director.ctx.onEnd = (w) => this.recordResult(w);
    this.series = null;
    this.hubCtx = null;
    this.match = { introDone: false };
    this.loadState();
    this.timer = setInterval(() => this.tick(), 100);
  }

  // ------------------------------------------------- series memory on disk
  // The series and the lines said in it survive a restart of the casters
  // (within 30 minutes of the last game, or the same RL Career Hub series).
  loadState() {
    if (!this.statePath) return;
    try {
      const st = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      if (!st || !st.series || Date.now() - (st.series.lastSeen || 0) > SERIES_GAP) return;
      if (!Array.isArray(st.series.sides) || !Array.isArray(st.series.wins)) return; // saved by 2.1.1 or older
      this.series = st.series;
      this.lib.load(st.used);
    } catch (e) { /* no saved series */ }
  }
  saveState() {
    if (!this.statePath) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        const tmp = this.statePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ series: this.series, used: this.lib.dump() }));
        fs.renameSync(tmp, this.statePath);
      } catch (e) { /* not worth stopping the casters for */ }
    }, 1500);
  }

  // ------------------------------------------------- events
  handle(name, d) {
    let moments;
    try { moments = this.model.handle(name, d || {}); } catch (e) { this.log(`Commentary error on ${name}: ${e.stack || e.message}`); return; }
    for (const mo of moments) this.moment(mo);
  }

  tick() {
    try {
      if (!this.match.introDone && this.match.createdAt && this.introReady()) this.intro();
      for (const mo of this.model.tick()) this.moment(mo);
      this.director.tick();
    } catch (e) { this.log(`Commentary error: ${e.stack || e.message}`); }
  }

  moment(mo) {
    try {
      switch (mo.type) {
        case 'match_created':
          // the intro waits for the players (introReady): RL Career Hub opens the match ~20 s
          // before anyone is in it
          this.newMatch();
          this.match.createdAt = Date.now();
          break;
        case 'joined_late': this.newMatch(); this.match.introDone = true; this.match.joinedLate = true; break;
        case 'match_init': if (!this.match.introDone) { clearTimeout(this.introTimer); this.introTimer = setTimeout(() => this.intro(), 300); } break;
        case 'countdown': if (!this.match.introDone && mo.first) this.intro(); break;
        case 'destroyed': if (this.series) { this.series.lastSeen = Date.now(); this.saveState(); } break;
        default: break;
      }
      this.director.onMoment(mo);
    } catch (e) { this.log(`Commentary error on ${mo.type}: ${e.stack || e.message}`); }
  }

  newMatch() {
    // the last game's result and wrap-up, if still waiting to be said (RL Career Hub starts the
    // next match seconds after the podium): they carry on over the new lobby
    const carry = this.director.queue.filter((c) => c.kind === 'end' || c.kind === 'signoff');
    this.lib.newMatch();
    this.director.reset();
    this.director.queue.push(...carry);
    this.director.ctx.teamName = (t) => this.teamName(t);
    this.director.ctx.onEnd = (w) => this.recordResult(w);
    this.hubCtx = null;
    this.match = { introDone: false };
  }

  name(n) { return n ? W.speakName(n, this.config.pronunciations) : null; }
  teamName(t) {
    const def = t === 1 ? 'Orange' : 'Blue';
    const n = W.cleanTeamName(this.model.m.teams[t], t);
    // the game only says Blue / Orange: RL Career Hub knows the real club
    if (n === def && this.hubCtx && this.hubCtx.teamNames && this.hubCtx.teamNames[t]) return this.hubCtx.teamNames[t];
    return n === def ? n : W.packTeamName(n, this.tts && this.tts.info && this.tts.info.teams);
  }

  // ------------------------------------------------- series
  // Who is on each side: the team name (when the game has a real one) and the players.
  side(n) {
    const m = this.model.m;
    const t = W.cleanTeamName(m.teams[n], n);
    const team = t && t !== (n === 1 ? 'Orange' : 'Blue') ? t.toLowerCase() : null;
    const players = [...m.players.values()].filter((p) => p.team === n).map((p) => p.name.toLowerCase()).sort();
    return { team, players };
  }
  // the same side as before: the same team name, or most of the same players (RL Career Hub
  // only names the teams a moment before kickoff, so the players are often all there is)
  static sameSide(a, b) {
    if (!a || !b) return false;
    if (a.team && b.team) return a.team === b.team;
    const n = Math.min(a.players.length, b.players.length);
    if (!n) return false;
    const common = a.players.filter((p) => b.players.includes(p)).length;
    return common >= Math.ceil(n * 0.6);
  }
  // which side of the series is blue and which orange: [0, 1], [1, 0], or null (not this series)
  sidesOf(S) {
    if (!S || !Array.isArray(S.sides)) return null;
    const cur = [this.side(0), this.side(1)];
    const same = Commentary.sameSide;
    if (same(S.sides[0], cur[0]) && same(S.sides[1], cur[1])) return [0, 1];
    if (same(S.sides[1], cur[0]) && same(S.sides[0], cur[1])) return [1, 0];
    return null;
  }
  // learn the team names and players as they come in
  noteSides() {
    const S = this.series, map = this.match.map;
    if (!S || !map) return;
    for (const n of [0, 1]) {
      const cur = this.side(n), mine = S.sides[map[n]];
      if (cur.team) mine.team = cur.team;
      if (cur.players.length) mine.players = cur.players;
    }
  }
  newSeries(now = Date.now()) {
    this.series = { sides: [this.side(0), this.side(1)], game: 1, wins: [0, 0], finished: false, lastSeen: now };
    this.match.map = [0, 1];
    this.lib.newSeries();
    return this.series;
  }
  // The same two sides meeting again within 30 minutes of the last game is the next game of a series.
  startSeriesGame() {
    const now = Date.now();
    const S = this.series;
    const map = S && now - S.lastSeen < SERIES_GAP ? this.sidesOf(S) : null;
    if (map) {
      this.match.map = map;
      if (S.finished) { S.game++; S.finished = false; } // an abandoned game is played again as the same game
    } else this.newSeries(now);
    this.series.lastSeen = now;
    this.match.game = this.series.game;
    this.saveState();
    return this.series;
  }
  // series wins, blue and orange
  winsNow() {
    const S = this.series, map = this.match.map;
    return S && map ? [S.wins[map[0]] || 0, S.wins[map[1]] || 0] : [0, 0];
  }
  recordResult(w) {
    if (this.match.joinedLate && !this.match.game) this.startSeriesGame();
    const S = this.series;
    if (S && this.match.game && this.match.map) {
      this.noteSides();
      if (!S.finished && (w === 0 || w === 1)) S.wins[this.match.map[w]]++;
      S.finished = true;
      S.lastSeen = Date.now();
      this.director.ctx.series = this.seriesCtx(true);
      this.saveState();
    }
  }
  // what the director knows about the series: the game, best of, wins (blue, orange)
  seriesCtx(after = false) {
    const S = this.series;
    if (!S) return null;
    const H = this.hubCtx;
    return { game: S.game, bestOf: (H && H.bestOf) || null, wins: this.winsNow(), after };
  }
  seriesStatus() {
    const S = this.series;
    if (!S) return [];
    const L = (cats, vars) => this.lib.pick(cats, vars || {});
    const w = this.winsNow();
    if (w[0] + w[1] === 0) return [];
    if (w[0] === w[1]) return [L([['series_level', { a: W.num(w[0]) }], 'series_tied'])];
    const lead = w[0] > w[1] ? 0 : 1;
    return [L([['series_lead', { team: this.teamName(lead) }]]), L([['series_score', { score: W.scoreWords(w[lead], w[1 - lead]) }]])];
  }
  seriesStakes() {
    const H = this.hubCtx;
    const w = this.winsNow();
    if (!H || !H.bestOf) return null;
    const need = Math.ceil(H.bestOf / 2);
    if (w[0] === need - 1 && w[1] === need - 1) return this.lib.pick(['series_decider']);
    if (w[0] === need - 1 || w[1] === need - 1) return this.lib.pick(['series_matchpoint']);
    return null;
  }

  // what RL Career Hub says about this match (null without it)
  hubContext(quiet = false) {
    if (!this.hub) return null;
    try {
      const m = this.model.m;
      const players = [...m.players.values()].map((p) => ({ name: p.name, team: p.team }));
      const ctx = this.hub.contextFor({ teams: [W.cleanTeamName(m.teams[0], 0), W.cleanTeamName(m.teams[1], 1)], players });
      if (ctx && !quiet) this.log(`RL Career Hub: ${ctx.describe}`);
      return ctx;
    } catch (e) { this.log(`RL Career Hub: could not read the season (${e.message}).`); return null; }
  }

  // ------------------------------------------------- the intro
  // There are only a few seconds before the first kickoff, so the intro is one or two lines;
  // the rest (the teams, a player to watch, form, the series) becomes stories for the first lulls.
  // Ready to introduce the match: both teams have players (a lobby that's still filling
  // waits), and the team names are in, or RL Career Hub knows the teams from the players,
  // or it's been a few seconds. The first countdown or MatchInitialized start it anyway.
  introReady() {
    const M = this.match, m = this.model.m;
    const now = Date.now();
    if (now - M.createdAt < 1200) return false;
    const players = [...m.players.values()];
    if (![0, 1].every((n) => players.some((p) => p.team === n))) return false;
    if (!M.playersAt) M.playersAt = now;
    if ([0, 1].some((n) => W.cleanTeamName(m.teams[n], n) !== (n === 1 ? 'Orange' : 'Blue'))) return true;
    if (M.hubTried === undefined) M.hubTried = !!this.hubContext(true);
    return M.hubTried || now - M.playersAt >= 3000;
  }

  intro() {
    if (this.match.introDone) return;
    this.match.introDone = true;
    clearTimeout(this.introTimer);
    const m = this.model.m;
    if (m.stateReplay) return;
    this.hubCtx = this.hubContext();
    this.director.ctx.hub = this.hubCtx;
    const H = this.hubCtx;
    let S = this.startSeriesGame();
    if (H && H.game) {
      // RL Career Hub knows the series. It may not write its save until the series is over,
      // so its game number can lag ours: the larger one wins (ours counts the games we saw)
      if (H.seriesId && S.hubId && S.hubId !== H.seriesId) S = this.newSeries(); // a new fixture
      S.hubId = H.seriesId || S.hubId;
      const map = this.match.map;
      if (H.game > S.game) S.game = H.game;
      if (H.wins && H.wins[0] + H.wins[1] > S.wins[0] + S.wins[1]) { S.wins[map[0]] = H.wins[0]; S.wins[map[1]] = H.wins[1]; }
      this.match.game = S.game;
      this.saveState();
    }
    this.director.ctx.series = this.seriesCtx();
    this.director.ctx.introAt = Date.now();
    const D = this.director;
    const L = (cats, vars, opts) => this.lib.pick(cats, vars || {}, opts || {});
    const T0 = { team: this.teamName(0) }, T1 = { team: this.teamName(1) };
    const teams = () => [L([['intro_blue', T0]]), L([['intro_orange', T1]])];
    const players = [...m.players.values()];
    const known = players.filter((p) => L([['intro_star', { name: this.name(p.name) }]]));
    const forMs = 150000;
    this.log(S.game > 1 ? `Game ${S.game} of the series (${this.winsNow().join('-')}).` : 'Introducing the match.');
    if (S.game > 1) {
      // where the series stands, unless it was just said after the last game
      const fresh = Date.now() - (this.lib.lastSeriesAt || 0) > 120000;
      D.call('intro', 90, () => [L([['intro_game', { a: W.num(S.game) }]]), ...(fresh ? this.seriesStatus() : []), this.seriesStakes()], { within: 8000 });
      if (chance(0.6)) D.topic('intro_color', 18, () => [L(['intro_color'])], { forMs });
      return;
    }
    // the welcome, then the two teams, in one go before the first kickoff (2.1.2: the teams
    // were left for a lull, and two lines that long never fit one in live play)
    // "On the blue side tonight, it's Blue" says nothing: only name real teams
    const named = [0, 1].some((t) => this.teamName(t) !== (t === 1 ? 'Orange' : 'Blue'));
    const welcome = (first) => D.call('intro', 90, () => [first(named ? 4200 : 6500), ...(named ? teams() : [])], { within: 8000 });
    const O = (maxMs) => ({ maxMs, fallbackMs: 7000 });
    if (H) {
      const ev = { worlds: 'intro_worlds', major: 'intro_major', open: 'intro_open', regional: 'intro_regional' }[H.kind];
      const knockout = H.stage && H.stage !== 'group';
      welcome((ms) => (knockout ? L([`stage_${H.stage}`], {}, O(ms)) : H.city && chance(0.5) ? L([['intro_event', { city: H.city }]], {}, O(ms)) : ev ? L([ev], {}, O(ms)) : H.stage ? L([`stage_${H.stage}`], {}, O(ms)) : L(['intro'], {}, O(ms))));
      const form = (f, t) => {
        if (!f) return null;
        if (f.unbeaten && f.played >= 3) return ['form_unbeaten'];
        if (f.won >= 2) return [['form_streak', { streak: W.num(Math.min(f.won, 8)) }]];
        if (f.lost >= 2) return [['form_slump', { streak: W.num(Math.min(f.lost, 8)) }]];
        return null;
      };
      [0, 1].forEach((t) => {
        const f = form(H.form && H.form[t], t);
        // the form line follows the team's name so it's clear who it's about
        if (f) D.topic('form' + t, 23, () => [L([[t === 0 ? 'intro_blue' : 'intro_orange', t === 0 ? T0 : T1]]), L(f)], { forMs });
      });
      if (knockout && H.bestOf > 1) D.topic('bestof', 22, () => [L([['intro_bestof', { bestof: W.num(H.bestOf) }]])], { forMs });
      if (H.table === 'top') D.topic('table', 21, () => [L(['table_top'])], { forMs });
      else if (H.table === 'close') D.topic('table', 21, () => [L(['table_close'])], { forMs });
      if (H.metBefore) D.topic('h2h', 21, () => [L(['h2h_revenge'])], { forMs });
    } else welcome((ms) => L(['intro'], {}, O(ms)));
    if (known.length && chance(0.7)) {
      const p = rand(known);
      D.topic('intro_star', 19, () => [L([['intro_star', { name: this.name(p.name) }]])], { forMs });
    }
    if (chance(0.5)) D.topic('intro_color', 18, () => [L(['intro_color'])], { forMs });
  }

  close() { clearInterval(this.timer); clearTimeout(this.introTimer); clearTimeout(this.saveTimer); }

  // ------------------------------------------------- for the studio and live voices
  static studioSpec() { return C.studioSpec(); }

  // live voices: lines that never change; rendered once, kept forever
  static genericLines() {
    const out = [];
    for (const [cat, list] of Object.entries(C.LINES)) {
      for (const tpl of list) {
        const clip = (text) => ({ role: C.roleOf(cat), mood: C.moodOf(cat), text });
        if (!/\{/.test(tpl)) { out.push(clip(C.fill(tpl, {}))); continue; }
        if (/\{team\}/.test(tpl)) for (const team of ['Blue', 'Orange']) out.push(clip(C.fill(tpl, { team })));
      }
    }
    return out;
  }

  // every ordinary word in the line bank (used to check recordings; names are left out)
  static vocabulary() {
    const v = new Set();
    for (const list of Object.values(C.LINES)) for (const t of list) {
      for (const w of t.replace(/\{\w+\}/g, ' ').toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/)) if (w.length > 1) v.add(w);
    }
    for (const n of ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'nothing', 'all', 'twenty', 'thirty', 'forty',
      'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'seconds', 'minute', 'kilometers', 'miles', 'hour', 'hundred', 'and']) v.add(n);
    return v;
  }
}

module.exports = { Commentary, fill: C.fill, roleOf: C.roleOf, moodOf: C.moodOf, tidy: C.tidy };
