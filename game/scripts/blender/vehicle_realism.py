"""
VEHICLE PREP, step 4 (any car; skills/realistic-vehicle-system §8.2, §8.9): REAL WHEELS + BAKED AMBIENT OCCLUSION.

1. The model's own wheels (named parts, or the round loose parts on the ground) are replaced by wheels built here
   at the same size, named `wheel_<FL|FR|RL|RR>` (extra `rim` = rim radius / tyre radius, for the tyre shader):
   - TYRE: a revolved carcass (bead → bulging sidewall → shoulder → tread) with staggered tread BLOCKS and
     shoulder LUGS — mud-terrain (big, open), all-terrain (tighter) or road (fine blocks) by the car's tyre kind;
     the block tops are the tyre's real outer radius (the physics radius).
   - RIM: steel (dished face, lip, vents, hub, lug nuts), alloy (spokes — the brakes show through) or steel with a
     chrome cap.
   Vertex colours on one material `wheel_hw` (rubber, dusty tread tops, rim paint, chrome nuts).
2. Cycles AMBIENT OCCLUSION baked into every part's vertex colours (glass hidden so light reaches the cabin):
   wheel arches, panel gaps, under the body and inside the cabin darken like the real thing; the loader multiplies
   it into the baked material colour (scene extra `vertex_ao`). Wheel / brake parts keep their albedo × AO.

Run (Blender with the MCP add-on server on :9876), after vehicle_brakes.py:
  node scripts/blender/bl.mjs scripts/blender/vehicle_realism.py NAME=mercedes_g500_4x4 OUT=C:/tmp/real/
Then copy OUT/<NAME>.lod0.glb to src/assets/models/vehicles/ and run `npm run validate:assets`.
"""
import bpy, bmesh, math, os, json, re
from mathutils import Vector, Matrix

SRC = 'C:/Project/Dark/src/assets/models/vehicles/'
CARS = {
    # tyre: tread style; rim: rim style + rim/tyre radius ratio; metres: the tyre radius in metres (AO distance)
    'mercedes_g500_4x4': {'tread': 'at', 'rim': 'alloy', 'ratio': 0.6, 'metres': 0.475, 'rim_rgb': (0.11, 0.11, 0.12),
                          'segs': 32, 'rows': 22},  # (lighter wheels: the G500 is at the 40 k budget)
}
NAME = globals().get('NAME', 'mercedes_g500_4x4')
OUT = globals().get('OUT', 'C:/tmp/real/')
cfg = CARS[NAME]
os.makedirs(OUT, exist_ok=True)

RUBBER = (0.028, 0.028, 0.03)
TREAD = (0.05, 0.046, 0.042)
NUT = (0.55, 0.56, 0.58)
CHROME = (0.7, 0.72, 0.75)
DARK = (0.012, 0.012, 0.014)

