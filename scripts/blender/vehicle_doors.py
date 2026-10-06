"""
VEHICLE PREP, step 1 of 2: cut the front doors out of the garage cars. Run inside Blender 5.x (Text Editor, or the
MCP add-on). Input: the ORIGINAL GLBs (`git show 8538725:src/assets/models/vehicles/<name>.lod0.glb`) in SRC; each
car goes into a scene named after it (create scenes 'pickup_truck', 'mercedes_g500_4x4', 'zuk_a06' first, each
with a camera). Along each door outline (pixels of a 1600-px orthographic left-side render, CARS below) the skin is
bisected, the door faces (skin, trim, mirror, window) move to `door_FL_<car>` / `door_FR_<car>`, the opening gets
a dark jamb, the Żuk door an inner panel (the others have modelled door cards), and the imported custom normals
are transferred back onto the original skin (bmesh drops them). Then run vehicle_finish.py.
"""
import bpy, bmesh, mathutils, math
from mathutils import Vector

SRC = 'C:/path/to/original/vehicles/'  # the original GLBs (see above)

# Door outlines in PIXELS of the left-side render (1600 px = ortho span s, centred on ctr), front first.
CARS = {
    'pickup_truck': dict(length=5.1, s=8.00588, cy=0.36133, cz=1.30923,
                         poly=[(497, 585), (762, 585), (762, 336), (605, 336), (500, 430)]),
    'mercedes_g500_4x4': dict(length=4.8, s=0.0509201, cy=-0.000834598, cz=0.0113197,
                              poly=[(599, 557), (905, 557), (905, 151), (690, 151), (599, 290)]),
    'zuk_a06': dict(length=4.4, s=1.48317, cy=-0.048993, cz=0.166539,
                    panel=True, poly=[(330, 175), (596, 175), (596, 652), (415, 652), (385, 600), (350, 550), (330, 505)]),
}
SKIP = ('wheel', 'tyre', 'tire', 'caliper', 'rim_')


def px2(c, p):
    return (c['cy'] + (p[0] - 800) / 1600 * c['s'], c['cz'] - (p[1] - 450) / 1600 * c['s'])


def inside(poly, y, z):
    n, ins = len(poly), False
    for i in range(n):
        (y1, z1), (y2, z2) = poly[i], poly[(i + 1) % n]
        if (z1 > z) != (z2 > z) and y < (y2 - y1) * (z - z1) / (z2 - z1) + y1:
            ins = not ins
    return ins


def seg_dist(poly, y, z):
    best = 1e9
    for i in range(len(poly)):
        a, b = Vector(poly[i]), Vector(poly[(i + 1) % len(poly)])
        p = Vector((y, z)); ab = b - a
        t = max(0, min(1, (p - a).dot(ab) / ab.length_squared))
        best = min(best, (a + ab * t - p).length)
    return best


def pct(vals, q):
    v = sorted(vals)
    return v[min(len(v) - 1, int(q * len(v)))]


def get_mat(name, base, rgba):
    m = bpy.data.materials.get(name)
    if m: return m
    m = base.copy() if base else bpy.data.materials.new(name)
    m.name = name
    if not m.use_nodes: m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    if b and not b.inputs['Base Color'].is_linked:
        b.inputs['Base Color'].default_value = rgba
    return m


def restore_normals(sc, targets, sources, k):
    win = bpy.context.window_manager.windows[0]
    for o in targets:
        me = o.data
        inner = {i for i, m in enumerate(me.materials) if m and 'inner' in m.name}
        bad = set()
        for p in me.polygons:
            if p.material_index in inner: bad.update(p.vertices)
        vg = o.vertex_groups.get('skin') or o.vertex_groups.new(name='skin')
        vg.add([v.index for v in me.vertices if v.index not in bad], 1.0, 'REPLACE')
        me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
        for s2 in sources:
            md = o.modifiers.new('dt_' + s2.name[:40], 'DATA_TRANSFER')
            md.object = s2
            md.use_loop_data = True
            md.data_types_loops = {'CUSTOM_NORMAL'}
            md.loop_mapping = 'NEAREST_NORMAL'
            md.use_max_distance = True
            md.max_distance = 0.003 / k
            md.vertex_group = 'skin'
    with bpy.context.temp_override(window=win, scene=sc):
        dg = bpy.context.evaluated_depsgraph_get()
        dg.update()
        for o in targets:
            ev = o.evaluated_get(dg)
            nm = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
            old = o.data
            o.modifiers.clear()
            o.data = nm
            nm.name = old.name
            bpy.data.meshes.remove(old)
            o.vertex_groups.clear()


