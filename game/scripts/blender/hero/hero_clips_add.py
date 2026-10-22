"""
EXTRA CLIPS for the hero without rebuilding it (build6 / build7 need the step files): Mixamo clips (FBX, without
skin, 30 fps — README) onto the rig of the shipped `hero.lod0.glb`, exported as an animation-only GLB (the rig's
nodes, no mesh): the game adds them to the hero's mixer by bone name (assets/loadModels `loadHeroTowClips`).

Two hops, because the glTF importer turns every bone to its own axes (a world-rotation copy straight from a Mixamo FBX
rig onto it twists the limbs — the arm stuck out sideways):
 1. Mixamo's rig of the hero (`character.fbx`, the FBX axes the clips share) follows the clip as build6.py does it:
    world-space copy rotation (hips also location), the clip rig's collarbones rested on ours, ours not animated.
 2. Each frame, every bone of the GLB rig takes that bone's world rotation times a constant per-bone OFFSET (the two
    rigs' rest orientations differ only by the axis convention, measured at rest), hips position copied; baked.

  blender -b --python scripts/blender/hero/hero_clips_add.py -- CLIPS=hook_low,hook_reach,hook_carry \\
      OUT=src/assets/models/characters/hero_tow_clips.glb
Clips are read from refer/characters/hero/mixamo/<name>.fbx.
"""
import bpy, os, sys
from mathutils import Matrix

for a in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []):
    if '=' in a:
        globals()[a.split('=', 1)[0]] = a.split('=', 1)[1]
HERE = os.path.dirname(os.path.abspath(__file__))
GAME = os.path.normpath(os.path.join(HERE, '../../..'))
MX = os.path.join(GAME, 'refer/characters/hero/mixamo')
HERO = globals().get('HERO', os.path.join(GAME, 'src/assets/models/characters/hero.lod0.glb'))
CLIPS = globals().get('CLIPS', 'hook_low,hook_reach,hook_carry').split(',')
OUT = globals().get('OUT', os.path.join(GAME, 'src/assets/models/characters/hero_tow_clips.glb'))

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene


def activate(o):
    for q in bpy.data.objects:
        q.select_set(q is o)
    bpy.context.view_layer.objects.active = o


def fresh(before):
    return [o for o in bpy.data.objects if o not in before]


# the game's rig (target): its rest as shipped
before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=HERO)
rig = next(o for o in fresh(before) if o.type == 'ARMATURE'); rig.name = 'glb_rig'
for o in [o for o in fresh(before) if o.type == 'MESH']:
    bpy.data.objects.remove(o, do_unlink=True)
if rig.animation_data:
    rig.animation_data.action = None
    for t in list(rig.animation_data.nla_tracks):
        rig.animation_data.nla_tracks.remove(t)
for a in list(bpy.data.actions):
    bpy.data.actions.remove(a)
# Mixamo's rig of the hero (FBX axes)
before = set(bpy.data.objects)
bpy.ops.import_scene.fbx(filepath=os.path.join(MX, 'character.fbx'), automatic_bone_orientation=False)
mid = next(o for o in fresh(before) if o.type == 'ARMATURE'); mid.name = 'fbx_rig'
for o in [o for o in fresh(before) if o.type == 'MESH']:
    bpy.data.objects.remove(o, do_unlink=True)
for a in list(bpy.data.actions):
    bpy.data.actions.remove(a)
bpy.context.view_layer.update()
names = [b.name for b in rig.data.bones if b.name in mid.pose.bones]
order = [b.name for b in rig.data.bones if b.name in names]  # (bones come parents first)
A = rig.matrix_world.to_3x3()
# per-bone OFFSET at rest: glb_world = fbx_world @ O
O = {}
for n in names:
    rf = (mid.matrix_world @ mid.data.bones[n].matrix_local).to_3x3().normalized()
    rg = (rig.matrix_world @ rig.data.bones[n].matrix_local).to_3x3().normalized()
    O[n] = rf.inverted() @ rg
