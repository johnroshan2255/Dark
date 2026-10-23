"""
VEHICLE PREP — the whole pipeline for a NEW car in one headless run (2026-10-23: the BMW E30 M3 and the kei van;
skills/realistic-vehicle-system §8.2). The older per-step scripts (vehicle_doors / finish / brakes / realism / cabin /
hooks) were written for an interactive Blender session and per-car pixel tables; this one does the same steps from a
config per car, in the car's own METRE frame:

  frame   x across (+ = LEFT), y along (− = FRONT), z up; ground (tyre bottoms) z = 0; origin = wheelbase centre.

  1. LOAD + NORMALISE: transforms applied, scaled to the real wheelbase, turned to face −Y, set on the ground.
  2. MATERIALS: no metal, matte (roughness 0.8 — the source's glossy PBR read as glitter), one base-colour texture
     at most (normal / roughness / metallic maps dropped: the game bakes base colour only), duplicates merged,
     untextured parts keep their colour; the brand lettering / watermarks painted out or deleted (config).
  3. BUDGET: parts deleted (old wheels, brake / spring meshes the game draws itself, hidden junk), parts decimated
     (collapse, UV-preserving) until the car is ≤ 30 k tris (the user's limit).
  4. WHEELS: rebuilt at the measured hubs (vehicle_realism's wheel: revolved carcass + tread + a styled rim),
     `wheel_<FL|FR|RL|RR>` with the `rim` extra; BRAKES `caliper_<corner>` (disc + hat + caliper, vertex colours).
  5. DOORS: the front doors cut out of the skin along an outline (bisected → clean edges, UVs kept), their windows
     out of the glass, `door_FL_<car>` / `door_FR_<car>` with the `hinge` extra (glTF space).
  6. COCKPIT: the car's own interior kept (renamed / decimated) or built (dash, binnacle, seats, console, floor),
     `steering_wheel`, `dial_<car>` (gauge faces UV-mapped onto the canvas the game draws), `pedal_*`, `gear_lever`
     with `pivot` / `axis` extras, `cab_<car>`.
  7. AO baked into vertex colours (Cycles), scene extra `vertex_ao`; exported GLB (+Y up, extras).
Then: vehicle_hooks.py for the tow hooks (headless), copy to src/assets/models/vehicles/, `npm run validate:assets`.

  blender -b --python scripts/blender/vehicle_prep.py -- CAR=bmw_e30 OUT=<dir> [STAGE=measure|build] [BAKE=0]
"""
import bpy, bmesh, math, os, re, sys, json
from mathutils import Vector, Matrix

ARGS = dict(a.split('=', 1) for a in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []) if '=' in a)
HERE = os.path.dirname(os.path.abspath(__file__))
VEH = os.path.join(HERE, 'vehicles_src')   # the source models as delivered (BMW E30, the kei van)
CAR = ARGS.get('CAR', 'bmw_e30')
OUT = ARGS.get('OUT', '/tmp/vehicle_prep')
STAGE = ARGS.get('STAGE', 'build')
os.makedirs(OUT, exist_ok=True)
BUDGET = 30000

# ---------------------------------------------------------------- per-car config (metre frame, see the header)
CARS = {
    'bmw_e30': {
        'src': 'bmw_e30_1985_white.glb',
        # model: millimetres, front toward −X; real E30 wheelbase 2.562 m (the model's 2.570: kept as is)
        'unit': 0.001, 'turn': 90, 'wheelbase': 2.57,
        'wheel_mats': ['Tire'],
        'keep_wheels': 'Tire', 'rim': 0.62,            # its own BBS cross-spoke wheels: split per corner, kept
        'texture': 'Body',                              # one base-colour texture kept (the body's 1024²)
        'brake': 'disc',
        # front doors (y, z) outline, front-bottom first; window frame follows the A-pillar
        'door': [(-0.69, 0.26), (0.515, 0.26), (0.52, 1.29), (-0.17, 1.29), (-0.665, 0.89)], 'door_x': 0.65,
        'steer_box': ((0.15, -0.38, 0.65), (0.58, -0.17, 1.0)),   # its own steering wheel → `steering_wheel`
        'driver_x': 0.37, 'eye': (0.37, 0.12, 1.09),
        'pedals': {'y_pad': -0.84, 'y_pivot': -0.9, 'z_pivot': 0.6, 'xs': (0.47, 0.37, 0.27)},
        'gear': {'x': 0.0, 'y': -0.32, 'auto': False},
        'dials': {'style': 'twin', 'at': (0.37, -0.62, 0.86), 'size': 0.115, 'gap': 0.13},
        # the "ROH3D.COM" watermark on both plates (one UV island): texture pixels (x0, y0, x1, y1, top-down) filled white
        'paint_out': [(76, 238, 94, 336)],
        'lamps': {'head': [(0.586, 0.606), (0.41, 0.606)], 'head_r': 0.075, 'tail': (0.51, 0.655), 'tail_wh': (0.148, 0.078)},
        'exhaust': [(0.40, 0.25), (0.46, 0.25)],
    },
    'carry_van': {
        'src': 'suzuki_carry_blind_van.glb',
        # model: metres, front toward −Y; ST90 Carry van wheelbase ~1.84 m (the model's 1.90 scaled down)
        'unit': 1.0, 'turn': 0, 'wheelbase': 1.84,
        'wheel_mats': ['WatanabeMaterial', 'EXT_rim', 'Tyre', 'brakedisc', 'FM3_CALIPER', 'Material_10831'],
        'tyre': {'tread': 'road', 'rim': 'spoke8', 'ratio': 0.6, 'rim_rgb': (0.8, 0.8, 0.79), 'segs': 32, 'rows': 30},
        'brake': 'drum',
        # (heavy source: 158 k tris) — parts the game draws itself or can do without, and the decimation budget
        'drop_mats': ['AE86_SPRING', 'AE86_SUSP', 'S13TBS', 'Material_11112'],
        'body_budget': 17000, 'paint_albedo': 0.8,
        'zfight': [('black.009', 'MAINBODY.007'), ('Black.007', 'MAINBODY.007')],
        'door': [(-1.51, 0.56), (-0.475, 0.56), (-0.475, 1.52), (-1.20, 1.52), (-1.45, 1.15), (-1.51, 1.0)], 'door_x': 0.54,
        'build_steering': {'c': (0.33, -1.12, 1.0), 'tilt': 52, 'R': 0.18},
        # (no seats in the source: the squat cab's windscreen is 1.02–1.55 m, so the head sits at 1.38 — catalogue cabin)
        'driver_x': 0.33, 'eye': (0.33, -0.79, 1.38),
        # the floor ahead of the front wheels is at 0.56 m; a ray from under the dash hits the heater box (0.82)
        'pedals': {'y_pad': -1.42, 'y_pivot': -1.38, 'z_pivot': 0.98, 'xs': (0.43, 0.33, 0.23), 'floor': 0.57},
        'gear': {'x': 0.04, 'y': -1.0, 'auto': False, 'top': 0.5},
        'dials': {'style': 'single', 'at': (0.33, -1.33, 1.03), 'size': 0.13, 'gap': 0.0},
        # the SUZUKI letters on the front panel and the S badge on the rear plate: small islands in these boxes
        'badges': [((-0.32, -1.63, 0.69), (0.32, -1.57, 0.78)), ((-0.05, 1.58, 0.55), (0.05, 1.62, 0.61))],
        'lamps': {'head': [(0.492, 0.752)], 'head_r': 0.078, 'tail': (0.648, 0.758), 'tail_wh': (0.05, 0.069)},
        'exhaust': [(-0.42, 0.22)],
    },
}
cfg = CARS[CAR]


