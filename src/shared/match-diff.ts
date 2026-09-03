/**
 * The signed reference-versus-candidate error, per dimension.
 *
 * `compareAudioMetrics` answers "how close are you"; every one of its detail blocks computes
 * a per-band, per-window or per-partial error and then collapses it to a scalar mean. The
 * project's own eval recorded what that costs: `details.bands` sat at 0.000-0.008 through
 * every iteration, and "an agent has no way to tell which" band was wrong. A score with no
 * gradient is a number to guess against. This module keeps the gradient.
 *
 * Two invariants hold everywhere below, and they matter more than the arithmetic:
 *
 * 1. The sign is `candidate - reference`, with no exceptions. Negative means the candidate
 *    is quieter, darker, shorter or narrower than the reference. A convention the reader
 *    has to re-derive per block is a bug.
 * 2. `null` means "not measurable on one side", never "no difference". A 0 that means
 *    "unknown" is exactly how a model gets confidently misled.
 * 3. The two ARRAYS state the same thing with a flag instead: `belowNoiseFloor` on a
 *    brightness row whose slices were not both above the analyzer's noise gate, and
 *    `aboveNyquist` on a band whose lower edge sits above one side's Nyquist. Their numbers
 *    stay numbers so that the rules in `match-advice.ts` which mean, spread and trend these
 *    arrays keep doing arithmetic on numbers; each of them drops the marked entries first,
 *    and so must the formatter. Both flags mark exactly what `compareAudioMetrics` left out
 *    of the score, which is the only way a printed table and the score it explains can agree.
 */

import type {
  AudioMetrics,
  AudioMetricsComparison,
  SpectralWindow
} from './audio-analysis'
import { isMeasuredPartial, isSpectralWindowBelowNoiseFloor } from './audio-analysis'
import type { HarmonicShape, MatchDiff } from './match-types'

/** Octave band centres: 31.25 Hz doubled nine times, ending at 16 kHz. Mirrors the analyzer. */
export const BAND_CENTERS_HZ: readonly number[] = Array.from({ length: 10 }, (_, index) => 31.25 * 2 ** index)

/** The analyzer's partial count. */
const HARMONIC_COUNT = 12

/**
 * Added to both centroids before the ratio, exactly as `brightnessDetail` does, so a silent
 * window (0 Hz) yields a finite octave distance instead of -Infinity or NaN. The guard is
 * symmetric, so two equal centroids still read 0 octaves.
 */
const BRIGHTNESS_FLOOR_HZ = 20

/**
 * Highest frequency a buffer at this rate can carry, or `Infinity` when the rate is not
 * recorded - which a metrics object built by hand, or serialized before `sampleRateHz`
 * existed, is. `Infinity` never widens the limit the two sides are capped to, so a rate
 * missing on one side leaves the other side's rate doing the gating, and a pair with no rate
 * at all takes every band as measurable, exactly as it did before the flag existed.
 *
 * The same function as `nyquistOrUnbounded` in `audio-analysis.ts`, which is where the rule
 * is argued; it is private there, so this is a copy rather than an import. The agreement is
 * asserted rather than trusted: a test compares the bands this module leaves unmarked
 * against `details.bands.bandsCompared`, so the two cannot drift apart in silence.
 */
const nyquistOrUnbounded = (sampleRateHz: number | undefined): number =>
  typeof sampleRateHz === 'number' && Number.isFinite(sampleRateHz) && sampleRateHz > 0
    ? sampleRateHz / 2
    : Number.POSITIVE_INFINITY

/**
 * Could the band at `index` hold energy below `limitHz`? Octave bands, so the band centred
 * at f spans f/sqrt(2) to f*sqrt(2); once its LOWER edge is above the limit there is nothing
 * in it to measure at any level. Mirrors `isBandMeasurable` in `audio-analysis.ts`.
 */
const isBandMeasurable = (index: number, limitHz: number): boolean =>
  BAND_CENTERS_HZ[index] / Math.SQRT2 < limitHz

