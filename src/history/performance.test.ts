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
    expect(() => validatePerformanceNotes([{ ...notes[0], velocity: NaN }])).toThrow(/finite/)
    expect(() => validatePerformanceNotes([{ ...notes[0], duration: 31 }])).toThrow(/30 seconds/)
  })

  it('names the accepted note shape when a property is unexpected', () => {
    expect(() => validatePerformanceNotes([{ ...notes[0], name: 'E4' }]))
      .toThrow("notes[0]: unexpected property 'name'. Each note is {midi, velocity, start, duration}")
    expect(() => validatePerformanceNotes([{ midi: 60, velocity: 0.8, start: 0 }])).toThrow(/notes\[0\]\.duration is required/)
  })

  it('accepts same-pitch overlap and reports how many were found', () => {
    const contiguous = validatePerformanceNotes([...notes, { ...notes[0], start: 1 }])
    expect(contiguous.overlaps).toBe(0)
    const overlapping = validatePerformanceNotes([...notes, { ...notes[0], start: 0.5 }])
    expect(overlapping.overlaps).toBe(1)
    expect(overlapping.duration).toBe(1.5)
    expect(overlapping.notes).toHaveLength(2)
    const triple = validatePerformanceNotes([
      { midi: 64, velocity: 0.8, start: 0, duration: 1 },
      { midi: 64, velocity: 0.6, start: 0.5, duration: 1 },
      { midi: 64, velocity: 0.4, start: 0.75, duration: 1 },
      { midi: 67, velocity: 0.4, start: 0, duration: 1 }
    ])
    expect(triple.overlaps).toBe(2)
  })
})

describe('performNotes same-pitch retrigger', () => {
  function logEngine() {
    const log: string[] = []
    const start = Date.now()
    return {
      log,
      engine: {
        heldNotes: new Set<number>(),
        noteOn: (midi: number, velocity: number, _owner: symbol) => { log.push(`on ${midi} ${velocity} @${Date.now() - start}`) },
        noteOff: (midi: number, _owner: symbol) => { log.push(`off ${midi} @${Date.now() - start}`) }
      }
    }
  }

  it('retriggers a pitch that is still sounding and releases it once, at the later end', async () => {
    vi.useFakeTimers()
    const { log, engine } = logEngine()
    const done = performNotes(engine, [
      { midi: 64, velocity: 0.8, start: 0, duration: 1 },
      { midi: 64, velocity: 0.5, start: 0.5, duration: 1 }
    ], new AbortController().signal)
    await vi.advanceTimersByTimeAsync(2000)
    await done
    // The retrigger is a paired off/on at the same instant; the earlier end releases nothing.
    expect(log).toEqual(['on 64 0.8 @0', 'off 64 @500', 'on 64 0.5 @500', 'off 64 @1500'])
    expect(log.filter(entry => entry.startsWith('on 64'))).toHaveLength(2)
    expect(log.filter(entry => entry === 'off 64 @1000')).toHaveLength(0)
    expect(log[log.length - 1]).toBe('off 64 @1500')
  })

  it('keeps distinct pitches independent while a pitch retriggers', async () => {
    vi.useFakeTimers()
    const { log, engine } = logEngine()
    const done = performNotes(engine, [
      { midi: 64, velocity: 0.8, start: 0, duration: 1 },
      { midi: 67, velocity: 0.8, start: 0, duration: 0.25 },
      { midi: 64, velocity: 0.5, start: 0.5, duration: 0.5 }
    ], new AbortController().signal)
    await vi.advanceTimersByTimeAsync(2000)
    await done
    expect(log).toEqual(['on 64 0.8 @0', 'on 67 0.8 @0', 'off 67 @250', 'off 64 @500', 'on 64 0.5 @500', 'off 64 @1000'])
  })

  it('releases every still-active pitch once when the performance is aborted mid-retrigger', async () => {
    vi.useFakeTimers()
    const { log, engine } = logEngine()
    const controller = new AbortController()
    const done = performNotes(engine, [
      { midi: 64, velocity: 0.8, start: 0, duration: 2 },
      { midi: 64, velocity: 0.5, start: 0.5, duration: 2 },
      { midi: 67, velocity: 0.5, start: 0.5, duration: 2 }
    ], controller.signal)
    const rejected = expect(done).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(600)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    await rejected
    expect(log.slice(-2).sort()).toEqual(['off 64 @600', 'off 67 @600'])
    expect(log.filter(entry => entry.startsWith('off 64'))).toHaveLength(2) // the retrigger release plus the cleanup release
    expect(log.filter(entry => entry.startsWith('off 67'))).toHaveLength(1)
  })
})
