import type { SynthEngine } from '../audio/engine'
import type { AudioMetricsComparison } from '../shared/audio-analysis'
import { PARAMS } from '../shared/params'
import { changeKey, samePatchValue, type PatchChange, type PatchMutation } from '../shared/patch-change'

export type PendingChange = PatchChange & { key: string; revision: number }

/** Session-only attribution saved alongside each sound-history version. */
export interface AgentAttribution {
  pendingChanges: PendingChange[]
  checkpointCreatedAt: number | null
  reviewEpoch: number
}

export interface AgentAction {
  id: number
  tool: string
  label: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  summary: string
  timestamp: number
  finishedAt?: number
}

export interface ToolRegistrationError { tool: string; message: string }
export type ToolAvailability = 'checking' | 'unavailable' | 'ready' | 'error'

export interface AgentActivitySnapshot {
  readyTools: number
  audioToolsLocked: boolean
  toolAvailability: ToolAvailability
  registrationErrors: ToolRegistrationError[]
  actions: AgentAction[]
  activeToolCalls: number
  lastError: AgentAction | null
  lastAction: AgentAction | null
  changedParameters: string[]
  pendingChanges: PendingChange[]
  showChanges: boolean
  comparison: AudioMetricsComparison | null
  checkpointAvailable: boolean
  checkpointCreatedAt: number | null
  performanceActive: boolean
}

type Listener = (snapshot: AgentActivitySnapshot) => void

