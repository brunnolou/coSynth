// Preset browser: factory presets, localStorage user presets, JSON file
// export/import.

import { paramDef, valueToNorm } from '../shared/params'
import type { SynthEngine, PresetData } from '../audio/engine'
import { el } from './common'

const STORAGE_KEY = 'soundgineer.presets.v1'

/** Convenience: author factory presets in raw units, store normalized. */
function P(raw: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [id, v] of Object.entries(raw)) out[id] = valueToNorm(paramDef(id), v)
  return out
}

const FACTORY: Partial<PresetData>[] = [
  { name: 'Init', params: {} },
  {
    name: 'Deep Saw Bass',
    params: P({
      'osc1.enabled': 1, 'osc1.wavetable': 0, 'osc1.morph': 0.7, 'osc1.unison': 5, 'osc1.detune': 9,
      'osc1.transpose': -12, 'osc1.level': 0.8, 'sub.enabled': 1, 'sub.level': 0.7, 'sub.octave': -1,
      'filter1.enabled': 1, 'filter1.type': 1, 'filter1.cutoff': 300, 'filter1.resonance': 0.35, 'filter1.drive': 0.3,
      'env1.attack': 0.003, 'env1.decay': 0.4, 'env1.sustain': 0.9, 'env1.release': 0.12,
      'env2.attack': 0.003, 'env2.decay': 0.35, 'env2.sustain': 0.15, 'env2.release': 0.1,
      'dist.type': 1, 'dist.drive': 0.25
    }),
    mods: [{ source: 'env2', dest: 'filter1.cutoff', depth: 0.45, enabled: true }]
  },
  {
    name: 'Morphing Pad',
    params: P({
      'osc1.enabled': 1, 'osc1.wavetable': 3, 'osc1.unison': 7, 'osc1.detune': 16, 'osc1.spread': 0.9, 'osc1.level': 0.55,
      'osc2.enabled': 1, 'osc2.wavetable': 1, 'osc2.unison': 5, 'osc2.detune': 12, 'osc2.transpose': 12, 'osc2.level': 0.3,
      'filter1.enabled': 1, 'filter1.type': 0, 'filter1.cutoff': 2200, 'filter1.resonance': 0.15,
      'env1.attack': 0.9, 'env1.decay': 1.5, 'env1.sustain': 0.8, 'env1.release': 1.8,
      'lfo1.rate': 0.12, 'lfo1.sync': 0,
      'chorus.enabled': 1, 'chorus.mix': 0.4, 'reverb.enabled': 1, 'reverb.size': 0.85, 'reverb.mix': 0.35
    }),
    mods: [
      { source: 'lfo1', dest: 'osc1.morph', depth: 0.6, enabled: true },
      { source: 'lfo2', dest: 'osc2.morph', depth: 0.3, enabled: true }
    ]
  },
  {
    name: 'Sync Pluck',
    params: P({
      'osc1.enabled': 1, 'osc1.wavetable': 0, 'osc1.morph': 0.55, 'osc1.sync': 1,
      'filter1.enabled': 1, 'filter1.type': 1, 'filter1.cutoff': 900, 'filter1.resonance': 0.3, 'filter1.keytrack': 1,
      'env1.attack': 0.002, 'env1.decay': 0.5, 'env1.sustain': 0, 'env1.release': 0.4,
      'env2.attack': 0.001, 'env2.decay': 0.25, 'env2.sustain': 0, 'env2.release': 0.2,
      'delay.enabled': 1, 'delay.mix': 0.25, 'delay.feedback': 0.35,
      'reverb.enabled': 1, 'reverb.mix': 0.2
    }),
    mods: [
      { source: 'env2', dest: 'filter1.cutoff', depth: 0.5, enabled: true },
      { source: 'env2', dest: 'osc1.sync', depth: 0.5, enabled: true },
      { source: 'velocity', dest: 'filter1.cutoff', depth: 0.25, enabled: true }
    ]
  },
  {
    name: 'PWM Keys',
    params: P({
      'osc1.enabled': 1, 'osc1.wavetable': 2, 'osc1.morph': 0.3, 'osc1.unison': 3, 'osc1.detune': 6,
      'filter1.enabled': 1, 'filter1.type': 0, 'filter1.cutoff': 5000,
      'env1.attack': 0.01, 'env1.decay': 0.8, 'env1.sustain': 0.6, 'env1.release': 0.5,
      'lfo1.rate': 0.6, 'lfo1.sync': 0,
      'chorus.enabled': 1, 'chorus.mix': 0.35, 'eq.enabled': 1, 'eq.high_gain': 2
    }),
    mods: [
      { source: 'lfo1', dest: 'osc1.morph', depth: 0.35, enabled: true },
      { source: 'modwheel', dest: 'osc1.morph', depth: 0.5, enabled: true }
    ]
  }
]

