import type { SynthEngine } from '../audio/engine'
import type { HistoryServices, ReplayEntry, SoundEntrySummary } from '../history/types'
import { agentActivityFor, type AgentActivitySnapshot, type AgentActivityStore } from '../webmcp/activity'
import { el } from './common'
import { ModalDialog } from './dialog'
import { guideTarget } from './guide-target'
import { Undo2, Redo2, History as HistoryIcon, CircleHelp, Play, Spotlight, Square } from 'lucide'
import { changeSummary } from './agent-change-summary'
import { iconButton, setButtonIcon } from './icon-button'
import { AgentStatus, actionSentence, readinessSentence } from './agent-status'

function button(label: string): HTMLButtonElement {
  const node = el('button', 'agent-btn', label)
  node.type = 'button'
  return node
}

/** `decayT60Ms` is null whenever a sound never decayed, so no comparison figure exists. */
function comparisonLine(metric: string, value: { candidate: number | null; delta: number | null }): string {
  if (value.candidate === null) return `${metric}: not measurable`
  const delta = value.delta === null ? '' : ` (${value.delta >= 0 ? '+' : ''}${value.delta.toFixed(2)})`
  return `${metric}: ${value.candidate.toFixed(2)}${delta}`
}

/** Different from the welcome tour's list on purpose: a second set of ideas to try. */
const PROMPT_IDEAS = [
  'Build me a rubbery acid bass.',
  'Make a glassy bell pluck with a long tail.',
  'Give this more air and less mud.',
  'Wobble the filter in time with the beat.',
  'Play a dreamy four-chord loop.',
  'Compare this to the preset I started from.',
  'Teach me how the envelope shapes the attack.'
]

function invitation(state: AgentActivitySnapshot): string {
  if (state.toolAvailability === 'unavailable') {
    return 'Nothing yet — this browser can’t reach the AI tools. Open coSynth in ChatGPT Desktop’s in-app browser and ChatGPT can design sounds with you here. Keep playing meanwhile.'
  }
  if (state.toolAvailability === 'checking') return 'Getting the AI tools ready. Once they are up, ask ChatGPT for a sound and every move it makes shows up here.'
  if (state.toolAvailability === 'error') return 'The AI tools failed to register. Reload the page, or reopen coSynth in ChatGPT Desktop’s in-app browser.'
  return 'Nothing yet. Ask ChatGPT in the chat next to this page — every parameter it touches lands here for you to keep or reject.'
}

interface HistoryRow { root: HTMLElement; label: HTMLElement; meta: HTMLElement; direct: HTMLElement; details: HTMLElement; action: HTMLButtonElement; signature: string }

/** One view for human and AI edits, with a separate list of replayable actions. */
export class AgentActivityPanel {
  readonly root = el('section', 'panel agent-activity-panel')
  private readonly undo = iconButton('Undo', Undo2)
  private readonly redo = iconButton('Redo', Redo2)
  private readonly play = iconButton('Play again', Play)
  private readonly replayGuide = iconButton('Restart AI walkthrough', Spotlight)
  private readonly indicator: AgentStatus
  private readonly activity: AgentActivityStore
  private readonly dialogError = el('span', 'history-error')
  private readonly dialog = new ModalDialog('History', 'history')
  private readonly reviewDialog = new ModalDialog('AI activity', 'agent-changes')
  private readonly readiness = el('p', 'agent-empty')
  private readonly activityError = el('p', 'history-error')
  private readonly toolLog = el('details', 'agent-tool-log')
  private readonly toolLogSummary = el('summary', '', 'Tool calls (0)')
  private readonly toolLogList = el('ol', 'agent-tool-log-list')
  private logSignature = ''
  private readonly explainer = el('p', '', 'Reject undoes only pending AI changes and adds one sound-history entry. Your manual edits are kept. Editing a route, LFO shape, or FX order makes that whole unit yours.')
  private readonly changeCount = el('h3', 'agent-section-title')
  private readonly changeList = el('div', 'agent-param-list')
  private readonly onboarding = el('div', 'agent-modal-section agent-onboarding')
  private readonly onboardingText = el('p', 'agent-empty')
  private readonly comparison = el('div', 'agent-modal-section')
  private readonly keep = button('Keep changes')
  private readonly reject = button('Reject changes')
  private reviewSignature = ''
  private readonly soundTab = button('Sound history')
  private readonly replayTab = button('Replays')
  private readonly soundList = el('div', 'history-list')
  private readonly alternatives = el('details', 'history-alternatives')
  private readonly alternativeList = el('div', 'history-list')
  private readonly replayList = el('div', 'history-list')
  private readonly soundView = el('div', 'history-view')
  private readonly replayView = el('div', 'history-view')
  private readonly retention = el('p', 'history-retention')
  private readonly soundRows = new Map<string, HistoryRow>()
  private readonly replayRows = new Map<string, HistoryRow>()
  private readonly disposeListeners: (() => void)[] = []
  private state: AgentActivitySnapshot
  private pending = 0
  private disposed = false

