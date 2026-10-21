import os
WORK = os.environ.get('HERO_WORK', 'C:/tmp/hero')  # intermediate .blend files, renders, exports, mixamo/
SCRIPTS = os.environ.get('HERO_SCRIPTS', 'C:/Project/Dark/scripts/blender/hero')
# Step 4: A-pose (arms rotated 40° out about the shoulder joints) for Mixamo's auto-rigger.
import bpy, math
from mathutils import Vector, Matrix
SP = WORK
bpy.ops.wm.open_mainfile(filepath=SP + r"\hero_step4a.blend")
hero = bpy.data.objects['hero']
ANGLE = math.radians(40)
arm = bpy.data.armatures.new('tmp'); rig = bpy.data.objects.new('tmp_rig', arm)
bpy.context.scene.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
win = bpy.context.window_manager.windows[0]; area = next(a for a in win.screen.areas if a.type == 'VIEW_3D')
ctx = dict(window=win, area=area, region=next(r for r in area.regions if r.type == 'WINDOW'))
with bpy.context.temp_override(**ctx, active_object=rig, object=rig):
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.edit_bones
    body = eb.new('body'); body.head = (0, 0, -0.95); body.tail = (0, 0, 0.95)
    for side in (1, -1):
        k = hero['cut%+d' % side]; C = Vector(k[:3])
        sh = Vector((0.215 * side, 0.0, 0.55))
        up = eb.new('arm%+d' % side); up.head = sh; up.tail = C; up.parent = body
        hand = eb.new('hand%+d' % side); hand.head = C; hand.tail = C + (C - sh).normalized() * 0.17; hand.parent = up; hand.use_connect = True
    bpy.ops.object.mode_set(mode='OBJECT')
hero.select_set(True); rig.select_set(True); bpy.context.view_layer.objects.active = rig
with bpy.context.temp_override(**ctx, active_object=rig, object=rig, selected_objects=[hero, rig], selected_editable_objects=[hero, rig]):
    bpy.ops.object.parent_set(type='ARMATURE_NAME')
groups = {g.name: g.index for g in hero.vertex_groups}
# exact arm weights below the armpit: the arm piece (reachable from the hand below ZA) is 1, the torso 0; above ZA the
# heat weights (shoulder cap), faded out on the torso side over ZA..ZA+0.08
import bmesh
ZA = 0.335   # below the slit tops (the armpit, where arm and jacket stay joined)
def sst(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a))); return t * t * (3 - 2 * t)
me = hero.data
bm = bmesh.new(); bm.from_mesh(me); bm.verts.ensure_lookup_table()
ihl = bm.verts.layers.float['is_hand']
for side in (1, -1):
    k = hero['cut%+d' % side]; P = Vector(k[:3]) - Vector(k[3:]) * 0.09   # on the forearm axis above the wrist (hands are separate shells)
    seed = min((v for v in bm.verts if v[ihl] < 0.5), key=lambda v: (v.co - P).length)
    armset = {seed.index}; st = [seed]
    while st:
        a = st.pop()
        for e in a.link_edges:
            b = e.other_vert(a)
            if b.index not in armset and b.co.z < ZA: armset.add(b.index); st.append(b)
    print("seed", side, tuple(round(x, 3) for x in seed.co), "P", tuple(round(x, 3) for x in P), "armset", len(armset))
    assert len(armset) > 300, "arm seed on a fragment"
    leak = sum(1 for i in armset if abs(bm.verts[i].co.x) < 0.12)
    print('side', side, 'arm piece verts', len(armset), 'leak toward the centre', leak)
    ga, gh, gb = hero.vertex_groups['arm%+d' % side], hero.vertex_groups['hand%+d' % side], hero.vertex_groups['body']
    S = Vector((0.215 * side, 0.0, 0.55)); d = (Vector(k[:3]) - S).normalized()
    for v in me.vertices:
        if v.co.x * side <= 0.0: continue
        if bm.verts[v.index][ihl] > 0.5:
            gh.add([v.index], 1.0, 'REPLACE'); continue
        geo = sst(-0.10, 0.02, (v.co - S).dot(d)) * sst(0.14, 0.23, v.co.x * side)   # shoulder cap blend
        if v.index in armset: w = 1.0
        elif v.co.z < ZA: w = 0.0                                                      # the jacket side under the armpit stays
        else:
            # above the armpit only the sleeve side of the crease line (|x| ≈ 0.21) follows the arm — the jacket's side
            # panel stays put (it was dragged out with the arm: 'wings'); the full shoulder blend near the top
            armness = sst(0.195, 0.225, v.co.x * side)
            w = geo * (armness + (1 - armness) * sst(0.44, 0.52, v.co.z))
        if w > 0: ga.add([v.index], w, 'REPLACE')
