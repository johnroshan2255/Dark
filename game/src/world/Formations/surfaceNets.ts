/**
 * SURFACE NETS (naive): the zero level of a signed distance field sampled on a regular grid → a smooth, watertight
 * quad mesh (split to triangles). One vertex per cell that the surface crosses (the mean of its edge crossings),
 * one quad per grid edge with a sign change. Simpler and smoother than marching cubes (no tables); caves,
 * arches and overhangs come for free — this is what the heightfield terrain cannot do.
 * Pure arithmetic → deterministic; runs in the chunk workers.
 */
export interface VoxelMesh {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
  /** Baked ambient occlusion per vertex (1 = open, → 0 in crevices / under ledges): free space along the normal. */
  ao: Float32Array
  /** Convex EDGE per vertex (0 = flat or hollow … 1 = a sharp ridge / block corner): the rock is thin under it. */
  edge: Float32Array
}

/**
 * @param sdf signed distance (negative inside) at a local point
 * @param min grid origin (local), @param size cells per axis, @param step cell size (m)
 */
export function surfaceNets(
  sdf: (x: number, y: number, z: number) => number,
  min: [number, number, number],
  size: [number, number, number],
  step: number,
  /** Normal sampling distance (m; default half a cell). Smaller = crisper facets where the field has sharp edges. */
  nEps = step * 0.5,
): VoxelMesh {
  const [nx, ny, nz] = size
  const sx = nx + 1, sy = ny + 1, sz = nz + 1
  // Field at the grid points.
  const field = new Float32Array(sx * sy * sz)
  const at = (i: number, j: number, k: number) => i + sx * (j + sy * k)
  for (let k = 0; k < sz; k++) for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++) {
    field[at(i, j, k)] = sdf(min[0] + i * step, min[1] + j * step, min[2] + k * step)
  }
  // One vertex per crossed cell.
  const cellVert = new Int32Array(nx * ny * nz).fill(-1)
  const cell = (i: number, j: number, k: number) => i + nx * (j + ny * k)
  const pos: number[] = []
  const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]]
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]
  const v = new Float32Array(8)
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let mask = 0
    for (let c = 0; c < 8; c++) {
      v[c] = field[at(i + corner[c][0], j + corner[c][1], k + corner[c][2])]
      if (v[c] < 0) mask |= 1 << c
    }
    if (mask === 0 || mask === 255) continue
    let px = 0, py = 0, pz = 0, n = 0
    for (const [a, b] of edges) {
      const va = v[a], vb = v[b]
      if (va < 0 === vb < 0) continue
      const t = va / (va - vb)
      px += corner[a][0] + (corner[b][0] - corner[a][0]) * t
      py += corner[a][1] + (corner[b][1] - corner[a][1]) * t
      pz += corner[a][2] + (corner[b][2] - corner[a][2]) * t
      n++
    }
    cellVert[cell(i, j, k)] = pos.length / 3
    pos.push(min[0] + (i + px / n) * step, min[1] + (j + py / n) * step, min[2] + (k + pz / n) * step)
  }
  // One quad per sign-changing grid edge, between the 4 cells around it (wound so the normal points outward).
  const idx: number[] = []
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return
    if (flip) idx.push(a, b, c, a, c, d)
    else idx.push(a, c, b, a, d, c)
  }
  for (let k = 1; k < nz; k++) for (let j = 1; j < ny; j++) for (let i = 0; i < nx; i++) {
    const f0 = field[at(i, j, k)], f1 = field[at(i + 1, j, k)]
    if (f0 < 0 === f1 < 0) continue
    quad(cellVert[cell(i, j - 1, k - 1)], cellVert[cell(i, j, k - 1)], cellVert[cell(i, j, k)], cellVert[cell(i, j - 1, k)], f0 < 0)
  }
  for (let k = 1; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 1; i < nx; i++) {
    const f0 = field[at(i, j, k)], f1 = field[at(i, j + 1, k)]
    if (f0 < 0 === f1 < 0) continue
    quad(cellVert[cell(i - 1, j, k - 1)], cellVert[cell(i - 1, j, k)], cellVert[cell(i, j, k)], cellVert[cell(i, j, k - 1)], f0 < 0)
  }
  for (let k = 0; k < nz; k++) for (let j = 1; j < ny; j++) for (let i = 1; i < nx; i++) {
    const f0 = field[at(i, j, k)], f1 = field[at(i, j, k + 1)]
    if (f0 < 0 === f1 < 0) continue
    quad(cellVert[cell(i - 1, j - 1, k)], cellVert[cell(i, j - 1, k)], cellVert[cell(i, j, k)], cellVert[cell(i - 1, j, k)], f0 < 0)
  }
  // Smooth normals from the field's gradient at each vertex (central differences of the SDF itself).
  const positions = new Float32Array(pos)
  const normals = new Float32Array(pos.length)
  const ao = new Float32Array(pos.length / 3)
  const edge = new Float32Array(pos.length / 3)
  const e = nEps
  for (let p = 0; p < positions.length; p += 3) {
    const x = positions[p], y = positions[p + 1], z = positions[p + 2]
    let gx = sdf(x + e, y, z) - sdf(x - e, y, z)
    let gy = sdf(x, y + e, z) - sdf(x, y - e, z)
    let gz = sdf(x, y, z + e) - sdf(x, y, z - e)
    const l = Math.hypot(gx, gy, gz) || 1
    gx /= l; gy /= l; gz /= l
    normals[p] = gx; normals[p + 1] = gy; normals[p + 2] = gz
    // AO: how much of 1.2 m and 3 m along the normal is free (rock closing in → the gap between blocks, a ledge's
    // underside, a cave's corners go dark — the contact shadow that makes stylized rock read as solid).
    const a1 = sdf(x + gx * 1.2, y + gy * 1.2, z + gz * 1.2) / 1.2, a2 = sdf(x + gx * 3, y + gy * 3, z + gz * 3) / 3
    const o = Math.min(1, Math.max(0, (0.5 * a1 + 0.5 * a2 - 0.2) / 0.75))
    ao[p / 3] = o * o * (3 - 2 * o)
    // EDGE: 0.9 m into the rock, how deep is it? Under a flat face 0.9 m; under a ridge or a block's corner less (the
    // other face is near) → the edges of the plates and ledges, where Genshin's painted rock catches the light.
    const b = -sdf(x - gx * 0.9, y - gy * 0.9, z - gz * 0.9) / 0.9
    edge[p / 3] = Math.min(1, Math.max(0, (0.92 - b) * 2.2))
  }
  return { positions, normals, indices: new Uint32Array(idx), ao, edge }
}

