import os
WORK = os.environ.get('HERO_WORK', 'C:/tmp/hero')  # intermediate .blend files, renders, exports, mixamo/
SCRIPTS = os.environ.get('HERO_SCRIPTS', 'C:/Project/Dark/scripts/blender/hero')
import bpy, math
from mathutils import Vector
OUT = WORK + '/r'
def setup(engine='BLENDER_WORKBENCH'):
    sc = bpy.context.scene
    sc.render.engine = engine
    sc.render.resolution_x = 900; sc.render.resolution_y = 900
    sc.render.film_transparent = False
    if engine == 'BLENDER_WORKBENCH':
        sh = sc.display.shading
        sh.light = 'STUDIO'; sh.color_type = 'TEXTURE'; sh.show_specular_highlight = False
        sh.show_backface_culling = False
    w = bpy.data.worlds.get('W') or bpy.data.worlds.new('W'); sc.world = w
    w.color = (0.12, 0.12, 0.13)
def shot(name, target, dist, yaw_deg=0, pitch_deg=0, ortho=None, res=900):
    sc = bpy.context.scene
    sc.render.resolution_x = res; sc.render.resolution_y = res
    cam = bpy.data.objects.get('ShotCam')
    if not cam:
        cam = bpy.data.objects.new('ShotCam', bpy.data.cameras.new('ShotCam')); sc.collection.objects.link(cam)
    t = Vector(target); y = math.radians(yaw_deg); p = math.radians(pitch_deg)
    # yaw 0 = camera on -Y looking +Y (Blender front view)
    d = Vector((math.sin(y)*math.cos(p), -math.cos(y)*math.cos(p), math.sin(p)))
    cam.location = t + d*dist
    cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    if ortho: cam.data.type = 'ORTHO'; cam.data.ortho_scale = ortho
    else: cam.data.type = 'PERSP'; cam.data.lens = 50
    cam.data.clip_start = 0.01
    sc.camera = cam
    sc.render.filepath = OUT + '/' + name + '.png'
    bpy.ops.render.render(write_still=True)
