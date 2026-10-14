import os
WORK = os.environ.get('HERO_WORK', 'C:/tmp/hero')  # intermediate .blend files, renders, exports, mixamo/
SCRIPTS = os.environ.get('HERO_SCRIPTS', 'C:/Project/Dark/scripts/blender/hero')
# Step 6: Mixamo rig + clips → one rig with one baked action per clip (NLA tracks).
# The clip FBXs carry a T-pose rest while the character's rest is its A-pose: each clip is RETARGETED — the
# character's bones follow the clip rig in world space (copy rotation; hips also copy location) and are baked.
import bpy
SP = WORK
MX = SCRIPTS + '/../../../refer/characters/hero/mixamo'  # Mixamo exports + the FBX that was uploaded (see README)
CLIPS = ['idle', 'walk', 'jog', 'run', 'sprint', 'walk_back', 'strafe_left', 'strafe_right', 'jump', 'fall', 'land', 'knockdown', 'get_up']
CLIPS = globals().get('CLIP_SUBSET', CLIPS)
SHOULDER = globals().get('SHOULDER', (0.26, 1.41))   # (x, z) m: Mixamo's (0.275, 1.33) sat low in the padded shoulder; raised 8 cm (higher made coat-hanger shoulders, further in swung the arms into the torso)
OUT_BLEND = globals().get('OUT_BLEND', SP + '/hero_step6_rigged.blend')
bpy.ops.wm.read_homefile(use_empty=True)
def ctx():
    win = bpy.context.window_manager.windows[0]
    area = next((a for a in win.screen.areas if a.type == 'VIEW_3D'), win.screen.areas[0])
    return dict(window=win, area=area, region=next(r for r in area.regions if r.type == 'WINDOW'))
def fbx(path):
    with bpy.context.temp_override(**ctx()):
        bpy.ops.import_scene.fbx(filepath=path, automatic_bone_orientation=False)
fbx(MX + '/character.fbx')
rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE'); rig.name = 'hero_rig'
mesh = next(o for o in bpy.data.objects if o.type == 'MESH'); mesh.name = 'hero'
for a in list(bpy.data.actions): bpy.data.actions.remove(a)
# --- RESHAPE the rigged mesh to the corrected A-pose (build4/build5: armpits back on the jacket, head tilted back),
# keeping Mixamo's skeleton and skin weights. Mixamo's mesh = the uploaded FBX vertex for vertex (matched by
# position), and that FBX = the build5 mesh by index. Moved armpit vertices take the weights of their nearest
# unmoved neighbour on the NEW shape (the jacket side then follows the spine, not the arm); the head keeps its own.
import numpy as np
from mathutils.kdtree import KDTree
before = set(bpy.data.objects)
fbx(MX + '/hero_apose_upload.fbx')
old = next(o for o in bpy.data.objects if o not in before and o.type == 'MESH')
with bpy.data.libraries.load(SP + '/hero_step5_apose.blend') as (src, dst): dst.objects = ['hero']
new = dst.objects[0]
W = lambda o: np.array([(o.matrix_world @ v.co)[:] for v in o.data.vertices])
Pm, Po, Pn = W(mesh), W(old), W(new)
assert len(Po) == len(Pn), 'build5 topology changed — re-upload to Mixamo'
kd = KDTree(len(Po))
for i, p in enumerate(Po): kd.insert(p, i)
kd.balance()
idx = []
for p in Pm:
    co, i, dist = kd.find(p); assert dist < 1e-4, 'Mixamo mesh does not match the uploaded FBX'; idx.append(i)
target = Pn[idx]
moved = np.linalg.norm(target - Pm, axis=1) > 0.002
fix = moved & (target[:, 2] < 1.38)                     # armpit / jacket side (the head keeps its weights)
inv = mesh.matrix_world.inverted()
from mathutils import Vector
for i, v in enumerate(mesh.data.vertices): v.co = inv @ Vector(target[i])
# UVs too (build4a's caps may have new UVs): polygons matched by their (mapped) vertex sets
nm, mm = new.data, mesh.data
nuv, muv = nm.uv_layers.active.data, mm.uv_layers.active.data
by_set = {frozenset(p.vertices): p for p in nm.polygons}
copied = missing = 0
for p in mm.polygons:
    q = by_set.get(frozenset(idx[v] for v in p.vertices))
    if q is None: missing += 1; continue
    nloop = {nm.loops[li].vertex_index: li for li in q.loop_indices}
    for li in p.loop_indices:
        muv[li].uv = nuv[nloop[idx[mm.loops[li].vertex_index]]].uv
    copied += 1