def tris(objs):
    return sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)


def meshes():
    return [o for o in bpy.context.scene.objects if o.type == 'MESH']


def gl(v):  # Blender → glTF (Y up)
    return [v.x, v.z, -v.y]


# ---------------------------------------------------------------- 1. load + normalise
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=os.path.join(VEH, cfg['src']))
for o in list(sc.objects):
    if o.type != 'MESH':
        continue
    o.data = o.data.copy() if o.data.users > 1 else o.data
    mw = o.matrix_world.copy()
    o.parent = None
    o.data.transform(mw)
    o.matrix_world = Matrix.Identity(4)
for o in [o for o in sc.objects if o.type != 'MESH']:
    bpy.data.objects.remove(o, do_unlink=True)
T = Matrix.Rotation(math.radians(cfg['turn']), 4, 'Z') @ Matrix.Scale(cfg['unit'], 4)
for o in meshes():
    o.data.transform(T)


def wheel_clusters():
    """The source wheels (by material): 4 corner clusters → [(centre, R, width)] FL, FR, RL, RR (metre frame)."""
    pts = [v.co.copy() for o in meshes() for v in o.data.vertices if o.data.materials and any(m and any(w in m.name for w in cfg['wheel_mats'][:3]) for m in o.data.materials)]
    allp = [v.co for o in meshes() for v in o.data.vertices]
    cx = (min(p.x for p in allp) + max(p.x for p in allp)) / 2
    cy = (min(p.y for p in allp) + max(p.y for p in allp)) / 2
    out = {}
    for name, sx, sy in (('FL', 1, -1), ('FR', -1, -1), ('RL', 1, 1), ('RR', -1, 1)):
        q = [p for p in pts if (p.x - cx) * sx > 0 and (p.y - cy) * sy > 0]
        lo = Vector([min(p[i] for p in q) for i in range(3)]); hi = Vector([max(p[i] for p in q) for i in range(3)])
        out[name] = ((lo + hi) / 2, (hi.z - lo.z) / 2, hi.x - lo.x)
    return out


W0 = wheel_clusters()
wb = (W0['RL'][0].y - W0['FL'][0].y)
s = cfg['wheelbase'] / wb
mid = Vector(((W0['FL'][0].x + W0['FR'][0].x) / 2, (W0['FL'][0].y + W0['RL'][0].y) / 2, min(w[0].z - w[1] for w in W0.values())))
for o in meshes():
    o.data.transform(Matrix.Scale(s, 4) @ Matrix.Translation(-mid))
W = {k: ((c - mid) * s, R * s, w * s) for k, (c, R, w) in W0.items()}
allp = [v.co for o in meshes() for v in o.data.vertices]
LO = Vector([min(p[i] for p in allp) for i in range(3)]); HI = Vector([max(p[i] for p in allp) for i in range(3)])
print('FRAME', CAR, 'scale', round(s, 4), 'bbox', [round(v, 3) for v in LO], [round(v, 3) for v in HI],
      {k: ([round(v, 3) for v in c], round(R, 3), round(w, 3)) for k, (c, R, w) in W.items()}, 'tris', tris(meshes()))

