import * as THREE from 'three'
import { CELL_SIZE, CHUNK_RES, CHUNK_VERTS, LOD_TERRAIN_STRIDE } from '../constants'
import type { ChunkData } from '../types'

/**
 * Terrain mesh for one chunk at one LOD. Vertex stride 1/2/4 of the LOD0 grid.
 * Skirts (vertical strips hanging from every border) hide T-junction cracks between
 * chunks at different LODs — cheaper and simpler than stitching. See skills/terrain.
 *
 * Quad diagonal must match sampleHeight() AND Rapier's heightfield: split along (10)-(01),
 * triangles (00,01,10) and (10,01,11). Verified by tests/world.test.ts.
 */
export function buildTerrainGeometry(d: ChunkData, lod: number): THREE.BufferGeometry {
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
  }

  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const src = j * s * CHUNK_VERTS + i * s
      copy(j * m + i, src, d.heights[src])
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
  g.setIndex(new THREE.BufferAttribute(idx, 1))
  const size = CHUNK_RES * CELL_SIZE
  g.boundingBox = new THREE.Box3(new THREE.Vector3(0, d.minY - skirtDepth, 0), new THREE.Vector3(size, d.maxY, size))
  g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere())
  g.name = `terrain.${d.cx},${d.cz}.lod${lod}`
  return g
}
