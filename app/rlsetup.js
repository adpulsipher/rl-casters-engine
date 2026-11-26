'use strict';
// Finds the Rocket League install and switches on its official Stats API
// (TAGame\Config\TAStatsAPI.ini or DefaultStatsAPI.ini), keeping a backup.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SECTION = '[TAGame.MatchStatsExporter_TA]';

function isRlDir(dir) {
  try { return !!dir && fs.statSync(path.join(dir, 'TAGame', 'Config')).isDirectory(); } catch (e) { return false; }
}

function ps(command) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) { return ''; }
}

function rocketLeagueRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq RocketLeague.exe', '/NH'], { encoding: 'utf8', windowsHide: true });
    return /RocketLeague\.exe/i.test(out);
  } catch (e) { return false; }
}

function findRocketLeague(configured, log) {
  const cands = [];
  const add = (p, why) => { if (p) cands.push({ p: path.resolve(p), why }); };
  add(configured, 'config.json');

  // 1) running game
  const running = ps("(Get-Process RocketLeague -ErrorAction SilentlyContinue | Select-Object -First 1).Path");
  if (running) add(path.resolve(path.dirname(running), '..', '..'), 'running game');

  // 2) Epic Games launcher (Rocket League's app name is "Sugar")
  const pd = process.env.ProgramData || 'C:\\ProgramData';
  try {
    const dat = JSON.parse(fs.readFileSync(path.join(pd, 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat'), 'utf8'));
    for (const it of dat.InstallationList || []) if (/sugar|rocket/i.test(it.AppName || '') || /rocketleague/i.test(it.InstallLocation || '')) add(it.InstallLocation, 'Epic');
  } catch (e) {}
  try {
    const dir = path.join(pd, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.item')) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (/rocket league/i.test(m.DisplayName || '') || /^sugar$/i.test(m.AppName || '')) add(m.InstallLocation, 'Epic');
      } catch (e) {}
    }
  } catch (e) {}

  // 3) Steam
  const steam = ps("(Get-ItemProperty -Path 'HKCU:\\Software\\Valve\\Steam' -ErrorAction SilentlyContinue).SteamPath");
  if (steam) {
    const libs = [steam];
    try {
      const vdf = fs.readFileSync(path.join(steam, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const m of vdf.matchAll(/"path"\s*"([^"]+)"/g)) libs.push(m[1].replace(/\\\\/g, '\\'));
    } catch (e) {}
    for (const l of libs) add(path.join(l, 'steamapps', 'common', 'rocketleague'), 'Steam');
  }

  // 4) usual folders
  for (const d of ['C', 'D', 'E', 'F']) {
    add(`${d}:\\Program Files\\Epic Games\\rocketleague`, 'default');
    add(`${d}:\\Epic Games\\rocketleague`, 'default');
    add(`${d}:\\Games\\Epic Games\\rocketleague`, 'default');
  }
  const hit = cands.find((c) => isRlDir(c.p));
  if (hit) log(`Rocket League found (${hit.why}): ${hit.p}`);
  return hit ? hit.p : null;
}

function readIniValue(text, key) {
  const lines = text.split(/\r?\n/);
  let inSec = false;
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith('[')) inSec = t.toLowerCase() === SECTION.toLowerCase();
    else if (inSec) { const m = t.match(new RegExp(`^${key}\\s*=\\s*(.*)$`, 'i')); if (m) return m[1].trim(); }
  }
  return null;
}

// returns new text with the section values set (adds the section if needed)
function setIniValues(text, values) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length ? text.split(/\r?\n/) : [];
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  let secStart = lines.findIndex((l) => l.trim().toLowerCase() === SECTION.toLowerCase());
  if (secStart < 0) {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(SECTION);
    secStart = lines.length - 1;
  }
  let secEnd = lines.length;
  for (let i = secStart + 1; i < lines.length; i++) if (lines[i].trim().startsWith('[')) { secEnd = i; break; }
  for (const [k, v] of Object.entries(values)) {
    let found = false;
    for (let i = secStart + 1; i < secEnd; i++) {
      if (new RegExp(`^\\s*${k}\\s*=`, 'i').test(lines[i])) { lines[i] = `${k}=${v}`; found = true; break; }
    }
    if (!found) { lines.splice(secEnd, 0, `${k}=${v}`); secEnd++; }
  }
  return lines.join(eol) + eol;
}