if STAGE == 'measure':
    # side / front / rear / top orthographic renders with a 10 cm grid (thick every metre), for outlines and lamps
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'FLAT'
    sc.display.shading.color_type = 'TEXTURE'
    sc.render.resolution_x, sc.render.resolution_y = 1800, 900
    grid = bmesh.new()
    def line(a, b, w):
        d = (b - a).normalized(); n = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))
        e = d.cross(n).normalized() * w
        vs = [grid.verts.new(p) for p in (a - e, b - e, b + e, a + e)]
        grid.faces.new(vs)
    X = HI.x + 0.05
    for y10 in range(int(LO.y * 10) - 1, int(HI.y * 10) + 2):
        y = y10 / 10; w = 0.006 if y10 % 10 else 0.014
        line(Vector((X, y, -0.05)), Vector((X, y, HI.z + 0.05)), w)
        line(Vector((-X, y, -0.05)), Vector((-X, y, HI.z + 0.05)), w)
    for z10 in range(0, int(HI.z * 10) + 2):
        z = z10 / 10; w = 0.006 if z10 % 10 else 0.014
        line(Vector((X, LO.y - 0.05, z)), Vector((X, HI.y + 0.05, z)), w)
        line(Vector((-X, LO.y - 0.05, z)), Vector((-X, HI.y + 0.05, z)), w)
        # front / rear grids (x across)
        line(Vector((LO.x - 0.05, LO.y - 0.05, z)), Vector((HI.x + 0.05, LO.y - 0.05, z)), w)
        line(Vector((LO.x - 0.05, HI.y + 0.05, z)), Vector((HI.x + 0.05, HI.y + 0.05, z)), w)
    for x10 in range(int(LO.x * 10) - 1, int(HI.x * 10) + 2):
        x = x10 / 10; w = 0.006 if x10 % 10 else 0.014
        line(Vector((x, LO.y - 0.05, -0.05)), Vector((x, LO.y - 0.05, HI.z + 0.05)), w)
        line(Vector((x, HI.y + 0.05, -0.05)), Vector((x, HI.y + 0.05, HI.z + 0.05)), w)
    gm = bpy.data.meshes.new('grid'); grid.to_mesh(gm)
    gmat = bpy.data.materials.new('gridmat'); gmat.diffuse_color = (1, 0, 0, 1); gm.materials.append(gmat)
    sc.collection.objects.link(bpy.data.objects.new('grid', gm))
    sc.display.shading.color_type = 'MATERIAL'
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.type = 'ORTHO'; cam.data.clip_end = 100
    L = HI.y - LO.y
    views = {'left': (Vector((8, (LO.y + HI.y) / 2, HI.z / 2)), Vector((-1, 0, 0)), L * 1.08),
             'right': (Vector((-8, (LO.y + HI.y) / 2, HI.z / 2)), Vector((1, 0, 0)), L * 1.08),
             'front': (Vector((0, -8, HI.z / 2)), Vector((0, 1, 0)), (HI.x - LO.x) * 1.3),
             'rear': (Vector((0, 8, HI.z / 2)), Vector((0, -1, 0)), (HI.x - LO.x) * 1.3)}
    for n, (at, d, scale) in views.items():
        cam.location = at; cam.data.ortho_scale = scale
        cam.rotation_euler = d.to_track_quat('-Z', 'Z' if abs(d.z) > 0.9 else 'Y').to_euler()
        sc.render.resolution_x, sc.render.resolution_y = (1800, 700) if n in ('left', 'right') else (1000, 900)
        sc.render.filepath = os.path.join(OUT, f'{CAR}_{n}.png')
        bpy.ops.render.render(write_still=True)
    sc.display.shading.color_type = 'TEXTURE'
    for n, (at, d, scale) in views.items():
        cam.location = at; cam.data.ortho_scale = scale
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        sc.render.resolution_x, sc.render.resolution_y = (1800, 700) if n in ('left', 'right') else (1000, 900)
        sc.render.filepath = os.path.join(OUT, f'{CAR}_{n}_tex.png')
        bpy.ops.render.render(write_still=True)
    sys.exit(0)

# =====================================================================================================================
# BUILD
# =====================================================================================================================
import numpy as np
rng_ = __import__('random').Random(7)


def srgb2lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def base_image(m):
    """The image feeding a material's Base Color (through any chain of nodes), and its colour factor (linear)."""
    if not m or not m.node_tree:
        return None, (1, 1, 1)
    bsdf = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not bsdf:
        return None, (1, 1, 1)
    inp = bsdf.inputs['Base Color']
    fac = tuple(inp.default_value[:3])
    stack = [l.from_node for l in inp.links]
    while stack:
        n = stack.pop()
        if n.type == 'TEX_IMAGE' and n.image:
            return n.image, fac
        if n.type == 'MIX' or n.type == 'MIX_RGB':
            pass
        for i in n.inputs:
            stack += [l.from_node for l in i.links]
    return None, fac


IMG = {}


def img_pixels(im):
    if im.name not in IMG:
        w, h = im.size
        a = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4)
        lin = im.colorspace_settings.name.lower().startswith('srgb')
        if lin:  # (Blender returns the stored bytes as 0..1: convert sRGB → linear here)
            a[..., :3] = np.where(a[..., :3] <= 0.04045, a[..., :3] / 12.92, ((a[..., :3] + 0.055) / 1.055) ** 2.4)
        IMG[im.name] = a
    return IMG[im.name]


def bake_texture_to_col(o):
    """Per corner: base colour (texture sampled at the corner's UV × the factor), linear, into a FLOAT 'Col' attribute."""
    me = o.data
    uvl = me.uv_layers.active
    attr = me.color_attributes.get('Col') or me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
    cols = np.ones((len(me.loops), 4), np.float32)
    for p in me.polygons:
        m = me.materials[p.material_index] if me.materials else None
        im, fac = base_image(m)
        if im is None or not uvl or im.size[0] == 0:
            c = np.array([*fac, 1.0], np.float32)
            for li in p.loop_indices:
                cols[li] = c
            continue
        px = img_pixels(im); h, w = px.shape[:2]
        if w * h <= 64 * 64:
            c = px[..., :3].reshape(-1, 3).mean(0)
            for li in p.loop_indices:
                cols[li] = (c[0] * fac[0], c[1] * fac[1], c[2] * fac[2], 1.0)
            continue
        for li in p.loop_indices:
            u, v = uvl.data[li].uv
            x = int((u % 1.0) * (w - 1)); y = int((v % 1.0) * (h - 1))
            c = px[y, x]
            cols[li] = (c[0] * fac[0], c[1] * fac[1], c[2] * fac[2], 1.0)
    attr.data.foreach_set('color', cols.ravel())
    me.color_attributes.active_color = attr


def role_mat(name, rgba=(1, 1, 1, 1), glass=False, image=None):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        if n.type not in ('BSDF_PRINCIPLED', 'OUTPUT_MATERIAL'):
            nt.nodes.remove(n)
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    # MATTE (the user: the glossy source materials read as glitter): no metal, rough, no specular tint
    bsdf.inputs['Metallic'].default_value = 0.0
    bsdf.inputs['Roughness'].default_value = 0.85
    bsdf.inputs['Base Color'].default_value = rgba
    if image is not None:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = image
        nt.links.new(t.outputs['Color'], bsdf.inputs['Base Color'])
    if glass:
        bsdf.inputs['Alpha'].default_value = 0.35
        m.blend_method = 'BLEND'
        m.surface_render_method = 'BLENDED' if hasattr(m, 'surface_render_method') else m.surface_render_method
    return m


def islands(bm, faces=None):
    faces = list(bm.faces) if faces is None else faces
    allowed = set(f.index for f in faces); seen = set(); out = []
    for f in faces:
        if f.index in seen:
            continue
        stack = [f]; isl = []; seen.add(f.index)
        while stack:
            g = stack.pop(); isl.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen and h.index in allowed:
                        seen.add(h.index); stack.append(h)
        out.append(isl)
    return out


def bbox(vs):
    return Vector([min(p[i] for p in vs) for i in range(3)]), Vector([max(p[i] for p in vs) for i in range(3)])


