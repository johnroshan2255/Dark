import * as THREE from 'three'
import type { Landmarks } from './Landmarks'
import type { Landmark, MapData } from './MapData'

/**
 * THE MAP and THE COMPASS (2026-10-27, the user: "add those" — OTH's map with its highlighted places): Tab (or the MAP
 * button) opens a painted chart of the valley — hillshade, 40 m contours, the ground's colour fields (meadow green →
 * golden straw, forest, rock, snow, water, mud), the tracks (rock-crawling routes dashed), the bridges, the marsh — with
 * every LANDMARK: its icon and name once discovered, a "?" until then, and the car as an arrow. Click / Z: the whole
 * valley ⇄ zoomed round the car. The COMPASS (always on, top centre): the heading's letters and ticks, the landmarks
 * ahead (within 2.5 km, ±80°) as markers — a "?" for the ones not found yet — and the nearest one's distance.
 * The chart is painted once, the first time it opens (~0.2 s); the compass redraws ten times a second (DOM, no canvas).
 */
const ICON: Record<Landmark['kind'], string> = { tower: '♜', view: '◭', cabin: '⌂', shack: '⌂', sawmill: '▤', mine: '⛏', meteorite: '✶', falls: '≋', meadow: '✿' }

export class MapView {
  private readonly root: HTMLDivElement
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private chart: HTMLCanvasElement | null = null
  private open = false
  private zoom = false
  private readonly compass: HTMLDivElement
  private readonly strip: HTMLDivElement
  private readonly marks = new Map<number, HTMLDivElement>()
  private readonly ticks: HTMLDivElement[] = []
  private readonly near: HTMLDivElement
  private compassT = 0
  private readonly dir = new THREE.Vector3()

