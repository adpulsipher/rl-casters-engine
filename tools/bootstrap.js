'use strict';
// Single-file exe entry point. Unpacks the app (JavaScript + the speech engine's
// DLLs) into Casters\runtime\<version> next to the exe, then starts it.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const { createRequire } = require('module');

const VERSION = '2.0.0';
const BUILD = '2.0.0-2a6402b5'; // version + content hash, so a rebuilt exe never reuses old files

function writable(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); const t = path.join(dir, '.w'); fs.writeFileSync(t, '1'); fs.unlinkSync(t); return true; } catch (e) { return false; }
}

function unpack(target) {
  const sea = require('node:sea');
  const packed = Buffer.from(sea.getAsset('runtime'));
  const raw = zlib.gunzipSync(packed);
  const headerLen = raw.readUInt32LE(0);
  const manifest = JSON.parse(raw.subarray(4, 4 + headerLen).toString('utf8'));
  let off = 4 + headerLen;
  const tmp = target + '.tmp-' + process.pid;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of manifest.files) {
    const file = path.join(tmp, ...f.p.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, raw.subarray(off, off + f.n));
    off += f.n;
  }
  fs.writeFileSync(path.join(tmp, '.ok'), BUILD);
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(tmp, target);
}

async function start() {
  const exeDir = path.dirname(process.execPath);
  let base = path.join(exeDir, 'Casters');
  if (!writable(base)) base = path.join(process.env.LOCALAPPDATA || os.homedir(), 'RL Career Casters');
  const runtime = path.join(base, 'runtime', BUILD);
  if (!fs.existsSync(path.join(runtime, '.ok'))) {
    console.log('Setting up (first launch of this version)...');
    unpack(runtime);
    // remove older versions
    for (const d of fs.readdirSync(path.join(base, 'runtime'))) {
      if (d !== BUILD) try { fs.rmSync(path.join(base, 'runtime', d), { recursive: true, force: true }); } catch (e) {}
    }
  }
  const req = createRequire(path.join(runtime, 'index.js'));
  const code = await req('./app/main.js').main({ exeDir, version: VERSION, argv: process.argv.slice(2) });
  process.exit(code || 0);
}

start().catch(async (e) => {
  console.error('\nThe casters hit a problem and had to stop:\n' + (e && e.stack || e));
  if (process.stdin.isTTY) {
    console.log('\nPress Enter to close this window.');
    await new Promise((r) => { process.stdin.resume(); process.stdin.once('data', r); });
  }
  process.exit(1);
});
