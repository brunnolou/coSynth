/**
 * Offline rendering for `render_audio` — Task 10 of
 * docs/plans/2026-09-02-agent-experience.md.
 *
 * A scratch `SynthEngine` is built on a single-use `OfflineAudioContext`, loaded
 * with the live engine's current patch, and driven with sample-accurate note
 * events. Nothing touches the live graph, so a render needs no user gesture and
 * no wall-clock time. The scheduling is exact and repeatable; the samples are
 * only repeatable up to the patch's own noise and random sources (noise
 * oscillators, oscillator start-phase randomisation, the `random` mod source),
 * which draw from `Math.random()` on every render.
 */
import { SynthEngine, type RecordedAudio } from '../audio/engine'
import type { PerformanceNote } from '../history/types'

/** The signature `WebMcpToolDependencies.renderOffline` is injected against. */
export type OfflineRenderer = (
  engine: SynthEngine,
  notes: readonly PerformanceNote[],
  duration: number,
  options?: { signal?: AbortSignal }
) => Promise<RecordedAudio>

export interface OfflineRenderOptions {
  /** Cancels the render: see the note on `startRendering()` in `renderOffline`. */
  signal?: AbortSignal
  /** Overrides the sample rate taken from the live engine's context. */
  sampleRate?: number
  /** Seam for tests: build the render context. */
  createContext?: (options: { numberOfChannels: number; length: number; sampleRate: number }) => BaseAudioContext
  /** Seam for tests: build the scratch engine over that context. */
  createEngine?: (context: BaseAudioContext) => SynthEngine
  /**
   * How long the barrier before `startRendering()` waits for its
   * acknowledgement before giving up on the guarantee and rendering anyway.
   * See `SYNC_TIMEOUT_MS`.
   */
  syncTimeoutMs?: number
  /**
   * The same, for each mid-render barrier. Defaults to the smaller of
   * `syncTimeoutMs` and `MID_RENDER_SYNC_TIMEOUT_MS`.
   */
  midRenderSyncTimeoutMs?: number
}

/** Web Audio renders in 128-frame quanta; `suspend()` only accepts boundaries. */
const RENDER_QUANTUM = 128
const DEFAULT_SAMPLE_RATE = 48000
/**
 * How long the barrier in front of `startRendering()` waits for the worklet to
 * acknowledge its messages. Long enough for a wavetable-and-sample `syncAll()`
 * on a loaded machine, short enough that a browser whose offline worklet never
 * answers costs a render rather than a session. This is the barrier that must
 * not be skipped: it is what stops a render from outrunning its own frame-0
 * note events and coming back as silence, so it is allowed to wait.
 */
const SYNC_TIMEOUT_MS = 2000
/**
 * How long a MID-RENDER barrier waits, which is a different bargain. A
 * suspension's barrier carries only the handful of note messages for that one
 * quantum — the patch, wavetables and noise sample all went through the
 * pre-render barrier — and it buys placement, not existence: give up and the
 * event lands a few quanta late rather than not at all.
 *
 * That matters because the whole mechanism rests on the port queue draining
 * while an `OfflineAudioContext` is suspended. Chromium does drain it (measured
 * through the probe harness: render wall clock stays ~200 ms whether a render
 * has one mid-render suspension or fifteen), but nothing in the spec promises
 * it. On an engine that does not, every suspension would wait out its full
 * budget, and at `SYNC_TIMEOUT_MS` each a fifteen-event render would take half
 * a minute — correct, and useless. At 50 ms the same render pays 0.75 s.
 *
 * 50 ms is also far above the acknowledgement latency actually observed: fifteen
 * barriers plus the rendering itself fit inside ~200 ms, so the round trip costs
 * single-digit milliseconds and this leaves an order of magnitude of headroom
 * for a jankier main thread.
 */
const MID_RENDER_SYNC_TIMEOUT_MS = 50

/** Mono WAV handed to audio-capable agents: small enough to put in a message. */
export const BASE64_SAMPLE_RATE = 22050
export const BASE64_MAX_SECONDS = 8