  constructor(engine: SynthEngine, private readonly services: HistoryServices, openWalkthrough: () => void = () => {}) {
    const activity = this.activity = agentActivityFor(engine)
    this.state = activity.snapshot()
    const open = iconButton('History', HistoryIcon)
    open.classList.add('agent-history-open')
    const walkthrough = iconButton('Walkthrough', CircleHelp)
    walkthrough.classList.add('agent-walkthrough')
    this.indicator = new AgentStatus(engine, this.state, () => this.reviewDialog.open())
    guideTarget(this.root, 'panel.agent', 'History and agent activity', 'panel')
    for (const [node, id, label] of [
      [this.undo, 'undo', 'Undo sound edit'], [this.redo, 'redo', 'Redo sound edit'],
      [open, 'open', 'Open history'], [this.play, 'play', 'Replay or stop performance'],
      [this.replayGuide, 'spotlight', 'Restart latest AI walkthrough'],
      [walkthrough, 'walkthrough', 'Open walkthrough']
    ] as const) guideTarget(node, `button.history.${id}`, label, 'button')
    this.undo.title = 'Undo (⌘/Ctrl+Z)'
    this.redo.title = 'Redo (⌘/Ctrl+Shift+Z)'
    this.undo.addEventListener('click', () => this.navigate('undo'))
    this.redo.addEventListener('click', () => this.navigate('redo'))
    open.addEventListener('click', () => this.dialog.open())
    this.replayGuide.addEventListener('click', () => {
      const id = [...services.replays.snapshot()].reverse().find(entry => entry.kind === 'guide')?.id
      if (id) this.run(() => services.replays.replay(id, undefined, 'human'))
    })
    walkthrough.addEventListener('click', openWalkthrough)
    this.play.addEventListener('click', () => {
      if (services.performance.active) this.run(() => services.performance.stop())
      else {
        const id = services.replays.latestPerformanceId()
        // This is an explicit human action. Do not let replay provenance inherit
        // from the original AI-created performance.
        if (id) this.run(() => services.replays.replay(id, undefined, 'human'))
      }
    })
    const actions = el('div', 'agent-activity-actions')
    actions.setAttribute('role', 'group')
    actions.setAttribute('aria-label', 'History, playback, and help')
    actions.append(this.undo, this.redo, open, this.play)
    const guideActions = el('div', 'agent-guide-actions')
    guideActions.append(this.replayGuide, walkthrough)
    this.keep.addEventListener('click', () => {
      if (activity.acceptCheckpoint()) this.reviewDialog.close()
    })
    this.reject.addEventListener('click', () => {
      if (activity.restoreCheckpoint()) this.reviewDialog.close()
    })
    this.toolLog.append(this.toolLogSummary, el('p', 'agent-empty', 'Latest 100 tool calls, kept in this tab until reload.'), this.toolLogList)
    const ideas = el('ul', 'agent-onboarding-prompts')
    ideas.append(...PROMPT_IDEAS.map(idea => el('li', '', idea)))
    this.onboarding.append(el('h3', 'agent-section-title', 'Design a sound with AI'), this.onboardingText, ideas)
    this.reviewDialog.body.append(this.readiness, this.activityError, this.explainer,
      this.onboarding, this.changeCount, this.changeList, this.comparison, this.toolLog
    )
    this.reviewDialog.footer.append(this.keep, this.reject)
    this.activityError.setAttribute('role', 'alert')
    this.dialogError.setAttribute('role', 'alert')
    this.root.append(actions, this.indicator.root, guideActions, this.dialog.root, this.reviewDialog.root)

    const tabs = el('div', 'history-tabs')
    tabs.setAttribute('role', 'tablist')
    tabs.setAttribute('aria-label', 'History views')
    for (const [tab, id, view] of [[this.soundTab, 'sound', this.soundView], [this.replayTab, 'replays', this.replayView]] as const) {
      tab.setAttribute('role', 'tab')
      tab.id = `history-tab-${id}`
      tab.setAttribute('aria-controls', `history-view-${id}`)
      view.id = `history-view-${id}`
      view.setAttribute('role', 'tabpanel')
      view.setAttribute('aria-labelledby', tab.id)
      tab.addEventListener('click', () => this.selectTab(id))
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const next = event.key === 'Home' ? 'sound' : event.key === 'End' ? 'replays' : id === 'sound' ? 'replays' : 'sound'
        this.selectTab(next)
        ;(next === 'sound' ? this.soundTab : this.replayTab).focus()
      })
    }
    tabs.append(this.soundTab, this.replayTab)
    this.alternatives.append(el('summary', '', 'Earlier alternatives'), this.alternativeList)
    this.soundView.append(this.soundList, this.alternatives)
    this.replayView.append(el('p', 'agent-empty', 'Performances use the current sound. Walkthroughs reopen at step one.'), this.replayList)
    this.dialog.body.append(tabs, this.soundView, this.replayView)
    this.dialog.footer.append(this.dialogError, this.retention)
    this.selectTab('sound')
    this.disposeListeners.push(
      activity.subscribe(state => { this.state = state; this.render() }),
      services.history.subscribe(() => this.render()),
      services.replays.subscribe(() => this.render()),
      services.performance.subscribe(() => this.render())
    )
    this.render()
  }

  dispose(): void {
    this.disposed = true
    for (const unsubscribe of this.disposeListeners) unsubscribe()
    this.dialog.close()
    this.reviewDialog.close()
    this.indicator.dispose()
  }

  private selectTab(tab: 'sound' | 'replays'): void {
    this.soundView.hidden = tab !== 'sound'
    this.replayView.hidden = tab !== 'replays'
    for (const [button, active] of [[this.soundTab, tab === 'sound'], [this.replayTab, tab === 'replays']] as const) {
      button.setAttribute('aria-selected', String(active))
      button.tabIndex = active ? 0 : -1
    }
  }

  private navigate(action: 'undo' | 'redo' | 'restore', id?: string): void {
    this.run(() => this.services.history.navigate(action, id))
  }

  private run(action: () => Promise<unknown>): void {
    this.dialogError.textContent = ''
    // Do not lock Stop behind a playback promise that resolves only when audio ends.
    this.pending++
    this.render()
    void Promise.resolve().then(action).catch(error => {
      if (error instanceof Error && error.name === 'AbortError') return
      if (!this.disposed) {
        this.dialogError.textContent = error instanceof Error ? error.message : String(error)
        this.activity.reportHumanError(error)
      }
    }).finally(() => {
      this.pending--
      if (!this.disposed) this.render()
    })
  }

  private render(): void {
    if (this.disposed) return
    const { history, replays, performance } = this.services
    const view = history.snapshot()
    const busy = view.navigating
    this.renderReview(busy || view.gestureActive || performance.active || this.state.performanceActive)
    this.undo.disabled = !view.canUndo || busy
    this.redo.disabled = !view.canRedo || busy
    const playLabel = performance.active ? 'Stop' : 'Play again'
    if (this.play.getAttribute('aria-label') !== playLabel) setButtonIcon(this.play, playLabel, performance.active ? Square : Play)
    const hasPerformance = !!replays.latestPerformanceId()
    this.play.hidden = !performance.active && !hasPerformance
    this.play.disabled = !performance.active && (this.pending > 0 || !hasPerformance || busy)
    this.indicator.update(this.state, performance.aiPlaying)
    this.retention.textContent = `In memory only · Up to 120 entries per tab · Older assets: ${(view.retainedAssetBytes / 1048576).toFixed(1)} / 128 MiB · Reload clears history.`
    const ids = new Set(view.entries.map(entry => entry.id))
    for (const [id, row] of this.soundRows) if (!ids.has(id)) { row.root.remove(); this.soundRows.delete(id) }
    for (const entry of view.entries) {
      let row = this.soundRows.get(entry.id)
      if (!row) {
        row = this.createRow(() => this.navigate('restore', entry.id), 'Restore')
        this.soundRows.set(entry.id, row)
      }
      this.updateSound(row, entry, busy)
    }
    this.placeRows(this.soundList, view.entries.filter(entry => entry.activePath).map(entry => this.soundRows.get(entry.id)!.root))
    this.placeRows(this.alternativeList, view.entries.filter(entry => !entry.activePath).map(entry => this.soundRows.get(entry.id)!.root))
    this.alternatives.hidden = !view.entries.some(entry => !entry.activePath)
    const entries = replays.snapshot()
    this.replayGuide.hidden = !entries.some(entry => entry.kind === 'guide')
    const replayIds = new Set(entries.map(entry => entry.id))
    for (const [id, row] of this.replayRows) if (!replayIds.has(id)) { row.root.remove(); this.replayRows.delete(id) }
    for (const entry of entries) {
      let row = this.replayRows.get(entry.id)
      if (!row) {
        row = this.createRow(() => {
          this.dialog.close()
          this.run(() => this.services.replays.replay(entry.id, undefined, 'human'))
        }, entry.kind === 'guide' ? 'Open walkthrough' : 'Play again')
        this.replayRows.set(entry.id, row)
      }
      this.updateReplay(row, entry, busy || performance.active)
    }
    this.placeRows(this.replayList, entries.map(entry => this.replayRows.get(entry.id)!.root))
    this.replayList.dataset.empty = entries.length ? '' : 'No saved performances or walkthroughs yet.'
  }

  private renderReview(busy: boolean): void {
    const count = this.state.pendingChanges.length
    this.readiness.textContent = readinessSentence(this.state)
    this.activityError.textContent = [this.state.lastError?.summary,
      this.state.lastAction?.tool === 'human_checkpoint' && this.state.lastAction.status === 'failed' ? this.state.lastAction.summary : null,
      ...this.state.registrationErrors.map(error => `${error.tool}: ${error.message}`)].filter(Boolean).join('\n')
    const logSignature = JSON.stringify(this.state.actions)
    if (logSignature !== this.logSignature) {
      this.logSignature = logSignature
      this.toolLogSummary.textContent = `Tool calls (${this.state.actions.length})`
      this.toolLogList.replaceChildren(...[...this.state.actions].reverse().map(action => {
        const row = el('li', 'agent-tool-call', actionSentence(action))
        row.dataset.actionId = String(action.id)
        row.dataset.status = action.status
        return row
      }))
    }
    this.keep.disabled = this.reject.disabled = !count || busy
    // Nothing has happened yet: invite the user in instead of explaining a reject they cannot do.
    const fresh = !count && !this.state.actions.length
    this.keep.hidden = this.reject.hidden = this.explainer.hidden = !count
    this.onboarding.hidden = !fresh
    this.changeCount.hidden = this.changeList.hidden = fresh
    this.onboardingText.textContent = invitation(this.state)
    const signature = JSON.stringify([this.state.pendingChanges, this.state.comparison])
    if (signature === this.reviewSignature) return
    this.reviewSignature = signature
    this.changeCount.textContent = `Pending changes (${count})`
    this.changeList.replaceChildren(...(count
      ? this.state.pendingChanges.map(change => el('div', 'agent-field', changeSummary(change)))
      : [el('span', 'agent-empty', 'No pending AI changes.')]))
    this.comparison.replaceChildren(el('h3', 'agent-section-title', 'Latest comparison'))
    this.comparison.hidden = !this.state.comparison
    if (!this.state.comparison) this.comparison.append(el('p', 'agent-empty', 'No comparison result yet.'))
    else {
      this.comparison.append(el('p', '', `${Math.round(this.state.comparison.similarity * 100)}% similarity`))
      for (const [metric, value] of Object.entries(this.state.comparison.details)) {
        this.comparison.append(el('div', 'history-comparison', comparisonLine(metric, value)))
      }
    }
  }

  private createRow(onClick: () => void, actionLabel: string): HistoryRow {
    const root = el('article', 'history-row')
    const label = el('strong', 'history-row-label')
    const meta = el('span', 'history-row-meta')
    const direct = el('div', 'history-row-changes')
    const details = el('details', 'history-row-details')
    details.append(el('summary', '', 'Details'), el('div', 'history-change-list'))
    const action = button(actionLabel)
    action.addEventListener('click', onClick)
    const head = el('div', 'history-row-head')
    const text = el('div', 'history-row-text')
    text.append(label, meta)
    head.append(text, action)
    root.append(head, direct, details)
    return { root, label, meta, direct, details, action, signature: '' }
  }

  private updateSound(row: HistoryRow, entry: SoundEntrySummary, busy: boolean): void {
    row.label.textContent = `${entry.current ? 'Current · ' : ''}${entry.label}`
    row.root.classList.toggle('current', entry.current)
    row.root.dataset.historyId = entry.id
    row.meta.textContent = `${entry.origin === 'ai' ? 'AI' : entry.origin === 'initial' ? 'Starting sound' : 'Human'} · ${new Date(entry.timestamp).toLocaleTimeString()}`
    row.action.disabled = entry.current || busy
    const grouped = entry.changed.length > 2
    row.direct.hidden = !entry.changed.length || grouped
    row.details.hidden = !grouped && !entry.comparison
    const signature = JSON.stringify([entry.changed, entry.changeDetails, entry.comparison])
    if (signature === row.signature) return
    row.signature = signature
    const change = (id: string) => entry.changeDetails?.find(detail => detail.id === id)
    const changeNodes = entry.changed.map(id => {
      const detail = change(id)
      return detail ? el('span', 'history-change', `${id}: ${detail.before} → ${detail.after}`) : el('code', 'agent-param', id)
    })
    row.direct.replaceChildren(...(grouped ? [] : changeNodes))
    const content = row.details.lastElementChild!
    content.replaceChildren(...(grouped ? changeNodes : []))
    if (entry.comparison) {
      content.append(el('p', '', `${Math.round(entry.comparison.similarity * 100)}% similarity`))
      for (const [metric, value] of Object.entries(entry.comparison.details)) {
        content.append(el('div', 'history-comparison', comparisonLine(metric, value)))
      }
    }
  }

  private updateReplay(row: HistoryRow, entry: ReplayEntry, busy: boolean): void {
    row.label.textContent = entry.label
    row.root.dataset.replayId = entry.id
    row.meta.textContent = `${entry.kind === 'guide' ? 'Walkthrough' : 'Performance'} · ${entry.status} · ${new Date(entry.timestamp).toLocaleTimeString()}`
    row.action.disabled = busy
    const signature = JSON.stringify([entry.notes?.length, entry.steps?.length, entry.duration])
    if (signature !== row.signature) {
      row.signature = signature
      row.details.lastElementChild!.textContent = entry.kind === 'guide' ? `${entry.steps?.length ?? 0} steps` : `${entry.notes?.length ?? 0} notes${entry.duration === undefined ? '' : ` · ${entry.duration.toFixed(2)} seconds`}`
    }
  }

  /** Keep existing nodes in place unless the actual order changed, preserving focus/details. */
  private placeRows(parent: HTMLElement, rows: HTMLElement[]): void {
    rows.forEach((row, index) => {
      if (parent.children[index] !== row) parent.insertBefore(row, parent.children[index] ?? null)
    })
  }
}
