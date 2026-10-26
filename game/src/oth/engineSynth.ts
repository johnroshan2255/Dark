/**
 * ENGINE SYNTH (the user: "the car sound isn't realistic — I need it like Over the Hill"; OTH's own recordings are
 * Funselektor's, so the engine is MODELLED instead — physically informed, after Baldan et al. 2015, "Physically
 * informed car engine sound synthesis"): an AudioWorklet (the audio thread — never the game's frame) that turns the
 * car's rpm and load into sound, sample by sample:
 *   COMBUSTION   every cylinder at its own firing angle in the 720° cycle opens its exhaust valve ~140° after firing
 *                → a pressure BLOW-DOWN (a fast rise, a decay over ~¼ turn) and the gas's turbulence, each cycle a
 *                little different (a real engine is never even); off the throttle the pulses are weak, and at high
 *                revs on the overrun one now and then POPS;
 *   EXHAUST      each bank's pulses run down its pipe (a delay line: the reflection off the open end, damped, makes
 *                the pipe's resonances) and a short header, then the MUFFLER (its body resonance + a low-pass that
 *                opens on load);
 *   INTAKE       the induction roar: noise band-passed, swelling with each intake stroke and the throttle;
 *   MECHANICAL   the valvetrain's ticks; a TURBO's whistle and blow-off (the G-wagen);
 *   then a soft saturation and a DC block. STARTING: the starter cranks (~230 rpm, weak and missing), the engine
 *   catches, flares and settles to the sim's idle; STOPPING: the revs run down. A gear change dips the drive.
 * Each car is its own VOICE (cylinders, firing angles, banks, pipes, muffler): the G-wagen's cross-plane V8 (each
 * bank fed unevenly — the burble), the E30 M3's raspy four, the kei van's three.
 * The processor's code is a string (loaded from a Blob: the same in dev and in the build); `EngineCore` is plain
 * DSP (tests can run it in Node).
 */
export interface EngineVoice {
  /** firing angle of each cylinder, as a share of the 720° cycle */
  firing: number[]
  /** the exhaust bank each cylinder blows into (0 / 1) */
  bank: number[]
  /** each bank's pipe length (m) and the header's */
  pipe: [number, number]
  header: number
  /** the muffler's body resonance (Hz) and its low-pass on full load (Hz) */
  muffler: number
  open: number
  /** levels 0…1: the intake's roar, the valvetrain, a turbo */
  intake: number
  mech: number
  turbo: number
  gain: number
}

export const VOICES: Record<string, EngineVoice> = {
  // G500 4×4²: a cross-plane V8 (firing order 1-5-4-8-6-3-7-2, 90° apart; bank A = 1–4, B = 5–8 — each bank fires
  // at uneven intervals: the V8 burble), twin pipes, a deep muffler, two turbos
  gwagen: { firing: [0, 0.875, 0.625, 0.25, 0.125, 0.5, 0.75, 0.375], bank: [0, 0, 0, 0, 1, 1, 1, 1], pipe: [2.5, 2.75], header: 0.45, muffler: 78, open: 2600, intake: 0.25, mech: 0.3, turbo: 0.55, gain: 1.0 },
  // E30 M3 (S14): an inline four (180° apart), a 4-2-1 header, a bright muffler, a loud intake (throttle bodies)
  bmw: { firing: [0, 0.75, 0.25, 0.5], bank: [0, 0, 0, 0], pipe: [2.9, 2.9], header: 0.6, muffler: 150, open: 4200, intake: 0.8, mech: 0.55, turbo: 0, gain: 0.95 },
  // the kei van: a 660 cm³ inline three (240° apart), a short pipe, a small buzzy muffler
  van: { firing: [0, 1 / 3, 2 / 3], bank: [0, 0, 0], pipe: [1.7, 1.7], header: 0.35, muffler: 215, open: 3000, intake: 0.35, mech: 0.5, turbo: 0, gain: 0.85 },
}

