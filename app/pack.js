'use strict';
// Voice packs: every line pre-recorded in a "studio session" (the Colab notebook),
// the way Madden records its commentators. The casters play these files instead of
// generating speech during the match.
//
// A pack is a zip with manifest.json ({ type: 'rl-career-casters-voicepack', lines: [{ role, mood, text, file }] })
// and the MP3 files it lists. On import each line is decoded, run through the same
// broadcast voice chain as live lines, and saved as WAV (Windows plays WAV instantly).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PACK_TYPE = 'rl-career-casters-voicepack';
// accents don't matter (a pack's "Fibérr" matches the game's "Fiberr")
const norm = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const keyOf = (role, mood, text) => `${role}|${mood}|${norm(text)}`;

function openZip(file) {
  const yauzl = require('yauzl');
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: false }, (e, z) => (e ? reject(e) : resolve(z))));
}

// read every entry we care about into memory (packs are tens of MB)
function readEntries(zip, want) {
  return new Promise((resolve, reject) => {
    const out = new Map();
    zip.on('error', reject);
    zip.on('end', () => resolve(out));
    zip.on('entry', (entry) => {
      const name = entry.fileName.replace(/\\/g, '/').replace(/^[^/]*?\/(?=manifest\.json$|lines\/)/, '');
      if (/\/$/.test(entry.fileName) || !want(name)) { zip.readEntry(); return; }
      zip.openReadStream(entry, (e, s) => {
        if (e) return reject(e);
        const chunks = [];
        s.on('data', (c) => chunks.push(c));
        s.on('end', () => { out.set(name, Buffer.concat(chunks)); zip.readEntry(); });
        s.on('error', reject);
      });
    });
    zip.readEntry();
  });
}

async function readManifest(file) {
  try {
    const zip = await openZip(file);
    const m = await readEntries(zip, (n) => n === 'manifest.json');
    zip.close();
    if (!m.has('manifest.json')) return null;
    const man = JSON.parse(m.get('manifest.json').toString('utf8'));
    return man && man.type === PACK_TYPE ? man : null;
  } catch (e) { return null; }
}

// look for new pack zips next to the exe and in the Casters folder
async function findPackZips(dirs) {
  const found = [];
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d); } catch (e) { continue; }
    for (const n of names) {
      if (!/\.zip$/i.test(n)) continue;
      const file = path.join(d, n);
      const man = await readManifest(file);
      if (man) found.push({ file, man, mtime: fs.statSync(file).mtimeMs });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

// the add-on packs that go with this pack and aren't already combined into it
function addonsFor(main, zips) {
  const done = new Set(main.man.includes || []);
  return zips.filter((z) => z.man.addon && z.man.name === main.man.name && !done.has(z.man.created));
}

// Registers a voice pack zip. Nothing is converted up front: each line is read from
// the zip and turned into a WAV the first time it's needed (about 10 ms), then kept.
// A pack imported in full by an older version is reused as it is.
async function importPack({ file, packsDir, log }) {
  const id = crypto.createHash('sha1').update(fs.statSync(file).size + ':' + fs.statSync(file).mtimeMs + ':' + path.basename(file)).digest('hex').slice(0, 10);
  const dest = path.join(packsDir, id);
  fs.rmSync(dest + '.tmp', { recursive: true, force: true }); // left over from an interrupted full import
  if (fs.existsSync(path.join(dest, 'pack.json'))) return dest;
  const zip = await openZip(file);
  const names = new Set();
  const entries = await readEntries(zip, (n) => { names.add(n); return n === 'manifest.json'; });
  zip.close();
  const man = JSON.parse(entries.get('manifest.json').toString('utf8'));
  const lines = [];
  let bad = 0;
  for (const l of man.lines || []) {
    const src = String(l.file || '').replace(/\\/g, '/');
    if (!names.has(src)) { bad++; continue; }
    lines.push({ role: l.role, mood: l.mood, text: l.text, src });
  }
  fs.mkdirSync(path.join(dest, 'wav'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'pack.json'), JSON.stringify({ format: 'lazy', zip: file, name: man.name || path.basename(file), created: man.created, kbps: man.kbps, source: path.basename(file), casters: man.casters, oneVoice: !!man.oneVoice, players: man.players, teams: man.teams, lines }));
  log(`Added voice pack ${path.basename(file)}: ${lines.length} lines${bad ? ` (${bad} missing from the zip)` : ''}. Each line is prepared the first time it's used.`);
  return dest;
}

// the zip entries by name, without reading their data
function listEntries(zip) {
  return new Promise((resolve, reject) => {
    const out = new Map();
    zip.on('error', reject);
    zip.on('end', () => resolve(out));
    zip.on('entry', (entry) => {
      const name = entry.fileName.replace(/\\/g, '/').replace(/^[^/]*?\/(?=manifest\.json$|lines\/)/, '');
      if (!/\/$/.test(entry.fileName)) out.set(name, entry);
      zip.readEntry();
    });
    zip.readEntry();
  });
}

function readEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (e, s) => {
      if (e) return reject(e);
      const chunks = [];
      s.on('data', (c) => chunks.push(c));
      s.on('end', () => resolve(Buffer.concat(chunks)));
      s.on('error', reject);
    });
  });
}

// length of a 16-bit mono WAV we wrote, from its header
function wavMs(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const h = Buffer.alloc(44);
    fs.readSync(fd, h, 0, 44, 0);
    fs.closeSync(fd);
    const sr = h.readUInt32LE(24), size = fs.statSync(file).size;
    return sr > 0 && size > 44 ? Math.round(((size - 44) / 2 / sr) * 1000) : 0;
  } catch (e) { return 0; }
}

