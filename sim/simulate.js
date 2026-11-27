#!/usr/bin/env node
'use strict';
// Runs the casters' engine over a recorded match (a match-recorder capture or a converted
// replay) in virtual time, with a simulated voice pack and audio device, and writes what
// was said, when, and how it lines up with what really happened.
//
// usage: simulate.js <stream.jsonl.gz> [--truth f.truth.json] [--out result.json] [--pack current|full]
//                    [--inventory sim/data/inventory.json] [--seed n] [--transcript file.txt] [--hub] [--pace normal]

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

// ------------------------------------------------------------------ virtual time
const realSetImmediate = setImmediate;
let NOW = Date.UTC(2026, 10, 24, 20, 0, 0);
let SEQ = 0;
const timers = new Map();
const mkHandle = (id) => ({ id, unref() { return this; }, ref() { return this; }, hasRef() { return true; }, [Symbol.toPrimitive]() { return id; } });
const idOf = (h) => (h && typeof h === 'object' ? h.id : h);
global.Date.now = () => NOW;
global.setTimeout = (fn, ms, ...a) => { const id = ++SEQ; timers.set(id, { at: NOW + Math.max(0, Number(ms) || 0), fn, a, every: 0 }); return mkHandle(id); };
global.setInterval = (fn, ms, ...a) => { const id = ++SEQ; const every = Math.max(1, Number(ms) || 1); timers.set(id, { at: NOW + every, fn, a, every }); return mkHandle(id); };
global.clearTimeout = (h) => timers.delete(idOf(h));
global.clearInterval = (h) => timers.delete(idOf(h));
const flush = () => new Promise((r) => realSetImmediate(r));
async function runUntil(t) {
  for (;;) {
    let best = null, bid = null;
    for (const [id, x] of timers) if (x.at <= t && (!best || x.at < best.at || (x.at === best.at && id < bid))) { best = x; bid = id; }
    if (!best) break;
    NOW = Math.max(NOW, best.at);
    if (best.every) best.at += best.every; else timers.delete(bid);
    try { best.fn(...best.a); } catch (e) { errors.push(String(e.stack || e)); }
    await flush();
  }
  NOW = Math.max(NOW, t);
}
const errors = [];

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(k);
const streamFile = argv[0];
const truthFile = opt('--truth', streamFile.replace(/\.jsonl\.gz$/, '.truth.json'));
const SEED = Number(opt('--seed', '1'));
const PACK = opt('--pack', 'full');
const LAT = Number(opt('--latency', '200'));
// seeded randomness, so a run can be repeated exactly
let rs = (SEED * 2654435761) >>> 0 || 1;
Math.random = () => { rs ^= rs << 13; rs >>>= 0; rs ^= rs >>> 17; rs ^= rs << 5; rs >>>= 0; return rs / 4294967296; };

// ------------------------------------------------------------------ the voice pack
const APP = process.env.RLCC_APP || path.join(__dirname, '..', 'app'); // RLCC_APP: grade another copy of the app (an older version, say)
const { keyOf } = require(path.join(APP, 'pack.js'));
const INV = JSON.parse(fs.readFileSync(opt('--inventory', path.join(__dirname, 'data', 'inventory.json')), 'utf8'));
const lineMs = new Map(Object.entries(INV.current));
if (PACK === 'full') for (const [k, v] of Object.entries(INV.new)) lineMs.set(k, v);
const packPlayers = INV.players.map((p) => p.split('=')[0].trim());
const packTeams = INV.teams.map((p) => p.split('=')[0].trim());
const voice = {
  strict: true,
  info: { name: 'Sim', players: packPlayers, teams: packTeams, oneVoice: true },
  size: lineMs.size,
  find(c) { return lineMs.has(keyOf(c.role, c.mood || 'lively', c.text)); },
  has(c) { return this.find(c); },
  durationOf(c) { return lineMs.get(keyOf(c.role, c.mood || 'lively', c.text)) || 0; },
  request(c) { const ms = this.durationOf(c); return ms ? new Promise((r) => setTimeout(() => r({ file: 'sim', ms }), 12)) : Promise.reject(new Error('not in pack')); },
  prefetch() {}, dropBackground() {}, get queued() { return 0; }, get busy() { return false; }, get avgRenderMs() { return 0; },
};

