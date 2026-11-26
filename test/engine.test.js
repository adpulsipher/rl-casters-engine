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
const { Library, MAX_PER_MATCH } = require(path.join(APP, 'engine/library'));
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
test('library never gives a line a third time in a match', () => {
  const lib = new Library({ tts: voice() });
  const seen = new Map();
  for (let i = 0; i < 200; i++) {
    const c = lib.pick(['save_g_short']);
    if (!c) break;
    lib.said(c);
    seen.set(c.text, (seen.get(c.text) || 0) + 1);
  }
  for (const [t, n] of seen) assert.ok(n <= MAX_PER_MATCH, `${t} said ${n} times`);
  assert.strictEqual(lib.pick(['save_g_short']), null, 'runs out instead of a third time');
});
test('library prefers a fresh line, then repeats rather than staying silent', () => {
  const lib = new Library({ tts: voice() });
  const n = C.LINES.kickoff_go.length;
  const first = new Set();
  for (let i = 0; i < n; i++) { const c = lib.pick(['kickoff_go']); lib.said(c); first.add(c.text); }
  assert.strictEqual(first.size, n, 'every line once before any twice');
  assert.ok(lib.pick(['kickoff_go']), 'a repeat is still available');
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
test('a goal cuts in at once, whatever is playing', async () => {
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

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    timers.clear();
    try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.stack.split('\n').slice(0, 3).join('\n       ')}`); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
