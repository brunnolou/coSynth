/**
 * Shared contract for sound matching: pitch, the reference-vs-candidate diff, and the
 * parameter-vocabulary advice built from it.
 *
 * These types are declared apart from `audio-analysis.ts` so the diff, the formatter and
 * the advice table can be written against them without importing the analyzer itself.
 * Nothing here computes; every producer lives in its own module.
 */

/** A measured or supplied fundamental. Producers return `null` rather than guessing. */
export interface PitchEstimate {
  f0Hz: number
  /** 0…1. Below ~0.5 treat any harmonic block derived from this as untrustworthy. */
  confidence: number
  /** Nearest MIDI note to `f0Hz`, A4 = 440, scientific pitch notation (C-1 = 0). */
  midi: number
  /** -50…+50, the offset of `f0Hz` from `midi`. */
  centsOffset: number
  /** `given` when the caller supplied f0Hz; `detected` when measured from the samples. */
  source: 'given' | 'detected'
}

/** Extra harmonic descriptors that collapse 12 partials onto the two axes a wavetable synth has. */
export interface HarmonicShape {
  /**
   * The first 12 partials in dB relative to the FUNDAMENTAL, so two sounds are comparable
   * even when their loudest partial is a different n. `amplitudesDb` on `HarmonicMetrics`
   * stays relative to the loudest partial and is kept for continuity.
   * A partial with no peak above the noise reads the -120 dB floor.
   */
  amplitudesDbRelF0: number[]
  /** Fitted spectral tilt in dB per octave. One number for "brighter" versus "darker". */
  tiltDbPerOctave: number
  /** mean(odd partials) - mean(even partials), dB. Square/pulse read high, saw near 0. */
  oddEvenDb: number
}

/** Periodic amplitude or spectral modulation, i.e. an audible LFO. */
export interface ModulationEstimate {
  rateHz: number
  /** Peak-to-peak modulation depth in dB. */
  depthDb: number
  target: 'amplitude' | 'brightness'
  confidence: number
}

/**
 * Signed reference-versus-candidate error, per dimension, in the unit of the parameter
 * that moves it. Sign convention is `candidate - reference` throughout: negative means
 * the candidate is quieter, darker, shorter or narrower than the reference.
 *
 * `null` always means "not measurable on one side", never "no difference".
 */
export interface MatchDiff {
  /** The existing overall score, carried through unchanged so eval trajectories stay comparable. */
  similarity: number

  pitch: {
    referenceHz: number | null
    candidateHz: number | null
    /** `candidate - reference` in cents. */
    centsError: number | null
  }

  /** `null` when either side has no harmonic block (no usable pitch). */
  harmonics: {
    /** 12 entries; `null` where either side could not measure that partial. */
    deltaDb: (number | null)[]
    tiltDeltaDbPerOctave: number
    oddEvenDeltaDb: number
    inharmonicityDelta: number
  } | null

  /** Per-band signed error, all 10 octave bands. The array `bandsDetail` collapses today. */
  bands: { centerHz: number; deltaDb: number }[]

  /**
   * Per-segment signed error, in env1's own vocabulary, from what is measurable today.
   * A full ADSR fit (delay/hold/release/curves) is deliberately out of scope here; those
   * arrive with `envelope-fit.ts` later, at which point this block gains fields.
   */
  envelope: {
    attackMsDelta: number
    timeToPeakMsDelta: number
    /** From `decayT60Ms`, which is `null` whenever the buffer holds no decay to slope. */
    decayT60MsDelta: number | null
    sustainDbDelta: number
  }

  /** Per-window signed brightness error in octaves, earliest window first. */
  brightness: { startMs: number; endMs: number; octaveDelta: number }[]

  /** From `spectralFlatness`: 0 tonal, 1 noise. A dedicated harmonic-residual ratio comes later. */
  flatnessDelta: number
  stereoWidthDelta: number
  loudnessDbDelta: number

  /** The gradient, in parameter vocabulary. Ordered by estimated similarity gain. */
  actions: MatchAction[]
}

/** One ranked, actionable move expressed in coSynth's own parameter ids. */
export interface MatchAction {
  /** Plain-language statement of the measured error, with the number in it. */
  finding: string
  /** Parameter ids from `PARAMS`, most direct first. Every id must exist in the registry. */
  paramIds: string[]
  direction: 'increase' | 'decrease' | 'either'
  /** Present when the mapping is quantitative. `to` must respect the param's min/max/step. */
  suggested?: { id: string; from: number; to: number; unit: string }
  /** Estimated overall-similarity gain if fully corrected. Ranks the list. */
  estimatedGain: number
  confidence: 'high' | 'medium' | 'low'
}
