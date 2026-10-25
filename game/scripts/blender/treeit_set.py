"""
TREE IT SET (2026-10-24: the user's Tree It trees — juniper, beech, elm, fir, bamboo, acacia .fbx; 2–9 k triangles each,
a bark mesh and a leaf-card mesh on Tree It's own textures). Optimised into the game's tree format, one GLB, run in
the live Blender (its own scene — the open one is left alone):

  node scripts/blender/bl.mjs scripts/blender/treeit_set.py [SRC=<dir with the .fbx>] [OUT=<dir>] [RENDER=<png>]

  - every leaf card re-cut as its texture's whole square (least-squares fit UV → position, as spruce_treeit.py) and
    folded along the stem diagonal: 2 triangles; U = 8 + 2 × cell + u — the foliage atlas's per-species cell
    (FoliageAtlas ATLAS_CELLS: conifer sheet 4 — fir / juniper / bamboo slots —, beech 5, elm 6, acacia 7), where the
    game paints that species' Genshin leaf (genshinLeaves.ts), drawn in the Tree It texture's layout (stem from the
    square's bottom-left corner) so the cards line up with it. Fixed cards (not camera-facing): the tree keeps its shape.
  - LODs keep a share of the cards (biggest first, spread through the crown's height), each grown to keep the leaf
    AREA: LOD0 ≤ 180 cards, LOD1 70, LOD2 26;
  - the bark: its small twigs dropped (hidden by the leaves), the rest collapse-decimated — LOD0 ≈ 420, LOD1 ≈ 140, LOD2
    ≈ 40 triangles (U 2, the bark texel; bamboo culms U 4, the plain solid in culm green);
  - vertex colours: Genshin greens per species, dark inside → light outer tips; bark dark at the foot;
  - normals: leaves out from the crown's centre (an ellipsoid, tilted up: soft volume light, no flat card flashes),
    bark smooth.
  Each species `<name>` with `<name>_lod0/1/2` → treeit_set.glb (assets/treeModels.ts registers them).
"""
import bpy, bmesh, math, os, random
import numpy as np
from mathutils import Vector, Matrix

SRC = globals().get('SRC', 'C:/Users/johnr/Downloads')
OUT = globals().get('OUT', 'C:/project/Dark/game/src/assets/models/trees/')
RENDER = globals().get('RENDER', '')


def srgb(h):
    c = [((h >> s) & 255) / 255 for s in (16, 8, 0)]
    return tuple((x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


# slots inside a cell (cell-local UV, v up) — FoliageAtlas SHEET_SLOTS
FULL = (0.0, 0.0, 1.0, 1.0)
SLOTS = [(0.0, 0.5, 0.5, 1.0), (0.5, 0.5, 1.0, 1.0), (0.0, 0.0, 0.5, 0.5), (0.5, 0.0, 1.0, 0.5)]
PAD = 0.012
# name: atlas cell, slots, height (m), bark (foot, top), culm (plain solid), leaves (deep, mid, tip), LOD card caps,
# fill (every card grown by this much more — a full Genshin crown, not Tree It's airy one)
SPECIES = {
    'beech':   dict(cell=5, slots=[FULL], height=13.0, bark=(0x6b675f, 0x9a978e), leaf=(0x2f5b2b, 0x4f9139, 0x95cc58), cards=(180, 70, 26), fill=1.45),
    'elm':     dict(cell=6, slots=[FULL], height=14.0, bark=(0x46392e, 0x6c5b4a), leaf=(0x29502a, 0x467f35, 0x7fb24a), cards=(180, 70, 26), fill=1.25),
    'acacia':  dict(cell=7, slots=[FULL], height=8.0, bark=(0x3e3026, 0x5f4a38), leaf=(0x4a6a2c, 0x7b9a40, 0xb8c66a), cards=(170, 70, 26), fill=1.3),
    'fir':     dict(cell=4, slots=[SLOTS[0], SLOTS[3]], height=14.0, bark=(0x3f342c, 0x6a5d50), leaf=(0x173d2c, 0x2c6146, 0x58936a), cards=(180, 70, 26), fill=1.3),
    'juniper': dict(cell=4, slots=[SLOTS[1]], height=6.5, bark=(0x3e2a20, 0x5e4334), leaf=(0x26473b, 0x406d5b, 0x76a08a), cards=(81, 45, 20), fill=2.4),
    'bamboo':  dict(cell=4, slots=[SLOTS[2]], height=10.0, bark=(0x6f8a34, 0xb2b45c), culm=True, leaf=(0x3a6c2c, 0x67a343, 0xa8d466), cards=(171, 70, 26), fill=1.45),
}
BARK_TRIS = (420, 140, 40)

# ---------------------------------------------------------------- a scene of our own
sc = bpy.data.scenes.get('treeit_set') or bpy.data.scenes.new('treeit_set')
win = bpy.context.window
prev = win.scene
win.scene = sc
for o in list(sc.objects):
    bpy.data.objects.remove(o, do_unlink=True)


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
        A = sum(x.calc_area() for x in faces)
        out.append((U, P, A, [x.index for x in faces]))
    bm.free()
    return out


def fit(U, P):
    """UV → position (least squares, affine + droop along / across the stem), at the texture square's corners."""
    s = (U[:, 0] + U[:, 1]) / 2; d = U[:, 0] - U[:, 1]
    A = np.stack([np.ones(len(U)), U[:, 0], U[:, 1], s * s, d * d], 1)
    coef, *_ = np.linalg.lstsq(A, P, rcond=None)
    ev = lambda u, v: Vector(np.array([1.0, u, v, ((u + v) / 2) ** 2, (u - v) ** 2]) @ coef)
    return {c: ev(*c) for c in ((0, 0), (1, 0), (1, 1), (0, 1))}


def bark_lod(src, lod, keep_area):
    """The bark mesh without its small parts (area < keep_area of the biggest), collapse-decimated to BARK_TRIS[lod]."""
    comps = components(src.data)
    big = max(c[2] for c in comps)
    keep = set(i for c in comps if c[2] >= keep_area * big for i in c[3])
    bm = bmesh.new(); bm.from_mesh(src.data)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.index not in keep], context='FACES')
    me = bpy.data.meshes.new('tmp'); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new('tmp', me); sc.collection.objects.link(ob)
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    if tris > BARK_TRIS[lod]:
        m = ob.modifiers.new('dec', 'DECIMATE'); m.ratio = BARK_TRIS[lod] / tris; m.use_collapse_triangulate = True
    dg = bpy.context.evaluated_depsgraph_get()
    out = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bpy.data.objects.remove(ob, do_unlink=True); bpy.data.meshes.remove(me)
    # many small loose parts can't collapse below a few triangles each (acacia's 87 limbs): drop more of them
    if sum(len(p.vertices) - 2 for p in out.polygons) > BARK_TRIS[lod] * 1.25 and keep_area < 0.5:
        bpy.data.meshes.remove(out)
        return bark_lod(src, lod, keep_area * 2)
    return out


