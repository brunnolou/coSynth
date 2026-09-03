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

/** Mean of the channels. A mono mix is what both detectors want; neither is stereo-aware. */
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

/**
 * Estimate the fundamental of a decoded buffer, or return `null` when nothing periodic
 * survives the guards. Refusing beats fabricating here, exactly as `decayT60Ms` already does.
 */
export function detectPitch(
  channels: readonly Float32Array[],
  sampleRate: number,
  options: DetectPitchOptions = {}
): PitchEstimate | null {
  const minHz = options.minHz ?? 16.35
  const maxHz = options.maxHz ?? 5000
  const minConfidence = options.minConfidence ?? 0.85

  if (!channels.length || !Number.isFinite(sampleRate) || sampleRate <= 0) return null

  const length = Math.min(...channels.map((c) => c.length))
  if (length < MIN_WINDOW) return null

  const mono = toMono(channels, length)
  const size = windowFor(length)
  const hop = size >> 1

  const detector = PitchDetector.forFloat32Array(size)
  detector.minVolumeDecibels = -60

  // Pass 1: pitchy on every frame, cheap. Keep the frame indices that clear both guards.
  const passed: { start: number; hz: number; clarity: number }[] = []
  for (let start = 0; start + size <= length; start += hop) {
    const frame = mono.subarray(start, start + size)
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
    const frame = mono.subarray(start, start + size)
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
