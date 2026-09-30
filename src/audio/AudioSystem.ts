import musicUrl from '../assets/audio/music/gone_fishin.mp3?url'
import engineDriveUrl from '../assets/audio/car/engine_drive.wav?url'
import engineIdleUrl from '../assets/audio/car/engine_idle.wav?url'
import engineStartUrl from '../assets/audio/car/engine_start.mp3?url'
import engineStopUrl from '../assets/audio/car/engine_stop.mp3?url'
import doorUrl from '../assets/audio/car/door.mp3?url'
import skidUrl from '../assets/audio/car/skid.mp3?url'
import boostUrl from '../assets/audio/car/boost_wind.mp3?url'
import freewheelUrl from '../assets/audio/bike/freewheel.mp3?url'
import rollUrl from '../assets/audio/bike/roll.mp3?url'
import rainUrl from '../assets/audio/ambience/rain.mp3?url'
import step0 from '../assets/audio/steps/step0.mp3?url'
import step1 from '../assets/audio/steps/step1.mp3?url'
import step2 from '../assets/audio/steps/step2.mp3?url'
import step3 from '../assets/audio/steps/step3.mp3?url'
import step4 from '../assets/audio/steps/step4.mp3?url'
import step5 from '../assets/audio/steps/step5.mp3?url'
import step6 from '../assets/audio/steps/step6.mp3?url'
import step7 from '../assets/audio/steps/step7.mp3?url'
import step8 from '../assets/audio/steps/step8.mp3?url'
import step9 from '../assets/audio/steps/step9.mp3?url'

/**
 * SOUND. Recorded CC0 sounds (src/assets/audio, credits ASSET_LIST.md) + a few synthesized effects (thunder,
 * monster, hurt). Mixer: master (the Settings "Sound" toggle mutes everything) → music bus (Settings "Theme
 * music") + effects bus. Continuous sounds are PERSISTENT LOOPS whose gain / pitch / pan follow the game every
 * frame (`frame()`): engine (two layers + simulated gears), boost rush, tyre skid, bike freewheel + rolling,
 * rain, theme. One-shots: doors, engine start / stop, footsteps (`footstep()`, timed to stride length by Game).
 * WebAudio needs a user gesture: the context is created / resumed on the first pointerdown / keydown, then the
 * ~3 MB of audio is fetched and decoded in the background (the game never waits for it).
 * Cost: ~9 looping sources + a few short-lived nodes; ~12 gain/rate automations per frame.
 */
const SOUNDS = {
  music: musicUrl, engineDrive: engineDriveUrl, engineIdle: engineIdleUrl, engineStart: engineStartUrl, engineStop: engineStopUrl,
  door: doorUrl, skid: skidUrl, boost: boostUrl, freewheel: freewheelUrl, roll: rollUrl, rain: rainUrl,
  step0, step1, step2, step3, step4, step5, step6, step7, step8, step9,
} as const
type SoundName = keyof typeof SOUNDS
const LOOPS: SoundName[] = ['music', 'engineDrive', 'engineIdle', 'skid', 'boost', 'freewheel', 'roll', 'rain']

/** Per-frame game state the mixer follows (plain numbers — no game types here). */
export interface SoundFrame {
  dt: number
  /** 0 day … 1 night; nightmare 0..1 — the theme fades with them. */
  darkness: number
  nightmare: number
  /** Front end open (menu / garage): the theme a little louder, no game sounds. */
  menu: boolean
  rain: number
  car: { engineOn: boolean; distance: number; pan: number; speed: number; throttle: number; boost: boolean; slip: number }
  bike: { riding: boolean; distance: number; pan: number; speed: number; throttle: number }
}

interface Loop {
  src: AudioBufferSourceNode
  gain: GainNode
  pan: StereoPannerNode
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const sstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}
/** Automatic gearbox for the engine note: shift points (m/s) — the pitch climbs through each gear, drops at a shift. */
const GEARS = [0, 5.5, 11, 17.5, 25, 34, 60]

export class AudioSystem {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private musicBus: GainNode | null = null
  private sfx: GainNode | null = null
  private noise: AudioBuffer | null = null
  private readonly buffers = new Map<SoundName, AudioBuffer>()
  private readonly loops = new Map<SoundName, Loop>()
  private loading = false
  volume = 0.8
  /** Settings: all sound on/off, theme music on/off. */
  private enabled = true
  private musicOn = true
  private rpm = 0.2
  private lastStep = -1

