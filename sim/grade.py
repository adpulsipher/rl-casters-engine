#!/usr/bin/env python3
"""Run the casters' engine over many real matches and grade it against what really happened.

usage: grade.py [--pack full|current] [--n 76] [--jobs 2] [--tag name] [--seed0 100]
               [--streams sim/data/streams] [--inventory sim/data/inventory.json] [--out sim/out]
Writes <out>/<tag>/{metrics.json,report.txt} and prints the report.
"""
import sys, os, json, glob, gzip, subprocess, statistics, collections, random, re, math
from concurrent.futures import ThreadPoolExecutor

args = sys.argv[1:]
opt = lambda k, d: args[args.index(k) + 1] if k in args else d
HERE = os.path.dirname(os.path.abspath(__file__))
PACK = opt('--pack', 'full')
N, JOBS = int(opt('--n', '76')), int(opt('--jobs', '2'))
TAG = opt('--tag', PACK)
STREAMS = opt('--streams', os.path.join(HERE, 'data', 'streams'))
INVENTORY = opt('--inventory', os.path.join(HERE, 'data', 'inventory.json'))
OUT = os.path.join(opt('--out', os.path.join(HERE, 'out')), TAG)
os.makedirs(OUT, exist_ok=True)

GOAL_CALL = {'goal', 'goal_generic', 'goal_g_short', 'goal_ot', 'goal_ot_generic', 'goal_rout', 'goal_rout_generic', 'goal_consolation',
             'goal_consolation_generic', 'goal_own_g'}
SAVE_CALL = {'save', 'save_generic', 'save_g_short', 'save_again', 'epicsave', 'epicsave_generic'}
EPIC_CALL = {'epicsave', 'epicsave_generic'}
SHOT_CALL = {'shot', 'shot_g'}
DEMO_CALL = {'demo', 'demo_victim', 'demo_generic', 'demo_g_short'}
BAR_CALL = {'crossbar', 'crossbar_generic', 'close_g'}
MISS_CALL = {'nearmiss_g', 'nearmiss_name'}
TOUCH_NAMED = {'pbp_touch', 'pbp_wall', 'pbp_dribble', 'pbp_clear', 'bighit_clear', 'bighit_attack', 'aerial', 'pbp_pass'}
SCORE_LINES = {'score_now', 'score_tie', 'end_score'}
LIVE_ONLY = TOUCH_NAMED | {'pbp_touch_g', 'pbp_wall_g', 'pbp_aerial_g', 'pbp_ceiling_g', 'pbp_pass_g', 'pbp_fifty_g', 'pbp_clear_g',
                           'pbp_turnover_g', 'pbp_flick_g', 'pbp_pressure_g', 'pbp_pressure', 'pbp_transition', 'pbp_transition_g', 'shot', 'shot_g',
                           'save', 'save_generic', 'save_g_short', 'epicsave', 'epicsave_generic', 'nearmiss_g', 'nearmiss_name', 'rebound_g'}
NUM = 'zero one two three four five six seven eight nine ten'.split()


def streams():
    fs = sorted(glob.glob(os.path.join(STREAMS, '*.jsonl.gz')))
    ok = []
    for f in fs:
        t = f.replace('.jsonl.gz', '.truth.json')
        if not os.path.exists(t): continue
        s = json.load(open(t))['summary']
        if s['duration'] < 200 or s['counts'].get('touch', 0) < 60: continue
        ok.append(f)
    random.Random(7).shuffle(ok)
    return ok[:N]


def run(f, i):
    out = f'{OUT}/{os.path.basename(f)}.json'
    cmd = ['node', os.path.join(HERE, 'simulate.js'), f, '--out', out, '--pack', PACK, '--inventory', INVENTORY, '--seed', str(int(opt('--seed0', '100')) + i)]
    if i % 2 == 0: cmd.append('--hub')
    if i % 5 == 0: cmd += ['--transcript', out.replace('.json', '.txt')]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    if r.returncode != 0:
        return {'stream': os.path.basename(f), 'crash': (r.stderr or r.stdout)[-800:]}
    return measure(f, json.load(open(out)))