/**
 * True when this browser can render offline at all. jsdom and older embedded
 * browsers have neither constructor; without them `render_audio` must say so
 * and fall back to the real-time capture path.
 *
 * `suspend()` counts too: Safari has shipped an `OfflineAudioContext` without
 * it, and with no way to place events in time a render can only be silence.
 * Reporting unavailable sends the caller to the real-time path instead.
 */
export function offlineRenderAvailable(): boolean {
  if (typeof OfflineAudioContext !== 'function') return false
  if (typeof AudioWorkletNode !== 'function') return false
  const offlineProto: unknown = OfflineAudioContext.prototype
  if (typeof offlineProto !== 'object' || offlineProto === null) return false
  if (!('suspend' in (offlineProto as object))) return false
  const proto: unknown = typeof BaseAudioContext === 'function'
    ? BaseAudioContext.prototype
    : offlineProto
  return typeof proto === 'object' && proto !== null && 'audioWorklet' in (proto as object)
}

interface NoteEvent {
  frame: number
  on: boolean
  midi: number
  velocity: number
  /** Ordering within a quantum: releases, then strikes, then same-quantum releases. */
  rank: number
}

const RANK_OFF = 0
const RANK_ON = 1
/** A note whose end quantizes onto its own start still has to sound first. */
const RANK_OFF_SAME_QUANTUM = 2

/**
 * Note-ons and note-offs on the render timeline. Within a quantum a release
 * comes before a strike, so a note handing over to the next one frees its voice
 * first — except for a note shorter than one quantum, whose own release must
 * follow its own strike or the strike would leave the voice held for the whole
 * render.
 */
function noteEvents(notes: readonly PerformanceNote[], duration: number, sampleRate: number): NoteEvent[] {
  const lastFrame = Math.max(0, Math.ceil(duration * sampleRate) - 1)
  const quantize = (seconds: number) => {
    const frame = Math.min(lastFrame, Math.max(0, Math.round(seconds * sampleRate)))
    return Math.floor(frame / RENDER_QUANTUM) * RENDER_QUANTUM
  }
  const events: NoteEvent[] = []
  for (const note of notes) {
    const on = quantize(note.start)
    const off = quantize(note.start + note.duration)
    events.push({ frame: on, on: true, midi: note.midi, velocity: note.velocity, rank: RANK_ON })
    events.push({
      frame: off,
      on: false,
      midi: note.midi,
      velocity: note.velocity,
      rank: off <= on ? RANK_OFF_SAME_QUANTUM : RANK_OFF
    })
  }
  return events.sort((a, b) => a.frame - b.frame || a.rank - b.rank)
}

/**
 * Applies events to the scratch engine with the same per-pitch counting
 * `performNotes` (src/history/performance.ts) uses, so a render hears exactly
 * what `play_notes` plays: a repeated pitch releases and restrikes, and only
 * the last instance's end releases the note. `SynthEngine.noteOn` is a no-op
 * for a pitch already held, so without this the restrike is swallowed and the
 * first note-off cuts the sound short.
 */
class OfflineNotes {
  private readonly owner = Symbol('offline-render')
  /** Active instances per pitch. */
  private readonly active = new Map<number, number>()

  constructor(private readonly engine: SynthEngine) {}

  apply(event: NoteEvent): void {
    const count = this.active.get(event.midi) ?? 0
    if (event.on) {
      if (count > 0) this.engine.noteOff(event.midi, this.owner)
      this.engine.noteOn(event.midi, event.velocity, this.owner)
      this.active.set(event.midi, count + 1)
    } else if (count === 1) {
      this.active.delete(event.midi)
      this.engine.noteOff(event.midi, this.owner)
    } else if (count > 1) {
      this.active.set(event.midi, count - 1)
    }
  }
}

/** The repo's cancellation idiom: `register.ts` classifies this as a cancel. */
function abortError(): Error {
  const error = new Error('Execution aborted')
  error.name = 'AbortError'
  return error
}

