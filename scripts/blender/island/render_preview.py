# 3D preview of the island heightfield in Blender (Eevee): a mesh of the region (DEC cells per vertex), vertex colours
# by biome / slope / strata, roads painted, a low warm sun. Defined first: MAP, HEIGHTS (optional), OUT, X0 X1 Z0 Z1,
# CAM "x,y,z" and LOOK "x,y,z" in GAME coordinates (x, height, z), DEC (default 2), LENS (mm, default 28).
import bpy, json, os, math, bmesh
import numpy as np
X0, X1, Z0, Z1 = map(float, (X0, X1, Z0, Z1))
DEC = int(globals().get('DEC', 2)); LENS = float(globals().get('LENS', 28))
meta = json.load(open(os.path.join(MAP, 'map.json')))
g = meta['grid']; n = g['n']
hp = globals().get('HEIGHTS') or os.path.join(MAP, 'heights.bin')
H = np.fromfile(hp, dtype='<u2').reshape(n, n).astype(np.float32) / 65535 * g['range'] + g['min'] + meta['heightOffset']
bn = meta['biomeGrid']['n']
B = np.fromfile(os.path.join(MAP, 'biome.bin'), dtype=np.uint8).reshape(bn, bn, 2).astype(np.float32) / 255
i0, i1 = int((X0 + 1200) / 2), int((X1 + 1200) / 2); j0, j1 = int((Z0 + 1200) / 2), int((Z1 + 1200) / 2)
I = np.arange(i0, i1 + 1, DEC); J = np.arange(j0, j1 + 1, DEC)
sub = H[np.ix_(J, I)]
ny, nx = sub.shape
xs = -1200 + I * 2.0; zs = -1200 + J * 2.0
XX, ZZ = np.meshgrid(xs, zs)
# Blender: x = game x, y = −game z, z = height
verts = np.stack([XX.ravel(), -ZZ.ravel(), sub.ravel()], 1)
faces = []
idx = np.arange(nx * ny).reshape(ny, nx)
a = idx[:-1, :-1].ravel(); b = idx[:-1, 1:].ravel(); c = idx[1:, 1:].ravel(); d = idx[1:, :-1].ravel()
quads = np.stack([a, b, c, d], 1)
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
for m in list(bpy.data.meshes): bpy.data.meshes.remove(m)
me = bpy.data.meshes.new('terrain')
me.vertices.add(len(verts)); me.vertices.foreach_set('co', verts.ravel().astype(np.float32))
nl = len(quads)
me.loops.add(nl * 4); me.loops.foreach_set('vertex_index', quads.ravel().astype(np.int32))
me.polygons.add(nl); me.polygons.foreach_set('loop_start', (np.arange(nl) * 4).astype(np.int32))
me.update(calc_edges=True)
# colours per vertex
gy, gx = np.gradient(sub, 2.0 * DEC)
slope = np.hypot(gx, gy)
bi = np.clip(np.round(I / 2).astype(int), 0, bn - 1); bj = np.clip(np.round(J / 2).astype(int), 0, bn - 1)
dw = B[np.ix_(bj, bi)][..., 0]; sw = B[np.ix_(bj, bi)][..., 1]
sand = np.array([0.80, 0.50, 0.30]); rock = np.array([0.55, 0.25, 0.14]); band2 = np.array([0.70, 0.38, 0.22])
green = np.array([0.30, 0.42, 0.18]); snow = np.array([0.9, 0.92, 0.96]); sea = np.array([0.1, 0.3, 0.45])
strata = ((np.floor(sub / 6) % 2) == 0)[..., None]
cliffc = np.where(strata, rock, band2)
cliff = np.clip((slope - 0.7) / 0.6, 0, 1)[..., None]
base = green * (1 - dw - sw)[..., None] + sand * dw[..., None] + snow * sw[..., None]
col = base * (1 - cliff) + cliffc * cliff
col[sub < 0.3] = sea
# roads
roads = meta['roads']
EX = globals().get('ROADS_EXTRA')
if EX and os.path.exists(EX): roads = roads + json.load(open(EX))
for r in roads:
    for x, z in zip(r['x'], r['z']):
        ii = int(round((x - xs[0]) / (2 * DEC))); jj = int(round((z - zs[0]) / (2 * DEC)))
        if 0 <= ii < nx and 0 <= jj < ny:
            col[max(0, jj - 1):jj + 2, max(0, ii - 1):ii + 2] = [0.35, 0.27, 0.2]
lc = col.reshape(-1, 3)[quads.ravel()]
attr = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
rgba = np.ones((len(lc), 4), np.float32); rgba[:, :3] = lc
attr.data.foreach_set('color', rgba.ravel())
ob = bpy.data.objects.new('terrain', me); bpy.context.scene.collection.objects.link(ob)
for p in me.polygons: p.use_smooth = False
mat = bpy.data.materials.new('t'); mat.use_nodes = True
nt = mat.node_tree; bsdf = nt.nodes['Principled BSDF']
ca = nt.nodes.new('ShaderNodeVertexColor'); ca.layer_name = 'Col'
nt.links.new(ca.outputs['Color'], bsdf.inputs['Base Color']); bsdf.inputs['Roughness'].default_value = 0.95
me.materials.append(mat)
# sea plane
bpy.ops.mesh.primitive_plane_add(size=6000, location=(0, 0, -6.0))
sm = bpy.data.materials.new('sea'); sm.use_nodes = True; sm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.08, 0.3, 0.42, 1)
bpy.context.object.data.materials.append(sm)
# sun + sky
sun = bpy.data.lights.new('sun', 'SUN'); sun.energy = 4.0; sun.angle = 0.05
so = bpy.data.objects.new('sun', sun); bpy.context.scene.collection.objects.link(so)
so.rotation_euler = (math.radians(58), 0, math.radians(-120))
w = bpy.context.scene.world or bpy.data.worlds.new('w'); bpy.context.scene.world = w; w.use_nodes = True
w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.75, 0.68, 0.6, 1); w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.8
cam = bpy.data.cameras.new('cam'); cam.lens = LENS; cam.clip_end = 6000
co = bpy.data.objects.new('cam', cam); bpy.context.scene.collection.objects.link(co)
cx, cy, cz = map(float, CAM.split(',')); lx, ly, lz = map(float, LOOK.split(','))
co.location = (cx, -cz, cy)
from mathutils import Vector
dvec = Vector((lx - cx, -(lz - cz), ly - cy))
co.rotation_euler = dvec.to_track_quat('-Z', 'Y').to_euler()
sc = bpy.context.scene; sc.camera = co
sc.render.engine = 'BLENDER_EEVEE' if 'BLENDER_EEVEE' in [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items] else 'BLENDER_EEVEE_NEXT'
sc.render.resolution_x = 1280; sc.render.resolution_y = 640; sc.render.resolution_percentage = 100
sc.view_settings.view_transform = 'Standard'
sc.render.filepath = OUT; sc.render.image_settings.file_format = 'PNG'
bpy.ops.render.render(write_still=True)
print('rendered', OUT)
