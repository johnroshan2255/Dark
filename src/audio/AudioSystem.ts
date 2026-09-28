/**
 * Synthesized sound (no audio files to download): thunder crack + rumble, monster growl/screech, hurt thump.
 * WebAudio needs a user gesture: the context is created/resumed on the first pointerdown/keydown.
 * Cost: a few short-lived nodes per event; zero per frame.
 */
export class AudioSystem {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noise: AudioBuffer | null = null
  volume = 0.8

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
      this.master.gain.value = this.volume
      this.master.connect(ctx.destination)
      // 4 s of brown-ish noise, reused by every effect.
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
    } catch {
      this.ctx = null
    }
    return this.ctx
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
      src.connect(hp).connect(g).connect(this.master)
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
    src.connect(lp).connect(g).connect(this.master)
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
    osc.connect(lp).connect(g).connect(this.master)
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
    osc.connect(g).connect(this.master)
    osc.start(t)
    osc.stop(t + 0.32)
  }
}
