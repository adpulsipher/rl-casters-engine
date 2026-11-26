#!/usr/bin/env python3
"""RL Career Casters - cloud studio.

Records a whole voice pack on a rented GPU with Fish Audio Drama 3: every commentary
line, for every player and team you list, in your cloned voices, checked by speech
recognition and re-taken when a line comes out garbled. The result is the same
voice pack zip the Colab notebook makes, so the casters import it the same way.

Commands (run them in this folder, with the venv from setup.sh active):
  python studio_cloud.py count          how many lines, and a time / cost estimate (no GPU needed)
  python studio_cloud.py preview        start Drama 3 and record 6 sample lines to listen to
  python studio_cloud.py preview --names   say every player and team name once, to check them
  python studio_cloud.py record         record the whole pack (picks up where it stopped), then build the zip
  python studio_cloud.py record --limit 100   record only the next 100 lines (a speed test)
  python studio_cloud.py review         build a review page to pick the better of two takes
  python studio_cloud.py apply choices.json   use the takes you picked (and mark redos)
  python studio_cloud.py export         build the zip from what is recorded so far
  python studio_cloud.py dryrun         test everything with a fake voice (no GPU, no model)

Settings live in settings.json next to this file.
"""

import argparse
import http.server
import io
import json
import math
import os
import random
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import base64
import zipfile
from concurrent.futures import ThreadPoolExecutor, Future, wait, FIRST_COMPLETED
from datetime import datetime, timezone

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PACK_TYPE = 'rl-career-casters-voicepack'
MOODS = ('hype', 'lively', 'calm')
ROLES = ('pbp', 'color')
CLIP_NAMES = {('pbp', m): f'pbp-{m}' for m in MOODS} | {('color', m): f'analyst-{m}' for m in MOODS}
MODEL = 'fishaudio/drama-3'
PACK_SR = 24000            # recordings are saved at 24 kHz: plenty for speech, and half the disk space in the casters
THRESHOLD = 0.8            # share of a line's words the checker must hear
MAX_TAKES = 3

# Speed measured by the vLLM recipe on one H100 80 GB: real-time factor at each concurrency.
# Used only for the estimate in `count`; `record` prints the real speed as it goes.
BENCH_RTF = {1: 0.28, 4: 0.40, 8: 0.51}

CAT_LABELS = {'intro': 'Match intro', 'intro_blue': 'Intro: blue team', 'intro_orange': 'Intro: orange team', 'intro_color': 'Analyst preview', 'intro_star': 'Analyst: player to watch', 'kickoff': 'Kickoff', 'kickoff_lead': 'Kickoff: team in front', 'kickoff_tie': 'Kickoff: tied', 'goal': 'Goal', 'goal_generic': 'Goal', 'goal_ot': 'Overtime winner', 'goal_ot_generic': 'Overtime winner', 'score_first': 'First goal of the match', 'score_take_lead': 'Takes the lead', 'score_extend': 'Extends the lead', 'score_equalize': 'Equalizer', 'score_pull_back': 'Pulls one back', 'score_late_lead': 'Late go-ahead goal', 'score_late_tie': 'Late equalizer', 'score_now': 'The score', 'score_tie': 'Tied score', 'an_aerial': 'Replay: aerial goal', 'an_bicycle': 'Replay: bicycle goal', 'an_long': 'Replay: long-range goal', 'an_backwards': 'Replay: backwards goal', 'an_turtle': 'Replay: turtle goal', 'an_hattrick': 'Replay: hat trick', 'an_speed': 'Replay: shot speed', 'an_assist': 'Replay: the assist', 'an_named': 'Replay: the scorer', 'an_generic': 'Replay: general', 'save': 'Save', 'save_generic': 'Save', 'save_again': 'Another save', 'epicsave': 'Epic save', 'epicsave_generic': 'Epic save', 'demo': 'Demo', 'demo_victim': 'Demo (victim)', 'demo_generic': 'Demo', 'crossbar': 'Crossbar', 'crossbar_generic': 'Crossbar', 'bighit_clear': 'Big clear', 'bighit_attack': 'Big hit on attack', 'aerial': 'High touch in attack', 'shot': 'Shot', 't60_tie': 'One minute: tied', 't60_nil': 'One minute: no goals', 't60_close': 'One minute: one-goal lead', 't60_big': 'One minute: big lead', 't30_tie': 'Thirty seconds: tied', 't30_close': 'Thirty seconds: one-goal lead', 't10_tie': 'Ten seconds: tied', 't10_close': 'Ten seconds: trailing team', 'ot': 'Overtime starts', 'ot_color': 'Analyst: overtime', 'end': 'Match over', 'end_close': 'Match over: close', 'end_blowout': 'Match over: blowout', 'end_ot': 'Match over: overtime', 'end_score': 'Final score', 'end_mvp': 'Player of the match', 'end_winner': 'Analyst: the winners', 'end_loser': 'Analyst: the losers', 'signoff': 'Sign-off', 'filler_color': 'Analyst filler', 'filler_pbp': 'Play-by-play filler', 'filler_ot': 'Overtime filler', 'filler_pressure': 'Filler: team pressing', 'filler_saves': 'Filler: lots of saves', 'filler_goals': 'Filler: multiple goals', 'filler_demos': 'Filler: lots of demos', 'filler_shots': 'Filler: shot count', 'filler_trailing': 'Filler: trailing late', 'filler_leading': 'Filler: leading late', 'goal_rout': 'Goal in a blowout', 'goal_rout_generic': 'Goal in a blowout', 'score_rout': 'Blowout: piling on', 'goal_consolation': 'Consolation goal', 'goal_consolation_generic': 'Consolation goal', 'score_consolation': 'Consolation: too late', 'intro_game': 'Series: game number', 'series_lead': 'Series: who leads', 'series_score': 'Series: the score', 'series_level': 'Series: tied score', 'series_tied': 'Series: tied'}

# which lines get two takes for you to choose between (by the kind of fill-in they have)
TWO_TAKES = {
    'none': set(),
    'general': {None},                                        # lines with no name, team or number in them
    'general+teams': {None, 'team'},
    'no-names': {None, 'team', 'score', 'a', 'speed'},        # everything except lines with a player's name
}


