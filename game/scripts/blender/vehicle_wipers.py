"""
VEHICLE PREP, step 8 (any car; skills/realistic-vehicle-system): WORKING WINDSCREEN WIPERS (2026-10-24, the user: "the
wiper must be an actual part of the car — use real wipers of the cars, add a real wiper to all cars in Blender").

Two tandem wipers per car, modelled to its own windscreen (found from the glass: the forward-facing panes):
  `wiper_L` / `wiper_R`  pivot cap + nut on the cowl, the arm's spring housing, the tapering arm down to its J-hook,
                         the blade (metal frame, yokes and end caps, the rubber squeegee lying on the glass) — parked
                         along the windscreen's lower edge toward the passenger side. glTF extras (glTF space, model
                         units, like the cockpit's pedals): `pivot` = the spindle, `axis` = the spindle's axis (the
                         glass normal). The game sweeps them about it (Cockpit) and wipes the glass under the blade.
Sizes from the windscreen: arm length L = min(0.3 × its width, 0.6 × its slant height); blade 0.9 L, centred on the arm
tip (it sweeps the band L ± 0.45 L). ~300 tris a wiper, vertex colours on the wheels' material (no extra material).
Any `wiper_*` already in the model (the G500's first ones) is replaced.

Headless:
  blender -b --factory-startup --python scripts/blender/vehicle_wipers.py -- NAME=carry_van SRC=src/assets/models/vehicles/ OUT=<dir>
Then copy OUT/<NAME>.lod0.glb to src/assets/models/vehicles/.
"""
import bpy, bmesh, math, os, re, sys, json
from mathutils import Vector

for a in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []):
    if '=' in a:
        globals()[a.split('=', 1)[0]] = a.split('=', 1)[1]
NAME = globals().get('NAME', 'carry_van')
SRC = globals().get('SRC', 'src/assets/models/vehicles/')
OUT = globals().get('OUT', '/tmp/wipers/')
os.makedirs(OUT, exist_ok=True)
METRES = {'mercedes_g500_4x4': 0.475, 'bmw_e30': 0.3, 'carry_van': 0.255}

BLACK = (0.022, 0.022, 0.024)    # satin black steel
RUBBER = (0.008, 0.008, 0.009)
NUT = (0.3, 0.3, 0.31)

if bpy.app.background:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
else:
    sc = bpy.data.scenes.get('wiper_' + NAME) or bpy.data.scenes.new('wiper_' + NAME)
    for o in list(sc.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.context.window_manager.windows[0].scene = sc
bpy.ops.import_scene.gltf(filepath=os.path.join(SRC, NAME + '.lod0.glb'))
for o in [o for o in sc.objects if o.type == 'MESH' and o.name.startswith('wiper_')]:   # re-runs replace them
    bpy.data.objects.remove(o, do_unlink=True)
meshes = [o for o in sc.objects if o.type == 'MESH']


def tris(objs):
    return sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)


before = tris(meshes)
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
yF, yR = W['FL'][0].y, W['RL'][0].y
side = 1 if W['FL'][0].x > xm else -1      # +x (this frame) = the car's left
fwd_y = -1 if yF < yR else 1               # the model's y toward the front
WHEEL_MAT = next(s.material for o in meshes if o.name.startswith('wheel_') for s in o.material_slots if s.material)


def local(p):
    """Model → metres: x across (+ = left), y along (+ = toward the rear), z up; origin = centre line, front axle."""
    return Vector(((p.x - xm) * side / k, (p.y - yF) / k * -fwd_y, (p.z - z0) / k))


def to_model(v):
    return Vector((xm + v.x * side * k, yF - v.y * k * fwd_y, z0 + v.z * k))


def dir_model(v):
    return Vector((v.x * side, -v.y * fwd_y, v.z)).normalized()


def gl(v):  # Blender → glTF (Y up)
    return [v.x, v.z, -v.y]