def overlap(a, b, c, d):
    return max(0.0, min(b, d) - max(a, c))


def measure(f, res):
    rows = [json.loads(l) for l in gzip.open(f, 'rt')]
    truth = json.load(open(f.replace('.jsonl.gz', '.truth.json')))
    ren = res['rename']
    R = lambda n: ren.get(n, n)
    ev = [(r['t'] / 1000.0, r['e'], r.get('d', {})) for r in rows if r.get('e')]
    # live play intervals and replay intervals
    live, rep, start = [], [], None
    rstart = None
    for t, e, d in ev:
        if e == 'RoundStarted': start = t
        elif e in ('GoalScored', 'MatchEnded', 'CountdownBegin') and start is not None:
            live.append((start, t)); start = None
        if e == 'GoalReplayStart': rstart = t
        if e == 'GoalReplayEnd' and rstart is not None: rep.append((rstart, t)); rstart = None
    tl = [dict(x, start=x['start'] / 1000.0, end=x['end'] / 1000.0) for x in res['timeline']]
    live_total = sum(b - a for a, b in live) or 1
    talk = sum(overlap(a, b, x['start'], x['end']) for a, b in live for x in tl)
    # silences inside live play
    gaps = []
    for a, b in live:
        segs = sorted((max(a, x['start']), min(b, x['end'])) for x in tl if x['end'] > a and x['start'] < b)
        cur = a
        for s0, s1 in segs:
            if s0 > cur: gaps.append(s0 - cur)
            cur = max(cur, s1)
        if b > cur: gaps.append(b - cur)
    long_gap_time = sum(g for g in gaps if g > 3.0)
    counts = collections.Counter(x['text'] for x in tl)
    said = len(tl)
    repeats = sum(c - 1 for c in counts.values())
    triple = sum(1 for c in counts.values() if c >= 3)
    b2b = sum(1 for p, q in zip(tl, tl[1:]) if p['cat'] == q['cat'] and p['cat'] not in GOAL_CALL | {'?'} and q['start'] - p['end'] < 3)
    # a shot call cut off by the save or the goal is how a real call sounds ("shoots - SAVED!"); any other cut is choppy
    def natural_cut(i, x):
        nxt = tl[i + 1] if i + 1 < len(tl) else None
        return x['cat'] in SHOT_CALL and nxt is not None and nxt['cat'] in SAVE_CALL | GOAL_CALL | BAR_CALL
    cuts = sum(1 for i, x in enumerate(tl) if x.get('how') == 'cut' and not natural_cut(i, x))
    goal_cut = sum(1 for x in tl if x.get('how') == 'cut' and x['cat'] in GOAL_CALL)
    cats = collections.Counter(x['cat'] for x in tl)

    def first_line(cats, lo, hi):
        c = [x for x in tl if x['cat'] in cats and lo <= x['start'] <= hi]
        return min(c, key=lambda x: x['start']) if c else None

    goals = truth.get('goal', [])
    goal_lat, goal_hit = [], 0
    for g in goals:
        x = first_line(GOAL_CALL, g['time'] - 0.1, g['time'] + 2.0)
        if x: goal_hit += 1; goal_lat.append(x['start'] - g['time'])
    gtimes = [g['time'] for g in goals]
    in_live = lambda t: any(a <= t <= b for a, b in live)
    saves = [s for s in truth.get('save', []) if in_live(s['time']) and not any(0 <= gt - s['time'] < 1.2 for gt in gtimes)]
    # close-game saves are the ones that must be called
    def close_at(t):
        sc = [0, 0]
        for g in goals:
            if g['time'] < t: sc = g['score']
        return abs(sc[0] - sc[1]) <= 2
    save_lat, save_hit, save_n = [], 0, 0
    epic_n = epic_hit = 0
    for s in saves:
        if not close_at(s['time']): continue
        save_n += 1
        x = first_line(SAVE_CALL, s['time'] - 0.05, s['time'] + 1.5)
        if x: save_hit += 1; save_lat.append(x['start'] - s['time'])
        if s.get('epic'):
            epic_n += 1
            if first_line(EPIC_CALL, s['time'] - 0.05, s['time'] + 1.6): epic_hit += 1
    demos = [d for d in truth.get('demo', []) if in_live(d['time']) and close_at(d['time'])]
    demo_hit = sum(1 for d in demos if first_line(DEMO_CALL, d['time'] - 0.05, d['time'] + 2.0))
    wood = [w for w in truth.get('woodwork', []) if in_live(w['time']) and not any(0 <= gt - w['time'] < 1.0 for gt in gtimes)]
    wood_hit = sum(1 for w in wood if first_line(BAR_CALL, w['time'] - 0.05, w['time'] + 1.5))
    misses = [m for m in truth.get('near_miss', []) if in_live(m['time'])]
    miss_hit = sum(1 for m in misses if first_line(MISS_CALL, (m.get('touch_time') or m['time']) - 0.1, m['time'] + 1.6))

    # ------------------------------------------------------------ is what was said true?
    delays = []  # how long after the thing it describes each call started
    def near(events, t, lo, hi, key='time'):
        m = [e for e in events if e.get(key) is not None and lo <= t - e[key] <= hi]
        if m: delays.append(min(t - e[key] for e in m))
        return m
    wrong = collections.Counter(); checked = collections.Counter()
    touch_fresh = []
    touches = truth.get('touch', [])
    names_pack = set(ren.values())
    for x in tl:
        c, t, text = x['cat'], x['start'], x['text']
        def chk(k, ok):
            checked[k] += 1
            if not ok: wrong[k] += 1; x['wrong'] = k
        if c in SAVE_CALL: chk('save', bool(near(saves + truth.get('save', []), t, -0.1, 1.8)))
        if c in GOAL_CALL: chk('goal', bool(near(goals, t, -0.2, 2.5)))
        if c in SHOT_CALL: chk('shot', bool(near(truth.get('shot', []), t, -0.1, 1.2)))
        if c in DEMO_CALL: chk('demo', bool(near(truth.get('demo', []), t, -0.1, 2.5)))
        if c in BAR_CALL: chk('woodwork', bool(near(truth.get('woodwork', []), t, -0.1, 2.0)))
        if c in MISS_CALL: chk('near_miss', bool(near(truth.get('near_miss', []) + truth.get('woodwork', []), t, -0.6, 2.5)))
        if c in ('pbp_pass', 'pbp_pass_g'): chk('pass', bool([p for p in truth.get('pass', []) if p.get('end') is not None and -0.6 <= t - p['end'] <= 1.8]))
        if c == 'pbp_fifty_g': chk('fifty', bool([p for p in truth.get('fifty_fifty', []) if (p['time'] - 0.5) <= t <= (p.get('end') or p['time']) + 1.6]))
        if c in ('pbp_transition', 'pbp_transition_g'):
            # the play really turned: that team was on the ball in its own third, then in the other half
            att = lambda u: u['pos'][1] if u['team'] == 0 else -u['pos'][1]
            recent = [u for u in touches if 0 <= t - u['time'] <= 4.5]
            teams_ok = [tm for tm in (0, 1) if any(u['team'] == tm and att(u) < -1707 for u in recent) and any(u['team'] == tm and att(u) > 0 and t - u['time'] <= 2.0 for u in recent)]
            chk('transition', bool(teams_ok))
        if c in ('pbp_pressure', 'pbp_pressure_g', 'filler_pressure'):
            chk('pressure', bool([p for p in truth.get('territorial_pressure', []) if p['time'] - 2 <= t <= (p.get('end') or p['time']) + 2]))
        if c in ('kickoff_won', 'kickoff_won_name', 'kickoff_even'):
            k = [k for k in truth.get('kickoff', []) if k['time'] - 1 <= t <= k['time'] + 12]
            if k:
                adv = k[-1]['payload'].get('advantage', '')
                if c == 'kickoff_even': chk('kickoff', adv == 'no_advantage')
                else:
                    team = None
                    if c == 'kickoff_won_name':
                        nm = next((n for n in names_pack if n and n in text), None)
                        team = next((p['team'] for p in truth['summary']['players'] if R(p['name']) == nm), None)
                    else:
                        tn = res.get('hubTeams') or ['Blue', 'Orange']
                        team = 0 if tn[0] in text else 1 if tn[1] in text else None
                    if team is not None: chk('kickoff', (adv.startswith('team_zero') and team == 0) or (adv.startswith('team_one') and team == 1))
        # a player's name on a touch call: they really were on the ball a moment ago
        if c in TOUCH_NAMED:
            nm = next((n for n in sorted(names_pack, key=len, reverse=True) if n and n in text), None)
            if nm:
                orig = [o for o, p in ren.items() if p == nm]
                mt = [u for u in touches if u['player'] in orig and -0.2 <= t - u['time'] <= 3.0]
                chk('named', bool(mt))
                if mt: touch_fresh.append(min(t - u['time'] for u in mt))
        if c in SCORE_LINES:
            sc = [0, 0]
            for g in goals:
                if g['time'] <= t + 0.2: sc = g['score']
            hi_, lo_ = max(sc), min(sc)
            ok = (NUM[hi_] in text.lower() if hi_ < 11 else True) and (lo_ == 0 or NUM[lo_] in text.lower() or 'apiece' in text or 'all' in text.lower())
            chk('score', ok)
        if c in LIVE_ONLY and any(a + 0.3 <= t <= b for a, b in rep): chk('in_replay', False)
    stale = sum(1 for d in delays if d > 1.5)
    # is a team-context line true? (who leads, who's chasing, who scored the last two)
    tn = res.get('hubTeams') or ['Blue', 'Orange']
    def team_in(text):
        hits = [i for i in (0, 1) if tn[i] in text]
        return hits[0] if len(hits) == 1 else None
    def score_at(t):
        sc = [0, 0]
        for g in goals:
            if g['time'] <= t + 0.2: sc = g['score']
        return sc
    ctx_checked = ctx_wrong = 0
    ctx_samples = []
    for x in tl:
        c, t = x['cat'], x['start']
        team = team_in(x['text'])
        if team is None: continue
        sc = score_at(t); lead = sc[team] - sc[1 - team]
        rule = {
            'filler_leading': lead >= 2, 'filler_trailing': lead < 0, 'need_goal': lead < 0, 'kickoff_lead': lead > 0,
            't60_close': lead == 1, 't30_close': lead == 1, 't10_close': lead == -1, 't120_close': lead == 1, 't60_big': lead >= 2,
            'momentum_run': len(goals) >= 2 and all(g['team'] == team for g in [g for g in goals if g['time'] <= t + 0.2][-2:]),
            'comeback': lead >= 0, 'score_take_lead': lead >= 1, 'score_extend': lead >= 2, 'score_equalize': lead == 0, 'score_pull_back': lead < 0,
            'end_winner': lead > 0, 'end_loser': lead < 0, 'end': lead > 0, 'end_close': lead > 0, 'end_blowout': lead > 0,
        }.get(c)
        if rule is None: continue
        ctx_checked += 1
        if not rule: ctx_wrong += 1; ctx_samples.append((round(t, 1), c, x['text'], sc))
    # hype is for big moments
    big = [g['time'] for g in goals] + [s_['time'] for s_ in truth.get('save', []) if s_.get('epic')] + [w['time'] for w in truth.get('woodwork', [])]
    ends = [t for t, e, d in ev if e in ('MatchEnded',)]
    hype_cats_ok = {'zero_g', 't5_g', 'ot', 'goal_ot', 'goal_ot_generic', 'end', 'end_close', 'end_ot', 'demo_g_short', 'rebound_g', 'epicsave', 'epicsave_generic'}
    hype = [x for x in tl if x['mood'] == 'hype']
    hype_bad = [x for x in hype if x['cat'] not in hype_cats_ok and not any(-0.5 <= x['start'] - b <= 14 for b in big + ends)]
    # the same player named again and again
    named = [(x['start'], n) for x in tl for n in names_pack if n and n in x['text']]
    spam = 0
    for i, (t, n) in enumerate(named):
        if sum(1 for (t2, n2) in named if n2 == n and t <= t2 < t + 30) > 4: spam += 1
    # replays: the caster should be talking over them
    rep_total = sum(b - a for a, b in rep) or 0
    rep_talk = sum(overlap(a, b, x['start'], x['end']) for a, b in rep for x in tl)
    # long colour talking over the kickoff
    kick = [t for t, e, d in ev if e == 'RoundStarted']
    over_kick = sum(1 for k in kick for x in tl if x['cat'] not in ('kickoff_go', 'kickoff', 'kickoff_ready') and x['start'] < k + 0.5 and x['end'] > k + 1.5 and x['role'] == 'color')
    p = lambda xs, q: (sorted(xs)[min(len(xs) - 1, int(math.ceil(q * len(xs))) - 1)] if xs else None)
    return {
        'stream': os.path.basename(f), 'errors': len(res['errors']), 'error_samples': res['errors'][:2],
        'live_s': live_total, 'talk_ratio': talk / live_total, 'gap_p95': p(gaps, 0.95), 'gap_max': max(gaps) if gaps else 0,
        'long_gap_share': long_gap_time / live_total, 'lines': said, 'repeat_share': repeats / max(1, said), 'triples': triple,
        'max_uses': max(counts.values()) if counts else 0, 'b2b_cat': b2b, 'cuts': cuts, 'goal_cut': goal_cut,
        'goals': len(goals), 'goal_hit': goal_hit, 'goal_lat': goal_lat, 'saves': save_n, 'save_hit': save_hit, 'save_lat': save_lat,
        'epic': epic_n, 'epic_hit': epic_hit, 'demos': len(demos), 'demo_hit': demo_hit, 'wood': len(wood), 'wood_hit': wood_hit,
        'misses': len(misses), 'miss_hit': miss_hit, 'checked': dict(checked), 'wrong': dict(wrong), 'stale': stale, 'calls': len(delays),
        'touch_fresh': sum(1 for d in touch_fresh if d <= 1.2), 'touch_named': len(touch_fresh),
        'ctx_checked': ctx_checked, 'ctx_wrong': ctx_wrong, 'ctx_samples': ctx_samples[:4], 'hype': len(hype), 'hype_bad': len(hype_bad),
        'hype_samples': [(round(x['start'], 1), x['cat'], x['text']) for x in hype_bad[:3]], 'spam': spam, 'named_lines': len(named),
        'rep_total': rep_total, 'rep_talk': rep_talk, 'kickoffs': len(kick), 'over_kick': over_kick,
        'cats': dict(cats), 'unique_cats': len(cats),
        'wrong_samples': [(round(x['start'], 1), x['cat'], x['text'], x['wrong']) for x in tl if x.get('wrong')][:8],
    }


