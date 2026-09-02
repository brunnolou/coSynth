import { describe, expect, it } from 'vitest'
import {
  analyzeAudio, compareAudioMetrics,
  type AudioMetrics, type ComparedMetricKey, type SpectralWindow
} from './audio-analysis'

function sine(frequency: number, sampleRate: number, seconds: number, amplitude = 1, phase = 0): Float32Array {
  return Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_, i) =>
    amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate + phase))
}

/** 440 Hz tone with a linear attack and an exponential decay of the given T60. */
function pluck(sampleRate: number, seconds: number, attackSeconds: number, t60Seconds: number): Float32Array {
  const decay = Math.log(1000) / t60Seconds
  return Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_, i) => {
    const t = i / sampleRate
    const attack = attackSeconds > 0 ? Math.min(1, t / attackSeconds) : 1
    return attack * Math.exp(-decay * t) * Math.sin(2 * Math.PI * 440 * t)
  })
}

/**
 * Two sines 1 Hz apart, phased so the unison beat peaks a third of a second in -
 * the shape that made the old rectified-sample attack report hundreds of ms.
 */
function beating(sampleRate: number, seconds: number, attackSeconds: number): Float32Array {
  return Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_, i) => {
    const t = i / sampleRate
    const attack = attackSeconds > 0 ? Math.min(1, t / attackSeconds) : 1
    const first = Math.sin(2 * Math.PI * 441 * t - 2 * Math.PI / 3)
    const second = Math.sin(2 * Math.PI * 440 * t)
    return attack * 0.4 * (first + second)
  })
}

/** A 220 Hz tone with a linear attack of the given length, then a steady sustain. */
function swell(attackMs: number, sampleRate: number, seconds: number): Float32Array {
  const attackSeconds = attackMs / 1000
  return Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_, i) => {
    const t = i / sampleRate
    return 0.5 * Math.min(1, t / attackSeconds) * Math.sin(2 * Math.PI * 220 * t)
  })
}

/** Band-limited sawtooth: partial n has amplitude 1/n, so partial levels fall 6 dB per octave. */
function sawtooth(frequency: number, sampleRate: number, seconds: number, amplitude = 0.5): Float32Array {
  const partials = Math.floor(sampleRate / 2 / frequency)
  return Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_, i) => {
    const t = i / sampleRate
    let value = 0
    for (let n = 1; n <= partials; n++) value += Math.sin(2 * Math.PI * frequency * n * t) / n
    return amplitude * value * 2 / Math.PI
  })
}

/**
 * Twelve partials at n·f0·√(1 + B·n²) with 1/n amplitudes, optionally under a 5 ms attack
 * and an exponential decay - the shape a real plucked note has, which is what the harmonic
 * peak-picking has to survive.
 */
function stretchedPartials(
  f0: number,
  inharmonicity: number,
  sampleRate: number,
  seconds: number,
  options: { decayT60Seconds?: number } = {}
): Float32Array {
  const { decayT60Seconds } = options
  const decay = decayT60Seconds ? Math.log(1000) / decayT60Seconds : 0
  return Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_, i) => {
    const t = i / sampleRate
    const envelope = decayT60Seconds ? Math.min(1, t / 0.005) * Math.exp(-decay * t) : 1
    let value = 0
    for (let n = 1; n <= 12; n++) {
      value += Math.sin(2 * Math.PI * f0 * n * Math.sqrt(1 + inharmonicity * n * n) * t) / n
    }
    return 0.4 * envelope * value
  })
}

/**
 * One-pole low-pass whose cutoff falls exponentially from `startHz` to `endHz` across the
 * buffer - a brightness decay, the `env -> cutoff` route an agent cannot otherwise verify.
 */
function sweepingLowpass(source: Float32Array, sampleRate: number, startHz: number, endHz: number): Float32Array {
  const out = new Float32Array(source.length)
  let state = 0
  for (let i = 0; i < source.length; i++) {
    const cutoff = startHz * (endHz / startHz) ** (i / (source.length - 1))
    state += (1 - Math.exp(-2 * Math.PI * cutoff / sampleRate)) * (source[i] - state)
    out[i] = state
  }
  return out
}

/**
 * Twelve partials where partial n decays n times as fast as the fundamental - a piano's
 * defining behaviour, and invisible in a whole-buffer `harmonics.amplitudesDb` snapshot.
 */
function fasterUpperPartialDecay(
  f0: number,
  sampleRate: number,
  seconds: number,
  t60Seconds: number
): Float32Array {
  const base = Math.log(1000) / t60Seconds
  return Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_, i) => {
    const t = i / sampleRate
    let value = 0
    for (let n = 1; n <= 12; n++) value += Math.exp(-base * n * t) * Math.sin(2 * Math.PI * f0 * n * t) / n
    return 0.3 * Math.min(1, t / 0.005) * value
  })
}

