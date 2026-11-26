'use strict';
// The director: what the caster says, and when. Two kinds of speech:
//
// 1. Calls: answers to something that just happened (a goal, a save, a shot, a pass...).
//    Each has a priority and a deadline. A call that can't start in time is dropped - a
//    late call is worse than none - and a big enough call cuts in over a smaller line.
// 2. Flow: what fills the rest, at broadcast pace. Touch-by-touch naming of who's on the
//    ball, the pressure, the clock; colour and stories (form, stats, momentum) when the
//    play is calm; replay analysis after goals. The calmer the play, the longer the line
//    it allows; with the ball near a goal only short lines start.
//
// Every line goes through the library, which never lets a line be said three times in
// a match, and prefers a repeat to silence.

const W = require('../words');
const C = require('./catalog');

const rand = (a) => a[Math.floor(Math.random() * a.length)];
const chance = (p) => Math.random() < p;
const between = (a, b) => a + Math.random() * (b - a);

// how much talking: 'normal' is broadcast pace (the caster talks most of the time)
const PACE = {
  normal: { gap: [250, 650], colorEvery: 6500, ratio: 0.65, minPrio: 0, flow: 1 },
  chatty: { gap: [150, 450], colorEvery: 5000, ratio: 0.75, minPrio: 0, flow: 1.2 },
  quiet: { gap: [900, 2000], colorEvery: 15000, ratio: 0.4, minPrio: 31, flow: 0.5 },
  sparse: { gap: [2500, 5000], colorEvery: 40000, ratio: 0.2, minPrio: 45, flow: 0.15 },
};

// the generic lines that describe a particular situation: only said when it's true
const FLOW_WHEN = {
  'Back in the middle.': (t) => Math.abs(t.x) < 1600 && Math.abs(t.y) < 1600,
  'Back to the defense.': (t) => t.zone === 'def',
  'Up the field it goes.': (t) => t.zone === 'def' && t.speed > 1400,
  'Into the corner.': (t) => Math.abs(t.x) > 2400 && Math.abs(t.y) > 3400,
  'Off the back wall.': (t) => t.surface === 'wall' && Math.abs(t.y) > 4600,
  'Loose ball.': (t, d) => d.fiftyRecent,
  'Settling it down now.': (t) => t.speed < 1100 && t.chain >= 2,
  'Resetting the play.': (t) => t.zone !== 'att' && t.speed < 1300,
  'Working it around.': (t) => t.chain >= 3,
  'Looking for an opening.': (t) => t.zone === 'att' && t.chain >= 2,
};

class Director {
  constructor({ model, lib, speaker, config, log, now = () => Date.now(), trace = null }) {
    Object.assign(this, { model, lib, speaker, config: config || {}, log, now, trace });
    this.pace = PACE[this.config.chatter] || PACE.normal;
    this.reset();
  }

  reset() {
    this.queue = [];
    this.topics = [];
    this.at = { name: 0, pbp: 0, color: 0, flow: 0 };
    this.kindAt = new Map();
    this.nextGap = this.gap();
    this.goalCtx = null;
    this.ctx = { intro: null, series: null };
    this.speech = []; // [start, end] of what was said, for the talk ratio
    this.fiftyAt = 0;
  }

  gap() { return between(this.pace.gap[0], this.pace.gap[1]); }
  name(n) { return n ? W.speakName(n, this.config.pronunciations) : null; }
  teamName(t) { return this.ctx.teamName ? this.ctx.teamName(t) : this.model.m.teams[t] || (t === 1 ? 'Orange' : 'Blue'); }
  since(kind) { const t = this.kindAt.get(kind); return t ? this.now() - t : Infinity; }

  // a line from these categories (best first), or null
  line(cats, vars, opts = {}) { return this.lib.pick(cats, vars || {}, opts); }

  // ------------------------------------------------------------------ calls
  // within: ms it may wait to start; cut: it may cut in over a line of this priority or lower
  call(kind, prio, make, { within = 1500, cut = -1, protect = false, key = kind, gap = 0 } = {}) {
    if (prio < this.pace.minPrio && prio < 50) return;
    const now = this.now();
    this.queue = this.queue.filter((c) => c.key !== key);
    this.queue.push({ kind, prio, make, at: now, deadline: now + within, cut, protect, key, gap });
    this.pump();
  }

  // a topic: something worth saying in the next lull (form, a stat, momentum)
  topic(key, prio, make, { forMs = 60000, valid = null } = {}) {
    if (this.topics.some((t) => t.key === key)) return;
    this.topics.push({ key, prio, make, until: this.now() + forMs, valid });
  }