def inside(c, box):
    return all(box[0][i] <= c[i] <= box[1][i] for i in range(3))


# ---------------------------------------------------------------- 2a. drop parts, remove branding
for o in list(meshes()):
    names = [m.name for m in o.data.materials if m]
    if names and all(any(d in n for d in cfg.get('drop_mats', [])) for n in names):
        bpy.data.objects.remove(o, do_unlink=True)
for box in cfg.get('badges', []):
    for o in meshes():
        bm = bmesh.new(); bm.from_mesh(o.data); bm.faces.ensure_lookup_table()
        gone = [f for isl in islands(bm) for f in isl if inside(sum((v.co for g in isl for v in g.verts), Vector()) / sum(len(g.verts) for g in isl), box)
                and (lambda lo_hi: (lo_hi[1] - lo_hi[0]).length < 0.13)(bbox([v.co for g in isl for v in g.verts]))]
        if gone:
            bmesh.ops.delete(bm, geom=list(set(gone)), context='FACES')
            bm.to_mesh(o.data); o.data.update()
            print('badge removed from', o.name, len(set(gone)), 'faces')
        bm.free()

# Z-FIGHTING: faces of one part lying on another part's surface (the van's black bumper strips on the white body: a
# black/white flicker) — the lower one ("under", e.g. MAINBODY) loses its faces there
if cfg.get('zfight'):
    from mathutils.bvhtree import BVHTree
    for top, under in cfg['zfight']:
        to = [o for o in meshes() if o.data.materials and o.data.materials[0] and top in o.data.materials[0].name]
        uo = [o for o in meshes() if o.data.materials and o.data.materials[0] and under in o.data.materials[0].name]
        for t_ in to:
            bmt = bmesh.new(); bmt.from_mesh(t_.data); tree = BVHTree.FromBMesh(bmt)
            for u_ in uo:
                bm = bmesh.new(); bm.from_mesh(u_.data)
                gone = []
                for f in bm.faces:
                    c = f.calc_center_median()
                    hit = tree.find_nearest(c, 0.006)
                    if hit[0] is not None and abs(hit[1].dot(f.normal)) > 0.8:
                        gone.append(f)
                if gone:
                    bmesh.ops.delete(bm, geom=gone, context='FACES'); bm.to_mesh(u_.data)
                    print('z-fight:', len(gone), under, 'faces under', top, 'removed')
                bm.free()
            bmt.free()

# ---------------------------------------------------------------- 2b. wheels: the source's out (or split per corner)
wheel_objs = []
if cfg.get('keep_wheels'):
    src = next(o for o in meshes() if o.data.materials and o.data.materials[0] and cfg['keep_wheels'] in o.data.materials[0].name)
    bake_texture_to_col(src)
    for key, (c, R, wd) in W.items():
        o = src.copy(); o.data = src.data.copy(); sc.collection.objects.link(o)
        bm = bmesh.new(); bm.from_mesh(o.data)
        gone = [f for f in bm.faces if (f.calc_center_median() - c).length > R * 1.3]
        bmesh.ops.delete(bm, geom=gone, context='FACES'); bm.to_mesh(o.data); bm.free()
        o.name = 'wheel_' + key; o['rim'] = cfg['rim']
        wheel_objs.append(o)
    bpy.data.objects.remove(src, do_unlink=True)
else:
    for o in list(meshes()):
        if o.data.materials and any(m and any(w in m.name for w in cfg['wheel_mats']) for m in o.data.materials):
            bpy.data.objects.remove(o, do_unlink=True)

# ---------------------------------------------------------------- 2c. budget: decimate the body (UVs kept)
body_budget = cfg.get('body_budget')
if body_budget:
    parts = [o for o in meshes() if not o.name.startswith('wheel_')]
    t0 = tris(parts)
    if t0 > body_budget:
        big = [o for o in parts if tris([o]) > 600]
        small = tris(parts) - tris(big)
        ratio = max(0.12, (body_budget - small) / max(1, tris(big)))
        for o in big:
            mod = o.modifiers.new('dec', 'DECIMATE'); mod.ratio = ratio; mod.use_collapse_triangulate = True
            with bpy.context.temp_override(object=o, active_object=o):
                bpy.ops.object.modifier_apply(modifier=mod.name)
        print('decimated body', t0, '→', tris([o for o in meshes() if not o.name.startswith('wheel_')]), 'ratio', round(ratio, 3))

# ---------------------------------------------------------------- 2d. materials → roles (matte), colours into vertices
TEX = None
if cfg.get('texture'):
    for o in meshes():
        for m in o.data.materials:
            if m and cfg['texture'] in m.name:
                TEX = base_image(m)[0]
# WATERMARKS painted out of the texture (BMW: "ROH3D.COM" on both plates — a blank plate)
if TEX is not None and cfg.get('paint_out'):
    px = img_pixels(TEX).copy(); h, w = px.shape[:2]
    for (x0, y0, x1, y1) in cfg['paint_out']:
        ys0, ys1 = h - y1, h - y0          # (Blender rows run bottom-up)
        fill = px[h - y0 - 1, x0 - 2, :3].copy() if px[h - y0 - 1, x0 - 2, :3].mean() > 0.5 else np.array([0.9, 0.9, 0.9], np.float32)
        px[ys0:ys1, x0:x1, :3] = fill
    out_ = px.copy()
    out_[..., :3] = np.where(out_[..., :3] <= 0.0031308, out_[..., :3] * 12.92, 1.055 * np.power(np.clip(out_[..., :3], 0, None), 1 / 2.4) - 0.055)
    TEX.pixels[:] = out_.ravel(); TEX.update()
    IMG.pop(TEX.name, None)
    print('watermark painted out', cfg['paint_out'])

MAT = {
    'paint': role_mat('paint'), 'trim': role_mat('trim'), 'cabin': role_mat('cabin_trim'), 'glass': role_mat('glass', (0.55, 0.6, 0.62, 1), glass=True),
    'lamp': role_mat('lamp_lens'), 'wheel': role_mat('wheel_hw'), 'brake': role_mat('brake_hw'), 'dial': role_mat('dial'),
}
if TEX is not None:
    MAT['body'] = role_mat('body_tex', image=TEX)


