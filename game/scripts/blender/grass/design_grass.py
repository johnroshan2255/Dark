"""
GRASS DESIGN (2026-10-24, the user: "redesign our grass in Blender … optimized and styled to look too good", reference:
soft stylized meadow — tall tapered blades in dense TUFTS, dark cool base → pale warm tip, almost unlit, hazy distance).

Builds ONE 1 m² grass PATCH exactly as the game would (the same budget as today's grass: ULTRA near layer = 42 blades
× 3 triangles = 126 triangles; no texture, no alpha test, opaque), tiles it over a field with random turns, shades it
the way the game's shader would (base→tip ramp, per-tuft hue, soft wrap light, distance haze) and renders previews.

  blender -b --factory-startup --python design_grass.py -- OUT=<dir> [BLADES=42] [SEG=2] [SEED=7]

Writes <OUT>/grass_field.png, grass_close.png, grass_patch.png (one patch, wireframe over shaded) and grass_stats.txt.
"""
import bpy, bmesh, math, random, sys, os
from mathutils import Vector

args = dict(a.split('=', 1) for a in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []))
OUT = args.get('OUT', os.path.join(os.path.dirname(__file__), 'out'))
BLADES = int(args.get('BLADES', 42))
SEG = int(args.get('SEG', 2))
SEED = int(args.get('SEED', 7))
WIDE = float(args.get('WIDE', 1))
PER = int(args.get('PER', 7))
CURL = float(args.get('CURL', 1))
RAD = float(args.get('RAD', 0.07))     # clump root radius (m)
LEAN = float(args.get('LEAN', 1))      # lean / bend multiplier
TOPW = float(args.get('TOPW', 0.35))
HT = float(args.get('HT', 1))
PUFF = float(args.get('PUFF', 0))      # clumps as soft domes: shape (taller middle) + ball shading          # blade height multiplier
MASS = float(args.get('MASS', 0))      # field: big grass MASSES (~3 m noise) with ground showing between (0 = even)   # blunt blades: top width / root width
os.makedirs(OUT, exist_ok=True)

# ---------------------------------------------------------------- the patch (what the game will build)
# Blades grow in TUFTS (6–8 per tuft, ~6 tufts per m²): each tuft has a root area r ≈ 6 cm, its blades fan outward
# a little and their tips curl over — all leaning a touch the same way (the wind's set), heights varied 0.35–0.75 m.
# A blade is a tapered ribbon: SEG = 1 → 1 triangle, 2 → 3 triangles (one bend), 3 → 5 triangles (two bends).
WIND = Vector((0.8, 0.0, 0.6)).normalized()   # (x, z ground plane; y up — built as Blender x, y below)