def log(*a):
    print(*a, flush=True)


# ===================================================================== settings
def clean_list(v):
    """Names from a list, or a text with one per line / comma separated."""
    if isinstance(v, list):
        parts = v
    else:
        keep = [ln for ln in (v or '').splitlines() if not ln.strip().startswith('#')]
        parts = re.split(r'[\n,]+', '\n'.join(keep))
    out, seen = [], set()
    for p in parts:
        n = str(p).strip()
        if n and n.lower() not in seen:
            seen.add(n.lower())
            out.append(n)
    return out


def split_say(items):
    """'Rw9 = R W nine' -> written 'Rw9' (what the casters match on) and how to say it.
    Lines starting with # are notes and are skipped."""
    written, say = [], {}
    for it in items:
        if it.startswith('#'):
            continue
        w, _, sp = it.partition('=')
        w, sp = w.strip(), sp.strip()
        if not w or w.lower() in {x.lower() for x in written}:
            continue
        written.append(w)
        if sp and sp != w:
            say[w] = sp
    return written, say


def load_settings(path):
    with open(path, encoding='utf-8') as f:
        s = json.load(f)
    players = clean_list(s.get('players'))
    if s.get('players_file'):
        with open(os.path.join(HERE, s['players_file']), encoding='utf-8') as f:
            players = clean_list(players + clean_list(f.read()))
    teams = clean_list(s.get('teams'))
    if s.get('teams_file'):
        with open(os.path.join(HERE, s['teams_file']), encoding='utf-8') as f:
            teams = clean_list(teams + clean_list(f.read()))
    s['players'], say_p = split_say(players)
    s['teams'], say_t = split_say(teams)
    s['say'] = {**say_t, **say_p}
    s.setdefault('pack_name', 'My casters')
    s.setdefault('lines_per_player', 5)
    s.setdefault('concurrency', 8)
    s.setdefault('output_dir', '/workspace/studio-output' if os.path.isdir('/workspace') else os.path.join(HERE, 'output'))
    s.setdefault('server_args', [])
    s.setdefault('port', 8000)
    s.setdefault('two_takes_for', 'general')
    s.setdefault('one_voice', False)
    if s['two_takes_for'] not in TWO_TAKES:
        raise SystemExit(f'settings.json: two_takes_for must be one of: ' + ', '.join(TWO_TAKES))
    return s


def out_dir(s):
    d = os.path.join(s['output_dir'], re.sub(r'[\\/:*?"<>|]+', '_', s['pack_name']))
    os.makedirs(d, exist_ok=True)
    return d


# ==================================================================== line bank
def tidy(t):
    """Capital letter at the start of each sentence (same rule as the casters)."""
    return re.sub(r'(^|[.!?]\s+)([a-z])', lambda m: m.group(1) + m.group(2).upper(), t)


def norm(t):
    return re.sub(r'[^a-z0-9]+', ' ', str(t).lower()).strip()


def key_of(role, mood, text):
    return f'{role}|{mood}|{norm(text)}'


def per_player_counts(setting):
    """lines_per_player: a number (at most that many versions of each call per player) or 'all'."""
    if str(setting).lower() == 'all':
        return {'*': 10 ** 6}
    return {'*': max(1, int(setting))}


def expand(spec, players, teams, per_player, seed=7, say=None):
    """Every line the pack should contain: [{cat, role, mood, text, say?}].
    text is what the casters match on; say (when a name has a spoken form) is what gets recorded."""
    say = say or {}
    teams = list(dict.fromkeys(['Blue', 'Orange'] + list(teams)))
    lines, seen = [], set()
    for cat, c in spec['categories'].items():
        f = c['fill']
        if f is None:
            values = [None]
        elif f == 'team':
            values = teams
        elif f == 'name':
            values = list(players)
        else:
            values = spec['domains'].get(f, [])
        for v in values:
            tpls = c['templates']
            if f == 'name':
                k = per_player.get(cat, per_player.get('*', 1))
                tpls = random.Random(f'{seed}|{cat}|{v}').sample(tpls, min(k, len(tpls)))
            for tpl in tpls:
                text = tidy(tpl.replace('{' + f + '}', v) if f else tpl)
                k2 = key_of(c['role'], c['mood'], text)
                if k2 in seen:
                    continue
                seen.add(k2)
                line = {'cat': cat, 'role': c['role'], 'mood': c['mood'], 'text': text}
                if f in ('name', 'team') and v in say:
                    line['say'] = tidy(tpl.replace('{' + f + '}', say[v]))
                lines.append(line)
    return lines


# ===================================================================== checking
ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split()
TENS = ' ten twenty thirty forty fifty sixty seventy eighty ninety'.split(' ')


