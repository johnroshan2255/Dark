import * as pc from 'playcanvas'
import * as THREE from 'three'
import { linearToSrgbBytes } from './geometry'
import { LayerSet } from './layerSet'
import { applyWorldLook } from './materials/common'

/**
 * THREE → PLAYCANVAS RENDER BRIDGE for the gameplay objects. The game's gameplay systems (the character with its
 * Mixamo clips, IK and procedural poses, the cars with their struts / doors / steering / damage dents, the bike, the
 * monsters, the tow ropes, remote players, debris, particles…) keep their own scene graph as plain data — three's
 * Object3D tree, its bones and its AnimationMixer are math here, nothing of three ever draws — and PlayCanvas renders
 * them:
 *  - every visible Mesh / Points becomes an engine MeshInstance whose node takes the object's world matrix each frame;
 *  - a SkinnedMesh becomes an engine SKINNED mesh (pc.Skin + SkinInstance: the GPU skinning, shadow pass included, is
 *    the engine's); its bones are read from the three skeleton's world matrices each frame;
 *  - an InstancedMesh / InstancedBufferGeometry becomes ONE engine instanced draw: the instance matrices (× the mesh's
 *    world matrix), instanceColor and every per-instance attribute in one instance buffer, re-uploaded when three
 *    marks them changed;
 *  - geometry whose attributes change (dents, ropes, particles) is re-uploaded when its version moves; a non-indexed
 *    draw range (particle budgets) is applied per frame without a re-upload;
 *  - custom vertex attributes get an engine semantic from one registry by NAME (attrSemantic), so a geometry and the
 *    shader reading it always agree;
 *  - materials are translated once per three material: a registered converter (`MaterialBank.register`, by
 *    `material.userData.pcKind` — the car paint, glass…), three ShaderMaterials by the automatic port
 *    (materials/shaderPort), else the generic world look (toon + hemisphere fill + rim + the sky fog, as every world
 *    material) from the three material's colour / map / vertex colours / instance colours / opacity.
 * Cost: per frame a traverse of the mirrored roots (tens of objects) and a matrix decompose per visible mesh; bones
 * are copied (16 floats each). No allocation in the steady state.
 */

export interface PcMat {
  material: pc.Material
  /** Called once per frame while the material is in use (uniforms that follow the three material's). */
  sync?: () => void
  /** custom vertex streams its shader reads: every mesh drawn with it carries them (zeros where the geometry has
   *  none) — one vertex layout per material, so the engine's batching can merge them */
  attrs?: { name: string; size: number }[]
}
export type MatConverter = (m: THREE.Material, bank: MaterialBank, variant: MatVariant) => PcMat
/** What the drawn object needs of a material beyond the three material itself. */
export interface MatVariant {
  /** per-instance colours (three's instanceColor) */
  instColor: boolean
}

// ------------------------------------------------------------------------------------------------ attributes

/**
 * Custom vertex attributes → engine semantics, by NAME (shared by every geometry and every shader). Fixed ones for the
 * converters' own shaders; the rest are given a free slot on first sight. The slots avoid the standard streams'
 * locations (position 0, normal 1, colour 4, uv 5) and the engine's instance matrix (11, 12, 14, 15).
 */
export const MIRROR_ATTRS: Record<string, string> = {
  paintMask: pc.SEMANTIC_ATTR8,
  tyreW: pc.SEMANTIC_ATTR9,
  aCar: pc.SEMANTIC_ATTR10,
  aGlassP: pc.SEMANTIC_ATTR8,
  lampId: pc.SEMANTIC_ATTR8,
  corner: pc.SEMANTIC_ATTR9,
  instanceColor: pc.SEMANTIC_ATTR13,
}
// (ATTR13 is instanceColor's alone)
const POOL = [pc.SEMANTIC_ATTR7, pc.SEMANTIC_ATTR10, pc.SEMANTIC_ATTR9, pc.SEMANTIC_ATTR8, pc.SEMANTIC_ATTR6, pc.SEMANTIC_ATTR3, pc.SEMANTIC_ATTR2]
/** three's built-in streams (uploaded as the engine's own) */
const STANDARD = new Set(['position', 'normal', 'color', 'uv', 'uv1', 'skinIndex', 'skinWeight', 'instanceMatrix'])

/** The semantic of a custom attribute: registered, or the first pool slot not `taken` (registered from then on). */
export function attrSemantic(name: string, taken: Set<string>): string | null {
  const s = MIRROR_ATTRS[name]
  if (s) return taken.has(s) ? null : s
  const free = POOL.find((p) => !taken.has(p))
  if (!free) return null
  MIRROR_ATTRS[name] = free
  return free
}

const warnedAttr = new Set<string>()
function warnAttr(name: string): void {
  if (warnedAttr.has(name)) return
  warnedAttr.add(name)
  console.warn(`[pc] attribute ${name}: no free semantic`)
}

// ------------------------------------------------------------------------------------------------ textures

/** Engine textures of three textures (one each; the image / canvas / data is shared). */
export class TextureBank {
  private readonly map = new WeakMap<THREE.Texture, { tex: pc.Texture; version: number }>()
  constructor(private readonly device: pc.GraphicsDevice) {}