  // start the most important call that's due, cutting in if it's worth it
  pump() {
    const now = this.now();
    for (const c of this.queue) if (now > c.deadline) this.dropped(c, 'late');
    this.queue = this.queue.filter((c) => now <= c.deadline);
    if (!this.queue.length) return false;
    this.queue.sort((a, b) => b.prio - a.prio || a.at - b.at);
    const cur = this.speaker.current;
    for (const c of this.queue) {
      if (cur) {
        const u = cur.utt;
        if (u.protect || c.cut < u.prio || c.prio <= u.prio) continue;
        if (this.start(c, true)) return true;
      } else {
        if (c.gap && now - this.speaker.lastSpokeAt < c.gap) continue;
        if (this.start(c, false)) return true;
      }
    }
    return false;
  }

  start(c, cutting) {
    this.queue = this.queue.filter((q) => q !== c);
    let clips;
    try { clips = (c.make() || []).filter(Boolean); } catch (e) { this.log(`Director: ${c.kind}: ${e.stack || e.message}`); clips = []; }
    if (!clips.length) { this.dropped(c, 'no line'); return false; }
    if (cutting) {
      const cur = this.speaker.current;
      if (this.trace) this.trace('cut', { by: c.kind, prio: c.prio, cut: cur && cur.utt.kind });
      this.speaker.cut(140);
    }
    this.say(c.kind, c.prio, clips, { protect: c.protect, latency: this.now() - c.at });
    return true;
  }

  dropped(c, why) {
    if (this.trace) this.trace('drop', { kind: c.kind, why, prio: c.prio });
    // a save that couldn't be called in time gets a word in the next lull
    if (c.kind === 'save' && why === 'late' && c.saver && this.model.live()) {
      const N = { name: this.name(c.saver) };
      this.topic('save_late', 31, () => [this.line([['save_late', N], 'save_react_g'])], { forMs: 6000 });
    }
  }

  say(kind, prio, clips, { protect = false, latency = 0 } = {}) {
    const started = this.now();
    this.kindAt.set(kind, started);
    const utt = {
      kind, prio, protect, clips,
      onClip: (clip) => {
        this.lib.said(clip);
        if (this.trace) this.trace('say', { kind, prio, clip, latency });
      },
      onDone: () => {
        this.speech.push([started, this.now()]);
        if (this.speech.length > 200) this.speech.shift();
        this.nextGap = this.gap();
      },
    };
    this.speaker.speak(utt);
  }

  // share of the last 30 s spent talking
  talkRatio() {
    const now = this.now(), from = now - 30000;
    let t = 0;
    for (const [a, b] of this.speech) if (b > from) t += b - Math.max(a, from);
    const cur = this.speaker.current;
    if (cur && cur.clipAt) t += now - Math.max(cur.clipAt, from);
    return t / 30000;
  }

