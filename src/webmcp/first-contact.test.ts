/**
 * First-contact smoke test — Verification item 2 of
 * docs/plans/2026-09-02-agent-experience.md.
 *
 * A scripted "agent" that can see ONLY each tool's `name`, `description` and
 * `inputSchema` must complete this journey with ZERO retries:
 *
 *   1. discover the full parameter space in <= 2 calls
 *   2. apply a 10-parameter patch in one `update_parameters` call
 *   3. add 2 modulation routes
 *   4. render one note OFFLINE, without a user Start gesture
 *   5. read `metrics.decayT60Ms` and `metrics.harmonics.inharmonicity`
 *
 * Everything the agent sends is DERIVED at runtime from the descriptors and
 * from the discovery responses. Unlike every other test in this repo, it must
 * not know the source. The two deliberate exceptions are marked HARDCODED.
 *
 * This test is expected to be RED until Tasks 1-10 of the plan land.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultValues } from '../shared/params'
import { DEFAULT_FX_ORDER, FX_IDS, MAX_MOD_SLOTS, defaultLfoShape, type ModSlotState } from '../shared/messages'
import type { PresetData, RecordedAudio, SynthEngine } from '../audio/engine'
import { createWebMcpTools, type WebMcpToolDependencies } from './tools'

// ---------------------------------------------------------------- test rig

class MemoryStorage implements Storage {
  private data = new Map<string, string>()
  get length() { return this.data.size }
  clear() { this.data.clear() }
  getItem(key: string) { return this.data.get(key) ?? null }
  key(index: number) { return [...this.data.keys()][index] ?? null }
  removeItem(key: string) { this.data.delete(key) }
  setItem(key: string, value: string) { this.data.set(key, value) }
}

const OFFLINE_SAMPLE_RATE = 48000
const SYNTHETIC_T60_MS = 1200
const SYNTHETIC_INHARMONICITY = 0.0004
const SYNTHETIC_ATTACK_MS = 2

/**
 * A decaying, slightly stretched harmonic tone — the kind of signal an offline
 * render of a single piano-ish note produces. `decayT60Ms` and
 * `harmonics.inharmonicity` are measured against these known values.
 */
function syntheticNote(f0Hz: number, seconds: number, sampleRate = OFFLINE_SAMPLE_RATE): Float32Array {
  const length = Math.max(64, Math.round(seconds * sampleRate))
  const out = new Float32Array(length)
  const nyquist = sampleRate / 2
  const partials: { freq: number; amp: number }[] = []
  for (let n = 1; n <= 12; n++) {
    const freq = n * f0Hz * Math.sqrt(1 + SYNTHETIC_INHARMONICITY * n * n)
    if (freq >= nyquist * 0.95) break
    partials.push({ freq, amp: 1 / n })
  }
  const attackSamples = Math.max(1, Math.round((SYNTHETIC_ATTACK_MS / 1000) * sampleRate))
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate
    const attack = i < attackSamples ? i / attackSamples : 1
    const decay = Math.pow(10, (-3 * t) / (SYNTHETIC_T60_MS / 1000))
    let sample = 0
    for (const partial of partials) sample += partial.amp * Math.sin(2 * Math.PI * partial.freq * t)
    out[i] = 0.5 * attack * decay * (sample / 2)
  }
  return out
}

function syntheticRender(duration: number, f0Hz: number): RecordedAudio {
  const channel = syntheticNote(f0Hz, duration)
  return {
    blob: new Blob(['wav'], { type: 'audio/wav' }),
    mimeType: 'audio/wav',
    duration,
    sampleRate: OFFLINE_SAMPLE_RATE,
    channelData: [channel, channel.slice()]
  }
}

