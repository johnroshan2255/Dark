// WHO HOLDS THE MEMORY (needs `npm run dev`): a V8 heap snapshot of the running game, every ArrayBuffer's backing
// store (geometry, textures' pixels, map grids, wasm) grouped by the object + property that owns it
// (`Owner.prop → typed array → buffer`), the biggest first.
//   node scripts/mem-buffers.mjs [query…]
import puppeteer from 'puppeteer-core'

const q = process.argv.slice(2)
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1280,720', '--mute-audio'],
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
})
const page = await browser.newPage()
await page.goto(`http://localhost:${process.env.PORT || 5173}/?${['play=1', 'adaptive=0', 'hour=11', ...q].join('&')}`, { waitUntil: 'load' })
await page.waitForFunction(() => window.__game && window.__game.store.get().worldReady, { timeout: 180_000, polling: 250 })
await new Promise((r) => setTimeout(r, Number(process.env.SETTLE ?? 12000)))
const cdp = await page.createCDPSession()
let json = ''
cdp.on('HeapProfiler.addHeapSnapshotChunk', (e) => (json += e.chunk))
await cdp.send('HeapProfiler.collectGarbage')
await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
await browser.close()
const snap = JSON.parse(json)
const m = snap.snapshot.meta
const NF = m.node_fields.length, EF = m.edge_fields.length
const nTypes = m.node_types[0], eTypes = m.edge_types[0]
const N = snap.nodes, E = snap.edges, S = snap.strings
const nTypeI = m.node_fields.indexOf('type'), nNameI = m.node_fields.indexOf('name'), nSizeI = m.node_fields.indexOf('self_size'), nEdgesI = m.node_fields.indexOf('edge_count')
const eTypeI = m.edge_fields.indexOf('type'), eNameI = m.edge_fields.indexOf('name_or_index'), eToI = m.edge_fields.indexOf('to_node')
const count = N.length / NF
// edges → owners (reverse index)
const firstEdge = new Uint32Array(count + 1)
for (let i = 0, e = 0; i < count; i++) {
  firstEdge[i] = e
  e += N[i * NF + nEdgesI] * EF
}
firstEdge[count] = E.length
const parents = Array.from({ length: count }, () => [])
for (let i = 0; i < count; i++) {
  for (let e = firstEdge[i]; e < firstEdge[i + 1]; e += EF) {
    const to = E[e + eToI] / NF
    const et = eTypes[E[e + eTypeI]]
    if (et === 'weak' || et === 'shortcut') continue
    const name = et === 'element' || et === 'hidden' ? `[${E[e + eNameI]}]` : S[E[e + eNameI]]
    if (parents[to].length < 6) parents[to].push([i, name])
  }
}
const nm = (i) => S[N[i * NF + nNameI]]
const ty = (i) => nTypes[N[i * NF + nTypeI]]
const groups = new Map()
let total = 0
for (let i = 0; i < count; i++) {
  if (ty(i) !== 'native' || !/JSArrayBufferData|ArrayBufferData|backing/i.test(nm(i))) continue
  const size = N[i * NF + nSizeI]
  if (size < 64 * 1024) continue
  total += size
  // backing ← ArrayBuffer ← TypedArray ← owner.prop
  let key = '?'
  const ab = parents[i].find(([p]) => nm(p) === 'ArrayBuffer' || nm(p) === 'SharedArrayBuffer')?.[0]
  if (ab !== undefined) {
    const tas = parents[ab].filter(([p]) => /Array$/.test(nm(p)) && nm(p) !== 'ArrayBuffer')
    const ta = tas[0]?.[0]
    const holder = ta !== undefined ? parents[ta].find(([p, n]) => !/^\[/.test(n) && ty(p) === 'object' && !/Array$/.test(nm(p))) ?? parents[ta][0] : parents[ab].find(([p]) => ty(p) === 'object' && !/Array$/.test(nm(p)))
    key = holder ? `${nm(holder[0])}.${holder[1]}` : `${ta !== undefined ? nm(ta) : 'ArrayBuffer'} (anon)`
    if (holder && /^\[/.test(holder[1])) {
      const up = parents[holder[0]].find(([p, n]) => !/^\[/.test(n) && ty(p) === 'object')
      if (up) key = `${nm(up[0])}.${up[1]}${holder[1]}`
    }
  } else {
    const p = parents[i][0]
    key = p ? `${nm(p[0])}.${p[1]} (native)` : 'unowned'
  }
  const g = groups.get(key) ?? { n: 0, size: 0 }
  g.n++
  g.size += size
  groups.set(key, g)
}
console.log(`buffers ≥ 64 KB: ${(total / 1048576).toFixed(1)} MB`)
for (const [k, g] of [...groups].sort((a, b) => b[1].size - a[1].size).slice(0, 40)) console.log(`${(g.size / 1048576).toFixed(1).padStart(7)} MB  ×${String(g.n).padEnd(5)} ${k}`)