  constructor() {
    const unlock = () => {
      this.ensure()
      void this.ctx?.resume()
    }
    window.addEventListener('pointerdown', unlock, { passive: true })
    window.addEventListener('keydown', unlock)
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx
    try {
      const ctx = new AudioContext()
      this.master = ctx.createGain()
      this.master.gain.value = this.enabled ? this.volume : 0
      this.master.connect(ctx.destination)
      this.musicBus = ctx.createGain()
      this.musicBus.gain.value = this.musicOn ? 1 : 0
      this.musicBus.connect(this.master)
      this.sfx = ctx.createGain()
      this.sfx.connect(this.master)
      // 4 s of brown-ish noise, reused by the synthesized effects.
      const len = ctx.sampleRate * 4
      const buf = ctx.createBuffer(1, len, ctx.sampleRate)
      const d = buf.getChannelData(0)
      let last = 0
      for (let i = 0; i < len; i++) {
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02
        d[i] = last * 3.5
      }
      this.noise = buf
      this.ctx = ctx
      void this.load()
    } catch {
      this.ctx = null
    }
    return this.ctx
  }

  /** Fetch + decode every sound once (in parallel); a failed file is skipped, the rest still play. */
  private async load(): Promise<void> {
    if (this.loading || !this.ctx) return
    this.loading = true
    const ctx = this.ctx
    await Promise.all(
      (Object.keys(SOUNDS) as SoundName[]).map(async (name) => {
        try {
          const res = await fetch(SOUNDS[name])
          const buf = await ctx.decodeAudioData(await res.arrayBuffer())
          this.buffers.set(name, buf)
          if (LOOPS.includes(name)) this.startLoop(name, buf)
        } catch (e) {
          console.warn(`audio: ${name} failed to load`, e)
        }
      }),
    )
  }

  /** A loop that runs forever at gain 0 until frame() raises it. MP3 loops skip the encoder padding at both ends. */
  private startLoop(name: SoundName, buf: AudioBuffer): void {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    const mp3 = SOUNDS[name].endsWith('.mp3')
    src.loopStart = mp3 ? 0.03 : 0
    src.loopEnd = mp3 ? buf.duration - 0.03 : buf.duration
    const gain = ctx.createGain()
    gain.gain.value = 0
    const pan = ctx.createStereoPanner()
    src.connect(gain).connect(pan).connect(name === 'music' ? this.musicBus! : this.sfx!)
    src.start(0, src.loopStart)
    this.loops.set(name, { src, gain, pan })
  }

