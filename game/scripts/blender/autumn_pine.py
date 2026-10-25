"""
AUTUMN PINES for DARK (2026-10-23, the user's "Autumn Pine" sheet: a tall, dense spruce — a narrow cone of many short
drooping, FEATHERY branches, deep green inside, olive / gold / orange at the tips, a red-brown trunk showing only at
the foot; "not all of them golden orange, some of them"; low cost). Run inside Blender 5.x:

  node scripts/blender/bl.mjs scripts/blender/autumn_pine.py OUT=C:/project/Dark/game/src/assets/models/trees/ [RENDER=<png>]
  blender -b --factory-startup --python scripts/blender/autumn_pine.py -- OUT=<dir> [RENDER=<png>]

Writes autumn_pine.glb: three variants under empties `pineA` (spruce form, green with orange-tipped sprays here and
there), `pineB` (taller, slimmer, greener) and `pineGold` (the autumn one: most tips orange-gold), each
`<variant>_lod0/1/2`. The game (assets/treeModels.ts) puts them in the conifer slots of a map whose map.json says
`pines: 'autumn'` — spruce 50 %, pine 32 %, fir 18 % of the scatter — so about one tree in five is the gold one.

How a tree is built (vertex colours × the foliage atlas — the game multiplies its gentle per-tree hues on top):
  - BRANCHES are SPRAY CARDS: the atlas's spruce branch spray (cell 0 — a stem with dense drooping needles,
    alpha-tested), so the needles make the silhouette and the surface (flat facets read as "a triangle with leaves
    on it"). 12 tiers up the trunk, 8 branches each, rotated by the golden angle; per branch two crossed cards (LOD0):
    one HANGING along the drooping branch line, one DRAPED steeply out to one side. Colour trunk end → tip: deep green
    → the tip colour (moss, or for the variant's share of branches orange / gold).
  - CORE: a wide deep-green cone inside — a gap between sprays shows shaded foliage, never the pole.
  - TRUNK: red-brown, below the lowest branches; the leader on top.
  Triangles (printed): LOD0 382, LOD1 107, LOD2 42 (the tiered pines: 264 / 140 / 38) — the near band only; past it the
  trees are impostor images, so the far forest costs the same as before.
UV U carries the part kind for the game's bake (2 = bark texel, 6 = NEEDLE_UV solid, 8..9 = the spray cell's U).
"""
import bpy, bmesh, math, random, os, sys
from mathutils import Vector

for a in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []):
    if '=' in a:
        globals()[a.split('=', 1)[0]] = a.split('=', 1)[1]
OUT = globals().get('OUT', 'C:/project/Dark/game/src/assets/models/trees/')
RENDER = globals().get('RENDER', '')
os.makedirs(OUT, exist_ok=True)