def num_words(n):
    n = int(n)
    if n < 20:
        return ONES[n]
    if n < 100:
        return TENS[n // 10] + (' ' + ONES[n % 10] if n % 10 else '')
    if n < 1000:
        return ONES[n // 100] + ' hundred' + (' and ' + num_words(n % 100) if n % 100 else '')
    return str(n)


def words(s):
    s = re.sub(r'\d+', lambda m: ' ' + num_words(m.group(0)) + ' ', str(s))
    s = s.lower().replace('-', ' ')
    return [w for w in re.sub(r"[^a-z' ]", ' ', s).split() if len(w) > 1]


def vocabulary(spec):
    v = set()
    for c in spec['categories'].values():
        for t in c['templates']:
            v.update(words(re.sub(r'\{\w+\}', ' ', t)))
    for d in spec['domains'].values():
        for t in d:
            v.update(words(t))
    return v


def line_score(text, heard, vocab):
    """Share of the line's ordinary words that were actually heard (names left out)."""
    expect = [w for w in words(text) if w in vocab]
    if len(expect) < 2:
        return 1.0
    got = set(words(heard))
    return sum(1 for w in expect if w in got) / len(expect)


def length_ok(text, samples, sr):
    secs = len(samples) / sr
    n = max(1, len(words(text)))
    return 0.12 * n < secs < 1.5 + 0.75 * n


def expected_secs(text):
    return 0.5 + len(words(text)) / 2.6


def trim(x, sr, thr=0.01):
    """Cut silence off both ends (also catches a take that keeps emitting silence)."""
    idx = np.where(np.abs(x) > thr)[0]
    if not idx.size:
        return x[:0]
    return x[max(0, idx[0] - int(0.1 * sr)): idx[-1] + int(0.2 * sr)]


def resample(x, sr, target):
    if sr == target:
        return x
    try:
        from scipy.signal import resample_poly
        g = math.gcd(sr, target)
        return resample_poly(x, target // g, sr // g).astype(np.float32)
    except ImportError:
        n = int(round(len(x) * target / sr))
        return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


class Checker:
    """Speech recognition that scores each take. One background thread batches requests,
    so the recording threads never fight over the GPU model."""

    def __init__(self, vocab, fake=False):
        self.vocab = vocab
        self.fake = fake
        self.q = []
        self.cv = threading.Condition()
        self.stop = False
        self.kind = 'fake' if fake else None
        if not fake:
            self._load()
        self.t = threading.Thread(target=self._run, daemon=True)
        self.t.start()

    def _load(self):
        try:
            import torch
            from transformers import pipeline
            if not torch.cuda.is_available():
                raise RuntimeError('no CUDA')
            self.asr = pipeline('automatic-speech-recognition', model='openai/whisper-small.en', torch_dtype=torch.float16, device=0)
            self.asr([np.zeros(16000, dtype=np.float32)])
            self.kind = 'whisper-small.en (GPU)'
            return
        except Exception as e:
            log(f'  Line checker could not use the GPU ({str(e).splitlines()[0][:120]}). Trying the CPU checker.')
        try:
            from faster_whisper import WhisperModel
            self.fw = WhisperModel('base.en', device='cpu', compute_type='int8', cpu_threads=max(2, (os.cpu_count() or 4) // 2))
            self.kind = 'whisper-base.en (CPU)'
            return
        except Exception as e:
            log(f'  No line checker available ({str(e).splitlines()[0][:120]}). Every take will be kept as is.')
            self.kind = 'none'

    def score(self, text, samples, sr):
        fut = Future()
        with self.cv:
            self.q.append((text, samples, sr, fut))
            self.cv.notify()
        return fut.result()

    def _heard(self, batch):
        if self.kind == 'fake':
            return [text if random.random() > 0.15 else 'mumble' for text, _, _, _ in batch]
        if self.kind == 'none':
            return [text for text, _, _, _ in batch]
        audio = [resample(s, sr, 16000) for _, s, sr, _ in batch]
        if self.kind.startswith('whisper-small'):
            out = self.asr([{'raw': a, 'sampling_rate': 16000} for a in audio], batch_size=len(audio))
            return [o['text'] for o in out]
        res = []
        for a in audio:
            segs, _ = self.fw.transcribe(a, language='en', beam_size=1, vad_filter=False)
            res.append(' '.join(s.text for s in segs))
        return res

    def _run(self):
        while True:
            with self.cv:
                while not self.q and not self.stop:
                    self.cv.wait()
                if self.stop and not self.q:
                    return
                batch, self.q = self.q[:16], self.q[16:]
            try:
                heard = self._heard(batch)
                for (text, _, _, fut), h in zip(batch, heard):
                    fut.set_result(line_score(text, h, self.vocab))
            except Exception as e:
                for *_, fut in batch:
                    if not fut.done():
                        fut.set_result(1.0)
                log(f'  Checker error ({e}); kept those takes unchecked.')

    def close(self):
        with self.cv:
            self.stop = True
            self.cv.notify()


# ======================================================================= audio io
def ffmpeg_ok():
    return shutil.which('ffmpeg') is not None and shutil.which('ffprobe') is not None


def load_audio(path, sr, max_secs=15):
    """Any audio file -> mono float32 at sr, silence trimmed, at most max_secs long."""
    p = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', str(sr), 'pipe:1'], capture_output=True)
    if p.returncode != 0:
        raise RuntimeError(f'could not read {path}: ' + p.stderr.decode(errors='ignore')[-200:])
    x = np.frombuffer(p.stdout, dtype=np.float32).copy()
    x = trim(x, sr)
    return x[: int(max_secs * sr)]


def wav_bytes(x, sr):
    import wave
    x = np.clip(np.asarray(x, dtype=np.float32), -1, 1)
    b = io.BytesIO()
    with wave.open(b, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((x * 32767).astype('<i2').tobytes())
    return b.getvalue()


def read_wav(data):
    try:
        import soundfile as sf
        x, sr = sf.read(io.BytesIO(data), dtype='float32', always_2d=True)
        return x.mean(axis=1).astype(np.float32), sr
    except ImportError:
        import wave
        with wave.open(io.BytesIO(data)) as w:
            sr, n, ch, sw = w.getframerate(), w.getnframes(), w.getnchannels(), w.getsampwidth()
            raw = w.readframes(n)
        if sw != 2:
            raise RuntimeError('install soundfile to read this WAV format')
        x = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768
        return x.reshape(-1, ch).mean(axis=1), sr


def save_mp3(samples, sr, path):
    x = np.asarray(samples, dtype=np.float32)
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    if peak > 0.99:
        x = x * (0.99 / peak)
    p = subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'f32le', '-ar', str(sr), '-ac', '1', '-i', 'pipe:0',
                        '-ar', str(PACK_SR), '-codec:a', 'libmp3lame', '-b:a', '64k', path], input=x.tobytes(), capture_output=True)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.decode(errors='ignore')[-300:])


def clip_source_problem(path):
    """Clips ripped from soundboards or broadcasts carry tags that say so. Those are
    someone else's voice, so they can't be used."""
    p = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format_tags:stream_tags', '-of', 'default=nw=1', path],
                       capture_output=True, text=True)
    tags = p.stdout.lower()
    for word in ('soundboard', '101soundboards', 'myinstants', 'voicemod', 'youtube', 'twitch'):
        if word in tags:
            return word
    return None


def find_clip(clips_dir, base):
    for ext in ('.wav', '.mp3', '.m4a', '.flac', '.ogg', '.aac'):
        p = os.path.join(clips_dir, base + ext)
        if os.path.exists(p):
            return p
    return None


def clip_names(s):
    """Which clip file is the voice for each caster and mood. One voice: hype, lively, calm for both."""
    if s.get('one_voice'):
        return {(role, m): m for role in ROLES for m in MOODS}
    return CLIP_NAMES


def prepare_clips(s, ref_dir):
    """Load the reference clips (six, or three with one_voice; the analyst falls back to the
    play-by-play voice) and write clean 44.1 kHz WAV copies for the voice engine.
    Returns {(role, mood): (wav_path, text)}."""
    clips_dir = os.path.join(HERE, s.get('clips_dir', 'clips'))
    texts = s.get('clip_texts', {})
    os.makedirs(ref_dir, exist_ok=True)
    refs = {}
    names = clip_names(s)
    for (role, mood), base in names.items():
        if (role, mood) in refs:
            continue
        path = find_clip(clips_dir, base)
        if not path:
            continue
        bad = clip_source_problem(path)
        if bad:
            raise SystemExit(f'{os.path.basename(path)}: its tags say it came from {bad}. Only use recordings of people who agreed to be cloned.')
        text = (texts.get(base) or '').strip()
        if not text:
            raise SystemExit(f'settings.json: clip_texts is missing the words said in {base}.')
        x = load_audio(path, 44100)
        if len(x) / 44100 < 4:
            log(f'  {base} is only {len(x) / 44100:.1f} s long. 8 to 15 seconds clones much better.')
        out = os.path.join(ref_dir, base + '.wav')
        with open(out, 'wb') as f:
            f.write(wav_bytes(x, 44100))
        refs[(role, mood)] = (out, text)
    missing = sorted({names[('pbp', m)] for m in MOODS if ('pbp', m) not in refs})
    if missing:
        raise SystemExit(f'Missing play-by-play clips in {clips_dir}: ' + ', '.join(missing))
    for m in MOODS:
        if ('color', m) not in refs:
            log(f'  No analyst-{m} clip: the analyst uses the pbp-{m} voice.')
            refs[('color', m)] = refs[('pbp', m)]
    return refs


# ================================================================= voice engines
class RefServer:
    """Serves the reference WAVs on localhost so the voice server can fetch them by URL."""

    def __init__(self, directory):
        handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=directory, **k)
        http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
        self.httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def url(self, path):
        return f'http://127.0.0.1:{self.port}/{os.path.basename(path)}'

    def close(self):
        self.httpd.shutdown()


class DramaServer:
    """Starts `vllm serve fishaudio/drama-3 --omni` (or uses one that's already running)."""

    def __init__(self, s, workdir, url=None):
        self.proc = None
        self.url = (url or f"http://127.0.0.1:{s['port']}").rstrip('/')
        if url or self._up():
            log(f'Using the voice server at {self.url}.')
            return
        if not shutil.which('vllm'):
            raise SystemExit('vllm is not installed here. Run `bash setup.sh`, then `source /workspace/venv/bin/activate`.')
        self.log_path = os.path.join(workdir, 'server.log')
        cmd = ['vllm', 'serve', MODEL, '--omni', '--port', str(s['port'])] + list(s['server_args'])
        log('Starting Drama 3: ' + ' '.join(cmd))
        log('  The first start downloads the model (about 40 GB) and can take 10 to 20 minutes. Log: ' + self.log_path)
        self.logf = open(self.log_path, 'ab')
        env = dict(os.environ, VLLM_USE_FLASHINFER_SAMPLER='0')  # its sampler needs a CUDA compiler the pod doesn't have
        env['PATH'] = os.path.dirname(sys.executable) + os.pathsep + env.get('PATH', '')
        self.proc = subprocess.Popen(cmd, stdout=self.logf, stderr=subprocess.STDOUT, start_new_session=True, env=env)
        t0, last = time.time(), 0
        while not self._up():
            if self.proc.poll() is not None:
                raise SystemExit('The voice server stopped while starting. The end of its log:\n' + self.tail())
            if time.time() - t0 > 3600:
                self.close()
                raise SystemExit('The voice server did not start within an hour. The end of its log:\n' + self.tail())
            if time.time() - last > 60:
                last = time.time()
                log(f'  still starting ({(time.time() - t0) / 60:.0f} min)... ' + self.tail(1).strip()[-120:])
            time.sleep(5)
        log(f'Voice server ready after {(time.time() - t0) / 60:.1f} min.')

    def _up(self):
        try:
            with urllib.request.urlopen(self.url + '/v1/models', timeout=3) as r:
                return r.status == 200
        except Exception:
            return False

    def tail(self, n=25):
        try:
            with open(self.log_path, 'rb') as f:
                return b'\n'.join(f.read().splitlines()[-n:]).decode(errors='ignore')
        except Exception:
            return ''

    def close(self):
        if self.proc and self.proc.poll() is None:
            log('Stopping the voice server.')
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
                self.proc.wait(timeout=60)
            except Exception:
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except Exception:
                    pass


class DramaEngine:
    """Calls the OpenAI-style /v1/audio/speech endpoint with a cloned reference voice."""

    def __init__(self, server_url, refs, ref_server):
        import requests
        self.requests = requests
        self.session = requests.Session()
        self.url = server_url + '/v1/audio/speech'
        self.refs = refs
        self.ref_server = ref_server
        self.extras = True       # max_new_tokens; dropped if the server doesn't accept it
        self.ref_mode = 'url'    # 'url' (served on localhost) or 'data' (base64 in the request)
        self._b64 = {}

    def _ref(self, path):
        if self.ref_mode == 'url':
            return self.ref_server.url(path)
        if path not in self._b64:
            with open(path, 'rb') as f:
                self._b64[path] = 'data:audio/wav;base64,' + base64.b64encode(f.read()).decode()
        return self._b64[path]

    def _payload(self, text, role, mood):
        path, ref_text = self.refs[(role, mood)]
        p = {'model': MODEL, 'input': text, 'voice': 'default', 'ref_audio': self._ref(path), 'ref_text': ref_text, 'response_format': 'wav'}
        if self.extras:
            # the recipe: set max_new_tokens near the expected length (about 22 audio frames a second)
            p['max_new_tokens'] = int(min(900, 60 + expected_secs(text) * 2.2 * 22))
        return p

    def synth(self, text, role, mood):
        r = self.session.post(self.url, json=self._payload(text, role, mood), timeout=180)
        if r.status_code != 200:
            raise RuntimeError(f'HTTP {r.status_code}: {r.text[:300]}')
        return read_wav(r.content)

    def warm_up(self):
        """First requests compile kernels (~10 s). Also works out which request options this server takes."""
        text, role, mood = 'Testing, testing. What a goal that is!', 'pbp', 'lively'
        attempts = [(True, 'url'), (False, 'url'), (True, 'data'), (False, 'data')]
        last = None
        for extras, mode in attempts:
            self.extras, self.ref_mode = extras, mode
            try:
                x, sr = self.synth(text, role, mood)
                if len(x) < sr * 0.5:
                    raise RuntimeError('the test line came back almost empty')
                for _ in range(2):
                    self.synth(text, role, mood)
                log(f'  Voice engine OK (reference by {"URL" if mode == "url" else "upload"}{", length limit on" if extras else ""}).')
                return
            except Exception as e:
                last = e
        raise SystemExit(f'The voice server would not make a test line: {last}')


class FakeEngine:
    """Stand-in voice for `dryrun`: a tone as long as the line would be, sometimes broken."""

    def __init__(self):
        self.sr = 44100

    def warm_up(self):
        log('  Fake voice engine (dry run).')

    def synth(self, text, role, mood):
        time.sleep(0.01)
        secs = expected_secs(text) * random.uniform(0.8, 1.2)
        if random.random() < 0.05:
            secs = 0.05  # a broken take, to exercise re-takes
        t = np.arange(int(secs * self.sr)) / self.sr
        x = 0.3 * np.sin(2 * np.pi * (180 if role == 'pbp' else 230) * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 3 * t))
        pad = np.zeros(int(0.3 * self.sr))
        return np.concatenate([pad, x, pad]).astype(np.float32), self.sr


