"""
VEHICLE PREP, step 7 (any car; skills/realistic-vehicle-system): TOW HOOKS front and rear.

Every car gets a recovery point at each end — the G500's front winch hook, made the standard:
  `tow_mount_<F|R>`  a fairlead plate bolted to the bumper (static: drawn and collided with the body), the rope's
                     exit slot in its middle;
  `hook_<F|R>`       a forged winch hook with its safety latch, hanging from the fairlead by its eye — a SEPARATE
                     part: the game takes it off the car (in a hand, onto a tree or another car's hook) with the rope
                     paying out of the fairlead. glTF extras (glTF space, model units, like the doors' `hinge`):
                     `eye` = where the rope ties on, `fairlead` = where the rope leaves the car.
The G500's own hook (modelled into its body) is cut out — its detachable hook hangs in the same place.
Low-poly (~250 tris a hook, ~70 a mount), vertex colours on the wheels' material (no extra material: the G500 is at
the 12-material budget), placed in METRES from the wheels like vehicle_details.py.

Headless (no MCP add-on needed):
  blender -b --python scripts/blender/vehicle_hooks.py -- NAME=carry_van SRC=src/assets/models/vehicles/ OUT=/tmp/hooks/
or through the add-on: node scripts/blender/bl.mjs scripts/blender/vehicle_hooks.py NAME=carry_van SRC=… OUT=…
Then copy OUT/<NAME>.lod0.glb to src/assets/models/vehicles/. Re-runs replace the hooks (the G500's cut stays cut).
"""
import bpy, bmesh, math, os, re, sys, json
from mathutils import Vector, Matrix

for a in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []):
    if '=' in a:
        globals()[a.split('=', 1)[0]] = a.split('=', 1)[1]
NAME = globals().get('NAME', 'carry_van')
SRC = globals().get('SRC', 'src/assets/models/vehicles/')
OUT = globals().get('OUT', '/tmp/hooks/')
os.makedirs(OUT, exist_ok=True)
METRES = {'mercedes_g500_4x4': 0.475, 'bmw_e30': 0.3, 'carry_van': 0.255}
# Per car and end: (x across, + = left; height above the ground) of the tow point, m — on the bumper's face (found
# below). The G500's front is where its own hook hung (right of the winch, under the bumper lip).
POINTS = {
    'mercedes_g500_4x4': {'F': (-0.152, 0.72), 'R': (0.0, 0.78)},
    'bmw_e30': {'F': (-0.25, 0.30), 'R': (0.30, 0.25)},      # (the E30's own tow eyes: front right, rear left)
    'carry_van': {'F': (0.0, 0.40), 'R': (0.0, 0.40)},
}
# The G500's modelled hook (metres in P()'s frame): its loose parts inside this box are deleted.
CUT = {'mercedes_g500_4x4': {'F': ((-0.18, -1.02, 0.62), (-0.12, -0.92, 0.73))}}

STEEL = (0.09, 0.09, 0.095)
BOLT = (0.45, 0.46, 0.48)
HOOK = (0.5, 0.06, 0.04)    # recovery-red forged steel: it reads at a glance where to grab
LATCH = (0.62, 0.62, 0.6)
SLOT = (0.012, 0.012, 0.014)

if bpy.app.background:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
else:
    sc = bpy.data.scenes.get('hook_' + NAME) or bpy.data.scenes.new('hook_' + NAME)
    for o in list(sc.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.context.window_manager.windows[0].scene = sc
bpy.ops.import_scene.gltf(filepath=os.path.join(SRC, NAME + '.lod0.glb'))
meshes = [o for o in sc.objects if o.type == 'MESH']


def tris(objs):
    return sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)


before = tris(meshes)
for o in [o for o in meshes if o.name.startswith(('hook_', 'tow_mount_'))]:  # re-runs replace them
    bpy.data.objects.remove(o, do_unlink=True)
meshes = [o for o in sc.objects if o.type == 'MESH']

# ---- frame of reference (vehicle_details.py): wheels, ground, metres ----
W = {}
for o in meshes:
    m = re.match(r'wheel_(FL|FR|RL|RR)', o.name)
    if m:
        pts = [o.matrix_world @ v.co for v in o.data.vertices]
        lo = Vector([min(p[i] for p in pts) for i in range(3)]); hi = Vector([max(p[i] for p in pts) for i in range(3)])
        W[m.group(1)] = ((lo + hi) / 2, (hi.z - lo.z) / 2)
R = W['FL'][1]
k = R / METRES[NAME]
z0 = W['FL'][0].z - R
xm = sum(w[0].x for w in W.values()) / 4
yF = W['FL'][0].y
side = 1 if W['FL'][0].x > xm else -1
WHEEL_MAT = next(s.material for o in meshes if o.name.startswith('wheel_') for s in o.material_slots if s.material)