def is_glass(m):
    return m is not None and (m.blend_method == 'BLEND' or getattr(m, 'surface_render_method', '') == 'BLENDED' or re.search('glas|wind', m.name, re.I)) \
        and not re.search('light|lamp|glow', m.name, re.I)


# ---- the windscreen: glass faces facing forward and up (local −y, +z), above the beltline (> 55 % of the car's
#      height: not the headlamp lenses, which share the glass material on some models), the front-most band of them
WB = local(W['RL'][0]).y                           # (the front half of the car: not the rear window)
roof = max(local(o.matrix_world @ v.co).z for o in meshes if not o.name.startswith(('wheel_', 'hook_', 'tow_')) for v in o.data.vertices)
cand = []
for o in meshes:
    if o.name.startswith(('door_', 'wheel_')):
        continue
    for poly in o.data.polygons:
        mat = o.material_slots[poly.material_index].material if o.material_slots else None
        if not is_glass(mat):
            continue
        vs = [local(o.matrix_world @ o.data.vertices[i].co) for i in poly.vertices]
        c = sum(vs, Vector()) / len(vs)
        n = (vs[1] - vs[0]).cross(vs[2] - vs[0])
        if n.length < 1e-9:
            continue
        a_ = n.length / 2
        n.normalize()
        if n.y > 0:
            n = -n                                  # (either winding: the outward side faces forward)
        if n.y > -0.35 or abs(n.z) > 0.95 or abs(c.x) > 0.95 or c.z < 0.55 * roof or c.y > 0.6 * WB:
            continue
        cand.append((c, n, a_, vs))
if not cand:
    raise RuntimeError(f'{NAME}: no windscreen glass found')
# the windscreen = the forward-facing glass with the most area (0.3 m bins along the car): not a lamp lens, not a
# small quarter light
bins = {}
for c, n, a_, vs in cand:
    bins[round(c.y / 0.3)] = bins.get(round(c.y / 0.3), 0.0) + a_
yb = max(bins, key=bins.get) * 0.3
sel = [t for t in cand if abs(t[0].y - yb) < 0.45]
ws = [p for t in sel for p in t[3]]
N = sum((t[1] * t[2] for t in sel), Vector()).normalized()
report0 = {'roof': round(roof, 3)}
if N.z < 0:
    N = -N if N.y > 0 else N
X0, X1 = min(p.x for p in ws), max(p.x for p in ws)
Wd = X1 - X0
U = Vector((-1, 0, 0))                              # parked toward the passenger side (−x: the right, a left-hand drive)
U = (U - N * U.dot(N)).normalized()
V = N.cross(U)
if V.z < 0:
    V = -V                                          # up the glass
hs = [p.dot(V) for p in ws]
Hs = max(hs) - min(hs)


def bottom_at(x):
    """The windscreen's lowest glass point near x (its lower edge)."""
    near = [p for p in ws if abs(p.x - x) < 0.12] or ws
    return min(near, key=lambda p: p.z)


