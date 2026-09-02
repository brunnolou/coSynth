import type { PresetData } from '../audio/engine'
import { PARAMS, SYNC_DIVISIONS } from './params'
import { FX_IDS, MAX_MOD_SLOTS, MOD_SOURCES, type LfoPoint } from './messages'

export const PRESET_STORAGE_KEY = 'cosynth.presets.v1'
const LEGACY_PRESET_STORAGE_KEY = 'soundgineer.presets.v1'
export const MAX_PRESETS = 100
export const MAX_PRESET_STORAGE_BYTES = 5 * 1024 * 1024
const MAX_NAME_LENGTH = 80

/** Current preset format. Version 1 is still read, and upgraded on load. */
export const PRESET_VERSION = 2
/** Highest index of the 13-entry division list format 1 normalized against. */
const V1_SYNC_DIVISION_MAX = 12

const paramById = new Map(PARAMS.map(param => [param.id, param]))
const sourceIds = new Set(MOD_SOURCES.map(source => source.id))
const fxIds = new Set<string>(FX_IDS)

/**
 * Rescale the LFO divisions of a format 1 preset.
 *
 * A choices parameter is stored as `index / (choices.length - 1)`, and the slow
 * 2/1..31/1 multiples grew SYNC_DIVISIONS from 13 entries to 43. So the same
 * division has two different normalized forms - format 1 wrote 1/4 as 4/12,
 * format 2 writes it as 4/42 - and nothing but the version tag tells them
 * apart. Hence the version bump: an unconditional remap would corrupt every
 * newly saved preset. Recover the index on the old scale, then renormalize.
 *
 * `delay.division` is deliberately excluded: it stayed on the original
 * 13-entry DELAY_DIVISIONS, so its scale never moved and remapping it would
 * corrupt it. Selecting on the choices array rather than on the parameter id
 * keeps that true if either list changes again.
 */
function upgradeSyncDivisionScale(params: Record<string, number>): Record<string, number> {
  const max = SYNC_DIVISIONS.length - 1
  const upgraded: Record<string, number> = {}
  for (const [id, value] of Object.entries(params)) {
    upgraded[id] = paramById.get(id)?.choices === SYNC_DIVISIONS
      ? Math.round(value * V1_SYNC_DIVISION_MAX) / max
      : value
  }
  return upgraded
}