# soften the arm weights over the shoulder band (no kinks between the sleeve and the jacket)
import bmesh as _bm
bm2 = _bm.new(); bm2.from_mesh(me); bm2.verts.ensure_lookup_table()
ih2 = bm2.verts.layers.float['is_hand']
for side in (1, -1):
    g = hero.vertex_groups['arm%+d' % side]
    def wt(i):
        try: return g.weight(i)
        except RuntimeError: return 0.0
    band = [v for v in bm2.verts if v[ih2] < 0.5 and ZA - 0.02 < v.co.z < 0.56 and v.co.x * side > 0.1 and wt(v.index) < 0.999]
    for _ in range(3):
        new = {}
        for v in band:
            nb = [e.other_vert(v).index for e in v.link_edges]
            new[v.index] = 0.5 * wt(v.index) + 0.5 * sum(wt(i) for i in nb) / max(1, len(nb))
        for i, w in new.items(): g.add([i], w, 'REPLACE')
bm2.free()
for v in me.vertices:
    tot = sum(g.weight for g in v.groups if hero.vertex_groups[g.group].name != 'body')
    hero.vertex_groups['body'].add([v.index], max(0.0, 1.0 - tot), 'REPLACE')
bm.free()
groups = {g.name: g.index for g in hero.vertex_groups}
print('groups', list(groups))
# weight sanity: how many verts are mostly on the arms
me = hero.data
cnt = {n: 0 for n in groups}
for v in me.vertices:
    if v.groups:
        g = max(v.groups, key=lambda g: g.weight); cnt[hero.vertex_groups[g.group].name] += 1
print('dominant counts', cnt)
for side in (1, -1):
    pb = rig.pose.bones['arm%+d' % side]
    pb.rotation_mode = 'XYZ'
    # rotate in armature space about +Y (front axis is -Y): left arm (+X) swings up/out with −angle about Y... use world axis
    sh = pb.head.copy()
    R = Matrix.Rotation(-side * ANGLE, 4, 'Y')
    M = Matrix.Translation(sh) @ R @ Matrix.Translation(-sh)
    pb.matrix = M @ pb.matrix
bpy.context.view_layer.update()
for side in (1, -1):
    k = hero['cut%+d' % side]; C = Vector(k[:3])
    print('hand', side, 'moves to', tuple(round(x, 3) for x in (rig.pose.bones['hand%+d' % side].head)))
bpy.ops.wm.save_as_mainfile(filepath=SP + r"\hero_step4_posed.blend")
exec(open(SCRIPTS + '/render_lib.py').read())
setup(); sh_ = bpy.context.scene.display.shading; sh_.color_type = 'SINGLE'; sh_.single_color = (0.8, 0.8, 0.8)
rig.hide_render = True
shot('apose_front', (0, 0, 0.1), 6, 0, 0, ortho=2.0)
shot('apose_shoulder', (-0.25, 0, 0.45), 6, -20, 10, ortho=0.6)
shot('apose_shoulder_b', (-0.25, 0, 0.45), 6, 200, 10, ortho=0.6)