def P(x, y, z):
    """Metres → model: x across (+ = left), y along (+ = toward the rear), z up; origin = centre line, front axle."""
    return Vector((xm + x * side * k, yF + y * k, z0 + z * k))


def local(p):
    return ((p.x - xm) * side / k, (p.y - yF) / k, (p.z - z0) / k)


def gl(v):  # Blender → glTF (Y up)
    return [v.x, v.z, -v.y]


# ---- the G500's own hook out ----
cut = 0
for end, (lo, hi) in CUT.get(NAME, {}).items():
    for o in [o for o in meshes if not o.name.startswith(('wheel_', 'caliper_'))]:
        bm = bmesh.new(); bm.from_mesh(o.data); bm.verts.ensure_lookup_table()
        seen, gone = set(), []
        for v in bm.verts:
            if v.index in seen:
                continue
            stack, isl = [v], []
            seen.add(v.index)
            while stack:
                a = stack.pop(); isl.append(a)
                for e in a.link_edges:
                    b = e.other_vert(a)
                    if b.index not in seen:
                        seen.add(b.index); stack.append(b)
            if all(lo[i] <= local(o.matrix_world @ q.co)[i] <= hi[i] for q in isl for i in range(3)):
                gone += isl
        if gone:
            cut += len(gone)
            bmesh.ops.delete(bm, geom=gone, context='VERTS')
            bm.to_mesh(o.data); o.data.update()
        bm.free()

# ---- where each tow point sits: the body's face at that height on that line ----
body = [o for o in meshes if not o.name.startswith(('wheel_', 'caliper_', 'door_', 'cab_', 'dial_', 'pedal_', 'gear_', 'wiper_', 'steering'))]
BM = [local(o.matrix_world @ v.co) for o in body for v in o.data.vertices]


WB = (W['RL'][0].y - yF) / k


DG = bpy.context.evaluated_depsgraph_get()
SKIP_HIT = ('wheel_', 'caliper_', 'hook_', 'tow_mount_')


def face_y(end, x, z):
    """The body's face (m along) at (x, z): a ray from outside that end, toward the car (vertices alone miss big
    flat panels — a tailgate can be one quad)."""
    out = -1 if end == 'F' else 1
    o = P(x, (WB / 2) + out * (WB / 2 + 4), z)
    d = Vector((0, -out * (1 if k > 0 else -1), 0)).normalized()
    for _ in range(8):
        hit, loc, _n, _i, ob, _m = sc.ray_cast(DG, o, d)
        if not hit:
            return None
        if not ob.name.startswith(SKIP_HIT):
            y = local(loc)[1]
            return y if (y < WB / 2) == (end == 'F') else None  # (through a gap to the far end: none here)
        o = loc + d * 0.01 * k
    return None


if globals().get('PROFILE'):
    for end in ('F', 'R'):
        print('PROFILE', NAME, end, ' '.join(f'{z:.2f}:{face_y(end, 0.0, z):.2f}' if face_y(end, 0.0, z) is not None else f'{z:.2f}:-' for z in [0.2 + 0.05 * i for i in range(17)]))
    raise SystemExit


class Kit:
    def __init__(self):
        self.bm = bmesh.new()
        self.cols = []

    def face(self, vs, col):
        try:
            self.cols.append((self.bm.faces.new(vs), col))
        except ValueError:
            pass

    def box(self, c, size, col, rot=None):
        """Box at c (model point), size in metres (x across, y along, z up)."""
        hx, hy, hz = (s * k / 2 for s in size)
        vs = []
        for dz in (-hz, hz):
            for dy in (-hy, hy):
                for dx in (-hx, hx):
                    d = Vector((dx, dy, dz))
                    vs.append(self.bm.verts.new(c + (rot @ d if rot else d)))
        for q in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
            self.face([vs[i] for i in q], col)

    def sweep(self, path, r, col, seg=6, closed=False):
        """A tube of radius r (m) along a list of model points (a ring per point, each square to the path)."""
        rings = []
        n = len(path)
        for i, p in enumerate(path):
            a = path[(i - 1) % n] if closed or i > 0 else p
            b = path[(i + 1) % n] if closed or i < n - 1 else p
            t = (b - a).normalized()
            u = t.orthogonal().normalized(); v = t.cross(u)
            rings.append([self.bm.verts.new(p + (u * math.cos(2 * math.pi * j / seg) + v * math.sin(2 * math.pi * j / seg)) * r * k) for j in range(seg)])
        for i in range(n if closed else n - 1):
            ra, rb = rings[i], rings[(i + 1) % n]
            for j in range(seg):
                jj = (j + 1) % seg
                self.face((ra[j], ra[jj], rb[jj], rb[j]), col)
        if not closed:
            self.face(list(reversed(rings[0])), col)
            self.face(rings[-1], col)

    def finish(self, name, extras=None):
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        # 'Color' — the name the shared wheel material's colour node reads after a glTF re-import.
        col = me.color_attributes.new('Color', 'BYTE_COLOR', 'CORNER')
        for poly, (f, rgb) in zip(me.polygons, self.cols):
            for li in poly.loop_indices:
                col.data[li].color = (*rgb, 1.0)
        me.materials.append(WHEEL_MAT)
        ob = bpy.data.objects.new(name, me)
        sc.collection.objects.link(ob)
        for key, val in (extras or {}).items():
            ob[key] = val
        return ob


