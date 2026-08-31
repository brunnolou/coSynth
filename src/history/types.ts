import type { AudioMetricsComparison } from '../shared/audio-analysis'
import type { GuideStep } from '../ui/guide'

export interface PerformanceNote { midi: number; velocity: number; start: number; duration: number }
export interface SoundEntrySummary {
  id: string
  parentId: string | null
  label: string
  origin: 'human' | 'ai' | 'initial'
  timestamp: number
  changed: string[]
  /** Formatted before/after values when a change is a regular synth parameter. */
  changeDetails?: Array<{ id: string; before: string; after: string }>
  current: boolean
  activePath: boolean
  comparison?: AudioMetricsComparison
}
export interface SoundHistoryView {
  entries: SoundEntrySummary[]
  currentId: string
  revision: number
  canUndo: boolean
  canRedo: boolean
  gestureActive: boolean
  navigating: boolean
  retainedAssetBytes: number
}
export interface SoundHistoryService {
  snapshot(): SoundHistoryView
  subscribe(listener: () => void): () => void
  navigate(action: 'undo' | 'redo' | 'restore', entryId?: string, expectedRevision?: number, signal?: AbortSignal): Promise<SoundHistoryView>
  beginGesture(label: string): void
  endGesture(): void
  coalesce(key: string, label: string): void
}
export interface ReplayEntry {
  id: string
  kind: 'performance' | 'guide'
  label: string
  timestamp: number
  status: 'running' | 'completed' | 'cancelled' | 'failed'
  notes?: PerformanceNote[]
  steps?: GuideStep[]
  duration?: number
  soundEntryId?: string
}
export interface ReplayService {
  snapshot(): ReplayEntry[]
  subscribe(listener: () => void): () => void
  latestPerformanceId(): string | undefined
  replay(id: string, signal?: AbortSignal, origin?: PlaybackOrigin): Promise<void>
}
export type PlaybackOrigin = 'ai' | 'human'
export interface PerformanceService {
  readonly active: boolean
  readonly playing: boolean
  readonly aiPlaying: boolean
  subscribe(listener: () => void): () => void
  stop(): Promise<void>
}
export interface HistoryServices {
  history: SoundHistoryService
  replays: ReplayService
  performance: PerformanceService
}
