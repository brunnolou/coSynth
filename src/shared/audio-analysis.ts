import { fft } from './fft'
import type { HarmonicShape, PitchEstimate } from './match-types'
import { hzToNearestMidi } from './notes'
import { detectPitch } from './pitch'

export interface AudioMetrics {
  peakDb: number
  rmsDb: number
  clippingCount: number
  dcOffset: number
  /**
   * Power-weighted mean frequency of the whole buffer.
   *
   * Bounded by that buffer's own Nyquist, so the same sound analysed at 16 kHz and at 48 kHz
   * reads about 568 Hz and 632 Hz - a real measurement of the audio as delivered, biased by
   * roughly a tenth when a bandlimited source meets a full-rate render. That is a bias in a
   * measurement rather than the fabricated floor `bandsDb` carries above the Nyquist, which
   * is why `bandsDetail` drops those bands and this stays compared; `spectralRolloffHz`
   * (879 vs 883 Hz on the same probe) and `spectralFlatness` (nil either way) barely move at
   * all. Analysing both sides at one rate is what removes the bias, and `audio-input.ts` is
   * where that is arranged.
   *
   * NOT the same quantity as the `brightness` comparison term, which is an unweighted mean
   * over `spectralWindows`; see `AudioMetricsComparison` for why the two can disagree about
   * which of two sounds is brighter.
   */
  spectralCentroidHz: number
  attackMs: number
  /** 0 is identical L/R, 1 is fully anti-phase. Mono is 0. */
  stereoWidth: number
  /** Time of the global envelope peak. The old `attackMs` measured the rise to this point. */
  timeToPeakMs: number
  /**
   * -60 dB decay time extrapolated from the -5…-25 dB slope of the energy decay curve.
   * `null` whenever the buffer holds no decay that slope describes - a steady tone, a
   * beating unison, a tremolo - rather than a number invented from the buffer's last cycle.
   */
  decayT60Ms: number | null
  /** Envelope level at 80% of the buffer, relative to the peak. */
  sustainDb: number
  /** 64 evenly spaced envelope samples, dB relative to the peak, rounded to 0.1. */
  envelopeDb: number[]
  /**
   * Gated RMS: envelope windows more than 10 dB below the ungated level are dropped, so
   * reverb tails and silence do not dilute it. The gate is relative, as in EBU R128, so a
   * gain change moves this by exactly that gain instead of also changing which windows count.
   */
  loudnessDb: number
  /**
   * Ten octave-band levels centred 31.25 Hz, 62.5 Hz … 16 kHz, in dB relative to the
   * total spectral power, floored at -100 and rounded to 0.1. Silence reads all -100.
   */
  bandsDb: number[]
  /** Frequency below which 85% of the spectral power lies. 0 for silence. */
  spectralRolloffHz: number
  /** Geometric over arithmetic mean of the power spectrum: 0 is tonal, 1 is noise. */
  spectralFlatness: number
  /**
   * Four consecutive, equal, non-overlapping slices of the buffer, earliest first, each
   * analysed on its own samples. Every other spectral field above collapses the whole
   * buffer into one number, so a sound whose brightness *falls* - a piano, anything with
   * `env -> cutoff` - is indistinguishable from a steady one. Read the trend across these
   * to see that.
   *
   * Skip any window carrying `belowNoiseFloor` when reading that trend: its spectral
   * figures measure the analyzer's noise floor, not the sound.
   */
  spectralWindows: SpectralWindow[]
  /**
   * Present whenever a fundamental was available - supplied as `f0Hz` or measured here -
   * and the buffer held partials to measure. Never fabricated.
   */
  harmonics?: HarmonicMetrics
  /**
   * The fundamental this analysis used, whether supplied by the caller or measured here.
   * `null` when nothing periodic was found, which is also when `harmonics` is absent.
   */
  pitch?: PitchEstimate | null
  /** Present whenever `harmonics` is. The two axes a wavetable synth actually has. */
  harmonicShape?: HarmonicShape
  /**
   * The rate this buffer was analysed at. `analyzeAudio` always records it; it is optional
   * only so that metrics objects built by hand - several tests, and any older serialized
   * analysis - still typecheck and still compare.
   *
   * It exists because half of `bandsDb` can be unmeasurable. An octave band whose lower edge
   * sits above `sampleRateHz / 2` cannot hold energy, so it reads the -100 floor whatever the
   * sound is, and `bandsDetail` leaves those bands out rather than scoring them. Without a
   * rate there is no way to tell that floor from a band that really is empty, so a comparison
   * missing it on either side falls back to scoring all ten - today's behaviour, and the
   * reason adding this field changes nothing for a pair of full-rate renders.
   */
  sampleRateHz?: number
}

/** One time slice of the buffer. See `AudioMetrics.spectralWindows`. */
export interface SpectralWindow {
  /** Start of the analysed slice, ms from the buffer start. */
  startMs: number
  /** End of the analysed slice, ms from the buffer start. */
  endMs: number
  /**
   * Spectral centroid of this slice alone - the brightness figure to read a trend from.
   *
   * Read `belowNoiseFloor` first: when that is set this number describes the noise the
   * slice decayed into and says nothing about the sound.
   */
  spectralCentroidHz: number
  /**
   * Frequency below which 85% of this slice's power lies. Subject to the same
   * `belowNoiseFloor` caveat as `spectralCentroidHz`.
   */
  spectralRolloffHz: number
  /**
   * RMS of this slice in dB relative to the loudest slice, so the loudest reads 0. Tells a
   * brightness change apart from the level change that a closing filter also causes.
   */
  levelDb: number
  /**
   * `true` - and never `false` - on a slice whose `levelDb` sits below
   * `SPECTRAL_WINDOW_NOISE_GATE_DB`. Every spectral figure on such a slice
   * (`spectralCentroidHz`, `spectralRolloffHz`, `harmonicsDb`) was measured on the noise
   * the sound decayed into, so it is a number without a meaning: report it as `n/a (below
   * the noise floor)` and leave it out of any trend, difference or score.
   *
   * The slice is kept rather than dropped, so the window count stays predictable and
   * `startMs`/`endMs` still tile the buffer. Absent means "this slice was measured"; the
   * flag is derived from `levelDb` alone, so `isSpectralWindowBelowNoiseFloor` gives the
   * same answer for windows that reached you without it.
   */
  belowNoiseFloor?: true
  /**
   * The first 12 partials of this slice in dB relative to the loudest partial found in
   * *any* slice, so both the overall decay and the per-partial decay rates are readable:
   * a piano's eighth partial falls tens of dB while its fundamental barely moves.
   *
   * Present only when `analyzeAudio` was given a usable `f0Hz` and the slices are long
   * enough to resolve partials; present on every slice or on none, never fabricated. On a
   * `belowNoiseFloor` slice these are peaks picked out of noise: the *level* they report is
   * real - the partials have gone - but their shape across n is not.
   *
   * NOT COMPARABLE ENTRY FOR ENTRY WITH `harmonics.amplitudesDb` OR
   * `harmonicShape.amplitudesDbRelF0`, and an eval agent reading them side by side called
   * the difference a contradiction. Three arrays, three different denominators: this one is
   * relative to the loudest partial in any SLICE, `amplitudesDb` to the loudest partial of a
   * separate peak-centred pass over the whole buffer, `amplitudesDbRelF0` to the
   * FUNDAMENTAL. A slice's whole row therefore sits a further (this slice's level) below the
   * other two - on the eval reference, window 0 lands within about 3 dB of the whole-buffer
   * array while windows 1-3 sit 15, 24 and 37 dB under it, which is the decay, not a
   * disagreement. The two passes also run at different FFT sizes (up to 32768 for the whole
   * buffer, `SPECTRAL_FFT_MAX` here), so a low fundamental is resolved far better in the
   * whole-buffer array. Read these across SLICES, at one n; read the other two across n.
   */
  harmonicsDb?: number[]
}

export interface HarmonicMetrics {
  /**
   * The first 12 partials, in dB relative to the loudest partial found (so the loudest
   * reads 0). A partial with no peak above the noise reads the -120 dB floor, which means
   * "not there"; how far down it reads is the clamp's depth rather than a measurement, so
   * nothing should difference against it. See `harmonicsDetail`.
   *
   * Measured on one window at the envelope peak, as long as the buffer allows. That is a
   * different pass from `SpectralWindow.harmonicsDb` - different span, different FFT size,
   * different denominator - so the two arrays are not comparable entry for entry. That
   * field's own comment sets out which to read for what.
   */
  amplitudesDb: number[]
  /**
   * B fitted from `f_n = n·f0·√(1 + B·n²)`. 0 is perfectly harmonic (an organ);
   * a piano string is roughly 1e-4 … 1e-3; stiffer, more bell-like partials are higher.
   * Measurable to about 2e-2, above which the second partial lands outside the search
   * window that seeds the fit and B reads far too low.
   */
  inharmonicity: number
}

export interface AnalyzeAudioOptions {
  /**
   * Fundamental of the tone in Hz. Supply it for a single-pitch render - a rendered
   * candidate knows its own MIDI note - and the analyzer skips detection entirely.
   */
  f0Hz?: number
  /**
   * Detect the fundamental when `f0Hz` is absent. Defaults to **true**.
   *
   * Without this an uploaded reference file could never grow a `harmonics` block, while a
   * rendered candidate always did: the model saw its own spectrum and not the target's,
   * which is the asymmetry that made harmonic matching unusable. Set it to `false` only
   * for material that has no single fundamental - a drum loop, a chord, noise - where the
   * cost of the detector outweighs a result it will refuse anyway.
   */
  detectPitch?: boolean
  /**
   * Number of spectral windows. Defaults to `SPECTRAL_WINDOW_COUNT` (4); 4…32 inclusive.
   * More windows resolve a faster-moving filter sweep at a proportional cost in response
   * size, since each window carries its own 12 partials.
   */
  windows?: number
}

/** Metrics `compareAudioMetrics` scores one against one. */
export type ComparedMetricKey =
  | 'peakDb' | 'rmsDb' | 'clippingCount' | 'dcOffset'
  | 'spectralCentroidHz' | 'attackMs' | 'stereoWidth' | 'decayT60Ms'

export interface AudioMetricComparisonDetail {
  reference: number
  candidate: number
  delta: number
  similarity: number
}

/**
 * `decayT60Ms` is absent whenever the buffer never decayed, the harmonic terms are absent
 * whenever a side had no usable fundamental, and `brightness` is absent whenever the noise
 * gate leaves no comparable window pair, so their details carry nulls.
 *
 * `similarity` is `null` - and the metric is left out of the overall mean - when the pair
 * was not measurable rather than maximally different. Both sides `null` is a match and
 * scores 1; two measured values score normally.
 *
 * Which absences count as "not measurable" differs by metric, and the three rules are argued
 * where they live: symmetric for `decayT60Ms` (see `decayDetail`), asymmetric for
 * `harmonics`, `tilt` and `inharmonicity` (see `harmonicTerm`), where a reference that *has*
 * a fundamental and a candidate that does not is a measured failure of the candidate and
 * scores 0, and never-a-match for `brightness` (see `brightnessDetail`), where both sides
 * being unreadable is a fact about two noise floors rather than an agreement between two
 * sounds.
 */
export interface NullableMetricComparisonDetail {
  reference: number | null
  candidate: number | null
  delta: number | null
  /** `null` means "not measurable", never "as wrong as it gets". */
  similarity: number | null
}

