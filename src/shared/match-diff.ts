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
 */

import type {
  AudioMetrics,
  AudioMetricsComparison,
  SpectralWindow
} from './audio-analysis'
import type { MatchDiff } from './match-types'

/** Octave band centres: 31.25 Hz doubled nine times, ending at 16 kHz. Mirrors the analyzer. */
export const BAND_CENTERS_HZ: readonly number[] = Array.from({ length: 10 }, (_, index) => 31.25 * 2 ** index)

/** The analyzer's partial count. */
const HARMONIC_COUNT = 12

/**
 * `amplitudesDbRelF0` writes this floor for a partial with no peak above the noise, i.e.
 * "not measured", so a delta against it would be an artefact of the floor's depth rather
 * than of the sound. Such an entry reads `null`.
 */
const HARMONIC_AMPLITUDE_FLOOR_DB = -120

/**
 * Added to both centroids before the ratio, exactly as `brightnessDetail` does, so a silent
 * window (0 Hz) yields a finite octave distance instead of -Infinity or NaN. The guard is
 * symmetric, so two equal centroids still read 0 octaves.
 */
const BRIGHTNESS_FLOOR_HZ = 20

const isMeasuredPartial = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > HARMONIC_AMPLITUDE_FLOOR_DB

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
    deltaDb.push(isMeasuredPartial(left) && isMeasuredPartial(right) ? right - left : null)
  }

  return {
    deltaDb,
    tiltDeltaDbPerOctave: candidateShape.tiltDbPerOctave - referenceShape.tiltDbPerOctave,
    oddEvenDeltaDb: candidateShape.oddEvenDb - referenceShape.oddEvenDb,
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
    windows.push({
      startMs: referenceWindow.startMs,
      endMs: referenceWindow.endMs,
      octaveDelta: octaveDelta(referenceWindow.spectralCentroidHz, candidateWindow.spectralCentroidHz)
    })
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
  const bands: MatchDiff['bands'] = []
  for (let index = 0; index < bandCount; index++) {
    bands.push({
      centerHz: BAND_CENTERS_HZ[index],
      deltaDb: candidate.bandsDb[index] - reference.bandsDb[index]
    })
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
