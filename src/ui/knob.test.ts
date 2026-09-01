// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SynthEngine } from '../audio/engine'
import { defaultNorm, normToValue, PARAMS, paramIndex } from '../shared/params'
import { Knob } from './knob'
import { ACCENT_COLOR } from './common'

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

})
