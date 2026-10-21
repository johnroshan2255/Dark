# THE ISLAND — map card preview (2026-10-21): a bird's-eye (north up, tilted) Eevee render of the map in the game's BRIGHT look
# instead of a numpy hillshade: cel-shaded terrain in the in-game palette (orange-salmon desert, blue-shaded snow,
# saturated green forest), the map's own tree placements as round dot-canopy trees / pines / snowy pines / palms /
# cacti / bushes, turquoise sea and river with a surf line, roads as packed-dirt ribbons, a low warm sun.
#   blender -b --factory-startup --python scripts/blender/island/map_preview.py -- MAP=public/maps/island \
#           OUT=public/maps/island/preview.jpg [PX=1100] [SAMPLES=64] [TILT=43.5] [SUN_AZ=70] [POOLS=<pools.json>]
# MINIMAP (in-game, GameHud): TILT=0 FULL=1 PX=1024 OUT=public/maps/island/minimap.jpg — top-down, exactly the map's
# 2·half square (pixel = (x + half, z + half) / 2·half · PX).
# Biome-driven: a map repainted all-snow (2026-10-21) renders frozen sea / lakes as ice and every tree site in the
# snow as a snowy conifer, like the game.
import json, math, os, sys
import numpy as np
import bpy

ARGS = dict(a.split('=', 1) for a in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []))
MAP = ARGS['MAP']; OUT = ARGS['OUT']; PX = int(ARGS.get('PX', 1024)); SAMPLES = int(ARGS.get('SAMPLES', 32))
# POOLS: the desert pools as the game places them at load (FixedMap.pools — export them from a running game:
# JSON.stringify(window.__game.map.pools)); drawn as water with a green ring and bushes.
POOLS = json.load(open(ARGS['POOLS'])) if ARGS.get('POOLS') else []
DEC = int(ARGS.get('DEC', 1))  # grid cells per terrain vertex (1 = the game's 2 m)
TILT = float(ARGS.get('TILT', 43.5)); FULL = ARGS.get('FULL', '0') == '1'; SUN_AZ = float(ARGS.get('SUN_AZ', 70)); LIFT = float(ARGS.get('LIFT', 40))  # view tilt (deg) and the height the frame centres on (m)

meta = json.load(open(os.path.join(MAP, 'map.json')))
props = json.load(open(os.path.join(MAP, 'props.json')))
g = meta['grid']; N = g['n']; ST = g['step']; OFF = meta['heightOffset']; HALF = meta['half']
H = np.fromfile(os.path.join(MAP, 'heights.bin'), dtype='<u2').reshape(N, N).astype(np.float64) / 65535 * g['range'] + g['min'] + OFF
bg = meta['biomeGrid']; BN = bg['n']
BIO = np.fromfile(os.path.join(MAP, 'biome.bin'), dtype=np.uint8).reshape(BN, BN, 2).astype(np.float64) / 255
WATER = -6.0      # WorldFields.WATER
ICE_SNOW = 0.32   # world/types.ts: no open water in the snow

def srgb(*c):
    """sRGB 0..255 → linear (Blender vertex colours are linear)."""
    a = np.array(c, float) / 255
    return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)

def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t)

def vnoise(x, z, scale, seed):
    rng = np.random.default_rng(seed); m = int(2 * (HALF + 400) / scale) + 4
    lat = rng.uniform(-1, 1, (m, m))
    u = (x + HALF + 400) / scale; v = (z + HALF + 400) / scale
    i = np.clip(np.floor(u).astype(int), 0, m - 2); j = np.clip(np.floor(v).astype(int), 0, m - 2)
    fu = u - i; fv = v - j; fu = fu * fu * (3 - 2 * fu); fv = fv * fv * (3 - 2 * fv)
    a = lat[j, i]; b = lat[j, i + 1]; c = lat[j + 1, i]; d = lat[j + 1, i + 1]
    return a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv

