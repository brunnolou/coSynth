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
    /**
     * `null` when either side has fewer than two measurable partials, so no slope was fitted
     * on it. `measureHarmonicShape` writes `tiltDbPerOctave: 0` for that case - the same
     * number a genuinely flat spectrum produces - and a rendered sine hits it exactly, since
     * it floors partials 2-12. Subtracting the two 0s reported "no tilt difference" between
     * a sine and anything at all. A real 0 here still means the two slopes agree.
     */
    tiltDeltaDbPerOctave: number | null
    /**
     * `null` when either side found no partial above the noise at all.
     *
     * A NARROWER absence than the tilt's, deliberately. A parity group sitting entirely on
     * the floor is a measurement, not a gap: a band-limited square really has no even
     * partials, and that is the whole content of this axis, so those sides report a real
     * (large) number. `measureHarmonicShape` falls back to 0 only when NO partial was found -
     * the same number a sawtooth's near-balance produces - and that 0 is what this nulls.
     */
    oddEvenDeltaDb: number | null
    inharmonicityDelta: number
  } | null

  /** Per-band signed error, all 10 octave bands. The array `bandsDetail` collapses today. */
  bands: {
    centerHz: number
    /**
     * `candidate - reference` in dB for this band. Always a finite number, including on an
     * `aboveNyquist` band, where it is the difference between two floors; read the flag
     * first, for the same reason `brightness` states in full.
     */
    deltaDb: number
    /**
     * `true` - and never `false` - when this band's lower edge sits above the Nyquist of the
     * reference, of the candidate, or of both. `bandsDb` reads its -100 dB floor there
     * whatever the sound is, so the two sides agree for free and `deltaDb` is a fact about
     * the two FILES rather than about the two sounds.
     *
     * `compareAudioMetrics` leaves exactly these bands out of `details.bands` - its error and
     * its means alike - and counts the rest in `details.bands.bandsCompared`, so anything
     * that means or trends this array, and anything that prints it, must drop them too or it
     * will disagree with the score it is steering.
     *
     * Absent means the band was compared. Neither side carrying a `sampleRateHz` leaves every
     * band unmarked, which is what a hand-built or older serialized analysis gives us and is
     * the behaviour that predates the flag.
     */
    aboveNyquist?: true
  }[]

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
  brightness: {
    startMs: number
    endMs: number
    /**
     * `candidate - reference` in octaves for this row's pair of slices.
     *
     * Always a finite number, including on a `belowNoiseFloor` row, where it is the
     * difference that was measured rather than a difference that means anything. Read the
     * flag first; a nullable field here would push `null` into the arithmetic of every
     * `match-advice.ts` rule that means, spreads or trends this trajectory, and each of
     * those has to drop the row anyway.
     */
    octaveDelta: number
    /**
     * `true` - and never `false` - when the reference slice, the candidate slice, or both
     * sat below `SPECTRAL_WINDOW_NOISE_GATE_DB` after resampling. One of the two centroids
     * then describes the noise the sound decayed into, so the row's `octaveDelta` is not a
     * brightness disagreement: it is the distance between a sound and a noise floor.
     *
     * `compareAudioMetrics` leaves exactly these rows out of `details.brightness`, both its
     * error and its reported means, so anything that means, spreads or trends this array
     * must drop them too or it will disagree with the score it is steering.
     *
     * Absent means the pair was measured. The row itself is kept so the window count stays
     * predictable and `startMs`/`endMs` still tile the reference buffer.
     */
    belowNoiseFloor?: true
  }[]

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
