'use strict';
// Combine a voice pack and its add-on packs into one pack zip ("Combine voice packs.bat").
// Nothing is changed or deleted: a new "(combined ...)" zip is written next to the pack,
// and from then on the casters use it and ignore the zips it was made from.
//
// Where the pack and an add-on both have a line, the add-on's take wins (it's newer:
// add-ons re-record lines whose spoken name changed). Every line keeps its audio
// byte for byte; only the file names inside the zip are renumbered.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const pack = require('./pack');

const crcOf = (buf) => zlib.crc32(buf) >>> 0;

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// a plain zip writer (no zip64: a pack is far below 4 GB and 65,535 files)
class ZipWriter {
  constructor(file) {
    this.fd = fs.openSync(file, 'w');
    this.pos = 0;
    this.central = [];
    this.when = dosTime(new Date());
  }
  write(buf) { let off = 0; while (off < buf.length) off += fs.writeSync(this.fd, buf, off, buf.length - off, this.pos + off); this.pos += buf.length; }
  add(name, data, { method = 0, crc, size }) {
    const n = Buffer.from(name, 'utf8');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(method, 8);
    h.writeUInt16LE(this.when.time, 10); h.writeUInt16LE(this.when.date, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(size, 22);
    h.writeUInt16LE(n.length, 26); h.writeUInt16LE(0, 28);
    const offset = this.pos;
    if (offset + 30 + n.length + data.length > 0xfffffff0) throw new Error('the combined pack would be over 4 GB');
    this.write(h); this.write(n); this.write(data);
    this.central.push({ n, method, crc, csize: data.length, size, offset });
  }
  close() {
    if (this.central.length > 0xfffe) throw new Error('the combined pack would have too many files');
    const start = this.pos;
    for (const e of this.central) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(this.when.time, 12); c.writeUInt16LE(this.when.date, 14);
      c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.csize, 20); c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.n.length, 28); c.writeUInt32LE(e.offset, 42);
      this.write(c); this.write(e.n);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(this.central.length, 8); end.writeUInt16LE(this.central.length, 10);
    end.writeUInt32LE(this.pos - start, 12); end.writeUInt32LE(start, 16);
    this.write(end);
    fs.closeSync(this.fd);
  }
  abort() { try { fs.closeSync(this.fd); } catch (e) {} }
}

const stamp = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
const fmt = (n) => n.toLocaleString('en-US');

function union(lists) {
  const seen = new Set(), out = [];
  for (const list of lists) for (const x of list || []) { const k = pack.norm(x); if (x && !seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}

async function combinePacks({ dirs, log, outDir }) {
  const zips = await pack.findPackZips(dirs);
  const main = zips.find((z) => !z.man.addon);
  if (!main) { log('No voice pack found. Put the pack zip and its add-on zips next to RL Career Casters.exe, then run this again.'); return null; }
  const addons = pack.addonsFor(main, zips).sort((a, b) => String(a.man.created).localeCompare(String(b.man.created)));
  if (!addons.length) {
    const others = zips.filter((z) => z.man.addon && z.man.name !== main.man.name);
    log(`"${main.man.name}" has no add-ons to combine. It's already one pack.` +
      (others.length ? ` (Found an add-on for a different pack, "${others[0].man.name}". An add-on only goes with the pack of the same name.)` : ''));
    return null;
  }
  const sources = [main, ...addons];
  log(`Combining "${main.man.name}" (${path.basename(main.file)}) with ${addons.length} add-on${addons.length > 1 ? 's' : ''}:`);
  for (const a of addons) log(`  + ${path.basename(a.file)}`);

  // every line goes to the newest source that has it
  const owner = new Map();
  sources.forEach((s, i) => { for (const l of s.man.lines || []) owner.set(pack.keyOf(l.role, l.mood, l.text), i); });

  const name = String(main.man.name || 'Voice pack');
  const now = new Date();
  const outFile = path.join(outDir || path.dirname(main.file), `RL Career Casters Voice Pack - ${name.replace(/[<>:"/\\|?*]+/g, '')} (combined ${stamp(now)}).zip`);
  const tmp = outFile + '.part';
  const zw = new ZipWriter(tmp);
  const opened = [];
  try {
    const plan = [];
    let missing = 0, replaced = 0;
    for (let i = 0; i < sources.length; i++) {
      const zip = await pack.openZip(sources[i].file);
      zip.__file = sources[i].file;
      opened.push(zip);
      const entries = await pack.listEntries(zip);
      for (const l of sources[i].man.lines || []) {
        if (owner.get(pack.keyOf(l.role, l.mood, l.text)) !== i) { replaced++; continue; }
        const src = String(l.file || '').replace(/\\/g, '/');
        const entry = entries.get(src);
        if (!entry) { missing++; continue; }
        plan.push({ zip, entry, line: l, ext: path.extname(src) || '.mp3' });
      }
    }
    const lines = plan.map((p, i) => {
      p.file = `lines/${String(i).padStart(5, '0')}${p.ext}`;
      const { file, ...rest } = p.line;
      return { ...rest, file: p.file };
    });
    const man = { ...main.man };
    delete man.addon;
    Object.assign(man, {
      created: now.toISOString().replace(/\.\d+Z$/, '+00:00'),
      players: union(sources.map((s) => s.man.players)),
      teams: union(sources.map((s) => s.man.teams)),
      combined: [...(main.man.combined || [path.basename(main.file)]), ...addons.map((a) => path.basename(a.file))],
      includes: [...(main.man.includes || []), ...addons.map((a) => a.man.created)],
      lines,
    });
    const mj = Buffer.from(JSON.stringify(man), 'utf8');
    zw.add('manifest.json', zlib.deflateRawSync(mj), { method: 8, crc: crcOf(mj), size: mj.length });

    let done = 0;
    for (const p of plan) {
      const data = await pack.readEntry(p.zip, p.entry);
      const crc = p.entry.crc32 >>> 0;
      if (data.length !== p.entry.uncompressedSize || crcOf(data) !== crc) throw new Error(`${p.entry.fileName} is damaged in ${path.basename(p.zip.__file || '')}`);
      zw.add(p.file, data, { method: 0, crc, size: data.length });
      if (++done % 2000 === 0) log(`  ${fmt(done)} of ${fmt(plan.length)} lines...`);
    }
    zw.close();
    for (const z of opened) z.close();

    // make sure what we wrote reads back as a pack before it replaces anything
    const check = await pack.readManifest(tmp);
    if (!check || !check.lines || check.lines.length !== lines.length) throw new Error('the new zip did not read back correctly');
    fs.renameSync(tmp, outFile);

    const sizeMb = Math.round(fs.statSync(outFile).size / 1048576);
    log(`\nDone: ${fmt(lines.length)} lines, ${man.players.length} players, ${man.teams.length} teams (${fmt(sizeMb)} MB).`);
    if (replaced) log(`${fmt(replaced)} older take${replaced > 1 ? 's were' : ' was'} replaced by the add-on's newer recording.`);
    if (missing) log(`${fmt(missing)} line${missing > 1 ? 's were' : ' was'} listed but missing from the zips and left out.`);
    log(`Saved as "${path.basename(outFile)}" in ${path.dirname(outFile)}`);
    log('The casters use the combined pack from now on. The old pack and add-on zips are no longer used,');
    log('so you can delete them (or keep them as a backup).');
    return { file: outFile, lines: lines.length };
  } catch (e) {
    zw.abort();
    for (const z of opened) try { z.close(); } catch (x) {}
    try { fs.rmSync(tmp, { force: true }); } catch (x) {}
    throw e;
  }
}

module.exports = { combinePacks };
