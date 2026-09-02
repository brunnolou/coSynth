import { describe, expect, it } from 'vitest'
import { analyzeAudio, compareAudioMetrics, type AudioMetrics, type ComparedMetricKey } from './audio-analysis'

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

  it('returns accepted metrics whose scalars are finite and never serialize as null', () => {
    const metrics = analyzeAudio([pluck(8000, 1.5, 0.005, 0.4)], 8000)
    const { decayT60Ms, envelopeDb, bandsDb, harmonics, ...scalars } = metrics
    expect(Object.values(scalars).every(Number.isFinite)).toBe(true)
    expect(envelopeDb.every(Number.isFinite)).toBe(true)
    expect(bandsDb.every(Number.isFinite)).toBe(true)
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
const detailKeys = [...metricKeys, 'envelope', 'bands'] as const

/** A decaying shape, so envelope correlation has something to correlate. */
const rampEnvelope = (start: number, end: number): number[] =>
  Array.from({ length: 64 }, (_, i) => Math.round((start + (end - start) * i / 63) * 10) / 10)

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
  spectralFlatness: 0.08
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
      bandsDb: new Array(10).fill(-100), spectralRolloffHz: 0, spectralFlatness: 0
    }
    const changed: AudioMetrics = {
      peakDb: -159, rmsDb: -140, clippingCount: 1, dcOffset: 0,
      spectralCentroidHz: 20, attackMs: 1, stereoWidth: 0,
      timeToPeakMs: 1, decayT60Ms: 5, sustainDb: -3,
      envelopeDb: rampEnvelope(0, -12), loudnessDb: -140,
      bandsDb: new Array(10).fill(-10), spectralRolloffHz: 20, spectralFlatness: 1
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

  it('scores bandsDb by mean absolute dB difference on a 6 dB scale', () => {
    const identical = compareAudioMetrics(referenceMetrics, { ...referenceMetrics })
    expect(identical.details.bands.similarity).toBe(1)
    expect(identical.details.bands.delta).toBe(0)

    const tilted = {
      ...referenceMetrics,
      bandsDb: referenceMetrics.bandsDb.map(value => value - 6)
    }
    const shifted = compareAudioMetrics(referenceMetrics, tilted).details.bands
    expect(shifted.delta).toBeCloseTo(-6, 5)
    // A flat 6 dB offset is exactly one scale unit away.
    expect(shifted.similarity).toBeCloseTo(Math.exp(-1), 5)

    const brighter = { ...referenceMetrics, bandsDb: [-60, -50, -40, -30, -20, -10, -6, -6, -8, -12] }
    expect(compareAudioMetrics(referenceMetrics, brighter).details.bands.similarity).toBeLessThan(0.1)
  })

  it('rejects malformed band arrays', () => {
    expect(() => compareAudioMetrics(referenceMetrics, { ...referenceMetrics, bandsDb: [1, 2, 3] }))
      .toThrow(/bandsDb/i)
    expect(() => compareAudioMetrics({ ...referenceMetrics, bandsDb: new Array(10).fill(Number.NaN) }, referenceMetrics))
      .toThrow(/bandsDb/i)
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