  // ------------------------------------------------------------------ moments
  onMoment(mo) {
    const M = this.model;
    const m = M.m;
    const close = M.isClose();
    switch (mo.type) {
      case 'match_created': case 'joined_late': break;
      case 'countdown': {
        this.queue = this.queue.filter((c) => c.prio >= 90); // nothing from the last play is worth saying now
        { const cur = this.speaker.current; if (cur && ['replay', 'topic', 'color', 'celebrate'].includes(cur.utt.kind)) cur.utt.trim = true; } // finish the sentence, then stop
        if (mo.overtime && !m.otCalled) { m.otCalled = true; return this.call('overtime', 90, () => [this.line(['ot']), this.line(['ot_color'], {}, { maxMs: 5000 })], { within: 4000, cut: 60, protect: true }); }
        if (!mo.first) this.call('restart', this.scoreDue ? 38 : 30, () => [this.restartLine()], { within: this.scoreDue ? 2000 : 900, gap: 250 });
        break;
      }
      case 'overtime': break; // called at the overtime kickoff (above)
      case 'kickoff_go':
        if (!chance(0.75 * this.pace.flow)) break;
        this.call('kickoff_go', 44, () => [this.line(['kickoff_go', 'kickoff'], {}, { maxMs: 2300 })], { within: 600 });
        break;
      case 'kickoff_result': {
        if (!mo.even) {
          const T = { team: this.teamName(mo.team) };
          const N = { name: this.name(mo.name) };
          this.call('kickoff_result', 40, () => [this.line(mo.name && chance(0.5) ? [['kickoff_won_name', N], ['kickoff_won', T]] : [['kickoff_won', T], ['kickoff_won_name', N]], {}, { maxMs: 3100 })], { within: 800, cut: 30 });
        }
        break;
      }
      case 'touch': this.onTouch(mo); break;
      case 'pass':
        if (this.since('pass') < 7000 || !close) break;
        this.call('pass', 36, () => [this.line(chance(0.45) ? [['pbp_pass', { name: this.name(mo.from) }], 'pbp_pass_g'] : ['pbp_pass_g', ['pbp_pass', { name: this.name(mo.from) }]], {}, { maxMs: this.maxMs(1900) })], { within: 650, gap: 150 });
        break;
      case 'clear':
        if (this.since('clear') < 6000) break;
        this.call('clear', 36, () => [this.line(chance(0.5) ? [['pbp_clear', { name: this.name(mo.name) }], ['bighit_clear', { name: this.name(mo.name) }], 'pbp_clear_g'] : ['pbp_clear_g', ['pbp_clear', { name: this.name(mo.name) }]], {}, { maxMs: 2800 })], { within: 650, gap: 150 });
        break;
      case 'fifty':
        this.fiftyAt = this.now();
        if (this.since('fifty') < 8000) break;
        this.call('fifty', 37, () => [this.line(['pbp_fifty_g'], {}, { maxMs: 2300 })], { within: 450 });
        break;
      case 'turnover':
        break; // folded into the touch call
      case 'counter':
        if (this.since('counter') < 15000) break;
        this.call('counter', 38, () => [this.line(chance(0.5) ? [['pbp_transition', { team: this.teamName(mo.team) }], 'pbp_transition_g'] : ['pbp_transition_g', ['pbp_transition', { team: this.teamName(mo.team) }]], {}, { maxMs: 2600 })], { within: 800 });
        break;
      case 'dribble':
        if (this.since('dribble') < 12000) break;
        this.call('dribble', 33, () => [this.line([['pbp_dribble', { name: this.name(mo.name) }]], {}, { maxMs: 2600 })], { within: 700 });
        break;
      case 'flick':
        this.call('flick', 41, () => [this.line(['pbp_flick_g'], {}, { maxMs: 1900 })], { within: 450, cut: 30 });
        break;
      case 'rebound':
        this.call('rebound', 55, () => [this.line(['rebound_g'], {}, { maxMs: 1800 })], { within: 450, cut: 36 });
        break;
      case 'pressure':
        if (this.since('pressure') < 18000) break;
        this.call('pressure', 32, () => [this.line(chance(0.5) ? [['pbp_pressure', { team: this.teamName(mo.team) }], 'pbp_pressure_g'] : ['pbp_pressure_g', ['filler_pressure', { team: this.teamName(mo.team) }]], {}, { maxMs: this.maxMs(3000) })], { within: 1500 });
        break;
      case 'shot': this.onShot(mo); break;
      case 'save': this.onSave(mo); break;
      case 'crossbar':
        if (this.since('crossbar') < 6000) break;
        this.call('crossbar', 72, () => [this.line(chance(0.7) ? [['crossbar', { name: this.name(mo.name) }], 'crossbar_generic', 'close_g'] : ['close_g', 'crossbar_generic'], {}, { maxMs: 3200, fallbackMs: 5200 })], { within: 700, cut: 60 });
        this.topic('close_react', 24, () => [this.line(['close_react_g'])], { forMs: 7000 });
        break;
      case 'demo': this.onDemo(mo); break;
      case 'goal': this.onGoal(mo); break;
      case 'replay_start': this.onReplay(); break;
      case 'replay_will_end': this.topics = this.topics.filter((t) => !t.key.startsWith('replay')); break;
      case 'clock_mark': this.onClock(mo.mark); break;
      case 'zero': {
        if (M.scoreDiff() > 1) break;
        this.call('zero', 85, () => [this.line(['zero_g'])], { within: 1200, cut: 60 });
        break;
      }
      case 'ot_mark': {
        const cat = mo.mark === 60 ? 'ot_1min' : mo.mark === 120 ? 'ot_2min' : 'ot_long';
        this.call('ot_mark', 34, () => [this.line([cat, 'ot_long'], {}, { maxMs: this.maxMs(3000) })], { within: 5000 });
        break;
      }
      case 'match_end': this.onEnd(mo); break;
      case 'podium': {
        const color = this.endColor; this.endColor = null;
        this.call('signoff', 60, () => [color && this.line(color), this.line(['signoff'])], { within: 9000, gap: 400 });
        break;
      }
      case 'destroyed': this.queue = []; this.topics = []; this.speaker.stopAll(); break;
      default: break;
    }
  }

  // the longest line worth starting now: short with the ball near a goal, long when it's calm
  maxMs(cap = 7000) {
    const d = this.model.danger();
    const w = d >= 0.8 ? 2000 : d >= 0.62 ? 2700 : d >= 0.45 ? 3900 : 6500;
    return Math.min(cap, w);
  }

  onTouch(t) {
    const N = { name: this.name(t.name) };
    if (!this.model.isClose() && !chance(0.4)) return;
    if (t.kinds.includes('ceiling')) return this.call('ceiling', 38, () => [this.line(['pbp_ceiling_g'], {}, { maxMs: 2000 })], { within: 500 });
    if (t.kinds.includes('aerial') && t.zone !== 'def' && this.since('aerial') > 9000) {
      return this.call('aerial', 35, () => [this.line(chance(0.6) ? [['aerial', N], 'pbp_aerial_g'] : ['pbp_aerial_g', ['aerial', N]], {}, { maxMs: this.maxMs(2000) })], { within: 550 });
    }
    if (t.kinds.includes('wall') && this.since('wall') > 10000 && t.zone !== 'def') {
      return this.call('wall', 31, () => [this.line(chance(0.5) ? [['pbp_wall', N], 'pbp_wall_g'] : ['pbp_wall_g', ['pbp_wall', N]], {}, { maxMs: 2400 })], { within: 550 });
    }
    if (t.speed >= 3400 && t.zone === 'att' && this.since('bighit') > 20000) {
      return this.call('bighit', 39, () => [this.line([['bighit_attack', N]], {}, { maxMs: 2600 })], { within: 450 });
    }
    if (t.kinds.includes('turnover') && this.since('turnover') > 9000 && chance(0.5)) {
      // winning it back in your own third is good defending
      const cats = t.zone === 'def' ? ['pbp_defend_g', 'pbp_turnover_g'] : ['pbp_turnover_g'];
      return this.call('turnover', 34, () => [this.line(cats, {}, { maxMs: 1900 })], { within: 500 });
    }
  }