class FakeEngine {
  onPatchChange = vi.fn(() => () => {})
  values = defaultValues()
  modSlots: (ModSlotState | null)[] = new Array(MAX_MOD_SLOTS).fill(null)
  lfoShapes = Array.from({ length: 8 }, () => defaultLfoShape())
  fxOrder = DEFAULT_FX_ORDER.slice()
  /** No user gesture yet: the whole point of the offline path (plan Task 10.3). */
  running = false
  ctx = { sampleRate: OFFLINE_SAMPLE_RATE }
  scopeL = new Float32Array([0, 0.2, -0.2, 0])
  scopeR = new Float32Array([0, 0.1, -0.1, 0])
  voiceCount = 0
  peakL = 0
  peakR = 0
  heldNotes = new Set<number>()
  offlineRenders = 0
  setParam = vi.fn((index: number, value: number) => { this.values[index] = value })
  setModSlot = vi.fn((slot: number, state: ModSlotState | null) => { this.modSlots[slot] = state })
  noteOn = vi.fn((note: number) => { this.heldNotes.add(note) })
  noteOff = vi.fn((note: number) => { this.heldNotes.delete(note) })
  allNotesOff = vi.fn(() => { this.heldNotes.clear() })
  toPreset = vi.fn((name: string): PresetData => ({
    name, version: 1,
    params: Object.fromEntries(Array.from(this.values, (value, index) => [`p${index}`, value])),
    mods: [], lfoShapes: this.lfoShapes.map(shape => shape.map(point => ({ ...point }))), fxOrder: [...FX_IDS]
  }))
  loadPreset = vi.fn(() => {})
  /** A live render must never happen on this engine: audio was never started. */
  recordOutput = vi.fn(async (): Promise<RecordedAudio> => {
    throw new Error('recordOutput must not run: this journey renders offline without a Start gesture')
  })
  /**
   * Seam A for the offline path (plan Task 9/10): an engine-level offline
   * renderer. Whichever seam Task 10 wires up, it lands on the same synthetic
   * note, so the metric assertions below stay meaningful.
   */
  renderOffline = vi.fn(async (notes: { midi: number }[], duration: number): Promise<RecordedAudio> => {
    this.offlineRenders++
    return syntheticRender(duration, 440 * Math.pow(2, ((notes[0]?.midi ?? 69) - 69) / 12))
  })
}

// ---------------------------------------------------------------- the agent

interface Descriptor {
  name: string
  description: string
  inputSchema: any
}

/** What the model actually sees. Nothing else may leak into the agent's plan. */
function descriptorsOnly(tools: readonly any[]): Descriptor[] {
  return tools.map(tool => ({
    name: String(tool.name),
    description: String(tool.description),
    inputSchema: JSON.parse(JSON.stringify(tool.inputSchema))
  }))
}

function schemaOf(descriptors: Descriptor[], name: string): any {
  const descriptor = descriptors.find(entry => entry.name === name)
  expect(descriptor, `tool ${name} must exist`).toBeDefined()
  return descriptor!.inputSchema
}

/** Largest value the schema itself says is acceptable for an integer property. */
function schemaMaximum(schema: any, property: string): number {
  const max = schema?.properties?.[property]?.maximum
  expect(typeof max, `${property}.maximum must be declared in the input schema`).toBe('number')
  return max as number
}

function enumOf(schema: any, property: string): string[] {
  const values = schema?.properties?.[property]?.enum
  expect(Array.isArray(values), `${property} must declare an enum in the input schema`).toBe(true)
  return values as string[]
}

/** Snap a value onto the grid the schema advertises, so no retry is needed. */
function derivedValue(item: any): number {
  const midpoint = (item.min + item.max) / 2
  if (typeof item.step !== 'number' || item.step <= 0) return midpoint
  const snapped = Math.round(midpoint / item.step) * item.step
  return Math.min(item.max, Math.max(item.min, snapped))
}

/** Parse one line of the compact discovery format, e.g.
 *  `filter1.cutoff Hz 20..20000 exp =8000 mod` / `filter1.type {LP 12|LP 24} =1` */
function parseCompactItem(line: string): { id: string; moddable: boolean } {
  expect(typeof line, 'compact parameter items must be strings').toBe('string')
  const id = line.trim().split(/\s+/)[0] ?? ''
  expect(id, `compact item must start with a parameter id: ${line}`).toMatch(/^[A-Za-z][\w]*(\.[\w]+)+$/)
  return { id, moddable: /(^|\s)mod(\s|$)/.test(line) }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => `blob:first-contact-${Math.random()}`),
    revokeObjectURL: vi.fn()
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function setup() {
  const engine = new FakeEngine()
  /**
   * Seam B for the offline path: an injected renderer, mirroring how
   * `decodeAudio` / `analyzeAudioAsync` are already injected. The cast is only
   * because `renderOffline` does not exist on the dependency type yet.
   */
  const dependencies = {
    renderOffline: vi.fn(async (_engine: unknown, notes: { midi: number }[], duration: number) => {
      engine.offlineRenders++
      return syntheticRender(duration, 440 * Math.pow(2, ((notes[0]?.midi ?? 69) - 69) / 12))
    })
  } as unknown as WebMcpToolDependencies

  const tools = createWebMcpTools(engine as unknown as SynthEngine, undefined, dependencies)
  const descriptors = descriptorsOnly(tools)
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  const calls: string[] = []

  /**
   * Zero-retry harness: any throw, any `{ ok: false }`, is a hard failure.
   * There is no second attempt anywhere in this file.
   */
  const call = async (name: string, input: Record<string, unknown> = {}): Promise<any> => {
    calls.push(name)
    const tool = byName.get(name)
    expect(tool, `tool ${name} must exist`).toBeDefined()
    let result: any
    try {
      result = await tool!.execute(input, { signal: new AbortController().signal })
    } catch (error) {
      throw new Error(
        `${name} rejected a first-attempt call built from its own schema: ` +
        `${(error as Error)?.message ?? error}\ninput=${JSON.stringify(input)}`
      )
    }
    if (result && typeof result === 'object' && (result as { ok?: unknown }).ok === false) {
      throw new Error(`${name} returned ok:false on a first attempt: ${JSON.stringify(result)}`)
    }
    return result
  }

  const countOf = (name: string) => calls.filter(entry => entry === name).length
  return { engine, descriptors, call, calls, countOf }
}

