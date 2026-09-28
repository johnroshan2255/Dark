#!/usr/bin/env node
// Dependency-free GLB/GLTF validator. See skills/asset-optimization/SKILL.md.
//
// Usage: node scripts/validate-assets.mjs [dir] [--strict] [--json]
//   dir       default: src/assets/models
//   --strict  exit 1 if any budget violation
//   --json    print machine-readable report

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, extname, relative, dirname, resolve, sep } from 'node:path'

// ---------------------------------------------------------------------------
// Budgets (LOD0). lod1/lod2 files get tris budget × LOD_FACTOR[n].
// Keep in sync with skills/asset-optimization/SKILL.md.
// ---------------------------------------------------------------------------
const BUDGETS = {
  trees:      { tris: 1500,  materials: 2, maxTexture: 1024, maxFileMB: 1.5 },
  rocks:      { tris: 800,   materials: 1, maxTexture: 512,  maxFileMB: 0.75 },
  plants:     { tris: 300,   materials: 1, maxTexture: 256,  maxFileMB: 0.25 },
  props:      { tris: 3000,  materials: 2, maxTexture: 1024, maxFileMB: 2 },
  caves:      { tris: 2000,  materials: 1, maxTexture: 1024, maxFileMB: 2 },
  road:       { tris: 2000,  materials: 1, maxTexture: 1024, maxFileMB: 2 },
  monsters:   { tris: 12000, materials: 2, maxTexture: 2048, maxFileMB: 6 },
  characters: { tris: 15000, materials: 3, maxTexture: 2048, maxFileMB: 8 },
  bmx:        { tris: 8000,  materials: 2, maxTexture: 1024, maxFileMB: 3 },
  default:    { tris: 5000,  materials: 2, maxTexture: 1024, maxFileMB: 3 },
}
const LOD_FACTOR = [1, 0.35, 0.1, 0.05]
const SCALE_WARN = { min: 0.01, max: 100 } // node scale components outside → suspicious export units

// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const strict = args.includes('--strict')
const asJson = args.includes('--json')
const root = resolve(args.find(a => !a.startsWith('--')) ?? 'src/assets/models')

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(glb|gltf)$/i.test(name)) out.push(p)
  }
  return out
}

function parseGlb(buf) {
  const magic = buf.readUInt32LE(0)
  if (magic !== 0x46546c67) throw new Error('not a GLB (bad magic)')
  const version = buf.readUInt32LE(4)
  if (version !== 2) throw new Error(`unsupported GLB version ${version}`)
  let offset = 12
  let json = null
  let bin = null
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32LE(offset)
    const type = buf.readUInt32LE(offset + 4)
    const data = buf.subarray(offset + 8, offset + 8 + len)
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'))
    else if (type === 0x004e4942) bin = data
    offset += 8 + len
  }
  if (!json) throw new Error('GLB has no JSON chunk')
  return { json, bin }
}

function loadAsset(file) {
  const buf = readFileSync(file)
  if (extname(file).toLowerCase() === '.glb') return { ...parseGlb(buf), size: buf.length, baseDir: dirname(file) }
  return { json: JSON.parse(buf.toString('utf8')), bin: null, size: buf.length, baseDir: dirname(file) }
}

/** Returns bytes of a bufferView (GLB bin chunk, data URI, or external .bin next to .gltf). */
function bufferViewBytes(asset, viewIndex) {
  const view = asset.json.bufferViews?.[viewIndex]
  if (!view) return null
  const buffer = asset.json.buffers?.[view.buffer]
  let data = null
  if (!buffer) return null
  if (buffer.uri === undefined) data = asset.bin
  else if (buffer.uri.startsWith('data:')) data = Buffer.from(buffer.uri.split(',')[1], 'base64')
  else {
    const p = join(asset.baseDir, decodeURIComponent(buffer.uri))
    if (existsSync(p)) data = readFileSync(p)
  }
  if (!data) return null
  const start = view.byteOffset ?? 0
  return data.subarray(start, start + view.byteLength)
}

function imageBytes(asset, image) {
  if (image.bufferView !== undefined) return bufferViewBytes(asset, image.bufferView)
  if (image.uri?.startsWith('data:')) return Buffer.from(image.uri.split(',')[1], 'base64')
  if (image.uri) {
    const p = join(asset.baseDir, decodeURIComponent(image.uri))
    if (existsSync(p)) return readFileSync(p)
  }
  return null
}

