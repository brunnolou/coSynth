import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PresetData } from '../audio/engine'
import { FX_IDS, MAX_MOD_SLOTS, defaultLfoShape } from './messages'
import {
  clearCurrentPreset, currentPresetState, deletePreset, factoryDeleteRefusal, listPresets, loadPreset,
  markPresetLoaded, onPresetStoreChange, PRESET_STORAGE_KEY, PRESET_VERSION, presetFileName, savePreset,
  serializePreset, validatePresetData, validatePresetName, type PresetStoreChange
} from './preset-store'
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

describe('deleting a preset', () => {
  const record = () => {
    const changes: PresetStoreChange[] = []
    const stop = onPresetStoreChange(change => changes.push(change))
    return { changes, stop }
  }

  it('removes one preset, keeps the rest, and announces the removal', () => {
    const storage = new MemoryStorage()
    savePreset(preset('Keeper'), storage)
    savePreset(preset('Doomed', 0.7), storage)
    const { changes, stop } = record()

    expect(deletePreset('  Doomed  ', storage)?.params['osc1.level']).toBe(0.7)
    stop()
    expect(listPresets(storage).map(item => item.name)).toEqual(['Keeper'])
    expect(loadPreset('Doomed', storage)).toBeNull()
    // The listener set is what made the dropdown follow a save; a silent delete
    // would put the original bug back, one preset at a time.
    expect(changes).toEqual([{ kind: 'deleted', name: 'Doomed' }])
  })

  it('reports a name it does not hold without writing or announcing anything', () => {
    const storage = new MemoryStorage()
    savePreset(preset('Keeper'), storage)
    const before = storage.getItem(PRESET_STORAGE_KEY)
    const { changes, stop } = record()

    // A factory name reaches here as an ordinary miss: storage holds user
    // presets only, and the refusal is worded by the caller that knows the list.
    expect(deletePreset('Init', storage)).toBeNull()
    expect(deletePreset('Keeper ', storage)).not.toBeNull()
    stop()
    expect(changes).toEqual([{ kind: 'deleted', name: 'Keeper' }])
    expect(before).not.toBeNull()
    expect(() => deletePreset('', storage)).toThrow(/preset name/i)
    expect(factoryDeleteRefusal('Init')).toMatch(/factory preset/i)
  })

  it('surfaces a storage failure instead of reporting a delete that did not happen', () => {
    const storage = new MemoryStorage()
    savePreset(preset('Doomed'), storage)
    storage.setItem = () => { throw new DOMException('quota', 'QuotaExceededError') }
    const { changes, stop } = record()
    expect(() => deletePreset('Doomed', storage)).toThrow(/Could not delete preset/)
    stop()
    expect(changes).toEqual([])
  })
})

describe('exporting a preset', () => {
  it('writes importable JSON, stamped with the current format version', () => {
    const exported = serializePreset(preset('Exported', 0.4))
    const parsed = JSON.parse(exported)
    expect(parsed.version).toBe(PRESET_VERSION)
    // The exact object the import path produces, so the round trip is closed
    // before a file is ever written.
    expect(validatePresetData(parsed)).toEqual(validatePresetData(preset('Exported', 0.4)))
    expect(exported).toContain('\n')
  })

  it('refuses to write a file this app would not read back', () => {
    expect(() => serializePreset({ ...preset('Broken'), fxOrder: [] })).toThrow(/preset/i)
  })

  it('names the file after the preset', () => {
    expect(presetFileName('My Sound')).toBe('my-sound.cosynth.json')
    expect(presetFileName('  ///  ')).toBe('patch.cosynth.json')
    expect(presetFileName('x'.repeat(80)).length).toBeLessThanOrEqual(60 + '.cosynth.json'.length)
  })
})

describe('the preset the patch came from', () => {
  /**
   * The engine, as `markPresetLoaded` sees it. Values are what the engine holds
   * after a load, not what a file spelled out - which is the distinction the
   * real thing turns on, and the reason this takes a source instead of data.
   */
  class FakeEngine {
    params: Record<string, number> = { 'osc1.level': 0.2, 'filter1.cutoff': 0.5 }
    toPreset(name: string): PresetData {
      return {
        name, version: PRESET_VERSION, params: { ...this.params }, mods: [],
        lfoShapes: Array.from({ length: 8 }, () => defaultLfoShape()), fxOrder: [...FX_IDS]
      }
    }
  }

  afterEach(() => clearCurrentPreset())

  it('is nothing until a preset is loaded', () => {
    const engine = new FakeEngine()
    expect(currentPresetState(engine)).toEqual({ name: null, source: null, dirty: false })
  })

  it('is clean at the load, dirty at the first change, and clean again at the reload', () => {
    const engine = new FakeEngine()
    markPresetLoaded('Reese Bass', 'factory', engine)
    expect(currentPresetState(engine)).toEqual({ name: 'Reese Bass', source: 'factory', dirty: false })

    engine.params['osc1.level'] = 0.9
    expect(currentPresetState(engine)).toMatchObject({ name: 'Reese Bass', dirty: true })
    engine.params['osc1.level'] = 0.2
    expect(currentPresetState(engine).dirty).toBe(false)

    engine.params['osc1.level'] = 0.9
    markPresetLoaded('Reese Bass', 'factory', engine)
    expect(currentPresetState(engine).dirty).toBe(false)
  })

  it('notices every part of the patch, not just the parameters', () => {
    const engine = new FakeEngine()
    markPresetLoaded('Patch', 'user', engine)
    const mutate = (fn: (preset: PresetData) => void) => {
      const original = engine.toPreset.bind(engine)
      engine.toPreset = (name: string) => { const preset = original(name); fn(preset); return preset }
    }
    mutate(preset => { preset.fxOrder = [...FX_IDS].reverse() })
    expect(currentPresetState(engine).dirty).toBe(true)
    mutate(preset => { preset.mods = [{ source: 'lfo1', dest: 'osc1.level', depth: 0.5, enabled: true }] })
    expect(currentPresetState(engine).dirty).toBe(true)
    mutate(preset => { preset.lfoShapes[0][0].y = 0.5 })
    expect(currentPresetState(engine).dirty).toBe(true)
    // A rename is not a patch change.
    engine.toPreset = (name: string) => ({ ...new FakeEngine().toPreset(name), name: 'Something else' })
    expect(currentPresetState(engine).dirty).toBe(false)
  })

  it('stops attributing the patch to a preset that was just deleted', () => {
    const storage = new MemoryStorage()
    const engine = new FakeEngine()
    savePreset(preset('Doomed'), storage)
    markPresetLoaded('Doomed', 'user', engine)
    expect(currentPresetState(engine).name).toBe('Doomed')
    deletePreset('Doomed', storage)
    expect(currentPresetState(engine)).toEqual({ name: null, source: null, dirty: false })

    // A different preset's delete leaves the current one alone.
    savePreset(preset('Other'), storage)
    markPresetLoaded('Other', 'user', engine)
    savePreset(preset('Third'), storage)
    deletePreset('Third', storage)
    expect(currentPresetState(engine).name).toBe('Other')
  })

  it('reads the reference out of the engine, not out of the preset it was handed', () => {
    const engine = new FakeEngine()
    const captured = vi.spyOn(engine, 'toPreset')
    markPresetLoaded('  Patch  ', 'user', engine)
    // Canonicalized once, and asked for by that name from then on.
    expect(captured).toHaveBeenCalledExactlyOnceWith('Patch')
    expect(currentPresetState(engine).name).toBe('Patch')
    expect(captured).toHaveBeenLastCalledWith('Patch')
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
