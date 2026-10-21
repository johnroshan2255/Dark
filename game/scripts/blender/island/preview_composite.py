import bpy, numpy as np, json, os
def load(p):
    im = bpy.data.images.load(p); w, h = im.size
    a = np.array(im.pixels[:], np.float32).reshape(h, w, 4)[::-1]  # top row first
    bpy.data.images.remove(im); return a
A = load(ORIGP); B = load(NEWP)
n = A.shape[0]
xs = np.linspace(-1200, 1200, n); X, Z = np.meshgrid(xs, xs)
meta = json.load(open(os.path.join(MAP, 'map.json'))); bn = meta['biomeGrid']['n']
bio = np.fromfile(os.path.join(MAP, 'biome.bin'), dtype=np.uint8).reshape(bn, bn, 2)[..., 0] / 255
bi = np.clip(np.round((xs + 1200) / 4).astype(int), 0, bn - 1)
D = bio[np.ix_(bi, bi)]
ss = lambda a, b, x: np.clip((x - a) / (b - a), 0, 1) ** 2 * (3 - 2 * np.clip((x - a) / (b - a), 0, 1))
M = ss(0.3, 0.8, D) * ss(-140, -60, -Z) * ss(-160, -60, X)
M = M[..., None]
w = M[..., 0] > 0.9
for c in range(3): B[..., c] *= A[..., c][w].mean() / max(1e-4, B[..., c][w].mean())
C = A * (1 - M) + B * M; C[..., 3] = 1
img = bpy.data.images.new('pv', n, n, alpha=False); img.pixels = C[::-1].ravel()
img.filepath_raw = OUT; img.file_format = 'PNG'; img.save(); bpy.data.images.remove(img); print('ok', OUT)
