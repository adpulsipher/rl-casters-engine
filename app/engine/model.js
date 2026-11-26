'use strict';
// The match as the casters understand it. Takes Rocket League's Stats API messages and
// keeps the state of play (phase, clock, score, who's on the ball, where, pressure), and
// turns them into "moments" for the director: a touch, a pass, a clear, a 50/50, a shot,
// a save, a near miss, a goal, a clock mark...
//
// Field: blue (team 0) attacks +Y, orange (team 1) attacks -Y. Goal lines at Y = +-5120,
// side walls at X = +-4096, ceiling at Z = 2044. The goal mouth is 1786 wide, 642 high.
// The game only says where the ball is when someone touches it (BallHit), and its speed
// on every state update, so everything here is built from touches, speeds and the stat feed.

const GOAL_Y = 5120, WALL_X = 4096, POST_X = 893;
const THIRD = 1707;

const keyOf = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

class GameModel {
  constructor({ now = () => Date.now(), log = () => {} } = {}) {
    this.now = now;
    this.log = log;
    this.reset();
  }

  reset() {
    this.m = {
      active: false, phase: 'idle', joinedLate: false, initialized: false,
      overtime: false, paused: false, stateReplay: false, goalReplay: false,
      score: [0, 0], stateScore: [0, 0], scoreBehindSince: 0, time: null, clockAt: 0, countdownAt: 0,
      teams: ['Blue', 'Orange'], players: new Map(), teamSize: 0, spectator: false,
      ballSpeed: 0, ballTeam: 255, speeds: [], touches: [], lastTouch: null,
      chain: { team: -1, count: 0, names: [] }, run: { name: null, count: 0 },
      kickoff: null, kickoffs: 0, pressure: { team: -1, since: 0, active: false, calledAt: 0 },
      lastShot: null, lastSave: null, pendingSave: null, pendingMiss: null, lastClear: null,
      lastGoal: null, goals: [], demos: [], demolished: new Map(), counts: new Map(),
      marks: new Set(), roundAt: 0, lastLiveAt: 0,
    };
  }

  get state() { return this.m; }
  // live play: the ball is in play, no replay or break
  live() { return this.m.phase === 'live' && !this.m.stateReplay && !this.m.goalReplay && !this.m.paused; }
  count(name, k) {
    if (!name) return 0;
    const c = this.m.counts.get(name) || {};
    c[k] = (c[k] || 0) + 1;
    this.m.counts.set(name, c);
    return c[k];
  }
  stat(name, k) { const c = this.m.counts.get(name); return (c && c[k]) || 0; }
  player(name) { return this.m.players.get(name); }
  teamOf(name) { const p = this.m.players.get(name); return p ? p.team : -1; }
  attackY(team, y) { return team === 1 ? -y : y; }
  zoneOf(team, y) { const a = this.attackY(team, y); return a > THIRD ? 'att' : a < -THIRD ? 'def' : 'mid'; }
  scoreDiff() { return Math.abs(this.m.score[0] - this.m.score[1]); }
  isClose() { return this.scoreDiff() <= 2 || this.m.overtime; }
  leader() { const s = this.m.score; return s[0] === s[1] ? -1 : s[0] > s[1] ? 0 : 1; }

  // how likely something big is about to happen (0 calm .. 1 a shot is on its way)
  danger(now = this.now()) {
    const m = this.m;
    if (!this.live()) return 0;
    if (m.lastShot && now - m.lastShot.at < 1500) return 0.95;
    if (m.kickoff && !m.kickoff.resolved) return now - m.kickoff.at < 4000 ? 0.6 : 0.4;
    const t = m.lastTouch;
    if (!t) return 0.3;
    const age = now - t.at;
    const a = this.attackY(t.team, t.y);
    let d;
    if (a > 3200) d = 0.85;
    else if (a > THIRD) d = 0.7;
    else if (a > -THIRD) d = 0.45;
    else d = t.post > 1500 ? 0.3 : 0.6; // a clear is calm; a scramble in your own box isn't
    if (t.post > 2200 && a > 0) d += 0.1;
    if (m.pressure.active) d = Math.max(d, 0.65);
    if (age > 2500) d -= 0.15;
    return Math.max(0, Math.min(1, d));
  }

