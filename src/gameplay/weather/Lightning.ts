import * as THREE from 'three'
import type { AudioSystem } from '../../audio/AudioSystem'
import { Rng } from '../../world/noise/rng'
import type { WorldFields } from '../../world/WorldFields'
import type { PlayerController } from '../player/PlayerController'
import type { Health } from '../survival/Health'

/**
 * Random lightning during monster time (night: every 15–45 s, nightmare: 5–15 s).
 *
 * Look (reference: red nightmare storm):
 *  - Bolt = fractal main channel + forked branches + sub-branches, built as camera-facing ribbons whose shader
 *    draws a thin blinding pink-white CORE inside a wide crimson GLOW (Gaussian profiles across the ribbon).
 *  - Stepped leader: the bolt GROWS top→down in ~70 ms, then the return stroke, then 1–3 random re-strikes
 *    (random timing and strength per strike — no two look the same). Branch tips fade.
 *  - Light: the flash lights the CLOUDS around the bolt from inside (sky shader, directional) and gives the
 *    ground a short red-violet burst via the hemisphere light — no full-screen colour wash.
 *  - Thunder: AudioSystem, delayed by distance / 343 m/s.
 * Danger: ~15% of strikes land 2–9 m from the player. ≤ 3.5 m: 45 damage + knockdown; ≤ 9 m: 12 + stagger.
 * Cost: 1 draw for < 0.6 s per strike; a few hundred triangles.
 */
export class Lightning {
  readonly mesh: THREE.Mesh
  enabled = true
  /** Current flash intensity 0..~1.2 (lighting, sky and grading read this). */
  flash = 0
  /** World direction from the camera to the bolt's upper channel (sky lights clouds around it). */
  readonly boltDir = new THREE.Vector3(0, 1, 0)
  readonly lastStrike = new THREE.Vector3()
  lastDistance = Infinity
  strikes = 0
  private timer = 12
  private age = 99
  private readonly rng = new Rng((Date.now() & 0x7fffffff) ^ 0x7e57)
  private readonly material: THREE.ShaderMaterial
  /** Re-strike times and strengths for the current strike. */
  private pulses: [number, number][] = []
  private readonly top = new THREE.Vector3()

