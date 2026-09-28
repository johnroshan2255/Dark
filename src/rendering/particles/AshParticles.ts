import * as THREE from 'three'

/**
 * Nightmare-realm ash and embers (refer/nightmare: "Ash spores fall"). 700 points in a 60 m box that wraps
 * around the camera in the vertex shader (no CPU per frame), drifting down with a slow swirl; ~20% are
 * glowing embers (HDR red → bloom). Additive, depth-tested. 1 draw call; invisible outside the realm.
 */
export class AshParticles {
  readonly points: THREE.Points
  private readonly material: THREE.ShaderMaterial

  constructor(count = 700) {
    const pos = new Float32Array(count * 3)
    const seed = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      pos[i * 3] = Math.random() * 60
      pos[i * 3 + 1] = Math.random() * 30
      pos[i * 3 + 2] = Math.random() * 60
      seed[i] = Math.random()
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 1))
    this.material = new THREE.ShaderMaterial({
      name: 'Ash',
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uAmount: { value: 0 }, uScale: { value: 400 } },
      vertexShader: /* glsl */ `
        attribute float seed; uniform float uTime, uScale; uniform vec3 uCam; varying float vSeed; varying float vFade;
        void main() {
          vec3 p = position;
          p.y -= uTime * (0.4 + seed * 0.6);
          p.x += sin(uTime * 0.3 + seed * 40.0) * 2.0;
          p.z += cos(uTime * 0.25 + seed * 30.0) * 2.0;
          vec3 box = vec3(60.0, 30.0, 60.0);
          vec3 wp = uCam - vec3(30.0, 10.0, 30.0) + mod(p - (uCam - vec3(30.0, 10.0, 30.0)), box);
          vec4 mv = modelViewMatrix * vec4(wp, 1.0);
          vSeed = seed;
          vFade = 1.0 - smoothstep(18.0, 30.0, length(wp - uCam));
          // World size 4–7 cm → pixels (uScale = viewport height / (2·tan(fov/2))), clamped.
          gl_PointSize = clamp((seed > 0.8 ? 0.14 : 0.09) * uScale / -mv.z, 1.5, 9.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uAmount; varying float vSeed; varying float vFade;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          float a = (1.0 - d * 2.0) * vFade * uAmount;
          vec3 col = vSeed > 0.8 ? vec3(6.0, 1.0, 0.3) : vec3(0.6, 0.3, 0.26);
          gl_FragColor = vec4(col * a, 1.0);
        }`,
    })
    this.points = new THREE.Points(g, this.material)
    this.points.frustumCulled = false
    this.points.name = 'ash'
    this.points.visible = false
  }

  update(time: number, cam: THREE.Vector3, amount: number, viewportHeight: number): void {
    const u = this.material.uniforms
    u.uTime.value = time
    ;(u.uCam.value as THREE.Vector3).copy(cam)
    u.uAmount.value = amount
    u.uScale.value = viewportHeight * 0.714 // 1 / (2·tan(35°)) for the 70° camera
    this.points.visible = amount > 0.01
  }

  dispose(): void {
    this.points.geometry.dispose()
    this.material.dispose()
  }
}