def role_of(mname):
    n = mname.lower()
    if re.search(r'glass|window|windos', n):
        return 'glass'
    if re.search(r'light|lamp|focos|signal|^red', n):
        return 'lamp'
    if TEX is not None and cfg['texture'].lower() in n:
        return 'body'
    if re.search(r'_int|dash|seat', n):
        return 'cabin'
    if n.startswith('mainbody.') or n == 'mainbody' or 'paint' in n:
        return 'paint'
    return 'trim'


for o in meshes():
    if o.name.startswith('wheel_'):
        o.data.materials.clear(); o.data.materials.append(MAT['wheel']); continue
    # (the van's MAINBODY bakes to a mid grey: its paint panels take a clean white instead — the garage paint
    #  tints them, the AO below shades them)
    if cfg.get('paint_albedo') and any(m and role_of(m.name) == 'paint' for m in o.data.materials):
        pass
    roles = [role_of(m.name) if m else 'trim' for m in o.data.materials]
    if not any(r == 'body' for r in roles):
        bake_texture_to_col(o)
    else:
        me = o.data  # textured body: the colour is in the texture; vertex colour = AO only (later)
        bake_texture_to_col(o)  # (non-body slots of a textured object keep their own colour)
        a = me.color_attributes['Col']
        for p in me.polygons:
            if roles[p.material_index] == 'body':
                for li in p.loop_indices:
                    a.data[li].color = (1, 1, 1, 1)
    me = o.data
    if cfg.get('paint_albedo'):
        a_ = me.color_attributes['Col']; pa = cfg['paint_albedo']
        for p in me.polygons:
            if roles[p.material_index] == 'paint':
                for li in p.loop_indices:
                    a_.data[li].color = (pa, pa, pa, 1)
    for i, r in enumerate(roles):
        me.materials[i] = MAT[r]
# one object per role (fewer parts, fewer materials)
groups = {}
for o in meshes():
    if o.name.startswith('wheel_'):
        continue
    r = o.data.materials[0].name if len(o.data.materials) == 1 else 'mixed'
    groups.setdefault(r, []).append(o)
for r, objs in groups.items():
    if len(objs) > 1:
        with bpy.context.temp_override(active_object=objs[0], selected_editable_objects=objs, selected_objects=objs):
            bpy.ops.object.join()
for o in meshes():
    if not o.name.startswith('wheel_'):
        o.name = 'body_' + (o.data.materials[0].name if o.data.materials else 'x')
print('materials', sorted({m.name for o in meshes() for m in o.data.materials if m}), 'tris', tris(meshes()))

# ---------------------------------------------------------------- 3. wheels (built) + brake hardware
class Builder:
    """Faces in wheel-local space: x = outward along the axle, (y, z) the wheel plane (z up) — vehicle_realism.py's."""

    def __init__(self):
        self.bm = bmesh.new(); self.cols = []

    def v(self, x, r, a):
        return self.bm.verts.new((x, r * math.sin(a), r * math.cos(a)))

    def face(self, vs, col):
        try:
            self.cols.append((self.bm.faces.new(vs), col))
        except ValueError:
            pass

    def revolve(self, prof, cols, n, a0=0.0):
        rings = [[self.v(x, r, a0 + 2 * math.pi * k / n) for k in range(n)] for (x, r) in prof]
        for i in range(len(prof) - 1):
            A, B = rings[i], rings[i + 1]
            for k in range(n):
                k2 = (k + 1) % n
                self.face((A[k], A[k2], B[k2], B[k]), cols[i])

    def block(self, x0, x1, r0, r1, a0, a1, col, taper=0.85):
        am, ah = (a0 + a1) / 2, (a1 - a0) / 2 * taper
        b = [self.v(x0, r0, a0), self.v(x1, r0, a0), self.v(x1, r0, a1), self.v(x0, r0, a1)]
        t = [self.v(x0, r1, am - ah), self.v(x1, r1, am - ah), self.v(x1, r1, am + ah), self.v(x0, r1, am + ah)]
        for q in ((b[0], b[1], b[2], b[3]), (t[3], t[2], t[1], t[0]), (b[0], t[0], t[1], b[1]), (b[1], t[1], t[2], b[2]),
                  (b[2], t[2], t[3], b[3]), (b[3], t[3], t[0], b[0])):
            self.face(q, col)

    def to_object(self, name, mat, M):
        bmesh.ops.recalc_face_normals(self.bm, faces=[f for f, _ in self.cols if f.is_valid])
        me = bpy.data.meshes.new(name); self.bm.to_mesh(me)
        col = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
        for poly, (f, rgb) in zip(me.polygons, self.cols):
            for li in poly.loop_indices:
                col.data[li].color = (*rgb, 1.0)
        me.color_attributes.active_color = col
        me.materials.append(mat); me.transform(M)
        ob = bpy.data.objects.new(name, me); sc.collection.objects.link(ob)
        return ob


RUBBER = (0.028, 0.028, 0.03); TREAD = (0.045, 0.043, 0.04); DARK = (0.012, 0.012, 0.014); NUT = (0.5, 0.5, 0.52)


def build_wheel(key, c, R, Wd, out):
    t = cfg['tyre']; b = Builder()
    Rr = t['ratio'] * R; knob = 0.014 * R; Rb = R - knob; sw = Rb - Rr; W_ = Wd
    side = [(-0.40, 0.0), (-0.47, 0.22), (-0.50, 0.5), (-0.485, 0.78), (-0.44, 0.95), (-0.36, 1.0)]
    prof = [(x * W_, Rr + f * sw) for (x, f) in side] + [(0.0, Rb)] + [(-x * W_, Rr + f * sw) for (x, f) in reversed(side)]
    b.revolve(prof, [RUBBER] * (len(prof) - 1), t['segs'])
    rows = t['rows']; pitch = 2 * math.pi / rows
    for k in range(rows):
        for s_, off in ((-1, 0.0), (1, 0.5)):
            a0 = k * pitch + off * pitch; a1 = a0 + 0.66 * pitch
            x0, x1 = sorted((s_ * 0.03 * W_, s_ * 0.44 * W_))
            b.block(x0, x1, Rb - 0.004 * R, R, a0, a1, TREAD)
    rc = t['rim_rgb']
    b.revolve([(x * W_, r) for (x, r) in [(0.40, Rr + 0.012 * R), (0.37, Rr - 0.004 * R), (0.0, Rr - 0.03 * R), (-0.40, Rr - 0.03 * R), (-0.42, Rr + 0.01 * R)]],
              [rc, rc, tuple(v * 0.6 for v in rc), rc], 32)
    # spoke wheel: a dished centre, 8 spokes, a dark hub, 4 nuts
    b.revolve([(0.10 * W_, 0.0), (0.12 * W_, 0.24 * Rr), (0.06 * W_, 0.34 * Rr)], [rc, rc], 20)
    for k in range(8):
        a = k * 2 * math.pi / 8
        b.block(0.0, 0.1 * W_, 0.3 * Rr, Rr - 0.02 * R, a - 0.17, a + 0.17, rc, taper=0.7)
    b.revolve([(-0.2 * W_, 0.94 * Rr), (-0.2 * W_, 0.3 * Rr)], [DARK], 24)   # the dark disc behind the spokes
    for k in range(4):
        a = k * math.pi / 2 + math.pi / 4
        b.block(0.12 * W_, 0.16 * W_, 0.18 * Rr, 0.22 * Rr, a - 0.12, a + 0.12, NUT, taper=1.0)
    M = Matrix.Translation(c) @ (Matrix.Rotation(math.pi, 4, 'Z') if out < 0 else Matrix.Identity(4))
    ob = b.to_object('wheel_' + key, MAT['wheel'], M)
    ob['rim'] = t['ratio']
    return ob


