// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SynthEngine } from '../audio/engine'
import {
  savePreset, loadPreset, listPresets, PRESET_STORAGE_KEY, PRESET_VERSION,
  clearCurrentPreset, currentPresetState, serializePreset, presetFileName
} from '../shared/preset-store'
import { defaultLfoShape, FX_IDS } from '../shared/messages'
import { normToValue, paramDef, paramIndex, SYNC_DIVISIONS } from '../shared/params'
import { PresetBrowser, deletePresetFromUi, downloadPreset, importPresetFile } from './presets'
import { createWebMcpTools } from '../webmcp/tools'

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
    // The loaded-preset reference is module state, like the listener set beside it.
    clearCurrentPreset()
    engine = new SynthEngine()
    vi.spyOn(engine, 'loadPreset')
    browser = new PresetBrowser(engine)
    document.body.append(browser.root)
  })
  afterEach(() => {
    actions().open = false
    toggle()
    browser.dispose()
    document.body.replaceChildren()
    vi.restoreAllMocks()
    localStorage.clear()
    clearCurrentPreset()
  })

  it('places chevrons around the select and groups all actions behind a cog', () => {
    expect([...browser.root.children].slice(0, 4).map(node => node.tagName))
      .toEqual(['BUTTON', 'SELECT', 'BUTTON', 'DETAILS'])
    expect(actions().open).toBe(false)
    expect(trigger().getAttribute('aria-label')).toBe('Preset actions')
    expect(trigger().querySelector('svg')).not.toBeNull()
    expect([...actions().querySelectorAll('button')].map(button => button.textContent))
      .toEqual(['Save', 'Export', 'Import', 'Delete'])
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

  it('focuses Next after direct selection without advancing twice', () => {
    select().focus()
    select().value = 'factory:Reese Bass'
    select().dispatchEvent(new Event('change'))
    expect(engine.loadPreset).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Reese Bass' }))
    expect(engine.loadPreset).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(button('Next preset'))
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

  // The slow LFO divisions changed how a division normalizes. Factory presets
  // are authored in raw indices and normalized at module load, so they follow
  // the current scale for free; user presets on disk are format 1 and have to
  // be upgraded on the way in. Both land on the division they were written as.
  const divisionOf = (id: string) =>
    SYNC_DIVISIONS[normToValue(paramDef(id), engine.getParam(paramIndex(id)))]

  it('loads factory presets on the current division scale', () => {
    select().value = 'factory:Wobble Bass'
    select().dispatchEvent(new Event('change'))
    expect(engine.loadPreset).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Wobble Bass' }))
    expect(divisionOf('lfo1.division')).toBe('1/4')
    expect(divisionOf('delay.division')).toBe('1/8')
  })

  it('upgrades a format 1 user preset in storage to the current division scale', () => {
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify([{
      name: 'Old Patch', version: 1,
      // Format 1 wrote 1/4 as 4/12 and the delay's 1/8 as 7/12.
      params: { 'lfo1.division': 4 / 12, 'delay.division': 7 / 12 },
      mods: [], lfoShapes: Array.from({ length: 8 }, () => defaultLfoShape()), fxOrder: [...FX_IDS]
    }]))
    browser = new PresetBrowser(engine)
    document.body.replaceChildren(browser.root)
    select().value = 'user:Old Patch'
    select().dispatchEvent(new Event('change'))
    expect(divisionOf('lfo1.division')).toBe('1/4')
    expect(divisionOf('delay.division')).toBe('1/8')
  })

  // An agent writes and reads the preset store directly, so nothing in the UI
  // fires. Without a store subscription the dropdown never showed the save.
  const callTool = (name: string, input: Record<string, unknown>) =>
    createWebMcpTools(engine).find(tool => tool.name === name)!
      .execute(input, { signal: new AbortController().signal })

  it('lists and selects a preset the agent saved through save_preset', () => {
    engine.setParamById('osc1.morph', 0.42, 'ai')
    callTool('save_preset', { name: 'Agent patch' })
    expect([...select().querySelectorAll('optgroup')].map(group => group.label)).toEqual(['Factory', 'User'])
    expect([...select().options].map(option => option.value)).toContain('user:Agent patch')
    expect(select().value).toBe('user:Agent patch')
  })

  it('follows the agent selecting a stored preset through load_preset', () => {
    savePreset(engine.toPreset('Agent patch'))
    select().value = 'factory:Reese Bass'
    select().dispatchEvent(new Event('change'))
    callTool('load_preset', { name: 'Agent patch' })
    expect(select().value).toBe('user:Agent patch')
  })

  it('keeps the current selection when a save lands in another storage', () => {
    const elsewhere = new Map<string, string>()
    const other = {
      getItem: (key: string) => elsewhere.get(key) ?? null,
      setItem: (key: string, value: string) => { elsewhere.set(key, value) }
    } as unknown as Storage
    select().value = 'factory:Reese Bass'
    savePreset(engine.toPreset('Elsewhere'), other)
    expect(select().value).toBe('factory:Reese Bass')
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

  // The export exists to be imported again, so the assertion is equality of the
  // whole patch, not of a field or two: every parameter, every mod route, all
  // eight LFO shapes and the FX order, through JSON and back into the engine.
  it('round-trips an exported preset through the import path exactly', async () => {
    engine.setParamById('osc1.morph', 0.42)
    engine.setParamById('filter1.cutoff', 0.31)
    engine.setParamById('lfo1.division', SYNC_DIVISIONS.indexOf('1/16') / (SYNC_DIVISIONS.length - 1))
    const exported = engine.toPreset('Round Trip')
    const json = serializePreset(exported)
    expect(JSON.parse(json).version).toBe(PRESET_VERSION)

    // Move the patch away, so an import that did nothing could not pass.
    engine.setParamById('osc1.morph', 0.9)
    expect(engine.toPreset('Round Trip')).not.toEqual(exported)

    const imported = await importPresetFile(engine, new File([json], presetFileName('Round Trip'), { type: 'application/json' }))
    expect(imported).toEqual(exported)
    expect(engine.toPreset('Round Trip')).toEqual(exported)
    expect(listPresets().map(preset => preset.name)).toEqual(['Round Trip'])
    expect(presetFileName('Round Trip')).toBe('round-trip.cosynth.json')
  })

  it('names the downloaded file after the preset', () => {
    const createUrl = vi.fn(() => 'blob:patch')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    const downloads: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download)
    })
    downloadPreset(engine.toPreset('My Sound'))
    select().value = 'factory:Reese Bass'
    select().dispatchEvent(new Event('change'))
    button('Export').click()
    engine.setParamById('osc1.morph', 0.77)
    button('Export').click()
    // A modified factory patch must not export as the factory name: importing
    // saves under it and would shadow the built-in preset.
    expect(downloads).toEqual(['my-sound.cosynth.json', 'reese-bass.cosynth.json', 'reese-bass-edited.cosynth.json'])
  })

  const openDelete = () => {
    actions().open = true
    button('Delete').click()
  }
  const deleteDialog = () => [...browser.root.querySelectorAll('dialog')]
    .find(dialog => dialog.getAttribute('aria-label') === 'Delete preset')!
  const confirmDelete = () => (deleteDialog().querySelector('.agent-btn.primary') as HTMLButtonElement).click()

  it('deletes the selected user preset, refreshes the list, and leaves the sound alone', () => {
    savePreset(engine.toPreset('Doomed'))
    savePreset(engine.toPreset('Keeper'))
    browser.dispose()
    browser = new PresetBrowser(engine)
    document.body.replaceChildren(browser.root)
    select().value = 'user:Doomed'
    select().dispatchEvent(new Event('change'))
    expect(browser.currentPreset()).toEqual({ name: 'Doomed', source: 'user', dirty: false })

    const sound = engine.captureSoundState()
    const loads = (engine.loadPreset as ReturnType<typeof vi.fn>).mock.calls.length
    openDelete()
    expect(deleteDialog().open).toBe(true)
    expect(deleteDialog().textContent).toContain('Doomed')
    confirmDelete()

    expect(deleteDialog().open).toBe(false)
    expect(listPresets().map(preset => preset.name)).toEqual(['Keeper'])
    expect([...select().options].map(option => option.value)).not.toContain('user:Doomed')
    // Deleting a saved copy is not an edit: the patch on screen is untouched,
    // and nothing is loaded over it.
    expect(engine.captureSoundState()).toEqual(sound)
    expect((engine.loadPreset as ReturnType<typeof vi.fn>).mock.calls.length).toBe(loads)
    // The selection can no longer name a preset, so it falls back to the first
    // entry and the patch stops claiming to be a copy of anything.
    expect(select().value).toBe('factory:Init')
    expect(browser.currentPreset()).toEqual({ name: null, source: null, dirty: false })
  })

  it('keeps the selection when the deleted preset is not the selected one', () => {
    savePreset(engine.toPreset('Doomed'))
    savePreset(engine.toPreset('Keeper'))
    browser.dispose()
    browser = new PresetBrowser(engine)
    document.body.replaceChildren(browser.root)
    select().value = 'user:Keeper'
    select().dispatchEvent(new Event('change'))
    expect(deletePresetFromUi('Doomed').name).toBe('Doomed')
    expect(select().value).toBe('user:Keeper')
    expect(browser.currentPreset()).toMatchObject({ name: 'Keeper', source: 'user' })
  })

  it('refuses to delete a factory preset and says why', () => {
    expect(select().value).toBe('factory:Init')
    expect((button('Delete') as HTMLButtonElement).disabled).toBe(true)
    expect(button('Delete').title).toMatch(/factory preset/i)
    expect(() => deletePresetFromUi('Init')).toThrow(/factory preset/i)
    expect(() => deletePresetFromUi('Nothing here')).toThrow(/No preset named/i)
    // A user preset that shadows a factory name is deliberate work, and stays
    // deletable; what comes back is the built-in patch of the same name.
    savePreset(engine.toPreset('Init'))
    expect(deletePresetFromUi('Init').name).toBe('Init')
    expect(listPresets()).toHaveLength(0)
  })

  it('tracks whether the live patch still matches the preset that was loaded', () => {
    const dirtyMark = () => browser.root.querySelector('.preset-dirty') as HTMLElement
    expect(browser.currentPreset()).toEqual({ name: null, source: null, dirty: false })

    select().value = 'factory:Reese Bass'
    select().dispatchEvent(new Event('change'))
    // A factory preset spells out a fraction of the parameters and the engine
    // fills in the rest, so the reference has to be the engine's own view.
    expect(browser.currentPreset()).toEqual({ name: 'Reese Bass', source: 'factory', dirty: false })
    expect(dirtyMark().hidden).toBe(true)

    const loaded = engine.getParam(paramIndex('osc1.morph'))
    engine.setParamById('osc1.morph', 0.123)
    expect(browser.currentPreset()).toMatchObject({ name: 'Reese Bass', dirty: true })
    expect(dirtyMark().hidden).toBe(false)

    // Exact equality, so putting the value back is not a change.
    engine.setParamById('osc1.morph', loaded)
    expect(browser.currentPreset().dirty).toBe(false)

    engine.setParamById('osc1.morph', 0.123)
    select().value = 'factory:Reese Bass'
    select().dispatchEvent(new Event('change'))
    expect(browser.currentPreset()).toEqual({ name: 'Reese Bass', source: 'factory', dirty: false })
    expect(dirtyMark().hidden).toBe(true)

    // Saving makes the patch a copy of the preset it was just written to.
    engine.setParamById('osc1.morph', 0.456)
    button('Save').click()
    nameInput().value = 'Mine'
    submit()
    expect(browser.currentPreset()).toEqual({ name: 'Mine', source: 'user', dirty: false })
  })

  // Every value the engine holds is a float32, and a format 1 preset on disk is
  // not: 4/42 rescaled from the old division scale has no float32 form. The
  // reference is captured from the engine after the load for exactly this case.
  it('is clean straight after loading a rescaled format 1 preset', () => {
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify([{
      name: 'Old Patch', version: 1,
      params: { 'lfo1.division': 4 / 12, 'osc1.morph': 0.1 },
      mods: [], lfoShapes: Array.from({ length: 8 }, () => defaultLfoShape()), fxOrder: [...FX_IDS]
    }]))
    browser.dispose()
    browser = new PresetBrowser(engine)
    document.body.replaceChildren(browser.root)
    select().value = 'user:Old Patch'
    select().dispatchEvent(new Event('change'))
    expect(currentPresetState(engine)).toEqual({ name: 'Old Patch', source: 'user', dirty: false })
    expect(divisionOf('lfo1.division')).toBe('1/4')
  })
})
