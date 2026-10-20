# Top-down map view (hillshade × biome tint + roads + set pieces) of the island, rendered with numpy in Blender.
# Defined before this runs (bl.mjs NAME=value): MAP (folder), OUT (png), X0 X1 Z0 Z1 (world m), PX (output width px),
# HEIGHTS (optional: an alternative heights .bin path)
import bpy, json, numpy as np, os
X0, X1, Z0, Z1, PX = float(X0), float(X1), float(Z0), float(Z1), int(PX)
meta = json.load(open(os.path.join(MAP, 'map.json')))
g = meta['grid']; n = g['n']; st = g['step']
hp = HEIGHTS if 'HEIGHTS' in globals() and HEIGHTS else os.path.join(MAP, 'heights.bin')
H = np.fromfile(hp, dtype='<u2').reshape(n, n).astype(np.float32) / 65535 * g['range'] + g['min'] + meta['heightOffset']
bg = meta['biomeGrid']; bn = bg['n']
B = np.fromfile(os.path.join(MAP, 'biome.bin'), dtype=np.uint8).reshape(bn, bn, 2).astype(np.float32) / 255
W = PX; Hh = int(PX * (Z1 - Z0) / (X1 - X0))
xs = np.linspace(X0, X1, W); zs = np.linspace(Z0, Z1, Hh)
gx = np.clip((xs + 1200) / st, 0, n - 1.001); gz = np.clip((zs + 1200) / st, 0, n - 1.001)
GX, GZ = np.meshgrid(gx, gz)
i0 = GX.astype(int); j0 = GZ.astype(int); fx = GX - i0; fz = GZ - j0
h = (H[j0, i0] * (1 - fx) * (1 - fz) + H[j0, i0 + 1] * fx * (1 - fz) + H[j0 + 1, i0] * (1 - fx) * fz + H[j0 + 1, i0 + 1] * fx * fz)
dx = (X1 - X0) / W
hx = np.gradient(h, dx, axis=1); hz = np.gradient(h, dx, axis=0)
# light from the north-west, above
nx, ny, nz = -hx, np.ones_like(h), -hz
ln = np.sqrt(nx * nx + ny * ny + nz * nz)
L = np.array([-0.5, 0.75, -0.45]); L = L / np.linalg.norm(L)
shade = np.clip((nx * L[0] + ny * L[1] + nz * L[2]) / ln, 0, 1)
bi = np.clip(np.round((xs + 1200) / bg['step']).astype(int), 0, bn - 1); bj = np.clip(np.round((zs + 1200) / bg['step']).astype(int), 0, bn - 1)
BI, BJ = np.meshgrid(bi, bj)
d = B[BJ, BI, 0]; s = B[BJ, BI, 1]
col = np.zeros((Hh, W, 3), np.float32)
green = np.array([0.42, 0.55, 0.30]); sand = np.array([0.85, 0.62, 0.40]); snow = np.array([0.92, 0.94, 0.98]); sea = np.array([0.2, 0.45, 0.6])
base = green * (1 - d - s)[..., None] + sand * d[..., None] + snow * s[..., None]
# height bands (contours every 10 m)
band = (np.floor(h / 10) % 2)[..., None] * 0.06
col = base * (0.35 + 0.75 * shade[..., None]) - band
col[h < 0.3] = sea
slope = np.sqrt(hx * hx + hz * hz)
col[slope > 1.2] = col[slope > 1.2] * 0.6 + np.array([0.5, 0.2, 0.15]) * 0.4
def plot(x, z, c, r=1):
    px = int((x - X0) / (X1 - X0) * W); pz = int((z - Z0) / (Z1 - Z0) * Hh)
    if 0 <= px < W and 0 <= pz < Hh:
        col[max(0, pz - r):pz + r + 1, max(0, px - r):px + r + 1] = c
for r in meta['roads']:
    for x, z in zip(r['x'], r['z']):
        plot(x, z, np.array([0.45, 0.33, 0.26]) if globals().get('NOPROPS') else np.array([0.1, 0.1, 0.1]), 1)
props = json.load(open(os.path.join(MAP, 'props.json')))
NATURE = {'pine', 'pine_snow', 'oak', 'birch', 'cherry', 'palm', 'rock', 'rock_snow', 'rock_red', 'bush', 'grass_tuft', 'cactus', 'log', 'stump', 'boulder', 'dead_tree'}
stride = props['stride']
for tile in ([] if globals().get('NOPROPS') else props['placements'].values()):
    for t, a in tile.items():
        if t in NATURE: continue
        for o in range(0, len(a), stride):
            plot(a[o], a[o + 2], np.array([0.9, 0.1, 0.9]), 2)
EXTRA = globals().get('EXTRA')
if EXTRA:
    for x, z in json.load(open(EXTRA)):
        plot(x, z, np.array([0.1, 0.4, 1.0]), 1)
img = bpy.data.images.new('view', W, Hh, alpha=False)
rgba = np.ones((Hh, W, 4), np.float32); rgba[..., :3] = np.clip(col, 0, 1)
img.pixels = rgba[::-1].ravel()  # Blender rows bottom-up; north (−z) at the top
img.filepath_raw = OUT; img.file_format = 'PNG'; img.save()
bpy.data.images.remove(img)
print('saved', OUT, W, Hh, 'h range', float(h.min()), float(h.max()))
