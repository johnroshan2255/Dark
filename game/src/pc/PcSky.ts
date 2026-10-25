import * as pc from 'playcanvas'
import * as THREE from 'three'
import { MIST_GLSL, SKY_GLSL, skyUniforms } from '../rendering/sky/skyShader'
import type { TimeOfDay } from '../rendering/lighting/TimeOfDay'
import { isBright, isGenshin, isOverland } from '../rendering/artStyle'
import { pcGlsl } from './materials/glsl'

/**
 * The procedural SKY on PlayCanvas: the game's sky function (skyShader SKY_GLSL — gradient, sun / moon, stars,
 * drifting clouds, the mist against the horizon) on a dome in the engine's SKYBOX layer (drawn after the opaque world,
 * depth-tested at the far plane, so only uncovered pixels run it), following the camera. Its uniforms are the shared
 * skyUniforms (pushed into the device scope each frame by uniformBridge — the fog of every material reads the same).
 * PlayCanvas's own Sky draws a cube map / panorama only; an animated procedural sky is this one ShaderMaterial.
 * Output: linear HDR (the sun core > 1): CameraFrame tone-maps it.
 */
export class PcSky {
  readonly entity: pc.Entity

  constructor(app: pc.AppBase) {
    const material = new pc.ShaderMaterial({
      uniqueName: 'darkSky',
      attributes: { aPosition: pc.SEMANTIC_POSITION },
      vertexGLSL: /* glsl */ `
        attribute vec3 aPosition;
        uniform mat4 matrix_model;
        uniform mat4 matrix_viewProjection;
        varying vec3 vDir;
        void main(void) {
          vDir = aPosition;
          vec4 p = matrix_viewProjection * (matrix_model * vec4(aPosition, 1.0));
          gl_Position = p.xyww; // (on the far plane)
        }`,
      fragmentGLSL: /* glsl */ `
        ${pcGlsl(SKY_GLSL)}
        ${pcGlsl(MIST_GLSL)}
        varying vec3 vDir;
        void main(void) {
          vec3 d = normalize(vDir);
          vec3 col = skyColor(d, true);
          float mist = mistAmount(vec3(d.x, max(d.y, 0.004), d.z), 1.0e5);
          gl_FragColor = vec4(mix(col, skyColor(d, false) * 1.06, mist * 0.9), 1.0);
        }`,
    })
    material.cull = pc.CULLFACE_FRONT // (seen from inside)
    material.depthWrite = false
    material.depthTest = true
    material.update()
    const mesh = pc.Mesh.fromGeometry(app.graphicsDevice, new pc.SphereGeometry({ radius: 1, latitudeBands: 24, longitudeBands: 32 }))
    const mi = new pc.MeshInstance(mesh, material)
    mi.cull = false
    this.entity = new pc.Entity('sky')
    this.entity.addComponent('render', { meshInstances: [mi], castShadows: false, receiveShadows: false })
    const sky = app.scene.layers.getLayerById(pc.LAYERID_SKYBOX)
    if (sky) this.entity.render!.layers = [sky.id]
    app.root.addChild(this.entity)
  }

  /** The sky's uniforms from the time of day (as SkyDome.update) and the dome on the camera, inside the far plane. */
  update(tod: TimeOfDay, cam: pc.Entity, time: number): void {
    const u = skyUniforms
    const p = tod.current
    u.uSkyHorizon.value.copy(p.fogColor)
    u.uSkyZenith.value.copy(p.skyZenith)
    u.uSkySunDir.value.copy(tod.sunDir)
    u.uSkyMoonDir.value.copy(tod.moonDir)
    u.uSkySunColor.value.copy(p.sunColor)
    u.uSkyMoonColor.value.copy(p.moonColor)
    u.uSkySunVis.value = THREE.MathUtils.smoothstep(tod.sunDir.y, -0.06, 0.02) * (1 - tod.nightmare * 0.3)
    u.uSkyMoonVis.value = THREE.MathUtils.smoothstep(tod.moonDir.y, -0.04, 0.05) * (1 - 0.7 * THREE.MathUtils.smoothstep(tod.sunDir.y, -0.1, 0.1))
    u.uSkyStars.value = p.stars
    u.uSkyClouds.value = p.clouds
    u.uSkyCloudWhite.value = p.cloudWhite
    u.uSkyStorm.value = p.storm
    u.uSkyCurve.value = isGenshin() ? 0.25 : 0.45
    u.uSkyCumulus.value = isGenshin() ? 1 : 0
    u.uSkyHaze.value.set(p.haze, isOverland() ? 380 : isGenshin() || isBright() ? 320 : 110)
    u.uSkyTime.value = time
    const far = cam.camera!.farClip * 0.9
    this.entity.setPosition(cam.getPosition())
    this.entity.setLocalScale(far, far, far)
  }
}
