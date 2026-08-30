import type { SynthEngine } from '../audio/engine'
import type { AudioMetricsComparison } from '../shared/audio-analysis'

export interface AgentAction {
  id: number
  tool: string
  label: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  summary: string
  timestamp: number
}

export interface AgentActivitySnapshot {
  readyTools: number
  audioToolsLocked: boolean
  lastAction: AgentAction | null
  changedParameters: string[]
  comparison: AudioMetricsComparison | null
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
  private readonly performanceActions = new Set<number>()
  private actionId = 0
  private state: AgentActivitySnapshot = {
    readyTools: 0,
    audioToolsLocked: true,
    lastAction: null,
    changedParameters: [],
    comparison: null,
    performanceActive: false
  }

  constructor(_engine: SynthEngine) {}

  snapshot(): AgentActivitySnapshot {
    return {
      ...this.state,
      changedParameters: [...this.state.changedParameters],
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

  setToolReadiness(readyTools: number, audioToolsLocked: boolean): void {
    this.state.readyTools = readyTools
    this.state.audioToolsLocked = audioToolsLocked
    this.emit()
  }

  startAction(tool: string): number {
    const id = ++this.actionId
    if (['update_parameters', 'set_modulation', 'load_preset'].includes(tool)) this.state.changedParameters = []
    this.state.lastAction = {
      id,
      tool,
      label: TOOL_LABELS[tool] ?? tool,
      status: 'running',
      summary: 'In progress',
      timestamp: Date.now()
    }
    if (tool === 'play_notes' || tool === 'render_audio') {
      this.performanceActions.add(id)
      this.state.performanceActive = true
    }
    this.emit()
    return id
  }

  finishAction(id: number, tool: string, input: unknown, output: unknown): void {
    const inputObject = objectValue(input)
    const outputObject = objectValue(output)
    const expectedError = objectValue(outputObject?.error)
    if (outputObject?.ok === false && expectedError) {
      this.complete(id, tool, 'failed', String(expectedError.message ?? 'Tool failed'))
      return
    }

    if (tool === 'update_parameters' && Array.isArray(outputObject?.applied)) {
      const ids = outputObject.applied.flatMap(item => {
        const value = objectValue(item)
        return typeof value?.id === 'string' ? [value.id] : []
      })
      this.addChangedParameters(ids)
    } else if (tool === 'set_modulation' && typeof inputObject?.destination === 'string') {
      this.addChangedParameters([inputObject.destination])
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
    if (tool === 'play_notes' || tool === 'render_audio') {
      this.performanceActions.delete(id)
      this.state.performanceActive = this.performanceActions.size > 0
    }
    if (!this.state.lastAction || this.state.lastAction.id <= id) {
      this.state.lastAction = {
        id,
        tool,
        label: TOOL_LABELS[tool] ?? tool,
        status,
        summary,
        timestamp: Date.now()
      }
    }
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

  private addChangedParameters(ids: string[]): void {
    this.state.changedParameters = [...new Set([...this.state.changedParameters, ...ids])]
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