# ---- the model's own STATIC wipers (modelled into the body: arms and blades lying on the glass) go — the working ones
#      replace them. Separate parts only (connected once the import's seam-split vertices are welded), long and thin
#      like an arm or a blade piece (15–50 cm), lying on the windscreen (0–5 cm off its plane, never behind it: the cowl),
#      over its lowest 30 cm (as
#      vehicle_cabin.py did for the G500's — not repeated on it).
PD = sum(p.dot(N) for p in ws) / len(ws)
vb = min(p.dot(V) for p in ws)
removed = []
from mathutils import kdtree
for o in [o for o in sc.objects if o.type == 'MESH' and NAME != 'mercedes_g500_4x4' and not o.name.startswith(('wheel_', 'caliper_', 'door_', 'cab_', 'dial_', 'pedal_', 'gear_', 'steering', 'hook_', 'tow_'))]:
    if any(is_glass(s_.material) for s_ in o.material_slots) and len(o.material_slots) == 1:
        continue
    # (the glTF import splits every vertex at its UV / normal seams: weld a COPY by position to find the real parts)
    wb = bmesh.new(); wb.from_mesh(o.data)
    bmesh.ops.remove_doubles(wb, verts=wb.verts, dist=1e-4 * k)
    wb.verts.ensure_lookup_table(); wb.faces.ensure_lookup_table()
    seen, hits = set(), []
    for v0 in wb.verts:
        if v0.index in seen:
            continue
        stack, comp = [v0], []
        seen.add(v0.index)
        while stack:
            a_ = stack.pop(); comp.append(a_)
            for e_ in a_.link_edges:
                b_ = e_.other_vert(a_)
                if b_.index not in seen:
                    seen.add(b_.index); stack.append(b_)
        if len(comp) > 600:
            continue
        q = [local(o.matrix_world @ a_.co) for a_ in comp]
        lo = Vector([min(p[i] for p in q) for i in range(3)]); hi = Vector([max(p[i] for p in q) for i in range(3)])
        dims = sorted(hi - lo)
        if not (0.15 < dims[2] < 0.5 and dims[1] < 0.15) or lo.x < X0 - 0.05 or hi.x > X1 + 0.05:
            continue                                   # (an arm or a blade piece: 15–50 cm — not the cowl trim across)
        off = [p.dot(N) - PD for p in q]; up = [p.dot(V) - vb for p in q]
        if min(off) > -0.015 and max(off) < 0.05 and min(up) > -0.08 and max(up) < 0.3:   # (on the glass, not the cowl behind it)
            ids = {a_.index for a_ in comp}
            hits += [f.calc_center_median() for f in wb.faces if all(v.index in ids for v in f.verts)]
            removed.append({'obj': o.name[:30], 'verts': len(comp), 'size': [round(v, 2) for v in hi - lo]})
    wb.free()
    if hits:
        kd = kdtree.KDTree(len(hits))
        for i, c in enumerate(hits):
            kd.insert(c, i)
        kd.balance()
        bm = bmesh.new(); bm.from_mesh(o.data)
        gone = [f for f in bm.faces if kd.find(f.calc_center_median())[2] < 1e-4 * k]
        bmesh.ops.delete(bm, geom=gone, context='FACES'); bm.to_mesh(o.data); o.data.update(); bm.free()
print('STATIC WIPER PARTS REMOVED', json.dumps(removed))

L = min(0.3 * Wd, 0.6 * Hs)
B = 0.9 * L
report = {**report0, 'width': round(Wd, 3), 'slant': round(Hs, 3), 'normal': [round(v, 3) for v in N], 'arm': round(L, 3)}


