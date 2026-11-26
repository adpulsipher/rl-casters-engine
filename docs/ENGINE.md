# How the engine works (2.1)

## What changed in 2.1.2

Found by playing a best of five in RL Career Hub with the match recorder on (three games, 3-0):

- **The intro never played, and the casters talked over the empty lobby.** On `MatchCreated` the model
  reset its state but then marked the *old* state active, so the first `UpdateState` looked like a
  match joined late: no intro, no "game two", and phase `live` for RL Career Hub's ~20 s empty lobby
  (no players, teams "BLUE"/"Orange") - all filler. Now the lobby is phase `pre` (silent), and the
  intro waits until both teams have players, then for the team names, or RL Career Hub knowing the
  teams from the players, or 3 s (MatchInitialized and the first countdown still start it). Game 1's
  intro is the welcome and both teams in one go (the team lines were left for a lull and never fit
  in live play, where nothing over 3.8 s starts).
- **Series games.** RL Career Hub's save doesn't change during a series (it said game 1 for all three),
  so its game number and score only win when they're ahead of the casters' own count. A side is the
  same as last game by team name, or by 60% of the same players, because the names arrive seconds
  before kickoff. After each game: where the series stands, and the goodbye only once the series is
  over (best of known from RL Career Hub) - "And that's the series!" lines are in the bank to record.
- **The result was cut off.** RL Career Hub closes the match 0.1-0.6 s after the podium starts, and
  `MatchDestroyed` stopped all speech. After a finished match it now only drops what's not the result
  or the wrap-up, which carries on over the next match's lobby. Leaving mid-game still stops at once.