if not cfg.get('keep_wheels'):
    for key, (c, R, wd) in W.items():
        wheel_objs.append(build_wheel(key, c, W['FL'][1], W['FL'][2], 1 if c.x > 0 else -1))

DISC = (0.3, 0.3, 0.31); HAT = (0.16, 0.16, 0.17); CAL = (0.12, 0.12, 0.13); DRUM = (0.1, 0.1, 0.1)
for key, (c, R, wd) in W.items():
    b = Builder(); Rr = (cfg['rim'] if cfg.get('keep_wheels') else cfg['tyre']['ratio']) * R
    if cfg['brake'] == 'disc':
        rd = Rr * 0.82
        b.revolve([(-0.05, rd * 0.45), (-0.05, rd), (-0.075, rd), (-0.075, rd * 0.45)], [DISC, DISC, DISC], 24)
        b.revolve([(0.0, 0.0), (0.0, rd * 0.45), (-0.05, rd * 0.45)], [HAT, HAT], 16)
        b.block(-0.1, -0.03, rd * 0.62, rd * 1.06, -0.32, 0.32, CAL, taper=0.9)      # caliper at 12 o'clock
    else:
        rd = Rr * 0.88
        b.revolve([(-0.11, 0.0), (-0.11, rd), (-0.02, rd), (-0.02, rd * 0.4), (0.0, rd * 0.4), (0.0, 0.0)], [DRUM] * 5, 24)
    out = 1 if c.x > 0 else -1
    M = Matrix.Translation(c) @ (Matrix.Rotation(math.pi, 4, 'Z') if out < 0 else Matrix.Identity(4))
    b.to_object('caliper_' + key, MAT['brake'], M)

# ---------------------------------------------------------------- 4. doors (front, both sides)
poly = cfg['door']


def in_poly(y, z):
    n = len(poly); inside_ = False
    for i in range(n):
        (y1, z1), (y2, z2) = poly[i], poly[(i + 1) % n]
        if (z1 > z) != (z2 > z) and y < (y2 - y1) * (z - z1) / (z2 - z1 + 1e-12) + y1:
            inside_ = not inside_
    return inside_


DX = cfg['door_x']
car_tag = CAR.split('_')[0]
for side_key, sgn in (('FL', 1), ('FR', -1)):
    door_parts = []
    for o in [o for o in meshes() if o.name.startswith('body_')]:
        dx = DX - (0.15 if o.data.materials and o.data.materials[0].name == 'glass' else 0.0)   # (side glass leans in)
        bm = bmesh.new(); bm.from_mesh(o.data)
        # bisect along the outline (only the door side's outer faces), then split: the copy keeps the door faces
        for i in range(len(poly)):
            (y1, z1), (y2, z2) = poly[i], poly[(i + 1) % len(poly)]
            d = Vector((0, y2 - y1, z2 - z1)); n = Vector((0, -d.z, d.y)).normalized()
            fs = [f for f in bm.faces if f.calc_center_median().x * sgn > dx - 0.05]
            if fs:
                geom = list({v for f in fs for v in f.verts}) + list({e for f in fs for e in f.edges}) + fs
                bmesh.ops.bisect_plane(bm, geom=geom, plane_co=Vector((0, y1, z1)), plane_no=n)
        bm.faces.ensure_lookup_table()
        sel = {f.index for f in bm.faces if f.calc_center_median().x * sgn > dx and in_poly(f.calc_center_median().y, f.calc_center_median().z)}
        bm.to_mesh(o.data); bm.free()
        if not sel:
            continue
        dob = o.copy(); dob.data = o.data.copy(); sc.collection.objects.link(dob)
        for ob_, keep in ((dob, True), (o, False)):
            bm = bmesh.new(); bm.from_mesh(ob_.data); bm.faces.ensure_lookup_table()
            bmesh.ops.delete(bm, geom=[f for f in bm.faces if (f.index in sel) != keep], context='FACES')
            bm.to_mesh(ob_.data); ob_.data.update(); bm.free()
        door_parts.append(dob)
    if door_parts:
        if len(door_parts) > 1:
            with bpy.context.temp_override(active_object=door_parts[0], selected_editable_objects=door_parts, selected_objects=door_parts):
                bpy.ops.object.join()
        dob = door_parts[0]; dob.name = f'door_{side_key}_{car_tag}'
        vs = [v.co for v in dob.data.vertices]
        lo, hi = bbox(vs)
        ymin = min(p[0] for p in poly)
        hinge = Vector((hi.x if sgn > 0 else lo.x, ymin + 0.02, (lo.z + hi.z) / 2))
        dob['hinge'] = gl(hinge)
        print('door', dob.name, len(dob.data.polygons), 'faces, hinge', [round(v, 3) for v in hinge])

# ---------------------------------------------------------------- 5. steering wheel + cockpit controls
STEEL = (0.08, 0.08, 0.085); BLACK = (0.02, 0.02, 0.022); RUB = (0.025, 0.025, 0.027); LEATHER = (0.03, 0.026, 0.024)