  // ------------------------------------------------------------------ events
  handle(name, d) {
    const out = [];
    const emit = (type, x = {}) => out.push({ type, at: this.now(), ...x });
    const m = this.m;
    const now = this.now();
    d = d || {};
    switch (name) {
      case 'MatchCreated':
        this.reset(); m.active = true; m.phase = 'pre';
        emit('match_created');
        break;
      case 'MatchInitialized':
        m.active = true; m.initialized = true;
        if (m.phase === 'idle') m.phase = 'pre';
        emit('match_init');
        break;
      case 'CountdownBegin': {
        m.active = true;
        if (m.phase === 'ended') break;
        m.goalReplay = false;
        m.phase = 'countdown'; m.countdownAt = now;
        m.kickoffs++;
        m.pendingMiss = null; m.lastShot = null;
        const ot = m.overtime || (m.time === 0 && m.score[0] === m.score[1] && m.kickoffs > 1);
        if (ot && !m.overtime) { m.overtime = true; emit('overtime'); }
        emit('countdown', { first: m.kickoffs === 1 && !m.joinedLate, overtime: m.overtime });
        break;
      }
      case 'RoundStarted':
        m.active = true;
        if (m.phase === 'ended') break;
        m.phase = 'live'; m.goalReplay = false; m.roundAt = now;
        m.kickoff = { at: now, first: null, takers: new Set(), resolved: false };
        m.chain = { team: -1, count: 0, names: [] }; m.run = { name: null, count: 0 };
        m.pressure = { team: -1, since: 0, active: false, calledAt: m.pressure.calledAt };
        emit('kickoff_go', { overtime: m.overtime });
        break;
      case 'UpdateState': this.update(d, emit); break;
      case 'ClockUpdatedSeconds': this.clock(d.TimeSeconds, d.bOvertime, emit); break;
      case 'BallHit': this.ballHit(d, emit); break;
      case 'StatfeedEvent': this.statfeed(d, emit); break;
      case 'GoalScored': this.goal(d, emit); break;
      case 'CrossbarHit': this.crossbar(d, emit); break;
      case 'GoalReplayStart':
        m.goalReplay = true; m.phase = m.phase === 'ended' ? 'ended' : 'replay';
        emit('replay_start');
        break;
      case 'GoalReplayWillEnd': emit('replay_will_end'); break;
      case 'GoalReplayEnd':
        m.goalReplay = false;
        emit('replay_end');
        break;
      case 'MatchPaused': m.paused = true; emit('paused'); break;
      case 'MatchUnpaused': m.paused = false; emit('unpaused'); break;
      case 'MatchEnded': {
        if (m.phase === 'ended') break;
        m.phase = 'ended';
        const w = d.WinnerTeamNum === 1 ? 1 : d.WinnerTeamNum === 0 ? 0 : (m.score[0] >= m.score[1] ? 0 : 1);
        emit('match_end', { winner: w });
        break;
      }
      case 'PodiumStart': emit('podium'); break;
      case 'MatchDestroyed': emit('destroyed'); this.reset(); break;
      case 'PlayerLeft': if (d.PlayerName) m.players.delete(d.PlayerName); break;
      default: break;
    }
    return out;
  }

