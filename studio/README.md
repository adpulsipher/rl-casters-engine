# RL Career Casters: Cloud Studio

> **From GitHub?** Two things aren't in this repo, on purpose: `clips/` (the three reference
> recordings of the voice) and `already_in.json` (the lines a particular pack already has).
> Add three clips of **your own voice** (or of someone who has agreed) as `clips/hype.wav`,
> `clips/lively.wav` and `clips/calm.wav`, type exactly what each says under `clip_texts` in
> `settings.json`, and only then set `everyone_in_my_clips_agreed` to `true`. To record only what a
> pack you already have is missing, set `"already_in"` to that pack's zip (or a list: the pack and
> its add-ons) and run `record --addon`.

Records a whole voice pack on a rented GPU with **Fish Audio Drama 3**. It works like
the Colab notebook: every line, for every player and team you list, cloned from your
clips, checked by speech recognition, and re-taken if it comes out garbled. You get
the same voice pack zip at the end, so you put it next to `RL Career Casters.exe` as before.

**What it costs:** one H100 80 GB for 1½ to 2½ hours, plus the time you spend picking
takes. On RunPod that's about $2 to $3 an hour, so roughly **$4 to $10** for 72 players.
`count` shows the estimate for your own list before you spend anything.

**Use it with RL Career Casters 1.3.1.** The pack is recorded from the 1.3 line bank:
469 lines, 285 of them new, including the blowout, consolation and series calls.
Casters 1.2 can play the pack too, but only the original lines in it.

**What's in this folder**

| File | What it is |
|---|---|
| `studio_cloud.py` | the studio (count, preview, record, export) |
| `settings.json` | your pack name, clip texts and other settings |
| `players.txt` | the 72 players, with how to say each name: **check this** |
| `teams.txt` | the 24 Kick-Off teams, with how to say each name |
| `spec.json` | the casters 2.0 line bank (every call type, old and new) |
| `review.html` | the take picker page (the studio fills it in for you) |
| `setup.sh` | one-time install on the rented machine |
| `clips/` | your three reference clips (`hype`, `lively`, `calm`), already cut from your recordings |
| `NEW LINES.md` | the lines new in 2.0, grouped by call type, to read through |
| `already_in.json` | the 18,477 lines already in your pack (full pack + 1.4 add-on), so they aren't recorded again |

---

## Recording the 2.0 lines (for RL Career Casters 2.0)

