// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentActivityPanel } from './agent-activity'
import { SynthEngine } from '../audio/engine'
import type { HistoryServices, ReplayEntry, SoundHistoryView } from '../history/types'
import { agentActivityFor } from '../webmcp/activity'

let panel: AgentActivityPanel
let view: SoundHistoryView
let replays: ReplayEntry[]
let services: HistoryServices
let performing: boolean
let aiPerforming: boolean
let engine: SynthEngine
const listeners = new Set<() => void>()
const refresh = () => { for (const listener of listeners) listener() }
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false } })
  view = {
    entries: [
      { id: 'a', parentId: null, label: 'Initial', origin: 'initial', timestamp: 1, changed: [], current: false, activePath: true },
      { id: 'b', parentId: 'a', label: 'Cutoff', origin: 'human', timestamp: 2, changed: ['filter1.cutoff'], changeDetails: [{ id: 'filter1.cutoff', before: '8.00 kHz', after: '12.00 kHz' }], current: true, activePath: true },
      { id: 'c', parentId: 'a', label: 'Earlier AI edit', origin: 'ai', timestamp: 3, changed: ['osc1.level'], current: false, activePath: false }
    ], currentId: 'b', revision: 2, canUndo: true, canRedo: false, gestureActive: false, navigating: false, retainedAssetBytes: 1024
  }
  replays = [{ id: 'g', kind: 'guide', label: 'Pluck guide', timestamp: 1, status: 'completed', steps: [{ title: 'Oscillator' }] }]
  performing = false
  aiPerforming = false
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }
  services = {
    history: { snapshot: () => view, subscribe, navigate: vi.fn().mockResolvedValue(view), beginGesture: vi.fn(), endGesture: vi.fn(), coalesce: vi.fn() },
    replays: { snapshot: () => replays, subscribe, latestPerformanceId: () => [...replays].reverse().find(entry => entry.kind === 'performance')?.id, replay: vi.fn().mockResolvedValue(undefined) },
    performance: { get active() { return performing }, get playing() { return performing }, get aiPlaying() { return aiPerforming }, subscribe, stop: vi.fn().mockResolvedValue(undefined) }
  }
  engine = new SynthEngine()
  agentActivityFor(engine).setToolReadiness(15, true)
  panel = new AgentActivityPanel(engine, services)
  document.body.append(panel.root)
})
afterEach(() => { panel.dispose(); agentActivityFor(engine).dispose(); document.body.replaceChildren(); listeners.clear(); vi.restoreAllMocks(); vi.useRealTimers() })

it('replaces checkpoints with history actions, alternatives and a separate replay tab', () => {
  expect(panel.root.textContent).not.toContain('Checkpoint')
  expect(panel.root.querySelector('[data-guide-id="button.history.undo"]')).not.toBeNull()
  const alternatives = panel.root.querySelector('.history-alternatives') as HTMLDetailsElement
  expect(alternatives.open).toBe(false)
  expect(alternatives.textContent).toContain('Earlier AI edit')
  expect(panel.root.textContent).toContain('120 entries per tab')
  expect(panel.root.textContent).toContain('128 MiB')
  const replayTab = panel.root.querySelector('#history-tab-replays') as HTMLButtonElement
  replayTab.click()
  expect(replayTab.getAttribute('aria-selected')).toBe('true')
  expect((panel.root.querySelector('#history-view-sound') as HTMLElement).hidden).toBe(true)
})

it('retains focused row buttons and expanded details when activity/history refreshes', () => {
  const row = panel.root.querySelector('[data-history-id="a"]')!
  const action = row.querySelector('button')!
  const details = row.querySelector('details')!
  details.open = true
  action.focus()
  refresh()
  expect(panel.root.querySelector('[data-history-id="a"] button')).toBe(action)
  expect(document.activeElement).toBe(action)
  expect(details.open).toBe(true)
})

it('uses icon-only toolbar buttons with accessible labels and keeps Help at the right edge', () => {
  for (const [id, label] of [['undo', 'Undo'], ['redo', 'Redo'], ['open', 'History'], ['play', 'Play again'], ['walkthrough', 'Walkthrough']]) {
    const button = panel.root.querySelector(`[data-guide-id="button.history.${id}"]`)!
    expect(button.textContent).toBe('')
    expect(button.getAttribute('aria-label')).toBe(label)
    expect(button.getAttribute('title')).toContain(label)
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(button.querySelector('svg')?.getAttribute('focusable')).toBe('false')
  }
  const walkthrough = panel.root.querySelector('[data-guide-id="button.history.walkthrough"]')!
  expect(walkthrough.parentElement).toBe(panel.root)
  expect(panel.root.querySelector('.agent-ai-strip')?.nextElementSibling).toBe(walkthrough)
})

