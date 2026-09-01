// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SoundHistoryService } from './types'
import { bindHistoryInteractions, isTextEditing } from '../ui/history-bindings'
import { Keyboard } from '../ui/keyboard'
import { ModMatrix } from '../ui/matrix'
import type { SynthEngine } from '../audio/engine'

describe('history interaction bindings', () => {
  let app: HTMLElement
  let dispose: () => void
  const history = {
    beginGesture: vi.fn(), endGesture: vi.fn(), coalesce: vi.fn(), navigate: vi.fn().mockResolvedValue({}),
    subscribe: vi.fn(() => () => {}), snapshot: vi.fn(() => ({ navigating: false }))
  } as unknown as SoundHistoryService
  const error = vi.fn()
  beforeEach(() => {
    vi.clearAllMocks()
    app = document.createElement('main')
    document.body.append(app)
    dispose = bindHistoryInteractions(app, history, error)
  })
  afterEach(() => { dispose(); document.body.replaceChildren() })
  const key = (target: EventTarget, key: string, modifiers: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, bubbles: true, cancelable: true, ...modifiers })
    target.dispatchEvent(event)
    return event
  }
  it('handles Mac and Windows/Linux undo/redo before normal keyboard handlers', () => {
    const native = vi.fn()
    window.addEventListener('keydown', native)
    expect(key(app, 'z', { metaKey: true }).defaultPrevented).toBe(true)
    key(app, 'z', { ctrlKey: true, shiftKey: true })
    key(app, 'y', { ctrlKey: true })
    expect(history.navigate).toHaveBeenNthCalledWith(1, 'undo')
    expect(history.navigate).toHaveBeenNthCalledWith(2, 'redo')
    expect(history.navigate).toHaveBeenNthCalledWith(3, 'redo')
    expect(native).not.toHaveBeenCalled()
    window.removeEventListener('keydown', native)
  })
  it('preserves native undo in text fields, textareas, and contenteditable descendants', () => {
    for (const tag of ['input', 'textarea', 'div']) {
      const node = document.createElement(tag)
      if (tag === 'div') node.setAttribute('contenteditable', 'true')
      app.append(node)
      expect(isTextEditing(node)).toBe(true)
      expect(key(node, 'z', { metaKey: true }).defaultPrevented).toBe(false)
    }
    expect(history.navigate).not.toHaveBeenCalled()
    const range = document.createElement('input')
    range.type = 'range'
    app.append(range)
    expect(isTextEditing(range)).toBe(false)
    key(range, 'z', { ctrlKey: true })
    expect(history.navigate).toHaveBeenCalledWith('undo')
  })
  it('starts pointer gesture before mutations and ends after the final pointerup mutation', async () => {
    const knob = document.createElement('div')
    knob.className = 'knob'
    knob.dataset.guideLabel = 'Cutoff'
    app.append(knob)
    const events: string[] = []
    vi.mocked(history.beginGesture).mockImplementation(() => events.push('begin'))
    vi.mocked(history.endGesture).mockImplementation(() => events.push('end'))
    knob.addEventListener('pointerdown', () => events.push('down'))
    knob.addEventListener('pointerup', () => events.push('final change'))
    for (const type of ['pointerdown', 'pointerup']) {
      const event = new Event(type, { bubbles: true })
      Object.defineProperties(event, { pointerId: { value: 1 }, button: { value: 0 } })
      knob.dispatchEvent(event)
    }
    expect(events).toEqual(['begin', 'down', 'final change'])
    await Promise.resolve()
    expect(events).toEqual(['begin', 'down', 'final change', 'end'])
  })
  it('groups wheel and keyboard slider edits by stable control ID', () => {
    const knob = document.createElement('div')
    knob.className = 'knob'
    knob.dataset.guideId = 'param.cutoff'
    knob.dataset.guideLabel = 'Cutoff'
    const range = document.createElement('input')
    range.type = 'range'
    range.dataset.guideId = 'matrix.slot0.depth'
    range.dataset.guideLabel = 'Depth'
    app.append(knob, range)
    knob.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
    key(range, 'ArrowRight')
    expect(history.coalesce).toHaveBeenNthCalledWith(1, 'param.cutoff', 'Cutoff')
    expect(history.coalesce).toHaveBeenNthCalledWith(2, 'matrix.slot0.depth', 'Depth')
  })
  it('reports navigation errors and removes all global listeners on dispose', async () => {
    const failure = new Error('No undo available')
    vi.mocked(history.navigate).mockRejectedValueOnce(failure)
    key(app, 'z', { ctrlKey: true })
    await Promise.resolve()
    expect(error).toHaveBeenCalledWith(failure)
    dispose()
    vi.mocked(history.navigate).mockClear()
    key(app, 'z', { metaKey: true })
    expect(history.navigate).not.toHaveBeenCalled()
  })
  it('cancels a captured drag before Undo so moves cannot mutate again without pointerdown', () => {
    const knob = document.createElement('div')
    knob.className = 'knob'
    const canvas = document.createElement('canvas')
    knob.append(canvas)
    app.append(knob)
    let dragging = false
    const mutate = vi.fn()
    const release = vi.fn()
    canvas.hasPointerCapture = () => true
    canvas.releasePointerCapture = release
    canvas.addEventListener('pointerdown', () => { dragging = true })
    canvas.addEventListener('pointercancel', () => { dragging = false })
    canvas.addEventListener('pointermove', () => { if (dragging) mutate() })
    const down = new Event('pointerdown', { bubbles: true })
    Object.defineProperties(down, { pointerId: { value: 4 }, button: { value: 0 } })
    canvas.dispatchEvent(down)
    canvas.dispatchEvent(new Event('pointermove'))
    key(app, 'z', { metaKey: true })
    canvas.dispatchEvent(new Event('pointermove'))
    expect(mutate).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledWith(4)
    expect(history.navigate).toHaveBeenCalledWith('undo')
  })
  it('ends pending wheel or MIDI coalescing before discrete buttons, selects and resets', () => {
    const events: string[] = []
    vi.mocked(history.endGesture).mockImplementation(() => events.push('boundary'))
    const toggle = document.createElement('button')
    const select = document.createElement('select')
    const knob = document.createElement('div')
    knob.className = 'knob'
    app.append(toggle, select, knob)
    toggle.addEventListener('click', () => events.push('toggle'))
    select.addEventListener('change', () => events.push('select'))
    knob.addEventListener('dblclick', () => events.push('reset'))
    toggle.click()
    select.dispatchEvent(new Event('change', { bubbles: true }))
    knob.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(events).toEqual(['boundary', 'toggle', 'boundary', 'select', 'boundary', 'reset'])
  })
  it('groups body-mounted modulation menu sliders without tracking unrelated document inputs', async () => {
    const menu = document.createElement('div')
    menu.className = 'mod-menu'
    const slider = document.createElement('input')
    slider.type = 'range'
    slider.dataset.guideId = 'mod-menu.slot1.depth'
    slider.dataset.guideLabel = 'LFO 2 modulation depth'
    menu.append(slider)
    document.body.append(menu)
    key(slider, 'ArrowRight')
    expect(history.coalesce).toHaveBeenCalledWith('mod-menu.slot1.depth', 'LFO 2 modulation depth')
    const down = new Event('pointerdown', { bubbles: true })
    Object.defineProperties(down, { pointerId: { value: 8 }, button: { value: 0 } })
    slider.dispatchEvent(down)
    expect(history.beginGesture).toHaveBeenCalledWith('LFO 2 modulation depth')
    const up = new Event('pointerup', { bubbles: true })
    Object.defineProperty(up, 'pointerId', { value: 8 })
    slider.dispatchEvent(up)
    await Promise.resolve()
    expect(history.endGesture).toHaveBeenCalled()
    vi.mocked(history.coalesce).mockClear()
    document.body.append(slider)
    key(slider, 'ArrowRight')
    expect(history.coalesce).not.toHaveBeenCalled()
  })
})