/**
 * `tiltDbPerOctave`, or `null` when the fit had nothing to fit.
 *
 * `measureHarmonicShape` writes 0 for a shape with fewer than two measurable partials and
 * says so: that 0 is "no tilt measurable", which is the same number a genuinely flat
 * spectrum produces. Subtracting one from the other therefore printed `(same slope)` about a
 * slope one side never had - a rendered sine floors partials 2-12, so it has exactly one
 * measurable partial and no slope at all. `measuredTilt` in `audio-analysis.ts` is this
 * function, and feeds the tilt term of the score; it is private there, so this is a copy.
 */
const measuredTilt = (shape: HarmonicShape): number | null =>
  shape.amplitudesDbRelF0.filter(isMeasuredPartial).length >= 2 ? shape.tiltDbPerOctave : null

/**
 * `oddEvenDb`, or `null` when no partial at all was found.
 *
 * The line here is NOT the one `measuredTilt` draws, and the difference is the whole point.
 * `measureHarmonicShape` treats a parity group with nothing above the noise as measured *at*
 * the floor, because that absence is exactly what this axis reports: a band-limited square's
 * even partials really are missing, and reading them as unmeasurable would throw away the
 * one measurement that separates a square from a saw. The reading is meaningless only when
 * NEITHER parity found anything, which is where `measureHarmonicShape` falls back to 0 -
 * the same number a saw's near-balance produces. `amplitudesDbRelF0` tells the two apart,
 * by whether any entry is above the floor, and that is what this asks.
 */
const measuredOddEven = (shape: HarmonicShape): number | null =>
  shape.amplitudesDbRelF0.some(isMeasuredPartial) ? shape.oddEvenDb : null

/** `candidate - reference`, or `null` when either side is absent. */
const subtractOrNull = (reference: number | null | undefined, candidate: number | null | undefined): number | null =>
  typeof reference === 'number' && typeof candidate === 'number' && Number.isFinite(reference) && Number.isFinite(candidate)
    ? candidate - reference
    : null

const octaveDelta = (referenceHz: number, candidateHz: number): number => {
  const left = Math.max(0, referenceHz) + BRIGHTNESS_FLOOR_HZ
  const right = Math.max(0, candidateHz) + BRIGHTNESS_FLOOR_HZ
  const delta = Math.log2(right / left)
  return Number.isFinite(delta) ? delta : 0
}

const pitchHz = (metrics: AudioMetrics): number | null => {
  const f0 = metrics.pitch?.f0Hz
  return typeof f0 === 'number' && Number.isFinite(f0) && f0 > 0 ? f0 : null
}

function diffHarmonics(reference: AudioMetrics, candidate: AudioMetrics): MatchDiff['harmonics'] {
  const referenceShape = reference.harmonicShape
  const candidateShape = candidate.harmonicShape
  // The whole block is `null` when either side has no harmonic analysis: there is no
  // fundamental to express the partials relative to, so no entry in it would be measurable.
  if (!referenceShape || !candidateShape || !reference.harmonics || !candidate.harmonics) return null

  const deltaDb: (number | null)[] = []
  for (let index = 0; index < HARMONIC_COUNT; index++) {
    const left = referenceShape.amplitudesDbRelF0[index]
    const right = candidateShape.amplitudesDbRelF0[index]
    // The analyzer's own predicate, imported rather than restated: `amplitudesDbRelF0`
    // writes its -120 dB floor for a partial with no peak above the noise, so a delta
    // against it would measure how deep `partialsDb` happens to clamp rather than the
    // sound. Two modules with two definitions of "this partial exists" would eventually
    // disagree about which column a number belongs in.
    deltaDb.push(isMeasuredPartial(left) && isMeasuredPartial(right) ? right - left : null)
  }

  return {
    deltaDb,
    // Both of these are subtractions of a field whose 0 is ambiguous, so both go through
    // `subtractOrNull` on values that are already `null` when unmeasurable. The two
    // predicates differ, deliberately - see each one.
    tiltDeltaDbPerOctave: subtractOrNull(measuredTilt(referenceShape), measuredTilt(candidateShape)),
    oddEvenDeltaDb: subtractOrNull(measuredOddEven(referenceShape), measuredOddEven(candidateShape)),
    inharmonicityDelta: candidate.harmonics.inharmonicity - reference.harmonics.inharmonicity
  }
}

