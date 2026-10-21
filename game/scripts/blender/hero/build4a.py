import os
WORK = os.environ.get('HERO_WORK', 'C:/tmp/hero')  # intermediate .blend files, renders, exports, mixamo/
SCRIPTS = os.environ.get('HERO_SCRIPTS', 'C:/Project/Dark/scripts/blender/hero')
# Step 4a: free the arms from the jacket sides (the generator fused them between the forearm and the armpit).
import bpy, bmesh, math
from mathutils import Vector
SP = WORK
exec(open(SCRIPTS + '/creases.py').read())
bpy.ops.wm.open_mainfile(filepath=SP + r"\hero_step3c.blend")
hero = bpy.data.objects['hero']; me = hero.data
Z0, Z1 = 0.17, 0.365
# crease tips per side, every 0.01 (shallow / missing pockets take the neighbour's value)
tips = {}
for side in (-1, 1):
    rows = []
    for zi in range(17, 38):
        z = zi / 100; f, b = notches(max(slice_loops(me, z), key=len), side)
        rows.append([z, f[1] if f and f[0] > 0.03 else None, b[1] if b and b[0] > 0.03 else None])
    for k in (1, 2):
        for i in range(len(rows)):
            if rows[i][k] is None:
                nb = [rows[j][k] for j in sorted(range(len(rows)), key=lambda j: abs(j - i)) if rows[j][k] is not None]
                rows[i][k] = nb[0]
    # arm-lobe centre: centroid of the section points outward of the crease line, near it
    for r in rows:
        z, F, B = r
        d = B - F; n = Vector((d.y, -d.x)).normalized()
        if n.x * side < 0: n = -n
        mid = (F + B) / 2
        pts = [p for lp in slice_loops(me, z) for p in lp if (p - F).dot(n) > 0.004 and (p - mid).length < 0.16]
        r.append(sum(pts, Vector((0, 0))) / len(pts) if pts else mid + n * 0.06)
    tips[side] = rows
def line_at(side, z):
    rows = tips[side]; zz = max(rows[0][0], min(rows[-1][0], z))
    i = min(len(rows) - 2, int((zz - rows[0][0]) / 0.01)); t = (zz - rows[i][0]) / 0.01
    F = rows[i][1].lerp(rows[i + 1][1], t); B = rows[i][2].lerp(rows[i + 1][2], t); A = rows[i][3].lerp(rows[i + 1][3], t)
    return F, B, A
bm = bmesh.new(); bm.from_mesh(me)
ih = bm.verts.layers.float['is_hand']; uvl = bm.loops.layers.uv['new']
# forearm below the merge (z < 0.155, already separate from the jacket): flood from the outer forearm
bm.verts.ensure_lookup_table()
fore = {}
for side in (-1, 1):
    seed = max((v for v in bm.verts if v[ih] < 0.5 and 0.06 < v.co.z < 0.14), key=lambda v: v.co.x * side)
    S = {seed}; st = [seed]
    while st:
        a = st.pop()
        for e in a.link_edges:
            b = e.other_vert(a)
            if b not in S and b.co.z < 0.155 and b.co.x * side > 0.185: S.add(b); st.append(b)   # the forearm never comes closer in
    assert not any(abs(v.co.x) < 0.15 for v in S), 'forearm flood leaked'
    fore[side] = S
arm_face = {}
for f in bm.faces:
    c = f.calc_center_median()
    if c.z >= Z1 or f.verts[0][ih] > 0.5 or abs(c.x) < 0.1: continue
    side = 1 if c.x > 0 else -1
    if all(v.co.z < 0.155 for v in f.verts):
        arm_face[f] = side if all(v in fore[side] for v in f.verts) else 0
        continue
    F, B, A = line_at(side, c.z)
    p = Vector((c.x, c.y))
    # the torso is the angular sector (seen from the arm centre A) between the rays to the crease tips F and B
    # that contains the inward direction; the arm is everything else within the arm's reach of A
    ang = lambda v: math.atan2(v.y, v.x)
    inward = ang(Vector((-side, 0.0)))
    def rel(a): return (a - inward + math.pi) % (2 * math.pi) - math.pi
    aF, aB, aP = rel(ang(F - A)), rel(ang(B - A)), rel(ang(p - A))
    lo, hi = min(aF, aB), max(aF, aB)
    torso = lo <= aP <= hi
    arm_face[f] = side if (not torso and (p - A).length < 0.095) else 0
    if c.z < 0.25 and c.x * side > 0.265: arm_face[f] = side   # the jacket never reaches this far out down here
    if c.z < 0.21 and c.x * side < 0.2: arm_face[f] = 0        # nor the arm this far in (the crease saddle dips toward the hem)
# keep only the arm-side region connected to the outer sleeve (stray arm-side bits elsewhere stay torso)
for side in (-1, 1):
    seeds = [f for f, s in arm_face.items() if s == side]
    seed = max(seeds, key=lambda f: f.calc_center_median().x * side)
    keep = {seed}; st = [seed]
    while st:
        f = st.pop()
        for e in f.edges:
            for g in e.link_faces:
                if g not in keep and arm_face.get(g) == side: keep.add(g); st.append(g)
    stray = [f for f in seeds if f not in keep]
    for f in stray: arm_face[f] = 0
    # torso-side holes inside the arm region (enclosed torso-class faces touching only arm faces) → arm
    print('side', side, 'arm faces', len(keep), 'stray arm-side faces', len(stray))
