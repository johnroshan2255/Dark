"""
PLAYER CHARACTER for DARK (run inside Blender 5.x — Text Editor or the MCP add-on via scripts/blender: bl.mjs).

A stylized (Genshin-proportioned, ~7 heads) adult in a T-POSE, 1.78 m, built as ONE smooth continuous body:
  - BODY: a vertex skeleton (pelvis → waist → chest → neck, hips → knees → ankles → toes, clavicles → shoulders →
    elbows → wrists → hands) with per-joint radii, turned into a smooth quad skin by the SKIN modifier + one level of
    subdivision — no seams between limbs, so it bends cleanly when skinned;
  - HEAD: a smooth ovoid with a jaw taper, two eyes, HAIR (a cap with a fringe, cut away over the face);
  - CLOTHES by vertex colour: dark-blue jacket over a white shirt line, brown belt, charcoal trousers, brown boots,
    skin on the face / neck / hands.
The joints sit exactly at the landmarks CharacterModel.ts expects (SRC, metres; facing +Z after glTF export, +X =
the character's LEFT) — the game rigs and animates it in code (15 bones, foot-planting IK, car / bike poses).
Exports src/assets/models/characters/human.lod0.glb (one mesh, POSITION / NORMAL / COLOR_0). ~4–5 k triangles.
"""
import bpy, bmesh, math, os
from mathutils import Vector

OUT = globals().get('OUT', 'C:/Project/Dark/src/assets/models/characters/human.lod0.glb')

# Landmarks (metres, Blender Z up, front = −Y). Must match CharacterModel.ts SRC.
L = dict(sole=0.0, ankle=0.085, knee=0.5, hip=0.9, pelvis=0.96, chest=1.26, shoulderY=1.44, neck=1.5,
         shoulderX=0.19, elbowX=0.465, wristX=0.705, handX=0.79, legX=0.092, top=1.78)


