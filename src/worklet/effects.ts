// Global (post-voice-sum) stereo effects. Each effect processes a block in
// place; the processor calls them in the user-defined rack order.

function flush(x: number): number {
  return Math.abs(x) < 1e-20 ? 0 : x
}

// ------------------------------------------------------------ modulated delay core

class ModDelayLine {
  buf: Float32Array
  pos = 0
  constructor(size: number) {
    this.buf = new Float32Array(size)
  }
  write(x: number): void {
    this.buf[this.pos] = x
    this.pos = (this.pos + 1) % this.buf.length
  }
  /** Read `delay` samples back with linear interpolation (before this block's write). */
  read(delay: number): number {
    const size = this.buf.length
    let p = this.pos - delay
    while (p < 0) p += size
    const i0 = p | 0
    const frac = p - i0
    const i1 = (i0 + 1) % size
    return this.buf[i0] + (this.buf[i1] - this.buf[i0]) * frac
  }
}

// ------------------------------------------------------------ chorus

export class Chorus {
  private dl = [new ModDelayLine(8192), new ModDelayLine(8192)]
  private phase = 0
  constructor(private sr: number) {}

  process(l: Float32Array, r: Float32Array, n: number, rate: number, depth: number, mix: number): void {
    const base = 0.02 * this.sr
    const dep = depth * 0.008 * this.sr
    const inc = rate / this.sr
    for (let i = 0; i < n; i++) {
      this.phase = (this.phase + inc) % 1
      const lfoL = Math.sin(this.phase * 2 * Math.PI)
      const lfoR = Math.sin((this.phase + 0.25) * 2 * Math.PI)
      this.dl[0].write(l[i])
      this.dl[1].write(r[i])
      const wl = this.dl[0].read(base + dep * (1 + lfoL) + 1)
      const wr = this.dl[1].read(base + dep * (1 + lfoR) + 1)
      l[i] = l[i] * (1 - mix) + wl * mix
      r[i] = r[i] * (1 - mix) + wr * mix
    }
  }
}

// ------------------------------------------------------------ flanger

export class Flanger {
  private dl = [new ModDelayLine(4096), new ModDelayLine(4096)]
  private fb = [0, 0]
  private phase = 0
  constructor(private sr: number) {}

  process(l: Float32Array, r: Float32Array, n: number, rate: number, depth: number, feedback: number, mix: number): void {
    const min = 0.001 * this.sr
    const dep = depth * 0.006 * this.sr
    const inc = rate / this.sr
    for (let i = 0; i < n; i++) {
      this.phase = (this.phase + inc) % 1
      const tri = 1 - Math.abs(this.phase * 2 - 1) * 2 + 1 // 0..1 triangle
      const halfTri = (1 - Math.cos(this.phase * 2 * Math.PI)) * 0.5
      void tri
      const d = min + dep * halfTri + 1
      for (let ch = 0; ch < 2; ch++) {
        const buf = ch === 0 ? l : r
        this.dl[ch].write(buf[i] + this.fb[ch] * feedback)
        const w = this.dl[ch].read(d)
        this.fb[ch] = flush(w)
        buf[i] = buf[i] * (1 - mix) + w * mix
      }
    }
  }
}

// ------------------------------------------------------------ phaser

export class Phaser {
  private ap: number[][] = [new Array(6).fill(0), new Array(6).fill(0)]
  private fb = [0, 0]
  private phase = 0
  constructor(private sr: number) {}

  process(l: Float32Array, r: Float32Array, n: number, rate: number, depth: number, feedback: number, mix: number): void {
    const inc = rate / this.sr
    for (let i = 0; i < n; i++) {
      this.phase = (this.phase + inc) % 1
      for (let ch = 0; ch < 2; ch++) {
        const sweep = (1 - Math.cos((this.phase + ch * 0.25) * 2 * Math.PI)) * 0.5
        const f = 300 * Math.pow(2, sweep * depth * 4.5) // 300 Hz .. ~6.8 kHz
        const w = Math.min((Math.PI * f) / this.sr, 1.5)
        const a = (1 - Math.tan(w)) / (1 + Math.tan(w))
        const buf = ch === 0 ? l : r
        let x = buf[i] + this.fb[ch] * feedback
        const st = this.ap[ch]
        for (let s = 0; s < 6; s++) {
          const y = a * x + st[s]
          st[s] = x - a * y
          x = y
        }
        this.fb[ch] = flush(x)
        buf[i] = buf[i] * (1 - mix) + x * mix
      }
    }
  }
}

// ------------------------------------------------------------ delay

