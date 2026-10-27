import * as THREE from 'three'
import type { MapData } from './MapData'
import type { Tier } from './quality'
import type { Vehicle } from './Vehicle'

/**
 * TYRE TRACKS (2026-10-27, OTH leaves ruts behind you): each wheel lays a dark tread mark where it rolls on soft
 * ground — the tracks' dirt, the mud (deepest, darkest), the sand and gravel at the water, the crater's floor; none on
 * rock, planks, grass (its blades would hide them) or in the water. A ring of `tier` segments (each ~0.4 m, one per
 * wheel per step it moves): ONE instanced draw, the ground DARKENED under it (multiply blending: the light and the
 * ground's own colour stay), a tread pattern across, soft edges, fading over two minutes and out past 70 m.
 * ≈ 0.02 ms CPU (four tests a frame), the GPU a few hundred thin quads.
 */
export class TyreTracks {
  readonly mesh: THREE.Mesh
  private readonly n: number
  private readonly a0: THREE.InstancedBufferAttribute // start xyz, birth time
  private readonly a1: THREE.InstancedBufferAttribute // end xyz, darkness
  private head = 0
  private readonly geo: THREE.InstancedBufferGeometry
  private readonly last: (THREE.Vector3 | null)[] = [null, null, null, null]
  private readonly c = new THREE.Vector3()
  private readonly time = { value: 0 }

  constructor(private readonly map: MapData, tier: Tier) {
    this.n = tier.name === 'low' ? 1400 : tier.name === 'medium' ? 2400 : 3600
    const g = new THREE.InstancedBufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 0, 1, 0, 1, 1, 0, 1, -1, 0], 3)) // (x: along 0 … 1, y: across)
    g.setIndex([0, 2, 1, 0, 3, 2])
    this.a0 = new THREE.InstancedBufferAttribute(new Float32Array(this.n * 4).fill(-1e5), 4).setUsage(THREE.DynamicDrawUsage)
    this.a1 = new THREE.InstancedBufferAttribute(new Float32Array(this.n * 4), 4).setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('aS', this.a0)
    g.setAttribute('aE', this.a1)
    g.instanceCount = 0 // (only what's been laid: grows to n, then the ring wraps)
    this.geo = g
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.time },
      vertexShader: /* glsl */ `
        attribute vec4 aS;
        attribute vec4 aE;
        uniform float uTime;
        varying vec2 vUv;
        varying float vK;
        void main() {
          vec3 d = aE.xyz - aS.xyz;
          vec3 side = normalize(vec3(-d.z, 0.0, d.x) + 1e-5) * 0.15;
          vec3 w = mix(aS.xyz, aE.xyz, position.x) + side * position.y + vec3(0.0, 0.06, 0.0);
          vUv = vec2(position.x * length(d), position.y);
          float age = uTime - aS.w;
          vec4 mv = modelViewMatrix * vec4(w, 1.0);
          vK = aE.w * (1.0 - smoothstep(60.0, 120.0, age)) * (1.0 - smoothstep(45.0, 70.0, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying float vK;
        void main() {
          // the tread: bars across the mark, the edges soft
          float tread = 0.7 + 0.3 * step(0.5, fract(vUv.x * 4.5 + abs(vUv.y) * 0.6));
          float edge = 1.0 - smoothstep(0.55, 1.0, abs(vUv.y));
          float k = vK * tread * edge;
          gl_FragColor = vec4(vec3(1.0 - k), 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide, // (the quads' winding faces down: culled from above)
      blending: THREE.MultiplyBlending,
      premultipliedAlpha: true,
      // (no polygon offset: with the reversed depth buffer (main.ts) a negative one pushes the marks UNDER the ground —
      //  they lie 6 cm over it instead)
    })
    this.mesh = new THREE.Mesh(g, mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 1
  }

  update(car: Vehicle, t: number): void {
    this.time.value = t
    const sim = car.sim, model = car.model
    if (!sim || !model) return
    const q = car.root.quaternion, p = car.root.position, hw = this.map.meta.trails.hw
    let wrote = false
    for (let k = 0; k < 4; k++) {
      const wk = sim.wheels[k]
      const [hx, hy, hz] = model.wheelPos[k]
      const c = this.c.set(hx, hy + wk.lift - model.wheelRadius * 0.9, hz).applyQuaternion(q).add(p)
      // what it rolls on: the tracks' dirt, mud, the water's sand — not rock, planks, grass or water
      const ground = this.map.height(c.x, c.z)
      const onGround = wk.contact && c.y < ground + 0.35 && this.map.bridgeAt(c.x, c.z) === null && this.map.waterLevel(c.x, c.z) === null
      const mud = this.map.mudAt(c.x, c.z), track = Math.max(0, Math.min(1, (hw + 0.3 - this.map.trailDist(c.x, c.z)) / 0.8))
      const dark = onGround ? Math.max(mud * 0.6, track * 0.32) : 0
      const prev = this.last[k]
      if (dark < 0.05) { this.last[k] = null; continue }
      c.y = ground
      if (!prev) { this.last[k] = c.clone(); continue }
      if (prev.distanceToSquared(c) < 0.16) continue
      if (prev.distanceToSquared(c) > 4) { prev.copy(c); continue } // (a jump / a reset: no streak across)
      const i = this.head
      this.head = (this.head + 1) % this.n
      this.a0.setXYZW(i, prev.x, prev.y, prev.z, t)
      this.a1.setXYZW(i, c.x, c.y, c.z, dark)
      prev.copy(c)
      wrote = true
    }
    if (wrote) { this.a0.needsUpdate = true; this.a1.needsUpdate = true; this.geo.instanceCount = Math.max(this.geo.instanceCount, this.head === 0 ? this.n : this.head) }
  }
}