  get(t: THREE.Texture): pc.Texture | null {
    const img = t.image as (TexImageSource & { width: number; height: number }) | { data: ArrayBufferView; width: number; height: number } | undefined
    if (!img || !img.width) return null
    let e = this.map.get(t)
    if (e && e.version === t.version) return e.tex
    const srgb = t.colorSpace === THREE.SRGBColorSpace
    const wrap = (w: number) => (w === THREE.RepeatWrapping ? pc.ADDRESS_REPEAT : w === THREE.MirroredRepeatWrapping ? pc.ADDRESS_MIRRORED_REPEAT : pc.ADDRESS_CLAMP_TO_EDGE)
    if (!e) {
      const tex = new pc.Texture(this.device, {
        name: t.name || 'three-texture',
        width: img.width,
        height: img.height,
        format: srgb ? pc.PIXELFORMAT_SRGBA8 : pc.PIXELFORMAT_RGBA8,
        mipmaps: t.generateMipmaps,
        minFilter: t.generateMipmaps ? pc.FILTER_LINEAR_MIPMAP_LINEAR : pc.FILTER_LINEAR,
        magFilter: t.magFilter === THREE.NearestFilter ? pc.FILTER_NEAREST : pc.FILTER_LINEAR,
        addressU: wrap(t.wrapS),
        addressV: wrap(t.wrapT),
        anisotropy: Math.max(1, t.anisotropy),
        flipY: t.flipY,
      })
      e = { tex, version: -1 }
      this.map.set(t, e)
    }
    if ('data' in img) {
      // DataTexture: bytes as they are, floats 0..1 → bytes (half floats are not converted: shared textures like the
      // noise lattice are bound by the engine scope, never through here)
      const n = img.width * img.height
      const px = e.tex.lock() as Uint8Array
      const d = img.data as ArrayLike<number>
      const k = Math.max(1, Math.round(d.length / n))
      const bytes = d instanceof Uint8Array || d instanceof Uint8ClampedArray
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < 4; c++) {
          const v = c < k ? d[i * k + c] : k === 1 && c < 3 ? d[i] : 255
          px[i * 4 + c] = bytes ? v : Math.round(Math.min(1, Math.max(0, v)) * 255)
        }
      }
      e.tex.unlock()
    } else {
      e.tex.setSource(img as HTMLImageElement)
    }
    e.version = t.version
    return e.tex
  }
}

// ------------------------------------------------------------------------------------------------ materials

/** Engine materials of three materials (cached per material and variant; converters by userData.pcKind). */
export class MaterialBank {
  private readonly cache = new WeakMap<THREE.Material, Map<string, PcMat>>()
  private readonly kinds = new Map<string, MatConverter>()
  /** three ShaderMaterials without a converter (materials/shaderPort: their own GLSL on the engine) */
  shaderFallback: MatConverter | null = null
  private readonly warned = new Set<string>()
  readonly textures: TextureBank
  /** per-frame syncs of the materials drawn this frame */
  readonly live = new Set<PcMat>()

  constructor(readonly device: pc.GraphicsDevice) {
    this.textures = new TextureBank(device)
  }

  register(kind: string, conv: MatConverter): void {
    this.kinds.set(kind, conv)
  }

  get(m: THREE.Material, variant: MatVariant = NO_VARIANT): PcMat {
    let byV = this.cache.get(m)
    if (!byV) this.cache.set(m, (byV = new Map()))
    const key = variant.instColor ? 'ic' : ''
    let e = byV.get(key)
    if (!e) {
      const kind = m.userData.pcKind as string | undefined
      const conv = kind ? this.kinds.get(kind) : undefined
      const shader = (m as THREE.ShaderMaterial).isShaderMaterial && this.shaderFallback
      if (kind && !conv && !shader && !this.warned.has(kind)) {
        this.warned.add(kind)
        console.warn(`[pc] no converter for material kind "${kind}" — generic look`)
      }
      e = conv ? conv(m, this, variant) : shader ? this.shaderFallback!(m, this, variant) : genericMaterial(m, this, variant)
      byV.set(key, e)
    }
    if (e.sync) this.live.add(e)
    return e
  }

  /** Run the syncs of the materials used since the last call. */
  syncAll(): void {
    for (const e of this.live) e.sync!()
    this.live.clear()
  }
}
const NO_VARIANT: MatVariant = { instColor: false }

/** albedo × three's instanceColor (generic lit materials of instanced meshes: debris, crystals) */
const INST_COLOR_DECL_VS = 'attribute vec3 instanceColor;\nvarying vec3 vInstColor;\n'
const INST_COLOR_END_VS = '  vInstColor = instanceColor;\n'
const INST_COLOR_DECL_PS = 'varying vec3 vInstColor;\n'
const INST_COLOR_ALBEDO_PS = /* glsl */ `
uniform vec3 material_diffuse;
void getAlbedo() {
  dAlbedo = material_diffuse.rgb;
  #ifdef STD_DIFFUSE_TEXTURE
    dAlbedo *= {STD_DIFFUSE_TEXTURE_DECODE}(texture2DBias({STD_DIFFUSE_TEXTURE_NAME}, {STD_DIFFUSE_TEXTURE_UV}, {STD_TEXTURE_BIAS})).{STD_DIFFUSE_TEXTURE_CHANNEL};
  #endif
  #ifdef STD_DIFFUSE_VERTEX
    dAlbedo *= saturate(vVertexColor.{STD_DIFFUSE_VERTEX_CHANNEL});
  #endif
  dAlbedo *= vInstColor;
}
`

/** The generic world look from a three material's plain properties. */
export function genericMaterial(src: THREE.Material, bank: MaterialBank, variant: MatVariant = NO_VARIANT, o: { rim?: number; toon?: number } = {}): PcMat {
  const s = src as THREE.MeshStandardMaterial & THREE.MeshBasicMaterial & { emissive?: THREE.Color; emissiveIntensity?: number; emissiveMap?: THREE.Texture | null }
  const m = new pc.StandardMaterial()
  m.name = src.name || src.type
  const basic = (src as THREE.MeshBasicMaterial).isMeshBasicMaterial || (src as THREE.ShaderMaterial).isShaderMaterial
  const col = s.color ?? new THREE.Color(1, 1, 1)
  const map = s.map ? bank.textures.get(s.map) : null
  if (basic) {
    // unlit: the colour as emission
    m.useLighting = false
    m.diffuse = new pc.Color(0, 0, 0)
    m.emissive = srgbColor(col)
    if (map) m.emissiveMap = map
    if (s.vertexColors) m.emissiveVertexColor = true
    m.useFog = true
  } else {
    m.diffuse = srgbColor(col)
    if (map) m.diffuseMap = map
    if (s.vertexColors) m.diffuseVertexColor = true
    if (s.emissive && (s.emissive.r || s.emissive.g || s.emissive.b)) {
      m.emissive = srgbColor(s.emissive)
      m.emissiveIntensity = s.emissiveIntensity ?? 1
      if (s.emissiveMap) m.emissiveMap = bank.textures.get(s.emissiveMap) ?? null
    }
    const ic = variant.instColor
    applyWorldLook(m, { rim: o.rim ?? 0.6, toon: o.toon ?? 1, declVS: ic ? INST_COLOR_DECL_VS : undefined, mainEndVS: ic ? INST_COLOR_END_VS : undefined, declPS: ic ? INST_COLOR_DECL_PS : undefined })
    if (ic) {
      m.getShaderChunks(pc.SHADERLANGUAGE_GLSL).set('diffusePS', INST_COLOR_ALBEDO_PS)
      m.setAttribute('instanceColor', MIRROR_ATTRS.instanceColor)
    }
  }
  ;(m as unknown as { vertexColorGamma: boolean }).vertexColorGamma = true
  applyCommon(m, src)
  // (an ALPHA MAP — three reads its green channel: the blob shadows' soft round falloff; without it they drew as dark
  //  squares)
  const am = s.alphaMap ? bank.textures.get(s.alphaMap) : null
  if (am && (src.transparent || src.alphaTest > 0)) {
    m.opacityMap = am
    m.opacityMapChannel = 'g'
  }
  m.update()
  return { material: m }
}