def process(f):
    c = CARS[f]
    sc = bpy.data.scenes[f]
    win = bpy.context.window_manager.windows[0]
    win.scene = sc
    for o in list(sc.objects):
        if o.type != 'CAMERA': bpy.data.objects.remove(o)
    with bpy.context.temp_override(window=win, scene=sc):
        bpy.ops.import_scene.gltf(filepath=SRC + f + '.lod0.glb')
    meshes = [o for o in sc.objects if o.type == 'MESH']
    # Flatten the hierarchy: world-space mesh data, no parents (names kept).
    for o in meshes:
        mw = o.matrix_world.copy()
        o.parent = None
        o.data.transform(mw)
        o.matrix_world = mathutils.Matrix.Identity(4)
    for o in [o for o in sc.objects if o.type == 'EMPTY']:
        bpy.data.objects.remove(o)
    work = [o for o in meshes if not any(k in o.name.lower() for k in SKIP)]
    # Untouched copies: their custom normals are transferred back after the cut (bmesh drops them).
    sources = []
    for o in work:
        s2 = o.copy(); s2.data = o.data.copy(); s2.name = 'src_' + o.name; sc.collection.objects.link(s2); s2.hide_render = True
        sources.append(s2)
    xs, ys = [], []
    for o in work:
        for v in o.data.vertices: xs.append(v.co.x); ys.append(v.co.y)
    cx = (pct(xs, 0.02) + pct(xs, 0.98)) / 2
    k = c['length'] / (pct(ys, 0.995) - pct(ys, 0.005))  # metres per model unit
    TH = 0.15 / k   # selection depth from the outer skin
    PANEL = 0.07 / k  # door / jamb thickness
    poly_l = [px2(c, p) for p in c['poly']]
    ymin = min(p[0] for p in poly_l); ymax = max(p[0] for p in poly_l)
    zmin = min(p[1] for p in poly_l); zmax = max(p[1] for p in poly_l)
    pad = 0.05 / k
    report = {'cx': cx, 'k': k}
    for side, tag in ((1, 'FL'), (-1, 'FR')):  # +X = the car's left (driver) in Blender
        # Outer skin depth inside the outline.
        # Outer skin = area-weighted median depth of the outward-facing panels inside the outline (mirrors and
        # flares sticking out don't count).
        sv = []
        for o in work:
            for p in o.data.polygons:
                if p.normal.x * side > 0.8 and inside(poly_l, p.center.y, p.center.z):
                    sv.append((side * (p.center.x - cx), p.area))
        if not sv: continue
        mx = max(x_ for x_, _ in sv)
        sv = sorted((x_, a) for x_, a in sv if x_ > mx * 0.7)
        tot = sum(a for _, a in sv); acc = 0
        for x_, a in sv:
            acc += a
            if acc >= tot * 0.5:
                outer = x_; break
        outer += 0.03 / k
        pieces = []
        for o in work:
            bm = bmesh.new(); bm.from_mesh(o.data)
            near = lambda co: side * (co.x - cx) > outer - TH * 1.4 and ymin - pad < co.y < ymax + pad and zmin - pad < co.z < zmax + pad
            # 1) Cut the skin along every outline edge (only faces near this door).
            for i in range(len(poly_l)):
                (y1, z1), (y2, z2) = poly_l[i], poly_l[(i + 1) % len(poly_l)]
                n = Vector((0, -(z2 - z1), y2 - y1)).normalized()
                fs = [fc for fc in bm.faces if near(fc.calc_center_median())]
                if not fs: continue
                geom = list({e for fc in fs for e in fc.edges}) + fs + list({v for fc in fs for v in fc.verts})
                bmesh.ops.bisect_plane(bm, geom=geom, plane_co=Vector((0, y1, z1)), plane_no=n)
            # 2) Door faces: inside the outline, within TH of the outer skin.
            door = [fc for fc in bm.faces if inside(poly_l, *fc.calc_center_median().yz) and side * (fc.calc_center_median().x - cx) > outer - TH]
            if not door:
                bm.free(); continue
            ds = set(door)
            # Hole boundary edges (become the jamb) = edges shared by a door face and a non-door face.
            hole = [e for e in {e for fc in door for e in fc.edges} if any(lf not in ds for lf in e.link_faces) and seg_dist(poly_l, *((e.verts[0].co + e.verts[1].co) / 2).yz) < 0.02 / k]
            # Copy door faces into their own mesh.
            dbm = bmesh.new()
            vmap = {}
            uvl = bm.loops.layers.uv.active
            duv = dbm.loops.layers.uv.new() if uvl else None
            for fc in door:
                vs = []
                for v in fc.verts:
                    if v not in vmap: vmap[v] = dbm.verts.new(v.co)
                    vs.append(vmap[v])
                try:
                    nf = dbm.faces.new(vs)
                except ValueError:
                    continue
                nf.material_index = fc.material_index
                nf.smooth = fc.smooth
                if uvl:
                    for la, lb in zip(fc.loops, nf.loops): lb[duv].uv = la[uvl].uv
            # Jamb: extrude the hole's edges into the body (dark), then delete the door faces from the body.
            jamb_mat = None
            if hole:
                ret = bmesh.ops.extrude_edge_only(bm, edges=hole)
                nv = [g for g in ret['geom'] if isinstance(g, bmesh.types.BMVert)]
                for v in nv: v.co.x -= side * PANEL
                jf = [g for g in ret['geom'] if isinstance(g, bmesh.types.BMFace)]
                jamb_mat = len(o.data.materials)
                for fc in jf: fc.material_index = jamb_mat
            bmesh.ops.delete(bm, geom=door, context='FACES')
            if hole:
                # Jamb faces must face the opening (outward, toward the door's centre plane).
                bm.normal_update()
                ctr = Vector((0, (ymin + ymax) / 2, (zmin + zmax) / 2))
                for fc in bm.faces:
                    if fc.material_index == jamb_mat:
                        cc = fc.calc_center_median(); d = Vector((0, ctr.y - cc.y, ctr.z - cc.z))
                        if fc.normal.dot(d) < 0: fc.normal_flip()
            bm.to_mesh(o.data); bm.free()
            if hole:
                base = o.data.materials[0] if o.data.materials else None
                o.data.materials.append(get_mat('door_inner_' + f[:3], base, (0.1, 0.1, 0.1, 1)))
            me = bpy.data.meshes.new('door_%s_%s' % (tag, o.name))
            dbm.to_mesh(me); dbm.free()
            for m in o.data.materials: me.materials.append(m)
            pieces.append(me)
        # Join the pieces into one door object.
        if not pieces: continue
        dbm = bmesh.new()
        allmats = []
        for me in pieces:
            off = len(allmats)
            allmats += list(me.materials)
            tmp = bmesh.new(); tmp.from_mesh(me)
            for fc in tmp.faces: fc.material_index += off
            tmp.to_mesh(me); tmp.free()
            dbm.from_mesh(me)
        dme = bpy.data.meshes.new('door_%s_%s' % (tag, f[:3]))
        dbm.to_mesh(dme); dbm.free()
        for m in allmats: dme.materials.append(m)
        for me in pieces: bpy.data.meshes.remove(me)
        # Inner panel + rim on the opaque (non-glass) faces: offset inward along the normals.
        bm = bmesh.new(); bm.from_mesh(dme); bm.normal_update()
        uvl = bm.loops.layers.uv.active
        glassy = lambda fc: any(s in (dme.materials[fc.material_index].name.lower() if dme.materials[fc.material_index] else '') for s in ('wind', 'glas'))
        skin = [fc for fc in bm.faces if not glassy(fc)] if c.get('panel') else []
        inner_idx = len(dme.materials)
        dme.materials.append(get_mat('door_inner_' + f[:3], dme.materials[0], (0.1, 0.1, 0.1, 1)))
        vin = {}
        for fc in skin:
            for v in fc.verts:
                if v not in vin:
                    nrm = v.normal if v.normal.length > 0.5 else Vector((side, 0, 0))
                    vin[v] = bm.verts.new(v.co - nrm * PANEL)
        sset = set(skin)
        newf = []
        for fc in skin:
            try:
                nf = bm.faces.new([vin[v] for v in reversed(fc.verts)])
            except ValueError:
                continue
            nf.material_index = inner_idx; nf.smooth = fc.smooth
            if uvl:
                for la, lb in zip(reversed(fc.loops), nf.loops): lb[uvl].uv = la[uvl].uv
            newf.append(nf)
        for e in list(bm.edges):
            lf = [f2 for f2 in e.link_faces if f2 in sset]
            if len(lf) == 1:
                a, b = e.verts
                # Winding: follow the owning face's loop direction.
                lp = next(l for l in lf[0].loops if l.edge == e)
                a, b = lp.vert, lp.link_loop_next.vert
                try:
                    rf = bm.faces.new([b, a, vin[a], vin[b]])
                    rf.material_index = inner_idx
                except ValueError:
                    pass
        bm.to_mesh(dme); bm.free()
        dob = bpy.data.objects.new('door_%s_%s' % (tag, f[:3]), dme)
        sc.collection.objects.link(dob)
        bb = [Vector(v) for v in dob.bound_box]
        report[tag] = {'outer': outer, 'faces': len(dme.polygons), 'hole_edges': len(hole) if 'hole' in dir() else 0,
                       'bb': [round(min(v.x for v in bb) * k, 3), round(max(v.x for v in bb) * k, 3), round(min(v.y for v in bb) * k, 3), round(max(v.y for v in bb) * k, 3)]}
    doors = [o for o in sc.objects if o.name.startswith('door_')]
    restore_normals(sc, work + doors, sources, k)
    for s2 in sources: bpy.data.objects.remove(s2)
    return report


result = {}
for f in CARS:
    try:
        result[f] = process(f)
    except Exception as e:
        import traceback
        result[f] = traceback.format_exc()
