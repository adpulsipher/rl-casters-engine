'use strict';
// Every kind of line the casters can say: the original bank (lines.js) plus engine 2.0's
// (lines2.js), who says each one (pbp or color) and how (hype, lively or calm).
// A recorded line is found by caster + mood + text, so the rules for the original
// categories must never change: they are copied here exactly as 1.x had them.

const OLD = require('../lines');
const { LINES: NEW, META } = require('../lines2');
const W = require('../words');

for (const k of Object.keys(NEW)) if (OLD[k]) throw new Error(`line category ${k} is defined twice`);
const LINES = { ...OLD, ...NEW };

const COLOR_CATS = new Set(['intro_color', 'intro_star', 'ot_color', 'end_mvp', 'end_winner', 'end_loser', 'filler_color', 'filler_ot',
  'filler_saves', 'filler_goals', 'filler_demos', 'filler_shots', 'filler_trailing', 'filler_leading']);
const HYPE = new Set(['goal', 'goal_generic', 'goal_ot', 'goal_ot_generic', 'epicsave', 'epicsave_generic', 'score_first', 'score_take_lead',
  'score_late_lead', 'score_late_tie', 'score_equalize', 'score_tie', 'ot', 'end', 'end_close', 'end_ot', 'an_bicycle', 'an_hattrick', 'an_turtle']);
const CALM = new Set(['an_generic', 'an_named', 'an_assist', 'end_mvp', 'end_winner', 'end_loser', 'filler_color', 'filler_ot', 'filler_saves',
  'filler_goals', 'filler_demos', 'filler_shots', 'filler_trailing', 'filler_leading']);

const roleOf = (cat) => (META[cat] ? META[cat].role : cat.startsWith('an_') || COLOR_CATS.has(cat) ? 'color' : 'pbp');
const moodOf = (cat) => (META[cat] ? META[cat].mood : HYPE.has(cat) ? 'hype' : CALM.has(cat) ? 'calm' : 'lively');

// capital letter at the start of each sentence (a filled-in word can start one)
const tidy = (t) => t.replace(/(^|[.!?]\s+)([a-z])/g, (_, a, b) => a + b.toUpperCase());

function fill(tpl, vars) {
  let ok = true;
  const out = tpl.replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars ? vars[k] : undefined;
    if (v === undefined || v === null || v === '') { ok = false; return ''; }
    return String(v);
  });
  return ok ? tidy(out) : null;
}

const fillOf = (cat) => {
  const v = new Set();
  for (const t of LINES[cat] || []) for (const m of t.matchAll(/\{(\w+)\}/g)) v.add(m[1]);
  return [...v];
};

const SEASON_MARKS = [5, 10, 15, 20, 25, 30, 40, 50];

// Everything a voice pack can contain: each category's caster, mood and lines, plus every
// value the number fill-ins can take. The studio reads this to know what to record.
function studioSpec() {
  const categories = {};
  for (const [cat, templates] of Object.entries(LINES)) {
    const vars = fillOf(cat);
    if (vars.length > 1) throw new Error(`${cat} mixes fill-ins ${vars.join(', ')}`);
    categories[cat] = { role: roleOf(cat), mood: moodOf(cat), fill: vars[0] || null, templates };
  }
  const score = [];
  for (let h = 1; h <= 9; h++) for (let l = 0; l < h; l++) score.push(W.scoreWords(h, l));
  const a = []; for (let n = 0; n <= 9; n++) a.push(W.num(n));
  const speed = [];
  for (let k = 60; k <= 180; k += 10) speed.push(W.speedWords(k / 0.036, 'kph'));
  for (let m = 40; m <= 110; m += 5) speed.push(W.speedWords(m / 0.0223694, 'mph'));
  const nums = (from, to) => { const out = []; for (let n = from; n <= to; n++) out.push(W.num(n)); return out; };
  return {
    version: 3, categories,
    domains: {
      score, a, speed,
      goals: nums(2, 6), saves: nums(3, 9), demos: nums(2, 5), assists: nums(2, 5), streak: nums(2, 8), run: nums(3, 6),
      season: SEASON_MARKS.map((n) => W.num(n)), bestof: ['three', 'five', 'seven'],
      city: ['London', 'Birmingham', 'Copenhagen', 'Raleigh', 'Boston', 'Paris', 'Fort Worth'],
    },
  };
}

module.exports = { LINES, META, roleOf, moodOf, fill, tidy, fillOf, studioSpec, SEASON_MARKS };