describe('analyzeAudio', () => {
  it('measures peak, RMS, clipping, DC, and spectral centroid', () => {
    const sampleRate = 8192
    const signal = sine(1024, sampleRate, 1, 0.5)
    const metrics = analyzeAudio([signal], sampleRate)
    expect(metrics.peakDb).toBeCloseTo(-6.0206, 2)
    expect(metrics.rmsDb).toBeCloseTo(-9.0309, 2)
    expect(metrics.clippingCount).toBe(0)
    expect(metrics.dcOffset).toBeCloseTo(0, 5)
    expect(metrics.spectralCentroidHz).toBeCloseTo(1024, 0)
  })

  it('counts clipped samples and reports DC offset', () => {
    const metrics = analyzeAudio([new Float32Array([1, -1.2, 0.5, 0.5])], 1000)
    expect(metrics.clippingCount).toBe(2)
    expect(metrics.dcOffset).toBeCloseTo(0.2, 5)
    expect(metrics.peakDb).toBeGreaterThan(0)
  })

  it('finds 10%-to-90% attack time', () => {
    const sampleRate = 1000
    const signal = Float32Array.from({ length: 200 }, (_, i) => i < 100 ? i / 100 : 1)
    expect(analyzeAudio([signal], sampleRate).attackMs).toBeCloseTo(80, 0)
  })

  it('distinguishes mono and anti-phase stereo width', () => {
    const left = sine(200, 4096, 1, 0.5)
    const same = analyzeAudio([left, new Float32Array(left)], 4096)
    const opposite = analyzeAudio([left, Float32Array.from(left, value => -value)], 4096)
    expect(same.stereoWidth).toBeCloseTo(0, 5)
    expect(opposite.stereoWidth).toBeCloseTo(1, 5)
  })

  it('analyzes a tone that begins after 500ms instead of only the render prefix', () => {
    const sampleRate = 48000
    const signal = new Float32Array(sampleRate)
    for (let index = Math.round(sampleRate * 0.6); index < signal.length; index++) {
      signal[index] = 0.5 * Math.sin(2 * Math.PI * 3000 * index / sampleRate)
    }
    expect(analyzeAudio([signal], sampleRate).spectralCentroidHz).toBeCloseTo(3000, -1)
  })

  it('finds a short tone between the old sparse windows in a 15-second render', () => {
    const sampleRate = 48000
    const signal = new Float32Array(sampleRate * 15)
    for (let index = sampleRate * 0.5; index < sampleRate * 0.55; index++) {
      signal[index] = 0.5 * Math.sin(2 * Math.PI * 3000 * index / sampleRate)
    }
    expect(analyzeAudio([signal], sampleRate).spectralCentroidHz).toBeCloseTo(3000, -1)
  })

  it('preserves envelope metrics for anti-phase and decorrelated stereo', () => {
    const sampleRate = 48000
    const left = sine(440, sampleRate, 1, 0.5)
    const mono = analyzeAudio([left], sampleRate)
    // An amplitude downmix cancels these to digital silence, so every envelope metric read
    // as silence and a stereo-width control looked like a level change.
    const antiPhase = analyzeAudio([left, Float32Array.from(left, value => -value)], sampleRate)
    expect(antiPhase.loudnessDb).toBeCloseTo(mono.loudnessDb, 4)
    expect(antiPhase.sustainDb).toBeCloseTo(mono.sustainDb, 4)
    expect(antiPhase.envelopeDb).toEqual(mono.envelopeDb)

    const decorrelated = analyzeAudio([left, sine(440, sampleRate, 1, 0.5, Math.PI / 2)], sampleRate)
    expect(decorrelated.loudnessDb).toBeCloseTo(mono.loudnessDb, 1)
  })

  it('does not read the trailing envelope window as a decay on a steady tone', () => {
    const sampleRate = 48000
    const { envelopeDb, decayT60Ms } = analyzeAudio([sine(440, sampleRate, 1, 0.5)], sampleRate)
    // A window that ran off the end of the buffer read ~1.9 dB low; an agent sees a real decay.
    expect(envelopeDb[63]).toBeGreaterThan(-1)
    expect(decayT60Ms).toBeNull()
  })

  it('keeps sustainDb and envelopeDb relative to the peak for a near-silent buffer', () => {
    const sampleRate = 8000
    const signal = new Float32Array(sampleRate)
    for (let i = 0; i < sampleRate / 2; i++) signal[i] = 1e-9 * Math.sin(2 * Math.PI * 440 * i / sampleRate)
    const metrics = analyzeAudio([signal], sampleRate)
    // toDb's -160 floor applied to the reference alone once pushed this to +23 dB.
    expect(metrics.sustainDb).toBeLessThanOrEqual(0)
    expect(metrics.envelopeDb.every(value => value <= 0)).toBe(true)
  })

  it('preserves spectral energy for anti-phase stereo', () => {
    const left = sine(1024, 8192, 1, 0.5)
    const right = Float32Array.from(left, value => -value)
    expect(analyzeAudio([left, right], 8192).spectralCentroidHz).toBeCloseTo(1024, 0)
  })

  it('aggregates channel power independently when channels contain distinct tones', () => {
    const left = sine(512, 8192, 1, 1)
    const right = sine(1536, 8192, 1, 0.5)
    expect(analyzeAudio([left, right], 8192).spectralCentroidHz).toBeCloseTo(716.8, 0)
  })

  it('measures a 5ms attack and a 2s T60 on a plucked tone', () => {
    const sampleRate = 8000
    const metrics = analyzeAudio([pluck(sampleRate, 1.5, 0.005, 2)], sampleRate)
    expect(metrics.attackMs).toBeCloseTo(5, 0)
    expect(metrics.decayT60Ms).not.toBeNull()
    expect(metrics.decayT60Ms as number).toBeGreaterThan(1900)
    expect(metrics.decayT60Ms as number).toBeLessThan(2100)
    expect(metrics.sustainDb).toBeLessThan(-20)
    expect(metrics.timeToPeakMs).toBeLessThan(20)
  })

  it('tracks attacks from 2 ms to 2 s instead of saturating just past 100 ms', () => {
    const sampleRate = 48000
    // A fixed fractional growth over a fixed hold reports the same ~94 ms for every attack
    // longer than ~125 ms, because *any* rising envelope grows slower than 8 % per 10 ms
    // by then. Every pad and swell read the same wrong number.
    const measured = [2, 5, 50, 250, 1000, 2000].map(attackMs => ({
      attackMs,
      reported: analyzeAudio([swell(attackMs, sampleRate, Math.max(3, attackMs / 500))], sampleRate).attackMs
    }))
    for (const { attackMs, reported } of measured) {
      // 10 % to 90 % of a linear ramp is 80 % of its length, plus the RMS window's smear.
      expect(reported).toBeGreaterThan(0.8 * attackMs - 8)
      expect(reported).toBeLessThan(0.8 * attackMs + 8)
    }
    for (let i = 1; i < measured.length; i++) {
      expect(measured[i].reported).toBeGreaterThan(measured[i - 1].reported)
    }
  })

  it('measures the attack of a beating unison instead of the beat rise', () => {
    const sampleRate = 8000
    const metrics = analyzeAudio([beating(sampleRate, 1, 0.002)], sampleRate)
    expect(metrics.attackMs).toBeLessThan(10)
    expect(metrics.attackMs).toBeGreaterThan(0)
    // The old behaviour - the global peak sits on the beat maximum a third of a second in.
    expect(metrics.timeToPeakMs).toBeCloseTo(333, -1)
  })

  it('returns a 64-point envelope in dB relative to the peak', () => {
    const sampleRate = 8000
    const metrics = analyzeAudio([pluck(sampleRate, 1, 0.005, 2)], sampleRate)
    expect(metrics.envelopeDb).toHaveLength(64)
    expect(metrics.envelopeDb.every(value => Number.isFinite(value) && value <= 0)).toBe(true)
    expect(metrics.envelopeDb.every(value => Math.abs(value * 10 - Math.round(value * 10)) < 1e-9)).toBe(true)
    // Evenly spaced points need not land exactly on the peak hop, but must bracket it.
    expect(Math.max(...metrics.envelopeDb)).toBeGreaterThan(-2)
    expect(metrics.envelopeDb[63]).toBeLessThan(metrics.envelopeDb[10])
  })

  it('reports no T60 when the signal never falls 20 dB inside the buffer', () => {
    const sampleRate = 8000
    expect(analyzeAudio([sine(440, sampleRate, 0.5, 0.5)], sampleRate).decayT60Ms).toBeNull()
  })

  it('reports no T60 for signals that never decay but do pass through nulls', () => {
    const sampleRate = 48000
    // Every one of these is steady. Taking the first envelope hop past each threshold made
    // a single amplitude null end the fit, so all three reported a decay that is not there.
    const steadyBeat = Float32Array.from({ length: sampleRate * 3 }, (_, i) => {
      const t = i / sampleRate
      return 0.4 * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 441 * t))
    })
    expect(analyzeAudio([steadyBeat], sampleRate).decayT60Ms).toBeNull()

    const tremolo = Float32Array.from({ length: sampleRate * 3 }, (_, i) => {
      const t = i / sampleRate
      return 0.5 * (0.5 + 0.5 * Math.cos(2 * Math.PI * 2.5 * t)) * Math.sin(2 * Math.PI * 440 * t)
    })
    expect(analyzeAudio([tremolo], sampleRate).decayT60Ms).toBeNull()
  })

  it('measures the true T60 of a detuned-unison pluck through its beat nulls', () => {
    const sampleRate = 48000
    const decay = Math.log(1000) / 2
    const signal = Float32Array.from({ length: sampleRate * 3 }, (_, i) => {
      const t = i / sampleRate
      const envelope = Math.min(1, t / 0.005) * Math.exp(-decay * t)
      return 0.4 * envelope * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 441.8 * t))
    })
    // The nulls halved this to 894 ms. The 1.8 Hz beat still biases the fit, because its
    // period is a large fraction of the -5…-25 dB span, so the tolerance is wide.
    const { decayT60Ms } = analyzeAudio([signal], sampleRate)
    expect(decayT60Ms).not.toBeNull()
    expect(decayT60Ms as number).toBeGreaterThan(1600)
    expect(decayT60Ms as number).toBeLessThan(2600)
  })

  it('reports strictly increasing gated loudness for the same tone at rising amplitudes', () => {
    const sampleRate = 8000
    const loudness = [0.25, 0.5, 1].map(amplitude => {
      const tone = sine(440, sampleRate, 0.5, amplitude)
      const padded = new Float32Array(sampleRate)
      padded.set(tone, 0)
      return analyzeAudio([padded], sampleRate).loudnessDb
    })
    expect(loudness[0]).toBeLessThan(loudness[1])
    expect(loudness[1]).toBeLessThan(loudness[2])
    // Gating the trailing silence keeps the steps at the true 6 dB.
    expect(loudness[1] - loudness[0]).toBeCloseTo(6.02, 1)
    expect(loudness[2] - loudness[1]).toBeCloseTo(6.02, 1)
  })

  it('moves loudnessDb by exactly the gain applied to a decaying note', () => {
    const sampleRate = 48000
    // An absolute -60 dBFS gate drops windows as the buffer is attenuated and inflates the
    // mean of the rest, so this gained only 5.4 dB for a real 6 dB.
    const note = (gain: number) => {
      const decay = Math.log(1000)
      return analyzeAudio([Float32Array.from({ length: sampleRate * 3 }, (_, i) => {
        const t = i / sampleRate
        return gain * 0.8 * Math.exp(-decay * t) * Math.sin(2 * Math.PI * 440 * t)
      })], sampleRate).loudnessDb
    }
    expect(note(1) - note(0.5)).toBeCloseTo(6.02, 2)
    expect(note(0.5) - note(0.25)).toBeCloseTo(6.02, 2)
  })

  it('does not let a long quiet tail invert loudnessDb against gain', () => {
    const sampleRate = 48000
    // 0.2 s of body, then 4 s at an amplitude that straddles the old absolute gate. At gain
    // 0.5 the tail fell below -60 dBFS and was dropped; at gain 1.0 it passed and dragged the
    // mean down, so doubling the amplitude *lowered* reported loudness by 7 dB.
    const bodyPlusTail = (gain: number) =>
      analyzeAudio([Float32Array.from({ length: Math.round(sampleRate * 4.2) }, (_, i) => {
        const t = i / sampleRate
        return gain * (t < 0.2 ? 0.5 : 0.0016) * Math.sin(2 * Math.PI * 440 * t)
      })], sampleRate).loudnessDb
    expect(bodyPlusTail(1) - bodyPlusTail(0.5)).toBeCloseTo(6.02, 2)
    // The tail is 50 dB down; the relative gate must exclude it at either gain.
    expect(bodyPlusTail(1)).toBeGreaterThan(-11)
  })

  it('reports octave bands that fall steadily above the fundamental for a 220 Hz sawtooth', () => {
    const sampleRate = 48000
    const { bandsDb } = analyzeAudio([sawtooth(220, sampleRate, 1)], sampleRate)
    expect(bandsDb).toHaveLength(10)
    // Bands 0-2 (31.25-125 Hz) sit below the 220 Hz fundamental and hold almost nothing.
    expect(bandsDb[3]).toBeGreaterThan(-5)
    for (let band = 4; band < 10; band++) {
      const drop = bandsDb[band - 1] - bandsDb[band]
      // A 1/n sawtooth loses 6 dB per octave *per partial*; an octave band gathers twice
      // as many partials as the one below it, so the integrated band level falls ~3 dB.
      expect(drop).toBeGreaterThan(1.5)
      expect(drop).toBeLessThan(6)
    }
    expect(bandsDb[9]).toBeLessThan(bandsDb[3] - 15)
  })

  it('separates a tonal sine from white noise by spectral flatness and rolloff', () => {
    const sampleRate = 48000
    const tone = analyzeAudio([sine(440, sampleRate, 1, 0.5)], sampleRate)
    expect(tone.spectralFlatness).toBeLessThan(0.05)
    expect(tone.spectralRolloffHz).toBeCloseTo(440, -2)

    let seed = 12345
    const noise = Float32Array.from({ length: sampleRate }, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return (seed / 2147483648) * 2 - 1
    })
    const noisy = analyzeAudio([noise], sampleRate)
    expect(noisy.spectralFlatness).toBeGreaterThan(0.5)
    expect(noisy.spectralRolloffHz).toBeGreaterThan(15000)
  })

  it('omits harmonics entirely when no f0Hz is supplied', () => {
    const sampleRate = 48000
    const metrics = analyzeAudio([sawtooth(220, sampleRate, 0.5)], sampleRate)
    expect(metrics.harmonics).toBeUndefined()
    expect('harmonics' in metrics).toBe(false)
    expect(JSON.stringify(metrics)).not.toContain('harmonics')
  })

  it('reports 1/n partial amplitudes and near-zero inharmonicity for a sawtooth', () => {
    const sampleRate = 48000
    const { harmonics } = analyzeAudio([sawtooth(220, sampleRate, 1)], sampleRate, { f0Hz: 220 })
    expect(harmonics).toBeDefined()
    expect(harmonics!.amplitudesDb).toHaveLength(12)
    expect(harmonics!.amplitudesDb[0]).toBe(0)
    // 1/n means -6.02 dB per octave of partial number.
    expect(harmonics!.amplitudesDb[1]).toBeCloseTo(-6.02, 0)
    expect(harmonics!.amplitudesDb[3]).toBeCloseTo(-12.04, 0)
    expect(harmonics!.amplitudesDb[7]).toBeCloseTo(-18.06, 0)
    expect(Math.abs(harmonics!.inharmonicity)).toBeLessThan(2e-5)
  })

  it('fits the stiffness coefficient B of stretched partials on a steady tone', () => {
    const sampleRate = 48000
    const { harmonics } = analyzeAudio(
      [stretchedPartials(220, 0.0004, sampleRate, 2.5)],
      sampleRate,
      { f0Hz: 220 }
    )
    expect(harmonics!.inharmonicity).toBeGreaterThan(0.0004 * 0.8)
    expect(harmonics!.inharmonicity).toBeLessThan(0.0004 * 1.2)
  })

  it('fits B across the documented range and beyond, not just its bottom half', () => {
    const sampleRate = 48000
    // A fixed ±3 % window around n·f0 caps B at about 4e-4: past that the high partials fall
    // outside it, the picked bin sits at the window edge, and the n²-weighted fit drags B to
    // zero - so a bell reported as a perfect harmonic series. Measured before:
    // 1e-3 -> 1.09e-5, 2e-3 -> 2.95e-5, 5e-3 -> -4.7e-6.
    for (const inharmonicity of [1e-4, 6e-4, 1e-3, 2e-3, 5e-3]) {
      const { harmonics } = analyzeAudio(
        [stretchedPartials(220, inharmonicity, sampleRate, 2.5)],
        sampleRate,
        { f0Hz: 220 }
      )
      expect(harmonics!.inharmonicity).toBeGreaterThan(inharmonicity * 0.9)
      expect(harmonics!.inharmonicity).toBeLessThan(inharmonicity * 1.1)
    }
  })

  it('fits a high B through an attack and an exponential decay', () => {
    const sampleRate = 48000
    const { harmonics } = analyzeAudio(
      [stretchedPartials(440, 0.005, sampleRate, 2.5, { decayT60Seconds: 3 })],
      sampleRate,
      { f0Hz: 440 }
    )
    expect(harmonics!.inharmonicity).toBeGreaterThan(0.005 * 0.9)
    expect(harmonics!.inharmonicity).toBeLessThan(0.005 * 1.1)
  })

  it('fits the same B through an attack and an exponential decay', () => {
    const sampleRate = 48000
    const { harmonics } = analyzeAudio(
      [stretchedPartials(440, 0.0004, sampleRate, 2.5, { decayT60Seconds: 3 })],
      sampleRate,
      { f0Hz: 440 }
    )
    expect(harmonics!.inharmonicity).toBeGreaterThan(0.0004 * 0.8)
    expect(harmonics!.inharmonicity).toBeLessThan(0.0004 * 1.2)
    expect(harmonics!.amplitudesDb[0]).toBe(0)
    expect(harmonics!.amplitudesDb.every(value => Number.isFinite(value) && value <= 0)).toBe(true)
  })

  it('leaves harmonics absent for silence and for a nonsensical f0Hz', () => {
    const sampleRate = 48000
    expect(analyzeAudio([new Float32Array(sampleRate)], sampleRate, { f0Hz: 440 }).harmonics).toBeUndefined()
    expect(analyzeAudio([sine(440, sampleRate, 0.5, 0.5)], sampleRate, { f0Hz: 0 }).harmonics).toBeUndefined()
    expect(analyzeAudio([sine(440, sampleRate, 0.5, 0.5)], sampleRate, { f0Hz: Number.NaN }).harmonics).toBeUndefined()
  })

  it('covers the buffer in order with four consecutive, equal, non-overlapping windows', () => {
    const sampleRate = 48000
    const { spectralWindows } = analyzeAudio([sawtooth(220, sampleRate, 2)], sampleRate)
    expect(spectralWindows).toHaveLength(4)
    expect(spectralWindows.map(window => [window.startMs, window.endMs])).toEqual([
      [0, 500], [500, 1000], [1000, 1500], [1500, 2000]
    ])
  })

  it('reports a falling per-window centroid for a closing filter and a flat one for a steady tone', () => {
    const sampleRate = 48000
    // Measured: 528.9 -> 433.3 -> 352.5 -> 292.8 Hz. The whole-buffer spectralCentroidHz
    // collapses all of that to a single 414 Hz, which a steady tone can equally well produce.
    const falling = analyzeAudio(
      [sweepingLowpass(sawtooth(220, sampleRate, 2), sampleRate, 8000, 300)],
      sampleRate
    )
    const brightness = falling.spectralWindows.map(window => window.spectralCentroidHz)
    for (let index = 1; index < brightness.length; index++) {
      // Strictly falling, and by enough that a whole-buffer computation - which would make
      // every window identical - or a reversed window order cannot satisfy it.
      expect(brightness[index]).toBeLessThan(brightness[index - 1] * 0.95)
    }
    expect(brightness[3]).toBeLessThan(brightness[0] * 0.6)
    // The rolloff falls with it; the level barely moves, so this is brightness, not volume.
    expect(falling.spectralWindows[3].spectralRolloffHz).toBeLessThan(falling.spectralWindows[0].spectralRolloffHz)
    expect(falling.spectralWindows[3].levelDb).toBeGreaterThan(-6)

    const steady = analyzeAudio([sawtooth(220, sampleRate, 2)], sampleRate)
    const flat = steady.spectralWindows.map(window => window.spectralCentroidHz)
    expect(new Set(flat).size).toBe(1)
    expect(steady.spectralWindows.map(window => window.levelDb)).toEqual([0, 0, 0, 0])
  })

  it('reports per-window level relative to the loudest window', () => {
    const sampleRate = 48000
    const decaying = analyzeAudio([pluck(sampleRate, 2, 0.005, 1)], sampleRate)
    const levels = decaying.spectralWindows.map(window => window.levelDb)
    expect(levels[0]).toBe(0)
    for (let index = 1; index < levels.length; index++) expect(levels[index]).toBeLessThan(levels[index - 1])
    // A 1 s T60 is 60 dB/s, so consecutive 500 ms windows are about 30 dB apart.
    expect(levels[1]).toBeLessThan(-25)
    expect(levels[1]).toBeGreaterThan(-35)

    // The loudest window is not always the first: a 2 s swell peaks at the end, and
    // levelDb must be relative to that peak rather than to whatever came first.
    const swelling = analyzeAudio([swell(2000, sampleRate, 2)], sampleRate)
    const rising = swelling.spectralWindows.map(window => window.levelDb)
    expect(rising[0]).toBeLessThan(-10)
    expect(rising[3]).toBe(0)
    for (let index = 1; index < rising.length; index++) expect(rising[index]).toBeGreaterThan(rising[index - 1])
  })

  it('shows the upper partials decaying faster than the fundamental, window by window', () => {
    const sampleRate = 48000
    const { spectralWindows, harmonics } = analyzeAudio(
      [fasterUpperPartialDecay(220, sampleRate, 2, 1.5)],
      sampleRate,
      { f0Hz: 220 }
    )
    // The whole-buffer snapshot sees one set of partials and cannot express a decay rate.
    expect(harmonics!.amplitudesDb).toHaveLength(12)

    const partial = (index: number) => spectralWindows.map(window => window.harmonicsDb![index])
    for (const window of spectralWindows) expect(window.harmonicsDb).toHaveLength(12)
    // Partial 1 falls 20 dB per window (T60 1.5 s = 40 dB/s, windows are 500 ms).
    const fundamental = partial(0)
    expect(fundamental[0]).toBe(0)
    expect(fundamental[1]).toBeCloseTo(-20, 0)
    expect(fundamental[2]).toBeCloseTo(-40, 0)
    expect(fundamental[3]).toBeCloseTo(-60, 0)
    // Partial 2 decays twice as fast, so it loses twice as much between the first two
    // windows. A per-window normalisation to each window's own loudest partial would make
    // every window read 0 here and hide exactly this.
    const second = partial(1)
    expect(second[0] - second[1]).toBeGreaterThan(2 * (fundamental[0] - fundamental[1]) - 4)
    // And by the last window the upper partials are gone while the fundamental is not.
    expect(partial(7)[3]).toBeLessThan(fundamental[3] - 40)
    for (const values of [fundamental, second, partial(3)]) {
      for (let index = 1; index < values.length; index++) {
        expect(values[index]).toBeLessThanOrEqual(values[index - 1])
      }
    }
  })

  it('omits per-window harmonicsDb exactly when the whole-buffer harmonics are omitted', () => {
    const sampleRate = 48000
    const signal = sawtooth(220, sampleRate, 1)
    const without = analyzeAudio([signal], sampleRate)
    expect(without.harmonics).toBeUndefined()
    expect(without.spectralWindows.every(window => !('harmonicsDb' in window))).toBe(true)
    expect(JSON.stringify(without.spectralWindows)).not.toContain('harmonics')

    const withF0 = analyzeAudio([signal], sampleRate, { f0Hz: 220 })
    expect(withF0.spectralWindows.every(window => window.harmonicsDb?.length === 12)).toBe(true)
    // The whole-buffer field is untouched by the per-window pass.
    expect(withF0.harmonics).toEqual(analyzeAudio([signal], sampleRate, { f0Hz: 220 }).harmonics)

    for (const f0Hz of [0, -220, Number.NaN]) {
      const rejected = analyzeAudio([signal], sampleRate, { f0Hz })
      expect(rejected.harmonics).toBeUndefined()
      expect(rejected.spectralWindows.every(window => window.harmonicsDb === undefined)).toBe(true)
    }
  })

  it('reports identical spectral windows for mono, duplicated stereo, and anti-phase stereo', () => {
    const sampleRate = 48000
    const left = sweepingLowpass(sawtooth(220, sampleRate, 1), sampleRate, 8000, 300)
    const mono = analyzeAudio([left], sampleRate, { f0Hz: 220 })
    for (const right of [new Float32Array(left), Float32Array.from(left, value => -value)]) {
      expect(analyzeAudio([left, right], sampleRate, { f0Hz: 220 }).spectralWindows).toEqual(mono.spectralWindows)
    }
  })

  it('returns zeroed spectral windows rather than throwing for buffers too short to slice', () => {
    for (const [length, sampleRate] of [[4, 1000], [8, 48000], [1, 48000]] as const) {
      const { spectralWindows } = analyzeAudio([new Float32Array(length).fill(0.2)], sampleRate, { f0Hz: 220 })
      expect(spectralWindows).toHaveLength(4)
      for (const window of spectralWindows) {
        expect(Object.values(window).every(Number.isFinite)).toBe(true)
        expect(window.spectralCentroidHz).toBe(0)
        expect(window.levelDb).toBe(0)
        expect(window.harmonicsDb).toBeUndefined()
      }
    }

    // 32 samples do slice into four 8-sample windows. Those carry a real (if useless)
    // spectrum, which must still be finite, and an FFT far too small to resolve partials.
    const sliced = analyzeAudio([new Float32Array(32).fill(0.2)], 48000, { f0Hz: 220 })
    expect(sliced.spectralWindows).toHaveLength(4)
    expect(sliced.spectralWindows.every(window => Object.values(window).every(Number.isFinite))).toBe(true)
    expect(sliced.spectralWindows.every(window => window.harmonicsDb === undefined)).toBe(true)
  })

  it('keeps spectral windows finite for DC and for a buffer that falls to digital silence', () => {
    const sampleRate = 48000
    const dc = analyzeAudio([new Float32Array(sampleRate).fill(0.5)], sampleRate, { f0Hz: 220 })
    for (const window of dc.spectralWindows) {
      expect(Number.isFinite(window.spectralCentroidHz)).toBe(true)
      expect(window.harmonicsDb!.every(Number.isFinite)).toBe(true)
    }

    // Half a note, then true zeros: the silent windows must read the floor, not -Infinity.
    const half = new Float32Array(sampleRate)
    half.set(sine(440, sampleRate, 0.4, 0.5), 0)
    const gated = analyzeAudio([half], sampleRate, { f0Hz: 440 })
    expect(gated.spectralWindows[3].levelDb).toBeLessThanOrEqual(-100)
    expect(gated.spectralWindows.every(window => window.harmonicsDb!.every(Number.isFinite))).toBe(true)
    expect(JSON.stringify(gated.spectralWindows)).not.toContain('null')
  })

  it('handles silence and rejects malformed input', () => {
    const silence = analyzeAudio([new Float32Array(32)], 48000)
    expect(silence).toMatchObject({
      peakDb: -160,
      rmsDb: -160,
      spectralCentroidHz: 0,
      attackMs: 0,
      stereoWidth: 0,
      timeToPeakMs: 0,
      decayT60Ms: null,
      sustainDb: 0,
      loudnessDb: -160,
      spectralRolloffHz: 0,
      spectralFlatness: 0
    })
    expect(silence.envelopeDb).toEqual(new Array(64).fill(0))
    expect(silence.bandsDb).toEqual(new Array(10).fill(-100))
    expect(silence.spectralWindows).toHaveLength(4)
    expect(silence.spectralWindows.map(window => window.spectralCentroidHz)).toEqual([0, 0, 0, 0])
    expect(silence.spectralWindows.map(window => window.levelDb)).toEqual([0, 0, 0, 0])
    expect(() => analyzeAudio([], 48000)).toThrow(/channel/i)
    expect(() => analyzeAudio([new Float32Array(2)], 0)).toThrow(/sample rate/i)
  })

  it.each([Number.NaN, Infinity, -Infinity])('rejects nonfinite PCM sample %s before analysis', sample => {
    expect(() => analyzeAudio([new Float32Array([0, sample, 0])], 48000)).toThrow(/finite.*sample/i)
  })

  it('rejects finite Float32 PCM when derived analysis metrics overflow', () => {
    const huge = Float32Array.from([3e38, -3e38, 3e38, -3e38])
    expect(Array.from(huge).every(Number.isFinite)).toBe(true)
    expect(() => analyzeAudio([huge], 48000)).toThrow(/analysis.*nonfinite/i)
  })

  it('lets the harmonics finiteness guard fire instead of rounding NaN to zero', () => {
    // The 32768-sample harmonic FFT overflows Float32 here while the 4096-sample spectral
    // FFT does not, so every scalar is finite and only the partial amplitudes go NaN.
    // Rounding with `|| 0` turned those into 0 dB and let a fabricated B through.
    const sampleRate = 48000
    const huge = Float32Array.from({ length: sampleRate }, (_, i) => 5e34 * Math.sin(2 * Math.PI * 440 * i / sampleRate))
    expect(Array.from(huge).every(Number.isFinite)).toBe(true)
    expect(() => analyzeAudio([huge], sampleRate, { f0Hz: 440 })).toThrow(/nonfinite metric: harmonics/)
  })

  it('returns accepted metrics whose scalars are finite and never serialize as null', () => {
    const metrics = analyzeAudio([pluck(8000, 1.5, 0.005, 0.4)], 8000)
    const { decayT60Ms, envelopeDb, bandsDb, harmonics, spectralWindows, ...scalars } = metrics
    expect(Object.values(scalars).every(Number.isFinite)).toBe(true)
    expect(envelopeDb.every(Number.isFinite)).toBe(true)
    expect(bandsDb.every(Number.isFinite)).toBe(true)
    expect(spectralWindows.every(window => Object.values(window).every(Number.isFinite))).toBe(true)
    expect(harmonics).toBeUndefined()
    expect(decayT60Ms).toBeGreaterThan(0)
    expect(JSON.stringify(metrics)).not.toContain('null')
  })

  it('serializes decayT60Ms as null - the only nullable metric - when there is no measurable decay', () => {
    const metrics = analyzeAudio([sine(440, 48000, 0.01, 0.25)], 48000)
    expect(metrics.decayT60Ms).toBeNull()
    expect(JSON.stringify(metrics).match(/null/g)).toHaveLength(1)
  })
})

