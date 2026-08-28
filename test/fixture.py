#!/usr/bin/env python3
"""
Generate and inspect WAV files carrying a `smpl` chunk.

Deliberately an independent implementation of the same format the JS reads and
writes. A round-trip test where my parser checks my writer proves the two agree
with each other and nothing about whether either matches the spec; this is the
outside opinion.

  fixture.py make OUT.wav        - write a test file with a known smpl chunk
  fixture.py dump FILE.wav       - print the chunk list and any smpl loops
"""
import math
import struct
import sys

RATE = 44100
FRAMES = 44100 * 3          # 3 seconds
LOOP_START = 28 * 300       # 8400, deliberately block-aligned
LOOP_END = 28 * 900 - 1     # 25199, so the length is a whole number of blocks


def make(path):
    # A tone that changes character at the loop points, so a loop that is off
    # by even a few hundred samples is audible and visible in the waveform.
    frames = bytearray()
    for i in range(FRAMES):
        t = i / RATE
        f = 220.0 if i < LOOP_START else (330.0 if i <= LOOP_END else 440.0)
        env = min(1.0, i / 500.0, (FRAMES - i) / 500.0)
        v = math.sin(2 * math.pi * f * t) * 0.6 * env
        s = int(max(-1.0, min(1.0, v)) * 32767)
        frames += struct.pack('<hh', s, s // 2)     # stereo, R at half level

    fmt = struct.pack('<HHIIHH', 1, 2, RATE, RATE * 4, 4, 16)

    # One forward loop. cSampleLoops = 1, no sampler data.
    smpl = struct.pack('<9I',
                       0,                       # manufacturer
                       0,                       # product
                       round(1e9 / RATE),       # sample period, ns
                       60,                      # MIDI unity note
                       0,                       # pitch fraction
                       0, 0,                    # SMPTE format, offset
                       1,                       # cSampleLoops
                       0)                       # cbSamplerData
    smpl += struct.pack('<6I', 0, 0, LOOP_START, LOOP_END, 0, 0)

    # An extra chunk the JS does not understand, to prove export preserves it.
    note = b'independent fixture'
    body = (b'fmt ' + struct.pack('<I', len(fmt)) + fmt +
            b'note' + struct.pack('<I', len(note)) + note +
            (b'\0' if len(note) & 1 else b'') +
            b'smpl' + struct.pack('<I', len(smpl)) + smpl +
            b'data' + struct.pack('<I', len(frames)) + bytes(frames))

    with open(path, 'wb') as fp:
        fp.write(b'RIFF' + struct.pack('<I', 4 + len(body)) + b'WAVE' + body)

    print('wrote %s: %d frames @ %d Hz, loop %d..%d (inclusive), length %d'
          % (path, FRAMES, RATE, LOOP_START, LOOP_END, LOOP_END - LOOP_START + 1))


def dump(path):
    data = open(path, 'rb').read()
    if data[0:4] != b'RIFF' or data[8:12] != b'WAVE':
        print('NOT-A-WAVE')
        return 1
    declared = struct.unpack('<I', data[4:8])[0]
    print('riff_size_field %d file_size_minus_8 %d %s'
          % (declared, len(data) - 8, 'OK' if declared == len(data) - 8 else 'MISMATCH'))

    pos, order, loops = 12, [], []
    data_hash = None
    while pos + 8 <= len(data):
        cid = data[pos:pos + 4].decode('latin1')
        size = struct.unpack('<I', data[pos + 4:pos + 8])[0]
        body = data[pos + 8:pos + 8 + size]
        order.append(cid)
        if cid == 'smpl' and size >= 36:
            hdr = struct.unpack('<9I', body[:36])
            print('smpl period %d unity %d count %d' % (hdr[2], hdr[3], hdr[7]))
            for i in range(hdr[7]):
                off = 36 + i * 24
                if off + 24 > size:
                    break
                lid, ltype, ls, le, frac, pc = struct.unpack('<6I', body[off:off + 24])
                loops.append((ltype, ls, le))
                print('loop %d type %d start %d end %d length %d playcount %d'
                      % (i, ltype, ls, le, le - ls + 1, pc))
        if cid == 'data':
            data_hash = (len(body), sum(body) & 0xffffffff)
        if cid == 'note':
            print('note %r' % body)
        pos += 8 + size + (size & 1)

    print('chunks %s' % ' '.join(order))
    if data_hash:
        print('data_bytes %d data_checksum %d' % data_hash)
    print('loop_count %d' % len(loops))
    return 0


def read_chunks(path):
    data = open(path, 'rb').read()
    pos, out = 12, []
    while pos + 8 <= len(data):
        cid = data[pos:pos + 4].decode('latin1')
        size = struct.unpack('<I', data[pos + 4:pos + 8])[0]
        out.append((cid, data[pos + 8:pos + 8 + size]))
        pos += 8 + size + (size & 1)
    return data, out


def verify(wav_path, expect_path, source_path):
    """Check an exported file against what the app said it wrote, and against
    the original it was derived from. Exits non-zero on any mismatch."""
    import json
    expect = json.load(open(expect_path))
    data, chunks = read_chunks(wav_path)
    ids = [c for c, _ in chunks]
    bad = []

    def ck(name, cond, detail=''):
        print(('  ok   ' if cond else '  FAIL ') + name + (('  (%s)' % detail) if detail and not cond else ''))
        if not cond:
            bad.append(name)

    ck('riff size field is correct',
       struct.unpack('<I', data[4:8])[0] == len(data) - 8)
    ck('chunk order preserved', ids == expect['chunks'], '%s vs %s' % (ids, expect['chunks']))
    ck('exactly one smpl chunk', ids.count('smpl') == 1, str(ids.count('smpl')))

    note = dict(chunks).get('note')
    ck('unknown "note" chunk survived export', note == b'independent fixture', repr(note))

    src, src_chunks = read_chunks(source_path)
    ck('data chunk is byte-identical to the source',
       dict(chunks).get('data') == dict(src_chunks).get('data'))
    ck('fmt chunk is byte-identical to the source',
       dict(chunks).get('fmt ') == dict(src_chunks).get('fmt '))

    smpl = dict(chunks).get('smpl')
    if smpl is None:
        ck('smpl chunk present', False)
    else:
        hdr = struct.unpack('<9I', smpl[:36])
        ck('smpl sample period matches 44100 Hz', hdr[2] == round(1e9 / 44100), str(hdr[2]))
        ck('loop count matches the app', hdr[7] == len(expect['loops']),
           '%d vs %d' % (hdr[7], len(expect['loops'])))
        for i, want in enumerate(expect['loops']):
            off = 36 + i * 24
            if off + 24 > len(smpl):
                ck('loop %d present' % i, False)
                continue
            _, ltype, ls, le, _, _ = struct.unpack('<6I', smpl[off:off + 24])
            ck('loop %d start' % i, ls == want['start'], '%d vs %d' % (ls, want['start']))
            ck('loop %d end' % i, le == want['end'], '%d vs %d' % (le, want['end']))
            ck('loop %d type' % i, ltype == want['type'], '%d vs %d' % (ltype, want['type']))

    print('VERIFY ' + ('FAILED: ' + ', '.join(bad) if bad else 'OK'))
    return 1 if bad else 0


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    cmd = sys.argv[1]
    if cmd == 'make':
        make(sys.argv[2])
        sys.exit(0)
    if cmd == 'dump':
        sys.exit(dump(sys.argv[2]))
    if cmd == 'verify':
        sys.exit(verify(sys.argv[2], sys.argv[3], sys.argv[4]))
    print(__doc__)
    sys.exit(2)
