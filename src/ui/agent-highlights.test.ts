// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SynthEngine } from '../audio/engine'
import { paramIndex } from '../shared/params'
import { AgentActivityStore } from '../webmcp/activity'
import { AgentHighlights } from './agent-highlights'
import { guideTarget } from './guide-target'
import { ModMatrix } from './matrix'
import { paramSelect, paramToggle } from './controls'
import { changeSummary } from './agent-change-summary'

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
const summaryOf = (element: HTMLElement) => (element.getAttribute('aria-describedby') ?? '').split(' ')
  .map(id => document.getElementById(id)?.textContent ?? '').join(' ')

describe('shared AI highlights', () => {
  let engine: SynthEngine
  let store: AgentActivityStore
  let root: HTMLElement
  let highlights: AgentHighlights
  const target = (id: string, tag = 'div') => {
    const element = guideTarget(document.createElement(tag), id, id)
    root.append(element)
    return element
  }

  beforeEach(() => {
    engine = new SynthEngine()
    store = new AgentActivityStore(engine)
    root = document.createElement('div')
    document.body.append(root)
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 10, bottom: 60, left: 10, right: 60, width: 50, height: 50 } as DOMRect)
    highlights = new AgentHighlights(root, store)
  })
  afterEach(() => {
    highlights.dispose()
    store.dispose()
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('uses the same marker for knobs, native dropdowns, sliders and buttons without changing layout or names', async () => {
    const knob = target('param.osc1.morph')
    knob.className = 'knob'
    const select = paramSelect(engine, 'filter1.type')
    const button = paramToggle(engine, 'filter2.enabled', '●')
    const slider = target('param.macro1.value', 'input') as HTMLInputElement
    slider.type = 'range'
    root.append(select, button)
    const ids = ['osc1.morph', 'filter1.type', 'filter2.enabled', 'macro1.value']
    ids.forEach(id => engine.setParamById(id, 1, 'ai'))
    await flush()
    for (const element of [knob, select, slider, button]) {
      expect(element.classList.contains('ai-changed')).toBe(true)
      expect(element.classList.contains('ai-change-pulse')).toBe(true)
      expect(element.style.position).toBe('')
      expect(element.style.width).toBe('')
      expect(element.style.height).toBe('')
      expect(element.hasAttribute('tabindex')).toBe(false)
      expect(element.getAttribute('aria-label')).toBeNull()
    }
    expect(button.textContent).toBe('●')
    expect(select.options).toHaveLength(9)
  })

  it('adds hover/focus descriptions without losing existing help or accessible descriptions', async () => {
    const button = target('param.filter2.enabled', 'button')
    button.title = 'Enable filter'
    button.setAttribute('aria-describedby', 'existing-help')
    engine.setParamById('filter2.enabled', 1, 'ai')
    await flush()
    expect(button.title).toBe('Enable filter')
    expect(summaryOf(button)).toContain('AI changed')
    expect(button.getAttribute('aria-describedby')).toMatch(/^existing-help ai-change-/)
    button.focus()
    const tooltip = root.querySelector<HTMLElement>('[role="tooltip"]')!
    expect(tooltip.hidden).toBe(false)
    expect(tooltip.textContent).toContain('AI changed filter2 On')
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(tooltip.hidden).toBe(true)
    store.acceptCheckpoint()
    await flush()
    expect(button.title).toBe('Enable filter')
    expect(button.getAttribute('aria-describedby')).toBe('existing-help')
  })

  it('does not pulse pending changes mounted later or when visibility is toggled', async () => {
    engine.setParamById('osc1.morph', 0.7, 'ai')
    await flush()
    const knob = target('param.osc1.morph')
    await flush()
    expect(knob.classList.contains('ai-changed')).toBe(true)
    expect(knob.classList.contains('ai-change-pulse')).toBe(false)
    store.setShowChanges(false)
    await flush()
    expect(knob.classList.contains('ai-changed')).toBe(false)
    expect(store.snapshot().pendingChanges).toHaveLength(1)
    store.setShowChanges(true)
    await flush()
    expect(knob.classList.contains('ai-changed')).toBe(true)
    expect(knob.classList.contains('ai-change-pulse')).toBe(false)
  })

  it('does not pulse preexisting state when the controller is mounted', async () => {
    highlights.dispose()
    const knob = target('param.osc1.morph')
    engine.setParamById('osc1.morph', 0.8, 'ai')
    highlights = new AgentHighlights(root, store)
    await flush()
    expect(knob.classList.contains('ai-changed')).toBe(true)
    expect(knob.classList.contains('ai-change-pulse')).toBe(false)
  })

  it('marks tabs and restores rebuilt controls without replaying their pulse', async () => {
    const tab = target('tab.env2', 'button')
    engine.setParamById('env2.attack', 0.8, 'ai')
    await flush()
    expect(tab.classList.contains('ai-changed')).toBe(true)
    let knob = target('param.env2.attack')
    await flush()
    expect(knob.classList.contains('ai-change-pulse')).toBe(false)
    knob.remove()
    knob = target('param.env2.attack')
    await flush()
    expect(knob.classList.contains('ai-changed')).toBe(true)
    expect(root.querySelectorAll('.ai-change-descriptions > span')).toHaveLength(2)
    engine.setParamById('env2.attack', 0.4)
    await flush()
    expect(root.querySelectorAll('.ai-changed')).toHaveLength(0)
  })

  it('keeps hidden controls passive and binds the shared LFO canvas to the selected LFO', async () => {
    const hidden = target('param.env3.attack')
    hidden.hidden = true
    const canvas = target('visualizer.lfo')
    canvas.dataset.aiTarget = 'lfo.0'
    const tab = target('tab.lfo2', 'button')
    engine.setParamById('env3.attack', 0.8, 'ai')
    engine.setLfoShape(1, [{ x: 0, y: 1, power: 0 }, { x: 1, y: 0, power: 0 }], 'ai')
    await flush()
    expect(hidden.classList.contains('ai-change-pulse')).toBe(false)
    expect(canvas.classList.contains('ai-changed')).toBe(false)
    expect(tab.classList.contains('ai-changed')).toBe(true)
    canvas.dataset.aiTarget = 'lfo.1'
    await flush()
    expect(canvas.classList.contains('ai-changed')).toBe(true)
    expect(canvas.classList.contains('ai-change-pulse')).toBe(false)
    canvas.dataset.aiTarget = 'lfo.0'
    await flush()
    expect(canvas.classList.contains('ai-changed')).toBe(false)
  })

  it('marks rebuilt matrix fields and surviving targets of a removed route', async () => {
    const panel = target('panel.matrix', 'section')
    panel.append(new ModMatrix(engine).root)
    const cutoff = target('param.filter1.cutoff')
    const route = { source: 1, dest: paramIndex('filter1.cutoff'), depth: 0.3, enabled: true }
    engine.setModSlot(4, route, 'ai')
    await flush()
    expect(panel.querySelectorAll('.ai-changed')).toHaveLength(4)
    store.acceptCheckpoint()
    engine.setModSlot(4, { ...route, depth: 0.7 }, 'ai')
    await flush()
    expect(panel.querySelectorAll('.ai-changed')).toHaveLength(1)
    expect(panel.querySelector('.ai-changed')?.getAttribute('data-guide-id')).toBe('matrix.slot4.depth')
    engine.setModSlot(4, null, 'ai')
    await flush()
    expect(panel.querySelector('.matrix-row')).toBeNull()
    expect(panel.classList.contains('ai-changed')).toBe(true)
    expect(summaryOf(cutoff)).toContain('Route 5 removed')
    expect(summaryOf(cutoff)).not.toContain('Cutoff:')
    store.restoreCheckpoint()
    await flush()
    expect(root.querySelectorAll('.ai-changed')).toHaveLength(0)
    expect(panel.querySelector('.matrix-row')).not.toBeNull()
  })

  it('retains disabled state and clears all markers when disposed', async () => {
    const panel = document.createElement('section')
    panel.className = 'is-disabled'
    root.append(panel)
    const knob = target('param.osc2.morph')
    panel.append(knob)
    engine.setParamById('osc2.morph', 0.9, 'ai')
    await flush()
    expect(panel.className).toBe('is-disabled')
    expect(knob.classList.contains('ai-changed')).toBe(true)
    highlights.dispose()
    expect(knob.classList.contains('ai-changed')).toBe(false)
    expect(knob.hasAttribute('aria-describedby')).toBe(false)
    engine.setParamById('osc2.morph', 0.8, 'ai')
    await flush()
    expect(root.querySelector('.ai-changed')).toBeNull()
  })

  it('provides structural FX and LFO summaries rather than pretending their base parameters changed', async () => {
    const fx = target('panel.fx')
    engine.setFxOrder([...engine.fxOrder].reverse(), 'ai')
    await flush()
    expect(summaryOf(fx)).toContain('FX order:')
    expect(changeSummary({ kind: 'lfo', index: 0, before: [{ x: 0, y: 0, power: 0 }], after: [{ x: 0, y: 1, power: 0 }], key: 'lfo.0', revision: 1 }))
      .toContain('point positions or curves changed')
  })

  it('allows the 1s hold and 600ms transition, then stays still for no-op writes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const knob = target('param.osc1.morph')
    engine.setParamById('osc1.morph', 0.3, 'ai')
    await flush()
    expect(knob.classList.contains('ai-change-pulse')).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(knob.classList.contains('ai-change-pulse')).toBe(true)
    vi.advanceTimersByTime(599)
    expect(knob.classList.contains('ai-change-pulse')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(knob.classList.contains('ai-change-pulse')).toBe(false)
    expect(knob.classList.contains('ai-changed')).toBe(true)
    engine.setParamById('osc1.morph', 0.3, 'ai')
    await flush()
    expect(knob.classList.contains('ai-change-pulse')).toBe(false)
  })

  it('restarts the arrival animation for a new revision and cancels it on human takeover', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const knob = target('param.osc1.morph')
    engine.setParamById('osc1.morph', 0.3, 'ai')
    await flush()
    vi.advanceTimersByTime(1200)
    engine.setParamById('osc1.morph', 0.4, 'ai')
    await flush()
    vi.advanceTimersByTime(400)
    expect(knob.classList.contains('ai-change-pulse')).toBe(true)
    engine.setParamById('osc1.morph', 0.5)
    await flush()
    expect(knob.classList.contains('ai-changed')).toBe(false)
    expect(knob.classList.contains('ai-change-pulse')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('scatters batch timing without cutting animations short and cancels delayed markers on manual edits', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(1)
    const first = target('param.osc1.morph')
    const second = target('param.osc1.level')
    const third = target('param.osc1.pan')
    engine.setParamById('osc1.morph', 0.3, 'ai')
    engine.setParamById('osc1.level', 0.4, 'ai')
    engine.setParamById('osc1.pan', 0.6, 'ai')
    await flush()
    expect(first.style.getPropertyValue('--ai-change-delay')).toBe('')
    expect(second.style.getPropertyValue('--ai-change-delay')).toBe('25ms')
    expect(third.style.getPropertyValue('--ai-change-delay')).toBe('500ms')
    engine.setParamById('osc1.level', 0.5)
    await flush()
    expect(second.classList.contains('ai-change-pulse')).toBe(false)
    expect(second.style.getPropertyValue('--ai-change-delay')).toBe('')
    vi.advanceTimersByTime(1600)
    expect(first.classList.contains('ai-change-pulse')).toBe(false)
    expect(third.classList.contains('ai-change-pulse')).toBe(true)
    vi.advanceTimersByTime(499)
    expect(third.classList.contains('ai-change-pulse')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(third.classList.contains('ai-change-pulse')).toBe(false)
    expect(third.style.getPropertyValue('--ai-change-delay')).toBe('')
    expect(third.classList.contains('ai-changed')).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a human slider input clears ownership of the entire route and Reject keeps it', async () => {
    const panel = target('panel.matrix', 'section')
    panel.append(new ModMatrix(engine).root)
    engine.setModSlot(4, { source: 1, dest: paramIndex('filter1.cutoff'), depth: 0.3, enabled: true }, 'ai')
    engine.setParamById('osc1.morph', 0.8, 'ai')
    await flush()
    const slider = panel.querySelector<HTMLInputElement>('input[type="range"]')!
    slider.value = '45'
    slider.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    expect(panel.querySelectorAll('.ai-changed')).toHaveLength(0)
    expect(store.snapshot().pendingChanges).toHaveLength(1)
    store.restoreCheckpoint()
    expect(engine.modSlots[4]?.depth).toBe(0.45)
    expect(engine.getParam(paramIndex('osc1.morph'))).toBe(0)
  })
})