function loadUserPresets(): PresetData[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as PresetData[]
  } catch {
    return []
  }
}

function saveUserPresets(list: PresetData[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
}

export class PresetBrowser {
  readonly root: HTMLElement
  private readonly select: HTMLSelectElement

  constructor(private readonly engine: SynthEngine) {
    this.root = el('div', 'presets')
    this.select = el('select', 'param-select preset-select') as HTMLSelectElement
    this.select.addEventListener('change', () => this.load(this.select.value))

    const save = el('button', 'hdr-btn', 'SAVE')
    save.title = 'Save current patch to the browser'
    save.addEventListener('click', () => {
      const name = prompt('Preset name?', 'My Patch')
      if (!name) return
      const list = loadUserPresets().filter(p => p.name !== name)
      list.push(this.engine.toPreset(name))
      saveUserPresets(list)
      this.refresh(`user:${name}`)
    })

    const exportBtn = el('button', 'hdr-btn', 'EXPORT')
    exportBtn.title = 'Download patch as JSON'
    exportBtn.addEventListener('click', () => {
      const preset = this.engine.toPreset('Exported Patch')
      const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' })
      const a = el('a') as HTMLAnchorElement
      a.href = URL.createObjectURL(blob)
      a.download = 'patch.soundgineer.json'
      a.click()
      URL.revokeObjectURL(a.href)
    })

    const importBtn = el('button', 'hdr-btn', 'IMPORT')
    const file = el('input') as HTMLInputElement
    file.type = 'file'
    file.accept = '.json'
    file.style.display = 'none'
    file.addEventListener('change', async () => {
      const f = file.files?.[0]
      if (!f) return
      try {
        const preset = JSON.parse(await f.text()) as PresetData
        this.engine.loadPreset(preset)
        const list = loadUserPresets().filter(p => p.name !== preset.name)
        list.push(preset)
        saveUserPresets(list)
        this.refresh(`user:${preset.name}`)
      } catch (err) {
        alert(`Could not load preset: ${err}`)
      }
      file.value = ''
    })
    importBtn.addEventListener('click', () => file.click())

    this.root.append(this.select, save, exportBtn, importBtn, file)
    this.refresh('factory:Init')
  }

  private refresh(selected: string): void {
    this.select.textContent = ''
    const fGroup = el('optgroup') as HTMLOptGroupElement
    fGroup.label = 'Factory'
    for (const p of FACTORY) {
      const o = el('option', undefined, p.name) as HTMLOptionElement
      o.value = `factory:${p.name}`
      fGroup.appendChild(o)
    }
    this.select.appendChild(fGroup)
    const users = loadUserPresets()
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
    this.select.value = selected
  }

  private load(key: string): void {
    const [kind, ...rest] = key.split(':')
    const name = rest.join(':')
    const preset =
      kind === 'factory'
        ? FACTORY.find(p => p.name === name)
        : loadUserPresets().find(p => p.name === name)
    if (preset) this.engine.loadPreset(preset)
  }
}
