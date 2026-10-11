"""
VEHICLE PREP, step 5 (any car; skills/realistic-vehicle-system §8.2): WORKING-VEHICLE DETAILS + a fresh AO bake.

Real 4×4s, pickups and vans in the field carry kit: spare wheels, racks, jerrycans, lights, flaps, sliders. Each
car gets its own set, built here as low-poly geometry (one material `detail_hw`, vertex colours), named `acc_*`
(the loader never paints them), placed in METRES from the car's wheels and body box (`k` = model units per metre
from the measured wheel radius):
  pickup — LED light bar on the roll cage, twin spotlights + winch on the bull bar, spare wheel, jerrycans and a
           toolbox in the bed, rock sliders, a snorkel;
  G500   — the G-Class rear spare in a hard cover, a roof rack with jerrycans and a bag
           (+ a collapse decimate of the hidden underbody details: the car sits at the 40 k budget);
  Żuk    — a roof rack with a ladder, crates and a tarp-covered load, a rear step.
Then Cycles AO is baked again: body parts get fresh AO, the new parts albedo × AO (wheels and brakes keep theirs).

Run after vehicle_realism.py:
  node scripts/blender/bl.mjs scripts/blender/vehicle_details.py NAME=pickup_truck OUT=C:/tmp/details/
"""
import bpy, bmesh, math, os, json, re
from mathutils import Vector, Matrix

SRC = 'C:/Project/Dark/src/assets/models/vehicles/'
NAME = globals().get('NAME', 'pickup_truck')
OUT = globals().get('OUT', 'C:/tmp/details/')
METRES = {'pickup_truck': 0.391, 'mercedes_g500_4x4': 0.475, 'zuk_a06': 0.339}
os.makedirs(OUT, exist_ok=True)

BLACK = (0.02, 0.02, 0.022)
STEEL = (0.08, 0.08, 0.085)
ALU = (0.42, 0.43, 0.45)
CHROME = (0.7, 0.72, 0.75)
LENS = (0.85, 0.86, 0.8)
AMBER = (0.9, 0.45, 0.05)
OLIVE = (0.17, 0.2, 0.1)
RED = (0.45, 0.05, 0.04)
CANVAS = (0.33, 0.29, 0.2)
WOOD = (0.32, 0.2, 0.1)
RUBBER = (0.028, 0.028, 0.03)
TREAD = (0.05, 0.046, 0.042)

sc = bpy.data.scenes.get('det_' + NAME) or bpy.data.scenes.new('det_' + NAME)
for o in list(sc.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.context.window_manager.windows[0].scene = sc
bpy.ops.import_scene.gltf(filepath=SRC + NAME + '.lod0.glb')
meshes = [o for o in sc.objects if o.type == 'MESH']


def tris(objs):
    return sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)


before = tris(meshes)
for o in [o for o in meshes if o.name.startswith('acc_')]:  # re-runs replace the kit
    bpy.data.objects.remove(o, do_unlink=True)
meshes = [o for o in sc.objects if o.type == 'MESH']

# ---- frame of reference: wheels, ground, body box, metres ----
W = {}
for o in meshes:
    m = re.match(r'wheel_(FL|FR|RL|RR)', o.name)
    if m:
        pts = [o.matrix_world @ v.co for v in o.data.vertices]
        lo = Vector([min(p[i] for p in pts) for i in range(3)]); hi = Vector([max(p[i] for p in pts) for i in range(3)])
        W[m.group(1)] = ((lo + hi) / 2, (hi.z - lo.z) / 2, hi.x - lo.x)
R = W['FL'][1]
WHEEL_MAT = next(s.material for o in meshes if o.name.startswith('wheel_') for s in o.material_slots if s.material)
k = R / METRES[NAME]                       # model units per metre
z0 = W['FL'][0].z - R                      # ground
xm = sum(w[0].x for w in W.values()) / 4   # centre line
body = [o for o in meshes if not o.name.startswith(('wheel_', 'caliper_'))]
bp = [o.matrix_world @ v.co for o in body for v in o.data.vertices]
blo = Vector([min(p[i] for p in bp) for i in range(3)]); bhi = Vector([max(p[i] for p in bp) for i in range(3)])
yF, yR = W['FL'][0].y, W['RL'][0].y      # front / rear axle (front = −y)
side = 1 if W['FL'][0].x > xm else -1     # +x is the car's left