def build_patch(blades, seg, seed):
    rnd = random.Random(seed)
    verts, faces, tip, tuft, side, cn, bv = [], [], [], [], [], [], []
    per = PER
    b = 0
    while b < blades:
        n = min(per + rnd.randint(-1, 1), blades - b)
        # tufts spread EVENLY over the patch (an R2 low-discrepancy sequence + a little jitter): no bare holes
        ti = b // max(1, per)
        tx = (0.31 + ti * 0.7548777) % 1 - 0.5 + rnd.uniform(-0.06, 0.06)
        ty = (0.17 + ti * 0.5698403) % 1 - 0.5 + rnd.uniform(-0.06, 0.06)
        th = rnd.random()                      # per-tuft hue
        tall = 0.55 + 0.85 * rnd.random() ** 1.3  # per-tuft height (strong: clumps read as soft tussocks)
        for k in range(n):
            a = rnd.uniform(0, math.tau)
            r = 0.01 + RAD * math.sqrt(rnd.random())
            rx, ry = tx + math.cos(a) * r, ty + math.sin(a) * r
            h = (0.48 + 0.4 * rnd.random() ** 0.8) * tall * HT
            # PUFF (2026-10-25, the user: "too hard and sharp — I need fluff and puff"): a clump is a DOME — the
            # blades tallest in its middle, shorter and leaning outward toward its rim
            rr = min(1.0, r / max(RAD, 1e-3))
            h *= 1.0 - PUFF * 0.5 * rr * rr
            w = (0.03 + 0.018 * rnd.random()) * WIDE  # half width at the root (6–9.6 cm wide blades × WIDE)
            face = rnd.uniform(0, math.pi)
            # lean: outward from the tuft + the wind's set. The blade is an ARC of fixed length h: it leaves the root
            # at a small angle and curls to `curl` at the tip (the tip droops as it bends) — each straight segment
            # takes the arc's angle at its middle, so the one joint turns by only half the curl (no hard kink)
            # SOFT / SOAKED (2026-10-25, the user: "the reference grass is soaked and sluggy loose, ours is hardened"):
            # each blade flops its own way (the wind only a hint), bends over under its own weight — a long, heavy
            # curl concentrated toward the tip, the longer blades drooping most — and stays wide like a wet ribbon
            out = Vector((math.cos(a + rnd.uniform(-0.9, 0.9)), math.sin(a + rnd.uniform(-0.9, 0.9)), 0)) * (0.6 + 0.8 * rnd.random())
            wind = Vector((WIND.x, WIND.z, 0)) * (0.15 + 0.25 * rnd.random())
            d = out + wind
            curl = (0.35 + 0.75 * rnd.random() ** 1.2) * (0.8 + 0.4 * h / 0.8) * CURL * LEAN
            d.normalize()
            lean0 = (0.06 + 0.2 * rnd.random()) * LEAN + PUFF * 0.55 * rr
            if PUFF > 0:
                d = (d + Vector((math.cos(a), math.sin(a), 0)) * PUFF * rr * 1.5).normalized()  # (rim blades fan out)
            px, py = math.cos(face) * w, math.sin(face) * w
            # the ribbon's stations: t, width factor (stays wide, then a long taper to the point)
            # (SEG 0 / −2: BLUNT blades — no pointed tip (2026-10-25, the user: "ours have too sharp ends"): the
            #  ribbon ends in a narrow soft top edge, TOPW of the root width; 1 quad = 2 tris, or 2 quads = 4 tris)
            blunt = seg <= 0
            st = {1: [(0, 1)], 2: [(0, 1), (0.55, 0.82)], 3: [(0, 1), (0.4, 0.95), (0.74, 0.78)],
                  0: [(0, 1), (1, TOPW)], -2: [(0, 1), (0.62, 0.92), (1, TOPW)]}[seg]  # (−2: a STRAP — parallel to ~⅔, then a long soft taper)
            ts = [t for t, _ in st] + ([] if blunt else [1.0])
            pts = [Vector((rx, ry, 0))]
            for i in range(len(ts) - 1):
                ang = lean0 + curl * ((ts[i] + ts[i + 1]) / 2) ** 1.5
                pts.append(pts[-1] + (d * math.sin(ang) + Vector((0, 0, math.cos(ang)))) * h * (ts[i + 1] - ts[i]))
            base = len(verts)
            bri = 0.78 + 0.32 * rnd.random()     # (each blade its own brightness: the reference's depth / softness)
            for (t, wf), c in zip(st, pts):
                bv += [bri, bri]
                verts += [(c.x + px * wf, c.y + py * wf, c.z), (c.x - px * wf, c.y - py * wf, c.z)]
                # the clump's ball normal: out of the dome (its centre ~a third down the clump) — the tuft shades as
                # one soft volume, lit on top, deeper inside / under (the game: the same, as the blade normal)
                q = Vector((c.x - tx, c.y - ty, c.z - 0.35 * tall * HT)); q.z = max(q.z, 0.0) + 0.15
                q.normalize(); cn += [q.x, q.y, q.z, q.x, q.y, q.z]
                tip += [t, t]; tuft += [th, th]; side += [0, 1]
            if not blunt:
                T = pts[-1]
                verts.append((T.x, T.y, T.z)); tip.append(1.0); tuft.append(th); side.append(0.5); bv.append(bri)
                q = Vector((T.x - tx, T.y - ty, T.z - 0.35 * tall * HT)); q.z = max(q.z, 0.0) + 0.15
                q.normalize(); cn += [q.x, q.y, q.z]
            ns = len(st)
            for i in range(ns - 1):
                l0, r0, l1, r1 = base + 2 * i, base + 2 * i + 1, base + 2 * i + 2, base + 2 * i + 3
                faces += [(l0, r0, l1), (r0, r1, l1)]
            if not blunt:
                faces.append((base + 2 * ns - 2, base + 2 * ns - 1, base + 2 * ns))
            b += 1
    me = bpy.data.meshes.new('grass_patch')
    me.from_pydata(verts, [], faces)
    at = me.attributes.new('cn', 'FLOAT_VECTOR', 'POINT'); at.data.foreach_set('vector', cn)
    for name, vals in (('tip', tip), ('tuft', tuft), ('bv', bv)):
        at = me.attributes.new(name, 'FLOAT', 'POINT')
        at.data.foreach_set('value', vals)
    me.update()
    return me, len(verts), len(faces)


