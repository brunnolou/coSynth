// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SynthEngine } from '../audio/engine'
import { savePreset, loadPreset, listPresets } from '../shared/preset-store'
import { PresetBrowser } from './presets'

describe('compact preset browser', () => {
  let engine: SynthEngine
  let browser: PresetBrowser
  const select = () => browser.root.querySelector('select')!
  const actions = () => browser.root.querySelector('details')!
  const trigger = () => browser.root.querySelector('summary')!
  const dialog = () => browser.root.querySelector('dialog')!
  const nameInput = () => dialog().querySelector('input')!
  const submit = () => (dialog().querySelector('button[type="submit"]') as HTMLButtonElement).click()
  const button = (name: string) => [...browser.root.querySelectorAll('button')]
    .find(button => button.getAttribute('aria-label') === name || button.textContent === name)!
  const toggle = () => actions().dispatchEvent(new Event('toggle'))

  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true } })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) {
      this.open = false
      this.dispatchEvent(new Event('close'))
    } })
    localStorage.clear()
    engine = new SynthEngine()
    vi.spyOn(engine, 'loadPreset')
    browser = new PresetBrowser(engine)
    document.body.append(browser.root)
  })
  afterEach(() => {
    actions().open = false
    toggle()
    document.body.replaceChildren()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('places chevrons around the select and groups all actions behind a cog', () => {
    expect([...browser.root.children].slice(0, 4).map(node => node.tagName))
      .toEqual(['BUTTON', 'SELECT', 'BUTTON', 'DETAILS'])
    expect(actions().open).toBe(false)
    expect(trigger().getAttribute('aria-label')).toBe('Preset actions')
    expect(trigger().querySelector('svg')).not.toBeNull()
    expect([...actions().querySelectorAll('button')].map(button => button.textContent))
      .toEqual(['Save', 'Export', 'Import'])
  })

  it('loads next and previous presets and wraps in both directions', () => {
    button('Next preset').click()
    expect(select().value).toBe('factory:Deep Saw Bass')
    expect(engine.loadPreset).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Deep Saw Bass' }))
    button('Previous preset').click()
    expect(select().value).toBe('factory:Init')
    button('Previous preset').click()
    expect(select().selectedIndex).toBe(select().options.length - 1)
    button('Next preset').click()
    expect(select().value).toBe('factory:Init')
    expect(engine.loadPreset).toHaveBeenCalledTimes(4)
  })

  it('keeps direct selection working', () => {
    select().value = 'factory:Reese Bass'
    select().dispatchEvent(new Event('change'))
    expect(engine.loadPreset).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Reese Bass' }))
    button('Next preset').click()
    expect(select().value).toBe('factory:Acid Squelch')
  })

  it('includes saved presets in navigation and keeps Save functional', () => {
    const nativePrompt = vi.spyOn(window, 'prompt').mockImplementation(() => { throw new Error('prompt() is not supported.') })
    button('Save').click()
    expect(nativePrompt).not.toHaveBeenCalled()
    expect(dialog().open).toBe(true)
    expect(document.activeElement).toBe(nameInput())
    nameInput().value = '  Saved patch  '
    submit()
    expect(dialog().open).toBe(false)
    expect(document.activeElement).toBe(trigger())
    expect(select().value).toBe('user:Saved patch')
    button('Next preset').click()
    expect(select().value).toBe('factory:Init')
    button('Previous preset').click()
    expect(select().value).toBe('user:Saved patch')
    expect(engine.loadPreset).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Saved patch' }))
  })

  it('saves on Enter without submitting during composition or modified shortcuts', () => {
    button('Save').click()
    nameInput().value = 'Keyboard save'
    for (const options of [{ isComposing: true }, { repeat: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }]) {
      nameInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options }))
      expect(listPresets()).toHaveLength(0)
    }
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    nameInput().dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(true)
    expect(dialog().open).toBe(false)
    expect(select().value).toBe('user:Keyboard save')
  })

  it('validates names inline, keeps the dialog open, and allows correction', () => {
    const nativeAlert = vi.spyOn(window, 'alert').mockImplementation(() => { throw new Error('Native alert used') })
    button('Save').click()
    for (const invalid of ['   ', 'x'.repeat(81)]) {
      nameInput().value = invalid
      submit()
      expect(dialog().open).toBe(true)
      expect(dialog().querySelector('[role="alert"]')?.textContent).toMatch(/1-80 printable characters/)
      expect(listPresets()).toHaveLength(0)
    }
    nameInput().value = 'Fixed name'
    nameInput().dispatchEvent(new Event('input'))
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe('')
    submit()
    expect(loadPreset('Fixed name')).not.toBeNull()
    expect(nativeAlert).not.toHaveBeenCalled()
  })

  it('reports storage errors inline and can retry without losing the typed name', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError') })
    button('Save').click()
    nameInput().value = 'Keep this name'
    submit()
    expect(dialog().open).toBe(true)
    expect(nameInput().value).toBe('Keep this name')
    expect(dialog().querySelector('[role="alert"]')?.textContent).toMatch(/Could not save preset:.*quota/)
    write.mockRestore()
    submit()
    expect(dialog().open).toBe(false)
    expect(select().value).toBe('user:Keep this name')
  })

  it('cancels without saving or changing the sound and reuses a selected user preset name', () => {
    const before = engine.captureSoundState()
    button('Save').click()
    nameInput().value = 'Do not save'
    button('Cancel').click()
    expect(listPresets()).toHaveLength(0)
    expect(engine.captureSoundState()).toEqual(before)
    expect(engine.loadPreset).not.toHaveBeenCalled()
    button('Save').click()
    nameInput().value = 'My sound'
    submit()
    expect(engine.captureSoundState()).toEqual(before)
    button('Save').click()
    expect(nameInput().value).toBe('My sound')
    expect((dialog().querySelector('input') as HTMLInputElement).maxLength).toBe(80)
  })

  it('loads existing user presets when created', () => {
    savePreset(engine.toPreset('Existing'))
    browser.root.remove()
    browser = new PresetBrowser(engine)
    document.body.append(browser.root)
    button('Previous preset').click()
    expect(select().value).toBe('user:Existing')
  })

  it('closes on Escape, outside pointerdown, and focus leaving the menu', () => {
    actions().open = true
    toggle()
    button('Save').focus()
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    button('Save').dispatchEvent(escape)
    expect(actions().open).toBe(false)
    expect(escape.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(trigger())
    actions().open = true
    toggle()
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(actions().open).toBe(false)
    actions().open = true
    button('Save').focus()
    select().focus()
    expect(actions().open).toBe(false)
  })

  it('opens the same hidden file picker and closes the menu on Import', () => {
    const file = browser.root.querySelector('input')!
    const click = vi.spyOn(file, 'click').mockImplementation(() => {})
    actions().open = true
    button('Import').click()
    expect(click).toHaveBeenCalledOnce()
    expect(actions().open).toBe(false)
  })

  it.each(['Enter', ' '])('toggles once with %j and ignores held keys', key => {
    const press = (repeat = false) => trigger().dispatchEvent(new KeyboardEvent('keydown', {
      key, repeat, bubbles: true, cancelable: true
    }))
    press()
    expect(actions().open).toBe(true)
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    press(true)
    expect(actions().open).toBe(true)
    press()
    expect(actions().open).toBe(false)
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('exports the current patch through the existing JSON download', () => {
    const createUrl = vi.fn(() => 'blob:patch')
    const revokeUrl = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    actions().open = true
    button('Export').click()
    expect(createUrl).toHaveBeenCalledWith(expect.any(Blob))
    expect(click).toHaveBeenCalledOnce()
    expect(revokeUrl).toHaveBeenCalledWith('blob:patch')
    expect(actions().open).toBe(false)
  })
})