/**
 * A term whose `similarity` comes from a distance across an ARRAY - ten bands, twelve
 * partials, four windows - rather than from the two scalars beside it.
 *
 * `delta` on such a term is `candidate - reference` between two MEAN LEVELS, and a mean
 * cancels: a band 8 dB loud and a band 8 dB quiet average to no difference at all while the
 * score counts 8 dB in each. So `delta` and `similarity` can point in opposite directions,
 * and an eval agent read exactly that and could not tell which to believe - "a 1.6 dB
 * band-mean gap scored 0.467 while an 8.3 dB gap scored 0.696". `meanAbsError` is the
 * quantity `similarity` is actually computed from: the mean of the per-element ABSOLUTE
 * differences, after each element's own cap, over exactly the elements that were compared.
 * Read `delta` for "am I louder or quieter overall" and `meanAbsError` for "how far off am
 * I", never one for the other.
 */
export interface AggregateMetricComparisonDetail extends AudioMetricComparisonDetail {
  /** Mean per-element absolute difference, post-cap, in that term's own unit. */
  meanAbsError: number
}

/** As `AggregateMetricComparisonDetail`, for a term that can be unmeasurable. */
export interface NullableAggregateMetricComparisonDetail extends NullableMetricComparisonDetail {
  /** `null` exactly when `similarity` is, or when no element pair was comparable. */
  meanAbsError: number | null
}

export interface BandsComparisonDetail extends NullableAggregateMetricComparisonDetail {
  /**
   * How many of the ten octave bands were comparable. Fewer than ten means the rest sat
   * entirely above one side's Nyquist, where `bandsDb` reads its floor for want of anything
   * to measure; those are left out rather than scored. See `bandsDetail`.
   */
  bandsCompared: number
}

export interface AudioMetricsComparison {
  similarity: number
  details:
    & { [Key in Exclude<ComparedMetricKey, 'decayT60Ms'>]: AudioMetricComparisonDetail }
    & { decayT60Ms: NullableMetricComparisonDetail }
    /** Pearson correlation of the two `envelopeDb` curves; reference/candidate are their mean levels. */
    & { envelope: AudioMetricComparisonDetail }
    /**
     * Mean per-band dB difference across `bandsDb`, each band capped at 20 dB and read
     * linearly against that cap; reference/candidate are their mean levels and
     * `meanAbsError` is in dB. One set of bands feeds all of them - the `bandsCompared`
     * bands measurable on both sides, which is fewer than ten whenever a side's Nyquist cuts
     * a band off entirely - but the two statistics still answer different questions, and
     * `meanAbsError` is the one `similarity` follows. See `AggregateMetricComparisonDetail`
     * and, for the Nyquist rule, `bandsDetail`.
     *
     * `null` when no band is measurable on both sides.
     */
    & { bands: BandsComparisonDetail }
    /**
     * Mean absolute octave difference across the `spectralWindows` centroid trajectories;
     * reference/candidate are their mean centroids and `meanAbsError` is in octaves. Unlike
     * `envelope` this is not a pure shape score - absolute brightness is part of a timbre
     * match - but it separates two sounds with the same mean brightness that arrive at it
     * from opposite directions, which `spectralCentroidHz` alone cannot. Windows below
     * `SPECTRAL_WINDOW_NOISE_GATE_DB` on either side are excluded from the error and from
     * the means alike, which are taken over exactly the surviving pairs.
     *
     * THIS IS NOT `spectralCentroidHz`, AND THE TWO CAN DISAGREE ABOUT WHICH SIDE IS
     * BRIGHTER. `spectralCentroidHz` is one power-weighted centroid of the whole buffer, so
     * the loud part of a sound decides it; these means are unweighted across equal slices,
     * so a quiet bright tail counts as much as a loud dark body. On one probe buffer the two
     * read 239 Hz and 596 Hz with no window gated at all, and when the two sides put their
     * brightness in differently-loud slices the SIGN of the difference flips between them.
     * Neither is wrong: read `spectralCentroidHz` for "where is the energy", `brightness`
     * for "how does the timbre move". `formatDiff` prints both under that label.
     *
     * `null` when no pair survives the gate - a decaying reference against a late-starting
     * candidate, where every pair has one side in the noise. See `brightnessDetail` for why
     * that is "not measurable" rather than the agreement `harmonicTerm` reports.
     */
    & { brightness: NullableAggregateMetricComparisonDetail }
    /**
     * Mean per-partial dB difference across `harmonicShape.amplitudesDbRelF0`, each partial
     * capped at `HARMONIC_ERROR_CLAMP_DB` and read linearly against that cap - the
     * `bandsDetail` treatment, for the same reason. `meanAbsError` is in dB.
     *
     * reference/candidate are the mean levels of exactly the partials MEASURED ON BOTH
     * SIDES, never over all twelve entries: an entry at `HARMONIC_AMPLITUDE_FLOOR_DB` is
     * "this partial is not there", and averaging the floor's depth into a level reported a
     * four-partial reference as -82.3 dB when its four real partials averaged -6.9. A
     * partial present on one side only still moves `similarity` - see `harmonicsDetail` -
     * so `meanAbsError` covers more partials than the means do, and both say so here.
     */
    & { harmonics: NullableAggregateMetricComparisonDetail }
    /** From `harmonicShape.tiltDbPerOctave`: one number for brighter versus darker. */
    & { tilt: NullableMetricComparisonDetail }
    /** From `harmonics.inharmonicity`: computed since the first harmonic pass, never scored until now. */
    & { inharmonicity: NullableMetricComparisonDetail }
}

const clampSimilarity = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
const exponentialSimilarity = (error: number, scale: number): number =>
  clampSimilarity(Math.exp(-Math.abs(error) / scale))
const metricKeys: ComparedMetricKey[] = [
  'peakDb', 'rmsDb', 'clippingCount', 'dcOffset',
  'spectralCentroidHz', 'attackMs', 'stereoWidth', 'decayT60Ms'
]
/** Every metric that must always be a finite number. */
const scalarMetricKeys: (keyof AudioMetrics)[] = [
  'peakDb', 'rmsDb', 'clippingCount', 'dcOffset',
  'spectralCentroidHz', 'attackMs', 'stereoWidth',
  'timeToPeakMs', 'sustainDb', 'loudnessDb',
  'spectralRolloffHz', 'spectralFlatness'
]
const ENVELOPE_POINTS = 64
/**
 * Round to a tenth (of a dB, a hertz, a millisecond) and normalise -0, which reads as an
 * oddity in JSON diffs. `|| 0` would also turn NaN into 0, which would disarm the
 * finiteness guards this module ends with.
 */
const roundTenth = (value: number): number => {
  const rounded = Math.round(value * 10) / 10
  return rounded === 0 ? 0 : rounded
}
const BAND_COUNT = 10
/** Octave band centres: 31.25 Hz doubled nine times, ending at 16 kHz. */
const BAND_CENTERS_HZ = Array.from({ length: BAND_COUNT }, (_, index) => 31.25 * 2 ** index)
const BAND_FLOOR_DB = -100
/**
 * Highest frequency a buffer at this rate can carry, or `Infinity` when the rate is unknown
 * and every band therefore has to be taken as measurable - which is what a metrics object
 * built by hand, or serialized before `sampleRateHz` existed, gives us.
 */
const nyquistOrUnbounded = (sampleRateHz: number | undefined): number =>
  typeof sampleRateHz === 'number' && Number.isFinite(sampleRateHz) && sampleRateHz > 0
    ? sampleRateHz / 2
    : Number.POSITIVE_INFINITY
/**
 * Could the band at `index` hold energy below `limitHz`? Octave bands, so the band centred
 * at f spans f/sqrt(2) to f*sqrt(2); once its LOWER edge is above the limit there is nothing
 * in it to measure at any level. A band straddling the limit keeps its real, if partial,
 * content and stays in.
 */
const isBandMeasurable = (index: number, limitHz: number): boolean =>
  BAND_CENTERS_HZ[index] / Math.SQRT2 < limitHz
const HARMONIC_COUNT = 12
/** Partials quieter than this relative to the loudest are not real peaks; they do not constrain B. */
const HARMONIC_FIT_FLOOR_DB = -60
const HARMONIC_AMPLITUDE_FLOOR_DB = -120
/**
 * Did this partial have a peak above the noise at all? The one predicate every reader of an
 * `amplitudesDbRelF0` entry shares - `measureHarmonicShape`'s two fits, `harmonicsDetail`,
 * `tiltMeasurable`, and `isMeasuredPartial` in `match-diff.ts`, which is this function under
 * that name because the two modules must not disagree about which partials exist.
 */
export const isMeasuredPartial = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > HARMONIC_AMPLITUDE_FLOOR_DB
/** Half-width of the peak search around each predicted partial, as a fraction of it. */
const HARMONIC_SEARCH_FRACTION = 0.03
/** Largest FFT the whole-buffer spectral pass and each time window will use. */
const SPECTRAL_FFT_MAX = 4096
/**
 * Four windows: three successive deltas, which is the least that tells a monotone fall
 * ("brightness decays") from a dip and a recovery, and few enough that the whole
 * trajectory - 4 x (2 bounds + 3 figures), plus 4 x 12 partials when `f0Hz` is known -
 * stays the same order of magnitude as the 64-point `envelopeDb` already returned
 * unconditionally. A spectrogram would be no harder to compute and useless to read.
 */
const SPECTRAL_WINDOW_COUNT = 4
/**
 * Bounds on `AnalyzeAudioOptions.windows`. The floor is the four windows the reasoning
 * above settles on; the ceiling keeps the worst case - 32 x 12 partials - inside the same
 * order of magnitude as the rest of the response.
 */
const SPECTRAL_WINDOW_COUNT_MIN = 4
const SPECTRAL_WINDOW_COUNT_MAX = 32
/** A window with a shorter FFT than this cannot resolve partials; `harmonicsDb` is omitted. */
const SPECTRAL_WINDOW_MIN_HARMONIC_FFT = 256
/**
 * Largest per-band dB gap `bandsDetail` counts. See that function for the measurements
 * behind the number; briefly, 20 dB is where a band stops carrying steerable information
 * and starts reporting how deep `BAND_FLOOR_DB` is.
 */
const BAND_ERROR_CLAMP_DB = 20
/**
 * Largest per-partial dB gap the harmonic comparison counts, and the same 20 dB as
 * `BAND_ERROR_CLAMP_DB` for the same reason: 20 dB below the fundamental is 1 % of its
 * power, past which the two sounds share nothing in that partial and further dB report how
 * deep `HARMONIC_AMPLITUDE_FLOOR_DB` is rather than anything about the timbre. Without a cap
 * the -120 dB floor entries a square wave's even partials produce would dominate every
 * comparison it takes part in, exactly as the empty octave bands once did.
 */
const HARMONIC_ERROR_CLAMP_DB = 20
/**
 * Exponential scale for the spectral-tilt difference. A sawtooth falls about 6 dB/octave and
 * a flat spectrum 0, so 3 dB/octave is half that full span: half a "saw versus flat" apart
 * scores e^-1 = 0.37, and the audible range of tilts covers most of 0…1 instead of pinning
 * every plausible candidate near either end.
 */
const TILT_SCALE_DB_PER_OCTAVE = 3
/**
 * B is compared as a ratio, not a difference: the useful range spans four orders of
 * magnitude (an organ at 0, a guitar near 1e-4, a piano 1e-4…1e-3, bell-like partials
 * higher). The floor is where stretching stops being audible, so two effectively harmonic
 * series score 1 instead of being separated by their measurement noise; a factor of 4 is
 * roughly one step along that instrument ladder.
 */
