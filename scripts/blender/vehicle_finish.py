"""
VEHICLE PREP, step 2 of 2 (after vehicle_doors.py, same Blender session): the G500's steering wheel split out as
`steering_wheel`, a low-poly Żuk cabin (inward-facing liner, bench, dash, steering wheel — ~150 tris), each door's
hinge stored as a glTF extra (`hinge`, glTF space), only the base-colour texture kept (≤ 1024²; normal / roughness /
emissive maps dropped — the game bakes them away), exported to OUT as <name>.lod0.glb. Copy the results to
src/assets/models/vehicles/: loadModels `bakeVehicle` reads `door_*`, `steering_wheel` and `*inner*` / `*interior*`.
"""
import bpy, bmesh, math
from mathutils import Vector, Matrix

OUT = 'C:/path/to/out/'
import os
os.makedirs(OUT, exist_ok=True)
win = bpy.context.window_manager.windows[0]
K = {'pickup_truck': 0.8543265, 'mercedes_g500_4x4': 105.87297, 'zuk_a06': 3.2800702}
report = {}


def gl(v):  # Blender → glTF (Y up)
    return [v.x, v.z, -v.y]


def flat_mat(name, rgb):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = 0.9
    return m


def door_hinge(sc, o, k):
    """Hinge = front edge (−Y) of the door's outward skin, at the skin's depth."""
    side = 1 if '_FL' in o.name else -1
    me = o.data
    sk = [p for p in me.polygons if p.normal.x * side > 0.7]
    xs = sorted(side * p.center.x for p in sk)
    skin = xs[int(len(xs) * 0.7)] * side
    ys = sorted(min((me.vertices[i].co.y for i in p.vertices)) for p in sk)
    yf = ys[max(0, int(len(ys) * 0.01))]
    zs = [v.co.z for v in me.vertices]
    return Vector((skin, yf, (min(zs) + max(zs)) / 2))


def reset_doors(sc):
    for o in sc.objects:
        if o.name.startswith('door_') and (o.location.length > 0 or o.rotation_euler.z != 0):
            o.data.transform(Matrix.Translation(o.location))
            o.location = (0, 0, 0); o.rotation_euler = (0, 0, 0)
        o.hide_render = False


def separate_parts(sc, name, centre, radius):
    """Move every loose part whose bounds lie within `radius` of `centre` into a new object `name`."""
    bmo = bmesh.new()
    mats = []
    for o in [o for o in sc.objects if o.type == 'MESH' and not o.name.startswith('door_')]:
        bm = bmesh.new(); bm.from_mesh(o.data)
        seen = set(); take = []
        for f0 in bm.faces:
            if f0 in seen: continue
            stack = [f0]; comp = [f0]; seen.add(f0)
            while stack:
                f = stack.pop()
                for e in f.edges:
                    for g in e.link_faces:
                        if g not in seen: seen.add(g); stack.append(g); comp.append(g)
            vs = {v for f in comp for v in f.verts}
            if all((v.co - centre).length < radius for v in vs): take += comp
        if take:
            off = len(mats); mats += list(o.data.materials)
            tmp = bmesh.new()
            vm = {}
            for f in take:
                for v in f.verts:
                    if v not in vm: vm[v] = tmp.verts.new(v.co)
                try:
                    nf = tmp.faces.new([vm[v] for v in f.verts]); nf.material_index = f.material_index + off; nf.smooth = f.smooth
                except ValueError: pass
            me = bpy.data.meshes.new('tmp'); tmp.to_mesh(me); tmp.free()
            bmo.from_mesh(me); bpy.data.meshes.remove(me)
            bmesh.ops.delete(bm, geom=take, context='FACES')
            bm.to_mesh(o.data)
        bm.free()
    me = bpy.data.meshes.new(name); bmo.to_mesh(me); bmo.free()
    for m in mats: me.materials.append(m)
    ob = bpy.data.objects.new(name, me); sc.collection.objects.link(ob)
    return ob


def box(bm, lo, hi, inward=False):
    vs = [bm.verts.new((x, y, z)) for z in (lo[2], hi[2]) for y in (lo[1], hi[1]) for x in (lo[0], hi[0])]
    faces = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
    out = []
    for f in faces:
        q = [vs[i] for i in f]
        out.append(bm.faces.new(list(reversed(q)) if inward else q))
    return out


def ring(bm, c, r, tube, n_axis, seg=12, tseg=4):
    """Low-poly torus (steering rim) centred at c, axis n_axis."""
    n = n_axis.normalized()
    u = n.orthogonal().normalized(); w = n.cross(u)
    grid = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        d = u * math.cos(a) + w * math.sin(a)
        row = []
        for j in range(tseg):
            b = 2 * math.pi * j / tseg
            row.append(bm.verts.new(c + d * (r + tube * math.cos(b)) + n * tube * math.sin(b)))
        grid.append(row)
    for i in range(seg):
        for j in range(tseg):
            a, b2 = grid[i][j], grid[(i + 1) % seg][j]
            c2, d2 = grid[(i + 1) % seg][(j + 1) % tseg], grid[i][(j + 1) % tseg]
            bm.faces.new((a, b2, c2, d2))


