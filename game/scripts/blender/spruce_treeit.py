"""
TREEIT SPRUCE (2026-10-24: the user's spruce from Tree It — spruce.fbx, 7.1 k triangles: 200 green branch cards, 17 dry
ones, 18 bare-twig ones (12-triangle outline fans on three 1024² textures), a 4 k-triangle trunk with 45 branch stubs).
Optimised into the game's tree format, headless (no live session needed):

  blender -b --python scripts/blender/spruce_treeit.py -- FBX=<spruce.fbx> TEX=<Tree It install dir> [OUT=<dir>] [RENDER=<png>]

  - the three branch textures → ONE 512² greyscale + alpha sheet (2 × 2 slots: green spray, dry spray, twigs, a spare
    green copy), luminance normalised, colour dilated into the empty texels: `spruce_sheet.png`, drawn by the game in the
    foliage atlas's spray cell (FoliageAtlas.setSpraySheet) — vertex colours give the hue;
  - every card re-cut as its texture's whole square (U = 8 + u on the sheet), fitted to the card's own surface (least
    squares UV → position: affine + droop along the stem diagonal + droop of the sides) and folded along the stem: LOD0
    2 triangles per card (the V of a real spruce spray), LOD1 drops the twigs and the smaller half of the inner sprays,
    LOD2 keeps the biggest outer sprays;
  - our own tapered trunk (bark texel, U 2), the TreeIt stubs dropped (hidden by the sprays);
  - cone-shaped normals (out from the trunk, tilted up): the crown lights as one volume, no flat card flashes;
  - three variants as before (`pineA` green, `pineB` taller and mirrored, `pineGold` with warm autumn tips on a share of
    its sprays), each `<variant>_lod0/1/2` → spruce_treeit.glb. LOD0 ≈ 500, LOD1 ≈ 230, LOD2 ≈ 100 triangles.
"""
import bpy, bmesh, math, os, random, sys
import numpy as np
from mathutils import Vector, Matrix

for a in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []):
    if '=' in a:
        globals()[a.split('=', 1)[0]] = a.split('=', 1)[1]
FBX = globals()['FBX']
TEX = globals().get('TEX', 'C:/Program Files (x86)/Tree It')
OUT = globals().get('OUT', 'C:/project/Dark/game/src/assets/models/trees/')
RENDER = globals().get('RENDER', '')
os.makedirs(OUT, exist_ok=True)
HEIGHT = 13.0


