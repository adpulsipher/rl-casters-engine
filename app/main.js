'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const { loadConfig } = require('./config');
const { ensureModel } = require('./download');
const { TTS, processVoice, wavBuffer } = require('./tts');
const pack = require('./pack');
const { Player } = require('./player');
const { Speaker } = require('./speaker');
const { Commentary } = require('./commentary');
const { StatsClient } = require('./statsapi');

function argValue(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

// Who plays in --demo: --blue "a,b,c" --orange "d,e,f" --teams "X,Y" if given, otherwise
// the voice pack's first two teams and first six players (a pack lists players team by team).
function demoRoster(argv, tts) {
  const list = (v) => (v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : null);
  const info = (tts && tts.strict && tts.info) || {};
  const players = (info.players || []).filter(Boolean);
  const teams = (info.teams || []).filter((t) => t && !/^(blue|orange)$/i.test(t));
  return {
    blue: list(argValue(argv, '--blue')) || (players.length >= 6 ? players.slice(0, 3) : null),
    orange: list(argValue(argv, '--orange')) || (players.length >= 6 ? players.slice(3, 6) : null),
    teams: list(argValue(argv, '--teams')) || (teams.length >= 2 ? teams.slice(0, 2) : null),
  };
}

function pickDataDir(exeDir, override) {
  const tryDir = (d) => {
    try { fs.mkdirSync(d, { recursive: true }); const t = path.join(d, '.write-test'); fs.writeFileSync(t, 'x'); fs.unlinkSync(t); return d; } catch (e) { return null; }
  };
  if (override) return tryDir(path.resolve(override));
  return tryDir(path.join(exeDir, 'Casters')) ||
    tryDir(path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'RL Career Casters'));
}

function makeLogger(file) {
  const stream = fs.createWriteStream(file, { flags: 'a' });
  stream.write(`\n--- ${new Date().toISOString()} ---\n`);
  return (msg) => {
    const line = String(msg);
    console.log(line);
    stream.write(`[${new Date().toLocaleTimeString()}] ${line}\n`);
  };
}

function waitForEnter() {
  if (!process.stdin.isTTY) return Promise.resolve();
  console.log('\nPress Enter to close this window.');
  return new Promise((r) => { process.stdin.resume(); process.stdin.once('data', () => r()); });
}