def hash4(a, b, c=0, d=0):
    """world/noise/rng.ts hash4 (32-bit, bit-identical)."""
    M = 0xffffffff
    imul = lambda x, y: ((x & M) * (y & M)) & M
    h = imul(a, 0x27d4eb2d) ^ imul(b, 0x165667b1)
    h = imul(h ^ (h >> 15), 0x85ebca6b)
    h ^= imul(c, 0xc2b2ae35)
    h = imul(h ^ (h >> 13), 0x27d4eb2f)
    h ^= imul(d, 0x9e3779b1)
    h = imul(h ^ (h >> 16), 0x85ebca6b)
    return (h ^ (h >> 13)) & M
jsround = lambda v: int(math.floor(v + 0.5))
def kept_palm(x, z):
    """FixedMap: a fifth of the map's palms grow (PALM_KEEP, hashFloat(5531, round(x·10), round(z·10)))."""
    return hash4(5531, jsround(x * 10), jsround(z * 10)) / 4294967296 < 0.2

def sample(Hf, x, z):
    gx = np.clip((np.asarray(x) + HALF) / ST, 0, N - 1.001); gz = np.clip((np.asarray(z) + HALF) / ST, 0, N - 1.001)
    i = gx.astype(int); j = gz.astype(int); fx = gx - i; fz = gz - j
    return Hf[j, i] * (1 - fx) * (1 - fz) + Hf[j, i + 1] * fx * (1 - fz) + Hf[j + 1, i] * (1 - fx) * fz + Hf[j + 1, i + 1] * fx * fz

for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
for coll in (bpy.data.meshes, bpy.data.materials):
    for d in list(coll): coll.remove(d)
scene = bpy.context.scene

def mesh_obj(name, verts, faces_flat, nper, cols=None, mat=None, smooth=True):
    """verts (n, 3) Blender coords; faces as a flat index array of nper-gons; cols per vertex (n, 3) linear."""
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(verts)); me.vertices.foreach_set('co', verts.astype(np.float32).ravel())
    nf = len(faces_flat) // nper
    me.loops.add(len(faces_flat)); me.loops.foreach_set('vertex_index', faces_flat.astype(np.int32))
    me.polygons.add(nf); me.polygons.foreach_set('loop_start', (np.arange(nf) * nper).astype(np.int32))
    me.update(calc_edges=True)
    me.polygons.foreach_set('use_smooth', np.full(nf, smooth))
    if cols is not None:
        at = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
        rgba = np.ones((len(verts), 4), np.float32); rgba[:, :3] = cols
        at.data.foreach_set('color', rgba.ravel())
    if mat: me.materials.append(mat)
    ob = bpy.data.objects.new(name, me); scene.collection.objects.link(ob)
    return ob