/** Blend / depth / side / alpha test from the three material. */
export function applyCommon(m: pc.Material, src: THREE.Material): void {
  if (src.transparent || src.opacity < 1) {
    m.blendType = src.blending === THREE.AdditiveBlending ? pc.BLEND_ADDITIVEALPHA : pc.BLEND_NORMAL
    if (m instanceof pc.StandardMaterial) {
      m.opacity = src.opacity
      const s = src as THREE.MeshStandardMaterial
      if (s.map && s.transparent) {
        m.opacityMap = m.diffuseMap ?? m.emissiveMap
        m.opacityMapChannel = 'a'
      }
    }
  } else if (src.blending === THREE.AdditiveBlending) m.blendType = pc.BLEND_ADDITIVE
  // dst × src (the tyre marks darken the ground as it is lit)
  if (src.blending === THREE.CustomBlending && src.blendSrc === THREE.ZeroFactor && src.blendDst === THREE.SrcColorFactor) m.blendType = pc.BLEND_MULTIPLICATIVE
  m.depthWrite = src.depthWrite
  m.depthTest = src.depthTest
  m.cull = src.side === THREE.DoubleSide ? pc.CULLFACE_NONE : src.side === THREE.BackSide ? pc.CULLFACE_FRONT : pc.CULLFACE_BACK
  if (src.alphaTest > 0 && m instanceof pc.StandardMaterial) {
    m.alphaTest = src.alphaTest
    if (!m.opacityMap && (m.diffuseMap || m.emissiveMap)) {
      m.opacityMap = m.diffuseMap ?? m.emissiveMap
      m.opacityMapChannel = 'a'
    }
  }
  if (src.polygonOffset) {
    m.depthBias = src.polygonOffsetUnits
    m.slopeDepthBias = src.polygonOffsetFactor
  }
}

/** A linear three colour as the sRGB colour PlayCanvas's material parameters take. */
export function srgbColor(c: THREE.Color): pc.Color {
  const t = c.clone().convertLinearToSRGB()
  return new pc.Color(t.r, t.g, t.b)
}

// ------------------------------------------------------------------------------------------------ meshes

interface GeoEntry {
  mesh: pc.Mesh
  versions: number[]
  /** the vertex attributes uploaded (fast change check) and their versions */
  attrs: THREE.BufferAttribute[]
  attrVer: Int32Array
  index: THREE.BufferAttribute | null
  indexVer: number
  range: number
  /** a float view of the engine vertex buffer's storage (ranged updates) */
  f32?: Float32Array
}

const isInstAttr = (a: unknown) => (a as THREE.InstancedBufferAttribute).isInstancedBufferAttribute === true

/** Engine mesh of a three geometry, re-uploaded when its attributes change (dents, ropes, particles). */
class GeometryBank {
  private readonly map = new WeakMap<THREE.BufferGeometry, GeoEntry>()
  /** uploads per engine mesh (a dynamic batch copies the vertices: a re-upload rebuilds it) */
  private readonly stamps = new WeakMap<pc.Mesh, number>()
  stamp(m: pc.Mesh): number {
    return this.stamps.get(m) ?? 0
  }
  constructor(private readonly device: pc.GraphicsDevice) {}