async function main({ exeDir, version, argv = process.argv.slice(2) }) {
  const combine = argv.includes('--combine');
  console.log(`RL Career Casters v${version}  -  live commentary for Rocket League`);
  console.log(combine ? 'Combining your voice pack and its add-ons into one pack.\n' : 'Keep this window open while you play. Close it to stop the casters.\n');

  const dataDir = pickDataDir(exeDir, argValue(argv, '--data'));
  if (!dataDir) { console.log('Could not create the Casters folder. Move the exe somewhere you can save files.'); await waitForEnter(); return 1; }
  const baseLog = makeLogger(path.join(dataDir, 'casters.log'));
  // --capture: the match recorder (everything the game sends, and what the casters said)
  let capture = null;
  const log = (msg) => { baseLog(msg); if (capture) capture.note('log', { m: String(msg) }); };

  if (combine) {
    try { await require('./combine').combinePacks({ dirs: [exeDir, dataDir], log }); }
    catch (e) { log(`Could not combine the packs: ${e.message}. Nothing was changed.`); }
    if (!argv.includes('--exit')) await waitForEnter();
    return 0;
  }

  const cfg = loadConfig(dataDir, log);
  if (argv.includes('--capture')) {
    const { Capture } = require('./capture');
    capture = new Capture({ dir: path.join(dataDir, 'captures'), log: baseLog, header: { version, argv, config: cfg } });
    log(`Match recorder is on: each match is saved in ${path.join(dataDir, 'captures')}`);
  }
  const demo = argv.includes('--demo');
  const play = argv.includes('--play'); // a recorded match: see matchfile.js
  const recordFile = argValue(argv, '--record');

  if (!demo && !play) {
    // only one copy of the casters at a time
    const lockOk = await new Promise((resolve) => {
      const srv = require('net').createServer();
      srv.once('error', () => resolve(false));
      srv.listen(49198, '127.0.0.1', () => { srv.unref(); resolve(true); });
    });
    if (!lockOk) {
      log('The casters are already running in another window. Close this one.');
      await waitForEnter();
      return 0;
    }
  }

  // ---- voices: a recorded voice pack if there is one, otherwise live Pocket TTS
  let tts = null;
  if (cfg.voicePack !== 'off') {
    const packsDir = path.join(dataDir, 'packs');
    try {
      const zips = await pack.findPackZips([exeDir, dataDir]);
      // the newest full pack, plus any add-on packs made for it (new lines recorded later)
      const mainZip = zips.find((z) => !z.man.addon);
      const addons = mainZip ? pack.addonsFor(mainZip, zips) : [];
      let dirs = [];
      if (mainZip) {
        for (const z of [mainZip, ...addons]) dirs.push({ dir: await pack.importPack({ file: z.file, packsDir, log }), zip: z.file });
      } else if (fs.existsSync(packsDir)) {
        const imported = fs.readdirSync(packsDir).filter((d) => fs.existsSync(path.join(packsDir, d, 'pack.json')))
          .map((d) => ({ d, t: fs.statSync(path.join(packsDir, d, 'pack.json')).mtimeMs })).sort((a, b) => b.t - a.t);
        if (imported.length) dirs = [{ dir: path.join(packsDir, imported[0].d), zip: null }];
      }
      if (dirs.length) {
        const voices = [];
        for (const d of dirs) { const v = new pack.PackVoice(d.dir, { zipFile: d.zip, processVoice, wavBuffer, log }); await v.open(); voices.push(v); }
        tts = voices.length > 1 ? new pack.PackSet(voices) : voices[0];
        const i = tts.info;
        log(`Using voice pack "${i.name}": ${tts.size} recorded lines` + (i.players && i.players.length ? `, ${i.players.length} player names` : '') + (i.teams && i.teams.length ? `, ${i.teams.length} teams` : '') + '.');
        log('Players or teams that are not in the pack get the casters\' general lines.');
      }
    } catch (e) { log(`Could not load the voice pack (${e.message}). Using live voices instead.`); tts = null; }
  }

  if (!tts) {
    let modelDir, checkerDir = null;
    const modelRoot = path.join(dataDir, 'model');
    try {
      modelDir = await ensureModel({ which: 'voice', modelRoot, requireFrom: require, log, url: argValue(argv, '--model-url') });
      if (cfg.checkLines) checkerDir = await ensureModel({ which: 'checker', modelRoot, requireFrom: require, log, url: argValue(argv, '--checker-url') });
    } catch (e) { log(e.message); log('Check your internet connection and start the casters again.'); await waitForEnter(); return 1; }
    // the old Kokoro model from v1.0 isn't used any more
    try { fs.rmSync(path.join(modelRoot, 'kokoro-multi-lang-v1_0'), { recursive: true, force: true }); } catch (e) {}

    // caster voice clips: copied out once so they can be swapped for custom ones
    const voicesDir = path.join(dataDir, 'voices');
    fs.mkdirSync(voicesDir, { recursive: true });
    for (const f of fs.readdirSync(path.join(__dirname, 'voices'))) {
      if (f.endsWith('.wav') && !fs.existsSync(path.join(voicesDir, f))) fs.copyFileSync(path.join(__dirname, 'voices', f), path.join(voicesDir, f));
    }

    const sherpa = require('sherpa-onnx-node');
    const other = cfg.playByPlay === 'male' ? 'female' : 'male';
    tts = new TTS({
      sherpa, modelDir, checkerDir, voicesDir, cacheDir: path.join(dataDir, 'cache'), threads: cfg.ttsThreads, log,
      temperature: cfg.expressiveness, vocab: Commentary.vocabulary(),
      roles: { pbp: { voice: cfg.playByPlay }, color: { voice: other } },
    });
    try { await tts.init(); } catch (e) {
      log(`Could not start the voices: ${e.message}`);
      if (process.platform === 'win32') log('If this keeps happening, install the Microsoft Visual C++ Redistributable (x64) and try again.');
      await waitForEnter(); return 1;
    }
  }

  const player = new Player({ log, recordFile: recordFile && path.resolve(recordFile), silent: argv.includes('--silent'), basicAudio: cfg.audio === 'basic' || argv.includes('--basic-audio') });
  await player.start(cfg.volume);

  // one caster doing both jobs: a voice pack recorded in one voice (or casters: "one" in config.json)
  const oneVoice = !!tts.strict && (cfg.casters === 'one' || (cfg.casters === 'auto' && !!(tts.info && tts.info.oneVoice)));
  if (oneVoice) log('One caster: play-by-play and analysis in one voice.');
  const label = oneVoice ? { pbp: 'Caster', color: 'Caster' }
    : tts.strict ? { pbp: 'Play-by-play', color: 'Analyst     ' }
    : { pbp: cfg.playByPlay === 'male' ? 'Male caster ' : 'Female caster', color: cfg.playByPlay === 'male' ? 'Female caster' : 'Male caster ' };
  const speaker = new Speaker({ tts, player, log, oneVoice, onLine: (c) => { log(`  ${label[c.role]}: ${c.text}`); if (capture) capture.note('say', { role: c.role, mood: c.mood, text: c.text }); },
    onLineEnd: (c, how) => { if (capture) capture.note('said', { text: c.text, how }); },
    onDrop: (seg, why) => { if (capture) capture.note('drop', { why, prio: seg.prio, texts: seg.clips.map((c) => c.text) }); } });
  // RL Career Hub: the season around this match (event, stage, series, form, season stats), if it's installed
  let hub = null;
  // (not for a recorded match: it's called as it was, not as part of your current season)
  if (cfg.careerHub !== 'off' && !play) {
    try { hub = new (require('./hub').CareerHub)({ log }); if (!hub.available()) hub = null; else log(`RL Career Hub found: ${hub.where()}`); } catch (e) { hub = null; }
  }
  const commentary = new Commentary({ tts, speaker, config: cfg, log, statePath: play ? null : path.join(dataDir, 'series.json'), hub });

  // render the lines that never change, in the background (first run only)
  const generic = tts.strict ? [] : Commentary.genericLines().filter((c) => !tts.has(c));
  if (generic.length) {
    log(`Getting the casters ready: recording ${generic.length} common lines in the background (first run only, a few minutes).`);
    let left = generic.length;
    for (const c of generic) tts.request(c, 2).catch(() => {}).finally(() => { if (--left === 0) log('All common lines are ready.'); });
  }

  let client = null, demoRun = null;
  const shutdown = async (code) => {
    try { client && client.stop(); demoRun && demoRun.stop(); commentary.close(); player.close(); capture && capture.close(); } catch (e) {}
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGHUP', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  if (demo) {
    const D = require('./demo');
    const roster = D.setRoster(demoRoster(argv, tts));
    log('Demo: the opening minutes of a real 3v3 match, as Rocket League sent it (no game needed):');
    log(`  ${roster.teams[0]} (${roster.blue.join(', ')}) vs ${roster.teams[1]} (${roster.orange.join(', ')})\n`);
    await new Promise((resolve) => { demoRun = D.run((n, d) => commentary.handle(n, d), { onDone: resolve, roster }); });
    while (speaker.busy) await new Promise((r) => setTimeout(r, 300));
    log('\nDemo finished.');
    if (!argv.includes('--exit')) await waitForEnter();
    return shutdown(0);
  }

  if (play) {
    const M = require('./matchfile');
    const done = async () => { if (!argv.includes('--exit')) await waitForEnter(); return shutdown(0); };
    const file = M.find(argValue(argv, '--play'), [path.join(dataDir, 'captures'), path.join(exeDir, 'matches'), exeDir]);
    if (!file) {
      log('No match file to play. Drop one on "Play a match.bat": a recording from "Casters with match recorder.bat"');
      log('(saved in Casters\\captures), or a Rocket League replay turned into one by "Convert replay.bat".');
      return done();
    }
    if (/\.replay$/i.test(file)) {
      log(`"${path.basename(file)}" is a Rocket League replay. Drop it on "Convert replay.bat" first: that turns it into a match file and plays it.`);
      return done();
    }
    let events = [];
    try { events = M.load(file); } catch (e) { log(`Could not read "${path.basename(file)}": ${e.message}`); return done(); }
    if (events.length < 50) { log(`"${path.basename(file)}" has almost nothing in it (${events.length} events), so there's nothing to call.`); return done(); }
    const s = M.summary(events);
    const side = (n) => s.teams[n] + (s.players[n].length ? ` (${s.players[n].join(', ')})` : '');
    log(`Playing "${path.basename(file)}", about ${Math.max(1, Math.round(s.minutes))} min, as Rocket League sent it:`);
    log(`  ${side(0)} vs ${side(1)}\n`);
    // --sync ("Play a match.bat"): start on Space, to line it up with a video of the match
    const sync = argv.includes('--sync') && !!process.stdin.isTTY;
    if (argv.includes('--sync') && !sync) log('(No keyboard here, so the match starts straight away.)');
    let endKeys = () => {};
    if (sync) {
      log('To line it up with a video: press SPACE the moment the first kickoff countdown starts (when the 3 appears).');
      log('After every goal the casters hold at the next kickoff: press SPACE again when its countdown starts.');
      log('P pauses and carries on (pause the video too). Ctrl+C stops.\n');
      log('Waiting for SPACE...');
    }
    await new Promise((resolve) => {
      demoRun = M.run(events, (n, d) => commentary.handle(n, d), {
        onDone: resolve,
        sync,
        onWait: (n) => console.log(`  [kickoff ${n}: press SPACE when the countdown starts]`),
      });
      if (!sync) return;
      process.stdin.setRawMode(true);
      process.stdin.resume();
      const onKey = (buf) => {
        const k = buf.toString('utf8');
        if (k === '\u0003') { endKeys(); shutdown(0); return; }
        if (k === ' ') {
          const r = demoRun.release();
          if (r === 'started' || r === 'synced' || r === 'jumped') console.log('  [go]');
          else if (r === 'live') console.log('  [SPACE only works between a goal and the next kickoff]');
        } else if (k === 'p' || k === 'P') {
          console.log(demoRun.togglePause() ? '  [paused: P to carry on]' : '  [carrying on]');
        }
      };
      process.stdin.on('data', onKey);
      endKeys = () => { process.stdin.off('data', onKey); try { process.stdin.setRawMode(false); } catch (e) {} process.stdin.pause(); };
    });
    endKeys();
    while (speaker.busy) await new Promise((r) => setTimeout(r, 300));
    log('\nMatch finished.');
    return done();
  }

  // ---- Rocket League's Stats API
  let port = Number(argValue(argv, '--port')) || cfg.statsPort || 49123;
  if (process.platform === 'win32' && cfg.autoEnableStatsApi && !argValue(argv, '--port')) {
    const rl = require('./rlsetup');
    const dir = rl.findRocketLeague(cfg.rocketLeagueDir, log);
    if (!dir) {
      log('Could not find Rocket League. Set "rocketLeagueDir" in Casters\\config.json to the game folder');
      log('(the folder that has Binaries and TAGame in it), then start the casters again.');
    } else {
      try {
        const r = rl.enableStatsApi({ rlDir: dir, dataDir, log });
        if (!cfg.statsPort) port = r.port;
        if (r.changed && rl.rocketLeagueRunning()) log('>>> Rocket League is already open: close it and start it again once, so it picks up the change. <<<');
      } catch (e) { log(`Could not check Rocket League's settings: ${e.message}`); }
    }
  }
  client = new StatsClient({ port, log });
  client.on('event', (n, d) => { if (capture) capture.event(n, d); commentary.handle(n, d); });
  client.on('status', (s) => { if (s === 'disconnected') speaker.stopAll(); });
  client.start();
  return new Promise(() => {}); // run until closed
}

module.exports = { main };
