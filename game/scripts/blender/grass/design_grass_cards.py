"""
GRASS DESIGN — TUFT CARDS (2026-10-25, the user: "too hard and sharp — I need fluff and puff", reference: a soft,
full meadow of fine blades). Solid per-blade geometry can't be fluffy at the phone budget (~64 blades / m², each a
hard-edged strip); a CARD holds a whole soft tuft. This prototype:
  1. renders ONE tuft texture: ~90 fine curved blades (soft tips, a root → tip gradient in GREY so the game tints it
     per map), front-on, orthographic, transparent background, 512 × 512 → grass_tuft.png;
  2. builds a field of tufts, each 3 crossed cards (6 triangles) with that texture (alpha), in big masses with ground
     between them (like the reference), shaded softly, hazed with distance → cards_field.png, cards_close.png.

  blender -b --factory-startup --python design_grass_cards.py -- OUT=<dir> [TUFTS=7] [SEED=3]
"""
import bpy, math, random, sys, os
from mathutils import Vector, noise

args = dict(a.split('=', 1) for a in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []))
OUT = args.get('OUT', os.path.join(os.path.dirname(__file__), 'out'))
TUFTS = float(args.get('TUFTS', 7))
SEED = int(args.get('SEED', 3))
HT = float(args.get('HT', 1))   # tuft size multiplier
os.makedirs(OUT, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
for eng in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'):
    try:
        sc.render.engine = eng
        break
    except TypeError:
        pass
sc.view_settings.view_transform = 'Standard'

# ------------------------------------------------------------------ 1. the tuft texture
rnd = random.Random(SEED)
verts, faces, tipv = [], [], []
for b in range(90):
    x0 = rnd.gauss(0, 0.11)                       # roots bunched in the middle
    h = 0.55 + 0.4 * rnd.random() ** 0.7 - abs(x0) * 0.9   # taller in the middle: a soft dome
    lean = x0 * 1.6 + rnd.uniform(-0.25, 0.25)    # fanning out a little from the middle
    curl = rnd.uniform(-0.5, 0.5)
    w = 0.009 + 0.008 * rnd.random()
    z = rnd.uniform(-0.05, 0.05)
    N = 6
    base = len(verts)
    for k in range(N + 1):
        t = k / N
        ang = lean * 0.5 + (lean * 0.4 + curl) * t * t
        px = x0 + math.sin(ang) * h * t * 0.9
        py = h * t * (1 - 0.1 * abs(curl) * t)
        ww = w * (1 - t) ** 0.7 + 0.0008             # long taper to a fine soft tip
        verts += [(px - ww, z, py), (px + ww, z, py)]
        tipv += [t, t]
    for k in range(N):
        a = base + 2 * k
        faces += [(a, a + 1, a + 3), (a, a + 3, a + 2)]
me = bpy.data.meshes.new('tuft'); me.from_pydata(verts, [], faces)
at = me.attributes.new('tip', 'FLOAT', 'POINT'); at.data.foreach_set('value', tipv)
tuft = bpy.data.objects.new('tuft', me); sc.collection.objects.link(tuft)
m = bpy.data.materials.new('blade'); m.use_nodes = True
Nn, Ln = m.node_tree.nodes, m.node_tree.links
Nn.clear()
o = Nn.new('ShaderNodeOutputMaterial'); e = Nn.new('ShaderNodeEmission'); a = Nn.new('ShaderNodeAttribute'); a.attribute_name = 'tip'
r = Nn.new('ShaderNodeValToRGB')
r.color_ramp.elements[0].color = (0.42, 0.42, 0.42, 1); r.color_ramp.elements[1].color = (1, 1, 1, 1)
r.color_ramp.elements[0].position = 0.0; r.color_ramp.elements[1].position = 0.9
Ln.new(a.outputs['Fac'], r.inputs['Fac']); Ln.new(r.outputs['Color'], e.inputs['Color']); Ln.new(e.outputs[0], o.inputs['Surface'])
me.materials.append(m)
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
cam.data.type = 'ORTHO'; cam.data.ortho_scale = 1.2
cam.location = (0, -3, 0.6); cam.rotation_euler = (math.pi / 2, 0, 0)
sc.render.film_transparent = True
sc.render.resolution_x = sc.render.resolution_y = 512
try:
    sc.render.filter_size = 1.5   # (soft edges)
except AttributeError:
    pass
w = bpy.data.worlds.new('w'); sc.world = w
sc.render.filepath = os.path.join(OUT, 'grass_tuft.png')
bpy.ops.render.render(write_still=True)
bpy.data.objects.remove(tuft)

# ------------------------------------------------------------------ 2. the field of card tufts
sc.render.film_transparent = False
SKY = (0.6, 0.76, 0.76)
w.use_nodes = True
bg = w.node_tree.nodes.get('Background'); bg.inputs['Color'].default_value = (*SKY, 1); bg.inputs['Strength'].default_value = 1.0
img = bpy.data.images.load(os.path.join(OUT, 'grass_tuft.png'))
cm = bpy.data.materials.new('cards'); cm.use_nodes = True
Nn, Ln = cm.node_tree.nodes, cm.node_tree.links
Nn.clear()
o = Nn.new('ShaderNodeOutputMaterial'); tex = Nn.new('ShaderNodeTexImage'); tex.image = img
tex.extension = 'CLIP'
tint = Nn.new('ShaderNodeMix'); tint.data_type = 'RGBA'; tint.blend_type = 'MULTIPLY'; tint.inputs['Factor'].default_value = 1
tint.inputs['B'].default_value = (0.42, 0.66, 0.32, 1)
Ln.new(tex.outputs['Color'], tint.inputs['A'])
em = Nn.new('ShaderNodeEmission'); em.inputs['Strength'].default_value = 1.0
Ln.new(tint.outputs['Result'], em.inputs['Color'])
camd = Nn.new('ShaderNodeCameraData'); fz = Nn.new('ShaderNodeMapRange')
fz.inputs['From Min'].default_value = 6; fz.inputs['From Max'].default_value = 45; fz.inputs['To Max'].default_value = 0.75
Ln.new(camd.outputs['View Distance'], fz.inputs['Value'])
fog = Nn.new('ShaderNodeEmission'); fog.inputs['Color'].default_value = (*SKY, 1)
mx = Nn.new('ShaderNodeMixShader'); Ln.new(fz.outputs['Result'], mx.inputs['Fac']); Ln.new(em.outputs[0], mx.inputs[1]); Ln.new(fog.outputs[0], mx.inputs[2])
tr = Nn.new('ShaderNodeBsdfTransparent'); mx2 = Nn.new('ShaderNodeMixShader')
Ln.new(tex.outputs['Alpha'], mx2.inputs['Fac']); Ln.new(tr.outputs[0], mx2.inputs[1]); Ln.new(mx.outputs[0], mx2.inputs[2])
Ln.new(mx2.outputs[0], o.inputs['Surface'])
try:
    cm.surface_render_method = 'DITHERED'
except AttributeError:
    pass
cm.use_backface_culling = False

# one card tuft: 3 crossed quads (60° apart), 1 m wide × 1 m tall in uv, scaled per instance
cv, cf, cu = [], [], []
for k in range(3):
    ang = k * math.pi / 3
    dx, dy = math.cos(ang) * 0.5, math.sin(ang) * 0.5
    b0 = len(cv)
    cv += [(-dx, -dy, -0.1), (dx, dy, -0.1), (dx, dy, 1.1), (-dx, -dy, 1.1)]
    cu += [(0, 0), (1, 0), (1, 1), (0, 1)]
    cf.append((b0, b0 + 1, b0 + 2, b0 + 3))
cme = bpy.data.meshes.new('card'); cme.from_pydata(cv, [], cf)
uvl = cme.uv_layers.new(name='UV')
for poly in cme.polygons:
    for li in poly.loop_indices:
        uvl.data[li].uv = cu[cme.loops[li].vertex_index]
cme.materials.append(cm)

g = random.Random(11)
col = bpy.data.collections.new('field'); sc.collection.children.link(col)
F = 24
for i in range(-F, F):
    for j in range(-6, 2 * F):
        mval = noise.noise(Vector((i * 0.33, j * 0.33, 0.5)))
        e2 = min(1.0, max(0.0, (mval + 0.5) / 0.55)); e2 = e2 * e2 * (3 - 2 * e2)
        n = int(TUFTS * e2 + g.random())
        for t in range(n):
            ob = bpy.data.objects.new('c', cme)
            ob.location = (i + g.random(), j + g.random(), 0)
            ob.rotation_euler = (0, 0, g.random() * math.pi)
            s = (0.55 + 0.45 * g.random()) * (0.55 + 0.45 * e2) * HT
            ob.scale = (s * (0.9 + 0.3 * g.random()), s, s * (1.0 + 0.4 * g.random()))
            col.objects.link(ob)
gp = bpy.data.objects.new('ground', bpy.data.meshes.new('gp'))
gp.data.from_pydata([(-200, -200, 0), (200, -200, 0), (200, 200, 0), (-200, 200, 0)], [], [(0, 1, 2, 3)])
gm = bpy.data.materials.new('g'); gm.use_nodes = True
Nn, Ln = gm.node_tree.nodes, gm.node_tree.links
Nn.clear()
o = Nn.new('ShaderNodeOutputMaterial'); em = Nn.new('ShaderNodeEmission'); em.inputs['Color'].default_value = (0.26, 0.44, 0.22, 1)
camd = Nn.new('ShaderNodeCameraData'); fz = Nn.new('ShaderNodeMapRange')
fz.inputs['From Min'].default_value = 6; fz.inputs['From Max'].default_value = 45; fz.inputs['To Max'].default_value = 0.75
Ln.new(camd.outputs['View Distance'], fz.inputs['Value'])
fog = Nn.new('ShaderNodeEmission'); fog.inputs['Color'].default_value = (*SKY, 1)
mx = Nn.new('ShaderNodeMixShader'); Ln.new(fz.outputs['Result'], mx.inputs['Fac']); Ln.new(em.outputs[0], mx.inputs[1]); Ln.new(fog.outputs[0], mx.inputs[2])
Ln.new(mx.outputs[0], o.inputs['Surface'])
gp.data.materials.append(gm); sc.collection.objects.link(gp)

cam.data.type = 'PERSP'
sc.render.resolution_x, sc.render.resolution_y = 1280, 600


def shot(name, loc, look, lens):
    cam.location = loc
    cam.rotation_euler = (Vector(look) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = lens
    sc.render.filepath = os.path.join(OUT, name)
    bpy.ops.render.render(write_still=True)


shot('cards_field.png', (0.3, -2.4, 2.5), (0.0, 6.5, -0.6), 18)
shot('cards_close.png', (0.2, -1.6, 0.8), (0.4, 2.0, 0.4), 28)
print('CARDS done: 6 tris per tuft, ~%.0f tufts / m² in the masses' % TUFTS)
