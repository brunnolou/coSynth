// Wavetable generation and import.
//
// A wavetable is `numFrames` single cycles of FRAME_SIZE samples. Built-in
// tables are generated from formulas / additive recipes; intermediate frames
// are produced by FFT-based spectral morphing between key frames (magnitudes
// and phases interpolated in the frequency domain), which is what gives
// wavetable "morph" sweeps their smooth spectral motion.

import { fft, ifft, resampleCycle, bandlimitCycle } from './fft'

export const FRAME_SIZE = 2048

/** Number of band-limited mip levels per frame (max harmonic = 1024 >> mip). */
export const NUM_MIPS = 11

/**
 * Build the band-limited mip pyramid for a wavetable. Runs on the main thread
 * so table swaps never stall the audio thread; the result is transferred to
 * the worklet. Layout: [(frame * NUM_MIPS + mip) * frameSize ...].
 */
export function buildMips(data: Float32Array, frameSize: number, numFrames: number): Float32Array {
  const out = new Float32Array(numFrames * NUM_MIPS * frameSize)
  for (let f = 0; f < numFrames; f++) {
    const cycle = data.subarray(f * frameSize, (f + 1) * frameSize)
    for (let m = 0; m < NUM_MIPS; m++) {
      const dst = (f * NUM_MIPS + m) * frameSize
      if (m === 0) out.set(cycle, dst)
      else out.set(bandlimitCycle(cycle as Float32Array, Math.max(1, (frameSize >> 1) >> m)), dst)
    }
  }
  return out
}

export interface Wavetable {
  name: string
  frameSize: number
  numFrames: number
  /** numFrames * frameSize, frames concatenated. */
  data: Float32Array
}

function normalizeTable(data: Float32Array): void {
  let peak = 0
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]))
  if (peak > 1e-9) {
    const g = 1 / peak
    for (let i = 0; i < data.length; i++) data[i] *= g
  }
}

/**
 * FFT-based spectral morph: given key frames, produce `numFrames` frames whose
 * spectra interpolate linearly (magnitude + phase, shortest-path) between
 * consecutive key frames.
 */
export function spectralMorph(keyFrames: Float32Array[], numFrames: number): Float32Array {
  const n = FRAME_SIZE
  const half = n >> 1
  const specs = keyFrames.map(f => {
    const re = new Float32Array(f)
    const im = new Float32Array(n)
    fft(re, im)
    const mag = new Float32Array(half)
    const phase = new Float32Array(half)
    for (let k = 0; k < half; k++) {
      mag[k] = Math.hypot(re[k], im[k])
      phase[k] = Math.atan2(im[k], re[k])
    }
    return { mag, phase }
  })

  const out = new Float32Array(numFrames * n)
  const re = new Float32Array(n)
  const im = new Float32Array(n)
  for (let f = 0; f < numFrames; f++) {
    const pos = numFrames === 1 ? 0 : (f / (numFrames - 1)) * (specs.length - 1)
    const i0 = Math.min(Math.floor(pos), specs.length - 1)
    const i1 = Math.min(i0 + 1, specs.length - 1)
    const t = pos - i0
    re.fill(0)
    im.fill(0)
    for (let k = 1; k < half; k++) {
      const m = specs[i0].mag[k] + (specs[i1].mag[k] - specs[i0].mag[k]) * t
      let p0 = specs[i0].phase[k]
      let p1 = specs[i1].phase[k]
      let dp = p1 - p0
      if (dp > Math.PI) dp -= 2 * Math.PI
      if (dp < -Math.PI) dp += 2 * Math.PI
      const ph = p0 + dp * t
      re[k] = m * Math.cos(ph)
      im[k] = m * Math.sin(ph)
      re[n - k] = re[k]
      im[n - k] = -im[k]
    }
    ifft(re, im)
    out.set(re, f * n)
  }
  normalizeTable(out)
  return out
}

// ------------------------------------------------------------ key-frame recipes

function additive(harmonics: (k: number) => number, count = 512): Float32Array {
  const n = FRAME_SIZE
  const re = new Float32Array(n)
  const im = new Float32Array(n)
  const half = n >> 1
  for (let k = 1; k <= Math.min(count, half - 1); k++) {
    const a = harmonics(k)
    if (a === 0) continue
    // sine phase: X[k] = -i * a  =>  im[k] = -a/2 scaled; use im directly
    im[k] = (-a * n) / 2
    im[n - k] = (a * n) / 2
  }
  ifft(re, im)
  return re
}

const sineFrame = () => additive(k => (k === 1 ? 1 : 0))
const triFrame = () => additive(k => (k % 2 === 1 ? ((k % 4 === 1 ? 1 : -1) * 8) / (Math.PI * Math.PI * k * k) : 0))
const sawFrame = () => additive(k => (2 / Math.PI) * (1 / k), 800)
const squareFrame = () => additive(k => (k % 2 === 1 ? 4 / (Math.PI * k) : 0), 800)

function pwmFrame(width: number): Float32Array {
  return additive(k => ((2 / (Math.PI * k)) * Math.sin(Math.PI * k * width)) * 2, 600)
}

function fmFrame(index: number, ratio: number): Float32Array {
  const n = FRAME_SIZE
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const ph = (i / n) * 2 * Math.PI
    out[i] = Math.sin(ph + index * Math.sin(ratio * ph))
  }
  return out
}

function vocalFrame(f1: number, f2: number, f3: number): Float32Array {
  // Additive frame with resonance peaks at three "formants" (harmonic numbers).
  return additive(k => {
    const peak = (c: number, w: number) => Math.exp(-((k - c) * (k - c)) / (2 * w * w))
    return (1 / Math.sqrt(k)) * (peak(f1, 2) + 0.7 * peak(f2, 3) + 0.4 * peak(f3, 4))
  }, 128)
}

