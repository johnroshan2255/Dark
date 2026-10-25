import * as THREE from 'three'
import type { CockpitPart, TruckModel } from '../../assets/loadModels'
import { vehicleDef } from './catalogue'

/**
 * THE COCKPIT you see in first person (parts from scripts/blender/vehicle_cabin.py, loaded by loadModels):
 *
 *  - INSTRUMENTS: the gauge faces (`dial_*`) are UV-mapped onto ONE canvas per car, drawn here like the real dash —
 *    by the catalogue's `dash`: 'twin' round speedometer + tachometer (the E30), 'single' big speedometer and lamp
 *    strip (the kei van), 'screen' the G-Class's wide twin screen — needles, numbers, the gear, warning lamps.
 *    Redrawn only when a shown value changes (≤ 15 Hz) and only while you look at it (first person, in the car);
 *    one 512 × 256 (screen 1024 × 208) upload then.
 *  - CONTROLS: pedals swing on their pivots with the throttle / brake / clutch, the gear lever moves through its
 *    gate (H pattern for the manuals, P R N D for the automatic), the wipers sweep with the rain.
 * Cost: 1 draw for the dials (unlit, it glows like a backlit cluster at night) + 1 per control (≤ 6 small meshes on
 * the car's own program), CPU < 0.02 ms; the canvas draw ≈ 0.2 ms when it does redraw.
 */
/** Car carGlass's per-car wiper uniforms (filled by Cockpit.wipeGlass). */
export interface WipeGlass {
  uWPiv: { value: THREE.Vector3[] }
  uWPark: { value: THREE.Vector3[] }
  uWAxis: { value: THREE.Vector3 }
  uWReach: { value: THREE.Vector4 }
  uWSign: { value: THREE.Vector2 }
  uWFrac: { value: number }
  uWRate: { value: number }
  uWOff: { value: number }
  uWOn: { value: number }
  uWPrev: { value: number }
}

export interface CockpitState {
  kmh: number
  rpm: number
  /** 'P' 'R' 'N' 'D' or a gear number. */
  gear: string
  throttle: number
  brake: number
  /** Clutch pedal 0 (up) … 1 (pressed). */
  clutch: number
  lights: boolean
  /** Wiper speed 0 (parked) … 1 (fast). */
  wipers: number
  /** Draw the dials this frame (first person, in the car). */
  visible: boolean
}

interface Control {
  part: CockpitPart
  pivot: THREE.Object3D
  axis: THREE.Vector3
  angle: number
  /** wipers: +1 / −1 so a positive sweep lifts the blade off its park. */
  sign: number
}

const GEAR_H: Record<string, [number, number]> = {
  // [lateral (+ = left / driver side), fore-aft (+ = back)] of a 5-speed H gate, R top right… as the real boxes
  '1': [0.22, -0.28], '2': [0.22, 0.28], '3': [0, -0.28], '4': [0, 0.28], '5': [-0.22, -0.28], R: [-0.22, 0.28], N: [0, 0],
}
const GEAR_AUTO: Record<string, number> = { P: -0.32, R: -0.16, N: 0, D: 0.16 }

export class Cockpit {
  readonly root = new THREE.Group()
  private readonly canvas: HTMLCanvasElement | null = null
  private readonly ctx: CanvasRenderingContext2D | null = null
  private readonly tex: THREE.CanvasTexture | null = null
  private readonly controls: Control[] = []
  private drawn = ''
  private drawT = 0
  private wiperT = 0
  private wiperRate = 0.5
  /** Seconds since the blades last stopped (parked); 1e3 = never ran. */
  private wiperOff = 1e3
  /** Seconds since this run of the wipers began, and how long the swept band had gone uncleared then. */
  private wiperOn = 0
  private wiperPrev = 1e3
  private readonly style: 'twin' | 'single' | 'screen'

