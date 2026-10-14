import os
WORK = os.environ.get('HERO_WORK', 'C:/tmp/hero')  # intermediate .blend files, renders, exports, mixamo/
SCRIPTS = os.environ.get('HERO_SCRIPTS', 'C:/Project/Dark/scripts/blender/hero')
# Step 1: GLB → clean smooth mesh with new hands (clean planar cut at the glove cuff).
import bpy, bmesh, math
from mathutils import Vector, Matrix
SP = WORK
exec(open(SCRIPTS + '/hands.py').read()); exec(open(SCRIPTS + '/armsel.py').read())
bpy.ops.wm.read_homefile(use_empty=True)
os.makedirs(WORK + '/r', exist_ok=True)
# the previous (static, 15 k tris, baked atlas) game model — the input of this pipeline
bpy.ops.import_scene.gltf(filepath=SCRIPTS + '/../../../refer/characters/hero/hero_v4_static_source.glb')
hero = [o for o in bpy.data.objects if o.type == 'MESH'][0]; hero.name = 'hero'; hero.data.name = 'hero'
me = hero.data
bm = bmesh.new(); bm.from_mesh(me)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
for f in bm.faces: f.smooth = True
bm.verts.ensure_lookup_table()
def centroid(ids, z0, z1):
    ps = [bm.verts[i].co for i in ids if z0 <= bm.verts[i].co.z <= z1]
    return sum(ps, Vector()) / len(ps)
frames = {}
for side in (1, -1):
    ids = arm_verts(bm, side, 0.155)
    fore = centroid(ids, 0.09, 0.15); wrist = centroid(ids, 0.0, 0.04); fist = centroid(ids, -0.13, -0.07)
    a = ((wrist - fore).normalized() + (fist - wrist).normalized()).normalized()
    C = wrist + a * ((0.02 - wrist.z) / a.z)
    frames[side] = (C, a)
    hero['cut%+d' % side] = list(C) + list(a)   # wrist cut centre + forearm axis (later steps: glove cuff band)
for side, (C, a) in frames.items():
    bm.verts.ensure_lookup_table()
    ids = arm_verts(bm, side, 0.155)
    geom = list({f for i in ids for f in bm.verts[i].link_faces if all(v.index in ids for v in f.verts)})
    geom = geom + list({e for f in geom for e in f.edges}) + list({bm.verts[i] for i in ids})
    bmesh.ops.bisect_plane(bm, geom=geom, plane_co=C, plane_no=-a, clear_inner=True)
    bm.verts.ensure_lookup_table()
    # taper the remaining cuff toward the new wrist (ellipse 0.033 x 0.038 at the cut)
    ids = arm_verts(bm, side, 0.155) if any(v.co.z < 0.0 and v.co.x * side > 0.2 for v in bm.verts) else None
    X = Vector((1, 0, 0)); X = (X - a * X.dot(a)).normalized(); Y = a.cross(X)
    for v in bm.verts:
        rel0 = v.co - C; h = rel0.dot(-a)
        if not (-1e-4 <= h < 0.045): continue
        rel = rel0 - (-a) * h
        if rel.length > 0.09: continue
        ex, ey = rel.dot(X), rel.dot(Y)
        tx, ty = 0.033 + 0.25 * h, 0.038 + 0.25 * h
        r = math.hypot(ex / tx, ey / ty); w = (1 - h / 0.045) ** 2
        if r > 1: s = 1 + (1 / r - 1) * w; v.co = C + (-a) * h + X * ex * s + Y * ey * s
bd = [e for e in bm.edges if e.is_boundary and min(v.co.z for v in e.verts) < 0.06 and abs(e.verts[0].co.x) > 0.2]
res = bmesh.ops.holes_fill(bm, edges=bd, sides=0)
print('cut boundary edges', len(bd), 'caps', len(res['faces']))
bm.to_mesh(me); bm.free()
if 'sharp_face' in me.attributes: me.attributes.remove(me.attributes['sharp_face'])
gl = me.attributes.new('glove', 'FLOAT', 'POINT')   # body: 0 (unused); hands: signed distance past the glove edge
hm = me.attributes.new('is_hand', 'FLOAT', 'POINT')
newobs = []
for side, (C, a) in frames.items():
    hb, prims = build_canonical()
    if side == 1:
        for v in hb.verts: v.co.x = -v.co.x
        bmesh.ops.reverse_faces(hb, faces=hb.faces)
        prims = [(Vector((-p0.x, p0.y, p0.z)), Vector((-p1.x, p1.y, p1.z)), r0, r1, t) for p0, p1, r0, r1, t in prims]
    hme = bpy.data.meshes.new('hand%+d' % side); hb.to_mesh(hme); hb.free()
    ob = bpy.data.objects.new(hme.name, hme); bpy.context.scene.collection.objects.link(ob)
    hme.remesh_voxel_size = 0.0015
    with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob]):
        bpy.ops.object.voxel_remesh()
    m = ob.modifiers.new('sm', 'CORRECTIVE_SMOOTH'); m.iterations = 4; m.smooth_type = 'SIMPLE'; m.use_only_smooth = True
    m2 = ob.modifiers.new('dec', 'DECIMATE'); m2.ratio = 1500 / (2 * len(hme.polygons))
    with bpy.context.temp_override(object=ob, active_object=ob):
        bpy.ops.object.modifier_apply(modifier='sm'); bpy.ops.object.modifier_apply(modifier='dec')
    g = hme.attributes.new('glove', 'FLOAT', 'POINT'); ih = hme.attributes.new('is_hand', 'FLOAT', 'POINT')
    for v in hme.vertices: g.data[v.index].value = glove_sd(v.co, prims); ih.data[v.index].value = 1.0
    Zc = -a; Xc = Vector((1, 0, 0)); Xc = (Xc - Zc * Xc.dot(Zc)).normalized(); Yc = Zc.cross(Xc)
    M = Matrix((Xc, Yc, Zc)).transposed().to_4x4(); M.translation = C
    hme.transform(M)
    for p in hme.polygons: p.use_smooth = True
    hme.uv_layers.new(name='UVMap')
    for mt in me.materials: hme.materials.append(mt)
    newobs.append(ob)
with bpy.context.temp_override(active_object=hero, object=hero, selected_editable_objects=[hero] + newobs, selected_objects=[hero] + newobs):
    bpy.ops.object.join()
me = hero.data
print('hero verts', len(me.vertices), 'tris', sum(len(p.vertices) - 2 for p in me.polygons), 'uv layers', [u.name for u in me.uv_layers])
bpy.ops.wm.save_as_mainfile(filepath=SP + r"\hero_step1.blend")