function digitalFrame(seed: number): Float32Array {
  // Deterministic pseudo-random hard-edged steps — a gritty "digital" table.
  const n = FRAME_SIZE
  const out = new Float32Array(n)
  let s = seed >>> 0
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff) * 2 - 1
  const steps = 8 + (seed % 24)
  const levels: number[] = []
  for (let i = 0; i < steps; i++) levels.push(rand())
  for (let i = 0; i < n; i++) out[i] = levels[Math.floor((i / n) * steps)]
  // remove DC
  let mean = 0
  for (let i = 0; i < n; i++) mean += out[i]
  mean /= n
  for (let i = 0; i < n; i++) out[i] -= mean
  return out
}

// ------------------------------------------------------------ built-in tables

export function generateWavetable(name: string): Wavetable {
  let data: Float32Array
  let numFrames = 32
  switch (name) {
    case 'Basic Shapes':
      data = spectralMorph([sineFrame(), triFrame(), sawFrame(), squareFrame()], numFrames)
      break
    case 'Harmonic Sweep':
      data = spectralMorph(
        [1, 2, 4, 8, 16, 32].map(h => additive(k => (k <= h ? 1 / Math.sqrt(k) : 0), 64)),
        numFrames
      )
      break
    case 'PWM': {
      numFrames = 32
      data = new Float32Array(numFrames * FRAME_SIZE)
      for (let f = 0; f < numFrames; f++) {
        const width = 0.5 - (f / (numFrames - 1)) * 0.45
        data.set(pwmFrame(width), f * FRAME_SIZE)
      }
      normalizeTable(data)
      break
    }
    case 'Vocal':
      data = spectralMorph(
        [vocalFrame(6, 9, 22), vocalFrame(4, 16, 24), vocalFrame(2, 20, 28), vocalFrame(3, 7, 21), vocalFrame(2, 6, 18)],
        numFrames
      )
      break
    case 'FM Bell':
      data = spectralMorph(
        [fmFrame(0.5, 2), fmFrame(2, 2), fmFrame(4, 3.01), fmFrame(7, 5)],
        numFrames
      )
      break
    case 'Digital':
      data = spectralMorph([digitalFrame(7), digitalFrame(1234), digitalFrame(9876), digitalFrame(31415)], numFrames)
      break
    default:
      data = spectralMorph([sineFrame(), sawFrame()], numFrames)
  }
  return { name, frameSize: FRAME_SIZE, numFrames, data }
}

// ------------------------------------------------------------ WAV import

export interface DecodedWav {
  sampleRate: number
  channelData: Float32Array // mono mixdown
}

/** Minimal RIFF/WAVE parser: PCM 16/24/32-bit int and 32-bit float. */
export function decodeWav(buf: ArrayBuffer): DecodedWav {
  const dv = new DataView(buf)
  const tag = (off: number) => String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file')

  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null
  let dataOff = -1
  let dataLen = 0
  let off = 12
  while (off + 8 <= dv.byteLength) {
    const id = tag(off)
    const size = dv.getUint32(off + 4, true)
    if (id === 'fmt ') {
      fmt = {
        format: dv.getUint16(off + 8, true),
        channels: dv.getUint16(off + 10, true),
        sampleRate: dv.getUint32(off + 12, true),
        bits: dv.getUint16(off + 22, true)
      }
    } else if (id === 'data') {
      dataOff = off + 8
      dataLen = size
    }
    off += 8 + size + (size & 1)
  }
  if (!fmt || dataOff < 0) throw new Error('malformed WAV (missing fmt/data chunk)')
  const { format, channels, bits } = fmt
  const bytesPer = bits / 8
  const frames = Math.floor(dataLen / (bytesPer * channels))
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) {
      const o = dataOff + (i * channels + c) * bytesPer
      let v: number
      if (format === 3 && bits === 32) v = dv.getFloat32(o, true)
      else if (bits === 16) v = dv.getInt16(o, true) / 32768
      else if (bits === 24) {
        const b0 = dv.getUint8(o)
        const b1 = dv.getUint8(o + 1)
        const b2 = dv.getUint8(o + 2)
        let x = (b2 << 16) | (b1 << 8) | b0
        if (x & 0x800000) x -= 0x1000000
        v = x / 8388608
      } else if (bits === 32) v = dv.getInt32(o, true) / 2147483648
      else if (bits === 8) v = (dv.getUint8(o) - 128) / 128
      else throw new Error(`unsupported WAV bit depth: ${bits}`)
      sum += v
    }
    out[i] = sum / channels
  }
  return { sampleRate: fmt.sampleRate, channelData: out }
}

/**
 * Interpret a decoded WAV as a wavetable:
 * - length divisible into 2048-sample cycles (Serum-style concatenated frames)
 *   -> frames used directly (capped at 256).
 * - anything else -> treated as one single cycle, FFT-resampled to 2048, and
 *   expanded into a small table by progressive low-pass morphing.
 */
export function wavToWavetable(name: string, wav: DecodedWav): Wavetable {
  const d = wav.channelData
  if (d.length >= FRAME_SIZE && d.length % FRAME_SIZE === 0) {
    const numFrames = Math.min(d.length / FRAME_SIZE, 256)
    const data = new Float32Array(d.subarray(0, numFrames * FRAME_SIZE))
    normalizeTable(data)
    return { name, frameSize: FRAME_SIZE, numFrames, data }
  }
  const cycle = resampleCycle(d, FRAME_SIZE)
  const data = spectralMorph([sineFrame(), cycle], 16)
  return { name, frameSize: FRAME_SIZE, numFrames: 16, data }
}
