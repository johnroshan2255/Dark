import os
WORK = os.environ.get('HERO_WORK', 'C:/tmp/hero')  # intermediate .blend files, renders, exports, mixamo/
SCRIPTS = os.environ.get('HERO_SCRIPTS', 'C:/Project/Dark/scripts/blender/hero')
# Step 2: restore the face shape from the high-res source (subdivide the face, snap to a de-noised hi-res surface).
import bpy, bmesh, math
from mathutils import Vector
from mathutils.bvhtree import BVHTree
SP = WORK
bpy.ops.wm.open_mainfile(filepath=SP + r"\hero_step1.blend")
hero = bpy.data.objects['hero']
before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=SCRIPTS + '/../../../refer/characters/hero/hero_v3_full_shape_hands_free.glb')
hi = [o for o in bpy.data.objects if o not in before and o.type == 'MESH'][0]
# head part of the hi-res mesh only, de-noised (the generator leaves a fine crackle)
hb = bmesh.new(); hb.from_mesh(hi.data)
bmesh.ops.delete(hb, geom=[v for v in hb.verts if v.co.z < 0.6], context='VERTS')
bmesh.ops.remove_doubles(hb, verts=hb.verts, dist=1e-5)
for _ in range(4):
    bmesh.ops.smooth_laplacian_vert(hb, verts=hb.verts, lambda_factor=0.4, lambda_border=0.0, use_x=True, use_y=True, use_z=True, preserve_volume=True)
bvh = BVHTree.FromBMesh(hb)
for o in [o for o in bpy.data.objects if o not in before]: bpy.data.objects.remove(o)
bm = bmesh.new(); bm.from_mesh(hero.data)
ish = bm.verts.layers.float.get('is_hand')
def in_face(f):
    c = f.calc_center_median()
    return 0.68 < c.z < 0.97 and abs(c.x) < 0.125 and f.normal.y < -0.15 and c.y < 0.0
faces = [f for f in bm.faces if in_face(f)]
edges = list({e for f in faces for e in f.edges})
print('face region faces', len(faces))
bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=True, use_single_edge=False, use_only_quads=False)
bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
# snap: the face front region (by position) onto the hi-res surface, fading out toward the region's border
moved = 0; mx = 0
for v in bm.verts:
    if v[ish] > 0.5: continue
    c = v.co
    if not (0.66 < c.z < 0.99 and abs(c.x) < 0.14 and c.y < 0.02): continue
    if not any(in_face(f) for f in v.link_faces) and not (0.69 < c.z < 0.96 and abs(c.x) < 0.11 and c.y < -0.04): continue
    hit = bvh.find_nearest(c)
    if hit[0] is None: continue
    d = hit[0] - c
    if d.length > 0.02: continue
    # fade at the edges of the box so the head stays watertight and smooth
    w = min(1.0, (c.z - 0.68) / 0.03, (0.97 - c.z) / 0.03, (0.13 - abs(c.x)) / 0.03)
    w = max(0.0, w)
    v.co = c + d * w; moved += 1; mx = max(mx, d.length)
print('snapped', moved, 'max move', round(mx, 4))
bm.to_mesh(hero.data); bm.free()
hero.data.update()
print('tris', sum(len(p.vertices) - 2 for p in hero.data.polygons))
bpy.ops.wm.save_as_mainfile(filepath=SP + r"\hero_step2.blend")
exec(open(SCRIPTS + '/render_lib.py').read())
setup(); sh = bpy.context.scene.display.shading
sh.color_type = 'SINGLE'; sh.single_color = (0.8,0.8,0.8); sh.show_cavity = True; sh.cavity_type='BOTH'
shot('s2_head', (0,0,0.84), 3, 0, 0, ortho=0.30)
shot('s2_head34', (0,0,0.84), 3, 35, 0, ortho=0.30)
sh.show_cavity = False; sh.color_type = 'TEXTURE'
shot('s2_head_tex', (0,0,0.84), 3, 0, 0, ortho=0.30)
