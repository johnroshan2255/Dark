import os
WORK = os.environ.get('HERO_WORK', 'C:/tmp/hero')  # intermediate .blend files, renders, exports, mixamo/
SCRIPTS = os.environ.get('HERO_SCRIPTS', 'C:/Project/Dark/scripts/blender/hero')
# Step 7: decimate to the player budget (15k tris; head + hands protected), our texture, export the game GLB.
import bpy
SP = WORK
OUT = 'C:/Project/Dark/src/assets/models/characters/hero.lod0.glb'
TARGET = 15000
bpy.ops.wm.open_mainfile(filepath=SP + '/hero_step6_rigged.blend')
rig = bpy.data.objects['hero_rig']; mesh = bpy.data.objects['hero']; me = mesh.data
win = bpy.context.window_manager.windows[0]; area = next((a for a in win.screen.areas if a.type == 'VIEW_3D'), win.screen.areas[0])
ctx = dict(window=win, area=area, region=next(r for r in area.regions if r.type == 'WINDOW'))
# protect = head + neck + hands/fingers skin weight
prot = mesh.vertex_groups.get('protect') or mesh.vertex_groups.new(name='protect')
keys = ('Head', 'Neck', 'Hand')
gi = {g.index: any(k in g.name for k in keys) for g in mesh.vertex_groups}
for v in me.vertices:
    w = min(1.0, sum(g.weight for g in v.groups if gi.get(g.group)))
    if w > 0: prot.add([v.index], w, 'REPLACE')
tris0 = sum(len(p.vertices) - 2 for p in me.polygons)
ptris = sum(len(p.vertices) - 2 for p in me.polygons if all(any(g.group == prot.index and g.weight > 0.5 for g in me.vertices[i].groups) for i in p.vertices))
print('tris', tris0, 'protected', ptris)
dec = mesh.modifiers.new('dec', 'DECIMATE'); dec.decimate_type = 'COLLAPSE'
dec.vertex_group = 'protect'; dec.invert_vertex_group = True; dec.vertex_group_factor = 1.0; dec.use_collapse_triangulate = True
with bpy.context.temp_override(**ctx, object=mesh, active_object=mesh):
    bpy.ops.object.modifier_move_to_index(modifier='dec', index=0)
dg = bpy.context.evaluated_depsgraph_get()
lo, hi = 0.3, 1.0
for _ in range(14):           # bisect the ratio for ~TARGET tris
    dec.ratio = (lo + hi) / 2
    dg.update()
    ev = mesh.evaluated_get(dg)
    m = ev.to_mesh(); n = sum(len(p.vertices) - 2 for p in m.polygons); ev.to_mesh_clear()
    # armature modifier does not change topology, so n is the decimated count
    if n > TARGET: hi = dec.ratio
    else: lo = dec.ratio
dec.ratio = lo
with bpy.context.temp_override(**ctx, object=mesh, active_object=mesh):
    bpy.ops.object.modifier_apply(modifier='dec')
mesh.vertex_groups.remove(mesh.vertex_groups['protect'])
print('ratio', round(lo, 3), 'tris now', sum(len(p.vertices) - 2 for p in me.polygons), 'verts', len(me.vertices))
# our albedo instead of Mixamo's re-encoded copy
img = bpy.data.images.load(SP + '/export/hero_albedo.png'); img.name = 'hero_albedo'
for mat in me.materials:
    for n in mat.node_tree.nodes:
        if n.type == 'TEX_IMAGE': n.image = img
    bs = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bs:
        bs.inputs['Metallic'].default_value = 0.0; bs.inputs['Roughness'].default_value = 0.85
print('materials', [m.name for m in me.materials], 'images', [i.name for i in bpy.data.images])
bpy.ops.wm.save_as_mainfile(filepath=SP + '/hero_step7_game.blend')
for o in bpy.data.objects: o.select_set(o in (rig, mesh))
bpy.context.view_layer.objects.active = rig
with bpy.context.temp_override(**ctx, active_object=rig, selected_objects=[rig, mesh]):
    bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True, export_animation_mode='NLA_TRACKS',
                              export_image_format='JPEG', export_jpeg_quality=90, export_skins=True, export_def_bones=False,
                              export_optimize_animation_size=True, export_force_sampling=True, export_yup=True,
                              export_materials='EXPORT', export_normals=True, export_texcoords=True, export_morph=False,
                              export_cameras=False, export_lights=False)
import os; print('GLB bytes', os.path.getsize(OUT))
