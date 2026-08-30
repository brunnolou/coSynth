import { describe, expect, it, vi } from 'vitest'
import { PerformanceManager } from './performance'
import { ReplayStore } from './replays'

const notes = [{ midi: 60, velocity: 0.8, start: 0, duration: 1 }]
function setup() {
  const performance = new PerformanceManager()
  const executors = { play: vi.fn(async (_notes: typeof notes, _signal: AbortSignal) => {}), showGuide: vi.fn(), canPlay: vi.fn(() => true) }
  return { performance, executors, store: new ReplayStore(performance, executors) }
}

describe('ReplayStore', () => {
  it('copies inputs and snapshots, replays using current executor without duplicating history', async () => {
    const { store, executors } = setup()
    const sequence = structuredClone(notes)
    const id = store.startPerformance(sequence, 1, 'AI melody', 'sound-2')
    store.finishPerformance(id, 'completed')
    sequence[0].midi = 90
    const snapshot = store.snapshot()
    snapshot[0].notes![0].midi = 20
    await store.replay(id)
    expect(executors.play).toHaveBeenCalledWith(notes, expect.any(AbortSignal))
    expect(store.snapshot()).toHaveLength(1)
    expect(store.snapshot()[0]).toMatchObject({ id, status: 'completed', soundEntryId: 'sound-2' })
    expect(store.latestPerformanceId()).toBe(id)
  })

  it('keeps cancelled sequences, validates before append, and enforces audio readiness', async () => {
    const { store, executors } = setup()
    expect(() => store.startPerformance([{ ...notes[0], midi: 130 }], 1, 'bad')).toThrow(/midi/)
    expect(() => store.startPerformance(notes, 0.5, 'bad')).toThrow(/duration/)
    expect(store.snapshot()).toEqual([])
    const id = store.startPerformance(notes, 1, 'Cancelled')
    store.finishPerformance(id, 'cancelled')
    executors.canPlay.mockReturnValue(false)
    await expect(store.replay(id)).rejects.toThrow(/Start audio/)
    expect(executors.play).not.toHaveBeenCalled()
    expect(store.snapshot()[0].status).toBe('cancelled')
  })

  it('retains walkthroughs, reopens from the first step, and does not record empty guides', async () => {
    const { store, executors } = setup()
    const steps = [{ title: 'Start here', target: { id: 'panel.osc1' } }, { markdown: 'Continue' }]
    const id = store.addGuide(steps)!
    steps[0].title = 'Changed'
    executors.canPlay.mockReturnValue(false)
    expect(store.addGuide([])).toBeUndefined()
    expect(() => store.addGuide([{}])).toThrow(/empty/)
    await store.replay(id)
    await store.replay(id)
    expect(executors.showGuide.mock.calls[0][0][0].title).toBe('Start here')
    expect(executors.showGuide).toHaveBeenCalledTimes(2)
    expect(store.snapshot()).toHaveLength(1)
  })

  it('evicts the oldest entries across both replay types at 120', async () => {
    const { store } = setup()
    const first = store.startPerformance(notes, 1, 'First')
    for (let index = 0; index < 120; index++) store.addGuide([{ title: `Guide ${index}` }])
    expect(store.snapshot()).toHaveLength(120)
    expect(store.latestPerformanceId()).toBeUndefined()
    await expect(store.replay(first)).rejects.toThrow(/no longer retained/)
    store.finishPerformance(first, 'completed')
    expect(store.snapshot()).toHaveLength(120)
  })

  it('shares the performance lock, stops disposal, and honors aborted replay requests', async () => {
    const { performance, store, executors } = setup()
    const id = store.startPerformance(notes, 1, 'Melody')
    store.finishPerformance(id, 'completed')
    const controller = new AbortController()
    controller.abort()
    await expect(store.replay(id, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    executors.play.mockImplementation(async (_notes, signal) => {
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped'))))
    })
    const replay = store.replay(id)
    const result = expect(replay).rejects.toThrow('stopped')
    await Promise.resolve()
    await expect(performance.run(async () => {})).rejects.toThrow(/progress/)
    await store.dispose()
    await result
    expect(performance.active).toBe(false)
    expect(store.snapshot()).toEqual([])
    await expect(store.replay(id)).rejects.toThrow(/disposed/)
  })
})
