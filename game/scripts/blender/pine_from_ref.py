"""
PINES FROM THE USER'S REFERENCE (2026-10-24: "make our pine in Blender from this GLB" — a card-built spruce, ~175 flat
fan-shaped branch cards cut from one needle sheet, three spray shapes, in tiers round a thin trunk; ~4.5 k triangles).
Run inside Blender 5.x (the MCP add-on), the reference copied out of Downloads first:

  node scripts/blender/bl.mjs scripts/blender/pine_from_ref.py REF=<pine_tree.glb> OUT=<dir> [RENDER=<png>]

Keeps the reference's BRANCH LAYOUT and its spray SHAPES (the UVs onto its needle sheet), at our cost:
  - every branch card collapsed to a few triangles (UVs kept): small fan tips 2, big fronds 4 (they keep their droop);
  - scaled to a 13 m spruce, trunk on the origin; our own 6-sided red-brown trunk;
  - vertex colours tint the (greyscale) needle sheet: deep green inside, lighter at the branch ends, and for a share of
    branches (per variant) gold / orange tips — the user's autumn sheet;
  - three variants (`pineA` green with a few warm tips, `pineB` taller and greener, `pineGold` the autumn one), each
    `<variant>_lod0/1/2`: LOD1 drops most fan tips and simplifies the fronds, LOD2 keeps the big fronds as quads.
Export: autumn_pine.glb in the game's tree format (U = 8 + u on the needle sheet, 2 = bark texel); the game draws the
sheet in the foliage atlas's spray cell (written as needle_sheet.png next to the GLB: greyscale + alpha, 512²).
"""
import bpy, bmesh, math, os, random, sys
import numpy as np
from mathutils import Vector, Matrix

for a in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []):
    if '=' in a:
        globals()[a.split('=', 1)[0]] = a.split('=', 1)[1]
REF = globals()['REF']
OUT = globals().get('OUT', 'C:/project/Dark/game/src/assets/models/trees/')
RENDER = globals().get('RENDER', '')
os.makedirs(OUT, exist_ok=True)
HEIGHT = 13.0


