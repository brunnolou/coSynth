import type { RecordedAudio, SynthEngine } from '../audio/engine'
import { agentActivityFor } from './activity'
import {
  PARAMS, defaultNorm, formatValue, normToValue, paramIndex, valueToNorm,
  type ParamDef
} from '../shared/params'
import { FX_IDS, MAX_MOD_SLOTS, MOD_SOURCES, modSourceIndex, type ModSlotState } from '../shared/messages'
import { analyzeAudio, compareAudioMetrics, type AudioMetrics, type AudioMetricsComparison } from '../shared/audio-analysis'
import { listPresets, loadPreset, savePreset, validatePresetData, validatePresetName } from '../shared/preset-store'
import { decodeBase64Audio, MAX_AUDIO_BASE64_CHARACTERS, normalizeAudioMimeType } from './audio-input'
import { analyzeAudioAbortably } from './audio-analysis-task'
import { BASE64_MAX_SECONDS, monoWavBase64, offlineRenderAvailable, renderOffline, type OfflineRenderer } from './offline-render'
import { PerformanceManager, performNotes, assertNotesAvailable, validatePerformanceNotes } from '../history/performance'
import type { ReplayStore } from '../history/replays'

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
  'load_preset',
  'list_presets'
] as const

const MAX_NOTES = 128
const MAX_PLAY_SECONDS = 30
const MAX_RENDER_SECONDS = 15
const MAX_QUERY_LENGTH = 100
const MAX_REFERENCE_NAME_LENGTH = 255
const MAX_MIME_TYPE_LENGTH = 127
const MAX_PAGE_SIZE = 60
const COMPACT_PAGE_SIZE = PARAMS.length
const DEFAULT_PAGE_SIZE = 5
const PARAMETER_GROUPS = [...new Set(PARAMS.map(def => def.group))]

type Input = Record<string, unknown>
type DecodeAudio = typeof decodeBase64Audio

export interface WebMcpToolDependencies {
  decodeAudio?: DecodeAudio
  analyzeAudioAsync?: typeof analyzeAudioAbortably
  /**
   * Renders a note sequence without the live graph. Defaults to
   * `renderOffline()` when this browser has `OfflineAudioContext` and the
   * AudioWorklet; injected the same way as `decodeAudio` in tests.
   */
  renderOffline?: OfflineRenderer
  performance?: PerformanceManager
  replays?: ReplayStore
  currentSoundEntryId?: () => string
  onComparison?: (comparison: AudioMetricsComparison, soundEntryId?: string) => void
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
  lastRender: { metrics: AudioMetrics; sampleRate: number; channels: number; url: string; soundEntryId?: string } | null
  lastReference: ReferenceAnalysis | null
  referenceGeneration: number
  activeReferenceController: AbortController | null
  performance: PerformanceManager
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
      performance: new PerformanceManager()
    }
    sessions.set(engine, session)
  }
  return session
}

function accepted(allowed: readonly string[]): string {
  return allowed.length === 0 ? 'Accepted: (no properties)' : `Accepted: ${allowed.join(', ')}`
}

function assertObject(value: unknown, label: string, allowed: readonly string[], required: readonly string[] = []): Input {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const input = value as Input
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new Error(`Unexpected ${label} property '${key}'. ${accepted(allowed)}`)
  }
  for (const key of required) {
    if (!(key in input)) throw new Error(`${label}.${key} is required. Required: ${required.join(', ')}. ${accepted(allowed)}`)
  }
  return input
}

/** Edit distance capped at `limit`; returns limit + 1 once the budget is exceeded. */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        previous[j] + 1,
        row[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
    if (Math.min(...row) > limit) return limit + 1
    previous = row
  }
  return previous[b.length]
}

/** Up to three near candidates: prefix matches first, then edit distance <= 2. */
function suggest(id: string, candidates: readonly string[], max = 3): string[] {
  const needle = id.toLowerCase()
  const prefix = candidates.filter(candidate => candidate.toLowerCase().startsWith(needle))
  const near = candidates
    .filter(candidate => !prefix.includes(candidate))
    .map(candidate => ({ candidate, distance: editDistance(needle, candidate.toLowerCase(), 2) }))
    .filter(entry => entry.distance <= 2)
    .sort((a, b) => a.distance - b.distance)
    .map(entry => entry.candidate)
  return [...prefix, ...near].slice(0, max)
}

