'use strict';
// Line bank, part two (engine 2.0): the calls a broadcast makes between the big moments.
// Touch-by-touch play-by-play, kickoffs, passes, clears, 50/50s, pressure, counters,
// near misses, rebounds, zero-second drama, momentum, and a lot more colour for the lulls.
//
// Same rules as lines.js: at most ONE fill-in per line, so every line can be recorded in
// advance for every player and team. META says who says each kind of line and how.
// (The categories in lines.js keep their own rules in commentary.js: changing a recorded
// category's caster or mood would orphan its recordings.)

const LINES = {
  // ---------------------------------------------------------------- kickoffs
  kickoff_go: [
    'And we\'re underway!', 'Here we go!', 'Off we go!', 'Kickoff!', 'We\'re live!', 'And away we go!', 'Here\'s the kickoff!', 'Let\'s go!',
  ],
  kickoff_ready: [
    'Here\'s the restart.', 'Back to the middle.', 'Ready to go again.', 'Kickoff coming up.', 'Reset, and here we go again.',
  ],
  kickoff_won: [
    'Kickoff goes to {team}.', '{team} win the kickoff.', 'Good kickoff for {team}.', '{team} take it from the kickoff.',
  ],
  kickoff_won_name: [
    '{name} wins the kickoff.', 'Good kickoff from {name}.', '{name} takes the kickoff.', 'Strong kickoff by {name}.',
  ],

  // ---------------------------------------------------------------- touch by touch
  pbp_touch: [
    '{name} with it.', '{name} on the ball.', '{name} takes it.', 'Here\'s {name}.', '{name} picks it up.', '{name} has it now.', '{name} to the ball.',
  ],
  pbp_touch_g: [
    'Good touch.', 'Nice control.', 'Picks it up.', 'Takes it down.', 'Settles it.', 'Lovely first touch.',
  ],
  pbp_wall: [
    '{name} up the wall.', '{name} takes it off the wall.', '{name} goes up the wall.',
  ],
  pbp_wall_g: [
    'Up the wall.', 'Off the wall.', 'Wall play.', 'Along the wall.', 'Takes it up the wall.',
  ],
  pbp_aerial_g: [
    'Up in the air!', 'Aerial!', 'Goes up for it!', 'Off the ground!', 'Airborne!',
  ],
  pbp_ceiling_g: [
    'Off the ceiling!', 'Up to the ceiling!', 'Ceiling play!',
  ],
  pbp_pass: [
    'Nice pass from {name}.', '{name} finds a teammate.', '{name} lays it off.', 'Good ball from {name}.',
  ],
  pbp_pass_g: [
    'Lovely pass.', 'Good ball.', 'Nice pass.', 'Finds the teammate.', 'Passing it around.', 'Great vision.', 'Into the middle.',
  ],
  pbp_fifty_g: [
    'Fifty-fifty!', 'Big challenge!', 'They meet in the middle!', 'Fifty-fifty, and it\'s loose!', 'Fifty on the ball!', 'Contested!',
  ],
  pbp_clear: [
    '{name} clears.', '{name} sends it long.', '{name} gets it away.', 'Big clear from {name}.',
  ],
  pbp_clear_g: [
    'Cleared.', 'Away it goes.', 'Sent long.', 'Cleared up the field.', 'Gets it out.', 'And it\'s cleared.', 'Relief for the defense.',
  ],
  pbp_turnover_g: [
    'Turned over.', 'Won back.', 'Intercepted!', 'Nice read.', 'Stolen away!', 'They win it back.',
  ],
  pbp_dribble: [
    '{name} dribbling.', '{name} carries it.', '{name} on the dribble.', '{name} takes it up the field.',
  ],
  pbp_flick_g: [
    'Flick!', 'What a flick!', 'Off the flick!',
  ],
  pbp_pressure: [
    '{team} keep it in.', '{team} won\'t let it out.', '{team} pressing.', '{team} piling on the pressure.',
  ],
  pbp_pressure_g: [
    'Still in there.', 'Kept in!', 'It won\'t go away.', 'They can\'t clear it.', 'Wave after wave.', 'Still pressing.',
  ],
  // a clear, then the same team on the ball in the other half: the play has turned around
  // (the game doesn't say where the cars are, so these never claim an overload or a break)
  pbp_transition: [
    '{team} push forward.', '{team} going the other way.', 'Back on the attack for {team}.',
  ],
  pbp_transition_g: [
    'Going the other way!', 'Up the other end now.', 'Back on the attack.', 'Quick transition!', 'And now they push forward.',
  ],
  pbp_defend_g: [
    'Good defending.', 'Great challenge.', 'Nicely defended.', 'Shut down.', 'Well read.', 'Good shadow defense.',
  ],
  pbp_flow_g: [
    'Back in the middle.', 'Settling it down now.', 'Resetting the play.', 'Back to the defense.', 'Working it around.', 'Looking for an opening.',
    'Loose ball.', 'Up the field it goes.', 'Into the corner.', 'Off the back wall.',
  ],

  // ---------------------------------------------------------------- shots, saves, chances
  shot_g: [
    'Shot!', 'On target!', 'Here\'s the shot!', 'Goes for goal!', 'Shoots!', 'Takes the shot!',
  ],
  save_g_short: [
    'Saved!', 'Stopped!', 'Denied!', 'Blocked!', 'Kept out!', 'Big save!',
  ],
  save_late: [
    'Good save there from {name}.', '{name} with the save there.', 'Nice stop from {name}.',
  ],
  save_react_g: [
    'That was a huge save.', 'Brilliant goalkeeping there.', 'What reactions!', 'They were so close to scoring there.',
  ],
  rebound_g: [
    'Rebound!', 'Second chance!', 'Follow-up!', 'Again!', 'Off the rebound!', 'Still alive!',
  ],
  // with the woodwork (the game reports the ball hitting the frame; it can't tell a shot just wide)
  close_g: [
    'So close!', 'Oh, so close!', 'Inches away!', 'Nearly!', 'Not far away!', 'Denied by the woodwork!',
  ],
  close_react_g: [
    'They\'ll be wondering how that stayed out.', 'That was a big chance.', 'That one was nearly in.',
  ],

  // ---------------------------------------------------------------- demos
  demo_g_short: [
    'Demo!', 'Boom!', 'Blown up!', 'Demolished!', 'Take that!',
  ],
  demo_numbers_g: [
    'They\'re a man down.', 'Man advantage now.', 'One player short for a moment.', 'Numbers advantage!',
  ],

  // ---------------------------------------------------------------- goals
  goal_g_short: [
    'Goal!', 'It\'s in!', 'In the net!', 'Scored!', 'In it goes!', 'They score!',
  ],
  goal_own_g: [
    'Oh, it\'s gone in off a defender!', 'Own goal! That\'s a cruel one!', 'Off their own player and in!',
  ],
  goal_celebrate_g: [
    'What a moment!', 'Listen to that!', 'The place goes wild!', 'Huge goal!', 'What a time to score!', 'Get in!',
  ],
  goal_counter_g: [
    'That came from nowhere. One clear, and it\'s in the net.', 'Counter-attacking at its best.', 'Caught on the break, and punished.',
  ],
  goal_pressure_g: [
    'That pressure finally tells.', 'They kept knocking, and it finally opened.', 'Sustained pressure, and they get their reward.',
  ],
  goal_solo_g: [
    'That\'s all individual skill.', 'A solo effort, start to finish.', 'Took it all the way on their own.',
  ],
  goal_team_g: [
    'Great team goal.', 'Beautiful passing, and a clinical finish.', 'That\'s how you play as a team.',
  ],
  an_replay_g: [
    'Let\'s have another look at this one.', 'Watch the build-up here.', 'Here it is again.', 'Look at the space they found.',
    'Watch the rotation on this.', 'Here\'s how it happened.',
  ],

  // ---------------------------------------------------------------- the clock
  t120_g: [
    'Two minutes to play.', 'Into the final two minutes.',
  ],
  t120_tie: [
    'Two minutes to go, and it\'s all square.', 'Two minutes left, and nothing between them.',
  ],
  t120_close: [
    'Two minutes left, and {team} hold a slender lead.', 'Two to go. {team} are in front, but only just.',
  ],
  t5_g: [
    'Five seconds!', 'Final seconds!', 'Last chance!', 'Seconds left!',
  ],
  zero_g: [
    'Zero on the clock!', // 2.1.2: short, so it's said before the ball lands (not recorded yet)
    'Zero on the clock! The ball has to touch the ground!', 'Zero seconds! It\'s not over until it hits the floor!',
    'The clock\'s at zero, but the ball\'s still alive!',
  ],
  ot_1min: [
    'We\'re a minute into overtime.', 'One minute of overtime gone.',
  ],
  ot_2min: [
    'Two minutes of overtime, and still nothing.', 'Two minutes into overtime now.',
  ],
  ot_long: [
    'This overtime just keeps going!', 'Neither team can find the winner.', 'This is a marathon of an overtime.',
  ],

  // ---------------------------------------------------------------- the story of the game
  momentum_run: [
    '{team} have scored the last two.', 'That\'s back-to-back goals for {team}.', '{team} have all the momentum now.', '{team} are on a roll.',
  ],
  unanswered: [
    'That\'s {run} unanswered goals.', '{run} goals in a row now.',
  ],
  comeback: [
    'Here come {team}!', '{team} are fighting back!', 'Game on! {team} are back in this!',
  ],
  // 2.1.2 (not recorded yet: until they are, the lines nearest in meaning are used)
  need_something: [
    '{team} need something here, otherwise this might be too far to come back from.',
  ],
  series_clinch: [
    '{team} are one win away from the series, and this game is all but over.',
    '{team} are about to close out this series.',
    'This series is nearly wrapped up. {team} are cruising.',
  ],
  series_won: [
    'And that\'s the series! {team} take it!',
    '{team} win the series!',
    '{team} close it out, and the series is theirs!',
  ],
  need_goal: [
    '{team} need a goal here.', '{team} have to find something soon.', 'Time is running out for {team}.',
  ],
  color_team: [
    '{team} have looked dangerous every time they come forward.', '{team} need to settle down and find their rhythm.',
    '{team} are controlling the tempo right now.', '{team} are playing with real confidence.', '{team} have been solid at the back.',
    '{team} are pushing high, and that\'s risky.', 'You can see {team} growing into this game.', '{team} have to be careful on the counter.',
  ],
  color_player: [
    '{name} has been everywhere in this one.', '{name} is having a big game.', '{name} keeps showing up in the right places.',
    'Watch {name}, always in the play.',
  ],
  filler_g_color: [
    'Good rotations from both sides so far.', 'The boost control has been excellent.', 'Nobody wants to make the first mistake.',
    'It\'s all about the next touch here.', 'This is a real chess match.', 'Both teams are reading the play well.',
    'You can feel the tension building.', 'The pace of this game is incredible.', 'Patience is going to be key.',
    'One mistake could decide this.', 'They have to be careful not to overcommit.', 'Smart positioning from the defense.',
    'The third player back is so important here.', 'That\'s the kind of control you love to see.', 'Every touch matters at this level.',
    'They\'re making the field feel very small.', 'Communication is everything in a moment like this.', 'This crowd is loving every second.',
    'Great speed on the rotations.', 'Neither side giving an inch.', 'You can\'t switch off for a second.', 'It\'s end to end out there.',
    'Very disciplined play right now.', 'The mechanics on show are ridiculous.', 'Keep an eye on the boost management here.',
    'The pressure is starting to build.', 'This is high level Rocket League.', 'That\'s a smart decision, not forcing it.',
    'The defense is holding firm.', 'They\'re looking for the right opening.', 'You have to be patient against a defense like this.',
    'Possession is going back and forth.', 'Huge energy in this one.', 'It\'s a battle in midfield.', 'Speed is the name of the game.',
    'Both teams trading blows.', 'Nobody is backing down.', 'This could go either way.', 'What a contest this is.',
    'The quality on display is outstanding.',
  ],
};

