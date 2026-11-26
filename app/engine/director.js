'use strict';
// The director: what the caster says, and when. Two kinds of speech:
//
// 1. Calls: answers to something that just happened (a goal, a save, a shot, a pass...).
//    Each has a priority and a deadline. A call that can't start in time is dropped - a
//    late call is worse than none - and only a game-deciding goal cuts in over a line.
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

// routine saves: the calm lines about a defense holding (from the colour and flow banks)
const DEFENCE_HOLDS = /defen[cs]e is holding|positioning from the defen|patient against a defen|defen[cs]e rotating well|defen[cs]e is shadowing/i;
const NOT_A_SAVE = new Set(['Great challenge.']);
// save lines kept for the saves that matter
const OVER_THE_TOP = /impossible|miracle|unbelievable|incredible|how did|highlight|steals a certain/i;

// calls that lead up to a goal (the shot, a touch, the ball off the bar): the goal call
// follows them at the next pause between words instead of waiting for the line to end
const LEAD_INS = new Set(['shot', 'crossbar', 'rebound', 'flick', 'pass', 'clear', 'fifty', 'counter', 'dribble', 'aerial', 'wall',
  'ceiling', 'bighit', 'turnover', 'pressure', 'pbp_touch', 'pbp_flow', 'kickoff_go', 'kickoff_result', 'zero', 'clock']);