/**
 * A promise that never resolves and rejects with `AbortError` when `signal`
 * aborts. `dispose()` unsubscribes; the pre-attached `catch` keeps a rejection
 * nobody raced from surfacing as an unhandled one.
 *
 * An `abort` event that has already fired is never delivered again, so an
 * already-aborted signal must reject on the spot: attaching a listener to it
 * would produce a promise that can only hang, and a `Promise.race` against it
 * would silently wait out the very work the caller cancelled.
 */
function abortRejection(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  if (signal.aborted) {
    const promise = Promise.reject(abortError())
    promise.catch(() => {})
    return { promise, dispose: () => {} }
  }
  let dispose = () => {}
  const promise = new Promise<never>((_, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    dispose = () => signal.removeEventListener('abort', onAbort)
  })
  promise.catch(() => {})
  return { promise, dispose }
}

/**
 * `SynthEngine.awaitWorkletSync`, made cancellable.
 *
 * The wait itself cannot see the signal — it is a message round trip with a
 * timeout — so without this a `stop_performance` arriving while a barrier is
 * open sits behind the acknowledgement, or behind the whole timeout, before the
 * render's own abort checks can fire. Rejecting with the repo's `AbortError`
 * keeps `registeredTool` classifying it as a cancellation.
 *
 * The abandoned `awaitWorkletSync` promise is left to settle on its own: it
 * clears its own timer and closes its own port, and nothing reads its answer.
 */
