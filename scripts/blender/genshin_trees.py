"""
GENSHIN-STYLE TREES for DARK (run inside Blender 5.x — Text Editor or the MCP add-on). Builds each tree from
code-driven but hand-tuned parameters, three detail levels per tree, and exports one GLB per tree to OUT:

  mondstadt.glb  the common green broadleaf  (→ species slot 'birch')   ref: slim curving trunk, rounded clumps
  maple.glb      the autumn maple           (→ 'maple')                ref: broad umbrella of layered red clumps
  ancient.glb    the mystic ancient tree    (→ 'ancient')              ref: thick twisting trunk, flat cloud plates
  world_tree.glb the giant landmark oak     (→ landmark GiantTree)     ref: Windrise oak / world tree

How a Genshin canopy is built (and why it is cheap): every crown is a few CLUMPS (ellipsoids). Each clump gets
  - a dark low-poly CORE (icosphere) so the crown never looks see-through, and
  - LEAF CARDS (one quad each, the game's leaf-cluster atlas cell) scattered over the clump surface,
both with SPHERICAL custom normals (out of the clump, bent toward the whole crown) so the crown lights as soft
volumes like Genshin's, never as flat paper. Vertex colours carry a dark-inside / light-top gradient; the game
multiplies its per-tree hues on top. Trunk, limbs and roots are tapered, curving tubes with radial normals.

Materials (the game remaps by name): 'leaf' → the atlas leaf cell, 'bark' → the painted BARK surface texel,
'core' → the plain solid texel. Objects are named <tree>_lod0 / _lod1 / _lod2.

Triangle budget (measured by this script, printed): LOD0 ≈ 350–700 for forest trees (near, HIGH/MEDIUM),
LOD1 ≈ 120–250 (LOW's near trees), LOD2 ≈ 50–90; the world tree ≈ 5–7 k (one per landmark, far LOD ≈ 1.5 k).
"""
import bpy, bmesh, math, random, os
from mathutils import Vector, Matrix, Quaternion

OUT = globals().get('OUT', 'C:/Project/Dark/src/assets/models/trees/')
os.makedirs(OUT, exist_ok=True)

UP = Vector((0, 0, 1))


