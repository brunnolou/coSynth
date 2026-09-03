/**
 * Every signal here is synthesized in-process, so the assertions are about the detector and
 * nothing else. The two things worth guarding are symmetric: it must find the pitch that is
 * there (sines across five octaves, to within a cent), and it must refuse when there is none
 * (noise, a kick, silence) or when the fundamental is weak enough to tempt an octave error.
 */

import { describe, expect, it } from 'vitest'
import { detectPitch } from './pitch'
import { hzToMidi } from './notes'

const SR = 44100

function render(seconds: number, sampleRate: number, fn: (t: number, i: number) => number): Float32Array {
  const n = Math.round(seconds * sampleRate)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = fn(i / sampleRate, i)
  return out
}

const sine = (hz: number, seconds = 1, sampleRate = SR, amp = 0.8) =>
  render(seconds, sampleRate, (t) => amp * Math.sin(2 * Math.PI * hz * t))

/**
 * Additive synthesis is O(harmonics x samples), and a 37 Hz saw taken all the way to Nyquist
 * is ~600 partials over 2 s - slow enough to trip vitest's own timeout when the suite runs in
 * parallel. 40 partials reach 1.5 kHz even at 37 Hz, well past anything the detector reads.
 */
const MAX_PARTIALS = 40

/** Bandlimited saw: every harmonic, 1/n amplitude. */
const saw = (hz: number, seconds = 1, sampleRate = SR) =>
  render(seconds, sampleRate, (t) => {
    let v = 0
    for (let n = 1; n <= MAX_PARTIALS && n * hz < sampleRate / 2; n++) {
      v += Math.sin(2 * Math.PI * n * hz * t) / n
    }
    return 0.5 * v
  })

/** Bandlimited square: odd harmonics only. */
const square = (hz: number, seconds = 1, sampleRate = SR) =>
  render(seconds, sampleRate, (t) => {
    let v = 0
    for (let n = 1; n <= MAX_PARTIALS && n * hz < sampleRate / 2; n += 2) {
      v += Math.sin(2 * Math.PI * n * hz * t) / n
    }
    return 0.5 * v
  })

/** Harmonics 2..8 only - the fundamental is absent, the pitch is still `hz`. */
const missingFundamental = (hz: number, seconds = 1, sampleRate = SR) =>
  render(seconds, sampleRate, (t) => {
    let v = 0
    for (let n = 2; n <= 8; n++) v += Math.sin(2 * Math.PI * n * hz * t) / n
    return 0.6 * v
  })

/** Deterministic white noise, so a bad day for the RNG cannot flake the suite. */
const noise = (seconds = 1, sampleRate = SR) => {
  let seed = 12345
  return render(seconds, sampleRate, () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return (seed / 0x3fffffff - 1) * 0.7
  })
}

/**
 * The classic synthetic kick: a sine whose pitch dives from ~245 Hz to 45 Hz under a fast
 * amplitude decay, plus a noise click. It has no steady period while it is loud enough to
 * measure, which is exactly why a detector must refuse it rather than name its tail.
 */
const kick = (seconds = 0.25, sampleRate = SR) => {
  let phase = 0
  let seed = 999
  return render(seconds, sampleRate, (t) => {
    const hz = 45 + 200 * Math.exp(-t * 15)
    phase += (2 * Math.PI * hz) / sampleRate
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const click = (seed / 0x3fffffff - 1) * Math.exp(-t * 400) * 0.5
    return (Math.sin(phase) + click) * Math.exp(-t * 40)
  })
}

const decaying = (hz: number, seconds = 1.5, sampleRate = SR) =>
  render(seconds, sampleRate, (t) => 0.9 * Math.sin(2 * Math.PI * hz * t) * Math.exp(-t * 3))

/** 6 Hz vibrato, +/-30 cents, on a saw. */
const vibrato = (hz: number, seconds = 1.5, sampleRate = SR) => {
  let phase = 0
  return render(seconds, sampleRate, (t) => {
    const f = hz * Math.pow(2, (0.3 * Math.sin(2 * Math.PI * 6 * t)) / 12)
    phase += (2 * Math.PI * f) / sampleRate
    let v = 0
    for (let n = 1; n <= 12; n++) v += Math.sin(n * phase) / n
    return 0.5 * v
  })
}

