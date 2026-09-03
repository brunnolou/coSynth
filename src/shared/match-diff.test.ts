import { describe, expect, it } from 'vitest'
import type { AudioMetrics, AudioMetricsComparison, SpectralWindow } from './audio-analysis'
import { SPECTRAL_WINDOW_NOISE_GATE_DB, compareAudioMetrics } from './audio-analysis'
import { diffAudioMetrics } from './match-diff'
import type { HarmonicShape } from './match-types'
import { formatDiff } from './metrics-format'

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

/**
 * The level of the failing window from the eval: a tail that had decayed into the noise and
 * still reported a 4,978 Hz centroid. Deep under the -40 dB gate, so no rounding argument
 * can put it back over.
 */
const DECAYED_LEVEL_DB = -55

/**
 * Push the named windows under the gate, leaving `belowNoiseFloor` UNSET. Every gate
 * assertion below therefore runs against windows that carry only `levelDb` - a hand-built
 * fixture, or an analysis serialized before the flag existed - which is the case the
 * exported predicate exists to cover.
 */
const decayed = (windows: readonly SpectralWindow[], ...indices: readonly number[]): SpectralWindow[] =>
  windows.map((window, index) =>
    indices.includes(index) ? { ...window, levelDb: DECAYED_LEVEL_DB } : window
  )

/** The floor `partialsDb` clamps at, i.e. "no peak above the noise for this partial". */
const PARTIAL_FLOOR_DB = -120

/**
 * The four harmonic shapes the tilt and odd/even rules turn on, written the way
 * `measureHarmonicShape` would actually write them. The fitted figures are the ones its
 * documented degenerate cases produce, because the whole question here is whether a diff can
 * tell a fitted 0 from a fallback 0.
 */
const shapes = {
  /**
   * A rendered sine. One measurable partial, eleven on the floor - so no slope was fitted and
   * `tiltDbPerOctave` is the fallback 0. `oddEvenDb` is a real 120 dB: the even partials are
   * genuinely absent, which is the measurement rather than a gap in it.
   */
  sine: (): HarmonicShape => ({
    amplitudesDbRelF0: [0, ...Array.from({ length: 11 }, () => PARTIAL_FLOOR_DB)],
    tiltDbPerOctave: 0,
    oddEvenDb: 120
  }),
  /** Twelve equal partials. The slope really was fitted, and it really is 0. */
  flat: (): HarmonicShape => ({
    amplitudesDbRelF0: Array.from({ length: 12 }, () => 0),
    tiltDbPerOctave: 0,
    oddEvenDb: 0
  }),
  /** A band-limited square: six odd partials falling, every even one absent. */
  square: (oddEvenDb = 106.6): HarmonicShape => ({
    amplitudesDbRelF0: [0, -120, -9.5, -120, -14, -120, -16.9, -120, -19.1, -120, -20.8, -120],
    tiltDbPerOctave: -6.9,
    oddEvenDb
  }),
  /** Nothing above the noise anywhere, reachable when the fundamental's own peak is missing. */
  silent: (): HarmonicShape => ({
    amplitudesDbRelF0: Array.from({ length: 12 }, () => PARTIAL_FLOOR_DB),
    tiltDbPerOctave: 0,
    oddEvenDb: 0
  })
}