// who says it and how: pbp = calls the action, color = explains it
const PBP_LIVELY = ['kickoff_go', 'kickoff_ready', 'kickoff_won', 'kickoff_won_name', 'pbp_touch', 'pbp_touch_g', 'pbp_wall',
  'pbp_wall_g', 'pbp_aerial_g', 'pbp_ceiling_g', 'pbp_pass', 'pbp_pass_g', 'pbp_fifty_g', 'pbp_clear', 'pbp_clear_g', 'pbp_turnover_g',
  'pbp_dribble', 'pbp_flick_g', 'pbp_pressure', 'pbp_pressure_g', 'pbp_transition', 'pbp_transition_g', 'pbp_defend_g', 'pbp_flow_g', 'shot_g',
  'save_g_short', 'save_late', 'demo_numbers_g', 't120_g', 't120_tie', 't120_close', 'ot_1min', 'ot_2min', 'ot_long'];
const PBP_HYPE = ['rebound_g', 'close_g', 'demo_g_short', 'goal_g_short', 'goal_own_g', 'goal_celebrate_g', 't5_g', 'zero_g',
  'comeback', 'series_won'];
const COLOR_CALM = ['save_react_g', 'close_react_g', 'goal_counter_g', 'goal_pressure_g', 'goal_solo_g', 'goal_team_g', 'an_replay_g',
  'momentum_run', 'unanswered', 'need_goal', 'color_team', 'color_player', 'filler_g_color', 'need_something', 'series_clinch'];
const META = {};
for (const c of PBP_LIVELY) META[c] = { role: 'pbp', mood: 'lively' };
for (const c of PBP_HYPE) META[c] = { role: 'pbp', mood: 'hype' };
for (const c of COLOR_CALM) META[c] = { role: 'color', mood: 'calm' };
for (const c of Object.keys(LINES)) if (!META[c]) throw new Error(`lines2: no caster/mood for ${c}`);
for (const c of Object.keys(META)) if (!LINES[c]) throw new Error(`lines2: META lists unknown ${c}`);

module.exports = { LINES, META };
