#!/usr/bin/env python3
"""Build RL Career Casters.exe from this repo's app/ folder.

The exe is a Node single-executable app: node.exe with one blob injected (tools/bootstrap.js
plus a gzipped "runtime" asset holding app/ and node_modules/, including the speech engine's
native DLLs). This script takes an existing release exe as the base, keeps its Node runtime and
node_modules, swaps in every file from app/, bumps the version, and injects the new blob.

usage:  python tools/build.py --base "RL Career Casters.exe" --version 2.0.1 [--out "RL Career Casters.exe"]
needs:  pip install pefile   and   npx postject (Node.js)
"""
import argparse, gzip, hashlib, os, re, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from sea import parse_blob, build_blob, parse_runtime, build_runtime_raw  # noqa: E402

FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'


def blob_of(exe):
    import pefile
    pe = pefile.PE(exe, fast_load=True)
    pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_RESOURCE']])
    for t in pe.DIRECTORY_ENTRY_RESOURCE.entries:
        for n in t.directory.entries:
            if str(n.name) == 'NODE_SEA_BLOB':
                d = n.directory.entries[0].data.struct
                return bytes(pe.get_memory_mapped_image()[d.OffsetToData:d.OffsetToData + d.Size])
    raise SystemExit(f'{exe} has no NODE_SEA_BLOB: use an RL Career Casters release exe as --base')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', required=True, help='an RL Career Casters release exe')
    ap.add_argument('--version', required=True)
    ap.add_argument('--out', default='RL Career Casters.exe')
    ap.add_argument('--app', default=os.path.join(HERE, '..', 'app'))
    a = ap.parse_args()

    b = parse_blob(blob_of(a.base))
    (key, gz), = b['assets']
    man, files, _ = parse_runtime(gz)
    extra = {k: v for k, v in man.items() if k != 'files'}
    extra['version'] = a.version
    have = {p for p, _ in files}

    want = {}
    for root, dirs, names in os.walk(a.app):
        dirs[:] = [d for d in dirs if d not in ('__pycache__',)]
        for f in names:
            if f == 'README.md':
                continue
            full = os.path.join(root, f)
            want['app/' + os.path.relpath(full, a.app).replace(os.sep, '/')] = full
    out, changed = [], []
    for p, data in files:
        if p in want:
            cur = open(want[p], 'rb').read()
            if cur != data: changed.append(p)
            data = cur
        out.append((p, data))
    for rel in sorted(want):
        if rel not in have:
            out.append((rel, open(want[rel], 'rb').read())); changed.append(rel + ' (new)')
    print('changed:', ', '.join(changed) or 'nothing')

    raw, _ = build_runtime_raw(extra, out)
    h = hashlib.sha1(raw).hexdigest()[:8]
    code = b['code']
    code = re.sub(rb"const VERSION = '[^']+'", b"const VERSION = '" + a.version.encode() + b"'", code)
    code = re.sub(rb"const BUILD = '[^']+'", b"const BUILD = '" + a.version.encode() + b'-' + h.encode() + b"'", code)
    b['code'] = code
    b['assets'] = [(key, gzip.compress(raw, 9, mtime=0))]
    blob = a.out + '.blob'
    open(blob, 'wb').write(build_blob(b))

    if os.path.abspath(a.out) != os.path.abspath(a.base):
        shutil.copyfile(a.base, a.out)
    subprocess.run(['npx', '--yes', 'postject', a.out, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE, '--overwrite'], check=True,
                   shell=(os.name == 'nt'))
    if blob_of(a.out) != open(blob, 'rb').read():
        raise SystemExit('the blob in the new exe does not match: build failed')
    os.remove(blob)
    print(f'built {a.out}: version {a.version}, build {a.version}-{h}')


if __name__ == '__main__':
    main()
