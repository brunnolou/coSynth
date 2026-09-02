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

  it('forwards analysis options to the inline fallback so single-note renders get harmonics', async () => {
    vi.stubGlobal('Worker', undefined)
    const sampleRate = 48000
    const tone = Float32Array.from({ length: sampleRate }, (_, i) => {
      let value = 0
      for (let n = 1; n <= 8; n++) value += Math.sin(2 * Math.PI * 440 * n * i / sampleRate) / n
      return 0.4 * value
    })
    const withF0 = await analyzeAudioAbortably([tone], sampleRate, undefined, { f0Hz: 440 })
    expect(withF0.harmonics?.amplitudesDb).toHaveLength(12)
    expect((await analyzeAudioAbortably([tone], sampleRate)).harmonics).toBeUndefined()
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
})

