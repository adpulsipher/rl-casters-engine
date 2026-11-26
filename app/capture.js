'use strict';
// Match recorder ("--capture"): saves everything Rocket League's Stats API sends, with
// the time it arrived, plus what the casters said and when. One file per match in
// Casters\captures, gzipped when the match is over. Used to test and tune the engine
// against real games. It only writes inside the Casters folder.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

class Capture {
  constructor({ dir, log, header }) {
    Object.assign(this, { dir, log, header: header || {} });
    fs.mkdirSync(dir, { recursive: true });
    this.fd = null;
    this.file = null;
    this.t0 = 0;
    this.events = 0;
    this.sawMatch = false;
  }

  open() {
    const now = new Date();
    this.file = path.join(this.dir, `match ${stamp(now)}.jsonl`);
    this.fd = fs.openSync(this.file, 'a');
    this.t0 = Date.now();
    this.events = 0;
    this.sawMatch = false;
    this.write({ k: 'header', at: now.toISOString(), ...this.header });
  }

  write(obj) {
    if (this.fd === null) return;
    try { fs.writeSync(this.fd, JSON.stringify({ t: Date.now() - this.t0, ...obj }) + '\n'); } catch (e) {}
  }

  event(name, data) {
    // a new match starts a new file; the first event of all opens one too (joined mid-match)
    if (name === 'MatchCreated' && this.fd !== null && this.sawMatch) this.finish();
    if (this.fd === null) { if (name === 'MatchDestroyed') return; this.open(); }
    if (name === 'MatchCreated' || name === 'MatchInitialized' || name === 'RoundStarted') this.sawMatch = true;
    this.events++;
    this.write({ e: name, d: data });
    if (name === 'MatchDestroyed') this.finish();
  }

  // anything else worth keeping: lines the casters said, lines that were dropped, log messages
  note(kind, obj) { if (this.fd !== null) this.write({ k: kind, ...obj }); }

  finish() {
    if (this.fd === null) return;
    const file = this.file, n = this.events;
    try { fs.closeSync(this.fd); } catch (e) {}
    this.fd = null; this.file = null;
    if (n < 50) { try { fs.unlinkSync(file); } catch (e) {} return; } // a menu blip, not a match
    const gz = file + '.gz';
    const src = fs.createReadStream(file), out = fs.createWriteStream(gz);
    src.pipe(zlib.createGzip({ level: 6 })).pipe(out);
    out.on('finish', () => {
      try { fs.unlinkSync(file); } catch (e) {}
      const mb = (fs.statSync(gz).size / 1048576).toFixed(1);
      this.log(`Match recorder: saved "${path.basename(gz)}" (${mb} MB) in ${this.dir}`);
    });
    out.on('error', (e) => this.log(`Match recorder: could not compress ${path.basename(file)} (${e.message}); the plain file is kept.`));
  }

  close() { this.finish(); }
}

module.exports = { Capture };