// "{name} lets it fly" is for a goal from distance
const FROM_DISTANCE = /lets it fly|from distance|from long range|from way out/i;

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
    this.shotHold = 0;
    this.replayAt = 0;
    this.clinchSaid = false;
    this.statAt = new Map(); // player -> when a stat of theirs was last called out
  }

  gap() { return between(this.pace.gap[0], this.pace.gap[1]); }
  name(n) { return n ? W.speakName(n, this.config.pronunciations) : null; }
  teamName(t) { return this.ctx.teamName ? this.ctx.teamName(t) : this.model.m.teams[t] || (t === 1 ? 'Orange' : 'Blue'); }
  since(kind) { const t = this.kindAt.get(kind); return t ? this.now() - t : Infinity; }

  // a line from these categories (best first), or null
  line(cats, vars, opts = {}) { return this.lib.pick(cats, vars || {}, opts); }

  // ------------------------------------------------------------------ calls
  // within: ms it may wait to start. Nothing cuts in over a line that's being said (2.1: cuts
  // chopped words), except a game-deciding goal (decisive), and that waits for the next pause
  // between words. A more important call does stop a run of lines after the current one.
  call(kind, prio, make, { within = 1500, decisive = false, cutsLeadIn = false, protect = false, key = kind, gap = 0 } = {}) {
    if (prio < this.pace.minPrio && prio < 50) return;
    const now = this.now();
    this.queue = this.queue.filter((c) => c.key !== key);
    this.queue.push({ kind, prio, make, at: now, deadline: now + within, decisive, cutsLeadIn, protect, key, gap });
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
        if (c.prio <= u.prio) continue;
        const goalCall = u.kind === 'goal' || u.kind === 'end'; // never stopped early
        if (!goalCall && c.prio >= u.prio + 10) u.trim = true; // finish this line, skip the rest
        if (goalCall || !(c.decisive || (c.cutsLeadIn && LEAD_INS.has(u.kind)))) continue;
        if (this.start(c, true)) return true;
      } else {
        if (c.gap && now - this.speaker.lastSpokeAt < c.gap) continue;
        // a shot is on its way: keep quiet for the save or the goal (nothing gets cut for it now)
        if (c.prio < 55 && this.model.danger() >= 0.95) continue;
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
    const left = this.finalMs();
    if (left !== null && c.prio < 80 && clips.reduce((a, x) => a + (x.ms || 0), 0) > left - 250) { this.dropped(c, 'clock'); return false; }
    if (cutting) {
      const cur = this.speaker.current;
      if (this.trace) this.trace('cut', { by: c.kind, prio: c.prio, cut: cur && cur.utt.kind });
    }
    this.say(c.kind, c.prio, clips, { protect: c.protect, latency: this.now() - c.at, cutWithin: cutting ? 450 : 0 });
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

  say(kind, prio, clips, { protect = false, latency = 0, cutWithin = 0 } = {}) {
    const started = this.now();
    this.kindAt.set(kind, started);
    const utt = {
      kind, prio, protect, clips, cutWithin,
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
        if (mo.overtime && !m.otCalled) { m.otCalled = true; return this.call('overtime', 90, () => [this.line(['ot']), this.line(['ot_color'], {}, { maxMs: 5000 })], { within: 4000, protect: true }); }
        const moved = !!(this.goalCtx && this.goalCtx.contextMoved);
        if (!mo.first) this.call('restart', moved ? 46 : this.scoreDue ? 38 : 30, () => [this.restartLine()], { within: moved ? 3000 : this.scoreDue ? 2000 : 900, gap: 250 });
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
          this.call('kickoff_result', 40, () => [this.line(mo.name && chance(0.5) ? [['kickoff_won_name', N], ['kickoff_won', T]] : [['kickoff_won', T], ['kickoff_won_name', N]], {}, { maxMs: 3100 })], { within: 800 });
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
        this.call('flick', 41, () => [this.line(['pbp_flick_g'], {}, { maxMs: 1900 })], { within: 450 });
        break;
      case 'rebound':
        this.call('rebound', 55, () => [this.line(['rebound_g'], {}, { maxMs: 1800 })], { within: 450 });
        break;
      case 'pressure':
        if (this.since('pressure') < 18000) break;
        this.call('pressure', 32, () => [this.line(chance(0.5) ? [['pbp_pressure', { team: this.teamName(mo.team) }], 'pbp_pressure_g'] : ['pbp_pressure_g', ['filler_pressure', { team: this.teamName(mo.team) }]], {}, { maxMs: this.maxMs(3000) })], { within: 1500 });
        break;
      case 'shot': this.onShot(mo); break;
      case 'save': this.onSave(mo); break;
      case 'crossbar':
        if (this.since('crossbar') < 6000) break;
        this.call('crossbar', 72, () => [this.line(chance(0.7) ? [['crossbar', { name: this.name(mo.name) }], 'crossbar_generic', 'close_g'] : ['close_g', 'crossbar_generic'], {}, { maxMs: 3200, fallbackMs: 5200 })], { within: 1500 });
        this.topic('close_react', 24, () => [this.line(['close_react_g'])], { forMs: 7000 });
        break;
      case 'demo': this.onDemo(mo); break;
      case 'goal': this.onGoal(mo); break;
      case 'replay_start': {
        this.replayAt = this.now();
        // the replay is on, and the goal call is nearly done: what the goal means ("Gentle
        // Mates strike first!") waits for the restart, so the analysis goes with the pictures
        const cur = this.speaker.current, g = this.goalCtx;
        // (not the big ones - "Orange jump in front!" belongs with the goal)
        if (cur && g && cur.utt.kind === 'goal' && g.context && g.context.mood !== 'hype' && cur.clip === cur.utt.clips[0] && cur.clipEnd - Date.now() < 2500 && !g.overtime) {
          cur.utt.trim = true; g.contextMoved = true;
        }
        this.onReplay();
        break;
      }
      case 'replay_will_end': this.topics = this.topics.filter((t) => !t.key.startsWith('replay')); break;
      case 'clock_mark': this.onClock(mo.mark); break;
      case 'zero': {
        if (M.scoreDiff() > 1) break;
        // the ball usually lands within a second or two: it can't wait for a line to end
        // (the pack's zero lines run 4.7 s or more: "Last chance!" until a short one is recorded)
        this.call('zero', 85, () => [this.line(['zero_g'], {}, { maxMs: 2600 })
          || (this.lib.sinceCat('t5_g') > 3000 || chance(0.5) ? this.line(['t5_g'], {}, { filter: (c) => /last chance/i.test(c.text), allowRepeat: true }) : null)
          || this.line(['zero_g'], {}, { fallbackMs: 6000 })], { within: 700, decisive: true });
        break;
      }
      case 'ot_mark': {
        const cat = mo.mark === 60 ? 'ot_1min' : mo.mark === 120 ? 'ot_2min' : 'ot_long';
        this.call('ot_mark', 34, () => [this.line([cat, 'ot_long'], {}, { maxMs: this.maxMs(3000) })], { within: 5000 });
        break;
      }
      case 'match_end': this.onEnd(mo); break;
      case 'podium': {
        // after the game: a word on the winners, where the series stands, and goodbye - only
        // once the series is over (or if it's not known to be one). Picked now: in RL Career
        // Hub the next match is created seconds later, and this is said over its empty lobby.
        const color = this.endColor; this.endColor = null;
        const sr = this.seriesWrap();
        const clips = [color && this.line(color), ...(sr ? sr.clips : [])];
        if (!sr || sr.over !== false) clips.push(this.line(['signoff']));
        this.call('signoff', 60, () => clips, { within: 12000, gap: 400 });
        break;
      }
      case 'destroyed':
        this.topics = [];
        // left mid-game: stop. After the result (RL Career Hub closes the match right after
        // the podium): the result and the wrap-up are still said
        if (!mo.ended) { this.queue = []; this.speaker.stopAll(); } else this.queue = this.queue.filter((c) => c.kind === 'end' || c.kind === 'signoff');
        break;
      default: break;
    }
  }

  // the longest line worth starting now: short with the ball near a goal, long when it's calm
  maxMs(cap = 7000) {
    const d = this.model.danger();
    const w = d >= 0.8 ? 1500 : d >= 0.62 ? 2500 : d >= 0.45 ? 3900 : 6500;
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
    // keep the air clear until the ball should be there, so a goal call starts right away
    // (the game only says where the ball is when it's touched, and two shots in three are
    // saved, so the goal itself can't be called before it goes in)
    const eta = s.eta !== null && s.eta !== undefined ? Math.min(2500, s.eta) : 1500;
    this.shotHold = this.now() + eta + 400;
    { const cur = this.speaker.current; if (cur && cur.utt.prio < 60) cur.utt.trim = true; }
    // most shots are saved or scored within a second: a short call, and only if there's time
    if (s.eta !== null && s.eta < 650) return;
    if (!this.model.isClose() && !chance(0.3)) return;
    const room = s.eta ? Math.max(1100, s.eta + 300) : 1800;
    const N = { name: this.name(s.name) };
    this.call('shot', 60, () => [this.line(chance(0.6) ? [['shot', N], 'shot_g'] : ['shot_g', ['shot', N]], {}, { maxMs: Math.min(2300, room) })], { within: 300 });
  }

  // How much the moment matters: 'high' late in a close game and in overtime, 'low' early on
  // or in a blowout, 'mid' otherwise. It decides how big the call is: an early routine save
  // gets "The defense is holding firm", not "an absolute miracle".
  stakesNow() {
    const m = this.model.m, d = this.model.scoreDiff();
    if (m.overtime) return 'high';
    if (d >= 3) return 'low';
    const left = m.time === null || m.time === undefined ? 150 : m.time;
    if (left <= 60 && d <= 1) return 'high';
    if (left <= 120 && d === 0) return 'high';
    if (left > 180) return 'low';
    return 'mid';
  }

  // a routine save, said calmly
  routineSave(N, maxMs) {
    const lines = [
      () => this.line([['save_late', N], 'pbp_defend_g'], {}, { maxMs, filter: (c) => !NOT_A_SAVE.has(c.text) }),
      () => this.line(['filler_g_color', 'filler_color'], {}, { maxMs: Math.max(maxMs, 3400), filter: (c) => DEFENCE_HOLDS.test(c.text) }),
    ];
    if (chance(0.5)) lines.reverse();
    return lines[0]() || lines[1]() || this.line(['save_g_short'], {}, { maxMs });
  }

  onSave(s) {
    const M = this.model;
    const N = { name: this.name(s.name) };
    const close = M.isClose();
    if (!close && !s.big) return; // a blowout: only the ones off the line
    const stakes = this.stakesNow();
    const measured = (c) => !OVER_THE_TOP.test(c.text); // no "impossible save" unless it matters
    let make;
    if (s.big && stakes === 'high') make = () => [this.line([['epicsave', N], 'epicsave_generic', ['save', N], 'save_g_short'], {}, { maxMs: 4600, fallbackMs: 6000 })];
    else if (s.big) make = () => [this.line([['save', N], 'save_generic', 'save_g_short'], {}, { maxMs: Math.max(2200, this.maxMs(3300)), fallbackMs: 5500, filter: measured })];
    else if (stakes === 'low') make = () => [this.routineSave(N, Math.max(2000, this.maxMs(3000)))];
    else if (s.again && chance(0.6)) make = () => [this.line(['save_again', ['save', N], 'save_g_short'], {}, { maxMs: this.maxMs(3300), fallbackMs: 5500, filter: stakes === 'high' ? null : measured })];
    else make = () => [this.line(chance(0.55) ? [['save', N], 'save_generic', 'save_g_short'] : ['save_generic', 'save_g_short', ['save', N]], {}, { maxMs: Math.max(2200, this.maxMs(3300)), fallbackMs: 5500, filter: stakes === 'high' ? null : measured })];
    // a save waits for the line being said to end, unless config.json says cutIn: saves (then
    // it breaks in at the next pause between words)
    this.call('save', s.big ? 80 : 75, make, { within: 1800, decisive: this.config.cutIn === 'saves' });
    const q = this.queue.find((c) => c.kind === 'save'); if (q) q.saver = s.name;
    if (s.big && stakes !== 'low') this.topic('save_react', 26, () => [this.line(['save_react_g'])], { forMs: 7000 });
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

  // A defender taken out with the ball in their end is always worth a call (the play is right
  // there); any other demo only now and then
  onDemo(d) {
    const M = this.model;
    if (!d.live) return; // after a goal: not worth a call
    const close = M.isClose();
    if (!d.inEnd && !chance(close ? 0.2 : 0.1)) return;
    const att = { name: this.name(d.att) }, vic = { name: this.name(d.vic) };
    const n = d.att ? M.stat(d.att, 'demos') : 0;
    const prio = d.inEnd ? 52 : close ? 45 : 30;
    this.call('demo', prio, () => {
      const first = this.line(chance(0.35) ? [['demo_victim', vic], ['demo', att], 'demo_generic', 'demo_g_short'] : [['demo', att], ['demo_victim', vic], 'demo_generic', 'demo_g_short'], {}, { maxMs: this.maxMs(2600), fallbackMs: 4800 });
      return [first];
    }, { within: 1600 });
    if (d.down >= 1 && M.m.teamSize >= 2 && close && chance(0.5)) this.call('numbers', 33, () => [this.line(['demo_numbers_g'], {}, { maxMs: 2600 })], { within: 2500, gap: 200 });
    // (not "That's five demos tonight" on its own: after "ivn gets demolished" it sounds like ivn's)
    if (n >= 2 && n <= 5) this.topic('stat_demos' + n, 23, () => [this.line([['filler_demos', att]])], { forMs: 20000 });
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
  // a goal for a team already 3 up (or 2 up in the last minute) is 'rout': called, not
  // celebrated; one that leaves a team 3 down (or 2 down in the last minute) is 'consolation'
  stakes(g) {
    if (g.overtime) return 'normal';
    const lb = g.before[g.team] - g.before[1 - g.team], la = g.after[g.team] - g.after[1 - g.team];
    const left = this.model.m.time === null || this.model.m.time === undefined ? 300 : this.model.m.time;
    if (lb >= 3 || (lb >= 2 && left <= 60)) return 'rout';
    if (la <= -3 || (la <= -2 && left <= 60)) return 'consolation';
    return 'normal';
  }

  decisive(g) {
    if (g.overtime) return true;
    const lb = g.before[g.team] - g.before[1 - g.team], la = g.after[g.team] - g.after[1 - g.team];
    if (lb === 0 && la > 0) return true; // takes the lead
    const left = this.model.m.time;
    return left !== null && left <= 60 && lb < 0 && la >= -1; // under a minute left: back within one, or level
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
    const far = g.dist !== null && g.dist !== undefined && g.dist >= 3000;
    const G = { filter: (c) => far || !FROM_DISTANCE.test(c.text) }; // "lets it fly" only from distance
    const make = () => {
      if (g.overtime) return [this.line([['goal_ot', { name: scorer }], 'goal_ot_generic', 'goal_g_short', ['goal', { name: scorer }], 'goal_generic'], {}, G)];
      if (g.own) return [this.line(['goal_own_g', 'goal_g_short', 'goal_generic'], {}, G), this.line(this.scoreCats(g.team, g.before, g.after, g.late), T)];
      if (stakes === 'rout') return [this.line([['goal_rout', { name: scorer }], 'goal_rout_generic', 'goal_g_short', 'goal_generic'], {}, G), this.line([['score_rout', T], ['score_extend', T]])];
      if (stakes === 'consolation') return [this.line([['goal_consolation', { name: scorer }], 'goal_consolation_generic', 'goal_g_short', 'goal_generic'], {}, G), this.line([['score_consolation', T]])];
      return [this.line([['goal', { name: scorer }], 'goal_generic', 'goal_g_short'], {}, G), this.line(this.scoreCats(g.team, g.before, g.after, g.late), T)];
    };
    // game-deciding (takes the lead, overtime, or late and back within one): it cuts in, at the
    // next pause between words; any other goal waits for the line being said to end
    const decisive = this.decisive(g);
    g.decisive = decisive;
    // (2.1.2: and any goal follows a lead-in call - the shot, the touch, off the bar - the same way)
    const ctx = this.goalCtx;
    const made = () => { const clips = make(); ctx.context = clips[1] || null; return clips; };
    this.call('goal', 100, made, { within: decisive ? 1500 : 9000, decisive, cutsLeadIn: true, protect: true });
    this.shotHold = 0;
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
    const left = M.m.time === null || M.m.time === undefined ? 300 : M.m.time;
    // one win from the series, and this game is out of reach: say the series is all but done
    if (this.clinching(g.team) && (lead >= 3 || (lead >= 2 && left <= 90)) && !this.clinchSaid) {
      this.topic('series_close', 34, () => { this.clinchSaid = true; return [this.line([['series_clinch', T], 'series_matchpoint'], {}, { filter: (c) => c.cat !== 'series_matchpoint' || /move on|series is over/i.test(c.text) })]; },
        { forMs: 60000, valid: () => { const sc = this.model.m.score; return sc[g.team] - sc[1 - g.team] >= 2; } });
    }
    // two down late, or three down with time left: they need something now
    const behind = 1 - g.team;
    if (stakes !== 'consolation' && ((lead === 2 && left <= 180 && left > 45) || (lead === 3 && left > 60))) {
      this.topic('need_something', 29, () => [this.line([['need_something', { team: this.teamName(behind) }], ['filler_trailing', { team: this.teamName(behind) }]])],
        { forMs: 45000, valid: () => { const sc = this.model.m.score; return sc[g.team] - sc[behind] >= 2; } });
    }
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
    // (2.1.2: it came a bit late - after the goal call and the score it often landed as the
    // replay ended. It starts with less of a pause, the "here it is again" opener only when
    // there's time for it, and a shorter line the later it starts. A replay runs about 7 s.)
    const make = () => {
      const intoReplay = this.replayAt && this.model.m.goalReplay ? this.now() - this.replayAt : null;
      const left = intoReplay === null ? 6500 : 8000 - intoReplay;
      const opener = intoReplay !== null && intoReplay < 1500 && chance(0.3) ? this.line(['an_replay_g'], {}, { maxMs: 2000 }) : null;
      const maxMs = Math.max(4500, Math.min(7000, left - (opener ? opener.ms || 1500 : 0)));
      return [opener, this.line(cats, {}, { maxMs, fallbackMs: 8000 })];
    };
    this.call('replay', 40, make, { within: 7000, gap: 100 });
    const stat = big || g.stakes === 'rout' ? this.goalStat(g) : null; // a blowout's story is its numbers
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
    this.call('clock', prio, () => [this.line(cats, {}, { maxMs: mark <= 10 ? 2000 : 4200, fallbackMs: mark <= 10 ? 3200 : 5600 })], { within: mark <= 10 ? 900 : 2500 });
    if ((mark === 120 || mark === 60) && diff >= 2 && this.clinching(lead) && !this.clinchSaid) {
      const T = { team: this.teamName(lead) };
      this.topic('series_close', 34, () => { this.clinchSaid = true; return [this.line([['series_clinch', T], 'series_matchpoint'], {}, { filter: (c) => c.cat !== 'series_matchpoint' || /move on|series is over/i.test(c.text) })]; }, { forMs: 50000 });
    }
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
    // after a goal: what it meant, if the replay pushed it back, else the score
    const g = this.goalCtx;
    if (g && g.contextMoved && g.context) {
      g.contextMoved = false; this.scoreDue = null;
      if (this.lib.unused(g.context, 1)) return g.context;
    }
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

  // ------------------------------------------------------------------ the series
  // ctx.series: { game, bestOf, wins: [blue, orange], after } from the commentary (wins before
  // this game; after the result, wins including it)
  clinching(team) {
    const S = this.ctx.series;
    if (!S || !S.bestOf || S.after) return false;
    return S.wins[team] === Math.ceil(S.bestOf / 2) - 1;
  }
  seriesLines(w) {
    if (w[0] + w[1] === 0) return [];
    if (w[0] === w[1]) return [this.line([['series_level', { a: W.num(w[0]) }], 'series_tied'])];
    const lead = w[0] > w[1] ? 0 : 1;
    return [this.line([['series_lead', { team: this.teamName(lead) }]]), this.line([['series_score', { score: W.scoreWords(w[lead], w[1 - lead]) }]])];
  }
  // after a game of a series: { clips, over } (over: false = more to come, null = not known)
  seriesWrap() {
    const S = this.ctx.series;
    if (!S || !S.after) return null;
    const w = S.wins;
    const need = S.bestOf ? Math.ceil(S.bestOf / 2) : null;
    if (need && Math.max(w[0], w[1]) >= need) {
      const win = w[0] > w[1] ? 0 : 1;
      const score = W.scoreWords(w[win], w[1 - win]);
      return { over: true, clips: [this.line([['series_won', { team: this.teamName(win) }], ['series_score', { score }]])] };
    }
    if (!need && S.game < 2) return null; // one game, or the first of a series we can't tell yet
    return { over: need ? false : null, clips: this.seriesLines(w) };
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
    // a goal at the buzzer: its call finishes, but not the lines after it, so the result
    // isn't left waiting behind them (2.1.1: it used to be dropped in about one match in six)
    const cur = this.speaker.current;
    if (cur && cur.utt.kind === 'goal') cur.utt.trim = true;
    this.call('end', 95, () => [this.line(cats, T), this.line([['end_score', { score: this.scoreText(s) }]])], { within: 15000, protect: true, gap: 300, cutsLeadIn: true });
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
      case 'pre': case 'countdown': this.flowPre(idle); break;
      default: break;
    }
  }

  // ms left on the clock in the last seconds of a close game (nothing long may start), or null
  finalMs() {
    const m = this.model.m;
    if (m.overtime || m.time === null || m.time === undefined || m.time > 4 || m.phase !== 'live' || this.model.scoreDiff() > 1) return null;
    return Math.max(0, m.time * 1000 - (this.now() - m.clockAt));
  }

  // before the first kickoff: the teams and the stories of the intro, if they fit before it
  flowPre(idle) {
    const m = this.model.m;
    if (idle < 700 || !this.ctx.introAt) return;
    let room = 7000;
    if (m.phase === 'countdown') {
      if (m.kickoffs !== 1) return; // the restart after a goal has its own call
      room = 4000 - (this.now() - m.countdownAt) - 300;
    }
    if (room < 1500) return;
    const tp = this.takeTopic(room, ['intro_teams', 'form0', 'form1', 'bestof', 'table', 'h2h', 'intro_star', 'intro_color']);
    if (tp) this.say('topic', 24, tp);
  }

  flowLive(idle) {
    const M = this.model, m = M.m, now = this.now();
    if (idle < this.nextGap / this.pace.flow) return;
    if (now < this.shotHold) return; // a shot is on its way: the save or the goal call needs the air
    if (this.finalMs() !== null) return; // the last seconds: the clock calls only
    if (m.kickoff && !m.kickoff.resolved && now - m.kickoff.at < 6000 && idle < 2500) return; // the kickoff result is coming
    // ahead of broadcast pace: let a little air in
    if (this.talkRatio() > this.pace.ratio + 0.12 && idle < 1500) return;
    const d = M.danger();
    // nothing is cut off any more, so in live play no line may run long: a save or a goal
    // would have to wait for it (the long stories are for the breaks)
    // (a pack without the 2.0 lines has few short ones: there the 2.0 limit stays)
    const LIVE_MAX = this.lib.strict ? 3800 : 6500;
    const maxMs = Math.min(LIVE_MAX, this.maxMs());
    const t = m.lastTouch;
    const close = M.isClose();
    // 1. name who's on the ball, if it's fresh and nobody's been named for a moment
    // (2.1: about one in four of these moments is let go, for a little less "X takes it")
    if (t && now - t.at <= 900 && now - this.at.name >= (close ? 2900 : 5500) && this.pace.flow >= 0.5 && M.danger() < 0.95) {
      if (chance(0.25)) this.at.name = now;
      else {
        const clip = this.touchLine(t, Math.min(maxMs, 2500));
        if (clip) { this.at.name = now; return this.say('pbp_touch', 30, [clip]); }
      }
    }
    if (d >= 0.62 && idle < 2200) return; // the ball's near a goal: wait for what happens
    // 2. calm enough for a story or some colour
    if (d < 0.6 && now - this.at.color >= this.pace.colorEvery / this.pace.flow) {
      const clip = this.colourLine(maxMs) || (d < 0.5 && idle > 1500 ? this.colourLine(LIVE_MAX) : null);
      if (clip) { this.at.color = now; return this.say(clip.kind || 'color', 20, clip.clips); }
    }
    // 3. it's gone quiet for too long: something short and true about the play
    if (idle >= (close ? 1800 : 3200) / this.pace.flow) {
      const clip = this.fillGap(t, Math.min(maxMs, 3000)) || (d < 0.62 ? this.fillGap(t, LIVE_MAX, true) : null);
      if (clip) return this.say('pbp_flow', 25, [clip]);
    }
    // 4. dead air: say something - a repeat or a longer line beats silence
    const quiet = idle >= 4500 / this.pace.flow && d < 0.62; // calm, and it's been quiet a while
    const tooQuiet = idle >= 6500 / this.pace.flow && d < 0.9; // anything but a shot on its way
    if ((quiet || tooQuiet) && this.pace.flow >= 0.5 && !(m.lastShot && now - m.lastShot.at < 1500)) {
      const long = d < 0.45 ? 5500 : LIVE_MAX; // calm: a longer line is fine
      const c = this.colourLine(LIVE_MAX, true) || this.fillGap(t, LIVE_MAX, true) || this.colourLine(long, true)
        || this.colourLine(long, true, true) || this.fillGap(t, long, true, true); // a line a second time beats dead air
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
    if (g && g.contextMoved) return; // the air is kept for what the goal meant, at the restart
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

  colourLine(maxMs, any = false, allowRepeat = false) {
    const M = this.model, m = M.m;
    const tp = this.takeTopic(maxMs);
    if (tp) return { kind: 'topic', clips: tp };
    if (m.overtime) { const c = this.line(['filler_ot', 'filler_g_color'], {}, { maxMs }); return c && { clips: [c] }; }
    // what the stats say about the game so far (2.1.2: more of it, most of all in a blowout,
    // where the result is settled and the numbers are the story)
    const players = [...m.players.values()];
    const diff = M.scoreDiff();
    const opts = [];
    const now = this.now();
    for (const p of players) {
      if (now - (this.statAt.get(p.name) || -1e9) < 45000) continue; // not the same player again so soon
      const N = { name: this.name(p.name) };
      const who = p.name;
      if (p.goals >= 2 || p.saves >= 3 || (p.goals + p.assists >= 2)) opts.push({ who, cats: [['color_player', N]] });
      if (p.saves >= 3) opts.push({ who, cats: [['filler_saves', N]], filter: (c) => diff <= 1 || !/score is so close/i.test(c.text) });
      if (p.goals >= 2) opts.push({ who, cats: [['filler_goals', N]] });
      if (p.demos >= 2) opts.push({ who, cats: [['filler_demos', N]] });
      // the name, then the number: "Vatira has been everywhere in this one. That's three goals on the night."
      const num = p.goals >= 2 && p.goals <= 6 ? ['stat_goals', { goals: W.num(p.goals) }]
        : p.saves >= 3 && p.saves <= 9 ? ['stat_saves', { saves: W.num(p.saves) }]
          : p.assists >= 2 && p.assists <= 5 ? ['stat_assists', { assists: W.num(p.assists) }]
            : p.demos >= 2 && p.demos <= 5 ? ['stat_demos', { demos: W.num(p.demos) }] : null;
      if (num) opts.push({ who, cats: [['color_player', N], ['filler_goals', N]].filter((x) => x[0] === 'color_player' || p.goals >= 2), then: [num] });
    }
    const shots = [0, 1].map((tm) => players.filter((p) => p.team === tm).reduce((a, p) => a + p.shots, 0));
    // "they just need to convert" is for a side that's level or behind, not one up five
    for (const tm of [0, 1]) if (shots[tm] - shots[1 - tm] >= 3 && m.score[tm] <= m.score[1 - tm]) opts.push({ cats: [['filler_shots', { team: this.teamName(tm) }]] });
    if (m.lastTouch && chance(0.3)) opts.push({ cats: [['color_team', { team: this.teamName(m.chain.team >= 0 ? m.chain.team : m.lastTouch.team) }]] });
    if (opts.length && chance(diff >= 3 ? 0.8 : 0.5)) {
      // a pair is two lines: the second may run on past the live limit, as it's dropped if play heats up
      const o = rand(opts);
      const c = this.line(o.cats, {}, { maxMs, filter: o.filter });
      if (c) {
        const clips = [c];
        if (o.then && M.danger() < 0.5) { const n = this.line(o.then, {}, { maxMs: 2600 }); if (n) clips.push(n); }
        if (o.who) this.statAt.set(o.who, now);
        return { clips };
      }
    }
    const base = chance(0.5) ? ['filler_g_color', 'filler_color'] : ['filler_color', 'filler_g_color'];
    // generic colour is the bank's most used: a line from the last three games only when it's that or dead air
    const c = this.line(any ? [...base, 'filler_pbp', 'intro_color'] : base, {}, { maxMs, avoidLastCat: true, allowRepeat, fresh: !allowRepeat });
    return c && { clips: [c] };
  }

  // something short and true about the play right now
  fillGap(t, maxMs, loose = false, allowRepeat = false) {
    const M = this.model, m = M.m;
    if (m.pressure.active && this.since('pressure') > 16000 && this.lib.sinceCat('pbp_pressure_g') > 16000) {
      const c = this.line([['pbp_pressure', { team: this.teamName(m.pressure.team) }], 'pbp_pressure_g'], {}, { maxMs });
      if (c) return c;
    }
    if (t) {
      const info = { ...t, speed: t.post, chain: m.chain.count };
      const extra = { fiftyRecent: this.now() - this.fiftyAt < 3000 };
      const c = this.line(['pbp_flow_g'], {}, { maxMs, fresh: !allowRepeat, filter: (clip) => { const f = FLOW_WHEN[clip.text]; return !f || f(info, extra); } });
      if (c) return c;
      if (this.now() - t.at < 1200 && chance(0.6)) return this.touchLine(t, maxMs);
    }
    return this.line(loose ? ['filler_pbp', 'filler_g_color', 'filler_color'] : ['filler_pbp', 'filler_g_color'], {}, { maxMs, avoidLastCat: true, allowRepeat, fresh: !allowRepeat });
  }
}

module.exports = { Director, PACE, FLOW_WHEN };