const metricKeys: ComparedMetricKey[] = [
  'peakDb', 'rmsDb', 'clippingCount', 'dcOffset',
  'spectralCentroidHz', 'attackMs', 'stereoWidth', 'decayT60Ms'
]
const detailKeys = [...metricKeys, 'envelope', 'bands', 'brightness'] as const

/** A decaying shape, so envelope correlation has something to correlate. */
const rampEnvelope = (start: number, end: number): number[] =>
  Array.from({ length: 64 }, (_, i) => Math.round((start + (end - start) * i / 63) * 10) / 10)

/** Four 250 ms windows carrying the given centroid trajectory. */
const windowTrajectory = (centroids: readonly number[]): SpectralWindow[] =>
  centroids.map((spectralCentroidHz, index) => ({
    startMs: index * 250,
    endMs: (index + 1) * 250,
    spectralCentroidHz,
    spectralRolloffHz: spectralCentroidHz * 2,
    levelDb: index === 0 ? 0 : -3 * index
  }))

const referenceMetrics: AudioMetrics = {
  peakDb: -6,
  rmsDb: -12,
  clippingCount: 0,
  dcOffset: 0.001,
  spectralCentroidHz: 1200,
  attackMs: 25,
  stereoWidth: 0.2,
  timeToPeakMs: 30,
  decayT60Ms: 800,
  sustainDb: -30,
  envelopeDb: rampEnvelope(0, -60),
  loudnessDb: -14,
  bandsDb: [-40, -30, -20, -10, -6, -8, -14, -22, -30, -40],
  spectralRolloffHz: 3200,
  spectralFlatness: 0.08,
  spectralWindows: windowTrajectory([2000, 1400, 1000, 700])
}