// ------------------------------------------------------------------ the audio device
const timeline = []; // { start, end, text, role, mood, cat, kind (the call it was part of), how }
let lastSayKind = null;
class SimPlayer {
  constructor() { this.cur = null; this.fadeUntil = 0; }
  play(clip) {
    this.stop();
    const go = () => new Promise((resolve) => {
      const rec = { start: NOW + LAT, end: NOW + LAT + clip.ms, ms: clip.ms }; // play() to sound
      const timer = setTimeout(() => { this.cur = null; resolve(true); }, clip.ms + LAT);
      this.cur = { rec, timer, resolve };
      this.lastRec = rec;
    });
    const wait = Math.max(0, this.fadeUntil - NOW);
    return wait ? new Promise((r) => setTimeout(r, wait)).then(go) : go();
  }
  stop() { if (!this.cur) return; const c = this.cur; this.cur = null; clearTimeout(c.timer); c.rec.end = Math.min(c.rec.end, NOW); c.resolve(false); }
  fadeOut(ms) { if (!this.cur) return; const c = this.cur; this.cur = null; clearTimeout(c.timer); c.rec.end = Math.min(c.rec.end, NOW + ms); this.fadeUntil = NOW + ms + 30; c.resolve(false); }
  get playing() { return !!this.cur; }
  close() {}
}

// ------------------------------------------------------------------ the match
const rows = zlib.gunzipSync(fs.readFileSync(streamFile)).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
const truth = fs.existsSync(truthFile) ? JSON.parse(fs.readFileSync(truthFile, 'utf8')) : null;
const header = rows.find((r) => r.k === 'header') || {};
// rename the players to names in the voice pack (one stays unknown, like your own player)
const realNames = header.players || (truth && truth.summary.players.map((p) => p.name)) || [];
const shuffled = packPlayers.slice().sort(() => Math.random() - 0.5);
const rename = new Map();
// --real-names keeps the match's own names (a pro match whose players are in the pack)
realNames.forEach((n, i) => rename.set(n, flag('--real-names') ? n : i === realNames.length - 1 && !flag('--all-known') ? 'Unknown Player' : shuffled[i]));
const R = (n) => (rename.has(n) ? rename.get(n) : n);
function renameDeep(o) {
  if (Array.isArray(o)) return o.map(renameDeep);
  if (o && typeof o === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(o)) out[k] = (k === 'Name' || k === 'PlayerName') && typeof v === 'string' ? R(v) : renameDeep(v);
    return out;
  }
  return o;
}

const log = (m) => { logs.push(`[${((NOW - T0) / 1000).toFixed(1)}] ${m}`); if (/error/i.test(m)) errors.push(m); };
const logs = [];
const trace = [];
let T0 = NOW;
// --hub: a stand-in for RL Career Hub that, like the real one mid-series, still says game 1
// (--hub-teams "A,B" names the teams; --hub-bestof n)
const hubTeams = flag('--hub') ? (opt('--hub-teams') ? opt('--hub-teams').split(',') : packTeams.slice().sort(() => Math.random() - 0.5).slice(0, 2)) : null;
const hub = hubTeams ? {
  contextFor: ({ players }) => (!players.length ? null : { teamNames: hubTeams, describe: `${hubTeams[0]} vs ${hubTeams[1]}`, game: 1, wins: [0, 0], bestOf: Number(opt('--hub-bestof', 5)), kind: 'regional', stage: opt('--hub-stage', 'semi'),
    place: [2, 5], placeIfWin: [1, 5],
    form: [{ played: 5, won: 3, lost: 0 }, { played: 5, won: 0, lost: 2 }], table: null, metBefore: true,
    seasonGoals: () => 4, seasonSaves: () => 9, topScorer: () => false }),
} : null;

