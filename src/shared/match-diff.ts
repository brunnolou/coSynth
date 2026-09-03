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

function diffBrightness(
  reference: readonly SpectralWindow[],
  candidate: readonly SpectralWindow[]
): MatchDiff['brightness'] {
  // Windows pair by index; the analyzer emits a fixed count, and a short array only ever
  // means one side was analysed by an older build. Extra windows on either side are dropped
  // rather than compared against nothing.
  const count = Math.min(reference.length, candidate.length)
  const windows: MatchDiff['brightness'] = []
  for (let index = 0; index < count; index++) {
    windows.push({
      startMs: reference[index].startMs,
      endMs: reference[index].endMs,
      octaveDelta: octaveDelta(reference[index].spectralCentroidHz, candidate[index].spectralCentroidHz)
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
