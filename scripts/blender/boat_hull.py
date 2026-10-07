"""
AMPHIBIOUS HULL for DARK's cars (run inside Blender 5.x via the MCP add-on: node scripts/blender/bl.mjs
scripts/blender/boat_hull.py [OUT=...] [PREVIEW=...png]). One welded-aluminium jet-boat hull (refer: the user's
amphibious-truck reference — a silver jon/jet-boat tub the car sits in, decked raked bow, transom with a water jet)
in normalised HULL SPACE, split into the parts the game animates (gameplay/vehicle/BoatHull.ts):

  hull_keel     V bottom (deadrise, two lifting strakes a side) + the cockpit floor      telescopes out, drops
  hull_side_L/R flared side panel: skin, black rub rail, gunwale cap, inner liner        hinge on the chine
  hull_bow      decked, raked bow (lofted), stem bar, bow cleat                          slides out, snaps up
  hull_stern    transom, jet-pump housing, two trim tabs                                 folds up off the floor
  hull_nozzle   steerable jet nozzle                                                     extends, yaws with steering

HULL SPACE (Blender; glTF exports x, z, −y): X across (−1 … 1 = gunwale half-width), Y along (transom −1 … bow tip
+1; the bow part starts at Y = 0.6 = the car's front bumper), Z up (keel 0 … floor 0.4 … gunwale 1, the sheer rising
to ~1.14 at the stem). The game maps each axis piecewise onto a car (width, keel / floor / sill heights, bumper-to-
bumper length), so one asset fits every vehicle. Each part carries its hinge as a glTF extra `pivot` (glTF space).
Vertex colours only (COLOR_0, linear): no textures, no UVs — the game draws it on the car's own program.
~1.3 k triangles in all.
"""
import bpy, bmesh, math, os

OUT = globals().get('OUT', 'C:/Project/Dark/src/assets/models/vehicles/boat_hull.lod0.glb')
PREVIEW = globals().get('PREVIEW', '')


