# Read / write the Node single-executable blob and its gzipped "runtime" asset (layout as found in the 1.2 exe).
import struct, gzip, json, os, io

def parse_blob(b):
    hdr = b[:9]                         # magic (4) + flags (4) + 1 byte
    p = 9
    n = struct.unpack_from('<Q', b, p)[0]; p += 8; code_path = b[p:p + n]; p += n
    n = struct.unpack_from('<Q', b, p)[0]; p += 8; code = b[p:p + n]; p += n
    cnt = struct.unpack_from('<Q', b, p)[0]; p += 8
    assets = []
    for _ in range(cnt):
        n = struct.unpack_from('<Q', b, p)[0]; p += 8; k = b[p:p + n]; p += n
        n = struct.unpack_from('<Q', b, p)[0]; p += 8; v = b[p:p + n]; p += n
        assets.append((k, v))
    return dict(hdr=hdr, code_path=code_path, code=code, assets=assets, rest=b[p:])

def build_blob(d):
    out = io.BytesIO()
    out.write(d['hdr'])
    for part in (d['code_path'], d['code']):
        out.write(struct.pack('<Q', len(part))); out.write(part)
    out.write(struct.pack('<Q', len(d['assets'])))
    for k, v in d['assets']:
        out.write(struct.pack('<Q', len(k))); out.write(k)
        out.write(struct.pack('<Q', len(v))); out.write(v)
    out.write(d['rest'])
    return out.getvalue()

def parse_runtime(gz):
    raw = gzip.decompress(gz)
    hl = struct.unpack_from('<I', raw, 0)[0]
    man = json.loads(raw[4:4 + hl]); off = 4 + hl
    files = []
    for f in man['files']:
        files.append((f['p'], raw[off:off + f['n']])); off += f['n']
    return man, files, raw

def build_runtime_raw(man_extra, files):
    man = dict(man_extra); man['files'] = [{'p': p, 'n': len(data)} for p, data in files]
    hj = json.dumps(man, separators=(',', ':')).encode()
    return struct.pack('<I', len(hj)) + hj + b''.join(data for _, data in files), man