print('uv polygons copied', copied, 'unmatched', missing)
kd2 = KDTree(int((~fix).sum()))
for i in np.nonzero(~fix)[0]: kd2.insert(target[i], int(i))
kd2.balance()
vg = mesh.vertex_groups
src_w = {i: [(g.group, g.weight) for g in mesh.data.vertices[i].groups] for i in range(len(Pm))}
for i in np.nonzero(fix)[0]:
    _, j, _ = kd2.find(target[i])
    v = mesh.data.vertices[int(i)]
    for g in list(v.groups): vg[g.group].remove([v.index])
    for gi, w in src_w[j]: vg[gi].add([v.index], w, 'REPLACE')
# ARM vs TORSO share from build4's geometric weights (same vertex order as build5 = the upload): Mixamo had the whole
# upper sleeve on the spine (it rigged the padded A-pose sleeve as torso) → when the arm swung, the top of the sleeve
# stayed and the arm came out from under the shoulder, the band between stretched thin. Each vertex keeps Mixamo's
# split among Arm / ForeArm / Hand / finger bones, scaled to build4's arm share; the rest goes to the torso bones.
with bpy.data.libraries.load(SP + '/hero_step4_posed.blend') as (src4, dst4): dst4.objects = ['hero']
o4 = dst4.objects[0]
g4 = {g.name: g.index for g in o4.vertex_groups}
def share4(j, s):
    return min(1.0, sum(g.weight for g in o4.data.vertices[j].groups if g.group in (g4['arm%+d' % s], g4['hand%+d' % s])))
gname = {g.index: g.name for g in vg}
def chain_side(n):
    n = n.replace('mixamorig:', '')
    for side in ('Left', 'Right'):
        if n.startswith(side) and n != side + 'Shoulder' and any(k in n for k in ('Arm', 'Hand')): return side
    return None
side_of = {'Left': 1, 'Right': -1}
# which build4 side is Mixamo's 'Left'? (+X in Blender = the character's left)
lx = (rig.matrix_world @ rig.data.bones['mixamorig:LeftArm'].head_local).x
s4 = {'Left': 1 if lx > 0 else -1, 'Right': -1 if lx > 0 else 1}
changed = 0
for i, v in enumerate(mesh.data.vertices):
    j = idx[i]
    a = {sd: share4(j, s4[sd]) for sd in ('Left', 'Right')}
    ws = {gname[g.group]: g.weight for g in v.groups if g.weight > 0}
    chain = {sd: {n: w for n, w in ws.items() if chain_side(n) == sd} for sd in ('Left', 'Right')}
    torso = {n: w for n, w in ws.items() if chain_side(n) is None}
    tot_a = a['Left'] + a['Right']
    if tot_a < 1e-3 and not chain['Left'] and not chain['Right']: continue
    new = {}
    for sd in ('Left', 'Right'):
        if a[sd] < 1e-3: continue
        cs = sum(chain[sd].values())
        if cs < 1e-4: new['mixamorig:%sArm' % sd] = a[sd]
        else:
            for n, w in chain[sd].items(): new[n] = new.get(n, 0) + a[sd] * w / cs
    rem = max(0.0, 1.0 - tot_a)
    if rem > 1e-4:
        ts = sum(torso.values())
        if ts < 1e-4: torso = {'mixamorig:Spine2': 1.0}; ts = 1.0
        for n, w in torso.items(): new[n] = new.get(n, 0) + rem * w / ts
    for g in list(v.groups): vg[g.group].remove([v.index])
    for n, w in new.items():
        if w > 1e-4: vg[n].add([v.index], w, 'REPLACE')
    changed += 1