# ---------------------------------------------------------------- scene
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
for eng in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'):
    try:
        sc.render.engine = eng
        break
    except TypeError:
        pass
sc.view_settings.view_transform = 'Standard'
sc.render.film_transparent = False

patch, nv, nt = build_patch(BLADES, SEG, SEED)

# The game's look: colour = ramp(tip) (cool deep base → fresh mid → pale warm tip) shifted per tuft, lit softly
# (normals ≈ up in the game: the meadow shades as one surface — here: mostly emission + a little wrap diffuse),
# hazed with distance toward the sky.
# (2026-10-25, matched to the reference's pixels: one soft yellow-green, low contrast root → tip; linear values)
BASE, MID, TIP = (0.14, 0.3, 0.14), (0.27, 0.49, 0.23), (0.48, 0.68, 0.34)
SKY = (0.6, 0.76, 0.76)


def grass_mat():
    m = bpy.data.materials.new('grass')
    m.use_nodes = True
    nt_ = m.node_tree
    N, L = nt_.nodes, nt_.links
    N.clear()
    out = N.new('ShaderNodeOutputMaterial')
    tipA = N.new('ShaderNodeAttribute'); tipA.attribute_name = 'tip'
    tufA = N.new('ShaderNodeAttribute'); tufA.attribute_name = 'tuft'
    ramp = N.new('ShaderNodeValToRGB')
    cr = ramp.color_ramp
    cr.elements[0].position, cr.elements[0].color = 0.0, (*BASE, 1)
    cr.elements[1].position, cr.elements[1].color = 1.0, (*TIP, 1)
    e = cr.elements.new(0.45); e.color = (*MID, 1)
    pw = N.new('ShaderNodeMath'); pw.operation = 'POWER'; pw.inputs[1].default_value = 0.85
    L.new(tipA.outputs['Fac'], pw.inputs[0]); L.new(pw.outputs[0], ramp.inputs['Fac'])
    # per-tuft hue: a little bluer / yellower (and per patch: Object Info random)
    oi = N.new('ShaderNodeObjectInfo')
    mixv = N.new('ShaderNodeMath'); mixv.operation = 'MULTIPLY_ADD'
    mixv.inputs[1].default_value = 0.6
    L.new(tufA.outputs['Fac'], mixv.inputs[0]); L.new(oi.outputs['Random'], mixv.inputs[2])
    hue = N.new('ShaderNodeMix'); hue.data_type = 'RGBA'; hue.blend_type = 'MIX'
    hue.inputs['A'].default_value = (0.94, 1.0, 1.02, 1)
    hue.inputs['B'].default_value = (1.05, 1.02, 0.94, 1)
    sc_ = N.new('ShaderNodeMath'); sc_.operation = 'MULTIPLY'; sc_.inputs[1].default_value = 0.625
    L.new(mixv.outputs[0], sc_.inputs[0]); L.new(sc_.outputs[0], hue.inputs['Factor'])
    tint = N.new('ShaderNodeMix'); tint.data_type = 'RGBA'; tint.blend_type = 'MULTIPLY'
    tint.inputs['Factor'].default_value = 1.0
    bvA = N.new('ShaderNodeAttribute'); bvA.attribute_name = 'bv'
    hb = N.new('ShaderNodeMix'); hb.data_type = 'RGBA'; hb.blend_type = 'MULTIPLY'; hb.inputs['Factor'].default_value = 1.0
    L.new(hue.outputs['Result'], hb.inputs['A']); L.new(bvA.outputs['Fac'], hb.inputs['B'])
    L.new(ramp.outputs['Color'], tint.inputs['A']); L.new(hb.outputs['Result'], tint.inputs['B'])
    # soft light: 0.78 emission + diffuse (the sun) — the game's wrap-lit, up-normal meadow
    em = N.new('ShaderNodeEmission'); em.inputs['Strength'].default_value = 0.7
    df = N.new('ShaderNodeBsdfDiffuse')
    up = N.new('ShaderNodeCombineXYZ'); up.inputs['Z'].default_value = 1.0   # (the game's blades: normals up — soft)
    if PUFF > 0:
        cnA = N.new('ShaderNodeAttribute'); cnA.attribute_name = 'cn'
        L.new(cnA.outputs['Vector'], df.inputs['Normal'])
        # (and the emission: brighter on the dome's top, deeper toward its inside / foot — a soft ball)
        sep = N.new('ShaderNodeSeparateXYZ'); L.new(cnA.outputs['Vector'], sep.inputs[0])
        ao = N.new('ShaderNodeMapRange'); ao.inputs['From Min'].default_value = 0.0; ao.inputs['From Max'].default_value = 1.0
        ao.inputs['To Min'].default_value = 0.8; ao.inputs['To Max'].default_value = 1.06
        L.new(sep.outputs['Z'], ao.inputs['Value'])
        mul = N.new('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'; mul.inputs['Factor'].default_value = 1.0
        L.new(tint.outputs['Result'], mul.inputs['A']); L.new(ao.outputs['Result'], mul.inputs['B'])
        L.new(mul.outputs['Result'], em.inputs['Color'])
    else:
        L.new(up.outputs[0], df.inputs['Normal'])
    L.new(tint.outputs['Result'], df.inputs['Color'])
    if PUFF <= 0:
        L.new(tint.outputs['Result'], em.inputs['Color'])
    add = N.new('ShaderNodeAddShader')
    L.new(em.outputs[0], add.inputs[0]); L.new(df.outputs[0], add.inputs[1])
    # distance haze (the game's fog): mix to the sky colour by view distance
    cam = N.new('ShaderNodeCameraData')
    fz = N.new('ShaderNodeMapRange'); fz.inputs['From Min'].default_value = 6; fz.inputs['From Max'].default_value = 45
    fz.inputs['To Max'].default_value = 0.75
    L.new(cam.outputs['View Distance'], fz.inputs['Value'])
    fog = N.new('ShaderNodeEmission'); fog.inputs['Color'].default_value = (*SKY, 1)
    mixs = N.new('ShaderNodeMixShader')
    L.new(fz.outputs['Result'], mixs.inputs['Fac']); L.new(add.outputs[0], mixs.inputs[1]); L.new(fog.outputs[0], mixs.inputs[2])
    L.new(mixs.outputs[0], out.inputs['Surface'])
    m.use_backface_culling = False
    return m


def ground_mat():
    m = bpy.data.materials.new('ground')
    m.use_nodes = True
    N, L = m.node_tree.nodes, m.node_tree.links
    N.clear()
    out = N.new('ShaderNodeOutputMaterial')
    em = N.new('ShaderNodeEmission'); em.inputs['Color'].default_value = (0.27, 0.47, 0.24, 1); em.inputs['Strength'].default_value = 0.8
    df = N.new('ShaderNodeBsdfDiffuse'); df.inputs['Color'].default_value = (0.27, 0.47, 0.24, 1)
    add = N.new('ShaderNodeAddShader')
    L.new(em.outputs[0], add.inputs[0]); L.new(df.outputs[0], add.inputs[1])
    cam = N.new('ShaderNodeCameraData')
    fz = N.new('ShaderNodeMapRange'); fz.inputs['From Min'].default_value = 6; fz.inputs['From Max'].default_value = 45
    fz.inputs['To Max'].default_value = 0.75
    L.new(cam.outputs['View Distance'], fz.inputs['Value'])
    fog = N.new('ShaderNodeEmission'); fog.inputs['Color'].default_value = (*SKY, 1)
    mixs = N.new('ShaderNodeMixShader')
    L.new(fz.outputs['Result'], mixs.inputs['Fac']); L.new(add.outputs[0], mixs.inputs[1]); L.new(fog.outputs[0], mixs.inputs[2])
    L.new(mixs.outputs[0], out.inputs['Surface'])
    return m


gm = grass_mat()
patch.materials.append(gm)

# field: the patch tiled on a jittered 1 m grid with random turns (as GrassField does)
rnd = random.Random(99)
F = 26
col = bpy.data.collections.new('field'); sc.collection.children.link(col)
for i in range(-F, F):
    for j in range(-6, 2 * F):
        o = bpy.data.objects.new(f'p{i}_{j}', patch)
        o.location = (i + rnd.uniform(-0.2, 0.2), j + rnd.uniform(-0.2, 0.2), 0)
        o.rotation_euler = (0, 0, rnd.choice([0, 0.5, 1, 1.5]) * math.pi + rnd.uniform(-0.3, 0.3))
        s = s0 = 0.9 + 0.2 * rnd.random()
        if MASS > 0:
            from mathutils import noise as _nz
            m = _nz.noise(Vector((i * 0.33, j * 0.33, 0.5)))           # −1..1 over ~3 m
            # (the mass's edge: the patches shrink to nothing over ~1.5 m — no square holes; the game does the
            #  same per BLADE with its density attribute, so there the edge is softer still)
            e = min(1.0, max(0.0, (m + 0.5 * MASS) / 0.55))
            e = e * e * (3 - 2 * e)
            if e < 0.12:
                continue
            s *= 0.25 + 0.95 * e
        o.scale = (s0, s0, s)  # (masses: taller toward their middle)
        col.objects.link(o)

bpy.ops.mesh.primitive_plane_add(size=400, location=(0, 0, 0))
bpy.context.object.data.materials.append(ground_mat())

w = sc.world or bpy.data.worlds.new('w'); sc.world = w
w.use_nodes = True
bg = w.node_tree.nodes.get('Background')
bg.inputs['Color'].default_value = (*SKY, 1); bg.inputs['Strength'].default_value = 1.0
# (the sky seen is SKY; the light it gives is weak — the shading is the material's own soft term, as in the game)
lp = w.node_tree.nodes.new('ShaderNodeLightPath')
dim = w.node_tree.nodes.new('ShaderNodeBackground'); dim.inputs['Color'].default_value = (*SKY, 1); dim.inputs['Strength'].default_value = 0.15
ms = w.node_tree.nodes.new('ShaderNodeMixShader')
wo = w.node_tree.nodes.get('World Output')
w.node_tree.links.new(lp.outputs['Is Camera Ray'], ms.inputs['Fac'])
w.node_tree.links.new(dim.outputs[0], ms.inputs[1]); w.node_tree.links.new(bg.outputs[0], ms.inputs[2])
w.node_tree.links.new(ms.outputs[0], wo.inputs['Surface'])

sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
sun.data.energy = 1.2; sun.data.angle = math.radians(12); sun.data.use_shadow = False  # (the game's grass casts none)
sun.rotation_euler = (math.radians(50), 0, math.radians(140))
sc.collection.objects.link(sun)

cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
cam.data.lens = 24
sc.collection.objects.link(cam); sc.camera = cam
sc.render.resolution_x, sc.render.resolution_y = 1280, 600


def shot(name, loc, look, lens=24):
    cam.location = loc
    d = Vector(look) - Vector(loc)
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = lens
    sc.render.filepath = os.path.join(OUT, name)
    bpy.ops.render.render(write_still=True)


shot('grass_field.png', (0.3, -2.4, 2.5), (0.0, 6.5, -0.6), lens=18)
shot('grass_close.png', (0.2, -1.6, 0.75), (0.4, 2.0, 0.35), lens=28)

# one patch alone, from above at an angle
col.hide_render = True
one = bpy.data.objects.new('one', patch); sc.collection.objects.link(one)
one.location = (0, 30, 0)
shot('grass_patch.png', (1.6, 28.2, 1.3), (0, 30, 0.3), lens=35)

with open(os.path.join(OUT, 'grass_stats.txt'), 'w') as f:
    f.write(f'blades {BLADES} seg {SEG}: {nv} vertices, {nt} triangles per 1 m2 patch\n')
print('GRASS', BLADES, SEG, nv, nt)