class Kit:
    def __init__(self, a):
        self.bm = bmesh.new(); self.cols = []; self.a = a

    def M(self, s, t, h):
        """The wiper's frame (m): s along the parked arm, t up the glass, h off it (the glass normal)."""
        return to_model(self.a + U * s + V * t + N * h)

    def face(self, vs, col):
        try:
            self.cols.append((self.bm.faces.new(vs), col))
        except ValueError:
            pass

    def box(self, s0, s1, w0, w1, h0, h1, col, t=0.0, taper_h=None):
        """A bar from s0 to s1 (m) along the arm: widths w0 → w1 across (t), from h0 to h1 off the glass."""
        vs = []
        for s, w in ((s0, w0), (s1, w1)):
            hh1 = h1 if taper_h is None or s == s0 else taper_h
            for h in (h0, hh1):
                for d in (-w / 2, w / 2):
                    vs.append(self.bm.verts.new(self.M(s, t + d, h)))
        q = ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3))
        for f in q:
            self.face([vs[i] for i in f], col)

    def cyl(self, r, h0, h1, col, seg=12, s=0.0, t=0.0):
        """A cylinder about the spindle (the glass normal), radius r (m), from h0 to h1."""
        ring0 = [self.bm.verts.new(self.M(s + r * math.cos(2 * math.pi * i / seg), t + r * math.sin(2 * math.pi * i / seg), h0)) for i in range(seg)]
        ring1 = [self.bm.verts.new(self.M(s + r * math.cos(2 * math.pi * i / seg), t + r * math.sin(2 * math.pi * i / seg), h1)) for i in range(seg)]
        for i in range(seg):
            j = (i + 1) % seg
            self.face((ring0[i], ring0[j], ring1[j], ring1[i]), col)
        self.face(list(reversed(ring0)), col); self.face(ring1, col)

    def finish(self, name, extras):
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me); self.bm.free()
        col = me.color_attributes.new('Color', 'BYTE_COLOR', 'CORNER')
        for poly, (f, rgb) in zip(me.polygons, self.cols):
            for li in poly.loop_indices:
                col.data[li].color = (*rgb, 1.0)
        me.materials.append(WHEEL_MAT)
        ob = bpy.data.objects.new(name, me)
        sc.collection.objects.link(ob)
        for key, val in extras.items():
            ob[key] = val
        return ob


made = []
# tandem: the driver's pivot near the left edge, the passenger's just right of the centre (both park toward the right)
for nm, fx, lk in (('wiper_L', X1 - 0.14 * Wd, 1.0), ('wiper_R', X0 + 0.46 * Wd, 0.88)):
    e = bottom_at(fx)
    a = Vector((fx, e.y, e.z)) - V * 0.05 + N * 0.005          # on the cowl, 5 cm below the glass edge
    la, bl = L * lk, B * lk
    w = Kit(a)
    w.cyl(0.024, -0.01, 0.018, BLACK, 14)                      # pivot cap (the spindle's housing on the cowl)
    w.cyl(0.009, 0.018, 0.03, NUT, 8)                          # the spindle nut
    w.box(0.0, 0.11, 0.034, 0.024, 0.012, 0.04, BLACK, taper_h=0.03)   # spring housing (the arm's head)
    w.box(0.11, la - 0.03, 0.016, 0.01, 0.014, 0.026, BLACK, taper_h=0.018)   # the arm, tapering toward the tip
    w.box(la - 0.035, la + 0.012, 0.012, 0.012, 0.008, 0.02, BLACK)    # the J-hook / blade adapter
    # the blade: centred on the arm tip — a metal frame on two yokes, end caps, the rubber squeegee on the glass
    s0, s1 = la - bl / 2, la + bl / 2
    w.box(s0 + 0.02, s1 - 0.02, 0.01, 0.01, 0.012, 0.018, BLACK)     # frame (spine)
    for sy in (s0 + bl * 0.22, s0 + bl * 0.5, s0 + bl * 0.78):         # yokes / claws down to the rubber
        w.box(sy - 0.01, sy + 0.01, 0.009, 0.009, 0.004, 0.014, BLACK)
    w.box(s0, s0 + 0.02, 0.009, 0.006, 0.002, 0.014, BLACK)          # end caps
    w.box(s1 - 0.02, s1, 0.006, 0.009, 0.002, 0.014, BLACK)
    w.box(s0 + 0.004, s1 - 0.004, 0.007, 0.002, 0.0005, 0.005, RUBBER)   # squeegee (a thin wedge on the glass)
    made.append(w.finish(nm, {'pivot': gl(to_model(a)), 'axis': gl(dir_model(N))}))
    report[nm] = {'pivot_m': [round(v, 3) for v in a], 'arm': round(la, 3), 'blade': round(bl, 3)}

meshes = [o for o in sc.objects if o.type == 'MESH']
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
print(json.dumps({'name': NAME, 'tris_before': before, 'tris_after': tris(meshes), 'wiper_tris': tris(made), 'bytes': os.path.getsize(path), **report}))
