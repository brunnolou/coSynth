import { validateGuide, type GuideStep } from '../ui/guide'
import { PerformanceManager, performanceAbortError, validatePerformanceNotes } from './performance'
import type { PerformanceNote, ReplayEntry, ReplayService, PlaybackOrigin } from './types'

export interface ReplayExecutors {
  play(notes: PerformanceNote[], signal: AbortSignal, origin: PlaybackOrigin): Promise<void>
  showGuide(steps: GuideStep[]): void
  canPlay(): boolean
}

/** Replay payloads are independent of sound history and never restore a patch. */
export class ReplayStore implements ReplayService {
  private entries: ReplayEntry[] = []
  private readonly listeners = new Set<() => void>()
  private nextId = 1
  private disposed = false

  constructor(private readonly performance: PerformanceManager, private readonly executors: ReplayExecutors) {}

  snapshot(): ReplayEntry[] { return structuredClone(this.entries) }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private emit(): void { for (const listener of this.listeners) listener() }
  private assertLive(): void { if (this.disposed) throw new Error('Replay history has been disposed') }
  private append(entry: Omit<ReplayEntry, 'id' | 'timestamp'>): string {
    this.assertLive()
    const id = `replay-${this.nextId++}`
    this.entries.push({ ...structuredClone(entry), id, timestamp: Date.now() })
    if (this.entries.length > 120) this.entries.splice(0, this.entries.length - 120)
    this.emit()
    return id
  }

  addGuide(steps: GuideStep[]): string | undefined {
    const validated = validateGuide({ steps })
    if (!validated.length) return undefined
    return this.append({ kind: 'guide', label: validated[0].title ?? 'Walkthrough', steps: validated, status: 'completed' })
  }

  startPerformance(notes: PerformanceNote[], duration: number, label: string, soundEntryId?: string): string {
    const validated = validatePerformanceNotes(notes)
    if (!Number.isFinite(duration) || duration < validated.duration || duration > 30) throw new Error('Performance duration must cover the notes and be at most 30 seconds')
    return this.append({ kind: 'performance', label, notes: validated.notes, duration, soundEntryId, status: 'running' })
  }

  finishPerformance(id: string, status: 'completed' | 'cancelled' | 'failed'): void {
    const entry = this.entries.find(candidate => candidate.id === id)
    if (!entry || entry.kind !== 'performance') return
    entry.status = status
    this.emit()
  }

  latestPerformanceId(): string | undefined {
    for (let index = this.entries.length - 1; index >= 0; index--) {
      if (this.entries[index].kind === 'performance') return this.entries[index].id
    }
    return undefined
  }

  async replay(id: string, signal?: AbortSignal, origin: PlaybackOrigin = 'human'): Promise<void> {
    this.assertLive()
    if (signal?.aborted) throw performanceAbortError()
    const entry = this.entries.find(candidate => candidate.id === id)
    if (!entry) throw new Error(`Replay ${id} is no longer retained; refresh history`)
    if (entry.kind === 'guide') {
      this.executors.showGuide(structuredClone(entry.steps!))
      return
    }
    if (!this.executors.canPlay()) throw new Error('Start audio with a user gesture before replaying notes')
    await this.performance.run(operationSignal => this.executors.play(structuredClone(entry.notes!), operationSignal, origin), signal)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.performance.stop()
    this.entries = []
    this.emit()
    this.listeners.clear()
  }
}