def P(x, y, z):
    """Metres → model: x across (+ = left), y along (+ = toward the rear), z up from the ground; origin = the
    centre line at the front axle."""
    return Vector((xm + x * side * k, yF + y * k, z0 + z * k))


def H(z):
    """Model height → metres above the ground."""
    return (z - z0) / k


def local(p):
    """Model point → metres in P()'s frame."""
    return ((p.x - xm) * side / k, (p.y - yF) / k, (p.z - z0) / k)


BM = [local(p) for p in bp]


def width_at(z0_, z1_, y0_, y1_):
    """Half-width (m) of the body in a height / length band — mirrors and antennas don't count."""
    xs = [abs(x) for (x, y, z) in BM if z0_ <= z <= z1_ and y0_ <= y <= y1_]
    return max(xs) if xs else 0.8


def top_at(y0_, y1_, strip=0.35):
    """Roof (or cage) height (m) over a length band, in a central strip (the antenna stands at the side)."""
    zs = [z for (x, y, z) in BM if abs(x) < strip and y0_ <= y <= y1_]
    return max(zs) if zs else 1.8


class Kit:
    def __init__(self):
        self.bm = bmesh.new()
        self.cols = []

    def _face(self, vs, col):
        try:
            self.cols.append((self.bm.faces.new(vs), col))
        except ValueError:
            pass

    def box(self, c, size, col, rot=None):
        """Box at c (model), size in metres (x across, y along, z up), optional rotation matrix (3×3)."""
        hx, hy, hz = (s * k / 2 for s in size)
        vs = []
        for dz in (-hz, hz):
            for dy in (-hy, hy):
                for dx in (-hx, hx):
                    d = Vector((dx, dy, dz))
                    if rot:
                        d = rot @ d
                    vs.append(self.bm.verts.new(c + d))
        for q in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
            self._face([vs[i] for i in q], col)

    def tube(self, a, b, r, col, seg=8, caps=True):
        """Cylinder from a to b (model points), radius r metres."""
        ax = (b - a).normalized()
        u = ax.orthogonal().normalized(); v = ax.cross(u)
        rr = r * k
        ra = [self.bm.verts.new(a + (u * math.cos(t) + v * math.sin(t)) * rr) for t in (2 * math.pi * i / seg for i in range(seg))]
        rb = [self.bm.verts.new(b + (u * math.cos(t) + v * math.sin(t)) * rr) for t in (2 * math.pi * i / seg for i in range(seg))]
        for i in range(seg):
            j = (i + 1) % seg
            self._face((ra[i], ra[j], rb[j], rb[i]), col)
        if caps:
            self._face(list(reversed(ra)), col)
            self._face(rb, col)

    def disc(self, c, axis, r, depth, col, face_col=None, seg=16):
        a = c - axis.normalized() * depth * k / 2
        b = c + axis.normalized() * depth * k / 2
        self.tube(a, b, r, col, seg, caps=False)
        ax = axis.normalized(); u = ax.orthogonal().normalized(); v = ax.cross(u)
        ring = [self.bm.verts.new(b + (u * math.cos(t) + v * math.sin(t)) * r * k) for t in (2 * math.pi * i / seg for i in range(seg))]
        self._face(ring, face_col or col)
        ring2 = [self.bm.verts.new(a + (u * math.cos(t) + v * math.sin(t)) * r * k) for t in (2 * math.pi * i / seg for i in range(seg))]
        self._face(list(reversed(ring2)), col)

    def spare(self, c, axis, r, w, cover=None, seg=22):
        """A knobby spare wheel (or a hard-covered one) centred at c, its axle along `axis`."""
        ax = axis.normalized(); u = ax.orthogonal().normalized(); v = ax.cross(u)
        rr, hw = r * k, w * k / 2
        prof = [(-0.42, 0.55), (-0.5, 0.75), (-0.46, 0.95), (0.0, 0.97), (0.46, 0.95), (0.5, 0.75), (0.42, 0.55)]
        rings = [[self.bm.verts.new(c + ax * (x * 2 * hw) + (u * math.cos(t) + v * math.sin(t)) * f * rr) for t in (2 * math.pi * i / seg for i in range(seg))] for (x, f) in prof]
        for a in range(len(prof) - 1):
            for i in range(seg):
                j = (i + 1) % seg
                self._face((rings[a][i], rings[a][j], rings[a + 1][j], rings[a + 1][i]), RUBBER)
        if cover:
            self.disc(c + ax * hw * 0.55, ax, 0.98 * r, 0.06, cover, cover, seg)
        else:
            self.disc(c + ax * hw * 0.2, ax, 0.55 * r, 0.04, STEEL, STEEL, seg)
            for i in range(seg // 2):  # tread blocks
                t = 2 * math.pi * (i + 0.25) / (seg // 2)
                d = u * math.cos(t) + v * math.sin(t)
                self.box(c + d * rr * 0.985, (0.08, 0.08, 0.03), TREAD, Matrix((ax, d.cross(ax), d)).transposed())

    def jerrycan(self, c, col, rot=None):
        self.box(c, (0.17, 0.35, 0.47), col, rot)
        self.tube(c + Vector((0, -0.12 * k, 0.235 * k)), c + Vector((0, -0.12 * k, 0.29 * k)), 0.025, BLACK, 6)
        self.box(c + Vector((0, 0.06 * k, 0.255 * k)), (0.04, 0.16, 0.04), col, rot)

    def lamp(self, c, r, col=LENS, depth=0.08, facing=Vector((0, -1, 0))):
        self.disc(c, facing, r, depth, BLACK, col)

    def flap(self, w, behind=True):
        cc, rr, ww = W[w]
        y = cc.y + (1 if behind else -1) * (rr + 0.06 * k)
        x = cc.x
        self.box(Vector((x, y, z0 + 0.06 * k + 0.17 * k)), (ww / k * 0.95, 0.012, 0.34), RUBBER)

    def finish(self, name):
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        # 'Color' — the name the shared wheel material's colour node reads after a glTF re-import.
        col = me.color_attributes.new('Color', 'BYTE_COLOR', 'CORNER')
        for poly, (f, rgb) in zip(me.polygons, self.cols):
            for li in poly.loop_indices:
                col.data[li].color = (*rgb, 1.0)
        # Shares the wheels' vertex-coloured material (no extra material against the 12-material budget).
        mat = WHEEL_MAT or bpy.data.materials.new('wheel_hw')
        mat.use_nodes = True
        nt = mat.node_tree
        vc = next((n for n in nt.nodes if n.type == 'VERTEX_COLOR'), None) or nt.nodes.new('ShaderNodeVertexColor')
        vc.layer_name = 'Color'
        nt.links.new(vc.outputs['Color'], nt.nodes.get('Principled BSDF').inputs['Base Color'])
        me.materials.append(mat)
        ob = bpy.data.objects.new(name, me)
        sc.collection.objects.link(ob)
        return ob


kit = Kit()
wb = (yR - yF) / k             # wheelbase (m)
top = H(bhi.z)                 # roof / cage top (m)
nose, tail = (blo.y - yF) / k, (bhi.y - yF) / k   # body front / rear (m, along y from the front axle)
half = (bhi.x - blo.x) / 2 / k
# (no mud flaps: rubber sheets hanging behind the tyres read as black slabs at game distance — removed)
if NAME == 'pickup_truck':
    cab_y = wb * 0.36          # roll-cage front hoop over the cab
    cage = top_at(cab_y - 0.25, cab_y + 0.25)
    kit.box(P(0, cab_y, cage + 0.06), (1.12, 0.07, 0.09), BLACK)                      # LED light bar
    for i in range(10):
        kit.box(P(-0.5 + i * 0.111, cab_y - 0.036, cage + 0.06), (0.085, 0.006, 0.06), LENS)
    for s in (-1, 1):
        kit.box(P(s * 0.5, cab_y, cage + 0.02), (0.04, 0.05, 0.05), STEEL)            # brackets
    for s in (-1, 1):                                                                # bull-bar spotlights + mounts
        kit.lamp(P(s * 0.36, nose + 0.06, 0.98), 0.085)
        kit.tube(P(s * 0.36, nose + 0.1, 0.88), P(s * 0.36, nose + 0.1, 0.95), 0.015, STEEL, 6)
    kit.tube(P(-0.28, nose + 0.12, 0.5), P(0.28, nose + 0.12, 0.5), 0.07, BLACK, 12)  # winch drum
    kit.box(P(0, nose + 0.06, 0.5), (0.2, 0.06, 0.12), STEEL)                          # fairlead
    bed = H(W['RL'][0].z) + 0.47                                                      # bed floor (m)
    kit.spare(P(0.05, wb + 0.05, bed + 0.14), Vector((0, 0, 1)), 0.39, 0.26)         # spare lying in the bed
    kit.jerrycan(P(0.55, wb - 0.6, bed + 0.24), OLIVE)
    kit.jerrycan(P(0.55, wb - 0.22, bed + 0.24), RED)
    kit.box(P(-0.35, wb - 0.62, bed + 0.17), (0.75, 0.32, 0.34), ALU)                # toolbox
    sill = width_at(0.45, 0.75, 0.6, wb - 0.6)
    for s in (-1, 1):                                                                # rock sliders under the sills
        kit.tube(P(s * (sill - 0.05), 0.62, 0.47), P(s * (sill - 0.05), wb - 0.62, 0.47), 0.035, STEEL, 8)
        for y in (0.9, wb / 2, wb - 0.9):
            kit.tube(P(s * (sill - 0.05), y, 0.47), P(s * (sill - 0.25), y, 0.55), 0.02, STEEL, 6)
    fender = width_at(0.8, 1.0, -0.2, 0.45)
    a = P(-(fender + 0.04), 0.15, 0.85); b = P(-(fender + 0.04), 0.35, 1.1)           # snorkel (right): up the
    c = P(-(fender - 0.02), 0.72, 1.62)                                              # fender, along the A-pillar
    kit.tube(a, b, 0.05, BLACK, 10); kit.tube(b, c, 0.05, BLACK, 10)
    kit.box(c + Vector((0, -0.05 * k, 0.06 * k)), (0.13, 0.2, 0.11), BLACK)
    kit.box(P(0, tail + 0.05, 0.45), (0.12, 0.25, 0.08), STEEL)                      # tow hitch
elif NAME == 'mercedes_g500_4x4':
    kit.spare(P(0, tail + 0.16, 1.05), Vector((0, 1, 0)), 0.46, 0.33, cover=(0.06, 0.065, 0.07))
    kit.box(P(0, tail + 0.03, 1.05), (0.2, 0.05, 0.2), STEEL)
    rack_y = wb * 0.55
    top = top_at(rack_y - 0.9, rack_y + 0.9)
    for s in (-1, 1):
        kit.tube(P(s * 0.68, rack_y - 0.85, top + 0.07), P(s * 0.68, rack_y + 0.85, top + 0.07), 0.025, BLACK, 6)
    for i in range(5):
        y = rack_y - 0.85 + i * 0.425
        kit.tube(P(-0.68, y, top + 0.07), P(0.68, y, top + 0.07), 0.02, BLACK, 6)
    for s in (-1, 1):
        kit.box(P(s * 0.68, rack_y, top + 0.03), (0.05, 1.7, 0.07), BLACK)
        for t in (-0.8, -0.27, 0.27, 0.8):                                            # feet on the gutters
            kit.box(P(s * 0.7, rack_y + t, top - 0.06), (0.06, 0.08, 0.2), BLACK)
    kit.jerrycan(P(-0.45, rack_y + 0.45, top + 0.33), OLIVE, Matrix.Rotation(math.pi / 2, 3, 'Z'))
    kit.jerrycan(P(-0.45, rack_y + 0.05, top + 0.33), OLIVE, Matrix.Rotation(math.pi / 2, 3, 'Z'))
    kit.box(P(0.3, rack_y + 0.15, top + 0.22), (0.55, 0.8, 0.28), CANVAS)           # roof bag
elif NAME == 'zuk_a06':
    rack_y = wb * 0.55
    rl = 2.6
    top = top_at(rack_y - 1.2, rack_y + 1.2)
    half = width_at(top - 0.3, top, rack_y - 1, rack_y + 1)
    for s in (-1, 1):
        kit.box(P(s * (half - 0.12), rack_y, top + 0.06), (0.04, rl, 0.05), BLACK)
        for t in (-0.45, 0.0, 0.45):
            kit.tube(P(s * (half - 0.12), rack_y + t * rl, top), P(s * (half - 0.12), rack_y + t * rl, top + 0.06), 0.015, BLACK, 6)
    for i in range(6):
        kit.tube(P(-(half - 0.12), rack_y - rl / 2 + i * rl / 5, top + 0.09), P(half - 0.12, rack_y - rl / 2 + i * rl / 5, top + 0.09), 0.018, BLACK, 6)
    kit.box(P(0.05, rack_y - 0.45, top + 0.3), (1.1, 1.2, 0.4), CANVAS)               # tarp-covered load
    for s in (-1, 1):
        kit.tube(P(s * 0.4, rack_y - 1.05, top + 0.2), P(s * 0.4, rack_y + 0.15, top + 0.2), 0.02, BLACK, 6)  # straps
    kit.box(P(-0.25, rack_y + 0.65, top + 0.22), (0.5, 0.4, 0.26), WOOD)               # crates
    kit.box(P(0.3, rack_y + 0.7, top + 0.2), (0.45, 0.35, 0.22), WOOD)
    for s in (-1, 1):                                                                 # ladder up the back
        kit.tube(P(s * 0.2, tail + 0.03, 0.55), P(s * 0.2, tail + 0.03, top + 0.12), 0.015, ALU, 6)
    for i in range(6):
        z = 0.65 + i * (top - 0.6) / 6
        kit.tube(P(-0.2, tail + 0.03, z), P(0.2, tail + 0.03, z), 0.012, ALU, 6)
    kit.box(P(0, tail + 0.08, 0.38), (0.9, 0.16, 0.05), STEEL)                        # rear step
acc = kit.finish('acc_' + NAME.split('_')[0])

# ---- G500 budget: decimate the hidden underbody details ----
meshes = [o for o in sc.objects if o.type == 'MESH']
if tris(meshes) > 40000:
    for o in sorted([o for o in meshes if re.search('details', o.name) and not o.name.startswith(('wheel_', 'caliper_', 'acc_'))], key=lambda o: -len(o.data.polygons))[:1]:
        mod = o.modifiers.new('dec', 'DECIMATE'); mod.ratio = 0.7
        with bpy.context.temp_override(object=o, active_object=o):
            bpy.ops.object.modifier_apply(modifier=mod.name)

# ---- AO bake: body fresh, kit albedo × AO, wheels / brakes keep theirs (they still occlude) ----
scene = sc
scene.render.engine = 'CYCLES'; scene.cycles.samples = 48; scene.cycles.device = 'CPU'
if not scene.world:
    scene.world = bpy.data.worlds.new('ao_world')
scene.world.light_settings.distance = 0.9 * k
meshes = [o for o in sc.objects if o.type == 'MESH']


def is_glass(m):
    return m is None or m.blend_method == 'BLEND' or re.search('glas|wind', m.name, re.I)


glassy = [o for o in meshes if o.material_slots and all(is_glass(s.material) for s in o.material_slots)]
for o in glassy:
    o.hide_render = True
keep = [o for o in meshes if o.name.startswith(('wheel_', 'caliper_'))]
bake = [o for o in meshes if o not in glassy and o not in keep]
own = [acc]
for o in bake:
    attrs = o.data.color_attributes
    if o in own:
        a = attrs.new('AO', 'BYTE_COLOR', 'CORNER')
    else:
        for a in list(attrs):
            attrs.remove(a)
        a = attrs.new('Col', 'BYTE_COLOR', 'POINT')
    attrs.active_color = a
bpy.ops.object.select_all(action='DESELECT')
for o in bake:
    o.select_set(True)
bpy.context.view_layer.objects.active = bake[0]
bpy.ops.object.bake(type='AO', target='VERTEX_COLORS')
for o in own:
    attrs = o.data.color_attributes
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
# Re-imported parts (wheels, brakes) carry their colours as 'Color' but not as the ACTIVE attribute — the exporter
# writes only the active one: make sure every mesh has one set.
for o in meshes:
    attrs = o.data.color_attributes
    if len(attrs) and attrs.active_color is None:
        attrs.active_color = attrs[0]
    if len(attrs):
        attrs.render_color_index = attrs.active_color_index
mats = {s.material.name for o in meshes for s in o.material_slots if s.material}
path = OUT + NAME + '.lod0.glb'
bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_active_scene=True, export_extras=True,
                          export_cameras=False, export_lights=False, export_animations=False, export_yup=True,
                          export_vertex_color='ACTIVE')
print(json.dumps({'name': NAME, 'tris_before': before, 'tris_after': tris(meshes), 'kit_tris': tris([acc]),
                  'materials': len(mats), 'bytes': os.path.getsize(path), 'k': k, 'top_m': round(top, 2), 'wb_m': round(wb, 2)}))
