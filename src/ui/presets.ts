// Preset browser: factory presets, localStorage user presets, JSON file
// export/import.

import { listPresets, onPresetStoreChange, savePreset, validatePresetData } from '../shared/preset-store'
import { FACTORY_PRESETS } from '../shared/factory-presets'
import type { SynthEngine, PresetData } from '../audio/engine'
import { el } from './common'
import { guideTarget } from './guide-target'
import { ModalDialog } from './dialog'
import { ChevronLeft, ChevronRight, Cog, createElement } from 'lucide'
import './presets.css'

const MAX_IMPORT_BYTES = 1024 * 1024

export function savePresetFromUi(engine: SynthEngine, name: string, storage?: Storage): PresetData {
  return savePreset(engine.toPreset(name), storage)
}

export async function importPresetFile(engine: SynthEngine, file: File, storage?: Storage): Promise<PresetData> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error('Preset import is limited to 1 MiB')
  const parsed: unknown = JSON.parse(await file.text())
  const preset = validatePresetData(parsed)
  const saved = savePreset(preset, storage)
  engine.loadPreset(saved)
  return saved
}

export class PresetBrowser {
  readonly root: HTMLElement
  private readonly select: HTMLSelectElement
  private readonly unsubscribe: () => void

  constructor(private readonly engine: SynthEngine) {
    this.root = el('div', 'presets')
    this.select = el('select', 'param-select preset-select') as HTMLSelectElement
    this.select.setAttribute('aria-label', 'Preset')
    guideTarget(this.select, 'select.preset', 'Preset browser', 'select')

    const iconButton = (label: string, icon: typeof Cog) => {
      const button = el('button', 'hdr-btn preset-icon-btn')
      button.type = 'button'
      button.title = label
      button.setAttribute('aria-label', label)
      button.append(createElement(icon, { width: 16, height: 16, 'aria-hidden': 'true' }))
      return button
    }
    const previous = iconButton('Previous preset', ChevronLeft)
    const next = iconButton('Next preset', ChevronRight)
    this.select.addEventListener('change', () => {
      this.load(this.select.value)
      next.focus()
    })
    previous.addEventListener('click', () => this.step(-1))
    next.addEventListener('click', () => this.step(1))

    const actions = el('details', 'preset-actions')
    const trigger = el('summary', 'hdr-btn preset-icon-btn')
    trigger.title = 'Preset actions'
    trigger.tabIndex = 0
    trigger.setAttribute('role', 'button')
    trigger.setAttribute('aria-label', 'Preset actions')
    trigger.setAttribute('aria-expanded', 'false')
    trigger.append(createElement(Cog, { width: 16, height: 16, 'aria-hidden': 'true' }))
    guideTarget(trigger, 'button.preset.actions', 'Preset actions', 'button')
    const menu = el('div', 'preset-actions-menu')
    const closeActions = (restoreFocus = false) => {
      actions.open = false
      trigger.setAttribute('aria-expanded', 'false')
      if (restoreFocus) trigger.focus()
    }
    const outsideClick = (event: PointerEvent) => {
      if (!actions.contains(event.target as Node)) closeActions()
    }
    actions.addEventListener('toggle', () => {
      trigger.setAttribute('aria-expanded', String(actions.open))
      document.removeEventListener('pointerdown', outsideClick)
      if (actions.open) document.addEventListener('pointerdown', outsideClick)
    })
    actions.addEventListener('keydown', event => {
      event.stopPropagation()
      if (event.target === trigger && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault()
        if (!event.repeat) {
          actions.open = !actions.open
          trigger.setAttribute('aria-expanded', String(actions.open))
        }
      }
      if (event.key === 'Escape' && actions.open) {
        event.preventDefault()
        closeActions(true)
      }
    })
    actions.addEventListener('focusout', event => {
      if (event.relatedTarget && !actions.contains(event.relatedTarget as Node)) closeActions()
    })

    const saveDialog = new ModalDialog('Save preset', 'preset-save')
    saveDialog.root.classList.add('preset-save-dialog')
    saveDialog.root.setAttribute('aria-label', 'Save preset')
    const saveForm = el('form', 'preset-save-form')
    saveForm.id = 'preset-save-form'
    saveForm.noValidate = true
    const nameLabel = el('label', '', 'Preset name')
    nameLabel.htmlFor = 'preset-save-name'
    const nameInput = el('input', 'preset-name-input')
    nameInput.id = 'preset-save-name'
    nameInput.name = 'presetName'
    nameInput.type = 'text'
    nameInput.required = true
    nameInput.maxLength = 80
    nameInput.autocomplete = 'off'
    guideTarget(nameInput, 'input.preset.name', 'Preset name', 'input')
    const help = el('p', 'preset-save-help', 'Saved in this browser. An existing name replaces that saved preset. Use Export for a downloadable backup.')
    help.id = 'preset-save-help'
    const saveError = el('p', 'preset-save-error')
    saveError.id = 'preset-save-error'
    saveError.setAttribute('role', 'alert')
    nameInput.setAttribute('aria-describedby', `${help.id} ${saveError.id}`)
    const cancel = el('button', 'agent-btn', 'Cancel')
    cancel.type = 'button'
    cancel.addEventListener('click', () => saveDialog.close())
    const confirmSave = el('button', 'agent-btn primary', 'Save')
    confirmSave.type = 'submit'
    confirmSave.setAttribute('form', saveForm.id)
    guideTarget(confirmSave, 'button.preset.save-confirm', 'Confirm save preset', 'button')
    saveForm.append(nameLabel, nameInput, help, saveError)
    saveDialog.body.append(saveForm)
    saveDialog.footer.append(cancel, confirmSave)
    saveDialog.root.addEventListener('close', () => trigger.focus())
    nameInput.addEventListener('input', () => { saveError.textContent = '' })
    nameInput.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      event.preventDefault()
      if (!event.repeat) saveForm.requestSubmit(confirmSave)
    })
    saveForm.addEventListener('submit', event => {
      event.preventDefault()
      try {
        const saved = savePresetFromUi(this.engine, nameInput.value)
        this.refresh(`user:${saved.name}`)
        saveDialog.close()
      } catch (error) {
        saveError.textContent = `Could not save preset: ${error instanceof Error ? error.message : String(error)}`
        nameInput.focus()
      }
    })

    const save = el('button', 'hdr-btn', 'Save')
    guideTarget(save, 'button.preset.save', 'Save preset', 'button')
    save.title = 'Save current patch to the browser'
    save.addEventListener('click', () => {
      closeActions(true)
      nameInput.value = this.select.value.startsWith('user:') ? this.select.value.slice(5) : 'My Patch'
      saveError.textContent = ''
      saveDialog.open()
      nameInput.focus()
      nameInput.select()
    })

    const exportBtn = el('button', 'hdr-btn', 'Export')
    guideTarget(exportBtn, 'button.preset.export', 'Export preset', 'button')
    exportBtn.title = 'Download patch as JSON'
    exportBtn.addEventListener('click', () => {
      closeActions(true)
      const preset = this.engine.toPreset('Exported Patch')
      const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' })
      const a = el('a') as HTMLAnchorElement
      a.href = URL.createObjectURL(blob)
      a.download = 'patch.cosynth.json'
      a.click()
      URL.revokeObjectURL(a.href)
    })

    const importBtn = el('button', 'hdr-btn', 'Import')
    guideTarget(importBtn, 'button.preset.import', 'Import preset', 'button')
    const file = el('input') as HTMLInputElement
    file.type = 'file'
    file.accept = '.json'
    file.style.display = 'none'
    file.addEventListener('change', async () => {
      const f = file.files?.[0]
      if (!f) return
      try {
        const preset = await importPresetFile(this.engine, f)
        this.refresh(`user:${preset.name}`)
      } catch (err) {
        alert(`Could not load preset: ${err}`)
      }
      file.value = ''
    })
    importBtn.addEventListener('click', () => {
      closeActions(true)
      file.click()
    })

    for (const button of [save, exportBtn, importBtn]) button.type = 'button'
    menu.append(save, exportBtn, importBtn)
    actions.append(trigger, menu)
    this.root.append(previous, this.select, next, actions, file, saveDialog.root)
    this.refresh('factory:Init')
    // Presets also change from outside this component: an agent's save_preset or
    // load_preset tool call writes and reads the same store with no UI event.
    this.unsubscribe = onPresetStoreChange(change => this.refresh(`user:${change.name}`))
  }

  dispose(): void {
    this.unsubscribe()
  }

  private step(direction: -1 | 1): void {
    const count = this.select.options.length
    if (!count) return
    this.select.selectedIndex = (this.select.selectedIndex + direction + count) % count
    this.load(this.select.value)
  }

  private refresh(selected: string): void {
    const previous = this.select.value
    this.select.textContent = ''
    const fGroup = el('optgroup') as HTMLOptGroupElement
    fGroup.label = 'Factory'
    for (const p of FACTORY_PRESETS) {
      const o = el('option', undefined, p.name) as HTMLOptionElement
      o.value = `factory:${p.name}`
      fGroup.appendChild(o)
    }
    this.select.appendChild(fGroup)
    const users = listPresets()
    if (users.length) {
      const uGroup = el('optgroup') as HTMLOptGroupElement
      uGroup.label = 'User'
      for (const p of users) {
        const o = el('option', undefined, p.name) as HTMLOptionElement
        o.value = `user:${p.name}`
        uGroup.appendChild(o)
      }
      this.select.appendChild(uGroup)
    }
    // A name from another storage (or one just deleted) must not blank the field.
    this.select.value = selected
    if (!this.select.value) this.select.value = previous
    if (!this.select.value) this.select.selectedIndex = 0
  }

  private load(key: string): void {
    const [kind, ...rest] = key.split(':')
    const name = rest.join(':')
    const preset =
      kind === 'factory'
        ? FACTORY_PRESETS.find(p => p.name === name)
        : listPresets().find(p => p.name === name)
    if (preset) this.engine.loadPreset(preset)
  }
}
