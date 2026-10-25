# Before | after render of erode.py's result (H0.npy / H1.npy in DIR) — a scratch scene 'erode_preview' (the user's scenes
# are untouched; it is removed afterwards). Terrain coloured like the game's bright palette: lime meadow, darker green
# on the slopes, the map's cliff grey on the steep faces, lake water.
#   node scripts/blender/bl.mjs scripts/blender/highlands/erode_preview.py DIR=<erode OUT> [VIEWS=x,z,yaw,dist;...]
import math, os
import numpy as np
import bpy

DIR = globals()['DIR']
H0 = np.load(os.path.join(DIR, 'H0.npy')); H1 = np.load(os.path.join(DIR, 'H1.npy')); RD = np.load(os.path.join(DIR, 'roads.npy'))
N = H0.shape[0]; ST = 2.0; OX = OZ = -1200.0; WATER = -6.0
SUB = 2  # 4 m mesh

def srgb(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return np.array([x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c])
GRASS, GDARK, CLIFF, DIRT = srgb('a8e063'), srgb('5dbb4a'), srgb('b8bcc2'), srgb('9a8a6a')

def build(H, name, ox):
    h = H[::SUB, ::SUB]; n = h.shape[0]
    xs = OX + np.arange(n) * ST * SUB; zs = OZ + np.arange(n) * ST * SUB
    X, Z = np.meshgrid(xs, zs)
    gz, gx = np.gradient(h, ST * SUB)
    slope = np.degrees(np.arctan(np.hypot(gx, gz)))
    t_rock = np.clip((slope - 30) / 12, 0, 1)[..., None]; t_dark = np.clip((slope - 12) / 14, 0, 1)[..., None]
    col = GRASS * (1 - t_dark) + GDARK * t_dark
    col = col * (1 - t_rock) + CLIFF * 0.8 * t_rock
    shore = np.clip(1 - (h - WATER) / 1.5, 0, 1)[..., None]
    col = col * (1 - shore) + DIRT * shore
    rd = RD[::SUB, ::SUB][..., None]
    col = np.where(rd, srgb('c8a878'), col)  # the roads (unchanged by the erosion)
    verts = np.stack([X.ravel() + ox, -Z.ravel(), h.ravel()], 1)  # Blender: z up, map −z = north → +y
    i = np.arange(n - 1)[:, None] * n + np.arange(n - 1)[None, :]
    faces = np.stack([i, i + 1, i + n + 1, i + n], -1).reshape(-1, 4)
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(verts)); me.vertices.foreach_set('co', verts.astype(np.float32).ravel())
    me.loops.add(faces.size); me.loops.foreach_set('vertex_index', faces.ravel().astype(np.int32))
    me.polygons.add(len(faces)); me.polygons.foreach_set('loop_start', (np.arange(len(faces)) * 4).astype(np.int32)); me.polygons.foreach_set('loop_total', np.full(len(faces), 4, np.int32))
    me.update(); me.validate()
    me.flip_normals()  # (y = −z mirrors the grid: its faces came out looking down)
    me.shade_smooth()
    attr = me.color_attributes.new('col', 'FLOAT_COLOR', 'POINT')
    attr.data.foreach_set('color', np.concatenate([col.reshape(-1, 3), np.ones((n * n, 1))], 1).astype(np.float32).ravel())
    ob = bpy.data.objects.new(name, me)
    return ob

sc = bpy.data.scenes.get('erode_preview') or bpy.data.scenes.new('erode_preview')
for o in list(sc.collection.objects): bpy.data.objects.remove(o, do_unlink=True)
mat = bpy.data.materials.get('erode_terrain') or bpy.data.materials.new('erode_terrain')
mat.use_nodes = True
nt = mat.node_tree; nt.nodes.clear()
ca = nt.nodes.new('ShaderNodeVertexColor'); ca.layer_name = 'col'
bs = nt.nodes.new('ShaderNodeBsdfPrincipled'); bs.inputs['Roughness'].default_value = 0.9
outn = nt.nodes.new('ShaderNodeOutputMaterial')
nt.links.new(ca.outputs['Color'], bs.inputs['Base Color']); nt.links.new(bs.outputs['BSDF'], outn.inputs['Surface'])
wm = bpy.data.materials.get('erode_water') or bpy.data.materials.new('erode_water'); wm.diffuse_color = (0.12, 0.45, 0.6, 1)
wm.use_nodes = True; wm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.05, 0.3, 0.45, 1); wm.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.1
for H, nm in ((H0, 'before'), (H1, 'after')):
    ob = build(H, 'erode_' + nm, 0.0)
    ob.data.materials.append(mat); sc.collection.objects.link(ob); ob.hide_render = True
