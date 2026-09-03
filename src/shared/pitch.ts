/**
 * Fundamental-frequency detection.
 *
 * Two detectors, one veto. `pitchy` (McLeod pitch method) is fast and accurate on clean
 * periodic frames but has no range guard and no notion of "this is not a pitch at all":
 * it happily reports 5.4 Hz at clarity 0.66 on a kick drum and 7.22 Hz at clarity 0.99 on a
 * 37 Hz tone with a weak fundamental. So every frame that survives the range and clarity
 * guards is re-measured with YIN on the same samples, and the frame is dropped unless the two
 * agree within 50 cents. That veto is what turns confident wrong answers into `null`.
 *
 * Refusing beats fabricating here, exactly as `decayT60Ms` already does.
 *
 * Neither detector is stereo-aware, so both read a single signal. That signal is normally the
 * mono sum, but the sum is the one mix that can destroy the thing being measured: coSynth
 * produces anti-phase material on purpose - `osc1.spread`, unison detune, the chorus, all of
 * which `stereoWidth` scores toward 1 - and summing opposite channels cancels a clear tone to
 * nothing. So the sum's level is checked against the channels' first, and a cancelled sum is
 * abandoned in favour of the channels themselves. See `COLLAPSE_RATIO`.
 *
 * Safe in a Web Worker and under jsdom: no `window`, `document` or `AudioContext`, at import
 * or at call time.
 */

import yin from '@audio/pitch-yin'
import { PitchDetector } from 'pitchy'
import { hzToNearestMidi } from './notes'
import type { PitchEstimate } from './match-types'

export interface DetectPitchOptions {
  /** Search floor. Defaults to C0, 16.35 Hz - the keyboard's own bottom note. */
  minHz?: number
  /** Search ceiling. Defaults to 5000 Hz. */
  maxHz?: number
  /** Reject frames below this agreement/clarity. Defaults to 0.85. */
  minConfidence?: number
}

/**
 * 4096 is deliberate, not a round number. A 37 Hz period at 44.1 kHz is ~1192 samples, so the
 * window has to hold several of them; but at 8192 and 16384 pitchy collapses to a confident
 * subharmonic on vibrato'd low tones, because the pitch has moved within the window. 4096 is
 * the size where both failure modes stay away.
 */
const WINDOW = 4096
/** The smallest window we will fall back to on a short buffer. Below this, we refuse. */
const MIN_WINDOW = 1024
/** Two detectors must land inside this to count as agreement. */
const AGREEMENT_CENTS = 50
/**
 * pitchy costs ~0.5 ms per frame; the YIN veto costs ~14 ms. A 30 s buffer is ~640 frames, so
 * vetoing every survivor would cost ~9 s. We veto an evenly-spaced sample of at most this many
 * frames instead, which keeps the whole detection under ~0.5 s and still spans the buffer.
 */
const MAX_VETOED_FRAMES = 32
/**
 * How far the mono sum may fall below its loudest channel before we stop believing it. Two
 * equal-amplitude channels `phi` apart sum to `cos(phi / 2)` of one channel's level, so this
 * 0.25 (-12 dB) is only reached past ~151 degrees of phase difference. Every ordinary stereo
 * shape sits well above it: 1.0 for identical channels, ~0.71 for uncorrelated ones, 0.5 with
 * one channel silent. It fires on cancellation and on nothing else.
 */
const COLLAPSE_RATIO = 0.25
/**
 * ...and this is what keeps that ratio from firing on silence, where it is 0/0 or one noise
 * floor over another. It is pitchy's own `minVolumeDecibels = -60` expressed as an amplitude
 * (10 ** (-60 / 20)): below this the channels hold no frame the fallback could rescue, so a
 * quiet sum means an empty recording rather than a cancelled one, and the answer stays `null`.
 */
const SILENT_RMS = 1e-3

/** Mean of the channels. Still the right signal for everything that is not near anti-phase. */
function toMono(channels: readonly Float32Array[], length: number): Float32Array {
  if (channels.length === 1) return channels[0]
  const mono = new Float32Array(length)
  for (const channel of channels) {
    const n = Math.min(length, channel.length)
    for (let i = 0; i < n; i++) mono[i] += channel[i]
  }
  for (let i = 0; i < length; i++) mono[i] /= channels.length
  return mono
}

function rms(samples: Float32Array, length: number): number {
  const n = Math.min(length, samples.length)
  if (n <= 0) return 0
  let sum = 0
  for (let i = 0; i < n; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / n)
}

function centsBetween(a: number, b: number): number {
  return Math.abs(1200 * Math.log2(a / b))
}

/** Largest power of two that fits, so pitchy's FFT stays on its fast path. */
function windowFor(length: number): number {
  if (length >= WINDOW) return WINDOW
  let size = WINDOW
  while (size > length) size >>= 1
  return size
}

