#!/usr/bin/env python3
"""Make the simulator's voice-pack inventory: which lines exist, and how long each one lasts.

  python sim/make_inventory.py                       every line in the 2.0 line bank counts as recorded
  python sim/make_inventory.py --pack my.zip [...]   "current" = the lines in your pack zips (real lengths),
                                                     "new" = the rest of the 2.0 bank (estimated lengths)

The simulator then runs with --pack current (only what you have) or --pack full (current + new).
Players and teams come from studio/players.txt and studio/teams.txt.
"""
import argparse, json, os, random, sys, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.join(HERE, '..', 'studio')
sys.path.insert(0, STUDIO)
import studio_cloud as sc  # noqa: E402

# the pack voice's pace, fitted on 6,197 real recordings: about a second plus ~0.1 s a character
est = lambda t: 470 + 97.5 * min(len(t), 40) + 42.6 * max(len(t) - 40, 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pack', action='append', default=[], help='a voice pack zip (repeat for add-ons)')
    ap.add_argument('--out', default=os.path.join(HERE, 'data', 'inventory.json'))
    a = ap.parse_args()
    s = sc.load_settings(os.path.join(STUDIO, 'settings.json'))
    spec = json.load(open(os.path.join(STUDIO, 'spec.json')))
    lines = sc.expand(spec, s['players'], s['teams'], sc.per_player_counts(s['lines_per_player']), say=s.get('say'))
    real = {}
    for z in a.pack:
        zf = zipfile.ZipFile(z)
        size = {i.filename: i.file_size for i in zf.infolist()}
        for l in json.loads(zf.read('manifest.json'))['lines']:
            real[sc.key_of(l['role'], l['mood'], l['text'])] = size.get(l['file'], 0) / 8.0 + 80  # 64 kbps MP3s
    rnd = random.Random(5)
    cur, new = {}, {}
    for l in lines:
        k = sc.key_of(l['role'], l['mood'], l['text'])
        if a.pack:
            if k in real: cur[k] = round(real[k])
            else: new[k] = round(est(l['text']) * rnd.uniform(0.85, 1.18))
        else:
            cur[k] = round(est(l['text']) * rnd.uniform(0.85, 1.18))
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    json.dump({'current': cur, 'new': new, 'players': s['players'], 'teams': s['teams']}, open(a.out, 'w'))
    print(f'{a.out}: {len(cur)} lines recorded, {len(new)} more in the 2.0 bank')


if __name__ == '__main__':
    main()
