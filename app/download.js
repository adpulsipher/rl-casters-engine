'use strict';
// First-run downloads: the Pocket TTS voice model and the small speech recognizer that checks each line.

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
// Kyutai Pocket TTS (CC-BY-4.0 weights) and a small English speech recognizer used to check each line
const MODELS = {
  voice: {
    name: 'sherpa-onnx-pocket-tts-int8-2026-01-26', url: `${BASE}/tts-models/sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2`, mb: 98,
    keep: /^[^/]+\/(lm_flow\.int8\.onnx|lm_main\.int8\.onnx|encoder\.onnx|decoder\.int8\.onnx|text_conditioner\.onnx|vocab\.json|token_scores\.json|LICENSE|README\.md)$/,
    needed: ['lm_flow.int8.onnx', 'lm_main.int8.onnx', 'encoder.onnx', 'decoder.int8.onnx', 'text_conditioner.onnx', 'vocab.json', 'token_scores.json'],
    label: 'the voice model',
  },
  checker: {
    name: 'sherpa-onnx-nemo-ctc-en-conformer-small', url: `${BASE}/asr-models/sherpa-onnx-nemo-ctc-en-conformer-small.tar.bz2`, mb: 76,
    keep: /^[^/]+\/(model\.int8\.onnx|tokens\.txt|README\.md)$/,
    needed: ['model.int8.onnx', 'tokens.txt'],
    label: 'the line checker',
  },
};

function modelReady(dir, needed) {
  return fs.existsSync(path.join(dir, '.complete')) && needed.every((f) => fs.existsSync(path.join(dir, f)));
}

async function downloadFile(url, dest, log) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  let got = 0, lastPct = -1, lastT = 0;
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    const body = Readable.fromWeb(res.body);
    body.on('data', (c) => {
      got += c.length;
      const pct = total ? Math.floor((got / total) * 100) : -1;
      if (pct !== lastPct && Date.now() - lastT > 400) {
        lastPct = pct; lastT = Date.now();
        const mbps = got / 1e6 / Math.max(0.1, (Date.now() - t0) / 1000);
        process.stdout.write(`\r  Downloading: ${total ? pct + '%' : (got / 1e6).toFixed(0) + ' MB'}  (${(got / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} MB, ${mbps.toFixed(1)} MB/s)   `);
      }
    });
    body.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    body.pipe(out);
  });
  process.stdout.write('\n');
  if (total && got !== total) throw new Error('download was cut short');
  fs.renameSync(tmp, dest);
}

async function extract(archive, destDir, keep, requireFrom, log) {
  const bz2 = requireFrom('unbzip2-stream');
  const tar = requireFrom('tar-stream');
  log('  Unpacking...');
  fs.mkdirSync(destDir, { recursive: true });
  await new Promise((resolve, reject) => {
    const ex = tar.extract();
    ex.on('entry', (h, stream, next) => {
      const name = h.name.replace(/^\.\//, '');
      if (h.type === 'file' && keep.test(name)) {
        const rel = name.split('/').slice(1).join('/');
        const file = path.join(destDir, rel);
        if (!path.resolve(file).startsWith(path.resolve(destDir))) { stream.resume(); stream.on('end', next); return; }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const w = fs.createWriteStream(file);
        stream.pipe(w);
        w.on('finish', next);
        w.on('error', reject);
      } else { stream.on('end', next); stream.resume(); }
    });
    ex.on('finish', resolve);
    ex.on('error', reject);
    const src = fs.createReadStream(archive);
    const dec = bz2();
    src.on('error', reject); dec.on('error', reject);
    src.pipe(dec).pipe(ex);
  });
}

async function ensureModel({ which, modelRoot, requireFrom, log, url }) {
  const m = MODELS[which];
  const dir = path.join(modelRoot, m.name);
  if (modelReady(dir, m.needed)) return dir;
  fs.mkdirSync(modelRoot, { recursive: true });
  log(`First launch: downloading ${m.label} (about ${m.mb} MB, one time only).`);
  const archive = path.join(modelRoot, m.name + '.tar.bz2');
  for (let attempt = 1; ; attempt++) {
    try {
      if (!fs.existsSync(archive)) await downloadFile(url || m.url, archive, log);
      await extract(archive, dir, m.keep, requireFrom, log);
      if (!m.needed.every((f) => fs.existsSync(path.join(dir, f)))) throw new Error('the download was missing files');
      fs.writeFileSync(path.join(dir, '.complete'), new Date().toISOString());
      try { fs.unlinkSync(archive); } catch (e) {}
      log('  Done.');
      return dir;
    } catch (e) {
      try { fs.unlinkSync(archive); } catch (e2) {}
      if (attempt >= 3) throw new Error(`Could not get ${m.label}: ${e.message}`);
      log(`  Problem (${e.message}). Retrying...`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

module.exports = { ensureModel, modelReady, MODELS };