interface Guards {
  minHz: number
  maxHz: number
  minConfidence: number
}

/**
 * The detector proper, on one already-chosen signal: two passes, one veto, a median frame.
 */
function detectOn(
  signal: Float32Array,
  length: number,
  sampleRate: number,
  { minHz, maxHz, minConfidence }: Guards
): PitchEstimate | null {
  const size = windowFor(length)
  const hop = size >> 1

  const detector = PitchDetector.forFloat32Array(size)
  detector.minVolumeDecibels = -60

  // Pass 1: pitchy on every frame, cheap. Keep the frame indices that clear both guards.
  const passed: { start: number; hz: number; clarity: number }[] = []
  for (let start = 0; start + size <= length; start += hop) {
    const frame = signal.subarray(start, start + size)
    const [hz, clarity] = detector.findPitch(frame, sampleRate)
    // Range guard first: pitchy has none of its own, and its subharmonic answers are the
    // confident ones, so clarity cannot be trusted to filter them.
    if (!Number.isFinite(hz) || hz < minHz || hz > maxHz) continue
    if (clarity < minConfidence) continue
    passed.push({ start, hz, clarity })
  }
  if (!passed.length) return null

  // Pass 2: the YIN veto, on an evenly-spaced subset when there are many survivors.
  const step = Math.max(1, Math.ceil(passed.length / MAX_VETOED_FRAMES))
  const survivors: { hz: number; confidence: number }[] = []
  for (let i = 0; i < passed.length; i += step) {
    const { start, hz, clarity } = passed[i]
    const frame = signal.subarray(start, start + size)
    const check = yin(frame, { fs: sampleRate, minFreq: minHz, maxFreq: maxHz })
    if (!check || !Number.isFinite(check.freq) || check.freq <= 0) continue
    if (centsBetween(hz, check.freq) > AGREEMENT_CENTS) continue
    // The weaker of the two detectors is the honest confidence: agreement is only as good
    // as the less certain measurement behind it.
    survivors.push({ hz, confidence: Math.min(clarity, check.clarity) })
  }
  if (!survivors.length) return null

  // The median frame, not the mean, so one outlier frame cannot drag the answer off the note;
  // and we report that frame's own confidence rather than an average, so the number describes
  // the measurement we are actually returning. Even counts take the lower middle, which keeps
  // f0 and confidence belonging to the same real frame.
  survivors.sort((a, b) => a.hz - b.hz)
  const median = survivors[(survivors.length - 1) >> 1]

  const { midi, cents } = hzToNearestMidi(median.hz)
  return {
    f0Hz: median.hz,
    confidence: median.confidence,
    midi,
    centsOffset: cents,
    source: 'detected'
  }
}

/**
 * Estimate the fundamental of a decoded buffer, or return `null` when nothing periodic
 * survives the guards. Refusing beats fabricating here, exactly as `decayT60Ms` already does.
 */
export function detectPitch(
  channels: readonly Float32Array[],
  sampleRate: number,
  options: DetectPitchOptions = {}
): PitchEstimate | null {
  const guards: Guards = {
    minHz: options.minHz ?? 16.35,
    maxHz: options.maxHz ?? 5000,
    minConfidence: options.minConfidence ?? 0.85
  }

  if (!channels.length || !Number.isFinite(sampleRate) || sampleRate <= 0) return null

  const length = Math.min(...channels.map((c) => c.length))
  if (length < MIN_WINDOW) return null

  if (channels.length === 1) return detectOn(channels[0], length, sampleRate, guards)

  // Two O(n) passes of arithmetic decide which signal to spend the detectors on. That is
  // nothing beside pitchy's ~0.5 ms per frame, and it buys the whole anti-phase case.
  const levels = channels.map((channel) => rms(channel, length))
  const loudest = Math.max(...levels)
  const mono = toMono(channels, length)

  // A sum far below its own channels has cancelled; a sum far below nothing has not. The
  // absolute floor is what separates those two, and it has to come first - without it, digital
  // silence reads as a total collapse and sends us hunting for a pitch that was never there.
  const cancelled = loudest >= SILENT_RMS && rms(mono, length) < COLLAPSE_RATIO * loudest
  if (!cancelled) return detectOn(mono, length, sampleRate, guards)

  // The channels survive what their sum did not, and near anti-phase they are near mirrors of
  // each other, so the loudest one alone normally answers - one pass, the same cost as the sum
  // it replaced. The rest are tried only if it refuses.
  const byLevel = levels
    .map((level, index) => ({ level, index }))
    .sort((a, b) => b.level - a.level)
  for (const { index } of byLevel) {
    const got = detectOn(channels[index].subarray(0, length), length, sampleRate, guards)
    if (got) return got
  }
  return null
}
