// Per-voice DSP building blocks: band-limited wavetable storage, DAHDSR
// envelope, multi-point LFO, and the filter models.

import type { LfoPoint } from '../shared/messages'
import { evalLfoShape } from '../shared/messages'
import { NUM_MIPS } from '../shared/wavetable-gen'

export { NUM_MIPS }

// ------------------------------------------------------------ wavetable (mipmapped)

/**
 * Band-limited wavetable: per frame, NUM_MIPS progressively low-passed copies
 * of the cycle. The mip pyramid is built on the main thread (buildMips) and
 * received here as one transferred Float32Array; frames are zero-copy views.
 */
export class WavetableData {
  frameSize: number
  numFrames: number
  mips: Float32Array[]

  constructor(mipData: Float32Array, frameSize: number, numFrames: number) {
    this.frameSize = frameSize
    this.numFrames = numFrames
    this.mips = new Array(numFrames * NUM_MIPS)
    for (let i = 0; i < numFrames * NUM_MIPS; i++) {
      this.mips[i] = mipData.subarray(i * frameSize, (i + 1) * frameSize)
    }
  }

  /** Pick the mip whose highest harmonic stays below Nyquist for phaseInc (cycles/sample). */
  mipForInc(phaseInc: number): number {
    // audible harmonics = 0.5 / phaseInc ; mip m allows 1024 >> m harmonics
    const audible = 0.5 / Math.max(phaseInc, 1e-9)
    let m = 0
    while (m < NUM_MIPS - 1 && (1024 >> m) > audible) m++
    return m
  }

  /** Read with frame morph (pos 0..1) and linear sample interpolation. */
  read(pos: number, phase: number, mip: number): number {
    const fpos = pos * (this.numFrames - 1)
    let f0 = Math.floor(fpos)
    if (f0 >= this.numFrames - 1) f0 = this.numFrames - 2
    if (f0 < 0) f0 = 0
    const ft = this.numFrames > 1 ? fpos - f0 : 0

    const n = this.frameSize
    const idx = phase * n
    const i0 = idx | 0
    const st = idx - i0
    const i1 = i0 + 1 >= n ? 0 : i0 + 1

    const a = this.mips[f0 * NUM_MIPS + mip]
    const s0 = a[i0] + (a[i1] - a[i0]) * st
    if (ft === 0 || this.numFrames === 1) return s0
    const b = this.mips[(f0 + 1) * NUM_MIPS + mip]
    const s1 = b[i0] + (b[i1] - b[i0]) * st
    return s0 + (s1 - s0) * ft
  }
}

// ------------------------------------------------------------ envelope

const enum EnvStage { Idle, Delay, Attack, Hold, Decay, Sustain, Release, Kill }

export interface EnvParams {
  delay: number
  attack: number
  hold: number
  decay: number
  sustain: number
  release: number
  atkCurve: number
  decCurve: number
  relCurve: number
}

function curveShape(t: number, c: number): number {
  // c in -1..1 ; positive = slow start, negative = fast start
  return Math.pow(t, Math.pow(2, c * 3))
}

export class Envelope {
  private stage = EnvStage.Idle
  private t = 0 // seconds into current stage
  private level = 0
  private releaseFrom = 0
  private readonly dt: number

  constructor(sr: number, blockSize: number) {
    this.dt = blockSize / sr
  }

  trigger(): void {
    this.stage = EnvStage.Delay
    this.t = 0
  }

  gateOff(): void {
    if (this.stage !== EnvStage.Idle && this.stage !== EnvStage.Kill && this.stage !== EnvStage.Release) {
      this.releaseFrom = this.level
      this.stage = EnvStage.Release
      this.t = 0
    }
  }

  /** Fast fade for voice stealing. */
  kill(): void {
    if (this.stage !== EnvStage.Idle) {
      this.releaseFrom = this.level
      this.stage = EnvStage.Kill
      this.t = 0
    }
  }

  get idle(): boolean {
    return this.stage === EnvStage.Idle
  }
  get releasing(): boolean {
    return this.stage === EnvStage.Release || this.stage === EnvStage.Kill
  }
  get value(): number {
    return this.level
  }

