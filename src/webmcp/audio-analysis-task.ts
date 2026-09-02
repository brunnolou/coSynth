import { analyzeAudio, type AnalyzeAudioOptions, type AudioMetrics } from '../shared/audio-analysis'
import { cachedScriptUrlNow, forgetCachedScript } from '../shared/cached-script-url'
// `?worker&url` — the same idiom the DSP worklet uses (see `src/audio/engine.ts`).
// It is what makes Vite treat this file as a worker entry and emit a bundled
// asset for it. Computing the URL with `new URL('./…worker.ts', import.meta.url)`
// outside a `new Worker(...)` call does not: Vite stops emitting the worker
// entirely and the URL resolves to the SPA's HTML fallback at runtime, so every
// analysis silently fell back to the render thread. The bundled URL also keeps
// the script self-contained, which is what lets `cachedScriptUrl` serve it from
// a `blob:` URL that has no base URL to resolve imports against.
import workerUrl from './audio-analysis.worker.ts?worker&url'

function abortError(): Error {
  const error = new Error('Execution aborted')
  error.name = 'AbortError'
  return error
}

/** Analysis on this thread — what a browser without `Worker` already gets. */
function analyzeHere(
  channels: Float32Array[],
  sampleRate: number,
  signal: AbortSignal | undefined,
  options: AnalyzeAudioOptions
): Promise<AudioMetrics> {
  return Promise.resolve().then(() => {
    if (signal?.aborted) throw abortError()
    const metrics = analyzeAudio(channels, sampleRate, options)
    if (signal?.aborted) throw abortError()
    return metrics
  })
}

/**
 * Run expensive analysis away from rendering and audio controls, with prompt
 * cancellation.
 *
 * The worker script is loaded from an in-memory copy after the first time (see
 * `cachedScriptUrl`): a worker is spawned per analysis and therefore per
 * `render_audio` call, so without that every render depended on the page's
 * asset server still answering.
 *
 * A worker that cannot *start* falls back to analysing on this thread — the
 * same path a browser without `Worker` takes — because losing the off-thread
 * analysis is a performance regression, while failing the call loses the render
 * the caller already paid for. Only worker-level `error` events are treated
 * this way; an analysis that ran and reported a problem still rejects, since
 * repeating it here would only reproduce the same problem.
 */
export function analyzeAudioAbortably(
  channels: Float32Array[],
  sampleRate: number,
  signal?: AbortSignal,
  options: AnalyzeAudioOptions = {}
): Promise<AudioMetrics> {
  if (signal?.aborted) return Promise.reject(abortError())

  if (typeof Worker === 'undefined') return analyzeHere(channels, sampleRate, signal, options)

  // Synchronously, so a cancel arriving in the next turn has a worker to
  // terminate: see `cachedScriptUrlNow`.
  const scriptUrl = cachedScriptUrlNow(workerUrl)
  return runWorker(scriptUrl, channels, sampleRate, signal, options).catch(error => {
    if ((error as Error | undefined)?.name === 'AbortError') throw error
    if (!(error instanceof WorkerStartupError)) throw error
    // The cached copy is what failed to start; stop handing it out.
    if (scriptUrl !== workerUrl) forgetCachedScript(workerUrl)
    return analyzeHere(channels, sampleRate, signal, options)
  })
}

/** A worker that never ran: a load or parse failure, not an analysis failure. */
class WorkerStartupError extends Error {}

function runWorker(
  scriptUrl: string,
  channels: Float32Array[],
  sampleRate: number,
  signal: AbortSignal | undefined,
  options: AnalyzeAudioOptions
): Promise<AudioMetrics> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(scriptUrl, { type: 'module' })
    } catch (error) {
      reject(new WorkerStartupError(String((error as Error | undefined)?.message ?? error)))
      return
    }
    let settled = false

    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', aborted)
      worker.terminate()
      callback()
    }
    const aborted = () => finish(() => reject(abortError()))

    signal?.addEventListener('abort', aborted, { once: true })
    worker.addEventListener('message', event => {
      const result = event.data as { ok: true; metrics: AudioMetrics } | { ok: false; message: string }
      finish(() => result.ok ? resolve(result.metrics) : reject(new Error(result.message)))
    }, { once: true })
    // A worker-level error means the script never ran: the caller retries the
    // analysis on this thread rather than losing the render over it.
    worker.addEventListener('error', event => {
      finish(() => reject(new WorkerStartupError(event.message || 'Audio analysis worker failed to start')))
    }, { once: true })

    const buffers = channels.map(channel => channel.slice().buffer)
    worker.postMessage({ channels: buffers, sampleRate, options }, buffers)
  })
}

