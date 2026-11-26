# Edge-case versions of real matches, to check the engine copes: joined mid-match, missing
# kickoff events, a pause, spectator fields, unknown stat names, duplicated goal events.
# usage: edge_variants.py <streams dir> <out dir>
import json, gzip, glob, random, os, sys
src = sorted(glob.glob(os.path.join(sys.argv[1], '*.jsonl.gz')))
random.Random(3).shuffle(src)
out = sys.argv[2]
os.makedirs(out, exist_ok=True)
made = []
for i, f in enumerate(src[:12]):
    rows = [json.loads(l) for l in gzip.open(f, 'rt')]
    head, ev = rows[0], rows[1:]
    kind = ['late', 'noround', 'pause', 'spectator', 'unknown', 'dupes'][i % 6]
    if kind == 'late':
        ev = [r for r in ev if r['t'] > 95000]  # the casters started 95 s in
    elif kind == 'noround':
        ev = [r for r in ev if r.get('e') not in ('RoundStarted', 'CountdownBegin')]
    elif kind == 'pause':
        k = next(j for j, r in enumerate(ev) if r['t'] > 60000)
        t0 = ev[k]['t']
        ev = ev[:k] + [{'t': t0, 'e': 'MatchPaused', 'd': {}}, {'t': t0 + 20000, 'e': 'MatchUnpaused', 'd': {}}] + [dict(r, t=r['t'] + 20000) for r in ev[k:]]
    elif kind == 'spectator':
        for r in ev:
            if r.get('e') == 'UpdateState':
                for p in r['d']['Players']: p.update({'Boost': random.randint(0, 100), 'Speed': 1200.0, 'bDemolished': False, 'bSupersonic': False, 'bOnGround': True})
    elif kind == 'unknown':
        extra = []
        for r in ev:
            if r.get('e') == 'BallHit' and random.random() < 0.05:
                extra.append({'t': r['t'] + 5, 'e': 'StatfeedEvent', 'd': {'EventName': 'Something_New', 'Type': 'New Stat', 'MainTarget': r['d']['Players'][0]}})
            if r.get('e') == 'BallHit' and random.random() < 0.02:
                extra.append({'t': r['t'] + 7, 'e': 'BoostPickup', 'd': {'Player': r['d']['Players'][0], 'BoostType': 'BoostType_Pill'}})
        ev = sorted(ev + extra, key=lambda r: r['t'])
    elif kind == 'dupes':
        ev = sorted(ev + [dict(r, t=r['t'] + 3) for r in ev if r.get('e') in ('GoalScored', 'StatfeedEvent', 'MatchEnded')], key=lambda r: r['t'])
    base = os.path.basename(f).replace('.jsonl.gz', '')
    name = f'{base}__{kind}'
    with gzip.open(f'{out}/{name}.jsonl.gz', 'wt') as g:
        for r in [head] + ev: g.write(json.dumps(r) + '\n')
    made.append((name, kind))
print(made)