NA = object()


def lin(v, bad, good):
    """partial credit: 0 at bad, 1 at good (either direction)"""
    if v is None: return 0.0
    if bad == good: return 1.0 if v == good else 0.0
    x = (v - bad) / (good - bad)
    return max(0.0, min(1.0, x))


def grade(ms):
    ok = [m for m in ms if 'crash' not in m]
    S = lambda k: sum(m[k] for m in ok)
    allv = lambda k: [v for m in ok for v in m[k]]
    pct = lambda xs, q: sorted(xs)[min(len(xs) - 1, max(0, int(math.ceil(q * len(xs))) - 1))] if xs else None
    med = lambda xs: statistics.median(xs) if xs else None
    checked, wrong = collections.Counter(), collections.Counter()
    for m in ok: checked.update(m['checked']); wrong.update(m['wrong'])
    prec = lambda k: 1 - wrong[k] / checked[k] if checked[k] else None
    event_keys = ['save', 'goal', 'shot', 'demo', 'woodwork']
    ev_wrong = sum(wrong[k] for k in event_keys); ev_checked = sum(checked[k] for k in event_keys)
    pbp_keys = ['pass', 'fifty', 'transition', 'pressure', 'kickoff']
    pbp_prec = [prec(k) for k in pbp_keys if checked[k] >= 5]
    ratios = [m['talk_ratio'] for m in ok]
    r = {}
    items = []
    def item(group, name, weight, score, value):
        items.append({'group': group, 'name': name, 'weight': weight, 'score': round(score, 3), 'points': round(weight * score, 2), 'value': value})
    gl, sl = allv('goal_lat'), allv('save_lat')
    calls = S('calls')
    # 1. timing (18)
    item('Timing', 'Goal call starts fast (p90 latency, s)', 4, lin(pct(gl, .9), 1.2, 0.45), pct(gl, .9))
    item('Timing', 'Save call starts fast (p90 latency, s)', 4, lin(pct(sl, .9), 1.4, 0.75), pct(sl, .9))
    item('Timing', 'No stale calls (event calls started >1.5 s after the event)', 5, lin(S('stale') / max(1, calls), 0.08, 0.01), S('stale') / max(1, calls))
    item('Timing', 'Named touch calls while the touch is fresh (<=1.2 s)', 5, lin(S('touch_fresh') / S('touch_named'), 0.6, 0.9) if S('touch_named') else 0.0,
         S('touch_fresh') / max(1, S('touch_named')))
    # 2. coverage (14)
    item('Coverage', 'Goals called', 5, lin(S('goal_hit') / max(1, S('goals')), 0.9, 1.0), S('goal_hit') / max(1, S('goals')))
    item('Coverage', 'Saves called (close games)', 4, lin(S('save_hit') / max(1, S('saves')), 0.6, 0.85), S('save_hit') / max(1, S('saves')))
    item('Coverage', 'Saves on the line called as big saves', 2, lin(S('epic_hit') / max(1, S('epic')), 0.3, 0.7), S('epic_hit') / max(1, S('epic')))
    item('Coverage', 'Demos called (close games)', 1.5, lin(S('demo_hit') / S('demos'), 0.3, 0.6) if S('demos') else 1.0, f"{S('demo_hit')}/{S('demos')}")
    item('Coverage', 'Woodwork called', 1.5, lin(S('wood_hit') / S('wood'), 0.5, 0.8) if S('wood') else 1.0, f"{S('wood_hit')}/{S('wood')}")
    # 3. accuracy (22)
    item('Accuracy', 'Event calls true (save/goal/shot/demo/woodwork)', 7, lin(1 - ev_wrong / max(1, ev_checked), 0.9, 0.98), 1 - ev_wrong / max(1, ev_checked))
    item('Accuracy', 'Named touch calls name the right player', 3, lin(prec('named'), 0.95, 0.99), prec('named'))
    item('Accuracy', 'Score lines correct', 3, lin(prec('score'), 0.9, 1.0), prec('score'))
    item('Accuracy', 'Play-by-play reads true (pass, 50/50, transition, pressure, kickoff)', 4,
         lin(statistics.mean(pbp_prec), 0.6, 0.85) if pbp_prec else 1.0, {k: (round(prec(k), 3) if prec(k) is not None else None, checked[k]) for k in pbp_keys})
    cw = 1 - S('ctx_wrong') / max(1, S('ctx_checked'))
    item('Accuracy', 'Team-context lines true (who leads, chases, has momentum)', 3, lin(cw, 0.85, 0.99), f"{cw:.3f} of {S('ctx_checked')}")
    hb = S('hype_bad') / max(1, S('hype'))
    item('Accuracy', 'Hype saved for big moments (share of hype lines away from one)', 2, lin(hb, 0.25, 0.05), hb)
    # 4. pace (15)
    mr = statistics.mean(ratios) if ratios else 0
    item('Pace', 'Talk ratio in live play near broadcast pace (0.55-0.78)', 4, 1.0 if 0.55 <= mr <= 0.78 else lin(mr, 0.35, 0.55) if mr < 0.55 else lin(mr, 0.9, 0.78), mr)
    gp = pct([m['gap_p95'] for m in ok if m['gap_p95'] is not None], .5)
    item('Pace', 'Silences short (median of match p95 silence, s)', 4, lin(gp, 6.0, 3.5), gp)
    gm = pct([m['gap_max'] for m in ok], .5)
    item('Pace', 'No long dead air (median of match longest silence, s)', 4, lin(gm, 14.0, 7.0), gm)
    rt = S('rep_talk') / max(1, S('rep_total'))
    item('Pace', 'Talking over goal replays (share of replay time)', 3, lin(rt, 0.3, 0.6), rt)
    # 5. repetition (15)
    trip = S('triples')
    item('Repetition', 'No line said 3+ times in a match (hard rule)', 6, 1.0 if trip == 0 else 0.0, trip)
    rs = statistics.mean([m['repeat_share'] for m in ok]) if ok else 1
    item('Repetition', 'Repeat share (lines said twice)', 3, lin(rs, 0.3, 0.12), rs)
    b2 = S('b2b_cat') / max(1, S('lines'))
    item('Repetition', 'Same kind of line back to back', 2, lin(b2, 0.15, 0.04), b2)
    uc = statistics.mean([m['unique_cats'] for m in ok]) if ok else 0
    item('Repetition', 'Variety (kinds of line per match)', 2, lin(uc, 15, 35), uc)
    sp = S('spam') / max(1, S('named_lines'))
    item('Repetition', 'Nobody named 5+ times in 30 s', 2, lin(sp, 0.15, 0.02), sp)
    # 6. flow (6)
    cr = S('cuts') / max(1, S('lines'))
    item('Flow', 'Lines cut off (share, a shot call cut by its save/goal excluded)', 3, lin(cr, 0.2, 0.08), cr)
    item('Flow', 'Goal calls never cut', 1, 1.0 if S('goal_cut') == 0 else 0.0, S('goal_cut'))
    ok_ = S('over_kick') / max(1, S('kickoffs'))
    item('Flow', 'No long analysis running over the kickoff', 2, lin(ok_, 0.3, 0.05), ok_)
    # 7. robustness (10)
    crashes = len(ms) - len(ok)
    item('Robustness', 'No crashes or engine errors across all matches', 4, 1.0 if crashes == 0 and S('errors') == 0 else 0.0, {'crashes': crashes, 'errors': S('errors')})
    item('Robustness', 'Replays: no live calls during goal replays', 3, lin(wrong['in_replay'], 5, 0), wrong['in_replay'])
    item('Robustness', 'Match variety handled (1v1/2v2/3v3, overtime, skipped replays)', 3, 1.0 if crashes == 0 else 0.0, len(ok))
    total = sum(i['points'] for i in items)
    return total, items, {'matches': len(ok), 'checked': dict(checked), 'wrong': dict(wrong)}


