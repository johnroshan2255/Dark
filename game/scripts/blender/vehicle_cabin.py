"""
VEHICLE PREP, step 6 (any car; skills/realistic-vehicle-system §8.2 / §8.10): THE CABIN for first-person driving,
real GLASS, and the working-kit add-ons removed.

  - every `acc_*` part (racks, jerrycans, bags, crates, ladders… from vehicle_details.py) is deleted — the cars carry
    only their own parts;
  - MODE=MEASURE: prints the car's frame and cabin landmarks (metres) and renders the driver's view to OUT;
  - MODE=BUILD (later steps of this script) builds the cockpit.

  node scripts/blender/bl.mjs scripts/blender/vehicle_cabin.py NAME=mercedes_g500_4x4 MODE=MEASURE OUT=C:/tmp/cabin/
"""
import bpy, bmesh, math, os, json, re
from mathutils import Vector, Matrix

# Source: the cars BEFORE this step (vehicle_details.py output = the GLBs committed before the cabin pass) — never
# the game folder this step writes to (a re-run would build a second cockpit on top of the first).
#   git show <rev>:src/assets/models/vehicles/<name>.lod0.glb > <SRC>/<name>.lod0.glb
SRC = globals().get('SRC', 'C:/tmp/vehicles_src/')
NAME = globals().get('NAME', 'mercedes_g500_4x4')
MODE = globals().get('MODE', 'MEASURE')
OUT = globals().get('OUT', 'C:/tmp/cabin/')
METRES = {'mercedes_g500_4x4': 0.475}
# Catalogue `cabin` (src/gameplay/vehicle/catalogue.ts): hip height, roof height (m above the ground), eye behind the wheel.
CABIN = {'mercedes_g500_4x4': (1.35, 2.2, 0.49)}
# Driver's eye (m, this script's frame) — Car.eyeLocal read in game: x across (+ = left), y from the front axle, z.
EYE = {'mercedes_g500_4x4': (0.407, 1.51, 2.01)}
os.makedirs(OUT, exist_ok=True)

sc = bpy.data.scenes.get('cab_' + NAME) or bpy.data.scenes.new('cab_' + NAME)
for o in list(sc.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.context.window_manager.windows[0].scene = sc
# (earlier runs' scenes hold the same node names: clear them so the names stay unsuffixed)
for s_ in [s_ for s_ in bpy.data.scenes if s_.name.startswith(('cab_', 'ins_', 'det_')) and s_ != sc]:
    for o in list(s_.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.data.scenes.remove(s_)
for blk in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.cameras):
    for d in [d for d in blk if d.users == 0]:
        blk.remove(d)
bpy.ops.import_scene.gltf(filepath=SRC + NAME + '.lod0.glb')
for o in [o for o in sc.objects if o.name.startswith('acc_')]:
    bpy.data.objects.remove(o, do_unlink=True)
# (the glTF importer keeps node names; strip Blender's .001 suffixes so the naming standard matches)
for o in sc.objects:
    o.name = re.sub(r'\.\d{3}$', '', o.name)
meshes = [o for o in sc.objects if o.type == 'MESH']

# ---- frame of reference (as vehicle_details.py): wheels, ground, metres ----
W = {}
for o in meshes:
    m = re.match(r'wheel_(FL|FR|RL|RR)', o.name)
    if m:
        pts = [o.matrix_world @ v.co for v in o.data.vertices]
        lo = Vector([min(p[i] for p in pts) for i in range(3)]); hi = Vector([max(p[i] for p in pts) for i in range(3)])
        W[m.group(1)] = ((lo + hi) / 2, (hi.z - lo.z) / 2, hi.x - lo.x)
R = W['FL'][1]
k = R / METRES[NAME]
z0 = W['FL'][0].z - R
xm = sum(w[0].x for w in W.values()) / 4
yF, yR = W['FL'][0].y, W['RL'][0].y
side = 1 if W['FL'][0].x > xm else -1      # +x (P frame) = the car's left
wb = (yR - yF) / k


def P(x, y, z):
    """Metres → model: x across (+ = left), y along (+ = toward the rear), z up from the ground; origin = the
    centre line at the front axle."""
    return Vector((xm + x * side * k, yF + y * k, z0 + z * k))


def local(p):
    return Vector(((p.x - xm) * side / k, (p.y - yF) / k, (p.z - z0) / k))


def is_glass(m):
    return m is not None and (m.blend_method == 'BLEND' or getattr(m, 'surface_render_method', '') == 'BLENDED' or re.search('glas|wind', m.name, re.I))


def tris(objs):
    return sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)


