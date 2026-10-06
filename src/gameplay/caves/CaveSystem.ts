import * as THREE from 'three'
import type { WorldFields } from '../../world/WorldFields'
import type { Formation } from '../../world/Formations/formations'
import { caveAir, caveLight, cavePlan, type CavePlan } from '../../world/Formations/caves'
import { hash4 } from '../../world/noise/rng'

/**
 * CAVES, the live part (the rock, its baked darkness and the carved terrain come from the chunk workers —
 * world/Formations/caves.ts). For each hillside cave within ~260 m of the player:
 *   - CRYSTAL clusters on the walls: one InstancedMesh of elongated octahedra, unlit HDR cyan (bloom on MEDIUM+)
 *   - the POOL in the chamber's basin: a still, dark teal water disc with a slow shimmer and a fresnel sheen
 *   - SUNBEAMS under the skylights: soft additive light columns (fade with the sun; none at night)
 *   - the TREASURE CHEST in the hidden alcove, a golden sparkle over it until it is opened (E: lid swings open,
 *     full heal, +1 treasure)
 * and `inside` (0..1): how deep in the dark the player stands (the baked cave light at their position, smoothed) —
 * Game dims the sky fill, the fog closes in and darkens, the exposure opens up, the torch works at full strength.
 * Cost per cave: 4 draws (crystals, pool, beams, chest) only while near; ~1.5 k triangles; built once (~1 ms).
 */
interface CaveEntry {
  f: Formation
  plan: CavePlan
  root: THREE.Group
  beams: THREE.Mesh | null
  beamMat: THREE.ShaderMaterial | null
  chest: { lid: THREE.Object3D; sparkle: THREE.Mesh; pos: THREE.Vector3; open: number; id: number } | null
}

const CRYSTAL_COLOR = new THREE.Color(1.15, 1.45, 1.6)