export class StereoDelay {
  private dl: [ModDelayLine, ModDelayLine]
  private smoothedDelay: number
  constructor(private sr: number) {
    this.dl = [new ModDelayLine(Math.ceil(sr * 2.5)), new ModDelayLine(Math.ceil(sr * 2.5))]
    this.smoothedDelay = sr * 0.35
  }

  process(l: Float32Array, r: Float32Array, n: number, timeSec: number, feedback: number, pingpong: boolean, mix: number): void {
    const target = Math.min(Math.max(timeSec * this.sr, 32), this.sr * 2.4)
    for (let i = 0; i < n; i++) {
      this.smoothedDelay += (target - this.smoothedDelay) * 0.0005
      const d = this.smoothedDelay
      const wl = this.dl[0].read(d)
      const wr = this.dl[1].read(d)
      if (pingpong) {
        this.dl[0].write(flush(l[i] * 0.5 + r[i] * 0.5 + wr * feedback))
        this.dl[1].write(flush(wl * feedback))
      } else {
        this.dl[0].write(flush(l[i] + wl * feedback))
        this.dl[1].write(flush(r[i] + wr * feedback))
      }
      l[i] = l[i] * (1 - mix * 0.5) + wl * mix
      r[i] = r[i] * (1 - mix * 0.5) + wr * mix
    }
  }
}

// ------------------------------------------------------------ reverb (Freeverb topology)

class Comb {
  buf: Float32Array
  pos = 0
  filterStore = 0
  constructor(size: number) {
    this.buf = new Float32Array(size)
  }
  process(x: number, feedback: number, damp: number): number {
    const out = this.buf[this.pos]
    this.filterStore = flush(out * (1 - damp) + this.filterStore * damp)
    this.buf[this.pos] = flush(x + this.filterStore * feedback)
    this.pos = (this.pos + 1) % this.buf.length
    return out
  }
}

class Allpass {
  buf: Float32Array
  pos = 0
  constructor(size: number) {
    this.buf = new Float32Array(size)
  }
  process(x: number): number {
    const bufOut = this.buf[this.pos]
    const out = -x + bufOut
    this.buf[this.pos] = flush(x + bufOut * 0.5)
    this.pos = (this.pos + 1) % this.buf.length
    return out
  }
}

const COMB_TUNINGS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
const ALLPASS_TUNINGS = [556, 441, 341, 225]
const STEREO_SPREAD = 23

export class Reverb {
  private combs: [Comb[], Comb[]]
  private allpasses: [Allpass[], Allpass[]]
  constructor(sr: number) {
    const scale = sr / 44100
    this.combs = [
      COMB_TUNINGS.map(t => new Comb(Math.round(t * scale))),
      COMB_TUNINGS.map(t => new Comb(Math.round((t + STEREO_SPREAD) * scale)))
    ]
    this.allpasses = [
      ALLPASS_TUNINGS.map(t => new Allpass(Math.round(t * scale))),
      ALLPASS_TUNINGS.map(t => new Allpass(Math.round((t + STEREO_SPREAD) * scale)))
    ]
  }

  process(l: Float32Array, r: Float32Array, n: number, size: number, damp: number, width: number, mix: number): void {
    const feedback = 0.7 + size * 0.28
    const dampC = damp * 0.4
    const wet1 = (mix * (1 + width)) / 2
    const wet2 = (mix * (1 - width)) / 2
    for (let i = 0; i < n; i++) {
      const input = (l[i] + r[i]) * 0.015
      let outL = 0
      let outR = 0
      for (let c = 0; c < 8; c++) {
        outL += this.combs[0][c].process(input, feedback, dampC)
        outR += this.combs[1][c].process(input, feedback, dampC)
      }
      for (let a = 0; a < 4; a++) {
        outL = this.allpasses[0][a].process(outL)
        outR = this.allpasses[1][a].process(outR)
      }
      l[i] = l[i] * (1 - mix) + outL * wet1 + outR * wet2
      r[i] = r[i] * (1 - mix) + outR * wet1 + outL * wet2
    }
  }
}

// ------------------------------------------------------------ 3-band EQ (RBJ biquads)

