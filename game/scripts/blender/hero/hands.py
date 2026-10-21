import os
WORK = os.environ.get('HERO_WORK', 'C:/tmp/hero')  # intermediate .blend files, renders, exports, mixamo/
SCRIPTS = os.environ.get('HERO_SCRIPTS', 'C:/Project/Dark/scripts/blender/hero')
import bpy, bmesh, math
from mathutils import Vector, Matrix
# ---- canonical hand (units of the hero mesh: 1 = 0.894 m) -----------------------------------------------------
# wrist at origin, fingers toward -Z, palm faces +X, thumb on the -Y side. Built for the character's RIGHT hand (-X).
FINGERS = [  # name, knuckle y, knuckle z, lengths, root radius, tip radius, curls (MCP, PIP, DIP), splay
    ('index',  -0.0345, -0.100, (0.045, 0.027, 0.022), 0.0098, 0.0076, (0.30, 0.50, 0.30), -0.06),
    ('middle', -0.0115, -0.104, (0.049, 0.031, 0.023), 0.0102, 0.0079, (0.38, 0.58, 0.32), -0.01),
    ('ring',    0.0115, -0.100, (0.046, 0.029, 0.022), 0.0095, 0.0074, (0.46, 0.64, 0.34), 0.05),
    ('pinky',   0.0335, -0.091, (0.036, 0.022, 0.019), 0.0083, 0.0064, (0.56, 0.70, 0.36), 0.11),
]
def capsule(bm, p0, p1, r0, r1, tag, segs=20, rings=10):
    ax = (p1 - p0); L = ax.length; q = ax.normalized().to_track_quat('Z', 'Y')
    res = bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=1.0)
    for v in res['verts']:
        c = v.co.copy()
        if c.z >= 0: v.co = p1 + q @ (c * r1)
        else: v.co = p0 + q @ (c * r0)
    return [(p0, p1, r0, r1, tag)]
def ellipsoid(bm, c, rx, ry, rz, tag, rot=None):
    res = bmesh.ops.create_uvsphere(bm, u_segments=20, v_segments=12, radius=1.0)
    for v in res['verts']:
        p = Vector((v.co.x*rx, v.co.y*ry, v.co.z*rz))
        if rot: p = rot @ p
        v.co = c + p
    return []
def build_canonical():
    bm = bmesh.new(); prims = []
    # palm: stacked rounded slabs from the wrist to the knuckles (thicker at the heel, a slight cup toward the palm)
    for i in range(17):
        t = i / 16; z = -0.012 - 0.082 * t
        w = 0.036 + 0.010 * t           # half width (y)
        th = 0.0185 - 0.003 * t          # half thickness (x)
        ellipsoid(bm, Vector((0.0, 0.002 * t, z)), th, w, 0.016, 'palm')
        prims.append((Vector((0, -w*0.6, z)), Vector((0, w*0.6, z)), th, th, 'palm'))
    # wrist (goes up into the glove cuff)
    prims += capsule(bm, Vector((0, 0, 0.035)), Vector((0, 0, -0.012)), 0.031, 0.031, 'wrist')
    for p in [Vector((0, -0.008, 0.035)), Vector((0, 0.008, 0.035))]: pass
    ellipsoid(bm, Vector((0, 0, 0.012)), 0.027, 0.034, 0.03, 'wrist')
    # thenar (thumb ball) + hypothenar pads on the palm side
    ellipsoid(bm, Vector((0.012, -0.024, -0.03)), 0.015, 0.016, 0.026, 'palm', Matrix.Rotation(-0.3, 3, 'X'))
    ellipsoid(bm, Vector((0.010, 0.026, -0.04)), 0.011, 0.013, 0.03, 'palm')
    # fingers
    for name, ky, kz, lens, r0, r1, curls, splay in FINGERS:
        p = Vector((0.0, ky, kz)); ang = 0.0
        rr = [r0, r0 + (r1 - r0) * 0.45, r0 + (r1 - r0) * 0.8, r1]
        for s in range(3):
            ang += curls[s]
            d = Vector((math.sin(ang), 0, -math.cos(ang)))
            d = Matrix.Rotation(splay * (1.0 if s == 0 else 0.4), 3, 'X') @ d
            q = p + d * lens[s]
            prims += capsule(bm, p, q, rr[s], rr[s + 1], (name, s))
            p = q
    # thumb: metacarpal from the heel of the palm, then two phalanges curling across toward the index finger
    base = Vector((0.004, -0.028, -0.020))
    dirs = [Vector((0.18, -0.42, -0.89)), Vector((0.26, -0.22, -0.94)), Vector((0.36, -0.04, -0.93))]
    lens = [0.040, 0.029, 0.024]; rad = [0.0130, 0.0102, 0.0090, 0.0076]
    p = base
    for s in range(3):
        q = p + dirs[s].normalized() * lens[s]
        prims += capsule(bm, p, q, rad[s], rad[s + 1], ('thumb', s))
        p = q
    return bm, prims
def glove_sd(co, prims):
    """Signed distance (units) past the fingerless glove's edge: > 0 glove, < 0 bare skin. The glove covers the
    palm, the wrist, the thumb metacarpal + 45 % of its proximal phalanx, 62 % of each finger's proximal phalanx."""
    best = None
    for p0, p1, r0, r1, tag in prims:
        ax = p1 - p0; L2 = ax.length_squared
        t = max(0.0, min(1.0, (co - p0).dot(ax) / L2)) if L2 > 0 else 0
        d = (co - (p0 + ax * t)).length - (r0 + (r1 - r0) * t)
        if best is None or d < best[0]: best = (d, tag, t, math.sqrt(L2))
    _, tag, t, L = best
    if tag in ('palm', 'wrist'): return 0.05
    name, s = tag
    if name == 'thumb':
        return 0.05 if s == 0 else ((0.45 - t) * L if s == 1 else -0.05)
    return (0.62 - t) * L if s == 0 else -0.05
def glove_of(co, prims): return glove_sd(co, prims) > 0
