// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentActivityPanel } from './agent-activity'
import { SynthEngine } from '../audio/engine'
import type { HistoryServices, ReplayEntry, SoundHistoryView } from '../history/types'

let panel: AgentActivityPanel
let view: SoundHistoryView
let replays: ReplayEntry[]
let services: HistoryServices
let performing: boolean
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
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }
  services = {
    history: { snapshot: () => view, subscribe, navigate: vi.fn().mockResolvedValue(view), beginGesture: vi.fn(), endGesture: vi.fn(), coalesce: vi.fn() },
    replays: { snapshot: () => replays, subscribe, latestPerformanceId: () => [...replays].reverse().find(entry => entry.kind === 'performance')?.id, replay: vi.fn().mockResolvedValue(undefined) },
    performance: { get active() { return performing }, subscribe, stop: vi.fn().mockResolvedValue(undefined) }
  }
  panel = new AgentActivityPanel(new SynthEngine(), services)
  document.body.append(panel.root)
})
afterEach(() => { panel.dispose(); document.body.replaceChildren(); listeners.clear(); vi.restoreAllMocks() })

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

it('adds decorative icons without replacing the toolbar labels', () => {
  for (const [id, label] of [['undo', 'Undo'], ['redo', 'Redo'], ['open', 'History'], ['play', 'Play again']]) {
    const button = panel.root.querySelector(`[data-guide-id="button.history.${id}"]`)!
    expect(button.textContent).toBe(label)
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(button.querySelector('svg')?.getAttribute('focusable')).toBe('false')
  }
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
  expect(services.replays.replay).toHaveBeenCalledWith('p')
  performing = true
  replays = []
  refresh()
  expect(play.hidden).toBe(false)
  expect(play.disabled).toBe(false)
  expect(play.textContent).toBe('Stop')
  expect(play.querySelector('svg')).not.toBeNull()
  play.click()
  await Promise.resolve()
  expect(services.performance.stop).toHaveBeenCalledOnce()
  performing = false
  refresh()
  expect(play.hidden).toBe(true)
  expect(play.textContent).toBe('Play again')
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
  expect(services.replays.replay).toHaveBeenCalledWith('g')
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
