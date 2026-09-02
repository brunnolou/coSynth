import { fft } from './fft'

export interface AudioMetrics {
  peakDb: number
  rmsDb: number
  clippingCount: number
  dcOffset: number
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
  /** Gated RMS: envelope windows below -60 dBFS are dropped, so reverb tails and silence do not dilute it. */
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
  /** Present only when `analyzeAudio` was given an `f0Hz`; never fabricated. */
  harmonics?: HarmonicMetrics
}

export interface HarmonicMetrics {
  /**
   * The first 12 partials, in dB relative to the loudest partial found (so the loudest
   * reads 0). A partial with no peak above the noise reads the -120 dB floor.
   */
  amplitudesDb: number[]
  /**
   * B fitted from `f_n = n·f0·√(1 + B·n²)`. 0 is perfectly harmonic (an organ);
   * a piano string is roughly 1e-4 … 1e-3; stiffer, more bell-like partials are higher.
   */
  inharmonicity: number
}

export interface AnalyzeAudioOptions {
  /**
   * Fundamental of the tone in Hz. Supply it for a single-pitch render and the analyzer
   * adds `harmonics`; without it `harmonics` is absent rather than guessed.
   */
  f0Hz?: number
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

/** `decayT60Ms` is absent whenever the buffer never decayed, so its detail carries nulls. */
export interface NullableMetricComparisonDetail {
  reference: number | null
  candidate: number | null
  delta: number | null
  similarity: number
}

export interface AudioMetricsComparison {
  similarity: number
  details:
    & { [Key in Exclude<ComparedMetricKey, 'decayT60Ms'>]: AudioMetricComparisonDetail }
    & { decayT60Ms: NullableMetricComparisonDetail }
    /** Pearson correlation of the two `envelopeDb` curves; reference/candidate are their mean levels. */
    & { envelope: AudioMetricComparisonDetail }
    /** Mean absolute dB difference across `bandsDb`; reference/candidate are their mean levels. */
    & { bands: AudioMetricComparisonDetail }
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
 * Round to 0.1 dB and normalise -0, which reads as an oddity in JSON diffs. `|| 0` would
 * also turn NaN into 0, which would disarm the finiteness guards this module ends with.
 */
const roundDb = (value: number): number => {
  const rounded = Math.round(value * 10) / 10
  return rounded === 0 ? 0 : rounded
}
const BAND_COUNT = 10
/** Octave band centres: 31.25 Hz doubled nine times, ending at 16 kHz. */
const BAND_CENTERS_HZ = Array.from({ length: BAND_COUNT }, (_, index) => 31.25 * 2 ** index)
const BAND_FLOOR_DB = -100
const HARMONIC_COUNT = 12
/** Partials quieter than this relative to the loudest are not real peaks; they do not constrain B. */
const HARMONIC_FIT_FLOOR_DB = -60
const HARMONIC_AMPLITUDE_FLOOR_DB = -120

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

/** Two sounds that both never decayed match; one that decayed and one that did not do not. */
function decayDetail(
  reference: number | null,
  candidate: number | null,
  logRatio: (left: number, right: number, floor: number) => number
): NullableMetricComparisonDetail {
  const similarity = reference === null || candidate === null
    ? (reference === candidate ? 1 : 0)
    : clampSimilarity(exponentialSimilarity(logRatio(reference, candidate, 1), Math.log(4)))
  return {
    reference,
    candidate,
    delta: reference === null || candidate === null ? null : candidate - reference,
    similarity
  }
}

/** Mean absolute dB difference across the band vector, on a 6 dB scale. */
function bandsDetail(reference: readonly number[], candidate: readonly number[]): AudioMetricComparisonDetail {
  const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
  let absoluteError = 0
  for (let index = 0; index < reference.length; index++) absoluteError += Math.abs(candidate[index] - reference[index])
  const referenceMean = mean(reference)
  const candidateMean = mean(candidate)
  return {
    reference: referenceMean,
    candidate: candidateMean,
    delta: candidateMean - referenceMean,
    similarity: exponentialSimilarity(absoluteError / reference.length, 6)
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
    bands: bandsDetail(reference.bandsDb, candidate.bandsDb)
  }

  const overallKeys = [...metricKeys.filter(key => key !== 'clippingCount'), 'envelope' as const, 'bands' as const]
  const similarity = overallKeys.reduce((sum, key) => sum + details[key].similarity, 0) / overallKeys.length
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
/** Envelope windows quieter than this are excluded from the gated loudness figure. */
const LOUDNESS_GATE = 10 ** (-60 / 20)
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
 * Hann-windowed power spectrum summed over channels; index 0 is DC. Tiles the whole buffer
 * unless `singleWindowStart` asks for one window at a given offset.
 */
function accumulateSpectrum(
  channels: readonly Float32Array[],
  length: number,
  fftSize: number,
  singleWindowStart?: number
): Float64Array {
  const starts: number[] = []
  if (singleWindowStart !== undefined) {
    starts.push(Math.max(0, Math.min(singleWindowStart, length - fftSize)))
  } else {
    for (let start = 0; start + fftSize <= length; start += fftSize) starts.push(start)
    const finalStart = length - fftSize
    if (starts[starts.length - 1] !== finalStart) starts.push(finalStart)
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
    return roundDb(Math.max(BAND_FLOOR_DB, db))
  })
}

/**
 * Locate the first 12 partials by peak-picking ±3 % around n·f0 and fit the stiffness
 * coefficient B of `f_n = n·f0·√(1 + B·n²)`.
 *
 * The window is taken at the envelope peak and is as long as the buffer allows (up to
 * 32768 samples), because a decaying note only holds its partials near the onset and
 * because B is only visible with sub-bin frequency accuracy — hence the parabolic
 * interpolation over log magnitudes.
 */
function analyzeHarmonics(
  channels: readonly Float32Array[],
  length: number,
  sampleRate: number,
  f0Hz: number,
  peakSampleIndex: number
): HarmonicMetrics | undefined {
  if (!Number.isFinite(f0Hz) || f0Hz <= 0) return undefined
  let size = 1
  while ((size << 1) <= Math.min(length, 32768)) size <<= 1
  if (size < 256) return undefined

  const spectrum = accumulateSpectrum(channels, length, size, peakSampleIndex)
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
  const partials: { frequency: number; amplitude: number }[] = []
  for (let n = 1; n <= HARMONIC_COUNT; n++) {
    const centreBin = n * f0Hz * binsPerHz
    const low = Math.max(1, Math.floor(centreBin * 0.97))
    const high = Math.min(half - 1, Math.ceil(centreBin * 1.03))
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
    partials.push({
      frequency: (bestBin + shift) * sampleRate / size,
      amplitude: Number.isFinite(amplitude) ? amplitude : magnitude[bestBin]
    })
  }

  const loudest = partials.reduce((best, partial) => Math.max(best, partial.amplitude), 0)
  if (!(loudest > 0)) return undefined
  const amplitudesDb = partials.map(partial => {
    const db = partial.amplitude > 0 ? 20 * Math.log10(partial.amplitude / loudest) : HARMONIC_AMPLITUDE_FLOOR_DB
    return roundDb(Math.max(HARMONIC_AMPLITUDE_FLOOR_DB, db))
  })

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
    amplitudesDb,
    inharmonicity: Number.isFinite(inharmonicity) ? inharmonicity : 0
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
      return roundDb(relativeToPeakDb(envelopeValues[index], envelopePeak, ENVELOPE_FLOOR_DB))
    })

