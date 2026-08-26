import type { SynthEngine } from '../audio/engine'
import {
  PARAMS, defaultNorm, formatValue, normToValue, paramIndex, valueToNorm,
  type ParamDef
} from '../shared/params'
import { FX_IDS, MAX_MOD_SLOTS, MOD_SOURCES, modSourceIndex, type ModSlotState } from '../shared/messages'
import { analyzeAudio, type AudioMetrics } from '../shared/audio-analysis'
import { loadPreset, savePreset, validatePresetData, validatePresetName } from '../shared/preset-store'

export const WEBMCP_TOOL_NAMES = [
  'get_synth_state',
  'get_parameter_schema',
  'update_parameters',
  'set_modulation',
  'play_notes',
  'render_audio',
  'analyze_audio',
  'save_preset',
  'load_preset'
] as const

const MAX_NOTES = 128
const MAX_PLAY_SECONDS = 30
const MAX_RENDER_SECONDS = 15
const MAX_QUERY_LENGTH = 100

type Input = Record<string, unknown>
interface ValidNote { midi: number; velocity: number; start: number; duration: number }

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

function snapshot(engine: SynthEngine) {
  const parameters: Record<string, ReturnType<typeof parameterValue>> = {}
  PARAMS.forEach((def, index) => { parameters[def.id] = parameterValue(def, engine.values[index]) })
  const modulations = engine.modSlots.flatMap((route, slot) => route ? [routeValue(slot, route)] : [])
  const lfoShapes = engine.lfoShapes.map((points, index) => ({
    id: `lfo${index + 1}`,
    points: points.map(point => ({ ...point }))
  }))
  return {
    patch: {
      parameters,
      modulations,
      lfoShapes,
      fxOrder: engine.fxOrder.map(index => FX_IDS[index]).filter((id): id is (typeof FX_IDS)[number] => id !== undefined)
    },
    runtime: {
      running: engine.running,
      heldNotes: [...engine.heldNotes].sort((a, b) => a - b),
      voices: engine.voiceCount,
      peaks: { left: engine.peakL, right: engine.peakR }
    }
  }
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
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
export function createWebMcpTools(engine: SynthEngine, lifecycleSignal?: AbortSignal): WebMCP.ModelContextTool[] {
  let lastRender: { metrics: AudioMetrics; sampleRate: number; channels: number; url: string } | null = null
  let performanceInProgress = false

  const cleanupRender = () => {
    if (lastRender) URL.revokeObjectURL(lastRender.url)
    lastRender = null
  }
  lifecycleSignal?.addEventListener('abort', cleanupRender, { once: true })

  async function runPerformance<T>(signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (performanceInProgress) throw new Error('A WebMCP performance is already in progress')
    performanceInProgress = true
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
      performanceInProgress = false
    }
  }

  return [
    {
      name: 'get_synth_state',
      description: 'Get the complete live Soundgineer patch and runtime state using stable semantic IDs.',
      inputSchema: emptySchema,
      annotations: { readOnlyHint: true },
      execute(input) {
        assertObject(input, 'input', [])
        return snapshot(engine)
      }
    },
    {
      name: 'get_parameter_schema',
      description: 'Discover parameter units, ranges, defaults, curves, choices, and modulation capabilities.',
      inputSchema: {
        type: 'object', properties: {
          group: { type: 'string', maxLength: MAX_QUERY_LENGTH },
          search: { type: 'string', maxLength: MAX_QUERY_LENGTH }
        }, additionalProperties: false
      },
      annotations: { readOnlyHint: true },
      execute(input) {
        const value = assertObject(input, 'input', ['group', 'search'])
        if (value.group !== undefined && typeof value.group !== 'string') throw new Error('group must be a string')
        if (value.search !== undefined && typeof value.search !== 'string') throw new Error('search must be a string')
        if ((value.group as string | undefined)?.length && (value.group as string).length > MAX_QUERY_LENGTH) throw new Error(`group is limited to ${MAX_QUERY_LENGTH} characters`)
        if ((value.search as string | undefined)?.length && (value.search as string).length > MAX_QUERY_LENGTH) throw new Error(`search is limited to ${MAX_QUERY_LENGTH} characters`)
        const group = (value.group as string | undefined)?.toLowerCase()
        const search = (value.search as string | undefined)?.toLowerCase()
        const parameters = PARAMS.filter(def =>
          (!group || def.group.toLowerCase() === group) &&
          (!search || `${def.id} ${def.name} ${def.group}`.toLowerCase().includes(search))
        ).map(def => ({
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
        return {
          parameters,
          modulationSources: MOD_SOURCES.map(source => ({ ...source })),
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
      execute(input) {
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
      execute(input) {
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
      description: 'Play a bounded sequence of MIDI notes with relative real-time start and duration values.',
      inputSchema: {
        type: 'object', properties: { notes: { type: 'array', minItems: 1, maxItems: MAX_NOTES, items: noteSchema } },
        required: ['notes'], additionalProperties: false
      },
      async execute(input, { signal }) {
        return runPerformance(signal, async operationSignal => {
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
      description: 'Record the live AudioWorklet output in real time while playing a bounded note sequence; this is not offline or deterministic.',
      inputSchema: {
        type: 'object',
        properties: {
          notes: { type: 'array', minItems: 1, maxItems: MAX_NOTES, items: noteSchema },
          duration: { type: 'number', exclusiveMinimum: 0, maximum: MAX_RENDER_SECONDS }
        },
        required: ['notes'], additionalProperties: false
      },
      async execute(input, { signal }) {
        return runPerformance(signal, async operationSignal => {
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
            const metrics = analyzeAudio(recording.channelData, recording.sampleRate)
            if (lastRender) URL.revokeObjectURL(lastRender.url)
            const url = URL.createObjectURL(recording.blob)
            lastRender = { metrics, sampleRate: recording.sampleRate, channels: recording.channelData.length, url }
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
        if (lastRender) return {
          source: 'last-render', sampleRate: lastRender.sampleRate, channels: lastRender.channels,
          url: lastRender.url, metrics: lastRender.metrics
        }
        const sampleRate = engine.ctx?.sampleRate ?? 48000
        return {
          source: 'scope', sampleRate, channels: 2,
          metrics: analyzeAudio([engine.scopeL, engine.scopeR], sampleRate)
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
      execute(input) {
        const value = assertObject(input, 'input', ['name'], ['name'])
        const name = validatePresetName(value.name)
        savePreset(engine.toPreset(name))
        return { name, saved: true, state: snapshot(engine) }
      }
    },
    {
      name: 'load_preset',
      description: 'Load a named localStorage preset through the live engine and return its verifiable resulting state.',
      inputSchema: {
        type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 80 } },
        required: ['name'], additionalProperties: false
      },
      execute(input) {
        const value = assertObject(input, 'input', ['name'], ['name'])
        const name = validatePresetName(value.name)
        const preset = loadPreset(name)
        if (!preset) throw new Error(`Preset not found: ${name}`)
        const validated = validatePresetData(preset)
        engine.loadPreset(validated)
        return { name, loaded: true, state: snapshot(engine) }
      }
    }
  ]
}
