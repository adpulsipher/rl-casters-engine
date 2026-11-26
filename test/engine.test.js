'use strict';
// Engine tests: run with `node app/test/engine.test.js` (no test framework needed).
// A fake clock drives the model, the director and the speaker, so these run in a moment.

const assert = require('assert');
const path = require('path');

// ---------------------------------------------------------------- a fake clock for everything
let NOW = 1e12, SEQ = 0;
const timers = new Map();
global.Date.now = () => NOW;
global.setTimeout = (fn, ms) => { const id = ++SEQ; timers.set(id, { at: NOW + (ms || 0), fn }); return id; };
global.clearTimeout = (id) => timers.delete(id);
global.setInterval = (fn, ms) => { const id = ++SEQ; const t = { at: NOW + ms, fn, every: ms }; timers.set(id, t); return id; };
global.clearInterval = (id) => timers.delete(id);
const tick = () => new Promise((r) => setImmediate(r));
async function advance(ms) {
  const end = NOW + ms;
  for (;;) {
    let best = null, bid = null;
    for (const [id, x] of timers) if (x.at <= end && (!best || x.at < best.at)) { best = x; bid = id; }
    if (!best) break;
    NOW = best.at;
    if (best.every) best.at += best.every; else timers.delete(bid);
    best.fn();
    await tick();
  }
  NOW = end;
}

const APP = path.join(__dirname, '..', 'app');
const { GameModel } = require(path.join(APP, 'engine/model'));
const { Library, MAX_PER_MATCH, MAX_SHORT, isShort } = require(path.join(APP, 'engine/library'));
const { Speaker } = require(path.join(APP, 'speaker'));
const { Commentary } = require(path.join(APP, 'commentary'));
const C = require(path.join(APP, 'engine/catalog'));

