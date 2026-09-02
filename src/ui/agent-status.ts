import type { SynthEngine } from '../audio/engine'
import { normToValue, PARAMS, paramIndex } from '../shared/params'
import type { AgentAction, AgentActivitySnapshot } from '../webmcp/activity'
import { el } from './common'
import { guideTarget } from './guide-target'
import './agent-status.css'

const RUNNING: Record<string, string> = {
  get_synth_state: 'Reading synth state', get_parameter_schema: 'Reading parameter schema',
  update_parameters: 'Updating parameters', set_modulation: 'Changing modulation',
  play_notes: 'Playing notes', render_audio: 'Rendering audio', analyze_audio: 'Analyzing synth audio',
  analyze_reference_audio: 'Analyzing reference audio', compare_audio: 'Comparing audio',
  save_preset: 'Saving preset', load_preset: 'Loading preset', get_ui_targets: 'Finding teaching targets',
  show_ui_guide: 'Updating teaching guide', get_history: 'Reading history', navigate_history: 'Restoring sound history',
  replay_history: 'Replaying history', stop_performance: 'Stopping performance'
}

export function actionSentence(action: AgentAction): string {
  if (action.status === 'running') return `${RUNNING[action.tool] ?? action.label}…`
  if (action.status === 'failed' || action.status === 'cancelled') {
    const name = action.tool.replaceAll('_', ' ')
    return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${action.status}: ${action.summary}`
  }
  return action.summary === 'Completed' ? action.label : `${action.label}: ${action.summary}`
}

export function readinessSentence(state: AgentActivitySnapshot): string {
  if (state.toolAvailability === 'unavailable') return 'AI tools unavailable in this browser'
  if (state.toolAvailability === 'checking') return 'Checking AI tools…'
  const ready = `${state.readyTools} tools ready`
  if (state.registrationErrors.length) return `${ready} · ${state.registrationErrors.length} registration failures`
  return `${ready}${state.audioToolsLocked ? ' · Start audio to unlock 1' : ''}`
}

/** Short state word for the single AI button, so the icon never has to carry meaning alone. */
export function stateLabel(state: AgentActivitySnapshot, working: boolean): string {
  if (state.toolAvailability === 'unavailable') return 'AI off'
  if (state.toolAvailability === 'checking') return 'AI starting'
  if (state.toolAvailability === 'error' || state.lastError) return 'AI error'
  if (working) return 'AI working'
  const count = state.pendingChanges.length
  if (count) return `${count} change${count === 1 ? '' : 's'}`
  return 'AI ready'
}

/** Status presentation is separate from tool ownership, history and control markers. */
export class AgentStatus {
  readonly root = el('div', 'agent-ai-strip')
  readonly status = el('button', 'agent-btn agent-status-button')
  private readonly group = el('div', 'agent-ai-group')
  private readonly orb = el('span', 'agent-status-orb')
  private readonly label = el('span', 'agent-status-label')
  private readonly feed = el('div', 'agent-feed')
  private readonly live = el('span', 'agent-live-message')
  private state: AgentActivitySnapshot
  private playing = false
  private burstStart: number | null = null
  private settlingUntil = 0
  private timer?: ReturnType<typeof setTimeout>
  private feedTimer?: ReturnType<typeof setTimeout>
  private feedKey = ''
  private line: HTMLElement | null = null
  private readonly unsubscribe: () => void

  constructor(engine: SynthEngine, state: AgentActivitySnapshot, review: () => void) {
    this.state = state
    this.group.setAttribute('role', 'group')
    this.group.setAttribute('aria-label', 'AI controls')
    this.status.type = 'button'
    this.status.setAttribute('aria-haspopup', 'dialog')
    this.orb.setAttribute('aria-hidden', 'true')
    this.status.append(this.orb, this.label)
    guideTarget(this.group, 'panel.agent.ai', 'AI status and controls', 'panel')
    guideTarget(this.status, 'button.agent.checkpoint', 'AI status and pending changes', 'button')
    // One button, one destination: the activity dialog explains every state, including no AI yet.
    this.status.addEventListener('click', review)
    this.group.append(this.status)
    this.feed.setAttribute('aria-hidden', 'true')
    this.live.setAttribute('role', 'status')
    this.live.setAttribute('aria-atomic', 'true')
    this.root.append(this.group, this.feed, this.live)
    const bpmIndex = paramIndex('master.bpm')
    const updateBpm = () => this.root.style.setProperty('--agent-beat-duration', `${60000 / normToValue(PARAMS[bpmIndex], engine.getParam(bpmIndex))}ms`)
    updateBpm()
    this.unsubscribe = engine.onParam(bpmIndex, updateBpm)
    this.update(state, false)
  }

  update(state: AgentActivitySnapshot, playing: boolean): void {
    this.state = state
    this.playing = playing
    const off = state.toolAvailability === 'unavailable'
    const count = state.pendingChanges.length
    const humanError = state.lastAction?.tool === 'human_checkpoint' && state.lastAction.status === 'failed' ? state.lastAction : null
    const error = state.lastError?.summary ?? state.registrationErrors[0]?.message ?? humanError?.summary
    const label = stateLabel(state, state.activeToolCalls > 0)
    if (this.label.textContent !== label) this.label.textContent = label
    this.status.title = `${readinessSentence(state)}. ${error ? `Error: ${error}. ` : ''}${count} pending AI change${count === 1 ? '' : 's'}. Open activity and review.`
    this.status.setAttribute('aria-label', `AI activity — ${label}: ${count} pending change${count === 1 ? '' : 's'}${error ? ', error' : ''}`)
    this.group.dataset.tone = off ? 'off' : error ? 'error' : count ? 'pending' : 'idle'
    this.renderMotion()
    const action = state.actions.at(-1)
    this.showSentence(humanError ? `human-${humanError.id}` : action ? `tool-${action.id}` : 'readiness',
      humanError ? humanError.summary : action ? actionSentence(action) : readinessSentence(state),
      humanError?.status ?? action?.status ?? (state.toolAvailability === 'error' ? 'failed' : 'idle'))
  }

  private renderMotion(): void {
    clearTimeout(this.timer)
    const active = this.state.activeToolCalls > 0 || this.playing
    if (active) {
      if (this.burstStart === null) this.burstStart = Date.now()
      this.settlingUntil = 0
    }
    if (!active && this.burstStart !== null) {
      const remaining = 2000 - (Date.now() - this.burstStart)
      if (remaining > 0) this.timer = setTimeout(() => { this.renderMotion() }, remaining)
      else { this.burstStart = null; this.settlingUntil = Date.now() + 600 }
    }
    if (!active && this.burstStart === null && this.settlingUntil > Date.now()) {
      this.timer = setTimeout(() => this.renderMotion(), this.settlingUntil - Date.now())
    }
    this.group.dataset.motion = this.state.toolAvailability === 'unavailable' ? 'idle'
      : this.playing ? 'playing' : this.burstStart !== null ? 'working'
      : this.settlingUntil > Date.now() ? 'settling' : 'idle'
  }

  private showSentence(key: string, sentence: string, status: string): void {
    if (key !== this.feedKey) {
      clearTimeout(this.feedTimer)
      const previous = this.line
      this.feed.replaceChildren()
      if (previous) { previous.className = 'agent-feed-line leaving'; this.feed.append(previous) }
      this.line = el('span', `agent-feed-line${previous ? ' entering' : ''}`)
      this.feed.append(this.line)
      this.feedKey = key
      if (previous) this.feedTimer = setTimeout(() => { previous.remove(); this.line?.classList.remove('entering') }, 240)
    }
    if (this.line!.textContent !== sentence) this.line!.textContent = sentence
    this.line!.dataset.status = status
    this.feed.title = sentence
    if (this.live.textContent !== sentence) this.live.textContent = sentence
  }

  dispose(): void {
    this.unsubscribe()
    clearTimeout(this.timer)
    clearTimeout(this.feedTimer)
  }
}
