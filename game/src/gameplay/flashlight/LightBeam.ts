import * as THREE from 'three'

/**
 * Visible light cone in the air (refer/roads hero: headlamp beams are the brightest accents of the frame).
 * One additive, depth-tested, non-depth-writing open cone: bright at the lamp, fading along its length and
 * toward the silhouette (view-angle falloff), so it reads as lit haze. 1 draw call, ~64 tris, all tiers.
 */
export class LightBeam {
  readonly mesh: THREE.Mesh
  private readonly material: THREE.ShaderMaterial
  private readonly up = new THREE.Vector3(0, 1, 0)

  constructor(length = 13, angle = 0.36) {
    const r = Math.tan(angle) * length
    // Cone with apex at origin opening along -Z; uv.y = 0 at lamp, 1 at the far end.
    const g = new THREE.CylinderGeometry(r, 0.06, length, 24, 1, true)
    g.translate(0, length / 2, 0).rotateX(-Math.PI / 2)
    this.material = new THREE.ShaderMaterial({
      name: 'LightBeam',
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      uniforms: { uColor: { value: new THREE.Color(1, 0.9, 0.7) }, uIntensity: { value: 0 } },
      vertexShader: /* glsl */ `
        varying float vAlong; varying vec3 vN; varying vec3 vView;
        void main() {
          vAlong = uv.y; // 0 at the lamp (narrow end), 1 at the far end
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uIntensity;
        varying float vAlong; varying vec3 vN; varying vec3 vView;
        void main() {
          // Grazing view (looking down the beam) → brighter: we see through more lit haze. Side view stays soft.
          float edge = 0.45 + 0.3 * (1.0 - abs(dot(normalize(vN), normalize(vView))));
          float fade = pow(clamp(1.0 - vAlong, 0.0, 1.0), 2.6) * smoothstep(0.0, 0.04, vAlong);
          gl_FragColor = vec4(uColor * uIntensity * edge * fade, 1.0);
        }`,
    })
    this.mesh = new THREE.Mesh(g, this.material)
    this.mesh.name = 'flashlight-beam'
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 10
  }

  /** @param darkness 0 in full daylight … 1 at night (beams are only visible against dim surroundings). */
  /** @param firstPerson beam starts ~1 m ahead and is fainter (it would otherwise fill the screen). */
  update(origin: THREE.Vector3, target: THREE.Vector3, on: boolean, darkness: number, firstPerson = false): void {
    this.mesh.position.copy(origin)
    if (firstPerson) this.mesh.position.lerp(target, 1.2 / Math.max(1.2, origin.distanceTo(target)))
    this.mesh.up.copy(this.up)
    this.mesh.lookAt(target)
    // lookAt points +Z at the target for non-cameras; our cone opens along -Z → flip.
    this.mesh.rotateY(Math.PI)
    this.mesh.updateMatrixWorld()
    // Brightest at dusk (hazy golden air, refs), subtler in full night so it doesn't wash the view.
    const dusk = darkness * (1 - darkness) * 4
    this.material.uniforms.uIntensity.value = (on ? 0.1 + 0.18 * dusk + 0.08 * darkness : 0) * (firstPerson ? 0.35 : 1)
    this.mesh.visible = on
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