const INHARMONICITY_FLOOR = 1e-4
/**
 * A `SpectralWindow` whose `levelDb` falls below this is noise, and every spectral figure
 * measured on it describes that noise rather than the sound.
 *
 * Near-silence has a broadband, roughly even spectrum, so its centroid lands near the
 * middle of the analysed band whatever the sound had been doing. A real reference run put a
 * 4,978 Hz centroid on a -55 dB slice whose partials were all sitting on the -120 dB floor;
 * the +4.9 octave "brightness swing" that invented was read as a filter closing too fast
 * and sent `filter-envelope-depth` to the top of the advice ranking. The gate lives here,
 * in the analyzer, so the score, the diff and the printed table all reach the same verdict
 * instead of each re-deriving one.
 *
 * -40 dB is 1/10,000 of the loudest slice's power, and exactly twice the
 * `BAND_ERROR_CLAMP_DB` span at which this module already treats two spectra as sharing
 * nothing. It is deep enough to keep every tail worth reading: a note whose T60 outlasts
 * the buffer still reads about -30 dB in its final quarter, while the failure above sat at
 * -55 dB. Nearer -35 it starts gating the tails of ordinary plucks, and nearer -45 the
 * noise comes back.
 *
 * The test is strict, so a slice sitting exactly on the threshold is still measured.
 */
export const SPECTRAL_WINDOW_NOISE_GATE_DB = -40

/**
 * Whether a slice's spectral figures describe the noise floor rather than the sound.
 *
 * Derived from `levelDb` rather than read off `SpectralWindow.belowNoiseFloor`, so it
 * answers the same for a window hand-built in a test, deserialized from an older analysis,
 * or produced by any other path. `measureSpectralWindows` sets the flag from this same
 * predicate, which is what stops the score and the printed table disagreeing about which
 * windows counted.
 */
export const isSpectralWindowBelowNoiseFloor = (window: SpectralWindow): boolean =>
  window.levelDb < SPECTRAL_WINDOW_NOISE_GATE_DB

/** The per-window centroid trajectory is compared in octaves, on this scale. */
const BRIGHTNESS_SCALE_OCTAVES = 0.5
/** Added to both centroids before the ratio, so a silent window is not a divide by zero. */
const BRIGHTNESS_FLOOR_HZ = 20
/** Fields of a `SpectralWindow` that must always be finite numbers. */
const SPECTRAL_WINDOW_SCALAR_FIELDS = [
  'startMs', 'endMs', 'spectralCentroidHz', 'spectralRolloffHz', 'levelDb'
] as const

function assertNumberArray(label: string, field: string, values: unknown, expected: number): number[] {
  if (!Array.isArray(values) || values.length !== expected) {
    throw new Error(`${label}.${field} must be an array of ${expected} numbers`)
  }
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error(`${label}.${field} must contain finite numbers`)
  }
  return values as number[]
}

const assertEnvelopeDb = (label: string, values: unknown): number[] =>
  assertNumberArray(label, 'envelopeDb', values, ENVELOPE_POINTS)
const assertBandsDb = (label: string, values: unknown): number[] =>
  assertNumberArray(label, 'bandsDb', values, BAND_COUNT)

function assertSpectralWindows(label: string, value: unknown): SpectralWindow[] {
  // A range rather than an exact count, since `AnalyzeAudioOptions.windows` lets one side
  // have been analysed at a finer resolution than the other.
  if (
    !Array.isArray(value) ||
    value.length < SPECTRAL_WINDOW_COUNT_MIN ||
    value.length > SPECTRAL_WINDOW_COUNT_MAX
  ) {
    throw new Error(
      `${label}.spectralWindows must be an array of ` +
      `${SPECTRAL_WINDOW_COUNT_MIN}…${SPECTRAL_WINDOW_COUNT_MAX} windows`
    )
  }
  for (const window of value) {
    if (!window || typeof window !== 'object') {
      throw new Error(`${label}.spectralWindows must contain finite numbers`)
    }
    for (const field of SPECTRAL_WINDOW_SCALAR_FIELDS) {
      if (!Number.isFinite((window as SpectralWindow)[field])) {
        throw new Error(`${label}.spectralWindows.${field} must contain finite numbers`)
      }
    }
  }
  return value as SpectralWindow[]
}

/** Pearson correlation, so a shape match scores high regardless of overall level. */
function correlation(left: readonly number[], right: readonly number[]): number {
  const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
  const leftMean = mean(left)
  const rightMean = mean(right)
  let covariance = 0
  let leftVariance = 0
  let rightVariance = 0
  for (let i = 0; i < left.length; i++) {
    const a = left[i] - leftMean
    const b = right[i] - rightMean
    covariance += a * b
    leftVariance += a * a
    rightVariance += b * b
  }
  if (leftVariance <= 0 || rightVariance <= 0) return 0
  return covariance / Math.sqrt(leftVariance * rightVariance)
}

/**
 * Two sounds that both never decayed match. One that decayed and one that did not have no
 * comparison at all, which is reported as `similarity: null` rather than as 0.
 *
 * `decayT60Ms` is `null` whenever the buffer holds no decay the T60 line describes - a
 * sustaining patch, a short note, a beating unison - which is its most common value in the
 * reference-matching loop. Scoring that 0 said "as different as two decays can be" about a
 * pair that was never measured, and an agent reading the response could not tell the two
 * apart. It also made the arithmetic perverse: with every other metric identical, a
 * candidate whose decay was 160x too fast scored 0.9029 overall while one whose decay simply
 * could not be measured scored 0.9000.
 */
function decayDetail(
  reference: number | null,
  candidate: number | null,
  logRatio: (left: number, right: number, floor: number) => number
): NullableMetricComparisonDetail {
  const unmeasurable = reference === null || candidate === null
  const similarity = unmeasurable
    ? (reference === candidate ? 1 : null)
    : clampSimilarity(exponentialSimilarity(logRatio(reference as number, candidate as number, 1), Math.log(4)))
  return {
    reference,
    candidate,
    delta: unmeasurable ? null : (candidate as number) - (reference as number),
    similarity
  }
}

/**
 * Mean per-band dB difference, each band's error capped at `BAND_ERROR_CLAMP_DB` and the
 * mean then read linearly against that cap.
 *
 * An uncapped mean on an exponential scale could not work here, and the reference-matching
 * eval showed exactly how: across three iterations against a recorded target this scored
 * 0.000, 0.000, 0.008 while eight other metrics moved. Measured against
 * `docs/agent-match-eval-reference.wav`, every plausible synth patch sits 27-30 dB away and
 * a *deliberately* unrelated one 40-62 dB, so a 6 dB scale put the entire reachable range
 * inside the bottom hundredth of the metric.
 *
 * The distance was that large because `bandsDb` floors at -100: a C4 note has nothing at all
 * at 31 Hz and 16 kHz where a recording has energy, and those empty bands alone supplied 74 %
 * of the raw distance (28 % of it from bands within 10 dB of the floor). Capping each band's
 * error bounds that: 20 dB down is 1 % of the power, at which point the two sounds share
 * nothing in that band and further dB report the floor's depth rather than the sound.
 *
 * 20 dB is where the measurements put the boundary. Every pair one parameter change apart
 * differs by at most 10 dB in its worst band, so the cap never blunts what an agent is
 * steering by; genuinely unrelated pairs differ by 48-96 dB in their worst band, far above
 * it, so the cap only ever truncates the uninformative tail. Reading the capped mean
 * linearly rather than exponentially spends the resolution evenly: 1 dB of improvement is
 * worth the same 0.05 anywhere, instead of concentrating it all at a distance of zero that
 * an agent chasing an arbitrary recording never reaches.
 *
 * BANDS ABOVE A NYQUIST ARE LEFT OUT, both from the error and from the means. `bandsDb`
 * floors at -100 for a band with no energy, and a band whose lower edge sits above
 * `sampleRateHz / 2` cannot have energy no matter what the sound is - so that -100 is the
 * floor's depth again, not a measurement, and every rule this module already follows about
 * a floor applies. A live eval found both halves of the lie at once, from a reference
 * decoded at 16 kHz against a candidate rendered at 48 kHz (since fixed upstream, in
 * `audio-input.ts`): the mismatched pair was charged about 75 dB in the top band, an error
 * no patch could close, and a pair of 16 kHz buffers scored a silent, flattering 1.000 on a
 * band neither could measure.
 *
 * The line this draws is the one `harmonicsDetail` draws too, and it is worth naming because
 * the two land on opposite answers for what looks like the same case. A partial missing from
 * both sounds counts as agreement there, because a patch move can put it back or take it
 * away - absence is a feature the agent is steering. A band above the Nyquist is not
 * reachable by any patch move at all: the candidate gets that agreement for free, or is
 * charged for it forever, and either way it is a fact about the FILE rather than about the
 * sound. Score what the agent can move.
 *
 * `bandsCompared` is on the payload because a reader who sees a ten-band table and an eight-
 * band score has no other way to tell. When the two sides carry different rates only the
 * bands measurable on BOTH count, exactly as `brightnessDetail` keeps only pairs where both
 * windows cleared the gate; if none does, the term is `null` and leaves the mean.
 */
function bandsDetail(
  reference: readonly number[],
  candidate: readonly number[],
  referenceRateHz: number | undefined,
  candidateRateHz: number | undefined
): BandsComparisonDetail {
  const limitHz = Math.min(nyquistOrUnbounded(referenceRateHz), nyquistOrUnbounded(candidateRateHz))
  const referenceLevels: number[] = []
  const candidateLevels: number[] = []
  let cappedError = 0
  for (let index = 0; index < reference.length; index++) {
    if (!isBandMeasurable(index, limitHz)) continue
    referenceLevels.push(reference[index])
    candidateLevels.push(candidate[index])
    cappedError += Math.min(BAND_ERROR_CLAMP_DB, Math.abs(candidate[index] - reference[index]))
  }
  const bandsCompared = referenceLevels.length
  if (bandsCompared === 0) {
    return { reference: null, candidate: null, delta: null, meanAbsError: null, similarity: null, bandsCompared }
  }
  const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
  const referenceMean = mean(referenceLevels)
  const candidateMean = mean(candidateLevels)
  // `delta` is a difference of MEANS and cancels; `meanAbsError` is the mean of absolute
  // differences and does not. Both are reported because they answer different questions and
  // an agent handed only the first read the score as inconsistent with it. See
  // `AggregateMetricComparisonDetail`.
  const meanAbsError = cappedError / bandsCompared
  return {
    reference: referenceMean,
    candidate: candidateMean,
    delta: candidateMean - referenceMean,
    meanAbsError,
    similarity: clampSimilarity(1 - meanAbsError / BAND_ERROR_CLAMP_DB),
    bandsCompared
  }
}

