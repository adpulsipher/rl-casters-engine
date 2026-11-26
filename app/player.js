'use strict';
// Plays rendered WAV lines. On Windows a single hidden PowerShell process keeps
// a SoundPlayer open, so each line starts instantly. A line can be faded out
// (a goal cutting in): the volume ramps down over a quarter second, then the
// next line starts. "--record file.wav" also writes everything said to one WAV file.

const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
try { Add-Type -Name WinMM -Namespace Casters -MemberDefinition '[DllImport("winmm.dll")] public static extern int waveOutSetVolume(System.IntPtr h, uint v);' } catch {}
$p = New-Object System.Media.SoundPlayer
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  if ($line -eq 'STOP') { $p.Stop(); continue }
  if ($line.StartsWith('FADE ')) {
    # FADE <ms> <volume 0-65535>: ramp the volume down to nothing, then stop
    try {
      $a = $line.Substring(5).Split(' '); $ms = [int]$a[0]; $v = [double]$a[1]; $n = 10
      for ($i = $n - 1; $i -ge 0; $i--) {
        $c = [double][math]::Round($v * $i / $n)
        [void][Casters.WinMM]::waveOutSetVolume([IntPtr]::Zero, [uint32]($c * 65536 + $c))
        Start-Sleep -Milliseconds ([int]($ms / $n))
      }
    } catch {}
    $p.Stop(); continue
  }
  if ($line.StartsWith('VOL ')) { try { [void][Casters.WinMM]::waveOutSetVolume([IntPtr]::Zero, [uint32]$line.Substring(4)) } catch {}; continue }
  if ($line.StartsWith('PLAY ')) {
    try {
      $f = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring(5)))
      $p.SoundLocation = $f; $p.Load(); $p.Play()
    } catch { [Console]::Out.WriteLine('ERR ' + $_.Exception.Message); [Console]::Out.Flush() }
  }
}
`;

class WindowsPlayer {
  constructor(log) { this.log = log; }
  start(volume) {
    return new Promise((resolve) => {
      const enc = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
      this.ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
        { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      let ok = false;
      const done = (v) => { if (!ok) { ok = true; resolve(v); } };
      this.ps.stdout.setEncoding('utf8');
      this.ps.stdout.on('data', (d) => {
        if (d.includes('READY')) done(true);
        for (const l of d.split(/\r?\n/)) if (l.startsWith('ERR ')) this.log(`Audio: ${l.slice(4)}`);
      });
      this.ps.on('error', (e) => { this.log(`Audio player could not start: ${e.message}`); done(false); });
      this.ps.on('exit', () => { this.ps = null; done(false); });
      setTimeout(() => done(!!this.ps), 15000);
    }).then((ok) => { if (ok) this.setVolume(volume); return ok; });
  }
  send(line) { if (this.ps && this.ps.stdin.writable) this.ps.stdin.write(line + '\r\n'); }
  level(pct) { return Math.max(0, Math.min(0xffff, Math.round((Math.max(0, Math.min(100, pct)) / 100) * 0xffff))); }
  setVolume(pct) {
    const v = this.level(pct);
    this.send(`VOL ${(v * 0x10000 + v) >>> 0}`);
  }
  fade(ms, pct) { this.send(`FADE ${Math.round(ms)} ${this.level(pct)}`); }
  play(file) { this.send('PLAY ' + Buffer.from(file, 'utf8').toString('base64')); }
  stop() { this.send('STOP'); }
  close() { try { this.ps && this.ps.kill(); } catch (e) {} }
}

class CommandPlayer { // Linux/macOS dev builds: aplay / afplay if present
  constructor(cmd, log) { this.cmd = cmd; this.log = log; }
  async start() { return true; }
  play(file) { this.stop(); this.proc = spawn(this.cmd, [file], { stdio: 'ignore' }); this.proc.on('error', () => {}); }
  stop() { try { this.proc && this.proc.kill(); } catch (e) {} this.proc = null; }
  setVolume() {}
  close() { this.stop(); }
}

class NullPlayer { async start() { return true; } play() {} stop() {} setVolume() {} close() {} }

// Wraps a device player; tracks timing; optionally records a mix of the session.
class Player {
  constructor({ log, recordFile, silent }) {
    this.log = log;
    this.recordFile = recordFile;
    this.clips = [];
    this.t0 = Date.now();
    if (silent) this.dev = new NullPlayer();
    else if (process.platform === 'win32') this.dev = new WindowsPlayer(log);
    else {
      const cmd = process.platform === 'darwin' ? 'afplay' : 'aplay';
      const has = spawnSync('which', [cmd]).status === 0;
      this.dev = has ? new CommandPlayer(cmd, log) : new NullPlayer();
    }
    this.current = null;
  }
  async start(volume) {
    this.volume = volume;
    const ok = await this.dev.start(volume);
    if (!ok) { this.log('Could not start audio playback. Lines will be logged only.'); this.dev = new NullPlayer(); }
    return ok;
  }
  setVolume(v) { this.volume = v; this.dev.setVolume(v); }

  // resolves when the clip has finished (or was stopped). Waits for a fade-out to finish first.
  play(clip) {
    this.stop();
    const wait = Math.max(0, (this.fadeUntil || 0) - Date.now());
    if (!wait) return this.begin(clip);
    const token = (this.pending = {});
    return new Promise((r) => setTimeout(r, wait)).then(() => (this.pending === token ? this.begin(clip) : false));
  }
  begin(clip) {
    this.pending = null;
    const gain = clip.gain || 1;
    if (gain !== this.lastGain) { this.dev.setVolume(this.volume * gain); this.lastGain = gain; }
    this.dev.play(clip.file);
    const rec = { file: clip.file, at: Date.now() - this.t0, ms: clip.ms, gain };
    this.clips.push(rec);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.current = null; resolve(true); }, clip.ms + 40);
      this.current = { rec, timer, resolve };
    });
  }
  stop() {
    this.pending = null;
    if (!this.current) return;
    const c = this.current; this.current = null;
    clearTimeout(c.timer);
    c.rec.ms = Math.min(c.rec.ms, Date.now() - this.t0 - c.rec.at);
    this.dev.stop();
    c.resolve(false);
  }
  // fade the playing line out over ms, then stop it; the next play() starts after the fade
  fadeOut(ms) {
    this.pending = null;
    if (!this.current) return;
    const c = this.current; this.current = null;
    clearTimeout(c.timer);
    const played = Date.now() - this.t0 - c.rec.at;
    if (played + ms < c.rec.ms) { c.rec.ms = played + ms; c.rec.fade = ms; }
    if (this.dev.fade) {
      this.dev.fade(ms, this.volume * (this.lastGain || 1));
      this.lastGain = undefined; // the fade leaves the volume at zero: set it again for the next line
      this.fadeUntil = Date.now() + ms + 30;
    } else this.dev.stop();
    c.resolve(false);
  }
  get playing() { return !!this.current; }

  close() {
    this.stop();
    this.dev.close();
    if (this.recordFile && this.clips.length) this.writeRecording();
  }
  writeRecording() {
    const sr = 24000;
    const end = Math.max(...this.clips.map((c) => c.at + c.ms)) + 500;
    const mix = new Float32Array(Math.ceil((end / 1000) * sr));
    for (const c of this.clips) {
      const buf = fs.readFileSync(c.file);
      const n = Math.min((buf.length - 44) / 2, Math.round((c.ms / 1000) * sr));
      const off = Math.round((c.at / 1000) * sr);
      const g = c.gain || 1;
      const fadeN = c.fade ? Math.round((c.fade / 1000) * sr) : 0;
      for (let i = 0; i < n && off + i < mix.length; i++) {
        const f = fadeN && i > n - fadeN ? (n - i) / fadeN : 1;
        mix[off + i] += (buf.readInt16LE(44 + i * 2) / 32768) * g * f;
      }
    }
    const { wavBuffer } = require('./tts');
    fs.writeFileSync(this.recordFile, wavBuffer(mix, sr));
    this.log(`Recording saved: ${this.recordFile}`);
  }
}

module.exports = { Player };
