import { afterEach, describe, expect, it, vi } from 'vitest'
import { PerformanceManager, performNotes, validatePerformanceNotes } from './performance'

afterEach(() => vi.useRealTimers())
const notes = [{ midi: 60, velocity: 0.8, start: 0, duration: 1 }]

describe('PerformanceManager', () => {
  it('reports playback separately from the longer render/analysis operation', async () => {
    const manager = new PerformanceManager()
    const states: boolean[] = []
    manager.subscribe(() => states.push(manager.playing))
    let finishNotes!: () => void
    let finishAnalysis!: () => void
    const notesDone = new Promise<void>(resolve => { finishNotes = resolve })
    const analysisDone = new Promise<void>(resolve => { finishAnalysis = resolve })
    const operation = manager.run(async () => {
      await manager.trackPlayback(() => notesDone)
      await analysisDone
    })
    await Promise.resolve()
    expect(manager.playing).toBe(true)
    finishNotes()
    await notesDone
    await Promise.resolve()
    expect(manager.playing).toBe(false)
    expect(manager.aiPlaying).toBe(false)
    expect(manager.active).toBe(true)
    finishAnalysis()
    await operation
    expect(states).toEqual([false, true, false, false])
    await expect(manager.trackPlayback(async () => { throw new Error('Stopped') })).rejects.toThrow('Stopped')
    expect(manager.playing).toBe(false)
  })

  it('tracks AI playback separately from manual playback', async () => {
    const manager = new PerformanceManager()
    let finishAi!: () => void
    let finishHuman!: () => void
    const ai = new Promise<void>(resolve => { finishAi = resolve })
    const human = new Promise<void>(resolve => { finishHuman = resolve })
    const aiTask = manager.trackPlayback(() => ai, 'ai')
    const humanTask = manager.trackPlayback(() => human)
    expect(manager.playing).toBe(true)
    expect(manager.aiPlaying).toBe(true)
    finishAi()
    await aiTask
    expect(manager.playing).toBe(true)
    expect(manager.aiPlaying).toBe(false)
    finishHuman()
    await humanTask
    expect(manager.playing).toBe(false)
    expect(manager.aiPlaying).toBe(false)
  })

  it('shares one lock and waits for cancellation cleanup before releasing it', async () => {
    const manager = new PerformanceManager()
    const state = vi.fn()
    const unsubscribe = manager.subscribe(state)
    let finishCleanup!: () => void
    const cleanup = new Promise<void>(resolve => { finishCleanup = resolve })
    const task = manager.run(async signal => {
      try {
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled'))))
      } finally { await cleanup }
    })
    const rejected = expect(task).rejects.toThrow('cancelled')
    await Promise.resolve()
    expect(manager.active).toBe(true)
    await expect(manager.run(async () => {})).rejects.toThrow(/progress/)
    let stopped = false
    const stopping = manager.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(manager.active).toBe(true)
    expect(stopped).toBe(false)
    finishCleanup()
    await stopping
    await rejected
    expect(manager.active).toBe(false)
    expect(state).toHaveBeenCalledTimes(2)
    unsubscribe()
    await manager.run(async () => {})
    expect(state).toHaveBeenCalledTimes(2)
  })

  it('rejects pre-aborted runs and forwards cancellation', async () => {
    const manager = new PerformanceManager()
    const controller = new AbortController()
    controller.abort()
    const task = vi.fn(async () => {})
    await expect(manager.run(task, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(task).not.toHaveBeenCalled()
    expect(manager.active).toBe(false)
    const next = new AbortController()
    const operation = manager.run(async signal => {
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('forwarded'))))
    }, next.signal)
    await Promise.resolve()
    next.abort()
    await expect(operation).rejects.toThrow('forwarded')
    expect(manager.active).toBe(false)
  })

  it('releases only owned notes and preserves scheduling', async () => {
    vi.useFakeTimers()
    const engine = { heldNotes: new Set<number>(), noteOn: vi.fn(), noteOff: vi.fn() }
    const manager = new PerformanceManager()
    const operation = manager.run(signal => performNotes(engine, notes, signal))
    const result = expect(operation).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(10)
    expect(engine.noteOn).toHaveBeenCalledWith(60, 0.8, expect.any(Symbol))
    await manager.stop()
    await result
    expect(engine.noteOff).toHaveBeenCalledWith(60, engine.noteOn.mock.calls[0][2])
    expect(manager.active).toBe(false)
    engine.heldNotes.add(60)
    await expect(performNotes(engine, notes, new AbortController().signal)).rejects.toThrow(/already held/)
  })

  it('validates bounded sequences and permits contiguous notes', () => {
    expect(validatePerformanceNotes([...notes, { ...notes[0], start: 1 }]).duration).toBe(2)
    expect(() => validatePerformanceNotes([...notes, { ...notes[0], start: 0.5 }])).toThrow(/overlap/)
    expect(() => validatePerformanceNotes([{ ...notes[0], velocity: NaN }])).toThrow(/finite/)
    expect(() => validatePerformanceNotes([{ ...notes[0], duration: 31 }])).toThrow(/30 seconds/)
    expect(() => validatePerformanceNotes([{ ...notes[0], extra: true }])).toThrow(/Unexpected/)
  })
})