/**
 * Nearest source window for output row `index` of a `points`-long grid, by *position*.
 *
 * Deliberately the same arithmetic as `brightnessDetail` in `audio-analysis.ts`: that
 * function scores the very trajectories this one reports, and two resampling conventions
 * for one quantity would let the table and the score disagree about which slices were
 * compared. Endpoints anchor - row 0 is the first slice of each side and the last row the
 * last - so the map is over fraction-of-sound rather than over milliseconds.
 *
 * `points <= 1` has no fraction to interpolate (0/0); the single row reads the first
 * window, which keeps the degenerate case finite instead of indexing past the array.
 */
const resampledIndex = (length: number, index: number, points: number): number =>
  points > 1
    ? Math.min(length - 1, Math.max(0, Math.round(index * (length - 1) / (points - 1))))
    : 0

/**
 * Per-window signed brightness error, resampled by position onto the coarser of the two
 * grids.
 *
 * `analyze_reference_audio` takes `windows: 4…32`, so the two sides can carry different
 * counts. Each window is an equal, consecutive slice of *its own* buffer, so window i of a
 * 4-window run and window i of an 8-window run describe different spans of sound: pairing
 * by index compared the reference's first half against the whole candidate and handed
 * `filter-cutoff-static` / `filter-envelope-depth` a trajectory whose trend, and often
 * whose sign, belonged to no pair of slices that exist. Index position is fraction of
 * sound here, so aligning on it also survives the two sounds having different durations -
 * a reference file and a rendered candidate rarely share one.
 *
 * The output grid is the COARSER side. Resampling up would invent resolution neither
 * measurement has, repeat nearest-neighbour values into plateaus that read as real
 * brightness holds, and lengthen a table a human and a model read row by row.
 *
 * `startMs`/`endMs` are the bounds of the REFERENCE slice this row sampled - the provenance
 * of the row's reference centroid, never a span shared with the candidate, whose matching
 * slice sits at the same fraction of a possibly different duration. When the reference is
 * the coarser side (equal counts included) every row samples reference[i], so the labels
 * are its windows verbatim and the common path is unchanged.
 *
 * A row whose reference slice, candidate slice, or both sit below the analyzer's noise gate
 * is marked `belowNoiseFloor` rather than dropped. One of its two centroids was measured on
 * the noise the sound decayed into, so its `octaveDelta` is the distance from a sound to a
 * noise floor: a near-silent -55 dB tail once read a 4,978 Hz centroid and manufactured a
 * +4.9-octave "brightness swing" that ranked an `env2.decay` move first. The row survives so
 * the count and the timeline stay readable; the flag is what a consumer drops.
 *
 * THE GATE IS APPLIED AFTER RESAMPLING, to the two windows a row actually differenced. The
 * two sides can carry different window counts, so a slice that is under the gate in the
 * finer trajectory may be sampled by no row at all, and one that is over it may be sampled
 * by several. Gating the source arrays first would therefore mark a set of rows that does
 * not correspond to any pair being compared. `brightnessDetail` in `audio-analysis.ts`
 * resamples and then tests its resampled pair, exactly here, which is what makes this array
 * and the score agree on which windows counted.
 */
