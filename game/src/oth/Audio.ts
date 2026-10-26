import * as THREE from 'three'
import type { Atmosphere } from './Atmosphere'
import type { MapData } from './MapData'
import type { Vehicle } from './Vehicle'

/**
 * SOUND for Over the Hill (public/oth/audio — CC0 recordings, credits in ASSET_LIST.md). Starts on the first key /
 * tap (the browsers' rule); light by design (the user: "downloading audio while playing mustn't cause issues"):
 *   BEDS (music, forest, wind in the grass, the night's crickets, streams, waterfalls): <audio> elements STREAMED —
 *     never decoded whole (a 4-minute track would be ~90 MB of samples) — each started only when it's wanted
 *     (`preload: none`), paused again after a while silent;
 *   the ENGINE (idle / mid / high loops of an Iveco 3.0 diesel, recorded at 857 / 1731 / 2647 rpm) and the TYRES
 *     (a squeal on hard ground, a gravel scrub on dirt): small buffers fetched in the background after the start.
 * The engine: the car's idle … redline mapped onto the recordings' 857 … 3000 rpm, the three loops crossfaded and
 * pitched to it; on the throttle (the drivetrain's load) louder and open, off it quieter and muffled (a low-pass).
 * Streams and falls fade in as the camera nears them, panned to their side. M mutes everything.
 */
const BASE = '/oth/audio/'
const LAYERS = [
  { file: 'engine_idle.wav', rpm: 857 },
  { file: 'engine_mid.wav', rpm: 1731 },
  { file: 'engine_high.wav', rpm: 2647 },
]
const SOUND_IDLE = 857, SOUND_TOP = 3000
const MUSIC = ['music_etirwer.ogg', 'music_middle_of_nowhere.mp3']

/** A streamed, looping bed: an <audio> element through a gain (and a pan), played only while it's heard. */
class Bed {
  readonly el: HTMLAudioElement
  readonly gain: GainNode
  readonly pan: StereoPannerNode
  target = 0
  private level = 0
  private playing = false
  private quiet = 0
  constructor(ctx: AudioContext, url: string, out: AudioNode) {
    this.el = new Audio()
    this.el.src = url
    this.el.loop = true
    this.el.preload = 'none'
    this.gain = ctx.createGain()
    this.gain.gain.value = 0
    this.pan = ctx.createStereoPanner()
    ctx.createMediaElementSource(this.el).connect(this.gain).connect(this.pan).connect(out)
  }
  update(dt: number): void {
    this.level += (this.target - this.level) * Math.min(1, dt * 1.2)
    this.gain.gain.value = this.level
    if (this.target > 0.004 && !this.playing) { this.playing = true; this.el.play().catch(() => { this.playing = false }) }
    // (silent a while: paused — no decoding for a sound nobody hears)
    this.quiet = this.level < 0.002 && this.target < 0.002 ? this.quiet + dt : 0
    if (this.playing && this.quiet > 6) { this.playing = false; this.el.pause() }
  }
}

export class OthAudio {
  private ctx: AudioContext | null = null
  private master!: GainNode
  private muted = false
  private beds: Record<'forest' | 'wind' | 'night' | 'stream' | 'fall', Bed> | null = null
  private music: HTMLAudioElement | null = null
  private musicIndex = 0
  // the engine: one looping source per layer, each through its gain; all through the load's low-pass
  private engine: { src: AudioBufferSourceNode; gain: GainNode; rpm: number }[] = []
  private engineBus!: GainNode
  private engineTone!: BiquadFilterNode
  private squeal: { src: AudioBufferSourceNode; gain: GainNode } | null = null
  private gravel: { src: AudioBufferSourceNode; gain: GainNode } | null = null
  private sense = 0
  private oneShots: { start?: AudioBuffer; stop?: AudioBuffer } = {}
  private near = { stream: 1e9, streamPan: 0, fall: 1e9, fallPan: 0, forest: 0 }
  private readonly mk: [number, number, number, number] = [0, 0, 0, 0]
  private readonly flowPts: number[] = []
  private readonly right = new THREE.Vector3()