/** Reads width/height from PNG IHDR, JPEG SOFn, or KTX2 header. */
function imageSize(bytes) {
  if (!bytes || bytes.length < 24) return null
  // PNG
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { format: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue }
      const marker = bytes[i + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      const len = bytes.readUInt16BE(i + 2)
      const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSOF) return { format: 'jpeg', height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) }
      i += 2 + len
    }
    return { format: 'jpeg', width: 0, height: 0 }
  }
  // KTX2: «KTX 20»
  if (bytes[0] === 0xab && bytes[1] === 0x4b && bytes[2] === 0x54 && bytes[3] === 0x58 && bytes[5] === 0x32) {
    return { format: 'ktx2', width: bytes.readUInt32LE(20), height: bytes.readUInt32LE(24) }
  }
  // WebP (RIFF....WEBP VP8X/VP8 /VP8L)
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('ascii', 12, 16)
    if (chunk === 'VP8X') return { format: 'webp', width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) }
    if (chunk === 'VP8L') {
      const b = bytes.readUInt32LE(21)
      return { format: 'webp', width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) }
    }
    if (chunk === 'VP8 ') return { format: 'webp', width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
  }
  return null
}

function categoryOf(file) {
  const parts = relative(root, file).split(sep).map(s => s.toLowerCase())
  for (const p of parts) if (BUDGETS[p]) return p
  return 'default'
}

function lodOf(file) {
  const m = /\.lod(\d)\.(glb|gltf)$/i.exec(file)
  return m ? Number(m[1]) : null
}

const isPOT = n => n > 0 && (n & (n - 1)) === 0

function analyze(file) {
  const asset = loadAsset(file)
  const { json } = asset
  const category = categoryOf(file)
  const lod = lodOf(file)
  const budget = BUDGETS[category]
  const lodFactor = LOD_FACTOR[lod ?? 0] ?? 0.05
  const extensions = new Set([...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])])

  let triangles = 0, primitives = 0, vertices = 0
  const attributeNames = new Set()
  let missingUV = 0, nonTriangle = 0
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      primitives++
      const mode = prim.mode ?? 4
      const pos = json.accessors?.[prim.attributes?.POSITION]
      const idx = prim.indices !== undefined ? json.accessors?.[prim.indices] : null
      const count = idx ? idx.count : pos ? pos.count : 0
      if (pos) vertices += pos.count
      if (mode === 4) triangles += Math.floor(count / 3)
      else if (mode === 5 || mode === 6) triangles += Math.max(0, count - 2)
      else nonTriangle++
      for (const a of Object.keys(prim.attributes ?? {})) attributeNames.add(a)
      if (!prim.attributes?.TEXCOORD_0) missingUV++
    }
  }

  // Mesh instancing via nodes (same mesh referenced multiple times) — count referenced triangles too.
  const scaleAnomalies = []
  for (const [i, node] of (json.nodes ?? []).entries()) {
    const s = node.scale
    if (s && s.some(v => Math.abs(v) < SCALE_WARN.min || Math.abs(v) > SCALE_WARN.max))
      scaleAnomalies.push(`${node.name ?? `node#${i}`} scale=[${s.map(v => +v.toFixed(4)).join(', ')}]`)
    if (node.matrix) {
      const m = node.matrix
      const sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10])
      if ([sx, sy, sz].some(v => v < SCALE_WARN.min || v > SCALE_WARN.max))
        scaleAnomalies.push(`${node.name ?? `node#${i}`} matrix scale=[${[sx, sy, sz].map(v => +v.toFixed(4)).join(', ')}]`)
    }
  }

  const images = (json.images ?? []).map((img, i) => {
    const bytes = imageBytes(asset, img)
    const size = imageSize(bytes)
    return {
      name: img.name ?? img.uri ?? `image#${i}`,
      mimeType: img.mimeType ?? size?.format ?? 'unknown',
      embedded: img.bufferView !== undefined || !!img.uri?.startsWith('data:'),
      bytes: bytes?.length ?? 0,
      width: size?.width ?? null,
      height: size?.height ?? null,
    }
  })

  const issues = []   // budget violations (fail with --strict)
  const warnings = [] // quality hints
  const triBudget = Math.round(budget.tris * lodFactor)
  if (triangles > triBudget) issues.push(`triangles ${triangles} > budget ${triBudget} (${category}${lod !== null ? ` lod${lod}` : ''})`)
  const materials = json.materials?.length ?? 0
  if (materials > budget.materials) issues.push(`materials ${materials} > budget ${budget.materials}`)
  const fileMB = asset.size / (1024 * 1024)
  if (fileMB > budget.maxFileMB) issues.push(`file ${fileMB.toFixed(2)} MB > budget ${budget.maxFileMB} MB`)
  let vramBytes = 0
  for (const img of images) {
    if (img.width && img.height) {
      if (Math.max(img.width, img.height) > budget.maxTexture) issues.push(`texture ${img.name} ${img.width}×${img.height} > max ${budget.maxTexture}`)
      if (!isPOT(img.width) || !isPOT(img.height)) warnings.push(`texture ${img.name} ${img.width}×${img.height} not power-of-two`)
      const bpp = img.mimeType.includes('ktx2') || img.mimeType === 'ktx2' ? 1 : 4
      vramBytes += img.width * img.height * bpp * 1.333
    }
    if (!/ktx2/.test(img.mimeType)) warnings.push(`texture ${img.name} is ${img.mimeType}, not KTX2`)
  }
  if (lod === null) warnings.push('filename has no .lodN suffix (expected <name>.lod0.glb)')
  if (!extensions.has('EXT_meshopt_compression') && triangles > 500) warnings.push('geometry not meshopt-compressed')
  if (extensions.has('KHR_draco_mesh_compression')) warnings.push('uses Draco; prefer EXT_meshopt_compression')
  if (missingUV && images.length) warnings.push(`${missingUV} primitive(s) without TEXCOORD_0 while textures exist`)
  if (nonTriangle) warnings.push(`${nonTriangle} non-triangle primitive(s) (points/lines)`)
  for (const a of attributeNames) if (/^(TEXCOORD_[1-9]|COLOR_[1-9]|TANGENT|JOINTS_[1-9]|WEIGHTS_[1-9])$/.test(a))
    warnings.push(`attribute ${a} present — prune if unused`)
  if (vertices > triangles * 2 && triangles > 100) warnings.push(`vertices ${vertices} > 2× triangles — likely unwelded (run weld)`)
  if (primitives > materials + 2 && primitives > 4) warnings.push(`${primitives} primitives — consider join/flatten to cut draw calls`)
  for (const s of scaleAnomalies) warnings.push(`scale anomaly: ${s}`)

  return {
    file: relative(process.cwd(), file),
    category, lod,
    fileMB: +fileMB.toFixed(3),
    triangles, vertices,
    meshes: json.meshes?.length ?? 0,
    primitives,
    materials,
    textures: json.textures?.length ?? 0,
    images,
    estimatedTextureVRAM_MB: +(vramBytes / (1024 * 1024)).toFixed(2),
    compression: {
      basisu: extensions.has('KHR_texture_basisu'),
      meshopt: extensions.has('EXT_meshopt_compression'),
      draco: extensions.has('KHR_draco_mesh_compression'),
    },
    issues, warnings,
  }
}