def srgb(h):
    c = [((h >> s) & 255) / 255 for s in (16, 8, 0)]
    return tuple((x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


ALU, ALU_DARK, SEAM = srgb(0xbcc0c4), srgb(0x8c9197), srgb(0x8f949a)
RAIL, CAP, DECK = srgb(0x26282c), srgb(0xd6d9dc), srgb(0x9a9fa5)
INNER, FLOOR, JET, STEEL = srgb(0x767b81), srgb(0x55595f), srgb(0x34373c), srgb(0xa4aab0)

MAIN = (-1.0, 0.6)          # keel + sides run transom → bow joint
SEAMS = (-0.55, -0.1, 0.32)  # welded plate seams on the side skins
SEAM_W = 0.012


class Part:
    """A closed solid: vertices, faces and a colour per face."""

    def __init__(self):
        self.v, self.f, self.c = [], [], []

    def ring(self, pts):
        base = len(self.v)
        self.v.extend(pts)
        return list(range(base, base + len(pts)))

    def face(self, idx, col):
        self.f.append(list(idx))
        self.c.append(col)

    def loft(self, rings, col, cap0=None, cap1=None):
        """Quads between consecutive closed rings (equal counts); col(k, i) colours segment i of span k."""
        ids = [self.ring(r) for r in rings]
        n = len(rings[0])
        for k in range(len(ids) - 1):
            a, b = ids[k], ids[k + 1]
            for i in range(n):
                j = (i + 1) % n
                self.face((a[i], a[j], b[j], b[i]), col(k, i))
        if cap0:
            self.face(ids[0], cap0)
        if cap1:
            self.face(ids[-1][::-1], cap1)

    def box(self, x0, x1, y0, y1, z0, z1, col):
        r0 = [(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)]
        r1 = [(x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)]
        self.loft([r0, r1], lambda k, i: col, col, col)

    def build(self, name, pivot, coll):
        me = bpy.data.meshes.new(name)
        me.from_pydata(self.v, [], self.f)
        me.update()
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)  # every part is closed → outward normals
        bm.to_mesh(me)
        bm.free()
        attr = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
        for poly, col in zip(me.polygons, self.c):
            for li in poly.loop_indices:
                attr.data[li].color = (*col, 1.0)
        me.color_attributes.active_color = attr
        for p in me.polygons:
            p.use_smooth = True
        me.set_sharp_from_angle(angle=math.radians(32))  # rounded bow, crisp plate edges
        ob = bpy.data.objects.new(name, me)
        coll.objects.link(ob)
        ob['pivot'] = [pivot[0], pivot[2], -pivot[1]]  # glTF space
        return ob


def mirror(pts):
    return [(-x, z) for x, z in reversed(pts)]


def at_y(prof, y):
    return [(x, y, z) for x, z in prof]


# ---------------------------------------------------------------- keel: V bottom + floor
def keel():
    p = Part()
    # Right half from the keel outward: deadrise z = 0.188·x, two lifting strakes (small downward ridges), chine,
    # then up the inside of the chine to the floor edge.
    right = [(0.27, 0.051), (0.285, 0.034), (0.30, 0.056), (0.57, 0.107), (0.585, 0.090), (0.60, 0.113),
             (0.85, 0.16), (0.82, 0.19), (0.79, 0.40)]
    prof = [(0.0, 0.0)] + right + mirror(right)
    n = len(prof)

    def col(k, i):
        a, b = prof[i], prof[(i + 1) % n]
        if a[1] >= 0.39 and b[1] >= 0.39:
            return FLOOR
        if max(a[1], b[1]) > 0.17:
            return INNER
        return ALU_DARK
    p.loft([at_y(prof, MAIN[0]), at_y(prof, MAIN[1])], col, ALU_DARK, INNER)
    return p


# ---------------------------------------------------------------- sides
SIDE = [(0.85, 0.16), (0.975, 0.86), (1.015, 0.865), (1.022, 0.945), (1.0, 0.955), (1.0, 1.0), (0.92, 1.0),
        (0.80, 0.40), (0.82, 0.19)]
SIDE_COL = [ALU, RAIL, RAIL, RAIL, CAP, CAP, INNER, INNER, INNER]


def side(sign):
    p = Part()
    prof = [(x * sign, z) for x, z in SIDE]
    ys = [MAIN[0]]
    for s in SEAMS:
        ys += [s - SEAM_W, s + SEAM_W]
    ys.append(MAIN[1])

    def col(k, i):
        c = SIDE_COL[i]
        return SEAM if (c is ALU and k % 2 == 1) else c  # odd spans are the seam bands
    p.loft([at_y(prof, y) for y in ys], col, ALU, INNER)
    return p


# ---------------------------------------------------------------- bow: lofted, decked, raked
def bow():
    p = Part()
    rings = []
    ts = [0.0, 0.12, 0.25, 0.38, 0.5, 0.62, 0.73, 0.83, 0.91, 0.97]
    for t in ts:
        s = max(0.035, (1 - t) * (1 + 0.45 * t))  # pointed V in plan, a little fullness at the shoulders
        kz = 0.62 * t ** 2.2                  # forefoot sweeping up to the stem
        sz = 1.0 + 0.14 * t ** 1.6            # sheer rising toward the bow
        chz = kz + 0.16 * (1 - t) ** 0.6
        y = MAIN[1] + 0.4 * t
        rail = 0.04 * min(1.0, s * 3)
        right = [(0.85 * s, chz), (0.975 * s, sz - 0.14), (0.975 * s + rail, sz - 0.135), (0.98 * s + rail, sz - 0.055),
                 (1.0 * s, sz)]
        prof = [(0.0, kz)] + right + [(0.0, sz + 0.03)] + mirror(right)
        rings.append(at_y(prof, y))
    seg = [ALU_DARK, ALU, RAIL, RAIL, CAP, DECK, DECK, CAP, RAIL, RAIL, ALU, ALU_DARK]
    p.loft(rings, lambda k, i: seg[i], INNER, RAIL)
    # Bow cleat on the foredeck + the stem's bow eye.
    t = 0.8
    sz = 1.0 + 0.14 * t ** 1.6
    p.box(-0.06, 0.06, MAIN[1] + 0.4 * t - 0.025, MAIN[1] + 0.4 * t + 0.025, sz + 0.02, sz + 0.07, STEEL)
    return p


# ---------------------------------------------------------------- stern: transom, jet pump, trim tabs
def stern():
    p = Part()
    prof = [(0.0, 0.0), (0.85, 0.16), (1.022, 0.945), (1.0, 1.0), (-1.0, 1.0), (-1.022, 0.945), (-0.85, 0.16)]
    p.loft([at_y(prof, -1.035), at_y(prof, -1.0)], lambda k, i: ALU_DARK if i in (0, 6) else ALU, ALU, INNER)
    # Jet-pump housing (tapering aft) under the waterline.
    r0 = [(-0.2, -1.035, 0.03), (0.2, -1.035, 0.03), (0.2, -1.035, 0.30), (-0.2, -1.035, 0.30)]
    r1 = [(-0.16, -1.15, 0.065), (0.16, -1.15, 0.065), (0.16, -1.15, 0.265), (-0.16, -1.15, 0.265)]
    p.loft([r0, r1], lambda k, i: JET, JET, JET)
    # Trim tabs at the transom's bottom corners (following the deadrise).
    for sgn in (-1, 1):
        a, b = 0.45, 0.72
        z = lambda x: 0.188 * x - 0.004
        r0 = [(sgn * a, -1.035, z(a)), (sgn * b, -1.035, z(b)), (sgn * b, -1.035, z(b) + 0.02), (sgn * a, -1.035, z(a) + 0.02)]
        r1 = [(x, -1.13, zz - 0.012) for x, _, zz in r0]
        p.loft([r0, r1], lambda k, i: STEEL, STEEL, STEEL)
    return p


def nozzle():
    p = Part()
    n, zc = 10, 0.165
    ring = lambda y, r: [(r * math.cos(2 * math.pi * i / n), y, zc + r * math.sin(2 * math.pi * i / n)) for i in range(n)]
    p.loft([ring(-1.15, 0.095), ring(-1.27, 0.07)], lambda k, i: JET, JET, RAIL)
    return p


# ---------------------------------------------------------------- build + export
scene = bpy.data.scenes.get('DARK_boat_hull') or bpy.data.scenes.new('DARK_boat_hull')
for o in list(scene.collection.all_objects):
    bpy.data.objects.remove(o, do_unlink=True)
coll = scene.collection

mat = bpy.data.materials.get('hull') or bpy.data.materials.new('hull')
mat.use_nodes = True
nt = mat.node_tree
bsdf = nt.nodes.get('Principled BSDF')
ca = nt.nodes.get('Color Attribute') or nt.nodes.new('ShaderNodeVertexColor')
ca.layer_name = 'Col'
nt.links.new(ca.outputs['Color'], bsdf.inputs['Base Color'])
bsdf.inputs['Metallic'].default_value = 0.6
bsdf.inputs['Roughness'].default_value = 0.45

parts = [
    keel().build('hull_keel', (0, 0, 0.30), coll),
    side(-1).build('hull_side_L', (-0.845, 0, 0.16), coll),
    side(1).build('hull_side_R', (0.845, 0, 0.16), coll),
    bow().build('hull_bow', (0, MAIN[1], 0.0), coll),
    stern().build('hull_stern', (0, -1.0, 0.0), coll),
    nozzle().build('hull_nozzle', (0, -1.15, 0.165), coll),
]
for o in parts:
    o.data.materials.append(mat)

win = bpy.context.window_manager.windows[0]
prev_scene = win.scene
win.scene = scene
try:
    with bpy.context.temp_override(window=win, scene=scene):
        bpy.ops.object.select_all(action='DESELECT')
        for o in parts:
            o.select_set(True)
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        kw = dict(filepath=OUT, export_format='GLB', use_selection=True, use_active_scene=True, export_extras=True, export_yup=True,
                  export_apply=True, export_texcoords=False, export_normals=True, export_materials='EXPORT')
        try:
            bpy.ops.export_scene.gltf(**kw, export_vertex_color='ACTIVE')
        except TypeError:
            bpy.ops.export_scene.gltf(**kw)
        tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in parts)
        print('exported', OUT, os.path.getsize(OUT), 'bytes,', tris, 'tris')
        if PREVIEW:
            # Workbench views in the vertex colours at roughly in-game proportions: a 2.1 m × 0.9 m hull, 5.1 m from
            # transom to bow joint, the bow stretched to ~1.7 m about its joint (BoatHull.ts maps it the same way).
            for o in parts:
                o.scale = (1.05, 3.2, 0.9)
            bow_ob = scene.objects['hull_bow']
            bow_ob.scale.y = 1.7 / 0.4
            bow_ob.location.y = 3.2 * MAIN[1] - bow_ob.scale.y * MAIN[1]
            cam = bpy.data.objects.get('hull_cam') or bpy.data.objects.new('hull_cam', bpy.data.cameras.new('hull_cam'))
            if cam.name not in scene.collection.objects:
                scene.collection.objects.link(cam)
            cam.data.lens = 40
            scene.camera = cam
            scene.render.engine = 'BLENDER_WORKBENCH'
            scene.display.shading.light = 'STUDIO'
            scene.display.shading.color_type = 'VERTEX'
            scene.display.shading.show_cavity = True
            scene.render.resolution_x, scene.render.resolution_y = 960, 600
            for suffix, loc in (('', (6.5, 7.5, 3.4)), ('_aft', (-5.5, -7.5, 2.6)), ('_top', (0.01, 0.5, 13.0))):
                cam.location = loc
                cam.rotation_euler = (-cam.location.normalized()).to_track_quat('-Z', 'Y').to_euler()
                scene.render.filepath = PREVIEW.replace('.png', suffix + '.png')
                bpy.ops.render.render(write_still=True)
            for o in parts:
                o.scale = (1, 1, 1)
                o.location = (0, 0, 0)
            print('preview', PREVIEW)
finally:
    win.scene = prev_scene