function didYouMean(id: string, candidates: readonly string[]): string {
  const matches = suggest(id, candidates)
  return matches.length === 0 ? '' : ` Did you mean ${matches.join(', ')}?`
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

/** One parameter as a single line: `filter1.cutoff Hz 20..20000 exp =8000 mod`. */
function compactParameter(def: ParamDef): string {
  const parts = [def.id]
  if (def.unit) parts.push(def.unit)
  if (def.choices) parts.push(`{${def.choices.join('|')}}`)
  else {
    parts.push(`${def.min}..${def.max}`)
    if (def.curve === 'exp') parts.push('exp')
    if (def.step !== undefined) parts.push(`step${def.step}`)
  }
  parts.push(`=${def.def}`)
  if (def.moddable === true) parts.push('mod')
  return parts.join(' ')
}

function assertFormat(value: unknown): 'full' | 'compact' {
  if (value === undefined) return 'full'
  if (value !== 'full' && value !== 'compact') throw new Error("format must be 'full' or 'compact'")
  return value
}

const RENDER_MODES = ['offline', 'realtime'] as const
const RENDER_FORMATS = ['metrics', 'url', 'base64'] as const
type RenderMode = (typeof RENDER_MODES)[number]
type RenderFormat = (typeof RENDER_FORMATS)[number]

function assertRenderMode(value: unknown): RenderMode | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !RENDER_MODES.includes(value as RenderMode)) {
    throw new Error(`mode must be one of ${RENDER_MODES.join(', ')}`)
  }
  return value as RenderMode
}

function assertRenderFormat(value: unknown): RenderFormat {
  if (value === undefined) return 'metrics'
  if (typeof value !== 'string' || !RENDER_FORMATS.includes(value as RenderFormat)) {
    throw new Error(`format must be one of ${RENDER_FORMATS.join(', ')}`)
  }
  return value as RenderFormat
}

/** A single-pitch sequence gets harmonic analysis for free (plan Task 7.4). */
function analysisOptionsFor(notes: readonly { midi: number }[]): { f0Hz?: number } {
  const pitches = new Set(notes.map(note => note.midi))
  if (pitches.size !== 1) return {}
  const [midi] = [...pitches]
  return { f0Hz: 440 * Math.pow(2, (midi - 69) / 12) }
}

/**
 * Resolve the offline renderer once per tool set: an injected dependency, then
 * an engine that carries its own renderer, then the real implementation when
 * this browser can render offline at all.
 */