# ===================================================================== recording
def load_progress(d):
    f = os.path.join(d, 'progress.json')
    if os.path.exists(f):
        with open(f, encoding='utf-8') as fh:
            return json.load(fh)
    return {}


def save_progress(d, prog):
    f = os.path.join(d, 'progress.json')
    with open(f + '.tmp', 'w', encoding='utf-8') as fh:
        json.dump(prog, fh)
    os.replace(f + '.tmp', f)


def spoken(l):
    return l.get('say') or l['text']


def record_line(engine, checker, l):
    best, err = None, None
    said = spoken(l)
    for take in range(MAX_TAKES):
        try:
            x, sr = engine.synth(said, l['role'], l['mood'])
        except Exception as e:
            err = e
            time.sleep(2 * (take + 1))
            continue
        x = trim(x, sr)
        if len(x) < sr * 0.2:
            sc = 0.0
        else:
            sc = checker.score(said, x, sr)
            if not length_ok(said, x, sr):
                sc -= 0.5
        if best is None or sc > best[0]:
            best = (sc, x, sr)
        if sc >= THRESHOLD:
            break
    if best is None or len(best[1]) < best[2] * 0.2:
        raise RuntimeError(f'no usable take ({err})')
    return best


def record_all(lines, engine, checker, d, concurrency, limit=None, two_takes=lambda l: False):
    os.makedirs(os.path.join(d, 'lines'), exist_ok=True)
    prog = load_progress(d)
    def done_ok(l):
        v = prog.get(key_of(l['role'], l['mood'], l['text']))
        return bool(v) and os.path.exists(os.path.join(d, v['file'])) and (v.get('say') or v['text']) == spoken(l)
    todo = [l for l in lines if not done_ok(l)]
    resay = sum(1 for l in todo if key_of(l['role'], l['mood'], l['text']) in prog)
    log(f'{len(lines)} lines in the pack, {len(lines) - len(todo)} already recorded, {len(todo)} to go'
        + (f' ({resay} of them because a name is now said differently)' if resay else '') + '.')
    if limit:
        todo = todo[:limit]
        log(f'Recording the next {len(todo)} (--limit).')
    if not todo:
        return prog
    lock = threading.Lock()
    used = {v['file'] for v in prog.values()}
    counter = [len(prog)]
    done, failed, weak, audio_secs = [0], [0], [0], [0.0]
    t0 = time.time()
    last_print = [0.0]
    stop = threading.Event()

    def next_name():
        while True:
            name = f'lines/{counter[0]:05d}.mp3'
            counter[0] += 1
            if name not in used:
                used.add(name)
                return name

    def job(l):
        if stop.is_set():
            return
        takes = []
        try:
            for _ in range(2 if two_takes(l) else 1):
                takes.append(record_line(engine, checker, l))
        except Exception as e:
            with lock:
                failed[0] += 1
                if failed[0] <= 10:
                    log(f'  Could not record "{l["text"][:60]}": {e}')
            return
        with lock:
            names = [next_name() for _ in takes]
        for (sc, x, sr), name in zip(takes, names):
            save_mp3(x, sr, os.path.join(d, name))
        best = max(range(len(takes)), key=lambda i: takes[i][0])
        sc, x, sr = takes[best]
        with lock:
            entry = {'cat': l['cat'], 'role': l['role'], 'mood': l['mood'], 'text': l['text'], 'file': names[best], 'score': round(float(sc), 2)}
            if l.get('say'):
                entry['say'] = l['say']
            if len(takes) > 1:
                entry.update(takes=names, scores=[round(float(t[0]), 2) for t in takes], choice=None)
            prog[key_of(l['role'], l['mood'], l['text'])] = entry
            done[0] += 1
            audio_secs[0] += sum(len(t[1]) / t[2] for t in takes)
            if sc < THRESHOLD:
                weak[0] += 1
            if done[0] % 25 == 0:
                save_progress(d, prog)
            if time.time() - last_print[0] > 30:
                last_print[0] = time.time()
                el = time.time() - t0
                rate = done[0] / max(el, 1e-6)
                left = (len(todo) - done[0] - failed[0]) / max(rate, 1e-6)
                log(f'  {done[0]}/{len(todo)} recorded | {rate * 60:.0f} lines a minute | {audio_secs[0] / max(el, 1e-6):.1f} s of audio per second'
                    f' | about {left / 60:.0f} min left' + (f' | {weak[0]} unsure' if weak[0] else '') + (f' | {failed[0]} failed' if failed[0] else ''))

    def on_sigint(*_):
        if not stop.is_set():
            log('\nStopping after the lines in progress (Ctrl+C again to quit now). Progress is saved.')
            stop.set()
        else:
            save_progress(d, prog)
            os._exit(1)

    old = signal.signal(signal.SIGINT, on_sigint)
    try:
        with ThreadPoolExecutor(max_workers=concurrency) as ex:
            pending = set()
            it = iter(todo)
            for l in it:
                if stop.is_set():
                    break
                pending.add(ex.submit(job, l))
                if len(pending) >= concurrency * 3:
                    _, pending = wait(pending, return_when=FIRST_COMPLETED)
            wait(pending)
    finally:
        signal.signal(signal.SIGINT, old)
        save_progress(d, prog)
    el = time.time() - t0
    log(f'Recorded {done[0]} lines in {el / 60:.1f} min' + (f', {failed[0]} failed (run record again to retry them)' if failed[0] else '') + '.')
    return prog


