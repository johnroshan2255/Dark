import * as THREE from 'three'

/**
 * STYLIZED SPRUCE geometry (unit height, the trunk at the origin, up = +Y) — the Over-the-Hill conifer, new for this
 * world, INDEXED and under 1 000 vertices (the near LOD: 864): a tall cone of stacked TIERS, each a FRILLED SKIRT —
 * dark at its apex (under the tier above), a raised soft shoulder, and an outer FRINGE of fine hanging saw-teeth,
 * light at the tips and tucked-in darker notches between them, the teeth gathered into plumes by a slow wave round
 * the tier (longer and lower at a plume's middle). Up close it reads as OTH's feathered, layered spruce; far away its
 * bands of light fringe over dark gaps carry the same look into the impostors baked from it.
 *
 * Attributes: position, normal (soft: outward + up), color.r = AO (apex 0.16 … tooth tips 1), color.g = 1 foliage /
 * 0 trunk (a snag hides its foliage), color.b = height in the tree (sway). Front faces point up (a back face is an
 * underside, the shader darkens it).
 *
 * LODs: 0 = 12 tiers × 28 teeth — 864 vertices, ~1 020 triangles; 1 = 7 × 12 — 217 vertices, 250 triangles. Beyond
 * them the trees are impostors baked from LOD 0 (Trees.ts).
 */
interface Lod { tiers: number; teeth: number; mid: number; plumes: number; trunkSides: number }
const LODS: Lod[] = [
  { tiers: 12, teeth: 28, mid: 14, plumes: 7, trunkSides: 6 },
  { tiers: 7, teeth: 12, mid: 6, plumes: 6, trunkSides: 0 },
]
/** Crown radius at the bottom as a share of the height (OTH spruce ≈ 3 : 1). */
export const CROWN = 0.2
/** Where the crown starts (share of the height): the bare trunk below. */
const CROWN_BASE = 0.05

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x6d2b79f5) >>> 0) / 4294967296)
}

/** The crown radius at height share y (the cone, a little convex). */
const crownR = (y: number) => CROWN * Math.pow(Math.max(0, (1 - y) / (1 - CROWN_BASE)), 0.88)

