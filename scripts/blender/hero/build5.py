import os
WORK = os.environ.get('HERO_WORK', 'C:/tmp/hero')  # intermediate .blend files, renders, exports, mixamo/
SCRIPTS = os.environ.get('HERO_SCRIPTS', 'C:/Project/Dark/scripts/blender/hero')
# Step 5: bake the A-pose, clean the mesh for Mixamo (metres, feet at 0, one UV map + one textured material) → FBX.
import bpy, bmesh
SP = WORK
bpy.ops.wm.open_mainfile(filepath=SP + r"\hero_step4_posed.blend")
hero = bpy.data.objects['hero']; rig = bpy.data.objects['tmp_rig']; me = hero.data
win = bpy.context.window_manager.windows[0]; area = next(a for a in win.screen.areas if a.type == 'VIEW_3D')
ctx = dict(window=win, area=area, region=next(r for r in area.regions if r.type == 'WINDOW'))
mod = next(m for m in hero.modifiers if m.type == 'ARMATURE')
with bpy.context.temp_override(**ctx, object=hero, active_object=hero):
    bpy.ops.object.modifier_apply(modifier=mod.name)
hero.parent = None
bpy.data.objects.remove(rig)
hero.vertex_groups.clear()
# metres, soles at z = 0 (1.99 units tall → 1.78 m)
bm = bmesh.new(); bm.from_mesh(me)
zmin = min(v.co.z for v in bm.verts); zmax = max(v.co.z for v in bm.verts)
s = 1.78 / (zmax - zmin)
for v in bm.verts: v.co.z -= zmin; v.co *= s
# Posture: the generator gave the head a forward carriage (its top 6 cm ahead of the chest). Head + neck tilted back
# 8° about the base of the neck (blended over the neck); only inside the hood's opening (radius from the neck axis).
import math
from mathutils import Matrix, Vector
PIV = Vector((0.0, 0.02, 1.40)); R = Matrix.Rotation(math.radians(-8), 3, 'X')
def sst(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a))); return t * t * (3 - 2 * t)
moved = 0
for v in bm.verts:
    c = v.co
    r = math.hypot(c.x, max(0.0, c.y - 0.01))          # distance from the neck axis toward the sides / back (the hood)
    hood = 1 - sst(0.105, 0.125, r) if c.z < 1.60 else 1.0
    w = sst(1.40, 1.50, c.z) * hood
    if w <= 0: continue
    p = PIV + R @ (c - PIV)
    v.co = c.lerp(p, w); moved += 1
print('head tilt: verts', moved)
bm.to_mesh(me); bm.free()
print('scale', round(s, 4), 'height', round((zmax - zmin) * s, 3))
# one UV map
for nm in [u.name for u in me.uv_layers if u.name != 'new']: me.uv_layers.remove(me.uv_layers[nm])
me.uv_layers['new'].name = 'UVMap'
for nm in [a.name for a in me.attributes if a.name in ('glove', 'is_hand', 'faceW', 'headW', 'neckW', 'hairW')]: me.attributes.remove(me.attributes[nm])
# texture + material
import os, shutil; os.makedirs(SP + '/export', exist_ok=True)
shutil.copyfile(SP + '/r/hero_albedo_v2.png', SP + '/export/hero_albedo.png')
img = bpy.data.images.load(SP + '/export/hero_albedo.png')
mat = bpy.data.materials.new('hero'); mat.use_nodes = True; nt = mat.node_tree
bs = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
tx = nt.nodes.new('ShaderNodeTexImage'); tx.image = img
nt.links.new(tx.outputs['Color'], bs.inputs['Base Color'])
bs.inputs['Roughness'].default_value = 0.85
me.materials.clear(); me.materials.append(mat)
for p in me.polygons: p.material_index = 0
for o in list(bpy.data.objects):
    if o is not hero: bpy.data.objects.remove(o)
bpy.ops.wm.save_as_mainfile(filepath=SP + r"\hero_step5_apose.blend")
with bpy.context.temp_override(**ctx, object=hero, active_object=hero, selected_objects=[hero]):
    hero.select_set(True)
    bpy.ops.export_scene.fbx(filepath=SP + r"\export\hero_apose.fbx", use_selection=True, object_types={'MESH'},
                             path_mode='COPY', embed_textures=True, apply_unit_scale=True, add_leaf_bones=False,
                             mesh_smooth_type='FACE', use_mesh_modifiers=True)
print('tris', sum(len(p.vertices) - 2 for p in me.polygons), 'verts', len(me.vertices))
# textured preview of what goes to Mixamo
exec(open(SCRIPTS + '/render_lib.py').read())
setup()
shot('mixamo_front', (0, 0, 0.9), 6, 0, 0, ortho=2.0)
shot('mixamo_34', (0, 0, 0.9), 6, 30, 5, ortho=2.0)
