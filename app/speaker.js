'use strict';
// Plays what the director decides to say: one utterance (one or more lines back to back)
// at a time. The director owns the timing - what comes next, what waits, what's dropped -
// so the speaker only has to play, and stop cleanly when told to: a cut fades the line
// out over a fraction of a second, like a caster breaking off mid-sentence for a goal.

const MOOD_GAIN = { hype: 1, lively: 0.75, calm: 0.63 }; // big moments loudest (0 dB, -2.5 dB, -4 dB)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    if (this.active) this.cut(120);
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
        me.clip = clip; me.clipAt = Date.now(); me.clipEnd = me.clipAt + (res.ms || clip.ms || 0);
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

  // stop what's playing; fadeMs > 0 fades it out (the next line starts after the fade)
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

module.exports = { Speaker, MOOD_GAIN };
