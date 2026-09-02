import { describe, expect, it } from 'vitest'
import type { PresetData } from '../audio/engine'
import { FX_IDS, MAX_MOD_SLOTS, defaultLfoShape } from './messages'
import { loadPreset, listPresets, PRESET_STORAGE_KEY, PRESET_VERSION, savePreset, validatePresetData, validatePresetName } from './preset-store'
import { normToValue, paramDef, SYNC_DIVISIONS } from './params'

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
      { ...preset('x'), version: 3 },
      { ...preset('x'), version: 0 },
      { ...preset('x'), version: '2' },
      { ...preset('x'), version: undefined },
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

// The slow 2/1..31/1 multiples grew SYNC_DIVISIONS from 13 entries to 43, which
// moved the normalized form of every LFO division. Format 1 presets predate the
// move; format 2 presets do not, and only the version tag separates them.
describe('preset format upgrade', () => {
  const V1_MAX = 12
  const V2_MAX = SYNC_DIVISIONS.length - 1
  const divisionOf = (value: number) => SYNC_DIVISIONS[normToValue(paramDef('lfo1.division'), value)]
  const withParams = (version: 1 | 2, params: Record<string, number>): PresetData =>
    ({ ...preset('Divisions'), version, params })

  it('stamps the current format version on everything it returns', () => {
    expect(PRESET_VERSION).toBe(2)
    expect(validatePresetData(preset('Old')).version).toBe(PRESET_VERSION)
    expect(validatePresetData({ ...preset('New'), version: PRESET_VERSION }).version).toBe(PRESET_VERSION)
  })

  it('rescales every format 1 LFO division back onto the same division', () => {
    for (let index = 0; index <= V1_MAX; index++) {
      const upgraded = validatePresetData(withParams(1, { 'lfo1.division': index / V1_MAX }))
      expect(upgraded.params['lfo1.division']).toBeCloseTo(index / V2_MAX, 10)
      expect(divisionOf(upgraded.params['lfo1.division'])).toBe(SYNC_DIVISIONS[index])
    }
  })

  it('keeps the endpoints and the LFO default intact across the upgrade', () => {
    const upgraded = validatePresetData(withParams(1, {
      'lfo1.division': 0 / V1_MAX,   // 1/1
      'lfo2.division': 4 / V1_MAX,   // 1/4, the parameter default
      'lfo3.division': V1_MAX / V1_MAX // 1/32
    })).params
    expect(divisionOf(upgraded['lfo1.division'])).toBe('1/1')
    expect(divisionOf(upgraded['lfo2.division'])).toBe('1/4')
    expect(divisionOf(upgraded['lfo3.division'])).toBe('1/32')
    expect(upgraded['lfo2.division']).toBe(paramDef('lfo2.division').def / V2_MAX)
  })

  it('leaves delay.division alone: it never left the 13-entry scale', () => {
    const upgraded = validatePresetData(withParams(1, { 'delay.division': 7 / V1_MAX })).params
    expect(upgraded['delay.division']).toBe(7 / V1_MAX)
    expect(normToValue(paramDef('delay.division'), upgraded['delay.division'])).toBe(7)
  })

  it('leaves ordinary parameters alone', () => {
    const upgraded = validatePresetData(withParams(1, { 'osc1.level': 0.3333, 'master.bpm': 0.5 })).params
    expect(upgraded).toEqual({ 'osc1.level': 0.3333, 'master.bpm': 0.5 })
  })

  it('is a fixed point on format 2: validating twice never rescales twice', () => {
    const once = validatePresetData(withParams(1, { 'lfo1.division': 4 / V1_MAX }))
    const twice = validatePresetData(once)
    expect(twice).toEqual(once)
    expect(divisionOf(twice.params['lfo1.division'])).toBe('1/4')
    // The slow end is only reachable in format 2 and must survive untouched.
    const slow = withParams(2, { 'lfo1.division': SYNC_DIVISIONS.indexOf('31/1') / V2_MAX })
    expect(validatePresetData(validatePresetData(slow)).params['lfo1.division'])
      .toBe(slow.params['lfo1.division'])
    expect(divisionOf(slow.params['lfo1.division'])).toBe('31/1')
  })

  it('survives a save/load round trip without drifting', () => {
    const storage = new MemoryStorage()
    // savePreset validates on the way in and on the way out, so a v1 preset
    // meets the upgrade twice in one call.
    const saved = savePreset(withParams(1, { 'lfo1.division': 4 / V1_MAX }), storage)
    expect(divisionOf(saved.params['lfo1.division'])).toBe('1/4')
    const loaded = loadPreset('Divisions', storage)!
    expect(loaded.version).toBe(PRESET_VERSION)
    expect(loaded.params['lfo1.division']).toBe(saved.params['lfo1.division'])
    // Re-saving the upgraded preset is idempotent: storage is now format 2.
    const resaved = savePreset(loaded, storage)
    expect(resaved.params['lfo1.division']).toBe(saved.params['lfo1.division'])
    expect(divisionOf(listPresets(storage)[0].params['lfo1.division'])).toBe('1/4')
  })
})