// ---------------------------------------------------------------- the journey

describe('first contact: an agent that has only read the tool descriptors', () => {
  it('discovers, patches, modulates, renders offline, and measures — with no retries', async () => {
    const { engine, descriptors, call, calls, countOf } = setup()

    // --- Step 1: the whole parameter space in <= 2 calls -------------------
    const schemaTool = schemaOf(descriptors, 'get_parameter_schema')
    const formats = enumOf(schemaTool, 'format')
    expect(formats, 'get_parameter_schema must advertise a compact format').toContain('compact')

    const compact = await call('get_parameter_schema', { format: 'compact' })
    const compactItems: unknown[] = compact?.parameters?.items ?? []
    expect(Array.isArray(compactItems)).toBe(true)
    // The full space arrives at once: every item present, nothing left to page.
    expect(compact.parameters.total).toBe(compactItems.length)
    expect(compact.parameters.nextOffset).toBeUndefined()
    // Plausibility only — the exact count (224 today) is not the agent's business.
    expect(compactItems.length).toBeGreaterThan(150)

    const compactParsed = (compactItems as string[]).map(parseCompactItem)
    const compactIds = new Set(compactParsed.map(item => item.id))
    expect(compactIds.size, 'compact ids must be unique').toBe(compactParsed.length)
    expect(compactParsed.some(item => item.moddable), 'compact lines must flag moddable params').toBe(true)

    // Second and final discovery call: full detail for a page of parameters
    // (which carries `step`, needed to build values that validate first time)
    // plus the modulation source list, both sized from the schema's own maxima.
    const detailLimit = schemaMaximum(schemaTool, 'limit')
    const sourceLimit = schemaMaximum(schemaTool, 'sourceLimit')
    expect(detailLimit, 'a page must be big enough to plan a 10-parameter patch').toBeGreaterThanOrEqual(10)
    const detail = await call('get_parameter_schema', {
      limit: detailLimit,
      sourceOffset: 0,
      sourceLimit
    })
    expect(countOf('get_parameter_schema'), 'discovery budget is 2 calls').toBeLessThanOrEqual(2)
    expect(calls.length, 'no other call may precede the patch').toBe(2)

    const detailItems: any[] = detail?.parameters?.items ?? []
    expect(detailItems.length).toBeGreaterThanOrEqual(10)
    // The two discovery views must describe the same instrument.
    expect(detail.parameters.total).toBe(compact.parameters.total)
    for (const item of detailItems) expect(compactIds.has(item.id)).toBe(true)

    const sources: any[] = detail?.modulationSources?.items ?? []
    expect(sources.length, 'the source list must arrive whole in one page').toBe(detail.modulationSources.total)
    expect(sources.length).toBeGreaterThanOrEqual(2)

    // --- Step 2: a 10-parameter patch in one call --------------------------
    const patchable = detailItems.filter(item =>
      !item.choices && typeof item.min === 'number' && typeof item.max === 'number' && item.max > item.min)
    expect(patchable.length).toBeGreaterThanOrEqual(10)
    const patch = patchable.slice(0, 10).map(item => ({ id: item.id, value: derivedValue(item) }))

    const applied = await call('update_parameters', { updates: patch })
    expect(applied.applied).toHaveLength(10)
    expect(applied.applied.map((entry: any) => entry.id)).toEqual(patch.map(entry => entry.id))
    for (const [index, entry] of applied.applied.entries()) {
      expect(entry.raw).toBeCloseTo(patch[index].value, 6)
    }

    // --- Step 3: two modulation routes -------------------------------------
    const modSchema = schemaOf(descriptors, 'set_modulation')
    const actions = enumOf(modSchema, 'action')
    expect(actions).toContain('add')
    const depthMax = modSchema.properties.depth.maximum as number
    const depthMin = modSchema.properties.depth.minimum as number
    const destinations = detailItems.filter(item => item.moddable === true).map(item => item.id)
    expect(destinations.length, 'discovery must expose moddable destinations').toBeGreaterThanOrEqual(2)

    const routes = [
      { source: sources[0].id, destination: destinations[0], depth: depthMax / 2 },
      { source: sources[1].id, destination: destinations[1], depth: depthMin / 2 }
    ]
    for (const route of routes) {
      const result = await call('set_modulation', { action: 'add', ...route })
      expect(result.route).toMatchObject({
        source: route.source, destination: route.destination, depth: route.depth, enabled: true
      })
    }
    expect(engine.modSlots.filter(Boolean)).toHaveLength(2)

    // --- Step 4: one note, rendered offline, with audio never started ------
    const renderSchema = schemaOf(descriptors, 'render_audio')
    expect(enumOf(renderSchema, 'mode'), 'render_audio must advertise an offline mode').toContain('offline')
    const noteSchema = renderSchema.properties.notes.items
    const midiMin = noteSchema.properties.midi.minimum as number
    const midiMax = noteSchema.properties.midi.maximum as number
    const velocityMax = noteSchema.properties.velocity.maximum as number
    const maxRenderSeconds = renderSchema.properties.duration.maximum as number
    // HARDCODED: 2.0 s of note and 2.5 s of render. Nothing in the schema says
    // how long a decay measurement needs; the schema only caps the maximum.
    const noteDuration = Math.min(2, maxRenderSeconds)
    const renderDuration = Math.min(2.5, maxRenderSeconds)
    const midi = Math.round((midiMin + midiMax) / 2)

    expect(engine.running, 'the journey must not require a Start gesture').toBe(false)
    const render = await call('render_audio', {
      notes: [{ midi, velocity: velocityMax * 0.8, start: 0, duration: noteDuration }],
      duration: renderDuration,
      mode: 'offline'
    })
    expect(render.renderMode).toBe('offline')
    expect(engine.recordOutput).not.toHaveBeenCalled()
    expect(engine.offlineRenders).toBeGreaterThan(0)

    // --- Step 5: the metrics an agent designs against ----------------------
    const metrics = render.metrics as any
    expect(metrics).toBeTruthy()

    expect(typeof metrics.decayT60Ms, 'metrics.decayT60Ms must be reported').toBe('number')
    expect(Number.isFinite(metrics.decayT60Ms)).toBe(true)
    // Plausible: the rendered note decays 60 dB in roughly the synthesized time.
    expect(metrics.decayT60Ms).toBeGreaterThan(SYNTHETIC_T60_MS * 0.5)
    expect(metrics.decayT60Ms).toBeLessThan(SYNTHETIC_T60_MS * 2)

    expect(metrics.harmonics, 'metrics.harmonics must be reported for a single-pitch render').toBeTruthy()
    const inharmonicity = metrics.harmonics.inharmonicity
    expect(typeof inharmonicity, 'metrics.harmonics.inharmonicity must be a number').toBe('number')
    expect(Number.isFinite(inharmonicity)).toBe(true)
    // Plausible: stretched partials, same order of magnitude as synthesized.
    expect(inharmonicity).toBeGreaterThan(SYNTHETIC_INHARMONICITY * 0.4)
    expect(inharmonicity).toBeLessThan(SYNTHETIC_INHARMONICITY * 2.5)

    // Zero retries: exactly one call per step, five calls in total.
    expect(calls).toEqual([
      'get_parameter_schema', 'get_parameter_schema',
      'update_parameters', 'set_modulation', 'set_modulation', 'render_audio'
    ])
  })
})

