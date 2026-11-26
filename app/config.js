'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  volume: 100,
  chatter: 'normal',
  playByPlay: 'male',
  expressiveness: 0.7,
  checkLines: true,
  units: 'kph',
  ttsThreads: Math.max(2, Math.min(6, Math.floor(os.cpus().length / 3))),
  voicePack: 'auto',
  casters: 'auto',
  careerHub: 'auto',
  autoEnableStatsApi: true,
  rocketLeagueDir: '',
  statsPort: 0,
  audio: 'auto',
  pronunciations: {},
};

const HELP = {
  _help: [
    'Edit with Notepad, save, then restart the casters.',
    'volume: 0-100.  chatter: normal = broadcast pace (talks most of the time) | chatty = even more | quiet = big moments plus some colour | sparse = big moments only.',
    'playByPlay: male | female (who calls the action; the other caster is the analyst).',
    'expressiveness: 0.5 = steadier, 0.7 = normal, 0.9 = wilder (and the odd stumble).',
    'checkLines: re-record a line automatically when words come out garbled.',
    'Voices: the clips in Casters\\voices (male/female x hype/lively/calm). Swap one for your own 8-12 second clip to change that voice; delete the folder to get the originals back.',
    'units: kph | mph.  rocketLeagueDir: only if the game is not found automatically.',
    'voicePack: auto = use a recorded voice pack (a .zip from the studio notebook next to the exe or in this folder); off = always use live voices.',
    'casters: auto | one | two. one = a single caster doing both jobs (a voice pack recorded in one voice); auto = one when the pack says it was recorded with one voice.',
    'careerHub: auto | off. auto = read your RL Career Hub season (event, stage, series, form, season stats) for the calls; it is only ever read, never changed.',
    'audio: auto = one steady audio stream that keeps Bluetooth headphones and TV audio awake, so no line loses its first word; basic = the old player (one sound per line), only if auto gives you trouble.',
    'pronunciations: fix how names are said, e.g. {"Kaydop": "Kay dop"}.',
  ],
};

function loadConfig(dataDir, log) {
  const file = path.join(dataDir, 'config.json');
  let user = {};
  if (fs.existsSync(file)) {
    try { user = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
    catch (e) { log(`config.json has a mistake in it (${e.message}). Using the default settings this time.`); user = {}; }
  }
  const cfg = { ...DEFAULTS, ...user };
  delete cfg._help;
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify({ ...HELP, ...DEFAULTS }, null, 2));
  }
  cfg.volume = Math.max(0, Math.min(100, Number(cfg.volume) || 0));
  cfg.playByPlay = cfg.playByPlay === 'female' ? 'female' : 'male';
  cfg.expressiveness = Math.max(0.3, Math.min(1.0, Number(cfg.expressiveness) || 0.7));
  cfg.checkLines = cfg.checkLines !== false;
  cfg.ttsThreads = Math.max(1, Math.min(16, Number(cfg.ttsThreads) || DEFAULTS.ttsThreads));
  cfg.units = cfg.units === 'mph' ? 'mph' : 'kph';
  cfg.casters = ['one', 'two'].includes(cfg.casters) ? cfg.casters : 'auto';
  cfg.careerHub = cfg.careerHub === 'off' ? 'off' : 'auto';
  cfg.chatter = ['sparse', 'quiet', 'normal', 'chatty'].includes(cfg.chatter) ? cfg.chatter : 'normal';
  cfg.audio = cfg.audio === 'basic' ? 'basic' : 'auto';
  if (!cfg.pronunciations || typeof cfg.pronunciations !== 'object') cfg.pronunciations = {};
  return cfg;
}

module.exports = { loadConfig, DEFAULTS };