  get(g: THREE.BufferGeometry, skinned: boolean, points = false, need?: PcMat['attrs']): pc.Mesh | null {
    const pos = g.getAttribute('position')
    if (!pos || pos.count === 0) return null
    let e = this.map.get(g)
    // FAST PATH (every mesh, every frame — no allocation): the same attribute objects at the same versions, the same
    // index and indexed draw range → the uploaded mesh as it is
    if (e && this.unchanged(g, e)) return e.mesh
    // RANGED UPDATE (ring buffers — the tyre marks — mark only what they wrote: three's updateRanges): those floats
    // into the engine vertex buffer and only their bytes uploaded
    if (e && this.tryRanged(g, e)) {
      this.snap(g, e)
      return e.mesh
    }
    const names = Object.keys(g.attributes).filter((n) => !isInstAttr(g.attributes[n]))
    const versions = names.map((n) => (g.attributes[n] as THREE.BufferAttribute).version ?? 0)
    const idx = g.getIndex()
    // (a non-indexed draw range is applied per frame — the particle budgets — without a re-upload)
    versions.push(names.length, idx ? idx.version : 0, pos.count, idx ? idx.count : 0, idx ? (g.drawRange.count === Infinity ? -1 : g.drawRange.count) : -2)
    if (e && e.versions.length === versions.length && e.versions.every((v, i) => v === versions[i])) {
      this.snap(g, e)
      return e.mesh
    }
    const first = !e
    const mesh = e?.mesh ?? new pc.Mesh(this.device)
    const n = pos.count
    mesh.clear(true, false)
    mesh.setPositions(read(pos))
    const nor = g.getAttribute('normal')
    if (nor) mesh.setNormals(read(nor))
    // (plain meshes always carry colour + uv — white / 0 where the geometry has none: one layout for batching)
    const col = g.getAttribute('color')
    if (col && !isInstAttr(col)) mesh.setColors32(linearToSrgbBytes(read(col), n, col.itemSize))
    else if (!points && !skinned) mesh.setColors32(new Uint8ClampedArray(n * 4).fill(255))
    const uv = g.getAttribute('uv')
    if (uv) mesh.setUvs(0, read(uv))
    else if (!points && !skinned) mesh.setUvs(0, new Float32Array(n * 2))
    const uv1 = g.getAttribute('uv1')
    if (uv1) mesh.setUvs(1, read(uv1))
    const taken = new Set<string>([pc.SEMANTIC_ATTR11, pc.SEMANTIC_ATTR12, pc.SEMANTIC_ATTR14, pc.SEMANTIC_ATTR15])
    if (uv1) taken.add(pc.SEMANTIC_ATTR6)
    if (skinned) {
      taken.add(pc.SEMANTIC_ATTR2).add(pc.SEMANTIC_ATTR3)
      const si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight')
      const ids = new Uint8Array(n * 4)
      for (let i = 0; i < n * 4; i++) ids[i] = si.getComponent(Math.floor(i / 4), i % 4)
      mesh.setVertexStream(pc.SEMANTIC_BLENDINDICES, ids, 4, n, pc.TYPE_UINT8)
      mesh.setVertexStream(pc.SEMANTIC_BLENDWEIGHT, read(sw), 4)
    }
    // custom streams: the geometry's own + the material's required ones, in one canonical order (by name)
    const custom = new Map<string, number>()
    for (const name of names) if (!STANDARD.has(name)) custom.set(name, Math.min(4, (g.attributes[name] as THREE.BufferAttribute).itemSize))
    if (need) for (const a of need) if (!custom.has(a.name)) custom.set(a.name, a.size)
    for (const name of [...custom.keys()].sort()) {
      const sem = attrSemantic(name, taken)
      if (!sem) {
        warnAttr(name)
        continue
      }
      taken.add(sem)
      const a = g.attributes[name] as THREE.BufferAttribute | undefined
      const size = custom.get(name)!
      mesh.setVertexStream(sem, a ? read(a) : new Float32Array(n * size), size)
    }
    if (idx) {
      let arr = idx.array as ArrayLike<number>
      const start = g.drawRange.start, cnt = Math.min(idx.count - start, g.drawRange.count)
      if (start > 0 || cnt < idx.count) arr = Array.prototype.slice.call(arr, start, start + cnt)
      mesh.setIndices(n < 65536 ? Uint16Array.from(arr) : Uint32Array.from(arr))
    } else if (!points && n % 3 === 0 && !(g.drawRange.count < n)) {
      // (non-indexed triangles get an index 0…n−1: the engine's batching merges indexed meshes)
      const ix = n < 65536 ? new Uint16Array(n) : new Uint32Array(n)
      for (let i = 0; i < n; i++) ix[i] = i
      mesh.setIndices(ix)
    }
    mesh.update(points ? pc.PRIMITIVE_POINTS : pc.PRIMITIVE_TRIANGLES, true)
    this.stamps.set(mesh, (this.stamps.get(mesh) ?? 0) + 1)
    if (first) {
      e = { mesh, versions, attrs: [], attrVer: new Int32Array(0), index: null, indexVer: -1, range: 0 }
      this.map.set(g, e)
      // held by the bank (a mesh instance's destroy would free a mesh shared by others); released when three disposes
      // the geometry (freed once the last mesh instance using it goes)
      mesh.incRefCount()
      g.addEventListener('dispose', () => {
        this.map.delete(g)
        mesh.decRefCount()
        if (mesh.refCount < 1) mesh.destroy()
      })
    } else e!.versions = versions
    this.snap(g, e!)
    return mesh
  }

  private tryRanged(g: THREE.BufferGeometry, e: GeoEntry): boolean {
    const vb = e.mesh.vertexBuffer
    const idx = g.index
    if (!vb || idx !== e.index || (idx && (idx.version !== e.indexVer || g.drawRange.count !== e.range))) return false
    const changed: [THREE.BufferAttribute, string][] = []
    let k = 0
    for (const n in g.attributes) {
      const a = g.attributes[n] as THREE.BufferAttribute
      if (isInstAttr(a)) continue
      if (e.attrs[k] !== a) return false
      if (a.version !== e.attrVer[k]) {
        // (its ranges if it marked exactly one change since the last upload, else the whole attribute — in place)
        if (!(a.array instanceof Float32Array)) return false
        const sem = n === 'position' ? pc.SEMANTIC_POSITION : n === 'normal' ? pc.SEMANTIC_NORMAL : n === 'uv' ? pc.SEMANTIC_TEXCOORD0 : STANDARD.has(n) ? null : MIRROR_ATTRS[n]
        if (!sem) return false
        changed.push([a, sem])
      }
      k++
    }
    if (k !== e.attrs.length || !changed.length) return false
    const els = changed.map(([a, sem]) => vb.format.elements.find((x) => x.name === sem && x.dataType === pc.TYPE_FLOAT32 && x.numComponents === a.itemSize))
    if (els.some((x) => !x)) return false
    const storage = vb.lock() as ArrayBuffer
    const f32 = (e.f32 && e.f32.buffer === storage) ? e.f32 : (e.f32 = new Float32Array(storage))
    const spans: [number, number][] = []
    changed.forEach(([a, ], i) => {
      const el = els[i]!, src = a.array as Float32Array, sz = a.itemSize
      const whole = a.version !== e.attrVer[e.attrs.indexOf(a)] + 1 || !a.updateRanges.length
      for (const r of whole ? [{ start: 0, count: a.count * sz }] : a.updateRanges) {
        const v0 = Math.floor(r.start / sz), v1 = Math.min(a.count, Math.ceil((r.start + r.count) / sz))
        for (let v = v0; v < v1; v++) {
          const o = (el.offset + v * el.stride) >> 2
          for (let c = 0; c < sz; c++) f32[o + c] = src[v * sz + c]
        }
        spans.push([el.offset + v0 * el.stride, el.offset + v1 * el.stride])
      }
    })
    // (one upload per run of nearby spans, not one per range: a ring buffer marks a range per write)
    spans.sort((a, b) => a[0] - b[0])
    let lo = -1, hi = -1
    for (const [a, b] of spans) {
      if (b <= a) continue
      if (lo >= 0 && a <= hi + 4096) hi = Math.max(hi, b)
      else {
        if (lo >= 0) vb.unlock(lo, hi - lo)
        lo = a
        hi = b
      }
    }
    if (lo >= 0) vb.unlock(lo, hi - lo)
    return true
  }