const withShape = (shape: HarmonicShape): AudioMetrics => makeMetrics({ harmonicShape: shape })

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

  it('marks the bands one side could not measure, and marks exactly the ones the score dropped', () => {
    // The failure from a live eval: a reference decoded at 16 kHz against a candidate
    // rendered at 48 kHz. The 16 kHz band's lower edge is 11.3 kHz, above the 8 kHz Nyquist
    // of the reference, so `bandsDb` reads its -100 floor there for want of anything to
    // measure - on both sides once the pair is capped by the lower rate, which is a silent,
    // flattering agreement rather than a match.
    const flooredTop = (bandsDb: readonly number[]): number[] => [...bandsDb.slice(0, 9), -100]
    const reference = makeMetrics({ sampleRateHz: 16000, bandsDb: flooredTop(makeMetrics().bandsDb) })
    const candidate = makeMetrics({ sampleRateHz: 48000, bandsDb: flooredTop(makeMetrics().bandsDb) })

    const diff = diffAudioMetrics(reference, candidate, comparison())

    expect(diff.bands).toHaveLength(10)
    expect(diff.bands[9].centerHz).toBe(16000)
    expect(diff.bands[9].aboveNyquist).toBe(true)
    // Kept, never dropped: the frequency axis stays readable and `deltaDb` stays finite.
    expect(Number.isFinite(diff.bands[9].deltaDb)).toBe(true)
    // And the marker never lands on a band that WAS compared. The 8 kHz band straddles the
    // limit - its lower edge is 5.7 kHz - so it keeps its real, if partial, content.
    for (const band of diff.bands.slice(0, 9)) expect(Object.keys(band)).toEqual(['centerHz', 'deltaDb'])

    // The agreement, asserted rather than trusted: `bandsDetail` counts what it scored and
    // this module derives its marks independently, from the same two sample rates. If the
    // two rules ever drift, the printed table and the score it explains stop describing the
    // same bands - which is the whole defect this marker exists for.
    const scored = compareAudioMetrics(reference, candidate).details.bands
    expect(diff.bands.filter((band) => !band.aboveNyquist)).toHaveLength(scored.bandsCompared)
    expect(scored.bandsCompared).toBe(9)
  })

  it('marks a band above BOTH Nyquists too, since neither side could measure it', () => {
    const at16k = makeMetrics({ sampleRateHz: 16000 })
    const diff = diffAudioMetrics(at16k, at16k, comparison())
    // Identical buffers, so every delta is 0 - and the top band's 0 is the one that means
    // nothing, because no patch move can put energy where the file cannot carry it.
    expect(diff.bands[9].aboveNyquist).toBe(true)
    expect(diff.bands[9].deltaDb).toBe(0)
    expect(compareAudioMetrics(at16k, at16k).details.bands.bandsCompared).toBe(9)
  })

  it('leaves every band unmarked when no rate is known, exactly as before the flag', () => {
    // A hand-built fixture or an analysis serialized before `sampleRateHz` existed: there is
    // no way to tell an empty band from an unmeasurable one, so all ten are compared. The
    // keys are checked by name, so an ungated run emits the same two-key band it always did.
    // The full-rate pair - the common case - is here for the same reason.
    for (const [reference, candidate] of [
      [makeMetrics(), makeMetrics()],
      [makeMetrics({ sampleRateHz: 48000 }), makeMetrics({ sampleRateHz: 48000 })]
    ] as const) {
      const diff = diffAudioMetrics(reference, candidate, comparison())
      for (const band of diff.bands) expect(Object.keys(band)).toEqual(['centerHz', 'deltaDb'])
      expect(compareAudioMetrics(reference, candidate).details.bands.bandsCompared).toBe(10)
    }
  })

  it('gates on the rate it has when only one side records one, as bandsDetail does', () => {
    // `Math.min(nyquistOrUnbounded(ref), nyquistOrUnbounded(cand))`: a missing rate
    // contributes Infinity, so it never widens the limit the other side sets. A 16 kHz
    // candidate cannot hold energy above 8 kHz whatever the reference was decoded at, and
    // the analyzer leaves that band out on exactly these terms. Asserted in both directions,
    // because a `min` written as a `??` would pass one and fail the other.
    for (const [side, reference, candidate] of [
      ['rate on the candidate', makeMetrics(), makeMetrics({ sampleRateHz: 16000 })],
      ['rate on the reference', makeMetrics({ sampleRateHz: 16000 }), makeMetrics()]
    ] as const) {
      const diff = diffAudioMetrics(reference, candidate, comparison())
      expect(diff.bands[9].aboveNyquist, side).toBe(true)
      expect(diff.bands.filter((band) => !band.aboveNyquist), side).toHaveLength(
        compareAudioMetrics(reference, candidate).details.bands.bandsCompared
      )
    }
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

  it('nulls tiltDeltaDbPerOctave when either side fitted no slope, and never claims agreement', () => {
    const full = makeMetrics()
    const sine = withShape(shapes.sine())
    const cases = [
      { side: 'candidate is a sine', reference: full, candidate: sine },
      { side: 'reference is a sine', reference: sine, candidate: full },
      { side: 'both are sines', reference: sine, candidate: sine }
    ] as const

    for (const { side, reference, candidate } of cases) {
      const diff = diffAudioMetrics(reference, candidate, comparison())
      expect(diff.harmonics?.tiltDeltaDbPerOctave, side).toBeNull()
      // What the plain subtraction printed: a sine and a sine both report the fallback 0, so
      // the delta was 0 and the formatter said the two spectra share a slope neither has.
      expect(formatDiff(diff), side).not.toContain('same slope')
      expect(formatDiff(diff), side).toContain('tilt n/a dB/oct')
    }
    // The old arithmetic, spelled out: this is the number that reached the formatter.
    expect(shapes.sine().tiltDbPerOctave - shapes.sine().tiltDbPerOctave).toBe(0)

    // `measuredTilt` is imported from `audio-analysis.ts`, so both sides run one implementation.
    // `details.tilt.delta` is that copy's answer as the SCORE sees it - `harmonicTerm` writes
    // `candidate - reference`, or `null` when a side was unmeasurable - so asserting the two
    // agree over every shape is what keeps the diff and the score reading it the same way.
    for (const reference of Object.values(shapes)) {
      for (const candidate of Object.values(shapes)) {
        const pair = [withShape(reference()), withShape(candidate())] as const
        expect(diffAudioMetrics(pair[0], pair[1], comparison()).harmonics?.tiltDeltaDbPerOctave)
          .toBe(compareAudioMetrics(pair[0], pair[1]).details.tilt.delta)
      }
    }
  })

  it('keeps a real 0 tilt delta when both spectra genuinely are flat', () => {
    // The other half of the ambiguity, and the reason this cannot be fixed by nulling every
    // 0: twelve measurable partials at one level is a fitted slope of 0 dB/octave, and two of
    // them agree about it. `null` here would replace one collapse with another.
    const diff = diffAudioMetrics(withShape(shapes.flat()), withShape(shapes.flat()), comparison())
    expect(diff.harmonics?.tiltDeltaDbPerOctave).toBe(0)
    expect(formatDiff(diff)).toContain('(same slope)')

    // And a fitted slope against a fitted slope still reports its difference.
    const steeper = diffAudioMetrics(makeMetrics(), withShape(shapes.flat()), comparison())
    expect(steeper.harmonics?.tiltDeltaDbPerOctave).toBeCloseTo(6.1, 5)
  })

  it('reports a real oddEvenDeltaDb for a square, whose missing even partials ARE the measurement', () => {
    // The case `measureHarmonicShape` protects: a parity group entirely on the floor is
    // measured *at* the floor, because "this sound has no even partials" is exactly what this
    // axis says. Nulling it would throw away the one number that separates square from saw.
    const diff = diffAudioMetrics(
      withShape(shapes.square()),
      withShape(shapes.square(100.2)),
      comparison()
    )
    expect(diff.harmonics?.oddEvenDeltaDb).toBeCloseTo(-6.4, 5)

    // A sine has one measurable partial - too few for a slope, but plenty for this axis.
    const sine = diffAudioMetrics(makeMetrics(), withShape(shapes.sine()), comparison())
    expect(sine.harmonics?.tiltDeltaDbPerOctave).toBeNull()
    expect(sine.harmonics?.oddEvenDeltaDb).toBeCloseTo(117.2, 5)
  })

  it('nulls oddEvenDeltaDb only when a side found no partial above the noise at all', () => {
    // `measureHarmonicShape` falls back to 0 here, which is also what a sawtooth's
    // near-balance produces - opposite meanings, one number.
    const silent = withShape(shapes.silent())
    for (const [side, reference, candidate] of [
      ['candidate', makeMetrics(), silent],
      ['reference', silent, makeMetrics()],
      ['both', silent, silent]
    ] as const) {
      const diff = diffAudioMetrics(reference, candidate, comparison())
      expect(diff.harmonics?.oddEvenDeltaDb, side).toBeNull()
      expect(diff.harmonics?.tiltDeltaDbPerOctave, side).toBeNull()
      expect(formatDiff(diff), side).toContain('odd/even n/a dB')
    }

    // A saw against a saw: both near 0 dB, both measured, so the delta is a real 0.
    const saw = diffAudioMetrics(makeMetrics(), makeMetrics(), comparison())
    expect(saw.harmonics?.oddEvenDeltaDb).toBe(0)
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

  it('marks a brightness row when the reference slice, the candidate slice or both are gated', () => {
    const bright = spectralWindows([2000, 1600, 1200, 900])
    const cases = [
      { side: 'reference', reference: decayed(bright, 3), candidate: bright },
      { side: 'candidate', reference: bright, candidate: decayed(bright, 3) },
      { side: 'both', reference: decayed(bright, 3), candidate: decayed(bright, 3) }
    ] as const

    for (const { side, reference, candidate } of cases) {
      const diff = diffAudioMetrics(
        makeMetrics({ spectralWindows: reference }),
        makeMetrics({ spectralWindows: candidate }),
        comparison()
      )
      // Marked, never dropped: the count and the timeline stay readable.
      expect(diff.brightness, side).toHaveLength(4)
      expect(diff.brightness[3].belowNoiseFloor, side).toBe(true)
      expect([diff.brightness[3].startMs, diff.brightness[3].endMs], side).toEqual([495, 660])
      expect(Number.isFinite(diff.brightness[3].octaveDelta), side).toBe(true)
      // And no measured row is caught by it.
      for (const row of diff.brightness.slice(0, 3)) expect(row.belowNoiseFloor, side).toBeUndefined()
    }
  })

  it('gates on levelDb through the exported predicate, so an unflagged window is gated too', () => {
    const base = spectralWindows([2000, 1600, 1200, 900])
    const at = (levelDb: number, extra: Partial<SpectralWindow> = {}): SpectralWindow[] =>
      base.map((window, index) => (index === 3 ? { ...window, levelDb, ...extra } : window))
    const rows = (windows: SpectralWindow[]) =>
      diffAudioMetrics(
        makeMetrics({ spectralWindows: base }),
        makeMetrics({ spectralWindows: windows }),
        comparison()
      ).brightness

    // A hand-built window, or one deserialized from an analysis older than the flag: it
    // carries a level and nothing else, and it is gated on that alone.
    const unflagged = at(SPECTRAL_WINDOW_NOISE_GATE_DB - 0.1)
    expect(unflagged[3].belowNoiseFloor).toBeUndefined()
    expect(rows(unflagged)[3].belowNoiseFloor).toBe(true)
    // The analyzer's flag is set from the same predicate, so adding it changes nothing.
    expect(rows(at(SPECTRAL_WINDOW_NOISE_GATE_DB - 0.1, { belowNoiseFloor: true }))).toEqual(rows(unflagged))
    // The threshold test is strict, so a window sitting exactly on it is still measured.
    expect(rows(at(SPECTRAL_WINDOW_NOISE_GATE_DB))[3].belowNoiseFloor).toBeUndefined()
  })

  it('gates the pair each row compared, not the trajectories it was resampled from', () => {
    // Reference finer than the candidate: rows 0…3 sample reference windows 0, 2, 5 and 7,
    // so windows 1, 3, 4 and 6 are differenced by no row at all. Gating the source arrays
    // before resampling would mark rows for slices that nothing compared.
    const fine = spectralWindows(Array(8).fill(1000), 660)
    const coarse = spectralWindows(Array(4).fill(1000), 1650)
    const marks = (reference: SpectralWindow[]) =>
      diffAudioMetrics(
        makeMetrics({ spectralWindows: reference }),
        makeMetrics({ spectralWindows: coarse }),
        comparison()
      ).brightness.map((row) => row.belowNoiseFloor ?? false)

    expect(marks(decayed(fine, 1, 3, 4, 6))).toEqual([false, false, false, false])
    // Window 5 is the one row 2 samples, so that row - and only that row - is marked.
    expect(marks(decayed(fine, 5))).toEqual([false, false, true, false])
  })

  it('adds nothing at all to a row whose two slices were both measured', () => {
    const diff = diffAudioMetrics(
      makeMetrics(),
      makeMetrics({ spectralWindows: spectralWindows([1000, 800, 600, 450]) }),
      comparison()
    )
    // `toEqual` reads a present-but-undefined key as absent, so the keys are checked by
    // name: an ungated run emits the same three-key row it emitted before the gate existed.
    for (const row of diff.brightness) expect(Object.keys(row)).toEqual(['startMs', 'endMs', 'octaveDelta'])
  })

  it('marks exactly the windows compareAudioMetrics left out of the score', () => {
    const reference = makeMetrics({ spectralWindows: spectralWindows([2000, 1600, 1200, 900]) })
    // The failure this gate exists for: a tail that had decayed to -55 dB and still reported
    // a 4,978 Hz centroid, brighter than the note that produced it.
    const candidate = makeMetrics({ spectralWindows: decayed(spectralWindows([1000, 800, 600, 4978]), 3) })

    const diff = diffAudioMetrics(reference, candidate, comparison())
    const measured = diff.brightness.filter((row) => !row.belowNoiseFloor)
    expect(measured).toHaveLength(3)
    expect(Math.abs(diff.brightness[3].octaveDelta)).toBeGreaterThan(2)

    // `brightnessDetail` scores exp(-mean |octave error| / 0.5) over the windows it counted.
    // Recomputing that from the rows this module did NOT mark is the agreement: the table
    // and the score cannot be reading different sets of windows and still land on the same
    // number. Assert it rather than trust it - they resample independently.
    const meanError = (rows: readonly { octaveDelta: number }[]) =>
      rows.reduce((sum, row) => sum + Math.abs(row.octaveDelta), 0) / rows.length
    const scored = compareAudioMetrics(reference, candidate).details.brightness.similarity
    // Three of the four pairs survived the gate, so the term is a number rather than the
    // `null` an all-gated comparison reports. Narrowed here so the arithmetic below is
    // arithmetic on the score, not on a `null` coerced to 0.
    expect(typeof scored).toBe('number')
    if (scored === null) throw new Error('unreachable')
    expect(scored).toBeCloseTo(Math.exp(-meanError(measured) / 0.5), 12)
    // The marked row is not a rounding detail: counting it moves the score by half again.
    expect(Math.exp(-meanError(diff.brightness) / 0.5)).toBeLessThan(scored * 0.8)
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

  it('prints no NaN, undefined or null when every nullable field is unmeasurable at once', () => {
    // Every new `null` this module can produce, in one payload, through the formatter that
    // has to survive them. `n/a` is the only thing a reader may ever see in their place.
    const worst = diffAudioMetrics(
      makeMetrics({ sampleRateHz: 16000, harmonicShape: shapes.silent(), decayT60Ms: null, pitch: null }),
      makeMetrics({ sampleRateHz: 48000, harmonicShape: shapes.sine(), decayT60Ms: null }),
      comparison()
    )
    expect(worst.harmonics?.tiltDeltaDbPerOctave).toBeNull()
    expect(worst.harmonics?.oddEvenDeltaDb).toBeNull()
    expect(worst.bands[9].aboveNyquist).toBe(true)

    const text = formatDiff(worst)
    for (const forbidden of ['NaN', 'undefined', 'null', 'Infinity']) {
      expect(text, forbidden).not.toContain(forbidden)
    }
  })

  it('passes similarity through untouched and leaves actions to match-advice', () => {
    const diff = diffAudioMetrics(makeMetrics(), makeMetrics(), comparison(0.4172))
    expect(diff.similarity).toBe(0.4172)
    expect(diff.actions).toEqual([])
  })
})