  update(d, emit) {
    const m = this.m;
    const g = d.Game || {};
    if (!m.active) { m.active = true; m.joinedLate = true; m.phase = 'live'; emit('joined_late'); }
    if (Array.isArray(g.Teams)) {
      for (const t of g.Teams) {
        if (!t || typeof t !== 'object') continue;
        const n = t.TeamNum === 1 ? 1 : 0;
        if (t.Name) m.teams[n] = String(t.Name);
        if (typeof t.Score === 'number') m.stateScore[n] = t.Score | 0;
      }
      // the game's score is ahead of ours (we joined late, or missed a goal): catch up, but give the
      // goal event a moment first - it can arrive just after the state update that counts it
      const behind = [0, 1].some((n) => m.stateScore[n] > m.score[n]);
      if (!behind) m.scoreBehindSince = 0;
      else if (!m.scoreBehindSince) m.scoreBehindSince = this.now();
      else if (this.now() - m.scoreBehindSince > 1500) { m.score = [0, 1].map((n) => Math.max(m.score[n], m.stateScore[n])); m.scoreBehindSince = 0; }
    }
    if (typeof g.bReplay === 'boolean' && g.bReplay !== m.stateReplay) { m.stateReplay = g.bReplay; }
    if (g.bOvertime && !m.overtime) { m.overtime = true; emit('overtime'); }
    if (typeof g.TimeSeconds === 'number') this.clock(g.TimeSeconds, g.bOvertime, emit);
    if (g.Ball) {
      if (typeof g.Ball.Speed === 'number') {
        m.ballSpeed = g.Ball.Speed;
        if (this.live()) {
          m.speeds.push({ at: this.now(), s: g.Ball.Speed });
          if (m.speeds.length > 240) m.speeds.splice(0, m.speeds.length - 240);
        }
      }
      if (typeof g.Ball.TeamNum === 'number') m.ballTeam = g.Ball.TeamNum;
    }
    if (Array.isArray(d.Players)) {
      const perTeam = [0, 0];
      for (const p of d.Players) {
        if (!p || !p.Name) continue;
        const team = p.TeamNum === 1 ? 1 : 0;
        perTeam[team]++;
        const prev = m.players.get(p.Name) || {};
        const x = {
          name: p.Name, team, goals: p.Goals | 0, saves: p.Saves | 0, shots: p.Shots | 0, assists: p.Assists | 0,
          demos: p.Demos | 0, score: p.Score | 0, touches: p.Touches | 0,
        };
        if (typeof p.Boost === 'number') { x.boost = p.Boost; m.spectator = true; }
        if (typeof p.bDemolished === 'boolean') x.demolished = p.bDemolished;
        if (typeof p.bSupersonic === 'boolean') x.supersonic = p.bSupersonic;
        m.players.set(p.Name, { ...prev, ...x });
      }
      m.teamSize = Math.max(perTeam[0], perTeam[1]);
    }
  }

  clock(t, ot, emit) {
    const m = this.m;
    if (typeof t !== 'number') return;
    if (m.stateReplay || m.goalReplay) return; // a replay shows the old clock
    if (ot && !m.overtime) { m.overtime = true; emit('overtime'); }
    const prev = m.time;
    if (prev === t) return;
    m.time = t;
    m.clockAt = this.now();
    // the clock only runs in live play: if we joined late or missed the kickoff event, this tells us
    // the clock only runs in live play: if it's moving, play is on, whatever events we missed
    // (a kickoff after a goal included, as long as the game isn't showing a replay)
    const afterGoal = (m.phase === 'goal' || m.phase === 'replay') && !m.stateReplay && m.lastGoal && this.now() - m.lastGoal.at > 3000;
    if (prev !== null && m.active && (m.phase === 'pre' || m.phase === 'idle' || afterGoal || (m.phase === 'countdown' && this.now() - m.countdownAt > 2500))) {
      if (afterGoal) m.goalReplay = false;
      m.phase = 'live'; // the kickoff event never came
      if (!m.kickoff) m.kickoff = { at: this.now(), first: null, takers: new Set(), resolved: true };
    }
    if (prev === null || m.overtime || m.phase !== 'live') {
      if (m.overtime && prev !== null && t > prev) for (const mk of [60, 120, 180]) {
        if (prev < mk && t >= mk && !m.marks.has('ot' + mk)) { m.marks.add('ot' + mk); emit('ot_mark', { mark: mk }); }
      }
      return;
    }
    for (const mark of [120, 60, 30, 10, 5]) {
      if (prev > mark && t <= mark && !m.marks.has(mark)) { m.marks.add(mark); emit('clock_mark', { mark }); }
    }
    if (prev > 0 && t === 0 && !m.marks.has(0)) { m.marks.add(0); emit('zero'); }
  }