    let gatedPower = 0
    let gatedCount = 0
    for (const value of envelopeValues) {
      if (value < LOUDNESS_GATE) continue
      gatedPower += value * value
      gatedCount++
    }
    if (gatedCount > 0) loudnessDb = toDb(Math.sqrt(gatedPower / gatedCount))
  }

  let fftSize = 1
  while ((fftSize << 1) <= Math.min(length, 4096)) fftSize <<= 1
  let spectralCentroidHz = 0
  let spectralRolloffHz = 0
  let spectralFlatness = 0
  let bandsDb = new Array<number>(BAND_COUNT).fill(BAND_FLOOR_DB)
  if (fftSize >= 2 && peak > 0) {
    const spectrum = accumulateSpectrum(channels, length, fftSize)
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
    spectralFlatness
  }
  if (options.f0Hz !== undefined) {
    const peakSampleIndex = Math.round(envelope.peakIndex * hopMs * sampleRate / 1000)
    const harmonics = peak > 0 ? analyzeHarmonics(channels, length, sampleRate, options.f0Hz, peakSampleIndex) : undefined
    if (harmonics) metrics.harmonics = harmonics
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
  if (!Number.isInteger(metrics.clippingCount) || metrics.clippingCount < 0) {
    throw new Error('Audio analysis produced invalid clippingCount; expected a nonnegative integer')
  }
  return metrics
}
