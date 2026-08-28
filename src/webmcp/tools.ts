import type { SynthEngine } from '../audio/engine'
import {
  PARAMS, defaultNorm, formatValue, normToValue, paramIndex, valueToNorm,
  type ParamDef
} from '../shared/params'
import { FX_IDS, MAX_MOD_SLOTS, MOD_SOURCES, modSourceIndex, type ModSlotState } from '../shared/messages'
import { analyzeAudio, compareAudioMetrics, type AudioMetrics } from '../shared/audio-analysis'
import { loadPreset, savePreset, validatePresetData, validatePresetName } from '../shared/preset-store'
import { decodeBase64Audio, MAX_AUDIO_BASE64_CHARACTERS, normalizeAudioMimeType } from './audio-input'
import { analyzeAudioAbortably } from './audio-analysis-task'

export const WEBMCP_TOOL_NAMES = [
  'get_synth_state',
  'get_parameter_schema',
  'update_parameters',
  'set_modulation',
  'play_notes',
  'render_audio',
  'analyze_audio',
  'analyze_reference_audio',
  'compare_audio',
  'save_preset',
  'load_preset'
] as const

const MAX_NOTES = 128
const MAX_PLAY_SECONDS = 30
const MAX_RENDER_SECONDS = 15
const MAX_QUERY_LENGTH = 100
const MAX_REFERENCE_NAME_LENGTH = 255
const MAX_MIME_TYPE_LENGTH = 127
const MAX_PAGE_SIZE = 5

type Input = Record<string, unknown>
interface ValidNote { midi: number; velocity: number; start: number; duration: number }
type DecodeAudio = typeof decodeBase64Audio

export interface WebMcpToolDependencies {
  decodeAudio?: DecodeAudio
  analyzeAudioAsync?: typeof analyzeAudioAbortably
}

interface ReferenceAnalysis {
  source: 'base64-reference'
  name?: string
  mimeType?: string
  decodedBytes: number
  duration: number
  sampleRate: number
  channels: number
  metrics: AudioMetrics
}

interface WebMcpSessionState {
  lastRender: { metrics: AudioMetrics; sampleRate: number; channels: number; url: string } | null
  lastReference: ReferenceAnalysis | null
  referenceGeneration: number
  activeReferenceController: AbortController | null
  performanceInProgress: boolean
}

const sessions = new WeakMap<SynthEngine, WebMcpSessionState>()

function sessionFor(engine: SynthEngine): WebMcpSessionState {
  let session = sessions.get(engine)
  if (!session) {
    session = {
      lastRender: null,
      lastReference: null,
      referenceGeneration: 0,
      activeReferenceController: null,
      performanceInProgress: false
    }
    sessions.set(engine, session)
  }
  return session
}

function assertObject(value: unknown, label: string, allowed: readonly string[], required: readonly string[] = []): Input {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const input = value as Input
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`Unexpected ${label} property: ${key}`)
  for (const key of required) if (!(key in input)) throw new Error(`${label}.${key} is required`)
  return input
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return value
}

function clean(value: number): number {
  return Math.round(value * 1e8) / 1e8
}

function parameterValue(def: ParamDef, normalized: number) {
  return {
    raw: clean(normToValue(def, normalized)),
    normalized: clean(normalized),
    formatted: formatValue(def, normalized)
  }
}

function routeValue(slot: number, route: ModSlotState) {
  return {
    slot,
    source: MOD_SOURCES[route.source].id,
    destination: PARAMS[route.dest].id,
    depth: route.depth,
    enabled: route.enabled
  }
}

function runtimeSnapshot(engine: SynthEngine) {
  return {
    running: engine.running,
    heldNotes: [...engine.heldNotes].sort((a, b) => a - b),
    voices: engine.voiceCount,
    peaks: { left: engine.peakL, right: engine.peakR }
  }
}

function fxOrder(engine: SynthEngine) {
  return {
    fxOrder: engine.fxOrder.map(index => FX_IDS[index]).filter((id): id is (typeof FX_IDS)[number] => id !== undefined)
  }
}