report = {}
roots = []
for name, sp in SPECIES.items():
    before = set(sc.objects)
    bpy.ops.wm.fbx_import(filepath=os.path.join(SRC, f'{name}.fbx'))
    new = [o for o in sc.objects if o not in before]
    meshes = [o for o in new if o.type == 'MESH']
    for o in meshes:   # apply transforms; Tree It is Y-up → Z-up
        mw = o.matrix_world.copy(); o.parent = None; o.data.transform(mw); o.matrix_world = Matrix.Identity(4)
        o.data.transform(Matrix.Rotation(math.radians(90), 4, 'X'))
    for o in [o for o in new if o.type != 'MESH']:
        bpy.data.objects.remove(o, do_unlink=True)
    bark = next(o for o in meshes if not any(k in o.name for k in ('leaf', 'branch')) or o.name.startswith(('bark', 'plant')))
    leaves = [o for o in meshes if o is not bark]
    pts = [v.co for o in meshes for v in o.data.vertices]
    z0, z1 = min(p.z for p in pts), max(p.z for p in pts)
    low = [v.co for v in bark.data.vertices if v.co.z < z0 + 0.03 * (z1 - z0)]
    cx, cy = sum(p.x for p in low) / len(low), sum(p.y for p in low) / len(low)
    H = sp['height']
    T = Matrix.Scale(H / (z1 - z0), 4) @ Matrix.Translation(Vector((-cx, -cy, -z0)))
    for o in meshes:
        o.data.transform(T)

    # cards
    cards = []
    for o in leaves:
        for U, P, A, _ in components(o.data):
            if len(U) < 3:
                continue
            c = fit(U, P)
            size = (c[(1, 1)] - c[(0, 0)]).length
            if not (size > 1e-3):
                continue
            mid = (c[(0, 0)] + c[(1, 1)]) / 2
            cards.append(dict(c=c, size=size, mid=mid))
    C = sum((c['mid'] for c in cards), Vector()) / len(cards)
    rad = Vector([max(0.5, float(np.std([c['mid'][i] for c in cards])) * 1.7) for i in range(3)])
    total = sum(c['size'] ** 2 for c in cards)
    rng0 = random.Random(len(cards))
    for c in cards:
        c['rank'] = c['size'] * rng0.uniform(0.55, 1.45)
    # LODs keep the biggest cards of every HEIGHT BAND (ranked over the whole tree, the big low sprays win and the
    # crown's top goes bare — spruce_treeit.py)
    BANDS = 8
    zs = [c['mid'].z for c in cards]
    zlo, zhi = min(zs), max(zs) + 1e-6
    bands = [sorted((c for c in cards if int((c['mid'].z - zlo) / (zhi - zlo) * BANDS) == b), key=lambda c: -c['rank']) for b in range(BANDS)]

    def pick(cap):
        out = []
        for b in bands:
            out += b[:max(1 if b else 0, round(cap * len(b) / len(cards)))]
        return out

    deep, midc, tip = (srgb(h) for h in sp['leaf'])
    bfoot, btop = srgb(sp['bark'][0]), srgb(sp['bark'][1])
    root = bpy.data.objects.new(name, None); sc.collection.objects.link(root); roots.append(root)
    tris = []
    for lod in range(3):
        rng = random.Random(sum(map(ord, name)) * 10 + lod)
        kept = pick(sp['cards'][lod])
        grow = min(2.3, math.sqrt(total / max(1e-6, sum(c['size'] ** 2 for c in kept)))) * sp.get('fill', 1.0)
        bm = bmesh.new()
        col = bm.loops.layers.float_color.new('Col'); uvl = bm.loops.layers.uv.new('UVMap')
        leafverts = set()
        for k, card in enumerate(kept):
            s0, t0, s1, t1 = sp['slots'][k % len(sp['slots'])]
            base = 8.0 + 2 * sp['cell']
            ctr = card['mid']
            d = Vector(((ctr.x - C.x) / rad.x, (ctr.y - C.y) / rad.y, (ctr.z - C.z) / rad.z))
            out = min(1.0, d.length / 1.6)
            hf = ctr.z / H
            inner = mix(deep, midc, 0.25 + 0.5 * hf)
            outer = mix(midc, tip, rng.uniform(0.35, 0.9))
            vs = {}
            for uv, p in card['c'].items():
                q = card['c'][(0, 0)] + (p - card['c'][(0, 0)]) * grow   # grown from the stem's base
                w = min(1.0, (q - C).length / max(rad) / 1.3) * (0.6 + 0.4 * uv[0] * uv[1]) + 0.2 * out
                v = bm.verts.new(q); leafverts.add(v)
                vs[uv] = (v, (base + s0 + PAD + uv[0] * (s1 - s0 - 2 * PAD), t0 + PAD + uv[1] * (t1 - t0 - 2 * PAD)), mix(inner, outer, min(1.0, w)))
            for tri in (((0, 0), (1, 0), (1, 1)), ((0, 0), (1, 1), (0, 1))):
                try:
                    f = bm.faces.new([vs[t][0] for t in tri])
                except ValueError:
                    continue
                for l, t in zip(f.loops, tri):
                    l[uvl].uv = vs[t][1]; l[col] = (*vs[t][2], 1.0)
        # bark
        bme = bark_lod(bark, lod, (0.004, 0.05, 0.25)[lod])
        bb = bmesh.new(); bb.from_mesh(bme); bpy.data.meshes.remove(bme)
        vmap = {v: bm.verts.new(v.co) for v in bb.verts}
        U = 4.0 if sp.get('culm') else 2.0
        for f in bb.faces:
            try:
                nf = bm.faces.new([vmap[v] for v in f.verts])
            except ValueError:
                continue
            for l in nf.loops:
                z = l.vert.co.z / H
                l[uvl].uv = (U, 0.5); l[col] = (*mix(bfoot, btop, min(1.0, z * 2.5)), 1.0)
        bb.free()
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
        nm = f'{name}_lod{lod}'
        me = bpy.data.meshes.new(nm)
        bm.to_mesh(me); bm.free()
        # normals: leaves out of the crown ellipsoid (tilted up), bark smooth
        uvd = me.uv_layers['UVMap'].data
        vn = [v.normal.copy() for v in me.vertices]
        ns = []
        for l in me.loops:
            if uvd[l.index].uv[0] > 7.5:
                p = me.vertices[l.vertex_index].co
                n = Vector(((p.x - C.x) / rad.x ** 2, (p.y - C.y) / rad.y ** 2, (p.z - C.z) / rad.z ** 2))
                n = n.normalized() if n.length > 1e-6 else Vector((0, 0, 1))
                ns.append((n * 0.8 + Vector((0, 0, 0.35))).normalized())
            else:
                ns.append(vn[l.vertex_index])
        me.normals_split_custom_set(ns)
        ob = bpy.data.objects.new(nm, me); sc.collection.objects.link(ob); ob.parent = root
        tris.append(sum(len(p.vertices) - 2 for p in me.polygons))
    report[name] = dict(cards=len(cards), tris=tris)
    for o in meshes:
        bpy.data.objects.remove(o, do_unlink=True)
print('TRIS', report)

path = os.path.join(OUT, 'treeit_set.glb')
bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_active_scene=True, export_cameras=False, export_lights=False,
                          export_materials='NONE', export_animations=False, export_yup=True, export_vertex_color='ACTIVE',
                          export_normals=True)
print('EXPORTED', path, os.path.getsize(path))
win.scene = prev