export function validatePresetName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Preset name must be a string')
  const name = value.trim()
  if (!name || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error(`Preset name must contain 1-${MAX_NAME_LENGTH} printable characters`)
  }
  return name
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid preset: ${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function boundedFinite(value: unknown, minimum: number, maximum: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid preset: ${field} must be a finite number in range ${minimum}..${maximum}`)
  }
  return value
}

/**
 * Validate all semantic preset fields and return a detached canonical object,
 * upgraded to the current format version. Upgrading here rather than at the
 * point of use keeps storage reads, file imports and the agent tools on one
 * code path, and is idempotent: the result is already at PRESET_VERSION, so
 * re-validating it (as savePreset does) never rescales anything twice.
 */
export function validatePresetData(value: unknown): PresetData {
  const input = record(value, 'data')
  const name = validatePresetName(input.name)
  if (input.version !== 1 && input.version !== PRESET_VERSION) {
    throw new Error(`Invalid preset: version must be 1 or ${PRESET_VERSION}`)
  }

  const rawParams = record(input.params, 'params')
  let params: Record<string, number> = {}
  for (const [id, rawValue] of Object.entries(rawParams)) {
    if (!paramById.has(id)) throw new Error(`Invalid preset: unknown parameter ID ${id}`)
    params[id] = boundedFinite(rawValue, 0, 1, `params.${id}`)
  }
  if (input.version !== PRESET_VERSION) params = upgradeSyncDivisionScale(params)

  if (!Array.isArray(input.mods)) throw new Error('Invalid preset: mods must be an array')
  if (input.mods.length > MAX_MOD_SLOTS) throw new Error(`Invalid preset: mods is limited to ${MAX_MOD_SLOTS} entries`)
  const mods = input.mods.map((rawMod, index) => {
    const mod = record(rawMod, `mods[${index}]`)
    if (typeof mod.source !== 'string' || !sourceIds.has(mod.source)) {
      throw new Error(`Invalid preset: unknown modulation source at mods[${index}]`)
    }
    if (typeof mod.dest !== 'string') throw new Error(`Invalid preset: mods[${index}].dest must be a string`)
    const destination = paramById.get(mod.dest)
    if (!destination) throw new Error(`Invalid preset: unknown modulation destination ${mod.dest}`)
    if (!destination.moddable) throw new Error(`Invalid preset: modulation destination is not moddable: ${mod.dest}`)
    const depth = boundedFinite(mod.depth, -1, 1, `mods[${index}].depth`)
    if (typeof mod.enabled !== 'boolean') throw new Error(`Invalid preset: mods[${index}].enabled must be boolean`)
    return { source: mod.source, dest: mod.dest, depth, enabled: mod.enabled }
  })

  if (!Array.isArray(input.lfoShapes) || input.lfoShapes.length !== 8) {
    throw new Error('Invalid preset: lfoShapes must contain exactly 8 shapes')
  }
  const lfoShapes: LfoPoint[][] = input.lfoShapes.map((rawShape, shapeIndex) => {
    if (!Array.isArray(rawShape) || rawShape.length < 2 || rawShape.length > 64) {
      throw new Error(`Invalid preset: lfoShapes[${shapeIndex}] must contain 2..64 points`)
    }
    let previousX = -Infinity
    return rawShape.map((rawPoint, pointIndex) => {
      const point = record(rawPoint, `lfoShapes[${shapeIndex}][${pointIndex}]`)
      const x = boundedFinite(point.x, 0, 1, `lfoShapes[${shapeIndex}][${pointIndex}].x`)
      const y = boundedFinite(point.y, 0, 1, `lfoShapes[${shapeIndex}][${pointIndex}].y`)
      const power = boundedFinite(point.power, -1, 1, `lfoShapes[${shapeIndex}][${pointIndex}].power`)
      if (x < previousX) throw new Error(`Invalid preset: lfoShapes[${shapeIndex}] x values must be non-decreasing`)
      previousX = x
      return { x, y, power }
    })
  })

  if (!Array.isArray(input.fxOrder) || input.fxOrder.length !== FX_IDS.length ||
      input.fxOrder.some(id => typeof id !== 'string' || !fxIds.has(id)) ||
      new Set(input.fxOrder).size !== FX_IDS.length) {
    throw new Error('Invalid preset: fxOrder must be an exact permutation of all FX IDs')
  }
  const fxOrder = input.fxOrder.map(id => id as string)

  return { name, version: PRESET_VERSION, params, mods, lfoShapes, fxOrder }
}

function browserStorage(): Storage {
  try {
    if (typeof sessionStorage === 'undefined') throw new Error('sessionStorage is unavailable')
    return sessionStorage
  } catch (error) {
    throw new Error(`Preset storage is unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function readPresets(storage: Storage): PresetData[] {
  const serialized = storage.getItem(PRESET_STORAGE_KEY) ?? storage.getItem(LEGACY_PRESET_STORAGE_KEY) ?? '[]'
  if (byteLength(serialized) > MAX_PRESET_STORAGE_BYTES) {
    throw new Error('Stored preset data exceeds the 5 MiB limit')
  }
  const parsed: unknown = JSON.parse(serialized)
  if (!Array.isArray(parsed)) return []
  if (parsed.length > MAX_PRESETS) throw new Error(`Stored preset data exceeds the ${MAX_PRESETS} preset limit`)
  return parsed.flatMap(item => {
    try { return [validatePresetData(item)] } catch { return [] }
  })
}

function storageReadError(error: unknown): Error {
  return new Error(`Could not read preset browser storage: ${error instanceof Error ? error.message : String(error)}`)
}

export function listPresets(storage?: Storage): PresetData[] {
  try {
    return readPresets(storage ?? browserStorage())
  } catch {
    return []
  }
}

export function savePreset(preset: PresetData, storage?: Storage): PresetData {
  const target = storage ?? browserStorage()
  const saved = validatePresetData(preset)
  let list: PresetData[]
  try { list = readPresets(target) } catch (error) { throw storageReadError(error) }
  const existing = list.findIndex(item => item.name === saved.name)
  if (existing >= 0) list[existing] = saved
  else {
    if (list.length >= MAX_PRESETS) throw new Error(`Preset storage is limited to ${MAX_PRESETS} presets`)
    list.push(saved)
  }
  const serialized = JSON.stringify(list)
  if (byteLength(serialized) > MAX_PRESET_STORAGE_BYTES) {
    throw new Error('Preset storage is limited to 5 MiB of serialized data')
  }
  try {
    target.setItem(PRESET_STORAGE_KEY, serialized)
  } catch (error) {
    throw new Error(`Could not save preset to browser storage: ${error instanceof Error ? error.message : String(error)}`)
  }
  return validatePresetData(saved)
}

export function loadPreset(name: unknown, storage?: Storage): PresetData | null {
  const target = storage ?? browserStorage()
  const canonical = validatePresetName(name)
  let list: PresetData[]
  try { list = readPresets(target) } catch (error) { throw storageReadError(error) }
  const found = list.find(item => item.name === canonical)
  return found ? validatePresetData(found) : null
}