def srgb(h):
    """0xRRGGBB (sRGB) → linear RGB tuple (Blender colour attributes are linear floats)."""
    c = [((h >> s) & 255) / 255 for s in (16, 8, 0)]
    return tuple((x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def lerp3(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def mul3(a, k):
    return tuple(x * k for x in a)


class Builder:
    """Collects polygons with per-corner uv / colour / normal and a material slot, then makes a mesh."""

    def __init__(self):
        self.v, self.f, self.mat, self.uv, self.col, self.nrm = [], [], [], [], [], []

    def vert(self, p):
        self.v.append(tuple(p))
        return len(self.v) - 1

    def face(self, idx, mat, uvs, cols, nrms):
        self.f.append(idx)
        self.mat.append(mat)
        # Part kind travels in U (leaf 0..1, bark 2, core 4): ONE primitive per LOD — Blender's glTF exporter writes
        # vertex colours only for the first primitive of a multi-material mesh (bark / core came out white).
        self.uv += [(u + 2 * mat, v) for u, v in uvs]
        self.col += cols
        self.nrm += [tuple(n.normalized()) for n in nrms]

    def mesh(self, name):
        me = bpy.data.meshes.new(name)
        me.from_pydata(self.v, [], self.f)
        me.update()
        uvl = me.uv_layers.new(name='UVMap')
        for i, uv in enumerate(self.uv):
            uvl.data[i].uv = uv
        ca = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
        for i, c in enumerate(self.col):
            ca.data[i].color = (*c, 1.0)
        me.color_attributes.active_color = ca
        me.polygons.foreach_set('use_smooth', [True] * len(self.f))
        me.normals_split_custom_set(self.nrm)
        me.materials.append(material('tree'))
        return me

    @property
    def tris(self):
        return sum(len(f) - 2 for f in self.f)


MATS = {'tree': (1, 1, 1, 1), 'leaf': (0.35, 0.6, 0.2, 1), 'bark': (0.4, 0.28, 0.18, 1), 'core': (0.2, 0.35, 0.15, 1)}


def material(name):
    m = bpy.data.materials.get(name)
    if not m:
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        b = m.node_tree.nodes['Principled BSDF']
        b.inputs['Base Color'].default_value = MATS[name]
        # Preview: base colour × vertex colour.
        attr = m.node_tree.nodes.new('ShaderNodeVertexColor')
        attr.layer_name = 'Col'
        mix = m.node_tree.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        mix.blend_type = 'MULTIPLY'
        mix.inputs['Factor'].default_value = 1.0
        mix.inputs[6].default_value = MATS[name]
        m.node_tree.links.new(attr.outputs['Color'], mix.inputs[7])
        m.node_tree.links.new(mix.outputs[2], b.inputs['Base Color'])
    return m


MAT = {'leaf': 0, 'bark': 1, 'core': 2}


# ---- curves ---------------------------------------------------------------------------------------------------
def bezier(p0, p1, p2, p3, t):
    u = 1 - t
    return p0 * (u * u * u) + p1 * (3 * u * u * t) + p2 * (3 * u * t * t) + p3 * (t * t * t)


def path(start, end, d0, d1, wiggle, rng, n):
    """Cubic bezier from start to end leaving along d0, arriving along d1, with a random lateral wiggle."""
    L = (end - start).length
    side = d0.cross(Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0.3))).normalized()
    c1 = start + d0 * (L * 0.38) + side * (L * wiggle)
    c2 = end - d1 * (L * 0.38) - side * (L * wiggle * 0.8)
    return [bezier(start, c1, c2, end, i / n) for i in range(n + 1)]


def tube(b, pts, r0, r1, sides, bark_lo, bark_hi, flare=0.0):
    """Tapered tube along `pts` (parallel-transport frames), radial normals, colour darker at the base."""
    n = len(pts)
    tang = [(pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized() for i in range(n)]
    u = tang[0].cross(Vector((0.31, 0.77, 0.12))).normalized()
    rings = []
    for i, p in enumerate(pts):
        t = tang[i]
        u = (u - t * u.dot(t)).normalized()
        v = t.cross(u)
        k = i / (n - 1)
        r = r0 + (r1 - r0) * (k ** 0.85)
        if flare:
            r *= 1 + flare * math.exp(-k * 9)
        ring = []
        for s in range(sides):
            a = 2 * math.pi * s / sides
            d = u * math.cos(a) + v * math.sin(a)
            ring.append((b.vert(p + d * r), d, lerp3(bark_lo, bark_hi, min(1, k * 1.2))))
        rings.append(ring)
    for i in range(n - 1):
        for s in range(sides):
            a, bb = rings[i][s], rings[i][(s + 1) % sides]
            c, d = rings[i + 1][(s + 1) % sides], rings[i + 1][s]
            b.face([a[0], bb[0], c[0], d[0]], MAT['bark'], [(0, 0)] * 4, [a[2], bb[2], c[2], d[2]], [a[1], bb[1], c[1], d[1]])


def crown_normal(p, c, r, crown_c, crown_r):
    """Spherical canopy normal: out of the clump, bent toward the whole crown's volume, a little up."""
    return ((p - c) / max(r, 1e-3)) * 0.8 + ((p - crown_c) / max(crown_r, 1e-3)) * 0.35 + UP * 0.25


def clump(b, c, r, squash, cards, card_size, rng, dark, light, crown, inner=True):
    """A canopy clump made ONLY of leaf cards (Genshin crowns have no solid core — a low-poly ball read as a
    faceted blob from below): an OUTER shell of `cards` overlapping leaf-cluster cards facing out of the clump, and an
    INNER shell (half as many, darker) that fills the middle so the crown is dense, never see-through.
    Spherical normals (out of the clump, bent toward the whole crown) → soft volume lighting.
    The inner shell is LOD0 only (LOW draws LOD1 up close: −⅓ of its cards)."""
    crown_c, crown_r, z0, z1 = crown
    # Camera-facing cards (the game billboards them): FEWER, LARGER cards overlap into one smooth mass — many small
    # ones read as a cauliflower of separate puffs with dark gaps between them.
    cards = max(3, int(round(cards * 0.6)))
    card_size *= 1.35
    # Light from below → above twice over: across the whole crown AND across this clump (each puff reads as its own
    # bulb, lighter on top, a little darker underneath — the stylized-tree look).
    zc0 = c.z - r * squash
    def shade(p, outer):
        tc = max(0, min(1, (p.z - z0) / max(z1 - z0, 1e-3)))
        tl = max(0, min(1, (p.z - zc0) / max(2 * r * squash, 1e-3)))
        return mul3(lerp3(dark, light, 0.15 + 0.85 * (0.72 * tc + 0.28 * tl) ** 0.85), 0.9 + 0.1 * outer)
    ga = math.pi * (3 - math.sqrt(5))
    for shell, n, lo, hi, ksz in ((0, cards, 0.74, 1.0, 1.0), (1, max(2, cards // 2) if inner else 0, 0.3, 0.58, 0.95)):
        for i in range(n):
            zz = 1 - 2 * (i + 0.5) / n
            rad = math.sqrt(max(0, 1 - zz * zz))
            th = ga * i + rng.uniform(0, 0.6) + shell * 1.3
            d = Vector((math.cos(th) * rad, math.sin(th) * rad, zz))
            if shell == 0 and d.z < -0.6 and rng.random() < 0.5:
                continue
            p = c + Vector((d.x * r, d.y * r, d.z * r * squash)) * rng.uniform(lo, hi)
            # Cards face OUT of the clump (a little random tilt): from any side you see leaf faces, not edges.
            nrm = (d + Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1))) * 0.3 + UP * 0.1).normalized()
            ref = UP if abs(nrm.z) < 0.9 else Vector((1, 0, 0))
            t1 = nrm.cross(ref).normalized()
            t2 = nrm.cross(t1)
            ang = rng.uniform(0, 2 * math.pi)
            t1, t2 = t1 * math.cos(ang) + t2 * math.sin(ang), t2 * math.cos(ang) - t1 * math.sin(ang)
            s = card_size * ksz * rng.uniform(0.85, 1.2) * 0.5
            corners = [p - t1 * s - t2 * s, p + t1 * s - t2 * s, p + t1 * s + t2 * s, p - t1 * s + t2 * s]
            ids = [b.vert(q) for q in corners]
            outer = [0.0 if shell else min(1, (q - c).length / r) for q in corners]
            k = 0.94 if shell else 1.0  # (a darker inner shell showed as dark discs between the cards)
            b.face(ids, MAT['leaf'], [(0, 0), (1, 0), (1, 1), (0, 1)], [mul3(shade(q, o), k) for q, o in zip(corners, outer)], [crown_normal(q, c, r, crown_c, crown_r) for q in corners])


def spray(b, c, r, squash, cards, card_size, rng, dark, light, crown, lod, bark):
    """A Genshin LEAF SPRAY cluster (replaces the ball of cards on broadleaves): a few TWIGS radiate from the branch
    end — up and out, drooping at the tips — and the leaf cards sit ALONG them, so the crown is open and airy
    (sky between the sprays), follows its branches, and its outline breaks up into separate leafy sprays.
    (The twigs themselves are drawn in the card texture — 3D twigs crossed the camera-facing cards.)"""
    crown_c, crown_r, z0, z1 = crown
    def shade(p):
        tc = max(0, min(1, (p.z - z0) / max(z1 - z0, 1e-3)))
        return lerp3(dark, light, 0.25 + 0.75 * tc ** 0.8)  # one soft gradient over the whole crown, low contrast
    ntw = (6, 4, 3)[lod]
    per = max(1, int(round(cards / ntw)))
    for i in range(ntw):
        # Direction: around the clump, biased outward from the crown and upward; a little random.
        a = 2 * math.pi * (i + rng.uniform(0.0, 0.7)) / ntw
        out = (c - crown_c); out.z = 0
        out = out.normalized() if out.length > 1e-3 else Vector((1, 0, 0))
        d = (Vector((math.cos(a), math.sin(a), rng.uniform(0.0, 0.9))) + out * 0.6).normalized()
        L = r * rng.uniform(0.85, 1.2)
        start = c - d * r * 0.2
        end = c + d * L - UP * L * 0.22 * squash
        if False:  # (3D twigs crossed the camera-facing cards as dark sticks; the card texture draws the twigs)
            tube(b, path(start, end, d, (d - UP * 0.6).normalized(), 0.05, rng, 1), max(0.025, r * 0.035), max(0.012, r * 0.012), 3, bark, bark)
        for k in range(per):
            t = 0.4 + 0.6 * (k + 1) / per * rng.uniform(0.85, 1.0)
            q = start + (end - start) * t + Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.6, 0.6))) * r * 0.12
            nrm = crown_normal(q, c, r, crown_c, crown_r)
            ref = UP if abs(nrm.normalized().z) < 0.9 else Vector((1, 0, 0))
            t1 = nrm.cross(ref).normalized(); t2 = nrm.normalized().cross(t1)
            sz = card_size * rng.uniform(0.85, 1.15) * 0.5
            corners = [q - t1 * sz - t2 * sz, q + t1 * sz - t2 * sz, q + t1 * sz + t2 * sz, q - t1 * sz + t2 * sz]
            col = shade(q)
            b.face([b.vert(x) for x in corners], MAT['leaf'], [(0, 0), (1, 0), (1, 1), (0, 1)], [col] * 4, [crown_normal(x, c, r, crown_c, crown_r) for x in corners])


