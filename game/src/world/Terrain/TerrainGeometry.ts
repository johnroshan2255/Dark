import * as THREE from 'three'
import { CELL_SIZE, CHUNK_RES, CHUNK_VERTS, LOD_TERRAIN_STRIDE } from '../constants'
import type { ChunkData } from '../types'
import { RD_ATTR } from './roadSurface'

/**
 * Terrain mesh for one chunk at one LOD. Vertex stride 1/2/4 of the LOD0 grid.
 * Skirts (vertical strips hanging from every border) hide T-junction cracks between
 * chunks at different LODs — cheaper and simpler than stitching. See skills/terrain.
 *
 * Quad diagonal must match sampleHeight() AND Rapier's heightfield: split along (10)-(01),
 * triangles (00,01,10) and (10,01,11). Verified by tests/world.test.ts.
 */
/** @param peaks coarse LODs take the HIGHEST grid point of each vertex's cell (and its colour / normal): a tower map's
 *  25 m tops sampled every 8 m turned into points — Zhangjiajie (map.json `crags: false`). */
export function buildTerrainGeometry(d: ChunkData, lod: number, peaks = false): THREE.BufferGeometry {
  const s = LOD_TERRAIN_STRIDE[lod]
  const m = CHUNK_RES / s + 1 // verts per edge at this LOD
  const skirtDepth = 1 + s * 1.5
  const borderCount = 4 * (m - 1)
  const vCount = m * m + borderCount
  const pos = new Float32Array(vCount * 3)
  const nor = new Float32Array(vCount * 3)
  const col = new Float32Array(vCount * 3)
  const lat = new Float32Array(vCount)
  const net = new Float32Array(vCount * 2)
  const bio = new Float32Array(vCount * 2)
  // Damp / standing-water weight (the road ribbon's `mud`): 0 on the grid — same attribute set as the ribbon, one program.
  const mud = new Float32Array(vCount)
  // LOD0 is drawn with the road ribbon: its grid vertices under the ribbon are sunk (Road/RoadDetail). LOD1/2 keep the
  // plain ground (no ribbon there).
  const hs = lod === 0 ? d.heights0 : d.heights

  const copy = (dst: number, src: number, y: number) => {
    const ix = (src % CHUNK_VERTS)
    const iz = (src / CHUNK_VERTS) | 0
    pos[dst * 3] = ix * CELL_SIZE
    pos[dst * 3 + 1] = y
    pos[dst * 3 + 2] = iz * CELL_SIZE
    for (let k = 0; k < 3; k++) {
      nor[dst * 3 + k] = d.normals[src * 3 + k]
      col[dst * 3 + k] = d.colors[src * 3 + k]
    }
    lat[dst] = d.roadLat[src]
    net[dst * 2] = d.netEdge[src]
    net[dst * 2 + 1] = d.netType[src]
    bio[dst * 2] = d.biome[src * 2]
    bio[dst * 2 + 1] = d.biome[src * 2 + 1]
  }

  const half = s >> 1
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      let src = j * s * CHUNK_VERTS + i * s
      if (peaks && s > 1) {
        // (inside the chunk only: its edge vertices stay exact, so neighbours at another LOD still meet)
        const edge = i === 0 || j === 0 || i === m - 1 || j === m - 1
        for (let dj = edge ? 0 : -half; dj <= (edge ? 0 : half); dj++) {
          for (let di = edge ? 0 : -half; di <= (edge ? 0 : half); di++) {
            const k = (j * s + dj) * CHUNK_VERTS + i * s + di
            if (hs[k] > hs[src]) src = k
          }
        }
        copy(j * m + i, src, hs[src])
        pos[(j * m + i) * 3] = i * s * CELL_SIZE
        pos[(j * m + i) * 3 + 2] = j * s * CELL_SIZE
        continue
      }
      copy(j * m + i, src, hs[src])
    }
  }
  if (peaks && s > 1) {
    // (and its normals from the COARSE surface: a picked point's own 2 m normal disagreed with its neighbours' — the
    // walls read as big flat facets in the cel ramp)
    const L = s * CELL_SIZE
    for (let j = 1; j < m - 1; j++) {
      for (let i = 1; i < m - 1; i++) {
        const k = j * m + i
        const dx = (pos[(k + 1) * 3 + 1] - pos[(k - 1) * 3 + 1]) / (2 * L), dz = (pos[(k + m) * 3 + 1] - pos[(k - m) * 3 + 1]) / (2 * L)
        const inv = 1 / Math.hypot(dx, 1, dz)
        nor[k * 3] = -dx * inv; nor[k * 3 + 1] = inv; nor[k * 3 + 2] = -dz * inv
      }
    }
  }

  const quads = (m - 1) * (m - 1)
  const idx = new Uint16Array(quads * 6 + borderCount * 12)
  let n = 0
  for (let j = 0; j < m - 1; j++) {
    for (let i = 0; i < m - 1; i++) {
      const a = j * m + i
      const b = a + 1
      const c = a + m
      const e = c + 1
      idx[n++] = a; idx[n++] = c; idx[n++] = b
      idx[n++] = b; idx[n++] = c; idx[n++] = e
    }
  }

  // Border loop (clockwise-agnostic: skirts are emitted double-sided).
  const ring: number[] = []
  for (let i = 0; i < m - 1; i++) ring.push(i)
  for (let j = 0; j < m - 1; j++) ring.push(j * m + (m - 1))
  for (let i = m - 1; i > 0; i--) ring.push((m - 1) * m + i)
  for (let j = m - 1; j > 0; j--) ring.push(j * m)
  const base = m * m
  for (let k = 0; k < ring.length; k++) {
    const top = ring[k]
    const dst = base + k
    pos[dst * 3] = pos[top * 3]
    pos[dst * 3 + 1] = pos[top * 3 + 1] - skirtDepth
    pos[dst * 3 + 2] = pos[top * 3 + 2]
    for (let c = 0; c < 3; c++) {
      nor[dst * 3 + c] = nor[top * 3 + c]
      col[dst * 3 + c] = col[top * 3 + c] * 0.6
    }
    lat[dst] = lat[top]
    net[dst * 2] = net[top * 2]
    net[dst * 2 + 1] = net[top * 2 + 1]
    bio[dst * 2] = bio[top * 2]
    bio[dst * 2 + 1] = bio[top * 2 + 1]
  }
  for (let k = 0; k < ring.length; k++) {
    const t0 = ring[k], t1 = ring[(k + 1) % ring.length]
    const b0 = base + k, b1 = base + ((k + 1) % ring.length)
    idx[n++] = t0; idx[n++] = b0; idx[n++] = t1
    idx[n++] = t1; idx[n++] = b0; idx[n++] = b1
    idx[n++] = t0; idx[n++] = t1; idx[n++] = b0
    idx[n++] = t1; idx[n++] = b1; idx[n++] = b0
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  g.setAttribute('roadLat', new THREE.BufferAttribute(lat, 1))
  g.setAttribute('roadNet', new THREE.BufferAttribute(net, 2))
  g.setAttribute('biome', new THREE.BufferAttribute(bio, 2))
  g.setAttribute('mud', new THREE.BufferAttribute(mud, 1))
  g.setIndex(new THREE.BufferAttribute(idx, 1))
  const size = CHUNK_RES * CELL_SIZE
  g.boundingBox = new THREE.Box3(new THREE.Vector3(0, (lod === 0 ? d.minY0 : d.minY) - skirtDepth, 0), new THREE.Vector3(size, d.maxY, size))
  g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere())
  g.name = `terrain.${d.cx},${d.cz}.lod${lod}`
  return g
}