  onShot(s) {
    // most shots are saved or scored within a second: a short call, and only if there's time
    if (s.eta !== null && s.eta < 650) return;
    if (!this.model.isClose() && !chance(0.3)) return;
    const room = s.eta ? Math.max(1100, s.eta + 300) : 1800;
    const N = { name: this.name(s.name) };
    this.call('shot', 60, () => [this.line(chance(0.6) ? [['shot', N], 'shot_g'] : ['shot_g', ['shot', N]], {}, { maxMs: Math.min(2300, room) })], { within: 300 });
  }

  onSave(s) {
    const M = this.model;
    const N = { name: this.name(s.name) };
    const close = M.isClose();
    if (!close && !s.big) return; // a blowout: only the ones off the line
    let make;
    if (s.big) make = () => [this.line([['epicsave', N], 'epicsave_generic', ['save', N], 'save_g_short'], {}, { maxMs: 4600, fallbackMs: 6000 })];
    else if (s.again && chance(0.6)) make = () => [this.line(['save_again', ['save', N], 'save_g_short'], {}, { maxMs: this.maxMs(3300), fallbackMs: 5500 })];
    else make = () => [this.line(chance(0.55) ? [['save', N], 'save_generic', 'save_g_short'] : ['save_generic', 'save_g_short', ['save', N]], {}, { maxMs: Math.max(2200, this.maxMs(3300)), fallbackMs: 5500 })];
    this.call('save', s.big ? 80 : 75, make, { within: 800, cut: 60 });
    const q = this.queue.find((c) => c.kind === 'save'); if (q) q.saver = s.name;
    if (s.big) this.topic('save_react', 26, () => [this.line(['save_react_g'])], { forMs: 7000 });
    if (close && s.name && s.n) {
      const stat = this.saveStat(s.name, s.n);
      if (stat) this.topic('save_stat', 25, () => [this.line(...stat)], { forMs: 12000 });
      if (s.n === 3 || s.n === 5) this.topic('filler_saves', 22, () => [this.line([['filler_saves', N]])], { forMs: 40000 });
    }
  }

  saveStat(name, n) {
    const hub = this.ctx.hub;
    const season = hub && hub.seasonSaves ? hub.seasonSaves(name) : null;
    if (season !== null && season !== undefined && C.SEASON_MARKS.includes(season + n) && season + n >= 10) return [[['season_saves', { season: W.num(season + n) }]]];
    if (n >= 3 && n <= 9) return [[['stat_saves', { saves: W.num(n) }]]];
    return null;
  }

  onDemo(d) {
    const M = this.model;
    if (!d.live) return; // after a goal: not worth a call
    const close = M.isClose();
    if (!close && !chance(0.3)) return;
    const att = { name: this.name(d.att) }, vic = { name: this.name(d.vic) };
    const n = d.att ? M.stat(d.att, 'demos') : 0;
    const prio = close ? 50 : 30;
    this.call('demo', prio, () => {
      const first = this.line(chance(0.35) ? [['demo_victim', vic], ['demo', att], 'demo_generic', 'demo_g_short'] : [['demo', att], ['demo_victim', vic], 'demo_generic', 'demo_g_short'], {}, { maxMs: this.maxMs(2600), fallbackMs: 4800 });
      return [first];
    }, { within: 1100, cut: 25 });
    if (d.down >= 1 && M.m.teamSize >= 2 && close && chance(0.5)) this.call('numbers', 33, () => [this.line(['demo_numbers_g'], {}, { maxMs: 2600 })], { within: 2500, gap: 200 });
    if (n >= 2 && n <= 5) this.topic('stat_demos' + n, 23, () => [this.line([['stat_demos', { demos: W.num(n) }], ['filler_demos', att]])], { forMs: 20000 });
  }