def srgb(h):
    c = [((h >> s) & 255) / 255 for s in (16, 8, 0)]
    return tuple((x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


# The sheet's colour palette (left to right): two deep greens, moss, olive, gold, orange, rust; the trunk
DEEP, GREEN, MOSS, OLIVE = srgb(0x1c2a1c), srgb(0x2f4527), srgb(0x4a5e2e), srgb(0x77783a)
GOLD, ORANGE, RUST, BARK = srgb(0xb4893a), srgb(0xc06a2c), srgb(0x8e4524), srgb(0x6b3a24)
CORE = srgb(0x142017)

VARIANTS = {
    # height, crown radius at the foot, bare trunk, share of branches with warm tips, the warm colours
    'pineA': dict(height=13.0, radius=3.5, bare=0.7, warm=0.2, warmcols=(GOLD, ORANGE), seed=11),
    'pineB': dict(height=15.0, radius=3.1, bare=1.4, warm=0.1, warmcols=(OLIVE, GOLD), seed=23),
    'pineGold': dict(height=12.5, radius=3.4, bare=0.7, warm=0.55, warmcols=(ORANGE, GOLD, GOLD), seed=37),
}
# per LOD (LOD0 ≈ 360 triangles, LOD1 ≈ 115, LOD2 ≈ 45 — the tiered pines were 264 / 140 / 38)
LODS = [(12, 8, 2, 6, 6), (8, 6, 1, 5, 5), (4, 4, 1, 3, 3)]   # tiers, branches per tier, cards per branch, core sides, trunk sides


class Soup:
    def __init__(self):
        self.bm = bmesh.new()
        self.col = self.bm.loops.layers.float_color.new('Col')
        self.uv = self.bm.loops.layers.uv.new('UVMap')

    def tri(self, pts, cols, kind):
        vs = [self.bm.verts.new(p) for p in pts]
        try:
            f = self.bm.faces.new(vs)
        except ValueError:
            return
        for l, c in zip(f.loops, cols):
            l[self.col] = (*c, 1.0)
            l[self.uv].uv = (kind, 0.5)

    def finish(self, name, mat, parent):
        me = bpy.data.meshes.new(name)
        self.bm.normal_update()
        self.bm.to_mesh(me)
        self.bm.free()
        for p in me.polygons:
            p.use_smooth = False
        me.materials.append(mat)
        ob = bpy.data.objects.new(name, me)
        sc.collection.objects.link(ob)
        ob.parent = parent
        return ob


def cone(s, y0, y1, r0, r1, sides, c0, c1, kind, a0=0.0):
    for i in range(sides):
        a, b = a0 + 2 * math.pi * i / sides, a0 + 2 * math.pi * (i + 1) / sides
        p = lambda t, y, r: Vector((math.cos(t) * r, math.sin(t) * r, y))
        s.tri([p(a, y0, r0), p(b, y0, r0), p(b, y1, r1)], [c0, c0, c1], kind)
        if r1 > 1e-4:
            s.tri([p(a, y0, r0), p(b, y1, r1), p(a, y1, r1)], [c0, c1, c1], kind)


def card(s, top0, top1, down0, down1, c0, c1):
    """A SPRAY CARD (the atlas's spruce branch spray, cell 0: stem along the top third, needles hanging below; U 8..9
    in the export = the spray cell): trunk end top0 → tip top1, the card hanging `down` from that edge. Colour c0 at
    the trunk end, c1 at the tip. 2 triangles."""
    q = [top0, top1, top1 + down1, top0 + down0]
    uv = [(8.0, 1.0), (9.0, 1.0), (9.0, 0.0), (8.0, 0.0)]
    cols = [c0, c1, c1, c0]
    for a, b, c in ((0, 1, 2), (0, 2, 3)):
        vs = [s.bm.verts.new(q[i]) for i in (a, b, c)]
        try:
            f = s.bm.faces.new(vs)
        except ValueError:
            continue
        for l, i in zip(f.loops, (a, b, c)):
            l[s.col] = (*cols[i], 1.0)
            l[s.uv].uv = uv[i]


def build(name, v, lod, mat, parent):
    """SPRAY-CARD SPRUCE (2026-10-23, the user on the faceted one: "a triangle with some leaves on it — that's not a
    pine"): every branch is the atlas's needle spray, so the needles make the silhouette and the surface, not flat
    facets. Per branch two crossed cards (LOD0): one HANGING along the branch (the side view of the sheet's drooping
    sprays), one DRAPED out sideways and down (the spray seen from above / below); LOD1–2 the draped one only. A slim
    dark core only fills the gaps deep inside."""
    tiers, per, cards, core_sides, trunk_sides = LODS[lod]
    rng = random.Random(v['seed'] * 10 + lod)
    s = Soup()
    H, R, bare = v['height'], v['radius'], v['bare']
    crown = lambda y: R * max(0.0, (H - y) / (H - bare)) ** 0.9          # the crown's radius at height y
    cone(s, 0.0, bare + 1.0, 0.26, 0.18, trunk_sides, mix(BARK, CORE, 0.3), BARK, 2.0)
    # (deep needle green, not black, and wide: a gap between sprays shows shaded foliage, never a pole — the user:
    #  "the centre trunk is too visible")
    cone(s, bare + 0.6, H * 0.92, R * 0.45, 0.0, core_sides, mix(CORE, DEEP, 0.6), DEEP, 6.0, 0.3)
    golden = math.pi * (3 - math.sqrt(5))
    up = Vector((0, 0, 1))
    for t in range(tiers):
        f = max(0.0, (t + rng.uniform(-0.2, 0.2)) / tiers)
        y = bare + 0.5 + (H - bare - 0.6) * f ** 0.9
        rr = crown(y) + 0.35
        n_here = max(3, per - (2 if f > 0.7 else 0))
        for i in range(n_here):
            a = t * golden + 2 * math.pi * i / n_here + rng.uniform(-0.3, 0.3)
            L = rr * rng.uniform(0.8, 1.1)
            d = Vector((math.cos(a), math.sin(a), 0.0)); n = Vector((-d.y, d.x, 0.0))
            B = Vector((0, 0, y))                                              # (from the trunk itself: it hides it)
            T = B + d * L - up * (0.28 * L)                                    # the branch line droops to its tip
            h = L * rng.uniform(0.75, 0.95)                                    # how far the needles hang (the card)
            warm = rng.random() < v['warm']
            tipc = mix(MOSS, rng.choice(v['warmcols']), 0.7) if warm else mix(GREEN, MOSS, rng.uniform(0.3, 0.9))   # (warm: the tips only — the card's base stays green)
            base = mix(DEEP, GREEN, 0.35 + 0.3 * f)
            # (the spray's stem sits a third down the card: lift the card so the stem runs along the branch line)
            if cards == 2:
                card(s, B + up * 0.3 * h, T + up * 0.3 * h, -up * h, -up * h, base, tipc)
            side = (n * rng.choice((-1, 1)) * 0.5 - up * 0.87).normalized()   # (steep: edge-on it reads as hanging fringe, not a stripe)
            card(s, B - side * 0.3 * h, T - side * 0.3 * h, side * h, side * h * 1.1, base, tipc)
    cone(s, H * 0.86, H + 0.3, 0.2, 0.0, 3 if lod == 2 else 4, GREEN, mix(MOSS, v['warmcols'][0], 0.4), 6.0)
    return s.finish(f'{name}_lod{lod}', mat, parent)


def tris(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


# a scene of its own in a live session (the MCP add-on: the other scenes are left alone); headless: the default scene
if bpy.app.background:
    sc = bpy.context.scene
else:
    sc = bpy.data.scenes.get('autumn_pine') or bpy.data.scenes.new('autumn_pine')
    bpy.context.window_manager.windows[0].scene = sc
for o in list(sc.objects):
    bpy.data.objects.remove(o, do_unlink=True)
mat = bpy.data.materials.get('pine_solid') or bpy.data.materials.new('pine_solid')
mat.use_nodes = True
nt = mat.node_tree
bsdf = nt.nodes.get('Principled BSDF')
vc = next((n for n in nt.nodes if n.type == 'VERTEX_COLOR'), None) or nt.nodes.new('ShaderNodeVertexColor')
vc.layer_name = 'Col'
nt.links.new(vc.outputs['Color'], bsdf.inputs['Base Color'])
bsdf.inputs['Roughness'].default_value = 0.9

report = {}
roots = []
for name, v in VARIANTS.items():
    root = bpy.data.objects.new(name, None)
    sc.collection.objects.link(root)
    roots.append(root)
    obs = [build(name, v, l, mat, root) for l in range(3)]
    report[name] = [tris(o) for o in obs]
print('TRIS', report)

path = os.path.join(OUT, 'autumn_pine.glb')
with bpy.context.temp_override(scene=sc):
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_active_scene=True, export_cameras=False, export_lights=False,
                              export_animations=False, export_yup=True, export_vertex_color='ACTIVE', export_normals=True)
print('EXPORTED', path, os.path.getsize(path))

if RENDER:
    # the sheet's line-up: the three variants, LOD0, warm low sun from the left, a dark ground; then LOD1 / LOD2 of pineA
    for i, r in enumerate(roots):
        r.location = ((i - 1) * 8.5, 0, 0)
        for c in r.children:
            c.hide_render = not c.name.endswith('_lod0')
    cam = bpy.data.objects.get('ap_cam') or bpy.data.objects.new('ap_cam', bpy.data.cameras.new('ap_cam'))
    if cam.name not in sc.collection.objects:
        sc.collection.objects.link(cam)
    sc.camera = cam
    cam.location = (0, -31, 6.5); cam.rotation_euler = (math.radians(88), 0, 0); cam.data.lens = 40
    sun = bpy.data.objects.get('ap_sun') or bpy.data.objects.new('ap_sun', bpy.data.lights.new('ap_sun', 'SUN'))
    if sun.name not in sc.collection.objects:
        sc.collection.objects.link(sun)
    sun.data.energy = 4.0; sun.data.color = (1.0, 0.86, 0.68); sun.rotation_euler = (math.radians(62), 0, math.radians(-60))
    if not sc.world:
        sc.world = bpy.data.worlds.new('ap_world')
    sc.world.use_nodes = True
    sc.world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.05, 0.06, 0.08, 1)
    sc.world.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.0
    eng = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
    sc.render.engine = 'BLENDER_EEVEE' if 'BLENDER_EEVEE' in eng else 'BLENDER_EEVEE_NEXT'
    sc.render.resolution_x, sc.render.resolution_y = 1400, 900
    sc.render.filepath = RENDER
    bpy.ops.render.render(write_still=True)
    for r in roots:
        r.location = (0, 0, 0)
    print('RENDERED', RENDER)
