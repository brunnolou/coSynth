import { describe, expect, it } from 'vitest'
import { analyzeAudio, compareAudioMetrics, type AudioMetrics } from './audio-analysis'

function sine(frequency: number, sampleRate: number, seconds: number, amplitude = 1, phase = 0): Float32Array {
  return Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_, i) =>
    amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate + phase))
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

  it('handles silence and rejects malformed input', () => {
    expect(analyzeAudio([new Float32Array(32)], 48000)).toMatchObject({
      peakDb: -160,
      rmsDb: -160,
      spectralCentroidHz: 0,
      attackMs: 0,
      stereoWidth: 0
    })
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

  it('returns accepted metrics whose JSON serialization contains no null numeric values', () => {
    const metrics = analyzeAudio([sine(440, 48000, 0.01, 0.25)], 48000)
    expect(Object.values(metrics).every(Number.isFinite)).toBe(true)
    expect(JSON.stringify(metrics)).not.toContain('null')
  })
})

const metricKeys: (keyof AudioMetrics)[] = [
  'peakDb', 'rmsDb', 'clippingCount', 'dcOffset',
  'spectralCentroidHz', 'attackMs', 'stereoWidth'
]

const referenceMetrics: AudioMetrics = {
  peakDb: -6,
  rmsDb: -12,
  clippingCount: 0,
  dcOffset: 0.001,
  spectralCentroidHz: 1200,
  attackMs: 25,
  stereoWidth: 0.2
}

describe('compareAudioMetrics', () => {
  it('returns exact overall and per-metric similarity of 1 for identical metrics', () => {
    const result = compareAudioMetrics(referenceMetrics, { ...referenceMetrics })
    expect(result.similarity).toBe(1)
    expect(Object.keys(result.details)).toEqual(metricKeys)
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
      peakDb: -18,
      rmsDb: -30,
      clippingCount: 20,
      dcOffset: -0.05,
      spectralCentroidHz: 4800,
      attackMs: 200,
      stereoWidth: 0.9
    }
    const result = compareAudioMetrics(referenceMetrics, candidate)
    expect(result.similarity).toBeGreaterThanOrEqual(0)
    expect(result.similarity).toBeLessThan(1)
    for (const key of metricKeys) {
      expect(result.details[key].reference).toBe(referenceMetrics[key])
      expect(result.details[key].candidate).toBe(candidate[key])
      expect(result.details[key].delta).toBe(candidate[key] - referenceMetrics[key])
      expect(result.details[key].similarity).toBeGreaterThanOrEqual(0)
      expect(result.details[key].similarity).toBeLessThanOrEqual(1)
    }
    expect(result.details.spectralCentroidHz.similarity).toBeLessThan(0.7)
    expect(result.details.attackMs.similarity).toBeLessThan(0.7)
  })

  it('uses finite robust math for silence, zero, and nonnegative edge values', () => {
    const silence: AudioMetrics = {
      peakDb: -160, rmsDb: -160, clippingCount: 0, dcOffset: 0,
      spectralCentroidHz: 0, attackMs: 0, stereoWidth: 0
    }
    const changed: AudioMetrics = {
      peakDb: -159, rmsDb: -140, clippingCount: 1, dcOffset: 0,
      spectralCentroidHz: 20, attackMs: 1, stereoWidth: 0
    }
    for (const result of [compareAudioMetrics(silence, silence), compareAudioMetrics(silence, changed)]) {
      expect(Number.isFinite(result.similarity)).toBe(true)
      for (const key of metricKeys) {
        expect(Number.isFinite(result.details[key].similarity)).toBe(true)
        expect(Number.isFinite(result.details[key].delta)).toBe(true)
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