  constructor(truck: TruckModel, material: THREE.Material, private readonly maxKmh: number, private readonly maxRpm: number, private readonly auto: boolean) {
    this.root.name = 'cockpit'
    this.style = vehicleDef(truck.id).dash
    if (truck.dials) {
      const c = document.createElement('canvas')
      c.width = this.style === 'screen' ? 1024 : 512
      c.height = this.style === 'screen' ? 208 : 256
      this.canvas = c
      this.ctx = c.getContext('2d')
      this.tex = new THREE.CanvasTexture(c)
      this.tex.colorSpace = THREE.SRGBColorSpace
      this.tex.flipY = false // (glTF UVs: v already runs top → bottom)
      this.tex.anisotropy = 4
      const mat = new THREE.MeshBasicMaterial({ map: this.tex, color: new THREE.Color(0.86, 0.86, 0.86), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
      mat.name = 'lib/dials'
      const mesh = new THREE.Mesh(truck.dials, mat)
      mesh.name = 'dials'
      this.root.add(mesh)
      this.draw({ kmh: 0, rpm: 0, gear: auto ? 'P' : 'N', throttle: 0, brake: 0, clutch: 0, lights: false, wipers: 0, visible: true })
    }
    for (const part of truck.controls) {
      const pivot = new THREE.Object3D()
      pivot.position.set(...part.pivot)
      // (a 1-instance InstancedMesh, like the body: the truck material's one instanced program — a plain Mesh on it
      //  made three switch programs at every draw between the two kinds)
      const mesh = new THREE.InstancedMesh(part.geo, material, 1)
      mesh.name = part.kind
      mesh.castShadow = false
      pivot.add(mesh)
      this.root.add(pivot)
      const axis = new THREE.Vector3(...part.axis)
      if (!part.kind.startsWith('wiper') && axis.x < 0) axis.negate() // (pedals / lever: +x so + presses / leans back)
      let sign = 1
      if (part.kind.startsWith('wiper')) {
        // the blade's direction from the pivot; the sweep sign that lifts it (+y)
        part.geo.computeBoundingBox()
        const tip = part.geo.boundingBox!.getCenter(new THREE.Vector3())
        sign = tip.clone().applyAxisAngle(axis, 0.5).y > tip.y ? 1 : -1
      }
      this.controls.push({ part, pivot, axis, angle: 0, sign })
    }
  }

  /**
   * The wipers as the GLASS sees them (Car carGlass: the arc each blade clears, the time since it passed): per blade its
   * spindle (car space), axis, parked direction and swept band (inner / outer radius, from its own geometry: the blade
   * is centred on the arm tip, 0.9 of the arm long), the sweep's sign; the shared sweep clock. False: no wipers.
   */
  wipeGlass(u: WipeGlass): boolean {
    const ws = this.controls.filter((c) => c.part.kind.startsWith('wiper'))
    if (ws.length < 2) return false
    ws.slice(0, 2).forEach((c, i) => {
      if (!c.pivot.userData.park) {
        const p = c.part.geo.getAttribute('position'), v = new THREE.Vector3(), best = new THREE.Vector3()
        let r = 0
        for (let k = 0; k < p.count; k++) {
          v.fromBufferAttribute(p, k)
          v.addScaledVector(c.axis, -v.dot(c.axis))
          if (v.length() > r) (r = v.length()), best.copy(v)
        }
        c.pivot.userData.park = best.normalize()
        c.pivot.userData.reach = [r * 0.38, r]
      }
      u.uWPiv.value[i].copy(c.pivot.position)
      u.uWPark.value[i].copy(c.pivot.userData.park)
      u.uWReach.value.setComponent(i * 2, c.pivot.userData.reach[0]).setComponent(i * 2 + 1, c.pivot.userData.reach[1])
      u.uWSign.value.setComponent(i, c.sign)
      if (i === 0) u.uWAxis.value.copy(c.axis)
    })
    u.uWFrac.value = this.wiperT % 1
    u.uWRate.value = this.wiperRate
    u.uWOff.value = this.wiperOff
    u.uWOn.value = this.wiperOn
    u.uWPrev.value = this.wiperPrev
    return true
  }

  update(dt: number, s: CockpitState): void {
    // (one sweep clock for both wipers: they run in step; a sweep in progress finishes when the rain stops)
    const sweeping = s.wipers > 0.02 || this.wiperT % 1 > 0.02
    if (sweeping) {
      this.wiperRate = (0.45 + 0.55 * Math.max(s.wipers, 0.35)) * 0.5
      // (a new run: the band was last cleared when the blades parked, half a sweep before they stopped)
      if (this.wiperOff > 0) (this.wiperPrev = Math.min(1e3, this.wiperOff + 0.5 / this.wiperRate)), (this.wiperOn = 0)
      this.wiperT += dt * this.wiperRate
      this.wiperOn += dt
      this.wiperOff = 0
    } else this.wiperOff = Math.min(1e3, this.wiperOff + dt)
    const sweep = sweeping ? Math.sin((this.wiperT % 1) * Math.PI) * 1.75 : 0
    for (const c of this.controls) {
      const k = c.part.kind
      let target = 0
      if (k === 'pedal_gas') target = Math.max(0, s.throttle) * 0.32
      else if (k === 'pedal_brake') target = s.brake * 0.28
      else if (k === 'pedal_clutch') target = s.clutch * 0.34
      if (k === 'gear_lever') {
        if (this.auto) {
          c.angle += ((GEAR_AUTO[s.gear] ?? GEAR_AUTO.D) - c.angle) * Math.min(1, dt * 12)
          c.pivot.quaternion.setFromAxisAngle(c.axis, c.angle)
        } else {
          const [lat, fa] = GEAR_H[s.gear] ?? GEAR_H.N
          // (two angles: across the gate about the forward axis, along it about the lever's own axis)
          c.angle += (fa - c.angle) * Math.min(1, dt * 14)
          const latNow = (c.pivot.userData.lat ?? 0) + (lat - (c.pivot.userData.lat ?? 0)) * Math.min(1, dt * 14)
          c.pivot.userData.lat = latNow
          _qa.setFromAxisAngle(c.axis, c.angle)
          _qb.setFromAxisAngle(_fwd, latNow)
          c.pivot.quaternion.multiplyQuaternions(_qb, _qa)
        }
        continue
      }
      if (k.startsWith('wiper')) {
        c.angle = sweep * c.sign
        c.pivot.quaternion.setFromAxisAngle(c.axis, c.angle)
        continue
      }
      c.angle += (target - c.angle) * Math.min(1, dt * 18)
      c.pivot.quaternion.setFromAxisAngle(c.axis, c.angle)
    }
    if (this.ctx && s.visible) {
      this.drawT -= dt
      const key = `${Math.round(s.kmh)}|${Math.round(s.rpm / 50)}|${s.gear}|${s.lights}`
      if (key !== this.drawn && this.drawT <= 0) {
        this.drawT = 1 / 15
        this.draw(s)
        this.drawn = key
      }
    }
  }

  // ------------------------------------------------------------------ drawing

  private draw(s: CockpitState): void {
    const g = this.ctx!, c = this.canvas!
    g.clearRect(0, 0, c.width, c.height)
    if (this.style === 'screen') this.drawScreen(g, c, s)
    else {
      this.dial(g, 128, 128, 120, s.kmh, this.maxKmh, this.maxKmh > 120 ? 20 : 10, 'km/h', this.style === 'single')
      if (this.style === 'single') this.lampStrip(g, s)
      else this.dial(g, 384, 128, 120, s.rpm / 1000, this.maxRpm / 1000, 1, '×1000 r/min', false, this.maxRpm / 1000 - 1.5, s.gear)
    }
    this.tex!.needsUpdate = true
  }

  /** A round analogue gauge: black face, white ticks and numbers, an orange needle (the period's look). */
  private dial(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, value: number, max: number, step: number, unit: string, cream: boolean, red?: number, gear?: string): void {
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25
    const ang = (v: number) => a0 + (a1 - a0) * Math.max(0, Math.min(1, v / max))
    g.save()
    g.fillStyle = cream ? '#d9d2bd' : '#0c0d0f'
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill()
    g.lineWidth = 6; g.strokeStyle = cream ? '#2a2a2a' : '#3a3c40'; g.stroke()
    const ink = cream ? '#15171a' : '#f2f2ee'
    if (red !== undefined) {
      g.strokeStyle = '#d23a2a'; g.lineWidth = 9
      g.beginPath(); g.arc(cx, cy, r - 12, ang(red), ang(max)); g.stroke()
    }
    for (let v = 0; v <= max + 1e-6; v += step / 2) {
      const a = ang(v), major = Math.abs(v / step - Math.round(v / step)) < 1e-6
      g.strokeStyle = ink; g.lineWidth = major ? 4 : 2
      g.beginPath()
      g.moveTo(cx + Math.cos(a) * (r - 8), cy + Math.sin(a) * (r - 8))
      g.lineTo(cx + Math.cos(a) * (r - (major ? 24 : 16)), cy + Math.sin(a) * (r - (major ? 24 : 16)))
      g.stroke()
      if (major) {
        g.fillStyle = ink; g.font = 'bold 22px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'
        g.fillText(String(Math.round(v)), cx + Math.cos(a) * (r - 44), cy + Math.sin(a) * (r - 44))
      }
    }
    g.fillStyle = ink; g.font = '15px system-ui, sans-serif'; g.textAlign = 'center'
    g.fillText(unit, cx, cy + r * 0.42)
    if (gear) {
      g.font = 'bold 26px system-ui, sans-serif'; g.fillStyle = '#ffb45c'
      g.fillText(gear, cx, cy - r * 0.38)
    }
    const a = ang(value)
    g.strokeStyle = '#ff6a1a'; g.lineWidth = 6; g.lineCap = 'round'
    g.beginPath(); g.moveTo(cx - Math.cos(a) * 14, cy - Math.sin(a) * 14); g.lineTo(cx + Math.cos(a) * (r - 18), cy + Math.sin(a) * (r - 18)); g.stroke()
    g.fillStyle = '#1a1a1a'; g.beginPath(); g.arc(cx, cy, 13, 0, Math.PI * 2); g.fill()
    g.restore()
  }

  /** The single-dial cluster's strip (the kei van) right of the speedometer: fuel and temperature bars and the lamp row (charge, oil, lights). */
  private lampStrip(g: CanvasRenderingContext2D, s: CockpitState): void {
    g.save()
    g.fillStyle = '#101113'; g.fillRect(256, 64, 256, 128)
    g.strokeStyle = '#3a3c40'; g.lineWidth = 4; g.strokeRect(258, 66, 252, 124)
    const bar = (x: number, label: string, v: number) => {
      g.fillStyle = '#d9d2bd'; g.font = 'bold 15px system-ui'; g.textAlign = 'center'; g.fillText(label, x + 30, 88)
      g.strokeStyle = '#d9d2bd'; g.lineWidth = 2; g.strokeRect(x, 96, 60, 18)
      g.fillStyle = '#e6a13a'; g.fillRect(x + 2, 98, 56 * v, 14)
    }
    bar(270, 'FUEL', 0.7)
    bar(350, 'TEMP', 0.45 + Math.min(0.3, s.rpm / 12000))
    const lamp = (x: number, col: string, on: boolean) => {
      g.fillStyle = on ? col : '#2a2b2e'; g.beginPath(); g.arc(x, 150, 11, 0, Math.PI * 2); g.fill()
    }
    lamp(290, '#ff3b2f', s.rpm < 300)            // charge
    lamp(330, '#ff9a1f', s.rpm < 300)            // oil pressure
    lamp(370, '#3aa0ff', s.lights)               // headlights
    lamp(410, '#45d65a', false)
    g.fillStyle = '#e6a13a'; g.font = 'bold 26px system-ui'; g.textAlign = 'center'; g.fillText(s.gear, 470, 140)
    g.restore()
  }

  /** The G-Class's wide twin screen. From the driver's seat the wheel's rim covers the screen's left third, so the
   *  speedometer and the rev counter sit in the middle (seen over the rim, beside the hub) with the gear between
   *  them, the left third carries only the fuel / temperature bars, the right the map panel. */
  private drawScreen(g: CanvasRenderingContext2D, c: HTMLCanvasElement, s: CockpitState): void {
    g.save()
    const grd = g.createLinearGradient(0, 0, 0, c.height)
    grd.addColorStop(0, '#0d1218'); grd.addColorStop(1, '#05070a')
    g.fillStyle = grd; g.fillRect(0, 0, c.width, c.height)
    const ring = (cx: number, value: number, max: number, label: string, unit: string, col: string) => {
      const cy = 104, r = 84, a0 = Math.PI * 0.8, a1 = Math.PI * 2.2
      g.lineWidth = 11; g.strokeStyle = '#1f2833'
      g.beginPath(); g.arc(cx, cy, r, a0, a1); g.stroke()
      g.strokeStyle = col
      g.beginPath(); g.arc(cx, cy, r, a0, a0 + (a1 - a0) * Math.max(0, Math.min(1, value / max))); g.stroke()
      g.fillStyle = '#eef3f8'; g.font = 'bold 48px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'
      g.fillText(label, cx, cy - 4)
      g.fillStyle = '#8fa1b3'; g.font = '18px system-ui, sans-serif'; g.fillText(unit, cx, cy + 36)
    }
    // left third (behind the rim): fuel and temperature
    const bar = (y: number, label: string, v: number, col: string) => {
      g.fillStyle = '#8fa1b3'; g.font = '17px system-ui'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(label, 40, y)
      g.fillStyle = '#1f2833'; g.fillRect(110, y - 7, 180, 14)
      g.fillStyle = col; g.fillRect(110, y - 7, 180 * v, 14)
    }
    bar(80, 'FUEL', 0.72, '#9fe0ff')
    bar(128, 'TEMP', 0.4 + Math.min(0.25, s.rpm / 16000), '#ffb45c')
    ring(430, s.kmh, this.maxKmh, String(Math.round(s.kmh)), 'km/h', '#4fc3ff')
    g.fillStyle = '#ffb45c'; g.font = 'bold 50px system-ui'; g.textAlign = 'center'; g.fillText(s.gear, 548, 104)
    ring(666, s.rpm, this.maxRpm, (s.rpm / 1000).toFixed(1), '×1000 rpm', s.rpm > this.maxRpm - 800 ? '#ff5a3a' : '#9fe0ff')
    // right: a calm map-like panel (the infotainment side of the screen)
    g.fillStyle = '#0f1a22'; g.fillRect(776, 18, 232, 172)
    g.strokeStyle = '#1e3a4a'; g.lineWidth = 2
    for (let i = 0; i < 5; i++) { g.beginPath(); g.moveTo(790 + i * 48, 30); g.lineTo(816 + i * 42, 180); g.stroke() }
    g.strokeStyle = '#4fc3ff'; g.lineWidth = 5
    g.beginPath(); g.moveTo(820, 180); g.bezierCurveTo(860, 120, 900, 140, 960, 60); g.stroke()
    g.fillStyle = '#eef3f8'; g.font = '18px system-ui'; g.textAlign = 'left'
    g.fillText(s.lights ? 'Lights on' : 'G 500 4×4²', 790, 42)
    g.restore()
  }

  dispose(): void {
    this.tex?.dispose()
    this.root.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh && m.name === 'dials') (m.material as THREE.Material).dispose()
    })
  }
}

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _fwd = new THREE.Vector3(0, 0, -1)