def srgb(h):
    c = [((h >> s) & 255) / 255 for s in (16, 8, 0)]
    return tuple((x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


SKIN, HAIR, JACKET, SHIRT, BELT, PANTS, BOOT, EYE = (srgb(h) for h in (0xf4d2bc, 0x3a2a24, 0x2f4a78, 0xeeeae2, 0x6a4a30, 0x3a3a44, 0x5a3c26, 0x2a2a3a))

sc = bpy.data.scenes.get('human') or bpy.data.scenes.new('human')
win = bpy.context.window_manager.windows[0]
win.scene = sc
for o in list(sc.objects):
    if o.type != 'CAMERA':
        bpy.data.objects.remove(o)


def link(me, name):
    ob = bpy.data.objects.new(name, me)
    sc.collection.objects.link(ob)
    return ob


# ---- BODY: skin-modifier skeleton ---------------------------------------------------------------------------
V = []        # (x, y, z, rx, ry)
E = []


def v(x, y, z, rx, ry=None):
    V.append((x, y, z, rx, ry if ry is not None else rx))
    return len(V) - 1


pel = v(0, 0.008, L['pelvis'], 0.165, 0.115)
waist = v(0, 0.004, 1.1, 0.14, 0.105)
chest = v(0, -0.008, L['chest'], 0.175, 0.125)
upper = v(0, 0.0, 1.39, 0.185, 0.115)
neck0 = v(0, 0.01, L['neck'], 0.058, 0.058)
neck1 = v(0, 0.005, 1.57, 0.052, 0.054)
E += [(pel, waist), (waist, chest), (chest, upper), (upper, neck0), (neck0, neck1)]
for s in (1, -1):
    x = L['legX'] * s
    hp = v(x, 0.0, L['hip'], 0.1, 0.105)
    th = v(x, -0.005, 0.72, 0.085, 0.09)
    kn = v(x, -0.01, L['knee'], 0.06, 0.063)
    cf = v(x, 0.006, 0.33, 0.065, 0.068)   # calf
    an = v(x, 0.0, L['ankle'] + 0.03, 0.05, 0.055)   # boot shaft
    hl = v(x, 0.02, 0.04, 0.048, 0.045)  # heel
    ball = v(x, -0.095, 0.04, 0.052, 0.04)
    toe = v(x, -0.15, 0.035, 0.045, 0.033)
    E += [(pel, hp), (hp, th), (th, kn), (kn, cf), (cf, an), (an, hl), (hl, ball), (ball, toe)]
    cl = v(0.08 * s, 0.0, 1.43, 0.07, 0.065)
    sh = v(L['shoulderX'] * s, 0.0, L['shoulderY'], 0.068, 0.066)
    bi = v(0.33 * s, 0.0, L['shoulderY'], 0.054, 0.056)
    el = v(L['elbowX'] * s, 0.0, L['shoulderY'], 0.043, 0.045)
    fa = v(0.58 * s, 0.0, L['shoulderY'], 0.044, 0.04)
    wr = v(L['wristX'] * s, 0.0, L['shoulderY'], 0.028, 0.024)
    pa = v(0.75 * s, 0.0, L['shoulderY'] - 0.005, 0.043, 0.02)  # palm
    fi = v(L['handX'] * s, 0.0, L['shoulderY'] - 0.01, 0.035, 0.015)  # fingers
    E += [(upper, cl), (cl, sh), (sh, bi), (bi, el), (el, fa), (fa, wr), (wr, pa), (pa, fi)]
    th_ = v(0.73 * s, -0.035, L['shoulderY'] - 0.005, 0.016, 0.016)  # thumb
    E += [(wr, th_)]

me = bpy.data.meshes.new('body_skel')
me.from_pydata([p[:3] for p in V], E, [])
body = link(me, 'body')
skin = body.modifiers.new('skin', 'SKIN')
skin.branch_smoothing = 0.4
skin.use_smooth_shade = True
sv = me.skin_vertices[0].data
for i, p in enumerate(V):
    sv[i].radius = (p[3], p[4])
sv[pel].use_root = True
sub = body.modifiers.new('sub', 'SUBSURF')
sub.levels = 1
dg = bpy.context.evaluated_depsgraph_get()
body_me = bpy.data.meshes.new_from_object(body.evaluated_get(dg))
bpy.data.objects.remove(body)
body = link(body_me, 'body')

# ---- HEAD, EYES, HAIR ---------------------------------------------------------------------------------------
HEAD_C = Vector((0, -0.005, 1.655))


def ovoid(name, c, r, seg=20, rings=14, fn=None):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=1.0)
    for vv in bm.verts:
        p = vv.co
        x, y, z = p.x * r[0], p.y * r[1], p.z * r[2]
        if fn:
            x, y, z = fn(x, y, z)
        vv.co = Vector((x, y, z)) + c
    m = bpy.data.meshes.new(name)
    bm.to_mesh(m)
    bm.free()
    for poly in m.polygons:
        poly.use_smooth = True
    return link(m, name)


def head_shape(x, y, z):
    # Jaw / chin taper below the middle, a slightly flatter face front.
    if z < 0:
        k = 1 - 0.28 * min(1, -z / 0.12)
        x *= k
        y *= 1 - 0.12 * min(1, -z / 0.12)
    if y < 0:
        y *= 0.92
    return x, y, z


head = ovoid('head', HEAD_C, (0.088, 0.1, 0.118), 24, 16, head_shape)
eyes = []
for s in (1, -1):
    eyes.append(ovoid('eye', HEAD_C + Vector((0.034 * s, -0.087, 0.004)), (0.013, 0.006, 0.019), 10, 6))


def hair_shape(x, y, z):
    return x, y, z


ears = [ovoid('ear', HEAD_C + Vector((0.087 * s, 0.005, -0.005)), (0.014, 0.022, 0.03), 8, 6) for s in (1, -1)]
brows = [ovoid('brow', HEAD_C + Vector((0.035 * s, -0.09, 0.034)), (0.02, 0.004, 0.0045), 8, 4) for s in (1, -1)]
mouth = ovoid('mouth', HEAD_C + Vector((0, -0.088, -0.06)), (0.012, 0.003, 0.003), 8, 4)
shines = [ovoid('shine', HEAD_C + Vector((0.034 * s + 0.004, -0.0935, 0.011)), (0.004, 0.002, 0.005), 6, 4) for s in (1, -1)]
hair = ovoid('hair', HEAD_C + Vector((0, 0.008, 0.022)), (0.1, 0.112, 0.118), 40, 24)
bm = bmesh.new()
bm.from_mesh(hair.data)
rel = HEAD_C + Vector((0, 0.008, 0.022))
# FRINGE: a clean tilted cut across the FRONT half only (side-swept: lower on the character's left), so the edge is
# a smooth line, not stair-steps of deleted vertices; then trim the nape and the sides in front of the ears.
front = [f for f in bm.faces if (f.calc_center_median() - rel).y < 0.01]
geom = list({e for f in front for e in f.edges} | {vv for f in front for vv in f.verts}) + front
bmesh.ops.bisect_plane(bm, geom=geom, plane_co=rel + Vector((0, -0.1, 0.03)), plane_no=Vector((-0.28, -0.55, 1.0)).normalized(), clear_inner=True)
kill = [vv for vv in bm.verts if (vv.co - rel).z < -0.09 or (abs((vv.co - rel).x) > 0.06 and (vv.co - rel).z < -0.03 and (vv.co - rel).y < 0.0)]
bmesh.ops.delete(bm, geom=kill, context='VERTS')
bm.to_mesh(hair.data)
bm.free()
# Thickness so the cap has an inside (no see-through from below).
sol = hair.modifiers.new('sol', 'SOLIDIFY')
sol.thickness = 0.008
sol.offset = 1
dg = bpy.context.evaluated_depsgraph_get()
hm = bpy.data.meshes.new_from_object(hair.evaluated_get(dg))
bpy.data.objects.remove(hair)
hair = link(hm, 'hair')

# ---- COLOURS (per corner) -----------------------------------------------------------------------------------


def body_colour(p):
    x, y, z = p
    ax = abs(x)
    if z > 1.505:
        return SKIN                                   # neck
    if ax > L['wristX'] - 0.015 and z > 1.3:
        return SKIN                                   # hands
    if z < 0.12:
        return BOOT
    if ax > L['shoulderX'] + 0.02 and z > 1.3:
        return JACKET if ax < 0.66 else SHIRT        # sleeves, white cuffs
    if (z > 1.47 and ax < 0.085) or (z > 1.33 and ax < 0.03 * (z - 1.33) / 0.14 + 0.004 and y < -0.06):
        return SHIRT                                  # collar band + a narrow shirt V
    if 0.9 < z < 0.98:
        return BELT
    if z >= 0.98:
        return JACKET
    if z < 0.16:
        return PANTS
    return PANTS


def paint(ob, fn):
    m = ob.data
    ca = m.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
    for poly in m.polygons:
        for li in poly.loop_indices:
            p = m.vertices[m.loops[li].vertex_index].co
            c = fn(p)
            ca.data[li].color = (*c, 1.0)
    m.color_attributes.active_color = ca


paint(body, body_colour)
paint(head, lambda p: SKIN)
for e in eyes:
    paint(e, lambda p: EYE)
paint(hair, lambda p: HAIR)
for e in ears:
    paint(e, lambda p: SKIN)
for b_ in brows:
    paint(b_, lambda p: HAIR)
paint(mouth, lambda p: srgb(0xb0605a))
for e in shines:
    paint(e, lambda p: (1.0, 1.0, 1.0))

# ---- JOIN + MATERIAL + EXPORT -------------------------------------------------------------------------------
mat = bpy.data.materials.get('human') or bpy.data.materials.new('human')
mat.use_nodes = True
nt = mat.node_tree
if not any(n.bl_idname == 'ShaderNodeVertexColor' for n in nt.nodes):
    vc = nt.nodes.new('ShaderNodeVertexColor')
    vc.layer_name = 'Col'
    nt.links.new(vc.outputs['Color'], nt.nodes['Principled BSDF'].inputs['Base Color'])
parts = [body, head, hair, mouth] + eyes + ears + brows + shines
for ob in parts:
    ob.data.materials.clear()
    ob.data.materials.append(mat)
with bpy.context.temp_override(window=win, scene=sc, active_object=body, selected_editable_objects=parts, selected_objects=parts):
    bpy.ops.object.join()
body.name = 'human'
tris = sum(len(p.vertices) - 2 for p in body.data.polygons)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with bpy.context.temp_override(window=win, scene=sc):
    bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_active_scene=True, export_cameras=False,
                              export_lights=False, export_animations=False, export_yup=True,
                              export_vertex_color='MATERIAL', export_normals=True)
result = {'tris': tris, 'bytes': os.path.getsize(OUT),
          'bounds': [round(min(v.co[i] for v in body.data.vertices), 3) for i in range(3)] + [round(max(v.co[i] for v in body.data.vertices), 3) for i in range(3)]}