export class CaveSystem {
  readonly group = new THREE.Group()
  /** 0 = open air … 1 = deep in a dark cave (smoothed). */
  inside = 0
  /** A closed chest within reach (HUD prompt). */
  nearChest = false
  /** Chests opened this session (by id). */
  readonly opened = new Set<number>()
  treasures = 0
  private readonly caves = new Map<number, CaveEntry>()
  private readonly list: Formation[] = []
  private scanT = 0
  private readonly crystalGeo: THREE.BufferGeometry
  private readonly crystalMat = new THREE.MeshBasicMaterial({ color: CRYSTAL_COLOR, vertexColors: true, toneMapped: true, fog: true })
  private readonly poolMat: THREE.ShaderMaterial
  private readonly chestMat = new THREE.MeshLambertMaterial({ vertexColors: true })
  private readonly sparkleMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2.2, 0.8), transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending })
  private readonly _cl: [number, number] = [0, 0]

  constructor(private readonly fields: WorldFields) {
    this.group.name = 'caves'
    // Crystal: an elongated octahedron, base at y = 0 (grows out of the wall along +y).
    const g = new THREE.OctahedronGeometry(0.5, 0).toNonIndexed()
    g.scale(0.5, 1.6, 0.5).translate(0, 0.55, 0)
    // Vertex colour: a deep blue base growing into a glowing pale-cyan tip (the base is buried in the wall).
    const cp = g.getAttribute('position'), cc = new Float32Array(cp.count * 3)
    for (let i = 0; i < cp.count; i++) {
      const t = Math.min(1, Math.max(0, cp.getY(i) / 1.35))
      cc.set([0.04 + 0.22 * t, 0.2 + 0.85 * t, 0.5 + 0.85 * t], i * 3)
    }
    g.setAttribute('color', new THREE.BufferAttribute(cc, 3))
    this.crystalGeo = g
    this.poolMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: { value: 0 }, uGlow: { value: new THREE.Color(0.05, 0.3, 0.38) } },
      vertexShader: /* glsl */ `varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uGlow; varying vec3 vW;
        void main() {
          vec3 V = normalize(cameraPosition - vW);
          float fres = pow(1.0 - max(V.y, 0.0), 3.0);
          // Slow caustic shimmer: two drifting sine lattices.
          float c = sin(vW.x * 2.1 + uTime * 0.7) * sin(vW.z * 1.7 - uTime * 0.55) + sin((vW.x + vW.z) * 1.3 + uTime * 0.4) * 0.6;
          vec3 col = vec3(0.01, 0.05, 0.06) + uGlow * (0.35 + 0.15 * c) + vec3(0.25, 0.45, 0.5) * fres * 0.5;
          gl_FragColor = vec4(col, 0.82 + 0.15 * fres);
        }`,
    })
  }

  /**
   * @param pos player (or camera) position   @param sun 0..1 daylight strength at the key light (beams)
   */
  update(dt: number, time: number, pos: THREE.Vector3, sun: number): void {
    this.scanT -= dt
    if (this.scanT <= 0) {
      this.scanT = 0.5
      this.fields.formations.cavesNear(pos.x, pos.z, 260, this.list)
      const keep = new Set<number>()
      for (const f of this.list) {
        keep.add(f.seed)
        if (!this.caves.has(f.seed)) this.caves.set(f.seed, this.build(f))
      }
      for (const [k, e] of this.caves) {
        if (keep.has(k) || Math.hypot(e.f.x - pos.x, e.f.z - pos.z) < 340) continue
        this.dispose(e)
        this.caves.delete(k)
      }
    }
    // How deep in the dark: the baked cave light at the player's position (inside the air only).
    let target = 0
    this.nearChest = false
    for (const e of this.caves.values()) {
      const f = e.f
      const c = Math.cos(f.rot), s = Math.sin(f.rot), dx = pos.x - f.x, dz = pos.z - f.z
      const lx = dx * c + dz * s, lz = -dx * s + dz * c, ly = pos.y - f.y
      if (Math.abs(lx) < 70 && Math.abs(lz) < 70) {
        const air = caveAir(e.plan, f.seed, lx, ly + 1, lz, 0)
        if (air < 1.5) {
          caveLight(e.plan, lx, ly + 1, lz, this._cl)
          target = Math.max(target, (1 - this._cl[0]) * Math.min(1, (1.5 - air) / 2))
        }
      }
      if (e.beamMat) e.beamMat.uniforms.uSun.value = sun
      const ch = e.chest
      if (ch) {
        if (ch.open > 0 && ch.open < 1) ch.open = Math.min(1, ch.open + dt * 1.6)
        ch.lid.rotation.x = -1.9 * (1 - (1 - ch.open) ** 3)
        ch.sparkle.visible = ch.open === 0
        if (ch.sparkle.visible) {
          const k = 0.8 + 0.25 * Math.sin(time * 3.1)
          ch.sparkle.scale.setScalar(k)
          ch.sparkle.rotation.y = time
        }
        if (ch.open === 0 && pos.distanceTo(ch.pos) < 2.4) this.nearChest = true
      }
    }
    this.inside += (target - this.inside) * (1 - Math.exp(-dt * 2.2)) // the eye adapts over ~½ s
    this.poolMat.uniforms.uTime.value = time
    // Crystals breathe a little.
    this.crystalMat.color.copy(CRYSTAL_COLOR).multiplyScalar(0.85 + 0.15 * Math.sin(time * 1.3))
  }

  /** E near a closed chest: open it. Returns true when a chest was opened (the reward is the caller's). */
  tryOpen(pos: THREE.Vector3): boolean {
    for (const e of this.caves.values()) {
      const ch = e.chest
      if (ch && ch.open === 0 && pos.distanceTo(ch.pos) < 2.4) {
        ch.open = 0.001
        this.opened.add(ch.id)
        this.treasures++
        return true
      }
    }
    return false
  }

  private build(f: Formation): CaveEntry {
    const plan = cavePlan(f)
    const root = new THREE.Group()
    root.name = `cave ${f.seed}`
    root.position.set(f.x, f.y, f.z)
    root.rotation.y = -f.rot // formation local → world (Formations/formations.ts buildFormation)
    root.updateMatrix()
    root.matrixAutoUpdate = false
    let k = 0
    const rnd = () => hash4(f.seed, 7301, k++, 5) / 4294967296
    // ---- crystals: 3–5 per cluster, fanned around the wall normal ----
    const mats: THREE.Matrix4[] = []
    const q = new THREE.Quaternion(), q2 = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), n = new THREE.Vector3(), tilt = new THREE.Vector3()
    for (const [x, y, z, nx, ny, nz] of plan.crystals) {
      n.set(nx, ny, nz).normalize()
      const cnt = 3 + Math.floor(rnd() * 3)
      for (let i = 0; i < cnt; i++) {
        tilt.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(0.9).add(n).normalize()
        q.setFromUnitVectors(up, tilt)
        q2.setFromAxisAngle(tilt, rnd() * Math.PI)
        const sz = (i === 0 ? 0.9 : 0.4 + rnd() * 0.4) * (0.7 + rnd() * 0.5)
        // Rooted ~0.5 m inside the wall (the rough rock mesh ±0.5 m around the SDF never leaves them floating).
        mats.push(new THREE.Matrix4().compose(new THREE.Vector3(x - n.x * 0.55 + (rnd() - 0.5) * 0.5, y - n.y * 0.55 + (rnd() - 0.5) * 0.5, z - n.z * 0.55 + (rnd() - 0.5) * 0.5), q2.multiply(q), new THREE.Vector3(sz, sz * (1 + rnd() * 0.8), sz)))
      }
    }
    if (mats.length) {
      const im = new THREE.InstancedMesh(this.crystalGeo, this.crystalMat, mats.length)
      mats.forEach((m, i) => im.setMatrixAt(i, m))
      im.name = 'cave.crystals'
      im.computeBoundingSphere()
      root.add(im)
    }
    // ---- pool ----
    const [px, pz, prx, prz] = plan.pool
    const pool = new THREE.Mesh(new THREE.CircleGeometry(1, 28).rotateX(-Math.PI / 2), this.poolMat)
    pool.scale.set(prx * 0.92, 1, prz * 0.92)
    pool.position.set(px, plan.waterY, pz)
    pool.name = 'cave.pool'
    root.add(pool)
    // ---- sunbeams under the skylights ----
    let beams: THREE.Mesh | null = null, beamMat: THREE.ShaderMaterial | null = null
    if (plan.holes.length) {
      const parts: THREE.BufferGeometry[] = []
      for (const [hx, hz, hr] of plan.holes) {
        const top = plan.chamber[1] + plan.cr[1] + 14
        const h = top - plan.floor
        const g = new THREE.CylinderGeometry(hr * 0.95, hr * 1.5, h, 18, 1, true)
        g.translate(hx, plan.floor + h / 2, hz)
        parts.push(g)
      }
      const geo = parts.length === 1 ? parts[0] : mergeCylinders(parts)
      beamMat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        uniforms: { uSun: { value: 1 }, uBottom: { value: plan.floor }, uTop: { value: plan.chamber[1] + plan.cr[1] + 14 } },
        vertexShader: /* glsl */ `varying vec3 vN; varying vec3 vV; varying float vH; uniform float uBottom, uTop;
          void main() { vec4 w = modelMatrix * vec4(position, 1.0); vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - w.xyz);
            vH = (position.y - uBottom) / (uTop - uBottom); gl_Position = projectionMatrix * viewMatrix * w; }`,
        fragmentShader: /* glsl */ `varying vec3 vN; varying vec3 vV; varying float vH; uniform float uSun;
          void main() {
            float edge = pow(abs(dot(normalize(vN), vV)), 3.0);           // soft column edges, bright core
            float fade = smoothstep(0.0, 0.35, vH) * (1.0 - smoothstep(0.55, 1.0, vH)); // dissolves top and bottom
            gl_FragColor = vec4(vec3(1.0, 0.9, 0.7) * edge * fade * 0.075 * uSun, 1.0);
          }`,
      })
      beams = new THREE.Mesh(geo, beamMat)
      beams.name = 'cave.beams'
      beams.renderOrder = 5
      root.add(beams)
    }
    // ---- the chest in the hidden alcove (on the real floor: march down through the rough air) ----
    let chest: CaveEntry['chest'] = null
    {
      const [ax, ay, az] = plan.alcove
      let y = ay + 3
      for (let i = 0; i < 40 && caveAir(plan, f.seed, ax, y, az) < 0; i++) y -= 0.2
      const cg = new THREE.Group()
      cg.position.set(ax, y - 0.05, az)
      cg.rotation.y = Math.atan2(plan.side[0][0] - ax, plan.side[0][2] - az) // facing the way in
      const base = chestBox(1.0, 0.55, 0.62, false)
      const body = new THREE.Mesh(base, this.chestMat)
      const lidPivot = new THREE.Group()
      lidPivot.position.set(0, 0.55, -0.31)
      const lid = new THREE.Mesh(chestBox(1.0, 0.28, 0.62, true).translate(0, 0, 0.31), this.chestMat)
      lidPivot.add(lid)
      const sparkle = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), this.sparkleMat)
      sparkle.position.set(0, 1.25, 0)
      cg.add(body, lidPivot, sparkle)
      root.add(cg)
      root.updateMatrixWorld(true)
      const wp = cg.getWorldPosition(new THREE.Vector3())
      const id = f.seed
      chest = { lid: lidPivot, sparkle, pos: wp, open: this.opened.has(id) ? 1 : 0, id }
    }
    this.group.add(root)
    return { f, plan, root, beams, beamMat, chest }
  }

  private dispose(e: CaveEntry): void {
    this.group.remove(e.root)
    e.root.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh && m.geometry !== this.crystalGeo) m.geometry.dispose()
    })
    e.beamMat?.dispose()
  }
}