report = {}
made = []
FACES = {end: face_y(end, x, z) for end, (x, z) in POINTS[NAME].items()}
for end, (x, z) in POINTS[NAME].items():
    yb = FACES[end]
    if yb is None:
        raise RuntimeError(f'{NAME} {end}: no body at x {x} z {z}')
    out = -1 if end == 'F' else 1                      # away from the car, along y
    # FAIRLEAD PLATE on the bumper face: 22 × 8 cm, 2.5 cm proud, a dark slot, 4 bolts.
    mount = Kit()
    face = P(x, yb + out * 0.0125, z)
    mount.box(face, (0.22, 0.025, 0.08), STEEL)
    mount.box(P(x, yb + out * 0.026, z), (0.13, 0.004, 0.022), SLOT)
    for bx in (-0.085, 0.085):
        for bz in (-0.025, 0.025):
            mount.box(P(x + bx, yb + out * 0.027, z + bz), (0.014, 0.005, 0.014), BOLT)
    made.append(mount.finish('tow_mount_' + end))
    # THE HOOK, hanging from the fairlead slot: eye ring (in the plane across the car's length) → shank → J-bowl
    # opening toward the car, its latch closing it. Built in metres in the hook's own frame (a: along, out of the car;
    # c: up), the eye ring's top at the slot.
    lead = P(x, yb + out * 0.03, z)                    # where the rope leaves the car
    eye = P(x, yb + out * 0.045, z - 0.03)             # the eye's centre: where the rope ties on
    hk = Kit()

    def H(a, c):
        return eye + Vector((0, out * a * k, c * k))
    ring = [H(0.026 * math.sin(2 * math.pi * i / 10), 0.026 * math.cos(2 * math.pi * i / 10)) for i in range(10)]
    hk.sweep(ring, 0.008, HOOK, 5, closed=True)
    hk.sweep([H(0, -0.026), H(0, -0.06)], 0.011, HOOK, 6)                  # shank
    bowl = [H(-0.032 + 0.032 * math.cos(t), -0.088 + 0.032 * math.sin(t)) for t in (math.radians(d) for d in range(0, -220, -30))]
    bowl = [H(0, -0.06)] + bowl                                             # down the shank into the curve
    hk.sweep(bowl, 0.01, HOOK, 6)
    tip = bowl[-1]
    hk.sweep([tip, tip + Vector((0, 0, 0.012 * k))], 0.007, HOOK, 5)      # the point
    hk.box((tip + H(0, -0.055)) / 2 + Vector((0, 0, 0.004 * k)), (0.004, 0.006, 0.034), LATCH,
           Matrix.Rotation(math.atan2(-out * 0.032, 0.03), 3, 'X'))       # safety latch, tip → shank
    made.append(hk.finish('hook_' + end, {'eye': gl(eye), 'fairlead': gl(lead)}))
    report[end] = {'at_m': [round(x, 3), round(yb, 3), round(z, 3)]}

meshes = [o for o in sc.objects if o.type == 'MESH']
# (the glTF round trip can split a material — the G500's `glass` came back as `glass` + `glass.001`, one over the
#  12-material budget): a suffixed copy whose base is on the car folds back into it
used = {s_.material.name: s_.material for o in meshes for s_ in o.material_slots if s_.material}
for o in meshes:
    for s_ in o.material_slots:
        mm = re.match(r'^(.*)\.\d{3}$', s_.material.name) if s_.material else None
        if mm and mm.group(1) in used:
            s_.material = used[mm.group(1)]
path = os.path.join(OUT, NAME + '.lod0.glb')
bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_active_scene=True, export_extras=True,
                          export_cameras=False, export_lights=False, export_animations=False, export_yup=True,
                          export_vertex_color='ACTIVE')
mats = {s.material.name for o in meshes for s in o.material_slots if s.material}
print(json.dumps({'name': NAME, 'tris_before': before, 'tris_after': tris(meshes), 'hooks_tris': tris(made), 'cut_verts': cut,
                  'materials': len(mats), 'bytes': os.path.getsize(path), 'k': k, 'points': report}))
