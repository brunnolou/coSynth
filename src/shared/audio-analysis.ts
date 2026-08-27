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
}

export interface AudioMetricComparisonDetail {
  reference: number
  candidate: number
  delta: number
  similarity: number
}

export interface AudioMetricsComparison {
  similarity: number
  details: { [Key in keyof AudioMetrics]: AudioMetricComparisonDetail }
}

const clampSimilarity = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
const exponentialSimilarity = (error: number, scale: number): number =>
  clampSimilarity(Math.exp(-Math.abs(error) / scale))
const metricKeys: (keyof AudioMetrics)[] = [
  'peakDb', 'rmsDb', 'clippingCount', 'dcOffset',
  'spectralCentroidHz', 'attackMs', 'stereoWidth'
]

/**
 * Compare summary audio features on bounded, metric-specific scales.
 * This is feature similarity for iterative sound design, not proof that two
 * sounds are perceptually identical.
 */
export function compareAudioMetrics(reference: AudioMetrics, candidate: AudioMetrics): AudioMetricsComparison {
  for (const [label, metrics] of [['reference', reference], ['candidate', candidate]] as const) {
    for (const key of metricKeys) {
      if (!Number.isFinite(metrics[key])) throw new Error(`${label}.${key} must be finite`)
    }
    if (!Number.isInteger(metrics.clippingCount) || metrics.clippingCount < 0) {
      throw new Error(`${label}.clippingCount must be a nonnegative integer`)
    }
  }
  for (const key of metricKeys) {
    if (!Number.isFinite(candidate[key] - reference[key])) {
      throw new Error(`${key} delta must be finite`)
    }
  }

  const detail = (key: keyof AudioMetrics, similarity: number): AudioMetricComparisonDetail => ({
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
    stereoWidth: detail('stereoWidth', exponentialSimilarity(candidate.stereoWidth - reference.stereoWidth, 0.35))
  }

  const overallKeys = metricKeys.filter(key => key !== 'clippingCount')
  const similarity = overallKeys.reduce((sum, key) => sum + details[key].similarity, 0) / overallKeys.length
  return { similarity: clampSimilarity(similarity), details }
}

const toDb = (amplitude: number): number => amplitude > 0 ? 20 * Math.log10(amplitude) : -160

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

  const envelope = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    let value = 0
    for (const channel of channels) value += Math.abs(channel[i])
    envelope[i] = value / channels.length
  }
  const envelopePeak = envelope.reduce((maximum, value) => Math.max(maximum, value), 0)
  let attackMs = 0
  if (envelopePeak > 0) {
    const low = envelopePeak * 0.1
    const high = envelopePeak * 0.9
    const tolerance = envelopePeak * 1e-6
    let lowIndex = 0
    while (lowIndex < length && envelope[lowIndex] + tolerance < low) lowIndex++
    let highIndex = lowIndex
    while (highIndex < length && envelope[highIndex] + tolerance < high) highIndex++
    if (highIndex < length) attackMs = (highIndex - lowIndex) * 1000 / sampleRate
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
    stereoWidth
  }
  for (const key of metricKeys) {
    if (!Number.isFinite(metrics[key])) {
      throw new Error(`Audio analysis produced nonfinite metric: ${key}`)
    }
  }
  if (!Number.isInteger(metrics.clippingCount) || metrics.clippingCount < 0) {
    throw new Error('Audio analysis produced invalid clippingCount; expected a nonnegative integer')
  }
  return metrics
}