bpy.data.objects.remove(o4, do_unlink=True)
print('arm/torso shares from build4:', changed, 'vertices')
bpy.data.objects.remove(old, do_unlink=True)
for o in [o for o in bpy.data.objects if o not in (rig, mesh) and o.type in ('ARMATURE', 'EMPTY', 'MESH')]: bpy.data.objects.remove(o, do_unlink=True)
print('reshaped: moved', int(moved.sum()), 'reweighted (armpit)', int(fix.sum()))
# Slimmer upper sleeves (the generator's jacket puffs them up — read as 'wings' with the arms down): vertices pulled
# toward the upper-arm bone axis, by up to 15 % of their distance, in proportion to their upper-arm skin weight.
SLIM = 0.15
for side in ('Left', 'Right'):
    b0 = rig.matrix_world @ rig.data.bones['mixamorig:%sArm' % side].head_local
    b1 = rig.matrix_world @ rig.data.bones['mixamorig:%sForeArm' % side].head_local
    ax = (b1 - b0); L = ax.length; ax.normalize()
    gi = vg['mixamorig:%sArm' % side].index
    n = 0
    for v in mesh.data.vertices:
        w = next((g.weight for g in v.groups if g.group == gi), 0.0)
        if w < 0.05: continue
        p = mesh.matrix_world @ v.co
        t = max(0.0, min(L, (p - b0).dot(ax)))
        c = b0 + ax * t
        v.co = inv @ (p + (c - p) * (SLIM * w)); n += 1
    print('slimmed', side, n)
# FOREARM + ELBOW: the bare forearm under the rolled cuff read thin next to the sleeve — filled out radially from
# the ForeArm bone axis, +12 % at the elbow tapering to 0 at the wrist (glove untouched); and the Arm ⇄ ForeArm weight
# blend widened (3 smoothing passes over the elbow ring) so a bent elbow keeps its volume.
import bmesh as _bmesh
for side in ('Left', 'Right'):
    e = rig.matrix_world @ rig.data.bones['mixamorig:%sForeArm' % side].head_local
    w_ = rig.matrix_world @ rig.data.bones['mixamorig:%sHand' % side].head_local
    ax = (w_ - e); L = ax.length; ax.normalize()
    gf = vg['mixamorig:%sForeArm' % side].index; ga = vg['mixamorig:%sArm' % side].index
    n = 0
    for v in mesh.data.vertices:
        wf = next((g.weight for g in v.groups if g.group == gf), 0.0)
        if wf < 0.5: continue
        p = mesh.matrix_world @ v.co
        t = (p - e).dot(ax) / L
        if not (0.0 < t < 0.85): continue
        c = e + ax * (t * L)
        k = 0.12 * (1 - t / 0.85) ** 1.5
        v.co = inv @ (c + (p - c) * (1 + k)); n += 1
    # widen the elbow blend
    def wget(v, gi): return next((g.weight for g in v.groups if g.group == gi), 0.0)
    bm_ = _bmesh.new(); bm_.from_mesh(mesh.data); bm_.verts.ensure_lookup_table()
    ring_ = [v.index for v in mesh.data.vertices if 0.02 < wget(v, ga) and 0.02 < wget(v, gf)]
    zone = set(ring_)
    for i in ring_:
        for ed in bm_.verts[i].link_edges: zone.add(ed.other_vert(bm_.verts[i]).index)
    zone = list(zone)
    for _ in range(3):
        upd = {}
        for i in zone:
            nb = [ed.other_vert(bm_.verts[i]).index for ed in bm_.verts[i].link_edges]
            va, vf = mesh.data.vertices[i], None
            tot = wget(va, ga) + wget(va, gf)
            if tot < 0.5: continue
            fa = wget(va, gf) / tot
            fn = [wget(mesh.data.vertices[j], gf) / max(1e-6, wget(mesh.data.vertices[j], ga) + wget(mesh.data.vertices[j], gf)) for j in nb if wget(mesh.data.vertices[j], ga) + wget(mesh.data.vertices[j], gf) > 0.5]
            if fn: upd[i] = (tot, 0.5 * fa + 0.5 * sum(fn) / len(fn))
        for i, (tot, fa) in upd.items():
            vg[gf].add([i], tot * fa, 'REPLACE'); vg[ga].add([i], tot * (1 - fa), 'REPLACE')
    bm_.free()
    print('forearm filled', side, n, 'elbow blend verts', len(zone))
