import os
WORK = os.environ.get('HERO_WORK', 'C:/tmp/hero')  # intermediate .blend files, renders, exports, mixamo/
SCRIPTS = os.environ.get('HERO_SCRIPTS', 'C:/Project/Dark/scripts/blender/hero')
# Step 3b: bake the new 1024² albedo: old atlas (UV 'old') + the close-up portrait front-projected onto the face.
import bpy, bmesh, math
SP = WORK
bpy.ops.wm.open_mainfile(filepath=SP + r"\hero_step3a.blend")
hero = bpy.data.objects['hero']; me = hero.data
# portrait (concept sheet CLOSE UP panel, 226×268) ↔ mesh: x = (px − 123)·S, z = Z0 − py·S (landmark fit)
S, PX0, Z0, PW, PH = 0.001346, 123.0, 0.9768, 226.0, 268.0
def sstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a))); return t * t * (3 - 2 * t)
if 'proj' not in me.uv_layers: me.uv_layers.new(name='proj')
fw = me.attributes.get('faceW') or me.attributes.new('faceW', 'FLOAT', 'POINT')
ih = me.attributes['is_hand'].data
me.calc_normals() if hasattr(me, 'calc_normals') else None
for v in me.vertices:
    c = v.co; n = v.normal
    if ih[v.index].value > 0.5: fw.data[v.index].value = 0; continue
    face = sstep(0.4, 0.8, -n.y)                        # facing the camera of the portrait
    rx = 0.088 - 0.6 * max(0.0, 0.785 - c.z)          # narrower below the cheeks: the portrait's jaw, not the shadow past it
    e = math.hypot(c.x / rx, (c.z - 0.815) / (0.12 if c.z > 0.815 else 0.118))   # face ellipse
    fw.data[v.index].value = face * (1 - sstep(0.78, 1.0, e)) * (1.0 if c.y < 0.0 else 0.0)
pl = me.uv_layers['proj'].data
for l in me.loops:
    c = me.vertices[l.vertex_index].co
    px = PX0 + c.x / S; py = (Z0 - c.z) / S
    pl[l.index].uv = (px / PW, 1 - py / PH)
# bake material
mat = me.materials[0]; nt = mat.node_tree
old_img = next(n.image for n in nt.nodes if n.type == 'TEX_IMAGE')
for n in list(nt.nodes): nt.nodes.remove(n)
def node(t, **kw):
    n = nt.nodes.new(t)
    for k, v in kw.items(): setattr(n, k, v)
    return n
uvo = node('ShaderNodeUVMap', uv_map='old'); uvp = node('ShaderNodeUVMap', uv_map='proj')
to = node('ShaderNodeTexImage', image=old_img, interpolation='Cubic')
# the CLOSE UP panel of the concept sheet (226×268 px, top-left origin at 18, 590) — the face source
import numpy as np
sheet = bpy.data.images.load(SCRIPTS + '/../../../refer/characters/hero/concept_sheet.png', check_existing=True)
SW, SH = sheet.size
px = np.array(sheet.pixels[:], dtype=np.float32).reshape(SH, SW, 4)[::-1]
crop = px[590:858, 18:244]
portrait = bpy.data.images.new('portrait_crop', crop.shape[1], crop.shape[0], alpha=True)
portrait.pixels[:] = crop[::-1].ravel()
tp = node('ShaderNodeTexImage', image=portrait, interpolation='Cubic', extension='EXTEND')
at = node('ShaderNodeAttribute', attribute_name='faceW')
mix = node('ShaderNodeMix', data_type='RGBA')
em = node('ShaderNodeEmission'); out = node('ShaderNodeOutputMaterial')
L = nt.links.new
L(uvo.outputs[0], to.inputs[0]); L(uvp.outputs[0], tp.inputs[0])
L(at.outputs['Fac'], mix.inputs['Factor']); L(to.outputs['Color'], mix.inputs[6]); L(tp.outputs['Color'], mix.inputs[7])
L(mix.outputs[2], em.inputs['Color']); L(em.outputs[0], out.inputs[0])
target = bpy.data.images.get('hero_albedo') or bpy.data.images.new('hero_albedo', 1024, 1024, alpha=False)
tgt = node('ShaderNodeTexImage', image=target); nt.nodes.active = tgt
for u in me.uv_layers: u.active_render = (u.name == 'new')
me.uv_layers.active = me.uv_layers['new']
sc = bpy.context.scene; sc.render.engine = 'CYCLES'; sc.cycles.samples = 1; sc.cycles.device = 'CPU'
sc.render.bake.margin = 12; sc.render.bake.margin_type = 'EXTEND'
sc.view_settings.view_transform = 'Standard'
bpy.context.view_layer.objects.active = hero; hero.select_set(True)
win = bpy.context.window_manager.windows[0]
area = next(a for a in win.screen.areas if a.type == 'VIEW_3D')
with bpy.context.temp_override(window=win, area=area, region=next(r for r in area.regions if r.type == 'WINDOW'), active_object=hero, object=hero, selected_objects=[hero], selected_editable_objects=[hero]):
    bpy.ops.object.bake(type='EMIT')
target.filepath_raw = SP + r"\r\hero_albedo_bake.png"; target.file_format = 'PNG'; target.save()
bpy.ops.wm.save_as_mainfile(filepath=SP + r"\hero_step3b.blend")
print('baked')