/**
 * Mean absolute octave difference between the two centroid trajectories. A per-window
 * Pearson correlation would be the obvious mirror of `envelopeDetail`, but four points of
 * a *steady* tone's centroid have no variance to correlate, so two identical steady sounds
 * would have scored 0.5. An octave distance scores those 1 and still separates a falling
 * trajectory from a rising one with the same mean.
 *
 * Windows below `SPECTRAL_WINDOW_NOISE_GATE_DB` are left out of both the error and the
 * reported means, on either side. A pair with one side under the gate is not a brightness
 * disagreement at all - one of the two centroids is the noise floor's, so nothing was
 * compared - and counting it produced exactly the phantom swings this gate exists to stop.
 * The level difference that put the slice under the gate is not lost by leaving it out:
 * `envelope`, `rmsDb` and `decayT60Ms` read level directly and are where a candidate that
 * dies too early is charged for it.
 *
 * ONE SET OF PAIRS FEEDS ALL FOUR FIELDS. `reference`, `candidate` and `delta` are means
 * over exactly the pairs that contributed to the error, never over each side's own ungated
 * windows: `levelDb` is relative to each buffer's own loudest slice, so the two sides gate
 * at different indices and two independently-gated means describe a set of windows that was
 * never compared. The printed table and the score have to agree about which windows counted.
 *
 * WHEN NO PAIR SURVIVES THE GATE the term is `null` - not measurable - rather than a number.
 * There is no fallback to the ungated comparison, and the reachability is not theoretical:
 * each buffer has a 0 dB slice by construction, but the two peaks need not share an index,
 * so a decaying reference against a late-starting candidate can have one gated side in every
 * single pair while neither buffer is remotely silent. Scoring those pairs anyway would
 * reintroduce, in the one case that reaches it, the phantom centroid swing the gate exists
 * to stop - the same fabrication that once ranked a wrong action first.
 *
 * `harmonicTerm`'s "neither side is measurable, so they agree, so score 1" does NOT carry
 * over here, and the difference is what `null` is measuring. A missing fundamental is a
 * property of the sound: both sides having none is a real, shared fact about them. A gated
 * window is a property of where a slice sits in its OWN envelope, and its centroid was
 * measured on hiss - so an all-gated comparison says nothing whatever about whether the two
 * sounds' brightness agrees, and 1 would assert a match on the strength of two hiss
 * readings. Scoring it 1 would also be a lever: `levelDb` is buffer-relative, so a candidate
 * could gate its own windows by collapsing into one loud slice and collect a free 1.0 for
 * destroying its sustain. Exclusion is neutral, and a candidate cannot profit by reaching
 * this state either, because near-disjoint envelopes are what it takes to get here and
 * `envelope`, `attackMs`, `rmsDb` and `decayT60Ms` all charge for that directly.
 */
function brightnessDetail(
  reference: readonly SpectralWindow[],
  candidate: readonly SpectralWindow[]
): NullableAggregateMetricComparisonDetail {
  // The two sides may have been analysed at different `windows` resolutions. Each window
  // is a fixed *fraction* of its own buffer, so index i of a 4-window run and index i of a
  // 16-window run describe different spans; the trajectories are therefore resampled onto
  // the coarser grid by position rather than compared index for index.
  //
  // Arithmetic identical to `resampledIndex` in `match-diff.ts`, the `points <= 1` guard
  // included: that function resamples the very trajectories this one scores, and 0/0 in one
  // of the two would put a NaN in the score while the table beside it read row 0.
  // `assertSpectralWindows` keeps the count at 4-32 today, so the guard is latent - but a
  // pair documented as deliberately the same arithmetic has to BE the same arithmetic, or
  // the next person to relax that bound inherits a divergence nothing points at.
  const points = Math.min(reference.length, candidate.length)
  const at = (windows: readonly SpectralWindow[], index: number) =>
    windows[points > 1
      ? Math.min(windows.length - 1, Math.max(0, Math.round(index * (windows.length - 1) / (points - 1))))
      : 0]
  const errors: number[] = []
  const referenceCentroids: number[] = []
  const candidateCentroids: number[] = []
  for (let index = 0; index < points; index++) {
    const referenceWindow = at(reference, index)
    const candidateWindow = at(candidate, index)
    if (
      isSpectralWindowBelowNoiseFloor(referenceWindow) ||
      isSpectralWindowBelowNoiseFloor(candidateWindow)
    ) {
      continue
    }
    referenceCentroids.push(referenceWindow.spectralCentroidHz)
    candidateCentroids.push(candidateWindow.spectralCentroidHz)
    const left = Math.max(0, referenceWindow.spectralCentroidHz) + BRIGHTNESS_FLOOR_HZ
    const right = Math.max(0, candidateWindow.spectralCentroidHz) + BRIGHTNESS_FLOOR_HZ
    errors.push(Math.abs(Math.log2(right / left)))
  }
  if (errors.length === 0) {
    return { reference: null, candidate: null, delta: null, meanAbsError: null, similarity: null }
  }
  const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
  const referenceMean = mean(referenceCentroids)
  const candidateMean = mean(candidateCentroids)
  // Hz for the two means, octaves for the error, and they are not two views of one number:
  // a trajectory that is two octaves bright early and two octaves dark late has a mean
  // difference near zero and an error of two octaves. Reporting only the first made the
  // score look arbitrary. See `AggregateMetricComparisonDetail`.
  const meanAbsError = mean(errors)
  return {
    reference: referenceMean,
    candidate: candidateMean,
    delta: candidateMean - referenceMean,
    meanAbsError,
    similarity: exponentialSimilarity(meanAbsError, BRIGHTNESS_SCALE_OCTAVES)
  }
}

function envelopeDetail(reference: readonly number[], candidate: readonly number[]): AudioMetricComparisonDetail {
  const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
  const identical = reference.every((value, index) => value === candidate[index])
  const similarity = identical ? 1 : clampSimilarity((correlation(reference, candidate) + 1) / 2)
  const referenceMean = mean(reference)
  const candidateMean = mean(candidate)
  return { reference: referenceMean, candidate: candidateMean, delta: candidateMean - referenceMean, similarity }
}

/**
 * The shared shape of every harmonic comparison term, and the one place the "which side is
 * missing?" question is answered.
 *
 * Timbre is measurable on a side only when that side has a usable fundamental. The three
 * cases are not symmetric, and treating them as if they were is what let a candidate raise
 * its overall score by destroying its own pitch: an unweighted mean over the terms that
 * survive goes *up* when the terms a candidate was failing drop out of it. A high shelf
 * pushed one eval candidate past the pitch detector, `harmonics` (0.08) and `tilt` (0.00)
 * both went `null`, and the overall similarity reached a new best.
 *
 * - **Neither side has a fundamental.** Nothing was ever measurable and the two agree about
 *   that, so the term matches at 1 - as two buffers that both never decayed do.
 * - **The reference has none and the candidate does.** This is absence of evidence about
 *   the *target*: `detectPitch` failing on an uploaded recording says nothing about what
 *   the candidate should sound like, and scoring it would punish a reference for being a
 *   recording rather than a render. `similarity: null`, excluded from the mean. A candidate
 *   cannot reach this case by changing itself, so it is not a lever.
 * - **The reference has one and the candidate does not.** This is not "not measurable". The
 *   reference established that this dimension exists and what its value is; the candidate
 *   answered with a sound that has no measurable partial series at all. That is a measured
 *   failure of the candidate, and it scores 0 - the only assignment under which a candidate
 *   can never improve by losing a dimension the reference has.
 *
 * `decayT60Ms` keeps the older symmetric rule (see `decayDetail`) on purpose. A null there
 * is a property of the *measurement*: `measureDecayT60Ms` refuses the fit for curvature, for
 * decays faster than one hop per 10 dB, and for buffers that end before -25 dB, so it is
 * null for most reference material and for many perfectly good candidates. A null pitch is a
 * property of the *sound* - nothing periodic was found in it - which is why the asymmetry
 * belongs here and not there.
 */
function harmonicTerm(
  reference: number | null,
  candidate: number | null,
  score: (reference: number, candidate: number) => number
): NullableMetricComparisonDetail {
  if (reference === null || candidate === null) {
    return {
      reference,
      candidate,
      delta: null,
      similarity: reference === null ? (candidate === null ? 1 : null) : 0
    }
  }
  return {
    reference,
    candidate,
    delta: candidate - reference,
    similarity: clampSimilarity(score(reference, candidate))
  }
}

/**
 * Mean per-partial dB difference over `amplitudesDbRelF0`, each partial capped at
 * `HARMONIC_ERROR_CLAMP_DB` and the mean read linearly against that cap.
 *
 * Relative to the *fundamental*, never to the loudest partial: two sounds whose loudest
 * partial is a different n have every `amplitudesDb` entry offset by an unknown constant,
 * so a per-partial difference between them measures that offset rather than the timbre.
 * That is why the field exists and why this term reads it.
 *
 * WHAT `HARMONIC_AMPLITUDE_FLOOR_DB` MEANS, AND WHY THE FOUR READERS OF IT DIFFER. A
 * floored entry says "this partial is not there". That is a FACT about the sound - a square
 * wave's even partials really are missing, which is exactly what `measureHarmonicShape`'s
 * `oddEvenDb` already reports - but its DEPTH is an artefact: `partialsDb` clamps at -120,
 * and the underlying reading was -240 or -Infinity. So every reader that consumes the
 * NUMBER must drop it, and a reader that needs only the FACT may keep it. That single rule
 * explains all four sites: `measureHarmonicShape`'s least-squares fits drop it (a fit of the
 * floor's depth), `diffHarmonics` and `formatDiff` drop it (a printed dB delta against an
 * arbitrary depth), and this term keeps the fact while never touching the depth -
 *
 * - **both sides measured**: the signed difference, capped.
 * - **one side measured**: the two sounds do not share this partial at all, which is the
 *   most any per-partial difference can say, so `HARMONIC_ERROR_CLAMP_DB` outright. Reading
 *   `candidate - (-120)` instead would have made the charge depend on how deep the clamp
 *   happens to sit, and would have handed a candidate already 100 dB down a gradient built
 *   out of the floor.
 * - **neither side measured**: they agree that the partial is absent, so no error. This is
 *   the credit half of the charge above, and the two have to match: a candidate charged the
 *   full clamp for growing a partial the reference lacks must be credited for not growing
 *   it, or the term would punish presence without ever rewarding absence. The credit is
 *   also unreachable as a lever - the only way to collect it is to actually reproduce the
 *   reference's absence, which is the match.
 *
 * The asymmetry `harmonicTerm` draws stays where it is, one level up: it is about whether a
 * side has a measurable partial series AT ALL. A `harmonicShape` whose every entry is on the
 * floor - reachable when the fundamental's own peak is missing - is such a side, and is
 * treated here exactly as an absent shape, so a reference that established nothing about
 * timbre yields `similarity: null` instead of charging a candidate twelve times over.
 *
 * A NOTE ON THE ONE RULE THIS DELIBERATELY DOES NOT ADOPT: excluding a partial because the
 * REFERENCE floored it. It is tempting - a recording's noise floor is no one's target - but
 * measured against this analyzer it is both unnecessary and destructive. Unnecessary,
 * because a recording's noise floor does not reach this floor: probing a bandlimited tone
 * with broadband noise at -60 and -80 dBFS put its absent partials at -80 and -104 dB
 * relative to the fundamental, comfortably measurable, and `docs/agent-match-eval-reference.wav`
 * itself has all twelve above it - so exclusion would not have changed the case it was
 * proposed for. Destructive, because the material that DOES floor here is a clean render: a
 * synthesised sine floors partials 2-12 exactly, and excluding those would score a sawtooth
 * candidate 1.000 on timbre against a sine reference.
 *
 * `reference`/`candidate` are the mean levels of the partials measured on BOTH sides -
 * mirroring `bandsDetail`, and mirroring `brightnessDetail`'s rule that one set of pairs
 * feeds every field a reader might compare. Averaging the floor into them reported a
 * four-partial reference at -82.3 dB, a level no partial of it has and nothing was compared
 * against. `meanAbsError` covers the wider set the score does, and `AudioMetricsComparison`
 * says so where a reader meets the two.
 */