function resolveOfflineRenderer(engine: SynthEngine, dependencies: WebMcpToolDependencies): OfflineRenderer | null {
  if (dependencies.renderOffline) return dependencies.renderOffline
  const own = (engine as Partial<{
    renderOffline: (notes: readonly { midi: number; velocity: number; start: number; duration: number }[], duration: number) => Promise<RecordedAudio>
  }>).renderOffline
  if (typeof own === 'function') return (target, notes, duration) => own.call(target, notes, duration)
  return offlineRenderAvailable() ? renderOffline : null
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

function canonicalRaw(def: ParamDef, value: unknown): number {
  if (typeof value === 'string') {
    if (!def.choices) throw new Error(`${def.id} does not accept a choice label`)
    const choice = def.choices.indexOf(value)
    if (choice < 0) {
      throw new Error(`Unknown choice '${value}' for ${def.id}.${didYouMean(value, def.choices)} Choices: ${def.choices.join(', ')}`)
    }
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
  const performance = dependencies.performance ?? session.performance
  agentActivityFor(engine)
  const decodeAudio = dependencies.decodeAudio ?? decodeBase64Audio
  const analyzeAudioAsync = dependencies.analyzeAudioAsync ?? analyzeAudioAbortably
  const offlineRenderer = resolveOfflineRenderer(engine, dependencies)

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
    return performance.run(operationSignal => runAbortable(operationSignal, task), signal)
  }

  function assertPerformanceIdle(action: string): void {
    if (performance.active) throw new Error(`${action} is unavailable while a performance is in progress`)
  }

  function scopeCandidate() {
    const sampleRate = engine.ctx?.sampleRate ?? 48000
    return {
      source: 'scope' as const,
      sampleRate,
      channels: 2,
      metrics: analyzeAudio([engine.scopeL, engine.scopeR], sampleRate)
    }
  }

  function currentCandidate() {
    if (session.lastRender) return {
      source: 'last-render' as const,
      sampleRate: session.lastRender.sampleRate,
      channels: session.lastRender.channels,
      url: session.lastRender.url,
      metrics: session.lastRender.metrics
    }
    return scopeCandidate()
  }

  return [
    {
      name: 'get_synth_state',
      description: 'Get live synth state. Call with `format: "compact"` to see every parameter that differs from its default as `id=formatted` lines — the cheapest way to verify a patch. Runtime, modulation routes, and FX order are returned by default; use group/search/offset for a detailed parameter page, or `lfo` for one LFO shape.',
      inputSchema: {
        type: 'object', properties: {
          format: { type: 'string', enum: ['full', 'compact'] },
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
          'format', 'group', 'search', 'parameterOffset', 'parameterLimit', 'modulationOffset', 'modulationLimit',
          'lfo', 'lfoPointOffset', 'lfoPointLimit'
        ])
        const format = assertFormat(value.format)
        if (value.group !== undefined && typeof value.group !== 'string') throw new Error('group must be a string')
        if (value.search !== undefined && typeof value.search !== 'string') throw new Error('search must be a string')
        const group = value.group as string | undefined
        const search = value.search as string | undefined
        if (group && group.length > MAX_QUERY_LENGTH) throw new Error(`group is limited to ${MAX_QUERY_LENGTH} characters`)
        if (search && search.length > MAX_QUERY_LENGTH) throw new Error(`search is limited to ${MAX_QUERY_LENGTH} characters`)
        const offset = boundedInteger(value.parameterOffset, 'parameterOffset', 0, 0, PARAMS.length)
        const limit = boundedInteger(value.parameterLimit, 'parameterLimit', format === 'compact' ? COMPACT_PAGE_SIZE : DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE)
        const matches = filteredParameters(group, search)
        const includeParameters = format === 'compact' || group !== undefined || search !== undefined || value.parameterOffset !== undefined || value.parameterLimit !== undefined
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
        const changed = format !== 'compact' ? [] : matches.flatMap(def => {
          const normalized = engine.values[paramIndex(def.id)]
          return Math.abs(normalized - defaultNorm(def)) < 1e-6 ? [] : [`${def.id}=${formatValue(def, normalized)}`]
        })
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
              parameters: format === 'compact'
                ? { items: changed, total: changed.length, format: 'compact' as const }
                : {
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
      description: 'Discover parameter units, ranges, defaults, curves, choices, and modulation capabilities. Call once with `format: "compact"` to see every parameter as one line each (`filter1.cutoff Hz 20..20000 exp =8000 mod`); use group/search/offset for detail in the full format.',
      inputSchema: {
        type: 'object', properties: {
          format: { type: 'string', enum: ['full', 'compact'] },
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
        const value = assertObject(input, 'input', ['format', 'group', 'search', 'offset', 'limit', 'sourceOffset', 'sourceLimit'])
        const format = assertFormat(value.format)
        if (value.group !== undefined && typeof value.group !== 'string') throw new Error('group must be a string')
        if (value.search !== undefined && typeof value.search !== 'string') throw new Error('search must be a string')
        if ((value.group as string | undefined)?.length && (value.group as string).length > MAX_QUERY_LENGTH) throw new Error(`group is limited to ${MAX_QUERY_LENGTH} characters`)
        if ((value.search as string | undefined)?.length && (value.search as string).length > MAX_QUERY_LENGTH) throw new Error(`search is limited to ${MAX_QUERY_LENGTH} characters`)
        const matches = filteredParameters(value.group as string | undefined, value.search as string | undefined)
        const offset = boundedInteger(value.offset, 'offset', 0, 0, PARAMS.length)
        // An explicit limit is bounded by what the schema advertises; only the
        // compact default reaches past it, to hand over the whole space at once.
        const limit = boundedInteger(value.limit, 'limit', format === 'compact' ? COMPACT_PAGE_SIZE : DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE)
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
          groups: [...PARAMETER_GROUPS],
          parameters: format === 'compact'
            ? {
              items: page.map(compactParameter), total: matches.length, format: 'compact' as const,
              ...(offset + page.length < matches.length ? { nextOffset: offset + page.length } : {})
            }
            : { items: parameters, offset, limit, total: matches.length, ...(offset + page.length < matches.length ? { nextOffset: offset + page.length } : {}) },
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
      description: 'Atomically validate and apply a batch of raw-unit parameter values or textual choice labels. Example: {"updates":[{"id":"filter1.cutoff","value":1200},{"id":"filter1.type","value":"LP 24"}]}',
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
          if (!def) {
            throw new Error(`Unknown parameter '${id}'.${didYouMean(id, PARAMS.map(candidate => candidate.id))} Groups: ${PARAMETER_GROUPS.join(', ')}`)
          }
          if (seen.has(id)) throw new Error(`Duplicate parameter ID: ${id}`)
          seen.add(id)
          const raw = canonicalRaw(def, update.value)
          return { id, index: paramIndex(id), def, raw, normalized: valueToNorm(def, raw) }
        })
        for (const update of validated) engine.setParam(update.index, update.normalized, 'ai')
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
      description: 'Add, update, remove, or clear validated modulation routes in the shared 32-slot matrix. `depth` is bipolar (-1..1): it is added to the destination parameter\'s normalized 0..1 value and the sum is clamped, so depth 0.5 on a parameter sitting at 0.5 sweeps it up to 1.0. Example: {"action":"add","source":"lfo1","destination":"filter1.cutoff","depth":0.4}',
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
          engine.modSlots.forEach((route, slot) => { if (route) engine.setModSlot(slot, null, 'ai') })
          return { cleared: true, count: count() }
        }
        if (action === 'remove') {
          assertObject(input, 'input', ['action', 'slot'], ['action', 'slot'])
          const slot = finite(value.slot, 'slot')
          if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_MOD_SLOTS) throw new Error('slot must be an integer in range 0..31')
          if (!engine.modSlots[slot]) throw new Error(`Modulation slot ${slot} is empty`)
          engine.setModSlot(slot, null, 'ai')
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
          engine.setModSlot(slot, route, 'ai')
          return { route: routeValue(slot, route), count: count() }
        }
        assertObject(input, 'input', ['action', 'source', 'destination', 'depth', 'enabled'], ['action', 'source', 'destination', 'depth'])
        if (typeof value.source !== 'string') throw new Error('source must be a string')
        let source: number
        const sourceIds = MOD_SOURCES.map(candidate => candidate.id)
        try { source = modSourceIndex(value.source) } catch {
          throw new Error(`Unknown modulation source '${value.source}'.${didYouMean(value.source, sourceIds)} Valid: ${sourceIds.join(', ')}`)
        }
        if (typeof value.destination !== 'string') throw new Error('destination must be a string')
        const def = PARAMS.find(candidate => candidate.id === value.destination)
        if (!def) {
          const moddable = PARAMS.filter(candidate => candidate.moddable).map(candidate => candidate.id)
          throw new Error(`Unknown modulation destination '${value.destination}'.${didYouMean(value.destination, moddable)} Destinations are moddable parameter ids; groups: ${PARAMETER_GROUPS.join(', ')}`)
        }
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
        engine.setModSlot(slot, route, 'ai')
        return { route: routeValue(slot, route), count: count() }
      }
    },
    {
      name: 'play_notes',
      description: 'Play a bounded sequence of MIDI notes with relative real-time start and duration values, in seconds. A repeated pitch retriggers its voice. Example: {"notes":[{"midi":60,"velocity":0.8,"start":0,"duration":0.5}]}. Requires runtime.running=true; otherwise click CLICK TO START AUDIO first.',
      inputSchema: {
        type: 'object', properties: { notes: { type: 'array', minItems: 1, maxItems: MAX_NOTES, items: noteSchema } },
        required: ['notes'], additionalProperties: false
      },
      annotations: { readOnlyHint: false },
      async execute(input, options) {
        return runPerformance(invocationSignal(options), async operationSignal => {
          const value = assertObject(input, 'input', ['notes'], ['notes'])
          const sequence = validatePerformanceNotes(value.notes, MAX_PLAY_SECONDS)
          if (!engine.running) throw new Error('Start audio with a user gesture before playing notes')
          assertNotesAvailable(engine, sequence.notes)
          throwIfAborted(operationSignal)
          const replayId = dependencies.replays?.startPerformance(sequence.notes, sequence.duration, 'AI note sequence', dependencies.currentSoundEntryId?.())
          try {
            await performance.trackPlayback(() => performNotes(engine, sequence.notes, operationSignal), 'ai')
            if (replayId) dependencies.replays!.finishPerformance(replayId, 'completed')
            return { noteCount: sequence.notes.length, duration: sequence.duration, completed: true, ...(sequence.overlaps > 0 ? { retriggered: sequence.overlaps } : {}) }
          } catch (error) {
            if (replayId) dependencies.replays!.finishPerformance(replayId, operationSignal.aborted ? 'cancelled' : 'failed')
            throw error
          }
        })
      }
    },
    {
      name: 'render_audio',
      description: 'Render a bounded note sequence and return audio metrics for it. Offline by default: repeatable scheduling, far faster than real time, and available before the human has started audio — only `play_notes` needs that gesture. Pass `mode: "realtime"` to capture the live AudioWorklet output instead (needs running audio); an offline request falls back to real time, and says so in `renderModeFallback`, on browsers without OfflineAudioContext. `format` selects the audio payload: "metrics" (default, metrics only), "url" (a page-local blob URL), or "base64" (mono 16-bit WAV, 22.05 kHz, first ' + BASE64_MAX_SECONDS + ' s, so an audio-capable agent can listen). A single-pitch sequence also gets `metrics.harmonics`. `peakDb` is an instantaneous peak — use `loudnessDb` or `rmsDb` to compare levels.',
      inputSchema: {
        type: 'object',
        properties: {
          notes: { type: 'array', minItems: 1, maxItems: MAX_NOTES, items: noteSchema },
          duration: { type: 'number', exclusiveMinimum: 0, maximum: MAX_RENDER_SECONDS },
          mode: { type: 'string', enum: [...RENDER_MODES] },
          format: { type: 'string', enum: [...RENDER_FORMATS] }
        },
        required: ['notes'], additionalProperties: false
      },
      annotations: { readOnlyHint: false },
      async execute(input, options) {
        return runPerformance(invocationSignal(options), async operationSignal => {
          const value = assertObject(input, 'input', ['notes', 'duration', 'mode', 'format'], ['notes'])
          const sequence = validatePerformanceNotes(value.notes, MAX_RENDER_SECONDS)
          const requestedMode = assertRenderMode(value.mode)
          const format = assertRenderFormat(value.format)
          const duration = value.duration === undefined
            ? Math.min(MAX_RENDER_SECONDS, clean(sequence.duration + 0.25))
            : finite(value.duration, 'duration')
          if (duration <= 0 || duration > MAX_RENDER_SECONDS) throw new Error(`Render duration must be > 0 and limited to ${MAX_RENDER_SECONDS} seconds`)
          if (duration < sequence.duration) throw new Error('Render duration must cover the complete note sequence')
          // Whether offline works here is a property of the browser, not of the
          // request: a default (mode-less) call on a browser without an offline
          // renderer must not be told to retry with `mode: "offline"`.
          const offlineUnavailable = offlineRenderer === null
          const wantsOffline = requestedMode === undefined ? !offlineUnavailable : requestedMode === 'offline'
          const renderModeFallback = wantsOffline && offlineUnavailable
            ? 'Offline rendering is unavailable here (no OfflineAudioContext or AudioWorklet); captured the live output in real time instead'
            : undefined
          const soundEntryId = dependencies.currentSoundEntryId?.()
          const analysisOptions = analysisOptionsFor(sequence.notes)
          const finish = (recording: RecordedAudio, metrics: AudioMetrics, renderMode: RenderMode) => {
            if (session.lastRender) URL.revokeObjectURL(session.lastRender.url)
            const url = URL.createObjectURL(recording.blob)
            session.lastRender = { metrics, sampleRate: recording.sampleRate, channels: recording.channelData.length, url, soundEntryId }
            return {
              renderMode,
              mimeType: recording.mimeType,
              duration: recording.duration,
              sampleRate: recording.sampleRate,
              channels: recording.channelData.length,
              metrics,
              ...(format === 'url' ? { url } : {}),
              ...(format === 'base64' ? { audio: monoWavBase64(recording.channelData, recording.sampleRate) } : {}),
              ...(renderModeFallback ? { renderModeFallback } : {}),
              ...(sequence.overlaps > 0 ? { retriggered: sequence.overlaps } : {})
            }
          }

          if (wantsOffline && offlineRenderer) {
            // No live graph, no held-note conflict, no Start gesture: the whole
            // point of the offline path.
            throwIfAborted(operationSignal)
            // The signal goes *into* the renderer: an offline render burns CPU
            // for as long as it takes, and without it a cancellation could only
            // be reported once the whole render had finished.
            const recording = await offlineRenderer(engine, sequence.notes, duration, { signal: operationSignal })
            throwIfAborted(operationSignal)
            const metrics = await analyzeAudioAsync(recording.channelData, recording.sampleRate, operationSignal, analysisOptions)
            return finish(recording, metrics, 'offline')
          }

          if (!engine.running) {
            throw new Error(offlineUnavailable
              ? 'Start audio with a user gesture before rendering audio: offline rendering is unavailable in this browser'
              : 'Start audio with a user gesture before rendering audio, or use mode: "offline"')
          }
          assertNotesAvailable(engine, sequence.notes)
          throwIfAborted(operationSignal)
          const replayId = dependencies.replays?.startPerformance(sequence.notes, duration, 'AI rendered sequence', soundEntryId)
          const controller = new AbortController()
          const forwardAbort = () => controller.abort()
          operationSignal.addEventListener('abort', forwardAbort, { once: true })
          let recordingTask: ReturnType<SynthEngine['recordOutput']> | undefined
          let notesTask: Promise<void> | undefined
          try {
            recordingTask = engine.recordOutput(duration, controller.signal)
            notesTask = performance.trackPlayback(() => performNotes(engine, sequence.notes, controller.signal), 'ai')
            const [recording] = await Promise.all([recordingTask, notesTask])
            throwIfAborted(operationSignal)
            const metrics = await analyzeAudioAsync(recording.channelData, recording.sampleRate, operationSignal, analysisOptions)
            if (replayId) dependencies.replays!.finishPerformance(replayId, 'completed')
            return finish(recording, metrics, 'realtime')
          } catch (error) {
            controller.abort()
            await Promise.allSettled([recordingTask, notesTask])
            if (replayId) dependencies.replays!.finishPerformance(replayId, operationSignal.aborted ? 'cancelled' : 'failed')
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
      description: 'Re-analyze the last `render_audio` result, or analyze the live output right now (`source: "scope"`) — useful while a human is playing. `render_audio` already returns the same metrics, so call this only when you need a fresh look without re-rendering. `peakDb` is an instantaneous peak — use `loudnessDb` or `rmsDb` to compare levels.',
      inputSchema: {
        type: 'object',
        properties: { source: { type: 'string', enum: ['scope', 'last-render'] } },
        additionalProperties: false
      },
      annotations: { readOnlyHint: true },
      execute(input) {
        const value = assertObject(input, 'input', ['source'])
        if (value.source !== undefined && value.source !== 'scope' && value.source !== 'last-render') {
          throw new Error("source must be 'scope' or 'last-render'")
        }
        if (value.source === 'scope') return scopeCandidate()
        if (value.source === 'last-render' && !session.lastRender) {
          throw new Error('No render is available yet. Call render_audio first, or pass source: "scope" to analyze the live output')
        }
        return currentCandidate()
      }
    },
    {
      name: 'analyze_reference_audio',
      description: 'Step 1 of matching a target sound: send the target as Base64 audio, which is decoded in memory and analyzed with the same metrics as synth output. Then render your patch and call compare_audio (step 2).',
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
      description: 'Step 2 of matching a target sound: compare the latest reference from analyze_reference_audio with the latest render (or the live scope when nothing has been rendered — the same candidate analyze_audio would return), and report per-metric and overall similarity.',
      inputSchema: emptySchema,
      annotations: { readOnlyHint: true },
      execute(input, options) {
        const signal = invocationSignal(options)
        if (signal.aborted || lifecycleSignal?.aborted) throw abortError()
        assertObject(input, 'input', [])
        if (!session.lastReference) throw new Error('Call analyze_reference_audio first before compare_audio')
        const candidate = currentCandidate()
        if (signal.aborted || lifecycleSignal?.aborted) throw abortError()
        const comparison = compareAudioMetrics(session.lastReference.metrics, candidate.metrics)
        dependencies.onComparison?.(comparison, candidate.source === 'last-render' ? session.lastRender?.soundEntryId : dependencies.currentSoundEntryId?.())
        return {
          reference: session.lastReference,
          candidate,
          comparison
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
        engine.loadPreset(validated, 'ai')
        return { name, loaded: true }
      }
    },
    {
      name: 'list_presets',
      description: 'List the user presets saved to localStorage, newest storage order first, so you can see what save_preset and the human have stored. Factory presets from the UI dropdown are not included.',
      inputSchema: emptySchema,
      annotations: { readOnlyHint: true },
      execute(input) {
        assertObject(input, 'input', [])
        const presets = listPresets().map(preset => {
          const savedAt = (preset as { savedAt?: unknown }).savedAt
          return { name: preset.name, ...(typeof savedAt === 'number' ? { savedAt } : {}) }
        })
        return { presets, total: presets.length }
      }
    }
  ]
}