// ------------------------------------------------- descriptor-level affordances
// These are the individual affordances the journey above depends on. They fail
// separately so a red run points at one plan task each.

describe('first contact: descriptor affordances', () => {
  it('get_parameter_schema advertises a compact, unpaged full-space format (Task 2)', () => {
    const { descriptors } = setup()
    const schema = schemaOf(descriptors, 'get_parameter_schema')
    expect(schema.properties.format?.enum).toContain('compact')
  })

  it('get_parameter_schema pages are large enough to plan a patch (Task 2)', () => {
    const { descriptors } = setup()
    const schema = schemaOf(descriptors, 'get_parameter_schema')
    expect(schemaMaximum(schema, 'limit')).toBeGreaterThanOrEqual(10)
    // 24 modulation sources must fit in a single page for the second call.
    expect(schemaMaximum(schema, 'sourceLimit')).toBeGreaterThanOrEqual(24)
  })

  it('render_audio advertises an offline mode (Task 10)', () => {
    const { descriptors } = setup()
    const schema = schemaOf(descriptors, 'render_audio')
    expect(schema.properties.mode?.enum).toContain('offline')
    expect(schema.properties.mode?.enum).toContain('realtime')
  })

  it('render_audio no longer tells the agent a Start gesture is required (Task 10)', () => {
    const { descriptors } = setup()
    const description = descriptors.find(entry => entry.name === 'render_audio')!.description
    expect(description).toMatch(/offline/i)
    expect(description).not.toMatch(/CLICK TO START AUDIO/i)
  })
})
