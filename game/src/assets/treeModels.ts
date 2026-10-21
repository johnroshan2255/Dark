import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { ATLAS_CELLS, cellUv, SOLID_UV, SURFACE_UV } from '../rendering/materials/FoliageAtlas'
import { registerTreeSpecies } from '../world/Forest/treeFactory'
import { registerLandmarkTree } from '../world/Landmarks/landmarkGeometry'
import { TreeSpecies } from '../world/types'
import mondstadtUrl from './models/trees/mondstadt.glb?url'
import mapleUrl from './models/trees/maple.glb?url'
import ancientUrl from './models/trees/ancient.glb?url'
import worldTreeUrl from './models/trees/world_tree.glb?url'
import spruceUrl from './models/trees/spruce.glb?url'
import firUrl from './models/trees/fir.glb?url'
import pineUrl from './models/trees/pine.glb?url'
import deadUrl from './models/trees/dead.glb?url'
import slenderUrl from './models/trees/slender.glb?url'
import oakUrl from './models/trees/oak.glb?url'
import curvyUrl from './models/trees/curvy.glb?url'
import goldenUrl from './models/trees/golden.glb?url'

/**
 * GENSHIN-STYLE TREES modelled in Blender (scripts/blender/genshin_trees.py): the common green broadleaf, the autumn
 * maple, the mystic ancient tree and the giant landmark oak — each 3 detail levels (`<tree>_lod0/1/2`), ~60–190 KB.
 *
 * Baked here into the vegetation material's vertex format (the same program, instancing and per-tree LOD /
 * impostors as every other species): parts map by their U range — leaf cards → the atlas's leaf-cluster cell,
 * bark → the painted bark texel, core → the plain solid texel; vertex colours (dark inside → light top) and the
 * Blender SPHERICAL normals (soft volume lighting) are kept; billboard attributes are zero (fixed cards).
 * They replace the code-built spruce, fir, pine, dead tree, broadleaf, maple, ancient tree and giant oak in every art style
 * (the desert cacti and mystic mushroom trees stay code-built).
 */
function bake(scene: THREE.Object3D, name: string): THREE.BufferGeometry[] {
  scene.updateMatrixWorld(true)
  const parts: THREE.BufferGeometry[][] = [[], [], []]
  const leaf = cellUv(ATLAS_CELLS.tuft)
  scene.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    const chain = `${m.name}|${m.parent?.name ?? ''}`
    const lod = Number(/_lod(\d)/.exec(chain)?.[1] ?? -1)
    if (lod < 0 || lod > 2) return
    const g = m.geometry.clone().applyMatrix4(m.matrixWorld)
    const n = g.getAttribute('position').count
    // Colour: RGB (glTF COLOR_0 may be RGBA).
    const src = g.getAttribute('color')
    const col = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) (col[i * 3] = src ? src.getX(i) : 1), (col[i * 3 + 1] = src ? src.getY(i) : 1), (col[i * 3 + 2] = src ? src.getZ(i) : 1)
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    // UV by part — the kind travels in U (leaf 0..1, bark 2, core 4; one primitive per LOD so the exporter keeps
    // every vertex colour): leaf cards span the atlas leaf cell; solids sample their surface texel.
    const uvIn = g.getAttribute('uv')
    const uv = new Float32Array(n * 2)
    for (let i = 0; i < n; i++) {
      const u = uvIn ? uvIn.getX(i) : 0
      if (u < 1.5) {
        uv[i * 2] = leaf[0] + u * (leaf[2] - leaf[0])
        uv[i * 2 + 1] = leaf[1] + uvIn.getY(i) * (leaf[3] - leaf[1])
      } else {
        const t = u < 3 ? SURFACE_UV.bark : SOLID_UV
        uv[i * 2] = t[0]
        uv[i * 2 + 1] = t[1]
      }
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    // CAMERA-FACING LEAF CARDS (Genshin crowns are soft volumes, never flat cards seen edge-on): each card is its
    // own 4 vertices in the export → group the leaf triangles into connected cards; every corner gets the card
    // centre (bbCenter) and its offset in the view plane (bbOff, metres), turned by a per-card angle so the
    // puffs don't all line up. The vegetation shader expands it toward the camera (MaterialLibrary billboardable);
    // the positions stay the authored quad for shadows and bounds.
    const bbC = new Float32Array(n * 3), bbO = new Float32Array(n * 2)
    const pos = g.getAttribute('position'), idx = g.index
    if (idx && uvIn) {
      const parent = new Int32Array(n).map((_, i) => i)
      const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
      for (let t = 0; t < idx.count; t += 3) {
        const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2)
        if (uvIn.getX(a) > 1.5) continue
        parent[find(b)] = find(a)
        parent[find(c)] = find(a)
      }
      const sum = new Map<number, number[]>()
      for (let i = 0; i < n; i++) {
        if (uvIn.getX(i) > 1.5) continue
        const r = find(i), s = sum.get(r) ?? [0, 0, 0, 0]
        s[0] += pos.getX(i); s[1] += pos.getY(i); s[2] += pos.getZ(i); s[3]++
        sum.set(r, s)
      }
      for (let i = 0; i < n; i++) {
        if (uvIn.getX(i) > 1.5) continue
        const s = sum.get(find(i))!
        const cx = s[0] / s[3], cy = s[1] / s[3], cz = s[2] / s[3]
        bbC.set([cx, cy, cz], i * 3)
        const half = Math.hypot(pos.getX(i) - cx, pos.getY(i) - cy, pos.getZ(i) - cz) / Math.SQRT2
        const ang = (Math.sin(cx * 12.9898 + cy * 78.233 + cz * 37.719) * 43758.5453 % 1) * Math.PI * 2
        const ox = (uvIn.getX(i) - 0.5) * 2 * half, oy = (uvIn.getY(i) - 0.5) * 2 * half
        bbO[i * 2] = ox * Math.cos(ang) - oy * Math.sin(ang)
        bbO[i * 2 + 1] = ox * Math.sin(ang) + oy * Math.cos(ang)
      }
    }
    g.setAttribute('bbCenter', new THREE.BufferAttribute(bbC, 3))
    g.setAttribute('bbOff', new THREE.BufferAttribute(bbO, 2))
    for (const a of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color', 'bbCenter', 'bbOff'].includes(a)) g.deleteAttribute(a)
    parts[lod].push(g.index ? g : g)
  })
  return parts.map((p, l) => {
    const merged = mergeVertices(mergeGeometries(p.map((g) => (g.index ? g.toNonIndexed() : g)), false)!, 1e-5)
    p.forEach((g) => g.dispose())
    merged.computeBoundingSphere()
    merged.name = `${name}.lod${l}`
    return merged
  })
}

