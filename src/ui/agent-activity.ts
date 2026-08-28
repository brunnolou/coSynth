import type { SynthEngine } from '../audio/engine'
import type { AudioMetricsComparison } from '../shared/audio-analysis'
import { agentActivityFor, type AgentActivitySnapshot } from '../webmcp/activity'
import { el } from './common'
import { ModalDialog } from './dialog'

const METRIC_LABELS: Record<keyof AudioMetricsComparison['details'], string> = {
  peakDb: 'Peak',
  rmsDb: 'RMS',
  clippingCount: 'Clipping',
  dcOffset: 'DC offset',
  spectralCentroidHz: 'Centroid',
  attackMs: 'Attack',
  stereoWidth: 'Stereo width'
}

function button(label: string, className = 'agent-btn'): HTMLButtonElement {
  const result = el('button', className, label)
  result.type = 'button'
  return result
}

function field(label: string, value: string): HTMLElement {
  const row = el('div', 'agent-field')
  row.append(el('span', 'agent-field-label', label), el('span', 'agent-field-value', value))
  return row
}

function formatMetric(key: keyof AudioMetricsComparison['details'], value: number): string {
  if (key === 'peakDb' || key === 'rmsDb') return `${value.toFixed(1)} dB`
  if (key === 'attackMs') return `${value.toFixed(1)} ms`
  if (key === 'spectralCentroidHz') return `${Math.round(value)} Hz`
  if (key === 'clippingCount') return String(Math.round(value))
  return value.toFixed(3)
}

export class AgentActivityPanel {
  readonly root: HTMLElement
  private readonly store
  private readonly toolStatus = el('span', 'agent-tool-status', 'Checking agent tools…')
  private readonly lastAction = el('span', 'agent-last-action', 'No agent activity yet')
  private readonly checkpointButton = button('Checkpoint')
  private readonly detailsDialog = new ModalDialog('Agent Activity')
  private readonly checkpointDialog = new ModalDialog('Iteration checkpoint')
  private state: AgentActivitySnapshot

  constructor(engine: SynthEngine) {
    this.store = agentActivityFor(engine)
    this.state = this.store.snapshot()
    this.root = el('section', 'panel agent-activity-panel')
    const title = el('span', 'panel-title', 'AGENT ACTIVITY')
    const detailsButton = button('Details')
    detailsButton.addEventListener('click', () => this.detailsDialog.open())
    this.checkpointButton.addEventListener('click', () => this.checkpointDialog.open())

    const summary = el('div', 'agent-activity-summary')
    summary.append(title, this.toolStatus, this.lastAction)
    const actions = el('div', 'agent-activity-actions')
    actions.append(detailsButton, this.checkpointButton)
    this.root.append(summary, actions, this.detailsDialog.root, this.checkpointDialog.root)

    this.store.subscribe(state => {
      this.state = state
      this.render()
    })
  }

  private render(): void {
    this.toolStatus.textContent = this.state.readyTools === 0
      ? 'Agent tools unavailable'
      : this.state.audioToolsLocked
        ? `${this.state.readyTools} tools prontos · inicia áudio para desbloquear 2`
        : `${this.state.readyTools} tools prontos`

    const action = this.state.lastAction
    this.lastAction.textContent = action
      ? `${action.label} · ${action.summary}`
      : 'No agent activity yet'
    this.lastAction.dataset.status = action?.status ?? 'idle'

    this.checkpointButton.disabled = !this.state.checkpointAvailable || this.state.performanceActive
    this.checkpointButton.textContent = this.state.checkpointAvailable ? 'Checkpoint ready' : 'Checkpoint'
    this.renderDetails()
    this.renderCheckpoint()
  }

  private renderDetails(): void {
    const body = this.detailsDialog.body
    body.textContent = ''
    body.appendChild(field('Tools', this.toolStatus.textContent ?? ''))

    if (this.state.lastAction) {
      body.append(
        field('Last action', this.state.lastAction.label),
        field('Result', this.state.lastAction.summary),
        field('Status', this.state.lastAction.status),
        field('Time', new Date(this.state.lastAction.timestamp).toLocaleTimeString())
      )
    } else {
      body.appendChild(el('p', 'agent-empty', 'No WebMCP action has run yet.'))
    }

    const changedSection = el('section', 'agent-modal-section')
    changedSection.appendChild(el('h3', 'agent-section-title', 'Changed parameters'))
    const changed = el('div', 'agent-param-list')
    if (this.state.changedParameters.length) {
      for (const id of this.state.changedParameters) changed.appendChild(el('code', 'agent-param', id))
    } else {
      changed.appendChild(el('span', 'agent-empty', 'No parameter changes in this iteration.'))
    }
    changedSection.appendChild(changed)
    body.appendChild(changedSection)

    const comparisonSection = el('section', 'agent-modal-section')
    comparisonSection.appendChild(el('h3', 'agent-section-title', 'Latest comparison'))
    if (!this.state.comparison) {
      comparisonSection.appendChild(el('p', 'agent-empty', 'No comparison result yet.'))
    } else {
      comparisonSection.appendChild(el('div', 'agent-similarity', `${Math.round(this.state.comparison.similarity * 100)}% similarity`))
      const table = el('div', 'agent-metrics')
      for (const key of Object.keys(METRIC_LABELS) as (keyof AudioMetricsComparison['details'])[]) {
        const detail = this.state.comparison.details[key]
        const row = el('div', 'agent-metric-row')
        row.append(
          el('span', 'agent-metric-name', METRIC_LABELS[key]),
          el('span', 'agent-metric-value', formatMetric(key, detail.candidate)),
          el('span', detail.delta > 0 ? 'agent-delta positive' : detail.delta < 0 ? 'agent-delta negative' : 'agent-delta', `${detail.delta > 0 ? '+' : ''}${formatMetric(key, detail.delta)}`)
        )
        table.appendChild(row)
      }
      comparisonSection.appendChild(table)
    }
    body.appendChild(comparisonSection)

    const footer = this.detailsDialog.footer
    footer.textContent = ''
    const close = button('Close', 'agent-btn primary')
    close.addEventListener('click', () => this.detailsDialog.close())
    footer.appendChild(close)
  }

  private renderCheckpoint(): void {
    const body = this.checkpointDialog.body
    body.textContent = ''
    if (this.state.checkpointAvailable) {
      body.appendChild(el('p', '', 'Soundgineer saved the state from before this agent iteration. Rejecting restores parameters, modulation routes, LFO shapes, and FX order.'))
      if (this.state.changedParameters.length) {
        const changed = el('div', 'agent-param-list')
        for (const id of this.state.changedParameters) changed.appendChild(el('code', 'agent-param', id))
        body.appendChild(changed)
      }
      if (this.state.performanceActive) body.appendChild(el('p', 'agent-warning', 'Wait for playback or rendering to finish before choosing.'))
    } else {
      body.appendChild(el('p', 'agent-empty', 'No agent iteration is waiting for review.'))
    }

    const footer = this.checkpointDialog.footer
    footer.textContent = ''
    const keep = button('Keep changes')
    const reject = button('Reject iteration', 'agent-btn danger')
    keep.disabled = !this.state.checkpointAvailable || this.state.performanceActive
    reject.disabled = !this.state.checkpointAvailable || this.state.performanceActive
    keep.addEventListener('click', () => {
      if (this.store.acceptCheckpoint()) this.checkpointDialog.close()
    })
    reject.addEventListener('click', () => {
      if (this.store.restoreCheckpoint()) this.checkpointDialog.close()
    })
    footer.append(keep, reject)
  }
}

