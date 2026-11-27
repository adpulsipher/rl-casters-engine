'use strict';
// Reads RL Career Hub's career save (read only) so the casters know the season around
// a match: the event and stage, the series score, both teams' form, the table, and
// players' season totals. Nothing here ever writes to RL Career Hub's files.

const fs = require('fs');
const path = require('path');

const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const CITIES = ['London', 'Birmingham', 'Copenhagen', 'Raleigh', 'Boston', 'Paris', 'Fort Worth'];

function hubDir() {
  const base = process.env.APPDATA || (process.env.HOME ? path.join(process.env.HOME, 'AppData', 'Roaming') : null);
  return base ? path.join(base, 'rl-career-hub') : null;
}

// the career save being played: the most recently written one
function latestSave(dir) {
  const files = [];
  const savesDir = path.join(dir, 'saves');
  try { for (const f of fs.readdirSync(savesDir)) if (/\.json$/i.test(f)) files.push(path.join(savesDir, f)); } catch (e) {}
  const legacy = path.join(dir, 'career.json');
  if (fs.existsSync(legacy)) files.push(legacy);
  return files.map((f) => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t)[0] || null;
}

function stageOf(s) {
  const t = norm(s);
  if (!t) return null;
  if (/grand final|^final|\bfinals?$/.test(t) && !/semi|quarter/.test(t)) return 'final';
  if (/semi/.test(t)) return 'semi';
  if (/quarter/.test(t)) return 'quarter';
  if (/playoff|bracket|knockout|elimination|swiss|upper|lower/.test(t)) return 'playoffs';
  if (/group|round robin|league|match day|matchday/.test(t)) return 'group';
  return null;
}

function kindOf(ev, fixture) {
  const t = norm([ev && (ev.kind || ev.type || ev.tier), ev && (ev.name || ev.id), fixture && fixture.kind].filter(Boolean).join(' '));
  if (!ev && !(fixture && fixture.eventId != null)) return 'regional';
  if (/world/.test(t)) return 'worlds';
  if (/\blcq\b|last chance/.test(t)) return null; // its own thing: the stage lines cover it
  if (/open|qualif/.test(t)) return 'open';
  if (/major|kick ?off|split/.test(t)) return 'major';
  if (/regional|league/.test(t)) return 'regional';
  return null;
}

function cityOf(ev) {
  if (!ev) return null;
  const t = norm([ev.city, ev.location, ev.venue, ev.name, ev.id, ev.board].filter(Boolean).join(' '));
  return CITIES.find((c) => t.includes(norm(c))) || null;
}

class CareerHub {
  constructor({ log } = {}) {
    this.log = log || (() => {});
    this.dir = hubDir();
    this.cache = null;
  }

  available() { return !!(this.dir && latestSave(this.dir)); }
  where() { const s = latestSave(this.dir); return s ? s.f : '(no career save)'; }

  load() {
    const s = latestSave(this.dir);
    if (!s) return null;
    if (this.cache && this.cache.f === s.f && this.cache.t === s.t) return this.cache.state;
    const raw = JSON.parse(fs.readFileSync(s.f, 'utf8'));
    const state = raw && raw.state ? raw.state : raw;
    this.cache = { f: s.f, t: s.t, state };
    return state;
  }

