# RL Casters Engine

Live, broadcast-style commentary for Rocket League, built for
RL Career Hub career mode but working in any match. The casters listen to
Rocket League's Stats API and talk over the game the way an RLCS broadcast does: who's on the ball,
passes, clears, 50/50s, kickoffs and pressure, then colour and stories (form, stats, momentum) when
play calms down, a breakdown over every goal replay, and the result at the end.

The voice comes from a **voice pack**: tens of thousands of short lines pre-recorded in one cloned
voice (your own) with the cloud studio in `studio/`. Nothing is generated while you play, so lines
start instantly and cost no CPU or GPU. Without a pack, the casters fall back to live text-to-speech.

## What makes it sound like a caster

- **On time.** Goals and saves cut straight in, fading out whatever is playing. A smaller call that
  can't start within about a second is dropped instead of said late. With the ball near a goal, only
  short lines are allowed to start.
- **Broadcast pace.** It talks about 70% of live play with the 2.0 lines, and the longest silence in
  a typical match is under 3 seconds. The `chatter` setting turns it down (`quiet`, `sparse`) or up
  (`chatty`).
- **Never three times.** No line is said more than twice in a match; when nothing fresh fits, a
  repeat is used rather than silence.
- **Only true calls.** The Stats API doesn't say where the cars are or where a shot went, so the
  engine doesn't guess at "just wide!" or "on the break!" (tested, those guesses were wrong 65-80% of
  the time); the woodwork is called from the game's own event. Stories are re-checked when they're
  said: "Blue need a goal" only while Blue are behind.
- **Knows the season.** With RL Career Hub it reads your save (read-only) for team names, the
  series score, form, the table and season stats.

## How it's built

```
Rocket League Stats API (TCP, localhost:49123)
        |  statsapi.js
        v
   GameModel  (app/engine/model.js)    the match: phase, clock, score, touches, possession,
        |                               pressure, kickoffs -> "moments" (pass, clear, 50/50,
        |                               shot, save, goal, clock mark, ...)
        v
   Director   (app/engine/director.js) what to say and when: calls with a priority and a
        |                               deadline (late = dropped; big calls cut in), flow at
        |                               broadcast pace, stories for the lulls, replay analysis
        v
   Library    (app/engine/library.js)  which recorded line: fits the time there is, fresh
        |                               this match/series, never a third time
        v
   Speaker -> Player (app/speaker.js, app/player.js)   plays it on one steady Windows audio stream, cuts with a fade
```

`app/commentary.js` wires these together and keeps what lasts longer than a match (the series,
lines said in it, RL Career Hub context). The line bank is `app/lines.js` (1.x, 111 call types)
plus `app/lines2.js` (2.0, 56 call types); `app/engine/catalog.js` merges them. More in
[docs/ENGINE.md](docs/ENGINE.md).

## Running it

**Windows, from a release:** unzip, put your voice pack zip next to `RL Career Casters.exe`, start
the exe, play. [docs/USER-GUIDE.txt](docs/USER-GUIDE.txt) is the full guide (settings, voice packs,
the demo, the match recorder, troubleshooting). `windows/` has the launchers.

**From source** (Node.js 22.2 or newer):

```
npm install
npm test             # engine tests (fake clock, runs in seconds)
node run.js --demo   # the opening minutes of a real match, no game needed
node run.js          # the real thing: start this, then Rocket League
```

Voice packs go in this folder when running from source. Audio playback uses Windows (PowerShell);
on other systems use `--silent` to see the lines without sound.

**Building the exe:** `python tools/build.py --base "RL Career Casters.exe" --version 2.0.1` takes a
release exe as the base (its Node runtime and native speech-engine DLLs), swaps in `app/`, and
injects the new bundle (needs `pip install pefile` and Node for `npx postject`).

## Voice packs: the cloud studio

`studio/` records a voice pack on a rented GPU (RunPod) with Fish Audio Drama 3, cloning the voice
in three reference clips (hype, lively, calm). **Only clone your own voice, or the voice of someone
who has agreed to it** (the studio won't run until you confirm that in `settings.json`). The clips
aren't in this repo; add your own. See [studio/README.md](studio/README.md).

## Testing against real matches

`sim/` runs the engine over real matches in virtual time and grades it against what really
happened: Rocket League replays are converted into exactly what the Stats API would have sent,
plus an answer key (every touch, pass, 50/50, kickoff, save, goal, near miss and woodwork from the
ball's real path). On 76 sample replays, 2.0 grades **99.6/100** with its full line bank and
**92.2/100** with only the 1.x lines; the 1.x engine scored **67.6**. The match recorder
(`--capture`) saves real Stats API sessions in the same format. See [sim/README.md](sim/README.md).

## Credits

Cloud studio voice packs are recorded with Fish Audio Drama 3 (Fish Audio Community License: free
for personal, non-commercial use) and checked with Whisper (MIT); live voices use Kyutai Pocket TTS
through sherpa-onnx (Apache 2.0). The demo match (`app/demo_match.json.gz`) and the test replays
are sample replays from the [boxcars](https://github.com/nickbabcock/boxcars) project (MIT),
parsed with [subtr-actor](https://github.com/rlrml/subtr-actor). Not affiliated with Psyonix or
Epic Games; Rocket League is their trademark.