// a voice that has every line, each 1.5 s long
const voice = (has = () => true) => ({
  strict: true, info: {}, size: 1,
  has: (c) => has(c), find: (c) => has(c), durationOf: () => 1500,
  request: (c) => (has(c) ? Promise.resolve({ file: 'x', ms: 1500 }) : Promise.reject(new Error('no'))), prefetch() {},
});
class FakePlayer {
  constructor() { this.cur = null; this.log = []; }
  play(clip) { this.log.push(clip); return new Promise((r) => { const id = setTimeout(() => { this.cur = null; r(true); }, clip.ms); this.cur = { id, r }; }); }
  stop() { if (this.cur) { clearTimeout(this.cur.id); this.cur.r(false); this.cur = null; } }
  fadeOut() { this.stop(); }
}
const P = (n, t) => ({ Name: n, Shortcut: 1, TeamNum: t });
const players = [['A1', 0], ['A2', 0], ['A3', 0], ['B1', 1], ['B2', 1], ['B3', 1]];
const state = (score = [0, 0], time = 300, extra = {}) => ({
  Players: players.map(([n, t]) => ({ ...P(n, t), Goals: 0, Saves: 0, Shots: 0, Assists: 0, Demos: 0, Score: 0 })),
  Game: { Teams: [{ Name: 'Blue', TeamNum: 0, Score: score[0] }, { Name: 'Orange', TeamNum: 1, Score: score[1] }], TimeSeconds: time, bOvertime: false, Ball: { Speed: 1000, TeamNum: 0 }, bReplay: false, ...extra },
});
const hit = (n, t, x, y, z = 93, post = 1200) => ({ Players: [P(n, t)], Ball: { PreHitSpeed: 500, PostHitSpeed: post, Location: { X: x, Y: y, Z: z } } });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------------------------------------------------------------- the library
test('library never gives a sentence twice in a match (a short call at most twice)', () => {
  for (const cat of ['save_generic', 'save_g_short']) {
    const lib = new Library({ tts: voice() });
    const seen = new Map();
    for (let i = 0; i < 200; i++) {
      const c = lib.pick([cat]);
      if (!c) break;
      lib.said(c);
      seen.set(c.text, (seen.get(c.text) || 0) + 1);
    }
    for (const [t, n] of seen) assert.ok(n <= (isShort({ text: t }) ? MAX_SHORT : MAX_PER_MATCH), `${t} said ${n} times`);
    assert.strictEqual(lib.pick([cat]), null, 'runs out instead of a repeat');
  }
});
test('library uses every line once in a match, and starts over next match', () => {
  const lib = new Library({ tts: voice() });
  const cat = 'save_generic';
  const n = C.LINES[cat].length;
  const first = new Set();
  for (let i = 0; i < n; i++) { const c = lib.pick([cat]); lib.said(c); first.add(c.text); }
  assert.strictEqual(first.size, n, 'every line once');
  assert.strictEqual(lib.pick([cat]), null, 'nothing twice in a match');
  lib.newMatch();
  assert.ok(lib.pick([cat]), 'a new match can use them again');
});
test('a sentence stays out for three games in a row, and that survives a restart', () => {
  const lib = new Library({ tts: voice() });
  const all = lib.options(['save_generic']);
  const x = all.find((c) => !isShort(c));
  lib.said(x);
  const other = all.filter((c) => c.text !== x.text && !isShort(c));
  lib.newMatch(); // game 2
  lib.said(other[0]);
  assert.ok(!lib.unused(x, 0), 'not in game 2');
  assert.ok(lib.unused(x, 1), 'but there if a call would have nothing else');
  const saved = JSON.parse(JSON.stringify(lib.dump()));
  const again = new Library({ tts: voice() });
  again.load(saved);
  again.newMatch(); // game 3, after a restart
  again.said(other[1]);
  assert.ok(!again.unused(x, 0), 'not in game 3 either');
  again.newMatch(); // game 4
  assert.ok(again.unused(x, 0), 'back in game 4');
  const old = new Library({ tts: voice() });
  old.load([[x.text, 1]]); // a 2.0 save file
  assert.ok(old.unused(x, 0));
});
test('library treats a sentence template as said, whatever name was in it', () => {
  const lib = new Library({ tts: voice() });
  let a = null;
  for (let i = 0; i < 40 && (!a || isShort(a)); i++) a = lib.pick([['save', { name: 'Vatira' }]]); // a sentence, not a short call
  lib.said(a);
  for (let i = 0; i < 40; i++) {
    const b = lib.pick([['save', { name: 'Zen' }]]);
    if (!b) break;
    assert.notStrictEqual(b.tpl, a.tpl, `"${a.tpl}" came back with another name`);
    lib.said(b);
  }
});
test('library respects the time there is', () => {
  const lib = new Library({ tts: { ...voice(), durationOf: (c) => c.text.length * 100 } });
  const c = lib.pick(['filler_g_color'], {}, { maxMs: 2500 });
  assert.ok(!c || c.text.length * 100 <= 2500);
});
test('library only uses recorded lines with a voice pack', () => {
  const only = 'Saved!';
  const lib = new Library({ tts: voice((c) => c.text === only) });
  assert.strictEqual(lib.pick(['save_generic', 'save_g_short']).text, only);
});