/**
 * Drop the mesh's small DISCONNECTED pieces (< `minTris` triangles): surface nets leaves a few crumbs where rough
 * surfaces nearly pinch (rock floating in a cave's air, specks off a pillar). Union-find over the indices; the
 * vertex arrays are kept (unreferenced vertices cost nothing to draw), only the index list shrinks.
 */
export function dropIslands(m: VoxelMesh, minTris: number): VoxelMesh {
  const n = m.positions.length / 3, par = new Int32Array(n)
  for (let i = 0; i < n; i++) par[i] = i
  const find = (a: number): number => { while (par[a] !== a) a = par[a] = par[par[a]]; return a }
  const ix = m.indices
  for (let t = 0; t < ix.length; t += 3) {
    const a = find(ix[t]), b = find(ix[t + 1]), c = find(ix[t + 2])
    par[b] = a
    par[find(c)] = a
  }
  const count = new Map<number, number>()
  for (let t = 0; t < ix.length; t += 3) { const r = find(ix[t]); count.set(r, (count.get(r) ?? 0) + 1) }
  if (count.size < 2) return m
  const keep: number[] = []
  for (let t = 0; t < ix.length; t += 3) if ((count.get(find(ix[t])) ?? 0) >= minTris) keep.push(ix[t], ix[t + 1], ix[t + 2])
  return { ...m, indices: new Uint32Array(keep) }
}