it('hides Play again until a performance exists and keeps Stop available during playback', async () => {
  const play = panel.root.querySelector('[data-guide-id="button.history.play"]') as HTMLButtonElement
  expect(play.hidden).toBe(true) // A walkthrough alone is not an audio replay.
  replays.push({ id: 'p', kind: 'performance', label: 'Melody', timestamp: 2, status: 'completed',
    notes: [{ midi: 60, velocity: 0.5, start: 0, duration: 1 }] })
  refresh()
  expect(play.hidden).toBe(false)
  expect(play.disabled).toBe(false)
  play.click()
  await Promise.resolve()
  expect(services.replays.replay).toHaveBeenCalledWith('p', undefined, 'human')
  performing = true
  replays = []
  refresh()
  expect(play.hidden).toBe(false)
  expect(play.disabled).toBe(false)
  expect(play.getAttribute('aria-label')).toBe('Stop')
  expect(play.querySelector('svg')).not.toBeNull()
  play.click()
  await Promise.resolve()
  expect(services.performance.stop).toHaveBeenCalledOnce()
  performing = false
  refresh()
  expect(play.hidden).toBe(true)
  expect(play.getAttribute('aria-label')).toBe('Play again')
  expect(play.querySelector('svg')).not.toBeNull()
})

it('shows one or two valued changes directly, grouping only larger edits under Details', () => {
  const row = panel.root.querySelector('[data-history-id="b"]') as HTMLElement
  expect(row.querySelector('.history-row-changes')?.textContent).toContain('8.00 kHz → 12.00 kHz')
  expect((row.querySelector('details') as HTMLElement).hidden).toBe(true)
  view.entries[1].changed = ['filter1.cutoff', 'filter1.resonance', 'filter1.drive']
  view.entries[1].changeDetails = [
    { id: 'filter1.cutoff', before: '8.00 kHz', after: '12.00 kHz' },
    { id: 'filter1.resonance', before: '20%', after: '50%' },
    { id: 'filter1.drive', before: '0%', after: '5%' }
  ]
  refresh()
  expect((row.querySelector('.history-row-changes') as HTMLElement).hidden).toBe(true)
  expect((row.querySelector('details') as HTMLElement).hidden).toBe(false)
  expect(row.querySelector('details')?.textContent).toContain('20% → 50%')
})

it('closes history before guide replay, without adding or removing replay entries', async () => {
  const open = panel.root.querySelector('[data-guide-id="button.history.open"]') as HTMLButtonElement
  const dialog = panel.root.querySelector('dialog')!
  open.click()
  expect(dialog.open).toBe(true)
  ;(panel.root.querySelector('[data-replay-id="g"] button') as HTMLButtonElement).click()
  expect(dialog.open).toBe(false)
  await Promise.resolve()
  expect(services.replays.replay).toHaveBeenCalledWith('g', undefined, 'human')
  expect(replays).toHaveLength(1)
})

it('disables unavailable operations and drops subscriptions at disposal', () => {
  const redo = panel.root.querySelector('[data-guide-id="button.history.redo"]') as HTMLButtonElement
  const play = panel.root.querySelector('[data-guide-id="button.history.play"]') as HTMLButtonElement
  expect(redo.disabled).toBe(true)
  expect(play.disabled).toBe(true)
  view.navigating = true
  refresh()
  expect((panel.root.querySelector('[data-guide-id="button.history.undo"]') as HTMLButtonElement).disabled).toBe(true)
  expect(listeners.size).toBe(3)
  panel.dispose()
  expect(listeners.size).toBe(0)
})

it('replaces the checkbox with a Bot toggle and allows empty activity review', () => {
  const activity = agentActivityFor(engine)
  const bot = panel.root.querySelector('[data-guide-id="button.agent.show-changes"]') as HTMLButtonElement
  const review = panel.root.querySelector('[data-guide-id="button.agent.checkpoint"]') as HTMLButtonElement
  expect(panel.root.querySelector('input[type="checkbox"]')).toBeNull()
  expect(bot.getAttribute('aria-pressed')).toBe('true')
  bot.click()
  expect(activity.snapshot().showChanges).toBe(false)
  expect(bot.getAttribute('aria-pressed')).toBe('false')
  expect(bot.querySelector('svg')).not.toBeNull()
  expect(review.disabled).toBe(false)
  review.click()
  expect((panel.root.querySelector('[data-guide-id="dialog.agent-changes"]') as HTMLDialogElement).open).toBe(true)
  expect(panel.root.querySelector('.agent-feed')?.textContent).toBe('15 tools ready · Start audio to unlock 2')
})

