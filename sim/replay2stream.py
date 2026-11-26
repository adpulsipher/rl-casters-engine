#!/usr/bin/env python3
"""Turn a Rocket League .replay into what the Stats API would have sent during that match
(the same JSONL format as the casters' match recorder), plus a ground-truth file of what
really happened (touches, passes, 50/50s, kickoffs, saves, near misses...) to grade the
engine against.

The stream is what a *player* in the match sees: no SPECTATOR fields (boost, car speed).
Goal replays aren't in replay files, so one is inserted after each goal (random length,
sometimes skipped), and the replayed touches are sent again during it, like the game does.

usage: replay2stream.py <replay> <out_dir> [--seed N]
"""
import sys, os, json, gzip, random, collections
import numpy as np
import subtr_actor as s

FPS = 30.0
GOAL_Y, POST_X, BAR_Z = 5120.0, 892.755, 642.775
TRUTH_STREAMS = ('pass', 'fifty_fifty', 'kickoff', 'center', 'rush', 'territorial_pressure', 'backboard', 'ceiling_shot', 'wall_aerial',
                 'wall_aerial_shot', 'one_timer', 'double_tap', 'flick', 'flip_reset', 'air_dribble', 'goal_context', 'half_volley',
                 'bump', 'whiff', 'controlled_play', 'ball_carry', 'aerial_goal', 'high_aerial_goal', 'long_distance_goal', 'own_half_goal',
                 'empty_net_goal', 'counter_attack_goal', 'passing_goal', 'flick_goal', 'ceiling_shot_goal', 'double_tap_goal', 'one_timer_goal')


def pid(x):
    return json.dumps(x, sort_keys=True) if x is not None else None