def zuk_interior(sc):
    k = K['zuk_a06']
    m = 1 / k  # one metre in model units
    dark = flat_mat('interior_dark', (0.045, 0.045, 0.05))
    seat = flat_mat('interior_seat', (0.12, 0.085, 0.06))
    steel = flat_mat('interior_wheel', (0.03, 0.03, 0.03))
    # Cabin liner: an inward-facing box (seen only through the open door) + floor, dash, bench.
    bm = bmesh.new()
    floor, roof = -0.015, 0.42
    for f in box(bm, (-0.2, -0.50, floor), (0.2, 0.57, 0.40), inward=True): f.material_index = 0
    for f in box(bm, (-0.2, -0.50, 0.09), (0.2, -0.445, 0.19)): f.material_index = 0  # dashboard
    for f in box(bm, (-0.195, -0.36, floor), (0.195, -0.22, 0.10)): f.material_index = 1  # bench base + cushion
    for f in box(bm, (-0.195, -0.225, 0.10), (0.195, -0.19, 0.31)): f.material_index = 1  # backrest
    for f in box(bm, (-0.2, -0.19, floor), (0.2, -0.17, 0.40)): f.material_index = 0  # bulkhead behind the cab
    me = bpy.data.meshes.new('interior'); bm.to_mesh(me); bm.free()
    for mm in (dark, seat): me.materials.append(mm)
    ob = bpy.data.objects.new('interior', me); sc.collection.objects.link(ob)
    # Steering wheel: rim + 2 spokes, tilted ~40° (bus style), in front of the left (driver) seat.
    bm = bmesh.new()
    c = Vector((0.12, -0.415, 0.235))
    axis = Vector((0, -math.cos(math.radians(40)), -math.sin(math.radians(40))))  # down the column, away from the driver
    ring(bm, c, 0.19 * m, 0.016 * m, axis)
    u = axis.orthogonal().normalized()
    for s in (-1, 1):
        a = c + u * s * 0.17 * m
        box_c = (a + c) / 2
        hh = Vector((abs(a.x - c.x) / 2 + 0.01 * m, abs(a.y - c.y) / 2 + 0.01 * m, abs(a.z - c.z) / 2 + 0.01 * m))
        box(bm, box_c - hh, box_c + hh)
    me = bpy.data.meshes.new('steering_wheel'); bm.to_mesh(me); bm.free(); me.materials.append(steel)
    sw = bpy.data.objects.new('steering_wheel', me); sc.collection.objects.link(sw)
    # Column (static, part of the interior).
    bm = bmesh.new(); bm.from_mesh(ob.data)
    col = c + axis * 0.18 * m
    hh = Vector((0.02 * m, 0.09 * m, 0.03 * m))
    for f in box(bm, col - hh, col + hh): f.material_index = 0
    bm.to_mesh(ob.data); bm.free()


for f in ['pickup_truck', 'mercedes_g500_4x4', 'zuk_a06']:
    sc = bpy.data.scenes[f]
    win.scene = sc
    k = K[f]
    reset_doors(sc)
    for o in list(sc.objects):
        if o.name in ('interior', 'steering_wheel') or o.name.startswith(('interior.', 'steering_wheel.')):
            bpy.data.objects.remove(o)
    if f == 'mercedes_g500_4x4':
        separate_parts(sc, 'steering_wheel', Vector((0.456, -0.36, 1.645)) / k, 0.235 / k)
    if f == 'zuk_a06':
        zuk_interior(sc)
    for o in sc.objects:
        if o.name.startswith('door_'):
            h = door_hinge(sc, o, k)
            o['hinge'] = gl(h)
            report[o.name] = [round(x * k, 3) for x in h]
    # Keep only the base colour texture (the game bakes everything else away) — smaller download.
    for o in sc.objects:
        if o.type != 'MESH': continue
        for m in o.data.materials:
            if not m or not m.use_nodes: continue
            nt = m.node_tree
            b = nt.nodes.get('Principled BSDF')
            for inp in ('Normal', 'Roughness', 'Metallic', 'Emission Color', 'Emission Strength'):
                if b and b.inputs[inp].is_linked:
                    for l in list(b.inputs[inp].links): nt.links.remove(l)
            for n in list(nt.nodes):
                if n.type == 'NORMAL_MAP':
                    nt.nodes.remove(n)
                    continue
                # Base colour at most 1024² (the game's MEDIUM/HIGH map; LOW downscales to 512 at runtime).
                if n.type == 'TEX_IMAGE' and n.image and max(n.image.size) > 1024 and n.outputs['Color'].is_linked:
                    n.image.scale(1024, 1024)
            if b and b.inputs['Emission Strength'].default_value != 0 and not b.inputs['Emission Color'].is_linked:
                b.inputs['Emission Strength'].default_value = 0
    path = OUT + f + '.lod0.glb'
    with bpy.context.temp_override(window=win, scene=sc):
        bpy.ops.object.select_all(action='DESELECT')
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_active_scene=True, export_extras=True,
                                  export_cameras=False, export_lights=False, export_animations=False, export_yup=True)
    report[f] = os.path.getsize(path)
result = report
