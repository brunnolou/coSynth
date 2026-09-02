import type { RecordedAudio, SynthEngine } from '../audio/engine'
import { agentActivityFor } from './activity'
import {
  PARAMS, PARAM_GROUP_NOTES, defaultNorm, formatValue, normToValue, paramIndex, valueToNorm,
  type ParamDef
} from '../shared/params'
import { FX_IDS, MAX_MOD_SLOTS, MOD_SOURCES, modSourceIndex, type ModSlotState, type ModSourceDef } from '../shared/messages'
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
/** Derived at module load so the vocabulary in errors and descriptions cannot drift from `MOD_SOURCES`. */
const MOD_SOURCE_IDS = MOD_SOURCES.map(source => source.id)

/** Filtering advice belongs on the property an agent is filling in, not in the prose. */
const GROUP_PROPERTY_DESCRIPTION = 'Exact group id from `groups`, case-insensitive; an unknown name is an error.'
const SEARCH_PROPERTY_DESCRIPTION = 'Case-insensitive substring over parameter id, name, and group.'
/**
 * The discovery tool's own filters, where an evaluated agent decided to call
 * five times - one group per call - for what one unfiltered compact call
 * returns. `format: 'compact'` reads as a formatting flag, so the "one call
 * gets everything" property has to be stated here, not only in the prose.
 */
const GROUP_FILTER_DESCRIPTION = `Exact group id from \`groups\`, case-insensitive; an unknown name is an error, not an empty page. Groups are per instance (\`filter1\`, \`filter2\`, \`env1\`..\`env6\`), so \`filter\` is only the routing group. Usually skip it: omit \`group\` and \`search\`, and one call with \`format: "compact"\` returns all ${PARAMS.length} parameters.`
const SEARCH_FILTER_DESCRIPTION = `Case-insensitive substring over parameter id, name, and group; unlike \`group\` it spans instances (\`filter\` matches every filter1/filter2 parameter). Omit it too and one call with \`format: "compact"\` returns all ${PARAMS.length}.`

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

/** How `update`/`remove` may name a route; repeated in every addressing error. */
const ROUTE_ADDRESSING = 'Address an existing route either by `slot`, or by the same `source`+`destination` pair you added it with.'

/** A modulation source id to its index, with suggestions on any action. */
function assertModSource(value: unknown): number {
  if (typeof value !== 'string') throw new Error('source must be a string')
  try { return modSourceIndex(value) } catch {
    throw new Error(`Unknown modulation source '${value}'.${didYouMean(value, MOD_SOURCE_IDS)} Valid: ${MOD_SOURCE_IDS.join(', ')}`)
  }
}

/** A destination parameter id to its index; only moddable ids are routable. */
function assertModDestination(value: unknown): number {
  if (typeof value !== 'string') throw new Error('destination must be a string')
  const def = PARAMS.find(candidate => candidate.id === value)
  if (!def) {
    const moddable = PARAMS.filter(candidate => candidate.moddable).map(candidate => candidate.id)
    throw new Error(`Unknown modulation destination '${value}'.${didYouMean(value, moddable)} Destinations are moddable parameter ids; groups: ${PARAMETER_GROUPS.join(', ')}`)
  }
  if (!def.moddable) throw new Error(`Destination is not moddable: ${def.id}`)
  return paramIndex(def.id)
}

function assertModSlot(value: unknown): number {
  const slot = finite(value, 'slot')
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_MOD_SLOTS) throw new Error(`slot must be an integer in range 0..${MAX_MOD_SLOTS - 1}`)
  return slot
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

/**
 * The interpretation a metric needs at the point its number is read.
 *
 * These sentences used to sit in the `render_audio` and `analyze_audio`
 * descriptions, where they made the tool listing too big for a client to read
 * whole — a discoverability eval truncated the listing and lost `play_notes`
 * altogether. Each fact stays where an agent actually meets the number: in the
 * response that carries it, as `metricNotes`.
 */
const METRIC_NOTES = {
  peakDb: 'An instantaneous peak — use `loudnessDb` or `rmsDb` to compare levels.',
  decayT60Ms: "Measured from the rendered tail, not read back from `env1.decay`: the note's own `duration` and `env1.release` shape that tail, so the same patch reports a different T60 over a longer note. It is `null` — its most common value on short notes — whenever the buffer never falls the 20 dB the slope fit needs, or falls too abruptly for the envelope to resolve."
} as const