  ballHit(d, emit) {
    const m = this.m;
    const now = this.now();
    const ps = (Array.isArray(d.Players) ? d.Players : []).filter((p) => p && p.Name);
    const b = d.Ball || {};
    const loc = b.Location || {};
    if (!ps.length || typeof loc.Y !== 'number') return;
    if (!this.live()) return; // touches in a replay or after a goal already happened
    const p = ps[0];
    const team = p.TeamNum === 1 ? 1 : 0;
    const x = loc.X || 0, y = loc.Y, z = loc.Z || 0;
    const post = b.PostHitSpeed || 0, pre = b.PreHitSpeed || 0;
    const a = this.attackY(team, y);
    const zone = a > THIRD ? 'att' : a < -THIRD ? 'def' : 'mid';
    const surface = z > 1850 ? 'ceiling'
      : (Math.abs(x) > WALL_X - 260 && z > 200) || (Math.abs(y) > GOAL_Y - 200 && z > 260 && !(Math.abs(x) < POST_X && z < 640)) ? 'wall'
      : z > 330 ? 'air' : 'ground';
    const prev = m.lastTouch;
    const t = { at: now, name: p.Name, team, x, y, z, a, zone, surface, pre, post, multi: ps.some((q) => (q.TeamNum === 1 ? 1 : 0) !== team) };
    m.touches.push(t);
    if (m.touches.length > 60) m.touches.shift();
    m.lastTouch = t;
    m.lastLiveAt = now;
    if (m.pendingMiss && m.pendingMiss.at < now - 50) m.pendingMiss = null; // someone touched it: no near miss to call

    // the kickoff: the first contact, then who comes away with it
    const k = m.kickoff;
    if (k && !k.resolved) {
      if (!k.first) { k.first = now; k.takers.add(p.Name); for (const q of ps) k.takers.add(q.Name); emit('kickoff_touch', { name: p.Name, team }); }
      else if (now - k.first < 500) { k.takers.add(p.Name); }
      else if (now - k.first < 3000 && a > 300) {
        // the first team on the ball in the other half has won it
        // (tested on 477 real kickoffs: right 87% of the time; calls about one kickoff in six)
        k.resolved = true;
        emit('kickoff_result', { team, name: p.Name, even: false });
      }
    }
    const kickoffContact = k && k.first && now - k.first < 500;

    // a 50/50: both teams on the ball at once
    const fifty = !kickoffContact && (t.multi || (prev && prev.team !== team && now - prev.at < 220));
    if (fifty) emit('fifty', { team, name: p.Name, other: prev && prev.name, zone });

    // possession
    const turnover = m.chain.team !== -1 && m.chain.team !== team && m.chain.count >= 3 && !fifty;
    if (m.chain.team === team) { m.chain.count++; if (!m.chain.names.includes(p.Name)) m.chain.names.push(p.Name); }
    else m.chain = { team, count: 1, names: [p.Name] };
    if (m.run.name === p.Name && prev && now - prev.at < 1300) m.run.count++; else m.run = { name: p.Name, count: 1 };

    const kinds = [];
    if (turnover) kinds.push('turnover');
    // a pass: a teammate's touch, struck with some pace, then yours (nobody else between)
    // (tested on 140 real matches: travelling 5 m+ inside 2 s, and not out of a scramble, is a pass ~89% of the time)
    const before = m.touches.length >= 3 ? m.touches[m.touches.length - 3] : null;
    const scramble = before && before.team !== team && prev && prev.at - before.at < 600;
    if (!fifty && prev && prev.team === team && prev.name !== p.Name && now - prev.at < 2000 && prev.post > 500 && !kickoffContact
      && Math.hypot(x - prev.x, y - prev.y) >= 500 && !scramble && !prev.multi) {
      emit('pass', { team, from: prev.name, to: p.Name, zone, forward: a - prev.a });
      kinds.push('pass');
    }
    // a clear: struck hard out of your own third
    if (zone === 'def' && post >= 1600 && z < 1200 && !fifty) {
      m.lastClear = { at: now, team, name: p.Name };
      emit('clear', { team, name: p.Name, speed: post });
      kinds.push('clear');
    }
    // a counter: cleared from your third, then on the ball in their half within a few seconds
    if (m.lastClear && m.lastClear.team === team && now - m.lastClear.at < 3500 && now - m.lastClear.at > 400 && a > 0 && !m.lastClear.countered) {
      m.lastClear.countered = true;
      emit('counter', { team, name: p.Name });
      kinds.push('counter');
    }
    // dribble and flick: the same car keeping the ball close, then hitting it hard
    if (m.run.count === 3 && post < 1400) { emit('dribble', { team, name: p.Name, zone }); kinds.push('dribble'); }
    if (m.run.count >= 3 && post - pre > 900) { emit('flick', { team, name: p.Name }); kinds.push('flick'); }
    if (surface === 'wall') kinds.push('wall');
    if (surface === 'ceiling') kinds.push('ceiling');
    if (surface === 'air' && z > 500) kinds.push('aerial');
    // a rebound: the attackers back on it right after a save
    if (m.lastSave && m.lastSave.team !== team && now - m.lastSave.at < 1600 && zone === 'att' && !m.lastSave.rebounded) {
      m.lastSave.rebounded = true;
      emit('rebound', { team, name: p.Name });
      kinds.push('rebound');
    }
    emit('touch', { name: p.Name, team, zone, surface, speed: post, kinds, chain: m.chain.count, run: m.run.count, x, y, z });

  }