/** Load the Blender trees and register them (before the world builds its tree library). */
export async function loadTreeModels(onProgress?: (f: number) => void): Promise<void> {
  // ?trees=code keeps the code-built trees (A/B cost and look comparisons).
  if (new URLSearchParams(location.search).get('trees') === 'code') return onProgress?.(1)
  const loader = new GLTFLoader()
  const urls = [mondstadtUrl, mapleUrl, ancientUrl, worldTreeUrl, spruceUrl, firUrl, pineUrl, deadUrl, slenderUrl, oakUrl, curvyUrl, goldenUrl]
  let done = 0
  const [mond, maple, ancient, world, spruce, fir, pine, dead, slender, oak, curvy, golden] = await Promise.all(urls.map((u) => loader.loadAsync(u).then((g) => (onProgress?.(++done / urls.length), g.scene))))
  const lv = (s: THREE.Object3D, n: string) => bake(s, n) as [THREE.BufferGeometry, THREE.BufferGeometry, THREE.BufferGeometry]
  registerTreeSpecies({ id: TreeSpecies.Birch, name: 'birch', levels: lv(mond, 'birch'), trunkRadius: 0.36, trunkHalfHeight: 3, modelled: true })
  registerTreeSpecies({ id: TreeSpecies.Maple, name: 'maple', levels: lv(maple, 'maple'), trunkRadius: 0.32, trunkHalfHeight: 3, modelled: true })
  registerTreeSpecies({ id: TreeSpecies.Ancient, name: 'ancient', levels: lv(ancient, 'ancient'), trunkRadius: 0.62, trunkHalfHeight: 4, modelled: true })
  registerTreeSpecies({ id: TreeSpecies.Spruce, name: 'spruce', levels: lv(spruce, 'spruce'), trunkRadius: 0.28, trunkHalfHeight: 3, modelled: true })
  registerTreeSpecies({ id: TreeSpecies.Fir, name: 'fir', levels: lv(fir, 'fir'), trunkRadius: 0.3, trunkHalfHeight: 3, modelled: true })
  registerTreeSpecies({ id: TreeSpecies.Pine, name: 'pine', levels: lv(pine, 'pine'), trunkRadius: 0.34, trunkHalfHeight: 4, modelled: true })
  registerTreeSpecies({ id: TreeSpecies.Dead, name: 'dead', levels: lv(dead, 'dead'), trunkRadius: 0.24, trunkHalfHeight: 3, modelled: true })
  registerTreeSpecies({ id: TreeSpecies.Slender, name: 'slender', levels: lv(slender, 'slender'), trunkRadius: 0.3, trunkHalfHeight: 3, modelled: true })
  registerTreeSpecies({ id: TreeSpecies.Oak, name: 'oak', levels: lv(oak, 'oak'), trunkRadius: 0.62, trunkHalfHeight: 3, modelled: true })
  registerTreeSpecies({ id: TreeSpecies.Curvy, name: 'curvy', levels: lv(curvy, 'curvy'), trunkRadius: 0.34, trunkHalfHeight: 3, modelled: true })
  registerTreeSpecies({ id: TreeSpecies.Golden, name: 'golden', levels: lv(golden, 'golden'), trunkRadius: 0.32, trunkHalfHeight: 4, modelled: true })
  const w = lv(world, 'landmark.giantTree')
  registerLandmarkTree(w[0], w[1])
  w[2].dispose()
}