// Turn the Stats API on in one ini file. Returns { port, changed, ok }.
function enableInFile({ file, tag, dataDir, log, elevate }) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const rate = parseFloat(readIniValue(text, 'PacketSendRate') || '0');
  let port = parseInt(readIniValue(text, 'Port') || '49123', 10);
  const want = {};
  if (!(rate > 0)) want.PacketSendRate = 30;
  if (!(port > 0)) { port = 49123; want.Port = port; }
  if (!Object.keys(want).length) return { port, changed: false, ok: true };

  const next = setIniValues(text, want);
  const backupDir = path.join(dataDir, 'backup');
  fs.mkdirSync(backupDir, { recursive: true });
  const bak = path.join(backupDir, `${tag}-${path.basename(file)}.original`);
  if (text && !fs.existsSync(bak)) fs.writeFileSync(bak, text);
  try {
    fs.writeFileSync(file, next);
  } catch (e) {
    if (!elevate) { log(`Could not update ${file}: ${e.message}`); return { port, changed: false, ok: false }; }
    // Program Files needs admin rights: copy it in through one UAC prompt
    log('Windows needs permission to turn on Rocket League match data. Click "Yes" on the prompt.');
    const tmp = path.join(backupDir, `${tag}-${path.basename(file)}.new`);
    fs.writeFileSync(tmp, next);
    const esc = (v) => v.replace(/'/g, "''");
    const b64 = (v) => Buffer.from(v, 'utf16le').toString('base64');
    const inner = b64(`Copy-Item -LiteralPath '${esc(tmp)}' -Destination '${esc(file)}' -Force`);
    const outer = b64(`Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile','-EncodedCommand','${inner}')`);
    const r = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', outer], { windowsHide: true, timeout: 120000 });
    let okNow = false;
    try { okNow = fs.readFileSync(file, 'utf8') === next; } catch (e2) {}
    if (r.error || !okNow) {
      log('Could not turn on Rocket League match data automatically.');
      log(`Open this file with Notepad (as admin) and add these lines at the end:\n  ${file}\n  ${SECTION}\n  PacketSendRate=30\n  Port=49123`);
      return { port, changed: false, ok: false };
    }
  }
  log(`Turned on Rocket League match data in ${file} (original saved in Casters\\backup).`);
  return { port, changed: true, ok: true };
}

function documentsDirs() {
  const out = new Set();
  const docs = ps("[Environment]::GetFolderPath('MyDocuments')");
  if (docs) out.add(docs);
  const home = process.env.USERPROFILE || '';
  if (home) { out.add(path.join(home, 'Documents')); out.add(path.join(home, 'OneDrive', 'Documents')); }
  return [...out];
}

// Make sure the Stats API is on, in the game folder and in the per-user
// settings copy (Documents\My Games) if the game made one.
function enableStatsApi({ rlDir, dataDir, log }) {
  const cfgDir = path.join(rlDir, 'TAGame', 'Config');
  const ta = path.join(cfgDir, 'TAStatsAPI.ini');
  const primary = fs.existsSync(ta) ? ta : path.join(cfgDir, 'DefaultStatsAPI.ini');
  const main = enableInFile({ file: primary, tag: 'game', dataDir, log, elevate: true });
  let changed = main.changed;
  for (const d of documentsDirs()) {
    const f = path.join(d, 'My Games', 'Rocket League', 'TAGame', 'Config', 'TAStatsAPI.ini');
    if (!fs.existsSync(f)) continue;
    const r = enableInFile({ file: f, tag: 'documents', dataDir, log, elevate: false });
    changed = changed || r.changed;
  }
  if (main.ok && !changed) log(`Rocket League match data is on (port ${main.port}).`);
  return { port: main.port, changed, ok: main.ok };
}

module.exports = { findRocketLeague, enableStatsApi, rocketLeagueRunning, setIniValues, readIniValue };
