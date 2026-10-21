import * as THREE from 'three'
import type { WorldFields } from '../../world/WorldFields'
import type { Formation } from '../../world/Formations/formations'
import { caveAir, caveLight, cavePlan, CrystalHue, type CavePlan } from '../../world/Formations/caves'
import { hash4 } from '../../world/noise/rng'
import { CRYSTAL_RGB, createCrystalGeometry, createCrystalMaterial, createFlowerGeometry, createFlowerMaterial, createGlowMaterial, createMistMaterial, GlowKind, SHARD_RGB } from './caveFx'

/**
 * CAVES, the live part (the rock, its baked darkness and the carved terrain come from the chunk workers —
 * world/Formations/caves.ts). For each hillside cave within ~260 m of the player:
 *   - CRYSTAL clusters (caveFx.ts, Genshin's ores): quartz prisms fanned out of a socket of dark rock shards, a cut-gem
 *     HDR shader (cyan / deep blue in the chamber, violet amethyst guarding the treasure); haloes, twinkling stars,
 *     motes of light rising through the chamber, a few CRYSTALFLIES, luminous flowers on the floor, a low glowing mist
 *     — the "other world" inside the hill
 *   - the POOL in the chamber's basin: glowing turquoise water with a slow shimmer, a bright rim and a fresnel sheen
 *   - SUNBEAMS under the skylights: soft additive light columns (fade with the sun; none at night)
 *   - the TREASURE CHEST in the hidden alcove, a golden sparkle over it until it is opened (E: lid swings open,
 *     full heal, +1 treasure)
 * and `inside` (0..1): how deep in the dark the player stands (the baked cave light at their position, smoothed) —
 * Game dims the sky fill, the fog closes in and darkens, the exposure opens up, the torch works at full strength.
 * Cost per cave (only while within ~260 m): 8 draws (crystals, glow points, flowers, mist, pool, beams, chest ×2 + sparkle);
 * ~5 k triangles + ≤ 190 point sprites (motes / flies scale with the tier's particle share; LOW: smaller haloes, no
 * mist — both are additive overdraw); built once (~2 ms). Measured (M4, 844×390 LOW, in the chamber): 0.97–1.39 ms GPU vs 1.05–1.16 before (within run-to-run noise).
 */
