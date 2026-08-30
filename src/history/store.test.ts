import { afterEach, describe, expect, it, vi } from 'vitest'
import { HistoryStore, type HistoryChange } from './store'

function setup(limits?: { entries: number; assetBytes: number }) {
  let value = 0
  let asset: { byteLength: number } | undefined
  let notify: (event: HistoryChange) => void = () => {}
  const stop = vi.fn(async () => {})
  const restore = vi.fn((state: { value: number; asset?: { byteLength: number } }) => { value = state.value; asset = state.asset; notify({ label: 'Restore', changed: ['value'] }) })
  const history = new HistoryStore({
    capture: () => ({ value, asset }), restore,
    equal: (a, b) => a.value === b.value && a.asset === b.asset,
    assets: state => state.asset ? [state.asset] : [],
    subscribe: fn => { notify = fn; return () => { notify = () => {} } }
  }, stop, limits)
  const change = (next: number, coalesceKey?: string) => { value = next; notify({ label: 'Change value', changed: ['value'], coalesceKey }) }
  const importAsset = (next: { byteLength: number }) => { asset = next; notify({ label: 'Import', changed: ['sample'], atomic: true }) }
  return { history, change, importAsset, stop, restore, value: () => value }
}
afterEach(() => vi.useRealTimers())

describe('shared sound history', () => {
  it('groups gestures, skips no-ops, and undoes/redoes the full state', async () => {
    const { history, change, value } = setup()
    history.beginGesture('Turn cutoff')
    change(1); change(2); change(3)
    expect(history.snapshot().entries).toHaveLength(1)
    expect(history.snapshot().canUndo).toBe(true)
    history.endGesture()
    expect(history.snapshot().entries).toHaveLength(2)
    history.beginGesture('No change'); change(3); history.endGesture()
    expect(history.snapshot().entries).toHaveLength(2)
    await history.navigate('undo'); expect(value()).toBe(0)
    await history.navigate('redo'); expect(value()).toBe(3)
  })

  it('records one step per AI transaction and refuses an active human gesture', () => {
    const { history, change } = setup()
    history.runAi('Updated parameters', () => { change(1); change(2) })
    expect(history.snapshot().entries.at(-1)).toMatchObject({ origin: 'ai', label: 'Updated parameters' })
    expect(history.snapshot().entries).toHaveLength(2)
    history.beginGesture('Human drag')
    expect(() => history.runAi('Agent edit', () => change(4))).toThrow(/human edit/)
    history.endGesture()
  })

  it('coalesces wheel and MIDI by key for 300ms', () => {
    vi.useFakeTimers()
    const { history, change } = setup()
    change(1, 'midi:macro1'); vi.advanceTimersByTime(200); change(2, 'midi:macro1')
    vi.advanceTimersByTime(299); expect(history.snapshot().entries).toHaveLength(1)
    vi.advanceTimersByTime(1); expect(history.snapshot().entries).toHaveLength(2)
    change(3, 'midi:macro1'); change(4, 'midi:macro2')
    vi.advanceTimersByTime(300); expect(history.snapshot().entries).toHaveLength(4)
  })

  it('commits a pending human state before an atomic operation without capturing its new asset', async () => {
    vi.useFakeTimers()
    const { history, change, importAsset, restore } = setup()
    change(1, 'midi:macro1')
    const asset = { byteLength: 80 }
    importAsset(asset)
    const entries = history.snapshot().entries
    expect(entries).toHaveLength(3)
    expect(entries[1]).toMatchObject({ changed: ['value'], label: 'Change value' })
    expect(entries[2]).toMatchObject({ changed: ['sample'], label: 'Import' })
    vi.advanceTimersByTime(300)
    expect(history.snapshot().entries).toHaveLength(3)
    await history.navigate('undo')
    expect(restore).toHaveBeenLastCalledWith({ value: 1, asset: undefined })
    await history.navigate('redo')
    expect(restore).toHaveBeenLastCalledWith({ value: 1, asset })
  })

  it('keeps atomic engine operations inside one outer AI transaction', () => {
    const { history, change, importAsset } = setup()
    history.runAi('Load AI sound', () => {
      change(1)
      importAsset({ byteLength: 80 })
      change(2)
    })
    expect(history.snapshot().entries).toHaveLength(2)
    expect(history.snapshot().entries[1]).toMatchObject({ origin: 'ai', label: 'Load AI sound', changed: ['value', 'sample'] })
  })

  it('preserves alternative futures and restores their undo/redo path', async () => {
    const { history, change, value } = setup()
    change(1); change(2)
    const abandoned = history.snapshot().currentId
    await history.navigate('undo'); change(8)
    expect(history.snapshot().entries.find(e => e.id === abandoned)?.activePath).toBe(false)
    await history.navigate('restore', abandoned); expect(value()).toBe(2)
    await history.navigate('undo'); expect(value()).toBe(1)
    await history.navigate('redo'); expect(value()).toBe(2)
    expect(history.snapshot().entries).toHaveLength(4)
  })

  it('stops performance before restoring and rejects stale AI navigation', async () => {
    const { history, change, stop, restore } = setup()
    const oldRevision = history.snapshot().revision
    change(1)
    await expect(history.navigate('undo', undefined, oldRevision)).rejects.toThrow(/changed/)
    expect(stop).not.toHaveBeenCalled()
    await history.navigate('undo', undefined, history.snapshot().revision)
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(restore.mock.invocationCallOrder[0])
  })

  it('finalizes a gesture before undo and protects edits made while stopping', async () => {
    const { history, change, stop, value } = setup()
    history.beginGesture('Drag'); change(2)
    await history.navigate('undo'); expect(value()).toBe(0)
    change(3)
    stop.mockImplementationOnce(async () => { change(4) })
    await expect(history.navigate('undo')).rejects.toThrow(/changed/)
    expect(value()).toBe(4)
  })

  it('bounds all branches by entry count without discarding the current sound', async () => {
    const { history, change } = setup({ entries: 3, assetBytes: 1000 })
    change(1); change(2)
    const initial = history.snapshot().entries[0].id
    await history.navigate('restore', initial); change(9); change(10)
    expect(history.snapshot().entries).toHaveLength(3)
    expect(history.snapshot().entries.find(e => e.current)?.label).toBe('Change value')
    await expect(history.navigate('restore', initial)).rejects.toThrow(/no longer retained/)
  })

  it('counts shared old assets once and exempts current assets from the byte cap', () => {
    const { history, change, importAsset } = setup({ entries: 120, assetBytes: 100 })
    importAsset({ byteLength: 80 }); change(1); change(2)
    expect(history.snapshot().retainedAssetBytes).toBe(0)
    importAsset({ byteLength: 1000 })
    expect(history.snapshot().retainedAssetBytes).toBe(80)
    importAsset({ byteLength: 2000 })
    expect(history.snapshot().retainedAssetBytes).toBeLessThanOrEqual(100)
    expect(history.snapshot().entries.at(-1)?.current).toBe(true)
  })

  it('disposes subscriptions and pending coalescing timers', () => {
    vi.useFakeTimers()
    const { history, change } = setup()
    const observer = vi.fn(); history.subscribe(observer)
    change(1, 'wheel'); history.dispose(); observer.mockClear()
    change(2); vi.runAllTimers()
    expect(observer).not.toHaveBeenCalled()
  })
})