split = [e for e in bm.edges if len(e.link_faces) == 2 and all(f in arm_face for f in e.link_faces)
         and (arm_face[e.link_faces[0]] != 0) != (arm_face[e.link_faces[1]] != 0)]
print('split edges', len(split))
# also rip the slit ends below the armpit (shared by an arm face and a torso face); the top ends stay joined (armpit)
cls = lambda f: (arm_face.get(f, 0) != 0)
bot = [v for v in {v for e in split for v in e.verts} if v.co.z < Z1 - 0.02 and len({cls(f) for f in v.link_faces if f in arm_face}) == 2]
print('ripped slit-end verts', len(bot))
bmesh.ops.split_edges(bm, edges=split, verts=bot, use_verts=True)
# jacket-olive texel for the patches: the outer sleeve at mid height
def olive_uv(side):
    return Vector((0.9225, 0.975))   # the jacket-olive block painted by build3c
made = 0
patch_faces = []
bset = [e for e in bm.edges if e.is_boundary and e.link_faces[0] in arm_face]
groups = []; seen = set()
for e0 in bset:
    if e0 in seen: continue
    grp = [e0]; seen.add(e0); st = [e0]
    while st:
        e = st.pop()
        for v in e.verts:
            for e2 in v.link_edges:
                if e2 in bset and e2 not in seen and (arm_face[e2.link_faces[0]] != 0) == (arm_face[e0.link_faces[0]] != 0):
                    seen.add(e2); grp.append(e2); st.append(e2)
    groups.append(grp)
def order(grp):
    adj = {}
    for e in grp:
        a, b = e.verts; adj.setdefault(a, []).append(b); adj.setdefault(b, []).append(a)
    ends = [v for v, nb in adj.items() if len(nb) == 1]
    start = ends[0] if ends else grp[0].verts[0]
    chain = [start]; prev = None
    while True:
        nxt = [v for v in adj[chain[-1]] if v is not prev and v is not chain[0]]
        if not nxt: break
        prev = chain[-1]; chain.append(nxt[0])
        if len(chain) > len(adj): break
    return chain, len(ends)
def patch(verts, side, want_arm):
    global made
    verts = list(dict.fromkeys(verts))
    if len(verts) < 3 or bm.faces.get(verts): return
    try: face = bm.faces.new(verts)
    except ValueError: return
    face.normal_update()
    if (face.normal.x * side > 0) == want_arm: face.normal_flip()      # arm patch faces the body, torso patch faces out
    res = bmesh.ops.triangulate(bm, faces=[face], quad_method='BEAUTY', ngon_method='BEAUTY')
    patch_faces.extend(res['faces'])
    uv = olive_uv(side)
    for tf in res['faces']:
        tf.smooth = True
        for l in tf.loops: l[uvl].uv = uv
    made += 1
by = {}
for grp in groups:
    f0 = grp[0].link_faces[0]; side = 1 if f0.calc_center_median().x > 0 else -1; want_arm = arm_face[f0] != 0
    chain, nends = order(grp)
    by.setdefault((side, want_arm), []).append((chain, nends))
for (side, want_arm), chains in by.items():
    open_ = sorted([c for c, n in chains if n == 2], key=len, reverse=True)
    print('chains', side, 'arm' if want_arm else 'torso', 'open', [(len(c), round(c[0].co.z, 2), round(c[-1].co.z, 2)) for c in open_][:6], 'closed', [len(c) for c, n in chains if n == 0][:6])
    closed = [c for c, n in chains if n == 0]
    if len(open_) >= 2 and len(open_[1]) >= 12:
        a, b = open_[0], open_[1]
        if a[0].co.z < a[-1].co.z: a = a[::-1]          # a: top → bottom
        if b[0].co.z > b[-1].co.z: b = b[::-1]          # b: bottom → top
        patch(a + [v for v in b if v not in a], side, want_arm)
        print('opening', side, 'arm' if want_arm else 'torso', len(a), '+', len(b), 'verts')
        open_ = open_[2:]
    for c in open_:
        if len(c) >= 3: patch(c, side, want_arm)
    for c in closed:
        if len(c) >= 3: patch(c, side, want_arm)
# clean-up: loose slivers out, consistent normals, the seam regions (patches + 3 cm around) smoothed so the old crease
# fins fold back into a clean inner-arm / jacket-side surface
bm.verts.ensure_lookup_table()
seen = set(); dead = []
for v in bm.verts:
    if v in seen: continue
    S = {v}; st = [v]
    while st:
        a = st.pop()
        for e in a.link_edges:
            b = e.other_vert(a)
            if b not in S: S.add(b); st.append(b)
    seen |= S
    if len(S) < 30 and v[ih] < 0.5: dead += list(S)
bmesh.ops.delete(bm, geom=dead, context='VERTS')
print('loose sliver verts removed', len(dead))
bmesh.ops.recalc_face_normals(bm, faces=[f for f in bm.faces if f.verts[0][ih] < 0.5])
seam = {v for f in patch_faces for v in f.verts if f.is_valid}
near = [v for v in bm.verts if v[ih] < 0.5 and Z0 - 0.03 < v.co.z < Z1 and abs(v.co.x) > 0.12 and any((v.co - s.co).length < 0.04 for s in seam)]
print('seam smoothing verts', len(near))
for _ in range(20):
    bmesh.ops.smooth_vert(bm, verts=near, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
bm.normal_update()
bm.to_mesh(me); bm.free()
print('patches', made, 'tris', sum(len(p.vertices) - 2 for p in me.polygons))
bpy.ops.wm.save_as_mainfile(filepath=SP + r"\hero_step4a.blend")
