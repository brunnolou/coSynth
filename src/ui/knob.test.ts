// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SynthEngine } from '../audio/engine'
import { MOD_SOURCES } from '../shared/messages'
import { defaultNorm, normToValue, PARAMS, paramIndex } from '../shared/params'
import { Knob, sourceBadge } from './knob'
import { setControlGated } from './controls'
import { ACCENT_COLOR, closePopup } from './common'
import styleCss from '../style.css?raw'

const context = {
  clearRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), stroke: vi.fn(), fill: vi.fn(),
  moveTo: vi.fn(), lineTo: vi.fn(), scale: vi.fn(),
  strokeStyle: '', fillStyle: '', lineWidth: 0, lineCap: ''
}

describe('Knob', () => {
  let engine: SynthEngine
  let knob: Knob
  let canvas: HTMLCanvasElement
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
    engine = new SynthEngine()
    knob = new Knob(engine, paramIndex('osc1.morph'))
    document.body.append(knob.root)
    canvas = knob.root.querySelector('canvas')!
    canvas.requestPointerLock = vi.fn(() => undefined) as unknown as typeof canvas.requestPointerLock
  })
  afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

  it('keeps native double-click reset available before Pointer Lock starts', () => {
    const index = paramIndex('osc1.morph')
    const set = vi.spyOn(engine, 'setParam')
    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(set).toHaveBeenCalledOnce()
    expect(set).toHaveBeenCalledWith(index, defaultNorm(PARAMS[index]))
    expect(canvas.requestPointerLock).not.toHaveBeenCalled()
  })

  it('uses Cmd for fine wheel changes and Shift for 12.5% stops', () => {
    const index = paramIndex('osc1.morph')
    engine.setParam(index, .45)
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, metaKey: true }))
    expect(engine.getParam(index)).toBeCloseTo(.452)
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, shiftKey: true }))
    expect(engine.getParam(index)).toBeCloseTo(.5)
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, shiftKey: true }))
    expect(engine.getParam(index)).toBeCloseTo(.375)
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 0 }))
    expect(engine.getParam(index)).toBeCloseTo(.375)
  })

  it('keeps octave wheel changes on real stops, even with modifiers', () => {
    const index = paramIndex('sub.octave')
    const sub = new Knob(engine, index)
    const subCanvas = sub.root.querySelector('canvas')!
    for (const modifiers of [{}, { metaKey: true }, { shiftKey: true }]) {
      engine.setParam(index, 1 / 3)
      subCanvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, ...modifiers }))
      expect(engine.getParam(index)).toBeCloseTo(2 / 3)
      expect(normToValue(PARAMS[index], engine.getParam(index))).toBe(-1)
      subCanvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, ...modifiers }))
      expect(engine.getParam(index)).toBeCloseTo(1 / 3)
    }
  })

  it('draws discrete progress at the actual step even for unsnapped imported values', () => {
    const index = paramIndex('sub.octave')
    const sub = new Knob(engine, index)
    engine.setParam(index, .55)
    context.arc.mockClear()
    sub.draw()
    const [, , , start, end] = context.arc.mock.calls[1]
    expect(start).toBeCloseTo(.75 * Math.PI)
    expect(end).toBeCloseTo(.75 * Math.PI + 1.5 * Math.PI * 2 / 3)
  })

  it.each(['osc1.morph', 'osc1.pan', 'osc1.transpose'])('omits the blue value stroke at zero for %s', id => {
    const index = paramIndex(id)
    engine.setParam(index, id === 'osc1.morph' ? 0 : .5)
    const zeroKnob = new Knob(engine, index)
    const strokes: string[] = []
    context.stroke.mockImplementation(() => { strokes.push(context.strokeStyle) })
    zeroKnob.draw()
    expect(strokes).not.toContain(ACCENT_COLOR)
    engine.setParam(index, .8)
    expect(strokes).toContain(ACCENT_COLOR)
  })

  // A SYNC pair gates the bypassed half by putting `.is-gated` on the whole knob root.
  // lfoN.rate and delay.time are the two knobs people actually modulate, so gating one
  // must not strand the route that lives on it.
  describe('gated by a SYNC toggle', () => {
    const env2 = MOD_SOURCES.findIndex(s => s.id === 'env2')
    let index: number
    let time: Knob

    beforeEach(() => {
      index = paramIndex('delay.time')
      time = new Knob(engine, index)
      document.body.append(time.root)
      engine.addModRoute(env2, index)
      setControlGated(time.root, true)
    })

    it('still opens the mod menu, so an existing route can be inspected and removed', () => {
      vi.useFakeTimers()  // showPopup defers wiring its outside-click closer
      try {
        expect(engine.routesForDest(index)).toHaveLength(1)
        time.root.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
        vi.runAllTimers()
        const menu = document.querySelector('.mod-menu')
        expect(menu).not.toBeNull()
        const chips = [...menu!.querySelectorAll('.mod-chip')].map(c => c.textContent)
        expect(chips).toEqual([MOD_SOURCES[env2].name])
        ;(menu!.querySelector('.mod-del') as HTMLButtonElement).click()
        expect(engine.routesForDest(index)).toHaveLength(0)
      } finally {
        closePopup()
        vi.useRealTimers()
      }
    })

    it('makes only the canvas stack inert, leaving the knob root live', () => {
      // jsdom does not apply the stylesheet, so pin the rules the behaviour rests on:
      // a blanket `.is-gated { pointer-events: none }` reaching the root would kill the
      // mod menu and the drag-to-assign drop target along with the value drag.
      const css = styleCss.replace(/\s+/g, ' ')
      expect(css).toContain('.knob.is-gated { pointer-events: auto; }')
      expect(css).toContain('.knob.is-gated .knob-canvases { pointer-events: none; }')
      // Value editing is bound to the canvas (inside the inert stack); the mod menu to the root.
      const stack = time.root.querySelector('.knob-canvases')!
      expect(stack.contains(time.root.querySelector('canvas'))).toBe(true)
      expect(stack.contains(time.root)).toBe(false)
    })

    it('is still a drag-to-assign drop target', () => {
      engine.setModSlot(engine.routesForDest(index)[0].slot, null)
      // The drop resolves its target with elementFromPoint(...).closest('.knob'), which
      // only reaches a knob whose root keeps its pointer events.
      const label = time.root.querySelector('.knob-label') as Element
      document.elementFromPoint = vi.fn(() => label)
      const badge = sourceBadge(engine, 'env2')
      document.body.append(badge)
      badge.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 5, clientY: 5 }))
      expect(engine.routesForDest(index)).toHaveLength(1)
      expect(engine.routesForDest(index)[0].state.source).toBe(env2)
    })
  })
})