/**
 * The chunk's ROAD RIBBON mesh (gutters, ruts, potholes — Terrain/roadSurface.ts) with the terrain's vertex format
 * (position, normal, colour, roadLat, roadNet, biome, mud), so it draws with the terrain program. null when the
 * chunk has no road. The attributes share one interleaved buffer.
 */
export function buildRoadDetailGeometry(d: ChunkData): THREE.BufferGeometry | null {
  if (!d.rdIdx.length) return null
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(d.rdPos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(d.rdNor, 3))
  g.setAttribute('color', new THREE.BufferAttribute(d.rdCol, 3))
  const ib = new THREE.InterleavedBuffer(d.rdAttr, RD_ATTR)
  g.setAttribute('roadLat', new THREE.InterleavedBufferAttribute(ib, 1, 0))
  g.setAttribute('roadNet', new THREE.InterleavedBufferAttribute(ib, 2, 1))
  g.setAttribute('biome', new THREE.InterleavedBufferAttribute(ib, 2, 3))
  g.setAttribute('mud', new THREE.InterleavedBufferAttribute(ib, 1, 5))
  g.setIndex(new THREE.BufferAttribute(d.rdIdx, 1))
  g.computeBoundingBox()
  g.boundingSphere = g.boundingBox!.getBoundingSphere(new THREE.Sphere())
  g.name = `roadDetail.${d.cx},${d.cz}`
  return g
}