if __name__ == '__main__':
    fs = streams()
    print(f'{len(fs)} matches, pack={PACK}', flush=True)
    with ThreadPoolExecutor(JOBS) as ex:
        ms = list(ex.map(lambda a: run(*a), [(f, i) for i, f in enumerate(fs)]))
    json.dump(ms, open(f'{OUT}/metrics.json', 'w'), default=str)
    total, items, extra = grade(ms)
    lines = [f'GRADE {total:.1f} / 100   ({extra["matches"]} matches, pack={PACK})', '']
    grp = None
    for i in items:
        if i['group'] != grp:
            grp = i['group']; lines.append(f"{grp} ({sum(x['weight'] for x in items if x['group'] == grp)})")
        v = i['value']
        vs = f'{v:.3f}' if isinstance(v, float) else str(v)
        lines.append(f"  {i['points']:5.2f}/{i['weight']:<2} {i['name']}  [{vs}]")
    crashes = [m for m in ms if 'crash' in m]
    if crashes: lines.append(f'\nCRASHES: {crashes[0]["crash"][-400:]}')
    samples = [s for m in ms if 'crash' not in m for s in m['wrong_samples'] + [('CTX',) + tuple(c) for c in m.get('ctx_samples', [])] + [('HYPE',) + tuple(h) for h in m.get('hype_samples', [])]][:30]
    if samples: lines += ['', 'Some wrong calls:'] + [f'  {s}' for s in samples]
    rep = '\n'.join(lines)
    open(f'{OUT}/report.txt', 'w').write(rep)
    print(rep)