function diffBrightness(
  reference: readonly SpectralWindow[],
  candidate: readonly SpectralWindow[]
): MatchDiff['brightness'] {
  const points = Math.min(reference.length, candidate.length)
  const windows: MatchDiff['brightness'] = []
  for (let index = 0; index < points; index++) {
    const referenceWindow = reference[resampledIndex(reference.length, index, points)]
    const candidateWindow = candidate[resampledIndex(candidate.length, index, points)]
    const row: MatchDiff['brightness'][number] = {
      startMs: referenceWindow.startMs,
      endMs: referenceWindow.endMs,
      octaveDelta: octaveDelta(referenceWindow.spectralCentroidHz, candidateWindow.spectralCentroidHz)
    }
    // The exported predicate rather than a local threshold: it reads `levelDb`, so a window
    // hand-built in a test or deserialized from an analysis that predates the flag is gated
    // on the same terms as one the analyzer marked, and there is one number to change.
    if (isSpectralWindowBelowNoiseFloor(referenceWindow) || isSpectralWindowBelowNoiseFloor(candidateWindow)) {
      row.belowNoiseFloor = true
    }
    windows.push(row)
  }
  return windows
}

/**
 * The signed error between two analyses, in the unit of the parameter that moves each one.
 *
 * `comparison.similarity` is passed straight through so existing eval trajectories stay
 * comparable. `actions` is left empty here; `match-advice.ts` owns the mapping from these
 * numbers to coSynth's parameter vocabulary.
 */
export function diffAudioMetrics(
  reference: AudioMetrics,
  candidate: AudioMetrics,
  comparison: AudioMetricsComparison
): MatchDiff {
  const referenceHz = pitchHz(reference)
  const candidateHz = pitchHz(candidate)

  const bandCount = Math.min(reference.bandsDb.length, candidate.bandsDb.length, BAND_CENTERS_HZ.length)
  // The lower of the two Nyquists: `bandsDetail` scores only the bands measurable on BOTH
  // sides, so a 16 kHz reference against a 48 kHz render cuts the same band off both.
  const limitHz = Math.min(nyquistOrUnbounded(reference.sampleRateHz), nyquistOrUnbounded(candidate.sampleRateHz))
  const bands: MatchDiff['bands'] = []
  for (let index = 0; index < bandCount; index++) {
    const band: MatchDiff['bands'][number] = {
      centerHz: BAND_CENTERS_HZ[index],
      deltaDb: candidate.bandsDb[index] - reference.bandsDb[index]
    }
    // Marked, never dropped - the same shape as `belowNoiseFloor` on a brightness row. The
    // table keeps all ten bands so the frequency axis stays readable and the row count stays
    // predictable, and the flag is what a consumer drops. Whoever means or trends this array
    // must drop them, and so must the formatter: `bandsDb` reads its -100 floor for a band
    // above the Nyquist whatever the sound is, so the two sides "agree" there for free and a
    // printed `0.0` is a match the score never counted.
    if (!isBandMeasurable(index, limitHz)) band.aboveNyquist = true
    bands.push(band)
  }

  return {
    similarity: comparison.similarity,
    pitch: {
      referenceHz,
      candidateHz,
      centsError:
        referenceHz !== null && candidateHz !== null ? 1200 * Math.log2(candidateHz / referenceHz) : null
    },
    harmonics: diffHarmonics(reference, candidate),
    bands,
    envelope: {
      attackMsDelta: candidate.attackMs - reference.attackMs,
      timeToPeakMsDelta: candidate.timeToPeakMs - reference.timeToPeakMs,
      decayT60MsDelta: subtractOrNull(reference.decayT60Ms, candidate.decayT60Ms),
      sustainDbDelta: candidate.sustainDb - reference.sustainDb
    },
    brightness: diffBrightness(reference.spectralWindows, candidate.spectralWindows),
    flatnessDelta: candidate.spectralFlatness - reference.spectralFlatness,
    stereoWidthDelta: candidate.stereoWidth - reference.stereoWidth,
    loudnessDbDelta: candidate.loudnessDb - reference.loudnessDb,
    actions: []
  }
}
