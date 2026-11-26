'use strict';
// Turns numbers, times, speeds and gamer tags into text that reads well aloud.

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function num(n) {
  n = Math.max(0, Math.round(Number(n) || 0));
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' and ' + num(n % 100) : '');
  return String(n);
}

// score as said on a broadcast: "three to one", 0 -> "nothing"
function scoreWords(high, low) {
  return `${num(high)} to ${low === 0 ? 'nothing' : num(low)}`;
}

function timeWords(sec) {
  sec = Math.round(sec);
  if (sec === 60) return 'one minute';
  if (sec === 90) return 'a minute and a half';
  if (sec > 60 && sec % 60 === 0) return `${num(sec / 60)} minutes`;
  if (sec === 1) return 'one second';
  return `${num(sec)} seconds`;
}

// Stats API speeds are in Unreal units per second (1 uu = 1 cm)
// rounded like a caster would say it (and so a voice pack can pre-record every value)
function speedWords(uuPerSec, units) {
  if (units === 'mph') return `${num(Math.max(40, Math.min(110, Math.round((uuPerSec * 0.0223694) / 5) * 5)))} miles an hour`;
  return `${num(Math.max(60, Math.min(180, Math.round((uuPerSec * 0.036) / 10) * 10)))} kilometers an hour`;
}

// Make gamer tags speakable: "xX_Zen_Xx" -> "Zen", "Nexto (2)" -> "Nexto"
function speakName(name, pronunciations) {
  const raw = String(name || '').trim();
  if (pronunciations && pronunciations[raw]) return pronunciations[raw];
  let s = raw
    .replace(/\s*\(\d+\)\s*$/, '')        // RLBot duplicate suffix
    .replace(/\[[^\]]*\]\s*/g, '')         // [CLAN] tags
    .replace(/^(?:x+X+|X+x+)[_\-. ]*/, '') // xX_ decorations
    .replace(/[_\-. ]*(?:x+X+|X+x+)$/, '')
    .replace(/[_|~*^]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (pronunciations && pronunciations[s]) return pronunciations[s];
  return s || raw || 'that player';
}

function cleanTeamName(name, teamNum) {
  const s = String(name || '').trim();
  if (!s || /^(blue|orange)$/i.test(s) || /^team\s*[0-9]?$/i.test(s)) return teamNum === 1 ? 'Orange' : 'Blue';
  return s;
}

module.exports = { num, scoreWords, timeWords, speedWords, speakName, cleanTeamName };
