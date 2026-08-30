import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SynthEngine } from '../audio/engine'
import { paramIndex } from '../shared/params'
import { generateWavetable } from '../shared/wavetable-gen'
import { OscWavePreview } from './osc-wave-preview'

// Minimal DOM stand-in keeps these controller tests independent of browser packages.
// Native focus, layout, and event bubbling are verified in the browser smoke check.
class ElementStub extends EventTarget {
  className = ''
  style = {}
  children: ElementStub[] = []
  private attributes = new Map<string, string>()
  classList = {
    toggle: (name: string, enabled: boolean) => {
      const names = new Set(this.className.split(' ').filter(Boolean))
      if (enabled) names.add(name)
      else names.delete(name)
      this.className = [...names].join(' ')
    }
  }
  appendChild(child: ElementStub) { this.children.push(child); return child }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  removeAttribute(name: string) { this.attributes.delete(name) }
  set tabIndex(value: number) { this.setAttribute('tabindex', String(value)) }
  set title(value: string) { this.setAttribute('title', value) }
  get title() { return this.getAttribute('title') ?? '' }
  getContext() { return {} }
  click() { this.dispatchEvent(new Event('click')) }
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: () => new ElementStub() })
  vi.stubGlobal('ResizeObserver', class { observe() {} })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function setup() {
  const engine = new SynthEngine()
  engine.primeTables()
  const previews = [0, 1, 2].map(osc => new OscWavePreview(engine, osc))
  return { engine, previews }
}

describe('OscWavePreview snap interaction', () => {
  it.each([0, 1, 2])('updates only oscillator %i base morph without starting audio or enabling it', osc => {
    const { engine, previews } = setup()
    engine.setParam(paramIndex(`osc${osc + 1}.sync`), 0.5)
    const before = engine.values.slice()
    const index = paramIndex(`osc${osc + 1}.morph`)
    const notified = vi.fn()
    engine.onParam(index, notified)
    previews[osc].root.click()
    before[index] = 1 / 3
    expect(engine.values).toEqual(before)
    expect(engine.running).toBe(false)
    expect(notified).toHaveBeenCalledOnce()
    expect(previews[osc].root.title).toContain('Base shape: Triangle. Next: Saw.')
  })

  it('cycles from base morph, preserving modulation and sync', () => {
    const { engine, previews } = setup()
    engine.setModSlot(0, { source: 0, dest: paramIndex('osc1.morph'), depth: 0.8, enabled: true })
    engine.sourceValues[0] = 1
    engine.setParam(paramIndex('osc1.sync'), 0.5)
    const routes = structuredClone(engine.modSlots)
    previews[0].root.click()
    expect(engine.getParam(paramIndex('osc1.morph'))).toBeCloseTo(1 / 3)
    expect(engine.modSlots).toEqual(routes)
    expect(engine.getParam(paramIndex('osc1.sync'))).toBe(0.5)
    expect(previews[0].animated).toBe(true)
  })

  it('updates the tooltip for continuous morph changes and wraps after Square', () => {
    const { engine, previews } = setup()
    engine.setParam(paramIndex('osc1.morph'), 0.5)
    expect(previews[0].root.title).toContain('Base shape: between shapes. Next: Saw.')
    previews[0].root.click()
    expect(previews[0].root.title).toContain('Base shape: Saw. Next: Square.')
    previews[0].root.click()
    previews[0].root.click()
    expect(engine.getParam(paramIndex('osc1.morph'))).toBe(0)
  })

  it.each(['Enter', ' '])('activates once on %s, prevents scrolling, and ignores repeats', key => {
    const { engine, previews } = setup()
    const click = vi.spyOn(previews[0].root, 'click')
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key, repeat: false })
    previews[0].root.dispatchEvent(event)
    previews[0].root.dispatchEvent(Object.assign(new Event('keydown'), { key, repeat: true }))
    previews[0].root.dispatchEvent(Object.assign(new Event('keyup'), { key }))
    expect(click).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(true)
    expect(engine.getParam(paramIndex('osc1.morph'))).toBeCloseTo(1 / 3)
  })

  it('removes stale interaction when the table changes and restores it for Basic Shapes', () => {
    const { engine, previews } = setup()
    engine.setParam(paramIndex('osc1.wavetable'), 1 / 6)
    const root = previews[0].root
    expect(root.getAttribute('role')).toBeNull()
    expect(root.getAttribute('tabindex')).toBeNull()
    expect(root.getAttribute('title')).toBeNull()
    root.click()
    expect(engine.getParam(paramIndex('osc1.morph'))).toBe(0)
    engine.setParam(paramIndex('osc1.wavetable'), 0)
    expect(root.getAttribute('role')).toBe('button')
    expect(root.getAttribute('tabindex')).toBe('0')
    root.click()
    expect(engine.getParam(paramIndex('osc1.morph'))).toBeCloseTo(1 / 3)
  })

  it('treats a single authored anchor as passive', () => {
    const engine = new SynthEngine()
    engine.currentTables[0] = { ...generateWavetable('Basic Shapes'), snapPoints: [{ label: 'Sine', position: 0 }] }
    const preview = new OscWavePreview(engine, 0)
    expect(preview.root.getAttribute('role')).toBeNull()
    preview.root.click()
    expect(engine.getParam(paramIndex('osc1.morph'))).toBe(0)
  })
})