# ARMPIT: the jacket's side panel under the arm (torso-skinned) bulges out toward the arm — pulled in toward the body
# (|x| above 0.13 m compressed by up to ARMPIT_K), strongest just under the armpit, fading out at the waist and
# at the shoulder; the inner face of the upper sleeve follows partially so the two stay apart.
ARMPIT_K = globals().get('ARMPIT_K', 0.35)
if ARMPIT_K > 0:
    arm_ids = {vg['mixamorig:%s%s' % (sd, b)].index for sd in ('Left', 'Right') for b in ('Arm', 'ForeArm', 'Hand')}
    def smst(a, b, x):
        t = max(0.0, min(1.0, (x - a) / (b - a))); return t * t * (3 - 2 * t)
    n = 0
    for v in mesh.data.vertices:
        p = mesh.matrix_world @ v.co
        ax_ = abs(p.x)
        if ax_ < 0.13 or not (1.0 < p.z < 1.42): continue
        armw = sum(g.weight for g in v.groups if g.group in arm_ids)
        zf = smst(1.0, 1.15, p.z) * (1 - smst(1.30, 1.42, p.z))
        k = ARMPIT_K * zf * (1 - armw) + 0.5 * ARMPIT_K * zf * armw * (1 - smst(0.26, 0.30, ax_))
        if k <= 0: continue
        nx = 0.13 + (ax_ - 0.13) * (1 - k)
        p.x = nx if p.x > 0 else -nx
        v.co = inv @ p; n += 1
    print('armpit slimmed verts', n, 'k', ARMPIT_K)
# SHOULDER JOINTS: Mixamo put them ~8 cm outboard inside the padded jacket (x ±0.275 m), so every clip swung the
# arms out wide ('wings'). Moved to the pivot the A-pose was made about (build4: x ±0.192 m, z 1.386 m — metres,
# Blender frame), so lowering the arms returns them to the modelled shape against the body. Rest-pose edit only:
# the mesh is unchanged at rest; weights stay.
from mathutils import Vector as _V
win6 = bpy.context.window_manager.windows[0]; area6 = next((a for a in win6.screen.areas if a.type == 'VIEW_3D'), win6.screen.areas[0])
for o in bpy.data.objects: o.select_set(o is rig)
bpy.context.view_layer.objects.active = rig
with bpy.context.temp_override(window=win6, area=area6, region=next(r for r in area6.regions if r.type == 'WINDOW'), active_object=rig, object=rig):
    bpy.ops.object.mode_set(mode='EDIT')
    Minv = rig.matrix_world.inverted()
    for side, sx in (('Left', 1), ('Right', -1)):
        eb = rig.data.edit_bones['mixamorig:%sArm' % side]
        hw = rig.matrix_world @ eb.head
        # which world x sign is this side?
        sgn = 1 if hw.x > 0 else -1
        if SHOULDER is None: continue
        new = _V((sgn * SHOULDER[0], hw.y, SHOULDER[1]))
        zax = eb.z_axis.copy()
        print('shoulder', side, 'from', tuple(round(c, 3) for c in hw), 'to', tuple(round(c, 3) for c in new))
        eb.head = Minv @ new
        eb.align_roll(zax)   # keep the bone's twist frame (else the elbow candy-wraps)
        sh = rig.data.edit_bones['mixamorig:%sShoulder' % side]
        if sh.tail != eb.head and not eb.use_connect: sh.tail = eb.head
    bpy.ops.object.mode_set(mode='OBJECT')
