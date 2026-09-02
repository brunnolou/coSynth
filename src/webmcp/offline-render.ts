/**
 * Offline rendering for `render_audio` — Task 10 of
 * docs/plans/2026-09-02-agent-experience.md.
 *
 * A scratch `SynthEngine` is built on a single-use `OfflineAudioContext`, loaded
 * with the live engine's current patch, and driven with sample-accurate note
 * events. Nothing touches the live graph, so a render needs no user gesture, no
 * wall-clock time, and produces the same samples every call.
 */
import { SynthEngine, type RecordedAudio } from '../audio/engine'
import type { PerformanceNote } from '../history/types'

/** The signature `WebMcpToolDependencies.renderOffline` is injected against. */
export type OfflineRenderer = (
  engine: SynthEngine,
  notes: readonly PerformanceNote[],
  duration: number
) => Promise<RecordedAudio>

export interface OfflineRenderOptions {
  /** Overrides the sample rate taken from the live engine's context. */
  sampleRate?: number
  /** Seam for tests: build the render context. */
  createContext?: (options: { numberOfChannels: number; length: number; sampleRate: number }) => BaseAudioContext
  /** Seam for tests: build the scratch engine over that context. */
  createEngine?: (context: BaseAudioContext) => SynthEngine
}

/** Web Audio renders in 128-frame quanta; `suspend()` only accepts boundaries. */
const RENDER_QUANTUM = 128
const DEFAULT_SAMPLE_RATE = 48000

/** Mono WAV handed to audio-capable agents: small enough to put in a message. */
export const BASE64_SAMPLE_RATE = 22050
export const BASE64_MAX_SECONDS = 8

/**
 * True when this browser can render offline at all. jsdom and older embedded
 * browsers have neither constructor; without them `render_audio` must say so
 * and fall back to the real-time capture path.
 */
export function offlineRenderAvailable(): boolean {
  if (typeof OfflineAudioContext !== 'function') return false
  if (typeof AudioWorkletNode !== 'function') return false
  const proto: unknown = typeof BaseAudioContext === 'function'
    ? BaseAudioContext.prototype
    : OfflineAudioContext.prototype
  return typeof proto === 'object' && proto !== null && 'audioWorklet' in (proto as object)
}

interface NoteEvent {
  frame: number
  on: boolean
  midi: number
  velocity: number
}

/** Note-ons and note-offs on the render timeline, offs first within a quantum. */
function noteEvents(notes: readonly PerformanceNote[], duration: number, sampleRate: number): NoteEvent[] {
  const lastFrame = Math.max(0, Math.ceil(duration * sampleRate) - 1)
  const quantize = (seconds: number) => {
    const frame = Math.min(lastFrame, Math.max(0, Math.round(seconds * sampleRate)))
    return Math.floor(frame / RENDER_QUANTUM) * RENDER_QUANTUM
  }
  const events: NoteEvent[] = []
  for (const note of notes) {
    events.push({ frame: quantize(note.start), on: true, midi: note.midi, velocity: note.velocity })
    events.push({ frame: quantize(note.start + note.duration), on: false, midi: note.midi, velocity: note.velocity })
  }
  return events.sort((a, b) => a.frame - b.frame || Number(a.on) - Number(b.on))
}

function applyEvent(engine: SynthEngine, event: NoteEvent): void {
  if (event.on) engine.noteOn(event.midi, event.velocity)
  else engine.noteOff(event.midi)
}

/**
 * Render `notes` through a throwaway copy of `engine`'s patch and return the
 * result as lossless PCM plus a WAV blob.
 */