sc_name = 'real_' + NAME
sc = bpy.data.scenes.get(sc_name) or bpy.data.scenes.new(sc_name)
for o in list(sc.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.context.window_manager.windows[0].scene = sc
bpy.ops.import_scene.gltf(filepath=SRC + NAME + '.lod0.glb')
meshes = [o for o in sc.objects if o.type == 'MESH']


def tris(objs):
    t = 0
    for o in objs:
        t += sum(len(p.vertices) - 2 for p in o.data.polygons)
    return t


before = tris(meshes)

# ---------------- 1. find + remove the old wheels ----------------
allv = [o.matrix_world @ v.co for o in meshes for v in o.data.vertices]
zmin = min(p.z for p in allv); zmax = max(p.z for p in allv); H = zmax - zmin
cands = []  # (centre, r, w, lo, hi, obj, face indices)
named = {}
for o in meshes:
    n = o.name.lower().replace('_', '')
    if 'wheel' in n and not o.name.startswith('wheel_'):
        for key in ('fl', 'fr', 'bl', 'br', 'rl', 'rr'):
            if 'wheel' + key in n:
                named.setdefault(key, []).append(o)
if len(named) == 4:
    for objs in named.values():
        pts = [o.matrix_world @ v.co for o in objs for v in o.data.vertices]
        lo = Vector([min(p[i] for p in pts) for i in range(3)]); hi = Vector([max(p[i] for p in pts) for i in range(3)])
        cands.append(((lo + hi) / 2, (hi.z - lo.z) / 2, hi.x - lo.x, lo, hi, None, None))
    for objs in named.values():
        for o in objs:
            bpy.data.objects.remove(o, do_unlink=True)
else:
    for o in meshes:
        if o.name.startswith(('door_', 'caliper_')):
            continue
        bm = bmesh.new(); bm.from_mesh(o.data)
        seen = set()
        for f0 in bm.faces:
            if f0.index in seen:
                continue
            stack, comp = [f0], []
            seen.add(f0.index)
            while stack:
                f = stack.pop(); comp.append(f)
                for e in f.edges:
                    for g in e.link_faces:
                        if g.index not in seen:
                            seen.add(g.index); stack.append(g)
            pts = [o.matrix_world @ v.co for f in comp for v in f.verts]
            lo = Vector([min(p[i] for p in pts) for i in range(3)]); hi = Vector([max(p[i] for p in pts) for i in range(3)])
            s = hi - lo
            if lo.z < zmin + 0.15 * H and s.z > 0.12 * H and abs(s.z - s.y) < 0.25 * s.z and s.x < 0.6 * s.z:
                cands.append(((lo + hi) / 2, s.z / 2, s.x, lo, hi, o, [f.index for f in comp]))
        bm.free()
# Cluster the parts of one wheel (tyre, rim, hub — often unwelded).
groups = []
for c in cands:
    g = next((g for g in groups if (g[0][0] - c[0]).length < 0.6 * c[1]), None)
    (g.append(c) if g else groups.append([c]))
if len(groups) != 4:
    raise RuntimeError(f'{NAME}: {len(groups)} wheels')
wheels = []
doomed = {}  # object → face indices of its old wheels (deleted once per object: indices shift otherwise)
for g in groups:
    lo = Vector([min(x[3][i] for x in g) for i in range(3)]); hi = Vector([max(x[4][i] for x in g) for i in range(3)])
    wheels.append(((lo + hi) / 2, (hi.z - lo.z) / 2, hi.x - lo.x))
    for x in g:
        if x[5] is not None:
            doomed.setdefault(x[5], set()).update(x[6])
for o, idx in doomed.items():
    bm = bmesh.new(); bm.from_mesh(o.data); bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.faces[i] for i in sorted(idx)], context='FACES')
    bm.to_mesh(o.data); bm.free()
ys = sorted(w[0].y for w in wheels)
ymid = (ys[1] + ys[2]) / 2
xmid = sum(w[0].x for w in wheels) / 4


def corner(c):
    return ('F' if c.y < ymid else 'R') + ('L' if c.x > xmid else 'R')


# ---------------- 2. build the new wheels ----------------
mat = bpy.data.materials.get('wheel_hw') or bpy.data.materials.new('wheel_hw')
mat.use_nodes = True
nt = mat.node_tree
bsdf = nt.nodes.get('Principled BSDF')
vc = next((n for n in nt.nodes if n.type == 'VERTEX_COLOR'), None) or nt.nodes.new('ShaderNodeVertexColor')
vc.layer_name = 'Col'
nt.links.new(vc.outputs['Color'], bsdf.inputs['Base Color'])


class Builder:
    """Faces in wheel-local space: x = outward along the axle, (y, z) the wheel plane (z up)."""

    def __init__(self):
        self.bm = bmesh.new()
        self.cols = []

    def v(self, x, r, a):
        return self.bm.verts.new((x, r * math.sin(a), r * math.cos(a)))

    def face(self, vs, col):
        try:
            self.cols.append((self.bm.faces.new(vs), col))
        except ValueError:
            pass

    def revolve(self, prof, cols, n, a0=0.0, closed=True):
        """Revolve a (x, r) polyline about the axle; cols[i] colours segment i."""
        rings = [[self.v(x, r, a0 + 2 * math.pi * k / n) for k in range(n)] for (x, r) in prof]
        for i in range(len(prof) - 1):
            A, B = rings[i], rings[i + 1]
            for k in range(n):
                k2 = (k + 1) % n
                self.face((A[k], A[k2], B[k2], B[k]), cols[i])

    def block(self, x0, x1, r0, r1, a0, a1, col, taper=0.85):
        """A tread block / lug / spoke: angular span a0..a1 at the base, tapered toward the top."""
        am, ah = (a0 + a1) / 2, (a1 - a0) / 2 * taper
        b = [self.v(x0, r0, a0), self.v(x1, r0, a0), self.v(x1, r0, a1), self.v(x0, r0, a1)]
        t = [self.v(x0, r1, am - ah), self.v(x1, r1, am - ah), self.v(x1, r1, am + ah), self.v(x0, r1, am + ah)]
        for q in ((b[0], b[1], b[2], b[3]), (t[3], t[2], t[1], t[0]), (b[0], t[0], t[1], b[1]), (b[1], t[1], t[2], b[2]),
                  (b[2], t[2], t[3], b[3]), (b[3], t[3], t[0], b[0])):
            self.face(q, col)

    def nut(self, x0, x1, r, a, size, col):
        c = Vector((0, r * math.sin(a), r * math.cos(a)))
        ring0, ring1 = [], []
        for k in range(6):
            t = 2 * math.pi * k / 6
            d = Vector((0, math.cos(t) * size, math.sin(t) * size))
            ring0.append(self.bm.verts.new((x0, c.y + d.y, c.z + d.z)))
            ring1.append(self.bm.verts.new((x1, c.y + d.y, c.z + d.z)))
        for k in range(6):
            k2 = (k + 1) % 6
            self.face((ring0[k], ring0[k2], ring1[k2], ring1[k]), col)
        self.face(list(reversed(ring1)), col)