const files = walk(root)
const reports = []
let failed = 0
for (const f of files) {
  try { reports.push(analyze(f)) }
  catch (e) { reports.push({ file: relative(process.cwd(), f), error: e.message, issues: [`parse error: ${e.message}`], warnings: [] }) }
}
for (const r of reports) if (r.issues.length) failed++

if (asJson) {
  console.log(JSON.stringify({ root, files: reports.length, failed, reports }, null, 2))
} else {
  console.log(`Asset validation: ${relative(process.cwd(), root) || '.'} — ${files.length} file(s)`)
  if (!files.length) console.log('  (no .glb/.gltf files found)')
  for (const r of reports) {
    console.log(`\n${r.issues.length ? '✗' : '✓'} ${r.file}`)
    if (r.error) { console.log(`    error: ${r.error}`); continue }
    const c = r.compression
    console.log(`    ${r.category}${r.lod !== null ? ` lod${r.lod}` : ''} · ${r.triangles} tris · ${r.vertices} verts · ${r.meshes} meshes/${r.primitives} prims · ${r.materials} mats · ${r.textures} tex · ${r.fileMB} MB`)
    console.log(`    compression: meshopt=${c.meshopt} basisu=${c.basisu} draco=${c.draco} · est. texture VRAM ${r.estimatedTextureVRAM_MB} MB`)
    for (const img of r.images) console.log(`    image ${img.name}: ${img.mimeType} ${img.width ?? '?'}×${img.height ?? '?'}${img.embedded ? ' (embedded)' : ''}`)
    for (const i of r.issues) console.log(`    ✗ ${i}`)
    for (const w of r.warnings) console.log(`    ! ${w}`)
  }
  console.log(`\n${failed} file(s) over budget${strict ? ' (strict)' : ''}`)
}

process.exit(strict && failed > 0 ? 1 : 0)
