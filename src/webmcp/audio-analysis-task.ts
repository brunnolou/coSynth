import { analyzeAudio, type AnalyzeAudioOptions, type AudioMetrics } from '../shared/audio-analysis'

function abortError(): Error {
  const error = new Error('Execution aborted')
  error.name = 'AbortError'
  return error
}

/** Run expensive analysis away from rendering and audio controls, with prompt cancellation. */
export function analyzeAudioAbortably(
  channels: Float32Array[],
  sampleRate: number,
  signal?: AbortSignal,
  options: AnalyzeAudioOptions = {}
): Promise<AudioMetrics> {
  if (signal?.aborted) return Promise.reject(abortError())

  if (typeof Worker === 'undefined') {
    return Promise.resolve().then(() => {
      if (signal?.aborted) throw abortError()
      const metrics = analyzeAudio(channels, sampleRate, options)
      if (signal?.aborted) throw abortError()
      return metrics
    })
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./audio-analysis.worker.ts', import.meta.url), { type: 'module' })
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
    worker.addEventListener('error', event => {
      finish(() => reject(new Error(event.message || 'Audio analysis worker failed')))
    }, { once: true })

    const buffers = channels.map(channel => channel.slice().buffer)
    worker.postMessage({ channels: buffers, sampleRate, options }, buffers)
  })
}

