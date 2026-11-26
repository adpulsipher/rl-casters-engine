'use strict';
// Expressive text-to-speech with Kyutai Pocket TTS (via sherpa-onnx).
// Pocket TTS copies the delivery of a short reference clip, so each caster has
// three reference clips: hype (goals), lively (saves, demos, the clock) and calm
// (analysis). Every rendered line is checked with a small speech recognizer and
// re-taken if words went missing. Finished lines are cached on disk.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENGINE_VERSION = 'pocket-3'; // cache folder version (3: lines evened out by loudness)
const MOODS = ['hype', 'lively', 'calm'];
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

// ------------------------------------------------------------------- DSP
function biquad(x, b0, b1, b2, a1, a2) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0; x[i] = y0;
  }
}
function highpass(x, sr, f, q = 0.707) {
  const w = 2 * Math.PI * f / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
  biquad(x, (1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - al) / a0);
}
function peaking(x, sr, f, gainDb, q) {
  const A = 10 ** (gainDb / 40), w = 2 * Math.PI * f / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al / A;
  biquad(x, (1 + al * A) / a0, -2 * c / a0, (1 - al * A) / a0, -2 * c / a0, (1 - al / A) / a0);
}

// broadcast voice chain: trim, low cut, presence lift, gentle compression, then every line
// brought to the same loudness (2.1; it used to match peaks, which left speech up to 12 dB apart)
function processVoice(input, sr) {
  const thr = 0.008;
  let s = 0, e = input.length - 1;
  while (s < e && Math.abs(input[s]) < thr) s++;
  while (e > s && Math.abs(input[e]) < thr) e--;
  // Pocket starts speaking on the very first sample: put 80 ms of silence in front
  // so the filters and fade can't eat the first consonant
  const lead = Math.round(sr * 0.08), tail = Math.round(sr * 0.03);
  const body = input.subarray(Math.max(0, s - tail), Math.min(input.length, e + tail));
  const x = new Float32Array(lead + body.length);
  x.set(body, lead);
  if (x.length < sr * 0.1) return x;
  highpass(x, sr, 85);
  peaking(x, sr, 200, -1.5, 1.0);
  peaking(x, sr, 3200, 2.5, 0.9);
  const att = Math.exp(-1 / (sr * 0.004)), rel = Math.exp(-1 / (sr * 0.09));
  const thrLin = 10 ** (-22 / 20), ratio = 3;
  let env = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i] * x[i];
    env = v > env ? att * env + (1 - att) * v : rel * env + (1 - rel) * v;
    const lvl = Math.sqrt(env);
    if (lvl > thrLin) x[i] *= (thrLin * (lvl / thrLin) ** (1 / ratio)) / lvl;
  }
  const g = loudnessGain(x, sr);
  const fade = Math.round(sr * 0.008);
  for (let i = 0; i < x.length; i++) {
    let f = 1;
    if (i < fade) f = i / fade; else if (i > x.length - fade) f = (x.length - i) / fade;
    x[i] *= g * f;
  }
  limit(x, sr);
  return x;
}

// the gain that brings the speech in a line (pauses left out) to -19 dBFS RMS, at most +18 dB
const TARGET_RMS = 10 ** (-19 / 20);
function loudnessGain(x, sr) {
  const n = Math.max(1, Math.round(sr * 0.02));
  const frames = [];
  for (let i = 0; i + n <= x.length; i += n) {
    let s = 0;
    for (let k = i; k < i + n; k++) s += x[k] * x[k];
    frames.push(s / n);
  }
  if (!frames.length) return 1;
  const top = Math.max(...frames);
  const gate = Math.max(1e-5, top * 10 ** (-25 / 10)); // frames within 25 dB of the loudest
  const speech = frames.filter((v) => v >= gate);
  const rms = Math.sqrt(speech.reduce((a, v) => a + v, 0) / speech.length);
  return rms > 0 ? Math.min(10 ** (18 / 20), TARGET_RMS / rms) : 1;
}

// peak limiter at -1 dBFS: looks 2 ms ahead so it turns down before a peak, eases back over 60 ms
function limit(x, sr) {
  const ceil = 10 ** (-1 / 20);
  const ahead = Math.max(1, Math.round(sr * 0.002));
  const rel = Math.exp(-1 / (sr * 0.06));
  const need = new Float32Array(x.length);
  let any = false;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); need[i] = a > ceil ? ceil / a : 1; if (need[i] < 1) any = true; }
  if (!any) return;
  let g = 1;
  for (let i = 0; i < x.length; i++) {
    let m = 1;
    for (let k = i; k < Math.min(x.length, i + ahead); k++) if (need[k] < m) m = need[k];
    g = m < g ? m : rel * g + (1 - rel) * m;
    x[i] *= Math.min(g, need[i]);
  }
}

