import * as THREE from 'three'
import type { TimeOfDay } from '../lighting/TimeOfDay'
import { SKY_GLSL, skyUniforms } from './skyShader'

/**
 * Procedural sky: gradient (horizon == fog colour), sun disc + glow, moon disc + halo, stars, and a
 * drifting stylized cloud layer (3-octave value noise on a plane projection) lit by the key light —
 * orange-rimmed at sunset like refer/roads/forest-road-evening-hero.png.
 * One draw call, fragment-only work, drawn first with depthWrite off (so the god-ray pass sees
 * sky as depth = 1). Follows the camera; radius stays inside the far plane.
 * Output is linear HDR — the sun core is > 1 so tone mapping + god rays read it as a light source.
 */
export class SkyDome {
  readonly mesh: THREE.Mesh
  readonly material: THREE.ShaderMaterial

  constructor() {
    this.material = new THREE.ShaderMaterial({
      name: 'SkyDome',
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: skyUniforms,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww; // on the far plane
        }
      `,
      fragmentShader: /* glsl */ `
        ${SKY_GLSL}
        varying vec3 vDir;
        void main() { gl_FragColor = vec4(skyColor(normalize(vDir), true), 1.0); }
      `,
    })
    this.mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3), this.material)
    this.mesh.name = 'sky'
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = -1000
    this.mesh.matrixAutoUpdate = false
  }

  update(tod: TimeOfDay, camera: THREE.PerspectiveCamera, time: number): void {
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
    u.uSkyHaze.value.set(p.haze, 110)
    u.uSkyTime.value = time
    // Follow the camera; scale inside the far plane (the vertex shader pins depth to far anyway).
    const r = camera.far * 0.9
    this.mesh.matrix.makeScale(r, r, r).setPosition(camera.position)
    this.mesh.matrixWorld.copy(this.mesh.matrix)
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
