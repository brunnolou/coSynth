import type { AudioMetricsComparison } from '../shared/audio-analysis'
import type { SoundEntrySummary, SoundHistoryService, SoundHistoryView } from './types'

export const HISTORY_LIMIT = 120
export const HISTORY_ASSET_LIMIT = 128 * 1024 * 1024
export interface HistoryChange { label: string; changed: string[]; coalesceKey?: string; atomic?: boolean }
export interface HistoryAdapter<S> {
  capture(): S
  restore(state: S): void
  equal(a: S, b: S): boolean
  assets(state: S): readonly { byteLength: number }[]
  describe?(before: S, after: S, changed: readonly string[]): Array<{ id: string; before: string; after: string }>
  subscribe(listener: (change: HistoryChange) => void): () => void
}
interface Entry<S> extends Omit<SoundEntrySummary, 'current' | 'activePath'> { state: S }
interface Transaction<S> { label: string; origin: 'human' | 'ai'; changed: Set<string>; key?: string; state?: S }
export class HistoryBusyError extends Error {
  readonly retryable = true
  constructor(message = 'A human edit is in progress. Retry after the gesture ends.') { super(message); this.name = 'history_busy' }
}
export class HistoryConflictError extends Error {
  readonly retryable = true
  constructor() { super('Sound history changed. Read get_history again before navigating.'); this.name = 'history_conflict' }
}

/** Immutable states form a bounded tree. The cursor and preferred children define undo/redo. */
export class HistoryStore<S> implements SoundHistoryService {
  private entries: Entry<S>[] = []
  private preferred = new Map<string, string>()
  private listeners = new Set<() => void>()
  private currentId = ''
  private revision = 0
  private serial = 0
  private transaction: Transaction<S> | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private suppress = false
  private disposed = false
  private navigating = false
  private unsubscribe: () => void

  constructor(private adapter: HistoryAdapter<S>, private stop: () => Promise<void>,
    private limits = { entries: HISTORY_LIMIT, assetBytes: HISTORY_ASSET_LIMIT }) {
    this.currentId = this.nextId()
    this.entries.push({ id: this.currentId, parentId: null, label: 'Initial sound', origin: 'initial', timestamp: Date.now(), changed: [], state: adapter.capture() })
    this.unsubscribe = adapter.subscribe(change => this.record(change))
  }

  private nextId() { return `sound-${++this.serial}` }
  private current() { return this.entries.find(entry => entry.id === this.currentId)! }
  private emit() { for (const listener of this.listeners) listener() }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  private activePath(): Set<string> {
    const result = new Set<string>()
    let entry: Entry<S> | undefined = this.current()
    while (entry && !result.has(entry.id)) { result.add(entry.id); entry = this.entries.find(e => e.id === entry!.parentId) }
    let next = this.preferred.get(this.currentId)
    while (next && !result.has(next)) { result.add(next); next = this.preferred.get(next) }
    return result
  }

  private retainedAssetBytes(): number {
    const currentAssets = new Set(this.adapter.assets(this.current().state))
    const oldAssets = new Set<{ byteLength: number }>()
    for (const entry of this.entries) for (const asset of this.adapter.assets(entry.state)) if (!currentAssets.has(asset)) oldAssets.add(asset)
    return [...oldAssets].reduce((total, asset) => total + asset.byteLength, 0)
  }

  snapshot(): SoundHistoryView {
    const path = this.activePath()
    return {
      currentId: this.currentId, revision: this.revision,
      canUndo: !!this.current()?.parentId || !!this.transaction?.changed.size,
      canRedo: this.preferred.has(this.currentId) && !this.transaction?.changed.size,
      gestureActive: this.transaction?.origin === 'human', navigating: this.navigating,
      retainedAssetBytes: this.retainedAssetBytes(),
      entries: this.entries.map(({ state: _state, ...entry }) => ({ ...entry, changed: [...entry.changed],
        ...(entry.comparison ? { comparison: structuredClone(entry.comparison) } : {}),
        current: entry.id === this.currentId, activePath: path.has(entry.id) }))
    }
  }

  private record(change: HistoryChange) {
    if (this.suppress || this.disposed) return
    // Imports decode asynchronously. A MIDI/wheel gesture may have begun while
    // decoding, so commit its last captured state before recording the import.
    // An AI tool remains the outer transaction even when it uses engine batches.
    if (change.atomic && this.transaction?.origin === 'human') this.endGesture()
    if (change.coalesceKey && !this.transaction) this.coalesce(change.coalesceKey, change.label)
    else if (change.coalesceKey && this.transaction?.key) this.coalesce(change.coalesceKey, change.label)
    this.revision++ // Includes unfinished gestures, protecting AI against stale observations.
    if (this.transaction) {
      for (const key of change.changed) this.transaction.changed.add(key)
      this.transaction.state = this.adapter.capture()
      this.emit()
    } else {
      this.commit({ label: change.label, origin: 'human', changed: new Set(change.changed) })
    }
  }