class Part:
    def __init__(self):
        self.bm = bmesh.new(); self.cols = []; self.uvs = []

    def face(self, vs, col, uv=None):
        try:
            f = self.bm.faces.new(vs)
        except ValueError:
            return
        self.cols.append((f, col)); self.uvs.append(uv)

    def box(self, c, size, col, basis=None):
        u, v, w = basis or (Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)))
        hx, hy, hz = (q / 2 for q in size)
        vs = [self.bm.verts.new(c + u * dx_ + v * dy + w * dz) for dz in (-hz, hz) for dy in (-hy, hy) for dx_ in (-hx, hx)]
        for q in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
            self.face([vs[i] for i in q], col)

    def tube(self, a, b, r, col, seg=8):
        ax = (b - a).normalized(); u = ax.orthogonal().normalized(); v = ax.cross(u)
        ra = [self.bm.verts.new(a + (u * math.cos(t) + v * math.sin(t)) * r) for t in (2 * math.pi * i / seg for i in range(seg))]
        rb = [self.bm.verts.new(b + (u * math.cos(t) + v * math.sin(t)) * r) for t in (2 * math.pi * i / seg for i in range(seg))]
        for i in range(seg):
            j = (i + 1) % seg
            self.face((ra[i], ra[j], rb[j], rb[i]), col)
        self.face(list(reversed(ra)), col); self.face(rb, col)

    def ring(self, c, n, R, r, col, seg=28, tseg=8):
        u = n.orthogonal().normalized(); v = n.cross(u); rings = []
        for i in range(seg):
            t = 2 * math.pi * i / seg; d = u * math.cos(t) + v * math.sin(t)
            rings.append([self.bm.verts.new(c + d * R + (d * math.cos(q) + n * math.sin(q)) * r) for q in (2 * math.pi * j / tseg for j in range(tseg))])
        for i in range(seg):
            a, b = rings[i], rings[(i + 1) % seg]
            for j in range(tseg):
                self.face((a[j], b[j], b[(j + 1) % tseg], a[(j + 1) % tseg]), col)

    def quad_uv(self, c, u, v, w, h, uv_rect):
        hw, hh = w / 2, h / 2
        vs = [self.bm.verts.new(p) for p in (c - u * hw - v * hh, c + u * hw - v * hh, c + u * hw + v * hh, c - u * hw + v * hh)]
        u0, v0, u1, v1 = uv_rect
        self.face(vs, (1, 1, 1), [(u0, v0), (u1, v0), (u1, v1), (u0, v1)])

    def finish(self, name, mat, extras=None):
        solid = [f for (f, _), uv in zip(self.cols, self.uvs) if f.is_valid and not uv]
        if solid:
            bmesh.ops.recalc_face_normals(self.bm, faces=solid)
        if any(self.uvs):
            uvl = self.bm.loops.layers.uv.new('UVMap')
            for (f, _), uv in zip(self.cols, self.uvs):
                if uv and f.is_valid:
                    for l, q in zip(f.loops, uv):
                        l[uvl].uv = q
        me = bpy.data.meshes.new(name); self.bm.to_mesh(me); self.bm.free()
        col = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
        for poly, (f, rgb) in zip(me.polygons, self.cols):
            for li in poly.loop_indices:
                col.data[li].color = (*rgb, 1.0)
        me.color_attributes.active_color = col
        me.materials.append(mat)
        ob = bpy.data.objects.new(name, me); sc.collection.objects.link(ob)
        for k_, v_ in (extras or {}).items():
            ob[k_] = v_
        return ob


def cast(o_, d, skip=('wheel_', 'caliper_', 'door_')):
    dg = bpy.context.evaluated_depsgraph_get()
    for _ in range(8):
        hit, loc, nrm, idx, ob, _m = sc.ray_cast(dg, o_, d)
        if not hit:
            return None, None
        if ob.name.startswith(skip) or (ob.data.materials and ob.data.materials[0].name == 'glass'):
            o_ = loc + d * 0.003
            continue
        return loc, nrm
    return None, None


# STEERING WHEEL: the model's own (islands in a box → its own part), or built on the column's top
if cfg.get('steer_box'):
    box = cfg['steer_box']; parts_ = []
    for o in [o for o in meshes() if o.name.startswith('body_')]:
        bm = bmesh.new(); bm.from_mesh(o.data); bm.faces.ensure_lookup_table()
        sel = set()
        for isl in islands(bm):
            vs = [v.co for g in isl for v in g.verts]
            lo, hi = bbox(vs)
            if inside((lo + hi) / 2, box):
                sel |= {f.index for f in isl}
        bm.free()
        if not sel:
            continue
        sw = o.copy(); sw.data = o.data.copy(); sc.collection.objects.link(sw)
        for ob_, keep in ((sw, True), (o, False)):
            bm = bmesh.new(); bm.from_mesh(ob_.data); bm.faces.ensure_lookup_table()
            bmesh.ops.delete(bm, geom=[f for f in bm.faces if (f.index in sel) != keep], context='FACES')
            bm.to_mesh(ob_.data); bm.free()
        parts_.append(sw)
    if len(parts_) > 1:
        with bpy.context.temp_override(active_object=parts_[0], selected_editable_objects=parts_, selected_objects=parts_):
            bpy.ops.object.join()
    if parts_:
        parts_[0].name = 'steering_wheel'
        print('steering wheel split out', len(parts_[0].data.polygons), 'faces')
if cfg.get('build_steering'):
    bs = cfg['build_steering']; c = Vector(bs['c'])
    n = Vector((0, math.sin(math.radians(bs['tilt'])), math.cos(math.radians(bs['tilt']))))   # rim normal, up toward the driver
    n = Vector((0, -n.y, n.z)) if False else Vector((0, n.y, n.z))
    p = Part()
    p.ring(c, n, bs['R'], 0.014, BLACK, 28, 7)
    down = (Vector((0, 0, -1)) - n * Vector((0, 0, -1)).dot(n)).normalized(); right = n.cross(down)
    for ang in (90, 270):     # two spokes (a 1980s kei van's wheel)
        d = down * math.cos(math.radians(ang)) + right * math.sin(math.radians(ang))
        p.tube(c - n * 0.02, c + d * (bs['R'] - 0.01), 0.011, BLACK, 6)
    p.tube(c - n * 0.04, c + n * 0.005, 0.04, BLACK, 14)     # hub
    p.finish('steering_wheel', MAT['wheel'])