  private set(name: SoundName, gain: number, rate = 1, pan = 0, tau = 0.08): void {
    const l = this.loops.get(name)
    if (!l || !this.ctx) return
    const t = this.ctx.currentTime
    l.gain.gain.setTargetAtTime(Math.max(0, gain), t, tau)
    l.src.playbackRate.setTargetAtTime(Math.max(0.1, rate), t, tau)
    l.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), t, tau)
  }

  /** Play a one-shot. */
  play(name: SoundName, gain = 1, rate = 1, pan = 0): void {
    const ctx = this.ctx, buf = this.buffers.get(name)
    if (!ctx || !buf || !this.sfx || ctx.state !== 'running') return
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = rate
    const g = ctx.createGain()
    g.gain.value = gain
    const p = ctx.createStereoPanner()
    p.pan.value = pan
    src.connect(g).connect(p).connect(this.sfx)
    src.start()
  }

  /** One footstep (random of 10, slight pitch / level variety — never the same one twice in a row). */
  footstep(gain = 0.5): void {
    let k = Math.floor(Math.random() * 10)
    if (k === this.lastStep) k = (k + 3) % 10
    this.lastStep = k
    this.play(`step${k}` as SoundName, gain * (0.85 + Math.random() * 0.3), 0.9 + Math.random() * 0.2)
  }

  /** Settings: the single Sound toggle (everything) and the theme music toggle. */
  setEnabled(on: boolean): void {
    this.enabled = on
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? this.volume : 0, this.ctx.currentTime, 0.1)
  }
  setMusic(on: boolean): void {
    this.musicOn = on
    if (this.musicBus && this.ctx) this.musicBus.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.4)
  }

  /** Every render frame: the loops follow the game. */
  frame(f: SoundFrame): void {
    if (!this.ctx || this.ctx.state !== 'running') return
    // THEME: warm by day, fading out as night falls and gone in the nightmare (the horror plays without it).
    this.set('music', 0.34 * (f.menu ? 1.2 : 1) * (1 - 0.8 * f.darkness) * (1 - f.nightmare), 1, 0, 1.2)
    this.set('rain', f.menu ? 0 : 0.7 * f.rain, 1, 0, 0.8)
    const c = f.car, att = (d: number) => 1 / (1 + Math.max(0, d - 5) / 9)
    // ENGINE: an automatic gearbox — rpm climbs through each gear with speed, drops at the shift; throttle adds
    // load; revving on the spot when stopped. Two layers: idle (low rpm) crossfading into the drive loop.
    if (c.engineOn && !f.menu) {
      const v = Math.abs(c.speed)
      let g = 0
      while (g < GEARS.length - 2 && v > GEARS[g + 1]) g++
      const inGear = (v - GEARS[g]) / (GEARS[g + 1] - GEARS[g])
      const target = v < 1 ? 0.18 + 0.55 * c.throttle : 0.3 + 0.62 * clamp01(inGear) + 0.1 * c.throttle
      this.rpm += (target - this.rpm) * Math.min(1, f.dt * (target > this.rpm ? 6 : 10))
      const a = att(c.distance)
      const boost = c.boost && c.throttle > 0.1 ? 1 : 0
      const drive = sstep(0.12, 0.4, this.rpm)
      this.set('engineIdle', (1 - drive) * 0.55 * a, 0.9 + this.rpm * 0.6, c.pan)
      this.set('engineDrive', (0.18 + 0.5 * this.rpm + 0.15 * c.throttle) * drive * a * (boost ? 1.25 : 1), 0.45 + this.rpm * 0.85 + boost * 0.08, c.pan)
      this.set('boost', boost * 0.6 * clamp01(v / 10) * a, 0.9 + clamp01(v / 30) * 0.4, c.pan, 0.15)
      this.set('skid', sstep(0.18, 0.75, c.slip) * 0.75 * a, 0.9 + 0.2 * c.slip, c.pan, 0.05)
    } else {
      for (const n of ['engineIdle', 'engineDrive', 'boost', 'skid'] as const) this.set(n, 0, 1, 0, 0.25)
      this.rpm = 0.2
    }
    // BIKE: tyres rolling on the ground (level with speed) + the freewheel ticking when coasting.
    const b = f.bike
    if (b.riding && !f.menu) {
      const a = att(b.distance), v = Math.abs(b.speed)
      this.set('roll', clamp01(v / 9) * 0.5 * a, 0.8 + clamp01(v / 12) * 0.4, b.pan)
      const coast = b.throttle < 0.05 && v > 1.2 ? 1 : 0
      this.set('freewheel', coast * clamp01(v / 7) * 0.55 * a, 0.7 + clamp01(v / 12) * 0.6, b.pan, 0.12)
    } else {
      this.set('roll', 0, 1, 0, 0.3)
      this.set('freewheel', 0, 1, 0, 0.3)
    }
  }

  private noiseSource(ctx: AudioContext, offset = 0): AudioBufferSourceNode {
    const s = ctx.createBufferSource()
    s.buffer = this.noise
    s.start(ctx.currentTime + offset, Math.random() * 2)
    return s
  }

  /** @param distance metres — sets delay (speed of sound), loudness and how much crack survives. */
  thunder(distance: number): void {
    const ctx = this.ctx
    if (!ctx || !this.master || ctx.state !== 'running') return
    const delay = Math.min(6, distance / 343)
    const near = Math.max(0, 1 - distance / 120)
    const t = ctx.currentTime + delay
    // Crack (near strikes only): bright, short.
    if (near > 0.2) {
      const src = this.noiseSource(ctx, delay)
      const hp = ctx.createBiquadFilter()
      hp.type = 'highpass'
      hp.frequency.value = 900
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(1.6 * near, t + 0.01)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.35)
      src.connect(hp).connect(g).connect(this.sfx!)
      src.stop(t + 0.4)
    }
    // Rumble.
    const src = this.noiseSource(ctx, delay)
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 180 + 500 * near
    const g = ctx.createGain()
    const vol = 0.35 + 0.9 * near
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(vol, t + 0.08 + (1 - near) * 0.4)
    g.gain.setValueAtTime(vol * 0.7, t + 0.8)
    g.gain.exponentialRampToValueAtTime(0.001, t + 3.5 + (1 - near) * 1.5)
    src.connect(lp).connect(g).connect(this.sfx!)
    src.stop(t + 5.5)
  }

  /** Low distorted growl (hunt start) or short screech (attack). */
  monster(kind: 'growl' | 'screech', distance: number): void {
    const ctx = this.ctx
    if (!ctx || !this.master || ctx.state !== 'running') return
    const t = ctx.currentTime
    const vol = Math.max(0, 1 - distance / 60) * (kind === 'screech' ? 0.5 : 0.6)
    if (vol <= 0.01) return
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(kind === 'growl' ? 58 : 420, t)
    osc.frequency.exponentialRampToValueAtTime(kind === 'growl' ? 42 : 180, t + (kind === 'growl' ? 1.4 : 0.5))
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = kind === 'growl' ? 400 : 2200
    const g = ctx.createGain()
    const dur = kind === 'growl' ? 1.6 : 0.55
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(vol, t + 0.08)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    osc.connect(lp).connect(g).connect(this.sfx!)
    osc.start(t)
    osc.stop(t + dur + 0.05)
    const n = this.noiseSource(ctx)
    const ng = ctx.createGain()
    ng.gain.setValueAtTime(vol * 0.5, t)
    ng.gain.exponentialRampToValueAtTime(0.001, t + dur)
    n.connect(lp)
    n.stop(t + dur)
  }

  hurt(): void {
    const ctx = this.ctx
    if (!ctx || !this.master || ctx.state !== 'running') return
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    osc.frequency.setValueAtTime(110, t)
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.25)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.8, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3)
    osc.connect(g).connect(this.sfx!)
    osc.start(t)
    osc.stop(t + 0.32)
  }
}