async function awaitSync(
  engine: SynthEngine,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<boolean> {
  const wait = engine.awaitWorkletSync(timeoutMs)
  if (!signal) return await wait
  const abort = abortRejection(signal)
  try {
    return await Promise.race([wait, abort.promise])
  } finally {
    abort.dispose()
  }
}

/**
 * Render `notes` through a throwaway copy of `engine`'s patch and return the
 * result as lossless PCM plus a WAV blob.
 *
 * The patch and the note events reach the render worklet as port messages,
 * which `startRendering()` does not wait for, so each attempt puts a
 * `SynthEngine.awaitWorkletSync` barrier in front of rendering and in front of
 * every mid-render `resume()`.
 *
 * The barrier is allowed to give up rather than hang, so it is backed by a
 * guard: an attempt that was asked for notes, returned digital silence, and
 * could not confirm the worklet had its events is retried once on a fresh
 * context, and a second such attempt throws. Silence is the one result an agent
 * cannot audit — every metric collapses to -160 dB and reads as a real
 * measurement of a dead patch — so it is the one result that must never be
 * returned unverified. Silence the barrier *did* confirm is returned normally:
 * a patch with its volume at zero renders nothing, and saying so is correct.
 */
export async function renderOffline(
  engine: SynthEngine,
  notes: readonly PerformanceNote[],
  duration: number,
  options: OfflineRenderOptions = {}
): Promise<RecordedAudio> {
  const signal = options.signal
  if (signal?.aborted) throw abortError()
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Offline render duration must be greater than zero')
  const first = await renderOnce(engine, notes, duration, options)
  // A render is only suspect when it was asked to make a sound and made none.
  if (!first.suspect) return first.recording
  // One retry, on a wholly fresh context and scratch engine. A stuck barrier is
  // a per-render accident, and silence that survives an independent second
  // render is the patch's own: see `renderOffline`'s doc comment.
  if (signal?.aborted) throw abortError()
  const second = await renderOnce(engine, notes, duration, options)
  if (!second.suspect) return second.recording
  throw new Error(
    'Offline render produced digital silence twice and could not be confirmed: the audio worklet never acknowledged the '
    + 'patch and note events before rendering, so this result would be a measurement of nothing rather than of the patch. '
    + 'Retry, or use mode: "realtime" once audio is running.'
  )
}

/** What one render attempt produced, and whether it can be trusted. */
interface Attempt {
  recording: RecordedAudio
  /**
   * The render asked for notes, returned digital silence, AND could not confirm
   * the worklet had its events — silence that may be the race rather than the
   * patch. A confirmed silent render is not suspect: a patch with the volume at
   * zero is entitled to render nothing, and reporting that honestly is the
   * point.
   */
  suspect: boolean
}

async function renderOnce(
  engine: SynthEngine,
  notes: readonly PerformanceNote[],
  duration: number,
  options: OfflineRenderOptions
): Promise<Attempt> {
  const signal = options.signal
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

  // One scratch engine per render: an OfflineAudioContext is single-use, so it
  // cannot be reused and this object is disposed afterwards. What survives
  // between renders is the worklet module source, cached in memory by
  // `src/shared/cached-script-url.ts` — the expensive part, and the only part
  // that is safe to share, since a cached script carries no per-render state.
  const scratch = options.createEngine ? options.createEngine(ctx) : new SynthEngine({ context: ctx })
  // The scratch engine is disposed however this ends, including the abort
  // path: an abandoned render is exactly the case where the graph would
  // otherwise be left attached with nobody to drop it. See
  // `SynthEngine.dispose` for what this can and cannot release.
  try {
    // `start()` awaits `audioWorklet.addModule()`, which is the one slow step
    // before rendering. A cancel arriving inside that await must stop here, ahead
    // of any suspension being scheduled or any note event being applied, rather
    // than being left to the race further down.
    await scratch.start()
    if (signal?.aborted) throw abortError()
    // A snapshot, not a preset: a preset carries only parameters, modulation, LFO
    // shapes and FX order, so a round-trip through one silently swaps an imported
    // Custom wavetable for a built-in and drops the imported noise sample
    // entirely — the render would then measure a different sound than the one the
    // human hears. `captureSoundState()` includes both PCM assets and
    // `restoreSoundState()` re-posts them via `syncAll()`. Its other side effects
    // (`notifyPatch`, `allNotesOff`, param/matrix/FX-order listeners, the
    // enclosing `batchSoundChange` notification) are no-ops on a scratch engine:
    // it holds no notes and has no listeners registered.
    scratch.restoreSoundState(engine.captureSoundState())

    // A context without `suspend` cannot place an event in time at all: every
    // note would be struck and released before rendering starts, returning
    // silence that looks like a successful render. `offlineRenderAvailable()`
    // screens for this; refusing here keeps a caller that skipped it honest.
    if (typeof suspendable.suspend !== 'function') {
      throw new Error('Offline rendering is unavailable here: this OfflineAudioContext has no suspend()')
    }

    const syncTimeout = options.syncTimeoutMs ?? SYNC_TIMEOUT_MS
    // Never longer than the pre-render budget: a caller that asked for a short
    // barrier means it everywhere, and a test that shortens one wants both.
    const midRenderSyncTimeout = options.midRenderSyncTimeoutMs
      ?? Math.min(syncTimeout, MID_RENDER_SYNC_TIMEOUT_MS)
    // Set false by any barrier that went unacknowledged; see the silence guard at
    // the end of this function.
    let synced = true
    const player = new OfflineNotes(scratch)
    const events = noteEvents(notes, duration, sampleRate)
    const immediate = events.filter(event => event.frame === 0)
    const scheduled = events.filter(event => event.frame > 0)
    for (const event of immediate) player.apply(event)

    // Register every suspension before rendering starts; one suspension per
    // quantum boundary, because a second suspend at the same frame is rejected.
    const pending: Promise<void>[] = []
    const byFrame = new Map<number, NoteEvent[]>()
    for (const event of scheduled) {
      const bucket = byFrame.get(event.frame)
      if (bucket) bucket.push(event)
      else byFrame.set(event.frame, [event])
    }
    for (const [frame, bucket] of [...byFrame.entries()].sort((a, b) => a[0] - b[0])) {
      pending.push(suspendable.suspend(frame / sampleRate).then(async () => {
        try {
          // Once cancelled, stop scheduling: no further note events are applied,
          // so an abandoned render cannot keep mutating the scratch engine.
          if (!signal?.aborted) {
            for (const event of bucket) player.apply(event)
            // Held suspended until the processor confirms it has these events, for
            // the same reason as the barrier before `startRendering()`: resuming
            // first would let the render outrun them and place the event late by
            // however many quanta the queue took to drain. On its own budget,
            // because this barrier only improves placement: see
            // `MID_RENDER_SYNC_TIMEOUT_MS`.
            //
            // An abort here resolves the wait instead of rejecting it: this
            // callback belongs to a render nobody is waiting for any more, and
            // the one thing it still owes that render is the `resume()` below.
            const acknowledged = await awaitSync(scratch, midRenderSyncTimeout, signal).catch(() => false)
            if (!acknowledged) synced = false
          }
        } finally {
          // Deliberately not awaited: resuming is what lets rendering continue.
          // Still resumed after an abort, so the orphaned render below can finish
          // and be collected instead of sitting suspended forever.
          void suspendable.resume?.()
        }
      }))
    }

    // The barrier that closes the race this whole render turns on: everything
    // above — the patch, the modulation, the wavetables, the frame-0 note-ons —
    // reached the processor as port messages, and `startRendering()` does not
    // wait for them. See `SynthEngine.awaitWorkletSync`.
    // Cancellable: a `stop_performance` arriving while this barrier is open must
    // not have to wait out the acknowledgement, or the whole timeout, first.
    if (!await awaitSync(scratch, syncTimeout, signal)) synced = false
    if (signal?.aborted) throw abortError()

    // The Web Audio API offers no way to cancel an in-flight `startRendering()`.
    // Racing it against the signal is therefore about the CALLER, not the CPU:
    // `stop_performance` and a cancelled invocation return promptly instead of
    // waiting out the render, while the orphaned render still runs to completion
    // on its own and is then collected, with nothing consuming its buffer.
    const abort = signal ? abortRejection(signal) : null
    let buffer: AudioBuffer
    try {
      buffer = abort
        ? await Promise.race([suspendable.startRendering(), abort.promise])
        : await suspendable.startRendering()
    } finally {
      abort?.dispose()
    }
    await Promise.allSettled(pending)

    const channelData: Float32Array[] = []
    const channels = Math.max(1, buffer.numberOfChannels ?? 1)
    for (let channel = 0; channel < channels; channel++) {
      channelData.push(Float32Array.from(buffer.getChannelData(channel)))
    }
    const renderedRate = buffer.sampleRate ?? sampleRate
    const wav = encodeWav(channelData, renderedRate)
    return {
      recording: {
        blob: new Blob([wav], { type: 'audio/wav' }),
        mimeType: 'audio/wav',
        duration: (buffer.length ?? channelData[0]?.length ?? 0) / renderedRate,
        sampleRate: renderedRate,
        channelData
      },
      suspect: !synced && events.length > 0 && isSilent(channelData)
    }
  } finally {
    scratch.dispose()
  }
}

/**
 * Digital silence: every sample exactly zero. Deliberately not a dB threshold.
 * A very quiet patch is a legitimate result an agent may be hunting for, and a
 * floor low enough to be safe would be indistinguishable from zero anyway,
 * while a floor high enough to be useful would reject real renders. The failure
 * this guards is categorical — the note never reached the processor, so the
 * output buffer was never written to at all.
 */
function isSilent(channels: readonly Float32Array[]): boolean {
  for (const channel of channels) {
    for (const sample of channel) if (sample !== 0) return false
  }
  return true
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
  /**
   * How the preview became mono: `sum` is the plain channel average, `left` /
   * `right` means that average cancelled and the louder channel was sent alone.
   */
  downmix: 'sum' | 'left' | 'right'
}

/**
 * How much level the mono sum may lose to phase cancellation before the preview
 * switches to a single channel: the sum's RMS must stay above half (-6 dB) of
 * the level-preserving power downmix `sqrt(mean over channels of x²)` that
 * `analyzeAudio` measures.
 *
 * Two fully decorrelated channels of equal power already lose 3 dB in any mono
 * sum — that is ordinary wide stereo and must keep the plain sum — so the
 * threshold sits a further 3 dB down, where the loss can only come from
 * correlated-but-opposed content. Hard anti-phase loses everything.
 */
const DOWNMIX_CANCELLATION_RATIO = 0.5

/** RMS of `[0, frames)` of one channel. */
function channelRms(channel: Float32Array | undefined, frames: number): number {
  if (!channel || frames <= 0) return 0
  let squares = 0
  for (let frame = 0; frame < frames; frame++) {
    const sample = channel[frame] ?? 0
    squares += sample * sample
  }
  return Math.sqrt(squares / frames)
}

/** RMS of the plain channel average — the signal the preview would carry. */
function sumRms(channels: readonly Float32Array[], frames: number): number {
  if (frames <= 0) return 0
  const channelCount = Math.max(1, channels.length)
  let squares = 0
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0
    for (const channel of channels) sum += channel[frame] ?? 0
    const mean = sum / channelCount
    squares += mean * mean
  }
  return Math.sqrt(squares / frames)
}