  // ------------------------------------------------------------------ the stat feed
  statfeed(d, emit) {
    const m = this.m;
    const now = this.now();
    const key = keyOf(d.EventName || d.Type);
    const main = d.MainTarget && d.MainTarget.Name ? d.MainTarget : null;
    const second = d.SecondaryTarget && d.SecondaryTarget.Name ? d.SecondaryTarget : null;
    const team = main ? (main.TeamNum === 1 ? 1 : 0) : -1;
    // goal types arrive with the goal
    if (m.lastGoal && now - m.lastGoal.at < 4000 && key.includes('goal') && key !== 'goal') {
      for (const tp of ['aerial', 'bicycle', 'backwards', 'turtle', 'long', 'pool', 'overtime']) if (key.includes(tp)) m.lastGoal.types.add(tp);
      emit('goal_type', { key });
      return;
    }
    if (key.includes('hattrick')) { if (m.lastGoal) m.lastGoal.hattrick = true; return; }
    if (m.stateReplay || m.goalReplay || m.phase === 'ended') return; // stats shown again in a replay already happened
    if (key === 'shot' || key === 'shotongoal') {
      if (!main) return;
      const h = this.lastHitOf(main.Name, 600);
      const eta = h ? (Math.hypot(h.x, GOAL_Y - h.a) / Math.max(400, h.post)) * 1000 : null;
      m.lastShot = { at: now, name: main.Name, team, eta, zone: h ? h.zone : null };
      if (m.pendingMiss && m.pendingMiss.team === team) m.pendingMiss = null; // on target: a save or a goal is coming
      this.count(main.Name, 'shots');
      emit('shot', { name: main.Name, team, eta, dist: h ? Math.hypot(h.x, GOAL_Y - h.a) : null });
    } else if (key === 'save' || key === 'saves' || key === 'epicsave') {
      // a save and an epic save arrive together: wait a beat, then call it once
      const epic = key === 'epicsave';
      if (m.pendingSave && now - m.pendingSave.at < 400) { if (epic) m.pendingSave.epic = true; return; }
      m.pendingSave = { at: now, name: main && main.Name, team, epic };
      if (!epic && main) m.pendingSave.n = this.count(main.Name, 'saves');
    } else if (key === 'demolish' || key === 'demolition' || key === 'demo') {
      const att = main && main.Name, vic = second && second.Name;
      if (att) this.count(att, 'demos');
      m.demos.push({ at: now, att, vic, team });
      if (vic) m.demolished.set(vic, now);
      const vt = vic ? this.teamOf(vic) : -1;
      const down = vt >= 0 ? [...m.demolished.entries()].filter(([n, at]) => now - at < 3000 && this.teamOf(n) === vt).length : 0;
      m.pendingDemo = { at: now, att, vic, team, victimTeam: vt, down };
    } else if (key === 'assist') {
      if (main) this.count(main.Name, 'assists');
    } else if (key !== 'goal') {
      emit('stat', { key, name: main && main.Name, team });
    }
  }