  /** Advance one block and return the envelope level at the END of the block. */
  process(p: EnvParams): number {
    this.t += this.dt
    switch (this.stage) {
      case EnvStage.Idle:
        this.level = 0
        break
      case EnvStage.Delay:
        this.level = 0
        if (this.t >= p.delay) { this.stage = EnvStage.Attack; this.t = 0 }
        break
      case EnvStage.Attack:
        if (this.t >= p.attack) { this.level = 1; this.stage = EnvStage.Hold; this.t = 0 }
        else this.level = curveShape(this.t / p.attack, p.atkCurve)
        break
      case EnvStage.Hold:
        this.level = 1
        if (this.t >= p.hold) { this.stage = EnvStage.Decay; this.t = 0 }
        break
      case EnvStage.Decay:
        if (this.t >= p.decay) { this.level = p.sustain; this.stage = EnvStage.Sustain; this.t = 0 }
        else this.level = p.sustain + (1 - p.sustain) * (1 - curveShape(this.t / p.decay, -p.decCurve))
        break
      case EnvStage.Sustain:
        this.level = p.sustain
        break
      case EnvStage.Release:
        if (this.t >= p.release) { this.level = 0; this.stage = EnvStage.Idle }
        else this.level = this.releaseFrom * (1 - curveShape(this.t / p.release, -p.relCurve))
        break
      case EnvStage.Kill: {
        const killTime = 0.004
        if (this.t >= killTime) { this.level = 0; this.stage = EnvStage.Idle }
        else this.level = this.releaseFrom * (1 - this.t / killTime)
        break
      }
    }
    return this.level
  }
}

// ------------------------------------------------------------ LFO

export class Lfo {
  phase = 0
  private smoothed = 0
  private readonly dt: number

  constructor(sr: number, blockSize: number) {
    this.dt = blockSize / sr
  }

  trigger(startPhase: number): void {
    this.phase = startPhase % 1
    this.smoothed = 0
  }

  /**
   * Advance one block.
   * mode: 0 = Trigger (own phase), 1 = Free (follow globalPhase), 2 = Sync (beat-locked).
   */
  process(points: LfoPoint[], freq: number, mode: number, globalPhase: number, beatPhase: number, smooth: number): number {
    let ph: number
    if (mode === 1) ph = globalPhase
    else if (mode === 2) ph = beatPhase
    else {
      this.phase = (this.phase + freq * this.dt) % 1
      ph = this.phase
    }
    const raw = evalLfoShape(points, ph)
    if (smooth <= 0.001) {
      this.smoothed = raw
      return raw
    }
    // smoothing time constant up to ~250 ms
    const k = 1 - Math.exp(-this.dt / (smooth * 0.25))
    this.smoothed += (raw - this.smoothed) * k
    return this.smoothed
  }
}

// ------------------------------------------------------------ filters

/** Zavalishin TPT state-variable filter, one channel. */
class SvfChannel {
  ic1 = 0
  ic2 = 0

  process(x: number, g: number, k: number, mode: number): number {
    const a1 = 1 / (1 + g * (g + k))
    const a2 = g * a1
    const a3 = g * a2
    const v3 = x - this.ic2
    const v1 = a1 * this.ic1 + a2 * v3
    const v2 = this.ic2 + a2 * this.ic1 + a3 * v3
    this.ic1 = 2 * v1 - this.ic1
    this.ic2 = 2 * v2 - this.ic2
    const lp = v2
    const bp = v1
    const hp = x - k * v1 - v2
    switch (mode) {
      case 0: return lp
      case 1: return hp
      case 2: return bp * k // gain-compensated bandpass
      default: return x - k * bp // notch
    }
  }

  reset(): void {
    this.ic1 = 0
    this.ic2 = 0
  }
}

const COMB_SIZE = 4096

/**
 * One voice filter slot: SVF (12/24 dB LP/HP/BP/Notch), feedback comb, or
 * 3-band formant. Stereo.
 */
export class VoiceFilter {
  private s1 = [new SvfChannel(), new SvfChannel()]
  private s2 = [new SvfChannel(), new SvfChannel()]
  private formant: SvfChannel[][] = [
    [new SvfChannel(), new SvfChannel(), new SvfChannel()],
    [new SvfChannel(), new SvfChannel(), new SvfChannel()]
  ]
  private comb: Float32Array[] = [new Float32Array(COMB_SIZE), new Float32Array(COMB_SIZE)]
  private combPos = 0
  private combLp = [0, 0]
  private readonly sr: number

  constructor(sr: number) {
    this.sr = sr
  }

  reset(): void {
    for (const c of this.s1) c.reset()
    for (const c of this.s2) c.reset()
    for (const row of this.formant) for (const c of row) c.reset()
    this.comb[0].fill(0)
    this.comb[1].fill(0)
    this.combLp[0] = this.combLp[1] = 0
    this.combPos = 0
  }