describe('keyboard shortcut isolation', () => {
  it('never changes octave or plays notes for modified shortcuts, and removes listeners', () => {
    const unsubscribe = vi.fn()
    const engine = { noteOn: vi.fn(), noteOff: vi.fn(), onNote: vi.fn(() => unsubscribe) }
    const keyboard = new Keyboard(engine as unknown as SynthEngine)
    document.body.append(keyboard.root)
    const originalOctave = keyboard.root.querySelector('.oct-label')!.textContent
    for (const code of ['KeyZ', 'KeyX', 'KeyA', 'KeyY']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, ctrlKey: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { code, metaKey: true }))
    }
    expect(keyboard.root.querySelector('.oct-label')!.textContent).toBe(originalOctave)
    expect(engine.noteOn).not.toHaveBeenCalled()
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA' }))
    expect(engine.noteOn).toHaveBeenCalledOnce()
    keyboard.dispose()
    expect(engine.noteOff).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS' }))
    expect(engine.noteOn).toHaveBeenCalledOnce()
    keyboard.root.remove()
  })
})

describe('matrix controls', () => {
  it('keeps the matrix depth knob and focus during live updates and uses current slot values', () => {
    let listener = () => {}
    const slots = [{ source: 6, dest: 0, depth: .2, enabled: true }]
    const engine = {
      modSlots: slots,
      onMatrixChange: (fn: () => void) => { listener = fn; return vi.fn() },
      setModSlot: (slot: number, state: typeof slots[number]) => { slots[slot] = state; listener() }
    }
    const matrix = new ModMatrix(engine as unknown as SynthEngine)
    document.body.append(matrix.root)
    const row = matrix.root.querySelector('.matrix-row')!
    const knob = matrix.root.querySelector<HTMLCanvasElement>('.matrix-depth-knob canvas')!
    const toggle = matrix.root.querySelector('.toggle') as HTMLButtonElement
    expect(row.firstElementChild).toBe(toggle)
    knob.focus()
    knob.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(matrix.root.querySelector('.matrix-depth-knob canvas')).toBe(knob)
    expect(document.activeElement).toBe(knob)
    toggle.click()
    expect(slots[0]).toMatchObject({ depth: 1, enabled: false })
    expect(row.classList.contains('is-inactive')).toBe(true)
    toggle.click()
    expect(slots[0].enabled).toBe(true)
    expect(row.classList.contains('is-inactive')).toBe(false)
    matrix.dispose()
    matrix.root.remove()
  })
})