- **Speeds were read in the wrong units.** The live Stats API gives km/h (ball hits 10-130 here); the
  engine was tuned on match files in uu/s. So in live play every shot's time to goal came out ~25x
  too long, no hit was ever "big", and every touch was "soft". The model now takes km/h until it sees
  a speed over 250 (only possible in uu/s: the ball's top speed is 216 km/h).
- **Stat events arrive once per player** (7 times over while spectating): counted once now, so a
  player's demos and assists are right.
- Alex's notes on the recordings:
  - "They just need to convert" only for a team that's level or behind.
  - A demo is always called when the ball is in the victim's own third; any other one 20% of the
    time (10% in a blowout).
  - At zero on the clock: a short call at once, at the next pause between words; nothing long starts
    in the last 4 s of a close game; the result follows the zero call at a pause. The pack's zero
    lines are all 4.7 s+, so "Last chance!" until "Zero on the clock!" is recorded.
  - Goals: the goal itself can't be called early - the game only says where the ball is when it's
    touched, and two shots in three are saved - so a shot keeps the air clear until it should have
    arrived, and the goal call follows a call about the same play (the shot, a touch, off the bar)
    at the next pause between words instead of after it. The bar call waits 0.9 s (the ball went in
    0.2-0.8 s after hitting it in these games).
  - "{name} lets it fly" only for a goal hit from 3000 uu out or more.
  - Short calls ("Aerial!") can come up to 5 times a game, 30 s apart.
  - Replay analysis started 5-10 s into a 7 s replay. When the replay starts with the goal call
    nearly done, the line about what the goal means ("Gentle Mates extend the lead") moves to the
    restart (not a hype line like "Orange jump in front!"), the analysis starts with less of a pause,
    and the "here it is again" opener is only used early in the replay. In the recorded games it now
    starts 1.5-2.5 s into the replay.
  - More stat callouts, most in a blowout (80% of colour moments there have a stat when there's one):
    the player's line, then the number ("That's three goals on the night."), and replay stats after
    goals in a blowout too.
  - One win from the series and out of reach in this game (3 up, or 2 up in the last 90 s / at the
    one- and two-minute marks): the series is called as all but over.
  - "{team} need something here, otherwise this might be too far to come back from." when a team
    goes 2 down with under three minutes left, or 3 down with time left.
  - New lines in the bank, said once recorded: `need_something`, `series_clinch`, `series_won`, and
    "Zero on the clock!".

On the 80-match set (match files, so the km/h fix doesn't show here):

| | 2.1.1 | 2.1.2 |
|---|---|---|
| Goal call starts (p90 after the goal) | 1.44 s | 0.58 s |
| Goals called in time | 89% | 93% |
| Event calls started over 1.5 s late | 11% | 8% |
| Saves called (close games) | 60% | 59% |
| Demos called (close games) | 58% | 32% (by design) |
| Woodwork called | 49% | 38% (waits 0.9 s now) |
| Talking in live play / median longest silence | 66% / 3.9 s | 65% / 4.2 s |
| Lines said 3+ times in a match | 0 | 96 in 80 matches, all short calls |

In the Bo5 recordings: silent through the lobby, the welcome and both teams before kickoff, "game two"
and "game three" with the series score, the result and the series score after each game, replay
analysis 1.5-2.5 s into the replay (was 5-10 s).

## What changed in 2.1

Asked for by listening to real matches, and graded on 80 (the 76 samples plus four Worlds 2025 games):

| | 2.0.4 | 2.1 | 2.1 with `cutIn: saves` |
|---|---|---|---|
| Lines broken off by another call, per match | 12.5 | 1.7 (game-deciding goals only, at a pause) | 6.6 (plus saves, at a pause) |
| Sentences said twice in a match | 3.9 | 0 | 0 |
| Speech level spread across lines (30 real lines) | 14 dB | under 1 dB | same |
| Early routine saves called with a "miracle" line | 7% | 0% | 0% |
| "X takes it" calls per match | 12.8 | 10.0 | 10.2 |
| Saves called within 1.5 s | 87% | 57% (25% more a beat late) | 91% |
| Goals called within 2 s | 100% | 90% (the rest within 5 s) | 91% |
| Longest silence in a match (median) | 2.8 s | 3.9 s | 3.9 s |

- **No cutting in**, except a game-deciding goal: one that takes the lead, any overtime goal, or with
  under a minute left one that brings a team level or back within one. It waits for the next pause
  between words (up to 0.45 s; the pauses are found in the rendered line), then fades over 50 ms.
  Any other call waits for the line being said to end, and stops a run of lines after the current
  one. `cutIn: "saves"` in config.json lets saves break in the same way.
- **Never repeat a sentence in three games in a row** (2.1.1; 2.1.0 was per match), nor its template
  with another name in it, so a sentence comes up three times at most in a best of seven. Calls of
  three words or fewer ("Shot!", "{name} takes it.") can come up twice a game, or they'd run out.
  When a call would have no line, one from the two games before is used again; generic colour and
  flow lines never are, unless it's that or dead air. Tested on 25 games played back to back (three
  best-of-sevens plus the four Worlds games): sentences back from the previous two games went from
  18.7 to 3.2 a game, talking from 69% to 67% of the game, the median longest silence 4.8 s to 4.9 s.
  The window survives a restart of the casters. Generic colour (40 lines, about 30 used a game) is
  what runs out first.
- **Even loudness**: every line is brought to -19 dBFS of speech (pauses left out) with a -1 dBFS
  limiter, instead of matching peaks; moods differ by only 1-2 dB now.
- **Stakes**: early in the game or in a blowout a routine save gets a calm line ("The defense is
  holding firm."), a game-flagged epic save only gets a big call late in a close game or in
  overtime, and a goal for a team already 3 up (2 up in the last minute) is called, not celebrated.
- **Live play keeps lines short** (3.8 s at most) and nothing new starts while a shot is on its way,
  so a save or goal rarely has to wait. Long stories are for the breaks.

The rest of this page describes 2.0; the call table's "cuts in over" column is now "nothing" for
every call but a game-deciding goal.

## What Rocket League tells us

The casters read Rocket League's Stats API (a JSON stream on `localhost:49123`; the casters turn
it on in `DefaultStatsAPI.ini`, 30 updates a second). For a player in the match it sends:

- `UpdateState` 30 times a second: score, clock, overtime, replay flag, the ball's **speed** and
  which team touched it last, and each player's match stats. Boost, car speed and demolished state
  are only sent while spectating; the engine uses them when present.
- `BallHit`: who touched the ball, its speed before and after, and **where the ball was**. This is
  the only time the ball's position is known; car positions are never sent.
- `StatfeedEvent`: shots on target, saves, epic saves, demolitions, assists, goal types.
- `GoalScored` (scorer, assister, speed, where it went in), `CrossbarHit`, `CountdownBegin`,
  `RoundStarted`, `ClockUpdatedSeconds`, the goal-replay events, `MatchEnded` and so on.

Everything below is built from that. Field: blue (team 0) attacks +Y, goal lines at Y = +-5120,
side walls at X = +-4096, ceiling at Z = 2044.

## GameModel (`app/engine/model.js`)

Keeps the state of play and turns messages into **moments**:

| Moment | How it's detected |
|---|---|
| touch | every live `BallHit`: zone (own third / middle / their third, from the toucher's side), surface (ground, wall, air, ceiling, from the ball's position) |
| kickoff result | the first team on the ball **in the other half** within 3 s of the kickoff contact (right 87% of the time on 477 real kickoffs; called about one kickoff in six) |
| pass | a teammate's touch, then yours: the ball travelled 5 m+ inside 2 s, and the passer's touch wasn't a scramble (right 89%) |
| 50/50 | both teams in one `BallHit`, or opposing touches within 0.22 s |
| clear | struck at 1600+ out of your own third |
| transition | a clear, then the same team on the ball in the other half within 3.5 s ("going the other way" - not "a counter-attack", which needs car positions) |
| dribble / flick | the same car on it three times in a row, slowly; then hit hard |
| pressure | 80%+ of the last 10 s of touches in one team's attacking half |
| shot | stat feed `Shot`, with an estimate of when it arrives (distance / speed) |
| save | stat feed `Save` / `EpicSave`, merged (they arrive together); "on the line" from the saver's touch |
| rebound | the attackers back on it in their third within 1.6 s of a save |
| woodwork | `CrossbarHit`, held 300 ms: off the post and in is a goal, not a near miss |
| goal | `GoalScored`; who scored from **which goal it went in** (an own goal only when nobody on the scoring team is credited); how it was built (from a clear, under pressure, solo, a passing move) |
| clock marks | 2:00, 1:00, 0:30, 0:10, 0:05, zero seconds (the ball still has to hit the ground), and minutes of overtime |

It copes with what real sessions throw at it: joining mid-match (catches up with the game's score),
missing kickoff events (the clock only runs in live play, so a moving clock means play is on),
pauses, replays (touches and stats shown again in a replay are ignored), duplicated events, unknown
stat names and malformed data.

**What it deliberately doesn't do:** near misses. A hard shot off the back wall and a shot just
wide look the same in the Stats API (a sharp change in ball speed, no touch); on 140 real matches
no rule got above 35% right, so there's no "just wide!". Likewise "on the break!": a real
counter-attack is about numbers, and car positions aren't sent (best rule: 23% right).

## Director (`app/engine/director.js`)

Two kinds of speech.

**Calls** answer a moment. Each has a priority, a deadline and what it may cut in over:

| Call | Priority | Must start within | Cuts in over |
|---|---|---|---|
| goal | 100 | 1.5 s | everything (and can't itself be cut) |
| big save / save | 80 / 75 | 0.8 s | shots, play-by-play, colour |
| woodwork | 72 | 0.7 s | play-by-play, colour |
| shot | 60 | 0.3 s | nothing (only if the caster is free) |
| rebound | 55 | 0.45 s | play-by-play |
| demo | 50 | 1.1 s | colour |
| clock | 50-58 | 0.9-2.5 s | colour |
| kickoff, kickoff result | 44, 40 | 0.6-0.8 s | colour |
| pass, clear, 50/50, transition... | 33-42 | 0.45-0.9 s | nothing |

A call that can't start in time is **dropped** (a save that was dropped gets a "good save there"
in the next lull instead). A cut fades the line out over 140 ms.

**Flow** fills the rest at the pace set by `chatter`. In live play, in order: name who's on the
ball if the touch is under 0.9 s old (not more than every ~2.3 s); colour or a story when play is
calm; something short and true about the play if it's gone quiet; and after 4.5 s of silence in
calm play (6.5 s otherwise, unless a shot is on its way) anything at all, because a repeat beats
dead air. How long a line may be depends on the danger: about 2 s with the ball near a goal, up to
6.5 s when it's calm.

**Stories** are things worth saying in a lull: the teams and form from RL Career Hub, a player to
watch, stats ("that's three saves"), momentum ("back-to-back goals"), comebacks, "need a goal".
Each one is checked again when it's about to be said, so it's still true.

**Goals:** the call and what it means ("...take the lead!"), the score at the restart, and a
breakdown over the replay (the build-up, the speed, the assist, a season milestone).

## Library (`app/engine/library.js`)

Every line comes from here. A line is only used if it's recorded (in the voice pack), fits the time
there is (lengths come from the pack's 64 kbps MP3 sizes, no decoding needed), and has been said
fewer than **twice this match**. Among those it prefers lines not said this series, then not this
match, then the one said longest ago; it avoids reusing a template for a while, and the same kind
of line twice in a row. Important calls fall back to a longer line rather than none.

## How it was tested

`sim/` converts real replays into the exact Stats API stream (with goal replays inserted, since
replay files don't contain them, and the replayed touches sent again like the game does) and an
answer key from the ball's real path and the parser's labels. The engine runs over each match in
virtual time with a simulated voice pack and a conservative 200 ms audio delay, and every line is
checked: was it on time, was it true (the right player, a real pass, the right score, the right
team leading), how long were the silences, was anything said three times.

Final grades, 76 sample replays (1v1 to 3v3, with overtimes), fresh random seeds:

| | 1.x engine, 1.x lines | 2.0, 1.x lines only | 2.0, full 2.0 bank |
|---|---|---|---|
| **Overall** | 67.6 | 92.2 | **99.6** |
| Timing (18) | 15.5 | 16.6 | 18 |
| Coverage (14) | 4.5 | 13.9 | 14 |
| Accuracy (22) | 17.2 | 22 | 22 |
| Pace (15) | 6.9 | 11 | 15 |
| Repetition (15) | 8.3 | 14.2 | 15 |
| Flow + robustness (16) | 15.1 | 14.5 | 15.6 |

With the full bank: every goal called (p90 latency 0.21 s), ~95% of saves in close games (p90
latency 0.42 s), every goal/save/shot/demo/woodwork call true, every named call the right player,
passes, 50/50s, transitions, pressure and kickoff winners 87-100% right, talking ~69% of live play,
no line ever said three times, no errors.

Limits worth knowing: the grade is the engine on real match data, not the sound of it; line lengths
for some lines are estimated; the parser's labels (what counts as a pass) are themselves a model.
Real sessions from the match recorder are the final check.
