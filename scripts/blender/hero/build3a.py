import os
WORK = os.environ.get('HERO_WORK', 'C:/tmp/hero')  # intermediate .blend files, renders, exports, mixamo/
SCRIPTS = os.environ.get('HERO_SCRIPTS', 'C:/Project/Dark/scripts/blender/hero')
# Step 3a: new UV layout ('new'): head islands ×1.8, packed; hands get a reserved corner (filled in 3b).
import bpy, bmesh, math
from mathutils import Vector
SP = WORK
bpy.ops.wm.open_mainfile(filepath=SP + r"\hero_step2.blend")
hero = bpy.data.objects['hero']; me = hero.data
me.uv_layers['UVMap'].name = 'old'
me.uv_layers.new(name='new', do_init=True)
me.uv_layers.active = me.uv_layers['new']
bm = bmesh.new(); bm.from_mesh(me)
uv = bm.loops.layers.uv['new']; ih = bm.verts.layers.float['is_hand']
bm.faces.ensure_lookup_table()
olduv = bm.loops.layers.uv['old']
def _uva(f, lay):
    p = [l[lay].uv for l in f.loops]; return sum(abs((p[i] - p[0]).cross(p[i + 1] - p[0])) / 2 for i in range(1, len(p) - 1))
_ih = bm.verts.layers.float['is_hand']
_me = lambda f: max((f.loops[i][olduv].uv - f.loops[(i + 1) % len(f.loops)][olduv].uv).length for i in range(len(f.loops)))
bad = [f for f in bm.faces if f.verts[0][_ih] < 0.5 and (_uva(f, olduv) > 0.002 or _me(f) > 0.15)]
print('degenerate-uv faces (hole caps)', len(bad), [(len(f.verts), round(_uva(f, olduv), 3), tuple(round(x, 2) for x in f.calc_center_median())) for f in bad][:8])
for f in bad:
    for lay in (olduv, uv):
        p = f.loops[0][lay].uv.copy()
        for l in f.loops: l[lay].uv = p
is_hand = lambda f: f.verts[0][ih] > 0.5
# UV islands of the body (loops connected through shared UV coordinates)
key = lambda l: (round(l[uv].uv.x, 6), round(l[uv].uv.y, 6))
parent = {}
def find(a):
    while parent.setdefault(a, a) != a: parent[a] = parent[parent[a]]; a = parent[a]
    return a
for f in bm.faces:
    if is_hand(f): continue
    for l in f.loops:
        # same vertex + same uv → same island node; neighbouring loops of a face are joined
        parent.setdefault((l.vert.index, key(l)), (l.vert.index, key(l)))
    ks = [(l.vert.index, key(l)) for l in f.loops]
    for k in ks[1:]: parent[find(k)] = find(ks[0])
isl = {}
for f in bm.faces:
    if is_hand(f): continue
    r = find((f.loops[0].vert.index, key(f.loops[0])))
    isl.setdefault(r, []).append(f)
print('islands', len(isl))
nhead = 0
for r, fs in isl.items():
    a3 = sum(f.calc_area() for f in fs); ah = sum(f.calc_area() for f in fs if f.calc_center_median().z > 0.66)
    if ah > 0.5 * a3:
        nhead += 1
        ls = [l for f in fs for l in f.loops]
        c = sum((l[uv].uv for l in ls), Vector((0, 0))) / len(ls)
        for l in ls: l[uv].uv = c + (l[uv].uv - c) * 1.8
print('head islands scaled', nhead)
for f in bm.faces:
    f.select = not is_hand(f)
    if is_hand(f):
        for l in f.loops: l[uv].uv = (0.0, 0.0)
bm.to_mesh(me); bm.free()
# pack (edit mode, only the body faces are selected)
bpy.context.view_layer.objects.active = hero; hero.select_set(True)
win = bpy.context.window_manager.windows[0]
area = next(a for a in win.screen.areas if a.type == 'VIEW_3D')
with bpy.context.temp_override(window=win, area=area, region=next(r for r in area.regions if r.type == 'WINDOW'), active_object=hero, object=hero):
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.context.scene.tool_settings.use_uv_select_sync = False
    bpy.ops.mesh.reveal(); 
    bm = bmesh.from_edit_mesh(me); ih = bm.verts.layers.float['is_hand']
    for f in bm.faces: f.select = f.verts[0][ih] < 0.5
    bmesh.update_edit_mesh(me)
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(udim_source='CLOSEST_UDIM', rotate=True, scale=True, margin_method='FRACTION', margin=0.006)
    bpy.ops.object.mode_set(mode='OBJECT')
# leave a 5 % strip for the hand patches (top-right corner)
bm = bmesh.new(); bm.from_mesh(me); uv = bm.loops.layers.uv['new']; ih = bm.verts.layers.float['is_hand']
umax = vmax = 0
for f in bm.faces:
    if f.verts[0][ih] > 0.5: continue
    for l in f.loops: l[uv].uv *= 0.95; umax = max(umax, l[uv].uv.x); vmax = max(vmax, l[uv].uv.y)
def uvarea(f, lay):
    p = [l[lay].uv for l in f.loops]; return sum(abs((p[i] - p[0]).cross(p[i + 1] - p[0])) / 2 for i in range(1, len(p) - 1))
old = bm.loops.layers.uv['old']
body = [f for f in bm.faces if f.verts[0][ih] < 0.5]
front = [f for f in body if f.calc_center_median().z > 0.69 and f.normal.y < -0.3]
print('uv extent', round(umax, 3), round(vmax, 3), 'used new', round(sum(uvarea(f, uv) for f in body), 3), 'old', round(sum(uvarea(f, old) for f in body), 3))
print('face-front uv area new', round(sum(uvarea(f, uv) for f in front), 4), 'old', round(sum(uvarea(f, old) for f in front), 4))
bm.to_mesh(me); bm.free()
bpy.ops.wm.save_as_mainfile(filepath=SP + r"\hero_step3a.blend")
