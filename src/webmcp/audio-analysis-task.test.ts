import { afterEach, describe, expect, it, vi } from 'vitest'
import { analyzeAudioAbortably } from './audio-analysis-task'

afterEach(() => vi.unstubAllGlobals())

describe('analyzeAudioAbortably', () => {
  it('falls back safely when workers are unavailable', async () => {
    vi.stubGlobal('Worker', undefined)
    const channel = Float32Array.from([0, 0.5, -0.5, 0])
    await expect(analyzeAudioAbortably([channel], 8000)).resolves.toMatchObject({
      peakDb: expect.any(Number),
      rmsDb: expect.any(Number)
    })
  })

  /**
   * The options reach the analyzer, and the analyzer's own defaults reach the
   * caller. `f0Hz` is now a way to STATE the fundamental rather than the only
   * way to get a harmonic block at all: detection is on by default, so the
   * difference the options make is `pitch.source` (and `detectPitch: false`,
   * which is how a caller says "this material has no single fundamental").
   */
  it('forwards analysis options to the inline fallback', async () => {
    vi.stubGlobal('Worker', undefined)
    const sampleRate = 48000
    const tone = Float32Array.from({ length: sampleRate }, (_, i) => {
      let value = 0
      for (let n = 1; n <= 8; n++) value += Math.sin(2 * Math.PI * 440 * n * i / sampleRate) / n
      return 0.4 * value
    })
    const withF0 = await analyzeAudioAbortably([tone], sampleRate, undefined, { f0Hz: 440 })
    expect(withF0.harmonics?.amplitudesDb).toHaveLength(12)
    expect(withF0.pitch).toMatchObject({ f0Hz: 440, source: 'given' })

    const detected = await analyzeAudioAbortably([tone], sampleRate)
    expect(detected.pitch?.source).toBe('detected')
    expect(detected.pitch?.f0Hz).toBeCloseTo(440, 0)
    expect(detected.harmonics?.amplitudesDb).toHaveLength(12)

    const unpitched = await analyzeAudioAbortably([tone], sampleRate, undefined, { detectPitch: false })
    expect(unpitched.pitch).toBeNull()
    expect(unpitched.harmonics).toBeUndefined()
  })

  it('includes analysis options in the worker payload', () => {
    const postMessage = vi.fn()
    class FakeWorker {
      addEventListener = vi.fn()
      postMessage = postMessage
      terminate = vi.fn()
    }
    vi.stubGlobal('Worker', FakeWorker)
    void analyzeAudioAbortably([new Float32Array(4)], 8000, undefined, { f0Hz: 220 })
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sampleRate: 8000, options: { f0Hz: 220 } }),
      expect.any(Array)
    )
  })

  it('rejects without doing work when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(analyzeAudioAbortably([new Float32Array(4)], 8000, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('terminates an active worker promptly when cancelled', async () => {
    const terminate = vi.fn()
    class FakeWorker {
      addEventListener = vi.fn()
      postMessage = vi.fn()
      terminate = terminate
    }
    vi.stubGlobal('Worker', FakeWorker)
    const controller = new AbortController()
    const pending = analyzeAudioAbortably([new Float32Array(4)], 8000, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(terminate).toHaveBeenCalledOnce()
  })

  /**
   * A worker is spawned per analysis and therefore per `render_audio` call, and
   * each spawn loads its script. A worker that cannot start must not cost the
   * caller the render it already paid for: the analysis falls back to this
   * thread, which is the same path a browser without `Worker` takes.
   */
  it('analyses on this thread when the worker cannot start', async () => {
    class FailingWorker {
      private handlers = new Map<string, (event: { message: string }) => void>()
      addEventListener = (type: string, handler: (event: { message: string }) => void) => {
        this.handlers.set(type, handler)
      }
      postMessage = () => {
        // A script that will not load reports a worker-level `error`, never a
        // `message`: the worker exists, but nothing inside it ever ran.
        setTimeout(() => this.handlers.get('error')?.({ message: 'Failed to fetch the worker script' }), 0)
      }
      terminate = vi.fn()
    }
    vi.stubGlobal('Worker', FailingWorker)
    const channel = Float32Array.from([0, 0.5, -0.5, 0])
    await expect(analyzeAudioAbortably([channel], 8000)).resolves.toMatchObject({
      peakDb: expect.any(Number),
      rmsDb: expect.any(Number)
    })
  })

  /**
   * The fallback is for a worker that never ran. An analysis that DID run and
   * reported a problem must still reject: repeating it here would only
   * reproduce the same problem, and swallowing it would turn a real failure
   * into a silently different set of numbers.
   */
  it('still rejects when the analysis itself reports a failure', async () => {
    class ReportingWorker {
      private handlers = new Map<string, (event: { data: unknown }) => void>()
      addEventListener = (type: string, handler: (event: { data: unknown }) => void) => {
        this.handlers.set(type, handler)
      }
      postMessage = () => {
        setTimeout(() => this.handlers.get('message')?.({ data: { ok: false, message: 'analysis blew up' } }), 0)
      }
      terminate = vi.fn()
    }
    vi.stubGlobal('Worker', ReportingWorker)
    await expect(analyzeAudioAbortably([new Float32Array(4)], 8000))
      .rejects.toThrow('analysis blew up')
  })
})

