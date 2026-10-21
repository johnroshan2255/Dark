import os
WORK = os.environ.get('HERO_WORK', 'C:/tmp/hero')  # intermediate .blend files, renders, exports, mixamo/
SCRIPTS = os.environ.get('HERO_SCRIPTS', 'C:/Project/Dark/scripts/blender/hero')
# Step 3c: match the old head/neck skin to the portrait's tone, then UV + paint the new hands.
import bpy, bmesh, math, numpy as np
SP = WORK
bpy.ops.wm.open_mainfile(filepath=SP + r"\hero_step3b.blend")
hero = bpy.data.objects['hero']; me = hero.data
src = bpy.data.images.load(SP + '/r/hero_albedo_bake.png'); bpy.data.images['hero_albedo'].pixels[:] = src.pixels[:]
def sstep(a, b, x): t = np.clip((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t)
# --- mask bake: R = faceW, G = head/neck region --------------------------------------------------------------
hw = me.attributes.get('headW') or me.attributes.new('headW', 'FLOAT', 'POINT')
ih = me.attributes['is_hand'].data
def head_w(c):
    # the head and neck skin only, not the hood around them: radius from the neck axis (x 0, y −0.02)
    r = math.hypot(c.x, c.y + 0.02)
    lim = 0.075 if c.z < 0.70 else (0.11 if c.z < 0.80 else 1.0)
    return float(sstep(0.58, 0.64, c.z)) * float(1 - sstep(lim, lim + 0.012, r))
hairw = me.attributes.get('hairW') or me.attributes.new('hairW', 'FLOAT', 'POINT')
nw = me.attributes.get('neckW') or me.attributes.new('neckW', 'FLOAT', 'POINT')
ckw = me.attributes.get('cheekW') or me.attributes.new('cheekW', 'FLOAT', 'POINT')
for v in me.vertices:
    c = v.co; hand = ih[v.index].value > 0.5
    hw.data[v.index].value = 0.0 if hand else head_w(c)
    # hair: crown / sides above the ears and the back of the head (not the ears)
    hr = max(float(sstep(0.85, 0.87, c.z)), float(sstep(0.04, 0.06, c.y) * sstep(0.73, 0.75, c.z)))
    hairw.data[v.index].value = 0.0 if hand else hr
    # neck + under / along the jaw (up to the cheek at the sides, front half only): repainted as clean skin
    zs = 0.05 * float(sstep(0.04, 0.07, abs(c.x)))
    lim = 0.085 + 1.0 * max(float(sstep(0.735, 0.75, c.z)), float((1 - sstep(-0.08, -0.06, c.y)) * (1 - sstep(0.055, 0.065, abs(c.x)))))   # no radius limit on the throat / under the chin (the hood is at the sides and back)
    front = 1.0 if c.z < 0.745 else float(1 - sstep(-0.05, -0.025, c.y))
    # side of the face: cheek / temple down to the jaw, in front of the ear, below the side hairline
    ckw.data[v.index].value = 0.0 if hand else float(sstep(0.685, 0.705, c.z) * (1 - sstep(0.835, 0.86, c.z)) * (1 - sstep(-0.03, -0.005, c.y)) * sstep(0.02, 0.045, abs(c.x)))
    nw.data[v.index].value = 0.0 if hand else float(sstep(0.60, 0.63, c.z) * (1 - sstep(0.735 + zs, 0.75 + zs, c.z)) * (1 - sstep(lim, lim + 0.012, math.hypot(c.x, c.y + 0.02))) * front)
mat = me.materials[0]; nt = mat.node_tree
em = next(n for n in nt.nodes if n.type == 'EMISSION')
a1 = nt.nodes.new('ShaderNodeAttribute'); a1.attribute_name = 'faceW'
a2 = nt.nodes.new('ShaderNodeAttribute'); a2.attribute_name = 'headW'
cb = nt.nodes.new('ShaderNodeCombineColor')
emA = nt.nodes.new('ShaderNodeAttribute'); emA.attribute_name = 'hairW'
a3 = nt.nodes.new('ShaderNodeAttribute'); a3.attribute_name = 'neckW'
nt.links.new(a1.outputs['Fac'], cb.inputs[0]); nt.links.new(a2.outputs['Fac'], cb.inputs[1]); nt.links.new(a3.outputs['Fac'], cb.inputs[2])
nt.links.new(cb.outputs[0], em.inputs['Color'])
mask = bpy.data.images.get('mask') or bpy.data.images.new('mask', 1024, 1024, alpha=False, float_buffer=True)
mask.colorspace_settings.name = 'Non-Color'
tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = mask; nt.nodes.active = tn
win = bpy.context.window_manager.windows[0]; area = next(a for a in win.screen.areas if a.type == 'VIEW_3D')
with bpy.context.temp_override(window=win, area=area, region=next(r for r in area.regions if r.type == 'WINDOW'), active_object=hero, object=hero, selected_objects=[hero], selected_editable_objects=[hero]):
    bpy.ops.object.bake(type='EMIT', margin=12)
M = np.array(mask.pixels[:], dtype=np.float32).reshape(1024, 1024, 4).copy()
nt.links.new(emA.outputs['Fac'], cb.inputs[0])
with bpy.context.temp_override(window=win, area=area, region=next(r for r in area.regions if r.type == 'WINDOW'), active_object=hero, object=hero, selected_objects=[hero], selected_editable_objects=[hero]):
    bpy.ops.object.bake(type='EMIT', margin=12)
HairW = np.array(mask.pixels[:], dtype=np.float32).reshape(1024, 1024, 4)[..., 0].copy()
emC = nt.nodes.new('ShaderNodeAttribute'); emC.attribute_name = 'cheekW'
nt.links.new(emC.outputs['Fac'], cb.inputs[0])
with bpy.context.temp_override(window=win, area=area, region=next(r for r in area.regions if r.type == 'WINDOW'), active_object=hero, object=hero, selected_objects=[hero], selected_editable_objects=[hero]):
    bpy.ops.object.bake(type='EMIT', margin=12)
CheekW = np.array(mask.pixels[:], dtype=np.float32).reshape(1024, 1024, 4)[..., 0].copy()
A = np.array(bpy.data.images['hero_albedo'].pixels[:], dtype=np.float32).reshape(1024, 1024, 4)
F, Hd = M[..., 0], M[..., 1]
r, g, b = A[..., 0], A[..., 1], A[..., 2]
lum = 0.3 * r + 0.59 * g + 0.11 * b
skin = sstep(0.06, 0.16, r - b) * sstep(0.30, 0.42, lum) * sstep(0.05, 0.09, r - g)   # skin hue (olive cloth has r ≈ g), bright enough to be skin, not hair highlights
P = A[(F > 0.9) & (skin > 0.8)][:, :3].mean(0); O = A[(F < 0.05) & (Hd > 0.9) & (skin > 0.8)][:, :3].mean(0)
lP = 0.3 * P[0] + 0.59 * P[1] + 0.11 * P[2]
print('portrait skin', P.round(3), 'old skin', O.round(3))
w = (skin * Hd * (1 - F))[..., None]
l2 = (lum * 0.55 + lP * 0.45)[..., None]   # keep most of the painted shading, lift the dark side of the head
A[..., :3] = A[..., :3] * (1 - w) + (P / lP) * l2 * w
# hair: bright skin-coloured blotches in the old bake read as bald patches → compress toward the hair colour
lum2 = 0.3 * A[..., 0] + 0.59 * A[..., 1] + 0.11 * A[..., 2]
hairc = np.median(A[(HairW > 0.9) & (F < 0.05) & (lum2 < 0.25) & (lum2 > 0.05)][:, :3], 0)
hk = (HairW * (1 - F) * sstep(0.2, 0.34, lum2))[..., None]
A[..., :3] = A[..., :3] * (1 - hk * 0.75) + hairc * 1.35 * hk * 0.75
print('hair colour', hairc.round(3))
# neck / under-jaw: clean skin carrying a blurred version of the painted shading
Nk = (M[..., 2] * (1 - F) * sstep(0.12, 0.2, lum))[..., None]   # not the black T-shirt collar
def blur(x, k=9):
    for ax in (0, 1):
        c = np.cumsum(np.pad(x, [(k, k) if i == ax else (0, 0) for i in range(x.ndim)], mode='edge'), axis=ax)
        x = (np.take(c, range(2 * k, c.shape[ax]), axis=ax) - np.take(c, range(0, c.shape[ax] - 2 * k), axis=ax)) / (2 * k)
    return x
lb = blur(0.3 * A[..., 0] + 0.59 * A[..., 1] + 0.11 * A[..., 2])
ln = np.clip(lb * 0.4 + lP * 0.85 * 0.6, 0.3, 0.75)[..., None]
A[..., :3] = A[..., :3] * (1 - Nk) + (P / lP) * ln * Nk
# side of the face: one clean skin tone continuing the portrait's (its own painted shading kept softly, dark
# smudges lifted) — no seam where the front projection ends, no old cheek tone / painted shadows behind it
lumc = 0.3 * A[..., 0] + 0.59 * A[..., 1] + 0.11 * A[..., 2]
lbc = blur(lumc, 7)
Ck = (CheekW * (1 - F) * sstep(0.08, 0.14, lumc))[..., None]
lc = np.clip(lbc * 0.35 + lP * 0.65, lP * 0.82, lP * 1.04)[..., None]
A[..., :3] = A[..., :3] * (1 - Ck) + (P / lP) * lc * Ck
print('cheek repaint texels', int((Ck[..., 0] > 0.5).sum()))
# --- hands: UVs into the top-right corner patch, painted glove / skin -----------------------------------------
# reference colours: forearm skin (just above the jacket cuff) and the glove cuff, sampled through UV 'new'
bm = bmesh.new(); bm.from_mesh(me); uvl = bm.loops.layers.uv['new']; ihl = bm.verts.layers.float['is_hand']; gl = bm.verts.layers.float['glove']
def samp(pred):
    cs = []
    for f in bm.faces:
        if f.verts[0][ihl] > 0.5 or not pred(f.calc_center_median()): continue
        for l in f.loops:
            u, v = l[uvl].uv; cs.append(A[min(1023, int(v * 1024)), min(1023, int(u * 1024)), :3])
    return np.array(cs)
fore = samp(lambda c: 0.09 < c.z < 0.16 and abs(c.x) > 0.25)
fl = 0.3 * fore[:, 0] + 0.59 * fore[:, 1] + 0.11 * fore[:, 2]
skin_c = np.median(fore[(fore[:, 0] - fore[:, 2] > 0.08) & (fl > 0.2)], 0)
cuff = samp(lambda c: 0.025 < c.z < 0.045 and abs(c.x) > 0.25)
glove_c = np.array([0.12, 0.115, 0.11])   # charcoal fingerless gloves (concept sheet)
print('forearm skin', skin_c.round(3), 'glove', glove_c.round(3))
U0, U1, VC, VH = 0.957, 0.993, 0.975, 0.015
for f in bm.faces:
    if f.verts[0][ihl] < 0.5: continue
    for l in f.loops:
        v = l.vert; side = 1 if v.co.x > 0 else -1
        palm = max(-1.0, min(1.0, -v.normal.x * side))     # +1 palm (faces the thigh), −1 back of the hand
        sd = v[gl]
        l[uvl].uv = (U0 + (U1 - U0) * (0.5 + 0.5 * palm), VC + max(-0.055, min(0.055, sd)) * 0.3)   # linear: the interpolated edge is straight
from mathutils import Vector
for side in (1, -1):
    k = hero['cut%+d' % side]; C = Vector(k[:3]); a = Vector(k[3:])
    near = [f for f in bm.faces if f.verts[0][ihl] < 0.5 and (f.calc_center_median() - C).length < 0.09]
    geom = near + list({e for f in near for e in f.edges}) + list({v for f in near for v in f.verts})
    bmesh.ops.bisect_plane(bm, geom=geom, plane_co=C - a * 0.03, plane_no=-a)
    band = [f for f in bm.faces if f.verts[0][ihl] < 0.5 and (f.calc_center_median() - C).length < 0.09 and -0.001 < (f.calc_center_median() - C).dot(-a) < 0.03]
    for f in band:
        for l in f.loops:
            side_n = max(-1.0, min(1.0, -l.vert.normal.x * side))
            l[uvl].uv = (U0 + (U1 - U0) * (0.5 + 0.5 * side_n * 0.3 - 0.35), VC + 0.0165)
    print('cuff band faces', side, len(band))
bm.to_mesh(me); bm.free()
# paint the corner block: columns = back → palm, rows: glove above VC, skin below (edge between texel rows)
y0, x0 = int(0.95 * 1024), int(0.95 * 1024)
ys = (np.arange(y0, 1024) + 0.5) / 1024; xs = (np.arange(x0, 1024) + 0.5) / 1024
pal = np.clip((xs - U0) / (U1 - U0), 0, 1)[None, :, None]           # 0 back … 1 palm
rng = np.random.default_rng(7)
noise = rng.normal(0, 1, (len(ys), len(xs), 1)).astype(np.float32)
glove_back = glove_c * 0.85; glove_palm = glove_c * 1.25 + np.array([0.01, 0.008, 0.005])
skin_back = skin_c; skin_palm = skin_c * np.array([1.05, 0.97, 0.95])
G = glove_back + (glove_palm - glove_back) * pal + noise * 0.006
Sk = skin_back + (skin_palm - skin_back) * pal + noise * 0.004
isglove = (ys > VC)[:, None, None]
A[y0:, x0:, :3] = np.where(isglove, G, Sk)
# jacket-olive block for the arm / jacket-side caps (build4a): the median olive of the jacket, a little shadowed
oh = (A[..., 1] >= A[..., 0] - 0.01) & (A[..., 1] > A[..., 2] + 0.04) & (lum > 0.12) & (lum < 0.4)
olive = np.median(A[oh][:, :3], 0) * 0.8
jx0, jx1 = int(0.90 * 1024), int(0.945 * 1024)
A[y0:, jx0:jx1, :3] = olive + rng.normal(0, 0.006, (1024 - y0, jx1 - jx0, 1)).astype(np.float32)
A[y0:, jx0:jx1, 3] = 1
print('jacket olive', olive.round(3))
A[y0:, x0:, 3] = 1
img = bpy.data.images['hero_albedo']; img.pixels[:] = A.ravel(); img.update()
img.filepath_raw = SP + r"\r\hero_albedo_v2.png"; img.file_format = 'PNG'; img.save()
bpy.ops.wm.save_as_mainfile(filepath=SP + r"\hero_step3c.blend")