export function spruceGeometry(lod: number, seed = 7): THREE.BufferGeometry {
  const L = LODS[Math.min(lod, LODS.length - 1)], rnd = rng(seed + lod * 101)
  const pos: number[] = [], nor: number[] = [], col: number[] = [], rimA: number[] = [], idx: number[] = []
  // rim: 0 at a tier's apex … 0.5 its shoulder … 1 the tooth tips — the shader cuts a NEEDLE FRINGE into the outer edge
  const v = (x: number, y: number, z: number, nx: number, ny: number, nz: number, ao: number, fol: number, rim = 0): number => {
    const l = Math.hypot(nx, ny, nz) || 1
    pos.push(x, y, z); nor.push(nx / l, ny / l, nz / l); col.push(ao, fol, Math.max(0, Math.min(1, y))); rimA.push(rim, 0, 0)
    return pos.length / 3 - 1
  }
  const P = (i: number) => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])
  const _a = new THREE.Vector3(), _b = new THREE.Vector3()
  /** A triangle, its winding chosen so the front face points up. */
  const tri = (a: number, b: number, c: number) => {
    const pa = P(a)
    _a.subVectors(P(b), pa); _b.subVectors(P(c), pa)
    if (_a.cross(_b).y >= 0) idx.push(a, b, c)
    else idx.push(a, c, b)
  }

  // TRUNK: a thin tapered prism, dark grey-brown (its foot shows under the crown)
  if (L.trunkSides) {
    const s = L.trunkSides, r0 = 0.013, r1 = 0.003, base = pos.length / 3
    for (let k = 0; k < s; k++) {
      const a = (k / s) * Math.PI * 2, cx = Math.cos(a), sz = Math.sin(a)
      v(cx * r0, -0.02, sz * r0, cx, 0, sz, 0.5, 0)
      v(cx * r1, 0.95, sz * r1, cx, 0, sz, 0.5, 0)
    }
    for (let k = 0; k < s; k++) {
      const a = base + k * 2, b = base + ((k + 1) % s) * 2
      idx.push(a, b, a + 1, b, b + 1, a + 1)
    }
  }

  // TIERS: frilled skirts — apex (dark, under the next tier) → a raised mid ring → the outer FRINGE of fine saw-teeth
  // (tips hang, light; notches tuck in, darker), the teeth grouped into plumes by a slow wave round the tier
  const T = L.tiers, K = L.teeth, Km = L.mid
  for (let i = 0; i < T; i++) {
    const t0 = i / T, t1 = (i + 1) / T
    const yb = CROWN_BASE + (1 - CROWN_BASE) * Math.pow(t0, 0.95)
    const ytn = CROWN_BASE + (1 - CROWN_BASE) * Math.pow(t1, 0.95)
    const yt = i === T - 1 ? 1.0 : Math.min(1.0, ytn + (ytn - yb) * 0.55) // the apex reaches up under the next tier
    const R = crownR(yb) * (0.95 + 0.1 * rnd()) + 0.014
    const droop = (yt - yb) * 0.3 + R * 0.14
    const shade = 0.74 + 0.26 * Math.pow(t0, 0.7) // lower tiers a little darker
    const phase = rnd() * Math.PI * 2, plumes = L.plumes, pph = rnd() * Math.PI * 2
    const A = v(0, yt, 0, 0, 1, 0, (i === T - 1 ? 0.8 : 0.16) * shade, 1)
    // mid ring: raised, half-way out (the skirt's soft convex shoulder)
    const mid: number[] = []
    for (let k = 0; k < Km; k++) {
      const a = phase + (k / Km) * Math.PI * 2, c = Math.cos(a), z = Math.sin(a)
      mid.push(v(c * R * 0.5, yt + (yb - yt) * 0.62, z * R * 0.5, c * 0.45, 0.9, z * 0.45, 0.55 * shade, 1, 0.5))
    }
    // the fringe: 2K points — tooth tips (long, hanging) and notches (short, higher), plume groups by a wave
    const fringe: number[] = []
    for (let k = 0; k < 2 * K; k++) {
      const a = phase + (k / (2 * K)) * Math.PI * 2 + (rnd() - 0.5) * (0.5 / K)
      const c = Math.cos(a), z = Math.sin(a)
      const wave = 0.5 + 0.5 * Math.cos(plumes * a + pph) // 1 at a plume's middle, 0 between plumes
      const tooth = k % 2 === 0
      const r = R * (tooth ? 0.95 + 0.25 * wave + 0.08 * rnd() : 0.72 + 0.12 * wave)
      const y = yb - (tooth ? droop * (0.75 + 0.45 * wave + 0.2 * rnd()) : droop * 0.25)
      fringe.push(v(c * r, y, z * r, c * 0.85, tooth ? 0.3 : 0.15, z * 0.85, (tooth ? 0.95 + 0.1 * wave : 0.5) * shade, 1, tooth ? 1 : 0.82))
    }
    for (let k = 0; k < Km; k++) tri(A, mid[k], mid[(k + 1) % Km])
    // strip: each mid segment spans 2K / Km fringe points
    const per = (2 * K) / Km
    for (let k = 0; k < Km; k++) {
      const m0 = mid[k], m1 = mid[(k + 1) % Km]
      const f0 = Math.round(k * per), f1 = Math.round((k + 1) * per)
      for (let f = f0; f < f1; f++) tri(m0, fringe[f % (2 * K)], fringe[(f + 1) % (2 * K)])
      tri(m0, fringe[f1 % (2 * K)], m1)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.setAttribute('leaf', new THREE.Float32BufferAttribute(rimA, 3)) // (x = rim; z = 0: no leaf cards)
  g.setIndex(idx)
  return g
}

/**
 * BROADLEAF geometry (unit height) — OTH's aspens and birches (their crowns up close: ss2, tr18, the user's sunset
 * grove): a WHITE trunk that FORKS into 2–3 rising branches with a few side limbs, and a broad oval crown of LEAF
 * CLUMPS, each a bunch of LEAF CARDS — quads showing a cluster of ~110 tiny separate leaves from the leaf texture
 * (leafTexture.ts), cut out round their gaps in the shader — facing every way round the clump (some up, some out,
 * the lower ones hanging), a few bigger, darker cards through the middle so the crown has a core. Many small leaves,
 * the sky between them, a ragged leafy outline — under 1 000 vertices.
 * Attributes as the spruce's + `leaf`: (u, v ∈ −1…1 on a card, 1 + texture tile + tint × 0.9); (0, 0, 0) on the bark.
 * LOD 0 = 13 clumps × 10 cards + 4 core cards (~600 vertices); LOD 1 = 6 clumps × 5 bigger cards (~140). The crown
 * starts at HALF the height; per tree the vertex shader raises its base a little more (up to 0.62) and widens or
 * narrows it (×0.85–1.15) — every tree its own outline.
 */
export function broadleafGeometry(lod: number, seed = 11): THREE.BufferGeometry {
  const rnd = rng(seed + lod * 53)
  const pos: number[] = [], nor: number[] = [], col: number[] = [], leaf: number[] = [], idx: number[] = []
  const vert = (p: THREE.Vector3, n: THREE.Vector3, ao: number, fol: number, lu = 0, lv = 0, lz = 0) => {
    pos.push(p.x, p.y, p.z); nor.push(n.x, n.y, n.z); col.push(ao, fol, Math.max(0, Math.min(1, p.y))); leaf.push(lu, lv, lz)
    return pos.length / 3 - 1
  }
  /** A tapered limb a → b (radii ra, rb), `sides` sided. */
  const limb = (a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number, sides: number) => {
    const axis = new THREE.Vector3().subVectors(b, a).normalize()
    const u = new THREE.Vector3().crossVectors(axis, Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize()
    const w = new THREE.Vector3().crossVectors(axis, u)
    const base = pos.length / 3
    for (let k = 0; k < sides; k++) {
      const t = (k / sides) * Math.PI * 2, d = u.clone().multiplyScalar(Math.cos(t)).addScaledVector(w, Math.sin(t))
      vert(a.clone().addScaledVector(d, ra), d, 0.8, 0)
      vert(b.clone().addScaledVector(d, rb), d, 0.85, 0)
    }
    for (let k = 0; k < sides; k++) {
      const i0 = base + k * 2, i1 = base + ((k + 1) % sides) * 2
      idx.push(i0, i1, i0 + 1, i1, i1 + 1, i0 + 1)
    }
  }
  // TRUNK + FORK + side limbs (they show through the gaps between the leaves)
  const sides = lod === 0 ? 5 : 3
  const forkY = 0.3 + 0.06 * rnd() // (low: the crown fills the top 70 % of the tree, the bare trunk 30 % — the user)
  const top = new THREE.Vector3(0, forkY, 0)
  limb(new THREE.Vector3(0, -0.02, 0), top, 0.02, 0.013, sides)
  const nb = 2 + (rnd() < 0.5 ? 1 : 0)
  for (let b = 0; b < nb; b++) {
    const a = (b / nb) * Math.PI * 2 + rnd() * 0.8, lean = 0.07 + 0.05 * rnd()
    limb(top, new THREE.Vector3(Math.cos(a) * lean, 0.9 + 0.06 * rnd(), Math.sin(a) * lean), 0.011, 0.004, Math.max(3, sides - 1))
  }
  if (lod === 0) for (let b = 0; b < 5; b++) {
    const a = rnd() * Math.PI * 2, y = 0.33 + 0.11 * b + 0.04 * rnd(), l = 0.1 + 0.05 * rnd()
    limb(new THREE.Vector3(0, y, 0), new THREE.Vector3(Math.cos(a) * l, y + 0.07, Math.sin(a) * l), 0.007, 0.003, 3)
  }
  // the CROWN: leaf clumps in a tall oval — one on top, rings below it — from 30 % of the tree's height up (the user:
  // "70 % of the tree is leaves, only 30 % the trunk")
  const centre = new THREE.Vector3(0, 0.64, 0)
  const clumps: { c: THREE.Vector3; r: number; t: number }[] = []
  const rings = lod === 0 ? 4 : 2, perRing = lod === 0 ? 4 : 3, nC = rings * perRing + 1
  for (let cI = 0; cI < nC; cI++) {
    // (4 rings of 4 + one on top on LOD 0, 2 of 3 + 1 on LOD 1 — the crown broad and full, an oval)
    const t = cI === nC - 1 ? 1 : (cI % perRing) / perRing * 0.16 + Math.floor(cI / perRing) * (0.86 / rings) + 0.04
    const y = 0.38 + 0.56 * Math.min(1, t)
    const ring = cI === nC - 1 ? 0.02 : 0.15 * Math.sin(Math.PI * (0.18 + 0.72 * Math.min(1, t)))
    const a = cI * 1.618 * Math.PI + rnd() * 0.6
    const r = (lod === 0 ? 0.088 : 0.12) * (0.85 + 0.3 * rnd())
    clumps.push({ c: new THREE.Vector3(Math.cos(a) * ring, y, Math.sin(a) * ring), r, t: Math.min(1, t) })
  }
  const tmp = new THREE.Vector3(), nrm = new THREE.Vector3(), uu = new THREE.Vector3(), vv = new THREE.Vector3(), out = new THREE.Vector3()
  /** One card: centre c, facing n (rotated by `spin` in its plane), half size h. */
  const card = (c: THREE.Vector3, n: THREE.Vector3, spin: number, h: number, ao: number) => {
    // (never flat: a horizontal card is seen edge-on from the ground — a dark streak against the sky)
    if (Math.abs(n.y) > 0.62) { n.y = Math.sign(n.y) * 0.62; const l = Math.hypot(n.x, n.z) || 1; const k = Math.sqrt(1 - 0.62 * 0.62) / l; n.x *= k; n.z *= k; if (l < 1e-3) n.x = Math.sqrt(1 - 0.62 * 0.62) }
    uu.crossVectors(n, Math.abs(n.y) < 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize()
    vv.crossVectors(n, uu)
    const cu = Math.cos(spin), su = Math.sin(spin)
    const a1 = uu.clone().multiplyScalar(cu).addScaledVector(vv, su), a2 = uu.clone().multiplyScalar(-su).addScaledVector(vv, cu)
    out.subVectors(c, centre).normalize()
    const sn = out.clone().multiplyScalar(0.75).addScaledVector(n, 0.25).normalize() // (lit as the crown's volume)
    const lz = 1 + Math.floor(rnd() * 4) + rnd() * 0.9
    const base = pos.length / 3
    for (const [ua, vb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      tmp.copy(c).addScaledVector(a1, ua * h).addScaledVector(a2, vb * h)
      vert(tmp, sn, ao, 1, ua, vb, lz)
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  const perClump = lod === 0 ? 10 : 5 // (fewer: gaps between the leaves — the user)
  for (const cl of clumps) {
    for (let k = 0; k < perClump; k++) {
      // spread over the clump's sphere (golden spiral), biased outward from the crown; lower ones droop
      const zz = 1 - (2 * (k + 0.5)) / perClump, rr = Math.sqrt(1 - zz * zz), ph = k * 2.39996 + rnd()
      const d = new THREE.Vector3(Math.cos(ph) * rr, zz, Math.sin(ph) * rr)
      out.set(cl.c.x, 0.15, cl.c.z).normalize()
      if (d.dot(out) < -0.2) d.addScaledVector(out, 0.9).normalize()
      const c = cl.c.clone().addScaledVector(d, cl.r * (0.45 + 0.25 * rnd()))
      nrm.copy(d).add(new THREE.Vector3(rnd() - 0.5, rnd() - 0.5 + (d.y < -0.3 ? -0.3 : 0.2), rnd() - 0.5).multiplyScalar(0.8)).normalize()
      out.subVectors(c, centre).normalize()
      const ao = Math.min(1.1, (0.6 + 0.4 * Math.max(0, d.dot(out))) * (0.78 + 0.32 * cl.t) * (0.9 + 0.2 * rnd()))
      card(c, nrm, rnd() * Math.PI * 2, cl.r * (lod === 0 ? 0.95 : 1.1) * (0.85 + 0.3 * rnd()), ao)
    }
  }
  // the core: a few bigger, darker cards crossing the crown's middle (no hollow shell)
  if (lod === 0) for (let k = 0; k < 5; k++) {
    const c = new THREE.Vector3((rnd() - 0.5) * 0.06, 0.45 + 0.4 * (k / 4), (rnd() - 0.5) * 0.06)
    card(c, new THREE.Vector3(rnd() - 0.5, rnd() * 0.6, rnd() - 0.5).normalize(), rnd() * 6.28, 0.085, 0.45) // (inside the crown)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.setAttribute('leaf', new THREE.Float32BufferAttribute(leaf, 3))
  g.setIndex(idx)
  return g
}