  constructor(
    private readonly fields: WorldFields,
    private readonly player: PlayerController,
    private readonly health: Health,
    private readonly audio: AudioSystem,
  ) {
    this.material = new THREE.ShaderMaterial({
      name: 'Lightning',
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uIntensity: { value: 0 },
        uReveal: { value: 1 },
        uCore: { value: new THREE.Color(1.0, 0.82, 0.9) },
        uGlow: { value: new THREE.Color(1.0, 0.16, 0.24) },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        attribute float across; attribute float along; attribute float strength;
        varying float vAcross; varying float vAlong; varying float vStrength;
        void main() {
          vAcross = across; vAlong = along; vStrength = strength;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uIntensity, uReveal, uTime; uniform vec3 uCore, uGlow;
        varying float vAcross; varying float vAlong; varying float vStrength;
        void main() {
          if (vAlong > uReveal) discard;                       // stepped leader growing downward
          float a2 = vAcross * vAcross;
          float core = exp(-a2 * 90.0);                         // blinding thin channel
          float glow = exp(-a2 * 5.0);                          // crimson corona
          float head = smoothstep(uReveal - 0.04, uReveal, vAlong) * step(uReveal, 0.999) * 2.0; // hot leader tip
          float tip = 1.0 - smoothstep(0.55, 1.0, vStrength < 0.99 ? vAlong : 0.0); // branch tips fade
          float flick = 0.85 + 0.15 * sin(uTime * 180.0 + vAlong * 40.0);
          vec3 col = uCore * core * 9.0 + uGlow * glow * 2.4;
          gl_FragColor = vec4(col * vStrength * uIntensity * flick * (1.0 + head), 1.0);
        }`,
    })
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material)
    this.mesh.name = 'lightning'
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    this.mesh.renderOrder = 20
  }

  /** Rain storm 0..1 (weather): strikes every 18–50 s in blue-white, day or night. */
  storm = 0

  update(dt: number, monsterTime: boolean, nightmare: number, camera: THREE.Camera): void {
    this.age += dt
    const t = this.age
    // Stepped leader (0–70 ms, dim), then return stroke + random re-strikes.
    const reveal = Math.min(1, t / 0.07)
    let f = reveal < 1 ? 0.12 * reveal : 0
    for (const [t0, s] of this.pulses) if (t >= t0) f = Math.max(f, s * Math.exp(-(t - t0) * 16))
    this.flash = f
    const u = this.material.uniforms
    u.uReveal.value = reveal
    u.uIntensity.value = reveal < 1 ? 0.5 : Math.min(1.2, f * 1.3)
    u.uTime.value = t
    this.mesh.visible = t < 0.9 && (reveal < 1 || f > 0.05)
    // Reddish storm light: crimson-magenta corona at night, deep blood red in the nightmare realm.
    const stormOnly = this.storm > 0.5 && !monsterTime
    if (stormOnly) {
      ;(u.uGlow.value as THREE.Color).setRGB(0.55, 0.65, 1.0) // rain storm: blue-white
      ;(u.uCore.value as THREE.Color).setRGB(0.96, 0.98, 1)
    } else {
      ;(u.uGlow.value as THREE.Color).setRGB(0.95 + 0.05 * nightmare, 0.22 - 0.08 * nightmare, 0.42 - 0.2 * nightmare)
      ;(u.uCore.value as THREE.Color).setRGB(1, 0.86 - 0.04 * nightmare, 0.95 - 0.05 * nightmare)
    }
    if (!this.enabled || (!monsterTime && this.storm < 0.5)) return
    this.timer -= dt
    if (this.timer <= 0) {
      this.timer = nightmare > 0.5 ? 5 + this.rng.next() * 10 : stormOnly ? 18 + this.rng.next() * 32 : 15 + this.rng.next() * 30
      this.strike(!stormOnly && this.rng.next() < 0.15, camera) // storm strikes never target the player
    }
  }

  /** @param near land 2–9 m from the player (dangerous). Public for tests/debug. */
  strike(near: boolean, camera: THREE.Camera): void {
    const p = this.player.renderPosition
    const a = this.rng.next() * Math.PI * 2
    const d = near ? 2 + this.rng.next() * 7 : 25 + this.rng.next() * 120
    const x = p.x + Math.cos(a) * d
    const z = p.z + Math.sin(a) * d
    const ground = new THREE.Vector3(x, this.fields.height(x, z), z)
    this.lastStrike.copy(ground)
    this.lastDistance = d
    this.strikes++
    this.build(ground, camera.position)
    this.boltDir.copy(this.top).sub(camera.position).normalize()
    this.age = 0
    // Return stroke at 70 ms, then 1–3 re-strikes with random gaps/strengths.
    this.pulses = [[0.07, 1]]
    let t = 0.07
    const n = 1 + Math.floor(this.rng.next() * 3)
    for (let i = 0; i < n; i++) {
      t += 0.06 + this.rng.next() * 0.16
      this.pulses.push([t, 0.45 + this.rng.next() * 0.5])
    }
    this.audio.thunder(d)
    if (!this.health.dead) {
      _v.subVectors(p, ground)
      _v.y = 0
      const dist = _v.length()
      if (dist < 9) {
        _v.normalize()
        if (dist < 3.5) {
          this.health.damage(45, 'lightning')
          this.player.applyImpulse(_v.x * 10, 6, _v.z * 10, 2.2)
        } else {
          this.health.damage(12, 'lightning')
          this.player.applyImpulse(_v.x * 5, 2, _v.z * 5, 0.5)
        }
      }
    }
  }

  private build(ground: THREE.Vector3, cam: THREE.Vector3): void {
    const top = this.top.set(ground.x + this.rng.range(-25, 25), ground.y + 170, ground.z + this.rng.range(-25, 25))
    const rng = this.rng
    // Midpoint displacement, perpendicular jitter (lightning zig-zags sideways far more than vertically).
    const channel = (a: THREE.Vector3, b: THREE.Vector3, depth: number, amp: number): THREE.Vector3[] => {
      let pts = [a.clone(), b.clone()]
      for (let k = 0; k < depth; k++) {
        const next: THREE.Vector3[] = [pts[0]]
        for (let i = 0; i < pts.length - 1; i++) {
          const m = new THREE.Vector3().lerpVectors(pts[i], pts[i + 1], 0.5 + rng.range(-0.1, 0.1))
          m.x += rng.range(-amp, amp)
          m.z += rng.range(-amp, amp)
          next.push(m, pts[i + 1])
        }
        pts = next
        amp *= 0.52
      }
      return pts
    }
    type Strand = { p: THREE.Vector3[]; w: number; s: number; a0: number; a1: number }
    const main = channel(top, ground, 7, 22)
    const strands: Strand[] = [{ p: main, w: 3.2, s: 1, a0: 0, a1: 1 }]
    const fork = (from: Strand, count: number, len: number, w: number, s: number, depth: number) => {
      for (let b = 0; b < count; b++) {
        const i = 4 + Math.floor(rng.next() * (from.p.length * 0.75))
        const start = from.p[Math.min(i, from.p.length - 2)]
        const dir = new THREE.Vector3().subVectors(from.p[Math.min(i + 1, from.p.length - 1)], start).normalize()
        const end = start.clone().addScaledVector(dir, len * rng.range(0.5, 1)).add(new THREE.Vector3(rng.range(-len, len) * 0.6, -len * rng.range(0.2, 0.6), rng.range(-len, len) * 0.6))
        const along0 = from.a0 + (from.a1 - from.a0) * (i / from.p.length)
        const st: Strand = { p: channel(start, end, 5, len * 0.18), w, s, a0: along0, a1: Math.min(1, along0 + 0.35) }
        strands.push(st)
        if (depth > 0) fork(st, 2, len * 0.45, w * 0.6, s * 0.7, depth - 1)
      }
    }
    fork(strands[0], 4 + Math.floor(rng.next() * 3), 45, 1.8, 0.6, 1)

    const pos: number[] = [], across: number[] = [], along: number[] = [], strength: number[] = []
    const side = new THREE.Vector3(), dir = new THREE.Vector3(), toCam = new THREE.Vector3()
    for (const st of strands) {
      const n = st.p.length - 1
      for (let i = 0; i < n; i++) {
        const a = st.p[i], b = st.p[i + 1]
        dir.subVectors(b, a).normalize()
        toCam.subVectors(cam, a).normalize()
        const w = st.w * (1 - (i / n) * 0.55)
        side.crossVectors(dir, toCam).normalize().multiplyScalar(w)
        const al0 = st.a0 + (st.a1 - st.a0) * (i / n)
        const al1 = st.a0 + (st.a1 - st.a0) * ((i + 1) / n)
        const quad: [THREE.Vector3, number, number][] = [
          [a.clone().sub(side), -1, al0], [a.clone().add(side), 1, al0], [b.clone().add(side), 1, al1],
          [a.clone().sub(side), -1, al0], [b.clone().add(side), 1, al1], [b.clone().sub(side), -1, al1],
        ]
        for (const [v, ac, al] of quad) {
          pos.push(v.x, v.y, v.z)
          across.push(ac)
          along.push(al)
          strength.push(st.s)
        }
      }
    }
    const g = this.mesh.geometry
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('across', new THREE.Float32BufferAttribute(across, 1))
    g.setAttribute('along', new THREE.Float32BufferAttribute(along, 1))
    g.setAttribute('strength', new THREE.Float32BufferAttribute(strength, 1))
    g.computeBoundingSphere()
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}

const _v = new THREE.Vector3()