def pack_keys(zip_path):
    """(key, spoken) of every line in an exported pack, to tell what an add-on still needs."""
    with zipfile.ZipFile(zip_path) as z:
        man = json.loads(z.read('manifest.json'))
    return {key_of(l['role'], l['mood'], l['text']) for l in man.get('lines', [])}


def export_pack(d, s, lines, addon=False):
    prog = load_progress(d)
    want = {key_of(l['role'], l['mood'], l['text']): spoken(l) for l in lines}
    entries = [v for k, v in prog.items() if k in want and os.path.exists(os.path.join(d, v['file']))
               and (v.get('say') or v['text']) == want[k]]
    name = s['pack_name']
    safe = re.sub(r'[\\/:*?"<>|]+', '_', name)
    full_zip = os.path.join(s['output_dir'], f'RL Career Casters Voice Pack - {safe}.zip')
    if addon:
        # only what the full pack doesn't have yet: a small zip to put next to it
        have = pack_keys(full_zip) if os.path.exists(full_zip) else (already_have(s) or set())
        if not have:
            raise SystemExit(f'No full pack to add to ({full_zip}), and no "already_in" list in settings.json.')
        entries = [e for e in entries if key_of(e['role'], e['mood'], e['text']) not in have]
        if not entries:
            log('Nothing new since the full pack: no add-on needed.')
            return None
    manifest = {
        'type': PACK_TYPE, 'version': 2, 'name': name, 'created': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'casters': {'pbp': 'Caster', 'color': 'Caster'} if s.get('one_voice') else {'pbp': 'Play-by-play', 'color': 'Analyst'},
        'oneVoice': bool(s.get('one_voice')), 'players': s['players'], 'teams': s['teams'],
        'studio': 'cloud', 'model': MODEL,
        'lines': [{'role': e['role'], 'mood': e['mood'], 'text': e['text'], 'file': e['file']} for e in entries],
    }
    if addon:
        manifest['addon'] = True
    stamp = datetime.now().strftime('%Y-%m-%d %H%M')
    zip_path = os.path.join(s['output_dir'], f'RL Career Casters Voice Pack - {safe} (add-on {stamp}).zip') if addon else full_zip
    with zipfile.ZipFile(zip_path + '.tmp', 'w') as z:
        z.writestr('manifest.json', json.dumps(manifest, indent=0), compress_type=zipfile.ZIP_DEFLATED)
        for e in entries:
            z.write(os.path.join(d, e['file']), e['file'], compress_type=zipfile.ZIP_STORED)
    os.replace(zip_path + '.tmp', zip_path)
    weak = sum(1 for e in entries if e['score'] < THRESHOLD)
    missing = 0 if addon else len(want) - len(entries)
    log(f'Voice {"pack add-on" if addon else "pack"}: {len(entries)} lines' + (f' ({weak} the checker was unsure about, kept anyway)' if weak else '')
        + (f', {missing} not recorded yet' if missing else '') + '.')
    log(f'  {zip_path}  ({os.path.getsize(zip_path) / 1e6:.0f} MB)')
    return zip_path