This copy is set up to record only the lines the 2.0 engine adds: touch-by-touch
play-by-play (who's on the ball, passes, clears, 50/50s, the wall, the air), kickoff
winners, pressure, transitions, rebounds, short goal and save calls, the two-minute,
five-second and zero-second calls, overtime clock calls, momentum and comebacks, and a
lot more colour for the lulls. That's **4,845 lines** (`NEW LINES.md` has them all).
`already_in.json` lists the 18,477 lines your pack already has (the full pack and the
1.4 add-on), so none of those are recorded again.

Rent and set up the pod as in steps 2 and 3, then run:
```
python studio_cloud.py record --addon
```
On one H200 that's about 20 minutes of recording after the ~25-minute setup, so
roughly **$4** at $5.29 an hour. At the end it builds
`RL Career Casters Voice Pack - My casters (add-on <date>).zip`. Put it next to your
pack and RL Career Casters 2.0 plays both; "Combine voice packs.bat" makes them one zip.

## 1. Fill in settings.json (on your PC, before renting anything)

- `everyone_in_my_clips_agreed`: set it to `true`. The clips are your own voice. Drama 3's
  license also bans cloning anyone without their consent.
- `pack_name`: any name. Re-using the same name later adds to the same pack.
- **Players and teams** live in `players.txt` and `teams.txt`, one per line:
  ```
  Rw9 = R W nine
  zen
  ```
  The part before `=` is the name **exactly as RL Career Hub shows it** (capitals, dots and
  spaces don't matter, letters do). That's what the casters match on. The part after `=` is
  what actually gets recorded. Leave it out when the name reads fine. You don't need
  `pronunciations` in the casters' config.json for these names, and it should stay empty
  for them, or the casters will look for the wrong text.
  Lines starting with `#` are notes. Blue and Orange are always included as teams.
- `lines_per_player`: up to this many versions of each call per player. **5** gives
  12,280 lines for the 72 players and 24 teams in the lists. Use `"all"` for every version.
- `two_takes_for`: which lines get **two takes for you to pick from** (step 5b):
  - `"general"` (default): the 149 calls with no name, team or number in them, so 298 takes to listen to.
    These are the lines you'll hear in every match.
  - `"general+teams"`: plus the team lines (about 2,900 takes for 10 teams).
  - `"no-names"`: everything except player-named lines (about 4,200 takes).
  - `"none"`: one take each, no picking.
  Set this before you record. Lines already recorded keep the takes they have.
- `one_voice`: `true` (the default here) means one caster doing both jobs, cloned from three
  clips: `clips/hype`, `clips/lively` and `clips/calm`. The casters then play the pack as a
  single caster. Set it to `false` for two casters from six clips (`pbp-hype` … `analyst-calm`).
- `clip_texts`: the exact words in each clip. These are already filled in from your clips.
  Check them by ear, especially the player names.

## 2. Rent the GPU (RunPod)

1. Make an account at runpod.io and add $10 of credit.
2. **Pods → Deploy**. Pick an **H100 80GB** (Community Cloud is the cheapest). Any card
   with 48 GB or more works (A100 80GB, H200), but the estimates assume an H100.
3. Template: **RunPod PyTorch** (any recent one). Click **Edit Template** and set
   **Volume Disk to 100 GB** (the model alone is about 40 GB) and Container Disk to 30 GB.
   If there's a CUDA version filter, set it to 12.8 or newer.
4. Deploy, wait for it to start, then **Connect → Jupyter Lab**.

Billing runs every second the pod is on. **Stop and delete it when you're done** (step 6).

## 3. Upload and set up (about 15 minutes)

1. In Jupyter's file browser, go to `/workspace` and drag this whole zip in.
2. Open a terminal (**File → New → Terminal**) and run:
   ```
   cd /workspace
   python3 -m zipfile -e "RL Career Casters Cloud Studio.zip" .
   cd "RL Career Casters Cloud Studio"
   bash setup.sh
   source /workspace/venv/bin/activate
   python studio_cloud.py count
   ```
   `count` prints the number of lines and a time and cost estimate.

In any new terminal, run `source /workspace/venv/bin/activate` again first.

## 4. Preview: listen before the long recording

```
python studio_cloud.py preview
```
The first run downloads Drama 3 (about 40 GB, 10 to 20 minutes). It then records six
sample lines into `/workspace/studio-output/<pack name>/preview/`. Double-click them in
Jupyter to listen. Check that each one sounds like you, has the right energy for its mood,
and **ends like a finished sentence**, which was Qwen's weak spot.

If one clip sounds off, swap a different clip into `clips/` (same file name), fix its
`clip_texts` entry, and run preview again. With one voice, the preview still records six
samples: the play-by-play and analysis lines for each mood, all in your voice.

Then check every name (about 5 minutes):
```
python studio_cloud.py preview --names
```
It records "What a save from ...!" for each player and "... take the lead!" for each team
into `preview/names/`. If one sounds wrong, change what comes after `=` for it and run
`preview --names` again. You can also fix a name after the big recording: change it and run
`record`, and only that name's lines are recorded again.

## 5. Record the whole pack

Run it inside **tmux**, so it keeps going if you close the browser tab:
```
tmux new -s studio
source /workspace/venv/bin/activate
python studio_cloud.py record --limit 100
python studio_cloud.py record
```
- `--limit 100` is an optional speed test: it shows the real lines per minute and time left.
- Plain `record` does everything else, then builds the zip.
- Every few lines it prints progress: lines a minute, time left, and how many the checker
  was unsure about.
- If the tab closes, open a terminal and run `tmux attach -t studio` to get back in.
- If it stops for any reason, run `record` again. It saves progress constantly and carries
  on where it stopped.
- Ctrl+C stops cleanly after the lines in progress. Run `export` to zip what's done so far.

## 5b. Pick the better take

```
python studio_cloud.py review
```
This makes `/workspace/studio-output/Review - <pack name>.zip` (about 12 MB for 298 takes).
1. Download it, unzip it on your PC, and open `review.html` in Chrome or Edge.
2. For each line: **Space** plays both takes, then **Q** keeps take 1, **W** keeps take 2,
   or **R** marks it to be recorded again. The page moves to the next line and plays it.
   **1** or **2** plays one take, **Backspace** clears a pick, and **↑ ↓** move.
   Your picks are kept in the browser as you go, so you can close it and come back.
3. Click **Save choices**. It downloads `choices.json`.
4. Upload `choices.json` into the studio folder in Jupyter and run:
   ```
   python studio_cloud.py apply choices.json
   ```
5. If you marked any redos, run `python studio_cloud.py record` (it records just those, with
   two fresh takes), then `review` again. The new review only shows lines still to pick.
6. When you're done: `python studio_cloud.py export` builds the voice pack with your picks.
   Lines you didn't pick use whichever take the checker scored higher.

The pod keeps billing while you listen (about $1 for half an hour). You can also **Stop** it
(not Delete) while you review: the volume keeps everything, including the downloaded model.
Start it again for the redos and export.

## 6. Download, then shut the pod down

1. In Jupyter, open `/workspace/studio-output/`, right-click
   `RL Career Casters Voice Pack - <name>.zip`, and choose **Download** (about 350 MB for 10,000 lines).
2. In RunPod: **Stop**, then **Delete** the pod and its volume. A stopped pod still charges
   a little for its disk.
3. Put the zip next to `RL Career Casters.exe` and start the casters. The first import of
   10,000 lines takes a few minutes and uses about 2 GB of disk.

## If something goes wrong

- **The voice server won't start:** the end of its log is printed, and the full log is
  `server.log` in the output folder. If the install picked a CUDA build the pod's driver
  can't run, deploy a pod with a newer CUDA version, or follow the vLLM-Omni Drama 3
  recipe's pinned install.
- **A server is already running in another terminal:** add `--server-url http://127.0.0.1:8000`.
- **Faster or slower:** `"concurrency"` in settings.json (default 8) sets how many lines are
  made at once. 16 is usually faster on an H100. If lines start failing, go back to 8.
- **"Line checker could not use the GPU":** it switches to a slower CPU checker on its own.
  Recording still works.
- **Test the whole thing for free:** `python studio_cloud.py dryrun` runs every step with a
  fake voice. It needs no GPU or model, just Python, numpy and ffmpeg.

## The line bank and the casters version

The casters only say lines from the line bank built into the program. With a voice pack,
they pick from the lines in that bank that are in the pack. This pack is recorded from the
1.3 bank: all 184 original lines, word for word, plus 285 new ones.

- **Casters 1.3:** every line in the pack gets used.
- **Casters 1.2:** the pack works, but only the original lines in it play.
- Your Qwen pack from the Colab notebook works in 1.3 too. It just doesn't have the new
  lines, so 1.3 falls back to the closest original line, or stays quiet where none fits.

Credits: Fish Audio Drama 3 (Fish Audio Community License v1.0: free for non-commercial use,
and for commercial use under US$500,000 a year in revenue; no cloning a real person without
consent; don't remove its watermark). vLLM and vLLM-Omni (Apache 2.0). Whisper by OpenAI (MIT).
