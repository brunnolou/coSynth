// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SynthEngine } from '../audio/engine'
import { savePreset } from '../shared/preset-store'
import { PresetBrowser } from './presets'

describe('compact preset browser', () => {
  let engine: SynthEngine
  let browser: PresetBrowser
  const select = () => browser.root.querySelector('select')!
  const actions = () => browser.root.querySelector('details')!
  const trigger = () => browser.root.querySelector('summary')!
  const button = (name: string) => [...browser.root.querySelectorAll('button')]
    .find(button => button.getAttribute('aria-label') === name || button.textContent === name)!
  const toggle = () => actions().dispatchEvent(new Event('toggle'))

  beforeEach(() => {
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
    vi.spyOn(window, 'prompt').mockReturnValue('Saved patch')
    button('Save').click()
    expect(select().value).toBe('user:Saved patch')
    button('Next preset').click()
    expect(select().value).toBe('factory:Init')
    button('Previous preset').click()
    expect(select().value).toBe('user:Saved patch')
    expect(engine.loadPreset).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Saved patch' }))
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