  beginGesture(label: string): void {
    if (this.disposed || this.navigating) return
    this.endGesture()
    this.transaction = { label, origin: 'human', changed: new Set() }
    this.emit()
  }

  coalesce(key: string, label: string): void {
    if (this.disposed || this.navigating || (this.transaction && !this.transaction.key)) return
    if (this.transaction?.key !== key) {
      this.endGesture()
      this.transaction = { label, origin: 'human', changed: new Set(), key }
    }
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.endGesture(), 300)
    this.emit()
  }

  endGesture(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    const transaction = this.transaction
    this.transaction = null
    if (transaction) this.commit(transaction)
  }

  runAi<T>(label: string, action: () => T): T {
    if (this.disposed) throw new Error('History has been disposed')
    if (this.transaction || this.navigating) throw new HistoryBusyError()
    this.transaction = { label, origin: 'ai', changed: new Set() }
    try { return action() }
    finally { this.endGesture() }
  }

  private commit(transaction: Transaction<S>): void {
    if (this.disposed) return
    const state = transaction.state ?? this.adapter.capture()
    if (!transaction.changed.size || this.adapter.equal(state, this.current().state)) { this.emit(); return }
    const id = this.nextId()
    const changed = [...transaction.changed]
    const changeDetails = this.adapter.describe?.(this.current().state, state, changed)
    this.entries.push({ id, parentId: this.currentId, state, label: transaction.label, origin: transaction.origin,
      changed, ...(changeDetails?.length ? { changeDetails } : {}), timestamp: Date.now() })
    this.preferred.set(this.currentId, id)
    this.currentId = id
    this.evict()
    this.emit()
  }

  private evict() {
    while (this.entries.length > this.limits.entries || this.retainedAssetBytes() > this.limits.assetBytes) {
      const oldest = this.entries.find(entry => entry.id !== this.currentId)
      if (!oldest) break
      this.entries = this.entries.filter(entry => entry !== oldest)
      for (const child of this.entries) if (child.parentId === oldest.id) child.parentId = null
      this.preferred.delete(oldest.id)
      for (const [id, next] of this.preferred) if (next === oldest.id) this.preferred.delete(id)
    }
  }

  async navigate(action: 'undo' | 'redo' | 'restore', entryId?: string, expectedRevision?: number, signal?: AbortSignal): Promise<SoundHistoryView> {
    signal?.throwIfAborted()
    if (this.disposed) throw new Error('History has been disposed')
    if (this.navigating) throw new HistoryBusyError('History navigation is already in progress')
    if (expectedRevision !== undefined && expectedRevision !== this.revision) throw new HistoryConflictError()
    this.endGesture()
    const targetId = action === 'undo' ? this.current().parentId : action === 'redo' ? this.preferred.get(this.currentId) : entryId
    if (!targetId) {
      if (action === 'restore') throw new Error('entryId is required for restore')
      return this.snapshot()
    }
    const target = this.entries.find(entry => entry.id === targetId)
    if (!target) throw new Error('That sound version is no longer retained')
    if (target.id === this.currentId) return this.snapshot()
    this.navigating = true
    const revision = this.revision
    this.emit()
    try {
      await this.stop()
      signal?.throwIfAborted()
      if (this.disposed) throw new Error('History has been disposed')
      if (this.revision !== revision) throw new HistoryConflictError()
      this.suppress = true
      try { this.adapter.restore(target.state) } finally { this.suppress = false }
      this.currentId = target.id
      let child: Entry<S> | undefined = target
      while (child?.parentId) {
        this.preferred.set(child.parentId, child.id)
        child = this.entries.find(entry => entry.id === child!.parentId)
      }
      this.revision++
      this.evict()
    } finally { this.navigating = false; this.emit() }
    return this.snapshot()
  }

  attachComparison(comparison: AudioMetricsComparison, entryId = this.currentId) {
    const entry = this.entries.find(entry => entry.id === entryId)
    if (entry) { entry.comparison = structuredClone(comparison); this.emit() }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.timer)
    this.unsubscribe()
    this.transaction = null
    this.entries = []
    this.preferred.clear()
    this.listeners.clear()
  }
}