# Glass faces (any object): their points in metres.
glass_pts = []
for o in meshes:
    for poly in o.data.polygons:
        mat = o.material_slots[poly.material_index].material if o.material_slots else None
        if is_glass(mat) and not re.search('light|lamp', mat.name, re.I):
            glass_pts += [local(o.matrix_world @ o.data.vertices[i].co) for i in poly.vertices]
steer = next((o for o in meshes if o.name.startswith('steering_wheel')), None)
hip, roof, behind = CABIN[NAME]
info = {'name': NAME, 'k': k, 'wheelbase': wb, 'tris': tris(meshes), 'objects': len(meshes)}
if steer:
    sp = [local(steer.matrix_world @ v.co) for v in steer.data.vertices]
    c = sum(sp, Vector()) / len(sp)
    info['steer'] = {'centre': [round(v, 3) for v in c], 'min': [round(min(p[i] for p in sp), 3) for i in range(3)], 'max': [round(max(p[i] for p in sp), 3) for i in range(3)]}
if glass_pts:
    # Windscreen: the glass ahead of the driver, facing forward — the front-most band of glass points.
    ymin = min(p.y for p in glass_pts)
    ws = [p for p in glass_pts if p.y < ymin + 0.5 and abs(p.x) < 0.9]
    info['windscreen'] = {'y': [round(min(p.y for p in ws), 3), round(max(p.y for p in ws), 3)], 'z': [round(min(p.z for p in ws), 3), round(max(p.z for p in ws), 3)],
                          'x': [round(min(p.x for p in ws), 3), round(max(p.x for p in ws), 3)]}
    info['glass_all'] = {'y': [round(min(p.y for p in glass_pts), 3), round(max(p.y for p in glass_pts), 3)], 'z': [round(min(p.z for p in glass_pts), 3), round(max(p.z for p in glass_pts), 3)]}
info['cabin'] = {'hip': hip, 'roof': roof, 'behind': behind}
info['parts'] = sorted({o.name: tris([o]) for o in meshes}.items(), key=lambda t: -t[1])[:30]
print(json.dumps(info, indent=1))

if MODE == 'MEASURE':
    # Renders (Workbench, fast): the driver's view as the game puts the eye (seat behind the wheel, hip + 0.66 m),
    # the same with the glass hidden (what's in the cabin), and a 3/4 outside view.
    # (the game's first-person eye, Car.eyeLocal → this frame: x = −x, y = wheelbase / 2 + z)
    eye_x, eye_y, ez = EYE[NAME]
    cam_d = bpy.data.cameras.new('drv')
    cam_d.clip_start, cam_d.clip_end = 0.02 * k, 60 * k
    cam = bpy.data.objects.new('drv', cam_d)
    sc.collection.objects.link(cam)
    sc.camera = cam
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'
    sc.display.shading.color_type = 'TEXTURE'
    sc.render.resolution_x, sc.render.resolution_y = 960, 540

    def shot(name, at, look, lens):
        cam.location = at
        cam.rotation_euler = (look - at).to_track_quat('-Z', 'Y').to_euler()
        cam_d.lens = lens
        sc.render.filepath = OUT + NAME + '_' + name + '.png'
        bpy.ops.render.render(write_still=True)

    shot('driver', P(eye_x, eye_y, ez), P(eye_x, eye_y - 3, ez - 0.9), 15)
    glassy = [o for o in meshes if o.material_slots and all(is_glass(s.material) for s in o.material_slots)]
    for o in glassy:
        o.hide_render = True
    shot('cabin', P(-eye_x, eye_y + 0.3, ez + 0.05), P(eye_x, eye_y - 1.2, ez - 0.5), 12)
    for o in glassy:
        o.hide_render = False
    shot('out', P(-3.4, -3.0, 2.0), P(0, wb * 0.4, 1.0), 28)
    print('rendered', OUT)

