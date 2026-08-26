import { describe, expect, it, vi } from 'vitest'
import type { PresetData, SynthEngine } from '../audio/engine'
import { FX_IDS, defaultLfoShape } from '../shared/messages'
import { importPresetFile, savePresetFromUi } from './presets'

function validPreset(): PresetData {
  return {
    name: 'Imported', version: 1, params: { 'osc1.level': 0.5 }, mods: [],
    lfoShapes: Array.from({ length: 8 }, () => defaultLfoShape()), fxOrder: [...FX_IDS]
  }
}

describe('preset UI boundaries', () => {
  it('rejects files over 1 MiB before reading or loading them', async () => {
    const text = vi.fn(async () => JSON.stringify(validPreset()))
    const file = { size: 1024 * 1024 + 1, text } as unknown as File
    const engine = { loadPreset: vi.fn() } as unknown as SynthEngine
    await expect(importPresetFile(engine, file)).rejects.toThrow(/1 MiB/i)
    expect(text).not.toHaveBeenCalled()
    expect(engine.loadPreset).not.toHaveBeenCalled()
  })

  it('validates imported JSON before mutating the engine', async () => {
    const file = { size: 100, text: vi.fn(async () => JSON.stringify({ ...validPreset(), params: { unknown: 0.2 } })) } as unknown as File
    const engine = { loadPreset: vi.fn() } as unknown as SynthEngine
    await expect(importPresetFile(engine, file)).rejects.toThrow(/preset/i)
    expect(engine.loadPreset).not.toHaveBeenCalled()
  })

  it('reports unavailable storage from SAVE without throwing through the UI', () => {
    const alert = vi.fn()
    vi.stubGlobal('alert', alert)
    const engine = { toPreset: vi.fn(() => validPreset()) } as unknown as SynthEngine
    const storage = { setItem() { throw new DOMException('quota', 'QuotaExceededError') } } as unknown as Storage
    expect(savePresetFromUi(engine, 'Imported', storage)).toBe(false)
    expect(alert).toHaveBeenCalledWith(expect.stringMatching(/could not save preset/i))
    vi.unstubAllGlobals()
  })
})