export const ENGINE_WORKLET = /* js */ `
const C = 500 // the speed of sound in the hot exhaust (m/s)
class EngineCore {
  constructor(fs) {
    this.fs = fs
    this.phase = 0; this.seed = 0x2f6b1c3d
    this.rpm = 0; this.rpmHost = 800; this.load = 0; this.loadHost = 0; this.thr = 0; this.thrHost = 0
    this.idle = 800; this.red = 6000
    this.mode = 'off'; this.modeT = 0; this.from = 0
    this.dip = 0; this.boost = 0; this.tPhase = 0; this.bov = 0; this.lastLoad = 0
    this.dc1 = 0; this.dcY = 0; this.lpA = 0; this.lpB = 0; this.hp1 = 0; this.whine = 0
    this.setVoice(null)
  }
  rand() { let s = this.seed; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; this.seed = s >>> 0; return this.seed / 4294967296 }
  noise() { return this.rand() * 2 - 1 }
  setVoice(v) {
    v = v || { firing: [0, 0.25, 0.5, 0.75], bank: [0, 0, 0, 0], pipe: [2.5, 2.5], header: 0.5, muffler: 120, open: 3000, intake: 0.4, mech: 0.4, turbo: 0, gain: 1 }
    this.v = v
    const n = v.firing.length, fs = this.fs
    this.evo = v.firing.map((f) => (f + 0.195) % 1) // exhaust valve opens ~140° after firing
    this.ivo = v.firing.map((f) => (f + 0.5) % 1)   // the intake stroke, a turn later
    this.t = new Float64Array(n).fill(9); this.amp = new Float64Array(n); this.pop = new Float64Array(n); this.tick = 9
    this.pipe = [0, 1].map((b) => new Float32Array(Math.max(8, Math.round((2 * v.pipe[b] / C) * fs))))
    this.head = [0, 1].map(() => new Float32Array(Math.max(4, Math.round((2 * v.header / C) * fs))))
    this.pi = [0, 0]; this.hi = [0, 0]; this.plp = [0, 0]
    this.bp = this.biquad(v.muffler, 0.85); this.bpS = [0, 0, 0, 0]
    this.ib = this.biquad(600, 1.3); this.ibS = [0, 0, 0, 0]
  }
  // RBJ band-pass (constant 0 dB peak)
  biquad(f, q) {
    const w = 2 * Math.PI * f / this.fs, a = Math.sin(w) / (2 * q), a0 = 1 + a
    return [a / a0, 0, -a / a0, (-2 * Math.cos(w)) / a0, (1 - a) / a0]
  }
  bq(c, s, x) { const y = c[0] * x + c[1] * s[0] + c[2] * s[1] - c[3] * s[2] - c[4] * s[3]; s[1] = s[0]; s[0] = x; s[3] = s[2]; s[2] = y; return y }
  set(rpm, load, thr, idle, red) { this.rpmHost = rpm; this.loadHost = load; this.thrHost = thr; if (idle > 0) this.idle = idle; if (red > 0) this.red = red }
  event(e) {
    if (e === 'start') { this.mode = 'crank'; this.modeT = 0 }
    else if (e === 'stop') { this.mode = 'stop'; this.modeT = 0; this.from = this.rpm }
    else if (e === 'shift') this.dip = 1
  }
  process(out) {
    const fs = this.fs, dt = 1 / fs, v = this.v, n = v.firing.length
    const kS = 1 - Math.exp(-dt / 0.02), kL = 1 - Math.exp(-dt / 0.06)
    for (let s = 0; s < out.length; s++) {
      // the revs: the sim's — or the starter's, the catch's, the run-down's
      this.modeT += dt
      let target = this.rpmHost, crank = false
      if (this.mode === 'off') target = 0
      else if (this.mode === 'crank') { target = 230 + 35 * Math.sin(this.modeT * 21); crank = true; if (this.modeT > 0.85) { this.mode = 'catch'; this.modeT = 0 } }
      else if (this.mode === 'catch') { const k = Math.min(1, this.modeT / 0.9); target = (this.idle * 1.7) * (1 - k) + this.rpmHost * k; if (k >= 1) this.mode = 'run' }
      else if (this.mode === 'stop') { target = this.from * Math.max(0, 1 - this.modeT / 0.9); if (this.modeT > 1.0) this.mode = 'off' }
      this.rpm += (target - this.rpm) * (this.mode === 'run' ? kS : kS * 2)
      this.load += (this.loadHost - this.load) * kL
      this.thr += (this.thrHost - this.thr) * kL
      const rpm = Math.max(0, this.rpm), on = Math.max(0, this.load), off = Math.max(0, -this.load)
      // the crank: 1 cycle = 720°
      const prev = this.phase
      this.phase += (rpm / 120) * dt
      const wrap = this.phase >= 1
      if (wrap) this.phase -= 1
      const crossed = (a) => (wrap ? (a > prev || a <= this.phase) : (a > prev && a <= this.phase))
      // COMBUSTION → the exhaust pulses
      const tauD = 0.22 * 60 / Math.max(rpm, 120), tauA = 0.00025
      let bankIn0 = 0, bankIn1 = 0, intakeEnv = 0
      for (let c = 0; c < n; c++) {
        if (rpm > 40 && crossed(this.evo[c])) {
          this.t[c] = 0
          let a = (0.2 + 0.8 * on) * (1 + 0.36 * (this.rand() - 0.5))
          if (crank) a *= this.rand() < 0.45 ? 0.05 : 0.3 // (cranking: weak, missing)
          this.amp[c] = a
          this.pop[c] = off > 0.15 && rpm > 2300 && this.rand() < 0.1 * off ? 1.3 + this.rand() : 0
          this.tick = 0
        }
        const t = this.t[c]
        if (t < 0.25) {
          const a = this.amp[c]
          let p = a * (1 - Math.exp(-t / tauA)) * Math.exp(-t / tauD) + a * 0.45 * this.noise() * Math.exp(-t / (0.6 * tauD))
          if (this.pop[c]) p += this.pop[c] * this.noise() * Math.exp(-t / 0.0016)
          if (v.bank[c]) bankIn1 += p; else bankIn0 += p
          this.t[c] = t + dt
        }
        // the intake stroke of this cylinder (a ¼-cycle swell)
        let q = this.phase - this.ivo[c]; if (q < 0) q += 1
        if (q < 0.25) intakeEnv += Math.sin(q * 4 * Math.PI)
      }
      // EXHAUST: each bank down its header and its pipe (inverted reflection off the open end, damped in the loop)
      let exh = 0
      for (let b = 0; b < 2; b++) {
        const x = b ? bankIn1 : bankIn0
        const H = this.head[b], hi = this.hi[b], hd = H[hi]
        const h = x + 0.32 * hd
        H[hi] = h; this.hi[b] = (hi + 1) % H.length
        const P = this.pipe[b], pi = this.pi[b]
        this.plp[b] += (P[pi] - this.plp[b]) * 0.42
        const y = h - 0.62 * this.plp[b]
        P[pi] = y; this.pi[b] = (pi + 1) % P.length
        exh += y
      }
      // the MUFFLER: its body resonance + a low-pass opening with the load
      const fc = v.open * (0.4 + 0.6 * on), a = 1 - Math.exp(-2 * Math.PI * fc * dt)
      this.lpA += (exh - this.lpA) * a; this.lpB += (this.lpA - this.lpB) * a
      const body = this.bq(this.bp, this.bpS, exh)
      let y = 0.8 * this.lpB + 1.5 * body
      // INTAKE roar
      y += v.intake * 0.22 * (0.15 + 0.85 * this.thr) * (0.35 + 0.65 * Math.min(1, rpm / this.red)) * intakeEnv * this.bq(this.ib, this.ibS, this.noise())
      // MECHANICAL ticks (high-passed noise bursts at each valve event)
      if (this.tick < 0.01) { const k = this.noise() * Math.exp(-this.tick / 0.00035); y += v.mech * 0.05 * (0.4 + rpm / 5000) * (k - this.hp1); this.hp1 = k; this.tick += dt }
      // TURBO: the whistle building with load and revs, the blow-off when the throttle snaps shut
      if (v.turbo) {
        this.boost += ((on * Math.min(1, Math.max(0, (rpm - 1500) / 3000))) - this.boost) * (1 - Math.exp(-dt / 0.35))
        this.tPhase += (1800 + 4200 * this.boost) * dt
        y += v.turbo * 0.02 * this.boost * Math.sin(2 * Math.PI * this.tPhase)
        if (this.lastLoad > 0.55 && this.load < 0.05 && this.boost > 0.3) this.bov = 1
        this.lastLoad = this.load
        if (this.bov > 0.001) { y += v.turbo * 0.05 * this.bov * this.noise(); this.bov *= Math.exp(-dt / 0.12) }
      }
      // the STARTER motor's whine while cranking
      if (crank) { this.whine += 680 * dt; y += 0.04 * Math.sin(2 * Math.PI * this.whine) + 0.02 * this.noise() }
      // a gear change: the drive dips for a moment
      if (this.dip > 0.001) { y *= 1 - 0.6 * this.dip; this.dip *= Math.exp(-dt / 0.09) }
      // louder with revs; soft saturation; DC block
      y *= v.gain * (0.55 + 0.45 * Math.min(1.2, rpm / this.red)) * (this.mode === 'off' ? 0 : 1)
      y = Math.tanh(1.5 * y) / 1.5
      const d = y - this.dc1 + 0.995 * this.dcY; this.dc1 = y; this.dcY = d
      out[s] = d
    }
  }
}
if (typeof registerProcessor === 'function') {
  registerProcessor('oth-engine', class extends AudioWorkletProcessor {
    constructor() {
      super()
      this.core = new EngineCore(sampleRate)
      this.port.onmessage = (e) => {
        const m = e.data
        if (m.voice) this.core.setVoice(m.voice)
        if (m.set) this.core.set(m.set[0], m.set[1], m.set[2], m.set[3], m.set[4])
        if (m.event) this.core.event(m.event)
      }
    }
    process(_in, outs) { const o = outs[0]; if (o && o[0]) { this.core.process(o[0]); for (let c = 1; c < o.length; c++) o[c].set(o[0]) } return true }
  })
}
`