function harmonicsDetail(
  reference: HarmonicShape | undefined,
  candidate: HarmonicShape | undefined
): NullableAggregateMetricComparisonDetail {
  const measurableSeries = (shape: HarmonicShape | undefined): shape is HarmonicShape =>
    shape !== undefined && shape.amplitudesDbRelF0.some(isMeasuredPartial)
  // 0 is a placeholder for "this side has a series"; only the `similarity` of the answer is
  // used, so that `harmonicTerm` stays the one place the missing-side question is answered.
  const presence = harmonicTerm(
    measurableSeries(reference) ? 0 : null,
    measurableSeries(candidate) ? 0 : null,
    () => 0
  )
  if (!measurableSeries(reference) || !measurableSeries(candidate)) {
    return { reference: null, candidate: null, delta: null, meanAbsError: null, similarity: presence.similarity }
  }

  const partials = Math.min(reference.amplitudesDbRelF0.length, candidate.amplitudesDbRelF0.length)
  const referenceLevels: number[] = []
  const candidateLevels: number[] = []
  let cappedError = 0
  for (let index = 0; index < partials; index++) {
    const left = reference.amplitudesDbRelF0[index]
    const right = candidate.amplitudesDbRelF0[index]
    if (isMeasuredPartial(left) && isMeasuredPartial(right)) {
      referenceLevels.push(left)
      candidateLevels.push(right)
      cappedError += Math.min(HARMONIC_ERROR_CLAMP_DB, Math.abs(right - left))
    } else if (isMeasuredPartial(left) || isMeasuredPartial(right)) {
      cappedError += HARMONIC_ERROR_CLAMP_DB
    }
  }
  const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
  const meanAbsError = partials > 0 ? cappedError / partials : 0
  const comparedLevels = referenceLevels.length > 0
  const referenceMean = comparedLevels ? mean(referenceLevels) : null
  const candidateMean = comparedLevels ? mean(candidateLevels) : null
  return {
    reference: referenceMean,
    candidate: candidateMean,
    delta: comparedLevels ? (candidateMean as number) - (referenceMean as number) : null,
    meanAbsError,
    similarity: clampSimilarity(1 - meanAbsError / HARMONIC_ERROR_CLAMP_DB)
  }
}

/**
 * `tiltDbPerOctave`, or `null` when the fit had nothing to fit.
 *
 * `measureHarmonicShape` writes 0 for a shape with fewer than two measurable partials, and
 * says so: "0 then means 'no tilt measurable', which is the same number a genuinely flat
 * spectrum produces". Scoring that 0 as a slope is the `harmonicsDetail` defect in its other
 * costume - an unmeasurable value read as a measured one - and it bites the same way round:
 * a rendered sine has exactly one measurable partial, so a sine on either side of the
 * comparison contributed a fabricated "flat spectrum" reading to the score. Handing
 * `harmonicTerm` a `null` puts it under the rule already argued there: unmeasurable on the
 * reference is excluded, unmeasurable on the candidate alone is a measured failure at 0.
 */
const measuredTilt = (shape: HarmonicShape | undefined): number | null =>
  shape !== undefined && shape.amplitudesDbRelF0.filter(isMeasuredPartial).length >= 2
    ? shape.tiltDbPerOctave
    : null

/**
 * Compare summary audio features on bounded, metric-specific scales.
 * This is feature similarity for iterative sound design, not proof that two
 * sounds are perceptually identical.
 */
export function compareAudioMetrics(reference: AudioMetrics, candidate: AudioMetrics): AudioMetricsComparison {
  for (const [label, metrics] of [['reference', reference], ['candidate', candidate]] as const) {
    for (const key of metricKeys) {
      const value = metrics[key]
      if (key === 'decayT60Ms' && value === null) continue
      if (!Number.isFinite(value)) throw new Error(`${label}.${key} must be finite`)
    }
    if (!Number.isInteger(metrics.clippingCount) || metrics.clippingCount < 0) {
      throw new Error(`${label}.clippingCount must be a nonnegative integer`)
    }
    assertEnvelopeDb(label, metrics.envelopeDb)
    assertBandsDb(label, metrics.bandsDb)
    assertSpectralWindows(label, metrics.spectralWindows)
    if (metrics.harmonicShape) {
      assertNumberArray(label, 'harmonicShape.amplitudesDbRelF0', metrics.harmonicShape.amplitudesDbRelF0, HARMONIC_COUNT)
      for (const field of ['tiltDbPerOctave', 'oddEvenDb'] as const) {
        if (!Number.isFinite(metrics.harmonicShape[field])) {
          throw new Error(`${label}.harmonicShape.${field} must be finite`)
        }
      }
    }
    if (metrics.harmonics && !Number.isFinite(metrics.harmonics.inharmonicity)) {
      throw new Error(`${label}.harmonics.inharmonicity must be finite`)
    }
  }
  for (const key of metricKeys) {
    if (key === 'decayT60Ms') continue
    if (!Number.isFinite((candidate[key] as number) - (reference[key] as number))) {
      throw new Error(`${key} delta must be finite`)
    }
  }

  const detail = (
    key: Exclude<ComparedMetricKey, 'decayT60Ms'>,
    similarity: number
  ): AudioMetricComparisonDetail => ({
    reference: reference[key],
    candidate: candidate[key],
    delta: candidate[key] - reference[key],
    similarity: clampSimilarity(similarity)
  })
  const logRatio = (left: number, right: number, floor: number): number =>
    Math.log((Math.max(0, right) + floor) / (Math.max(0, left) + floor))

  const details: AudioMetricsComparison['details'] = {
    peakDb: detail('peakDb', exponentialSimilarity(candidate.peakDb - reference.peakDb, 12)),
    rmsDb: detail('rmsDb', exponentialSimilarity(candidate.rmsDb - reference.rmsDb, 12)),
    clippingCount: detail('clippingCount', exponentialSimilarity(
      Math.log1p(Math.max(0, candidate.clippingCount)) - Math.log1p(Math.max(0, reference.clippingCount)), 4
    )),
    dcOffset: detail('dcOffset', exponentialSimilarity(candidate.dcOffset - reference.dcOffset, 0.05)),
    spectralCentroidHz: detail('spectralCentroidHz', exponentialSimilarity(
      logRatio(reference.spectralCentroidHz, candidate.spectralCentroidHz, 20), Math.log(4)
    )),
    attackMs: detail('attackMs', exponentialSimilarity(
      logRatio(reference.attackMs, candidate.attackMs, 1), Math.log(4)
    )),
    stereoWidth: detail('stereoWidth', exponentialSimilarity(candidate.stereoWidth - reference.stereoWidth, 0.35)),
    decayT60Ms: decayDetail(reference.decayT60Ms, candidate.decayT60Ms, logRatio),
    envelope: envelopeDetail(reference.envelopeDb, candidate.envelopeDb),
    bands: bandsDetail(reference.bandsDb, candidate.bandsDb, reference.sampleRateHz, candidate.sampleRateHz),
    brightness: brightnessDetail(reference.spectralWindows, candidate.spectralWindows),
    harmonics: harmonicsDetail(reference.harmonicShape, candidate.harmonicShape),
    tilt: harmonicTerm(
      measuredTilt(reference.harmonicShape),
      measuredTilt(candidate.harmonicShape),
      (left, right) => exponentialSimilarity(right - left, TILT_SCALE_DB_PER_OCTAVE)
    ),
    // No `measuredTilt` equivalent, and deliberately: `analyzeHarmonics` falls back to
    // `inharmonicity: 0` only when its fit has no term at all, which cannot happen while a
    // `harmonics` block exists - the loudest partial is 0 dB relative to itself, clears
    // `HARMONIC_FIT_FLOOR_DB`, and carries a positive frequency, so it always supplies one.
    // Every 0 reaching this line is a fitted 0: a harmonic series.
    inharmonicity: harmonicTerm(
      reference.harmonics?.inharmonicity ?? null,
      candidate.harmonics?.inharmonicity ?? null,
      (left, right) => exponentialSimilarity(
        logRatio(left, right, INHARMONICITY_FLOOR), Math.log(4)
      )
    )
  }

  const overallKeys = [
    ...metricKeys.filter(key => key !== 'clippingCount'),
    'envelope' as const, 'bands' as const, 'brightness' as const,
    // Timbre was absent from the overall score entirely: `harmonics` was computed and only
    // ever reported, and `inharmonicity` was computed and never compared at all.
    'harmonics' as const, 'tilt' as const, 'inharmonicity' as const
  ]
  // A metric the pair carries no evidence about is left out of the mean rather than averaged
  // in as a zero: counting it as maximal disagreement would penalise a candidate for a
  // property nothing established. The metric still appears in `details` with
  // `similarity: null`, so the absence is legible.
  //
  // Exclusion is a hole in an unweighted mean, so it has to be reserved for genuine absence
  // of evidence. `harmonicTerm` is where that line is drawn: a candidate that loses a
  // dimension the reference *has* scores 0 on it and stays in the mean, so no candidate can
  // raise this number by making itself less measurable.
  const contributing = overallKeys
    .map(key => details[key].similarity)
    .filter((value): value is number => value !== null)
  const similarity = contributing.length > 0
    ? contributing.reduce((sum, value) => sum + value, 0) / contributing.length
    : 1
  return { similarity: clampSimilarity(similarity), details }
}

const toDb = (amplitude: number): number => amplitude > 0 ? 20 * Math.log10(amplitude) : -160

/**
 * Level relative to a reference, floored and never positive. `toDb(a) - toDb(b)` cannot be
 * used for this: its -160 floor applies to each term separately, so a near-silent buffer
 * whose reference is below the floor produces a *positive* "relative to peak" level.
 */
const relativeToPeakDb = (value: number, peak: number, floorDb: number): number =>
  value > 0 && peak > 0 ? Math.max(floorDb, Math.min(0, 20 * Math.log10(value / peak))) : floorDb

const ENVELOPE_WINDOW_SECONDS = 0.005
const ENVELOPE_HOP_SECONDS = 0.001
/** Shortest window the envelope hull's growth rate is measured over. */
const PLATEAU_HOLD_MS = 10
/**
 * The attack ends at the first hop whose hull growth has fallen to this fraction of the
 * average growth since onset. Comparing a rate against the run's *own* average rate is
 * what separates "still attacking" from "sustaining while a beat drifts": a beating
 * unison reaches half its eventual level in the first couple of milliseconds and then
 * crawls, twenty times slower, so it trips this immediately - while a linear swell grows
 * at one steady rate for its whole length and trips it only at the top, however long that
 * takes.
 */
const ATTACK_SLOPE_FRACTION = 0.25
/**
 * The growth window also grows with elapsed time. A 10 ms window is a couple of cycles at
 * the low end, so its ripple swamps the growth of a multi-second swell; widening it keeps
 * short attacks sharp and long ones measurable.
 */
const ATTACK_SPAN_FRACTION = 0.25
/** The dB span of the decay curve the T60 line is fitted through, and its midpoint. */
const DECAY_FIT_START_DB = -5
const DECAY_FIT_MID_DB = -15
const DECAY_FIT_END_DB = -25
/**
 * How far the two halves of the fit span may differ in duration. An exponential decay
 * spends equal time in each 10 dB; a signal that only falls because the buffer ran out
 * crams the second half into a fraction of the first, which is how a steady tone is told
 * from a decaying one.
 */
const DECAY_CURVATURE_LIMIT = 4
/**
 * Loudness gating, EBU R128 style. The first pass drops windows that are silence relative
 * to the envelope peak; the second drops windows this far below the ungated level. Both
 * thresholds scale with the signal, so the measurement set does not change when the whole
 * buffer is attenuated - which is what makes the figure monotonic in gain.
 */
const LOUDNESS_SILENCE_FLOOR_DB = -100
const LOUDNESS_RELATIVE_GATE_DB = -10
const ENVELOPE_FLOOR_DB = -100

interface Envelope {
  /** RMS amplitude per hop, each window centred on its hop and shifted inward at the edges. */
  values: Float32Array
  hopMs: number
  peak: number
  peakIndex: number
}

/**
 * RMS envelope of the channel *power*, not of a mono downmix: 5 ms window, 1 ms hop.
 *
 * Summing amplitudes would cancel anti-phase or merely decorrelated channels, so a wide
 * stereo patch would read as silence and a unison-spread control would look like a level
 * change. `sqrt(mean over channels of x²)` is level-preserving for any channel correlation
 * and is identical to the old downmix for mono and for two equal channels.
 *
 * Windows are shifted inward rather than zero-padded at the buffer edges: a partial window
 * reads low, and an agent cannot tell that trailing dip from a real decay.
 */
