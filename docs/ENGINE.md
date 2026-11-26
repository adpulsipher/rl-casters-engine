# How the engine works (2.0)

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
