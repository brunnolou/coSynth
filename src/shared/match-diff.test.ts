import { describe, expect, it } from 'vitest'
import type { AudioMetrics, AudioMetricsComparison, SpectralWindow } from './audio-analysis'
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

/**
 * `windows` equal, consecutive slices of one buffer, the way the analyzer emits them: the
 * count varies (`analyze_reference_audio` takes 4…32) and `totalMs` varies independently,
 * because the reference is a file and the candidate is a render.
 */
const spectralWindows = (centroidsHz: readonly number[], totalMs = 660): SpectralWindow[] =>
  centroidsHz.map((spectralCentroidHz, index) => ({
    startMs: (index * totalMs) / centroidsHz.length,
    endMs: ((index + 1) * totalMs) / centroidsHz.length,
    spectralCentroidHz,
    spectralRolloffHz: spectralCentroidHz * 3,
    levelDb: 0
  }))

/** The octave delta the diff should report for one pair of centroids, floor included. */
const expectedDelta = (referenceHz: number, candidateHz: number): number =>
  Math.log2((candidateHz + 20) / (referenceHz + 20))

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

  it('resamples mismatched window counts by position instead of pairing by index', () => {
    // One sound, analysed twice. It holds 4 kHz for its first half and drops to 500 Hz for
    // its second; the candidate is that same trajectory a little brighter throughout, and
    // 2.5x longer, as a render of a shorter reference file would be.
    const reference = makeMetrics({
      spectralWindows: spectralWindows([4000, 4000, 4000, 4000, 500, 500, 500, 500], 660)
    })
    const candidate = makeMetrics({
      spectralWindows: spectralWindows([5000, 5000, 700, 700], 1650)
    })

    const diff = diffAudioMetrics(reference, candidate, comparison())

    // Resampled onto the coarser (4-window) grid: reference windows 0, 2, 5 and 7 sit at the
    // same fractions of their buffer as candidate windows 0…3, so every row compares a
    // brighter candidate slice against its own reference slice - positive throughout.
    expect(diff.brightness.map((window) => window.octaveDelta)).toEqual([
      expectedDelta(4000, 5000),
      expectedDelta(4000, 5000),
      expectedDelta(500, 700),
      expectedDelta(500, 700)
    ])
    for (const window of diff.brightness) expect(window.octaveDelta).toBeGreaterThan(0)

    // What pairing by index reported instead: rows 2 and 3 read the reference's *first half*
    // against the candidate's second, so a uniformly brighter candidate came back 2.48
    // octaves DARK with the sign inverted, and the first-to-last trend fell 2.8 octaves -
    // `filter-envelope-depth` would rank "darkens too fast, lengthen env2.decay" at the top
    // of a sound that never darkened at all.
    const pairedByIndex = [0, 1, 2, 3].map((index) =>
      expectedDelta(
        reference.spectralWindows[index].spectralCentroidHz,
        candidate.spectralWindows[index].spectralCentroidHz
      )
    )
    expect(pairedByIndex[2]).toBeLessThan(-2)
    expect(Math.sign(pairedByIndex[2])).toBe(-Math.sign(diff.brightness[2].octaveDelta))
    const trend = (windows: readonly { octaveDelta: number }[]) =>
      windows[windows.length - 1].octaveDelta - windows[0].octaveDelta
    expect(pairedByIndex[3] - pairedByIndex[0]).toBeLessThan(-2.5)
    expect(trend(diff.brightness)).toBeGreaterThan(0)
  })

  it('resamples the candidate when it is the finer side, mirroring the same positions', () => {
    const reference = makeMetrics({ spectralWindows: spectralWindows([4000, 4000, 500, 500], 660) })
    const candidate = makeMetrics({
      spectralWindows: spectralWindows([5000, 5000, 5000, 5000, 700, 700, 700, 700], 400)
    })

    const diff = diffAudioMetrics(reference, candidate, comparison())

    expect(diff.brightness.map((window) => window.octaveDelta)).toEqual([
      expectedDelta(4000, 5000),
      expectedDelta(4000, 5000),
      // Candidate windows 0, 2, 5 and 7 - the same fractions of a buffer 260 ms shorter.
      expectedDelta(500, 700),
      expectedDelta(500, 700)
    ])
  })

  it('leaves the equal-count path exactly as it was', () => {
    // The common case: both sides analysed at the default 4 windows. Hardcoded rather than
    // recomputed, so a change to the resampling that perturbs this path fails here.
    const candidate = makeMetrics({ spectralWindows: spectralWindows([1000, 800, 600, 450]) })
    const diff = diffAudioMetrics(makeMetrics(), candidate, comparison())

    expect(diff.brightness).toHaveLength(4)
    const deltas = diff.brightness.map((window) => window.octaveDelta)
    expect(deltas[0]).toBeCloseTo(-0.985786, 6)
    expect(deltas[1]).toBeCloseTo(-0.982298, 6)
    expect(deltas[2]).toBeCloseTo(-0.976541, 6)
    expect(deltas[3]).toBeCloseTo(-0.968973, 6)
    // Row labels are still the reference's own windows, verbatim.
    expect(diff.brightness.map((window) => [window.startMs, window.endMs])).toEqual(
      makeMetrics().spectralWindows.map((window) => [window.startMs, window.endMs])
    )
  })

  it('labels each row with the reference slice it sampled, never the candidate timeline', () => {
    // Reference finer than the candidate, and on a different timeline: rows 0…3 sample
    // reference windows 0, 2, 5 and 7, so those are the bounds that must be reported. Neither
    // reference[0…3] nor any candidate bound would be true of the numbers being differenced.
    const reference = makeMetrics({ spectralWindows: spectralWindows(Array(8).fill(1000), 660) })
    const candidate = makeMetrics({ spectralWindows: spectralWindows(Array(4).fill(1000), 1650) })

    const diff = diffAudioMetrics(reference, candidate, comparison())

    expect(diff.brightness.map((window) => [window.startMs, window.endMs])).toEqual(
      [0, 2, 5, 7].map((index) => [
        reference.spectralWindows[index].startMs,
        reference.spectralWindows[index].endMs
      ])
    )
    const candidateBounds = candidate.spectralWindows.map((window) => window.endMs)
    for (const window of diff.brightness) expect(candidateBounds).not.toContain(window.endMs)
  })

  it('handles both extremes of the 4…32 window range without throwing', () => {
    const fine = makeMetrics({
      spectralWindows: spectralWindows(Array.from({ length: 32 }, (_, index) => 4000 - index * 100))
    })
    const coarse = makeMetrics({ spectralWindows: spectralWindows([3800, 2600, 1400, 400], 900) })

    for (const [reference, candidate] of [[fine, coarse], [coarse, fine]] as const) {
      const diff = diffAudioMetrics(reference, candidate, comparison())
      expect(diff.brightness).toHaveLength(4)
      for (const window of diff.brightness) {
        expect(Number.isFinite(window.octaveDelta)).toBe(true)
        expect(Number.isFinite(window.startMs)).toBe(true)
        expect(Number.isFinite(window.endMs)).toBe(true)
      }
    }
  })

  it('survives the degenerate one-window and zero-window grids', () => {
    // Below the analyzer's 4-window floor, so unreachable through `analyzeAudio`; the diff is
    // a pure function over its argument and must not divide by zero windows either way.
    const single = makeMetrics({ spectralWindows: spectralWindows([1500]) })
    const none = makeMetrics({ spectralWindows: [] })
    const many = makeMetrics({ spectralWindows: spectralWindows([2000, 1600, 1200, 900]) })

    for (const [reference, candidate] of [
      [single, many], [many, single], [single, single], [none, many], [many, none], [none, none]
    ] as const) {
      const diff = diffAudioMetrics(reference, candidate, comparison())
      expect(diff.brightness).toHaveLength(Math.min(reference.spectralWindows.length, candidate.spectralWindows.length))
      everyNumber(diff.brightness, (found, path) => {
        expect(Number.isFinite(found), `${path} is ${found}`).toBe(true)
      })
    }
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
