# Testing the engine against real matches

The engine is graded by running it over real Rocket League matches in virtual time (a five-minute
match takes a few seconds) and checking everything it says against what really happened.

## 1. Get matches

Any `.replay` files work: your own (`Documents\My Games\Rocket League\TAGame\Demos`), or the
sample replays in the boxcars project:

```
git clone --depth 1 https://github.com/nickbabcock/boxcars
pip install subtr-actor-py numpy
python sim/replay2stream.py boxcars/assets/replays/good/00bb.replay sim/data/streams
```

`replay2stream.py` writes two files per match:

- `<name>.jsonl.gz`: what the Stats API would have sent a player in that match, with timing (the
  same format as the casters' match recorder, `--capture`). Goal replays aren't in replay files, so
  one is inserted after each goal (random length, sometimes skipped), and its touches are sent
  again flagged as replay, like the game does.
- `<name>.truth.json`: the answer key: every touch, pass, 50/50, kickoff and who won it, territorial
  pressure, rushes, saves (and how close to the line), goals and how they were built, demos, plus
  near misses and woodwork worked out from the ball's real path.

Recordings from the match recorder (`Casters\captures\*.jsonl.gz`) can be simulated too; they have
no answer key, so only the checks that don't need one apply.

## 2. Say what's recorded

```
python sim/make_inventory.py                          # pretend every 2.0 line is recorded
python sim/make_inventory.py --pack "My pack.zip"     # your pack: real line lengths
```

With `--pack`, `--pack current` in the next steps means "only the lines in your pack" and
`--pack full` adds the rest of the 2.0 bank (with estimated lengths).

## 3. Run and grade

```
node sim/simulate.js sim/data/streams/00bb.jsonl.gz --transcript 00bb.txt   # one match, readable
python sim/grade.py --pack full --n 76 --jobs 2                             # the full grade
python sim/edge_variants.py sim/data/streams sim/data/edge                  # joined late, pauses, ...
```

`simulate.js` options: `--seed n` (repeatable runs), `--hub` (pretend RL Career Hub is there, with
team names and form), `--pace quiet` (the chatter setting), `--latency 200` (ms from play to sound),
`--all-known` (every player is in the voice pack; by default one isn't, like your own player).

`grade.py` prints a report out of 100, grouped as timing, coverage, accuracy, pace, repetition,
flow and robustness, with examples of any wrong calls, and saves every match's result and some
transcripts in `sim/out/<tag>/`.