/**
 * Pick what the mono preview is made of.
 *
 * A true mono downmix of anti-phase content *is* silent, and that is correct
 * for mono playback — but the preview exists so an audio-capable agent can hear
 * what it just made, next to metrics that use the analyzer's power downmix and
 * therefore report the content as loud. Handing over silence while the same
 * response says `loudnessDb: -12` is the tools lying. So when the sum cancels,
 * send the louder single channel instead and say which one.
 */
function selectDownmix(
  channels: readonly Float32Array[],
  frames: number
): { sources: readonly Float32Array[]; downmix: MonoWavBase64['downmix'] } {
  const plain = { sources: channels, downmix: 'sum' as const }
  if (channels.length < 2) return plain
  let power = 0
  for (const channel of channels) {
    const rms = channelRms(channel, frames)
    power += rms * rms
  }
  const reference = Math.sqrt(power / channels.length)
  // Silence cancels into silence: nothing to rescue, and no ratio to take.
  if (reference <= 0) return plain
  if (sumRms(channels, frames) >= DOWNMIX_CANCELLATION_RATIO * reference) return plain
  let loudest = 0
  let loudestRms = -1
  channels.forEach((channel, index) => {
    const rms = channelRms(channel, frames)
    if (rms > loudestRms) {
      loudestRms = rms
      loudest = index
    }
  })
  // Beyond stereo there is no better name for a channel than the side it is on.
  return { sources: [channels[loudest]], downmix: loudest === 0 ? 'left' : 'right' }
}