// ---------------------------------------------------------------- the model
const model = () => { const m = new GameModel({ now: () => NOW }); m.handle('MatchCreated'); m.handle('UpdateState', state()); m.handle('CountdownBegin'); m.handle('RoundStarted'); return m; };
test('a goal is counted once even if the score update comes first', () => {
  const m = model();
  m.handle('UpdateState', state([1, 0]));
  const out = m.handle('GoalScored', { Scorer: P('A1', 0), ImpactLocation: { X: 0, Y: 5200, Z: 100 }, BallLastTouch: { Player: P('A1', 0) } });
  assert.deepStrictEqual(out.find((o) => o.type === 'goal').after, [1, 0]);
  assert.deepStrictEqual(m.m.score, [1, 0]);
  assert.strictEqual(m.handle('GoalScored', { Scorer: P('A1', 0), ImpactLocation: { X: 0, Y: 5200, Z: 100 } }).length, 0, 'the same goal twice');
});
test('own goal only when no scorer on the scoring team', () => {
  let m = model();
  let g = m.handle('GoalScored', { Scorer: P('A1', 0), ImpactLocation: { Y: 5200 }, BallLastTouch: { Player: P('B1', 1) } }).find((o) => o.type === 'goal');
  assert.strictEqual(g.own, false, 'a deflection off a defender is still the attacker\'s goal');
  m = model();
  g = m.handle('GoalScored', { Scorer: {}, ImpactLocation: { Y: 5200 }, BallLastTouch: { Player: P('B1', 1) } }).find((o) => o.type === 'goal');
  assert.strictEqual(g.own, true);
  assert.strictEqual(g.team, 0, 'the goal it went in decides who scored');
});
test('touches during a replay are not live play', () => {
  const m = model();
  m.handle('GoalScored', { Scorer: P('A1', 0), ImpactLocation: { Y: 5200 } });
  m.handle('GoalReplayStart');
  assert.strictEqual(m.handle('BallHit', hit('A1', 0, 0, 3000)).length, 0);
  assert.strictEqual(m.handle('StatfeedEvent', { EventName: 'Save', MainTarget: P('B1', 1) }).length, 0);
});
test('save and epic save arriving together make one big save', async () => {
  const m = model();
  m.handle('BallHit', hit('B1', 1, 0, 5000, 100));
  m.handle('StatfeedEvent', { EventName: 'Save', MainTarget: P('B1', 1) });
  m.handle('StatfeedEvent', { EventName: 'EpicSave', MainTarget: P('B1', 1) });
  NOW += 200;
  const saves = m.tick().filter((o) => o.type === 'save');
  assert.strictEqual(saves.length, 1);
  assert.ok(saves[0].big);
});
test('a pass needs distance, and not a scramble', () => {
  const m = model();
  m.handle('BallHit', hit('A1', 0, 0, 0)); NOW += 1000; // kickoff contact
  m.handle('BallHit', hit('A1', 0, 0, 200)); NOW += 900;
  let out = m.handle('BallHit', hit('A2', 0, 0, 1400));
  assert.ok(out.some((o) => o.type === 'pass'), 'A1 to A2 over 12 m');
  NOW += 300;
  out = m.handle('BallHit', hit('A3', 0, 0, 1500));
  assert.ok(!out.some((o) => o.type === 'pass'), '1 m is a touch, not a pass');
});
test('a missed kickoff event still gets play going', () => {
  const m = new GameModel({ now: () => NOW });
  m.handle('MatchCreated'); m.handle('UpdateState', state([0, 0], 300)); m.handle('CountdownBegin');
  NOW += 3000; m.handle('UpdateState', state([0, 0], 299));
  assert.ok(m.live());
});
test('play resumes after a goal even without kickoff events', () => {
  const m = model();
  m.handle('UpdateState', state([0, 0], 250));
  m.handle('GoalScored', { Scorer: P('A1', 0), ImpactLocation: { Y: 5200 } });
  NOW += 15000; m.handle('UpdateState', state([1, 0], 250));
  NOW += 1000; m.handle('UpdateState', state([1, 0], 249));
  assert.ok(m.live());
});
test('joining mid-match works', () => {
  const m = new GameModel({ now: () => NOW });
  const out = m.handle('UpdateState', state([2, 1], 120));
  assert.ok(out.some((o) => o.type === 'joined_late'));
  NOW += 1600; m.handle('UpdateState', state([2, 1], 119));
  assert.deepStrictEqual(m.m.score, [2, 1], 'catches up with the game\'s score');
});
test('rubbish in, no crash', () => {
  const m = model();
  for (const [e, d] of [['BallHit', {}], ['BallHit', { Players: [null] }], ['StatfeedEvent', {}], ['GoalScored', {}], ['UpdateState', { Players: [null, {}], Game: { Teams: [null] } }],
    ['CrossbarHit', {}], ['Nope', null], ['ClockUpdatedSeconds', { TimeSeconds: 'x' }], ['MatchEnded', {}], ['PlayerLeft', {}]]) {
    try { m.handle(e, d); m.tick(); } catch (err) { if (!/null|undefined/.test(err.message)) throw err; throw new Error(`${e}: ${err.message}`); }
  }
});