interface CaveEntry {
  f: Formation
  plan: CavePlan
  root: THREE.Group
  beams: THREE.Mesh | null
  beamMat: THREE.ShaderMaterial | null
  chest: { lid: THREE.Object3D; sparkle: THREE.Mesh; pos: THREE.Vector3; open: number; id: number } | null
}

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
  /** Particle share of the quality tier (`particles.rain`: 0.35 LOW … 1): motes and crystalflies per cave. */
  fxShare = 1
  private readonly crystalGeo = createCrystalGeometry()
  private readonly crystalMat = createCrystalMaterial()
  private readonly glowMat = createGlowMaterial()
  private readonly flowerGeo = createFlowerGeometry()
  private readonly flowerMat = createFlowerMaterial()
  private readonly mistMat = createMistMaterial()
  private readonly poolMat: THREE.ShaderMaterial
  private readonly chestMat = new THREE.MeshLambertMaterial({ vertexColors: true })
  private readonly sparkleMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2.2, 0.8), transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending })
  private readonly _cl: [number, number, number] = [0, 0, 0]

  constructor(private readonly fields: WorldFields) {
    this.group.name = 'caves'
    this.poolMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: { value: 0 }, uGlow: { value: new THREE.Color(0.06, 0.5, 0.56) } },
      vertexShader: /* glsl */ `varying vec3 vW; varying vec2 vUv; void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uGlow; varying vec3 vW; varying vec2 vUv;
        void main() {
          vec3 V = normalize(cameraPosition - vW);
          float fres = pow(1.0 - max(V.y, 0.0), 3.0);
          // Glowing turquoise water (Genshin's cave pools light the chamber): caustic shimmer, a bright rim at the shore.
          float c = sin(vW.x * 2.1 + uTime * 0.7) * sin(vW.z * 1.7 - uTime * 0.55) + sin((vW.x + vW.z) * 1.3 + uTime * 0.4) * 0.6;
          float r = length(vUv * 2.0 - 1.0);
          float deep = 1.0 - smoothstep(0.0, 0.85, r);
          vec3 col = vec3(0.01, 0.05, 0.06) + uGlow * (0.45 + 0.25 * c) * (0.7 + 0.5 * (1.0 - deep)) + vec3(0.3, 0.55, 0.6) * fres * 0.5;
          col += vec3(0.25, 0.9, 0.85) * smoothstep(0.82, 0.98, r) * 0.6;
          gl_FragColor = vec4(col, 0.85 + 0.12 * fres);
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
    this.crystalMat.uniforms.uTime.value = time
    this.glowMat.uniforms.uTime.value = time
    this.flowerMat.uniforms.uTime.value = time
    this.mistMat.uniforms.uTime.value = time
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
    // ---- crystal clusters: a tall main crystal, 4–6 smaller ones fanned out, 2–3 dark rock shards at the root ----
    const mats: THREE.Matrix4[] = [], cols: number[] = [], glow: number[] = []
    const gp: number[] = [], gk: number[] = [], gs: number[] = [], gz: number[] = [], gc: number[] = []
    const sprite = (x: number, y: number, z: number, kind: number, size: number, c: readonly number[], k = 1) => {
      gp.push(x, y, z); gk.push(kind); gs.push(rnd()); gz.push(size); gc.push(c[0] * k, c[1] * k, c[2] * k)
    }
    const q = new THREE.Quaternion(), q2 = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), n = new THREE.Vector3(), tilt = new THREE.Vector3()
    const add = (x: number, y: number, z: number, dir: THREE.Vector3, w: number, len: number, rgb: readonly number[], isCrystal: boolean) => {
      q.setFromUnitVectors(up, dir)
      q2.setFromAxisAngle(dir, rnd() * Math.PI * 2)
      mats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q2.multiply(q), new THREE.Vector3(w, len, w)))
      cols.push(rgb[0], rgb[1], rgb[2]); glow.push(isCrystal ? 1 : 0)
    }
    for (const [x, y, z, nx, ny, nz, hue] of plan.crystals) {
      n.set(nx, ny, nz).normalize()
      // Grow upward-ish (Genshin's clusters stand up out of the rock, never hang sideways like spikes).
      const grow = n.clone().lerp(up, ny > -0.3 ? 0.45 : 0.1).normalize()
      const rgb = CRYSTAL_RGB[hue] ?? CRYSTAL_RGB[CrystalHue.Cyan]
      const rx = x - n.x * 0.25, ry = y - n.y * 0.25, rz = z - n.z * 0.25 // rooted in the rock
      const main = 1.3 + rnd() * 0.7
      add(rx, ry, rz, grow, main * (1 + rnd() * 0.25), main, rgb, true)
      const cnt = 4 + Math.floor(rnd() * 3)
      for (let i = 0; i < cnt; i++) {
        tilt.set(rnd() - 0.5, rnd() * 0.3, rnd() - 0.5).multiplyScalar(1.4).add(grow).normalize()
        const sz = 0.5 + rnd() * 0.55
        const off = 0.12 + rnd() * 0.18
        add(rx + (tilt.x - grow.x) * off, ry + (tilt.y - grow.y) * off, rz + (tilt.z - grow.z) * off, tilt.clone(), sz * (1.1 + rnd() * 0.4), sz, rgb, true)
      }
      for (let i = 0; i < 3; i++) {
        tilt.set(rnd() - 0.5, 0.2, rnd() - 0.5).normalize().lerp(grow, 0.25).normalize()
        add(rx + (rnd() - 0.5) * 0.4, ry + (rnd() - 0.5) * 0.4, rz + (rnd() - 0.5) * 0.4, tilt.clone(), 1.9 + rnd(), 0.32 + rnd() * 0.2, SHARD_RGB, false)
      }
      // Halo around the cluster + a twinkling star near the main crystal's tip.
      // (Halo pixels are additive overdraw: smaller on LOW.)
      sprite(rx + grow.x * 0.9, ry + grow.y * 0.9, rz + grow.z * 0.9, GlowKind.Halo, 3.2 * (0.6 + 0.4 * this.fxShare), rgb, 0.5)
      sprite(rx + grow.x * main * 1.05, ry + grow.y * main * 1.05, rz + grow.z * main * 1.05, GlowKind.Sparkle, 0.8, [1.6, 1.7, 1.8])
    }
    if (mats.length) {
      const im = new THREE.InstancedMesh(this.crystalGeo, this.crystalMat, mats.length)
      mats.forEach((m, i) => im.setMatrixAt(i, m))
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cols), 3)
      im.geometry = this.crystalGeo.clone() // + this cave's per-instance aGlow (crystal 1 / rock shard 0)
      im.geometry.setAttribute('aGlow', new THREE.InstancedBufferAttribute(new Float32Array(glow), 1))
      im.name = 'cave.crystals'
      im.computeBoundingSphere()
      root.add(im)
    }
    // ---- the chamber's floor: luminous flowers, motes of light, crystalflies, a low glowing mist ----
    const floorAt = (x: number, z: number): number | null => {
      let y = plan.floor + 3
      if (caveAir(plan, f.seed, x, y, z) >= 0) return null
      for (let i = 0; i < 40 && caveAir(plan, f.seed, x, y, z) < 0; i++) y -= 0.2
      return y > plan.floor - 1.2 ? y : null // not down in the pool basin
    }
    const ch = plan.chamber, cr = plan.cr
    const fm: THREE.Matrix4[] = [], fc: number[] = []
    const nFlowers = 14 + Math.round(30 * this.fxShare)
    for (let i = 0, tries = 0; i < nFlowers && tries < nFlowers * 4; tries++) {
      const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * 0.85
      const x = ch[0] + Math.cos(a) * d * cr[0], z = ch[2] + Math.sin(a) * d * cr[2]
      if (Math.hypot((x - plan.pool[0]) / plan.pool[2], (z - plan.pool[1]) / plan.pool[3]) < 1.15) continue
      const y = floorAt(x, z)
      if (y === null) continue
      const s = 0.8 + rnd() * 0.7
      fm.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y - 0.03, z), new THREE.Quaternion().setFromAxisAngle(up, rnd() * 6.28), new THREE.Vector3(s, s, s)))
      const hue = rnd() < 0.6 ? CrystalHue.Cyan : rnd() < 0.6 ? CrystalHue.Blue : CrystalHue.Violet
      fc.push(...CRYSTAL_RGB[hue])
      i++
    }
    if (fm.length) {
      const fl = new THREE.InstancedMesh(this.flowerGeo, this.flowerMat, fm.length)
      fm.forEach((m, i) => fl.setMatrixAt(i, m))
      fl.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(fc), 3)
      fl.name = 'cave.flowers'
      fl.computeBoundingSphere()
      root.add(fl)
    }
    const nMotes = Math.round(110 * this.fxShare), nFlies = Math.max(2, Math.round(5 * this.fxShare))
    for (let i = 0; i < nMotes; i++) {
      const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * 0.8
      const hue = rnd() < 0.7 ? CrystalHue.Cyan : CrystalHue.Violet
      sprite(ch[0] + Math.cos(a) * d * cr[0], plan.floor + rnd() * 1.5, ch[2] + Math.sin(a) * d * cr[2], GlowKind.Mote, 0.09 + rnd() * 0.08, CRYSTAL_RGB[hue], 1.3)
    }
    for (let i = 0; i < nFlies; i++) {
      const a = rnd() * Math.PI * 2, d = rnd() * 0.5
      const hue = [CrystalHue.Cyan, CrystalHue.Violet, CrystalHue.Blue][i % 3]
      sprite(ch[0] + Math.cos(a) * d * cr[0], plan.floor + 1.6 + rnd() * 1.6, ch[2] + Math.sin(a) * d * cr[2], GlowKind.Fly, 0.45, CRYSTAL_RGB[hue], 1.4)
    }
    {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3))
      g.setAttribute('aKind', new THREE.Float32BufferAttribute(gk, 1))
      g.setAttribute('aSeed', new THREE.Float32BufferAttribute(gs, 1))
      g.setAttribute('aSize', new THREE.Float32BufferAttribute(gz, 1))
      g.setAttribute('aColor', new THREE.Float32BufferAttribute(gc, 3))
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(ch[0], plan.floor + 3, ch[2]), 45)
      const pts = new THREE.Points(g, this.glowMat)
      pts.name = 'cave.glow'
      pts.renderOrder = 6
      // Sprite size: metres → pixels at 1 m (drawing-buffer height × the projection's y scale / 2).
      pts.onBeforeRender = (renderer, _s, camera) => {
        renderer.getDrawingBufferSize(_buf)
        this.glowMat.uniforms.uScale.value = _buf.y * 0.5 * camera.projectionMatrix.elements[5]
      }
      root.add(pts)
    }
    if (this.fxShare >= 0.5) {
      // Mist: a chamber-wide additive layer (overdraw) — MEDIUM and up.
      const mist = new THREE.Mesh(new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2), this.mistMat)
      mist.scale.set(cr[0] * 1.05, 1, cr[2] * 1.05)
      mist.position.set(ch[0], plan.floor + 0.55, ch[2])
      mist.name = 'cave.mist'
      mist.renderOrder = 4
      root.add(mist)
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
      if ((m.isMesh || (o as THREE.Points).isPoints) && m.geometry !== this.crystalGeo && m.geometry !== this.flowerGeo) m.geometry.dispose()
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

const _buf = new THREE.Vector2()

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