  /** The uploaded state's identity (the fast path compares against it). */
  private snap(g: THREE.BufferGeometry, e: GeoEntry): void {
    const list: THREE.BufferAttribute[] = []
    for (const n in g.attributes) {
      const a = g.attributes[n] as THREE.BufferAttribute
      if (isInstAttr(a)) continue
      list.push(a)
      // (uploaded: its marked ranges are done — three's renderer clears them after its upload; nothing here did, so
      //  a ring buffer's list grew every frame and each frame walked and re-copied all of it: 48 k floats for 320
      //  vertices after a short drive)
      if (a.updateRanges?.length) a.clearUpdateRanges()
    }
    e.attrs = list
    e.attrVer = Int32Array.from(list, (a) => a.version)
    e.index = g.index
    e.indexVer = g.index ? g.index.version : -1
    e.range = g.index ? g.drawRange.count : 0
  }

  private unchanged(g: THREE.BufferGeometry, e: GeoEntry): boolean {
    const idx = g.index
    if (idx !== e.index || (idx && (idx.version !== e.indexVer || g.drawRange.count !== e.range))) return false
    let k = 0
    for (const n in g.attributes) {
      const a = g.attributes[n] as THREE.BufferAttribute
      if (isInstAttr(a)) continue
      if (e.attrs[k] !== a || e.attrVer[k] !== a.version) return false
      k++
    }
    return k === e.attrs.length
  }
}

function read(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  const n = a.count, k = a.itemSize
  if (!('isInterleavedBufferAttribute' in a) && a.array instanceof Float32Array && a.array.length === n * k && !a.normalized) return a.array
  const out = new Float32Array(n * k)
  for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) out[i * k + c] = a.getComponent(i, c)
  return out
}

/** A bone stand-in: the SkinInstance only ever asks a bone for its world transform. */
class BoneProxy {
  readonly m = new pc.Mat4()
  getWorldTransform(): pc.Mat4 {
    return this.m
  }
}

/** One instance buffer: the matrix (instanced meshes) + per-instance attributes. */
interface InstData {
  vb: pc.VertexBuffer | null
  capacity: number
  versions: number[]
  world: Float32Array
  matrix: boolean
  attrs: { a: THREE.BufferAttribute; size: number }[]
  semantics: string[]
  stride: number
  format: pc.VertexFormat | null
}

interface Entry {
  obj: THREE.Mesh
  node: pc.GraphNode
  mi: pc.MeshInstance
  mesh: pc.Mesh
  mat: PcMat
  src: THREE.Material
  bones?: BoneProxy[]
  inst?: InstData
  box?: pc.BoundingBox
  seen: number
  uid: number
  /** the world matrix the node was last set to (static objects skip the decompose) */
  world?: Float32Array
}

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3()
const _m = new THREE.Matrix4(), _mb = new THREE.Matrix4()
const _sph = new THREE.Sphere()
const _ident = new THREE.Matrix4()
const _mi = new THREE.Matrix4()

/** Sets a GraphNode (a child of the scene root) to a three world matrix: decomposed into position / rotation / scale. */
export function setNodeMatrix(node: pc.GraphNode, m: THREE.Matrix4): void {
  m.decompose(_p, _q, _s)
  node.setLocalPosition(_p.x, _p.y, _p.z)
  node.setLocalRotation(_q.x, _q.y, _q.z, _q.w)
  node.setLocalScale(_s.x, _s.y, _s.z)
}

/**
 * The mirror's nodes take the three world matrix AS IS — written into the engine node's world transform with its dirty
 * flags cleared (they are childless, under an identity holder, and their local transform is never used): exact for
 * any matrix (a rotated part × a non-uniform scale is not a position / rotation / scale — decomposing it sheared the
 * car's dampers into plates) and no decompose per part per frame.
 */
function setNodeWorld(node: pc.GraphNode, m: THREE.Matrix4): void {
  const n = node as unknown as { worldTransform: pc.Mat4; _dirtyLocal: boolean; _dirtyWorld: boolean; _dirtyNormal: boolean; _worldScaleSign: number; _aabbVer: number }
  n.worldTransform.data.set(m.elements)
  n._dirtyLocal = false
  n._dirtyWorld = false
  n._dirtyNormal = true
  n._worldScaleSign = 0
  n._aabbVer++
}
const _zero = new THREE.Matrix4().makeScale(0, 0, 0)
/** A batched root's InstancedMesh with at most this many slots is split into bones of its batch; larger: instanced. */
const MAX_VIRTUAL = 8

const identity = (n: pc.GraphNode) => setNodeWorld(n, _ident)

interface MirrorRoot {
  root: THREE.Object3D
  shadow: boolean
  batch: boolean
  /** the batched parts' identity (rebuild when it changes) */
  key: string
  batches: pc.Batch[]
}

/**
 * Mirrors three roots into the engine's world layer. `add(root)` once; `sync()` every frame after the systems posed
 * their objects (before the engine renders).
 */
export class ThreeMirror {
  private readonly roots: MirrorRoot[] = []
  private readonly entries = new Map<THREE.Object3D, Entry>()
  /** the engine's dynamic batching (BatchManager): a multi-part object's parts of one material → one draw */
  private readonly batcher: pc.BatchManager
  private uid = 0
  private readonly shown: LayerSet
  private readonly geos: GeometryBank
  private readonly holder = new pc.GraphNode('three-mirror')
  private frame = 0
  private readonly list: pc.MeshInstance[] = []
  /** mesh instances shown last sync (stats) */
  count = 0

  constructor(private readonly app: pc.AppBase, readonly mats: MaterialBank) {
    this.shown = new LayerSet(app)
    this.geos = new GeometryBank(app.graphicsDevice)
    app.root.addChild(this.holder)
    this.batcher = new pc.BatchManager(app.graphicsDevice, app.root as pc.Entity, app.scene)
  }

  /**
   * Mirror a three subtree. `shadows`: its meshes may cast (each mesh's own castShadow still decides). `batch`: a
   * multi-part object (a car, the bike, set pieces): its plain meshes are DYNAMICALLY BATCHED per material — the
   * engine's BatchManager merges them into one mesh whose bones are the parts' nodes (each part still moves; hidden
   * parts collapse to zero scale), one draw per material instead of one per part. Rebuilt when its parts change
   * (a part added / removed, a geometry re-uploaded — a dent — or a material / shadow change).
   */
  add(root: THREE.Object3D, shadows = true, batch = false): void {
    if (this.roots.some((r) => r.root === root)) return
    this.roots.push({ root, shadow: shadows, batch, key: '', batches: [] })
  }