def build_wheel(c, R, W, out):
    b = Builder()
    Rr = cfg['ratio'] * R
    tread = cfg['tread']
    knob = {'mt': 0.045, 'at': 0.032, 'road': 0.014}[tread] * R
    Rb = R - knob
    sw = Rb - Rr
    hw = W / 2
    # carcass: inner bead → sidewall bulge → shoulder → crown → mirror
    side = [(-0.40, 0.0), (-0.47, 0.22), (-0.50, 0.5), (-0.485, 0.78), (-0.44, 0.95), (-0.36, 1.0)]
    prof = [(x * W, Rr + f * sw) for (x, f) in side] + [(0.0, Rb)] + [(-x * W, Rr + f * sw) for (x, f) in reversed(side)]
    cols = [RUBBER] * (len(prof) - 1)
    b.revolve(prof, cols, cfg.get('segs', 40))
    # tread blocks (staggered pair per row) + shoulder lugs
    rows = cfg.get('rows') or {'mt': 18, 'at': 24, 'road': 34}[tread]
    fill = {'mt': 0.52, 'at': 0.6, 'road': 0.66}[tread]
    pitch = 2 * math.pi / rows
    for k in range(rows):
        a = k * pitch
        for s, off in ((-1, 0.0), (1, 0.5)):
            a0 = a + off * pitch
            a1 = a0 + fill * pitch
            inner, outer = (0.05 if tread != 'road' else 0.03) + (0.05 if k % 2 else 0.0), 0.44
            x0, x1 = sorted((s * inner * W, s * outer * W))
            b.block(x0, x1, Rb - 0.004 * R, R, a0, a1, TREAD)
            if tread != 'road':  # shoulder lug wrapping down the sidewall
                lx0, lx1 = sorted((s * 0.43 * W, s * 0.505 * W))
                b.block(lx0, lx1, Rr + 0.62 * sw, Rb + 0.3 * knob, a0 + 0.1 * pitch, a1 - 0.05 * pitch, RUBBER, taper=0.95)
    # rim
    rc = cfg['rim_rgb']
    lip = [(0.40, Rr + 0.012 * R), (0.37, Rr - 0.004 * R), (0.0, Rr - 0.03 * R), (-0.40, Rr - 0.03 * R), (-0.42, Rr + 0.01 * R)]
    b.revolve([(x * W, r) for (x, r) in lip], [rc, rc, (rc[0] * 0.6,) * 3, rc], 36)
    style = cfg['rim']
    if style == 'alloy':
        hub = [(0.14 * W, 0.0), (0.14 * W, 0.2 * Rr), (0.1 * W, 0.34 * Rr), (0.02 * W, 0.36 * Rr)]
        b.revolve(hub, [rc, rc, rc], 24)
        for k in range(6):
            a = k * 2 * math.pi / 6
            b.block(0.02 * W, 0.15 * W, 0.3 * Rr, Rr - 0.025 * R, a - 0.13, a + 0.13, rc, taper=0.6)
        for k in range(6):
            b.nut(0.13 * W, 0.17 * W, 0.24 * Rr, k * math.pi / 3 + math.pi / 6, 0.045 * Rr, NUT)
        b.revolve([(0.17 * W, 0.0), (0.17 * W, 0.1 * Rr)], [CHROME], 12)
    else:
        face = [(0.30, 0.98), (0.10, 0.92), (0.06, 0.78), (0.10, 0.55), (0.16, 0.44), (0.17, 0.30), (0.20, 0.22), (0.20, 0.0)]
        fc = [rc] * (len(face) - 1)
        b.revolve([(x * W, f * Rr) for (x, f) in face], fc, 32)
        vents = 6 if style == 'steel' else 8
        for k in range(vents):  # dark vent windows on the dish
            a = (k + 0.5) * 2 * math.pi / vents
            b.block(0.095 * W, 0.105 * W, 0.6 * Rr, 0.76 * Rr, a - 0.2, a + 0.2, DARK, taper=1.0)
        for k in range(6):
            b.nut(0.17 * W, 0.22 * W, 0.37 * Rr, k * math.pi / 3, 0.05 * Rr, NUT)
        if style == 'cap':  # chrome hubcap dome
            b.revolve([(0.2 * W, 0.5 * Rr), (0.26 * W, 0.42 * Rr), (0.3 * W, 0.22 * Rr), (0.31 * W, 0.0)], [CHROME] * 3, 28)
    bmesh.ops.recalc_face_normals(b.bm, faces=b.bm.faces)
    me = bpy.data.meshes.new('wheel')
    b.bm.to_mesh(me)
    b.bm.free()
    col = me.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
    for poly, (f, rgb) in zip(me.polygons, b.cols):
        for li in poly.loop_indices:
            col.data[li].color = (*rgb, 1.0)
    me.materials.append(mat)
    # wheel-local x = outward: mirror on the right side by turning the wheel 180° about Z (no negative scale)
    me.transform(Matrix.Translation(c) @ (Matrix.Rotation(math.pi, 4, 'Z') if out < 0 else Matrix.Identity(4)))
    ob = bpy.data.objects.new('wheel_' + corner(c), me)
    ob['rim'] = cfg['ratio']
    sc.collection.objects.link(ob)
    return ob


