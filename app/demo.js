'use strict';
// "--demo": the opening minutes of a real 3v3 match, sent to the casters exactly as
// Rocket League's Stats API sent them (every touch, save and goal, with the real timing),
// so the casters can be heard without starting the game. The six players and two teams
// are renamed to ones in your voice pack (see main.js), or set with --blue/--orange/--teams.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DEFAULT = {
  blue: ['Vortex', 'Ember', 'Nova'],
  orange: ['Glacier', 'Sparks', 'Blaze'],
  teams: ['Night Owls', 'Red Rockets'],
};
let BLUE = DEFAULT.blue, ORANGE = DEFAULT.orange, TEAMS = DEFAULT.teams;

function setRoster(r) {
  const fill = (list, def) => def.map((d, i) => (list && list[i]) || d);
  r = r || {};
  BLUE = fill(r.blue, DEFAULT.blue);
  ORANGE = fill(r.orange, DEFAULT.orange);
  TEAMS = fill(r.teams, DEFAULT.teams);
  return { blue: BLUE, orange: ORANGE, teams: TEAMS };
}

function load() {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'demo_match.json.gz'))).toString('utf8'));
}

// the recorded match with our names in it
function script() {
  const M = load();
  const map = new Map();
  const byTeam = [M.players.filter((p) => p.team === 0), M.players.filter((p) => p.team === 1)];
  byTeam[0].forEach((p, i) => map.set(p.name, BLUE[i] || p.name));
  byTeam[1].forEach((p, i) => map.set(p.name, ORANGE[i] || p.name));
  const rename = (o) => {
    if (Array.isArray(o)) return o.map(rename);
    if (o && typeof o === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(o)) out[k] = k === 'Name' && typeof v === 'string' ? (map.get(v) || (v === 'Blue' ? TEAMS[0] : v === 'Orange' ? TEAMS[1] : v)) : rename(v);
      return out;
    }
    return o;
  };
  const ev = [{ t: 0, name: 'MatchCreated', data: {} }];
  for (const [t, name, data] of M.events) {
    if (name === 'MatchCreated') continue;
    const d = rename(data);
    // the teams by club name
    if (name === 'UpdateState' && d.Game && Array.isArray(d.Game.Teams)) d.Game.Teams.forEach((tm) => { tm.Name = TEAMS[tm.TeamNum === 1 ? 1 : 0]; });
    ev.push({ t, name, data: d });
  }
  const end = M.end || (ev.length ? ev[ev.length - 1].t : 0);
  const s = M.score || [0, 0];
  ev.push({ t: end + 200, name: 'MatchEnded', data: { WinnerTeamNum: s[0] >= s[1] ? 0 : 1 } });
  ev.push({ t: end + 4200, name: 'PodiumStart', data: {} });
  ev.push({ t: end + 16000, name: 'MatchDestroyed', data: {} });
  return ev;
}

// Plays the match, calling emit(name, data) in real time.
function run(emit, { onDone, roster } = {}) {
  setRoster(roster);
  const events = script();
  const t0 = Date.now();
  let i = 0;
  const timers = [];
  let stopped = false;
  const next = () => {
    if (stopped) return;
    while (i < events.length && events[i].t <= Date.now() - t0) { const e = events[i++]; emit(e.name, e.data); }
    if (i < events.length) timers.push(setTimeout(next, Math.max(5, events[i].t - (Date.now() - t0))));
    else onDone && onDone();
  };
  next();
  return { stop: () => { stopped = true; timers.forEach(clearTimeout); }, events };
}

module.exports = { run, script, setRoster, DEFAULT };
