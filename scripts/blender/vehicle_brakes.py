"""
VEHICLE PREP, step 3 (any car; skills/realistic-vehicle-system §8.2): BRAKE HARDWARE behind each wheel, named to
the standard — `caliper_<FL|FR|RL|RR>` holds that corner's disc + hat + caliper (disc brakes) or drum + backing
plate (drum brakes). The game hangs them on the hub: they steer and ride with the suspension but never spin (a
plain disc or drum looks the same turning or not), so they are drawn on the car's program with no spin.

Calipers sit at 12 o'clock — symmetric, so the right side is the left one turned 180° (the game's wheel
convention, one geometry per axle). Colours are vertex colours on ONE material `brake_hw` (the loader keeps
vertex colours on `caliper_*` parts). Wheels are found by name (`wheel…FL`) or, for models whose wheels are part of
the body, as the round loose parts touching the ground (the same rule as assets/loadModels.ts).

Budget work on the way (vehicles lod0 ≤ 40 k tris, ≤ 12 materials): the model's own caliper stubs are replaced,
near-black materials are merged, and a PLANAR decimate (dissolves only coplanar faces — no visible change) runs on
parts over the triangle budget.

Run (Blender with the MCP add-on server on :9876):
  node scripts/blender/bl.mjs scripts/blender/vehicle_brakes.py NAME=pickup_truck OUT=C:/tmp/brakes/
Then copy OUT/<NAME>.lod0.glb to src/assets/models/vehicles/ and run `npm run validate:assets`.
"""
import bpy, bmesh, math, os, json, re
from mathutils import Vector

SRC = 'C:/Project/Dark/src/assets/models/vehicles/'
CARS = {
    # rim = rim radius / tyre radius (31x10.50R15: 15/31; 325/55R22: 22/36.1; 6.50-16: 16/28.8)
    'pickup_truck': {'front': 'disc', 'rear': 'drum', 'rim': 0.484, 'caliper': (0.11, 0.11, 0.12)},
    'mercedes_g500_4x4': {'front': 'disc', 'rear': 'disc', 'rim': 0.61, 'caliper': (0.55, 0.04, 0.03),
                          'merge': {'Carbon.012': 'Under.012', 'CP_Plastic.012': 'Under.012'},
                          'drop': 'caliper_', 'planar': 0.0087},
    'zuk_a06': {'front': 'drum', 'rear': 'drum', 'rim': 0.556},
}
NAME = globals().get('NAME', 'pickup_truck')
OUT = globals().get('OUT', 'C:/tmp/brakes/')
cfg = CARS[NAME]
os.makedirs(OUT, exist_ok=True)

DISC = (0.42, 0.42, 0.44)
HAT = (0.16, 0.16, 0.17)
DRUM = (0.13, 0.13, 0.14)
PLATE = (0.06, 0.06, 0.065)