# ---- one tree -------------------------------------------------------------------------------------------------
def tree(P, lod, seed):
    """Build one detail level. P = parameters (see SPECIES)."""
    rng = random.Random(seed)
    b = Builder()
    bark = srgb(P['bark'])
    bark_lo, bark_hi = mul3(bark, 0.7), bark
    dark, light = srgb(P['dark']), srgb(P['light'])
    sides_t = (7, 5, 4)[lod]
    sides_b = (4, 4, 3)[lod] if not P.get('hero') else (6, 5, 3)[lod]
    seg = (7, 4, 2)[lod]
    # TRUNK: an S-curve up to the fork, leaning, flared roots at the foot.
    fork = Vector((P['lean'] * P['fork'] * math.cos(P['leanA']), P['lean'] * P['fork'] * math.sin(P['leanA']), P['fork']))
    d1 = (UP + Vector((math.cos(P['leanA']), math.sin(P['leanA']), 0)) * P['lean'] * 1.5).normalized()
    trunk = path(Vector((0, 0, -0.3)), fork, UP, d1, P['curve'], rng, seg)
    tube(b, trunk, P['trunkR'], P['trunkR'] * 0.62, sides_t, bark_lo, bark_hi, flare=P.get('flare', 0.5))
    # ROOTS (buttress flares into the ground).
    if lod < 2:
        for i in range(P['roots']):
            a = 2 * math.pi * i / P['roots'] + rng.uniform(-0.3, 0.3)
            o = Vector((math.cos(a), math.sin(a), 0))
            # Buttress: leaves the trunk well above the ground, arches out and down into it, stays thick.
            s = Vector((0, 0, P['trunkR'] * 1.5)) + o * P['trunkR'] * 0.45
            e = o * P['trunkR'] * rng.uniform(2.0, 2.7) + Vector((0, 0, -0.35))
            tube(b, path(s, e, (o * 0.6 - UP * 0.2).normalized(), (o * 0.5 - UP * 0.9).normalized(), 0.05, rng, 2 if not P.get('hero') else 4), P['trunkR'] * 0.62, P['trunkR'] * 0.26, 4 if not P.get('hero') else 6, bark_lo, bark_lo)
    # LIMBS → clumps.
    clumps = []
    n = P['limbs']
    for i in range(n):
        a = 2 * math.pi * i / n + rng.uniform(-0.35, 0.35) + P.get('rot', 0)
        el = math.radians(rng.uniform(*P['elev']))
        out = Vector((math.cos(a) * math.cos(el), math.sin(a) * math.cos(el), math.sin(el)))
        L = P['spread'] * rng.uniform(0.85, 1.15)
        start = trunk[-2] + (trunk[-1] - trunk[-2]) * rng.uniform(0.2, 1.0)
        end = start + out * L
        dEnd = (out + UP * P.get('rise', 0.6)).normalized()
        lp = path(start, end, (d1 + out * 0.9).normalized(), dEnd, P['curve'] * 0.6, rng, max(2, seg - 3))
        tube(b, lp, P['trunkR'] * P.get('limbR', 0.5), P['trunkR'] * 0.14, sides_b, bark_lo, bark_hi)  # (seg-2 rings)
        cr = P['clumpR'] * rng.uniform(0.85, 1.12)
        clumps.append((end + UP * cr * 0.25, cr))
        # Side branches with their own clumps along the limb (LOD0/1): `sides` per limb (slender stems carry
        # several up their length), else one with probability `side`.
        ns = P['sides'] if 'sides' in P else (1 if rng.random() < P.get('side', 0.7) else 0)
        for j in range(ns if lod < 2 else 0):
            k = (j + 1) / (ns + 1) * 0.8 + rng.uniform(-0.06, 0.06) if 'sides' in P else rng.uniform(0.4, 0.62)
            s0 = lp[max(1, int(k * (len(lp) - 1)))] if len(lp) > 2 else start + (end - start) * k
            so = (out + Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(0.2, 0.9)))).normalized()
            se = s0 + so * L * P.get('sideL', 0.5)
            tube(b, path(s0, se, so, (so + UP * 0.5).normalized(), 0.08, rng, 2), P['trunkR'] * 0.22, P['trunkR'] * 0.08, 3, bark_lo, bark_hi)
            clumps.append((se + UP * cr * 0.2, cr * P.get('sideC', 0.78)))
    # A crowning clump over the fork (rounded crowns).
    if P.get('top', True):
        clumps.append((fork + UP * (P['clumpR'] * 1.3 + P['spread'] * 0.35), P['clumpR'] * 1.1))
    if P.get('bare'):  # dead tree: limbs only
        return b
    # FILL (hero): clumps between neighbouring limb clumps and an upper ring, so the crown is one continuous dome
    # (Windrise) instead of separate puffs on sticks. Light cores (LOD0 subdiv 0), all LODs keep them (silhouette).
    if P.get('fill'):
        ring = [cl for cl in clumps[:]]
        ring.sort(key=lambda cr_: math.atan2(cr_[0].y - fork.y, cr_[0].x - fork.x))
        top = fork + UP * (P['clumpR'] * 1.3 + P['spread'] * 0.35)
        for i in range(len(ring)):
            (c0, r0), (c1, r1) = ring[i], ring[(i + 1) % len(ring)]
            mid = (c0 + c1) * 0.5
            mid = mid + (mid - fork).normalized() * P['clumpR'] * 0.15 + UP * P['clumpR'] * 0.35
            clumps.append((mid, (r0 + r1) * 0.5 * P['fill']))
            up = c0 * 0.45 + top * 0.55 + UP * P['clumpR'] * 0.2
            clumps.append((up, r0 * P['fill'] * 0.95))
    # CROWN volume (normals / shading reference).
    lo = min(c.z - r * P['squash'] for c, r in clumps)
    hi = max(c.z + r * P['squash'] for c, r in clumps)
    cc = sum((c for c, _ in clumps), Vector()) / len(clumps)
    cR = max((c - cc).length + r for c, r in clumps)
    crown = (cc, cR, lo, hi)
    cards = (P['cards'], max(5, int(P['cards'] * 0.45)), 3)[lod]
    size = P['card'] * (1.0, 1.75, 2.1)[lod]
    for c, r in clumps:
        if P.get('hero'):
            clump(b, c, r, P['squash'], cards, size * (r / P['clumpR']) ** 0.5, rng, dark, light, crown, inner=True)
        else:  # broadleaves: open leaf SPRAYS along twigs (Genshin), ~0.85× card size, 0.9× cards
            spray(b, c, r, P['squash'], max(3, int(round(cards * 1.2))), size * 0.85 * (r / P['clumpR']) ** 0.5, rng, dark, light, crown, lod, bark_hi)
    return b