/**
 * A peak this low is digital silence: `analyzeAudio` floors an all-zero buffer
 * at -160 dB, and nothing audible sits below -100 dB.
 */
const SILENT_PEAK_DB = -100

/** Refusal text for `compare_audio` with no render and a silent live scope. */
const SILENT_CANDIDATE_REFUSAL =
  'Nothing has been rendered yet and the live scope is silent (peak below -100 dB), so there is nothing to compare the reference against; scoring it against silence would return a similarity that means nothing. Call render_audio first — it renders offline and needs no user gesture — then call compare_audio again. The scope fallback is only for comparing against a human who is actually playing.'

/** How the Base64 preview became mono; travels with the payload it describes. */
const DOWNMIX_NOTE = '"sum" is the plain channel average; "left"/"right" means that average cancelled and the louder channel was sent alone.'

/** One modulation source as a single line: `keytrack voice -1..1`. */
function compactSource(def: ModSourceDef): string {
  return `${def.id} ${def.perVoice ? 'voice' : 'global'} ${def.bipolar ? '-1..1' : '0..1'}`
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

/** Groups whose id extends this one: `filter` -> `filter1`, `filter2`. */
function relatedGroups(group: string): string[] {
  return PARAMETER_GROUPS.filter(candidate => candidate !== group && candidate.toLowerCase().startsWith(group.toLowerCase()))
}

/**
 * The canonical group id for a case-insensitively matched name. A name that
 * matches nothing used to return an empty page that looked like an answer;
 * `{ group: 'Filter' }` still resolves - to the one-parameter routing group,
 * which `groupFilter` in the response then says out loud.
 */
function assertGroup(value: string): string {
  const match = PARAMETER_GROUPS.find(candidate => candidate.toLowerCase() === value.toLowerCase())
  if (!match) {
    throw new Error(
      `Unknown group '${value}'.${didYouMean(value, PARAMETER_GROUPS)} Groups: ${PARAMETER_GROUPS.join(', ')}. ` +
      `One call with {"format":"compact"} and no group returns all ${PARAMS.length} parameters.`
    )
  }
  return match
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
      metrics: analyzeAudio([engine.scopeL, engine.scopeR], sampleRate),
      metricNotes: METRIC_NOTES
    }
  }

  function currentCandidate() {
    if (session.lastRender) return {
      source: 'last-render' as const,
      sampleRate: session.lastRender.sampleRate,
      channels: session.lastRender.channels,
      url: session.lastRender.url,
      metrics: session.lastRender.metrics,
      metricNotes: METRIC_NOTES
    }
    return scopeCandidate()
  }

  return [
    {
      name: 'get_synth_state',
      description: 'Get live synth state: runtime, FX order, and the modulation routes. One call with `format: "compact"` also returns every parameter that differs from its default as `id=formatted` lines — the cheapest way to verify a patch. Routes ship by default in `patch.modulations` (with `total`, and `nextOffset` when more exist — raise `modulationLimit`). `lfo: 1` returns one shape as `patch.lfoShape`.',
      inputSchema: {
        type: 'object', properties: {
          format: { type: 'string', enum: ['full', 'compact'] },
          group: {
            type: 'string', maxLength: MAX_QUERY_LENGTH,
            description: GROUP_PROPERTY_DESCRIPTION
          },
          search: {
            type: 'string', maxLength: MAX_QUERY_LENGTH,
            description: SEARCH_PROPERTY_DESCRIPTION
          },
          parameterOffset: {
            type: 'integer', minimum: 0,
            description: 'Full-format paging cursor; omit it with `format: "compact"`.'
          },
          parameterLimit: {
            type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE,
            description: `Full-format page size (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}); omit it with \`format: "compact"\`, which needs none and returns every non-default parameter in one response.`
          },
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
        const requestedGroup = value.group as string | undefined
        const search = value.search as string | undefined
        if (requestedGroup && requestedGroup.length > MAX_QUERY_LENGTH) throw new Error(`group is limited to ${MAX_QUERY_LENGTH} characters`)
        const group = requestedGroup ? assertGroup(requestedGroup) : requestedGroup
        if (search && search.length > MAX_QUERY_LENGTH) throw new Error(`search is limited to ${MAX_QUERY_LENGTH} characters`)
        const offset = boundedInteger(value.parameterOffset, 'parameterOffset', 0, 0, PARAMS.length)
        const limit = boundedInteger(value.parameterLimit, 'parameterLimit', format === 'compact' ? COMPACT_PAGE_SIZE : DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE)
        const matches = filteredParameters(group, search)
        const includeParameters = format === 'compact' || group !== undefined || search !== undefined || value.parameterOffset !== undefined || value.parameterLimit !== undefined
        const includeModulations = value.modulationOffset !== undefined || value.modulationLimit !== undefined
        const includeLfo = value.lfo !== undefined || value.lfoPointOffset !== undefined || value.lfoPointLimit !== undefined
        // Modulation paging is deliberately not part of this exclusivity: the
        // routes always ship, so a wider page of them is a bigger slice of a
        // field that is already there, not a competing view. It used to count,
        // which made `{format:'compact', modulationLimit:32}` throw - exactly
        // the recovery this tool's own description tells an agent to reach for.
        if (Number(includeParameters) + Number(includeLfo) > 1) {
          throw new Error('Request a detailed parameter page or one LFO shape in separate calls')
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
            // Returned by default: an agent verifying a patch it just wrote
            // needs the routes, and the default page keeps a saturated matrix
            // inside the discovery output budget.
            modulations: {
              items: modulationPage, offset: modulationOffset, limit: modulationLimit, total: modulations.length,
              ...(modulationOffset + modulationPage.length < modulations.length ? { nextOffset: modulationOffset + modulationPage.length } : {})
            },
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
      description: `Discover parameter units, ranges, defaults, curves, choices, and modulation capabilities. One unfiltered call with \`format: "compact"\` returns all ${PARAMS.length} parameters, one line each (\`filter1.cutoff Hz 20..20000 exp =8000 mod\`). env1 is the amplitude envelope (VCA) and the only hardwired modulator: env2-env6 and lfo1-lfo8 do nothing until routed with \`set_modulation\`; \`groupNotes\` repeats such facts for the groups on the page. Add \`sourceLimit\` for the modulation source ids \`set_modulation\` accepts.`,
      inputSchema: {
        type: 'object', properties: {
          format: { type: 'string', enum: ['full', 'compact'] },
          group: {
            type: 'string', maxLength: MAX_QUERY_LENGTH,
            description: GROUP_FILTER_DESCRIPTION
          },
          search: {
            type: 'string', maxLength: MAX_QUERY_LENGTH,
            description: SEARCH_FILTER_DESCRIPTION
          },
          offset: {
            type: 'integer', minimum: 0,
            description: 'Full-format paging cursor; omit it with `format: "compact"`.'
          },
          limit: {
            type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE,
            description: `Full-format page size (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}); omit it with \`format: "compact"\`, which needs none and returns all ${PARAMS.length} parameters in one response.`
          },
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
        const requestedGroup = value.group as string | undefined
        const group = requestedGroup ? assertGroup(requestedGroup) : undefined
        const matches = filteredParameters(group, value.search as string | undefined)
        const related = group === undefined ? [] : relatedGroups(group)
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
        // Either paging key asks for the source vocabulary; a limit on its own
        // implies offset 0, so `{ sourceLimit: 60 }` hands over the whole list.
        const includeSources = value.sourceOffset !== undefined || value.sourceLimit !== undefined
        const sourceOffset = boundedInteger(value.sourceOffset, 'sourceOffset', 0, 0, MOD_SOURCES.length)
        const sourceLimit = boundedInteger(value.sourceLimit, 'sourceLimit', DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE)
        const sources = includeSources ? MOD_SOURCES.slice(sourceOffset, sourceOffset + sourceLimit) : []
        const nextSourceOffset = sourceOffset + sources.length < MOD_SOURCES.length
          ? { nextOffset: sourceOffset + sources.length }
          : {}
        // Only the notes for groups actually on this page, so the default
        // response stays inside the discovery output budget.
        const groupNotes = Object.fromEntries(
          [...new Set(page.map(def => def.group))]
            .flatMap(group => PARAM_GROUP_NOTES[group] ? [[group, PARAM_GROUP_NOTES[group]]] : [])
        )
        return {
          groups: [...PARAMETER_GROUPS],
          // Says out loud what a group filter actually narrowed to, and that
          // the unfiltered compact call would have been one round trip. An
          // evaluated agent spent five calls, one group at a time, on what
          // `{ format: 'compact' }` alone returns.
          ...(group === undefined ? {} : {
            groupFilter: {
              group,
              total: matches.length,
              ...(related.length === 0 ? {} : { relatedGroups: related }),
              note: `group "${group}" is ${matches.length} of ${PARAMS.length} parameters` +
                (related.length === 0 ? '' : `, and ${related.join(', ')} ${related.length === 1 ? 'is a separate group' : 'are separate groups'}`) +
                `. One call with {"format":"compact"} and no group returns all ${PARAMS.length}.`
            }
          }),
          ...(Object.keys(groupNotes).length === 0 ? {} : { groupNotes }),
          parameters: format === 'compact'
            ? {
              items: page.map(compactParameter), total: matches.length, format: 'compact' as const,
              ...(offset + page.length < matches.length ? { nextOffset: offset + page.length } : {})
            }
            : { items: parameters, offset, limit, total: matches.length, ...(offset + page.length < matches.length ? { nextOffset: offset + page.length } : {}) },
          ...(!includeSources ? {} : {
            modulationSources: format === 'compact'
              ? { items: sources.map(compactSource), total: MOD_SOURCES.length, format: 'compact' as const, ...nextSourceOffset }
              : { items: sources.map(source => ({ ...source })), offset: sourceOffset, limit: sourceLimit, total: MOD_SOURCES.length, ...nextSourceOffset }
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
      description: `Add, update, remove, or clear modulation routes in the shared ${MAX_MOD_SLOTS}-slot matrix. \`add\` takes \`source\`+\`destination\` and replaces any route on that pair; \`update\`/\`remove\` address a route by \`slot\` or by that same pair — never both, and a pair with no route is an error, not a new route. \`depth\` is bipolar (-1..1): added to the destination's normalized 0..1 value, then clamped, so depth 0.5 on a parameter at 0.5 sweeps it to 1.0. Example: {"action":"add","source":"lfo1","destination":"filter1.cutoff","depth":0.4}`,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'update', 'remove', 'clear'] },
          source: {
            type: 'string',
            description: `Source id: ${MOD_SOURCE_IDS.join(', ')}. Required by \`add\`; on \`update\`/\`remove\` it pairs with \`destination\` instead of \`slot\`.`
          },
          destination: {
            type: 'string',
            description: 'Moddable parameter id (`mod` in the compact schema). Required by `add`; pairs with `source` on `update`/`remove`.'
          },
          depth: { type: 'number', minimum: -1, maximum: 1 },
          enabled: { type: 'boolean' },
          slot: {
            type: 'integer', minimum: 0, maximum: MAX_MOD_SLOTS - 1,
            description: 'Matrix slot from `route.slot`; the alternative to a `source`+`destination` pair on `update`/`remove` — passing both is ambiguous.'
          }
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
        /**
         * The slot an `update`/`remove` means. A `source`+`destination` pair
         * resolves the way `add` resolves it, so both actions mean exactly the
         * route `add` would have replaced; naming both forms is ambiguous
         * rather than merely redundant, and a pair that names nothing is an
         * error instead of a new route.
         */
        const addressedSlot = (): number => {
          const byPair = value.source !== undefined || value.destination !== undefined
          if (!byPair) {
            if (value.slot === undefined) throw new Error(`Modulation route address missing. ${ROUTE_ADDRESSING}`)
            return assertModSlot(value.slot)
          }
          if (value.slot !== undefined) throw new Error(`Ambiguous route address: pass either 'slot' or 'source'+'destination', not both. ${ROUTE_ADDRESSING}`)
          if (value.source === undefined || value.destination === undefined) {
            throw new Error(`Addressing a route by name needs both source and destination. ${ROUTE_ADDRESSING}`)
          }
          const source = assertModSource(value.source)
          const dest = assertModDestination(value.destination)
          const slot = engine.modSlots.findIndex(route => route?.source === source && route.dest === dest)
          if (slot < 0) throw new Error(`No modulation route from '${value.source}' to '${value.destination}'. Create it with action 'add'. ${ROUTE_ADDRESSING}`)
          return slot
        }
        if (action === 'remove') {
          assertObject(input, 'input', ['action', 'slot', 'source', 'destination'], ['action'])
          const slot = addressedSlot()
          if (!engine.modSlots[slot]) throw new Error(`Modulation slot ${slot} is empty`)
          engine.setModSlot(slot, null, 'ai')
          return { removed: slot, count: count() }
        }
        if (action === 'update') {
          assertObject(input, 'input', ['action', 'slot', 'source', 'destination', 'depth', 'enabled'], ['action'])
          const slot = addressedSlot()
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
        const source = assertModSource(value.source)
        const dest = assertModDestination(value.destination)
        const depth = finite(value.depth, 'depth')
        if (depth < -1 || depth > 1) throw new Error('depth must be in range -1..1')
        if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('enabled must be boolean')
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
      description: 'Play a bounded sequence of MIDI notes with relative start and duration values, in seconds. A repeated pitch retriggers its voice. Requires runtime.running=true; otherwise click CLICK TO START AUDIO first. Example: {"notes":[{"midi":60,"velocity":0.8,"start":0,"duration":0.5}]}',
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
      description: 'Render a bounded note sequence and return `metrics` for it (plus `metricNotes`, which says how to read them). Offline by default: repeatable scheduling, far faster than real time, and available before the human has started audio — only `play_notes` needs that gesture. A single-pitch sequence also gets `metrics.harmonics`.',
      inputSchema: {
        type: 'object',
        properties: {
          notes: { type: 'array', minItems: 1, maxItems: MAX_NOTES, items: noteSchema },
          duration: { type: 'number', exclusiveMinimum: 0, maximum: MAX_RENDER_SECONDS },
          mode: {
            type: 'string', enum: [...RENDER_MODES],
            description: 'Default "offline". "realtime" captures the live AudioWorklet output and needs running audio; with no OfflineAudioContext an offline request falls back to real time via `renderModeFallback`.'
          },
          format: {
            type: 'string', enum: [...RENDER_FORMATS],
            description: `Payload beside the metrics: "metrics" (default), "url" (a page-local blob URL), or "base64" (mono 16-bit WAV an audio-capable agent can listen to, first ${BASE64_MAX_SECONDS} s; the returned \`audio\` object describes itself).`
          }
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
              metricNotes: METRIC_NOTES,
              ...(format === 'url' ? { url } : {}),
              ...(format === 'base64' ? {
                audio: { ...monoWavBase64(recording.channelData, recording.sampleRate), downmixNote: DOWNMIX_NOTE }
              } : {}),
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
      description: 'Re-analyze the last `render_audio` result, or analyze the live output right now (`source: "scope"`) — useful while a human is playing. `render_audio` already returns the same metrics and the same `metricNotes`, so call this only when you need a fresh look without re-rendering.',
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
      description: 'Step 1 of matching a target sound: send the target as Base64 audio; it is decoded in memory and analyzed with the same metrics as synth output. Then render your patch and call compare_audio (step 2).',
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
      description: 'Step 2 of matching a target sound: report per-metric and overall similarity between the latest `analyze_reference_audio` reference and the latest render. With nothing rendered it falls back to the live scope — the same candidate `analyze_audio` returns — and refuses outright when that scope is silent rather than scoring against silence.',
      inputSchema: emptySchema,
      annotations: { readOnlyHint: true },
      execute(input, options) {
        const signal = invocationSignal(options)
        if (signal.aborted || lifecycleSignal?.aborted) throw abortError()
        assertObject(input, 'input', [])
        if (!session.lastReference) throw new Error('Call analyze_reference_audio first before compare_audio')
        const candidate = currentCandidate()
        // The scope fallback exists for a human who IS playing. Before the
        // audio gesture the scope is guaranteed digital silence, and scoring a
        // reference against it returned `ok` with a plausible similarity
        // (0.209 in the match eval) that an agent following "Step 1 ... Step 2"
        // reads as a baseline. A wrong number an agent trusts is worse than an
        // error, so refuse and say what to call first.
        if (candidate.source === 'scope' && candidate.metrics.peakDb <= SILENT_PEAK_DB) {
          throw new Error(SILENT_CANDIDATE_REFUSAL)
        }
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
      description: 'Load a named user preset saved to localStorage and return its verifiable resulting state. Factory presets from the UI dropdown are not included.',
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
      description: 'List the user presets saved to localStorage, newest storage order first. Factory presets from the UI dropdown are not included.',
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
