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
  /** -60 dB decay time extrapolated from the -5…-25 dB slope; null when the buffer never falls 20 dB. */
  decayT60Ms: number | null
  /** Envelope level at 80% of the buffer, relative to the peak. */
  sustainDb: number
  /** 64 evenly spaced envelope samples, dB relative to the peak, rounded to 0.1. */
  envelopeDb: number[]
  /** Gated RMS: envelope windows below -60 dBFS are dropped, so reverb tails and silence do not dilute it. */
  loudnessDb: number
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
  'timeToPeakMs', 'sustainDb', 'loudnessDb'
]
const ENVELOPE_POINTS = 64

function assertEnvelopeDb(label: string, values: unknown): number[] {
  if (!Array.isArray(values) || values.length !== ENVELOPE_POINTS) {
    throw new Error(`${label}.envelopeDb must be an array of ${ENVELOPE_POINTS} numbers`)
  }
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error(`${label}.envelopeDb must contain finite numbers`)
  }
  return values as number[]
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
    envelope: envelopeDetail(reference.envelopeDb, candidate.envelopeDb)
  }

  const overallKeys = [...metricKeys.filter(key => key !== 'clippingCount'), 'envelope' as const]
  const similarity = overallKeys.reduce((sum, key) => sum + details[key].similarity, 0) / overallKeys.length
  return { similarity: clampSimilarity(similarity), details }
}

const toDb = (amplitude: number): number => amplitude > 0 ? 20 * Math.log10(amplitude) : -160

const ENVELOPE_WINDOW_SECONDS = 0.005
const ENVELOPE_HOP_SECONDS = 0.001
/** How long the envelope must stop climbing before a hop counts as a local maximum. */
const PLATEAU_HOLD_MS = 10
/**
 * A hop is a local maximum when nothing in the next PLATEAU_HOLD_MS exceeds it by more
 * than this. Slow unison beating climbs a few percent per 10 ms; a real attack climbs far
 * faster, so this separates "still attacking" from "sustaining while the beat drifts".
 */
const PLATEAU_TOLERANCE = 0.08
/** Envelope windows quieter than this are excluded from the gated loudness figure. */
const LOUDNESS_GATE = 10 ** (-60 / 20)
const ENVELOPE_FLOOR_DB = -100

interface Envelope {
  /** RMS amplitude per hop, each window centred on its hop and zero-padded at the edges. */
  values: Float32Array
  hopMs: number
  peak: number
  peakIndex: number
}

/** Mono-summed RMS envelope: 5 ms window, 1 ms hop. */
function computeEnvelope(channels: readonly Float32Array[], length: number, sampleRate: number): Envelope {
  const window = Math.max(1, Math.round(ENVELOPE_WINDOW_SECONDS * sampleRate))
  const hop = Math.max(1, Math.round(ENVELOPE_HOP_SECONDS * sampleRate))
  const cumulative = new Float64Array(length + 1)
  for (let i = 0; i < length; i++) {
    let mono = 0
    for (const channel of channels) mono += channel[i]
    mono /= channels.length
    cumulative[i + 1] = cumulative[i] + mono * mono
  }

  const half = Math.floor(window / 2)
  const count = Math.floor((length - 1) / hop) + 1
  const values = new Float32Array(count)
  let peak = 0
  let peakIndex = 0
  for (let index = 0; index < count; index++) {
    const start = index * hop - half
    const low = Math.max(0, start)
    const high = Math.min(length, start + window)
    const power = high > low ? cumulative[high] - cumulative[low] : 0
    const value = Math.sqrt(power / window)
    values[index] = value
    if (value > peak) {
      peak = value
      peakIndex = index
    }
  }
  return { values, hopMs: hop * 1000 / sampleRate, peak, peakIndex }
}

/**
 * The first hop the envelope stops climbing for PLATEAU_HOLD_MS, and the height it reaches
 * there. This is the end of the attack; the global peak may arrive much later (tremolo,
 * unison beating, a swell), which is what `timeToPeakMs` reports.
 */