def conifer(P, lod, seed):
    """Genshin spruce / fir: straight trunk, TIERS of flattened drooping clumps ringing it (wide at the base,
    narrowing to a pointed top clump) — the layered teal skirts of Mondstadt / Dragonspine conifers."""
    rng = random.Random(seed)
    b = Builder()
    bark = srgb(P['bark'])
    dark, light = srgb(P['dark']), srgb(P['light'])
    H, bare, R = P['height'], P['bare'], P['radius']
    trunk = path(Vector((0, 0, -0.3)), Vector((0, 0, H * 0.92)), UP, UP, 0.03, rng, (6, 3, 2)[lod])
    tube(b, trunk, P['trunkR'], P['trunkR'] * 0.2, (6, 5, 3)[lod], mul3(bark, 0.7), bark, flare=0.5)
    tiers = P['tiers'][lod]
    clumps = []
    for t in range(tiers):
        k = t / max(1, tiers - 1)                       # 0 bottom → 1 top
        z = bare + (H * 0.86 - bare) * k
        rr = R * (1 - k * 0.78)                         # tier radius
        n = max(3, int(round(P['points'][lod] * (1 - k * 0.45))))
        cr = rr * (0.62 if lod < 2 else 0.9)
        rot = rng.uniform(0, math.pi)
        for i in range(n):
            a = rot + 2 * math.pi * i / n + rng.uniform(-0.25, 0.25)
            o = Vector((math.cos(a), math.sin(a), 0))
            c = o * rr * (0.55 if lod < 2 else 0.3) + Vector((0, 0, z - P['droop'] * rr * 0.4))
            clumps.append((c, cr * rng.uniform(0.85, 1.1)))
            if lod == 0:  # a thin drooping branch to each clump
                tube(b, path(Vector((0, 0, z + 0.25)), c, (o + UP * 0.2).normalized(), (o - UP * 0.4).normalized(), 0.04, rng, 2),
                     P['trunkR'] * 0.32, P['trunkR'] * 0.1, 3, bark, bark)
    clumps.append((Vector((0, 0, H * 0.93)), R * P.get('topR', 0.32)))   # pointed top (golden: a broad crowning pad)
    lo = min(c.z - r * P['squash'] for c, r in clumps)
    hi = max(c.z + r * P['squash'] for c, r in clumps)
    crown = (Vector((0, 0, (lo + hi) * 0.5)), max(R, (hi - lo) * 0.5), lo, hi)
    cards = (P['cards'], max(4, P['cards'] // 2), 3)[lod]
    for c, r in clumps:
        cs = P['card'] * (1.0, 1.65, 1.9)[lod] * (r / (R * 0.62)) ** 0.5
        if P.get('leafy'):  # golden Liyue (ginkgo): open leaf sprays along twigs, like the broadleaves
            spray(b, c, r, P['squash'], max(3, int(round(cards * 1.2))), cs * 0.85, rng, dark, light, crown, lod, srgb(P['bark']))
        else:
            clump(b, c, r, P['squash'], cards, cs, rng, dark, light, crown, inner=lod == 0)
    return b


# Parameters (metres, Blender Z up). Colours = the game's palettes (genshinTrees.ts); instance hues tint leaves.
SPECIES = {
    'mondstadt': dict(fork=4.2, trunkR=0.36, lean=0.1, leanA=0.6, curve=0.12, limbs=5, elev=(38, 64), spread=2.8, rise=0.7,
                      clumpR=1.6, squash=0.8, cards=18, card=1.9, roots=4, flare=0.6, side=0.9,
                      bark=0x8f7d6a, dark=0x5a7a34, light=0xc2d066),
    # SLENDER Mondstadt tree (ref: the tall green tree on the hill): forks low into 3 tall stems, each carrying
    # clumps up its length → a tall oval crown with the branches showing through.
    'slender': dict(fork=2.0, trunkR=0.3, lean=0.05, leanA=1.9, curve=0.18, limbs=3, elev=(62, 76), spread=6.0, rise=0.9,
                    limbR=0.62, sides=2, sideL=0.4, sideC=0.85, clumpR=1.45, squash=0.85, cards=16, card=1.8, roots=3, flare=0.5,
                    bark=0x968472, dark=0x587a36, light=0xbcd068),
    # WINDRISE OAK (forest-size): short thick trunk, six wide near-horizontal limbs, one broad continuous dome.
    'oak': dict(fork=3.0, trunkR=0.62, lean=0.04, leanA=0.3, curve=0.14, limbs=6, elev=(12, 32), spread=5.2, rise=0.45,
                limbR=0.55, side=0.6, fill=0.85, clumpR=2.3, squash=0.62, cards=12, card=2.9, roots=5, flare=0.75,
                bark=0x857260, dark=0x56762f, light=0xb6ca5c),
    # CURVY: a dramatic S-bent leaning trunk, the crown thrown off to one side.
    'curvy': dict(fork=5.2, trunkR=0.34, lean=0.38, leanA=2.4, curve=0.62, limbs=4, elev=(24, 52), spread=3.0, rise=0.6,
                  side=0.8, clumpR=1.75, squash=0.72, cards=18, card=2.0, roots=4, flare=0.6,
                  bark=0x8a7664, dark=0x5a7c38, light=0xc0d26a),
    'maple': dict(fork=3.3, trunkR=0.32, lean=0.12, leanA=2.2, curve=0.16, limbs=5, elev=(16, 34), spread=4.0, rise=0.35,
                  clumpR=1.9, squash=0.6, cards=18, card=2.1, roots=4, flare=0.6, side=0.8, top=True,
                  bark=0x5e4838, dark=0x9a3418, light=0xf2a23a),
    'ancient': dict(fork=6.0, trunkR=0.62, lean=0.2, leanA=4.0, curve=0.26, limbs=5, elev=(18, 40), spread=5.0, rise=0.3,
                    clumpR=2.5, squash=0.42, cards=18, card=2.6, roots=6, flare=0.9, side=0.75,
                    bark=0x5c4e66, dark=0x34287a, light=0xa48cf0),
    # Landmark units (LANDMARK_SCALE ×2 in the game): ~50 m tall there.
    'world_tree': dict(hero=True, fork=11, trunkR=2.4, lean=0.06, leanA=1.0, curve=0.14, limbs=7, elev=(14, 36), spread=11, rise=0.45,
                       clumpR=5.2, squash=0.62, cards=32, card=4.6, roots=8, flare=0.9, side=0.5, fill=0.9,
                       bark=0x76543a, dark=0x4c7c38, light=0xb4d064),
    # Conifers (Genshin teal, the game's sampled colours): layered drooping tiers.
    'spruce': dict(kind='conifer', height=12, bare=3.2, radius=3.0, trunkR=0.28, tiers=(6, 4, 3), points=(6, 5, 4), droop=0.55,
                   squash=0.45, cards=11, card=1.5, bark=0x5a4434, dark=0x2a5e5a, light=0x7cb89c),
    # GOLDEN Liyue tree: tall trunk with tiers of flat broad gold pads (Liyue's ginkgo-like trees).
    'golden': dict(kind='conifer', height=10, bare=3.6, radius=3.4, trunkR=0.32, tiers=(3, 3, 2), points=(4, 4, 3), droop=0.0,
                   topR=0.55, leafy=True, squash=0.36, cards=16, card=2.2, bark=0x6a5446, dark=0x9a7a1c, light=0xe2c84a),
    'fir': dict(kind='conifer', height=9.5, bare=2.4, radius=3.2, trunkR=0.3, tiers=(5, 4, 2), points=(7, 5, 4), droop=0.35,
                squash=0.5, cards=11, card=1.6, bark=0x56402f, dark=0x285a50, light=0x86c08e),
    # Liyue pine: S-bent leaning trunk, near-horizontal limbs ending in flat cloud pads.
    'pine': dict(fork=6.5, trunkR=0.34, lean=0.18, leanA=0.4, curve=0.3, limbs=5, elev=(4, 20), spread=3.6, rise=0.12,
                 clumpR=2.1, squash=0.36, cards=16, card=2.2, roots=3, flare=0.5, side=0.6,
                 bark=0x7a5640, dark=0x1e5246, light=0x7cc690),
    'dead': dict(bare=True, top=False, fork=5.0, trunkR=0.24, lean=0.12, leanA=2.6, curve=0.3, limbs=4, elev=(30, 60), spread=2.6, rise=0.5,
                 clumpR=1.0, squash=0.5, cards=0, card=1, roots=3, flare=0.5, side=0.8,
                 bark=0x6e6258, dark=0x000000, light=0x000000),
}

win = bpy.context.window_manager.windows[0]
report = {}
for name, P in SPECIES.items():
    sc = bpy.data.scenes.get('tree_' + name) or bpy.data.scenes.new('tree_' + name)
    for o in list(sc.objects):
        if o.type != 'CAMERA':
            bpy.data.objects.remove(o)
    tris = []
    for lod in range(3):
        b = (conifer if P.get('kind') == 'conifer' else tree)(P, lod, 1000 + sum(map(ord, name)))  # fixed seed per tree (hash() is randomised per session)
        me = b.mesh('%s_lod%d' % (name, lod))
        ob = bpy.data.objects.new('%s_lod%d' % (name, lod), me)
        sc.collection.objects.link(ob)
        tris.append(b.tris)
    report[name] = tris
    with bpy.context.temp_override(window=win, scene=sc):
        win.scene = sc
        bpy.ops.export_scene.gltf(filepath=OUT + name + '.glb', export_format='GLB', use_active_scene=True,
                                  export_cameras=False, export_lights=False, export_animations=False, export_yup=True,
                                  export_vertex_color='MATERIAL', export_normals=True)
    report[name + '_bytes'] = os.path.getsize(OUT + name + '.glb')
result = report