  remove(root: THREE.Object3D): void {
    const i = this.roots.findIndex((r) => r.root === root)
    if (i < 0) return
    for (const b of this.roots[i].batches) b.destroy(this.app.scene, [])
    this.roots.splice(i, 1)
  }

  /** A batched root's frame: every plain part (visible or not) into the batch, the rest drawn as they are. */
  private syncBatched(r: MirrorRoot, f: number, list: pc.MeshInstance[]): void {
    const members: Entry[] = []
    const visible = this.visSet
    visible.clear()
    r.root.traverseVisible((o) => visible.add(o))
    r.root.traverse((o) => {
      const mesh = o as THREE.Mesh
      const pts = (o as THREE.Points).isPoints === true
      if ((!mesh.isMesh && !pts) || (o as THREE.Line).isLine || o.layers.mask === 0) return
      const src = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material | undefined
      if (!src) return
      const vis = visible.has(o) && src.visible && !((o as THREE.InstancedMesh).isInstancedMesh && (o as THREE.InstancedMesh).count === 0) // (count 0 = hidden: the folded hull)
      const e = this.entry(mesh, src)
      if (!e) return
      e.seen = f
      e.mi.castShadow = r.shadow && mesh.castShadow && e.mat.material instanceof pc.StandardMaterial // (ported shaders: glass, glows, particles — never casters)
      e.mi.receiveShadow = true
      if (mesh.renderOrder) e.mi.drawOrder = mesh.renderOrder
      const plain = !e.bones && !e.inst && !pts && e.mat.material instanceof pc.StandardMaterial
      // (one shadow flag for a batched object: parts that differ would split its batch, and inside one draw a few
      //  small extra casters cost nothing)
      if (plain) e.mi.castShadow = r.shadow && r.root.userData.castShadow !== false
      // A MULTI-INSTANCE part (brakes, axles, dampers, springs — two to four each): every instance becomes its own
      // bone of the batch (the wheels stay one instanced draw: their tyre shader picks its wheel by instance index)
      // (only SMALL ones: a crowd's InstancedMesh — the remote silhouettes, cars, blob shadows: 160–320 slots — became
      //  a bone per SLOT, used or not, in one never-culled skinned batch: 932 k triangles a frame for a few players.
      //  Those stay one engine instanced draw of the slots in use.)
      const im = o as THREE.InstancedMesh
      if (e.inst && e.inst.matrix && !e.inst.attrs.length && !e.bones && e.mat.material instanceof pc.StandardMaterial && !this.isTyre(mesh.geometry) && im.instanceMatrix.count <= MAX_VIRTUAL) {
        const parts = this.virtualParts(e, im)
        const cast = r.shadow && r.root.userData.castShadow !== false
        const src = im.instanceMatrix.array as Float32Array
        for (let i = 0; i < parts.length; i++) {
          const v = parts[i]
          v.mi.castShadow = cast
          if (vis && i < im.count) {
            _mi.fromArray(src, i * 16).premultiply(o.matrixWorld)
            const w = _mi.elements, last = (v.world ??= new Float32Array(16).fill(NaN))
            let moved = false
            for (let k = 0; k < 16; k++) if (last[k] !== w[k]) { moved = true; break }
            if (moved) {
              last.set(w)
              setNodeWorld(v.node, _mi)
            }
          } else {
            setNodeWorld(v.node, _zero)
            v.world?.fill(NaN)
          }
          members.push(v)
        }
        if (e.mat.sync) this.mats.live.add(e.mat)
        return
      }
      if (!plain) {
        if (vis && this.pose(e)) {
          if (e.mat.sync) this.mats.live.add(e.mat)
          list.push(e.mi)
        }
        return
      }
      if (e.mat.sync) this.mats.live.add(e.mat)
      if (vis) this.pose(e)
      else {
        // (hidden this frame: its bone collapses — re-placed when it shows again)
        setNodeWorld(e.node, _zero)
        e.world?.fill(NaN)
      }
      members.push(e)
    })
    // the batches: rebuilt only when the parts / their meshes / materials / shadow flags changed
    let key = ''
    for (const e of members) key += `${e.uid}.${this.geos.stamp(e.mesh)}.${e.mat.material.id}.${e.mi.castShadow ? 1 : 0},`
    if (key !== r.key) {
      r.key = key
      for (const b of r.batches) b.destroy(this.app.scene, [])
      r.batches = []
      if (members.length) {
        for (const group of this.batcher.prepare(members.map((e) => e.mi), true, 1e5, false)) {
          const b = this.batcher.create(group, true)
          if (b?.meshInstance) r.batches.push(b)
        }
      }
    }
    for (const b of r.batches) {
      b.updateBoundingBox()
      list.push(b.meshInstance)
    }
  }
  private readonly visSet = new Set<THREE.Object3D>()

  sync(): void {
    const f = ++this.frame
    const list = this.list
    list.length = 0
    for (const r of this.roots) {
      if (!r.root.visible) continue
      r.root.updateMatrixWorld()
      if (r.batch) {
        this.syncBatched(r, f, list)
        continue
      }
      r.root.traverseVisible((o) => {
        const mesh = o as THREE.Mesh
        const pts = (o as THREE.Points).isPoints === true
        if ((!mesh.isMesh && !pts) || (o as THREE.Line).isLine) return
        if (o.layers.mask === 0) return
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        const src = mats[0]
        if (!src || !src.visible) return
        const e = this.entry(mesh, src)
        if (!e) return
        e.seen = f
        e.mi.castShadow = r.shadow && mesh.castShadow && e.mat.material instanceof pc.StandardMaterial // (ported shaders: glass, glows, particles — never casters)
        e.mi.receiveShadow = true
        if (mesh.renderOrder) e.mi.drawOrder = mesh.renderOrder
        if (!this.pose(e)) return
        if (e.mat.sync) this.mats.live.add(e.mat) // (its uniforms follow the three material's, this frame)
        list.push(e.mi)
      })
    }
    // gone a while (disposed / removed for good): free
    for (const [o, e] of this.entries) {
      if (f - e.seen > 600) {
        this.drop(e)
        this.entries.delete(o)
      }
    }
    this.shown.set(list)
    this.count = list.length
    this.mats.syncAll()
  }