function findFirstLocalMax(envelope: Envelope): { index: number; level: number } {
  const { values, peak, peakIndex } = envelope
  const hold = Math.max(1, Math.round(PLATEAU_HOLD_MS / envelope.hopMs))
  const floor = peak * 0.1
  for (let index = 0; index < values.length; index++) {
    if (values[index] < floor) continue
    const last = Math.min(values.length - 1, index + hold)
    let highest = values[index]
    let highestIndex = index
    for (let ahead = index + 1; ahead <= last; ahead++) {
      if (values[ahead] > highest) {
        highest = values[ahead]
        highestIndex = ahead
      }
    }
    if (highest <= values[index] * (1 + PLATEAU_TOLERANCE)) return { index: highestIndex, level: highest }
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

/** Least-squares dB slope over the -5…-25 dB span below the first local maximum, read out at -60 dB. */
function measureDecayT60Ms(envelope: Envelope, startIndex: number, level: number): number | null {
  if (!(level > 0)) return null
  const { values, hopMs } = envelope
  const relativeDb = (value: number) => value > 0 ? 20 * Math.log10(value / level) : -160
  let spanStart = -1
  let spanEnd = -1
  for (let index = startIndex; index < values.length; index++) {
    const db = relativeDb(values[index])
    if (spanStart < 0 && db <= -5) spanStart = index
    if (db <= -25) {
      spanEnd = index
      break
    }
  }
  if (spanStart < 0 || spanEnd < 0) return null

  let count = 0
  let sumX = 0
  let sumY = 0
  let sumXY = 0
  let sumXX = 0
  for (let index = spanStart; index <= spanEnd; index++) {
    const x = (index - spanStart) * hopMs
    const y = relativeDb(values[index])
    count++
    sumX += x
    sumY += y
    sumXY += x * y
    sumXX += x * x
  }
  const denominator = count * sumXX - sumX * sumX
  if (denominator <= 0) return null
  const slope = (count * sumXY - sumX * sumY) / denominator
  if (!Number.isFinite(slope) || slope >= 0) return null
  const t60 = -60 / slope
  return Number.isFinite(t60) && t60 > 0 ? t60 : null
}

export function analyzeAudio(channels: readonly Float32Array[], sampleRate: number): AudioMetrics {
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
    sustainDb = Math.max(ENVELOPE_FLOOR_DB, toDb(envelopeValues[sustainIndex]) - toDb(envelopePeak))

    envelopeDb = Array.from({ length: ENVELOPE_POINTS }, (_, point) => {
      const index = Math.round(point * (envelopeValues.length - 1) / (ENVELOPE_POINTS - 1))
      const db = Math.max(ENVELOPE_FLOOR_DB, toDb(envelopeValues[index]) - toDb(envelopePeak))
      return Math.round(db * 10) / 10
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
  if (fftSize >= 2 && peak > 0) {
    const windowStarts: number[] = []
    for (let start = 0; start + fftSize <= length; start += fftSize) windowStarts.push(start)
    const finalStart = length - fftSize
    if (windowStarts[windowStarts.length - 1] !== finalStart) windowStarts.push(finalStart)
    let weightedPower = 0
    let totalPower = 0
    for (const start of windowStarts) {
      for (const channel of channels) {
        const re = new Float32Array(fftSize)
        const im = new Float32Array(fftSize)
        for (let i = 0; i < fftSize; i++) {
          const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (fftSize - 1))
          re[i] = channel[start + i] * window
        }
        fft(re, im)
        for (let bin = 1; bin <= fftSize / 2; bin++) {
          const power = re[bin] * re[bin] + im[bin] * im[bin]
          weightedPower += power * bin * sampleRate / fftSize
          totalPower += power
        }
      }
    }
    if (totalPower > 0) spectralCentroidHz = weightedPower / totalPower
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
    loudnessDb
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
  if (!Number.isInteger(metrics.clippingCount) || metrics.clippingCount < 0) {
    throw new Error('Audio analysis produced invalid clippingCount; expected a nonnegative integer')
  }
  return metrics
}