// ---------------------------------------------------------------- the whole engine
async function engine(opts = {}) {
  const player = new FakePlayer();
  const said = [];
  const speaker = new Speaker({ tts: voice(opts.has), player, log: () => {}, oneVoice: true, onLine: (c) => said.push({ at: NOW, ...c }) });
  const c = new Commentary({ tts: voice(opts.has), speaker, config: { chatter: opts.pace || 'normal', pronunciations: {} }, log: (m) => { if (/error/i.test(m)) throw new Error(m); }, statePath: null });
  c.handle('MatchCreated'); c.handle('UpdateState', state()); c.handle('MatchInitialized'); c.handle('CountdownBegin');
  await advance(3000); c.handle('RoundStarted');
  return { c, said, player, speaker };
}
test('a game-deciding goal (one that takes the lead) cuts in at once', async () => {
  const { c, said } = await engine();
  await advance(1000); c.handle('BallHit', hit('A1', 0, 0, 0)); await advance(5000);
  const before = said.length;
  c.handle('GoalScored', { Scorer: P('A1', 0), ImpactLocation: { Y: 5200 } });
  await advance(400);
  const call = said.slice(before).find((x) => /goal/.test(x.cat));
  assert.ok(call, 'goal called');
  assert.ok(NOW - call.at < 400);
  c.close();
});
test('a goal that decides nothing waits for the line being said to finish', async () => {
  const { c, said, speaker } = await engine();
  c.handle('UpdateState', state([3, 0], 200)); await advance(1600); c.handle('UpdateState', state([3, 0], 199)); // 3-0 up
  await advance(2000);
  assert.deepStrictEqual(c.model.m.score, [3, 0]);
  // a colour line (a call about the play itself - the shot, the touch - is followed at the next
  // pause between words instead: next test)
  for (let i = 0; i < 40 && speaker.current; i++) await advance(200);
  c.director.say('color', 20, [c.lib.pick(['filler_g_color'], {}, { allowRepeat: true })]);
  await advance(300);
  assert.ok(speaker.current, 'a line is being said');
  const ends = speaker.current.clipEnd;
  const before = said.length;
  c.handle('GoalScored', { Scorer: P('A1', 0), ImpactLocation: { Y: 5200 } });
  c.handle('UpdateState', state([4, 0], 199));
  await advance(4000);
  const call = said.slice(before).find((x) => /^goal/.test(x.cat));
  assert.ok(call, 'goal called');
  assert.ok(call.at >= ends, `not before the line ended (${call.at - ends} ms; score was ${c.model.m.score}, decisive ${c.director.goalCtx && c.director.goalCtx.decisive})`);
  assert.ok(!/^goal$|^goal_generic$/.test(call.cat), `4-0 isn't celebrated like a big goal (${call.cat})`);
  c.close();
});
test('a goal follows a call about the play (the shot) at the next pause, not the end of it', async () => {
  const { c, said, speaker } = await engine();
  c.handle('UpdateState', state([3, 0], 200)); await advance(1600); c.handle('UpdateState', state([3, 0], 199));
  await advance(2000);
  for (let i = 0; i < 40 && speaker.current; i++) await advance(200);
  c.director.say('shot', 60, [c.lib.pick(['filler_g_color'], {}, { allowRepeat: true })]); // a long line, said as the shot call
  await advance(300);
  const ends = speaker.current.clipEnd;
  const before = said.length;
  c.handle('GoalScored', { Scorer: P('A1', 0), ImpactLocation: { Y: 5200 } });
  c.handle('UpdateState', state([4, 0], 199));
  await advance(4000);
  const call = said.slice(before).find((x) => /^goal/.test(x.cat));
  assert.ok(call, 'goal called');
  assert.ok(call.at < ends - 300, `it didn't wait for the shot line to end (${call.at - ends} ms)`);
  c.close();
});
test('which goals decide the game', async () => {
  const { c } = await engine();
  const D = c.director;
  const g = (before, team, extra = {}) => ({ before, after: before.map((v, i) => (i === team ? v + 1 : v)), team, overtime: false, ...extra });
  D.model.m.time = 200;
  assert.ok(D.decisive(g([0, 0], 0)), 'first goal takes the lead');
  assert.ok(D.decisive(g([2, 2], 1)), 'a go-ahead goal');
  assert.ok(!D.decisive(g([1, 0], 0)), '2-0 is not deciding');
  assert.ok(!D.decisive(g([2, 0], 1)), '2-1 with 200 s left is not');
  assert.ok(D.decisive(g([0, 0], 0, { overtime: true })), 'overtime');
  D.model.m.time = 45;
  assert.ok(D.decisive(g([3, 1], 1)), '3-2 with 45 s left: back within one');
  assert.ok(D.decisive(g([2, 1], 1)), 'level with 45 s left');
  assert.ok(!D.decisive(g([2, 1], 0)), 'going 3-1 up late is not');
  c.close();
});
test('an early routine save gets a calm line, not a miracle', async () => {
  for (let n = 0; n < 6; n++) {
    const { c, said } = await engine();
    c.handle('UpdateState', state([0, 0], 280));
    await advance(6000);
    const before = said.length;
    c.handle('BallHit', hit('B1', 1, 0, 5000, 100));
    c.handle('StatfeedEvent', { EventName: 'Save', MainTarget: P('B1', 1) });
    c.handle('StatfeedEvent', { EventName: 'EpicSave', MainTarget: P('B1', 1) });
    await advance(3000);
    const call = said.slice(before).find((x) => x.kind === 'save' || /save|defend|filler/.test(x.cat));
    if (call) assert.ok(!/epicsave|impossible|miracle|unbelievable|incredible|how did/i.test(call.cat + ' ' + call.text), `early save called "${call.text}"`);
    c.close();
  }
});
test('a line is broken off at a pause between words', async () => {
  const fs = require('fs'), os = require('os');
  const { gapsOf } = require(path.join(APP, 'speaker'));
  const sr = 24000, x = new Float32Array(sr * 2);
  for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = (t > 0.1 && t < 0.7) || (t > 0.85 && t < 1.8) ? 0.3 * Math.sin(2 * Math.PI * 220 * t) : 0; }
  const { wavBuffer } = require(path.join(APP, 'tts'));
  const f = path.join(os.tmpdir(), `rlcc-gap-${process.pid}.wav`);
  fs.writeFileSync(f, wavBuffer(x, sr));
  const gaps = gapsOf(f);
  fs.unlinkSync(f);
  assert.ok(gaps.some((g) => g >= 700 && g <= 790), `the pause at 0.70-0.85 s is found (${gaps})`);
});
test('lines come out at the same loudness, whatever level they were recorded at', () => {
  const { processVoice } = require(path.join(APP, 'tts'));
  const sr = 24000;
  const make = (amp) => { const x = new Float32Array(sr * 1.5); for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = t > 0.2 && t < 1.3 ? amp * Math.sin(2 * Math.PI * 180 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t)) : 0; } return x; };
  const level = (x) => { let s = 0, n = 0; for (const v of x) if (Math.abs(v) > 0.005) { s += v * v; n++; } return 10 * Math.log10(s / n); };
  const quiet = level(processVoice(make(0.05), sr)), loud = level(processVoice(make(0.6), sr));
  assert.ok(Math.abs(quiet - loud) < 1.5, `quiet ${quiet.toFixed(1)} dB vs loud ${loud.toFixed(1)} dB`);
  let peak = 0; for (const v of processVoice(make(0.9), sr)) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak <= 10 ** (-1 / 20) + 1e-3, 'peaks stay under -1 dBFS');
});
test('broadcast pace: the caster keeps talking through live play', async () => {
  const { c, said } = await engine();
  for (let i = 0; i < 60; i++) {
    const [n, t] = players[i % 6];
    c.handle('BallHit', hit(n, t, ((i * 977) % 6000) - 3000, ((i * 1543) % 8000) - 4000));
    c.handle('UpdateState', state([0, 0], 297 - i));
    await advance(1000);
  }
  const talking = said.filter((x) => x.at > NOW - 60000).length * 1500;
  assert.ok(talking > 25000, `talked for ${talking} ms of 60 s`);
  const counts = new Map(); for (const x of said) counts.set(x.text, (counts.get(x.text) || 0) + 1);
  assert.ok(Math.max(...counts.values()) <= 2);
  c.close();
});
test('sparse pace says much less', async () => {
  const { c, said } = await engine({ pace: 'sparse' });
  for (let i = 0; i < 60; i++) { const [n, t] = players[i % 6]; c.handle('BallHit', hit(n, t, 0, ((i * 1543) % 8000) - 4000)); await advance(1000); }
  assert.ok(said.length < 12, `${said.length} lines`);
  c.close();
});
test('works with only the old line bank (no 2.0 lines recorded)', async () => {
  const OLD = require(path.join(APP, 'lines'));
  const oldText = new Set();
  for (const list of Object.values(OLD)) for (const t of list) oldText.add(t.replace(/\{\w+\}/g, '').slice(0, 12));
  const { c, said } = await engine({ has: (clip) => !!clip.cat ? !require(path.join(APP, 'lines2')).LINES[clip.cat] : true });
  for (let i = 0; i < 40; i++) { const [n, t] = players[i % 6]; c.handle('BallHit', hit(n, t, 0, ((i * 1543) % 8000) - 4000)); await advance(1000); }
  c.handle('GoalScored', { Scorer: P('A1', 0), ImpactLocation: { Y: 5200 } }); await advance(3000);
  assert.ok(said.some((x) => /goal/.test(x.cat)), 'still calls the goal');
  c.close();
});
test('a tied match end calls no winner', async () => {
  const { c, said } = await engine();
  c.handle('MatchEnded', { WinnerTeamNum: 1 }); await advance(5000);
  assert.ok(!said.some((x) => /^end/.test(x.cat)));
  c.close();
});

