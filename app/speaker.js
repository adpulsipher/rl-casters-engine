'use strict';
// Plays what the director decides to say: one utterance (one or more lines back to back)
// at a time. The director owns the timing - what comes next, what waits, what's dropped -
// so the speaker only has to play, and stop cleanly when told to. Only a game-deciding goal
// interrupts a line, and then at the next pause between words, so no word is chopped.

const fs = require('fs');

// every line is evened out to the same loudness when it's rendered (tts.js); this only keeps
// the big moments a touch louder (0 dB, -1 dB, -2 dB)
const MOOD_GAIN = { hype: 1, lively: 0.89, calm: 0.79 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// where the pauses between words are in a rendered line: ms from the start of each pause
// of 60 ms or more (a little way into it, so a stop lands in the quiet)
const gapCache = new Map();
function gapsOf(file) {
  if (gapCache.has(file)) return gapCache.get(file);
  const out = [];
  try {
    const b = fs.readFileSync(file);
    let at = 12, sr = 24000, ch = 1, data = -1, len = 0;
    while (at + 8 <= b.length) {
      const id = b.toString('ascii', at, at + 4), n = b.readUInt32LE(at + 4);
      if (id === 'fmt ') { ch = b.readUInt16LE(at + 10) || 1; sr = b.readUInt32LE(at + 12) || 24000; }
      else if (id === 'data') { data = at + 8; len = Math.min(n, b.length - data); break; }
      at += 8 + n + (n & 1);
    }
    if (data >= 0) {
      const frame = Math.max(1, Math.round(sr * 0.01)) * ch;
      const frames = Math.floor(len / 2 / frame);
      const e = new Float64Array(frames);
      for (let f = 0; f < frames; f++) {
        let s = 0;
        for (let k = 0; k < frame; k++) { const v = b.readInt16LE(data + (f * frame + k) * 2) / 32768; s += v * v; }
        e[f] = Math.sqrt(s / frame);
      }
      const sorted = Array.from(e).sort((x, y) => x - y);
      const thr = Math.max(0.006, (sorted[Math.floor(frames * 0.8)] || 0) * 0.12);
      let run = 0;
      for (let f = 0; f < frames; f++) {
        if (e[f] < thr) { run++; if (run === 6) out.push((f - 5) * 10 + 20); } else run = 0;
      }
    }
  } catch (e) { /* no pauses known: a cut just fades */ }
  gapCache.set(file, out);
  if (gapCache.size > 400) gapCache.delete(gapCache.keys().next().value);
  return out;
}

class Speaker {
  constructor({ tts, player, log, onLine, onLineEnd, onDrop, oneVoice }) {
    Object.assign(this, { tts, player, log, onLine, onLineEnd, onDrop, oneVoice: !!oneVoice });
    this.active = null; // { utt, clip, clipAt, clipEnd }
    this.lastSpokeAt = 0; // when the last line ended
    this.token = 0;
  }

  get busy() { return !!this.active; }
  get current() { return this.active; }

  // utt: { clips: [{ role, mood, text, ms }], prio, kind, protect, onClip(clip), onDone(how) }
  // resolves when it has finished or been cut
  async speak(utt) {
    if (!utt || !utt.clips || !utt.clips.length) return 'empty';
    if (this.active) await this.interrupt(utt.cutWithin || 0);
    const token = ++this.token;
    const me = { utt, clip: null, clipAt: 0, clipEnd: 0, cancelled: false };
    this.active = me;
    let how = 'done';
    let prev = null;
    try {
      for (let i = 0; i < utt.clips.length; i++) {
        const clip = utt.clips[i];
        if (i > 0 && utt.trim) break; // asked to stop after the current line
        // the audio is normally ready (packs are local); never wait long for it
        const res = await Promise.race([this.tts.request(clip, 0).catch(() => null), sleep(i === 0 ? 600 : 1500).then(() => null)]);
        if (me.cancelled || token !== this.token) { how = 'cut'; break; }
        if (!res) { this.log(`(skipped a line that wasn't ready: "${clip.text}")`); if (i === 0) { how = 'missing'; break; } continue; }
        if (prev) {
          // a breath between lines: the same caster carries on quickly; the other one takes a beat
          await sleep(prev.role === clip.role ? 140 : this.oneVoice ? 200 : 340);
          if (me.cancelled || token !== this.token) { how = 'cut'; break; }
        }
        me.clip = clip; me.res = res; me.clipAt = Date.now(); me.clipEnd = me.clipAt + (res.ms || clip.ms || 0);
        if (utt.onClip) utt.onClip(clip, i);
        if (this.onLine) this.onLine(clip);
        const played = await this.player.play({ ...res, gain: MOOD_GAIN[clip.mood] || 1 });
        this.lastSpokeAt = Date.now();
        if (this.onLineEnd) this.onLineEnd(clip, played === false ? 'cut' : 'done');
        if (me.cancelled || token !== this.token || played === false) { how = 'cut'; break; }
        prev = clip;
      }
    } finally {
      if (this.active === me) this.active = null;
      this.lastSpokeAt = Date.now();
      if (utt.onDone) utt.onDone(how);
    }
    return how;
  }

  // stop what's playing at the next pause between words, if one comes within maxMs (or the
  // line ends first); no more lines from that utterance either way
  async interrupt(maxMs) {
    const a = this.active;
    if (!a) return;
    a.utt.trim = true;
    if (maxMs > 0 && a.res && a.res.file && a.clipAt) {
      const lat = this.player.latencyMs || 0;
      const pos = Date.now() - a.clipAt - lat; // how far into the line the listener is
      const ends = a.clipEnd + lat - Date.now();
      const g = gapsOf(a.res.file).find((x) => x >= pos + 30);
      let wait = g !== undefined ? g - pos : Infinity;
      if (ends > 0 && ends + 30 < wait) wait = ends + 30;
      if (wait <= maxMs) await sleep(Math.max(0, wait));
    }
    if (this.active === a) this.cut(50);
  }

  // stop what's playing now; fadeMs > 0 fades it out (the next line starts after the fade)
  cut(fadeMs = 150) {
    const a = this.active;
    if (!a) return;
    a.cancelled = true;
    this.active = null;
    this.token++;
    if (fadeMs > 0 && this.player.fadeOut) this.player.fadeOut(fadeMs); else this.player.stop();
  }

  stopAll() { this.cut(0); }
}

module.exports = { Speaker, MOOD_GAIN, gapsOf };