  /** The engine mesh instances drawn for a three subtree this frame (the garage studio shot). */
  instancesOf(root: THREE.Object3D): pc.MeshInstance[] {
    const out: pc.MeshInstance[] = []
    root.traverseVisible((o) => {
      const e = this.entries.get(o)
      if (e && e.seen === this.frame) out.push(e.mi)
    })
    return out
  }

  /** one plain part per instance slot of an instanced part (batched roots) — its own node, sharing the mesh */
  private readonly virt = new Map<Entry, Entry[]>()
  private virtualParts(e: Entry, im: THREE.InstancedMesh): Entry[] {
    const cap = im.instanceMatrix.count
    let list = this.virt.get(e)
    if (list && list.length === cap && list[0]?.mesh === e.mesh && list[0]?.mat === e.mat) return list
    if (list) for (const v of list) (v.mi.destroy(), v.node.destroy())
    list = []
    for (let i = 0; i < cap; i++) {
      const node = new pc.GraphNode(`${im.name || 'part'}#${i}`)
      this.holder.addChild(node)
      const mi = new pc.MeshInstance(e.mesh, e.mat.material, node)
      list.push({ obj: e.obj, node, mi, mesh: e.mesh, mat: e.mat, src: e.src, seen: e.seen, uid: ++this.uid })
    }
    this.virt.set(e, list)
    return list
  }

  /** a tyre (its geometry carries the wheel-deform weight): kept instanced */
  private readonly tyres = new WeakMap<THREE.BufferGeometry, boolean>()
  private isTyre(g: THREE.BufferGeometry): boolean {
    let t = this.tyres.get(g)
    if (t === undefined) {
      const a = g.getAttribute('tyreW')
      t = !!a && Array.prototype.some.call(a.array, (v: number) => v > 0)
      this.tyres.set(g, t)
    }
    return t
  }

  private drop(e: Entry): void {
    const v = this.virt.get(e)
    if (v) {
      for (const x of v) (x.mi.destroy(), x.node.destroy())
      this.virt.delete(e)
    }
    e.mi.destroy()
    e.node.destroy()
    e.inst?.vb?.destroy()
  }

  private entry(obj: THREE.Mesh, src: THREE.Material): Entry | null {
    const sk = (obj as THREE.SkinnedMesh).isSkinnedMesh
    const pts = (obj as unknown as THREE.Points).isPoints === true
    const g = obj.geometry
    const im = obj as THREE.InstancedMesh
    const instColor = !!(im.isInstancedMesh && im.instanceColor)
    let e = this.entries.get(obj)
    const need = (e && e.src === src ? e.mat : this.mats.get(src, { instColor })).attrs
    const mesh = this.geos.get(g, !!sk, pts, need)
    if (!mesh) return null
    if (e && e.mesh === mesh && e.src === src && (!!e.inst?.attrs.some((x) => x.a === im.instanceColor) || !instColor)) return e
    // (the instance layout first: it registers the per-instance attribute names the material's shader binds)
    const instAttrs = Object.entries(g.attributes).filter(([, a]) => isInstAttr(a)) as [string, THREE.BufferAttribute][]
    // (a ONE-instance InstancedMesh — the car paint makes every part one, for its per-wheel shader — is a plain part:
    //  its node takes world × instance 0, so it can join a dynamic batch)
    const single = im.isInstancedMesh === true && im.count === 1 && !im.instanceColor && !instAttrs.length
    const inst = (im.isInstancedMesh && !single) || instAttrs.length ? this.instLayout(obj, instAttrs) : undefined
    const mat = this.mats.get(src, { instColor })
    if (e && e.mesh === mesh && !instColor) {
      e.mi.material = mat.material
      e.mat = mat
      e.src = src
      return e
    }
    // new (or the geometry / instance layout changed)
    if (e) this.drop(e)
    const node = new pc.GraphNode(obj.name || 'mesh')
    this.holder.addChild(node)
    const mi = new pc.MeshInstance(mesh, mat.material, node)
    // (particles: placed by their vertex shader round the camera — never culled by the bind-time box)
    if (pts) mi.cull = false
    e = { obj, node, mi, mesh, mat, src, seen: 0, uid: ++this.uid }
    if (sk) {
      const s = obj as THREE.SkinnedMesh
      const sk3 = s.skeleton
      const ib = sk3.boneInverses.map((inv) => {
        const out = new pc.Mat4()
        _m.multiplyMatrices(inv, s.bindMatrix)
        out.data.set(_m.elements)
        return out
      })
      const skin = new pc.Skin(this.app.graphicsDevice, ib, sk3.bones.map((b) => b.name))
      const si = new pc.SkinInstance(skin)
      e.bones = sk3.bones.map(() => new BoneProxy())
      si.bones = e.bones as unknown as pc.GraphNode[]
      mi.skinInstance = si
    }
    e.inst = inst
    this.entries.set(obj, e)
    return e
  }

  /** The instance buffer layout of an instanced object: matrix (instanced meshes), instanceColor, per-instance attributes. */
  private instLayout(obj: THREE.Mesh, instAttrs: [string, THREE.BufferAttribute][]): InstData {
    const im = obj as THREE.InstancedMesh
    const matrix = im.isInstancedMesh === true
    const elems: { semantic: string; components: number; type: number }[] = []
    const attrs: InstData['attrs'] = []
    const semantics: string[] = []
    const taken = new Set<string>()
    let stride = 0
    if (matrix) {
      for (const s of [pc.SEMANTIC_ATTR11, pc.SEMANTIC_ATTR12, pc.SEMANTIC_ATTR14, pc.SEMANTIC_ATTR15]) {
        elems.push({ semantic: s, components: 4, type: pc.TYPE_FLOAT32 })
        taken.add(s)
      }
      stride = 16
    }
    // (the vertex streams of the mesh hold their own semantics)
    for (const [name, a] of Object.entries(obj.geometry.attributes)) if (!isInstAttr(a) && MIRROR_ATTRS[name]) taken.add(MIRROR_ATTRS[name])
    const list: [string, THREE.BufferAttribute][] = []
    if (matrix && im.instanceColor) list.push(['instanceColor', im.instanceColor])
    list.push(...instAttrs)
    for (const [name, a] of list) {
      if (a.itemSize > 4) continue
      const sem = attrSemantic(name, taken)
      if (!sem) {
        warnAttr(name)
        continue
      }
      taken.add(sem)
      elems.push({ semantic: sem, components: a.itemSize, type: pc.TYPE_FLOAT32 })
      attrs.push({ a, size: a.itemSize })
      semantics.push(sem)
      stride += a.itemSize
    }
    const format = new pc.VertexFormat(this.app.graphicsDevice, elems)
    return { vb: null, capacity: 0, versions: [], world: new Float32Array(16), matrix, attrs, semantics, stride, format }
  }

