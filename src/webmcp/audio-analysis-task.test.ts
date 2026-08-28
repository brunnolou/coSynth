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