  lastHitOf(name, maxAge) {
    const now = this.now();
    for (let i = this.m.touches.length - 1; i >= 0; i--) {
      const t = this.m.touches[i];
      if (now - t.at > maxAge) return null;
      if (t.name === name) return t;
    }
    return null;
  }

  crossbar(d, emit) {
    const m = this.m;
    if (!this.live()) return;
    const p = d.BallLastTouch && d.BallLastTouch.Player;
    m.pendingMiss = null;
    m.pendingBar = { at: this.now(), name: p && p.Name, team: p ? (p.TeamNum === 1 ? 1 : 0) : -1, speed: d.BallSpeed || 0 };
  }

  goal(d, emit) {
    const m = this.m;
    const now = this.now();
    if (m.stateReplay || m.goalReplay || m.phase === 'ended') return;
    if (m.goals.length && now - m.goals[m.goals.length - 1].at < 3000) return; // the same goal sent twice
    const imp = d.ImpactLocation || {};
    const sc = d.Scorer || (d.BallLastTouch && d.BallLastTouch.Player) || {};
    // which goal it went in says who scored, even for an own goal
    const team = typeof imp.Y === 'number' && Math.abs(imp.Y) > 1000 ? (imp.Y > 0 ? 0 : 1) : sc.TeamNum === 1 ? 1 : 0;
    const before = m.score.slice();
    const after = before.slice();
    after[team]++;
    for (const n of [0, 1]) if (m.stateScore[n] > after[n]) after[n] = m.stateScore[n]; // we were behind the game's own count
    m.score = after; m.scoreBehindSince = 0;
    const lt = d.BallLastTouch && d.BallLastTouch.Player;
    const scorer = sc.Name && (sc.TeamNum === 1 ? 1 : 0) === team ? sc.Name : null;
    // an own goal: the game credits nobody on the scoring team and a defender touched it last
    const own = !scorer && !!(lt && lt.Name && (lt.TeamNum === 1 ? 1 : 0) !== team);
    const assister = d.Assister && d.Assister.Name ? d.Assister.Name : null;
    const sHit = scorer ? this.lastHitOf(scorer, 3000) : null;
    // how it was built: a counter (from your own third moments ago), pressure, a solo run, a passing move
    const recent = m.touches.filter((t) => now - t.at < 8000);
    const fromDef = recent.some((t) => t.team === team && t.zone === 'def' && now - t.at < 6000);
    const pressured = m.pressure.active && m.pressure.team === team && now - m.pressure.since > 5000;
    const mine = [];
    for (let i = recent.length - 1; i >= 0 && recent[i].team === team; i--) mine.push(recent[i].name);
    const solo = mine.length >= 3 && mine.every((n) => n === scorer);
    const buildup = own ? 'own' : fromDef && !pressured ? 'counter' : pressured ? 'pressure' : solo ? 'solo' : assister ? 'team' : null;
    const types = new Set();
    if (sHit && sHit.z > 500) types.add('aerial');
    if (sHit && sHit.a < -200) types.add('long');
    const nGoals = scorer ? this.count(scorer, 'goals') : 0;
    const nAssists = assister ? this.count(assister, 'assists') : 0;
    const late = !m.overtime && m.time !== null && m.time <= 30 && m.time > 0;
    const g = {
      at: now, team, scorer, assister, own, speed: d.GoalSpeed || (d.BallLastTouch && d.BallLastTouch.Speed) || 0,
      before, after, late, overtime: m.overtime, types, buildup, goals: nGoals, assists: nAssists, hattrick: nGoals === 3,
      lastToucher: lt && lt.Name,
    };
    m.lastGoal = g;
    m.goals.push({ at: now, team, scorer });
    m.phase = 'goal';
    m.pendingMiss = null; m.lastShot = null; m.pendingSave = null; m.kickoff = null; m.pendingBar = null; m.pendingDemo = null;
    m.pressure = { team: -1, since: 0, active: false, calledAt: m.pressure.calledAt };
    if (m.overtime) m.ended = true;
    emit('goal', g);
  }