# ======================================================================= commands
def already_have(s):
    """Keys of the lines in the pack you already have, or None. settings.json "already_in": a pack
    zip, a JSON list of line keys, or a list of those (a full pack and its add-ons)."""
    f = s.get('already_in')
    if not f:
        return None
    have = set()
    for one in (f if isinstance(f, list) else [f]):
        path = one if os.path.isabs(one) else os.path.join(HERE, one)
        if path.lower().endswith('.zip'):
            have |= pack_keys(path)
        else:
            with open(path, encoding='utf-8') as fh:
                have |= set(json.load(fh))
    return have


def build_lines(s, skip_had=True):
    with open(os.path.join(HERE, 'spec.json'), encoding='utf-8') as f:
        spec = json.load(f)
    lines = expand(spec, s['players'], s['teams'], per_player_counts(s['lines_per_player']), say=s.get('say'))
    had = already_have(s) if skip_had else None
    if had:
        lines = [l for l in lines if key_of(l['role'], l['mood'], l['text']) not in had]
    return spec, lines


def estimate(lines, concurrency):
    audio = sum(expected_secs(spoken(l)) for l in lines) * 1.25  # about a quarter of lines need a re-take
    c = min(BENCH_RTF, key=lambda k: abs(k - concurrency))
    per_sec = c / BENCH_RTF[c]
    return audio, audio / per_sec


def require_consent(s):
    if not s.get('everyone_in_my_clips_agreed'):
        raise SystemExit('Set "everyone_in_my_clips_agreed": true in settings.json first. Only clone voices of people who said yes.')