function computeEnvelope(channels: readonly Float32Array[], length: number, sampleRate: number): Envelope {
  const window = Math.min(length, Math.max(1, Math.round(ENVELOPE_WINDOW_SECONDS * sampleRate)))
  const hop = Math.max(1, Math.round(ENVELOPE_HOP_SECONDS * sampleRate))
  const cumulative = new Float64Array(length + 1)
  for (let i = 0; i < length; i++) {
    let power = 0
    for (const channel of channels) power += channel[i] * channel[i]
    cumulative[i + 1] = cumulative[i] + power / channels.length
  }

  const half = Math.floor(window / 2)
  const count = Math.floor((length - 1) / hop) + 1
  const values = new Float32Array(count)
  let peak = 0
  let peakIndex = 0
  for (let index = 0; index < count; index++) {
    const low = Math.max(0, Math.min(index * hop - half, length - window))
    const power = cumulative[low + window] - cumulative[low]
    const value = Math.sqrt(Math.max(0, power) / window)
    values[index] = value
    if (value > peak) {
      peak = value
      peakIndex = index
    }
  }
  return { values, hopMs: hop * 1000 / sampleRate, peak, peakIndex }
}

/** Running maximum, left to right. Monotone, so it is immune to the RMS window's ripple. */
function risingHull(values: Float32Array): Float32Array {
  const hull = new Float32Array(values.length)
  let highest = 0
  for (let index = 0; index < values.length; index++) {
    if (values[index] > highest) highest = values[index]
    hull[index] = highest
  }
  return hull
}

/**
 * Where the attack ends, and the level it reached. The global peak may arrive much later
 * (tremolo, unison beating, a swell), which is what `timeToPeakMs` reports.
 *
 * Measured as growth of the rising hull over PLATEAU_HOLD_MS, compared against the fastest
 * growth since onset. A fixed fractional growth per fixed hold cannot work: any rising
 * envelope's fractional growth per 10 ms drops below 8 % about 125 ms in, so every attack
 * longer than that read the same ~94 ms.
 */
function findFirstLocalMax(envelope: Envelope): { index: number; level: number } {
  const { values, peak, peakIndex } = envelope
  const hold = Math.max(1, Math.round(PLATEAU_HOLD_MS / envelope.hopMs))
  const hull = risingHull(values)
  for (let index = 0; index < hull.length - 1; index++) {
    const elapsed = index + 1
    const ahead = Math.min(hull.length - 1, index + Math.max(hold, Math.round(elapsed * ATTACK_SPAN_FRACTION)))
    if (ahead <= index) break
    const growth = (hull[ahead] - hull[index]) / (ahead - index)
    // Averaged from the buffer start, never from a level threshold: dividing a level that
    // has already arrived by one hop reads as an impossibly fast rate and ends the attack
    // at its own onset. A late-starting note only dilutes the average, which errs long.
    const average = hull[index] / elapsed
    if (average > 0 && growth <= average * ATTACK_SLOPE_FRACTION) {
      return { index: ahead, level: hull[ahead] }
    }
  }
  return { index: peakIndex, level: peak }
}

/** First fractional hop index whose envelope reaches `target`, linearly interpolated; -1 if never. */
function crossingIndex(values: Float32Array, target: number): number {
  for (let index = 0; index < values.length; index++) {
    if (values[index] < target) continue
    if (index === 0) return 0
    const previous = values[index - 1]
    const span = values[index] - previous
    return span > 0 ? index - 1 + (target - previous) / span : index
  }
  return -1
}

/**
 * -60 dB decay time read off the Schroeder energy decay curve, or `null` when the buffer
 * holds no decay this line describes.
 *
 * The curve is the backward-integrated energy of the envelope from the first local
 * maximum, so it is monotone by construction. Reading the raw envelope instead let a
 * single amplitude null end the fit: two steady sines a hertz apart reported a 632 ms
 * decay, a 2.5 Hz tremolo reported 106 ms, and a detuned-unison pluck read less than half
 * its true T60 - the same beating that motivated Task 6, resurfacing in a new field.
 *
 * Monotonicity alone is not enough: the decay curve of a *steady* tone still falls away
 * near the end of the buffer, simply because there is no energy left after it. That fall
 * accelerates - it is `10·log10(1 - t/T)` - so its second 10 dB pass ten to twenty times
 * faster than its first, while a real exponential decay spends equal time in each. Fits
 * that curved are reported as no decay rather than as a decay that is not there.
 */
function measureDecayT60Ms(envelope: Envelope, startIndex: number, level: number): number | null {
  if (!(level > 0)) return null
  const { values, hopMs } = envelope
  const count = values.length - startIndex
  if (count < 2) return null
  const curve = new Float64Array(count)
  let energy = 0
  for (let index = count - 1; index >= 0; index--) {
    const value = values[startIndex + index]
    energy += value * value
    curve[index] = energy
  }
  const reference = curve[0]
  if (!(reference > 0)) return null

  const decayDb = (index: number) => curve[index] > 0 ? 10 * Math.log10(curve[index] / reference) : -160
  const crossing = (target: number) => {
    for (let index = 0; index < count; index++) if (decayDb(index) <= target) return index
    return -1
  }
  const spanStart = crossing(DECAY_FIT_START_DB)
  const spanMid = crossing(DECAY_FIT_MID_DB)
  const spanEnd = crossing(DECAY_FIT_END_DB)
  if (spanStart < 0 || spanEnd < 0) return null
  const firstHalf = spanMid - spanStart
  const secondHalf = spanEnd - spanMid
  // Under one hop per 10 dB the decay is faster than the envelope can resolve.
  if (firstHalf < 1 || secondHalf < 1) return null
  if (Math.max(firstHalf / secondHalf, secondHalf / firstHalf) > DECAY_CURVATURE_LIMIT) return null

  let points = 0
  let sumX = 0
  let sumY = 0
  let sumXY = 0
  let sumXX = 0
  for (let index = spanStart; index <= spanEnd; index++) {
    const x = (index - spanStart) * hopMs
    const y = decayDb(index)
    points++
    sumX += x
    sumY += y
    sumXY += x * y
    sumXX += x * x
  }
  const denominator = points * sumXX - sumX * sumX
  if (denominator <= 0) return null
  const slope = (points * sumXY - sumX * sumY) / denominator
  if (!Number.isFinite(slope) || slope >= 0) return null
  const t60 = -60 / slope
  return Number.isFinite(t60) && t60 > 0 ? t60 : null
}

/**
 * Hann-windowed power spectrum summed over channels; index 0 is DC. Tiles `[begin, end)`
 * unless `singleWindowStart` asks for one window at a given offset inside it.
 */
function accumulateSpectrum(
  channels: readonly Float32Array[],
  begin: number,
  end: number,
  fftSize: number,
  singleWindowStart?: number
): Float64Array {
  const starts: number[] = []
  if (singleWindowStart !== undefined) {
    starts.push(Math.max(begin, Math.min(singleWindowStart, end - fftSize)))
  } else {
    for (let start = begin; start + fftSize <= end; start += fftSize) starts.push(start)
    const finalStart = end - fftSize
    if (starts.length === 0 || starts[starts.length - 1] !== finalStart) starts.push(finalStart)
  }

  const spectrum = new Float64Array(fftSize / 2 + 1)
  const re = new Float32Array(fftSize)
  const im = new Float32Array(fftSize)
  for (const start of starts) {
    for (const channel of channels) {
      im.fill(0)
      for (let i = 0; i < fftSize; i++) {
        const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (fftSize - 1))
        re[i] = channel[start + i] * window
      }
      fft(re, im)
      for (let bin = 0; bin < spectrum.length; bin++) {
        spectrum[bin] += re[bin] * re[bin] + im[bin] * im[bin]
      }
    }
  }
  return spectrum
}

/**
 * Geometric over arithmetic mean of the power bins. A pure tone puts everything in one
 * bin and scores near 0; white noise spreads evenly and approaches 1.
 */
function measureFlatness(spectrum: Float64Array): number {
  let maximum = 0
  for (let bin = 1; bin < spectrum.length; bin++) maximum = Math.max(maximum, spectrum[bin])
  if (!(maximum > 0)) return 0
  // A floor 200 dB down keeps log(0) out without lifting a real noise floor.
  const floor = maximum * 1e-20
  let logSum = 0
  let sum = 0
  let count = 0
  for (let bin = 1; bin < spectrum.length; bin++) {
    const power = Math.max(floor, spectrum[bin])
    logSum += Math.log(power)
    sum += power
    count++
  }
  if (count === 0) return 0
  const flatness = Math.exp(logSum / count) / (sum / count)
  return Number.isFinite(flatness) ? Math.max(0, Math.min(1, flatness)) : 0
}

/** Ten octave bands, each spanning centre/√2 … centre·√2, in dB relative to the total power. */
function measureBands(spectrum: Float64Array, binHz: number, totalPower: number): number[] {
  const bandPower = new Array<number>(BAND_COUNT).fill(0)
  for (let bin = 1; bin < spectrum.length; bin++) {
    const frequency = bin * binHz
    for (let band = 0; band < BAND_COUNT; band++) {
      const centre = BAND_CENTERS_HZ[band]
      if (frequency >= centre / Math.SQRT2 && frequency < centre * Math.SQRT2) {
        bandPower[band] += spectrum[bin]
        break
      }
    }
  }
  return bandPower.map(power => {
    const db = power > 0 ? 10 * Math.log10(power / totalPower) : BAND_FLOOR_DB
    return roundTenth(Math.max(BAND_FLOOR_DB, db))
  })
}

interface Partial {
  frequency: number
  amplitude: number
}

/** Stand-in for a slice whose spectrum held no energy at all. */
const SILENT_PARTIALS: readonly Partial[] =
  Array.from({ length: HARMONIC_COUNT }, () => ({ frequency: 0, amplitude: 0 }))

/**
 * Locate the first 12 partials in one power spectrum by peak-picking ±3 % around the
 * predicted partial. The prediction carries the stiffness B implied by the partials
 * already found, so the search tracks the series as it stretches. Amplitudes come from
 * parabolic interpolation over log magnitudes, which is what gives sub-bin frequency
 * accuracy — the only way B is visible at all.
 *
 * `undefined` when the spectrum holds no energy: the caller decides whether that means
 * "omit the field" or "this slice of the note has gone quiet".
 */
