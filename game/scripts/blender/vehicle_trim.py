"""
VEHICLE TRIM (2026-10-23): bring a finished car under the triangle budget (the user: 30 k) and make its materials MATTE
(no metal, roughness 0.85 — the glossy source materials read as glitter in game). Everything named to the standard
(wheels, calipers, doors, steering wheel, cockpit parts, hooks) is left alone; the biggest anonymous body parts are
decimated (collapse, UVs and vertex colours kept) just enough. Extras (hinge, rim, pivot, eye, fairlead) survive the
round trip; the scene's `vertex_ao` flag is set again.

  blender -b --python scripts/blender/vehicle_trim.py -- SRC=<in.glb> OUT=<out.glb> [BUDGET=30000]
"""
import bpy, sys, os, re

ARGS = dict(a.split('=', 1) for a in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []) if '=' in a)
SRC, OUT = ARGS['SRC'], ARGS['OUT']
BUDGET = int(ARGS.get('BUDGET', 30000))
NAMED = re.compile(r'^(wheel_|caliper_|door_|steering_wheel|cab_|dial_|pedal_|gear_|wiper_|hook_|tow_)', re.I)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=SRC)
meshes = lambda: [o for o in sc.objects if o.type == 'MESH']
tris = lambda objs: sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)
before = tris(meshes())
over = before - BUDGET
if over > 0:
    body = sorted([o for o in meshes() if not NAMED.match(o.name) and len(o.data.polygons) > 400], key=lambda o: -tris([o]))
    pool = tris(body)
    ratio = max(0.25, 1 - over / max(1, pool) * 1.03)
    for o in body:
        bpy.context.view_layer.objects.active = o
        mod = o.modifiers.new('dec', 'DECIMATE'); mod.ratio = ratio
        with bpy.context.temp_override(object=o, active_object=o):
            bpy.ops.object.modifier_apply(modifier=mod.name)
    print('decimated', len(body), 'parts at', round(ratio, 3))
# the importer splits a material shared across meshes into `name` + `name.001` (13 > the 12 budget): merge them back
for o in meshes():
    for s in o.material_slots:
        base = re.match(r'(.+)\.\d{3}$', s.material.name) if s.material else None
        if base and base.group(1) in bpy.data.materials:
            s.material = bpy.data.materials[base.group(1)]
for m in bpy.data.materials:
    if not m.node_tree:
        continue
    for n in m.node_tree.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            for k, v in (('Metallic', 0.0), ('Roughness', 0.85)):
                for l in list(n.inputs[k].links):
                    m.node_tree.links.remove(l)
                n.inputs[k].default_value = v
            for l in list(n.inputs['Normal'].links):
                m.node_tree.links.remove(l)
for o in meshes():
    at = o.data.color_attributes
    if len(at):
        if at.active_color is None:
            at.active_color = at[0]
        at.render_color_index = at.active_color_index
sc['vertex_ao'] = 1
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_active_scene=True, export_extras=True, export_cameras=False,
                          export_lights=False, export_animations=False, export_yup=True, export_vertex_color='ACTIVE')
print('TRIM', os.path.basename(SRC), before, '→', tris(meshes()), 'tris,', os.path.getsize(OUT), 'bytes')