/** A chest part (vertex colours): dark red-brown wood with two gold bands and a gold rim; the lid is rounded on top. */
function chestBox(w: number, h: number, d: number, lid: boolean): THREE.BufferGeometry {
  const g = (lid ? new THREE.CylinderGeometry(d / 2, d / 2, w, 12, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateY(Math.PI / 2).scale(1, h / (d / 2), 1) : new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0)).toNonIndexed()
  const pos = g.getAttribute('position')
  const col = new Float32Array(pos.count * 3)
  const wood = new THREE.Color(0x6a2c1c).convertSRGBToLinear(), gold = new THREE.Color(0xe8b040).convertSRGBToLinear()
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i)
    const band = Math.abs(Math.abs(x) - w * 0.3) < 0.06 || (!lid && y < 0.06) || (!lid && y > h - 0.05)
    ;(band ? gold : wood).toArray(col, i * 3)
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  g.computeVertexNormals()
  return g
}

function mergeCylinders(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const ps: number[] = [], ns: number[] = [], idx: number[] = []
  let base = 0
  for (const g of parts) {
    const p = g.getAttribute('position'), n = g.getAttribute('normal'), ix = g.index!
    for (let i = 0; i < p.count; i++) ps.push(p.getX(i), p.getY(i), p.getZ(i)), ns.push(n.getX(i), n.getY(i), n.getZ(i))
    for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + base)
    base += p.count
    g.dispose()
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(ps, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(ns, 3))
  g.setIndex(idx)
  return g
}