  // ctx for a match about to start, or null if RL Career Hub isn't playing it
  contextFor({ teams, players }) {
    const st = this.load();
    if (!st || !Array.isArray(st.fixtures) || !Array.isArray(st.teams)) return null;
    const teamById = new Map(st.teams.map((t) => [t.id, t]));
    const plist = Array.isArray(st.players) ? st.players : [];
    const playerByName = new Map(plist.map((p) => [norm(p.name || p.handle || p.tag), p]));

    // which Hub team is on each side: by team name, else by most of its players
    const sideTeam = [0, 1].map((n) => {
      const byName = st.teams.find((t) => norm(t.name) === norm(teams[n]) && norm(teams[n]) !== (n ? 'orange' : 'blue'));
      if (byName) return byName.id;
      const counts = new Map();
      for (const p of players.filter((x) => x.team === n)) {
        const hp = playerByName.get(norm(p.name));
        if (hp && hp.teamId != null) counts.set(hp.teamId, (counts.get(hp.teamId) || 0) + 1);
      }
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      return best ? best[0] : null;
    });
    if (sideTeam[0] == null || sideTeam[1] == null || sideTeam[0] === sideTeam[1]) return null;

    // the fixture: the one RL Career Hub has waiting, else the next unfinished one between these teams
    const between = (f) => (f.homeId === sideTeam[0] && f.awayId === sideTeam[1]) || (f.homeId === sideTeam[1] && f.awayId === sideTeam[0]);
    const pm = st.pendingMatch;
    const pendingId = typeof pm === 'number' || typeof pm === 'string' ? pm : pm && (pm.fixtureId != null ? pm.fixtureId : pm.id);
    let fx = pendingId != null ? st.fixtures.find((f) => f.id === pendingId && between(f)) : null;
    if (!fx) fx = st.fixtures.filter((f) => between(f) && !f.played).sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))[0] || null;
    if (!fx) return null;

    const blueIsHome = fx.homeId === sideTeam[0];
    const wins = blueIsHome ? [fx.homeWins | 0, fx.awayWins | 0] : [fx.awayWins | 0, fx.homeWins | 0];
    const bestOf = Number(fx.bestOf) || null;
    const events = Array.isArray(st.events) ? st.events : [];
    const ev = fx.eventId != null ? events.find((e) => e.id === fx.eventId) || null : null;

    // form: results of each team's played fixtures, most recent first
    const played = st.fixtures.filter((f) => f.played).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const formOf = (id) => {
      const res = played.filter((f) => f.homeId === id || f.awayId === id).map((f) => ((f.homeId === id) === (f.homeWins > f.awayWins) ? 'W' : 'L'));
      const run = (ch) => { let n = 0; for (const r of res) { if (r !== ch) break; n++; } return n; };
      return { played: res.length, unbeaten: res.length > 0 && !res.includes('L'), won: run('W'), lost: run('L') };
    };

    // the regional table: series won in league fixtures (no event)
    const league = played.filter((f) => f.eventId == null);
    const pts = new Map();
    for (const f of league) { const w = f.homeWins > f.awayWins ? f.homeId : f.awayId; pts.set(w, (pts.get(w) || 0) + 1); }
    const region = (id) => { const t = teamById.get(id); return t && (t.regionId || t.region); };
    const table = [...new Set(st.teams.filter((t) => region(t.id) === region(sideTeam[0])).map((t) => t.id))]
      .map((id) => ({ id, p: pts.get(id) || 0 })).sort((a, b) => b.p - a.p);
    const pos = (id) => table.findIndex((r) => r.id === id);
    let tablePos = null, place = null, placeIfWin = null;
    if (fx.eventId == null && league.length >= 4) {
      // each side's place in the table (0 = top), and where a win tonight would take it (2.2)
      place = [pos(sideTeam[0]), pos(sideTeam[1])];
      placeIfWin = sideTeam.map((id) => { const p = (pts.get(id) || 0) + 1; return table.filter((r) => r.id !== id && r.p > p).length; });
      if (place.some((x) => x < 0 || x > 11)) place = placeIfWin = null;
      const [a, b] = [pos(sideTeam[0]), pos(sideTeam[1])];
      if (a >= 0 && b >= 0 && Math.max(a, b) <= 1) tablePos = 'top';
      else if (Math.abs((pts.get(sideTeam[0]) || 0) - (pts.get(sideTeam[1]) || 0)) <= 1) tablePos = 'close';
    }

    // season totals per player (before tonight)
    const goalsById = new Map(), assistsById = new Map();
    for (const f of played) {
      for (const id of f.scorerIds || []) goalsById.set(id, (goalsById.get(id) || 0) + 1);
      for (const id of f.assistIds || []) assistsById.set(id, (assistsById.get(id) || 0) + 1);
    }
    const statOf = (name, key) => {
      const p = playerByName.get(norm(name));
      if (!p) return null;
      const s = p.season || p.seasonStats || p.stats || p;
      if (typeof s[key] === 'number') return s[key];
      if (key === 'goals') return goalsById.get(p.id) || 0;
      if (key === 'assists') return assistsById.get(p.id) || 0;
      return null;
    };

    const name = (id) => (teamById.get(id) || {}).name || '?';
    const ctx = {
      teamNames: [name(sideTeam[0]), name(sideTeam[1])],
      fixtureId: fx.id,
      seriesId: `${fx.id}`,
      game: (fx.homeWins | 0) + (fx.awayWins | 0) + 1,
      wins, bestOf,
      kind: kindOf(ev, fx),
      city: cityOf(ev),
      stage: stageOf(fx.stage || (fx.slot && fx.slot.stage) || (ev && ev.stage)),
      form: [formOf(sideTeam[0]), formOf(sideTeam[1])],
      table: tablePos,
      place, placeIfWin,
      metBefore: played.some(between),
      seasonGoals: (n) => statOf(n, 'goals'),
      seasonSaves: (n) => statOf(n, 'saves'),
      topScorer: (n, tonight) => {
        const p = playerByName.get(norm(n));
        if (!p) return false;
        const mine = (statOf(n, 'goals') || 0) + (tonight || 0);
        // "the league" is this player's region
        const reg = region(p.teamId);
        return plist.every((q) => q === p || q.teamId == null || region(q.teamId) !== reg || (q.season ? q.season.goals || 0 : 0) <= mine);
      },
    };
    ctx.describe = `${name(sideTeam[0])} vs ${name(sideTeam[1])}, game ${ctx.game}${bestOf ? ` of a best of ${bestOf}` : ''}` +
      `${ctx.kind ? `, ${ctx.kind}` : ''}${ctx.city ? ` in ${ctx.city}` : ''}${ctx.stage ? `, ${ctx.stage}` : ''}.`;
    return ctx;
  }
}

module.exports = { CareerHub, stageOf, kindOf, cityOf, latestSave, hubDir };