class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0
  private x1 = [0, 0]; private x2 = [0, 0]; private y1 = [0, 0]; private y2 = [0, 0]

  lowShelf(sr: number, f: number, gainDb: number): void {
    const A = Math.pow(10, gainDb / 40)
    const w = (2 * Math.PI * f) / sr
    const cs = Math.cos(w)
    const sn = Math.sin(w)
    const beta = Math.sqrt(A) / 0.9
    const b0 = A * (A + 1 - (A - 1) * cs + beta * sn)
    const b1 = 2 * A * (A - 1 - (A + 1) * cs)
    const b2 = A * (A + 1 - (A - 1) * cs - beta * sn)
    const a0 = A + 1 + (A - 1) * cs + beta * sn
    const a1 = -2 * (A - 1 + (A + 1) * cs)
    const a2 = A + 1 + (A - 1) * cs - beta * sn
    this.set(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)
  }

  highShelf(sr: number, f: number, gainDb: number): void {
    const A = Math.pow(10, gainDb / 40)
    const w = (2 * Math.PI * f) / sr
    const cs = Math.cos(w)
    const sn = Math.sin(w)
    const beta = Math.sqrt(A) / 0.9
    const b0 = A * (A + 1 + (A - 1) * cs + beta * sn)
    const b1 = -2 * A * (A - 1 + (A + 1) * cs)
    const b2 = A * (A + 1 + (A - 1) * cs - beta * sn)
    const a0 = A + 1 - (A - 1) * cs + beta * sn
    const a1 = 2 * (A - 1 - (A + 1) * cs)
    const a2 = A + 1 - (A - 1) * cs - beta * sn
    this.set(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)
  }

  peak(sr: number, f: number, gainDb: number, q: number): void {
    const A = Math.pow(10, gainDb / 40)
    const w = (2 * Math.PI * f) / sr
    const alpha = Math.sin(w) / (2 * q)
    const cs = Math.cos(w)
    const b0 = 1 + alpha * A
    const b1 = -2 * cs
    const b2 = 1 - alpha * A
    const a0 = 1 + alpha / A
    const a1 = -2 * cs
    const a2 = 1 - alpha / A
    this.set(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)
  }

  private set(b0: number, b1: number, b2: number, a1: number, a2: number): void {
    this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2
  }

  processCh(x: number, ch: number): number {
    const y = this.b0 * x + this.b1 * this.x1[ch] + this.b2 * this.x2[ch] - this.a1 * this.y1[ch] - this.a2 * this.y2[ch]
    this.x2[ch] = this.x1[ch]
    this.x1[ch] = x
    this.y2[ch] = this.y1[ch]
    this.y1[ch] = flush(y)
    return y
  }
}

export class Eq3 {
  private low = new Biquad()
  private mid = new Biquad()
  private high = new Biquad()
  constructor(private sr: number) {}

  process(l: Float32Array, r: Float32Array, n: number, lowDb: number, midDb: number, midFreq: number, highDb: number): void {
    this.low.lowShelf(this.sr, 250, lowDb)
    this.mid.peak(this.sr, midFreq, midDb, 0.7)
    this.high.highShelf(this.sr, 4000, highDb)
    for (let i = 0; i < n; i++) {
      l[i] = this.high.processCh(this.mid.processCh(this.low.processCh(l[i], 0), 0), 0)
      r[i] = this.high.processCh(this.mid.processCh(this.low.processCh(r[i], 1), 1), 1)
    }
  }
}

// ------------------------------------------------------------ compressor

export class Compressor {
  private env = 0
  constructor(private sr: number) {}

  process(l: Float32Array, r: Float32Array, n: number, thresholdDb: number, ratio: number, attack: number, release: number, makeupDb: number): void {
    const atkC = Math.exp(-1 / (attack * this.sr))
    const relC = Math.exp(-1 / (release * this.sr))
    const makeup = Math.pow(10, makeupDb / 20)
    for (let i = 0; i < n; i++) {
      const peak = Math.max(Math.abs(l[i]), Math.abs(r[i]))
      const coeff = peak > this.env ? atkC : relC
      this.env = flush(coeff * this.env + (1 - coeff) * peak)
      const envDb = 20 * Math.log10(Math.max(this.env, 1e-6))
      let gainDb = 0
      if (envDb > thresholdDb) gainDb = (thresholdDb - envDb) * (1 - 1 / ratio)
      const g = Math.pow(10, gainDb / 20) * makeup
      l[i] *= g
      r[i] *= g
    }
  }
}

// ------------------------------------------------------------ distortion fx

export class FxDistortion {
  private lp = [0, 0]
  constructor(private sr: number) {}

  process(l: Float32Array, r: Float32Array, n: number, drive: number, tone: number, mix: number): void {
    const gain = 1 + drive * 30
    const comp = 1 / Math.pow(gain, 0.6)
    const k = 1 - Math.exp((-2 * Math.PI * tone) / this.sr)
    for (let i = 0; i < n; i++) {
      for (let ch = 0; ch < 2; ch++) {
        const buf = ch === 0 ? l : r
        const shaped = Math.tanh(buf[i] * gain) * comp
        this.lp[ch] += (shaped - this.lp[ch]) * k
        buf[i] = buf[i] * (1 - mix) + this.lp[ch] * mix
      }
    }
  }
}
