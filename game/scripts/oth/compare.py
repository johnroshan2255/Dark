# OVER THE HILL — compare our renders with reference shots, region by region, and score them (0–100).
#
#   blender -b --factory-startup --python scripts/oth/compare.py -- SPEC=<pairs.json> OUT=<dir>
#
# pairs.json: [{ "name", "ref": <image>, "refRect": [x0, y0, x1, y1] (0..1), "ours": <image>, "oursRect": [...] }]
# For every pair both regions are resized to the same size and measured:
#   colour   HSV histogram intersection (12 hue × 4 sat × 4 value bins)                      30 %
#   tone     luminance mean + spread (contrast)                                               20 %
#   texture  detail energy in three bands (fine 1–2 px, mid 2–6 px, coarse 6–16 px), log-ratio 30 %
#   strokes  gradient-orientation histogram (vertical blades vs. horizontal bands, …)         20 %
# 100 only for identical images. Writes <OUT>/<name>.jpg (reference | ours, side by side) and <OUT>/scores.json.
import sys, os, json, math
import numpy as np
import bpy

ARGS = dict(a.split('=', 1) for a in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []) if '=' in a)
SPEC = json.load(open(ARGS['SPEC']))
OUT = ARGS['OUT']
os.makedirs(OUT, exist_ok=True)
W, H = 480, 270


def load(path, rect):
    img = bpy.data.images.load(os.path.abspath(path), check_existing=False)
    w, h = img.size
    px = np.array(img.pixels[:], np.float32).reshape(h, w, 4)[::-1, :, :3]  # top row first
    x0, y0, x1, y1 = rect
    c = px[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)]
    # resize (area average via repeated 2× + nearest to the target)
    ys = (np.arange(H) + 0.5) * c.shape[0] / H
    xs = (np.arange(W) + 0.5) * c.shape[1] / W
    k = max(1, int(c.shape[0] / H))
    if k > 1:
        cc = np.cumsum(np.cumsum(np.pad(c, ((1, 0), (1, 0), (0, 0))), 0), 1)
        def box(y, x):
            ya, yb = np.clip((y - k / 2).astype(int), 0, c.shape[0]), np.clip((y + k / 2).astype(int), 0, c.shape[0])
            xa, xb = np.clip((x - k / 2).astype(int), 0, c.shape[1]), np.clip((x + k / 2).astype(int), 0, c.shape[1])
            Y0, X0 = np.meshgrid(ya, xa, indexing='ij'); Y1, X1 = np.meshgrid(yb, xb, indexing='ij')
            s = cc[Y1, X1] - cc[Y0, X1] - cc[Y1, X0] + cc[Y0, X0]
            return s / np.maximum((Y1 - Y0) * (X1 - X0), 1)[..., None]
        out = box(ys, xs)
    else:
        out = c[ys.astype(int)][:, xs.astype(int)]
    bpy.data.images.remove(img)
    return np.clip(out, 0, 1)


def blur(a, r):
    for ax in (0, 1):
        p = np.pad(a, [((r + 1, r) if i == ax else (0, 0)) for i in range(a.ndim)], mode='edge')
        cs = np.cumsum(p, axis=ax)
        a = (np.take(cs, range(2 * r + 1, cs.shape[ax]), axis=ax) - np.take(cs, range(0, cs.shape[ax] - 2 * r - 1), axis=ax)) / (2 * r + 1)
    return a


def hsv(c):
    r, g, b = c[..., 0], c[..., 1], c[..., 2]
    mx, mn = c.max(-1), c.min(-1)
    d = mx - mn + 1e-6
    h = np.where(mx == r, (g - b) / d % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) / 6
    s = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    return h % 1, s, mx


def stats(c):
    L = c @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    h, s, v = hsv(c)
    hist, _ = np.histogramdd(np.stack([h.ravel(), s.ravel(), v.ravel()], 1), bins=(12, 4, 4), range=((0, 1), (0, 1), (0, 1)))
    hist /= hist.sum()
    b1 = L - blur(L, 1); b2 = blur(L, 1) - blur(L, 3); b3 = blur(L, 3) - blur(L, 8)
    m = max(L.mean(), 1e-3)
    bands = [b.std() / m for b in (b1, b2, b3)]
    gy, gx = np.gradient(blur(L, 1))
    mag = np.hypot(gx, gy); ang = np.arctan2(gy, gx) % math.pi
    oh, _ = np.histogram(ang, bins=8, range=(0, math.pi), weights=mag)
    oh = oh / max(oh.sum(), 1e-9)
    rgb = [int(round(float(v) * 255)) for v in np.median(c.reshape(-1, 3), 0)]
    return dict(L=L, hist=hist, mean=float(L.mean()), std=float(L.std()), sat=float(s.mean()), bands=[float(x) for x in bands], orient=oh, rgb=rgb)


results = []
for p in SPEC:
    a = load(p['ref'], p.get('refRect', [0, 0, 1, 1]))
    b = load(p['ours'], p.get('oursRect', [0, 0, 1, 1]))
    A, B = stats(a), stats(b)
    colour = float(np.minimum(A['hist'], B['hist']).sum())
    tone = max(0.0, 1 - abs(A['mean'] - B['mean']) / 0.25) * 0.6 + max(0.0, 1 - abs(A['std'] - B['std']) / 0.12) * 0.4
    tex = float(np.mean([math.exp(-abs(math.log(max(x, 1e-4) / max(y, 1e-4)))) for x, y in zip(A['bands'], B['bands'])]))
    strokes = float(np.minimum(A['orient'], B['orient']).sum())
    score = 100 * (0.3 * colour + 0.2 * tone + 0.3 * tex + 0.2 * strokes)
    r = dict(name=p['name'], score=round(score, 1), colour=round(colour * 100), tone=round(tone * 100), texture=round(tex * 100),
             strokes=round(strokes * 100), ref=dict(mean=round(A['mean'], 3), std=round(A['std'], 3), sat=round(A['sat'], 3), bands=[round(x, 3) for x in A['bands']]),
             ours=dict(mean=round(B['mean'], 3), std=round(B['std'], 3), sat=round(B['sat'], 3), bands=[round(x, 3) for x in B['bands']]))
    results.append(r)
    print(f"{p['name']:<16} {score:5.1f}  colour {r['colour']:3d}  tone {r['tone']:3d}  texture {r['texture']:3d}  strokes {r['strokes']:3d}"
          f"   ref rgb {A['rgb']} L {A['mean']:.2f}±{A['std']:.2f} bands {['%.3f' % x for x in A['bands']]}"
          f"   ours rgb {B['rgb']} L {B['mean']:.2f}±{B['std']:.2f} bands {['%.3f' % x for x in B['bands']]}")
    sheet = np.ones((H, W * 2 + 6, 3), np.float32)
    sheet[:, :W] = a; sheet[:, W + 6:] = b
    img = bpy.data.images.new(p['name'], sheet.shape[1], sheet.shape[0], alpha=False)
    img.pixels.foreach_set(np.concatenate([sheet[::-1], np.ones(sheet.shape[:2] + (1,), np.float32)], -1).ravel())
    img.filepath_raw = os.path.join(OUT, p['name'] + '.jpg'); img.file_format = 'JPEG'; img.save()
total = sum(r['score'] for r in results) / max(len(results), 1)
print(f'OVERALL {total:.1f}')
json.dump(dict(overall=round(total, 1), pairs=results), open(os.path.join(OUT, 'scores.json'), 'w'), indent=1)