if MODE == 'PROBE':
    # Windscreen close-ups from outside: as is, and with the named detail parts hidden (which part are the wipers?).
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'
    sc.display.shading.color_type = 'TEXTURE'
    sc.render.resolution_x, sc.render.resolution_y = 800, 450
    cam_d = bpy.data.cameras.new('probe')
    cam_d.clip_start, cam_d.clip_end = 0.02 * k, 60 * k
    cam = bpy.data.objects.new('probe', cam_d)
    sc.collection.objects.link(cam)
    sc.camera = cam
    ws = info.get('windscreen', {'y': [0, 0.5], 'z': [1.2, 1.6]})
    look = P(0, ws['y'][0], (ws['z'][0] + ws['z'][1]) / 2 - 0.1)
    cam.location = P(0.6, ws['y'][0] - 2.4, ws['z'][1] + 0.6)
    cam.rotation_euler = (look - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam_d.lens = 30
    sc.render.filepath = OUT + NAME + '_ws.png'
    bpy.ops.render.render(write_still=True)
    hide = [o for o in meshes if re.search(globals().get('HIDE', 'skinned'), o.name)]
    for o in hide:
        o.hide_render = True
    sc.render.filepath = OUT + NAME + '_ws_hidden.png'
    bpy.ops.render.render(write_still=True)
    print('probe', [o.name for o in hide])

if MODE == 'PARTS':
    # Loose parts of the body that lie wholly inside the cabin box (steering wheel, gear stick, seats…): their
    # vertex counts and bounds (metres) — what can be swapped for a working part.
    box = [float(v) for v in globals().get('BOX', '-1,0,0.6,1,2.4,2.2').split(',')]
    for o in meshes:
        if o.name.startswith(('wheel_', 'caliper_', 'door_')):
            continue
        bm = bmesh.new(); bm.from_mesh(o.data); bm.verts.ensure_lookup_table()
        seen = set(); comps = []
        for v in bm.verts:
            if v.index in seen:
                continue
            stack = [v]; comp = []
            seen.add(v.index)
            while stack:
                a = stack.pop(); comp.append(a)
                for e in a.link_edges:
                    b = e.other_vert(a)
                    if b.index not in seen:
                        seen.add(b.index); stack.append(b)
            pts = [local(o.matrix_world @ a.co) for a in comp]
            lo = [min(p[i] for p in pts) for i in range(3)]; hi = [max(p[i] for p in pts) for i in range(3)]
            if all(box[i] <= lo[i] and hi[i] <= box[i + 3] for i in range(3)) and len(comp) >= 8:
                comps.append((len(comp), [round(x, 2) for x in lo], [round(x, 2) for x in hi]))
        bm.free()
        for c_ in sorted(comps, key=lambda t: -t[0])[:25]:
            print(o.name[:40], c_)



# =====================================================================================================================
# BUILD: real glass, the cockpit's working parts and the cabin, then a fresh AO bake and the GLB.
#   Parts (vertex-coloured on the wheels' material — no extra material; the loader never paints `cab_*`):
#     cab_<car>        static cockpit / cabin (dash panels, seats, floor, console, column, vents, mirror, visors…)
#     steering_wheel   rebuilt (rim + spokes + hub) — the loader finds its pivot and column axis from the ring
#     dial_<car>       gauge faces: quads UV-mapped onto a canvas the game draws (needles, numbers) — material `dial`
#     pedal_<gas|brake|clutch>, gear_lever, wiper_<L|R>: moving parts, extras `pivot` (glTF space) + `axis`
#   Glass: every window face on ONE material `glass` (transparent).
# =====================================================================================================================
if MODE == 'BUILD':
    WHEEL_MAT = next(s.material for o in meshes if o.name.startswith('wheel_') for s in o.material_slots if s.material)
    dg = bpy.context.evaluated_depsgraph_get()

    def gl(v):  # Blender → glTF (Y up)
        return [v.x, v.z, -v.y]

    def D(x, y, z):  # a direction in this frame → model
        return Vector((x * side, y, z)).normalized()

    BLACK = (0.018, 0.018, 0.02); SOFT = (0.035, 0.034, 0.036); GREY = (0.16, 0.16, 0.165); LIGHT = (0.32, 0.32, 0.33)
    STEEL = (0.08, 0.08, 0.085); CHROME = (0.62, 0.64, 0.67); RUBBER = (0.025, 0.025, 0.027); LEATHER = (0.03, 0.026, 0.024)
    WOOD = (0.16, 0.07, 0.03); VINYL_BLUE = (0.05, 0.09, 0.14); BODY_BLUE = (0.07, 0.17, 0.24)

    class Part:
        def __init__(self):
            self.bm = bmesh.new(); self.cols = []; self.uvs = []

        def face(self, vs, col, uv=None):
            try:
                f = self.bm.faces.new(vs)
            except ValueError:
                return None
            self.cols.append((f, col)); self.uvs.append(uv)
            return f

        def box(self, c, size, col, basis=None):
            """Box centred at c (model), size (m) along the basis axes (default: across, along, up of this frame)."""
            u, v, w = basis or (D(1, 0, 0), Vector((0, 1, 0)), Vector((0, 0, 1)))
            hx, hy, hz = (s * k / 2 for s in size)
            vs = [self.bm.verts.new(c + u * dx + v * dy + w * dz) for dz in (-hz, hz) for dy in (-hy, hy) for dx in (-hx, hx)]
            for q in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
                self.face([vs[i] for i in q], col)

        def tube(self, a, b, r, col, seg=8, caps=True):
            ax = (b - a).normalized(); u = ax.orthogonal().normalized(); v = ax.cross(u)
            ra = [self.bm.verts.new(a + (u * math.cos(t) + v * math.sin(t)) * r * k) for t in (2 * math.pi * i / seg for i in range(seg))]
            rb = [self.bm.verts.new(b + (u * math.cos(t) + v * math.sin(t)) * r * k) for t in (2 * math.pi * i / seg for i in range(seg))]
            for i in range(seg):
                j = (i + 1) % seg
                self.face((ra[i], ra[j], rb[j], rb[i]), col)
            if caps:
                self.face(list(reversed(ra)), col); self.face(rb, col)

        def ring(self, c, n, R, r, col, seg=28, tseg=8):
            """Torus: centre c, facing n (unit), ring radius R, tube radius r (m)."""
            u = n.orthogonal().normalized(); v = n.cross(u)
            rings = []
            for i in range(seg):
                t = 2 * math.pi * i / seg
                d = u * math.cos(t) + v * math.sin(t)
                rings.append([self.bm.verts.new(c + d * R * k + (d * math.cos(s) + n * math.sin(s)) * r * k) for s in (2 * math.pi * j / tseg for j in range(tseg))])
            for i in range(seg):
                a, b = rings[i], rings[(i + 1) % seg]
                for j in range(tseg):
                    self.face((a[j], b[j], b[(j + 1) % tseg], a[(j + 1) % tseg]), col)

        def disc(self, c, n, r, col, seg=20, depth=0.0, rim=None):
            u = n.orthogonal().normalized(); v = n.cross(u)
            top = [self.bm.verts.new(c + (u * math.cos(t) + v * math.sin(t)) * r * k) for t in (2 * math.pi * i / seg for i in range(seg))]
            self.face(top, col)
            if depth:
                bv = [self.bm.verts.new(p.co - n * depth * k) for p in top]
                for i in range(seg):
                    j = (i + 1) % seg
                    self.face((bv[i], bv[j], top[j], top[i]), rim or col)

        def quad_uv(self, c, u, v, w, h, col, uv_rect):
            """A flat w × h m rectangle in the plane of u, v (unit) centred at c, UV-mapped to (u0, v0, u1, v1)."""
            hw, hh = w * k / 2, h * k / 2
            vs = [self.bm.verts.new(p) for p in (c - u * hw - v * hh, c + u * hw - v * hh, c + u * hw + v * hh, c - u * hw + v * hh)]
            u0, v0, u1, v1 = uv_rect
            self.face(vs, col, [(u0, v0), (u1, v0), (u1, v1), (u0, v1)])

        def finish(self, name, extras=None, mat=None):
            solid = [f for (f, _), uv in zip(self.cols, self.uvs) if f.is_valid and not uv]
            if solid:
                bmesh.ops.recalc_face_normals(self.bm, faces=solid)
            if any(self.uvs):
                uvl = self.bm.loops.layers.uv.new('UVMap')
                for (f, _), uv in zip(self.cols, self.uvs):
                    if uv and f.is_valid:
                        for loop, xy in zip(f.loops, uv):
                            loop[uvl].uv = xy
            me = bpy.data.meshes.new(name)
            self.bm.to_mesh(me); self.bm.free()
            col = me.color_attributes.new('Color', 'BYTE_COLOR', 'CORNER')
            for poly, (f, rgb) in zip(me.polygons, self.cols):
                for li in poly.loop_indices:
                    col.data[li].color = (*rgb, 1.0)
            me.materials.append(mat or WHEEL_MAT)
            ob = bpy.data.objects.new(name, me)
            sc.collection.objects.link(ob)
            for kk, vv in (extras or {}).items():
                ob[kk] = vv
            return ob

    # (the vertex-coloured material must read 'Color', else the exporter drops COLOR_0)
    nt = WHEEL_MAT.node_tree
    vc = next((n for n in nt.nodes if n.type == 'VERTEX_COLOR'), None) or nt.nodes.new('ShaderNodeVertexColor')
    vc.layer_name = 'Color'
    nt.links.new(vc.outputs['Color'], nt.nodes.get('Principled BSDF').inputs['Base Color'])

    # ---- GLASS: one transparent material for every window ----
    glass = bpy.data.materials.get('glass') or bpy.data.materials.new('glass')
    glass.use_nodes = True
    gb = glass.node_tree.nodes.get('Principled BSDF')
    gb.inputs['Base Color'].default_value = (0.06, 0.075, 0.085, 1)
    gb.inputs['Alpha'].default_value = 0.32
    gb.inputs['Roughness'].default_value = 0.08
    for attr, val in (('surface_render_method', 'BLENDED'), ('blend_method', 'BLEND')):
        try:
            setattr(glass, attr, val)
        except Exception:
            pass
    for o in meshes:
        for s in o.material_slots:
            if s.material and re.search('wind|glas', s.material.name, re.I) and not re.search('light|lamp', s.material.name, re.I):
                s.material = glass

    if NAME == 'mercedes_g500_4x4':
        for o in [o for o in sc.objects if o.name.startswith('steering_wheel')]:
            bpy.data.objects.remove(o, do_unlink=True)
        # The modelled (static) wipers: small loose parts on the cowl (arms, blades, pivot caps) → working ones below.
        # (the long cowl trim strips across the whole width stay)
        for paint in [o for o in sc.objects if o.type == 'MESH' and 'chassis_carpaint' in o.name]:
            bm = bmesh.new(); bm.from_mesh(paint.data); bm.verts.ensure_lookup_table()
            seen = set(); kill = []
            for v in bm.verts:
                if v.index in seen:
                    continue
                stack = [v]; comp = []; seen.add(v.index)
                while stack:
                    a = stack.pop(); comp.append(a)
                    for e in a.link_edges:
                        b = e.other_vert(a)
                        if b.index not in seen:
                            seen.add(b.index); stack.append(b)
                pts = [local(paint.matrix_world @ a.co) for a in comp]
                lo = [min(q[i] for q in pts) for i in range(3)]; hi = [max(q[i] for q in pts) for i in range(3)]
                if lo[0] > -0.72 and hi[0] < 0.4 and lo[1] > 0.66 and hi[1] < 0.79 and lo[2] > 1.565 and hi[2] < 1.735 and hi[0] - lo[0] < 0.6 and len(comp) <= 40:
                    kill += comp
            print('g500 static wiper verts removed', len(kill))
            bmesh.ops.delete(bm, geom=kill, context='VERTS'); bm.to_mesh(paint.data); bm.free()
    meshes = [o for o in sc.objects if o.type == 'MESH']
    dg = bpy.context.evaluated_depsgraph_get()

    def cast(origin, d, skip_glass=True, max_m=4.0):
        """First hit (model point, normal) from origin along d — glass and wheels ignored."""
        o_ = origin.copy()
        for _ in range(8):
            hit, loc, nrm, idx, ob, mtx = sc.ray_cast(dg, o_, d, distance=max_m * k)
            if not hit:
                return None, None
            mat = None
            if ob.material_slots and idx < len(ob.data.polygons):
                mat = ob.material_slots[ob.data.polygons[idx].material_index].material
            if (skip_glass and mat == glass) or ob.name.startswith(('wheel_', 'caliper_')):
                o_ = loc + d * 0.002 * k
                continue
            return loc, nrm
        return None, None

    ex, ey, ez = EYE[NAME]
    eye = P(ex, ey, ez)
    cab = Part()
    built = []

    def floor_at(x, y, top=1.2):
        loc, _ = cast(P(x, y, top), Vector((0, 0, -1)))
        return local(loc).z if loc else 0.5

    def pedal(name, x, y_pivot, z_pivot, y_pad, pad=(0.08, 0.025, 0.06)):
        fz = floor_at(x, y_pad + 0.05)
        p = Part()
        a = P(x, y_pivot, z_pivot); b = P(x, y_pad, fz + 0.12)
        p.tube(a, b, 0.009, STEEL, 6)
        p.box(b + Vector((0, 0.012 * k, 0)), pad, RUBBER)
        built.append(p.finish(name, {'pivot': gl(a), 'axis': [1.0, 0.0, 0.0]}))

    def gear(x, y, top_h=0.36, lean=0.18, auto=False, base_z=None):
        fz = floor_at(x, y) if base_z is None else base_z
        base = P(x, y, fz)
        p = Part()
        if auto:
            p.box(base + Vector((0, 0, 0.05 * k)), (0.05, 0.12, 0.04), LIGHT)
            tip = base + Vector((0, -0.02, 1)).normalized() * top_h * 0.45 * k
            p.tube(base, tip, 0.012, CHROME, 8)
            p.box(tip + Vector((0, 0, 0.03 * k)), (0.045, 0.08, 0.06), LEATHER)
        else:
            p.box(base + Vector((0, 0, 0.03 * k)), (0.11, 0.11, 0.06), RUBBER)
            tip = base + Vector((0, lean, 1)).normalized() * top_h * k
            p.tube(base, tip, 0.008, STEEL, 8)
            p.box(tip, (0.045, 0.045, 0.045), BLACK)
        built.append(p.finish('gear_lever', {'pivot': gl(base), 'axis': [1.0, 0.0, 0.0]}))

    def wheel(c, n, R, r, spokes, col, hub=0.06, hub_col=None, star=False):
        p = Part()
        p.ring(c, n, R, r, col, seg=24, tseg=7)
        down = (Vector((0, 0, -1)) - n * Vector((0, 0, -1)).dot(n)).normalized()
        right = n.cross(down)
        for ang in spokes:
            d = down * math.cos(math.radians(ang)) + right * math.sin(math.radians(ang))
            p.tube(c - n * 0.015 * k, c + d * (R - r * 0.5) * k, r * 0.55, col, 6)
        p.disc(c + n * 0.012 * k, n, hub, hub_col or col, 20, depth=0.04)
        if star:
            for ang in (0, 120, 240):
                d = down * math.cos(math.radians(ang + 180)) + right * math.sin(math.radians(ang + 180))
                p.box(c + n * 0.014 * k + d * 0.018 * k, (0.006, 0.036, 0.004), CHROME, (n.cross(d).normalized(), d, n))
            p.ring(c + n * 0.014 * k, n, 0.036, 0.003, CHROME, 20, 4)
        built.append(p.finish('steering_wheel'))
        cab.tube(c - n * 0.03 * k, c - n * 0.3 * k + Vector((0, 0, -0.04 * k)), 0.022, SOFT, 10)
        cab.box(c - n * 0.1 * k + Vector((0, 0, -0.03 * k)), (0.07, 0.09, 0.05), SOFT, (D(1, 0, 0), -n, n.cross(D(1, 0, 0))))

    def dial_quads(items, name):
        """Gauge faces on the dash: each (target x, y, z m, w, h, uv rect) cast from the eye onto the panel and laid
        4 mm in front of it, facing the eye."""
        p = Part()
        for (tx, ty, tz, w, h, uv) in items:
            d = (P(tx, ty, tz) - eye).normalized()
            loc, nrm = cast(eye, d)
            if loc is None:
                print('dial: no surface', name, tx, ty, tz)
                continue
            c = loc - d * 0.004 * k
            f = (eye - c).normalized()
            u = D(-1, 0, 0)
            u = (u - f * u.dot(f)).normalized()
            v = f.cross(u).normalized()
            if v.z < 0:
                v = -v
            u = v.cross(f).normalized()
            p.quad_uv(c, u, v, w, h, (1, 1, 1), uv)
        dial = bpy.data.materials.get('dial') or bpy.data.materials.new('dial')
        built.append(p.finish(name, {}, dial))

    def screen_fixed(cx, cy, cz, w, h, uv, name, hood=True, more=()):
        """A gauge face / screen at an explicit point (m), facing the eye (+ `more` faces: (cx, cy, cz, w, h, uv));
        its housing and hood (a black lip) above it."""
        p = Part()
        c = P(cx, cy, cz)
        f = (eye - c).normalized()
        u = D(-1, 0, 0)
        u = (u - f * u.dot(f)).normalized()
        v = f.cross(u).normalized()
        if v.z < 0:
            v = -v
        u = v.cross(f).normalized()
        p.quad_uv(c, u, v, w, h, (1, 1, 1), uv)
        for (mx, my, mz, mw, mh, muv) in more:
            mc = P(mx, my, mz)
            p.quad_uv(mc, u, v, mw, mh, (1, 1, 1), muv)
        dial = bpy.data.materials.get('dial') or bpy.data.materials.new('dial')
        built.append(p.finish(name, {}, dial))
        if hood:
            cab.box(c - f * 0.012 * k, (w + 0.04, 0.02, h + 0.03), BLACK, (u, -f, v))                  # bezel / housing
            cab.box(c + v * (h / 2 + 0.02) * k - f * 0.04 * k, (w + 0.06, 0.1, 0.02), BLACK, (u, -f, v))  # hood

    def wipers(pivots, length, park_dir):
        """Two wiper arms on the windscreen's lower edge, parked toward park_dir (frame), pivots on the cowl."""
        for nm, (x, y, z) in zip(('wiper_L', 'wiper_R'), pivots):
            a = P(x, y, z)
            loc, nrm = cast(a - Vector((0, 0.3 * k, -0.15 * k)), (a - (a - Vector((0, 0.3 * k, -0.15 * k)))).normalized(), skip_glass=False)
            n = nrm.normalized() if nrm is not None else D(0, -0.5, 0.85)
            if n.y > 0:
                n = -n
            dirp = D(*park_dir)
            dirp = (dirp - n * dirp.dot(n)).normalized()
            p = Part()
            p.disc(a + n * 0.01 * k, n, 0.018, BLACK, 10, depth=0.02)
            base = a + n * 0.02 * k
            tip = base + dirp * length * k
            p.tube(base, tip, 0.006, BLACK, 6)
            p.box(tip - dirp * length * 0.45 * k + n * 0.004 * k, (length * 0.9, 0.012, 0.012), RUBBER, (dirp, n.cross(dirp), n))
            built.append(p.finish(nm, {'pivot': gl(a), 'axis': [n.x, n.z, -n.y]}))

    def seat(x, y, hip, w, col, back=0.6, tilt=14, head=True):
        cz = hip - 0.07
        cab.box(P(x, y, cz), (w, 0.48, 0.12), col)
        cab.box(P(x, y, cz - 0.16), (w * 0.8, 0.4, 0.2), SOFT)
        t = math.radians(tilt)
        bv = Vector((0, math.sin(t), math.cos(t)))
        bb = (D(1, 0, 0), Vector((0, math.cos(t), -math.sin(t))), bv)
        cab.box(P(x, y + 0.25 + math.sin(t) * back / 2, cz + 0.05 + math.cos(t) * back / 2), (w, 0.1, back), col, bb)
        if head:
            cab.box(P(x, y + 0.25 + math.sin(t) * (back + 0.12), cz + 0.05 + math.cos(t) * (back + 0.12)), (w * 0.55, 0.09, 0.17), col, bb)

    # ================================ per car ================================
    if NAME == 'mercedes_g500_4x4':
        wc = P(0.436, 1.08, 1.553)
        wn = D(0, 0.929, 0.37)
        wheel(wc, wn, 0.185, 0.021, (90, -90, 0), LEATHER, hub=0.075, hub_col=BLACK, star=True)
        # (the newer G-Class's wide twin screen of the reference: just above / ahead of the wheel, across to the centre)
        # (on the dash face: where the eye's ray through the wheel's top meets it)
        # STANDING ON the dash top (z ≈ 1.64 at y ≈ 0.94, cast), in front of its edge — behind it the cowl hid the
        # screen's lower half from the eye.
        top, _ = cast(P(0.16, 0.93, 1.9), Vector((0, 0, -1)))
        tz = local(top).z if top is not None else 1.64
        screen_fixed(0.16, 0.925, tz + 0.127 / 2 + 0.012, 0.62, 0.127, (0.0, 0.0, 1.0, 1.0), 'dial_g500')
        print('g500 screen on dash top', round(tz, 3))
        for x, z in ((-0.12, 1.47), (0.02, 1.47), (0.66, 1.62), (-0.62, 1.62)):
            dv = (P(x, 0.8, z) - eye).normalized()
            loc, nrm = cast(eye, dv)
            if loc is not None:
                cab.disc(loc - dv * 0.005 * k, -dv, 0.045, BLACK, 12, depth=0.02, rim=CHROME)
                cab.ring(loc - dv * 0.008 * k, -dv, 0.045, 0.006, CHROME, 12, 3)
        cab.tube(P(-0.62, 0.95, 1.6), P(-0.22, 0.95, 1.6), 0.016, LEATHER, 8)
        fz = floor_at(0, 1.45)
        cab.box(P(0, 1.5, fz + 0.3), (0.26, 0.75, 0.6), BLACK)
        cab.box(P(0, 1.38, fz + 0.61), (0.22, 0.4, 0.02), WOOD)
        for x in (-0.05, 0, 0.05):
            cab.box(P(x, 1.12, fz + 0.68), (0.03, 0.02, 0.03), CHROME)
        gear(0.0, 1.5, top_h=0.3, auto=True, base_z=fz + 0.62)                               # on the console
        for nm, x, pad in (('pedal_brake', 0.42, (0.13, 0.025, 0.07)), ('pedal_gas', 0.27, (0.06, 0.02, 0.17))):
            pedal(nm, x, 0.72, 1.45, 0.82, pad=pad)
        wipers([(0.365, 0.69, 1.58), (-0.19, 0.69, 1.58)], 0.42, (-1, 0, 0.35))
    built.append(cab.finish('cab_' + NAME.split('_')[0]))
    meshes = [o for o in sc.objects if o.type == 'MESH']
    # Budget (≤ 40 k): the G500's hidden underbody details take the cut (as vehicle_details.py did).
    if tris(meshes) > 40000:
        for o in sorted([o for o in meshes if re.search('chassis_details', o.name) and 'Carbon' not in o.name], key=lambda o: -len(o.data.polygons))[:1]:
            mod = o.modifiers.new('dec', 'DECIMATE'); mod.ratio = max(0.3, 1 - (tris(meshes) - 39000) / max(1, tris([o])))
            with bpy.context.temp_override(object=o, active_object=o):
                bpy.ops.object.modifier_apply(modifier=mod.name)
        meshes = [o for o in sc.objects if o.type == 'MESH']
    # one material per role: merge duplicates the glTF import made (glass.001, wheel_hw.003…)
    for o in meshes:
        for s_ in o.material_slots:
            if s_.material and s_.material.name.startswith('wheel_hw') and s_.material != WHEEL_MAT:
                s_.material = WHEEL_MAT
            elif s_.material and re.match(r'^(glass|dial)\.\d+$', s_.material.name):
                s_.material = bpy.data.materials[s_.material.name.split('.')[0]]
    print('tris after build', tris(meshes), 'mats', sorted({s_.material.name for o in meshes for s_ in o.material_slots if s_.material}))

    if globals().get('BAKE', '1') == '1':
        sc.render.engine = 'CYCLES'; sc.cycles.samples = int(globals().get('SAMPLES', '48')); sc.cycles.device = 'CPU'
        if not sc.world:
            sc.world = bpy.data.worlds.new('ao_world')
        sc.world.light_settings.distance = 0.9 * k
        glassy = [o for o in meshes if o.material_slots and all(s.material == glass or (s.material and re.search('glas|light|glow', s.material.name, re.I)) for s in o.material_slots)]
        for o in glassy:
            o.hide_render = True
        keep = [o for o in meshes if o.name.startswith(('wheel_', 'caliper_', 'dial_'))]
        bake = [o for o in meshes if o not in glassy and o not in keep]
        own = [o for o in built if not o.name.startswith('dial_')]
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
                c_ = col.data[i].color
                col.data[i].color = (c_[0] * a, c_[1] * a, c_[2] * a, 1.0)
            attrs.remove(ao)
            attrs.active_color = col
        for o in glassy:
            o.hide_render = False
        sc['vertex_ao'] = 1
    for o in meshes:
        attrs = o.data.color_attributes
        if len(attrs) and attrs.active_color is None:
            attrs.active_color = attrs[0]
        if len(attrs):
            attrs.render_color_index = attrs.active_color_index
    path = OUT + NAME + '.lod0.glb'
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_active_scene=True, export_extras=True,
                              export_cameras=False, export_lights=False, export_animations=False, export_yup=True,
                              export_vertex_color='ACTIVE')
    print('exported', path, os.path.getsize(path), 'tris', tris(meshes), 'mats', len({s.material.name for o in meshes for s in o.material_slots if s.material}))
    # driver's-view check render (Workbench)
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'
    sc.display.shading.color_type = 'VERTEX'
    sc.render.resolution_x, sc.render.resolution_y = 960, 540
    cam_d = bpy.data.cameras.new('chk'); cam_d.clip_start = 0.02 * k; cam_d.lens = 15
    cam = bpy.data.objects.new('chk', cam_d); sc.collection.objects.link(cam); sc.camera = cam
    sc.display.shading.color_type = 'TEXTURE'
    for nm, at, look in (('built_driver', eye, P(ex, ey - 3, ez - 0.9)), ('built_out', P(-3.0, -2.6, 2.1), P(0, wb * 0.4, 1.1)), ('built_side', P(-3.6, wb * 0.35, 1.6), P(0, wb * 0.35, 1.3))):
        cam.location = at
        cam.rotation_euler = (look - at).to_track_quat('-Z', 'Y').to_euler()
        sc.render.filepath = OUT + NAME + '_' + nm + '.png'
        bpy.ops.render.render(write_still=True)

if MODE == 'REAR':
    # The back of the (built) car, and the cabin looking back — the rear window check.
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'
    sc.display.shading.color_type = 'TEXTURE'
    sc.render.resolution_x, sc.render.resolution_y = 800, 450
    cam_d = bpy.data.cameras.new('rear'); cam_d.clip_start = 0.02 * k; cam_d.lens = 28
    cam = bpy.data.objects.new('rear', cam_d); sc.collection.objects.link(cam); sc.camera = cam
    tail = max(local(o.matrix_world @ v.co).y for o in meshes for v in o.data.vertices)
    for nm, at, look, lens in (('rear_out', P(1.6, tail + 3.2, 1.9), P(0, tail, 1.3), 28), ('rear_in', P(0.3, 0.9, 1.5), P(0, tail, 1.3), 18)):
        cam.location = at; cam_d.lens = lens
        cam.rotation_euler = (look - at).to_track_quat('-Z', 'Y').to_euler()
        sc.render.filepath = OUT + NAME + '_' + nm + '.png'
        bpy.ops.render.render(write_still=True)
    print('tail', round(tail, 2))