  constructor(private readonly map: MapData, private readonly lm: Landmarks, private readonly camera: THREE.Camera, private readonly carPos: () => THREE.Vector3, private readonly carHeading: () => number) {
    this.root = document.createElement('div')
    this.root.className = 'oth-map'
    this.canvas = document.createElement('canvas')
    this.ctx = this.canvas.getContext('2d')!
    const title = document.createElement('div')
    title.className = 'oth-map-title'
    this.root.append(title, this.canvas)
    this.canvas.addEventListener('pointerdown', () => { this.zoom = !this.zoom; this.draw() })
    document.body.appendChild(this.root)
    const btn = document.createElement('button')
    btn.className = 'oth-mapbtn'
    btn.textContent = 'MAP'
    btn.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.toggle() })
    document.body.appendChild(btn)
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Tab') { e.preventDefault(); this.toggle() }
      if (e.code === 'KeyZ' && this.open) { this.zoom = !this.zoom; this.draw() }
      if (e.code === 'Escape' && this.open) this.toggle()
    })
    // the compass: a strip of ticks / letters every 15° and a marker per landmark, laid out by bearing each update
    this.compass = document.createElement('div')
    this.compass.className = 'oth-compass'
    this.strip = document.createElement('div')
    this.strip.className = 'oth-compass-strip'
    this.compass.appendChild(this.strip)
    const LET: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }
    for (let a = 0; a < 360; a += 15) {
      const t = document.createElement('div')
      t.className = LET[a] ? 'oth-tick oth-tick-l' : 'oth-tick'
      t.textContent = LET[a] ?? '·'
      t.dataset.a = String(a)
      this.strip.appendChild(t)
      this.ticks.push(t)
    }
    for (const l of lm.list) {
      const m = document.createElement('div')
      m.className = 'oth-mark'
      this.strip.appendChild(m)
      this.marks.set(l.id, m)
    }
    this.near = document.createElement('div')
    this.near.className = 'oth-compass-near'
    this.compass.appendChild(this.near)
    document.body.appendChild(this.compass)
  }

  toggle(): void {
    this.open = !this.open
    this.root.classList.toggle('on', this.open)
    if (this.open) this.draw()
  }

  /** Per frame: the compass (10 Hz), the open map's car arrow (5 Hz). */
  update(dt: number): void {
    if ((this.compassT -= dt) > 0) return
    this.compassT = 0.1
    this.camera.getWorldDirection(this.dir)
    const head = (Math.atan2(this.dir.x, -this.dir.z) * 180) / Math.PI // (0 = north = −z, 90 = east = +x)
    const W = 420, span = 160 // (the strip shows ±80°)
    const at = (bearing: number) => { let d = bearing - head; d = ((d + 540) % 360) - 180; return Math.abs(d) <= span / 2 ? W / 2 + (d / span) * W : null }
    for (const t of this.ticks) {
      const x = at(Number(t.dataset.a))
      t.style.display = x === null ? 'none' : ''
      if (x !== null) t.style.transform = `translateX(${x.toFixed(1)}px)`
    }
    const p = this.carPos()
    let best: { l: Landmark; d: number } | null = null
    for (const l of this.lm.list) {
      const m = this.marks.get(l.id)!, dx = l.x - p.x, dz = l.z - p.z, d = Math.hypot(dx, dz)
      const x = d < 2500 ? at((Math.atan2(dx, -dz) * 180) / Math.PI) : null
      m.style.display = x === null ? 'none' : ''
      if (x === null) continue
      const found = this.lm.found.has(l.id)
      m.textContent = found ? ICON[l.kind] : '?'
      m.classList.toggle('found', found)
      m.style.transform = `translateX(${x.toFixed(1)}px)`
      if (!best || d < best.d) best = { l, d }
    }
    this.near.textContent = best ? `${this.lm.found.has(best.l.id) ? best.l.name : '? Unexplored'} · ${best.d < 1000 ? `${Math.round(best.d / 10) * 10} m` : `${(best.d / 1000).toFixed(1)} km`}` : ''
    if (this.open) this.draw()
  }

  // ------------------------------------------------------------------------------------------------- the chart
  private paintChart(): HTMLCanvasElement {
    const S = 640, c = document.createElement('canvas')
    c.width = c.height = S
    const g = c.getContext('2d')!, img = g.createImageData(S, S), map = this.map, half = map.half, mk: [number, number, number, number] = [0, 0, 0, 0]
    const cell = (2 * half) / S
    const H = new Float32Array(S * S)
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) H[j * S + i] = map.height(-half + (i + 0.5) * cell, -half + (j + 0.5) * cell)
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const x = -half + (i + 0.5) * cell, z = -half + (j + 0.5) * cell, h = H[j * S + i]
      const m = map.maskAt(x, z, mk), mud = map.mudAt(x, z)
      // the colour fields
      const dry = m[1]
      let r = 0.44 + (0.83 - 0.44) * dry, gg = 0.58 + (0.72 - 0.58) * dry, b = 0.33 + (0.45 - 0.33) * dry
      const f = m[3]; r += (0.24 - r) * f; gg += (0.4 - gg) * f; b += (0.25 - b) * f
      const rk = Math.min(1, m[0] * 1.3); r += (0.6 - r) * rk; gg += (0.59 - gg) * rk; b += (0.57 - b) * rk
      const sn = Math.max(0, Math.min(1, (h - 470) / 80)); r += (0.94 - r) * sn; gg += (0.95 - gg) * sn; b += (0.97 - b) * sn
      r += (0.42 - r) * mud; gg += (0.31 - gg) * mud; b += (0.2 - b) * mud
      if (m[2] > 0.9) { r = 0.47; gg = 0.67; b = 0.79 }
      // hillshade (light from the north-west) and 40 m contours
      const hx = H[j * S + Math.min(S - 1, i + 1)] - H[j * S + Math.max(0, i - 1)], hz = H[Math.min(S - 1, j + 1) * S + i] - H[Math.max(0, j - 1) * S + i]
      const sh = Math.max(0.55, Math.min(1.25, 1 + (-hx - hz) * 0.06))
      let k = sh
      if (m[2] <= 0.9 && Math.floor(h / 40) !== Math.floor(H[j * S + Math.min(S - 1, i + 1)] / 40)) k *= 0.9
      if (m[2] <= 0.9 && Math.floor(h / 40) !== Math.floor(H[Math.min(S - 1, j + 1) * S + i] / 40)) k *= 0.9
      // a warm paper tint over all
      const o = (j * S + i) * 4
      img.data[o] = Math.min(255, (r * k * 0.86 + 0.95 * 0.14) * 255)
      img.data[o + 1] = Math.min(255, (gg * k * 0.86 + 0.9 * 0.14) * 255)
      img.data[o + 2] = Math.min(255, (b * k * 0.86 + 0.78 * 0.14) * 255)
      img.data[o + 3] = 255
    }
    g.putImageData(img, 0, 0)
    // the tracks, the rock-crawling routes dashed; the bridges
    const P = (x: number, z: number): [number, number] => [((x + half) / (2 * half)) * S, ((z + half) / (2 * half)) * S]
    const rough = new Set(map.meta.trails.rough ?? [])
    map.meta.trails.lines.forEach((L, i) => {
      g.beginPath()
      L.forEach(([x, z], k) => { const [px, py] = P(x, z); if (k) g.lineTo(px, py); else g.moveTo(px, py) })
      g.setLineDash(rough.has(i) ? [4, 3] : [])
      g.strokeStyle = 'rgba(250, 236, 205, 0.9)'
      g.lineWidth = 3.2
      g.stroke()
      g.strokeStyle = rough.has(i) ? 'rgba(110, 70, 40, 0.95)' : 'rgba(135, 88, 50, 0.95)'
      g.lineWidth = 1.6
      g.stroke()
    })
    g.setLineDash([])
    for (const br of map.meta.bridges ?? []) {
      const [ax, ay] = P(br.x0, br.z0), [bx, by] = P(br.x1, br.z1)
      g.strokeStyle = '#3b2616'; g.lineWidth = 3.5
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke()
    }
    const ms = map.meta.mud?.marsh
    if (ms) { const [mx, my] = P(ms.x, ms.z); label(g, 'The Bog', mx, my, '#4a3423', 12, true) }
    return c
  }

  private draw(): void {
    if (!this.chart) this.chart = this.paintChart()
    const S = Math.round(Math.min(innerWidth, innerHeight) * 0.86 * Math.min(devicePixelRatio, 2))
    if (this.canvas.width !== S) { this.canvas.width = this.canvas.height = S; this.canvas.style.width = this.canvas.style.height = `${S / Math.min(devicePixelRatio, 2)}px` }
    const g = this.ctx, half = this.map.half, p = this.carPos()
    // the view: the whole box, or 1.6 km round the car
    const view = this.zoom ? 800 : half, cx = this.zoom ? Math.max(-half + view, Math.min(half - view, p.x)) : 0, cz = this.zoom ? Math.max(-half + view, Math.min(half - view, p.z)) : 0
    const P = (x: number, z: number): [number, number] => [((x - cx + view) / (2 * view)) * S, ((z - cz + view) / (2 * view)) * S]
    const cs = this.chart!.width
    g.imageSmoothingEnabled = true
    g.drawImage(this.chart!, ((cx - view + half) / (2 * half)) * cs, ((cz - view + half) / (2 * half)) * cs, (view / half) * cs, (view / half) * cs, 0, 0, S, S)
    const k = S / 640
    // the landmarks
    for (const l of this.lm.list) {
      const [x, y] = P(l.x, l.z), found = this.lm.found.has(l.id)
      g.fillStyle = found ? 'rgba(255, 246, 228, 0.95)' : 'rgba(60, 42, 30, 0.75)'
      g.beginPath(); g.arc(x, y, 9 * k, 0, Math.PI * 2); g.fill()
      g.strokeStyle = found ? '#8a3a1c' : 'rgba(255, 240, 220, 0.85)'; g.lineWidth = 1.6 * k; g.stroke()
      g.fillStyle = found ? '#5a2a14' : '#fff6ea'
      g.font = `${Math.round(11 * k)}px system-ui`
      g.textAlign = 'center'; g.textBaseline = 'middle'
      g.fillText(found ? ICON[l.kind] : '?', x, y + 0.5 * k)
      if (found) label(g, l.name, x, y + 17 * k, '#3a2414', Math.round(10.5 * k), false)
    }
    // the camp (the spawn) and the car
    const [sx, sy] = P(this.map.meta.spawn.x, this.map.meta.spawn.z)
    label(g, '⛺ Camp', sx, sy, '#3a2414', Math.round(10.5 * k), false)
    const [px, py] = P(p.x, p.z), h = this.carHeading()
    g.save(); g.translate(px, py); g.rotate(-h)
    g.fillStyle = '#e8492b'; g.strokeStyle = '#fff'; g.lineWidth = 2 * k
    g.beginPath(); g.moveTo(0, -11 * k); g.lineTo(7 * k, 8 * k); g.lineTo(0, 4 * k); g.lineTo(-7 * k, 8 * k); g.closePath(); g.fill(); g.stroke()
    g.restore()
    const title = this.root.firstChild as HTMLDivElement
    title.textContent = `${this.map.meta.name}   ·   ${this.lm.found.size} / ${this.lm.list.length} places found   ·   ${this.zoom ? 'click: whole valley' : 'click: zoom in'}   ·   Tab: close`
  }
}

/** A map label with a pale halo (legible on any ground). */
function label(g: CanvasRenderingContext2D, t: string, x: number, y: number, color: string, size: number, italic: boolean): void {
  g.font = `${italic ? 'italic ' : ''}600 ${size}px system-ui`
  g.textAlign = 'center'; g.textBaseline = 'middle'
  g.lineWidth = 3; g.strokeStyle = 'rgba(255, 248, 232, 0.85)'; g.strokeText(t, x, y)
  g.fillStyle = color; g.fillText(t, x, y)
}