function pickPartials(
  spectrum: Float64Array,
  size: number,
  sampleRate: number,
  f0Hz: number
): { partials: Partial[]; strongest: number } | undefined {
  const half = size / 2
  const magnitude = new Float64Array(half + 1)
  let strongest = 0
  for (let bin = 0; bin <= half; bin++) {
    magnitude[bin] = Math.sqrt(spectrum[bin])
    if (bin > 0) strongest = Math.max(strongest, magnitude[bin])
  }
  if (!(strongest > 0)) return undefined

  const binsPerHz = size / sampleRate
  const logFloor = Math.log(Math.max(strongest * 1e-12, Number.MIN_VALUE))
  const logMagnitude = (bin: number) => magnitude[bin] > 0 ? Math.max(logFloor, Math.log(magnitude[bin])) : logFloor
  const partials: Partial[] = []
  // B is tracked as partials are found and steers the search for the next one. A fixed
  // window around n·f0 caps the measurable B at about 4e-4: beyond it the high partials
  // fall outside, the picked bin sits at the window edge, and because the fit weights by
  // n² those edge bins drag B to zero - reporting a bell as a perfect harmonic series.
  let stiffness = 0
  let fitNumerator = 0
  let fitDenominator = 0
  for (let n = 1; n <= HARMONIC_COUNT; n++) {
    const centreBin = n * f0Hz * Math.sqrt(1 + stiffness * n * n) * binsPerHz
    const low = Math.max(1, Math.floor(centreBin * (1 - HARMONIC_SEARCH_FRACTION)))
    const high = Math.min(half - 1, Math.ceil(centreBin * (1 + HARMONIC_SEARCH_FRACTION)))
    if (high < low) {
      partials.push({ frequency: 0, amplitude: 0 })
      continue
    }
    let bestBin = low
    for (let bin = low; bin <= high; bin++) {
      if (magnitude[bin] > magnitude[bestBin]) bestBin = bin
    }
    // Parabolic interpolation over log magnitudes: sub-bin accuracy is what makes B visible.
    const a = logMagnitude(bestBin - 1)
    const b = logMagnitude(bestBin)
    const c = logMagnitude(bestBin + 1)
    const denominator = a - 2 * b + c
    const shift = denominator < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / denominator)) : 0
    const amplitude = Math.exp(b - 0.25 * (a - c) * shift)
    const frequency = (bestBin + shift) * sampleRate / size
    partials.push({
      frequency,
      amplitude: Number.isFinite(amplitude) ? amplitude : magnitude[bestBin]
    })

    // Refit B through the origin on everything found so far, so the window for partial
    // n + 1 already knows how far the series has stretched. Only partials well clear of
    // the noise steer it; a bin picked out of noise would send the search off the rails.
    if (n > 1 && amplitude > strongest * 10 ** (HARMONIC_FIT_FLOOR_DB / 20)) {
      const ratio = frequency / (n * f0Hz)
      fitNumerator += n * n * (ratio * ratio - 1)
      fitDenominator += n * n * n * n
      if (fitDenominator > 0) {
        const fitted = fitNumerator / fitDenominator
        if (Number.isFinite(fitted) && fitted > 0) stiffness = fitted
      }
    }
  }

  return { partials, strongest }
}

/** Partial amplitudes in dB against a shared reference, floored so a null partial is not -Infinity. */
const partialsDb = (partials: readonly Partial[], reference: number): number[] =>
  partials.map(partial => {
    const db = partial.amplitude > 0 && reference > 0
      ? 20 * Math.log10(partial.amplitude / reference)
      : HARMONIC_AMPLITUDE_FLOOR_DB
    return roundTenth(Math.max(HARMONIC_AMPLITUDE_FLOOR_DB, db))
  })

/**
 * The two axes a wavetable synth actually has, read off the same 12 partials.
 *
 * `amplitudesDbRelF0` is the reason this exists. `HarmonicMetrics.amplitudesDb` is relative
 * to the *loudest* partial, which cannot be compared across two sounds: when their loudest
 * partial is a different n, every per-partial difference between them carries an unknown
 * constant offset, so the comparison measures which partial happened to win rather than the
 * timbre. Relative to the fundamental there is no such offset, and entry 0 is 0 dB by
 * construction.
 *
 * Both fits ignore partials sitting on `HARMONIC_AMPLITUDE_FLOOR_DB`: that value means "no
 * peak above the noise", so feeding it to a least-squares fit would fit the floor's depth.
 *
 * Degenerate cases, with fewer than the three measurable partials either fit wants:
 * - `tiltDbPerOctave` is 0 when fewer than two partials are measurable, because a slope
 *   needs two points and log2(1) = 0 gives no spread. 0 then means "no tilt measurable",
 *   which is the same number a genuinely flat spectrum produces.
 * - `oddEvenDb` treats a parity with nothing above the noise as measured *at* the floor,
 *   because that absence is exactly what this axis reports: a square wave's even partials
 *   are missing, not unmeasured. It is 0 only when no partial at all was found, which is
 *   also the number a sawtooth's near-balance produces; `amplitudesDbRelF0` tells the two
 *   apart, by whether any entry is above the floor.
 */
function measureHarmonicShape(amplitudesDbRelF0: readonly number[]): HarmonicShape {
  const measurable: { n: number; db: number }[] = []
  for (let index = 0; index < amplitudesDbRelF0.length; index++) {
    const db = amplitudesDbRelF0[index]
    if (isMeasuredPartial(db)) measurable.push({ n: index + 1, db })
  }

  // Least squares of level against log2(n): the slope is dB per doubling of partial number,
  // which for a harmonic series is dB per octave.
  let tiltDbPerOctave = 0
  if (measurable.length >= 2) {
    const meanX = measurable.reduce((sum, point) => sum + Math.log2(point.n), 0) / measurable.length
    const meanY = measurable.reduce((sum, point) => sum + point.db, 0) / measurable.length
    let covariance = 0
    let variance = 0
    for (const point of measurable) {
      const x = Math.log2(point.n) - meanX
      covariance += x * (point.db - meanY)
      variance += x * x
    }
    const slope = variance > 0 ? covariance / variance : 0
    tiltDbPerOctave = Number.isFinite(slope) ? roundTenth(slope) : 0
  }

  const odd = measurable.filter(point => point.n % 2 === 1)
  const even = measurable.filter(point => point.n % 2 === 0)
  // A parity with nothing above the noise is not "unmeasurable", it is the measurement:
  // a square wave has no even partials at all, and that absence is the entire content of
  // this axis. Its mean is the floor, which also bounds how large the reading can get.
  const mean = (points: readonly { db: number }[]) => points.length > 0
    ? points.reduce((sum, point) => sum + point.db, 0) / points.length
    : HARMONIC_AMPLITUDE_FLOOR_DB
  const oddEvenDb = odd.length > 0 || even.length > 0 ? roundTenth(mean(odd) - mean(even)) : 0

  return {
    amplitudesDbRelF0: [...amplitudesDbRelF0],
    tiltDbPerOctave,
    oddEvenDb: Number.isFinite(oddEvenDb) ? oddEvenDb : 0
  }
}

/**
 * Whole-buffer partial amplitudes and the stiffness coefficient B of `f_n = n·f0·√(1 + B·n²)`.
 *
 * The analysis window is taken at the envelope peak and is as long as the buffer allows (up
 * to 32768 samples), because a decaying note only holds its partials near the onset.
 */
function analyzeHarmonics(
  channels: readonly Float32Array[],
  length: number,
  sampleRate: number,
  f0Hz: number,
  peakSampleIndex: number
): { harmonics: HarmonicMetrics; harmonicShape: HarmonicShape } | undefined {
  if (!Number.isFinite(f0Hz) || f0Hz <= 0) return undefined
  let size = 1
  while ((size << 1) <= Math.min(length, 32768)) size <<= 1
  if (size < 256) return undefined

  const picked = pickPartials(
    accumulateSpectrum(channels, 0, length, size, peakSampleIndex),
    size, sampleRate, f0Hz
  )
  if (!picked) return undefined
  const { partials } = picked

  const loudest = partials.reduce((best, partial) => Math.max(best, partial.amplitude), 0)
  if (!(loudest > 0)) return undefined
  const amplitudesDb = partialsDb(partials, loudest)

  // (f_n / (n·f0))² - 1 = B·n², so B is a least-squares fit through the origin.
  let numerator = 0
  let denominator = 0
  for (let n = 1; n <= HARMONIC_COUNT; n++) {
    const partial = partials[n - 1]
    if (amplitudesDb[n - 1] <= HARMONIC_FIT_FLOOR_DB || !(partial.frequency > 0)) continue
    const ratio = partial.frequency / (n * f0Hz)
    const y = ratio * ratio - 1
    const x = n * n
    numerator += x * y
    denominator += x * x
  }
  const inharmonicity = denominator > 0 ? numerator / denominator : 0
  return {
    harmonics: {
      amplitudesDb,
      inharmonicity: Number.isFinite(inharmonicity) ? inharmonicity : 0
    },
    harmonicShape: measureHarmonicShape(partialsDb(partials, partials[0].amplitude))
  }
}

/**
 * Spectral evolution across four equal slices of the buffer, earliest first.
 *
 * Every slice is analysed *only* on its own samples - one FFT size, one tile count, chosen
 * from the shared slice length - so a value can be compared with the same value in the
 * slice before it. Slices are equal by construction rather than by dividing the buffer at
 * rounded boundaries: unequal spans would change the tile count and shift the raw partial
 * amplitudes that `harmonicsDb` compares across slices. The last few samples of a buffer
 * that does not divide by four are therefore not analysed, which `endMs` states.
 *
 * Levels are relative to the loudest slice and partials to the loudest partial in any
 * slice, so a decay reads as a fall towards the floor instead of every slice reading 0.
 */
function measureSpectralWindows(
  channels: readonly Float32Array[],
  length: number,
  sampleRate: number,
  f0Hz: number | undefined,
  windowCount: number
): SpectralWindow[] {
  const span = Math.floor(length / windowCount)
  const bounds = (index: number) => ({
    startMs: roundTenth(index * span * 1000 / sampleRate),
    endMs: roundTenth((index + 1) * span * 1000 / sampleRate)
  })
  let size = 1
  while ((size << 1) <= Math.min(span, SPECTRAL_FFT_MAX)) size <<= 1
  // A one-sample slice has no spectrum; report the timing and zeros rather than throwing.
  if (span < 2 || size < 2) {
    return Array.from({ length: windowCount }, (_, index) => ({
      ...bounds(index),
      spectralCentroidHz: 0,
      spectralRolloffHz: 0,
      levelDb: 0
    }))
  }

  const binHz = sampleRate / size
  const wantsHarmonics = f0Hz !== undefined && Number.isFinite(f0Hz) && f0Hz > 0 &&
    size >= SPECTRAL_WINDOW_MIN_HARMONIC_FFT
  const measured = Array.from({ length: windowCount }, (_, index) => {
    const begin = index * span
    const end = begin + span
    const spectrum = accumulateSpectrum(channels, begin, end, size)

    let weightedPower = 0
    let totalPower = 0
    for (let bin = 1; bin < spectrum.length; bin++) {
      weightedPower += spectrum[bin] * bin * binHz
      totalPower += spectrum[bin]
    }
    let spectralCentroidHz = 0
    let spectralRolloffHz = 0
    if (totalPower > 0) {
      spectralCentroidHz = weightedPower / totalPower
      let cumulative = 0
      for (let bin = 1; bin < spectrum.length; bin++) {
        cumulative += spectrum[bin]
        if (cumulative >= 0.85 * totalPower) {
          spectralRolloffHz = bin * binHz
          break
        }
      }
    }

    let power = 0
    for (const channel of channels) {
      for (let i = begin; i < end; i++) power += channel[i] * channel[i]
    }
    const rms = Math.sqrt(power / (span * channels.length))

    return {
      ...bounds(index),
      spectralCentroidHz,
      spectralRolloffHz,
      rms,
      partials: wantsHarmonics ? pickPartials(spectrum, size, sampleRate, f0Hz as number)?.partials : undefined
    }
  })

  const loudestRms = measured.reduce((best, window) => Math.max(best, window.rms), 0)
  const loudestPartial = measured.reduce(
    (best, window) => (window.partials ?? []).reduce((inner, partial) => Math.max(inner, partial.amplitude), best),
    0
  )
  // Every slice carries `harmonicsDb` or none does, and none does when no slice held a
  // partial at all - an absent field beats twelve floor values pretending to be a spectrum.
  const reportHarmonics = wantsHarmonics && loudestPartial > 0

  return measured.map(({ rms, partials, ...window }) => {
    const slice: SpectralWindow = {
      ...window,
      spectralCentroidHz: roundTenth(window.spectralCentroidHz),
      spectralRolloffHz: roundTenth(window.spectralRolloffHz),
      // Mirrors `envelopeDb`: with nothing to be relative to, the level is 0, not the floor.
      levelDb: loudestRms > 0 ? roundTenth(relativeToPeakDb(rms, loudestRms, ENVELOPE_FLOOR_DB)) : 0
    }
    // Marked, never dropped: the count stays predictable and the bounds still tile the
    // buffer, so a consumer can print `n/a (below the noise floor)` in the row's place.
    // Set from the rounded `levelDb` the caller will read, so a caller re-deriving the gate
    // from that field can never disagree with the flag.
    if (isSpectralWindowBelowNoiseFloor(slice)) slice.belowNoiseFloor = true
    // A slice that fell silent still gets its twelve entries, all at the floor.
    if (reportHarmonics) slice.harmonicsDb = partialsDb(partials ?? SILENT_PARTIALS, loudestPartial)
    return slice
  })
}