class PackVoice {
  constructor(dir, opts = {}) {
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
    this.info = p;
    this.dir = dir;
    this.lazy = p.format === 'lazy';
    this.opts = opts;
    this.strict = true;
    this.zip = null;
    this.entries = null;
    this.byKey = new Map();
    this.byText = new Map(); // same line in another mood, if the exact mood wasn't recorded
    p.lines.forEach((l, i) => {
      const v = this.lazy
        ? { src: l.src, file: path.join(dir, 'wav', `${String(i).padStart(5, '0')}.wav`), ms: 0, pending: null }
        : { file: path.join(dir, l.file), ms: l.ms };
      this.byKey.set(keyOf(l.role, l.mood, l.text), v);
      const tk = `${l.role}|${norm(l.text)}`;
      if (!this.byText.has(tk)) this.byText.set(tk, v);
    });
  }

  // opens the zip the lines are read from (lazy packs only)
  async open() {
    if (!this.lazy) return;
    const file = [this.opts.zipFile, this.info.zip].find((f) => f && fs.existsSync(f));
    if (!file) {
      (this.opts.log || console.log)(`The voice pack zip (${this.info.source}) is missing. Put it back next to the exe; until then only lines already used can play.`);
      return;
    }
    this.zip = await openZip(file);
    this.entries = await listEntries(this.zip);
    this.zip.removeAllListeners('end');
  }

  ready(v) {
    if (!v.ms && this.lazy) v.ms = fs.existsSync(v.file) ? wavMs(v.file) : 0;
    return v.ms > 0;
  }

  convert(v) {
    if (this.ready(v)) return Promise.resolve(v);
    if (v.pending) return v.pending;
    v.pending = (async () => {
      const entry = this.entries && this.entries.get(v.src);
      if (!entry) throw new Error('not in the voice pack zip');
      const buf = await readEntry(this.zip, entry);
      const { MPEGDecoder } = require('mpg123-decoder');
      const dec = new MPEGDecoder();
      await dec.ready;
      let r;
      try { r = dec.decode(new Uint8Array(buf)); } finally { dec.free(); }
      if (!r.samplesDecoded) throw new Error('could not read that line');
      const x = this.opts.processVoice ? this.opts.processVoice(r.channelData[0], r.sampleRate) : r.channelData[0];
      const tmp = v.file + '.tmp';
      fs.writeFileSync(tmp, this.opts.wavBuffer(x, r.sampleRate));
      fs.renameSync(tmp, v.file);
      v.ms = Math.round((x.length / r.sampleRate) * 1000);
      return v;
    })().finally(() => { v.pending = null; });
    return v.pending;
  }

  usable(v) { return !!v && (!this.lazy || !!this.entries || this.ready(v)); }
  find(c) {
    const v = this.byKey.get(keyOf(c.role, c.mood || 'lively', c.text)) || this.byText.get(`${c.role}|${norm(c.text)}`) || null;
    return this.usable(v) ? v : null;
  }
  has(c) { return !!this.find(c); }
  // how long a line lasts, in ms, without decoding it: the pack's MP3s are a constant
  // 64 kbps (studio default; a manifest can say otherwise), so length = bytes / 8
  durationOf(c) {
    const v = this.find(c);
    if (!v) return 0;
    if (v.ms) return v.ms;
    const e = this.lazy && this.entries && this.entries.get(v.src);
    return e ? Math.round((e.uncompressedSize * 8) / (this.info.kbps || 64)) : 0;
  }
  request(c) {
    const f = this.find(c);
    if (!f) return Promise.reject(new Error('not in the voice pack'));
    if (!this.lazy) return Promise.resolve(f);
    return this.convert(f).then((v) => ({ file: v.file, ms: v.ms }));
  }
  prefetch(c) { const f = this.lazy && this.find(c); if (f) this.convert(f).catch(() => {}); }
  dropBackground() {}
  get queued() { return 0; }
  get busy() { return false; }
  get avgRenderMs() { return 0; }
  get size() { return this.byKey.size; }
  close() { try { this.zip && this.zip.close(); } catch (e) {} }
}

// Several packs at once (say, the main pack and a later add-on with new lines):
// a line is played from whichever pack has it. The biggest pack describes the voice.
class PackSet {
  constructor(voices) {
    this.voices = voices.slice().sort((a, b) => b.size - a.size);
    const main = this.voices[0].info;
    const uniq = (k) => [...new Set(this.voices.flatMap((v) => v.info[k] || []))];
    const extra = this.voices.length - 1;
    this.info = { ...main, name: `${main.name}${extra ? ` + ${extra} add-on${extra > 1 ? 's' : ''}` : ''}`, players: uniq('players'), teams: uniq('teams') };
    this.strict = true;
  }
  owner(c) { return this.voices.find((v) => v.has(c)) || null; }
  find(c) { const v = this.owner(c); return v ? v.find(c) : null; }
  has(c) { return !!this.owner(c); }
  request(c) { const v = this.owner(c); return v ? v.request(c) : Promise.reject(new Error('not in the voice pack')); }
  durationOf(c) { const v = this.owner(c); return v ? v.durationOf(c) : 0; }
  prefetch(c) { const v = this.owner(c); if (v) v.prefetch(c); }
  dropBackground() {}
  get queued() { return 0; }
  get busy() { return false; }
  get avgRenderMs() { return 0; }
  get size() { return this.voices.reduce((a, v) => a + v.size, 0); }
  close() { this.voices.forEach((v) => v.close && v.close()); }
}

module.exports = { PACK_TYPE, findPackZips, addonsFor, importPack, PackVoice, PackSet, norm, keyOf, openZip, listEntries, readEntry, readManifest };