# RAISE THE ARMS: the generator hung the whole arm low off a sloping jacket panel (shoulder line falls 14 cm from the
# neck to the arm, the armpit sits low: 'wings'). The whole arm (mesh by its arm weight + the Arm/ForeArm/Hand/finger
# bones) moves up ARM_LIFT; the top of the shoulder rises with it (blend from the neck side out to the arm), the jacket
# side below the armpit is stretched up to meet it (fading out toward the waist).
ARM_LIFT = globals().get('ARM_LIFT', 0.08)
if ARM_LIFT > 0:
    arm_ids2 = {g.index for g in mesh.vertex_groups if any(g.name.replace('mixamorig:', '').startswith(sd) and k in g.name for sd in ('Left', 'Right') for k in ('Arm', 'Hand')) and 'Shoulder' not in g.name}
    def smst2(a, b, x):
        t = max(0.0, min(1.0, (x - a) / (b - a))); return t * t * (3 - 2 * t)
    nl = 0
    for v in mesh.data.vertices:
        p = mesh.matrix_world @ v.co
        aw = min(1.0, sum(g.weight for g in v.groups if g.group in arm_ids2))
        ax_ = abs(p.x)
        cap = smst2(0.12, 0.22, ax_) * smst2(1.22, 1.40, p.z) * (1 - smst2(1.56, 1.62, p.z))   # shoulder top / side
        side = smst2(0.15, 0.21, ax_) * smst2(1.0, 1.30, p.z)                                  # jacket side under the arm
        k = max(aw, cap, side)
        if k <= 0: continue
        p.z += ARM_LIFT * k; v.co = inv @ p; nl += 1
    with bpy.context.temp_override(window=win6, area=area6, region=next(r for r in area6.regions if r.type == 'WINDOW'), active_object=rig, object=rig):
        bpy.ops.object.mode_set(mode='EDIT')
        Minv = rig.matrix_world.inverted()
        d = Minv.to_3x3() @ _V((0, 0, ARM_LIFT))
        # connected bones share head/tail: record every target first, disconnect, then assign (else moved twice)
        sel_b = [eb for eb in rig.data.edit_bones if any(eb.name.replace('mixamorig:', '').startswith(sd) for sd in ('Left', 'Right'))
                 and ('Arm' in eb.name or 'Hand' in eb.name) and 'Shoulder' not in eb.name]
        tgt = {eb.name: (eb.head + d, eb.tail + d) for eb in sel_b}
        shl = {eb.name: eb.tail + d for eb in rig.data.edit_bones if eb.name.endswith('Shoulder')}
        for eb in sel_b: eb.use_connect = False
        for n, t in shl.items(): rig.data.edit_bones[n].tail = t
        for n, (h, t) in tgt.items(): rig.data.edit_bones[n].head = h; rig.data.edit_bones[n].tail = t
        moved_b = len(sel_b)
        bpy.ops.object.mode_set(mode='OBJECT')
    print('arms raised', ARM_LIFT, 'm: verts', nl, 'bones', moved_b)
# NARROWER SHOULDERS: the arm joints sat 52 cm apart (an adult's ~40) under a padded jacket → the whole arm moves in
# ARM_IN per side (mesh by arm weight + bones); the torso above the armpit (shoulder top / cap) is squeezed in to meet
# it (0 at |x| 0.10 → full at |x| 0.26), the jacket side under the arm half as much, nothing below the chest.
ARM_IN = globals().get('ARM_IN', 0.03)
if ARM_IN > 0:
    arm_ids3 = {g.index for g in mesh.vertex_groups if any(g.name.replace('mixamorig:', '').startswith(sd) for sd in ('Left', 'Right'))
                and ('Arm' in g.name or 'Hand' in g.name) and 'Shoulder' not in g.name}
    def smst3(a, b, x):
        t = max(0.0, min(1.0, (x - a) / (b - a))); return t * t * (3 - 2 * t)
    ni = 0
    zarm = 1.38 + ARM_LIFT   # armpit height after the lift
    for v in mesh.data.vertices:
        p = mesh.matrix_world @ v.co
        ax_ = abs(p.x)
        if ax_ < 0.10: continue
        aw = min(1.0, sum(g.weight for g in v.groups if g.group in arm_ids3))
        tz = smst3(1.12, 1.30, p.z) * (0.5 + 0.5 * smst3(zarm - 0.12, zarm - 0.02, p.z))   # cap full, side half, none low
        shift = ARM_IN * (aw + (1 - aw) * smst3(0.10, 0.26, ax_) * tz)
        if shift <= 0: continue
        p.x -= shift if p.x > 0 else -shift
        v.co = inv @ p; ni += 1
    with bpy.context.temp_override(window=win6, area=area6, region=next(r for r in area6.regions if r.type == 'WINDOW'), active_object=rig, object=rig):
        bpy.ops.object.mode_set(mode='EDIT')
        Minv = rig.matrix_world.inverted()
        selb = [eb for eb in rig.data.edit_bones if any(eb.name.replace('mixamorig:', '').startswith(sd) for sd in ('Left', 'Right'))
                and ('Arm' in eb.name or 'Hand' in eb.name) and 'Shoulder' not in eb.name]
        def dv(eb):
            sgn = 1 if (rig.matrix_world @ eb.head).x > 0 else -1
            return Minv.to_3x3() @ _V((-sgn * ARM_IN, 0, 0))
        tg = {eb.name: (eb.head + dv(eb), eb.tail + dv(eb)) for eb in selb}
        sh_ = {eb.name: eb.tail + dv(eb) for eb in rig.data.edit_bones if eb.name.endswith('Shoulder')}
        for eb in selb: eb.use_connect = False
        for n, t in sh_.items(): rig.data.edit_bones[n].tail = t
        for n, (h, t) in tg.items(): rig.data.edit_bones[n].head = h; rig.data.edit_bones[n].tail = t
        bpy.ops.object.mode_set(mode='OBJECT')
    print('arms moved in', ARM_IN, 'm: verts', ni)