# ---------------------------------------------------------------- cel material (the game's toon ramp + blue shade)
def toon_material(name, shade=(0.42, 0.50, 0.78), lit=(1.0, 0.97, 0.92), soft=0.10, rough=1.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    vc = nt.nodes.new('ShaderNodeVertexColor'); vc.layer_name = 'Col'
    dif = nt.nodes.new('ShaderNodeBsdfDiffuse'); dif.inputs['Color'].default_value = (1, 1, 1, 1); dif.inputs['Roughness'].default_value = rough
    s2r = nt.nodes.new('ShaderNodeShaderToRGB')
    bw = nt.nodes.new('ShaderNodeRGBToBW')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.interpolation = 'EASE'
    # sun-only diffuse (the world adds nothing): 0 = cast shadow, ~0.6 = flat ground, 1 = facing the sun
    e = ramp.color_ramp.elements
    e[0].position = 0.0; e[0].color = (*shade, 1)
    e[1].position = 1.0; e[1].color = (lit[0] * 1.14, lit[1] * 1.12, lit[2] * 1.08, 1)
    for pos, k in ((0.10, 0.0), (0.10 + soft, 0.55), (0.42, 0.88), (0.62, 1.0)):
        el = e.new(pos); c = [shade[i] + (lit[i] - shade[i]) * k for i in range(3)]; el.color = (*c, 1)
    mul = nt.nodes.new('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'; mul.inputs['Factor'].default_value = 1
    em = nt.nodes.new('ShaderNodeEmission')
    L = nt.links
    L.new(dif.outputs['BSDF'], s2r.inputs['Shader']); L.new(s2r.outputs['Color'], bw.inputs['Color'])
    L.new(bw.outputs['Val'], ramp.inputs['Fac'])
    L.new(vc.outputs['Color'], mul.inputs[6]); L.new(ramp.outputs['Color'], mul.inputs[7])
    L.new(mul.outputs[2], em.inputs['Color']); L.new(em.outputs['Emission'], out.inputs['Surface'])
    return m

TERR = toon_material('terrain', soft=0.16)
FOL = toon_material('foliage', shade=(0.36, 0.46, 0.62), soft=0.14)

# ---------------------------------------------------------------- terrain
I = np.arange(0, N, DEC); nv = len(I)
# the 2 m grid's stair-steps (snow terraces) read as streaks from above: shade a lightly softened copy (preview only)
Hs = H.copy()
for _ in range(2):
    p_ = np.pad(Hs, 1, mode='edge'); Hs = sum(p_[1 + a:N + 1 + a, 1 + b:N + 1 + b] for a in (-1, 0, 1) for b in (-1, 0, 1)) / 9
sub = Hs[np.ix_(I, I)]
xs = -HALF + I * ST
XX, ZZ = np.meshgrid(xs, xs)  # [j, i]
bi = np.clip(np.round((xs + HALF) / bg['step']).astype(int), 0, BN - 1)
dw = BIO[np.ix_(bi, bi)][..., 0]; sw = BIO[np.ix_(bi, bi)][..., 1]
gz, gx = np.gradient(sub, ST * DEC)
slope = np.hypot(gx, gz)
n1 = vnoise(XX, ZZ, 46, 1); n2 = vnoise(XX, ZZ, 13, 2); n3 = vnoise(XX, ZZ, 120, 3)
water = (sub < WATER) & (sw <= ICE_SNOW)
fw = np.clip(1 - dw - sw, 0, 1)
# forest: saturated meadow green, yellow-green sunny patches, darker under the canopy (density from the map)
dens = np.zeros_like(sub)
FC = 16.0; fn = int(2 * HALF / FC)
cnt = np.zeros((fn, fn))
for tile in props['placements'].values():
    for t in ('pine', 'oak', 'birch', 'cherry'):
        a = tile.get(t)
        if not a: continue
        a = np.array(a).reshape(-1, props['stride'])
        ii = np.clip(((a[:, 0] + HALF) / FC).astype(int), 0, fn - 1); jj = np.clip(((a[:, 2] + HALF) / FC).astype(int), 0, fn - 1)
        np.add.at(cnt, (jj, ii), 1)
for _ in range(2):
    p_ = np.pad(cnt, 1, mode='edge'); cnt = sum(p_[1 + a:fn + 1 + a, 1 + b:fn + 1 + b] for a in (-1, 0, 1) for b in (-1, 0, 1)) / 9
u = np.clip((XX + HALF) / FC - 0.5, 0, fn - 1.001); v_ = np.clip((ZZ + HALF) / FC - 0.5, 0, fn - 1.001)
ci = u.astype(int); cj = v_.astype(int); fu = u - ci; fv = v_ - cj
dens = cnt[cj, ci] * (1 - fu) * (1 - fv) + cnt[cj, ci + 1] * fu * (1 - fv) + cnt[cj + 1, ci] * (1 - fu) * fv + cnt[cj + 1, ci + 1] * fu * fv
dens = np.clip(dens / 2.5, 0, 1)
meadow = srgb(118, 168, 52) * (1 + 0.10 * n1[..., None]) + (srgb(170, 182, 60) - srgb(118, 168, 52)) * np.clip(n3 * 1.6, 0, 1)[..., None]
floor_ = srgb(64, 110, 38)
forest = meadow + (floor_ - meadow) * (dens * 0.6)[..., None]
dune = srgb(236, 150, 98) * (1 + 0.07 * n1[..., None] + 0.04 * n2[..., None])
strata = (np.floor((sub + 2 * n2) / 5) % 2)[..., None]
sandstone = srgb(196, 112, 74) * (1 - 0.12 * strata)
snow = srgb(242, 246, 253) * (1 + 0.02 * n2[..., None])
snowrock = srgb(126, 140, 172) * (1 + 0.08 * n1[..., None])
granite = srgb(104, 112, 62)  # forest banks / cliffs: mossy earth (grey granite read as concrete along the river)
cliff = np.clip((slope - 0.9) / 0.6, 0, 1)[..., None]
col = (forest * (1 - cliff) + granite * cliff) * fw[..., None]
col += (dune * (1 - cliff) + sandstone * cliff) * dw[..., None]
col += (snow * (1 - cliff * 0.6) + snowrock * cliff * 0.6) * sw[..., None]
# frozen lake: the flat snow basin reads as ice (pale cyan)
lake = (sw > 0.6) & (slope < 0.02) & (sub < 60)
col[lake] = srgb(214, 236, 246)
# beach: wet sand rim + surf line at the water
depth = WATER - sub
shore = sstep(4, 0, np.abs(sub - WATER))[..., None] * (~water)[..., None]
rim = np.where((sw > ICE_SNOW)[..., None], srgb(176, 200, 222), srgb(205, 118, 78))  # wet sand / an icy shore in the snow
col = col * (1 - 0.35 * shore) + rim * 0.35 * shore
seaS, seaD = srgb(124, 214, 216), srgb(34, 128, 178)
wc = seaS + (seaD - seaS) * sstep(0.5, 14, depth)[..., None]
wc = wc * (1 + 0.04 * n2[..., None])
foam = sstep(1.2, 0.2, depth)[..., None]
wc = wc * (1 - foam) + srgb(236, 250, 250) * foam
col = np.where(water[..., None], wc, col)
# desert pools: carved bowl (as FixedMap.placePools), olive / scrub ring, wet edge
for pl in POOLS:
    d = np.hypot(XX - pl['x'], ZZ - pl['z']) - pl['r']
    ring = np.clip(np.where(d < 6, 1, 1 - (d - 6) / 6), 0, 1) * (d > 0)
    col = col + (srgb(96, 120, 44) - col) * (ring * 0.75)[..., None]
    col = np.where((d < 1.4)[..., None] & (d >= 0)[..., None], srgb(150, 110, 76), col)
    col = np.where((d < 0)[..., None], srgb(60, 168, 186), col)
    sub[d < 0] = pl['y']
# FROZEN water (snow: the game's ice — WorldFields.surface): flat at the water level, pale blue-white with darker
# clear-ice windows and a snowy rim
ice = (sub < WATER) & (sw > ICE_SNOW)
icec = srgb(210, 230, 244) * (1 + 0.025 * n2[..., None]) + (srgb(168, 202, 228) - srgb(210, 230, 244)) * (np.clip(0.45 + 0.35 * n3 + 0.25 * n1, 0, 1) * 0.55)[..., None]  # soft clear-ice sheets
col = np.where(ice[..., None], icec, col)
zz = np.where(water | ice, WATER, sub)
verts = np.stack([XX.ravel(), -ZZ.ravel(), zz.ravel()], 1)
idx = np.arange(nv * nv).reshape(nv, nv)
quads = np.stack([idx[:-1, :-1], idx[1:, :-1], idx[1:, 1:], idx[:-1, 1:]], -1).ravel()
mesh_obj('terrain', verts, quads, 4, col.reshape(-1, 3), TERR, smooth=True)
# open sea past the map edge
sea = bpy.data.materials.new('sea'); sea.use_nodes = True
FROZEN_SEA = float(np.mean(np.concatenate([BIO[0, :, 1], BIO[-1, :, 1], BIO[:, 0, 1], BIO[:, -1, 1]]))) > ICE_SNOW
em = sea.node_tree.nodes.new('ShaderNodeEmission'); em.inputs['Color'].default_value = (*(srgb(196, 222, 240) if FROZEN_SEA else seaD), 1)
sea.node_tree.links.new(em.outputs['Emission'], sea.node_tree.nodes['Material Output'].inputs['Surface'])
bpy.ops.mesh.primitive_plane_add(size=8000, location=(0, 0, WATER - 0.5)); bpy.context.object.data.materials.append(sea)

# ---------------------------------------------------------------- roads (packed dirt / sand / snow ribbons)
rv, rf, rc = [], [], []; base = 0
for r in meta['roads']:
    x = np.array(r['x']); z = np.array(r['z'])
    if r['closed']: x = np.r_[x, x[:1]]; z = np.r_[z, z[:1]]
    br = np.array(r['bridge'] + ([r['bridge'][0]] if r['closed'] else []), bool)
    dx = np.gradient(x); dz = np.gradient(z); L = np.hypot(dx, dz) + 1e-9; nx_, nz_ = -dz / L, dx / L
    hw = r['halfWidth'] * (1.15 if r['class'] == 'highway' else 1.0)
    h = sample(H, x, z)
    h = np.where(br, np.array(r['h'] + ([r['h'][0]] if r['closed'] else [])) + OFF, h)
    bb = BIO[np.clip(np.round((z + HALF) / bg['step']).astype(int), 0, BN - 1), np.clip(np.round((x + HALF) / bg['step']).astype(int), 0, BN - 1)]
    c0 = srgb(150, 112, 78); cd = srgb(246, 196, 146); cs = srgb(196, 206, 226)
    c = c0 * (1 - bb[:, :1] - bb[:, 1:]) + cd * bb[:, :1] + cs * bb[:, 1:]
    c = np.where(br[:, None], srgb(140, 92, 56), c)
    edge = c * 0.62
    # 4 strips across: edge | centre | centre | edge
    offs = np.array([-1.0, -0.72, 0.72, 1.0]) * hw
    m = len(x)
    for k, o in enumerate(offs):
        rv.append(np.stack([x + nx_ * o, -(z + nz_ * o), h + 0.35], 1))
        rc.append(edge if k in (0, 3) else c)
    for s in range(3):
        a = base + s * m + np.arange(m - 1); b_ = a + m
        rf.append(np.stack([a, a + 1, b_ + 1, b_], 1).ravel())
    base += 4 * m
ROAD = toon_material('road', soft=0.2)
mesh_obj('roads', np.vstack(rv), np.concatenate(rf), 4, np.vstack(rc), ROAD)

# ---------------------------------------------------------------- vegetation (the map's placements)
def ico():
    t = (1 + 5 ** 0.5) / 2
    v = np.array([[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]], float)
    f = np.array([[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]])
    return v / np.linalg.norm(v[0]), f
ICO_V, ICO_F = ico()
def cone(seg=7):
    a = np.linspace(0, 2 * math.pi, seg, endpoint=False)
    v = np.vstack([np.stack([np.cos(a), np.sin(a), np.zeros(seg)], 1), [[0, 0, 1]]])
    f = np.array([[k, (k + 1) % seg, seg] for k in range(seg)])
    return v, f
CONE_V, CONE_F = cone()

TREES = {'v': [], 'f': [], 'c': [], 'n': 0}
def add(shape, pos, scale, color):
    """Instances of a unit shape (verts, tris) at pos (k, 3) Blender coords, scale (k, 3), colour (k, 3)."""
    V, F = shape; k = len(pos)
    if k == 0: return
    vv = (V[None] * scale[:, None]) + pos[:, None]
    ff = F[None] + (np.arange(k) * len(V))[:, None, None] + TREES['n']
    TREES['v'].append(vv.reshape(-1, 3)); TREES['f'].append(ff.reshape(-1)); TREES['c'].append(np.repeat(color, len(V), 0))
    TREES['n'] += k * len(V)

rng = np.random.default_rng(7)
def placements(t):
    out = [np.array(tile[t]).reshape(-1, props['stride']) for tile in props['placements'].values() if tile.get(t)]
    return np.vstack(out) if out else np.zeros((0, props['stride']))
def ground(p): return sample(H, p[:, 0], p[:, 2])
def snowy(p):
    """Placements standing in the snow (the game grows only conifers there)."""
    if not len(p): return np.zeros(0, bool)
    return BIO[np.clip(np.round((p[:, 2] + HALF) / bg['step']).astype(int), 0, BN - 1), np.clip(np.round((p[:, 0] + HALF) / bg['step']).astype(int), 0, BN - 1)][:, 1] > 0.5
ALL = {t: placements(t) for t in ('pine', 'oak', 'birch', 'cherry', 'pine_snow', 'palm', 'cactus', 'dead_tree')}  # (desert sites in the snow grow conifers: FixedMap SNOW_TREE_SITES)
SNOWY = np.vstack([a[snowy(a)] for a in ALL.values() if len(a)] or [np.zeros((0, props['stride']))])
# forest trees: mostly round dot canopies (the game's broadleaf look), some dark-teal conifers
p = placements('pine'); p = p[~snowy(p)]; k = len(p); gy = ground(p); r_ = rng.uniform(0, 1, k)
broad = r_ < 0.7
sz = rng.uniform(4.0, 6.4, k)
greens = np.array([srgb(52, 128, 40), srgb(84, 150, 42), srgb(126, 170, 46), srgb(40, 104, 54)])
gc = greens[rng.integers(0, 4, k)] * rng.uniform(0.9, 1.1, (k, 1))
pos = np.stack([p[:, 0], -p[:, 2], gy + sz * 1.6], 1)
add((ICO_V, ICO_F), pos[broad], np.stack([sz, sz, sz * 0.85], 1)[broad], gc[broad])
hc = rng.uniform(9, 14, k)
add((CONE_V, CONE_F), np.stack([p[:, 0], -p[:, 2], gy + 1.5], 1)[~broad], np.stack([sz * 0.75, sz * 0.75, hc], 1)[~broad], np.repeat(srgb(30, 92, 84)[None], k, 0)[~broad])
p = SNOWY; k = len(p); gy = ground(p); sz = rng.uniform(2.6, 4.0, k)
add((CONE_V, CONE_F), np.stack([p[:, 0], -p[:, 2], gy + 1.2], 1), np.stack([sz, sz, sz * 3.2], 1), np.repeat(srgb(236, 244, 250)[None], k, 0) * rng.uniform(0.92, 1.0, (k, 1)))
add((CONE_V, CONE_F), np.stack([p[:, 0], -p[:, 2], gy + 0.6], 1), np.stack([sz * 1.1, sz * 1.1, sz * 1.4], 1), np.repeat(srgb(38, 96, 96)[None], k, 0))
p = placements('palm'); p = p[~snowy(p)]
p = p[[kept_palm(a[0], a[2]) for a in p]] if len(p) else p  # the game grows a fifth of them
k = len(p); gy = ground(p)
# a clump of bushes round each palm (scatter.beachTreeNear) and round each desert pool
cl = []
for a in p:
    for q in range(7): ang = q * 0.9 + rng.uniform(0, 0.6); rr = rng.uniform(1.6, 4.2); cl.append([a[0] + math.cos(ang) * rr, a[2] + math.sin(ang) * rr])
for pl in POOLS:
    for q in range(26): ang = rng.uniform(0, 2 * math.pi); rr = pl['r'] + rng.uniform(0.8, 7.5); cl.append([pl['x'] + math.cos(ang) * rr, pl['z'] + math.sin(ang) * rr])
if cl:
    cl = np.array(cl); cs = rng.uniform(1.5, 2.6, len(cl)); cy = sample(H, cl[:, 0], cl[:, 1])
    add((ICO_V, ICO_F), np.stack([cl[:, 0], -cl[:, 1], cy + cs * 0.4], 1), np.stack([cs, cs, cs * 0.7], 1), np.repeat(srgb(96, 156, 52)[None], len(cl), 0))
for a in (range(5) if k else ()):  # (no palms: an all-snow map)
    ang = a * 2 * math.pi / 5 + rng.uniform(0, 1, k)
    add((ICO_V, ICO_F), np.stack([p[:, 0] + 2.6 * np.cos(ang), -p[:, 2] + 2.6 * np.sin(ang), gy + 8], 1), np.stack([2.8, 2.8, 0.6] * np.ones((k, 1)), 1).reshape(k, 3), np.repeat(srgb(70, 170, 50)[None], k, 0))
p = placements('cactus'); p = p[~snowy(p)]; k = len(p); gy = ground(p)
if k: add((ICO_V, ICO_F), np.stack([p[:, 0], -p[:, 2], gy + 1.5], 1), np.stack([0.9, 0.9, 2.2] * np.ones((k, 1)), 1).reshape(k, 3), np.repeat(srgb(86, 140, 50)[None], k, 0))
p = placements('bush')
pb = BIO[np.clip(np.round((p[:, 2] + HALF) / bg['step']).astype(int), 0, BN - 1), np.clip(np.round((p[:, 0] + HALF) / bg['step']).astype(int), 0, BN - 1)]
p = p[pb[:, 0] < 0.3]  # the game grows no stray bushes on the desert / beach sand (scatter: pools and palm clumps only)
k = len(p); gy = ground(p)
bb = BIO[np.clip(np.round((p[:, 2] + HALF) / bg['step']).astype(int), 0, BN - 1), np.clip(np.round((p[:, 0] + HALF) / bg['step']).astype(int), 0, BN - 1)]
bc = np.where(bb[:, 1:] > 0.5, srgb(230, 238, 246), srgb(96, 156, 52))
s = rng.uniform(1.4, 2.4, k)
add((ICO_V, ICO_F), np.stack([p[:, 0], -p[:, 2], gy + s * 0.4], 1), np.stack([s, s, s * 0.7], 1), bc)
for t, c, s0 in (('rock_red', srgb(186, 100, 66), 2.2), ('rock_snow', srgb(150, 162, 190), 2.0), ('rock', srgb(150, 146, 132), 1.8), ('boulder', srgb(160, 150, 136), 3.4)):
    p = placements(t); k = len(p); gy = ground(p); s = rng.uniform(0.7, 1.3, k) * s0
    rc_ = np.where(snowy(p)[:, None], srgb(150, 162, 190), c[None]) if k else np.zeros((0, 3))  # snow-dusted grey in the snow
    add((ICO_V, ICO_F), np.stack([p[:, 0], -p[:, 2], gy + s * 0.3], 1), np.stack([s, s * 0.9, s * 0.7], 1), rc_)

# ---------------------------------------------------------------- set pieces: small coloured blocks (tents, cabins…)
SP = {'tent_orange': srgb(240, 128, 40), 'tent_blue': srgb(60, 120, 220), 'tent_red': srgb(220, 60, 50), 'cabin': srgb(130, 80, 50),
      'shack': srgb(120, 84, 56), 'caravan': srgb(240, 236, 226), 'igloo': srgb(240, 248, 255), 'lift_station': srgb(200, 60, 50),
      'water_tower': srgb(150, 96, 60), 'windmill': srgb(240, 236, 226), 'stunt_loop': srgb(240, 200, 60), 'quarterpipe': srgb(240, 200, 60),
      'wave_ramp': srgb(240, 200, 60), 'dock': srgb(140, 96, 60),}
box_v = np.array([[x, y, z] for x in (-1, 1) for y in (-1, 1) for z in (0, 1)], float)
box_f = np.array([[0, 2, 3], [0, 3, 1], [4, 5, 7], [4, 7, 6], [0, 1, 5], [0, 5, 4], [2, 6, 7], [2, 7, 3], [1, 3, 7], [1, 7, 5], [0, 4, 6], [0, 6, 2]])
for t, c in SP.items():
    p = placements(t); k = len(p)
    if not k: continue
    gy = ground(p); s = 6.0 if t in ('stunt_loop', 'lift_station', 'cabin', 'shack', 'water_tower', 'windmill') else 3.2
    add((box_v, box_f), np.stack([p[:, 0], -p[:, 2], gy], 1), np.stack([s, s, s * 0.9] * np.ones((k, 1)), 1).reshape(k, 3), np.repeat(c[None], k, 0))
mesh_obj('trees', np.vstack(TREES['v']), np.concatenate(TREES['f']), 3, np.vstack(TREES['c']), FOL, smooth=False)

# ---------------------------------------------------------------- light, world, camera
sun = bpy.data.lights.new('sun', 'SUN'); sun.energy = 2.6; sun.angle = math.radians(1.5); sun.color = (1.0, 0.93, 0.82)
so = bpy.data.objects.new('sun', sun); scene.collection.objects.link(so)
# low warm sun from the south-west (shadows fall to the north-east, like the game's afternoon)
so.rotation_euler = (math.radians(58), 0, math.radians(SUN_AZ))
w = scene.world or bpy.data.worlds.new('w'); scene.world = w; w.use_nodes = True
bgn = w.node_tree.nodes['Background']; bgn.inputs['Color'].default_value = (0.55, 0.72, 0.95, 1); bgn.inputs['Strength'].default_value = 0.0
# Bird's-eye, north up, tilted TILT° off vertical so relief stands up and the island fills the map card's frame
# (≈ 1.38 : 1 — the desktop card's 360 × 260 box) without cropping: aspect = 1 / cos(TILT). TILT=0: plain top-down.
cam = bpy.data.cameras.new('cam'); cam.type = 'ORTHO'; cam.ortho_scale = 2 * HALF * (1 if FULL else 0.965); cam.clip_end = 8000
co = bpy.data.objects.new('cam', cam); scene.collection.objects.link(co)
th = math.radians(TILT)
co.rotation_euler = (th, 0, 0)
D = 3000
co.location = (0, -D * math.sin(th), D * math.cos(th) + LIFT * math.sin(th))
scene.camera = co
scene.render.engine = 'BLENDER_EEVEE'
ee = scene.eevee
ee.taa_render_samples = SAMPLES
for k, v in (('use_shadows', True), ('shadow_ray_count', 2), ('shadow_step_count', 8)):
    if hasattr(ee, k): setattr(ee, k, v)
sun.use_shadow = True
if hasattr(sun, 'shadow_maximum_resolution'): sun.shadow_maximum_resolution = 0.25
scene.render.resolution_x = PX; scene.render.resolution_y = int(round(PX * math.cos(th))); scene.render.resolution_percentage = 100
scene.view_settings.view_transform = 'Standard'; scene.view_settings.look = 'None'
scene.view_settings.exposure = 0.0; scene.view_settings.gamma = 1.0
scene.render.filepath = OUT
jpg = OUT.lower().endswith(('.jpg', '.jpeg'))
scene.render.image_settings.file_format = 'JPEG' if jpg else 'PNG'
if jpg: scene.render.image_settings.quality = 88
bpy.ops.render.render(write_still=True)
print('rendered', OUT)