const TOOL_LABELS: Record<string, string> = {
  get_synth_state: 'Read synth state',
  get_parameter_schema: 'Read parameter schema',
  update_parameters: 'Updated parameters',
  set_modulation: 'Changed modulation',
  play_notes: 'Played notes',
  render_audio: 'Rendered audio',
  analyze_audio: 'Analyzed synth audio',
  analyze_reference_audio: 'Analyzed reference audio',
  compare_audio: 'Compared audio',
  save_preset: 'Saved preset',
  load_preset: 'Loaded preset',
  list_presets: 'Listed presets',
  get_ui_targets: 'Found teaching targets',
  show_ui_guide: 'Updated teaching guide',
  get_history: 'Read history',
  navigate_history: 'Restored sound history',
  replay_history: 'Replayed history',
  stop_performance: 'Stopped performance'
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export class AgentActivityStore {
  private readonly listeners = new Set<Listener>()
  private readonly actions = new Map<number, AgentAction>()
  private readonly activeCalls = new Set<number>()
  private readonly performanceActions = new Set<number>()
  private readonly pending = new Map<string, PendingChange>()
  private revision = 0
  private reviewEpoch = 0
  private canReview = () => true
  private readonly unsubscribe: () => void
  private actionId = 0
  private state: AgentActivitySnapshot = {
    readyTools: 0,
    audioToolsLocked: true,
    toolAvailability: 'checking',
    registrationErrors: [],
    actions: [],
    activeToolCalls: 0,
    lastError: null,
    lastAction: null,
    changedParameters: [],
    pendingChanges: [],
    showChanges: true,
    comparison: null,
    checkpointAvailable: false,
    checkpointCreatedAt: null,
    performanceActive: false
  }

  constructor(private readonly engine: SynthEngine) {
    this.unsubscribe = engine.onPatchChange(mutation => this.recordMutation(mutation))
  }

  dispose(): void {
    this.unsubscribe()
    this.listeners.clear()
  }

  private recordMutation(mutation: PatchMutation): void {
    if (mutation.origin === 'restore') return
    if (mutation.reset) {
      this.clearIteration()
    } else {
      for (const change of mutation.changes) {
        const key = changeKey(change)
        if (mutation.origin === 'human') {
          this.pending.delete(key)
          continue
        }
        const previous = this.pending.get(key)
        const before = previous ? previous.before : change.before
        if (samePatchValue(before, change.after)) this.pending.delete(key)
        else {
          if (this.state.checkpointCreatedAt === null) {
            this.state.checkpointCreatedAt = Date.now()
            this.state.comparison = null
          }
          this.pending.set(key, structuredClone({ ...change, before, key, revision: ++this.revision }) as PendingChange)
        }
      }
    }
    this.syncPending()
    this.emit()
  }

  private syncPending(): void {
    this.state.pendingChanges = [...this.pending.values()]
    this.state.changedParameters = this.state.pendingChanges.flatMap(change =>
      change.kind === 'param' ? [PARAMS[change.index].id] : [])
    this.state.checkpointAvailable = this.pending.size > 0
    if (!this.pending.size) this.state.checkpointCreatedAt = null
  }

  private clearIteration(): void {
    this.pending.clear()
    this.state.comparison = null
    this.syncPending()
  }

  setShowChanges(show: boolean): void {
    this.state.showChanges = show
    this.emit()
  }

  setReviewGuard(canReview: () => boolean): void {
    this.canReview = canReview
  }

  captureAttribution(): AgentAttribution {
    return {
      pendingChanges: structuredClone([...this.pending.values()]),
      checkpointCreatedAt: this.state.checkpointCreatedAt,
      reviewEpoch: this.reviewEpoch
    }
  }

  restoreAttribution(attribution: AgentAttribution): void {
    this.clearIteration()
    // Keep acknowledges the iteration across all retained sound versions.
    // Restored revisions stay unchanged so Undo never replays the arrival glow.
    if (attribution.reviewEpoch === this.reviewEpoch) {
      for (const change of structuredClone(attribution.pendingChanges)) {
        this.pending.set(change.key, change)
        this.revision = Math.max(this.revision, change.revision)
      }
      this.state.checkpointCreatedAt = attribution.checkpointCreatedAt
    }
    this.syncPending()
    this.emit()
  }

  snapshot(): AgentActivitySnapshot {
    return {
      ...this.state,
      actions: [...this.actions.values()].map(action => ({ ...action })),
      activeToolCalls: this.activeCalls.size,
      registrationErrors: this.state.registrationErrors.map(error => ({ ...error })),
      lastAction: this.state.lastAction ? { ...this.state.lastAction } : null,
      lastError: this.state.lastError ? { ...this.state.lastError } : null,
      changedParameters: [...this.state.changedParameters],
      pendingChanges: structuredClone(this.state.pendingChanges),
      comparison: this.state.comparison ? {
        similarity: this.state.comparison.similarity,
        details: { ...this.state.comparison.details }
      } : null
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  setToolReadiness(readyTools: number, audioToolsLocked: boolean, options: {
    available?: boolean; registering?: boolean; errors?: readonly ToolRegistrationError[]
  } = {}): void {
    this.state.readyTools = readyTools
    this.state.audioToolsLocked = audioToolsLocked
    this.state.registrationErrors = (options.errors ?? []).map(error => ({ ...error }))
    this.state.toolAvailability = options.available === false ? 'unavailable'
      : this.state.registrationErrors.length ? 'error'
      : readyTools > 0 ? 'ready'
      : options.registering ? 'checking' : 'unavailable'
    this.emit()
  }

  reportHumanError(error: unknown): void {
    this.state.lastAction = { ...this.humanAction('History action failed'), status: 'failed',
      summary: error instanceof Error ? error.message : String(error) }
    this.emit()
  }

  acceptCheckpoint(): boolean {
    if (!this.pending.size || this.state.performanceActive || !this.canReview()) return false
    this.reviewEpoch++
    this.clearIteration()
    this.state.lastAction = this.humanAction('Kept agent changes')
    this.emit()
    return true
  }

  restoreCheckpoint(): boolean {
    if (!this.pending.size || this.state.performanceActive || !this.canReview()) return false
    this.engine.batchSoundChange('Reject AI changes', () => {
      for (const change of this.pending.values()) {
        switch (change.kind) {
          case 'param': this.engine.setParam(change.index, change.before, 'restore'); break
          case 'route': this.engine.setModSlot(change.index, change.before, 'restore'); break
          case 'lfo': this.engine.setLfoShape(change.index, change.before, 'restore'); break
          case 'fx': this.engine.setFxOrder(change.before, 'restore'); break
        }
      }
      // History captures the final attribution when the batch commits.
      this.clearIteration()
    })
    this.state.lastAction = this.humanAction('Rejected agent changes; kept manual edits')
    this.emit()
    return true
  }

  startAction(tool: string): number {
    const id = ++this.actionId
    this.state.lastAction = {
      id,
      tool,
      label: TOOL_LABELS[tool] ?? tool,
      status: 'running',
      summary: 'In progress',
      timestamp: Date.now()
    }
    this.actions.set(id, this.state.lastAction)
    this.activeCalls.add(id)
    // Keep a bounded invocation log; active ownership is tracked separately.
    if (this.actions.size > 100) this.actions.delete(this.actions.keys().next().value!)
    if (tool === 'play_notes' || tool === 'render_audio') {
      this.performanceActions.add(id)
      this.state.performanceActive = true
    }
    this.emit()
    return id
  }

  finishAction(id: number, tool: string, _input: unknown, output: unknown): void {
    const outputObject = objectValue(output)
    const expectedError = objectValue(outputObject?.error)
    if (outputObject?.ok === false && expectedError) {
      this.complete(id, tool, 'failed', String(expectedError.message ?? 'Tool failed'))
      return
    }

    if (tool === 'compare_audio') {
      const comparison = objectValue(outputObject?.comparison)
      if (comparison && typeof comparison.similarity === 'number' && objectValue(comparison.details)) {
        this.state.comparison = comparison as unknown as AudioMetricsComparison
      }
    }

    this.complete(id, tool, 'completed', this.successSummary(tool, outputObject))
  }

  failAction(id: number, tool: string, error: unknown): void {
    const status = error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed'
    const summary = error instanceof Error ? error.message : 'Tool failed'
    this.complete(id, tool, status, summary)
  }

  private complete(id: number, tool: string, status: AgentAction['status'], summary: string): void {
    if (!this.activeCalls.delete(id)) return
    if (tool === 'play_notes' || tool === 'render_audio') {
      this.performanceActions.delete(id)
      this.state.performanceActive = this.performanceActions.size > 0
    }
    const action: AgentAction = {
      id,
      tool,
      label: TOOL_LABELS[tool] ?? tool,
      status,
      summary,
      timestamp: this.actions.get(id)?.timestamp ?? Date.now(),
      finishedAt: Date.now()
    }
    if (this.actions.has(id)) this.actions.set(id, action)
    if (status === 'failed') this.state.lastError = action
    else if (status === 'completed') this.state.lastError = null
    if (!this.state.lastAction || this.state.lastAction.id <= id) this.state.lastAction = action
    this.emit()
  }

  private successSummary(tool: string, output: Record<string, unknown> | null): string {
    if (tool === 'show_ui_guide') return output?.cleared ? 'Guide cleared' : `${output?.stepCount ?? 0} guide steps shown`
    if (tool === 'get_ui_targets' && Array.isArray(output?.items)) return `${output.items.length} targets returned`
    if (tool === 'update_parameters' && Array.isArray(output?.applied)) return `${output.applied.length} parameter${output.applied.length === 1 ? '' : 's'}`
    if (tool === 'play_notes' && typeof output?.noteCount === 'number') return `${output.noteCount} note${output.noteCount === 1 ? '' : 's'}`
    if (tool === 'compare_audio') {
      const comparison = objectValue(output?.comparison)
      if (typeof comparison?.similarity === 'number') return `${Math.round(comparison.similarity * 100)}% similarity`
    }
    if (tool === 'render_audio' && typeof output?.duration === 'number') return `${output.duration.toFixed(2)}s render`
    return 'Completed'
  }

  private humanAction(label: string): AgentAction {
    return {
      id: ++this.actionId,
      tool: 'human_checkpoint',
      label,
      status: 'completed',
      summary: 'Completed',
      timestamp: Date.now()
    }
  }

  private emit(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}

const stores = new WeakMap<SynthEngine, AgentActivityStore>()

export function agentActivityFor(engine: SynthEngine): AgentActivityStore {
  let store = stores.get(engine)
  if (!store) {
    store = new AgentActivityStore(engine)
    stores.set(engine, store)
  }
  return store
}