def srgb(h):
    c = [((h >> s) & 255) / 255 for s in (16, 8, 0)]
    return tuple((x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


DEEP, GREEN, TIP = srgb(0x1f3a22), srgb(0x365f34), srgb(0x638a46)
DRY, TWIG, BARK = srgb(0x6b6236), srgb(0x6a5848), srgb(0x3e3026)
GOLD, ORANGE = srgb(0xd09a3c), srgb(0xd0752e)
VARIANTS = {
    'pineA': dict(scale=1.0, mirror=False, warm=0.0, seed=11),
    'pineB': dict(scale=1.12, mirror=True, warm=0.05, seed=23),
    'pineGold': dict(scale=0.95, mirror=False, warm=0.6, seed=37),
}
# sheet slots (Blender UV, v up): u0, v0, u1, v1 per texture
SLOT = {'branch 1': (0.0, 0.5, 0.5, 1.0), 'branch 2': (0.5, 0.5, 1.0, 1.0), 'branch 3': (0.0, 0.0, 0.5, 0.5)}
PAD = 0.012

# ---------------------------------------------------------------- import (Tree It is Y-up: stand it on Z)
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
bpy.ops.wm.fbx_import(filepath=FBX)
meshes = [o for o in sc.objects if o.type == 'MESH']
for o in meshes:
    mw = o.matrix_world.copy(); o.parent = None; o.data.transform(mw); o.matrix_world = Matrix.Identity(4)
    o.data.transform(Matrix.Rotation(math.radians(90), 4, 'X'))
for o in [o for o in sc.objects if o.type != 'MESH']:
    bpy.data.objects.remove(o, do_unlink=True)
pts = [v.co for o in meshes for v in o.data.vertices]
z0, z1 = min(p.z for p in pts), max(p.z for p in pts)
bark = next(o for o in meshes if o.name.startswith('bark'))
low = [v.co for v in bark.data.vertices if v.co.z < z0 + 0.3]
cx, cy = sum(p.x for p in low) / len(low), sum(p.y for p in low) / len(low)
K = HEIGHT / (z1 - z0)
T = Matrix.Scale(K, 4) @ Matrix.Translation(Vector((-cx, -cy, -z0)))
for o in meshes:
    o.data.transform(T)

# ---------------------------------------------------------------- the sheet
S = 1024
sheet = np.zeros((S, S, 4), np.float32)
for key, (s0, t0, s1, t1) in SLOT.items():
    im = bpy.data.images.load(os.path.join(TEX, 'Trees', 'samples Library', 'spruce', f'spruce {key}.png'))
    w, h = im.size
    px = np.array(im.pixels[:], np.float32).reshape(h, w, 4)
    lum = px[..., :3] @ np.array([0.3, 0.59, 0.11], np.float32)
    a = px[..., 3]
    lo_, hi_ = np.percentile(lum[a > 0.5], 3), np.percentile(lum[a > 0.5], 97)
    g = np.clip((lum - lo_) / max(1e-4, hi_ - lo_), 0, 1) * 0.7 + 0.3
    # nearest-sample the texture into its slot (inset by PAD: no bleeding between slots at low mips)
    X0, Y0 = int((s0 + PAD) * S), int((t0 + PAD) * S)
    X1, Y1 = int((s1 - PAD) * S), int((t1 - PAD) * S)
    yy, xx = np.mgrid[Y0:Y1, X0:X1]
    sy = np.clip(((yy - Y0 + 0.5) / (Y1 - Y0) * h).astype(int), 0, h - 1)
    sx = np.clip(((xx - X0 + 0.5) / (X1 - X0) * w).astype(int), 0, w - 1)
    sheet[Y0:Y1, X0:X1, 0] = g[sy, sx]
    sheet[Y0:Y1, X0:X1, 3] = a[sy, sx]
    if key == 'branch 1':   # the spare slot: a second copy of the green spray (bottom-right)
        sheet[Y0 - S // 2:Y1 - S // 2, X0 + S // 2:X1 + S // 2] = sheet[Y0:Y1, X0:X1]
# dilate colour into the empty texels (no dark fringes at low mips)
for _ in range(10):
    m = sheet[..., 3] < 0.5
    best = np.max([np.roll(sheet, s, ax)[..., 0] * (np.roll(sheet, s, ax)[..., 3] >= 0.5) for s in (1, -1) for ax in (0, 1)], 0)
    sheet[..., 0] = np.where(m & (sheet[..., 0] == 0) & (best > 0), best, sheet[..., 0])
sheet[..., 0] = np.where(sheet[..., 0] == 0, 0.5, sheet[..., 0])
sheet[..., 1] = sheet[..., 2] = sheet[..., 0]
sim = bpy.data.images.new('spruce_sheet', S, S, alpha=True)
sim.pixels[:] = sheet.ravel()
sim.scale(512, 512)
sim.filepath_raw = os.path.join(OUT, 'spruce_sheet.png'); sim.file_format = 'PNG'; sim.save()


# ---------------------------------------------------------------- cards
def components(me):
    bm = bmesh.new(); bm.from_mesh(me)
    uvl = bm.loops.layers.uv.active
    seen, out = set(), []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack, faces = [f], []
        seen.add(f.index)
        while stack:
            x = stack.pop(); faces.append(x)
            for e in x.edges:
                for y in e.link_faces:
                    if y.index not in seen:
                        seen.add(y.index); stack.append(y)
        U = np.array([l[uvl].uv[:] for x in faces for l in x.loops])
        P = np.array([l.vert.co[:] for x in faces for l in x.loops])
        out.append((U, P))
    bm.free()
    return out


def fit(U, P):
    """The card's surface as a smooth map UV → position (least squares over its own fan): affine + droop along the stem
    (the texture's stem runs corner (0,0) → (1,1)) + droop of the sides; evaluated at the texture's four corners and the
    stem's middle."""
    s = (U[:, 0] + U[:, 1]) / 2; d = U[:, 0] - U[:, 1]
    A = np.stack([np.ones(len(U)), U[:, 0], U[:, 1], s * s, d * d], 1)
    coef, *_ = np.linalg.lstsq(A, P, rcond=None)
    ev = lambda u, v: Vector(np.array([1.0, u, v, ((u + v) / 2) ** 2, (u - v) ** 2]) @ coef)
    return {c: ev(*c) for c in ((0, 0), (1, 0), (1, 1), (0, 1))}


cards = []   # (kind, corners, size, reach)
for o in meshes:
    kind = next((k for k in SLOT if k in o.name), None)
    if not kind:
        continue
    for U, P in components(o.data):
        c = fit(U, P)
        size = (c[(1, 1)] - c[(0, 0)]).length
        mid = (c[(0, 0)] + c[(1, 1)]) / 2
        cards.append(dict(kind=kind, c=c, size=size, r=Vector((mid.x, mid.y)).length, z=mid.z))
print('CARDS', {k: sum(1 for c in cards if c['kind'] == k) for k in SLOT})


# LOD1 / LOD2 keep the biggest green sprays of every HEIGHT BAND (ranked over the whole tree, the big low sprays won and
# the crown's top went bare)
BANDS = 8
for c in cards:
    c['band'] = min(BANDS - 1, int(c['z'] / HEIGHT * BANDS))
    c['rank'] = c['size'] * (0.6 + c['r'])
for b in range(BANDS):
    band = sorted((c for c in cards if c['kind'] == 'branch 1' and c['band'] == b), key=lambda c: -c['rank'])
    for i, c in enumerate(band):
        c['order'] = (i + 0.5) / len(band)   # 0 = the band's biggest


def keep(card, lod, rng):
    if lod == 0:
        return True
    if card['kind'] == 'branch 3':
        return False
    if card['kind'] == 'branch 2':
        return lod == 1
    return card['order'] < (0.55 if lod == 1 else 0.24)


def build(name, v, lod, mat, parent):
    rng = random.Random(v['seed'] * 10 + lod)
    bm = bmesh.new()
    col = bm.loops.layers.float_color.new('Col'); uvl = bm.loops.layers.uv.new('UVMap')
    M = Matrix.Rotation(rng.uniform(0, 6.283), 4, 'Z') @ Matrix.Scale(v['scale'], 4)
    if v['mirror']:
        M = M @ Matrix.Scale(-1, 4, Vector((1, 0, 0)))
    nrm = []   # per loop: the cone normal
    grow = (1.15, 1.3, 1.5)[lod]   # fewer cards → each a bit bigger (the crown stays full)
    for card in cards:
        if not keep(card, lod, rng):
            continue
        s0, t0, s1, t1 = SLOT[card['kind']]
        if card['kind'] == 'branch 1' and rng.random() < 0.5:
            s0, t0, s1, t1 = 0.5, 0.0, 1.0, 0.5        # the spare copy: same spray (mips/filtering spread)
        ctr = (card['c'][(0, 0)] + card['c'][(1, 1)]) / 2
        hfrac = ctr.z / HEIGHT
        warm = card['kind'] == 'branch 1' and rng.random() < v['warm']
        if card['kind'] == 'branch 1':
            base, tip = mix(DEEP, GREEN, 0.2 + 0.4 * hfrac), (rng.choice((GOLD, ORANGE)) if warm else mix(GREEN, TIP, rng.uniform(0.2, 0.8)))
        elif card['kind'] == 'branch 2':
            base, tip = mix(DEEP, DRY, 0.5), DRY
        else:
            base, tip = TWIG, TWIG
        reach = max(0.6, 3.4 * (1 - hfrac) + 0.5)
        vs = {}
        for uv, p in card['c'].items():
            q = card['c'][(0, 0)] + (p - card['c'][(0, 0)]) * grow   # (grown from the stem's base, on the trunk side)
            out = min(1.0, Vector((q.x, q.y)).length / reach)
            vs[uv] = (bm.verts.new(M @ q), (8.0 + s0 + PAD + uv[0] * (s1 - s0 - 2 * PAD), t0 + PAD + uv[1] * (t1 - t0 - 2 * PAD)),
                      mix(base, tip, out ** 1.4 * (0.95 if warm else 0.7)))
        for tri in (((0, 0), (1, 0), (1, 1)), ((0, 0), (1, 1), (0, 1))):   # folded along the stem diagonal
            try:
                f = bm.faces.new([vs[t][0] for t in tri])
            except ValueError:
                continue
            for l, t in zip(f.loops, tri):
                l[uvl].uv = vs[t][1]; l[col] = (*vs[t][2], 1.0)
    # trunk: tapered, (U 2 = the bark texel)
    sides, segs = ((7, 3), (5, 2), (4, 1))[lod]
    top = HEIGHT * 0.9
    P = lambda a, z, r: Vector((math.cos(a) * r, math.sin(a) * r, z))
    rad = lambda z: 0.17 * (1 - z / top) ** 1.2 + 0.01
    for k in range(segs):
        za, zb = top * (k / segs) ** 1.4, top * ((k + 1) / segs) ** 1.4
        for i in range(sides):
            a0, a1 = 2 * math.pi * i / sides, 2 * math.pi * (i + 1) / sides
            quad = [P(a0, za, rad(za)), P(a1, za, rad(za)), P(a1, zb, rad(zb)), P(a0, zb, rad(zb))]
            f = bm.faces.new([bm.verts.new(M @ q) for q in quad])
            for l, j in zip(f.loops, range(4)):
                l[uvl].uv = (2.0, 0.5); l[col] = (*mix(BARK, DEEP, 0.35 if za < 0.5 else 0.1), 1.0)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    nm = f'{name}_lod{lod}'
    me = bpy.data.meshes.new(nm)
    bm.to_mesh(me); bm.free()
    # cone normals: out from the trunk, tilted up (sprays) — the trunk keeps its own
    uvd = me.uv_layers['UVMap'].data
    ns = []
    for l in me.loops:
        p = me.vertices[l.vertex_index].co
        if uvd[l.index].uv[0] > 7.5:
            ns.append(Vector((p.x, p.y, 0.0)).normalized() * 0.85 + Vector((0, 0, 0.55)))
        else:
            ns.append(Vector((p.x, p.y, 0.0)).normalized())
    me.normals_split_custom_set([n.normalized() for n in ns])
    me.materials.append(mat)
    ob = bpy.data.objects.new(nm, me); sc.collection.objects.link(ob); ob.parent = parent
    return ob


# preview material (Blender render only; the game uses its vegetation material)
mat = bpy.data.materials.new('spruce_preview')
mat.use_nodes = True
nt = mat.node_tree
bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = sim
uvn = nt.nodes.new('ShaderNodeUVMap'); uvn.uv_map = 'UVMap'
sep = nt.nodes.new('ShaderNodeSeparateXYZ'); comb = nt.nodes.new('ShaderNodeCombineXYZ'); fr = nt.nodes.new('ShaderNodeMath'); fr.operation = 'FRACT'
nt.links.new(uvn.outputs['UV'], sep.inputs[0]); nt.links.new(sep.outputs['X'], fr.inputs[0])
nt.links.new(fr.outputs[0], comb.inputs['X']); nt.links.new(sep.outputs['Y'], comb.inputs['Y']); nt.links.new(comb.outputs[0], tex.inputs['Vector'])
vc = nt.nodes.new('ShaderNodeVertexColor'); vc.layer_name = 'Col'
mul = nt.nodes.new('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'; mul.inputs['Factor'].default_value = 1.0
nt.links.new(tex.outputs['Color'], mul.inputs['A']); nt.links.new(vc.outputs['Color'], mul.inputs['B'])
nt.links.new(mul.outputs['Result'], bsdf.inputs['Base Color'])
lt = nt.nodes.new('ShaderNodeMath'); lt.operation = 'LESS_THAN'; lt.inputs[1].default_value = 7.5
nt.links.new(sep.outputs['X'], lt.inputs[0])
mx = nt.nodes.new('ShaderNodeMath'); mx.operation = 'MAXIMUM'
nt.links.new(tex.outputs['Alpha'], mx.inputs[0]); nt.links.new(lt.outputs[0], mx.inputs[1])
nt.links.new(mx.outputs[0], bsdf.inputs['Alpha'])
bsdf.inputs['Roughness'].default_value = 0.9

for o in meshes:
    bpy.data.objects.remove(o, do_unlink=True)
roots, report = [], {}
for name, v in VARIANTS.items():
    root = bpy.data.objects.new(name, None); sc.collection.objects.link(root); roots.append(root)
    obs = [build(name, v, l, mat, root) for l in range(3)]
    report[name] = [sum(len(p.vertices) - 2 for p in o.data.polygons) for o in obs]
print('TRIS', report)

path = os.path.join(OUT, 'spruce_treeit.glb')
bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_cameras=False, export_lights=False, export_materials='NONE',
                          export_animations=False, export_yup=True, export_vertex_color='ACTIVE', export_normals=True)
print('EXPORTED', path, os.path.getsize(path))

if RENDER:
    for i, r in enumerate(roots):
        for l in range(3):
            c = next(c for c in r.children if c.name.endswith(f'_lod{l}'))
            c.location = ((l - 1) * 8.0, i * 0.0, 0) if i == 0 else ((i - 1) * 8.0 + 30, 0, 0) if l == 0 else (0, 0, -100)
    for r in roots[1:]:
        for c in r.children:
            c.hide_render = not c.name.endswith('_lod0')
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam)
    sc.camera = cam; cam.data.lens = 28
    cam.location = (15, -46, 7.5); cam.rotation_euler = (math.radians(88), 0, 0)
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); sc.collection.objects.link(sun)
    sun.data.energy = 3.5; sun.data.color = (1.0, 0.92, 0.8); sun.rotation_euler = (math.radians(55), 0, math.radians(-40))
    sc.world = bpy.data.worlds.new('w')
    sc.world.use_nodes = True
    sc.world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.35, 0.42, 0.52, 1)
    eng = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
    sc.render.engine = 'BLENDER_EEVEE' if 'BLENDER_EEVEE' in eng else 'BLENDER_EEVEE_NEXT'
    sc.render.resolution_x, sc.render.resolution_y = 1800, 800
    sc.render.filepath = RENDER
    bpy.ops.render.render(write_still=True)
    print('RENDERED', RENDER)
