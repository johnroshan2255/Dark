import * as THREE from 'three'

/**
 * WIND DRIFT: grains skimming over the ground in the wind — blowing SAND over the desert, powder SNOW streaming
 * across the snowfields (Genshin's Sumeru / Dragonspine air). Point sprites in a box that wraps around the player
 * in the vertex shader (no CPU per frame, like the rain), kept in a thin layer just above the feet (0–1.6 m,
 * denser low down), racing along the wind with a little lift and swirl; each grain is a short soft streak.
 * Amount = biome weight × wind strength × the tier's particle share; invisible elsewhere. One draw call.
 */
const WHITE = new THREE.Color(1, 1, 1)

export class WindDrift {
  readonly points: THREE.Points
  private readonly material: THREE.ShaderMaterial

  constructor(count = 1800) {
    const pos = new Float32Array(count * 3)
    const seed = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      pos[i * 3] = Math.random() * 36
      pos[i * 3 + 1] = Math.pow(Math.random(), 2.2) * 1.6
      pos[i * 3 + 2] = Math.random() * 36
      seed[i] = Math.random()
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 1))
    this.material = new THREE.ShaderMaterial({
      name: 'WindDrift',
      transparent: true,
      depthWrite: false,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uFeet: { value: 0 }, uAmount: { value: 0 }, uScale: { value: 400 },
        uWind: { value: new THREE.Vector2(1, 0) }, uColor: { value: new THREE.Color() },
      }]),
      vertexShader: /* glsl */ `
        attribute float seed; uniform float uTime, uScale, uAmount, uFeet; uniform vec3 uCam; uniform vec2 uWind;
        varying float vA; varying vec2 vDir;
        #include <fog_pars_vertex>
        void main() {
          vec3 p = position;
          float ws = max(length(uWind), 0.3);
          vec2 wd = uWind / ws;
          float speed = (5.0 + seed * 6.0) * ws;
          p.xz += wd * uTime * speed + vec2(sin(uTime * 1.3 + seed * 30.0), cos(uTime * 1.1 + seed * 17.0)) * 0.6;
          p.y += sin(uTime * 2.0 + seed * 40.0) * 0.12;
          vec3 box = vec3(36.0, 1.6, 36.0);
          vec3 o = vec3(uCam.x - 18.0, 0.0, uCam.z - 18.0);
          vec3 wp = vec3(o.x + mod(p.x - o.x, box.x), uFeet - 0.15 + p.y, o.z + mod(p.z - o.z, box.z));
          if (seed > uAmount) wp = vec3(0.0, -1e4, 0.0);
          vec4 mvPosition = modelViewMatrix * vec4(wp, 1.0);
          float d = length(wp.xz - uCam.xz);
          vA = (1.0 - smoothstep(10.0, 18.0, d)) * smoothstep(0.5, 2.0, d) * (1.0 - p.y / 1.8);
          // Streak direction on screen = the wind's.
          vec4 a = projectionMatrix * mvPosition, b = projectionMatrix * modelViewMatrix * vec4(wp + vec3(wd.x, 0.0, wd.y), 1.0);
          vDir = normalize(b.xy / b.w - a.xy / a.w + 1e-5);
          gl_PointSize = clamp(0.35 * uScale / max(-mvPosition.z, 0.5), 2.0, 40.0);
          gl_Position = a;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; varying float vA; varying vec2 vDir;
        #include <fog_pars_fragment>
        void main() {
          vec2 q = gl_PointCoord - 0.5;
          q.y = -q.y;
          float along = dot(q, vDir), across = dot(q, vec2(-vDir.y, vDir.x));
          float a = (1.0 - smoothstep(0.0, 0.5, abs(along))) * (1.0 - smoothstep(0.02, 0.12, abs(across))) * vA * 0.7;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor, a);
          #include <fog_fragment>
        }`,
    })
    this.points = new THREE.Points(g, this.material)
    this.points.frustumCulled = false
    this.points.name = 'wind-drift'
    this.points.visible = false
    this.points.renderOrder = 6
  }

  /** @param sand desert weight · @param snow snowfield weight · @param budget tier particle share · @param feet ground y under the player */
  update(time: number, cam: THREE.Vector3, feet: number, sand: number, snow: number, windStrength: number, budget: number, wind: THREE.Vector2, light: THREE.Color, viewportHeight: number): void {
    const u = this.material.uniforms
    const amount = Math.min(1, Math.max(sand, snow) * (0.25 + 0.75 * windStrength) * budget)
    u.uTime.value = time
    ;(u.uCam.value as THREE.Vector3).copy(cam)
    u.uFeet.value = feet
    u.uAmount.value = amount
    ;(u.uWind.value as THREE.Vector2).copy(wind)
    // Sand: warm tan lit by the sky; snow: white.
    const c = u.uColor.value as THREE.Color
    c.setRGB(0.95, 0.78, 0.52).lerp(WHITE, snow / Math.max(1e-3, sand + snow)).multiply(light)
    u.uScale.value = viewportHeight * 0.714
    this.points.visible = amount > 0.02
  }

  dispose(): void {
    this.points.geometry.dispose()
    this.material.dispose()
  }
}