def cmd_count(s, args):
    spec, lines = build_lines(s)
    by_cat = {}
    for l in lines:
        by_cat[l['cat']] = by_cat.get(l['cat'], 0) + 1
    log(f"{len(s['players'])} players, {len(s['teams'])} teams, up to {s['lines_per_player']} versions of each call per player")
    rule = two_takes_rule(spec, s)
    two = sum(1 for l in lines if rule(l))
    log(f'-> {len(lines)} lines to record' + (f', {two} of them with two takes to choose from ({2 * two} takes to review).' if two else '.'))
    audio, gen = estimate(lines, s['concurrency'])
    log(f'About {audio / 3600:.1f} hours of audio to generate (counting re-takes).')
    log(f"On one H100 at {s['concurrency']} lines at a time: roughly {gen / 3600:.1f} hours of recording,"
        f' plus about 30 minutes of setup and model download.')
    hrs = gen / 3600 + 0.5
    lo, hi = f'{2 * hrs:.0f}', f'{3 * hrs:.0f}'
    log(f'At $2 to $3 an hour that is about ${lo}.' if lo == hi else f'At $2 to $3 an hour that is about ${lo} to ${hi}.')
    if args.verbose:
        for k, v in sorted(by_cat.items(), key=lambda kv: -kv[1]):
            log(f'  {k:18s} {v}')


def start_engine(s, d, args, fake=False):
    ref_dir = os.path.join(d, 'reference')
    refs = prepare_clips(s, ref_dir)
    if fake:
        return FakeEngine(), None, None
    ref_server = RefServer(ref_dir)
    server = DramaServer(s, d, url=args.server_url)
    engine = DramaEngine(server.url, refs, ref_server)
    log('Warming up (the first lines compile the GPU kernels)...')
    engine.warm_up()
    return engine, server, ref_server


def safe_name(n):
    return re.sub(r'[^A-Za-z0-9]+', '_', n).strip('_') or 'name'


def cmd_preview(s, args):
    require_consent(s)
    spec, lines = build_lines(s)
    d = out_dir(s)
    engine, server, ref_server = start_engine(s, d, args)
    checker = Checker(vocabulary(spec))
    log(f'Line checker: {checker.kind}')
    p0 = (s['players'] or ['Vortex'])[0]
    p0 = s.get('say', {}).get(p0, p0)
    samples = {
        ('pbp', 'hype'): f'{p0} buries it! The crowd is on its feet!',
        ('pbp', 'lively'): 'One minute left, and this one is going right down to the wire.',
        ('pbp', 'calm'): 'Back to the middle we go, and here comes the kickoff.',
        ('color', 'hype'): "A bicycle kick! You don't see that very often. Absolutely outrageous.",
        ('color', 'lively'): 'Look at the air control there. Perfect timing on the jump.',
        ('color', 'calm'): 'Look at the defense here. One player overcommits, and suddenly the whole net is open.',
    }
    pdir = os.path.join(d, 'preview')
    os.makedirs(pdir, exist_ok=True)
    if args.names:
        say = s.get('say', {})
        samples = {}
        for i, n in enumerate(s['players']):
            samples[('pbp', 'lively', f'player-{i + 1:02d}-{safe_name(n)}')] = f'What a save from {say.get(n, n)}!'
        for i, t in enumerate(s['teams']):
            samples[('pbp', 'lively', f'team-{i + 1:02d}-{safe_name(t)}')] = f'{say.get(t, t)} take the lead!'
        pdir = os.path.join(pdir, 'names')
        os.makedirs(pdir, exist_ok=True)
    try:
        for key, text in samples.items():
            role, mood = key[0], key[1]
            sc, x, sr = record_line(engine, checker, {'role': role, 'mood': mood, 'text': text})
            base = key[2] if len(key) > 2 else f'{"pbp" if role == "pbp" else "analyst"}-{mood}'
            f = os.path.join(pdir, base + '.wav')
            with open(f, 'wb') as fh:
                fh.write(wav_bytes(x, sr))
            log(f'  {base} (checker {sc:.0%}): {text}')
        log(f'Listen to the WAVs in {pdir} (double-click them in Jupyter).')
        if args.names:
            log('A name sounds wrong? Change what comes after = for it in players.txt or teams.txt and run this again.')
        log('Happy with them? Run: python studio_cloud.py record')
    finally:
        checker.close()
        if server:
            server.close()


def cmd_record(s, args, fake=False):
    require_consent(s)
    spec, lines = build_lines(s)
    d = out_dir(s)
    log(f'Saving recordings to {d}')
    engine, server, ref_server = start_engine(s, d, args, fake=fake)
    checker = Checker(vocabulary(spec), fake=fake)
    log(f'Line checker: {checker.kind}')
    try:
        record_all(lines, engine, checker, d, int(args.concurrency or s['concurrency']), limit=args.limit, two_takes=two_takes_rule(spec, s))
    finally:
        checker.close()
        if server:
            server.close()
    if not args.limit:
        return export_pack(d, s, lines, addon=bool(getattr(args, 'addon', False)))
    log('Run record again (without --limit) for the rest, or export to build a zip of what is done.')


def two_takes_rule(spec, s):
    kinds = TWO_TAKES[s['two_takes_for']]
    fills = {cat: c['fill'] for cat, c in spec['categories'].items()}
    return lambda l: fills.get(l['cat'], 'name') in kinds


def cmd_review(s, args):
    """A folder with review.html and the takes, zipped, to open on your PC."""
    spec, lines = build_lines(s)
    d = out_dir(s)
    prog = load_progress(d)
    want = {key_of(l['role'], l['mood'], l['text']) for l in lines}
    items = [dict(k=k, text=v['text'] + (f"  (said: {v['say']})" if v.get('say') else ''), role=v['role'], mood=v['mood'], cat=CAT_LABELS.get(v.get('cat', ''), v.get('cat', '')), takes=v['takes'], scores=v['scores'], choice=v.get('choice'))
             for k, v in prog.items() if k in want and v.get('takes') and (args.all or v.get('choice') is None)
             and all(os.path.exists(os.path.join(d, f)) for f in v['takes'])]
    if not items:
        log('Nothing to review: every line with two takes already has a choice (use --all to see them again).')
        return
    items.sort(key=lambda i: (i['role'], i['cat'], i['text']))
    with open(os.path.join(HERE, 'review.html'), encoding='utf-8') as f:
        page = f.read()
    data = json.dumps({'pack': s['pack_name'], 'made': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'items': items})
    page = page.replace('/*__REVIEW_DATA__*/null', data.replace('</', '<\\/'))
    safe = re.sub(r'[\\/:*?"<>|]+', '_', s['pack_name'])
    zip_path = os.path.join(s['output_dir'], f'Review - {safe}.zip')
    top = f'Review - {safe}'
    with zipfile.ZipFile(zip_path + '.tmp', 'w') as z:
        z.writestr(f'{top}/review.html', page, compress_type=zipfile.ZIP_DEFLATED)
        for it in items:
            for f in it['takes']:
                z.write(os.path.join(d, f), f'{top}/{f}', compress_type=zipfile.ZIP_STORED)
    os.replace(zip_path + '.tmp', zip_path)
    log(f'{len(items)} lines to review ({2 * len(items)} takes).')
    log(f'  {zip_path}  ({os.path.getsize(zip_path) / 1e6:.0f} MB)')
    log('Download it, unzip it on your PC, and open review.html in your browser.')
    log('When you are done, click "Save choices", upload choices.json here, and run: python studio_cloud.py apply choices.json')