  // ------------------------------------------------------------------ goals
  scoreCats(team, before, after, late) {
    const other = 1 - team;
    if (after[0] + after[1] === 1) return ['score_first'];
    if (after[team] > after[other]) {
      if (before[team] === before[other]) return late ? ['score_late_lead', 'score_take_lead'] : ['score_take_lead'];
      return ['score_extend'];
    }
    if (after[team] === after[other]) return late ? ['score_late_tie', 'score_equalize'] : ['score_equalize'];
    return ['score_pull_back'];
  }
  scoreText(s) { return W.scoreWords(Math.max(s[0], s[1]), Math.min(s[0], s[1])); }
  scoreLineFor(after) {
    if (after[0] + after[1] <= 1) return null;
    if (after[0] === after[1]) return ['score_tie', { a: W.num(after[0]) }];
    return ['score_now', { score: this.scoreText(after) }];
  }
  stakes(g) {
    if (g.overtime) return 'normal';
    const lb = g.before[g.team] - g.before[1 - g.team], la = g.after[g.team] - g.after[1 - g.team];
    if (Math.min(Math.abs(lb), Math.abs(la)) <= 2) return 'normal';
    return la > 0 ? 'rout' : 'consolation';
  }

  onGoal(g) {
    const M = this.model;
    this.queue = [];
    this.topics = this.topics.filter((t) => !/^(save|close|stat_demos)/.test(t.key));
    const scorer = this.name(g.scorer);
    const T = { team: this.teamName(g.team) };
    const stakes = this.stakes(g);
    g.stakes = stakes;
    this.goalCtx = { ...g, scorerSpoken: scorer, assistSpoken: this.name(g.assister), analysed: false };
    const sl = this.scoreLineFor(g.after);
    const make = () => {
      if (g.overtime) return [this.line([['goal_ot', { name: scorer }], 'goal_ot_generic', 'goal_g_short', ['goal', { name: scorer }], 'goal_generic'])];
      if (g.own) return [this.line(['goal_own_g', 'goal_g_short', 'goal_generic']), this.line(this.scoreCats(g.team, g.before, g.after, g.late), T)];
      if (stakes === 'rout') return [this.line([['goal_rout', { name: scorer }], 'goal_rout_generic', 'goal_g_short', 'goal_generic']), this.line([['score_rout', T], ['score_extend', T]])];
      if (stakes === 'consolation') return [this.line([['goal_consolation', { name: scorer }], 'goal_consolation_generic', 'goal_g_short', 'goal_generic']), this.line([['score_consolation', T]])];
      return [this.line([['goal', { name: scorer }], 'goal_generic', 'goal_g_short']), this.line(this.scoreCats(g.team, g.before, g.after, g.late), T)];
    };
    this.call('goal', 100, make, { within: 1500, cut: 99, protect: true });
    if (g.overtime) return;
    this.scoreDue = sl; // said at the restart
    // the story of the game, for the lulls that follow
    const goals = M.m.goals;
    const run = (() => { let n = 0; for (let i = goals.length - 1; i >= 0 && goals[i].team === g.team; i--) n++; return n; })();
    const diffBefore = g.before[1 - g.team] - g.before[g.team];
    if (stakes === 'normal' && diffBefore >= 1 && g.after[g.team] >= g.after[1 - g.team] && goals.length >= 3 && M.m.goals.slice(0, -1).some((x, i, a) => { const sc = [0, 0]; for (const y of a.slice(0, i + 1)) sc[y.team]++; return sc[1 - g.team] - sc[g.team] >= 2; }))
      this.topic('comeback', 34, () => [this.line(['comeback'], T)], { forMs: 15000, valid: () => this.model.m.goals.length === goals.length });
    const nGoals = goals.length;
    const still = () => this.model.m.goals.length === nGoals; // nobody has scored since
    if (run >= 3 && run <= 6) this.topic('unanswered', 30, () => [this.line([['unanswered', { run: W.num(run) }], ['momentum_run', T]])], { forMs: 25000, valid: still });
    else if (run === 2 && goals.length >= 3) this.topic('momentum', 28, () => [this.line([['momentum_run', T]])], { forMs: 25000, valid: still });
    const lead = g.after[g.team] - g.after[1 - g.team];
    if (lead >= 2 && stakes !== 'rout') this.topic('leading', 20, () => [this.line([['filler_leading', T]])], { forMs: 60000, valid: () => { const sc = this.model.m.score; return sc[g.team] - sc[1 - g.team] >= 2; } });
  }

  onReplay() {
    const g = this.goalCtx;
    if (!g || g.analysed || this.now() - g.at > 20000) return;
    g.analysed = true;
    const N = { name: g.scorerSpoken };
    const big = g.stakes === 'normal';
    const cats = [];
    if (g.hattrick && big) cats.push(['an_hattrick', N]);
    for (const t of ['bicycle', 'turtle', 'backwards', 'aerial', 'long']) if (g.types.has(t) && (big || !['bicycle', 'turtle'].includes(t))) cats.push([`an_${t}`, N]);
    const build = { counter: 'goal_counter_g', pressure: 'goal_pressure_g', solo: 'goal_solo_g', team: 'goal_team_g' }[g.buildup];
    if (build && chance(0.45)) cats.push(build);
    if (g.speed >= 2900 && chance(0.5)) cats.push(['an_speed', { speed: W.speedWords(g.speed, this.config.units) }]);
    if (g.assistSpoken && chance(0.55)) cats.push(['an_assist', { name: g.assistSpoken }]);
    cats.push(['an_named', N], 'an_generic');
    const opener = this.model.m.goalReplay && chance(0.3) ? this.line(['an_replay_g'], {}, { maxMs: 2600 }) : null; // only with the replay on screen
    this.call('replay', 40, () => [opener, this.line(cats, {}, { maxMs: 6000, fallbackMs: 8000 })], { within: 9000, gap: 300, cut: 28 });
    const stat = big ? this.goalStat(g) : null;
    if (stat) this.topic('replay_stat', 33, () => [this.line(...stat)], { forMs: 15000 });
  }