function wavBuffer(samples, sr) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return buf;
}

// ----------------------------------------------------- line checking
const words = (s) => String(s).toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/).filter((w) => w.length > 1);

class LineChecker {
  constructor({ sherpa, modelDir, vocab, log }) {
    this.vocab = vocab; // words that appear in the line bank (names are left out of the check)
    this.rec = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: { nemoCtc: { model: path.join(modelDir, 'model.int8.onnx') }, tokens: path.join(modelDir, 'tokens.txt'), numThreads: 1, provider: 'cpu', debug: 0 },
    });
    this.log = log;
  }
  // share of the line's ordinary words that were actually heard
  score(text, samples, sr) {
    const all = words(text);
    const expect = all.filter((w) => this.vocab.has(w));
    const padded = new Float32Array(samples.length + Math.round(sr * 0.3));
    padded.set(samples, Math.round(sr * 0.15));
    const st = this.rec.createStream();
    st.acceptWaveform({ samples: padded, sampleRate: sr });
    this.rec.decode(st);
    const heardList = words(this.rec.getResult(st).text);
    const heard = new Set(heardList);
    let score = expect.length >= 3 ? expect.filter((w) => heard.has(w)).length / expect.length : 1;
    if (heardList.length < all.length * 0.8) score -= 0.3; // a name or the first word went missing
    return score;
  }
}

// ----------------------------------------------------------------- engine
class TTS {
  constructor({ sherpa, modelDir, checkerDir, voicesDir, cacheDir, threads, roles, temperature, vocab, log }) {
    Object.assign(this, { sherpa, modelDir, checkerDir, voicesDir, cacheDir, threads, roles, temperature, vocab, log });
    this.queue = [];
    this.pending = new Map();
    this.ready = new Map();
    this.busy = false;
    this.renderMs = [];
    this.seed = Math.floor(Math.random() * 1e6);
  }