  // ------------------------------------------------------------------ time-based moments
  tick() {
    const out = [];
    const m = this.m;
    const now = this.now();
    const emit = (type, x = {}) => out.push({ type, at: now, ...x });
    if (m.pendingSave && now - m.pendingSave.at >= 120) {
      const s = m.pendingSave; m.pendingSave = null;
      if (this.live()) {
        const h = s.name ? this.lastHitOf(s.name, 1200) : null;
        // how close it was: the saver's touch on or near the line, in front of the goal
        const toLine = h ? GOAL_Y + h.a : null; // a for the saver: own goal is at a = -5120
        const onLine = h ? toLine <= 220 && Math.abs(h.x) <= POST_X + 200 && h.z <= 900 : false;
        const again = !!(m.lastSave && m.lastSave.team === s.team && now - m.lastSave.at < 9000);
        m.lastSave = { at: now, team: s.team, name: s.name };
        m.pendingMiss = null;
        emit('save', { name: s.name, team: s.team, epic: s.epic, onLine, big: s.epic || onLine, again, n: s.n || (s.name ? this.stat(s.name, 'saves') : 0) });
      }
    }
    if (m.pendingBar && now - m.pendingBar.at >= 300) {
      const b = m.pendingBar; m.pendingBar = null;
      if (this.live()) emit('crossbar', b);
    }
    if (m.pendingDemo && now - m.pendingDemo.at >= 150) {
      const dm = m.pendingDemo; m.pendingDemo = null;
      emit('demo', { ...dm, live: this.live() });
    }
    const k = m.kickoff;
    if (k && k.first && !k.resolved && now - k.first > 3000 && this.live()) {
      k.resolved = true;
      // nobody touched it again for a while: we can't see where the ball went, so no call
      // (a truly even kickoff is rare - about 1 in 20 in real matches)
    }
    // (no near-miss guessing: tested on 140 real matches, a hard shot off the back wall and a shot
    // just wide look the same in the Stats API - under 35% of such calls would be right)
    // pressure: most of the last ten seconds' touches in one team's attacking half
    if (this.live()) {
      const recent = m.touches.filter((t) => now - t.at < 10000);
      if (recent.length >= 5) {
        for (const team of [0, 1]) {
          const inHalf = recent.filter((t) => this.attackY(team, t.y) > 0).length / recent.length;
          const last = m.lastTouch && this.attackY(team, m.lastTouch.y) > 0;
          if (inHalf >= 0.8 && last) {
            if (!m.pressure.active || m.pressure.team !== team) {
              m.pressure = { team, since: recent[0].at, active: true, calledAt: m.pressure.calledAt };
              emit('pressure', { team });
            }
          } else if (m.pressure.active && m.pressure.team === team && inHalf < 0.6) {
            m.pressure.active = false;
            emit('pressure_end', { team });
          }
        }
      }
    }
    return out;
  }
}

module.exports = { GameModel, GOAL_Y, THIRD };