  constructor(private readonly map: MapData, private readonly car: Vehicle, private readonly atmos: Atmosphere) {
    // every point of the flowing water (the river, the streams) — the camera's nearest, a few times a second
    const W = map.meta.water
    for (const L of [W.river, ...(W.streams ?? [])]) for (let i = 0; i < L.x.length; i += 2) this.flowPts.push(L.x[i], L.z[i])
    const start = () => {
      for (const t of ['keydown', 'pointerdown', 'touchstart']) window.removeEventListener(t, start)
      this.init()
    }
    for (const t of ['keydown', 'pointerdown', 'touchstart']) window.addEventListener(t, start)
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyM' || !this.ctx) return
      this.muted = !this.muted
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, this.ctx.currentTime, 0.08)
    })
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return
      if (document.hidden) { void this.ctx.suspend(); this.music?.pause() } else { void this.ctx.resume(); void this.music?.play().catch(() => {}) }
    })
  }

  private init(): void {
    const ctx = (this.ctx = new AudioContext())
    this.master = ctx.createGain()
    this.master.gain.value = 0.9
    this.master.connect(ctx.destination)
    const amb = ctx.createGain()
    amb.gain.value = 1
    amb.connect(this.master)
    this.beds = {
      forest: new Bed(ctx, BASE + 'amb_forest.ogg', amb),
      wind: new Bed(ctx, BASE + 'amb_wind_grass.ogg', amb),
      night: new Bed(ctx, BASE + 'amb_night.mp3', amb),
      stream: new Bed(ctx, BASE + 'amb_stream.ogg', amb),
      fall: new Bed(ctx, BASE + 'amb_waterfall.ogg', amb),
    }
    // the MUSIC: the two tracks one after the other, quietly under the world
    const music = (this.music = new Audio())
    music.preload = 'auto'
    const mg = ctx.createGain()
    mg.gain.value = 0.26
    ctx.createMediaElementSource(music).connect(mg).connect(this.master)
    const next = () => { music.src = BASE + MUSIC[this.musicIndex++ % MUSIC.length]; void music.play().catch(() => {}) }
    music.addEventListener('ended', next)
    next()
    // the ENGINE + TYRES: fetched now, in the background (a few hundred kB each)
    this.engineTone = ctx.createBiquadFilter()
    this.engineTone.type = 'lowpass'
    this.engineTone.frequency.value = 2400
    this.engineBus = ctx.createGain()
    this.engineBus.gain.value = 0
    this.engineTone.connect(this.engineBus).connect(this.master)
    const load = (f: string) => fetch(BASE + f).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b))
    const loopOf = (buf: AudioBuffer, to: AudioNode) => {
      const src = ctx.createBufferSource(), gain = ctx.createGain()
      src.buffer = buf; src.loop = true; gain.gain.value = 0
      src.connect(gain).connect(to)
      src.start()
      return { src, gain }
    }
    void load('engine_stop.wav').then((b) => (this.oneShots.stop = b))
    void Promise.all([...LAYERS.map((l) => load(l.file)), load('engine_start.wav')]).then((bufs) => {
      this.oneShots.start = bufs[LAYERS.length]
      this.engine = LAYERS.map((l, i) => ({ ...loopOf(bufs[i], this.engineTone), rpm: l.rpm }))
      this.startEngine(0)
    })
    // another car: this engine stops, the next one starts
    this.car.onCarChange = () => {
      this.play(this.oneShots.stop, 0, 0.5)
      this.hold = ctx.currentTime + 2.6
      this.startEngine(1.4)
    }
    void load('tyre_squeal.wav').then((b) => (this.squeal = loopOf(b, this.master)))
    void load('tyre_gravel.wav').then((b) => (this.gravel = loopOf(b, this.master)))
  }

  /** The key turns (after `delay` s): the start, the engine fading in under it. */
  private startEngine(delay: number): void {
    this.play(this.oneShots.start, delay, 0.55)
    this.hold = this.ctx!.currentTime + delay + 1.0
  }
  private hold = 0
  /** A one-shot through the master, `delay` s from now. */
  private play(buf: AudioBuffer | undefined, delay: number, gain: number): void {
    const ctx = this.ctx
    if (!ctx || !buf) return
    const s = ctx.createBufferSource(), g = ctx.createGain()
    s.buffer = buf; g.gain.value = gain
    s.connect(g).connect(this.master)
    s.start(ctx.currentTime + delay)
  }

  /** Each frame (dt in s): the engine, the tyres and the beds follow the car, the light, the camera. */
  update(dt: number, camera: THREE.Camera): void {
    const ctx = this.ctx
    if (!ctx || !this.beds) return
    const t = ctx.currentTime, sim = this.car.sim, D = sim?.real ?? null
    const speed = sim ? Math.abs(sim.speed) : 0
    // the car from the camera: the further, the quieter
    const dCar = camera.position.distanceTo(this.car.pos), near = Math.min(1, Math.max(0.15, 9 / Math.max(dCar, 1)))
    // ENGINE: the car's rev range mapped onto the recordings', three loops crossfaded (equal power) and pitched
    if (this.engine.length) {
      let s: number, onLoad: number
      if (D) {
        const idle = (D.R.power.wIdle * 30) / Math.PI, red = (D.R.power.wRedline * 30) / Math.PI
        s = SOUND_IDLE + Math.min(1.1, Math.max(0, (D.rpm - idle) / Math.max(1, red - idle))) * (SOUND_TOP - SOUND_IDLE)
        onLoad = Math.max(0, D.load)
      } else {
        const thr = Math.max(0, sim?.controls.throttle ?? 0)
        s = SOUND_IDLE + Math.min(1, speed / 25) * 1700 + thr * 400
        onLoad = thr
      }
      const [a, b, c] = LAYERS.map((l) => l.rpm)
      const w = s <= b ? [(b - s) / (b - a), (s - a) / (b - a), 0] : [0, (c - s) / (c - b), (s - b) / (c - b)]
      this.engine.forEach((L, i) => {
        L.gain.gain.setTargetAtTime(Math.sqrt(Math.min(1, Math.max(0, w[i]))), t, 0.05)
        L.src.playbackRate.setTargetAtTime(Math.min(1.6, Math.max(0.55, s / L.rpm)), t, 0.05)
      })
      // on the throttle: open and loud; off it: muffled and quieter
      this.engineTone.frequency.setTargetAtTime(900 + 5200 * onLoad, t, 0.08)
      // (silent while a start / stop plays: `hold`)
      this.engineBus.gain.setTargetAtTime(t < this.hold ? 0 : (0.32 + 0.3 * onLoad) * near, t, t < this.hold ? 0.05 : 0.25)
    }
    // TYRES: a squeal sliding on hard ground; on dirt and gravel a scrub when sliding, a soft roll when not
    const n = sim?.tyreNoise() ?? null
    const slide = n ? n.slide : sim?.drifting ? 0.8 : 0, spin = n ? n.spin : 0
    const hard = n ? n.hard : 0.3, loose = n ? n.gravel + n.soft : 0.7
    const fast = Math.min(1, speed / 20)
    if (this.squeal) {
      this.squeal.gain.gain.setTargetAtTime(Math.min(1, slide * 1.2 + spin * 0.5) * hard * 0.5 * Math.min(1, speed / 6) * near, t, 0.06)
      this.squeal.src.playbackRate.setTargetAtTime(0.9 + 0.2 * fast, t, 0.1)
    }
    if (this.gravel) {
      const scrub = Math.min(1, slide * 1.2 + spin * 0.8) * loose * 0.75, roll = fast * loose * 0.16
      this.gravel.gain.gain.setTargetAtTime(Math.max(scrub, roll) * Math.min(1, speed / 3) * near, t, 0.08)
      this.gravel.src.playbackRate.setTargetAtTime(0.55 + 0.3 * fast, t, 0.1)
    }
    // BEDS: what's round the camera (a few times a second)
    this.sense -= dt
    if (this.sense <= 0) { this.sense = 0.25; this.listen(camera) }
    const night = this.atmos.uniforms.uNight.value, day = 1 - night, B = this.beds
    B.forest.target = day * (0.16 + 0.42 * this.near.forest)
    B.wind.target = day * (0.1 + 0.22 * (1 - this.near.forest))
    B.night.target = night * 0.5
    B.stream.target = 0.65 * smooth(70, 8, this.near.stream)
    B.stream.pan.pan.value = this.near.streamPan * 0.7
    B.fall.target = 0.85 * smooth(110, 10, this.near.fall)
    B.fall.pan.pan.value = this.near.fallPan * 0.7
    for (const k of Object.keys(B) as (keyof typeof B)[]) B[k].update(dt)
  }

  /** For the harness / a debug view: the context, what's loaded, every layer's level. */
  debug(): object {
    const r = (v: number) => +v.toFixed(3)
    return {
      state: this.ctx?.state ?? 'not started', muted: this.muted,
      engine: this.engine.map((L) => ({ rpm: L.rpm, gain: r(L.gain.gain.value), rate: r(L.src.playbackRate.value) })),
      engineBus: this.engineBus ? r(this.engineBus.gain.value) : 0, tone: this.engineTone ? Math.round(this.engineTone.frequency.value) : 0,
      squeal: this.squeal ? r(this.squeal.gain.gain.value) : null, gravel: this.gravel ? r(this.gravel.gain.gain.value) : null,
      beds: this.beds ? Object.fromEntries(Object.entries(this.beds).map(([k, b]) => [k, { target: r(b.target), level: r(b.gain.gain.value), playing: !b.el.paused }])) : null,
      music: this.music ? { src: this.music.src.split('/').pop(), playing: !this.music.paused, t: r(this.music.currentTime) } : null,
      near: { stream: Math.round(this.near.stream), fall: Math.round(this.near.fall), forest: r(this.near.forest) },
    }
  }

  /** The nearest flowing water and waterfall (distance, side), the forest round the camera. */
  private listen(camera: THREE.Camera): void {
    const p = camera.position, P = this.flowPts
    this.right.setFromMatrixColumn(camera.matrixWorld, 0)
    let best = 1e9, bx = 0, bz = 0
    for (let i = 0; i < P.length; i += 2) {
      const d = (P[i] - p.x) ** 2 + (P[i + 1] - p.z) ** 2
      if (d < best) { best = d; bx = P[i]; bz = P[i + 1] }
    }
    const side = (x: number, z: number) => { const dx = x - p.x, dz = z - p.z, l = Math.hypot(dx, dz) || 1; return (dx * this.right.x + dz * this.right.z) / l }
    this.near.stream = Math.sqrt(best)
    this.near.streamPan = side(bx, bz)
    best = 1e9
    for (const f of this.map.meta.water.falls ?? []) {
      const d = Math.hypot(f.x - p.x, f.z - p.z) - 0.3 * (f.y - f.by) // (a tall fall is heard further)
      if (d < best) { best = d; bx = f.x; bz = f.z }
    }
    this.near.fall = best
    this.near.fallPan = best < 1e8 ? side(bx, bz) : 0
    let f = 0
    for (const [dx, dz] of [[0, 0], [35, 0], [-35, 0], [0, 35], [0, -35]]) f += this.map.maskAt(p.x + dx, p.z + dz, this.mk)[3]
    this.near.forest = Math.min(1, f / 5 / 0.6)
  }
}

/** 1 at b (and nearer) … 0 at a (and further), smooth. */
function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