rig.animation_data_create()
rig.animation_data.action = None
for pb in rig.pose.bones:
    pb.rotation_mode = 'QUATERNION'
    if pb.name.endswith('Shoulder'): continue   # collarbones stay at our rest (the clip's spread them 2-3 cm wider while moving)
    c = pb.constraints.new('COPY_ROTATION'); c.name = 'rt_rot'; c.owner_space = 'WORLD'; c.target_space = 'WORLD'
    if pb.name.endswith('Hips'):
        c = pb.constraints.new('COPY_LOCATION'); c.name = 'rt_loc'; c.owner_space = 'WORLD'; c.target_space = 'WORLD'
sc = bpy.context.scene
for clip in CLIPS:
    before = set(bpy.data.objects); acts0 = set(bpy.data.actions)
    fbx(MX + '/' + clip + '.fbx')
    src = next(o for o in bpy.data.objects if o not in before and o.type == 'ARMATURE')
    # CLAVICLES: the world-rotation copy would aim our collarbone like the clip's, which points at the clip
    # skeleton's own (lower) shoulder — carrying our raised arm ~20 cm down in every clip. The clip rig's collarbone
    # rest is set to OURS, so its animated orientation = our rest + the clip's shrug delta, and that is copied.
    for o in bpy.data.objects: o.select_set(o is src)
    bpy.context.view_layer.objects.active = src
    with bpy.context.temp_override(**ctx(), active_object=src, object=src):
        bpy.ops.object.mode_set(mode='EDIT')
        Sinv = src.matrix_world.inverted()
        for sd in ('Left', 'Right'):
            nm = 'mixamorig:%sShoulder' % sd
            ob = rig.data.bones[nm]
            hw = rig.matrix_world @ ob.head_local; tw = rig.matrix_world @ ob.tail_local
            zw = (rig.matrix_world.to_3x3() @ ob.matrix_local.to_3x3().col[2]).normalized()
            arm = src.data.edit_bones['mixamorig:%sArm' % sd]; arm.use_connect = False
            eb = src.data.edit_bones[nm]
            eb.head = Sinv @ hw; eb.tail = Sinv @ tw
            eb.align_roll((Sinv.to_3x3() @ zw).normalized())
        bpy.ops.object.mode_set(mode='OBJECT')
    sact = [a for a in bpy.data.actions if a not in acts0][0]
    f0, f1 = int(sact.frame_range[0]), int(sact.frame_range[1])
    for pb in rig.pose.bones:
        for c in pb.constraints:
            c.target = src; c.subtarget = pb.name
    for o in bpy.data.objects: o.select_set(o is rig)
    bpy.context.view_layer.objects.active = rig
    with bpy.context.temp_override(**ctx(), active_object=rig, object=rig, selected_objects=[rig]):
        bpy.ops.object.mode_set(mode='POSE')
        bpy.ops.pose.select_all(action='SELECT')
        bpy.ops.nla.bake(frame_start=f0, frame_end=f1, only_selected=False, visual_keying=True, clear_constraints=False,
                         use_current_action=False, bake_types={'POSE'})
        bpy.ops.object.mode_set(mode='OBJECT')
    act = rig.animation_data.action; act.name = clip; act.use_fake_user = True
    rig.animation_data.action = None
    tr = rig.animation_data.nla_tracks.new(); tr.name = clip
    st = tr.strips.new(clip, f0, act); st.name = clip
    for o in [o for o in bpy.data.objects if o not in before]: bpy.data.objects.remove(o, do_unlink=True)
    bpy.data.actions.remove(sact)
    print('clip', clip, 'frames', f0, f1)
for pb in rig.pose.bones:
    for c in list(pb.constraints): pb.constraints.remove(c)
    pb.location = (0, 0, 0); pb.rotation_quaternion = (1, 0, 0, 0)
bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND)