  goalStat(g) {
    const hub = this.ctx.hub;
    const season = hub && g.scorer && hub.seasonGoals ? hub.seasonGoals(g.scorer) : null;
    if (season !== null && season !== undefined) {
      const total = season + g.goals;
      if (C.SEASON_MARKS.includes(total)) return [[['season_goals', { season: W.num(total) }]]];
      if (total >= 5 && hub.topScorer && hub.topScorer(g.scorer, g.goals) && chance(0.5)) return [['season_top_scorer']];
    }
    if (g.goals >= 2 && g.goals <= 6 && !g.hattrick) return [[['stat_goals', { goals: W.num(g.goals) }]]];
    if (g.assister && g.assists >= 2 && g.assists <= 5) return [[['stat_assists', { assists: W.num(g.assists) }]]];
    return null;
  }

  // ------------------------------------------------------------------ the clock
  onClock(mark) {
    const M = this.model;
    const s = M.m.score, diff = M.scoreDiff();
    const lead = M.leader();
    let cats = null, prio = 50;
    if (mark === 120) cats = diff === 0 ? ['t120_tie', 't120_g'] : diff === 1 ? [['t120_close', { team: this.teamName(lead) }], 't120_g'] : ['t120_g'];
    else if (mark === 60) cats = diff === 0 ? (s[0] === 0 ? ['t60_nil'] : [['t60_tie', { a: W.num(s[0]) }]]) : diff === 1 ? [['t60_close', { team: this.teamName(lead) }]] : [['t60_big', { team: this.teamName(lead) }]];
    else if (mark === 30 && diff <= 1) cats = diff === 0 ? [['t30_tie', { a: W.num(s[0]) }]] : [['t30_close', { team: this.teamName(lead) }]];
    else if (mark === 10 && diff <= 1) { prio = 56; cats = diff === 0 ? [['t10_tie', { a: W.num(s[0]) }]] : [['t10_close', { team: this.teamName(1 - lead) }]]; }
    else if (mark === 5 && diff <= 1) { prio = 58; cats = ['t5_g']; }
    if (!cats) return;
    if (mark === 120 && diff >= 2) return; // nothing to say about two minutes left in a blowout
    this.call('clock', prio, () => [this.line(cats, {}, { maxMs: mark <= 10 ? 2000 : 4200, fallbackMs: mark <= 10 ? 3200 : 5600 })], { within: mark <= 10 ? 900 : 2500, cut: mark <= 10 ? 36 : 25 });
    if (mark === 120 && diff >= 1) {
      const behind = 1 - lead;
      this.topic('need_goal', 27, () => [this.line([['need_goal', { team: this.teamName(behind) }], ['filler_trailing', { team: this.teamName(behind) }]])],
        { forMs: 50000, valid: () => this.model.leader() === 1 - behind });
    }
  }

  restartLine() {
    const M = this.model;
    const s = M.m.score;
    if (M.m.time === 0 && !M.m.overtime) return null;
    // after a goal: the score
    if (this.scoreDue) {
      const sl = this.scoreDue; this.scoreDue = null;
      const lead = M.leader();
      const c = lead < 0 ? this.line([['kickoff_tie', { a: W.num(s[0]) }]], {}, { maxMs: 2700 })
        : this.line([['score_now', sl[1]], ['kickoff_lead', { team: this.teamName(lead) }]], {}, { maxMs: 2700 });
      if (c) return c;
    }
    if (s[0] + s[1] > 0 && chance(0.4)) {
      if (s[0] === s[1]) return this.line([['kickoff_tie', { a: W.num(s[0]) }], 'kickoff_ready'], {}, { maxMs: 2600 });
      return this.line([['kickoff_lead', { team: this.teamName(M.leader()) }], 'kickoff_ready'], {}, { maxMs: 2600 });
    }
    return chance(0.6) ? this.line(['kickoff_ready', 'kickoff'], {}, { maxMs: 2600, fallbackMs: 4200 }) : null;
  }