new_wheels = [build_wheel(c, R, W, 1 if c.x > xmid else -1) for (c, R, W) in wheels]

# ---------------- 3. bake ambient occlusion into vertex colours ----------------
scene = sc
scene.render.engine = 'CYCLES'
scene.cycles.samples = 48
scene.cycles.device = 'CPU'
if not scene.world:
    scene.world = bpy.data.worlds.new('ao_world')
k = max(w[1] for w in wheels) / cfg['metres']  # model units per metre
scene.world.light_settings.distance = 0.9 * k
meshes = [o for o in sc.objects if o.type == 'MESH']
def is_glass(m):
    return m is None or m.blend_method == 'BLEND' or re.search('glas|wind', m.name, re.I)


# Glass-only parts are hidden from the bake (light reaches the cabin); doors with a window still get their AO.
glassy = [o for o in meshes if o.material_slots and all(is_glass(s.material) for s in o.material_slots) and not o.name.startswith(('wheel_', 'caliper_'))]
for o in glassy:
    o.hide_render = True
bake = [o for o in meshes if o not in glassy]
own = [o for o in bake if o.name.startswith(('wheel_', 'caliper_'))]
for o in bake:
    attrs = o.data.color_attributes
    name = 'AO' if o in own else 'Col'
    if attrs.get(name):
        attrs.remove(attrs.get(name))
    if o not in own:  # body parts: AO only — drop any imported colour attribute (it would shadow the bake)
        for a in list(attrs):
            attrs.remove(a)
    a = attrs.new(name, 'BYTE_COLOR', 'CORNER' if o in own else 'POINT')
    attrs.active_color = a
bpy.ops.object.select_all(action='DESELECT')
for o in bake:
    o.select_set(True)
bpy.context.view_layer.objects.active = bake[0]
bpy.ops.object.bake(type='AO', target='VERTEX_COLORS')
for o in own:
    attrs = o.data.color_attributes
    # (imported parts name their colours 'Color', ours 'Col')
    col, ao = next(a for a in attrs if a.name != 'AO'), attrs.get('AO')
    for i in range(len(col.data)):
        a = ao.data[i].color[0]
        c = col.data[i].color
        col.data[i].color = (c[0] * a, c[1] * a, c[2] * a, 1.0)
    attrs.remove(ao)
    attrs.active_color = col
for o in glassy:
    o.hide_render = False
sc['vertex_ao'] = 1

meshes = [o for o in sc.objects if o.type == 'MESH']
mats = {s.material.name for o in meshes for s in o.material_slots if s.material}
path = OUT + NAME + '.lod0.glb'
bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_active_scene=True, export_extras=True,
                          export_cameras=False, export_lights=False, export_animations=False, export_yup=True,
                          export_vertex_color='ACTIVE')
print(json.dumps({'name': NAME, 'tris_before': before, 'tris_after': tris(meshes), 'materials': len(mats),
                  'bytes': os.path.getsize(path), 'wheels': {o.name: tris([o]) for o in new_wheels}}))