def cmd_apply(s, args):
    if not args.file:
        raise SystemExit('Usage: python studio_cloud.py apply choices.json')
    with open(args.file, encoding='utf-8') as f:
        ch = json.load(f)
    ch = ch.get('choices', ch)
    d = out_dir(s)
    prog = load_progress(d)
    kept = redo = unknown = 0
    for k, c in ch.items():
        v = prog.get(k)
        if not v or not v.get('takes'):
            unknown += 1
            continue
        if c in ('1', '2', 1, 2):
            i = int(c) - 1
            v['choice'] = i
            v['file'] = v['takes'][i]
            v['score'] = v['scores'][i]
            kept += 1
        elif c == 'redo':
            for f in v['takes']:
                try:
                    os.remove(os.path.join(d, f))
                except OSError:
                    pass
            del prog[k]
            redo += 1
    save_progress(d, prog)
    log(f'Kept your pick for {kept} lines' + (f', {redo} marked to record again' if redo else '') + (f' ({unknown} not found in this pack, skipped)' if unknown else '') + '.')
    if redo:
        log('Next: python studio_cloud.py record   (records the redos with two fresh takes), then review again.')
    else:
        log('Next: python studio_cloud.py export   (builds the voice pack zip with your picks).')


def cmd_export(s, args):
    spec, lines = build_lines(s)
    return export_pack(out_dir(s), s, lines, addon=bool(getattr(args, 'addon', False)))


def cmd_dryrun(s, args):
    """Whole pipeline with a fake voice: settings, clips, recording, resume, export."""
    import tempfile
    tmp = tempfile.mkdtemp(prefix='studio-dryrun-')
    s = dict(s)
    s['output_dir'] = tmp
    s['pack_name'] = 'Dry run'
    s['everyone_in_my_clips_agreed'] = True
    s['players'] = s['players'][:3] or ['Vortex', 'Ember']
    s['teams'] = s['teams'][:2]
    s['say'] = {k: v for k, v in s.get('say', {}).items() if k in s['players'] or k in s['teams']}
    bases = sorted({clip_names(s)[('pbp', m)] for m in MOODS})
    if not all(find_clip(os.path.join(HERE, s.get('clips_dir', 'clips')), b) for b in bases):
        # no clips yet: make placeholder clips in a temp folder
        cdir = os.path.join(tmp, 'clips')
        os.makedirs(cdir)
        t = np.arange(44100 * 9) / 44100
        for base in bases:
            with open(os.path.join(cdir, base + '.wav'), 'wb') as f:
                f.write(wav_bytes(0.2 * np.sin(2 * np.pi * 200 * t), 44100))
        s['clips_dir'] = cdir
        s['clip_texts'] = {b: 'Placeholder words for the dry run.' for b in bases}
    a = argparse.Namespace(limit=40, concurrency=4, server_url=None)
    log('--- part 1: record 40 lines, then stop')
    cmd_record(s, a, fake=True)
    a.limit = None
    log('--- part 2: pick up where it stopped and finish')
    z = cmd_record(s, a, fake=True)
    with zipfile.ZipFile(z) as zf:
        man = json.loads(zf.read('manifest.json'))
        names = set(zf.namelist())
    assert man['type'] == PACK_TYPE and man['version'] == 2
    assert all(l['file'] in names for l in man['lines'])
    assert len({l['file'] for l in man['lines']}) == len(man['lines'])
    log(f'Dry run OK: {len(man["lines"])} lines in {z}')


def main():
    ap = argparse.ArgumentParser(description='RL Career Casters cloud studio (Fish Audio Drama 3).')
    ap.add_argument('command', choices=['count', 'preview', 'record', 'review', 'apply', 'export', 'dryrun'])
    ap.add_argument('file', nargs='?', help='for apply: the choices.json saved from the review page')
    ap.add_argument('--all', action='store_true', help='for review: include lines you already picked')
    ap.add_argument('--settings', default=os.path.join(HERE, 'settings.json'))
    ap.add_argument('--limit', type=int, default=None, help='record only this many lines this run')
    ap.add_argument('--concurrency', type=int, default=None, help='lines generated at the same time (default from settings)')
    ap.add_argument('--server-url', default=None, help='use a Drama 3 server that is already running')
    ap.add_argument('--verbose', action='store_true')
    ap.add_argument('--names', action='store_true', help='for preview: say every player and team name once, to check them')
    ap.add_argument('--addon', action='store_true', help='for record/export: zip only the lines the full pack does not have yet')
    args = ap.parse_args()
    if not ffmpeg_ok():
        raise SystemExit('ffmpeg is missing. Run `bash setup.sh` (or apt-get install -y ffmpeg).')
    os.environ.setdefault('HF_HOME', '/workspace/hf' if os.path.isdir('/workspace') else os.path.join(HERE, 'hf'))
    s = load_settings(args.settings)
    {'count': cmd_count, 'preview': cmd_preview, 'record': cmd_record, 'review': cmd_review, 'apply': cmd_apply,
     'export': cmd_export, 'dryrun': cmd_dryrun}[args.command](s, args)


if __name__ == '__main__':
    main()
