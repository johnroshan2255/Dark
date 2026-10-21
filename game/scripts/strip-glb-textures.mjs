#!/usr/bin/env node
// Strip every image/texture from a GLB and give each material a flat base colour instead (the game bakes
// materials to vertex colours anyway — skills/asset-optimization). Rebuilds the BIN with only the buffer
// views still referenced. Usage: node scripts/strip-glb-textures.mjs in.glb out.glb '{"materialName":"#rrggbb",...}'
import fs from 'node:fs'
const [inFile, outFile, colorsJson = '{}'] = process.argv.slice(2)
const colors = JSON.parse(colorsJson)
const buf = fs.readFileSync(inFile)
const jsonLen = buf.readUInt32LE(12)
const j = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'))
const binLen = buf.readUInt32LE(20 + jsonLen)
const bin = buf.subarray(28 + jsonLen, 28 + jsonLen + binLen)
const hex = (h) => [1, 3, 5].map((i) => { const c = parseInt(h.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
for (const m of j.materials ?? []) {
  const pbr = (m.pbrMetallicRoughness ??= {})
  const had = !!pbr.baseColorTexture
  delete pbr.baseColorTexture; delete pbr.metallicRoughnessTexture; delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture
  for (const k of Object.keys(m.extensions ?? {})) delete m.extensions[k]
  if (colors[m.name]) pbr.baseColorFactor = [...hex(colors[m.name]), pbr.baseColorFactor?.[3] ?? 1]
  else if (had && !pbr.baseColorFactor) pbr.baseColorFactor = [0.5, 0.5, 0.5, 1]
  if (!Object.keys(m.extensions ?? {}).length) delete m.extensions
}
delete j.images; delete j.textures; delete j.samplers
j.extensionsUsed = (j.extensionsUsed ?? []).filter((e) => !/texture/i.test(e)); if (!j.extensionsUsed.length) delete j.extensionsUsed
j.extensionsRequired = (j.extensionsRequired ?? []).filter((e) => !/texture/i.test(e)); if (!j.extensionsRequired.length) delete j.extensionsRequired
// Keep only buffer views used by accessors (images are gone). Remap indices, rebuild BIN.
const used = new Set((j.accessors ?? []).map((a) => a.bufferView).filter((v) => v != null))
for (const a of j.accessors ?? []) if (a.sparse) { used.add(a.sparse.indices.bufferView); used.add(a.sparse.values.bufferView) }
const remap = new Map(); const views = []; const parts = []; let off = 0
for (const [i, v] of (j.bufferViews ?? []).entries()) {
  if (!used.has(i)) continue
  const data = bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)
  const pad = (4 - (data.length % 4)) % 4
  remap.set(i, views.length); views.push({ ...v, buffer: 0, byteOffset: off }); parts.push(data, Buffer.alloc(pad)); off += data.length + pad
}
j.bufferViews = views
for (const a of j.accessors ?? []) { if (a.bufferView != null) a.bufferView = remap.get(a.bufferView); if (a.sparse) { a.sparse.indices.bufferView = remap.get(a.sparse.indices.bufferView); a.sparse.values.bufferView = remap.get(a.sparse.values.bufferView) } }
const newBin = Buffer.concat(parts); j.buffers = [{ byteLength: newBin.length }]
let js = Buffer.from(JSON.stringify(j), 'utf8'); const jp = (4 - (js.length % 4)) % 4; js = Buffer.concat([js, Buffer.alloc(jp, 0x20)])
const header = Buffer.alloc(12); header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + js.length + 8 + newBin.length, 8)
const jc = Buffer.alloc(8); jc.writeUInt32LE(js.length, 0); jc.write('JSON', 4)
const bc = Buffer.alloc(8); bc.writeUInt32LE(newBin.length, 0); bc.write('BIN\0', 4)
fs.writeFileSync(outFile, Buffer.concat([header, jc, js, bc, newBin]))
console.log(`${inFile} ${(buf.length / 1e6).toFixed(2)} MB → ${outFile} ${((12 + 16 + js.length + newBin.length) / 1e6).toFixed(2)} MB, ${j.materials?.length ?? 0} flat materials`)