describe('compareAudioMetrics', () => {
  it('returns exact overall and per-metric similarity of 1 for identical metrics', () => {
    const result = compareAudioMetrics(referenceMetrics, { ...referenceMetrics })
    expect(result.similarity).toBe(1)
    expect(Object.keys(result.details)).toEqual(detailKeys)
    for (const key of metricKeys) {
      expect(result.details[key]).toEqual({
        reference: referenceMetrics[key],
        candidate: referenceMetrics[key],
        delta: 0,
        similarity: 1
      })
    }
  })

  it('returns every signed delta and lowers bounded scores for meaningful differences', () => {
    const candidate: AudioMetrics = {
      ...referenceMetrics,
      peakDb: -18,
      rmsDb: -30,
      clippingCount: 20,
      dcOffset: -0.05,
      spectralCentroidHz: 4800,
      attackMs: 200,
      stereoWidth: 0.9,
      decayT60Ms: 60
    }
    const result = compareAudioMetrics(referenceMetrics, candidate)
    expect(result.similarity).toBeGreaterThanOrEqual(0)
    expect(result.similarity).toBeLessThan(1)
    for (const key of metricKeys) {
      expect(result.details[key].reference).toBe(referenceMetrics[key])
      expect(result.details[key].candidate).toBe(candidate[key])
      expect(result.details[key].delta).toBe((candidate[key] as number) - (referenceMetrics[key] as number))
      expect(result.details[key].similarity).toBeGreaterThanOrEqual(0)
      expect(result.details[key].similarity).toBeLessThanOrEqual(1)
    }
    expect(result.details.spectralCentroidHz.similarity).toBeLessThan(0.7)
    expect(result.details.attackMs.similarity).toBeLessThan(0.7)
  })

  it('uses finite robust math for silence, zero, and nonnegative edge values', () => {
    const silence: AudioMetrics = {
      peakDb: -160, rmsDb: -160, clippingCount: 0, dcOffset: 0,
      spectralCentroidHz: 0, attackMs: 0, stereoWidth: 0,
      timeToPeakMs: 0, decayT60Ms: null, sustainDb: 0,
      envelopeDb: new Array(64).fill(0), loudnessDb: -160,
      bandsDb: new Array(10).fill(-100), spectralRolloffHz: 0, spectralFlatness: 0,
      spectralWindows: windowTrajectory([0, 0, 0, 0])
    }
    const changed: AudioMetrics = {
      peakDb: -159, rmsDb: -140, clippingCount: 1, dcOffset: 0,
      spectralCentroidHz: 20, attackMs: 1, stereoWidth: 0,
      timeToPeakMs: 1, decayT60Ms: 5, sustainDb: -3,
      envelopeDb: rampEnvelope(0, -12), loudnessDb: -140,
      bandsDb: new Array(10).fill(-10), spectralRolloffHz: 20, spectralFlatness: 1,
      spectralWindows: windowTrajectory([20, 18, 12, 0])
    }
    for (const result of [compareAudioMetrics(silence, silence), compareAudioMetrics(silence, changed)]) {
      expect(Number.isFinite(result.similarity)).toBe(true)
      for (const key of detailKeys) {
        expect(Number.isFinite(result.details[key].similarity)).toBe(true)
      }
    }
  })

  it('reports clipping similarity but excludes clippingCount entirely from the overall score', () => {
    const clipped = { ...referenceMetrics, clippingCount: 1_000_000 }
    const result = compareAudioMetrics(referenceMetrics, clipped)
    expect(result.details.clippingCount.similarity).toBeLessThan(1)
    expect(result.similarity).toBe(1)
  })

  it.each(metricKeys)('rejects nonfinite reference and candidate %s values', key => {
    expect(() => compareAudioMetrics({ ...referenceMetrics, [key]: Number.NaN }, referenceMetrics)).toThrow(/finite/i)
    expect(() => compareAudioMetrics(referenceMetrics, { ...referenceMetrics, [key]: Infinity })).toThrow(/finite/i)
  })

  it('scores decayT60Ms by log ratio and treats null as an unmeasurable decay', () => {
    const quiet = { ...referenceMetrics, decayT60Ms: null }
    expect(compareAudioMetrics(quiet, { ...quiet }).details.decayT60Ms).toEqual({
      reference: null, candidate: null, delta: null, similarity: 1
    })
    const mismatch = compareAudioMetrics(quiet, referenceMetrics).details.decayT60Ms
    expect(mismatch).toEqual({ reference: null, candidate: 800, delta: null, similarity: 0 })
    const shorter = compareAudioMetrics(referenceMetrics, { ...referenceMetrics, decayT60Ms: 100 })
    expect(shorter.details.decayT60Ms.delta).toBe(-700)
    expect(shorter.details.decayT60Ms.similarity).toBeLessThan(0.7)
  })

  it('scores envelope shape by correlation, not by absolute level', () => {
    const shifted = { ...referenceMetrics, envelopeDb: rampEnvelope(-6, -66) }
    expect(compareAudioMetrics(referenceMetrics, shifted).details.envelope.similarity).toBeCloseTo(1, 5)
    const inverted = { ...referenceMetrics, envelopeDb: rampEnvelope(-60, 0) }
    expect(compareAudioMetrics(referenceMetrics, inverted).details.envelope.similarity).toBeCloseTo(0, 5)
    expect(compareAudioMetrics(referenceMetrics, referenceMetrics).details.envelope.similarity).toBe(1)
  })

  it('scores bandsDb by per-band capped dB difference read linearly against the 20 dB cap', () => {
    const identical = compareAudioMetrics(referenceMetrics, { ...referenceMetrics })
    expect(identical.details.bands.similarity).toBe(1)
    expect(identical.details.bands.delta).toBe(0)

    const tilted = {
      ...referenceMetrics,
      bandsDb: referenceMetrics.bandsDb.map(value => value - 6)
    }
    const shifted = compareAudioMetrics(referenceMetrics, tilted).details.bands
    expect(shifted.delta).toBeCloseTo(-6, 5)
    // A flat 6 dB offset is 6/20 of the way to "these bands share nothing".
    expect(shifted.similarity).toBeCloseTo(0.7, 5)

    // Six bands past the cap, four inside it: 0.2. Well under the 0.822 a one-parameter
    // change scores below, which is the separation that matters, not the absolute figure.
    const brighter = { ...referenceMetrics, bandsDb: [-60, -50, -40, -30, -20, -10, -6, -6, -8, -12] }
    expect(compareAudioMetrics(referenceMetrics, brighter).details.bands.similarity).toBeCloseTo(0.2, 5)
  })

  /**
   * Band vectors measured by `analyzeAudio`, not invented: the reference row is
   * `docs/agent-match-eval-reference.wav`, the candidate rows are C4 patches - a plain
   * sawtooth, the same sawtooth after one round of parameter edits, and a sine, which is as
   * spectrally unlike the recording as a single note gets.
   */
  const WAV_REFERENCE_BANDS = [-4.4, -19.7, -16, -12, -9.2, -7.4, -8, -13.7, -17.8, -23.2]
  const SAW_C4_BANDS = [-79, -72, -59, -2, -8, -9, -13, -18, -25, -100]
  const SAW_C4_EDITED_BANDS = [-75, -69, -56, -1, -9, -15, -23, -22, -28, -100]
  const SINE_C4_BANDS = [-76, -70, -57, 0, -57, -79, -90, -100, -100, -100]

  it('keeps band similarity informative against a real recorded reference', () => {
    const bandsOf = (bandsDb: number[]) =>
      compareAudioMetrics({ ...referenceMetrics, bandsDb: WAV_REFERENCE_BANDS }, { ...referenceMetrics, bandsDb })
        .details.bands.similarity

    const saw = bandsOf(SAW_C4_BANDS)
    const edited = bandsOf(SAW_C4_EDITED_BANDS)
    const sine = bandsOf(SINE_C4_BANDS)

    // Both plausible candidates must land somewhere an agent can read and steer by, rather
    // than in the bottom hundredth where the eval found them (0.010 and 0.008).
    expect(saw).toBeGreaterThan(0.25)
    expect(edited).toBeGreaterThan(0.25)
    expect(saw).toBeLessThan(0.75)
    expect(edited).toBeLessThan(0.75)
    // One round of edits must move the metric by more than the 0.002 it moved before.
    expect(Math.abs(saw - edited)).toBeGreaterThan(0.05)
    // And the scale must still put a genuinely unrelated spectrum far below both.
    expect(sine).toBeLessThan(Math.min(saw, edited) - 0.2)

    // Two candidates one parameter change apart still read as close to each other.
    const near = compareAudioMetrics(
      { ...referenceMetrics, bandsDb: SAW_C4_BANDS },
      { ...referenceMetrics, bandsDb: SAW_C4_EDITED_BANDS }
    ).details.bands.similarity
    expect(near).toBeGreaterThan(0.7)
    expect(near).toBeGreaterThan(Math.max(saw, edited) + 0.3)
  })

  it('rejects malformed band arrays', () => {
    expect(() => compareAudioMetrics(referenceMetrics, { ...referenceMetrics, bandsDb: [1, 2, 3] }))
      .toThrow(/bandsDb/i)
    expect(() => compareAudioMetrics({ ...referenceMetrics, bandsDb: new Array(10).fill(Number.NaN) }, referenceMetrics))
      .toThrow(/bandsDb/i)
  })

  it('separates a falling brightness trajectory from a rising one with the same mean', () => {
    const identical = compareAudioMetrics(referenceMetrics, { ...referenceMetrics })
    expect(identical.details.brightness.similarity).toBe(1)
    expect(identical.details.brightness.delta).toBe(0)
    expect(identical.details.brightness.reference).toBeCloseTo(1275, 5)

    // Same four centroids in the opposite order: identical mean, identical whole-buffer
    // spectralCentroidHz, opposite sound. This is the pair no other detail can tell apart.
    const rising = {
      ...referenceMetrics,
      spectralWindows: windowTrajectory([700, 1000, 1400, 2000])
    }
    const reversed = compareAudioMetrics(referenceMetrics, rising)
    expect(reversed.details.spectralCentroidHz.similarity).toBe(1)
    expect(reversed.details.brightness.delta).toBeCloseTo(0, 5)
    expect(reversed.details.brightness.similarity).toBeLessThan(0.3)
    expect(reversed.similarity).toBeLessThan(1)

    // A whole octave darker at every window is one scale unit of two.
    const darker = {
      ...referenceMetrics,
      spectralWindows: windowTrajectory([1000, 700, 500, 350])
    }
    const dark = compareAudioMetrics(referenceMetrics, darker).details.brightness
    expect(dark.delta).toBeLessThan(0)
    expect(dark.similarity).toBeGreaterThan(0.1)
    expect(dark.similarity).toBeLessThan(0.2)
  })

  it('rejects malformed spectral window arrays', () => {
    expect(() => compareAudioMetrics(referenceMetrics, {
      ...referenceMetrics,
      spectralWindows: windowTrajectory([1000, 500])
    })).toThrow(/spectralWindows/i)
    expect(() => compareAudioMetrics({
      ...referenceMetrics,
      spectralWindows: windowTrajectory([1000, 500, Number.NaN, 100])
    }, referenceMetrics)).toThrow(/spectralWindows/i)
    expect(() => compareAudioMetrics(referenceMetrics, {
      ...referenceMetrics,
      spectralWindows: [null, null, null, null] as unknown as SpectralWindow[]
    })).toThrow(/spectralWindows/i)
  })

  it('rejects malformed envelope arrays', () => {
    const broken = { ...referenceMetrics, envelopeDb: [1, 2, 3] }
    expect(() => compareAudioMetrics(referenceMetrics, broken)).toThrow(/envelopeDb/i)
    expect(() => compareAudioMetrics({ ...referenceMetrics, envelopeDb: rampEnvelope(0, Number.NaN) }, referenceMetrics))
      .toThrow(/envelopeDb/i)
  })

  it('requires clippingCount to be a nonnegative integer', () => {
    expect(() => compareAudioMetrics({ ...referenceMetrics, clippingCount: -1 }, referenceMetrics)).toThrow(/clippingCount.*nonnegative integer/i)
    expect(() => compareAudioMetrics(referenceMetrics, { ...referenceMetrics, clippingCount: 1.5 })).toThrow(/clippingCount.*nonnegative integer/i)
  })

  it('returns only finite JSON numeric details, deltas, similarities, and overall score', () => {
    const result = compareAudioMetrics(referenceMetrics, {
      ...referenceMetrics,
      peakDb: -160,
      spectralCentroidHz: 0,
      attackMs: 0,
      clippingCount: 100
    })
    expect(Number.isFinite(result.similarity)).toBe(true)
    for (const detail of Object.values(result.details)) {
      expect(Object.values(detail).every(Number.isFinite)).toBe(true)
    }
    expect(JSON.stringify(result)).not.toContain('null')
    const parsed = JSON.parse(JSON.stringify(result))
    expect(typeof parsed.similarity).toBe('number')
  })
})