  async init() {
    const t0 = Date.now();
    const M = this.modelDir;
    const f = (a, b) => (fs.existsSync(path.join(M, a)) ? path.join(M, a) : path.join(M, b));
    this.engine = await this.sherpa.OfflineTts.createAsync({
      model: {
        pocket: {
          lmFlow: f('lm_flow.int8.onnx', 'lm_flow.onnx'), lmMain: f('lm_main.int8.onnx', 'lm_main.onnx'),
          encoder: path.join(M, 'encoder.onnx'), decoder: f('decoder.int8.onnx', 'decoder.onnx'),
          textConditioner: path.join(M, 'text_conditioner.onnx'), vocabJson: path.join(M, 'vocab.json'),
          tokenScoresJson: path.join(M, 'token_scores.json'), voiceEmbeddingCacheCapacity: 12,
        },
        numThreads: this.threads, debug: false, provider: 'cpu',
      },
      maxNumSentences: 1,
    });
    if (this.checkerDir) {
      try { this.checker = new LineChecker({ sherpa: this.sherpa, modelDir: this.checkerDir, vocab: this.vocab, log: this.log }); }
      catch (e) { this.log(`Line checking is off (${e.message})`); }
    }
    this.log(`Voices loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

    // reference clips: Casters\voices\<male|female>-<hype|lively|calm>.wav
    this.refs = {};
    for (const who of ['male', 'female']) {
      for (const mood of MOODS) {
        const file = path.join(this.voicesDir, `${who}-${mood}.wav`);
        if (!fs.existsSync(file)) throw new Error(`missing voice clip ${file}`);
        const w = this.sherpa.readWave(file);
        this.refs[`${who}-${mood}`] = { samples: w.samples, sampleRate: w.sampleRate, hash: sha(fs.readFileSync(file)).slice(0, 10) };
      }
    }

    // one cache folder per voice clip + settings, so swapping a clip re-renders cleanly
    this.sig = {};
    for (const role of ['pbp', 'color']) {
      for (const mood of MOODS) {
        const r = this.refs[`${this.roles[role].voice}-${mood}`];
        const sig = sha(JSON.stringify({ e: ENGINE_VERSION, ref: r.hash, t: this.temperature })).slice(0, 12);
        this.sig[`${role}-${mood}`] = sig;
        const dir = path.join(this.cacheDir, sig);
        fs.mkdirSync(dir, { recursive: true });
        for (const file of fs.readdirSync(dir)) {
          if (!file.endsWith('.wav')) continue;
          const full = path.join(dir, file);
          const size = fs.statSync(full).size;
          if (size > 44) this.ready.set(`${sig}/${file.slice(0, -4)}`, { file: full, ms: ((size - 44) / 2 / 24000) * 1000 });
        }
      }
    }
    this.log(`${this.ready.size} lines already rendered in the cache`);
  }

  // clip = { role: 'pbp'|'color', mood: 'hype'|'lively'|'calm', text }
  key(c) { return `${this.sig[`${c.role}-${c.mood || 'lively'}`]}/${sha(c.text)}`; }
  has(c) { return this.ready.has(this.key(c)); }
  get queued() { return this.queue.length; }
  get avgRenderMs() { return this.renderMs.length ? this.renderMs.reduce((a, b) => a + b, 0) / this.renderMs.length : 2000; }

  // prio: 0 = needed right now, 1 = this match, 2 = background
  request(c, prio = 2) {
    const key = this.key(c);
    const done = this.ready.get(key);
    if (done) return Promise.resolve(done);
    let job = this.pending.get(key);
    if (!job) {
      job = { key, clip: c, prio, waiters: [] };
      this.pending.set(key, job);
      this.queue.push(job);
    } else if (prio < job.prio) job.prio = prio;
    const p = new Promise((resolve, reject) => job.waiters.push({ resolve, reject }));
    this.pump();
    return p;
  }
  prefetch(c, prio = 2) { this.request(c, prio).catch(() => {}); }

  dropBackground(prioAtLeast) {
    this.queue = this.queue.filter((j) => {
      if (j.prio >= prioAtLeast && !j.waiters.length) { this.pending.delete(j.key); return false; }
      return true;
    });
  }

  async pump() {
    if (this.busy || !this.engine) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        this.queue.sort((a, b) => a.prio - b.prio);
        const job = this.queue.shift();
        try {
          const res = await this.render(job);
          this.ready.set(job.key, res);
          job.waiters.forEach((w) => w.resolve(res));
        } catch (e) {
          this.log(`Could not render "${job.clip.text}": ${e.message}`);
          job.waiters.forEach((w) => w.reject(e));
        }
        this.pending.delete(job.key);
      }
    } finally { this.busy = false; }
  }

  // later takes are steadier: lower temperature means fewer stumbles
  async take(c, attempt = 0) {
    const r = this.roles[c.role];
    const ref = this.refs[`${r.voice}-${c.mood || 'lively'}`];
    const steady = attempt >= 3 ? 0.6 : attempt >= 2 ? 0.8 : 1;
    const temp = this.temperature * (c.mood === 'calm' ? 0.85 : 1) * steady;
    const cfg = new this.sherpa.GenerationConfig({
      referenceAudio: ref.samples, referenceSampleRate: ref.sampleRate, numSteps: 2,
      extra: { temperature: temp, seed: this.seed++ % 2147483647, max_reference_audio_len: 12 },
    });
    // a leading dash makes Pocket say the first word cleanly instead of swallowing it
    return this.engine.generateAsync({ text: `- ${c.text}`, enableExternalBuffer: false, generationConfig: cfg });
  }

  async render(job) {
    const c = job.clip;
    const t0 = Date.now();
    // urgent lines get two takes; prepared lines up to four, plus a careful fifth if all were garbled
    const maxTakes = this.checker ? (job.prio === 0 ? 2 : 4) : 1;
    let best = null;
    for (let i = 0; i < maxTakes + 1; i++) {
      if (i === maxTakes && (job.prio === 0 || !best || best.score >= 0.6)) break;
      const audio = await this.take(c, i === maxTakes ? 3 : i);
      const secs = audio.samples.length / audio.sampleRate;
      const n = words(c.text).length;
      let score = this.checker ? this.checker.score(c.text, audio.samples, audio.sampleRate) : 1;
      if (secs > 1.5 + n * 0.75) score -= 0.5; // rambling past the end of the line
      if (!best || score > best.score) best = { audio, score };
      if (score >= 0.8) break;
    }
    this.renderMs.push(Date.now() - t0); if (this.renderMs.length > 30) this.renderMs.shift();
    const x = processVoice(best.audio.samples, best.audio.sampleRate);
    const file = path.join(this.cacheDir, job.key + '.wav');
    fs.writeFileSync(file + '.tmp', wavBuffer(x, best.audio.sampleRate));
    fs.renameSync(file + '.tmp', file);
    return { file, ms: (x.length / best.audio.sampleRate) * 1000 };
  }
}

module.exports = { TTS, processVoice, wavBuffer, MOODS, words };