def srgb(h):
    c = [((h >> s) & 255) / 255 for s in (16, 8, 0)]
    return tuple((x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


DEEP, GREEN, MOSS = srgb(0x24402c), srgb(0x3f6a42), srgb(0x6c8a4a)
GOLD, ORANGE, BARK = srgb(0xd09a3c), srgb(0xd0752e), srgb(0x6b3a24)
VARIANTS = {
    'pineA': dict(scale=1.0, warm=0.18, warmcols=(GOLD, ORANGE), seed=11),
    'pineB': dict(scale=1.12, warm=0.06, warmcols=(GOLD,), seed=23),
    'pineGold': dict(scale=0.95, warm=0.7, warmcols=(ORANGE, GOLD), seed=37),
}

# ---------------------------------------------------------------- the reference, normalised
sc = bpy.data.scenes.get('pine_build') or bpy.data.scenes.new('pine_build')
bpy.context.window_manager.windows[0].scene = sc
for o in list(sc.objects):
    bpy.data.objects.remove(o, do_unlink=True)
# (the variants' names must be exact — the game looks them up: drop same-named objects other scenes still hold)
for o in [o for o in bpy.data.objects if o.name.split('.')[0].split('_lod')[0] in VARIANTS]:
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=REF)
ref = [o for o in sc.objects if o.type == 'MESH']
for o in ref:
    o.data = o.data.copy()
    mw = o.matrix_world.copy(); o.parent = None; o.data.transform(mw); o.matrix_world = Matrix.Identity(4)
for o in [o for o in sc.objects if o.type != 'MESH']:
    bpy.data.objects.remove(o, do_unlink=True)
trunk = next(o for o in ref if o.name.startswith('Trunk'))
pts = [v.co for o in ref for v in o.data.vertices]
z0, z1 = min(p.z for p in pts), max(p.z for p in pts)
tc = sum((v.co for v in trunk.data.vertices), Vector()) / len(trunk.data.vertices)
k = HEIGHT / (z1 - z0)
T = Matrix.Scale(k, 4) @ Matrix.Translation(Vector((-tc.x, -tc.y, -z0)))
for o in ref:
    o.data.transform(T)

# the needle sheet: the branch material's base-colour image (+ its alpha) → greyscale (luminance normalised) + alpha
bm_ = next(m for m in bpy.data.materials if m.name.startswith('M_Pine_Branch'))
img = next(n.image for n in bm_.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image and any(l.to_socket.name == 'Base Color' for l in n.outputs['Color'].links))
w, h = img.size
px = np.array(img.pixels[:], np.float32).reshape(h, w, 4)
lum = px[..., :3] @ np.array([0.3, 0.59, 0.11], np.float32)
a = px[..., 3]
lo_, hi_ = np.percentile(lum[a > 0.5], 3), np.percentile(lum[a > 0.5], 97)
g = np.clip((lum - lo_) / max(1e-4, hi_ - lo_), 0, 1) * 0.75 + 0.25
sheet = np.stack([g, g, g, a], -1)
# dilate colour into empty texels (no dark fringes at low mips)
for _ in range(8):
    m = sheet[..., 3] < 0.5
    sh = [np.roll(sheet, s, ax) for s in (1, -1) for ax in (0, 1)]
    best = np.max([x[..., 0] * (x[..., 3] >= 0.5) for x in sh], 0)
    sheet[..., 0] = np.where(m & (best > 0), best, sheet[..., 0])
sheet[..., 1] = sheet[..., 2] = sheet[..., 0]

# REPACK: the reference's three sprays overlap in UV (the small fan's rectangle holds the fronds' tops) — fine for
# outline-cut cards, scraps on our full-rectangle ones. Each spray is cut to its OWN outline (its card's triangles
# rasterised in UV) and moved to a slot of its own; `remap(uv)` sends a card's UVs there.
SLOTS = [(0.0, 0.0, 0.5, 0.72), (0.5, 0.0, 1.0, 0.72), (0.25, 0.74, 0.75, 1.0)]
regions = {}
for o in ref:
    if not o.name.startswith('Branch'):
        continue
    uvd = o.data.uv_layers.active.data
    us = [l.uv[0] for l in uvd]; vs_ = [l.uv[1] for l in uvd]
    key = (round(min(us), 3), round(min(vs_), 3), round(max(us), 3), round(max(vs_), 3))
    if key not in regions:
        tris_uv = []
        for p in o.data.polygons:
            L = list(p.loop_indices)
            for k in range(1, len(L) - 1):
                tris_uv.append([uvd[L[0]].uv[:], uvd[L[k]].uv[:], uvd[L[k + 1]].uv[:]])
        regions[key] = tris_uv
keys = sorted(regions, key=lambda r: (-(r[2] - r[0]) * (r[3] - r[1]), r[0]))   # the two fronds (biggest) first
packed = np.zeros_like(sheet)
SLOT_OF = {}
yy, xx = np.mgrid[0:h, 0:w]
U_, V_ = (xx + 0.5) / w, (yy + 0.5) / h                          # (Blender pixel rows run bottom-up: v = row / h)
for key, slot in zip(keys, SLOTS):
    SLOT_OF[key] = slot
    u0, v0, u1, v1 = key
    mask = np.zeros((h, w), bool)
    for (a, b, c) in regions[key]:
        d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(d) < 1e-12:
            continue
        l1 = ((b[1] - c[1]) * (U_ - c[0]) + (c[0] - b[0]) * (V_ - c[1])) / d
        l2 = ((c[1] - a[1]) * (U_ - c[0]) + (a[0] - c[0]) * (V_ - c[1])) / d
        mask |= (l1 >= -0.02) & (l2 >= -0.02) & (1 - l1 - l2 >= -0.02)
    src = sheet.copy(); src[..., 3] *= mask
    # destination pixels of the slot → source UVs (nearest)
    s0, t0, s1, t1 = slot
    dm = (U_ >= s0) & (U_ < s1) & (V_ >= t0) & (V_ < t1)
    su = u0 + (U_[dm] - s0) / (s1 - s0) * (u1 - u0); sv = v0 + (V_[dm] - t0) / (t1 - t0) * (v1 - v0)
    packed[dm] = src[np.clip((sv * h).astype(int), 0, h - 1), np.clip((su * w).astype(int), 0, w - 1)]
packed[..., :3] = np.where(packed[..., 3:] > 0.5, packed[..., :3], sheet[..., :3].mean())


def remap(key, u, v):
    u0, v0, u1, v1 = key; s0, t0, s1, t1 = SLOT_OF[key]
    return s0 + (u - u0) / (u1 - u0) * (s1 - s0), t0 + (v - v0) / (v1 - v0) * (t1 - t0)


sheet = packed
if bpy.data.images.get('needle_sheet'):
    bpy.data.images.remove(bpy.data.images['needle_sheet'])
sim = bpy.data.images.new('needle_sheet', w, h, alpha=True)
sim.pixels[:] = sheet.ravel()
sim.scale(512, 512)
sim.filepath_raw = os.path.join(OUT, 'needle_sheet.png'); sim.file_format = 'PNG'; sim.save()


# ---------------------------------------------------------------- build a variant
def card_tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def resample(o, cols, rows, bend=True):
    """The branch card re-cut as a clean cols × rows grid over its spray's whole UV rectangle. The reference cuts
    each card to its spray's OUTLINE (13–27 points round the needles), so the rectangle's corners lie off the mesh:
    the card's surface is fitted as a smooth map UV → position (least squares over its own vertices: affine + a bend
    along the spray) and evaluated at the grid — the quad covers the whole spray image, the alpha cuts it out as the
    reference's outline did, the texture is never stretched (a collapse decimate moved vertices across the needles;
    clamping the corners onto the outline squashed every card). Returns [(pos, (u, v))] row-major."""
    me = o.data; uv = me.uv_layers.active.data
    U, X = [], []
    for l in me.loops:
        U.append(uv[l.index].uv[:]); X.append(me.vertices[l.vertex_index].co[:])
    U = np.array(U); X = np.array(X)
    u0, v0 = U.min(0); u1, v1 = U.max(0)
    s = np.array([u1 - u0, v1 - v0]); s[s < 1e-6] = 1
    N = (U - [u0, v0]) / s                                               # 0..1 over the rectangle
    long_u = s[0] >= s[1]
    t = N[:, 0] if long_u else N[:, 1]
    A = np.stack([np.ones(len(N)), N[:, 0], N[:, 1], t * t if bend else 0 * t], 1)   # (small fans: flat — a bend over-extends them)
    coef, *_ = np.linalg.lstsq(A, X, rcond=None)
    out = []
    for j in range(rows):
        for i in range(cols):
            a, b = i / (cols - 1), j / (rows - 1)
            tt = a if long_u else b
            p = np.array([1.0, a, b, tt * tt if bend else 0.0]) @ coef
            out.append((Vector(p), (u0 + a * s[0], v0 + b * s[1])))
    return out


def build(name, v, lod, mat, parent):
    rng = random.Random(v['seed'] * 10 + lod)
    bm = bmesh.new()
    col = bm.loops.layers.float_color.new('Col'); uvl = bm.loops.layers.uv.new('UVMap')
    rot = Matrix.Rotation(rng.uniform(0, 6.283), 4, 'Z') @ Matrix.Scale(v['scale'], 4)
    cards = [o for o in ref if o.name.startswith('Branch')]
    for o in cards:
        small = card_tris(o) < 20
        if lod == 1 and small and rng.random() < 0.6:
            continue
        if lod == 2 and small:
            continue
        target = (2 if small else 4) if lod == 0 else 2
        # grid along the card's long UV side: big fronds 3 × 2 (4 triangles, they keep their droop), fan tips 2 × 2
        us = [l.uv[0] for l in o.data.uv_layers.active.data]; vs_ = [l.uv[1] for l in o.data.uv_layers.active.data]
        long_u = (max(us) - min(us)) >= (max(vs_) - min(vs_))
        n_long = 3 if target >= 4 else 2
        cols, rows = (n_long, 2) if long_u else (2, n_long)
        grid = resample(o, cols, rows, bend=not small)
        key = (round(min(us), 3), round(min(vs_), 3), round(max(us), 3), round(max(vs_), 3))
        ctr = sum((p for p, _ in grid), Vector()) / len(grid)
        hfrac = ctr.z / HEIGHT
        warm = rng.random() < v['warm']
        tip = rng.choice(v['warmcols']) if warm else mix(MOSS, GREEN, rng.uniform(0, 0.5))
        reach = max(0.5, 3.6 * (1 - hfrac) + 0.6)
        base = mix(DEEP, GREEN, 0.25 + 0.35 * hfrac)
        vv = []
        for p, (u_, v_) in grid:
            out = min(1.0, Vector((p.x, p.y)).length / reach)                  # 0 at the trunk → 1 at the tip
            ru, rv = remap(key, u_, v_)
            vv.append((bm.verts.new(rot @ p), (8.0 + ru, rv), mix(base, tip, out ** 1.5 * (0.9 if warm else 0.6))))
        for j in range(rows - 1):
            for i in range(cols - 1):
                a, b, c_, d = j * cols + i, j * cols + i + 1, (j + 1) * cols + i + 1, (j + 1) * cols + i
                for tri in ((a, b, c_), (a, c_, d)):
                    try:
                        f = bm.faces.new([vv[t][0] for t in tri])
                    except ValueError:
                        continue
                    for l, t in zip(f.loops, tri):
                        l[uvl].uv = vv[t][1]; l[col] = (*vv[t][2], 1.0)
    # our trunk: tapered, red-brown (U 2 = the bark texel)
    sides = (6, 5, 4)[lod]
    top = HEIGHT * 0.92 * v['scale']
    for i in range(sides):
        a0, a1 = 2 * math.pi * i / sides, 2 * math.pi * (i + 1) / sides
        P = lambda a, z, r: Vector((math.cos(a) * r, math.sin(a) * r, z))
        quad = [P(a0, 0, 0.2), P(a1, 0, 0.2), P(a1, top, 0.03), P(a0, top, 0.03)]   # (slim, as the reference)
        for tri in ((0, 1, 2), (0, 2, 3)):
            f = bm.faces.new([bm.verts.new(quad[j]) for j in tri])
            for l, j in zip(f.loops, tri):
                l[uvl].uv = (2.0, 0.5); l[col] = (*(mix(BARK, DEEP, 0.3) if j < 2 else BARK), 1.0)
    nm = f'{name}_lod{lod}'
    if bpy.data.meshes.get(nm):
        bpy.data.meshes.remove(bpy.data.meshes[nm])
    me = bpy.data.meshes.new(nm)
    bm.to_mesh(me); bm.free()
    me.materials.append(mat)
    ob = bpy.data.objects.new(nm, me); sc.collection.objects.link(ob); ob.parent = parent
    return ob


mat = bpy.data.materials.get('pine_preview') or bpy.data.materials.new('pine_preview')
mat.use_nodes = True
nt = mat.node_tree
for n in list(nt.nodes):
    if n.type not in ('BSDF_PRINCIPLED', 'OUTPUT_MATERIAL'):
        nt.nodes.remove(n)
bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = sim
uvn = nt.nodes.new('ShaderNodeUVMap'); uvn.uv_map = 'UVMap'
sep = nt.nodes.new('ShaderNodeSeparateXYZ'); comb = nt.nodes.new('ShaderNodeCombineXYZ'); sub = nt.nodes.new('ShaderNodeMath'); sub.operation = 'FRACT'
nt.links.new(uvn.outputs['UV'], sep.inputs[0]); nt.links.new(sep.outputs['X'], sub.inputs[0])
nt.links.new(sub.outputs[0], comb.inputs['X']); nt.links.new(sep.outputs['Y'], comb.inputs['Y']); nt.links.new(comb.outputs[0], tex.inputs['Vector'])
vc = nt.nodes.new('ShaderNodeVertexColor'); vc.layer_name = 'Col'
mul = nt.nodes.new('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'; mul.inputs['Factor'].default_value = 1.0
nt.links.new(tex.outputs['Color'], mul.inputs['A']); nt.links.new(vc.outputs['Color'], mul.inputs['B'])
nt.links.new(mul.outputs['Result'], bsdf.inputs['Base Color'])
# (bark: U 2 → fract 0 = column 0 of the sheet, opaque? no — alpha only where U ≥ 8)
gt = nt.nodes.new('ShaderNodeMath'); gt.operation = 'LESS_THAN'; gt.inputs[1].default_value = 7.5
nt.links.new(sep.outputs['X'], gt.inputs[0])
amax = nt.nodes.new('ShaderNodeMath'); amax.operation = 'MAXIMUM'
nt.links.new(tex.outputs['Alpha'], amax.inputs[0]); nt.links.new(gt.outputs[0], amax.inputs[1])
nt.links.new(amax.outputs[0], bsdf.inputs['Alpha'])
mat.blend_method = 'CLIP' if hasattr(mat, 'blend_method') else mat.blend_method
if hasattr(mat, 'surface_render_method'):
    mat.surface_render_method = 'DITHERED'
bsdf.inputs['Roughness'].default_value = 0.9

roots, report = [], {}
for name, v in VARIANTS.items():
    root = bpy.data.objects.new(name, None); sc.collection.objects.link(root); roots.append(root)
    obs = [build(name, v, l, mat, root) for l in range(3)]
    report[name] = [sum(len(p.vertices) - 2 for p in o.data.polygons) for o in obs]
print('TRIS', report)
for o in ref:
    o.hide_render = True; o.hide_set(True)

if RENDER:
    for i, r in enumerate(roots):
        r.location = ((i - 1) * 9.0, 0, 0)
        for c in r.children:
            c.hide_render = not c.name.endswith('_lod0')
    cam = bpy.data.objects.get('pb_cam') or bpy.data.objects.new('pb_cam', bpy.data.cameras.new('pb_cam'))
    if cam.name not in sc.collection.objects:
        sc.collection.objects.link(cam)
    sc.camera = cam; cam.data.lens = 40
    cam.location = (0, -30, 6.8); cam.rotation_euler = (math.radians(89), 0, 0)
    sun = bpy.data.objects.get('pb_sun') or bpy.data.objects.new('pb_sun', bpy.data.lights.new('pb_sun', 'SUN'))
    if sun.name not in sc.collection.objects:
        sc.collection.objects.link(sun)
    sun.data.energy = 3.5; sun.data.color = (1.0, 0.9, 0.75); sun.rotation_euler = (math.radians(55), 0, math.radians(-50))
    if not sc.world:
        sc.world = bpy.data.worlds.new('pb_world')
    sc.world.use_nodes = True
    sc.world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.32, 0.4, 0.52, 1)
    sc.world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.9
    eng = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
    sc.render.engine = 'BLENDER_EEVEE' if 'BLENDER_EEVEE' in eng else 'BLENDER_EEVEE_NEXT'
    sc.render.film_transparent = False
    sc.render.resolution_x, sc.render.resolution_y = 1500, 900
    sc.render.filepath = RENDER
    bpy.ops.render.render(write_still=True)
    print('RENDERED', RENDER)
