import * as THREE from 'three'

/**
 * RAIN: point sprites drawn as thin vertical streaks, in a box that wraps around the camera in the vertex shader
 * (no CPU per frame, like the nightmare ash), falling fast and slanting with the wind. Count = the tier's cap
 * (`particles.rain`); invisible when dry. Fogged by the scene fog so distant drops fade. One draw call.
 */
export class RainParticles {
  readonly points: THREE.Points
  private readonly material: THREE.ShaderMaterial
  constructor(count = 2600) {
    const pos = new Float32Array(count * 3)
    const seed = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      pos[i * 3] = Math.random() * 40
      pos[i * 3 + 1] = Math.random() * 24
      pos[i * 3 + 2] = Math.random() * 40
      seed[i] = Math.random()
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 1))
    this.material = new THREE.ShaderMaterial({
      name: 'Rain',
      transparent: true,
      depthWrite: false,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uAmount: { value: 0 }, uScale: { value: 400 }, uWind: { value: new THREE.Vector2() }, uColor: { value: new THREE.Color(0.8, 0.85, 0.95) } }]),
      vertexShader: /* glsl */ `
        attribute float seed; uniform float uTime, uScale, uAmount; uniform vec3 uCam; uniform vec2 uWind;
        varying float vFade; varying float vSeed;
        #include <fog_pars_vertex>
        void main() {
          vec3 p = position;
          float speed = 16.0 + seed * 8.0;
          p.y -= uTime * speed;
          p.xz += uWind * uTime * 0.6 + vec2(seed * 3.0, seed * 7.0);
          vec3 box = vec3(48.0, 26.0, 48.0);
          vec3 o = uCam - vec3(24.0, 8.0, 24.0);
          vec3 wp = o + mod(p - o, box);
          // Thin the field beyond the tier's amount by dropping seeds (whole drops vanish, no half-alpha rain).
          if (seed > uAmount) wp = vec3(0.0, -1e4, 0.0);
          vec4 mvPosition = modelViewMatrix * vec4(wp, 1.0);
          vec4 mv = mvPosition;
          float d = length(wp - uCam);
          vFade = (1.0 - smoothstep(16.0, 26.0, d)) * smoothstep(0.4, 1.5, d);
          vSeed = seed;
          // Streak ≈ 0.35 m tall → point size from the distance; the fragment keeps only a thin vertical bar.
          gl_PointSize = clamp(0.7 * uScale / max(-mv.z, 0.5), 2.0, 64.0);
          gl_Position = projectionMatrix * mv;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; varying float vFade; varying float vSeed;
        #include <fog_pars_fragment>
        void main() {
          vec2 q = gl_PointCoord - 0.5;
          if (abs(q.x) > 0.035 + 0.025 * vSeed) discard;
          float a = (1.0 - abs(q.y) * 2.0) * 0.8 * vFade;
          gl_FragColor = vec4(uColor, a);
          #include <fog_fragment>
        }`,
    })
    this.points = new THREE.Points(g, this.material)
    this.points.frustumCulled = false
    this.points.name = 'rain'
    this.points.visible = false
    this.points.renderOrder = 6
  }

  /** @param amount 0..1 rain strength · @param budget 0..1 share of the pool the tier may draw */
  update(time: number, cam: THREE.Vector3, amount: number, budget: number, wind: THREE.Vector2, light: THREE.Color, viewportHeight: number): void {
    const u = this.material.uniforms
    u.uTime.value = time
    ;(u.uCam.value as THREE.Vector3).copy(cam)
    u.uAmount.value = Math.min(1, amount * budget)
    ;(u.uWind.value as THREE.Vector2).copy(wind)
    ;(u.uColor.value as THREE.Color).copy(light)
    u.uScale.value = viewportHeight * 0.714
    this.points.visible = amount > 0.02
  }

  dispose(): void {
    this.points.geometry.dispose()
    this.material.dispose()
  }
}