for pb in mid.pose.bones:
    pb.rotation_mode = 'QUATERNION'
    if pb.name.endswith('Shoulder'):
        continue
    c = pb.constraints.new('COPY_ROTATION'); c.owner_space = 'WORLD'; c.target_space = 'WORLD'
    if pb.name.endswith('Hips'):
        c = pb.constraints.new('COPY_LOCATION'); c.owner_space = 'WORLD'; c.target_space = 'WORLD'
for pb in rig.pose.bones:
    pb.rotation_mode = 'QUATERNION'
rig.animation_data_create()

for clip in CLIPS:
    before = set(bpy.data.objects); acts0 = set(bpy.data.actions)
    bpy.ops.import_scene.fbx(filepath=os.path.join(MX, clip + '.fbx'), automatic_bone_orientation=False)
    src = next(o for o in fresh(before) if o.type == 'ARMATURE')
    # the clip rig's collarbone rest = the hero's (build6)
    activate(src)
    bpy.ops.object.mode_set(mode='EDIT')
    Sinv = src.matrix_world.inverted()
    for sd in ('Left', 'Right'):
        nm = 'mixamorig:%sShoulder' % sd
        ob = mid.data.bones[nm]
        hw = mid.matrix_world @ ob.head_local; tw = mid.matrix_world @ ob.tail_local
        zw = (mid.matrix_world.to_3x3() @ ob.matrix_local.to_3x3().col[2]).normalized()
        src.data.edit_bones['mixamorig:%sArm' % sd].use_connect = False
        eb = src.data.edit_bones[nm]
        eb.head = Sinv @ hw; eb.tail = Sinv @ tw
        eb.align_roll((Sinv.to_3x3() @ zw).normalized())
    bpy.ops.object.mode_set(mode='OBJECT')
    sact = [a for a in bpy.data.actions if a not in acts0][0]
    f0, f1 = int(sact.frame_range[0]), int(sact.frame_range[1])
    for pb in mid.pose.bones:
        for c in pb.constraints:
            c.target = src; c.subtarget = pb.name
    act = bpy.data.actions.new(clip); act.use_fake_user = True
    rig.animation_data.action = act
    for f in range(f0, f1 + 1):
        sc.frame_set(f)
        P = {}  # final armature-space matrices of the glb rig this frame
        for n in order:
            b = rig.data.bones[n]; pb = rig.pose.bones[n]
            N = (P[b.parent.name] @ b.parent.matrix_local.inverted() @ b.matrix_local) if b.parent and b.parent.name in P else b.matrix_local.copy()
            if n.endswith('Shoulder'):
                want = N  # not animated (build6)
            else:
                wf = (mid.matrix_world @ mid.pose.bones[n].matrix).to_3x3().normalized()
                rot = (A.inverted() @ wf @ O[n]).to_quaternion()
                loc = N.translation
                if n.endswith('Hips'):
                    loc = rig.matrix_world.inverted() @ (mid.matrix_world @ mid.pose.bones[n].matrix).translation
                want = Matrix.LocRotScale(loc, rot, None)
            basis = N.inverted() @ want
            pb.rotation_quaternion = basis.to_quaternion()
            pb.keyframe_insert('rotation_quaternion', frame=f, group=n)
            if n.endswith('Hips'):
                pb.location = basis.translation
                pb.keyframe_insert('location', frame=f, group=n)
            P[n] = N @ basis
    rig.animation_data.action = None
    tr = rig.animation_data.nla_tracks.new(); tr.name = clip
    st = tr.strips.new(clip, f0, act); st.name = clip
    for pb in mid.pose.bones:
        for c in pb.constraints:
            c.target = None
    for o in fresh(before):
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.data.actions.remove(sact)
    print('clip', clip, 'frames', f0, f1, '(%.2f s)' % ((f1 - f0) / sc.render.fps))
bpy.data.objects.remove(mid, do_unlink=True)
for pb in rig.pose.bones:
    pb.location = (0, 0, 0); pb.rotation_quaternion = (1, 0, 0, 0)
activate(rig)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True, export_animation_mode='NLA_TRACKS',
                          export_skins=True, export_def_bones=False, export_optimize_animation_size=True,
                          export_force_sampling=True, export_yup=True, export_materials='NONE', export_cameras=False,
                          export_lights=False)
print('GLB', OUT, os.path.getsize(OUT), 'bytes')