/**
 * Mono 16-bit WAV at 22.05 kHz, capped at 8 seconds — small enough to hand to
 * an audio-capable agent inside a tool result.
 *
 * Downsampling averages every source frame that falls inside an output frame
 * rather than point-sampling it. That box filter is crude — its stopband is
 * only about -13 dB — but it stops content above the preview's 11 kHz Nyquist
 * from folding back as a loud phantom tone in the middle of the band, which is
 * what an agent would otherwise hear and try to design away.
 *
 * `downmix` reports whether the channels were averaged or one of them was sent
 * alone because the average cancelled: see `selectDownmix`.
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
  const { sources, downmix } = selectDownmix(channels, keptFrames)
  const channelCount = Math.max(1, sources.length)
  for (let index = 0; index < outFrames; index++) {
    const from = Math.min(keptFrames - 1, Math.floor(index / ratio))
    const to = Math.min(keptFrames, Math.max(from + 1, Math.floor((index + 1) / ratio)))
    let sum = 0
    for (let frame = from; frame < to; frame++) {
      for (const channel of sources) sum += channel[frame] ?? 0
    }
    mono[index] = clampSample(sum / (channelCount * (to - from)))
  }
  const wav = encodeWav([mono], targetSampleRate)
  return {
    base64: toBase64(new Uint8Array(wav)),
    mimeType: 'audio/wav',
    sampleRate: targetSampleRate,
    channels: 1,
    duration: outFrames / targetSampleRate,
    bytes: wav.byteLength,
    truncated: keptFrames < sourceFrames,
    downmix
  }
}