bpy.ops.mesh.primitive_plane_add(size=2400, location=(0, 0, WATER))
wp = bpy.context.active_object
for c in list(wp.users_collection): c.objects.unlink(wp)
sc.collection.objects.link(wp); wp.data.materials.append(wm)
sun = bpy.data.objects.new('erode_sun', bpy.data.lights.new('erode_sun', 'SUN')); sun.data.energy = 4.5; sun.data.angle = math.radians(1.5)
sun.rotation_euler = (math.radians(62), 0, math.radians(35))  # a low sun: the relief reads; sc.collection.objects.link(sun)
cam = bpy.data.objects.new('erode_cam', bpy.data.cameras.new('erode_cam')); cam.data.lens = 30; sc.collection.objects.link(cam)
sc.camera = cam
w = bpy.data.worlds.get('erode_world') or bpy.data.worlds.new('erode_world'); w.use_nodes = True
w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.55, 0.72, 0.9, 1); w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.8
sc.world = w
# WORKBENCH: studio light + cast shadows + cavity — the relief reads plainly (Eevee lit this scratch scene flat)
sc.render.engine = 'BLENDER_WORKBENCH'
sh = sc.display.shading
sh.light = 'STUDIO'; sh.color_type = 'VERTEX'; sh.show_shadows = True; sh.shadow_intensity = 0.6
sh.show_cavity = True; sh.cavity_type = 'BOTH'; sh.curvature_ridge_factor = 1.0; sh.curvature_valley_factor = 1.0
sh.background_type = 'WORLD'
sc.display.light_direction = (0.55, -0.35, 0.75)
sc.render.resolution_x, sc.render.resolution_y = 960, 540
sc.render.image_settings.file_format = 'PNG'
sc.view_settings.view_transform = 'Standard'

# views: target (x, z map metres), yaw (deg, 0 = looking north), distance, height
VIEWS = [tuple(float(v) for v in s.split(',')) for s in globals().get('VIEWS', '').split(';') if s] or [(-840, -260, 200, 260, 120)]
frames = []
for vi, (tx, tz, yaw, dist, hgt) in enumerate(VIEWS):
    th = float(H1[int((tz - OZ) / ST), int((tx - OX) / ST)])
    a = math.radians(yaw)
    cx, cz = tx - math.sin(a) * dist, tz + math.cos(a) * dist
    cam.location = (cx, -cz, th + hgt)
    d = np.array([tx - cx, -(tz - cz), th - (th + hgt)]); d /= np.linalg.norm(d)
    cam.rotation_euler = (math.acos(-d[2]) , 0, math.atan2(d[1], d[0]) - math.pi / 2)
    row = []
    for nm in ('before', 'after'):
        for o in sc.collection.objects:
            if o.name.startswith('erode_b') or o.name.startswith('erode_a'): o.hide_render = not o.name.endswith(nm)
        path = os.path.join(DIR, 'v%d_%s.png' % (vi, nm))
        sc.render.filepath = path
        win = bpy.context.window
        prev = win.scene
        win.scene = sc
        bpy.ops.render.render(write_still=True, scene=sc.name)
        win.scene = prev
        im = bpy.data.images.load(path); px = np.array(im.pixels[:], np.float32).reshape(im.size[1], im.size[0], 4); bpy.data.images.remove(im)
        row.append(px)
    frames.append(np.concatenate([row[0], np.ones((row[0].shape[0], 8, 4), np.float32), row[1]], 1))
big = np.concatenate([np.concatenate([f, np.ones((8, f.shape[1], 4), np.float32)], 0) for f in frames], 0)
out = bpy.data.images.new('erosion_preview', big.shape[1], big.shape[0], alpha=True)
out.pixels.foreach_set(big.ravel()); out.filepath_raw = os.path.join(DIR, 'erosion_preview.png'); out.file_format = 'PNG'; out.save(); bpy.data.images.remove(out)
# clean up the scratch scene
for o in list(sc.collection.objects):
    d = o.data; bpy.data.objects.remove(o, do_unlink=True)
    if d is not None and d.users == 0:
        (bpy.data.meshes if isinstance(d, bpy.types.Mesh) else bpy.data.lights if isinstance(d, bpy.types.Light) else bpy.data.cameras).remove(d)
bpy.data.scenes.remove(sc)
print('preview ->', os.path.join(DIR, 'erosion_preview.png'))
