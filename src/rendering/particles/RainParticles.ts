import * as THREE from 'three'

/**
 * RAIN: point sprites drawn as thin vertical streaks, in a box that wraps around the camera in the vertex shader
 * (no CPU per frame, like the nightmare ash), falling fast and slanting with the wind. Count = the tier's cap
 * (`particles.rain`); invisible when dry. Fogged by the scene fog so distant drops fade. One draw call.
 * SNOW (`snow` = 0..1, the snowfield weight under the player): that share of the particles become soft round
 * flakes that fall ~12× slower, flutter and drift with the wind — the same draw call, the same budget.
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
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uAmount: { value: 0 }, uSnow: { value: 0 }, uScale: { value: 400 }, uWind: { value: new THREE.Vector2() }, uColor: { value: new THREE.Color(0.8, 0.85, 0.95) } }]),
      vertexShader: /* glsl */ `
        attribute float seed; uniform float uTime, uScale, uAmount, uSnow; uniform vec3 uCam; uniform vec2 uWind;
        varying float vFade; varying float vSeed; varying float vFlake;
        #include <fog_pars_vertex>
        void main() {
          vec3 p = position;
          vFlake = step(fract(seed * 13.71), uSnow);
          float speed = mix(16.0 + seed * 8.0, 1.1 + seed * 0.9, vFlake);
          p.y -= uTime * speed;
          p.xz += uWind * uTime * mix(0.6, 1.4, vFlake) + vec2(seed * 3.0, seed * 7.0);
          // Flakes flutter: slow sideways loops, each on its own phase.
          p.xz += vec2(sin(uTime * 0.9 + seed * 40.0), cos(uTime * 0.7 + seed * 31.0)) * 0.7 * vFlake;
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
          gl_PointSize = mix(clamp(0.7 * uScale / max(-mv.z, 0.5), 2.0, 64.0), clamp((0.11 + 0.08 * seed) * uScale / max(-mv.z, 0.5), 1.5, 24.0), vFlake);
          gl_Position = projectionMatrix * mv;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; varying float vFade; varying float vSeed; varying float vFlake;
        #include <fog_pars_fragment>
        void main() {
          vec2 q = gl_PointCoord - 0.5;
          float a;
          if (vFlake > 0.5) {
            a = smoothstep(0.5, 0.15, length(q)) * 0.95 * vFade; // soft round flake
            if (a < 0.02) discard;
            gl_FragColor = vec4(uColor * 1.25 + 0.08, a);
          } else {
            if (abs(q.x) > 0.035 + 0.025 * vSeed) discard;
            a = (1.0 - abs(q.y) * 2.0) * 0.8 * vFade;
            gl_FragColor = vec4(uColor, a);
          }
          #include <fog_fragment>
        }`,
    })
    this.points = new THREE.Points(g, this.material)
    this.points.frustumCulled = false
    this.points.name = 'rain'
    this.points.visible = false
    this.points.renderOrder = 6
  }

  /**
   * @param amount 0..1 precipitation strength · @param budget 0..1 share of the pool the tier may draw
   * @param snow 0..1 share of the particles falling as snow flakes
   */
  update(time: number, cam: THREE.Vector3, amount: number, budget: number, wind: THREE.Vector2, light: THREE.Color, viewportHeight: number, snow = 0): void {
    const u = this.material.uniforms
    u.uSnow.value = snow
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