it('uses a 2s minimum activity burst, a 600ms settle, and BPM playback priority', async () => {
  vi.useFakeTimers()
  const activity = agentActivityFor(engine)
  const group = panel.root.querySelector('.agent-ai-group') as HTMLElement
  const first = activity.startAction('get_synth_state')
  const second = activity.startAction('update_parameters')
  activity.finishAction(second, 'update_parameters', {}, { applied: [{ id: 'osc1.level' }] })
  expect(group.dataset.motion).toBe('working')
  vi.advanceTimersByTime(2100)
  expect(group.dataset.motion).toBe('working') // The older call still owns busy state.
  performing = true
  refresh()
  expect(group.dataset.motion).toBe('working')
  aiPerforming = true
  refresh()
  expect(group.dataset.motion).toBe('playing')
  engine.setParamById('master.bpm', 0.5) // 160 BPM, normalized.
  expect((panel.root.querySelector('.agent-ai-strip') as HTMLElement).style.getPropertyValue('--agent-beat-duration')).toBe('375ms')
  performing = false
  aiPerforming = false
  refresh()
  expect(group.dataset.motion).toBe('working')
  activity.finishAction(first, 'get_synth_state', {}, {})
  expect(group.dataset.motion).toBe('settling')
  vi.advanceTimersByTime(599)
  expect(group.dataset.motion).toBe('settling')
  vi.advanceTimersByTime(1)
  expect(group.dataset.motion).toBe('idle')
  const quick = activity.startAction('get_synth_state')
  activity.finishAction(quick, 'get_synth_state', {}, {})
  vi.advanceTimersByTime(1999)
  expect(group.dataset.motion).toBe('working')
  vi.advanceTimersByTime(1)
  expect(group.dataset.motion).toBe('settling')
  panel.dispose()
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps the AI status idle for a manually started replay', () => {
  const group = panel.root.querySelector('.agent-ai-group') as HTMLElement
  performing = true
  aiPerforming = false
  refresh()
  expect(group.dataset.motion).toBe('idle')
  expect(group.querySelector('.agent-status-orb')?.getAttribute('style')).toBeNull()
})

it('updates completion in place, retains concurrent failures and keeps the feed bounded', () => {
  vi.useFakeTimers()
  const activity = agentActivityFor(engine)
  const first = activity.startAction('render_audio')
  const second = activity.startAction('get_synth_state')
  activity.finishAction(second, 'get_synth_state', {}, {})
  activity.failAction(first, 'render_audio', new Error('Recording failed'))
  const group = panel.root.querySelector('.agent-ai-group') as HTMLElement
  expect(group.dataset.tone).toBe('error')
  expect(panel.root.querySelectorAll('.agent-tool-call')).toHaveLength(2)
  expect(panel.root.querySelector(`[data-action-id="${first}"]`)?.textContent).toContain('Recording failed')
  const third = activity.startAction('get_parameter_schema')
  expect(group.dataset.tone).toBe('error')
  activity.finishAction(third, 'get_parameter_schema', {}, {})
  expect(group.dataset.tone).toBe('idle')
  expect(panel.root.querySelectorAll('.agent-tool-call')).toHaveLength(3)
  expect(panel.root.querySelectorAll('.agent-feed-line').length).toBeLessThanOrEqual(2)
  vi.advanceTimersByTime(240)
  expect(panel.root.querySelectorAll('.agent-feed-line')).toHaveLength(1)
  expect(panel.root.querySelector('.agent-feed')?.textContent).toBe('Read parameter schema')
  engine.setParamById('osc1.level', 0.1, 'ai')
  expect(group.dataset.tone).toBe('pending')
  activity.setShowChanges(false)
  expect(group.dataset.tone).toBe('pending') // Hiding markers is not acceptance.
  activity.acceptCheckpoint()
  expect(group.dataset.tone).toBe('idle')
  expect(panel.root.querySelectorAll('.agent-tool-call')).toHaveLength(3)
})

it('shows capability-specific help with Escape and outside-click dismissal', () => {
  const activity = agentActivityFor(engine)
  const bot = panel.root.querySelector('[data-guide-id="button.agent.show-changes"]') as HTMLButtonElement
  const help = panel.root.querySelector('.app-popover') as HTMLElement
  activity.setToolReadiness(0, true, { available: false })
  expect(panel.root.querySelector('.agent-ai-group')?.getAttribute('data-tone')).toBe('off')
  expect(bot.hasAttribute('aria-pressed')).toBe(false)
  bot.click()
  expect(help.hidden).toBe(false)
  expect(help.textContent).toContain('ChatGPT Desktop')
  expect(document.activeElement).toBe(help)
  help.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(help.hidden).toBe(true)
  expect(document.activeElement).toBe(bot)
  activity.setToolReadiness(0, true, { available: true, errors: [{ tool: 'get_synth_state', message: 'Denied' }] })
  bot.click()
  expect(help.textContent).toContain('registration failed')
  expect(help.textContent).not.toContain('ChatGPT Desktop')
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  expect(help.hidden).toBe(true)
  activity.setToolReadiness(17, false, { available: true })
  expect(bot.getAttribute('aria-pressed')).toBe('true')
})
