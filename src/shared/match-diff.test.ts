import { describe, expect, it } from 'vitest'
import type { AudioMetrics, AudioMetricsComparison } from './audio-analysis'
import { diffAudioMetrics } from './match-diff'

/**
 * Fixtures are hand-built rather than analysed: the point of these assertions is the sign
 * and the null semantics of the diff, and running the analyzer would make them depend on
 * whatever it currently measures.
 */
function makeMetrics(overrides: Partial<AudioMetrics> = {}): AudioMetrics {
  return {
    peakDb: -1,
    rmsDb: -14,
    clippingCount: 0,
    dcOffset: 0,
    spectralCentroidHz: 1200,
    attackMs: 10,
    stereoWidth: 0.3,
    timeToPeakMs: 40,
    decayT60Ms: 800,
    sustainDb: -6,
    envelopeDb: Array.from({ length: 64 }, (_, index) => -index / 2),
    loudnessDb: -16,
    bandsDb: [-40, -30, -22, -16, -12, -14, -18, -24, -32, -44],
    spectralRolloffHz: 4000,
    spectralFlatness: 0.2,
    spectralWindows: [
      { startMs: 0, endMs: 165, spectralCentroidHz: 2000, spectralRolloffHz: 6000, levelDb: 0 },
      { startMs: 165, endMs: 330, spectralCentroidHz: 1600, spectralRolloffHz: 5200, levelDb: -3 },
      { startMs: 330, endMs: 495, spectralCentroidHz: 1200, spectralRolloffHz: 4400, levelDb: -7 },
      { startMs: 495, endMs: 660, spectralCentroidHz: 900, spectralRolloffHz: 3600, levelDb: -12 }
    ],
    harmonics: { amplitudesDb: [0, -6, -3, -11, -18, -23, -26, -30, -34, -38, -42, -45], inharmonicity: 3.1e-4 },
    pitch: { f0Hz: 261.9, confidence: 0.91, midi: 60, centsOffset: 2, source: 'detected' },
    harmonicShape: {
      amplitudesDbRelF0: [0, -6.2, -3.1, -11.4, -18, -22.7, -26.1, -30, -34.2, -38.1, -41.7, -45],
      tiltDbPerOctave: -6.1,
      oddEvenDb: 2.8
    },
    ...overrides
  }
}

const comparison = (similarity = 0.612): AudioMetricsComparison =>
  ({ similarity, details: {} } as unknown as AudioMetricsComparison)

/** Walks every number in the diff so a NaN cannot hide in one array entry. */
function everyNumber(value: unknown, visit: (found: number, path: string) => void, path = 'diff'): void {
  if (typeof value === 'number') visit(value, path)
  else if (Array.isArray(value)) value.forEach((entry, index) => everyNumber(entry, visit, `${path}[${index}]`))
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) everyNumber(entry, visit, `${path}.${key}`)
  }
}

