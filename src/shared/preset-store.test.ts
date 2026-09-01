import { describe, expect, it } from 'vitest'
import type { PresetData } from '../audio/engine'
import { FX_IDS, MAX_MOD_SLOTS, defaultLfoShape } from './messages'
import { loadPreset, listPresets, PRESET_STORAGE_KEY, savePreset, validatePresetData, validatePresetName } from './preset-store'

class MemoryStorage implements Storage {
  private data = new Map<string, string>()
  get length() { return this.data.size }
  clear() { this.data.clear() }
  getItem(key: string) { return this.data.get(key) ?? null }
  key(index: number) { return [...this.data.keys()][index] ?? null }
  removeItem(key: string) { this.data.delete(key) }
  setItem(key: string, value: string) { this.data.set(key, value) }
}

function preset(name: string, value = 0.2): PresetData {
  return {
    name, version: 1, params: { 'osc1.level': value }, mods: [],
    lfoShapes: Array.from({ length: 8 }, () => defaultLfoShape()),
    fxOrder: [...FX_IDS]
  }
}

describe('preset store', () => {
  it('validates and canonicalizes preset names', () => {
    expect(validatePresetName('  Agent Bass  ')).toBe('Agent Bass')
    for (const invalid of ['', '   ', 'bad\u0000name', 'x'.repeat(81), 42]) {
      expect(() => validatePresetName(invalid)).toThrow(/preset name/i)
    }
  })

  it('saves, lists, loads, and replaces by exact name', () => {
    const storage = new MemoryStorage()
    savePreset(preset('Patch', 0.2), storage)
    savePreset(preset('Other', 0.3), storage)
    savePreset(preset('Patch', 0.9), storage)

    expect(listPresets(storage).map(item => item.name)).toEqual(['Patch', 'Other'])
    expect(loadPreset('Patch', storage)?.params['osc1.level']).toBe(0.9)
    expect(loadPreset('Missing', storage)).toBeNull()
  })

  it('returns an empty safe list for corrupt or structurally invalid storage', () => {
    const storage = new MemoryStorage()
    storage.setItem(PRESET_STORAGE_KEY, '{broken')
    expect(listPresets(storage)).toEqual([])
    storage.setItem(PRESET_STORAGE_KEY, JSON.stringify([{ name: '', params: null }]))
    expect(listPresets(storage)).toEqual([])
  })

  it('keeps presets saved under the previous brand storage key', () => {
    const storage = new MemoryStorage()
    storage.setItem('soundgineer.presets.v1', JSON.stringify([preset('Legacy Patch')]))
    expect(listPresets(storage).map(item => item.name)).toEqual(['Legacy Patch'])
    savePreset(preset('New Patch'), storage)
    expect(storage.getItem(PRESET_STORAGE_KEY)).not.toBeNull()
    expect(listPresets(storage).map(item => item.name)).toEqual(['Legacy Patch', 'New Patch'])
  })

  it('does not expose mutable references from storage', () => {
    const storage = new MemoryStorage()
    const original = preset('Safe')
    savePreset(original, storage)
    const loaded = loadPreset('Safe', storage)!
    loaded.params['osc1.level'] = 1
    expect(loadPreset('Safe', storage)?.params['osc1.level']).toBe(0.2)
  })

  it('validates every semantic preset field and returns a detached canonical clone', () => {
    const original = preset('  Canonical  ')
    original.mods.push({ source: 'lfo1', dest: 'filter1.cutoff', depth: -0.5, enabled: true })
    const validated = validatePresetData(original)
    expect(validated.name).toBe('Canonical')
    expect(validated).not.toBe(original)
    expect(validated.lfoShapes[0]).not.toBe(original.lfoShapes[0])
    validated.lfoShapes[0][0].x = 0.25
    expect(original.lfoShapes[0][0].x).toBe(0)

    const invalid: unknown[] = [
      { ...preset('x'), version: 2 },
      { ...preset('x'), params: { missing: 0.5 } },
      { ...preset('x'), params: { 'osc1.level': NaN } },
      { ...preset('x'), params: { 'osc1.level': 1.1 } },
      { ...preset('x'), mods: Array.from({ length: MAX_MOD_SLOTS + 1 }, () => ({ source: 'lfo1', dest: 'osc1.level', depth: 0, enabled: true })) },
      { ...preset('x'), mods: [{ source: 'missing', dest: 'osc1.level', depth: 0, enabled: true }] },
      { ...preset('x'), mods: [{ source: 'lfo1', dest: 'missing', depth: 0, enabled: true }] },
      { ...preset('x'), mods: [{ source: 'lfo1', dest: 'master.bpm', depth: 0, enabled: true }] },
      { ...preset('x'), mods: [{ source: 'lfo1', dest: 'osc1.level', depth: 2, enabled: true }] },
      { ...preset('x'), mods: [{ source: 'lfo1', dest: 'osc1.level', depth: 0, enabled: 1 }] },
      { ...preset('x'), lfoShapes: [] },
      { ...preset('x'), lfoShapes: Array.from({ length: 8 }, () => [{ x: 0, y: 0, power: 0 }]) },
      { ...preset('x'), lfoShapes: Array.from({ length: 8 }, () => Array.from({ length: 65 }, (_, i) => ({ x: i / 64, y: 0, power: 0 }))) },
      { ...preset('x'), lfoShapes: Array.from({ length: 8 }, () => [{ x: 0.7, y: 0, power: 0 }, { x: 0.2, y: 1, power: 0 }]) },
      { ...preset('x'), fxOrder: [...FX_IDS].reverse().slice(1) },
      { ...preset('x'), fxOrder: [...FX_IDS.slice(0, -1), FX_IDS[0]] }
    ]
    for (const value of invalid) expect(() => validatePresetData(value)).toThrow(/preset/i)
  })

  it('limits storage to 100 presets while allowing replacement', () => {
    const storage = new MemoryStorage()
    for (let index = 0; index < 100; index++) savePreset(preset(`Patch ${index}`), storage)
    expect(() => savePreset(preset('Overflow'), storage)).toThrow(/100 presets/i)
    expect(() => savePreset(preset('Patch 0', 0.9), storage)).not.toThrow()
    expect(loadPreset('Patch 0', storage)?.params['osc1.level']).toBe(0.9)
  })

  it('returns an empty list when the localStorage getter or storage access throws', () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('blocked', 'SecurityError') }
    })
    expect(listPresets()).toEqual([])
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else delete (globalThis as { localStorage?: Storage }).localStorage

    const throwing = new MemoryStorage()
    throwing.getItem = () => { throw new DOMException('blocked', 'SecurityError') }
    expect(listPresets(throwing)).toEqual([])
    expect(() => savePreset(preset('Blocked'), throwing)).toThrow(/storage/i)
    expect(() => loadPreset('Blocked', throwing)).toThrow(/storage/i)
  })
})