function boundedInteger(value: unknown, label: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  const number = finite(value, label)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer in range ${min}..${max}`)
  }
  return number
}

function filteredParameters(group?: string, search?: string): ParamDef[] {
  const normalizedGroup = group?.toLowerCase()
  const normalizedSearch = search?.toLowerCase()
  return PARAMS.filter(def =>
    (!normalizedGroup || def.group.toLowerCase() === normalizedGroup) &&
    (!normalizedSearch || `${def.id} ${def.name} ${def.group}`.toLowerCase().includes(normalizedSearch))
  )
}

function validateNotes(value: unknown, maxSeconds: number): { notes: ValidNote[]; duration: number } {
  if (!Array.isArray(value) || value.length === 0) throw new Error('notes must be a non-empty array')
  if (value.length > MAX_NOTES) throw new Error(`notes is limited to ${MAX_NOTES} entries`)
  const notes = value.map((item, index) => {
    const note = assertObject(item, `notes[${index}]`, ['midi', 'velocity', 'start', 'duration'], ['midi', 'velocity', 'start', 'duration'])
    const midi = finite(note.midi, `notes[${index}].midi`)
    if (!Number.isInteger(midi) || midi < 0 || midi > 127) throw new Error(`notes[${index}].midi must be an integer in range 0..127`)
    const velocity = finite(note.velocity, `notes[${index}].velocity`)
    if (velocity < 0 || velocity > 1) throw new Error(`notes[${index}].velocity must be in range 0..1`)
    const start = finite(note.start, `notes[${index}].start`)
    if (start < 0) throw new Error(`notes[${index}].start must be >= 0`)
    const duration = finite(note.duration, `notes[${index}].duration`)
    if (duration <= 0) throw new Error(`notes[${index}].duration must be > 0`)
    return { midi, velocity, start, duration }
  })
  const duration = clean(Math.max(...notes.map(note => note.start + note.duration)))
  if (duration > maxSeconds) throw new Error(`Note sequence is limited to ${maxSeconds} seconds`)
  const lastEndByMidi = new Map<number, number>()
  for (const note of [...notes].sort((a, b) => a.start - b.start)) {
    const previousEnd = lastEndByMidi.get(note.midi)
    if (previousEnd !== undefined && note.start < previousEnd) {
      throw new Error(`Note intervals overlap for MIDI ${note.midi}`)
    }
    lastEndByMidi.set(note.midi, note.start + note.duration)
  }
  return { notes, duration }
}

function abortError(): Error {
  const error = new Error('Execution aborted')
  error.name = 'AbortError'
  return error
}

/**
 * Some experimental WebMCP clients omit the per-invocation AbortSignal even
 * though the current type definition requires it. Treat that as an
 * uncancellable invocation while retaining lifecycle cancellation.
 */
function invocationSignal(options?: WebMCP.ToolExecuteCallbackOptions): AbortSignal {
  return options?.signal ?? new AbortController().signal
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

function validateReferenceName(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('name must be a non-empty string without control characters')
  }
  if (value.length > MAX_REFERENCE_NAME_LENGTH) throw new Error(`name is limited to ${MAX_REFERENCE_NAME_LENGTH} characters`)
  return value
}

function validateAudioMimeType(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return normalizeAudioMimeType(value)
}

function wait(seconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  if (seconds <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, seconds * 1000)
    signal.addEventListener('abort', aborted, { once: true })
    function cleanup() {
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
    }
    function done() { cleanup(); resolve() }
    function aborted() { cleanup(); reject(abortError()) }
  })
}

async function performNotes(engine: SynthEngine, notes: ValidNote[], signal: AbortSignal): Promise<void> {
  const owner = Symbol('webmcp-performance')
  const events = notes.flatMap(note => [
    { time: note.start, on: true, note },
    { time: note.start + note.duration, on: false, note }
  ]).sort((a, b) => a.time - b.time || Number(a.on) - Number(b.on))
  const started = new Set<number>()
  let elapsed = 0
  try {
    for (const event of events) {
      await wait(event.time - elapsed, signal)
      throwIfAborted(signal)
      if (event.on) {
        engine.noteOn(event.note.midi, event.note.velocity, owner)
        started.add(event.note.midi)
      } else if (started.delete(event.note.midi)) {
        engine.noteOff(event.note.midi, owner)
      }
      elapsed = event.time
    }
  } finally {
    for (const midi of started) engine.noteOff(midi, owner)
  }
}

function assertNotesAvailable(engine: SynthEngine, notes: readonly ValidNote[]): void {
  const held = notes.find(note => engine.heldNotes.has(note.midi))
  if (held) throw new Error(`MIDI note ${held.midi} is already held by another input`)
}

function canonicalRaw(def: ParamDef, value: unknown): number {
  if (typeof value === 'string') {
    if (!def.choices) throw new Error(`${def.id} does not accept a choice label`)
    const choice = def.choices.indexOf(value)
    if (choice < 0) throw new Error(`Unknown choice for ${def.id}: ${value}`)
    return choice
  }
  const raw = finite(value, `${def.id} value`)
  const max = def.choices ? def.choices.length - 1 : def.max
  const min = def.choices ? 0 : def.min
  if (raw < min || raw > max) throw new Error(`${def.id} value is outside range ${min}..${max}`)
  if (def.choices && !Number.isInteger(raw)) throw new Error(`${def.id} choice index must be an integer`)
  if (def.step && Math.abs(raw / def.step - Math.round(raw / def.step)) > 1e-9) {
    throw new Error(`${def.id} value must align to step ${def.step}`)
  }
  return raw
}

const emptySchema = { type: 'object', properties: {}, additionalProperties: false } as const
const noteSchema = {
  type: 'object',
  properties: {
    midi: { type: 'integer', minimum: 0, maximum: 127 },
    velocity: { type: 'number', minimum: 0, maximum: 1 },
    start: { type: 'number', minimum: 0 },
    duration: { type: 'number', exclusiveMinimum: 0 }
  },
  required: ['midi', 'velocity', 'start', 'duration'],
  additionalProperties: false
} as const

/** Build WebMCP descriptors over the exact live engine used by the UI. */
export function createWebMcpTools(
  engine: SynthEngine,
  lifecycleSignal?: AbortSignal,
  dependencies: WebMcpToolDependencies = {}
): WebMCP.ModelContextTool[] {
  const session = sessionFor(engine)
  const decodeAudio = dependencies.decodeAudio ?? decodeBase64Audio
  const analyzeAudioAsync = dependencies.analyzeAudioAsync ?? analyzeAudioAbortably

  const cleanup = () => {
    session.referenceGeneration++
    session.activeReferenceController?.abort()
    session.activeReferenceController = null
    if (session.lastRender) URL.revokeObjectURL(session.lastRender.url)
    session.lastRender = null
    session.lastReference = null
  }
  lifecycleSignal?.addEventListener('abort', cleanup, { once: true })

  async function runAbortable<T>(signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    lifecycleSignal?.addEventListener('abort', abort, { once: true })
    if (signal.aborted || lifecycleSignal?.aborted) controller.abort()
    try {
      throwIfAborted(controller.signal)
      return await task(controller.signal)
    } finally {
      signal.removeEventListener('abort', abort)
      lifecycleSignal?.removeEventListener('abort', abort)
    }
  }

  async function runReferenceAnalysis<T>(
    signal: AbortSignal,
    invocationGeneration: number,
    task: (signal: AbortSignal, assertCurrent: () => void) => Promise<T>
  ): Promise<T> {
    const superseded = new Error('Reference audio analysis was superseded by a newer invocation')
    session.activeReferenceController?.abort(superseded)

    const controller = new AbortController()
    session.activeReferenceController = controller
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    lifecycleSignal?.addEventListener('abort', abort, { once: true })
    if (signal.aborted || lifecycleSignal?.aborted) controller.abort()

    const assertCurrent = () => {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason
        if (reason instanceof Error && /superseded/i.test(reason.message)) throw reason
        throw abortError()
      }
      if (invocationGeneration !== session.referenceGeneration) {
        throw new Error('Reference audio analysis was superseded by a newer invocation')
      }
    }

    try {
      assertCurrent()
      return await task(controller.signal, assertCurrent)
    } finally {
      signal.removeEventListener('abort', abort)
      lifecycleSignal?.removeEventListener('abort', abort)
      if (session.activeReferenceController === controller) session.activeReferenceController = null
    }
  }

  async function runPerformance<T>(signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (session.performanceInProgress) throw new Error('A WebMCP performance is already in progress')
    session.performanceInProgress = true
    try {
      return await runAbortable(signal, task)
    } finally {
      session.performanceInProgress = false
    }
  }

  function assertPerformanceIdle(action: string): void {
    if (session.performanceInProgress) throw new Error(`${action} is unavailable while a WebMCP performance is in progress`)
  }

  function currentCandidate() {
    if (session.lastRender) return {
      source: 'last-render' as const,
      sampleRate: session.lastRender.sampleRate,
      channels: session.lastRender.channels,
      url: session.lastRender.url,
      metrics: session.lastRender.metrics
    }
    const sampleRate = engine.ctx?.sampleRate ?? 48000
    return {
      source: 'scope' as const,
      sampleRate,
      channels: 2,
      metrics: analyzeAudio([engine.scopeL, engine.scopeR], sampleRate)
    }
  }

  return [
    {
      name: 'get_synth_state',
      description: 'Get compact live synth state. Runtime, modulation routes, and FX order are returned by default; request a filtered parameter page or one LFO shape when needed.',
      inputSchema: {
        type: 'object', properties: {
          group: { type: 'string', maxLength: MAX_QUERY_LENGTH },
          search: { type: 'string', maxLength: MAX_QUERY_LENGTH },
          parameterOffset: { type: 'integer', minimum: 0 },
          parameterLimit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE },
          modulationOffset: { type: 'integer', minimum: 0 },
          modulationLimit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE },
          lfo: { type: 'integer', minimum: 1, maximum: 8 },
          lfoPointOffset: { type: 'integer', minimum: 0 },
          lfoPointLimit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE }
        }, additionalProperties: false
      },
      annotations: { readOnlyHint: true },
      execute(input) {
        const value = assertObject(input, 'input', [
          'group', 'search', 'parameterOffset', 'parameterLimit', 'modulationOffset', 'modulationLimit',
          'lfo', 'lfoPointOffset', 'lfoPointLimit'
        ])
        if (value.group !== undefined && typeof value.group !== 'string') throw new Error('group must be a string')
        if (value.search !== undefined && typeof value.search !== 'string') throw new Error('search must be a string')
        const group = value.group as string | undefined
        const search = value.search as string | undefined
        if (group && group.length > MAX_QUERY_LENGTH) throw new Error(`group is limited to ${MAX_QUERY_LENGTH} characters`)
        if (search && search.length > MAX_QUERY_LENGTH) throw new Error(`search is limited to ${MAX_QUERY_LENGTH} characters`)
        const offset = boundedInteger(value.parameterOffset, 'parameterOffset', 0, 0, PARAMS.length)
        const limit = boundedInteger(value.parameterLimit, 'parameterLimit', 5, 1, MAX_PAGE_SIZE)
        const matches = filteredParameters(group, search)
        const includeParameters = group !== undefined || search !== undefined || value.parameterOffset !== undefined || value.parameterLimit !== undefined
        const includeModulations = value.modulationOffset !== undefined || value.modulationLimit !== undefined
        const includeLfo = value.lfo !== undefined || value.lfoPointOffset !== undefined || value.lfoPointLimit !== undefined
        if (Number(includeParameters) + Number(includeModulations) + Number(includeLfo) > 1) {
          throw new Error('Request parameters, modulations, or one LFO shape in separate calls')
        }
        if (includeLfo && value.lfo === undefined) throw new Error('lfo is required when paging LFO points')
        const modulations = engine.modSlots.flatMap((route, slot) => route ? [routeValue(slot, route)] : [])
        const modulationOffset = boundedInteger(value.modulationOffset, 'modulationOffset', 0, 0, MAX_MOD_SLOTS)
        const modulationLimit = boundedInteger(value.modulationLimit, 'modulationLimit', 5, 1, MAX_PAGE_SIZE)
        const modulationPage = modulations.slice(modulationOffset, modulationOffset + modulationLimit)
        const lfo = value.lfo === undefined ? undefined : boundedInteger(value.lfo, 'lfo', 1, 1, 8)
        const lfoPoints = lfo === undefined ? [] : engine.lfoShapes[lfo - 1]
        const lfoPointOffset = boundedInteger(value.lfoPointOffset, 'lfoPointOffset', 0, 0, lfoPoints.length)
        const lfoPointLimit = boundedInteger(value.lfoPointLimit, 'lfoPointLimit', 5, 1, MAX_PAGE_SIZE)
        const lfoPointPage = lfoPoints.slice(lfoPointOffset, lfoPointOffset + lfoPointLimit)
        const page = matches.slice(offset, offset + limit)
        return {
          runtime: runtimeSnapshot(engine),
          patch: {
            ...fxOrder(engine),
            modulationCount: modulations.length,
            ...(includeModulations ? { modulations: {
              items: modulationPage, offset: modulationOffset, limit: modulationLimit, total: modulations.length,
              ...(modulationOffset + modulationPage.length < modulations.length ? { nextOffset: modulationOffset + modulationPage.length } : {})
            } } : {}),
            ...(includeParameters ? {
              parameters: {
                items: Object.fromEntries(page.map(def => [def.id, parameterValue(def, engine.values[paramIndex(def.id)])])),
                offset, limit, total: matches.length,
                ...(offset + page.length < matches.length ? { nextOffset: offset + page.length } : {})
              }
            } : {}),
            ...(!includeLfo || lfo === undefined ? {} : {
              lfoShape: {
                id: `lfo${lfo}`,
                points: {
                  items: lfoPointPage.map(point => ({ ...point })), offset: lfoPointOffset, limit: lfoPointLimit, total: lfoPoints.length,
                  ...(lfoPointOffset + lfoPointPage.length < lfoPoints.length ? { nextOffset: lfoPointOffset + lfoPointPage.length } : {})
                }
              }
            })
          }
        }
      }
    },
    {
      name: 'get_parameter_schema',
      description: 'Discover parameter units, ranges, defaults, curves, choices, and modulation capabilities.',
      inputSchema: {
        type: 'object', properties: {
          group: { type: 'string', maxLength: MAX_QUERY_LENGTH },
          search: { type: 'string', maxLength: MAX_QUERY_LENGTH },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE },
          sourceOffset: { type: 'integer', minimum: 0 },
          sourceLimit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE }
        }, additionalProperties: false
      },
      annotations: { readOnlyHint: true },
      execute(input) {
        const value = assertObject(input, 'input', ['group', 'search', 'offset', 'limit', 'sourceOffset', 'sourceLimit'])
        if (value.group !== undefined && typeof value.group !== 'string') throw new Error('group must be a string')
        if (value.search !== undefined && typeof value.search !== 'string') throw new Error('search must be a string')
        if ((value.group as string | undefined)?.length && (value.group as string).length > MAX_QUERY_LENGTH) throw new Error(`group is limited to ${MAX_QUERY_LENGTH} characters`)
        if ((value.search as string | undefined)?.length && (value.search as string).length > MAX_QUERY_LENGTH) throw new Error(`search is limited to ${MAX_QUERY_LENGTH} characters`)
        const matches = filteredParameters(value.group as string | undefined, value.search as string | undefined)
        const offset = boundedInteger(value.offset, 'offset', 0, 0, PARAMS.length)
        const limit = boundedInteger(value.limit, 'limit', 5, 1, MAX_PAGE_SIZE)
        const page = matches.slice(offset, offset + limit)
        const parameters = page.map(def => ({
          id: def.id, name: def.name, group: def.group,
          min: def.choices ? 0 : def.min,
          max: def.choices ? def.choices.length - 1 : def.max,
          default: def.def,
          normalizedDefault: clean(defaultNorm(def)),
          ...(def.step === undefined ? {} : { step: def.step }),
          ...(def.choices ? { choices: [...def.choices] } : {}),
          ...(def.unit === undefined ? {} : { unit: def.unit }),
          curve: def.curve ?? 'lin',
          moddable: def.moddable === true
        }))
        const sourceOffset = value.sourceOffset === undefined ? undefined : boundedInteger(value.sourceOffset, 'sourceOffset', 0, 0, MOD_SOURCES.length)
        const sourceLimit = boundedInteger(value.sourceLimit, 'sourceLimit', 5, 1, MAX_PAGE_SIZE)
        const sources = sourceOffset === undefined ? [] : MOD_SOURCES.slice(sourceOffset, sourceOffset + sourceLimit)
        return {
          groups: [...new Set(PARAMS.map(def => def.group))],
          parameters: { items: parameters, offset, limit, total: matches.length, ...(offset + page.length < matches.length ? { nextOffset: offset + page.length } : {}) },
          ...(sourceOffset === undefined ? {} : {
            modulationSources: { items: sources.map(source => ({ ...source })), offset: sourceOffset, limit: sourceLimit, total: MOD_SOURCES.length, ...(sourceOffset + sources.length < MOD_SOURCES.length ? { nextOffset: sourceOffset + sources.length } : {}) }
          }),
          limits: {
            modulationSlots: MAX_MOD_SLOTS,
            modulationDepth: [-1, 1],
            midiNotes: [0, 127],
            maxNotes: MAX_NOTES,
            maxPlaySeconds: MAX_PLAY_SECONDS,
            maxRenderSeconds: MAX_RENDER_SECONDS
          }
        }
      }
    },
    {
      name: 'update_parameters',
      description: 'Atomically validate and apply a batch of raw-unit parameter values or textual choice labels.',
      inputSchema: {
        type: 'object',
        properties: {
          updates: {
            type: 'array', minItems: 1,
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, value: { anyOf: [{ type: 'number' }, { type: 'string' }] } },
              required: ['id', 'value'], additionalProperties: false
            }
          }
        },
        required: ['updates'], additionalProperties: false
      },
      annotations: { readOnlyHint: false },
      execute(input) {
        assertPerformanceIdle('Parameter updates')
        const value = assertObject(input, 'input', ['updates'], ['updates'])
        if (!Array.isArray(value.updates) || value.updates.length === 0) throw new Error('updates must be a non-empty array')
        const seen = new Set<string>()
        const validated = value.updates.map((item, index) => {
          const update = assertObject(item, `updates[${index}]`, ['id', 'value'], ['id', 'value'])
          if (typeof update.id !== 'string') throw new Error(`updates[${index}].id must be a string`)
          const id = update.id
          const def = PARAMS.find(candidate => candidate.id === id)
          if (!def) throw new Error(`Unknown parameter: ${id}`)
          if (seen.has(id)) throw new Error(`Duplicate parameter ID: ${id}`)
          seen.add(id)
          const raw = canonicalRaw(def, update.value)
          return { id, index: paramIndex(id), def, raw, normalized: valueToNorm(def, raw) }
        })
        for (const update of validated) engine.setParam(update.index, update.normalized)
        return {
          applied: validated.map(update => ({
            id: update.id,
            raw: update.raw,
            normalized: clean(update.normalized),
            formatted: formatValue(update.def, update.normalized)
          }))
        }
      }
    },
    {
      name: 'set_modulation',
      description: 'Add, update, remove, or clear validated modulation routes in the shared 32-slot matrix.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'update', 'remove', 'clear'] },
          source: { type: 'string' }, destination: { type: 'string' },
          depth: { type: 'number', minimum: -1, maximum: 1 },
          enabled: { type: 'boolean' }, slot: { type: 'integer', minimum: 0, maximum: 31 }
        },
        required: ['action'], additionalProperties: false
      },
      annotations: { readOnlyHint: false },
      execute(input) {
        assertPerformanceIdle('Modulation changes')
        const value = assertObject(input, 'input', ['action', 'source', 'destination', 'depth', 'enabled', 'slot'], ['action'])
        if (!['add', 'update', 'remove', 'clear'].includes(value.action as string)) throw new Error('Unknown modulation action')
        const action = value.action as string
        const count = () => engine.modSlots.filter(Boolean).length
        if (action === 'clear') {
          assertObject(input, 'input', ['action'], ['action'])
          engine.modSlots.forEach((route, slot) => { if (route) engine.setModSlot(slot, null) })
          return { cleared: true, count: count() }
        }
        if (action === 'remove') {
          assertObject(input, 'input', ['action', 'slot'], ['action', 'slot'])
          const slot = finite(value.slot, 'slot')
          if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_MOD_SLOTS) throw new Error('slot must be an integer in range 0..31')
          if (!engine.modSlots[slot]) throw new Error(`Modulation slot ${slot} is empty`)
          engine.setModSlot(slot, null)
          return { removed: slot, count: count() }
        }
        if (action === 'update') {
          assertObject(input, 'input', ['action', 'slot', 'depth', 'enabled'], ['action', 'slot'])
          const slot = finite(value.slot, 'slot')
          if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_MOD_SLOTS) throw new Error('slot must be an integer in range 0..31')
          const current = engine.modSlots[slot]
          if (!current) throw new Error(`Modulation slot ${slot} is empty`)
          if (value.depth === undefined && value.enabled === undefined) throw new Error('update requires depth and/or enabled')
          const depth = value.depth === undefined ? current.depth : finite(value.depth, 'depth')
          if (depth < -1 || depth > 1) throw new Error('depth must be in range -1..1')
          if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('enabled must be boolean')
          const route = { ...current, depth, enabled: value.enabled === undefined ? current.enabled : value.enabled }
          engine.setModSlot(slot, route)
          return { route: routeValue(slot, route), count: count() }
        }
        assertObject(input, 'input', ['action', 'source', 'destination', 'depth', 'enabled'], ['action', 'source', 'destination', 'depth'])
        if (typeof value.source !== 'string') throw new Error('source must be a string')
        let source: number
        try { source = modSourceIndex(value.source) } catch { throw new Error(`Unknown modulation source: ${value.source}`) }
        if (typeof value.destination !== 'string') throw new Error('destination must be a string')
        const def = PARAMS.find(candidate => candidate.id === value.destination)
        if (!def) throw new Error(`Unknown modulation destination: ${value.destination}`)
        if (!def.moddable) throw new Error(`Destination is not moddable: ${def.id}`)
        const depth = finite(value.depth, 'depth')
        if (depth < -1 || depth > 1) throw new Error('depth must be in range -1..1')
        if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('enabled must be boolean')
        const dest = paramIndex(def.id)
        const existingSlot = engine.modSlots.findIndex(route => route?.source === source && route.dest === dest)
        let slot = existingSlot
        if (slot < 0) slot = engine.modSlots.findIndex(route => route === null)
        if (slot < 0) throw new Error('Modulation matrix is full')
        const existing = existingSlot >= 0 ? engine.modSlots[existingSlot] : null
        const route = {
          source,
          dest,
          depth,
          enabled: value.enabled === undefined ? (existing?.enabled ?? true) : value.enabled
        }
        engine.setModSlot(slot, route)
        return { route: routeValue(slot, route), count: count() }
      }
    },
    {
      name: 'play_notes',
      description: 'Play a bounded sequence of MIDI notes with relative real-time start and duration values. Requires runtime.running=true; otherwise click CLICK TO START AUDIO first.',
      inputSchema: {
        type: 'object', properties: { notes: { type: 'array', minItems: 1, maxItems: MAX_NOTES, items: noteSchema } },
        required: ['notes'], additionalProperties: false
      },
      annotations: { readOnlyHint: false },
      async execute(input, options) {
        return runPerformance(invocationSignal(options), async operationSignal => {
          const value = assertObject(input, 'input', ['notes'], ['notes'])
          const sequence = validateNotes(value.notes, MAX_PLAY_SECONDS)
          if (!engine.running) throw new Error('Start audio with a user gesture before playing notes')
          assertNotesAvailable(engine, sequence.notes)
          throwIfAborted(operationSignal)
          await performNotes(engine, sequence.notes, operationSignal)
          return { noteCount: sequence.notes.length, duration: sequence.duration, completed: true }
        })
      }
    },
    {
      name: 'render_audio',
      description: 'Record the live AudioWorklet output in real time while playing a bounded note sequence; this is not offline or deterministic. Requires runtime.running=true; otherwise click CLICK TO START AUDIO first.',
      inputSchema: {
        type: 'object',
        properties: {
          notes: { type: 'array', minItems: 1, maxItems: MAX_NOTES, items: noteSchema },
          duration: { type: 'number', exclusiveMinimum: 0, maximum: MAX_RENDER_SECONDS }
        },
        required: ['notes'], additionalProperties: false
      },
      annotations: { readOnlyHint: false },
      async execute(input, options) {
        return runPerformance(invocationSignal(options), async operationSignal => {
          const value = assertObject(input, 'input', ['notes', 'duration'], ['notes'])
          const sequence = validateNotes(value.notes, MAX_RENDER_SECONDS)
          if (!engine.running) throw new Error('Start audio with a user gesture before rendering audio')
          const duration = value.duration === undefined
            ? Math.min(MAX_RENDER_SECONDS, clean(sequence.duration + 0.25))
            : finite(value.duration, 'duration')
          if (duration <= 0 || duration > MAX_RENDER_SECONDS) throw new Error(`Render duration must be > 0 and limited to ${MAX_RENDER_SECONDS} seconds`)
          if (duration < sequence.duration) throw new Error('Render duration must cover the complete note sequence')
          assertNotesAvailable(engine, sequence.notes)
          throwIfAborted(operationSignal)
          const controller = new AbortController()
          const forwardAbort = () => controller.abort()
          operationSignal.addEventListener('abort', forwardAbort, { once: true })
          const recordingTask = engine.recordOutput(duration, controller.signal)
          const notesTask = performNotes(engine, sequence.notes, controller.signal)
          try {
            const [recording] = await Promise.all([recordingTask, notesTask])
            throwIfAborted(operationSignal)
            const metrics = await analyzeAudioAsync(recording.channelData, recording.sampleRate, operationSignal)
            if (session.lastRender) URL.revokeObjectURL(session.lastRender.url)
            const url = URL.createObjectURL(recording.blob)
            session.lastRender = { metrics, sampleRate: recording.sampleRate, channels: recording.channelData.length, url }
            return {
              renderMode: 'realtime',
              mimeType: recording.mimeType,
              url,
              duration: recording.duration,
              sampleRate: recording.sampleRate,
              channels: recording.channelData.length,
              metrics
            }
          } catch (error) {
            controller.abort()
            await Promise.allSettled([recordingTask, notesTask])
            throw error
          } finally {
            controller.abort()
            operationSignal.removeEventListener('abort', forwardAbort)
          }
        })
      }
    },
    {
      name: 'analyze_audio',
      description: 'Analyze the most recent real-time render, or explicitly fall back to the current live scope buffers.',
      inputSchema: emptySchema,
      annotations: { readOnlyHint: true },
      execute(input) {
        assertObject(input, 'input', [])
        return currentCandidate()
      }
    },
    {
      name: 'analyze_reference_audio',
      description: 'Decode a short Base64 audio reference in memory and analyze it with the same metrics as synth output.',
      inputSchema: {
        type: 'object',
        properties: {
          audioBase64: { type: 'string', minLength: 1, maxLength: MAX_AUDIO_BASE64_CHARACTERS },
          name: { type: 'string', minLength: 1, maxLength: MAX_REFERENCE_NAME_LENGTH },
          mimeType: { type: 'string', minLength: 1, maxLength: MAX_MIME_TYPE_LENGTH, pattern: '^[aA][uU][dD][iI][oO]/' }
        },
        required: ['audioBase64'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input, options) {
        const signal = invocationSignal(options)
        const invocationGeneration = ++session.referenceGeneration
        return runReferenceAnalysis(signal, invocationGeneration, async (operationSignal, assertCurrent) => {
          const value = assertObject(input, 'input', ['audioBase64', 'name', 'mimeType'], ['audioBase64'])
          if (typeof value.audioBase64 !== 'string') throw new Error('audioBase64 must be a string')
          if (value.audioBase64.length === 0 || value.audioBase64.trim().length === 0) {
            throw new Error('audioBase64 must not be empty')
          }
          if (value.audioBase64.length > MAX_AUDIO_BASE64_CHARACTERS) {
            throw new Error('audioBase64 is limited to 16 MiB characters')
          }
          const name = validateReferenceName(value.name)
          const requestedMimeType = validateAudioMimeType(value.mimeType)
          assertCurrent()
          const decoded = await decodeAudio(value.audioBase64, { context: engine.ctx, signal: operationSignal })
          assertCurrent()
          const metrics = await analyzeAudioAsync(decoded.channelData, decoded.sampleRate, operationSignal)
          assertCurrent()
          const decodedMimeType = decoded.mimeType === undefined ? undefined : normalizeAudioMimeType(decoded.mimeType)
          if (requestedMimeType && decodedMimeType && requestedMimeType !== decodedMimeType) {
            throw new Error(`mimeType conflicts with data URI MIME type ${decodedMimeType}`)
          }
          const mimeType = requestedMimeType ?? decodedMimeType
          const analysis: ReferenceAnalysis = {
            source: 'base64-reference',
            ...(name ? { name } : {}),
            ...(mimeType ? { mimeType } : {}),
            decodedBytes: decoded.decodedBytes,
            duration: decoded.duration,
            sampleRate: decoded.sampleRate,
            channels: decoded.channels,
            metrics
          }
          assertCurrent()
          session.lastReference = analysis
          return analysis
        })
      }
    },
    {
      name: 'compare_audio',
      description: 'Compare the latest Base64 reference analysis with the same synth candidate selected by analyze_audio.',
      inputSchema: emptySchema,
      annotations: { readOnlyHint: true },
      execute(input, options) {
        const signal = invocationSignal(options)
        if (signal.aborted || lifecycleSignal?.aborted) throw abortError()
        assertObject(input, 'input', [])
        if (!session.lastReference) throw new Error('Call analyze_reference_audio first before compare_audio')
        const candidate = currentCandidate()
        if (signal.aborted || lifecycleSignal?.aborted) throw abortError()
        return {
          reference: session.lastReference,
          candidate,
          comparison: compareAudioMetrics(session.lastReference.metrics, candidate.metrics)
        }
      }
    },
    {
      name: 'save_preset',
      description: 'Save the complete current patch to localStorage under a validated name, replacing that name if present.',
      inputSchema: {
        type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 80 } },
        required: ['name'], additionalProperties: false
      },
      annotations: { readOnlyHint: false },
      execute(input) {
        const value = assertObject(input, 'input', ['name'], ['name'])
        const name = validatePresetName(value.name)
        savePreset(engine.toPreset(name))
        return { name, saved: true }
      }
    },
    {
      name: 'load_preset',
      description: 'Load a named user preset previously saved to localStorage and return its verifiable resulting state. Factory presets from the UI dropdown are not included.',
      inputSchema: {
        type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 80 } },
        required: ['name'], additionalProperties: false
      },
      annotations: { readOnlyHint: false },
      execute(input) {
        assertPerformanceIdle('Preset loading')
        const value = assertObject(input, 'input', ['name'], ['name'])
        const name = validatePresetName(value.name)
        const preset = loadPreset(name)
        if (!preset) throw new Error(`Preset not found: ${name}`)
        const validated = validatePresetData(preset)
        engine.loadPreset(validated)
        return { name, loaded: true }
      }
    }
  ]
}