  /** Places the engine instance for this frame; false = nothing to draw. */
  private pose(e: Entry): boolean {
    const o = e.obj
    const g = o.geometry
    if (!g.index) {
      // non-indexed draw range (particle budgets, growing ropes / marks)
      const n = g.getAttribute('position').count
      const prim = e.mesh.primitive[0]
      prim.base = Math.min(n, g.drawRange.start)
      prim.count = Math.max(0, Math.min(n - prim.base, g.drawRange.count))
    }
    if (e.bones) {
      // skinned: bones in world space (M · Bi · Bw — the engine's skin matrices are bone · inverseBind, with the
      // three bind matrix folded into its inverse binds)
      const s = o as THREE.SkinnedMesh
      _mb.multiplyMatrices(s.matrixWorld, s.bindMatrixInverse)
      const bones = s.skeleton.bones
      for (let i = 0; i < bones.length; i++) {
        _m.multiplyMatrices(_mb, bones[i].matrixWorld)
        e.bones[i].m.data.set(_m.elements)
      }
      identity(e.node)
      // (bounds: round the hips, generous — the poses leave the bind box)
      const hp = bones[0].getWorldPosition(_p)
      const box = (e.box ??= new pc.BoundingBox())
      box.center.set(hp.x, hp.y, hp.z)
      box.halfExtents.set(1.6, 1.6, 1.6)
      e.mi.setCustomAabb(box)
      return true
    }
    if (e.inst) return this.poseInstances(e, e.inst)
    const im = o as THREE.InstancedMesh
    if (im.isInstancedMesh && im.count === 0) return false
    const mw = im.isInstancedMesh ? _mi.fromArray(im.instanceMatrix.array, 0).premultiply(o.matrixWorld) : o.matrixWorld
    const w = mw.elements
    const last = (e.world ??= new Float32Array(16).fill(NaN))
    let moved = false
    for (let k = 0; k < 16; k++) if (last[k] !== w[k]) { moved = true; break }
    if (moved) {
      last.set(w)
      setNodeWorld(e.node, mw)
    }
    return true
  }

  private poseInstances(e: Entry, inst: InstData): boolean {
    const o = e.obj
    const im = o as THREE.InstancedMesh
    const g = o.geometry as THREE.InstancedBufferGeometry
    const n = inst.matrix ? im.count : Math.min(g.instanceCount === Infinity || g.instanceCount === undefined ? Infinity : g.instanceCount, ...inst.attrs.map((x) => x.a.count))
    if (!n || n === Infinity) return false
    if (n > inst.capacity) {
      inst.vb?.destroy()
      inst.capacity = Math.ceil(n * 1.25) + 8
      inst.vb = new pc.VertexBuffer(this.app.graphicsDevice, inst.format!, inst.capacity, { usage: pc.BUFFER_DYNAMIC })
      e.mi.setInstancing(inst.vb)
      inst.versions = []
    }
    // changed? (three's attribute versions, the instance count, the mesh's world matrix)
    const w = o.matrixWorld.elements
    let dirty = inst.versions.length === 0 || inst.versions[0] !== n
    if (inst.matrix) {
      for (let k = 0; k < 16; k++) if (w[k] !== inst.world[k]) dirty = true
      if (inst.versions[1] !== im.instanceMatrix.version) dirty = true
    }
    for (let k = 0; k < inst.attrs.length; k++) if (inst.versions[2 + k] !== inst.attrs[k].a.version) dirty = true
    if (dirty) {
      inst.versions = [n, inst.matrix ? im.instanceMatrix.version : 0, ...inst.attrs.map((x) => x.a.version)]
      inst.world.set(w)
      const f = new Float32Array(inst.vb!.lock() as ArrayBuffer)
      const st = inst.stride
      const src = inst.matrix ? (im.instanceMatrix.array as Float32Array) : null
      // (an identity world — the grass field, debris — copies the matrices as they are: thousands per upload)
      const ident = o.matrixWorld.equals(_ident)
      const arrs = inst.attrs.map((x) => ({ arr: x.a.array as ArrayLike<number>, size: x.size, plain: !(x.a as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute }))
      for (let i = 0; i < n; i++) {
        let at = i * st
        if (src) {
          // the instance matrices are relative to the mesh: × its world matrix (the node stays identity)
          if (ident) f.set(src.subarray(i * 16, i * 16 + 16), at)
          else {
            _m.fromArray(src, i * 16).premultiply(o.matrixWorld)
            f.set(_m.elements, at)
          }
          at += 16
        }
        for (let k = 0; k < arrs.length; k++) {
          const x = arrs[k], sz = x.size
          if (x.plain) for (let c = 0; c < sz; c++) f[at + c] = x.arr[i * sz + c]
          else for (let c = 0; c < sz; c++) f[at + c] = inst.attrs[k].a.getComponent(i, c)
          at += sz
        }
      }
      inst.vb!.unlock()
    }
    e.mi.instancingCount = n
    if (inst.matrix) {
      identity(e.node)
      if (im.boundingSphere === null) im.computeBoundingSphere()
      const bs = im.boundingSphere
      if (bs) {
        _sph.copy(bs).applyMatrix4(o.matrixWorld)
        const box = (e.box ??= new pc.BoundingBox())
        box.center.set(_sph.center.x, _sph.center.y, _sph.center.z)
        box.halfExtents.set(_sph.radius, _sph.radius, _sph.radius)
        e.mi.setCustomAabb(box)
      }
    } else {
      // per-instance data placed by the shader (name tags, stamps…): the mesh's own transform, never culled
      setNodeWorld(e.node, o.matrixWorld)
      e.mi.cull = false
    }
    return true
  }

  dispose(): void {
    for (const e of this.entries.values()) this.drop(e)
    this.entries.clear()
    this.shown.clear()
    this.holder.destroy()
  }
}