def convert(path, out_dir, seed=0):
    rnd = random.Random(seed)
    G = ['BallRigidBody', 'SecondsRemaining', 'CurrentTime', 'ReplicatedStateName']
    meta, arr = s.get_ndarray_with_info_from_replay_filepath(path, G, ['PlayerRigidBody'], fps=FPS)
    gi = {n: i for i, n in enumerate(meta['column_headers']['global_headers'])}
    rm = meta['replay_meta']
    roster = []
    for team, key in ((0, 'team_zero'), (1, 'team_one')):
        for p in rm.get(key) or []:
            roster.append({'name': p['name'], 'team': team, 'id': pid(p.get('remote_id'))})
    if len(roster) < 2:
        raise ValueError('no players')
    byid = {p['id']: p for p in roster}
    names = [p['name'] for p in roster]
    events = s.get_stats_events(path)['events']

    T0 = float(arr[0, gi['current time']])
    T = arr[:, gi['current time']].astype(float) - T0
    raw_state, secs = arr[:, gi['game state']], arr[:, gi['seconds remaining']]
    ball, vel = arr[:, 0:3], arr[:, 6:9]
    speed = np.linalg.norm(vel, axis=1)
    n = len(T)
    if n < FPS * 150:
        raise ValueError('too short to be a match')
    # the state numbers are indexes into each replay's own name table: work out which is which.
    # live play is the state the clock runs in; post-goal is the one right after the ball crosses the line.
    vals = np.unique(raw_state)
    step = int(FPS)
    def runs(v):
        idx = np.where(raw_state[:-step] == v)[0]
        return float(np.mean(secs[idx + step] != secs[idx])) if len(idx) > FPS * 5 else 0.0
    active = max(vals, key=runs)
    after = collections.Counter(raw_state[i] for i in range(1, n) if raw_state[i - 1] == active and raw_state[i] != active and abs(ball[i - 1][1]) > 4900)
    goal_state = after.most_common(1)[0][0] if after else None
    state = np.where(raw_state == active, 65, np.where(raw_state == goal_state, 95, 60)) if goal_state is not None else np.where(raw_state == active, 65, 60)
    frame_at = lambda t: int(min(n - 1, max(0, np.searchsorted(T, t))))
    who = lambda x: byid.get(pid(x))
    P = lambda p: {'Name': p['name'], 'Shortcut': names.index(p['name']) + 1, 'TeamNum': p['team']}

    # ---------------------------------------------------------------- facts (replay seconds)
    touches, stats, demos = [], [], []
    truth = collections.defaultdict(list)
    for e in events:
        st, pl, tm = e['meta']['stream'], e['payload']['payload'], e['meta']['timing']
        t = tm.get('time', tm.get('start_time', 0)) - T0
        if st == 'touch':
            p = who(pl.get('player'))
            if p: touches.append({'t': t, 'p': p, 'pos': pl.get('ball_position')})
        elif st == 'timeline':
            p = who(pl.get('player_id'))
            if p: stats.append({'t': pl['time'] - T0, 'kind': pl['kind'], 'p': p})
        elif st == 'demolition':
            a, v = who(pl.get('attacker')), who(pl.get('victim'))
            if a and v: demos.append({'t': pl['time'] - T0, 'a': a, 'v': v})
        elif st in TRUTH_STREAMS:
            pp = who(pl.get('player')) or who(pl.get('passer')) or who(e['meta'].get('primary_player'))
            truth[st].append({'time': t, 'end': (tm.get('end_time') - T0) if tm.get('end_time') is not None else None,
                              'player': pp['name'] if pp else None,
                              'receiver': (who(pl.get('receiver')) or {}).get('name'),
                              'team': 0 if e['meta'].get('team_is_team_0') else 1,
                              'payload': json.loads(json.dumps(pl, default=str))})
    for L in (touches, stats, demos):
        L.sort(key=lambda x: x['t'])

    def last_touch_before(t):
        best = None
        for x in touches:
            if x['t'] <= t: best = x
            else: break
        return best

    # ---------------------------------------------------------------- rounds (live play = state 65)
    rounds, cur = [], None
    for i in range(n):
        if state[i] == 65 and (i == 0 or state[i - 1] != 65):
            cur = {'go': i}
        if cur is not None and i > 0 and state[i] != 65 and state[i - 1] == 65:
            cur['end'] = i; cur['goal'] = bool(state[i] == 95); rounds.append(cur); cur = None
    if cur is not None:
        cur['end'] = n - 1; cur['goal'] = False; rounds.append(cur)
    if not rounds:
        raise ValueError('no live play')

    # ---------------------------------------------------------------- pass 1: goals, overtime, goal replays
    score, ot = [0, 0], False
    goals, shifts = [], []  # shifts: (replay-time boundary, seconds added)
    for ri, r in enumerate(rounds):
        if not ot and int(secs[r['go']]) == 0 and score[0] == score[1] and ri > 0:
            ot = True
        r['ot'] = ot
        if r['goal']:
            gt = T[r['end']]
            team = 0 if ball[r['end']][1] > 0 else 1
            score[team] += 1
            celeb_end = gt + 3.0
            nxt = rounds[ri + 1]['go'] if ri + 1 < len(rounds) else n - 1
            for i in range(r['end'], nxt):
                if state[i] != 95: celeb_end = T[i]; break
            rlen = 0.0 if (ot or rnd.random() < 0.25) else rnd.uniform(5.0, 8.0)
            goals.append({'round': ri, 't': gt, 'team': team, 'score': list(score), 'ot': ot, 'replay_at': celeb_end, 'rlen': rlen})
            if rlen: shifts.append((celeb_end, rlen))
            if ot: break
    final_round = goals[-1]['round'] if goals and goals[-1]['ot'] else len(rounds) - 1
    rounds = rounds[:final_round + 1]
    to_stream = lambda t: t + sum(L for b, L in shifts if t >= b)

    # ---------------------------------------------------------------- pass 2: the stream
    out = []
    def emit(t_replay, rec, stream_t=None):
        out.append((stream_t if stream_t is not None else to_stream(t_replay), rec))

    pstats = {p['name']: collections.Counter() for p in roster}
    score = [0, 0]
    live = {'last_team': 255, 'ot': False, 'replay': False}

    def state_msg(i):
        return {'e': 'UpdateState', 'd': {'MatchGuid': '', 'Players': [{**P(p), 'Score': pstats[p['name']]['score'], 'Goals': pstats[p['name']]['Goal'],
            'Shots': pstats[p['name']]['Shot'], 'Assists': pstats[p['name']]['Assist'], 'Saves': pstats[p['name']]['Save'],
            'Touches': pstats[p['name']]['touch'], 'CarTouches': 0, 'Demos': pstats[p['name']]['demo']} for p in roster],
            'Game': {'Teams': [{'Name': 'Blue', 'TeamNum': 0, 'Score': score[0]}, {'Name': 'Orange', 'TeamNum': 1, 'Score': score[1]}],
                     'PlaylistId': 6, 'TimeSeconds': int(secs[i]), 'bOvertime': live['ot'],
                     'Ball': {'Speed': float(speed[i]), 'TeamNum': live['last_team']}, 'bReplay': live['replay'],
                     'bHasWinner': False, 'Winner': '', 'Arena': 'Stadium_P', 'bHasTarget': False}}}

    emit(0, {'e': 'MatchCreated', 'd': {}}, 0.0)
    emit(0, {'e': 'MatchInitialized', 'd': {}}, 0.2)
    ti = si = di = 0
    clock_last = None
    for ri, r in enumerate(rounds):
        go_t, end = T[r['go']], r['end']
        live['ot'] = r['ot']
        emit(go_t - 3.0, {'e': 'CountdownBegin', 'd': {}})
        for i in range(max(0, r['go'] - 90), r['go']):  # the countdown: state updates, clock frozen
            if i % 3 == 0: emit(T[i], state_msg(i))
        emit(go_t, {'e': 'RoundStarted', 'd': {}})
        recent = []
        for i in range(r['go'], end + 1):
            t = T[i]
            while ti < len(touches) and touches[ti]['t'] <= t:
                x = touches[ti]; ti += 1
                if x['t'] < go_t - 0.05: continue  # not live play
                fi = frame_at(x['t'])
                pre, post = float(speed[max(0, fi - 1)]), float(speed[min(n - 1, fi + 2)])
                pos = x['pos'] or ball[fi].tolist()
                live['last_team'] = x['p']['team']
                pstats[x['p']['name']]['touch'] += 1
                rec = {'e': 'BallHit', 'd': {'Players': [P(x['p'])], 'Ball': {'PreHitSpeed': pre, 'PostHitSpeed': post, 'Location': {'X': pos[0], 'Y': pos[1], 'Z': pos[2]}}}}
                emit(x['t'] + 1 / FPS, rec)
                recent.append((x['t'], rec))
                truth['touch'].append({'time': to_stream(x['t']), 'player': x['p']['name'], 'team': x['p']['team'], 'pos': pos, 'speed': post})
            while si < len(stats) and stats[si]['t'] <= t:
                x = stats[si]; si += 1
                k = x['kind']
                if k in ('Goal', 'Assist'): continue  # sent with the goal below
                pstats[x['p']['name']][k] += 1
                pstats[x['p']['name']]['score'] += {'Save': 50, 'Shot': 20}.get(k, 0)
                if k == 'Save':
                    bp = ball[frame_at(x['t'])]
                    toline = GOAL_Y - abs(bp[1])
                    epic = bool(toline < 250 and abs(bp[0]) < POST_X + 150 and bp[2] < BAR_Z + 150)
                    emit(x['t'], {'e': 'StatfeedEvent', 'd': {'EventName': 'Save', 'Type': 'Save', 'MainTarget': P(x['p'])}})
                    if epic:
                        emit(x['t'] + 0.05, {'e': 'StatfeedEvent', 'd': {'EventName': 'EpicSave', 'Type': 'Epic Save', 'MainTarget': P(x['p'])}})
                    truth['save'].append({'time': to_stream(x['t']), 'player': x['p']['name'], 'team': x['p']['team'], 'to_line': float(toline), 'epic': epic})
                elif k == 'Shot':
                    emit(x['t'], {'e': 'StatfeedEvent', 'd': {'EventName': 'Shot', 'Type': 'Shot on Goal', 'MainTarget': P(x['p'])}})
                    truth['shot'].append({'time': to_stream(x['t']), 'player': x['p']['name'], 'team': x['p']['team']})
            while di < len(demos) and demos[di]['t'] <= t:
                x = demos[di]; di += 1
                pstats[x['a']['name']]['demo'] += 1
                emit(x['t'], {'e': 'StatfeedEvent', 'd': {'EventName': 'Demolish', 'Type': 'Demolition', 'MainTarget': P(x['a']), 'SecondaryTarget': P(x['v'])}})
                truth['demo'].append({'time': to_stream(x['t']), 'attacker': x['a']['name'], 'victim': x['v']['name'], 'team': x['a']['team']})
            emit(t, state_msg(i))
            sv = int(secs[i])
            if clock_last is None or sv != clock_last:
                clock_last = sv
                emit(t, {'e': 'ClockUpdatedSeconds', 'd': {'TimeSeconds': sv, 'bOvertime': live['ot']}})
        g = next((g for g in goals if g['round'] == ri), None)
        if not g:
            continue
        gt, team = g['t'], g['team']
        near = lambda k: [x for x in stats if x['kind'] == k and abs(x['t'] - gt) < 2.5]
        lt = last_touch_before(gt + 0.05)
        sc = next((x['p'] for x in near('Goal') if x['p']['team'] == team), None) or (lt['p'] if lt else roster[0])
        asst = next((x['p'] for x in near('Assist') if x['p']['team'] == team and x['p']['name'] != sc['name']), None)
        score[team] += 1
        pstats[sc['name']]['Goal'] += 1; pstats[sc['name']]['score'] += 100
        if asst: pstats[asst['name']]['Assist'] += 1; pstats[asst['name']]['score'] += 50
        gs = float(speed[max(0, end - 1)])
        d = {'GoalSpeed': gs, 'GoalTime': float(gt - go_t), 'ImpactLocation': {'X': float(ball[end][0]), 'Y': float(ball[end][1]), 'Z': float(ball[end][2])},
             'Scorer': P(sc), 'BallLastTouch': {'Player': P(lt['p'] if lt else sc), 'Speed': gs}}
        if asst: d['Assister'] = P(asst)
        emit(gt, {'e': 'GoalScored', 'd': d})
        emit(gt + 0.02, {'e': 'StatfeedEvent', 'd': {'EventName': 'Goal', 'Type': 'Goal', 'MainTarget': P(sc)}})
        if asst: emit(gt + 0.03, {'e': 'StatfeedEvent', 'd': {'EventName': 'Assist', 'Type': 'Assist', 'MainTarget': P(asst)}})
        for x in [x for x in demos if gt <= x['t'] < g['replay_at']]:  # demos in the celebration
            pass
        emit(gt + 0.1, state_msg(end))
        ctx = next((x for x in truth['goal_context'] if abs(x['time'] - gt) < 1.5), None)
        types = [k.replace('_goal', '') for k in TRUTH_STREAMS if k.endswith('_goal') and any(abs(x['time'] - gt) < 2.0 for x in truth[k])]
        truth['goal'].append({'time': to_stream(gt), 'scorer': sc['name'], 'team': team, 'assist': asst['name'] if asst else None,
                              'speed': gs, 'score': list(score), 'overtime': g['ot'], 'types': types,
                              'buildup': ctx['payload'].get('goal_buildup') if ctx else None, 'replay': g['rlen']})
        if g['rlen']:
            rs = to_stream(g['replay_at'] - 0.001)  # stream time the replay starts (before its own shift)
            emit(0, {'e': 'GoalReplayStart', 'd': {}}, rs)
            live['replay'] = True
            for (ht, rec) in recent:
                if ht > gt - g['rlen'] + 0.5:
                    emit(0, json.loads(json.dumps(rec)), rs + 0.3 + (ht - (gt - g['rlen'] + 0.5)))
            k = 0.0
            while k < g['rlen']:
                emit(0, state_msg(end), rs + k); k += 1 / FPS
            live['replay'] = False
            emit(0, {'e': 'GoalReplayWillEnd', 'd': {}}, rs + g['rlen'] - 0.4)
            emit(0, {'e': 'GoalReplayEnd', 'd': {}}, rs + g['rlen'])

    end_t = T[rounds[-1]['end']]
    winner = 0 if score[0] > score[1] else 1
    emit(end_t + 0.1, {'e': 'MatchEnded', 'd': {'WinnerTeamNum': winner}})
    emit(end_t + 4.0, {'e': 'PodiumStart', 'd': {}})
    emit(end_t + 14.0, {'e': 'MatchDestroyed', 'd': {}})

    # ---------------------------------------------------------------- the ball's real path: near misses and the woodwork
    for r in rounds:
        i = r['go']
        while i < r['end']:
            b, v = ball[i], vel[i]
            ay = abs(b[1])
            if ay > 4950 and np.sign(v[1]) == np.sign(b[1]) and abs(v[1]) > 400:
                x, z = abs(b[0]), b[2]
                wide = POST_X + 40 < x < POST_X + 500 and z < 900
                over = x < POST_X and BAR_Z + 40 < z < BAR_Z + 450
                goal_soon = r['goal'] and T[r['end']] - T[i] < 1.5
                if (wide or over) and not goal_soon:
                    lt = last_touch_before(T[i])
                    att = 0 if b[1] > 0 else 1
                    truth['near_miss'].append({'time': to_stream(T[i]), 'kind': 'wide' if wide else 'over', 'team': att,
                                               'by': lt['p']['name'] if lt and lt['p']['team'] == att else None,
                                               'dist': float(x - POST_X if wide else z - BAR_Z), 'touch_time': to_stream(lt['t']) if lt else None})
                    i += int(FPS * 1.5); continue
            near_post = abs(abs(b[0]) - POST_X) < 140 and b[2] < BAR_Z + 60
            near_bar = abs(b[2] - BAR_Z) < 140 and abs(b[0]) < POST_X + 60
            if ay > GOAL_Y - 160 and (near_post or near_bar) and i + 3 < n and np.sign(vel[i + 3][1]) != np.sign(v[1]) and abs(v[1]) > 300:
                lt = last_touch_before(T[i])
                truth['woodwork'].append({'time': to_stream(T[i]), 'kind': 'post' if near_post else 'bar', 'speed': float(speed[i]),
                                          'by': lt['p']['name'] if lt else None})
                emit(T[i] + 1 / FPS, {'e': 'CrossbarHit', 'd': {'BallLocation': {'X': float(b[0]), 'Y': float(b[1]), 'Z': float(b[2])},
                     'BallSpeed': float(speed[i]), 'ImpactForce': float(abs(v[1])),
                     'BallLastTouch': {'Player': P(lt['p'] if lt else roster[0]), 'Speed': float(speed[i])}}})
                i += int(FPS * 1.0); continue
            i += 1
    for k, L in truth.items():
        if k in ('touch', 'save', 'shot', 'demo', 'goal', 'near_miss', 'woodwork'):
            continue
        for x in L:
            x['time'] = to_stream(x['time'])
            if x.get('end') is not None: x['end'] = to_stream(x['end'])
    out.sort(key=lambda x: x[0])

    base = os.path.splitext(os.path.basename(path))[0]
    os.makedirs(out_dir, exist_ok=True)
    with gzip.open(os.path.join(out_dir, base + '.jsonl.gz'), 'wt') as f:
        f.write(json.dumps({'t': 0, 'k': 'header', 'source': 'replay', 'replay': os.path.basename(path), 'players': names, 'seed': seed}) + '\n')
        for t, r in out:
            f.write(json.dumps({'t': int(round(t * 1000)), **r}) + '\n')
    summary = {'replay': os.path.basename(path), 'players': roster, 'score': score, 'overtime': bool(goals and goals[-1]['ot']),
               'team_size': len(roster) // 2, 'duration': float(out[-1][0]), 'counts': {k: len(v) for k, v in truth.items()}}
    with open(os.path.join(out_dir, base + '.truth.json'), 'w') as f:
        json.dump({'summary': summary, **truth}, f, default=str)
    return summary


if __name__ == '__main__':
    seed = int(sys.argv[sys.argv.index('--seed') + 1]) if '--seed' in sys.argv else 0
    print(json.dumps(convert(sys.argv[1], sys.argv[2], seed)))