describe('diffAudioMetrics', () => {
  it('signs every delta as candidate minus reference', () => {
    const reference = makeMetrics()
    const candidate = makeMetrics({
      loudnessDb: -20,
      sustainDb: -12,
      attackMs: 14,
      timeToPeakMs: 28,
      decayT60Ms: 590,
      stereoWidth: 0.08,
      spectralFlatness: 0.02,
      bandsDb: [-42, -30, -22, -16, -12, -14, -18, -24, -32, -44],
      harmonicShape: {
        // A quieter second partial on the candidate side.
        amplitudesDbRelF0: [0, -14.8, -3.1, -11.4, -18, -22.7, -26.1, -30, -34.2, -38.1, -41.7, -45],
        tiltDbPerOctave: -11.4,
        oddEvenDb: 6.9
      }
    })

    const diff = diffAudioMetrics(reference, candidate, comparison())

    // The invariant most likely to be inverted: quieter candidate, negative delta.
    expect(diff.harmonics?.deltaDb[1]).toBeCloseTo(-8.6, 5)
    expect(diff.loudnessDbDelta).toBeCloseTo(-4, 5)
    expect(diff.envelope.sustainDbDelta).toBeCloseTo(-6, 5)
    expect(diff.envelope.attackMsDelta).toBeCloseTo(4, 5)
    expect(diff.envelope.timeToPeakMsDelta).toBeCloseTo(-12, 5)
    expect(diff.envelope.decayT60MsDelta).toBeCloseTo(-210, 5)
    expect(diff.stereoWidthDelta).toBeCloseTo(-0.22, 5)
    expect(diff.flatnessDelta).toBeCloseTo(-0.18, 5)
    expect(diff.bands[0].deltaDb).toBeCloseTo(-2, 5)
    expect(diff.harmonics?.tiltDeltaDbPerOctave).toBeCloseTo(-5.3, 5)
    expect(diff.harmonics?.oddEvenDeltaDb).toBeCloseTo(4.1, 5)
  })

  it('reports all ten bands with their real centre frequencies', () => {
    const diff = diffAudioMetrics(makeMetrics(), makeMetrics(), comparison())
    expect(diff.bands.map((band) => band.centerHz)).toEqual([
      31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000
    ])
  })

  it('reads a partial measurable on one side only as null rather than 0', () => {
    const reference = makeMetrics()
    const candidate = makeMetrics({
      harmonicShape: {
        // The eleventh partial has no peak above the noise on the candidate side.
        amplitudesDbRelF0: [0, -6.2, -3.1, -11.4, -18, -22.7, -26.1, -30, -34.2, -38.1, -120, -45],
        tiltDbPerOctave: -6.1,
        oddEvenDb: 2.8
      }
    })

    const diff = diffAudioMetrics(reference, candidate, comparison())

    expect(diff.harmonics?.deltaDb[10]).toBeNull()
    // A measured partial that happens to match still reads 0, so null is never "no difference".
    expect(diff.harmonics?.deltaDb[9]).toBe(0)
  })

  it('nulls the whole harmonics block when either side lacks it', () => {
    const withoutHarmonics = makeMetrics({ harmonics: undefined, harmonicShape: undefined, pitch: null })
    expect(diffAudioMetrics(makeMetrics(), withoutHarmonics, comparison()).harmonics).toBeNull()
    expect(diffAudioMetrics(withoutHarmonics, makeMetrics(), comparison()).harmonics).toBeNull()
    expect(diffAudioMetrics(withoutHarmonics, withoutHarmonics, comparison()).harmonics).toBeNull()
  })

  it('nulls decayT60MsDelta when either side never decayed', () => {
    const sustaining = makeMetrics({ decayT60Ms: null })
    expect(diffAudioMetrics(makeMetrics(), sustaining, comparison()).envelope.decayT60MsDelta).toBeNull()
    expect(diffAudioMetrics(sustaining, makeMetrics(), comparison()).envelope.decayT60MsDelta).toBeNull()
    expect(diffAudioMetrics(sustaining, sustaining, comparison()).envelope.decayT60MsDelta).toBeNull()
  })

  it('nulls centsError when either side has no pitch, and signs it candidate-first', () => {
    const flat = makeMetrics({
      pitch: { f0Hz: 261.9 / 2 ** (1 / 12), confidence: 0.9, midi: 59, centsOffset: 0, source: 'detected' }
    })
    expect(diffAudioMetrics(makeMetrics(), flat, comparison()).pitch.centsError).toBeCloseTo(-100, 3)
    expect(diffAudioMetrics(makeMetrics(), makeMetrics({ pitch: null }), comparison()).pitch.centsError).toBeNull()
    expect(diffAudioMetrics(makeMetrics({ pitch: undefined }), makeMetrics(), comparison()).pitch.centsError).toBeNull()
  })

  it('keeps brightness finite when a window is silent', () => {
    const silentTail = makeMetrics({
      spectralWindows: makeMetrics().spectralWindows.map((window, index) =>
        index === 3 ? { ...window, spectralCentroidHz: 0 } : window
      )
    })
    const diff = diffAudioMetrics(makeMetrics(), silentTail, comparison())
    expect(diff.brightness).toHaveLength(4)
    expect(Number.isFinite(diff.brightness[3].octaveDelta)).toBe(true)
    expect(diff.brightness[3].octaveDelta).toBeLessThan(0)
    expect(diff.brightness[0].startMs).toBe(0)
    expect(diff.brightness[0].endMs).toBe(165)
  })

  it('leaks no NaN or Infinity from any division', () => {
    const odd = makeMetrics({
      spectralWindows: makeMetrics().spectralWindows.map((window) => ({ ...window, spectralCentroidHz: 0 })),
      pitch: { f0Hz: 0.0001, confidence: 0, midi: 0, centsOffset: 0, source: 'given' },
      bandsDb: Array.from({ length: 10 }, () => -100)
    })
    const diff = diffAudioMetrics(makeMetrics(), odd, comparison())
    everyNumber(diff, (found, path) => {
      expect(Number.isFinite(found), `${path} is ${found}`).toBe(true)
    })
  })

  it('passes similarity through untouched and leaves actions to match-advice', () => {
    const diff = diffAudioMetrics(makeMetrics(), makeMetrics(), comparison(0.4172))
    expect(diff.similarity).toBe(0.4172)
    expect(diff.actions).toEqual([])
  })
})
