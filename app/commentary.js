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
      for (const mo of this.model.tick()) this.moment(mo);
      this.director.tick();
    } catch (e) { this.log(`Commentary error: ${e.stack || e.message}`); }
  }

  moment(mo) {
    try {
      switch (mo.type) {
        case 'match_created':
          this.newMatch();
          // give the first state update a moment to say who's playing, then introduce the match
          clearTimeout(this.introTimer);
          this.introTimer = setTimeout(() => this.intro(), 1200);
          break;
        case 'joined_late': this.newMatch(); this.match.introDone = true; this.match.joinedLate = true; break;
        case 'match_init': if (!this.match.introDone) { clearTimeout(this.introTimer); this.introTimer = setTimeout(() => this.intro(), 400); } break;
        case 'countdown': if (!this.match.introDone && mo.first) this.intro(); break;
        case 'destroyed': if (this.series) { this.series.lastSeen = Date.now(); this.saveState(); } break;
        default: break;
      }
      this.director.onMoment(mo);
    } catch (e) { this.log(`Commentary error on ${mo.type}: ${e.stack || e.message}`); }
  }

  newMatch() {
    this.lib.newMatch();
    this.director.reset();
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
    return n;
  }

  // ------------------------------------------------- series
  // Who is on each side: the team name, or the players' names when it's just Blue/Orange.
  sideKey(n) {
    const t = W.cleanTeamName(this.model.m.teams[n], n);
    if (t && t !== (n === 1 ? 'Orange' : 'Blue')) return 'team:' + t.toLowerCase();
    const names = [...this.model.m.players.values()].filter((p) => p.team === n).map((p) => p.name.toLowerCase()).sort();
    return names.length ? 'players:' + names.join('+') : null;
  }
  matchKey() {
    const a = this.sideKey(0), b = this.sideKey(1);
    return a && b ? [a, b].sort().join(' vs ') : null;
  }
  // The same two sides meeting again within 30 minutes of the last game is the next game of a series.
  startSeriesGame() {
    const key = this.matchKey();
    const now = Date.now();
    const S = this.series;
    if (key && S && S.key === key && now - S.lastSeen < SERIES_GAP) {
      if (S.finished) { S.game++; S.finished = false; } // an abandoned game is played again as the same game
    } else {
      this.series = { key, game: 1, wins: {}, finished: false, lastSeen: now };
      this.lib.newSeries();
    }
    this.series.lastSeen = now;
    this.match.game = this.series.game;
    this.saveState();
    return this.series;
  }
  recordResult(w) {
    if (this.match.joinedLate && !this.match.game) this.startSeriesGame();
    const S = this.series;
    if (S && this.match.game && S.key === this.matchKey()) {
      const k = this.sideKey(w);
      if (k && !S.finished) S.wins[k] = (S.wins[k] || 0) + 1;
      S.finished = true;
      S.lastSeen = Date.now();
      this.saveState();
    }
  }
  seriesStatus() {
    const S = this.series;
    if (!S) return [];
    const L = (cats, vars) => this.lib.pick(cats, vars || {});
    const w = [0, 1].map((n) => S.wins[this.sideKey(n)] || 0);
    if (w[0] + w[1] === 0) return [];
    if (w[0] === w[1]) return [L([['series_level', { a: W.num(w[0]) }], 'series_tied'])];
    const lead = w[0] > w[1] ? 0 : 1;
    return [L([['series_lead', { team: this.teamName(lead) }]]), L([['series_score', { score: W.scoreWords(w[lead], w[1 - lead]) }]])];
  }
  seriesStakes() {
    const H = this.hubCtx;
    if (!H || !H.bestOf || !H.wins) return null;
    const need = Math.ceil(H.bestOf / 2);
    if (H.wins[0] === need - 1 && H.wins[1] === need - 1) return this.lib.pick(['series_decider']);
    if (H.wins[0] === need - 1 || H.wins[1] === need - 1) return this.lib.pick(['series_matchpoint']);
    return null;
  }

  // what RL Career Hub says about this match (null without it)
  hubContext() {
    if (!this.hub) return null;
    try {
      const m = this.model.m;
      const players = [...m.players.values()].map((p) => ({ name: p.name, team: p.team }));
      const ctx = this.hub.contextFor({ teams: [W.cleanTeamName(m.teams[0], 0), W.cleanTeamName(m.teams[1], 1)], players });
      if (ctx) this.log(`RL Career Hub: ${ctx.describe}`);
      return ctx;
    } catch (e) { this.log(`RL Career Hub: could not read the season (${e.message}).`); return null; }
  }

  // ------------------------------------------------- the intro
  // There are only a few seconds before the first kickoff, so the intro is one or two lines;
  // the rest (the teams, a player to watch, form, the series) becomes stories for the first lulls.
  intro() {
    if (this.match.introDone) return;
    this.match.introDone = true;
    const m = this.model.m;
    if (m.stateReplay) return;
    this.hubCtx = this.hubContext();
    this.director.ctx.hub = this.hubCtx;
    const H = this.hubCtx;
    const S = this.startSeriesGame();
    if (H && H.game) {
      // RL Career Hub knows the series: trust its game number and score over our own guess
      S.game = H.game; this.match.game = H.game;
      if (H.wins) S.wins = { [this.sideKey(0)]: H.wins[0], [this.sideKey(1)]: H.wins[1] };
      if (H.seriesId && S.hubId !== H.seriesId) { S.hubId = H.seriesId; if (H.game === 1) this.lib.newSeries(); }
      this.saveState();
    }
    const D = this.director;
    const L = (cats, vars, opts) => this.lib.pick(cats, vars || {}, opts || {});
    const T0 = { team: this.teamName(0) }, T1 = { team: this.teamName(1) };
    const teams = () => [L([['intro_blue', T0]]), L([['intro_orange', T1]])];
    const players = [...m.players.values()];
    const known = players.filter((p) => L([['intro_star', { name: this.name(p.name) }]]));
    const forMs = 150000;
    if (S.game > 1) {
      this.log(`Game ${S.game} of the series.`);
      D.call('intro', 90, () => [L([['intro_game', { a: W.num(S.game) }]]), ...this.seriesStatus(), this.seriesStakes()], { within: 8000 });
      if (chance(0.6)) D.topic('intro_color', 18, () => [L(['intro_color'])], { forMs });
      return;
    }
    if (H) {
      const ev = { worlds: 'intro_worlds', major: 'intro_major', open: 'intro_open', regional: 'intro_regional' }[H.kind];
      const knockout = H.stage && H.stage !== 'group';
      const opener = () => (knockout ? L([`stage_${H.stage}`]) : H.city && chance(0.5) ? L([['intro_event', { city: H.city }]]) : ev ? L([ev]) : H.stage ? L([`stage_${H.stage}`]) : L(['intro']));
      D.call('intro', 90, () => [opener()], { within: 8000 });
      D.topic('intro_teams', 29, teams, { forMs });
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
    } else {
      D.call('intro', 90, () => [L(['intro'])], { within: 8000 });
      D.topic('intro_teams', 29, teams, { forMs });
    }
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