async function main() {
  const player = new SimPlayer();
  const config = { chatter: opt('--pace', 'normal'), pronunciations: {}, units: 'kph', cutIn: opt('--cut-in', process.env.RLCC_CUT_IN || 'deciding') };
  let commentary, speaker;
  {
    const { Speaker } = require(path.join(APP, 'speaker.js'));
    const { Commentary } = require(path.join(APP, 'commentary.js'));
    speaker = new Speaker({ tts: voice, player, log, oneVoice: true,
      onLine: (c) => timeline.push({ start: NOW + LAT, end: null, text: c.text, role: c.role, mood: c.mood, cat: c.cat, kind: lastSayKind }),
      onLineEnd: (c, how) => { const tl = timeline[timeline.length - 1]; if (tl && tl.text === c.text && tl.end === null) { tl.end = NOW + (how === 'cut' ? 140 : 0); tl.how = how; } } });
    commentary = new Commentary({ tts: voice, speaker, config, log, statePath: null, hub, trace: (k, x) => { if (k === 'say') lastSayKind = x.kind; trace.push({ t: NOW - T0, k, ...x, clip: x.clip ? { text: x.clip.text, cat: x.clip.cat } : undefined }); } });
  }
  // capture each line's real end time from the player
  const origPlay = player.play.bind(player);
  player.play = (clip) => { const p = origPlay(clip); const tl = timeline[timeline.length - 1]; setTimeout(() => { if (tl && !tl.rec) tl.rec = player.lastRec; }, 61); return p; };

  T0 = NOW;
  const events = rows.filter((r) => r.e);
  for (const r of events) {
    await runUntil(T0 + r.t);
    try { commentary.handle(r.e, renameDeep(r.d)); } catch (e) { errors.push(String(e.stack || e)); }
  }
  await runUntil(NOW + 20000);
  commentary.close && commentary.close();
  for (const tl of timeline) { if (tl.end === null) { const rec = tl.rec || {}; tl.end = rec.end || tl.start + 1500; tl.how = tl.how || 'done'; } delete tl._p; delete tl.rec; tl.start -= T0; tl.end -= T0; }
  const res = { stream: path.basename(streamFile), pack: PACK, seed: SEED, rename: Object.fromEntries(rename), hubTeams, timeline, trace, errors, logs: logs.slice(-50) };
  const out = opt('--out');
  if (out) fs.writeFileSync(out, JSON.stringify(res));
  if (opt('--transcript')) {
    const ev = events.filter((r) => ['GoalScored', 'RoundStarted', 'CountdownBegin', 'GoalReplayStart', 'GoalReplayEnd', 'MatchEnded', 'CrossbarHit'].includes(r.e)
      || (r.e === 'StatfeedEvent' && ['Save', 'EpicSave', 'Shot', 'Demolish'].includes(r.d.EventName)));
    const lines = [];
    for (const r of ev) lines.push([r.t, `      -- ${r.e === 'StatfeedEvent' ? r.d.EventName + ' ' + R(r.d.MainTarget.Name) : r.e === 'GoalScored' ? 'GOAL ' + R(r.d.Scorer.Name) : r.e}`]);
    for (const tl of timeline) lines.push([tl.start, `${tl.how === 'cut' ? 'x' : ' '} ${(tl.cat || '').padEnd(16)} ${tl.text}`]);
    lines.sort((a, b) => a[0] - b[0]);
    fs.writeFileSync(opt('--transcript'), lines.map(([t, s]) => `${(t / 1000).toFixed(1).padStart(6)} ${s}`).join('\n') + '\n');
  }
  if (!out) console.log(JSON.stringify({ lines: timeline.length, errors: errors.length }));
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