# PEDALS (pivot at the top of the arm, axis across), GEAR LEVER, DIAL FACES
pd = cfg['pedals']
for nm, x in zip(('pedal_clutch', 'pedal_brake', 'pedal_gas'), pd['xs']):
    loc, _ = cast(Vector((x, pd['y_pad'], pd['z_pivot'] - 0.12)), Vector((0, 0, -1)))   # (from under the dash: the floor)
    fz = pd['floor'] if 'floor' in pd else loc.z if loc else 0.2
    a = Vector((x, pd['y_pivot'], pd['z_pivot'])); b = Vector((x, pd['y_pad'], fz + 0.12))
    p = Part(); p.tube(a, b, 0.009, STEEL, 6)
    p.box(b + Vector((0, 0.012, 0)), (0.07, 0.022, 0.06) if nm != 'pedal_gas' else (0.06, 0.02, 0.14), RUB)
    p.finish(nm, MAT['wheel'], {'pivot': gl(a), 'axis': [1.0, 0.0, 0.0]})
gr = cfg['gear']
loc, _ = cast(Vector((gr['x'], gr['y'], 1.4)), Vector((0, 0, -1)))
base = Vector((gr['x'], gr['y'], loc.z if loc else 0.4))
p = Part()
p.box(base + Vector((0, 0, 0.03)), (0.11, 0.11, 0.06), RUB)
tip = base + Vector((0, 0.15, 1)).normalized() * gr.get('top', 0.28)
p.tube(base, tip, 0.008, STEEL, 8); p.box(tip, (0.045, 0.045, 0.045), BLACK)
p.finish('gear_lever', MAT['wheel'], {'pivot': gl(base), 'axis': [1.0, 0.0, 0.0]})

eye = Vector(cfg['eye']); dl = cfg['dials']
centre = Vector(dl['at'])
f = (eye - centre).normalized(); u = Vector((-1, 0, 0)); u = (u - f * u.dot(f)).normalized(); v = f.cross(u).normalized()
if v.z < 0:
    v = -v
u = v.cross(f).normalized()
# the face 4 mm in front of whatever surface is behind it (cast from the eye)
loc, _ = cast(eye, (centre - eye).normalized())
c0 = (loc - (centre - eye).normalized() * 0.004) if loc else centre
p = Part()
if dl['style'] == 'twin':
    for off, uv in ((-1, (0.0, 0.0, 0.5, 1.0)), (1, (0.5, 0.0, 1.0, 1.0))):
        p.quad_uv(c0 + u * (off * dl['gap'] / 2) * (-1), u, v, dl['size'], dl['size'], uv)
else:
    p.quad_uv(c0, u, v, dl['size'], dl['size'], (0.0, 0.0, 0.5, 1.0))
    p.quad_uv(c0 - u * (dl['size'] * 0.95), u, v, dl['size'] * 1.4, dl['size'] * 0.6, (0.5, 0.25, 1.0, 0.75))
p.finish('dial_' + car_tag, MAT['dial'])
print('cockpit: dials at', [round(q, 3) for q in c0], 'hit' if loc else 'NO SURFACE')

# ---------------------------------------------------------------- 6. AO into the vertex colours, export
for o in meshes():
    for m in o.data.materials:
        if m and m.name != 'body_tex':
            pass
sc.render.engine = 'CYCLES'; sc.cycles.samples = int(ARGS.get('SAMPLES', 48)); sc.cycles.device = 'CPU'
if not sc.world:
    sc.world = bpy.data.worlds.new('ao')
sc.world.light_settings.distance = 0.6
glassy = [o for o in meshes() if o.data.materials and all(m and m.name in ('glass', 'lamp_lens') for m in o.data.materials)]
skip_ao = [o for o in meshes() if o.name.startswith('dial_')]
bake = [o for o in meshes() if o not in glassy and o not in skip_ao]
if ARGS.get('BAKE', '1') == '1':
    for o in glassy:
        o.hide_render = True
    for o in bake:
        a = o.data.color_attributes.new('AO', 'FLOAT_COLOR', 'CORNER'); o.data.color_attributes.active_color = a
    bpy.ops.object.select_all(action='DESELECT')
    for o in bake:
        o.select_set(True)
    bpy.context.view_layer.objects.active = bake[0]
    bpy.ops.object.bake(type='AO', target='VERTEX_COLORS')
    for o in bake:
        at = o.data.color_attributes
        col, ao = at.get('Col'), at.get('AO')
        if col is None:
            col = at.new('Col', 'FLOAT_COLOR', 'CORNER')
            col.data.foreach_set('color', [1.0] * (4 * len(col.data)))
        cc = np.zeros(len(col.data) * 4, np.float32); col.data.foreach_get('color', cc)
        aa = np.zeros(len(ao.data) * 4, np.float32); ao.data.foreach_get('color', aa)
        cc = cc.reshape(-1, 4); aa = aa.reshape(-1, 4)
        cc[:, :3] *= (0.25 + 0.75 * aa[:, :1])
        col.data.foreach_set('color', cc.ravel()); at.remove(ao); at.active_color = col
    for o in glassy:
        o.hide_render = False
for o in meshes():
    at = o.data.color_attributes
    for a in list(at):
        if a.name != 'Col':
            at.remove(a)
    if at.get('Col'):
        at.active_color = at['Col']; at.render_color_index = at.active_color_index
sc['vertex_ao'] = 1
for o in meshes():   # (the exporter wants per-object transforms: identity here — all in the metre frame)
    o.data.update()
L = bbox([v.co for o in meshes() for v in o.data.vertices])
path = os.path.join(OUT, CAR + '.lod0.glb')
bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_active_scene=True, export_extras=True, export_cameras=False,
                          export_lights=False, export_animations=False, export_yup=True, export_vertex_color='ACTIVE',
                          export_image_format='JPEG' if TEX is not None else 'AUTO')
mats = sorted({m.name for o in meshes() for m in o.data.materials if m})
print('EXPORTED', path, os.path.getsize(path), 'bytes, tris', tris(meshes()), 'mats', len(mats), mats,
      'length', round(L[1].y - L[0].y, 4), 'width', round(L[1].x - L[0].x, 3), 'height', round(L[1].z, 3))
print('PARTS', sorted(o.name for o in meshes()))