  // ------------------------------------------------------------------ the end
  onEnd(e) {
    const M = this.model;
    const s = M.m.score;
    const w = e.winner;
    const diff = Math.abs(s[0] - s[1]);
    const players = [...M.m.players.values()].filter((p) => p.team === w).sort((a, b) => b.score - a.score);
    const T = { team: this.teamName(w) };
    const g = this.goalCtx;
    const justCalledOt = M.m.overtime && g && this.now() - g.at < 30000;
    const cats = M.m.overtime ? (justCalledOt ? ['end'] : ['end_ot', 'end']) : diff >= 3 ? ['end_blowout', 'end'] : diff === 1 ? ['end_close', 'end'] : ['end'];
    const color = [['end_mvp', { name: players.length ? this.name(players[0].name) : null }], ['end_winner', T], ['end_loser', { team: this.teamName(1 - w) }]].sort(() => Math.random() - 0.5);
    this.queue = this.queue.filter((c) => c.kind === 'goal');
    this.topics = [];
    if (s[0] === s[1]) { this.endColor = null; return; } // no result to call (a match left early)
    this.call('end', 95, () => [this.line(cats, T), this.line([['end_score', { score: this.scoreText(s) }]])], { within: 12000, protect: true, gap: 300 });
    this.endColor = color;
    if (this.ctx.onEnd) this.ctx.onEnd(w);
  }

  // ------------------------------------------------------------------ flow
  tick() {
    if (this.pump()) return;
    if (this.speaker.busy) return;
    const M = this.model;
    const m = M.m;
    const now = this.now();
    this.topics = this.topics.filter((t) => t.until > now);
    if (this.queue.length) return; // something is waiting for its gap
    const idle = now - this.speaker.lastSpokeAt;
    switch (m.phase) {
      case 'live': if (M.live()) this.flowLive(idle); break;
      case 'replay': this.flowBreak(idle, 'replay'); break;
      case 'goal': this.flowBreak(idle, 'goal'); break;
      default: break;
    }
  }

  flowLive(idle) {
    const M = this.model, m = M.m, now = this.now();
    if (idle < this.nextGap / this.pace.flow) return;
    if (m.kickoff && !m.kickoff.resolved && now - m.kickoff.at < 6000 && idle < 2500) return; // the kickoff result is coming
    // ahead of broadcast pace: let a little air in
    if (this.talkRatio() > this.pace.ratio + 0.12 && idle < 1500) return;
    const d = M.danger();
    const maxMs = this.maxMs();
    const t = m.lastTouch;
    const close = M.isClose();
    // 1. name who's on the ball, if it's fresh and nobody's been named for a moment
    if (t && now - t.at <= 900 && now - this.at.name >= (close ? 2300 : 4500) && this.pace.flow >= 0.5) {
      const clip = this.touchLine(t, Math.min(maxMs, 2500));
      if (clip) { this.at.name = now; return this.say('pbp_touch', 30, [clip]); }
    }
    if (d >= 0.62 && idle < 2200) return; // the ball's near a goal: wait for what happens
    // 2. calm enough for a story or some colour
    if (d < 0.6 && now - this.at.color >= this.pace.colorEvery / this.pace.flow) {
      const clip = this.colourLine(maxMs) || (d < 0.5 && idle > 1500 ? this.colourLine(Math.max(maxMs, 5600)) : null);
      if (clip) { this.at.color = now; return this.say(clip.kind || 'color', 20, clip.clips); }
    }
    // 3. it's gone quiet for too long: something short and true about the play
    if (idle >= (close ? 1800 : 3200) / this.pace.flow) {
      const clip = this.fillGap(t, Math.min(maxMs, 3000)) || (d < 0.62 ? this.fillGap(t, 5600, true) : null);
      if (clip) return this.say('pbp_flow', 25, [clip]);
    }
    // 4. dead air: say something - a repeat or a longer line beats silence
    const quiet = idle >= 4500 / this.pace.flow && d < 0.62; // calm, and it's been quiet a while
    const tooQuiet = idle >= 6500 / this.pace.flow && d < 0.9; // anything but a shot on its way
    if ((quiet || tooQuiet) && this.pace.flow >= 0.5 && !(m.lastShot && now - m.lastShot.at < 1500)) {
      const c = this.colourLine(6500, true) || this.fillGap(t, 6500, true);
      if (c) { this.at.color = now; return this.say('filler', 20, c.clips || [c]); }
    }
  }

  // between plays: after the goal call, and during the replay
  flowBreak(idle, phase) {
    const now = this.now();
    if (idle < (phase === 'replay' ? 700 : 900)) return;
    const g = this.goalCtx;
    if (phase === 'goal') {
      // before the replay: a reaction, or the story of the game
      if (g && now - g.at < 6000 && g.stakes === 'normal' && !g.celebrated && chance(0.6)) {
        g.celebrated = true;
        const c = this.line(['goal_celebrate_g'], {}, { maxMs: 2600 });
        if (c) return this.say('celebrate', 26, [c]);
      }
      const tp = this.takeTopic(3500, ['comeback', 'unanswered', 'momentum']);
      if (tp) return this.say('topic', 24, tp);
      if (g && !g.analysed && now - g.at > 4500) return this.onReplay(); // no replay (skipped): analyse now
      return;
    }
    const tp = this.takeTopic(4500);
    if (tp) return this.say('topic', 24, tp);
    if (g && now - g.at < 25000 && !g.colour && chance(0.5)) {
      g.colour = true;
      const c = this.line(['filler_color', 'filler_g_color'], {}, { maxMs: 4500 });
      if (c) return this.say('color', 20, [c]);
    }
  }