  /**
   * Process a stereo block in place.
   * type: FILTER_TYPES index. drive 0..1, mix 0..1.
   */
  process(l: Float32Array, r: Float32Array, n: number, type: number, cutoff: number, res: number, drive: number, mix: number): void {
    const driveGain = 1 + drive * 9
    const driveComp = 1 / Math.sqrt(driveGain)
    const wet = mix
    const dry = 1 - mix

    if (type <= 6) {
      // SVF family: 0 LP12,1 LP24,2 HP12,3 HP24,4 BP12,5 BP24,6 Notch
      const mode = type <= 1 ? 0 : type <= 3 ? 1 : type <= 5 ? 2 : 3
      const twoPole = type === 1 || type === 3 || type === 5
      const fc = Math.min(Math.max(cutoff, 10), this.sr * 0.49)
      const g = Math.tan((Math.PI * fc) / this.sr)
      const k = 2 - 1.98 * Math.min(res, 0.99)
      for (let ch = 0; ch < 2; ch++) {
        const buf = ch === 0 ? l : r
        const f1 = this.s1[ch]
        const f2 = this.s2[ch]
        for (let i = 0; i < n; i++) {
          const x = drive > 0.001 ? Math.tanh(buf[i] * driveGain) * driveComp : buf[i]
          let y = f1.process(x, g, k, mode)
          if (twoPole) y = f2.process(y, g, Math.max(k, 1.0), mode)
          buf[i] = dry * buf[i] + wet * y
        }
      }
      return
    }

    if (type === 7) {
      // feedback comb, cutoff -> delay length, res -> feedback, fixed damping
      const delay = Math.min(COMB_SIZE - 2, Math.max(2, this.sr / Math.max(cutoff, 20)))
      const fb = 0.5 + res * 0.48
      for (let i = 0; i < n; i++) {
        const readPos = (this.combPos - delay + COMB_SIZE) % COMB_SIZE
        const ri = readPos | 0
        const rf = readPos - ri
        for (let ch = 0; ch < 2; ch++) {
          const buf = ch === 0 ? l : r
          const cb = this.comb[ch]
          const dl = cb[ri] + (cb[(ri + 1) % COMB_SIZE] - cb[ri]) * rf
          this.combLp[ch] += (dl - this.combLp[ch]) * 0.6
          const x = drive > 0.001 ? Math.tanh(buf[i] * driveGain) * driveComp : buf[i]
          const y = x + this.combLp[ch] * fb
          cb[this.combPos] = y
          buf[i] = dry * buf[i] + wet * y * 0.5
        }
        this.combPos = (this.combPos + 1) % COMB_SIZE
      }
      return
    }

    // formant: morph A-E-I-O-U with cutoff position, res narrows bandwidth
    const vowels = [
      [800, 1150, 2900],
      [400, 2000, 2800],
      [250, 2300, 3000],
      [400, 800, 2600],
      [350, 600, 2700]
    ]
    const norm = Math.min(Math.max(Math.log(cutoff / 20) / Math.log(1000), 0), 1) * (vowels.length - 1)
    const v0 = Math.min(Math.floor(norm), vowels.length - 2)
    const vt = norm - v0
    const k = 2 - 1.9 * Math.min(0.3 + res * 0.7, 0.99)
    for (let b = 0; b < 3; b++) {
      const f = vowels[v0][b] + (vowels[v0 + 1][b] - vowels[v0][b]) * vt
      const g = Math.tan((Math.PI * Math.min(f, this.sr * 0.45)) / this.sr)
      const gains = [1, 0.6, 0.35]
      for (let ch = 0; ch < 2; ch++) {
        const buf = ch === 0 ? l : r
        const svf = this.formant[ch][b]
        for (let i = 0; i < n; i++) {
          const x = b === 0 ? (drive > 0.001 ? Math.tanh(buf[i] * driveGain) * driveComp : buf[i]) : buf[i]
          const y = svf.process(x, g, k, 2) * gains[b] * 2.5
          if (b === 0) buf[i] = dry * buf[i] + wet * y
          else buf[i] += wet * y
        }
      }
    }
  }
}

// ------------------------------------------------------------ misc

let pinkState = [0, 0, 0]

/** Paul Kellet pink noise approximation (stateful, mono). */
export function pinkNoise(white: number): number {
  pinkState[0] = 0.99765 * pinkState[0] + white * 0.099046
  pinkState[1] = 0.963 * pinkState[1] + white * 0.2965164
  pinkState[2] = 0.57 * pinkState[2] + white * 1.0526913
  return (pinkState[0] + pinkState[1] + pinkState[2] + white * 0.1848) * 0.2
}

export function noteToFreq(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12)
}