/**
 * The fundamental this analysis will work from: the caller's if they gave one, otherwise a
 * measurement, otherwise nothing. `null` is a real answer - the buffer holds no single
 * pitch - and every harmonic field is then absent rather than invented.
 *
 * A supplied `f0Hz` that is not a positive number is refused outright rather than falling
 * back to detection: the caller stated a fundamental, and quietly substituting a different
 * one would hide their bug behind plausible numbers.
 */
function resolvePitch(
  channels: readonly Float32Array[],
  sampleRate: number,
  options: AnalyzeAudioOptions
): PitchEstimate | null {
  if (options.f0Hz !== undefined) {
    if (!Number.isFinite(options.f0Hz) || options.f0Hz <= 0) return null
    const { midi, cents } = hzToNearestMidi(options.f0Hz)
    return { f0Hz: options.f0Hz, confidence: 1, midi, centsOffset: cents, source: 'given' }
  }
  if (options.detectPitch === false) return null
  try {
    const detected = detectPitch(channels, sampleRate)
    return detected && Number.isFinite(detected.f0Hz) && detected.f0Hz > 0 ? detected : null
  } catch {
    // A detector failure must not take the whole analysis down with it: every other metric
    // here is still valid, and the caller loses only the harmonic block - the same thing
    // they lose from unpitched material. Reported as "no pitch found", never as a fake one.
    return null
  }
}

export function analyzeAudio(
  channels: readonly Float32Array[],
  sampleRate: number,
  options: AnalyzeAudioOptions = {}
): AudioMetrics {
  if (!channels.length || channels.some(channel => !(channel instanceof Float32Array) || channel.length === 0)) {
    throw new Error('At least one non-empty audio channel is required')
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('Sample rate must be positive')
  const length = channels[0].length
  if (channels.some(channel => channel.length !== length)) throw new Error('Audio channels must have equal lengths')
  const windowCount = options.windows ?? SPECTRAL_WINDOW_COUNT
  if (
    !Number.isInteger(windowCount) ||
    windowCount < SPECTRAL_WINDOW_COUNT_MIN ||
    windowCount > SPECTRAL_WINDOW_COUNT_MAX
  ) {
    throw new Error(
      `windows must be an integer ${SPECTRAL_WINDOW_COUNT_MIN}…${SPECTRAL_WINDOW_COUNT_MAX}`
    )
  }

  let peak = 0
  let sum = 0
  let sumSquares = 0
  let clippingCount = 0
  let count = 0
  for (const channel of channels) {
    for (const sample of channel) {
      if (!Number.isFinite(sample)) throw new Error('Audio PCM must contain finite samples')
      const abs = Math.abs(sample)
      if (abs > peak) peak = abs
      if (abs >= 1) clippingCount++
      sum += sample
      sumSquares += sample * sample
      count++
    }
  }

  const envelope = computeEnvelope(channels, length, sampleRate)
  const { values: envelopeValues, hopMs, peak: envelopePeak } = envelope
  let attackMs = 0
  let timeToPeakMs = 0
  let decayT60Ms: number | null = null
  let sustainDb = 0
  let loudnessDb = -160
  let envelopeDb = new Array<number>(ENVELOPE_POINTS).fill(0)

  if (envelopePeak > 0) {
    const localMax = findFirstLocalMax(envelope)
    const lowIndex = crossingIndex(envelopeValues, localMax.level * 0.1)
    const highIndex = crossingIndex(envelopeValues, localMax.level * 0.9)
    if (lowIndex >= 0 && highIndex >= 0) attackMs = Math.max(0, highIndex - lowIndex) * hopMs

    timeToPeakMs = envelope.peakIndex * hopMs
    decayT60Ms = measureDecayT60Ms(envelope, localMax.index, localMax.level)

    const sustainIndex = Math.min(envelopeValues.length - 1, Math.round(0.8 * (envelopeValues.length - 1)))
    sustainDb = relativeToPeakDb(envelopeValues[sustainIndex], envelopePeak, ENVELOPE_FLOOR_DB)

    envelopeDb = Array.from({ length: ENVELOPE_POINTS }, (_, point) => {
      const index = Math.round(point * (envelopeValues.length - 1) / (ENVELOPE_POINTS - 1))
      return roundTenth(relativeToPeakDb(envelopeValues[index], envelopePeak, ENVELOPE_FLOOR_DB))
    })

    const silenceFloor = envelopePeak * 10 ** (LOUDNESS_SILENCE_FLOOR_DB / 20)
    const meanPower = (threshold: number): number => {
      let power = 0
      let windows = 0
      for (const value of envelopeValues) {
        if (value < threshold) continue
        power += value * value
        windows++
      }
      return windows > 0 ? power / windows : 0
    }
    const ungated = meanPower(silenceFloor)
    if (ungated > 0) {
      const relativeGate = Math.sqrt(ungated) * 10 ** (LOUDNESS_RELATIVE_GATE_DB / 20)
      loudnessDb = toDb(Math.sqrt(meanPower(Math.max(silenceFloor, relativeGate))))
    }
  }

  let fftSize = 1
  while ((fftSize << 1) <= Math.min(length, SPECTRAL_FFT_MAX)) fftSize <<= 1
  let spectralCentroidHz = 0
  let spectralRolloffHz = 0
  let spectralFlatness = 0
  let bandsDb = new Array<number>(BAND_COUNT).fill(BAND_FLOOR_DB)
  if (fftSize >= 2 && peak > 0) {
    const spectrum = accumulateSpectrum(channels, 0, length, fftSize)
    const binHz = sampleRate / fftSize
    let weightedPower = 0
    let totalPower = 0
    for (let bin = 1; bin < spectrum.length; bin++) {
      weightedPower += spectrum[bin] * bin * binHz
      totalPower += spectrum[bin]
    }
    if (totalPower > 0) {
      spectralCentroidHz = weightedPower / totalPower
      let cumulative = 0
      for (let bin = 1; bin < spectrum.length; bin++) {
        cumulative += spectrum[bin]
        if (cumulative >= 0.85 * totalPower) {
          spectralRolloffHz = bin * binHz
          break
        }
      }
      spectralFlatness = measureFlatness(spectrum)
      bandsDb = measureBands(spectrum, binHz, totalPower)
    }
  }

  let stereoWidth = 0
  if (channels.length >= 2) {
    let midSquares = 0
    let sideSquares = 0
    const left = channels[0]
    const right = channels[1]
    for (let i = 0; i < length; i++) {
      const mid = (left[i] + right[i]) * 0.5
      const side = (left[i] - right[i]) * 0.5
      midSquares += mid * mid
      sideSquares += side * side
    }
    const midRms = Math.sqrt(midSquares / length)
    const sideRms = Math.sqrt(sideSquares / length)
    const total = midRms + sideRms
    stereoWidth = total > 0 ? sideRms / total : 0
  }

  const pitch = resolvePitch(channels, sampleRate, options)

  const metrics: AudioMetrics = {
    peakDb: toDb(peak),
    rmsDb: toDb(Math.sqrt(sumSquares / count)),
    clippingCount,
    dcOffset: sum / count,
    spectralCentroidHz,
    attackMs,
    stereoWidth,
    timeToPeakMs,
    decayT60Ms,
    sustainDb,
    envelopeDb,
    loudnessDb,
    bandsDb,
    spectralRolloffHz,
    spectralFlatness,
    spectralWindows: measureSpectralWindows(channels, length, sampleRate, pitch?.f0Hz, windowCount),
    pitch,
    sampleRateHz: sampleRate
  }
  if (pitch) {
    const peakSampleIndex = Math.round(envelope.peakIndex * hopMs * sampleRate / 1000)
    const analyzed = peak > 0
      ? analyzeHarmonics(channels, length, sampleRate, pitch.f0Hz, peakSampleIndex)
      : undefined
    if (analyzed) {
      metrics.harmonics = analyzed.harmonics
      metrics.harmonicShape = analyzed.harmonicShape
    }
  }
  for (const key of scalarMetricKeys) {
    if (!Number.isFinite(metrics[key])) {
      throw new Error(`Audio analysis produced nonfinite metric: ${key}`)
    }
  }
  if (metrics.decayT60Ms !== null && !(Number.isFinite(metrics.decayT60Ms) && metrics.decayT60Ms > 0)) {
    throw new Error('Audio analysis produced nonfinite metric: decayT60Ms')
  }
  if (!metrics.envelopeDb.every(Number.isFinite)) {
    throw new Error('Audio analysis produced nonfinite metric: envelopeDb')
  }
  if (metrics.bandsDb.length !== BAND_COUNT || !metrics.bandsDb.every(Number.isFinite)) {
    throw new Error('Audio analysis produced nonfinite metric: bandsDb')
  }
  if (metrics.harmonics && !(
    metrics.harmonics.amplitudesDb.length === HARMONIC_COUNT &&
    metrics.harmonics.amplitudesDb.every(Number.isFinite) &&
    Number.isFinite(metrics.harmonics.inharmonicity)
  )) {
    throw new Error('Audio analysis produced nonfinite metric: harmonics')
  }
  if (metrics.harmonicShape && !(
    metrics.harmonicShape.amplitudesDbRelF0.length === HARMONIC_COUNT &&
    metrics.harmonicShape.amplitudesDbRelF0.every(Number.isFinite) &&
    Number.isFinite(metrics.harmonicShape.tiltDbPerOctave) &&
    Number.isFinite(metrics.harmonicShape.oddEvenDb)
  )) {
    throw new Error('Audio analysis produced nonfinite metric: harmonicShape')
  }
  if (metrics.pitch && !(
    Number.isFinite(metrics.pitch.f0Hz) && metrics.pitch.f0Hz > 0 &&
    Number.isFinite(metrics.pitch.confidence) &&
    Number.isFinite(metrics.pitch.midi) && Number.isFinite(metrics.pitch.centsOffset)
  )) {
    throw new Error('Audio analysis produced nonfinite metric: pitch')
  }
  // After the `harmonics` guard: the two share the peak-picking, so a buffer that overflows
  // it overflows both, and the narrower message is the more useful one.
  if (metrics.spectralWindows.length !== windowCount || !metrics.spectralWindows.every(window =>
    SPECTRAL_WINDOW_SCALAR_FIELDS.every(field => Number.isFinite(window[field])) &&
    (window.harmonicsDb === undefined ||
      (window.harmonicsDb.length === HARMONIC_COUNT && window.harmonicsDb.every(Number.isFinite)))
  )) {
    throw new Error('Audio analysis produced nonfinite metric: spectralWindows')
  }
  if (!Number.isInteger(metrics.clippingCount) || metrics.clippingCount < 0) {
    throw new Error('Audio analysis produced invalid clippingCount; expected a nonnegative integer')
  }
  return metrics
}