export async function renderOffline(
  engine: SynthEngine,
  notes: readonly PerformanceNote[],
  duration: number,
  options: OfflineRenderOptions = {}
): Promise<RecordedAudio> {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Offline render duration must be greater than zero')
  const sampleRate = options.sampleRate
    ?? (engine.context ?? engine.ctx)?.sampleRate
    ?? DEFAULT_SAMPLE_RATE
  const length = Math.max(RENDER_QUANTUM, Math.ceil(duration * sampleRate))
  const contextOptions = { numberOfChannels: 2, length, sampleRate }
  const ctx = options.createContext
    ? options.createContext(contextOptions)
    : new OfflineAudioContext(contextOptions)
  const suspendable = ctx as BaseAudioContext & {
    suspend?: (when: number) => Promise<void>
    resume?: () => Promise<void> | void
    startRendering: () => Promise<AudioBuffer>
  }

  // One scratch engine per render: `start()` is idempotent and an
  // OfflineAudioContext is single-use, so this object is discarded afterwards.
  const scratch = options.createEngine ? options.createEngine(ctx) : new SynthEngine({ context: ctx })
  await scratch.start()
  scratch.loadPreset(engine.toPreset('render'))

  const events = noteEvents(notes, duration, sampleRate)
  const immediate = events.filter(event => event.frame === 0)
  const scheduled = events.filter(event => event.frame > 0)
  for (const event of immediate) applyEvent(scratch, event)

  // Register every suspension before rendering starts; one suspension per
  // quantum boundary, because a second suspend at the same frame is rejected.
  const pending: Promise<void>[] = []
  const byFrame = new Map<number, NoteEvent[]>()
  for (const event of scheduled) {
    const bucket = byFrame.get(event.frame)
    if (bucket) bucket.push(event)
    else byFrame.set(event.frame, [event])
  }
  if (typeof suspendable.suspend === 'function') {
    for (const [frame, bucket] of [...byFrame.entries()].sort((a, b) => a[0] - b[0])) {
      pending.push(suspendable.suspend(frame / sampleRate).then(() => {
        for (const event of bucket) applyEvent(scratch, event)
        // Deliberately not awaited: resuming is what lets rendering continue.
        void suspendable.resume?.()
      }))
    }
  } else {
    // A context without `suspend` cannot place events in time; apply them all up
    // front rather than dropping the notes entirely.
    for (const event of scheduled) applyEvent(scratch, event)
  }

  const buffer = await suspendable.startRendering()
  await Promise.allSettled(pending)

  const channelData: Float32Array[] = []
  const channels = Math.max(1, buffer.numberOfChannels ?? 1)
  for (let channel = 0; channel < channels; channel++) {
    channelData.push(Float32Array.from(buffer.getChannelData(channel)))
  }
  const renderedRate = buffer.sampleRate ?? sampleRate
  const wav = encodeWav(channelData, renderedRate)
  return {
    blob: new Blob([wav], { type: 'audio/wav' }),
    mimeType: 'audio/wav',
    duration: (buffer.length ?? channelData[0]?.length ?? 0) / renderedRate,
    sampleRate: renderedRate,
    channelData
  }
}

function clampSample(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < -1 ? -1 : value > 1 ? 1 : value
}

/** Interleaved 16-bit PCM WAV — the one container every decoder reads. */
export function encodeWav(channels: readonly Float32Array[], sampleRate: number): ArrayBuffer {
  const channelCount = Math.max(1, channels.length)
  const frames = channels[0]?.length ?? 0
  const bytesPerSample = 2
  const blockAlign = channelCount * bytesPerSample
  const dataBytes = frames * blockAlign
  const out = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(out)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, Math.round(sampleRate), true)
  view.setUint32(28, Math.round(sampleRate) * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 8 * bytesPerSample, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  let offset = 44
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      const sample = clampSample(channels[channel]?.[frame] ?? 0)
      view.setInt16(offset, Math.round(sample * 32767), true)
      offset += 2
    }
  }
  return out
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  if (typeof btoa !== 'function') throw new Error('Base64 encoding is unavailable in this environment')
  return btoa(binary)
}

export interface MonoWavBase64 {
  base64: string
  mimeType: 'audio/wav'
  sampleRate: number
  channels: 1
  duration: number
  bytes: number
  /** True when the source was longer than `BASE64_MAX_SECONDS`. */
  truncated: boolean
}

/**
 * Mono 16-bit WAV at 22.05 kHz, capped at 8 seconds — small enough to hand to
 * an audio-capable agent inside a tool result.
 */
export function monoWavBase64(
  channels: readonly Float32Array[],
  sampleRate: number,
  maxSeconds = BASE64_MAX_SECONDS,
  targetSampleRate = BASE64_SAMPLE_RATE
): MonoWavBase64 {
  const sourceFrames = channels[0]?.length ?? 0
  const rate = sampleRate > 0 ? sampleRate : DEFAULT_SAMPLE_RATE
  const keptFrames = Math.min(sourceFrames, Math.ceil(maxSeconds * rate))
  const ratio = targetSampleRate / rate
  const outFrames = Math.max(0, Math.floor(keptFrames * ratio))
  const mono = new Float32Array(outFrames)
  const channelCount = Math.max(1, channels.length)
  for (let index = 0; index < outFrames; index++) {
    const position = index / ratio
    const left = Math.min(keptFrames - 1, Math.floor(position))
    const right = Math.min(keptFrames - 1, left + 1)
    const fraction = position - left
    let sum = 0
    for (const channel of channels) {
      const a = channel[left] ?? 0
      sum += a + ((channel[right] ?? a) - a) * fraction
    }
    mono[index] = clampSample(sum / channelCount)
  }
  const wav = encodeWav([mono], targetSampleRate)
  return {
    base64: toBase64(new Uint8Array(wav)),
    mimeType: 'audio/wav',
    sampleRate: targetSampleRate,
    channels: 1,
    duration: outFrames / targetSampleRate,
    bytes: wav.byteLength,
    truncated: keptFrames < sourceFrames
  }
}
