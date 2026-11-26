'use strict';
// Plays rendered WAV lines. On Windows a single hidden PowerShell process keeps one audio
// stream open for the whole session (so Bluetooth and TV audio stay awake and no line loses
// its first word), mixing each line into it. A line can be faded out (a goal cutting in),
// then the next line starts. "--record file.wav" also writes everything said to one WAV file.

const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

// The audio engine (compiled once at start by PowerShell's Add-Type): one output stream that
// stays open while the casters run, so Bluetooth headphones and TV/monitor audio never fall
// asleep between lines and swallow the first word of the next one.
const CS_SOURCE = String.raw`using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace Casters {
  // One output stream that stays open while the casters run. Between lines it plays an
  // inaudible hiss (+-1 sample, about -90 dB) so Bluetooth headphones and HDMI/TV audio never
  // go to sleep: a sleeping device swallows the start of the next line.
  public static class Audio {
    const int RATE = 24000, BUF = 480, NBUF = 6; // 20 ms buffers, 120 ms queued
    [StructLayout(LayoutKind.Sequential)]
    struct Fmt { public ushort tag, ch; public uint rate, bps; public ushort align, bits, extra; }
    [StructLayout(LayoutKind.Sequential)]
    struct Hdr { public IntPtr data; public uint len, rec; public IntPtr user; public uint flags, loops; public IntPtr next, res; }
    [DllImport("winmm.dll")] static extern int waveOutOpen(out IntPtr h, uint dev, ref Fmt f, IntPtr cb, IntPtr inst, uint flags);
    [DllImport("winmm.dll")] static extern int waveOutPrepareHeader(IntPtr h, IntPtr hdr, int size);
    [DllImport("winmm.dll")] static extern int waveOutUnprepareHeader(IntPtr h, IntPtr hdr, int size);
    [DllImport("winmm.dll")] static extern int waveOutWrite(IntPtr h, IntPtr hdr, int size);
    [DllImport("winmm.dll")] static extern int waveOutReset(IntPtr h);
    [DllImport("winmm.dll")] static extern int waveOutClose(IntPtr h);

    static readonly object lk = new object();
    static short[] clip; static int pos; static float vol = 1f; static int fadeLeft, fadeLen;
    static uint seed = 22222;
    static IntPtr dev = IntPtr.Zero;
    static readonly IntPtr[] hdrs = new IntPtr[NBUF];
    static int nextBuf;
    static readonly AutoResetEvent ev = new AutoResetEvent(false);
    static readonly int hsize = Marshal.SizeOf(typeof(Hdr));
    static readonly int flagsAt = (int)Marshal.OffsetOf(typeof(Hdr), "flags");
    static readonly short[] tmp = new short[BUF];
    public static string Error = "";

    public static bool Start() {
      if (!Open()) { Close(); return false; }
      Thread t = new Thread(Run);
      t.IsBackground = true;
      t.Priority = ThreadPriority.AboveNormal;
      t.Start();
      return true;
    }
    public static void Play(string file) {
      short[] x = Load(file);
      lock (lk) { clip = x.Length > 0 ? x : null; pos = 0; fadeLen = 0; }
    }
    public static void Stop() { lock (lk) { clip = null; fadeLen = 0; } }
    public static void Fade(int ms) {
      lock (lk) { if (clip != null && fadeLen == 0) { fadeLen = fadeLeft = Math.Max(1, ms * RATE / 1000); } }
    }
    public static void Volume(uint v) { lock (lk) { vol = (v & 0xFFFF) / 65535f; } }
    public static bool Busy { get { lock (lk) { return clip != null; } } }

    static bool Open() {
      Fmt f = new Fmt();
      f.tag = 1; f.ch = 1; f.rate = RATE; f.bps = RATE * 2; f.align = 2; f.bits = 16; f.extra = 0;
      IntPtr h;
      int r = waveOutOpen(out h, 0xFFFFFFFF, ref f, ev.SafeWaitHandle.DangerousGetHandle(), IntPtr.Zero, 0x50000);
      if (r != 0) { Error = "waveOutOpen error " + r; return false; }
      dev = h;
      nextBuf = 0;
      for (int i = 0; i < NBUF; i++) {
        if (hdrs[i] == IntPtr.Zero) {
          Hdr w = new Hdr();
          w.data = Marshal.AllocHGlobal(BUF * 2); w.len = BUF * 2;
          hdrs[i] = Marshal.AllocHGlobal(hsize);
          Marshal.StructureToPtr(w, hdrs[i], false);
        }
        Marshal.WriteInt32(hdrs[i], flagsAt, 0);
        r = waveOutPrepareHeader(dev, hdrs[i], hsize);
        if (r != 0) { Error = "waveOutPrepareHeader error " + r; return false; }
      }
      for (int i = 0; i < NBUF; i++) if (!Queue(i)) return false;
      return true;
    }

    static bool Queue(int i) {
      Fill(tmp);
      Marshal.Copy(tmp, 0, Marshal.ReadIntPtr(hdrs[i]), BUF);
      int fl = Marshal.ReadInt32(hdrs[i], flagsAt);
      Marshal.WriteInt32(hdrs[i], flagsAt, fl & ~1); // clear WHDR_DONE
      int r = waveOutWrite(dev, hdrs[i], hsize);
      if (r != 0) { Error = "waveOutWrite error " + r; return false; }
      return true;
    }

    static void Close() {
      lock (lk) { clip = null; fadeLen = 0; } // a line meant for a device that went away is dropped, not played late
      if (dev == IntPtr.Zero) return;
      waveOutReset(dev);
      for (int i = 0; i < NBUF; i++) if (hdrs[i] != IntPtr.Zero) waveOutUnprepareHeader(dev, hdrs[i], hsize);
      waveOutClose(dev);
      dev = IntPtr.Zero;
    }

    static void Run() {
      while (true) {
        try {
          if (dev == IntPtr.Zero) {
            // the device went away (headphones off, output changed): try again every second
            Thread.Sleep(1000);
            if (!Open()) { Close(); }
            continue;
          }
          ev.WaitOne(40);
          // refill finished buffers in the order they were queued
          for (int n = 0; n < NBUF; n++) {
            if ((Marshal.ReadInt32(hdrs[nextBuf], flagsAt) & 1) == 0) break;
            if (!Queue(nextBuf)) { Close(); break; }
            nextBuf = (nextBuf + 1) % NBUF;
          }
        } catch (Exception e) { Error = e.Message; Close(); }
      }
    }

    internal static void Fill(short[] b) {
      lock (lk) {
        for (int i = 0; i < b.Length; i++) {
          int s = 0;
          if (clip != null) {
            float g = vol;
            if (fadeLen > 0) {
              g *= (float)fadeLeft / fadeLen;
              if (--fadeLeft <= 0) { clip = null; fadeLen = 0; }
            }
            if (clip != null) {
              s = (int)(clip[pos] * g);
              if (++pos >= clip.Length) clip = null;
            }
          }
          seed = seed * 1664525u + 1013904223u;
          s += (int)(seed >> 31) * 2 - 1;
          b[i] = (short)(s > 32767 ? 32767 : (s < -32768 ? -32768 : s));
        }
      }
    }

    // 16-bit PCM WAV, any rate or channel count, to 24 kHz mono
    internal static short[] Load(string file) {
      byte[] d = File.ReadAllBytes(file);
      if (d.Length < 12 || System.Text.Encoding.ASCII.GetString(d, 0, 4) != "RIFF") throw new Exception("not a WAV file: " + file);
      int ch = 1, rate = RATE, bits = 16, at = 12, dataAt = -1, dataLen = 0;
      while (at + 8 <= d.Length) {
        string id = System.Text.Encoding.ASCII.GetString(d, at, 4);
        int len = BitConverter.ToInt32(d, at + 4);
        if (id == "fmt ") { ch = BitConverter.ToInt16(d, at + 10); rate = BitConverter.ToInt32(d, at + 12); bits = BitConverter.ToInt16(d, at + 22); }
        else if (id == "data") { dataAt = at + 8; dataLen = (len <= 0 || len > d.Length - dataAt) ? d.Length - dataAt : len; break; }
        if (len < 0) break;
        at += 8 + len + (len & 1);
      }
      if (dataAt < 0 || bits != 16 || ch < 1 || rate < 1000) throw new Exception("unsupported WAV: " + file);
      int n = dataLen / 2 / ch;
      float[] mono = new float[n];
      for (int i = 0; i < n; i++) {
        int sum = 0;
        for (int c = 0; c < ch; c++) sum += BitConverter.ToInt16(d, dataAt + (i * ch + c) * 2);
        mono[i] = sum / (float)ch;
      }
      if (rate == RATE) { short[] o = new short[n]; for (int i = 0; i < n; i++) o[i] = (short)mono[i]; return o; }
      int m = (int)((long)n * RATE / rate);
      short[] r = new short[m];
      for (int i = 0; i < m; i++) {
        double p = (double)i * rate / RATE; int k = (int)p; double fr = p - k;
        float a = mono[Math.Min(k, n - 1)], b = mono[Math.Min(k + 1, n - 1)];
        r[i] = (short)(a + (b - a) * fr);
      }
      return r;
    }
  }
}`;