# ---- fresh scene with the shipped model ----
sc_name = 'brakes_' + NAME
old = bpy.data.scenes.get(sc_name)
if old:
    for o in list(old.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    sc = old
else:
    sc = bpy.data.scenes.new(sc_name)
bpy.context.window_manager.windows[0].scene = sc
bpy.ops.import_scene.gltf(filepath=SRC + NAME + '.lod0.glb')
meshes = [o for o in sc.objects if o.type == 'MESH']


def tris(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    t = 0
    for o in objs:
        me = o.evaluated_get(dg).to_mesh()
        t += sum(len(p.vertices) - 2 for p in me.polygons)
        o.evaluated_get(dg).to_mesh_clear()
    return t


before = tris(meshes)

# ---- the model's own caliper stubs out (replaced by full hardware below) ----
if cfg.get('drop'):
    for o in [o for o in meshes if cfg['drop'] in o.name.lower() and not o.name.startswith('caliper_')]:
        bpy.data.objects.remove(o, do_unlink=True)
    meshes = [o for o in sc.objects if o.type == 'MESH']

# ---- wheels: by name, else round loose parts on the ground ----
allv = [o.matrix_world @ v.co for o in meshes for v in o.data.vertices]
zmin = min(p.z for p in allv); zmax = max(p.z for p in allv); H = zmax - zmin
wheels = []  # (centre Vector, radius, width)
named = {}
for o in meshes:
    n = o.name.lower()
    for key in ('fl', 'fr', 'bl', 'br', 'rl', 'rr'):
        if ('wheel' + key) in n.replace('_', ''):
            named.setdefault(key, []).extend(o.matrix_world @ v.co for v in o.data.vertices)
if len(named) == 4:
    for pts in named.values():
        lo = Vector([min(p[i] for p in pts) for i in range(3)]); hi = Vector([max(p[i] for p in pts) for i in range(3)])
        wheels.append(((lo + hi) / 2, (hi.z - lo.z) / 2, hi.x - lo.x))
else:
    for o in meshes:
        if o.name.startswith('door_'):
            continue
        bm = bmesh.new(); bm.from_mesh(o.data)
        bm.verts.ensure_lookup_table()
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
                wheels.append(((lo + hi) / 2, s.z / 2, s.x, lo, hi))
        bm.free()
    # A wheel is often several loose parts (tyre, rim, hub — unwelded): one wheel per cluster of centres.
    groups = []
    for wh in wheels:
        g = next((g for g in groups if (g[0][0] - wh[0]).length < 0.6 * wh[1]), None)
        if g:
            g.append(wh)
        else:
            groups.append([wh])
    wheels = []
    for g in groups:
        lo = Vector([min(x[3][i] for x in g) for i in range(3)]); hi = Vector([max(x[4][i] for x in g) for i in range(3)])
        wheels.append(((lo + hi) / 2, (hi.z - lo.z) / 2, hi.x - lo.x))
if len(wheels) != 4:
    raise RuntimeError(f'{NAME}: found {len(wheels)} wheels')
ys = sorted(w[0].y for w in wheels)
ymid = (ys[1] + ys[2]) / 2
xmid = sum(w[0].x for w in wheels) / 4  # models aren't always centred on x = 0


def corner(c):
    # Blender: +x = the car's left (glTF +z forward → game −Z after the loader's turn), −y = front.
    return ('F' if c.y < ymid else 'R') + ('L' if c.x > xmid else 'R')


# ---- material: one, vertex-coloured ----
mat = bpy.data.materials.get('brake_hw') or bpy.data.materials.new('brake_hw')
mat.use_nodes = True
nt = mat.node_tree
bsdf = nt.nodes.get('Principled BSDF')
attr = next((n for n in nt.nodes if n.type == 'VERTEX_COLOR'), None) or nt.nodes.new('ShaderNodeVertexColor')
attr.layer_name = 'Col'
nt.links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])
bsdf.inputs['Roughness'].default_value = 0.6


def ring_band(bm, col, items, c, ax, r0, r1, x0, x1, a0=0.0, a1=2 * math.pi, seg=24, caps=True):
    """A tube segment about the X axis: radius r0..r1 (r0 = 0 → solid), x0..x1, angles a0..a1 (0 = up, toward −y)."""
    full = abs(a1 - a0 - 2 * math.pi) < 1e-6
    n = seg if full else max(2, seg)
    def P(r, x, a):
        return bm.verts.new(c + Vector((x, -math.sin(a) * r, math.cos(a) * r)))
    rings = []
    for (r, x) in ((r1, x0), (r1, x1), (r0, x1), (r0, x0)):
        rings.append([P(r, x, a0 + (a1 - a0) * k / (n if full else n - 1)) for k in range(n if full else n)])
    m = len(rings[0])
    for q in range(4):
        A, B = rings[q], rings[(q + 1) % 4]
        if r0 <= 0 and q in (1, 3):
            continue  # solid disc: no inner wall
        for k in range(m if full else m - 1):
            k2 = (k + 1) % m
            items.append((bm.faces.new((A[k], A[k2], B[k2], B[k])), col))
    if r0 <= 0:
        # faces across the solid disc
        for X in (rings[1], rings[0]):
            if full:
                items.append((bm.faces.new(X if X is rings[1] else list(reversed(X))), col))
    if not full and caps:
        for idx in (0, m - 1):
            q = [rings[j][idx] for j in range(4)]
            items.append((bm.faces.new(q if idx == 0 else list(reversed(q))), col))


