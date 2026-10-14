import os
WORK = os.environ.get('HERO_WORK', 'C:/tmp/hero')  # intermediate .blend files, renders, exports, mixamo/
SCRIPTS = os.environ.get('HERO_SCRIPTS', 'C:/Project/Dark/scripts/blender/hero')
import bmesh, math
from mathutils import Vector
def slice_loops(me, z):
    bm = bmesh.new(); bm.from_mesh(me)
    res = bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, z), plane_no=(0, 0, 1))
    cut = [e for e in res['geom_cut'] if isinstance(e, bmesh.types.BMEdge)]
    adj = {}
    for e in cut:
        a, b = e.verts
        adj.setdefault(a, []).append(b); adj.setdefault(b, []).append(a)
    seen = set(); loops = []
    for s in adj:
        if s in seen: continue
        loop = [s]; seen.add(s); prev = None; cur = s
        while True:
            nxt = [n for n in adj[cur] if n is not prev and n not in seen]
            if not nxt: break
            prev, cur = cur, nxt[0]; seen.add(cur); loop.append(cur)
        loops.append([Vector((v.co.x, v.co.y)) for v in loop])
    bm.free()
    return loops
def hull(pts):
    P = sorted(set((round(p.x, 6), round(p.y, 6)) for p in pts))
    cross = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for p in P:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0: lo.pop()
        lo.append(p)
    for p in reversed(P):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0: up.pop()
        up.append(p)
    return lo[:-1] + up[:-1]
def notches(loop, side):
    """Front / back crease tips between the arm lobe and the torso in one horizontal section (main body loop)."""
    pts = loop; n = len(pts)
    H = hull(pts); Hs = set(H)
    idx = [i for i, p in enumerate(pts) if (round(p.x, 6), round(p.y, 6)) in Hs]
    pockets = []
    for k in range(len(idx)):
        i0, i1 = idx[k], idx[(k + 1) % len(idx)]
        a, b = pts[i0], pts[i1]
        ab = b - a; L = ab.length
        if L < 1e-6: continue
        nrm = Vector((-ab.y, ab.x)) / L
        best = (0, None); j = i0
        while j != i1:
            d = abs((pts[j] - a).dot(nrm))
            if d > best[0]: best = (d, pts[j])
            j = (j + 1) % n
        if best[1] is not None: pockets.append((best[0], best[1], a, b))
    cand = [p for p in pockets if 0.14 < p[1].x * side < 0.31 and p[0] > 0.004]
    front = [p for p in cand if p[1].y < 0.0]; back = [p for p in cand if p[1].y >= -0.01]
    f = max(front, key=lambda p: p[0]) if front else None
    b = max(back, key=lambda p: p[0]) if back else None
    return f, b