// Reads the C# above from stdin (up to a "#END-CS" line), then plays what Node sends:
// PLAY <base64 path> | STOP | FADE <ms> <vol> | VOL <packed vol>. If the stream can't start
// (or config.json says audio: basic) it falls back to the old one-SoundPlayer-per-line path.
const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$src = New-Object System.Text.StringBuilder
while ($true) { $l = [Console]::In.ReadLine(); if ($l -eq $null -or $l -eq '#END-CS') { break }; [void]$src.AppendLine($l) }
$stream = $false; $why = 'audio is set to basic in config.json'
if ($src.Length -gt 0) {
  try {
    Add-Type -TypeDefinition $src.ToString() -Language CSharp -ErrorAction Stop
    $stream = [Casters.Audio]::Start()
    if (-not $stream) { $why = [Casters.Audio]::Error }
  } catch { $why = $_.Exception.Message }
}
if (-not $stream) {
  try { Add-Type -Name WinMM -Namespace Casters -MemberDefinition '[DllImport("winmm.dll")] public static extern int waveOutSetVolume(System.IntPtr h, uint v);' } catch {}
  $p = New-Object System.Media.SoundPlayer
}
if ($stream) { [Console]::Out.WriteLine('READY stream') } else { [Console]::Out.WriteLine('READY basic ' + ($why -replace '[\r\n]+', ' ')) }
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    if ($line -eq 'STOP') {
      if ($stream) { [Casters.Audio]::Stop() } else { $p.Stop() }
    } elseif ($line.StartsWith('FADE ')) {
      # FADE <ms> <volume 0-65535>: fade the line out, then stop
      $a = $line.Substring(5).Split(' '); $ms = [int]$a[0]
      if ($stream) { [Casters.Audio]::Fade($ms) } else {
        $v = [double]$a[1]; $n = 10
        for ($i = $n - 1; $i -ge 0; $i--) {
          $c = [double][math]::Round($v * $i / $n)
          [void][Casters.WinMM]::waveOutSetVolume([IntPtr]::Zero, [uint32]($c * 65536 + $c))
          Start-Sleep -Milliseconds ([int]($ms / $n))
        }
        $p.Stop()
      }
    } elseif ($line.StartsWith('VOL ')) {
      if ($stream) { [Casters.Audio]::Volume([uint32]$line.Substring(4)) } else { [void][Casters.WinMM]::waveOutSetVolume([IntPtr]::Zero, [uint32]$line.Substring(4)) }
    } elseif ($line.StartsWith('PLAY ')) {
      $f = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring(5)))
      if ($stream) { [Casters.Audio]::Play($f) } else { $p.SoundLocation = $f; $p.Load(); $p.Play() }
    }
  } catch { [Console]::Out.WriteLine('ERR ' + $_.Exception.Message); [Console]::Out.Flush() }
}
`;

class WindowsPlayer {
  constructor(log, basic) { this.log = log; this.basic = !!basic; this.latencyMs = 0; }
  start(volume) {
    return new Promise((resolve) => {
      const enc = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
      this.ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
        { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      let ok = false, pending = '';
      const done = (v) => { if (!ok) { ok = true; resolve(v); } };
      this.ps.stdout.setEncoding('utf8');
      this.ps.stdout.on('data', (d) => {
        pending += d;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const l of lines) {
          if (l.startsWith('READY')) {
            this.mode = l.startsWith('READY stream') ? 'stream' : 'basic';
            // the stream keeps about 120 ms queued: a line ends that much after it was sent
            this.latencyMs = this.mode === 'stream' ? 120 : 0;
            if (this.mode === 'basic' && !this.basic) this.log(`Audio: using the basic player (${l.slice(12).trim() || 'the audio stream could not start'}). The first word of a line can get cut on Bluetooth headphones.`);
            done(true);
          } else if (l.startsWith('ERR ')) this.log(`Audio: ${l.slice(4)}`);
        }
      });
      this.ps.on('error', (e) => { this.log(`Audio player could not start: ${e.message}`); done(false); });
      this.ps.on('exit', () => { this.ps = null; done(false); });
      this.ps.stdin.on('error', () => {});
      this.ps.stdin.write((this.basic ? '' : CS_SOURCE.replace(/\r?\n/g, '\r\n') + '\r\n') + '#END-CS\r\n');
      setTimeout(() => done(!!this.ps), 20000);
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
  constructor({ log, recordFile, silent, basicAudio }) {
    this.log = log;
    this.recordFile = recordFile;
    this.clips = [];
    this.t0 = Date.now();
    if (silent) this.dev = new NullPlayer();
    else if (process.platform === 'win32') this.dev = new WindowsPlayer(log, basicAudio);
    else {
      const cmd = process.platform === 'darwin' ? 'afplay' : 'aplay';
      const has = spawnSync('which', [cmd]).status === 0;
      this.dev = has ? new CommandPlayer(cmd, log) : new NullPlayer();
    }
    this.current = null;
  }

  // how long after play() a line is heard (the steady stream keeps a little queued)
  get latencyMs() { return (this.dev && this.dev.latencyMs) || 0; }

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
      const timer = setTimeout(() => { this.current = null; resolve(true); }, clip.ms + 40 + (this.dev.latencyMs || 0));
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