  // the most important story that fits, or null
  takeTopic(maxMs, only) {
    this.topics = this.topics.filter((t) => !t.valid || t.valid());
    const list = this.topics.filter((t) => !only || only.includes(t.key)).sort((a, b) => b.prio - a.prio);
    for (const t of list) {
      let clips;
      try { clips = (t.make() || []).filter(Boolean); } catch (e) { clips = []; }
      if (!clips.length) { this.topics = this.topics.filter((x) => x !== t); continue; }
      const ms = clips.reduce((a, c) => a + (c.ms || 0), 0);
      if (ms > maxMs * 1.15) continue;
      this.topics = this.topics.filter((x) => x !== t);
      return clips;
    }
    return null;
  }

  touchLine(t, maxMs) {
    const N = { name: this.name(t.name) };
    if (t.surface === 'wall' && this.lib.sinceCat('pbp_wall') > 8000) return this.line([['pbp_wall', N], ['pbp_touch', N]], {}, { maxMs });
    if (t.surface === 'air' && t.z > 450 && t.zone !== 'def') return this.line([['aerial', N], ['pbp_touch', N], 'pbp_aerial_g'], {}, { maxMs });
    if (t.run >= 3) return this.line([['pbp_dribble', N], ['pbp_touch', N]], {}, { maxMs });
    const soft = t.post < 1000 && t.z < 300;
    return this.line(!soft || chance(0.85) ? [['pbp_touch', N], soft && 'pbp_touch_g'].filter(Boolean) : ['pbp_touch_g', ['pbp_touch', N]], {}, { maxMs });
  }

  colourLine(maxMs, any = false) {
    const M = this.model, m = M.m;
    const tp = this.takeTopic(maxMs);
    if (tp) return { kind: 'topic', clips: tp };
    if (m.overtime) { const c = this.line(['filler_ot', 'filler_g_color'], {}, { maxMs }); return c && { clips: [c] }; }
    // what the stats say about the game so far
    const players = [...m.players.values()];
    const opts = [];
    for (const p of players) {
      const N = { name: this.name(p.name) };
      if (p.goals >= 2 || p.saves >= 3 || (p.goals + p.assists >= 2)) opts.push([['color_player', N]]);
      if (p.saves >= 3) opts.push([['filler_saves', N]]);
      if (p.goals >= 2) opts.push([['filler_goals', N]]);
    }
    const shots = [0, 1].map((tm) => players.filter((p) => p.team === tm).reduce((a, p) => a + p.shots, 0));
    for (const tm of [0, 1]) if (shots[tm] - shots[1 - tm] >= 3) opts.push([['filler_shots', { team: this.teamName(tm) }]]);
    if (m.lastTouch && chance(0.3)) opts.push([['color_team', { team: this.teamName(m.chain.team >= 0 ? m.chain.team : m.lastTouch.team) }]]);
    if (opts.length && chance(0.45)) { const c = this.line(rand(opts), {}, { maxMs }); if (c) return { clips: [c] }; }
    const base = chance(0.5) ? ['filler_g_color', 'filler_color'] : ['filler_color', 'filler_g_color'];
    const c = this.line(any ? [...base, 'filler_pbp', 'intro_color'] : base, {}, { maxMs, avoidLastCat: true });
    return c && { clips: [c] };
  }

  // something short and true about the play right now
  fillGap(t, maxMs, loose = false) {
    const M = this.model, m = M.m;
    if (m.pressure.active && this.since('pressure') > 16000 && this.lib.sinceCat('pbp_pressure_g') > 16000) {
      const c = this.line([['pbp_pressure', { team: this.teamName(m.pressure.team) }], 'pbp_pressure_g'], {}, { maxMs });
      if (c) return c;
    }
    if (t) {
      const info = { ...t, speed: t.post, chain: m.chain.count };
      const extra = { fiftyRecent: this.now() - this.fiftyAt < 3000 };
      const c = this.line(['pbp_flow_g'], {}, { maxMs, filter: (clip) => { const f = FLOW_WHEN[clip.text]; return !f || f(info, extra); } });
      if (c) return c;
      if (this.now() - t.at < 1200) return this.touchLine(t, maxMs);
    }
    return this.line(loose ? ['filler_pbp', 'filler_g_color', 'filler_color'] : ['filler_pbp', 'filler_g_color'], {}, { maxMs, avoidLastCat: true });
  }
}

module.exports = { Director, PACE, FLOW_WHEN };
