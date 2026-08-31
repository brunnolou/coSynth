// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { cancelKnobDrag, KNOB_DRAG_END, startKnobDrag } from './knob-drag'
import { bindHistoryInteractions } from './history-bindings'
import { SynthEngine } from '../audio/engine'
import { createHistoryServices } from '../history/services'
import { paramDef, paramIndex } from '../shared/params'
import { snapKnobValue } from './knob-value'
import type { UiGuideController } from './guide'

describe('knob drag', () => {
  let canvas: HTMLCanvasElement
  let lock: Element | null
  let captured: boolean
  let value: number
  let finish: Mock<() => void>
  let change: Mock<(value: number) => void>
  let snap: (value: number) => number
  let disposeHistory: (() => void) | undefined
  const pointer = (type: string, options: PointerEventInit = {}, target: EventTarget = canvas) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, clientY: 100, ...options })
    Object.defineProperties(event, {
      pointerId: { value: options.pointerId ?? 1 }, pointerType: { value: options.pointerType ?? 'mouse' }
    })
    target.dispatchEvent(event)
    return event
  }
  const mouseMove = (movementY: number, options: MouseEventInit = {}) => {
    const event = new MouseEvent('mousemove', { bubbles: true, buttons: 1, ...options })
    Object.defineProperty(event, 'movementY', { value: movementY })
    canvas.dispatchEvent(event)
  }
  const grant = (element: Element = canvas) => {
    lock = element
    document.dispatchEvent(new Event('pointerlockchange'))
  }
  const legacyLock = () => { canvas.requestPointerLock = vi.fn(() => undefined) as unknown as typeof canvas.requestPointerLock }
  beforeEach(() => {
    canvas = document.createElement('canvas')
    const knob = document.createElement('div')
    knob.className = 'knob'
    knob.dataset.guideLabel = 'Cutoff'
    knob.append(canvas)
    document.body.append(knob)
    lock = null
    captured = false
    value = 0.5
    snap = value => value
    finish = vi.fn()
    change = vi.fn((v: number) => { value = v })
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => lock })
    Object.defineProperty(document, 'exitPointerLock', { configurable: true, value: vi.fn(() => {
      lock = null
      document.dispatchEvent(new Event('pointerlockchange'))
    }) })
    canvas.setPointerCapture = vi.fn(() => { captured = true })
    canvas.hasPointerCapture = vi.fn(() => captured)
    canvas.releasePointerCapture = vi.fn(() => { captured = false })
    canvas.addEventListener('pointerdown', e => startKnobDrag(canvas, e, value, change, finish, snap))
  })
  afterEach(() => {
    cancelKnobDrag(document)
    // Settle pending legacy requests as a browser denial would.
    document.dispatchEvent(new Event('pointerlockerror'))
    disposeHistory?.()
    disposeHistory = undefined
    document.body.replaceChildren()
    delete (document as unknown as Record<string, unknown>).pointerLockElement
    delete (document as unknown as Record<string, unknown>).exitPointerLock
    delete (document as unknown as Record<string, unknown>).hidden
    vi.restoreAllMocks()
  })

  it('falls back to captured dragging, supports Cmd changes without jumping, and reverses at bounds', () => {
    pointer('pointerdown')
    pointer('pointermove', { clientY: 80 })
    expect(value).toBeCloseTo(.6)
    pointer('pointermove', { clientY: 60, metaKey: true })
    expect(value).toBeCloseTo(.61)
    pointer('pointermove', { clientY: 50 })
    expect(value).toBeCloseTo(.66)
    pointer('pointermove', { clientY: -1000 })
    expect(value).toBe(1)
    pointer('pointermove', { clientY: -990 })
    expect(value).toBeCloseTo(.95)
    pointer('pointerup')
    expect(captured).toBe(false)
    expect(finish).toHaveBeenCalledOnce()
    pointer('pointermove', { clientY: 0 })
    expect(value).toBeCloseTo(.95)
  })

  it('uses unbounded mouse deltas while locked and ignores duplicate pointer moves', () => {
    legacyLock()
    pointer('pointerdown')
    pointer('pointermove', { clientY: 99 })
    expect(canvas.requestPointerLock).toHaveBeenCalledOnce()
    grant()
    pointer('lostpointercapture')
    expect(finish).not.toHaveBeenCalled()
    pointer('pointermove', { clientY: -10000 })
    expect(value).toBeCloseTo(.505)
    mouseMove(-30)
    mouseMove(-20, { metaKey: true })
    expect(value).toBeCloseTo(.665)
    expect(change).toHaveBeenCalledTimes(3)
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }))
    expect(lock).toBeNull()
    expect(finish).toHaveBeenCalledOnce()
    mouseMove(-30)
    expect(change).toHaveBeenCalledTimes(3)
  })

  it('snaps Shift drags to eighths and switches to Cmd fine without hidden remainder jumps', () => {
    value = .375
    pointer('pointerdown', { shiftKey: true })
    pointer('pointermove', { clientX: 10, shiftKey: true })
    expect(value).toBe(.375)
    pointer('pointermove', { clientX: 22, shiftKey: true })
    expect(value).toBe(.5)
    pointer('pointermove', { clientX: 42, shiftKey: true, metaKey: true })
    expect(value).toBeCloseTo(.51)
    pointer('pointermove', { clientX: 52 })
    expect(value).toBeCloseTo(.56)
  })

  it('accumulates small movements between real octave stops, including in fine mode', () => {
    value = 1 / 3
    snap = value => snapKnobValue(paramDef('sub.octave'), value)
    pointer('pointerdown')
    for (let x = 1; x <= 40; x++) pointer('pointermove', { clientX: x })
    expect(value).toBe(2 / 3)
    expect(change.mock.calls.every(([v]) => [1 / 3, 2 / 3].includes(v))).toBe(true)
    pointer('pointermove', { clientX: 0, metaKey: true })
    expect(value).toBe(2 / 3)
    pointer('pointermove', { clientX: -340, metaKey: true })
    expect(value).toBe(1 / 3)
  })

  it('applies Shift snapping with Pointer Lock', () => {
    value = .375
    legacyLock()
    pointer('pointerdown', { shiftKey: true })
    pointer('pointermove', { clientY: 99, shiftKey: true })
    grant()
    mouseMove(-22, { shiftKey: true })
    expect(value).toBe(.5)
    mouseMove(45, { shiftKey: true })
    expect(value).toBe(.25)
  })

  it.each(['throw', 'reject', 'legacy-error'] as const)('keeps normal dragging when pointer lock fails via %s', async mode => {
    canvas.requestPointerLock = vi.fn(() => {
      if (mode === 'throw') throw new Error('Unsupported')
      if (mode === 'reject') return Promise.reject(new Error('Denied'))
      return undefined
    }) as unknown as typeof canvas.requestPointerLock
    pointer('pointerdown')
    if (mode === 'legacy-error') document.dispatchEvent(new Event('pointerlockerror'))
    await Promise.resolve()
    pointer('pointermove', { clientY: 80 })
    expect(value).toBeCloseTo(.6)
    expect(finish).not.toHaveBeenCalled()
    pointer('pointerup')
    expect(finish).toHaveBeenCalledOnce()
  })

  it.each(['touch', 'pen'])('uses capture, not pointer lock, for %s', pointerType => {
    legacyLock()
    pointer('pointerdown', { pointerType })
    pointer('pointermove', { pointerType, clientY: 80 })
    expect(canvas.requestPointerLock).not.toHaveBeenCalled()
    expect(value).toBeCloseTo(.6)
  })

  it.each(['pointercancel', 'lostpointercapture', 'blur', 'hidden', 'pagehide', 'escape', 'released', 'dispose'])('ends the drag safely on %s', reason => {
    pointer('pointerdown')
    pointer('pointermove', { clientY: 80 })
    if (reason === 'hidden') {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true })
      document.dispatchEvent(new Event('visibilitychange'))
    } else if (reason === 'escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    else if (reason === 'released') pointer('pointermove', { clientY: 0, buttons: 0 })
    else if (reason === 'dispose') cancelKnobDrag(document)
    else if (reason === 'blur' || reason === 'pagehide') window.dispatchEvent(new Event(reason))
    else pointer(reason)
    expect(finish).toHaveBeenCalledOnce()
    expect(captured).toBe(false)
    pointer('pointermove', { clientY: 0 })
    expect(value).toBeCloseTo(.6)
    // No manual reset is needed to start the next gesture.
    pointer('pointerdown')
    pointer('pointermove', { clientY: 80 })
    expect(value).toBeCloseTo(.7)
  })

  it('stops after native pointer lock loss and leaves other locks alone', () => {
    legacyLock()
    pointer('pointerdown')
    pointer('pointermove', { clientY: 99 })
    grant()
    mouseMove(-20)
    grant(document.body)
    expect(finish).toHaveBeenCalledOnce()
    expect(document.exitPointerLock).not.toHaveBeenCalled()
    pointer('pointermove', { clientY: 0 })
    expect(value).toBeCloseTo(.605)
  })

  it('releases pointer lock on Escape and ignores subsequent movement', () => {
    legacyLock()
    pointer('pointerdown')
    grant()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(lock).toBeNull()
    mouseMove(-20)
    expect(value).toBe(.5)
    expect(finish).toHaveBeenCalledOnce()
  })

  it('handles release before a legacy lock grant without trapping the cursor or ending a newer drag', () => {
    legacyLock()
    pointer('pointerdown')
    pointer('pointermove', { clientY: 99 })
    pointer('pointerup')
    pointer('pointerdown')
    expect(canvas.requestPointerLock).toHaveBeenCalledOnce()
    grant()
    expect(lock).toBeNull()
    expect(finish).toHaveBeenCalledOnce()
    pointer('pointermove', { clientY: 80 })
    expect(value).toBeCloseTo(.605)
  })

  it('releases a late Promise grant after disposal', async () => {
    let resolve!: () => void
    canvas.requestPointerLock = vi.fn(() => new Promise<void>(r => { resolve = r }))
    pointer('pointerdown')
    pointer('pointermove', { clientY: 99 })
    cancelKnobDrag(document)
    lock = canvas
    resolve()
    await Promise.resolve()
    expect(lock).toBeNull()
    expect(finish).toHaveBeenCalledOnce()
  })

  it('does not let a settled old request release a newer lock on the same knob', async () => {
    let resolve!: () => void
    canvas.requestPointerLock = vi.fn(() => new Promise<void>(r => { resolve = r }))
    pointer('pointerdown')
    pointer('pointermove', { clientY: 99 })
    grant()
    pointer('pointerup')
    legacyLock()
    pointer('pointerdown')
    pointer('pointermove', { clientY: 99 })
    grant()
    resolve()
    await Promise.resolve()
    expect(lock).toBe(canvas)
    mouseMove(-20)
    expect(value).toBeCloseTo(.61)
  })

  it('cleans up when a dynamic knob is removed and notifies history on window', async () => {
    const end = vi.fn()
    window.addEventListener(KNOB_DRAG_END, end, { once: true })
    legacyLock()
    pointer('pointerdown')
    grant()
    canvas.remove()
    await Promise.resolve()
    expect(finish).toHaveBeenCalledOnce()
    expect(end).toHaveBeenCalledWith(expect.objectContaining({ detail: { pointerId: 1 } }))
    expect(lock).toBeNull()
  })

  it('ignores secondary buttons and unrelated pointers and survives capture failure', () => {
    pointer('pointerdown', { button: 2 })
    pointer('pointermove', { clientY: 80 })
    expect(change).not.toHaveBeenCalled()
    canvas.setPointerCapture = vi.fn(() => { throw new Error('Capture unavailable') })
    pointer('pointerdown')
    pointer('pointermove', { pointerId: 2, clientY: 80 })
    pointer('pointerup', { pointerId: 2 })
    expect(change).not.toHaveBeenCalled()
    expect(finish).not.toHaveBeenCalled()
    pointer('pointermove', { clientY: 80 }, window)
    expect(value).toBeCloseTo(.6)
    pointer('pointerup', {}, window)
    expect(finish).toHaveBeenCalledOnce()
  })

  it('keeps locked edits in one undo step and ends History on capture loss or keyboard Undo', async () => {
    const engine = new SynthEngine()
    const index = paramIndex('filter1.cutoff')
    engine.setParam(index, .5)
    const services = createHistoryServices(engine, {} as UiGuideController)
    disposeHistory = () => { disposeBindings(); services.dispose() }
    const disposeBindings = bindHistoryInteractions(document.body, services.history, error => { throw error })
    change.mockImplementation((v: number) => { value = v; engine.setParam(index, v) })
    legacyLock()
    pointer('pointerdown')
    grant()
    pointer('lostpointercapture')
    await Promise.resolve()
    expect(services.history.snapshot().gestureActive).toBe(true)
    mouseMove(-20)
    mouseMove(-20)
    expect(() => services.history.runAi('AI edit', () => {})).toThrow(/human edit/)
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }))
    await Promise.resolve()
    expect(services.history.snapshot()).toMatchObject({ gestureActive: false, canUndo: true })
    expect(services.history.snapshot().entries).toHaveLength(2)
    await services.history.navigate('undo')
    expect(engine.getParam(index)).toBeCloseTo(.5)
    value = engine.getParam(index)
    pointer('pointerdown')
    document.dispatchEvent(new Event('pointerlockerror'))
    pointer('pointermove', { clientY: 80 })
    pointer('lostpointercapture')
    await Promise.resolve()
    expect(services.history.snapshot().gestureActive).toBe(false)
    pointer('pointerdown')
    grant()
    mouseMove(-20)
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
    await Promise.resolve()
    await Promise.resolve()
    expect(lock).toBeNull()
    expect(services.history.snapshot().gestureActive).toBe(false)
    const restored = engine.getParam(index)
    mouseMove(-20)
    expect(engine.getParam(index)).toBe(restored)
  })
})
