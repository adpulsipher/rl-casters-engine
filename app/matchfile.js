'use strict';
// "--play <file>" ("Play a match.bat"): a recorded match sent to the casters with its real
// timing, so you can hear them call any match without starting the game. A match file is
// what the match recorder saves (Casters\captures\match ....jsonl.gz) or a Rocket League
// .replay turned into one by "Convert replay.bat" (the matches folder next to the exe).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const isMatchFile = (n) => /\.jsonl(\.gz)?$/i.test(n);

// the file asked for, or else the newest match file in these folders
function find(arg, dirs) {
  if (arg && !String(arg).startsWith('--')) {
    const f = path.resolve(String(arg));
    return fs.existsSync(f) ? f : null;
  }
  let best = null;
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d); } catch (e) { continue; }
    for (const n of names) {
      if (!isMatchFile(n)) continue;
      const f = path.join(d, n);
      const t = fs.statSync(f).mtimeMs;
      if (!best || t > best.t) best = { f, t };
    }
  }
  return best ? best.f : null;
}

// the events in a match file: one JSON object per line, {"t": ms, "e": name, "d": data}
function load(file) {
  let buf = fs.readFileSync(file);
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    // a recording cut off by the game closing still plays up to where it stops
    buf = zlib.gunzipSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  }
  const events = [];
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (e) { continue; }
    if (r && typeof r.e === 'string') events.push({ t: Number(r.t) || 0, name: r.e, data: r.d || {} });
  }
  events.sort((a, b) => a.t - b.t);
  return events;
}

// who's playing, for the opening line
function summary(events) {
  const players = [[], []];
  const teams = ['Blue', 'Orange'];
  let last = null;
  for (const e of events) {
    if (e.name !== 'UpdateState' || !e.data) continue;
    last = e.data;
    for (const p of e.data.Players || []) {
      if (p && p.Name && (p.TeamNum === 0 || p.TeamNum === 1) && !players[p.TeamNum].includes(p.Name)) players[p.TeamNum].push(p.Name);
    }
    for (const tm of (e.data.Game && e.data.Game.Teams) || []) {
      if (tm && tm.Name && (tm.TeamNum === 0 || tm.TeamNum === 1)) teams[tm.TeamNum] = tm.Name;
    }
  }
  const score = [0, 1].map((n) => {
    const tm = last && last.Game && (last.Game.Teams || []).find((x) => x && x.TeamNum === n);
    return tm && Number.isFinite(tm.Score) ? tm.Score : null;
  });
  const minutes = events.length ? (events[events.length - 1].t - events[0].t) / 60000 : 0;
  return { players, teams, score, minutes };
}

// Plays the events, calling emit(name, data) in real time. A long gap (the game paused, or
// left in a menu) is shortened to two seconds.
//
// sync: line it up with a video of the match. Nothing starts until release() (Space), and
// every kickoff countdown is a sync point: playback holds there until release(). A release
// that comes early, between a goal and its kickoff, jumps straight to the countdown. During
// live play a release does nothing, so a stray key can't skip any of the match.
const NOISY = new Set(['UpdateState', 'BallHit', 'ClockUpdatedSeconds', 'StatfeedEvent']);

function run(events, emit, { onDone, sync = false, onWait } = {}) {
  const sched = [];
  let at = 0;
  for (let i = 0; i < events.length; i++) {
    const gap = i ? events[i].t - events[i - 1].t : 0;
    at += gap > 10000 ? 2000 : Math.max(0, gap);
    sched.push(at);
  }
  const isKickoff = (k) => events[k].name === 'CountdownBegin';
  const kickoffNo = (k) => { let n = 0; for (let x = 0; x <= k; x++) if (isKickoff(x)) n++; return n; };
  const released = new Set();
  let t0 = Date.now(), i = 0, timer = null, stopped = false;
  let waiting = sync ? 'start' : null; // 'start' | index of the kickoff held at | null
  let pausedAt = 0;

  const clock = () => (pausedAt || Date.now()) - t0;
  const schedule = () => {
    clearTimeout(timer);
    if (!stopped && !pausedAt && waiting === null && i < events.length) timer = setTimeout(next, Math.max(5, sched[i] - clock()));
  };
  const next = () => {
    if (stopped || pausedAt || waiting !== null) return;
    while (i < events.length && sched[i] <= clock()) {
      if (sync && isKickoff(i) && !released.has(i)) {
        waiting = i;
        if (onWait) onWait(kickoffNo(i));
        return;
      }
      const e = events[i++];
      emit(e.name, e.data);
    }
    if (i < events.length) schedule();
    else if (onDone) onDone();
  };
  // start the kickoff countdown at index k right now
  const goTo = (k) => {
    // what's skipped on the way still happens (the replay starting and ending), minus the
    // touches and clock ticks; the last state update is kept so the score and clock are right
    let lastState = null;
    for (let x = i; x < k; x++) {
      const e = events[x];
      if (e.name === 'UpdateState') lastState = e;
      else if (!NOISY.has(e.name)) emit(e.name, e.data);
    }
    if (lastState) emit(lastState.name, lastState.data);
    i = k;
    released.add(k);
    waiting = null;
    t0 = Date.now() - sched[k];
    next();
  };
  // Space: returns 'started', 'synced', 'jumped', 'live' (ignored during play) or 'over'
  const release = () => {
    if (stopped || !sync) return 'over';
    if (pausedAt) togglePause();
    if (waiting === 'start' || waiting === null) {
      let k = i;
      while (k < events.length && !isKickoff(k)) k++;
      if (k >= events.length) return 'over';
      if (waiting === null) {
        // only between a goal and its kickoff: no live touch may be skipped
        let replay = false; // already in a goal replay?
        for (let x = i - 1; x >= 0; x--) {
          const n = events[x].name;
          if (n === 'GoalReplayStart' || n === 'GoalReplayEnd') { replay = n === 'GoalReplayStart'; break; }
        }
        for (let x = i; x < k; x++) {
          const n = events[x].name;
          if (n === 'GoalReplayStart') replay = true;
          else if (n === 'GoalReplayEnd') replay = false;
          else if (n === 'BallHit' && !replay) return 'live';
        }
      }
      const was = waiting;
      goTo(k);
      return was === 'start' ? 'started' : 'jumped';
    }
    goTo(waiting);
    return 'synced';
  };
  // P: freeze the match where it is (the line being said finishes), and carry on later
  const togglePause = () => {
    if (stopped) return false;
    if (pausedAt) { t0 += Date.now() - pausedAt; pausedAt = 0; schedule(); return false; }
    pausedAt = Date.now();
    clearTimeout(timer);
    return true;
  };
  if (!sync) next();
  return {
    stop: () => { stopped = true; clearTimeout(timer); },
    release,
    togglePause,
    get waiting() { return waiting; },
  };
}

module.exports = { find, load, summary, run, isMatchFile };