const centsOff = (hz: number, target: number) => Math.abs(1200 * Math.log2(hz / target))

describe('detectPitch', () => {
  it.each([55, 110, 440, 1000, 2000])('locks a %d Hz sine to within a cent', (hz) => {
    const got = detectPitch([sine(hz)], SR)
    expect(got).not.toBeNull()
    expect(centsOff(got!.f0Hz, hz)).toBeLessThan(1)
    expect(got!.midi).toBe(Math.round(hzToMidi(hz)))
    expect(got!.source).toBe('detected')
    expect(got!.confidence).toBeGreaterThan(0.85)
  })

  // The regression that started this work: pitchy alone answered an octave (or more) high on
  // low tones with a weak or short fundamental. 37 Hz is D1, MIDI 26 - never 38.
  it('resolves a 37 Hz saw to D1, not an octave up', () => {
    const got = detectPitch([saw(37, 2)], SR)
    expect(got).not.toBeNull()
    expect(got!.midi).toBe(26)
    expect(centsOff(got!.f0Hz, 37)).toBeLessThan(30)
  })

  it('resolves a 37 Hz sine to D1, not an octave up', () => {
    const got = detectPitch([sine(37, 2)], SR)
    expect(got).not.toBeNull()
    expect(got!.midi).toBe(26)
    expect(centsOff(got!.f0Hz, 37)).toBeLessThan(30)
  })

  it('gives a saw and a square at 220 Hz the same f0', () => {
    const a = detectPitch([saw(220)], SR)
    const b = detectPitch([square(220)], SR)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(centsOff(a!.f0Hz, b!.f0Hz)).toBeLessThan(5)
    expect(a!.midi).toBe(57)
    expect(b!.midi).toBe(57)
  })

  it('is sample-rate independent', () => {
    const at44 = detectPitch([sine(330, 1, 44100)], 44100)
    const at48 = detectPitch([sine(330, 1, 48000)], 48000)
    expect(at44).not.toBeNull()
    expect(at48).not.toBeNull()
    expect(centsOff(at44!.f0Hz, at48!.f0Hz)).toBeLessThan(2)
  })

  it('tracks a decaying tone', () => {
    const got = detectPitch([decaying(196)], SR)
    expect(got).not.toBeNull()
    expect(centsOff(got!.f0Hz, 196)).toBeLessThan(10)
  })

  it('follows a vibrato tone to its centre pitch', () => {
    const got = detectPitch([vibrato(146.83)], SR)
    expect(got).not.toBeNull()
    expect(centsOff(got!.f0Hz, 146.83)).toBeLessThan(40)
  })

  it('either finds the true pitch of a missing fundamental or refuses, never an octave up', () => {
    const got = detectPitch([missingFundamental(110, 2)], SR)
    // Refusing is a legitimate answer here; answering 220 Hz is not.
    if (got) expect(centsOff(got.f0Hz, 110)).toBeLessThan(50)
  })

  it('refuses white noise', () => {
    expect(detectPitch([noise()], SR)).toBeNull()
  })

  it('refuses a synthetic kick drum', () => {
    expect(detectPitch([kick()], SR)).toBeNull()
  })

  it('refuses digital silence', () => {
    expect(detectPitch([new Float32Array(SR)], SR)).toBeNull()
  })

  it('does not throw on a buffer shorter than one window', () => {
    for (const n of [0, 1, 64, 1023, 2048, 4095]) {
      expect(() => detectPitch([sine(440, n / SR)], SR)).not.toThrow()
    }
  })

  it('mixes stereo channels to mono before detecting', () => {
    const got = detectPitch([sine(440), sine(440)], SR)
    expect(got).not.toBeNull()
    expect(centsOff(got!.f0Hz, 440)).toBeLessThan(1)
  })

  it('refuses when the tone sits outside the supplied range', () => {
    expect(detectPitch([sine(440)], SR, { minHz: 600, maxHz: 5000 })).toBeNull()
    expect(detectPitch([sine(440)], SR, { minHz: 20, maxHz: 300 })).toBeNull()
  })

  it('refuses no channels at all', () => {
    expect(detectPitch([], SR)).toBeNull()
  })
})
