import { afterEach, describe, expect, it, vi } from 'vitest'
import { HistoryStore, type HistoryChange } from '../history/store'
import { PerformanceManager } from '../history/performance'
import { ReplayStore } from '../history/replays'
import { createHistoryTools } from './history-tools'

function setup() {
  let sound = 0
  let notify: (change: HistoryChange) => void = () => {}
  const performance = new PerformanceManager()
  const history = new HistoryStore({
    capture: () => sound,
    restore: (value: number) => { sound = value },
    equal: (a, b) => a === b,
    assets: () => [],
    subscribe: fn => { notify = fn; return () => { notify = () => {} } }
  }, () => performance.stop())
  const executors = {
    play: vi.fn(async (_notes: { midi: number; velocity: number; start: number; duration: number }[], _signal: AbortSignal) => {}),
    showGuide: vi.fn(), canPlay: () => true
  }
  const replays = new ReplayStore(performance, executors)
  const lifecycle = new AbortController()
  const tools = createHistoryTools({ history, replays, performance }, lifecycle.signal)
  const execute = async (name: string, input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<any> =>
    tools.find(tool => tool.name === name)!.execute(input, signal ? { signal } : undefined as never)
  const change = (value: number) => { sound = value; notify({ label: 'Change value', changed: ['value'] }) }
  return { history, replays, performance, executors, lifecycle, tools, execute, change, sound: () => sound }
}

afterEach(() => vi.useRealTimers())
const notes = [{ midi: 60, velocity: 1, start: 0, duration: 0.1 }]

describe('history WebMCP tools', () => {
  it('marks discovery read-only and navigation/replay/stop as UI writes', () => {
    const { tools } = setup()
    expect(tools.map(tool => tool.name)).toEqual(['get_history', 'navigate_history', 'replay_history', 'stop_performance'])
    expect(tools.map(tool => tool.annotations?.readOnlyHint)).toEqual([true, false, false, false])
    for (const tool of tools) expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
  })

  it('pages newest-first summaries with a maximum of 20 items and no replay payloads', async () => {
    const { replays, execute, change } = setup()
    for (let value = 1; value <= 25; value++) change(value)
    const page = await execute('get_history', { limit: 20 })
    expect(page).toMatchObject({ view: 'sounds', limit: 20, total: 26, nextOffset: 20, currentId: 'sound-26' })
    expect(page.items).toHaveLength(20)
    expect(page.items[0]).toMatchObject({ id: 'sound-26', current: true })
    expect((await execute('get_history', { offset: 20 })).items).toHaveLength(5)
    expect(await execute('get_history', { offset: 100 })).toMatchObject({ items: [], total: 26 })
    const performanceId = replays.startPerformance(notes, 0.1, 'Notes')
    replays.finishPerformance(performanceId, 'completed')
    replays.addGuide([{ title: 'Start', markdown: 'Sensitive payload omitted from listing' }])
    const replayPage = await execute('get_history', { view: 'replays' })
    expect(replayPage.items).toMatchObject([{ stepCount: 1, kind: 'guide' }, { noteCount: 1, kind: 'performance' }])
    for (const entry of replayPage.items) {
      expect(entry).not.toHaveProperty('steps')
      expect(entry).not.toHaveProperty('notes')
    }
    expect(replayPage.limits).toEqual({ sounds: 120, replays: 120, historicalAssetBytes: 128 * 1024 * 1024 })
  })

  it.each([
    ['get_history', { limit: 21 }, /limit/],
    ['get_history', { limit: 0 }, /limit/],
    ['get_history', { offset: 1.5 }, /offset/],
    ['get_history', { offset: -1 }, /offset/],
    ['get_history', { view: 'invalid' }, /view/],
    ['get_history', { unused: true }, /Unknown/],
    ['navigate_history', { action: 'skip', expectedRevision: 0 }, /action/],
    ['navigate_history', { action: 'undo' }, /expectedRevision/],
    ['navigate_history', { action: 'redo', expectedRevision: -1 }, /expectedRevision/],
    ['navigate_history', { action: 'undo', entryId: 'sound-1', expectedRevision: 0 }, /only valid/],
    ['navigate_history', { action: 'restore', expectedRevision: 0 }, /entryId/],
    ['replay_history', { entryId: ' ' }, /entryId/],
    ['replay_history', { entryId: 'x'.repeat(101) }, /entryId/],
    ['stop_performance', { extra: true }, /Unknown/]
  ])('validates %s input %j', async (name, payload, message) => {
    await expect(setup().execute(name, payload)).rejects.toThrow(message)
  })

  it('rejects stale navigation then supports undo, redo, and restoration without deleting replays', async () => {
    const { execute, change, replays, sound, history } = setup()
    const old = await execute('get_history')
    change(1)
    replays.addGuide([{ title: 'Retained guide' }])
    await expect(execute('navigate_history', { action: 'undo', expectedRevision: old.revision })).rejects.toMatchObject({ name: 'history_conflict', retryable: true })
    expect(sound()).toBe(1)
    const undo = await execute('navigate_history', { action: 'undo', expectedRevision: history.snapshot().revision })
    expect(undo).toMatchObject({ currentId: 'sound-1', canRedo: true })
    expect(sound()).toBe(0)
    const redo = await execute('navigate_history', { action: 'redo', expectedRevision: undo.revision })
    expect(sound()).toBe(1)
    await execute('navigate_history', { action: 'restore', entryId: 'sound-1', expectedRevision: redo.revision })
    expect(sound()).toBe(0)
    expect(replays.snapshot()).toHaveLength(1)
  })

  it('replays retained guides without sound changes or duplicate entries, including after sound undo', async () => {
    const { execute, change, replays, executors, history, sound } = setup()
    change(4)
    const id = replays.addGuide([{ title: 'First' }, { title: 'Second' }])!
    await execute('navigate_history', { action: 'undo', expectedRevision: history.snapshot().revision })
    const before = history.snapshot()
    expect(await execute('replay_history', { entryId: id })).toEqual({ replayed: id })
    expect(executors.showGuide).toHaveBeenCalledWith([{ title: 'First' }, { title: 'Second' }])
    expect(history.snapshot()).toEqual(before)
    expect(sound()).toBe(0)
    expect(replays.snapshot()).toHaveLength(1)
  })

  it.each(['get_history', 'navigate_history', 'replay_history', 'stop_performance'])('rejects pre-aborted %s before validation or action', async name => {
    const { execute, lifecycle } = setup()
    const invocation = new AbortController()
    invocation.abort()
    await expect(execute(name, {}, invocation.signal)).rejects.toMatchObject({ name: 'AbortError' })
    lifecycle.abort()
    await expect(execute(name)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it.each(['invocation', 'lifecycle'])('forwards %s cancellation to active performance replay', async source => {
    const { execute, lifecycle, replays, executors, performance } = setup()
    const id = replays.startPerformance(notes, 0.1, 'Stored performance')
    replays.finishPerformance(id, 'completed')
    executors.play.mockImplementation(async (_notes, signal) => {
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError'))))
    })
    const invocation = new AbortController()
    const replaying = execute('replay_history', { entryId: id }, invocation.signal)
    const rejected = expect(replaying).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    expect(performance.active).toBe(true)
    ;(source === 'invocation' ? invocation : lifecycle).abort()
    await rejected
    expect(performance.active).toBe(false)
    expect(replays.snapshot()).toHaveLength(1)
  })

  it('cancels navigation waiting for performance cleanup before sound restoration', async () => {
    const { execute, performance, change, history, sound } = setup()
    change(1)
    let cleanup!: () => void
    const gate = new Promise<void>(resolve => { cleanup = resolve })
    const playing = performance.run(async signal => {
      try { await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Stopped')))) }
      finally { await gate }
    })
    const stopped = expect(playing).rejects.toThrow('Stopped')
    await Promise.resolve()
    const invocation = new AbortController()
    const navigating = execute('navigate_history', { action: 'undo', expectedRevision: history.snapshot().revision }, invocation.signal)
    const cancelled = expect(navigating).rejects.toMatchObject({ name: 'AbortError' })
    invocation.abort()
    cleanup()
    await cancelled
    await stopped
    expect(sound()).toBe(1)
    expect(history.snapshot().navigating).toBe(false)
  })

  it('stops a performance without deleting the retained note sequence', async () => {
    const { execute, replays, executors, performance } = setup()
    const id = replays.startPerformance(notes, 0.1, 'Stored notes')
    replays.finishPerformance(id, 'completed')
    executors.play.mockImplementation(async (_notes, signal) => {
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError'))))
    })
    const replay = execute('replay_history', { entryId: id })
    const stopped = expect(replay).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    expect(await execute('stop_performance')).toEqual({ stopped: true })
    await stopped
    expect(performance.active).toBe(false)
    expect(replays.snapshot()).toHaveLength(1)
  })
})
