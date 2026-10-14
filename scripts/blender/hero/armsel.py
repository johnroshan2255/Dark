import os
WORK = os.environ.get('HERO_WORK', 'C:/tmp/hero')  # intermediate .blend files, renders, exports, mixamo/
SCRIPTS = os.environ.get('HERO_SCRIPTS', 'C:/Project/Dark/scripts/blender/hero')
import bpy, bmesh
from mathutils import Vector
def arm_verts(bm, side, zmax):
    """Vertices of one arm below zmax: flood fill from the outermost low vertex, staying below zmax."""
    seed = max((v for v in bm.verts if v.co.z < -0.05 and v.co.z > -0.12), key=lambda v: v.co.x*side)
    seen = {seed.index}; st=[seed]
    while st:
        a=st.pop()
        for e in a.link_edges:
            b=e.other_vert(a)
            if b.index not in seen and b.co.z < zmax: seen.add(b.index); st.append(b)
    return seen