// ---------------------------------------------------------------- 2.1.2: RL Career Hub's series flow
// RL Career Hub opens the match ~20 s before anyone is in it, names the teams a moment before
// kickoff, and closes the match right after the podium. The live game gives speeds in km/h and
// can send each stat event once per player.
const lobby = (time = 300) => ({ Players: [], Game: { Teams: [{ Name: 'BLUE', TeamNum: 0, Score: 0 }, { Name: 'Orange', TeamNum: 1, Score: 0 }], TimeSeconds: time, bOvertime: false, Ball: { Speed: 0, TeamNum: 255 }, bReplay: false } });
const named = (score = [0, 0], time = 300) => { const s = state(score, time); s.Game.Teams[0].Name = 'Gentle Mates'; s.Game.Teams[1].Name = 'SK Gaming'; return s; };
async function hubGame(c, said, { score = [3, 1], winner = 0 } = {}) {
  c.handle('MatchCreated');
  for (let i = 0; i < 40; i++) { c.handle('UpdateState', lobby()); await advance(500); } // 20 s of empty lobby
  const quiet = said.length;
  for (let i = 0; i < 6; i++) { c.handle('UpdateState', state()); await advance(500); } // the players are in
  c.handle('UpdateState', named()); await advance(150);
  c.handle('MatchInitialized'); c.handle('CountdownBegin'); await advance(4000); c.handle('RoundStarted');
  for (let i = 0; i < 20; i++) { c.handle('UpdateState', named([0, 0], 300 - i)); await advance(1000); }
  c.handle('UpdateState', named(score, 120)); await advance(2000); c.handle('UpdateState', named(score, 120)); await advance(2000);
  c.handle('MatchEnded', { WinnerTeamNum: winner }); await advance(3000);
  c.handle('PodiumStart'); await advance(300); c.handle('MatchDestroyed'); await advance(4000);
  return quiet;
}
test('an empty lobby is not live play: no talking until the players are in, then the intro', async () => {
  const player = new FakePlayer();
  const said = [];
  const speaker = new Speaker({ tts: voice(), player, log: () => {}, oneVoice: true, onLine: (x) => said.push({ at: NOW, ...x }) });
  const c = new Commentary({ tts: voice(), speaker, config: { chatter: 'normal', pronunciations: {} }, log: () => {}, statePath: null });
  const t0 = NOW;
  c.handle('MatchCreated');
  for (let i = 0; i < 40; i++) { c.handle('UpdateState', lobby()); await advance(500); }
  assert.strictEqual(said.length, 0, `nothing over the empty lobby (${said.map((x) => x.text).join(' | ')})`);
  assert.ok(!c.match.joinedLate && c.model.m.phase === 'pre', 'not taken for a match joined late');
  for (let i = 0; i < 8; i++) { c.handle('UpdateState', state()); await advance(500); }
  const intro = said.find((x) => /^intro|^stage_/.test(x.cat));
  assert.ok(intro, 'the match is introduced once the players are in');
  assert.ok(intro.at - t0 >= 20000, 'and not before');
  c.close();
});
test('the next game of the series is introduced as game two, after the series score', async () => {
  const player = new FakePlayer();
  const said = [];
  const speaker = new Speaker({ tts: voice(), player, log: () => {}, oneVoice: true, onLine: (x) => said.push({ at: NOW, ...x }) });
  // RL Career Hub's save says game 1 the whole series (it's written when the series is over)
  const hub = { contextFor: ({ players: ps }) => (!ps.length ? null : { teamNames: ['Gentle Mates', 'SK Gaming'], game: 1, wins: [0, 0], bestOf: 5, stage: 'semi', describe: 'GM vs SK' }) };
  const logs = [];
  const c = new Commentary({ tts: voice(), speaker, config: { chatter: 'normal', pronunciations: {} }, log: (m) => logs.push(m), statePath: null, hub });
  await hubGame(c, said);
  assert.ok(said.some((x) => x.cat === 'intro_blue') && said.some((x) => x.cat === 'intro_orange'), 'game 1 introduces both teams');
  const g1End = said.length;
  assert.ok(said.some((x) => /^end/.test(x.cat)), 'the result is said, though the match closed right after the podium');
  await hubGame(c, said);
  const g2 = said.slice(g1End);
  assert.ok(g2.some((x) => x.cat === 'series_lead' || x.cat === 'series_score'), 'the series score after game 1');
  assert.ok(g2.some((x) => x.cat === 'intro_game' && /two/.test(x.text)), `game two (${g2.map((x) => x.text).join(' | ')})`);
  assert.ok(logs.some((m) => /Game 2 of the series \(1-0\)/.test(m)), logs.join('\n'));
  assert.deepStrictEqual(c.series.wins, [2, 0]);
  c.close();
});
test('the live game gives speeds in km/h; match files in uu/s', () => {
  const live = new GameModel();
  assert.ok(Math.abs(live.speed(100) - 2778) < 2, 'km/h is converted');
  const file = new GameModel();
  file.speed(1800);
  assert.strictEqual(file.speed(100), 100, 'once a speed over 250 is seen, it is uu/s');
});
test('a stat event sent once per player counts once', () => {
  const m = new GameModel();
  m.handle('MatchCreated'); m.handle('UpdateState', state()); m.handle('CountdownBegin'); m.handle('RoundStarted');
  for (let i = 0; i < 7; i++) m.handle('StatfeedEvent', { EventName: 'Demolish', MainTarget: P('A1', 0), SecondaryTarget: P('B1', 1) });
  assert.strictEqual(m.stat('A1', 'demos'), 1);
});
test('"they just need to convert" only for a side that is level or behind', async () => {
  const { c } = await engine();
  const M = c.model.m;
  M.score = [4, 0];
  for (const p of M.players.values()) p.shots = p.team === 0 ? 4 : 0;
  for (let i = 0; i < 200; i++) {
    const r = c.director.colourLine(9000);
    const t = r && r.clips.map((x) => x.cat).join(',');
    assert.ok(!/filler_shots/.test(t || ''), 'not for a team four up');
  }
  c.close();
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    timers.clear();
    try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.stack.split('\n').slice(0, 3).join('\n       ')}`); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