report = {}
for (c, r, w) in wheels:
    cn = corner(c)
    kind = cfg['front'] if cn[0] == 'F' else cfg['rear']
    s_in = -1.0 if c.x > xmid else 1.0        # toward the car's centre line
    rim = cfg['rim'] * r
    bm = bmesh.new()
    items = []
    if kind == 'disc':
        Rd = 0.8 * rim
        xd = s_in * 0.2 * w                    # disc plane, inboard of the rim's mounting face
        t = 0.05 * r
        ring_band(bm, DISC, items, c, 0, 0.42 * Rd, Rd, xd - t / 2, xd + t / 2)
        ring_band(bm, HAT, items, c, 0, 0.0, 0.42 * Rd, xd - s_in * 0.08 * r, xd + t / 2, seg=16)
        cal = cfg.get('caliper', (0.15, 0.15, 0.16))
        ring_band(bm, cal, items, c, 0, 0.62 * Rd, 1.08 * Rd, xd - 0.09 * r, xd + 0.09 * r, -0.42, 0.42, seg=6)
    else:
        Rr = 0.8 * rim
        x_out, x_in = -s_in * 0.06 * w, s_in * 0.26 * w
        ring_band(bm, DRUM, items, c, 0, 0.0, Rr, min(x_out, x_in), max(x_out, x_in), seg=20)
        ring_band(bm, PLATE, items, c, 0, 0.3 * Rr, 1.06 * Rr, x_in, x_in + s_in * 0.02 * w, seg=20)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new('caliper_' + cn)
    bm.to_mesh(me)
    bm.free()
    col = me.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
    for poly, (f, rgb) in zip(me.polygons, items):
        for li in poly.loop_indices:
            col.data[li].color = (*rgb, 1.0)
    me.materials.append(mat)
    ob = bpy.data.objects.new('caliper_' + cn, me)
    sc.collection.objects.link(ob)
    report[cn] = {'kind': kind, 'centre': [round(v, 4) for v in c], 'r': round(r, 4), 'w': round(w, 4), 'tris': sum(len(p.vertices) - 2 for p in me.polygons)}

# ---- materials: merge near-black duplicates ----
def base(n):  # 'Carbon.012' / 'Carbon.013' (Blender renumbers on re-import) → 'Carbon'
    return re.sub(r'(\.\d{3})+$', '', n)


for src, dst in cfg.get('merge', {}).items():
    m_dst = next((s.material for o in sc.objects for s in o.material_slots if s.material and base(s.material.name) == base(dst)), None)
    if not m_dst:
        continue
    for o in sc.objects:
        for s in o.material_slots:
            if s.material and base(s.material.name) == base(src):
                s.material = m_dst

# ---- planar decimate on the heaviest parts until within budget ----
meshes = [o for o in sc.objects if o.type == 'MESH']
if cfg.get('planar') and tris(meshes) > 40000:
    for o in sorted(meshes, key=lambda o: -len(o.data.polygons))[:3]:
        if o.name.startswith(('caliper_', 'door_', 'steering')):
            continue
        mod = o.modifiers.new('planar', 'DECIMATE')
        mod.decimate_type = 'DISSOLVE'
        mod.angle_limit = cfg['planar']
        mod.delimit = {'MATERIAL', 'UV', 'SEAM', 'SHARP'}
        bpy.context.view_layer.objects.active = o
        with bpy.context.temp_override(object=o, active_object=o):
            bpy.ops.object.modifier_apply(modifier=mod.name)
        bm = bmesh.new(); bm.from_mesh(o.data); bmesh.ops.triangulate(bm, faces=bm.faces); bm.to_mesh(o.data); bm.free()
        if tris(meshes) <= 40000:
            break

meshes = [o for o in sc.objects if o.type == 'MESH']
mats = {s.material.name for o in meshes for s in o.material_slots if s.material}
path = OUT + NAME + '.lod0.glb'
bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_active_scene=True, export_extras=True,
                          export_cameras=False, export_lights=False, export_animations=False, export_yup=True)
print(json.dumps({'name': NAME, 'tris_before': before, 'tris_after': tris(meshes), 'materials': len(mats),
                  'bytes': os.path.getsize(path), 'brakes': report}))
