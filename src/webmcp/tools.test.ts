import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PARAMS, defaultValues, normToValue, paramDef, paramIndex } from '../shared/params'
import { DEFAULT_FX_ORDER, FX_IDS, MAX_MOD_SLOTS, MOD_SOURCES, defaultLfoShape, modSourceIndex, type ModSlotState } from '../shared/messages'
import { FACTORY_PRESETS, getFactoryPreset } from '../shared/factory-presets'
import { clearCurrentPreset, currentPresetState, listPresets, validatePresetData } from '../shared/preset-store'
import type { PresetData, RecordedAudio, SynthEngine } from '../audio/engine'
import { createWebMcpTools, type WebMcpToolDependencies } from './tools'
import { encodeWav } from './offline-render'
import type { DecodeBase64AudioOptions, DecodedBase64Audio } from './audio-input'

class MemoryStorage implements Storage {
  private data = new Map<string, string>()
  get length() { return this.data.size }
  clear() { this.data.clear() }
  getItem(key: string) { return this.data.get(key) ?? null }
  key(index: number) { return [...this.data.keys()][index] ?? null }
  removeItem(key: string) { this.data.delete(key) }
  setItem(key: string, value: string) { this.data.set(key, value) }
}

class FakeEngine {
  onPatchChange = vi.fn(() => () => {})
  values = defaultValues()
  modSlots: (ModSlotState | null)[] = new Array(MAX_MOD_SLOTS).fill(null)
  lfoShapes = Array.from({ length: 8 }, () => defaultLfoShape())
  fxOrder = DEFAULT_FX_ORDER.slice()
  running = true
  ctx = { sampleRate: 8000 }
  scopeL = new Float32Array([0, 0.2, -0.2, 0])
  scopeR = new Float32Array([0, 0.1, -0.1, 0])
  /**
   * Stands in for the engine's rolling capture. Tests assign the whole buffer;
   * `recentAudio` then slices the newest `seconds` out of it exactly as the real
   * ring does, so a request longer than what is held returns what is held.
   */
  recentBuffer: [Float32Array, Float32Array] | null = null
  recentAudio = vi.fn((seconds = 4) => {
    if (!this.recentBuffer) return null
    const sampleRate = this.ctx.sampleRate
    const held = this.recentBuffer[0].length
    const frames = Math.min(held, Math.max(1, Math.round(seconds * sampleRate)))
    return {
      channelData: this.recentBuffer.map(channel => channel.slice(held - frames)) as [Float32Array, Float32Array],
      sampleRate,
      duration: frames / sampleRate,
      heldSeconds: held / sampleRate,
      full: held >= 4 * sampleRate
    }
  })
  voiceCount = 2
  peakL = 0.2
  peakR = 0.1
  heldNotes = new Set<number>()
  private readonly defaultNoteOwner = Symbol('human')
  private readonly noteOwners = new Map<number, Set<symbol>>()
  // `origin` is declared on every mutator so a test can assert the 'ai' tag the
  // AI-changes panel depends on, not only the value that was written.
  setParam = vi.fn((index: number, value: number, _origin?: unknown) => { this.values[index] = value })
  setModSlot = vi.fn((slot: number, state: ModSlotState | null, _origin?: unknown) => { this.modSlots[slot] = state })
  setFxOrder = vi.fn((order: number[], _origin?: unknown) => { this.fxOrder = order.slice() })
  batchSoundChange = vi.fn(<T>(_label: string, fn: () => T): T => fn())
  noteOn = vi.fn((note: number, _velocity = 1, owner = this.defaultNoteOwner) => {
    let owners = this.noteOwners.get(note)
    if (!owners) {
      owners = new Set()
      this.noteOwners.set(note, owners)
    }
    owners.add(owner)
    this.heldNotes.add(note)
  })
  noteOff = vi.fn((note: number, owner = this.defaultNoteOwner) => {
    const owners = this.noteOwners.get(note)
    if (!owners?.delete(owner) || owners.size > 0) return
    this.noteOwners.delete(note)
    this.heldNotes.delete(note)
  })
  allNotesOff = vi.fn(() => { this.noteOwners.clear(); this.heldNotes.clear() })
  toPreset = vi.fn((name: string): PresetData => ({
    name, version: 1,
    params: Object.fromEntries(Array.from(this.values, (value, index) => [`p${index}`, value])),
    mods: [], lfoShapes: this.lfoShapes.map(shape => shape.map(point => ({ ...point }))), fxOrder: [...FX_IDS]
  }))
  loadPreset = vi.fn((preset: Partial<PresetData>, _origin?: unknown) => {
    if (preset.params?.['master.volume'] !== undefined) this.values[paramIndex('master.volume')] = preset.params['master.volume']
  })
  /**
   * Wavetables imported through the browser UI, one slot per oscillator. Null is
   * the real default: no WebMCP tool can fill one, so `osc*.wavetable: Custom`
   * resolves to Digital unless a human has imported a WAV.
   */
  customTables: (object | null)[] = [null, null, null]
  captureSoundState = vi.fn(() => ({ customTables: this.customTables.slice() }))
  recordOutput = vi.fn(async (duration: number, _signal?: AbortSignal): Promise<RecordedAudio> => {
    const length = Math.max(32, Math.round(duration * 8000))
    const left = Float32Array.from({ length }, (_, index) => 0.2 * Math.sin(2 * Math.PI * 440 * index / 8000))
    return { blob: new Blob(['audio'], { type: 'audio/webm' }), mimeType: 'audio/webm', duration, sampleRate: 8000, channelData: [left, new Float32Array(left)] }
  })
}

function decodedReference(overrides: Partial<DecodedBase64Audio> = {}): DecodedBase64Audio {
  const channel = Float32Array.from([0, 0.5, -0.5, 0])
  return {
    decodedBytes: 4,
    duration: channel.length / 8000,
    sampleRate: 8000,
    channels: 1,
    channelData: [channel],
    ...overrides
  }
}

function setup(
  lifecycleSignal?: AbortSignal,
  decodeAudio: NonNullable<WebMcpToolDependencies['decodeAudio']> = vi.fn(async () => decodedReference()),
  extra: Omit<WebMcpToolDependencies, 'decodeAudio'> = {}
) {
  const engine = new FakeEngine()
  const tools = createWebMcpTools(engine as unknown as SynthEngine, lifecycleSignal, { decodeAudio, ...extra })
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  const execute = async (name: string, input: Record<string, unknown> = {}, signal = new AbortController().signal) =>
    await byName.get(name)!.execute(input, { signal }) as any
  return { engine, tools, byName, execute, decodeAudio }
}

beforeEach(() => {
  // Preset identity is module state in `preset-store.ts`, which is what makes it
  // survive a reload of the tools in the real app - and what makes one test's
  // `load_preset` leak into the next one's `get_synth_state` here.
  clearCurrentPreset()
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => `blob:render-${Math.random()}`),
    revokeObjectURL: vi.fn()
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('WebMCP tool metadata', () => {
  it('exposes exactly eighteen strict object schemas in composable workflow order', () => {
    const { tools } = setup()
    // The three patch-editing tools sit together, `apply_patch` last of them
    // because it composes the other two plus the preset save. `capture_audio`
    // follows `analyze_audio`: it reads the same rolling buffer that tool's
    // `source: "recent"` reads, and an agent that finds one should find the other.
    // The preset block runs save/load/list/delete/export, the order the same five
    // operations are named in every other CRUD surface an agent has seen.
    expect(tools.map(tool => tool.name)).toEqual([
      'get_synth_state', 'get_parameter_schema', 'update_parameters', 'set_modulation',
      'set_fx_order', 'apply_patch',
      'play_notes', 'render_audio', 'analyze_audio', 'capture_audio', 'analyze_reference_audio',
      'compare_audio', 'suggest_patch', 'save_preset', 'load_preset', 'list_presets',
      'delete_preset', 'export_preset'
    ])
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(10)
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
      expect(tool.execute).toBeTypeOf('function')
    }
    // `capture_audio` belongs here and `analyze_audio` does not, which is the
    // whole distinction: capture reads a ring the engine fills on its own —
    // it plays nothing, renders nothing, and leaves no `last-render` behind.
    // `export_preset` belongs here for a reason worth stating: it reads a stored
    // preset through `listPresets`, never the store's `loadPreset`, so it cannot
    // announce a load that never happened.
    expect(tools.filter(tool => tool.annotations?.readOnlyHint).map(tool => tool.name)).toEqual([
      'get_synth_state', 'get_parameter_schema', 'capture_audio', 'suggest_patch', 'list_presets', 'export_preset'
    ])
    // `compare_audio` renders by default now, so it is no longer read-only:
    // it replaces `last-render`, and on the realtime fallback it makes sound.
    // `analyze_audio` left the read-only list for the same kind of reason:
    // `source: "reference"` with a corrected `f0Hz` or a raised `windows`
    // replaces the active reference and resets the best-so-far with it.
    expect(tools.filter(tool => tool.annotations?.readOnlyHint === false).map(tool => tool.name)).toEqual([
      'update_parameters', 'set_modulation', 'set_fx_order', 'apply_patch', 'play_notes', 'render_audio',
      'analyze_audio', 'analyze_reference_audio', 'compare_audio', 'save_preset', 'load_preset', 'delete_preset'
    ])
    const reference = tools.find(tool => tool.name === 'analyze_reference_audio')!
    expect(reference.annotations?.untrustedContentHint).toBe(true)
    expect(reference.inputSchema).toMatchObject({
      required: ['audioBase64'],
      properties: {
        audioBase64: { type: 'string', maxLength: 16 * 1024 * 1024 },
        name: { type: 'string' },
        mimeType: { type: 'string' }
      }
    })
    expect((reference.inputSchema as any).properties.mimeType.pattern).toBe('^[aA][uU][dD][iI][oO]/')
  })

  it('keeps the whole tool listing small enough to survive a client that truncates it', () => {
    const { tools } = setup()
    const listing = tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
    const bytes = (value: string) => new TextEncoder().encode(value).length
    // In the discoverability eval Codex truncated the 17-tool listing and lost
    // `play_notes` entirely, then drove the page through <select> elements
    // instead. These tools were 10751 B of that listing (5019 B of prose,
    // 4958 B of schema) after four rounds of per-tool clarity fixes, and the
    // budget was then held at 9900 B for twelve tools.
    //
    // Fifteen tools now. Three things moved the ceiling from 13200 B, and each
    // is paid for in round trips rather than in prose: `apply_patch` carries the
    // largest schema here (~2600 B) because it takes parameters, modulations, FX
    // order, a preset name and an audition sequence in one call — the eight-call
    // sequence it replaces cost far more of an agent's context than its schema
    // does; `set_fx_order` adds the effect-chain vocabulary; and every note
    // schema now advertises `note` beside `midi`, four times over, which is the
    // point (an agent that only ever reads `midi` never learns names are
    // accepted). ~1300 B per tool against ~1015 B before, and the prose half —
    // what a truncating client renders first — moved from ~338 to ~415 B per
    // tool, with the per-tool cap below unchanged at 600 B.
    //
    // Sixteen now: `capture_audio` costs 509 B of prose and 759 B of schema,
    // and `analyze_audio`, `compare_audio` and `suggest_patch` each grew by a
    // sentence for the rolling capture, the summary mode and the stale-advice
    // warning. 19443 B -> 21444 B, i.e. 1340 B per tool against 1296 B for
    // fifteen: the ceiling moved because a tool was added, not because the
    // prose was allowed to spread. The per-tool cap is untouched, and every one
    // of the four that changed was trimmed back under it.
    //
    // Eighteen: `delete_preset` and `export_preset` cost 755 B of prose and
    // 512 B of schema, and `get_synth_state` grew a sentence for `patch.preset`.
    // The raise is smaller than the additions, because the same round found
    // three places where one fact was written twice and paid for twice —
    // `capture_audio` restating the 21 ms scope trap that `analyze_audio` (where
    // the wrong option is actually chosen) and the page brief both already
    // carry, `list_presets` restating load_preset's shadowing rule, and
    // `export_preset` restating it a third time. 21444 B -> 22954 B: 1275 B per
    // tool against 1340 for sixteen, and 438 B of prose per tool against 444.
    // Both averages fell, which is the only reading of this ceiling that means
    // anything — the total may only grow when a tool is added.
    expect(bytes(JSON.stringify(listing))).toBeLessThanOrEqual(23000)
    const prose = listing.reduce((total, tool) => total + bytes(tool.description), 0)
    expect(prose).toBeLessThanOrEqual(7900)
    for (const tool of listing) {
      // No single tool may dominate the read: render_audio's description alone
      // was 1273 B, a tenth of the whole listing.
      expect(bytes(tool.description), `${tool.name} description`).toBeLessThanOrEqual(600)
      // Essential sentence first, so a truncated read still gets the useful
      // half: nothing may open with a 200-byte run-on.
      const lead = tool.description.split(/(?<=\.)\s/)[0] ?? ''
      expect(bytes(lead), `${tool.name} lead sentence`).toBeLessThanOrEqual(200)
    }
  })
})

describe('validation errors that carry the schema', () => {
  it('names the accepted properties on an unexpected key', async () => {
    const { execute } = setup()
    await expect(execute('update_parameters', { changes: [] }))
      .rejects.toThrow("Unexpected input property 'changes'. Accepted: updates")
    await expect(execute('play_notes', { notes: [{ midi: 60, velocity: 1, start: 0, duration: 1, name: 'C4' }] }))
      .rejects.toThrow(/notes\[0\].*'name'/)
  })

  it('lists the required properties when one is missing', async () => {
    await expect(setup().execute('analyze_reference_audio', {}))
      .rejects.toThrow(/input\.audioBase64 is required\. Required: audioBase64\. Accepted: audioBase64, name, mimeType/)
  })

  it('suggests near parameter ids and lists the groups', async () => {
    const { execute } = setup()
    const failure = await execute('update_parameters', { updates: [{ id: 'filter.cutoff', value: 1000 }] })
      .catch((error: Error) => error.message)
    expect(failure).toContain("Unknown parameter 'filter.cutoff'")
    expect(failure).toContain('Did you mean filter1.cutoff, filter2.cutoff?')
    expect(failure).toContain('Groups: global, osc1')
  })

  it('caps suggestions at three and stays silent when nothing is close', async () => {
    const { execute } = setup()
    const many = await execute('update_parameters', { updates: [{ id: 'env', value: 1 }] })
      .catch((error: Error) => error.message)
    expect(many.match(/Did you mean ([^?]+)\?/)![1].split(', ')).toHaveLength(3)
    const none = await execute('update_parameters', { updates: [{ id: 'zzzzzzzzzz', value: 1 }] })
      .catch((error: Error) => error.message)
    expect(none).not.toContain('Did you mean')
    expect(none).toContain('Groups:')
  })

  it('lists every modulation source and suggests near destinations', async () => {
    const { execute } = setup()
    const source = await execute('set_modulation', { action: 'add', source: 'vel', destination: 'osc1.level', depth: 0.5 })
      .catch((error: Error) => error.message)
    expect(source).toContain("Unknown modulation source 'vel'")
    expect(source).toContain('Did you mean velocity?')
    expect(source).toMatch(/Valid: .*env1.*lfo1.*velocity/)

    const destination = await execute('set_modulation', { action: 'add', source: 'lfo1', destination: 'filter1.cutof', depth: 0.5 })
      .catch((error: Error) => error.message)
    expect(destination).toContain("Unknown modulation destination 'filter1.cutof'")
    expect(destination).toContain('Did you mean filter1.cutoff, filter2.cutoff?')
  })

  it('lists the choices for an unknown choice label', async () => {
    const failure = await setup().execute('update_parameters', { updates: [{ id: 'filter1.type', value: 'Lowpass' }] })
      .catch((error: Error) => error.message)
    expect(failure).toContain("Unknown choice 'Lowpass' for filter1.type")
    expect(failure).toContain('Choices: LP 12, LP 24, HP 12, HP 24, BP 12, BP 24, Notch, Comb, Formant')
  })
})

describe('single-round-trip discovery', () => {
  it('returns every parameter as one compact line without paging', async () => {
    const { execute } = setup()
    const result = await execute('get_parameter_schema', { format: 'compact' })
    expect(result.parameters.total).toBe(result.parameters.items.length)
    expect(result.parameters.items).toHaveLength(PARAMS.length)
    expect(result.parameters).not.toHaveProperty('nextOffset')
    expect(result.parameters.items).toContain('filter1.cutoff Hz 20..20000 exp =8000 mod')
    expect(result.parameters.items).toContain(
      'filter1.type {LP 12|LP 24|HP 12|HP 24|BP 12|BP 24|Notch|Comb|Formant} =1'
    )
    expect(result.parameters.items).toContain('master.bpm BPM 20..300 step1 =120')
    // Envelope times are advertised in the seconds the API accepts, not in the
    // milliseconds the UI renders for short values.
    expect(result.parameters.items).toContain('env1.attack s 0.001..10 exp =0.005 mod')
    expect(result.limits).toMatchObject({ modulationSlots: 32 })
  })

  it('accepts a limit of 60 in the full format and surfaces the unit hint', async () => {
    const { execute } = setup()
    const result = await execute('get_parameter_schema', { limit: 60 })
    expect(result.parameters.items).toHaveLength(60)
    // master.volume renders as a percentage but is raw 0..1.5, so it carries no
    // unit at all rather than a `%` an agent would read as 0..100.
    expect(result.parameters.items[0]).toMatchObject({ id: 'master.volume', min: 0, max: 1.5 })
    expect(result.parameters.items[0]).not.toHaveProperty('unit')
    // The envelope times render in ms but are accepted in seconds.
    const envelope = await execute('get_parameter_schema', { search: 'env1.attack' })
    expect(envelope.parameters.items[0]).toMatchObject({ id: 'env1.attack', unit: 's', curve: 'exp' })
    await expect(execute('get_parameter_schema', { limit: 61 })).rejects.toThrow(/1\.\.60/)
    await expect(execute('get_parameter_schema', { format: 'brief' })).rejects.toThrow(/format/i)
  })

  it('says what the opaque choices SOUND like, and pays for a shared table once', async () => {
    const { execute } = setup()
    // The motivating run: an agent spent four render-and-compare rounds guessing
    // which of the seven wavetables was the bright one, and found it by luck.
    // "Digital" and "FM Bell" say nothing about tilt or odd/even on their own.
    const table = await execute('get_parameter_schema', { search: 'osc1.wavetable' })
    const wavetable = table.parameters.items[0]
    expect(wavetable.id).toBe('osc1.wavetable')
    expect(Object.keys(wavetable.choiceNotes)).toEqual(wavetable.choices)
    expect(wavetable.choiceNotes.Digital).toMatch(/tilt/i)

    // osc1/2/3.wavetable share one notes object by reference, and it is ~2 kB.
    // A page wide enough to hold all three is exactly the page an agent asks for
    // when it wants to see everything, so it must not pay for that prose three
    // times over.
    const wide = await execute('get_parameter_schema', { limit: 60 })
    const carriers = wide.parameters.items.filter((item: { choiceNotes?: unknown }) => item.choiceNotes)
    const referrers = wide.parameters.items.filter((item: { choiceNotesSameAs?: unknown }) => item.choiceNotesSameAs)
    expect(carriers.map((item: { id: string }) => item.id)).toContain('osc1.wavetable')
    expect(referrers.map((item: { id: string }) => item.id)).toEqual(['osc2.wavetable', 'osc3.wavetable'])
    for (const item of referrers) expect(item.choiceNotesSameAs).toBe('osc1.wavetable')
    // Identity, not deep equality: the other annotated choices carry their own.
    for (const id of ['dist.type', 'filter.routing']) {
      const own = (await execute('get_parameter_schema', { search: id })).parameters.items[0]
      expect(own.id, id).toBe(id)
      expect(Object.keys(own.choiceNotes), id).toEqual(own.choices)
    }

    // Compact is a one-line-per-parameter format and stays one line: the notes
    // are the reason to ask for the full format on a narrow page.
    const compact = await execute('get_parameter_schema', { format: 'compact' })
    expect(JSON.stringify(compact)).not.toContain('choiceNotes')
    // And the default full page — the discovery call with a 1500 B budget — does
    // not reach osc1.wavetable at all, so it pays nothing either.
    expect(JSON.stringify(await execute('get_parameter_schema'))).not.toContain('choiceNotes')
  })

  it('refuses to let `Custom` read back as a wavetable that is not playing', async () => {
    const { engine, execute } = setup()
    // `engine.tableForOsc` resolves Custom as WAVETABLE_NAMES[min(sel, CUSTOM_WT - 1)]
    // when the slot is empty — Digital — and no tool here can fill that slot:
    // importWavetableFile takes a browser File. So the write "succeeded", the
    // state read back "Custom", and the agent reasoned about a table it was not
    // hearing.
    const applied = await execute('update_parameters', { updates: [{ id: 'osc1.wavetable', value: 'Custom' }] })
    expect(applied.applied[0]).toMatchObject({ id: 'osc1.wavetable', formatted: 'Custom', resolvesTo: 'Digital' })
    expect(applied.applied[0].note).toMatch(/no wavetable has been imported/)
    expect(applied.applied[0].note).toMatch(/no tool here can import one/i)

    // Reading the patch back says the same thing, in either format and on any
    // page — the page an agent asks for usually does not hold osc*.wavetable.
    for (const input of [{}, { format: 'compact' }, { group: 'filter' }]) {
      const state = await execute('get_synth_state', input)
      expect(state.patch.wavetableFallback, JSON.stringify(input)).toMatchObject({
        parameters: ['osc1.wavetable'], resolvesTo: 'Digital'
      })
    }

    // A built-in table is not a fallback and says nothing.
    await execute('update_parameters', { updates: [{ id: 'osc1.wavetable', value: 'PWM' }] })
    expect((await execute('get_synth_state')).patch).not.toHaveProperty('wavetableFallback')

    // And once a human HAS imported one, Custom is exactly what it claims.
    engine.customTables[0] = { name: 'imported' }
    const backed = await execute('update_parameters', { updates: [{ id: 'osc1.wavetable', value: 'Custom' }] })
    expect(backed.applied[0]).not.toHaveProperty('resolvesTo')
    expect((await execute('get_synth_state')).patch).not.toHaveProperty('wavetableFallback')

    // apply_patch runs the same batch through the same reporting, dry run too.
    const other = setup()
    const dry = await other.execute('apply_patch', { parameters: [{ id: 'osc2.wavetable', value: 'Custom' }], dryRun: true })
    expect(dry.wouldApply.parameters[0].resolvesTo).toBe('Digital')
    const real = await other.execute('apply_patch', { parameters: [{ id: 'osc2.wavetable', value: 'Custom' }] })
    expect(real.applied.parameters[0].resolvesTo).toBe('Digital')
  })

  it('reports the whole instrument and the next page when a compact call is truncated', async () => {
    const { execute } = setup()
    const result = await execute('get_parameter_schema', { format: 'compact', limit: 10 })
    expect(result.parameters.items).toHaveLength(10)
    // `total` is the instrument, not the page: a truncated page that claimed
    // ten parameters would leave the agent believing it had seen everything.
    expect(result.parameters.total).toBe(PARAMS.length)
    expect(result.parameters.nextOffset).toBe(10)
    const next = await execute('get_parameter_schema', { format: 'compact', offset: 10, limit: 10 })
    expect(next.parameters.items).not.toContain(result.parameters.items[0])
    expect(next.parameters.total).toBe(PARAMS.length)
    // A compact limit is bounded by the maximum the input schema advertises.
    await expect(execute('get_parameter_schema', { format: 'compact', limit: 61 })).rejects.toThrow(/1\.\.60/)
  })

  it('says in the input schema that compact needs no limit', () => {
    const { byName } = setup()
    // An evaluated agent read "call once with format: compact", then sent
    // `{ format: 'compact', limit: 60 }` because the schema advertised a
    // maximum and said nothing about compact — and paged four times.
    const schema = byName.get('get_parameter_schema')!.inputSchema as any
    expect(schema.properties.limit.description).toMatch(/compact/i)
    expect(schema.properties.limit.description).toMatch(/omit/i)
    expect(schema.properties.limit.description).toContain(String(PARAMS.length))
    expect(schema.properties.offset.description).toMatch(/compact/i)
    const state = byName.get('get_synth_state')!.inputSchema as any
    expect(state.properties.parameterLimit.description).toMatch(/compact/i)
    expect(state.properties.parameterLimit.description).toMatch(/omit/i)
    expect(state.properties.parameterOffset.description).toMatch(/compact/i)
  })

  it('makes "one unfiltered compact call" impossible to miss at the point an agent filters', async () => {
    const { byName, execute } = setup()
    // An evaluated agent made FIVE get_parameter_schema calls -
    // {format:'compact', group:'Filter'}, then filter1, env1, osc1, env2 -
    // where one unfiltered compact call returns all 224. The `group` and
    // `search` property descriptions are where it decides to filter.
    const schema = byName.get('get_parameter_schema')!.inputSchema as any
    for (const property of ['group', 'search']) {
      expect(schema.properties[property].description, property).toMatch(/omit/i)
      expect(schema.properties[property].description, property).toContain(String(PARAMS.length))
      expect(schema.properties[property].description, property).toMatch(/one call/i)
    }

    // `group: 'Filter'` with a capital F matches the `filter` routing group
    // case-insensitively: one parameter, not the filter section the agent
    // meant. That answer must be obvious rather than a silent near-empty page.
    const filter = await execute('get_parameter_schema', { format: 'compact', group: 'Filter' })
    expect(filter.parameters.total).toBe(1)
    expect(filter.groupFilter.group).toBe('filter')
    expect(filter.groupFilter.relatedGroups).toEqual(['filter1', 'filter2'])
    expect(filter.groupFilter.note).toContain(String(PARAMS.length))
    expect(filter.groupFilter.note).toMatch(/one call/i)
    // A group that matches everything it should carries no misleading note.
    const filter1 = await execute('get_parameter_schema', { group: 'FILTER1' })
    expect(filter1.groupFilter).toMatchObject({ group: 'filter1' })
    expect(filter1.groupFilter).not.toHaveProperty('relatedGroups')

    // An unknown group is an error that names the groups, not an empty page.
    for (const tool of ['get_parameter_schema', 'get_synth_state']) {
      await expect(execute(tool, { group: 'Fliter' }), tool).rejects.toThrow(/unknown group/i)
      await expect(execute(tool, { group: 'Fliter' }), tool).rejects.toThrow(/filter1/)
    }
  })

  it('lists only non-default parameters when synth state is compact', async () => {
    const { engine, execute } = setup()
    await execute('update_parameters', { updates: [{ id: 'filter1.cutoff', value: 1200 }] })
    const result = await execute('get_synth_state', { format: 'compact' })
    expect(result.patch.parameters.items).toEqual(['filter1.cutoff=1.20 kHz'])
    expect(result.patch.parameters.total).toBe(1)
    expect(result.patch.parameters).not.toHaveProperty('nextOffset')
    expect(engine.setParam).toHaveBeenCalledTimes(1)
  })
})

describe('preset listing', () => {
  it('lists factory and user presets as one ordered list, each tagged with its source', async () => {
    const { engine, execute } = setup()
    engine.toPreset.mockImplementation((name: string): PresetData => ({
      name, version: 1, params: { 'master.volume': 0.5 }, mods: [],
      lfoShapes: engine.lfoShapes.map(shape => shape.map(point => ({ ...point }))), fxOrder: [...FX_IDS]
    }))
    // The failure this replaces: `list_presets` returned only localStorage, so
    // on a fresh profile it returned `{presets: [], total: 0}` — which reads as
    // "this synth ships no presets" — while the UI dropdown listed 35 of them.
    const empty = await execute('list_presets')
    expect(empty.presets).toEqual(FACTORY_PRESETS.map(preset => ({ name: preset.name, source: 'factory' })))
    expect(empty).toMatchObject({ total: FACTORY_PRESETS.length, factory: FACTORY_PRESETS.length, user: 0 })
    expect(empty.presets[0]).toEqual({ name: 'Init', source: 'factory' })

    await execute('save_preset', { name: 'Concert Grand' })
    await execute('save_preset', { name: 'Rhodes' })
    const listed = await execute('list_presets')
    // One list, factory first in dropdown order, then user in save order.
    expect(listed.presets.slice(-2)).toEqual([
      { name: 'Concert Grand', source: 'user' }, { name: 'Rhodes', source: 'user' }
    ])
    expect(listed).toMatchObject({ total: FACTORY_PRESETS.length + 2, factory: FACTORY_PRESETS.length, user: 2 })
    expect(listed).not.toHaveProperty('shadowedFactoryPresets')

    // A collision is two rows, one per source — the thing separate arrays would hide.
    const shadowing = await execute('save_preset', { name: 'Init' })
    expect(shadowing.shadowsFactoryPreset).toBe(true)
    expect(shadowing.shadowNote).toMatch(/factory preset is also called "Init"/)
    const collided = await execute('list_presets')
    expect(collided.presets.filter((preset: any) => preset.name === 'Init')).toEqual([
      { name: 'Init', source: 'factory' }, { name: 'Init', source: 'user' }
    ])
    expect(collided.shadowedFactoryPresets).toEqual(['Init'])
    expect(collided.note).toMatch(/load_preset returns the user one/)
    await expect(execute('list_presets', { name: 'x' })).rejects.toThrow(/unexpected/i)
  })
})

describe('experimental client compatibility', () => {
  it('plays, renders, and compares when invocation options omit the AbortSignal', async () => {
    vi.useFakeTimers()
    const { byName, engine } = setup()
    const noteInput = { notes: [{ midi: 60, velocity: 0.8, start: 0, duration: 0.01 }] }

    const played = (byName.get('play_notes')!.execute as any)(noteInput)
    await vi.advanceTimersByTimeAsync(20)
    await expect(played).resolves.toMatchObject({ completed: true })

    const rendered = (byName.get('render_audio')!.execute as any)({ ...noteInput, duration: 0.02 }, {})
    await vi.advanceTimersByTimeAsync(30)
    await expect(rendered).resolves.toMatchObject({ renderMode: 'realtime', channels: 2 })
    expect(engine.heldNotes.size).toBe(0)

    await expect((byName.get('analyze_reference_audio')!.execute as any)({ audioBase64: 'UklGRg==' }))
      .resolves.toMatchObject({ source: 'base64-reference' })
    await expect((byName.get('compare_audio')!.execute as any)({}, {}))
      .resolves.toMatchObject({ candidate: { source: 'last-render' } })
  })
})

describe('state and parameter tools', () => {
  it('returns a stable-ID patch and runtime snapshot', async () => {
    const { engine, execute } = setup()
    engine.modSlots[3] = { source: modSourceIndex('lfo1'), dest: paramIndex('filter1.cutoff'), depth: 0.4, enabled: true }
    engine.heldNotes.add(60)
    const state = await execute('get_synth_state', { group: 'global', search: 'volume' })
    expect(state.patch.parameters.items['master.volume']).toMatchObject({ raw: 0.7, normalized: expect.any(Number), formatted: '70%' })
    expect(state.patch.modulationCount).toBe(1)
    const routes = await execute('get_synth_state', { modulationOffset: 0 })
    expect(routes.patch.modulations.items).toContainEqual({ slot: 3, source: 'lfo1', destination: 'filter1.cutoff', depth: 0.4, enabled: true })
    const lfo = await execute('get_synth_state', { lfo: 1 })
    expect(lfo.patch.lfoShape).toMatchObject({ id: 'lfo1', points: { items: expect.any(Array) } })
    expect(state.patch.fxOrder).toEqual(['chorus', 'phaser', 'flanger', 'delay', 'reverb', 'eq', 'comp', 'fxdist'])
    expect(state.runtime).toEqual({ running: true, heldNotes: [60], voices: 2, peaks: { left: 0.2, right: 0.1 } })
  })

  it('derives searchable schema with normalized defaults, sources, and limits', async () => {
    const { execute } = setup()
    const result = await execute('get_parameter_schema', { group: 'filter1', search: 'cut', sourceOffset: 6 })
    expect(result.parameters.items).toHaveLength(1)
    expect(result.parameters.items[0]).toMatchObject({
      id: 'filter1.cutoff', min: 20, max: 20000, default: 8000,
      curve: 'exp', moddable: true, normalizedDefault: expect.any(Number)
    })
    expect(result.modulationSources.items.some((source: any) => source.id === 'lfo1')).toBe(true)
    expect(result.limits).toMatchObject({ modulationSlots: 32, modulationDepth: [-1, 1], midiNotes: [0, 127], maxRenderSeconds: 15 })
    const tool = setup().byName.get('get_parameter_schema')!
    expect((tool.inputSchema as { properties: object }).properties).toMatchObject({
      group: { type: 'string', maxLength: 100 }, search: { type: 'string', maxLength: 100 }
    })
    await expect(execute('get_parameter_schema', { search: 'x'.repeat(101) })).rejects.toThrow(/100 characters/i)
    await expect(execute('get_parameter_schema', { nope: true })).rejects.toThrow(/unexpected/i)
  })

  it('says which envelope drives amplitude', async () => {
    const { execute, byName } = setup()
    // env1..env6 are otherwise presented identically, and both evaluating
    // agents had to infer the VCA from env1's defaults alone.
    expect(byName.get('get_parameter_schema')!.description).toMatch(/env1[^.]*amplitude/i)
    const env1 = await execute('get_parameter_schema', { group: 'env1' })
    expect(env1.groupNotes.env1).toMatch(/amplitude/i)
    const env2 = await execute('get_parameter_schema', { group: 'env2' })
    // Only env1 is hardwired; nothing must be claimed for the others.
    expect(env2.groupNotes.env2).not.toMatch(/amplitude|hardwired|VCA/i)
    expect(JSON.stringify(await execute('get_parameter_schema'))).not.toContain('groupNotes')
  })

  it('says which way the envelope curve parameters bend', async () => {
    const { execute } = setup()
    // `-1..1 =-0.4` with no stated meaning made the sign a coin flip: an agent
    // guessed wrong and its "3 second decay" was flat for the first 1.5 s.
    for (const group of ['env1', 'env3', 'env6']) {
      const notes = (await execute('get_parameter_schema', { group })).groupNotes[group]
      expect(notes, group).toMatch(/atk_curve/)
      expect(notes, group).toMatch(/dec_curve/)
      expect(notes, group).toMatch(/rel_curve/)
      // Both directions must be named, with the sign attached to each.
      expect(notes, group).toMatch(/0 is linear/i)
      expect(notes, group).toMatch(/positive/i)
      expect(notes, group).toMatch(/negative/i)
    }
  })

  it('lists modulation sources from a bare sourceLimit and in compact format', async () => {
    const { execute } = setup()
    // A limit without an offset used to return nothing at all, which cost two
    // agents a round trip each while guessing at the source vocabulary.
    const limited = await execute('get_parameter_schema', { sourceLimit: 60 })
    expect(limited.modulationSources.offset).toBe(0)
    expect(limited.modulationSources.items).toHaveLength(MOD_SOURCES.length)
    expect(limited.modulationSources.items.map((source: any) => source.id)).toContain('env2')
    const compact = await execute('get_parameter_schema', { format: 'compact', sourceLimit: 60 })
    expect(compact.modulationSources).toMatchObject({ format: 'compact', total: MOD_SOURCES.length })
    expect(compact.modulationSources.items).toContain('env2 voice 0..1')
    expect(compact.modulationSources.items).toContain('keytrack voice -1..1')
    expect(compact.modulationSources.items).toContain('macro1 global 0..1')
    // Paging still works, and the default page size is unchanged.
    const paged = await execute('get_parameter_schema', { sourceOffset: 6 })
    expect(paged.modulationSources).toMatchObject({ offset: 6, limit: 5, nextOffset: 11 })
  })

  it('says decayT60Ms is measured from the rendered tail, not read back from env1.decay', async () => {
    vi.useFakeTimers()
    const { byName, execute } = setup()
    const description = byName.get('render_audio')!.description
    const schema = byName.get('render_audio')!.inputSchema as any
    // An agent read decayT60Ms as a readback of env1.decay, then spent a
    // render discovering the note's own length moves it. The sentence now
    // travels with the number, in the response's `metricNotes`, because in the
    // description it was a tenth of the whole tool listing.
    const rendering = execute('render_audio', { notes: [{ midi: 60, velocity: 1, start: 0, duration: 0.01 }], duration: 0.02 })
    await vi.advanceTimersByTimeAsync(30)
    const notes = (await rendering).metricNotes
    expect(notes.decayT60Ms).toMatch(/decayT60Ms|tail/i)
    expect(notes.decayT60Ms).toMatch(/tail|rendered/i)
    expect(notes.decayT60Ms).toContain('env1.decay')
    expect(notes.decayT60Ms).toContain('env1.release')
    expect(notes.decayT60Ms).toMatch(/null/i)
    // The facts earlier findings bought must survive, each where a client reads
    // it: the response for how to read a metric, the schema for how to call.
    expect(notes.peakDb).toContain('instantaneous peak')
    expect(schema.properties.mode.description).toContain('"realtime"')
    expect(schema.properties.mode.description).toContain('renderModeFallback')
    // The fact that replaced "a single-pitch sequence also gets
    // `metrics.harmonics`": harmonics now follow whatever pitch was DETECTED,
    // so what the description has to promise is that the pitch is measured.
    expect(description).toMatch(/MEASURED/)
    expect(description).toContain('pitchCheck')
    expect(description).toMatch(/metricNotes/)
  })

  it('names the valid modulation sources on the set_modulation source property', async () => {
    const { byName } = setup()
    // The 24-id vocabulary an agent guessed twice in round 1 now sits on the
    // property it fills in rather than in the prose, which a truncating client
    // reads first and which had grown past what that client would show.
    const schema = byName.get('set_modulation')!.inputSchema as any
    for (const source of MOD_SOURCES) expect(schema.properties.source.description).toContain(source.id)
  })

  it('returns modulation routes by default, as get_synth_state promises', async () => {
    const { engine, execute } = setup()
    engine.modSlots[3] = { source: modSourceIndex('lfo1'), dest: paramIndex('filter1.cutoff'), depth: 0.4, enabled: true }
    engine.modSlots[7] = { source: modSourceIndex('env2'), dest: paramIndex('osc1.level'), depth: -0.2, enabled: true }
    // An agent that just added two routes and wants to confirm them must not
    // have to discover `modulationLimit` first.
    const route = { slot: 3, source: 'lfo1', destination: 'filter1.cutoff', depth: 0.4, enabled: true }
    for (const input of [{}, { format: 'compact' }, { group: 'env1' }]) {
      const state = await execute('get_synth_state', input)
      expect(state.patch.modulations.items, JSON.stringify(input)).toContainEqual(route)
      expect(state.patch.modulations.total).toBe(2)
      expect(state.patch.modulationCount).toBe(2)
    }
    // ...and the widening the description points at must actually work in the
    // mode the same description recommends first. This threw before: compact
    // set the parameters flag, so any modulation paging looked like a second
    // competing view and the named recovery path failed.
    for (const input of [{ format: 'compact', modulationLimit: MAX_MOD_SLOTS }, { modulationLimit: MAX_MOD_SLOTS }, { format: 'compact', modulationOffset: 0 }]) {
      const wide = await execute('get_synth_state', input)
      expect(wide.patch.modulations.items, JSON.stringify(input)).toContainEqual(route)
      expect(wide.patch.modulations.total, JSON.stringify(input)).toBe(2)
    }
    // A detailed parameter page and an LFO shape are still separate calls:
    // those are two genuinely expensive views, unlike an always-present field.
    await expect(execute('get_synth_state', { group: 'env1', lfo: 1 })).rejects.toThrow(/separate calls/)

    // The description must name the keys the payload actually uses.
    const { byName } = setup()
    const description = byName.get('get_synth_state')!.description
    expect(description).toContain('modulations')
    expect(description).toContain('lfoShape')
  })

  it('keeps default discovery responses within the recommended WebMCP output budget', async () => {
    const { engine, execute } = setup()
    expect(JSON.stringify(await execute('get_synth_state')).length).toBeLessThanOrEqual(1500)
    expect(JSON.stringify(await execute('get_parameter_schema')).length).toBeLessThanOrEqual(1500)
    // Routes are returned by default, so a fully wired matrix must still fit:
    // the default page caps it and `nextOffset` carries the rest.
    for (let slot = 0; slot < MAX_MOD_SLOTS; slot++) {
      engine.modSlots[slot] = { source: modSourceIndex('lfo1'), dest: paramIndex('filter1.cutoff'), depth: 0.4, enabled: true }
    }
    const saturated = await execute('get_synth_state')
    expect(JSON.stringify(saturated).length).toBeLessThanOrEqual(1500)
    expect(saturated.patch.modulations.nextOffset).toBe(saturated.patch.modulations.items.length)
  })

  it('atomically applies linear, exponential, step, and choice values canonically', async () => {
    const { engine, execute } = setup()
    const result = await execute('update_parameters', { updates: [
      { id: 'master.volume', value: 1.2 },
      { id: 'filter1.cutoff', value: 200 },
      { id: 'master.bpm', value: 121 },
      { id: 'osc1.wavetable', value: 'PWM' }
    ] })
    expect(engine.setParam).toHaveBeenCalledTimes(4)
    expect(result.applied.map((value: any) => value.raw)).toEqual([1.2, 200, 121, 2])
    expect(result.applied[0].normalized).toBeCloseTo(0.8)
    expect(result.applied[1].normalized).toBeCloseTo(Math.log(10) / Math.log(1000))
    expect(result.applied[3].formatted).toBe('PWM')
    expect(engine.toPreset).not.toHaveBeenCalled()
  })

  it.each([
    [{ id: 'missing', value: 1 }, /unknown/i],
    [{ id: 'master.volume', value: Number.NaN }, /finite/i],
    [{ id: 'master.volume', value: Infinity }, /finite/i],
    [{ id: 'master.volume', value: 2 }, /range/i],
    [{ id: 'master.bpm', value: 120.5 }, /step/i],
    [{ id: 'osc1.wavetable', value: 'Nope' }, /choice/i]
  ])('rejects invalid updates without mutation: %o', async (update, message) => {
    const { engine, execute } = setup()
    await expect(execute('update_parameters', { updates: [{ id: 'osc1.level', value: 0.5 }, update] })).rejects.toThrow(message)
    expect(engine.setParam).not.toHaveBeenCalled()
  })

  it('rejects duplicate IDs and unknown nested fields atomically', async () => {
    const { engine, execute } = setup()
    await expect(execute('update_parameters', { updates: [
      { id: 'master.volume', value: 1 }, { id: 'master.volume', value: 0.5 }
    ] })).rejects.toThrow(/duplicate/i)
    await expect(execute('update_parameters', { updates: [{ id: 'master.volume', value: 1, normalized: true }] })).rejects.toThrow(/unexpected/i)
    expect(engine.setParam).not.toHaveBeenCalled()
  })
})

describe('modulation tool', () => {
  it('adds, updates an existing pair instead of duplicating, updates by slot, removes, and clears', async () => {
    const { engine, execute } = setup()
    const added = await execute('set_modulation', { action: 'add', source: 'lfo1', destination: 'filter1.cutoff', depth: 0.25, enabled: false })
    expect(added.route).toMatchObject({ slot: 0, source: 'lfo1', destination: 'filter1.cutoff', depth: 0.25, enabled: false })
    const replaced = await execute('set_modulation', { action: 'add', source: 'lfo1', destination: 'filter1.cutoff', depth: -0.5 })
    expect(replaced.route).toMatchObject({ slot: 0, enabled: false })
    expect(replaced.count).toBe(1)
    const updated = await execute('set_modulation', { action: 'update', slot: 0, depth: 0.75, enabled: false })
    expect(updated.route).toMatchObject({ depth: 0.75, enabled: false })
    expect((await execute('set_modulation', { action: 'remove', slot: 0 })).count).toBe(0)
    await execute('set_modulation', { action: 'add', source: 'env1', destination: 'osc1.level', depth: 0.1 })
    expect((await execute('set_modulation', { action: 'clear' })).count).toBe(0)
    expect(engine.setModSlot).toHaveBeenCalled()
  })

  it.each([
    [{ action: 'add', source: 'wat', destination: 'osc1.level', depth: 0 }, /source/i],
    [{ action: 'add', source: 'lfo1', destination: 'wat', depth: 0 }, /destination/i],
    [{ action: 'add', source: 'lfo1', destination: 'master.bpm', depth: 0 }, /moddable/i],
    [{ action: 'add', source: 'lfo1', destination: 'osc1.level', depth: 2 }, /depth/i],
    [{ action: 'update', slot: 32, depth: 0 }, /slot/i],
    [{ action: 'remove', slot: 0, extra: true }, /unexpected/i]
  ])('rejects invalid route input %o', async (input, error) => {
    await expect(setup().execute('set_modulation', input)).rejects.toThrow(error)
  })

  it('addresses an existing route by the source and destination it was added with', async () => {
    const { execute, byName } = setup()
    // An agent that added a route by name naturally updates it by name; being
    // told to find a slot number first cost an evaluated agent a round trip.
    await execute('set_modulation', { action: 'add', source: 'velocity', destination: 'osc1.level', depth: 0.5 })
    const updated = await execute('set_modulation', { action: 'update', source: 'velocity', destination: 'osc1.level', depth: 0.3 })
    expect(updated.route).toMatchObject({ slot: 0, source: 'velocity', destination: 'osc1.level', depth: 0.3, enabled: true })
    const disabled = await execute('set_modulation', { action: 'update', source: 'velocity', destination: 'osc1.level', enabled: false })
    expect(disabled.route).toMatchObject({ slot: 0, depth: 0.3, enabled: false })
    expect(await execute('set_modulation', { action: 'remove', source: 'velocity', destination: 'osc1.level' })).toMatchObject({ removed: 0, count: 0 })
    // The description has to state both addressing modes, and must keep the
    // source vocabulary and the bipolar depth note from earlier findings.
    const description = byName.get('set_modulation')!.description
    expect(description).toMatch(/slot/)
    expect(description).toMatch(/source/)
    expect(description).toMatch(/destination/)
    expect(description).toMatch(/bipolar/)
  })

  it.each([
    [{ action: 'update', source: 'velocity', destination: 'osc1.level', depth: 0.3 }, /No modulation route from 'velocity' to 'osc1\.level'/],
    [{ action: 'remove', source: 'velocity', destination: 'osc1.level' }, /No modulation route from 'velocity' to 'osc1\.level'/],
    [{ action: 'update', slot: 0, source: 'velocity', destination: 'osc1.level', depth: 0.3 }, /ambiguous/i],
    [{ action: 'remove', slot: 0, source: 'velocity', destination: 'osc1.level' }, /ambiguous/i],
    [{ action: 'update', source: 'velocity', depth: 0.3 }, /both source and destination/i],
    [{ action: 'update', depth: 0.3 }, /slot/i],
    [{ action: 'update', source: 'vel', destination: 'osc1.level', depth: 0.3 }, /Did you mean velocity\?/],
    [{ action: 'remove', source: 'velocity', destination: 'osc1.levl' }, /Did you mean osc1\.level[,?]/]
  ])('rejects an unresolvable or ambiguous route address %o', async (input, error) => {
    await expect(setup().execute('set_modulation', input)).rejects.toThrow(error)
  })

  it('never creates a route from an update that names no existing pair', async () => {
    const { engine, execute } = setup()
    await expect(execute('set_modulation', { action: 'update', source: 'lfo1', destination: 'filter1.cutoff', depth: 0.4 }))
      .rejects.toThrow(/No modulation route/)
    expect(engine.setModSlot).not.toHaveBeenCalled()
    expect(engine.modSlots.filter(Boolean)).toHaveLength(0)
  })

  it('reports slot exhaustion', async () => {
    const { engine, execute } = setup()
    engine.modSlots.fill({ source: 0, dest: paramIndex('osc1.level'), depth: 0, enabled: true })
    await expect(execute('set_modulation', { action: 'add', source: 'lfo1', destination: 'filter1.cutoff', depth: 0 })).rejects.toThrow(/full/i)
  })
})

describe('note tools', () => {
  it('plays relative note timings and always cleans up', async () => {
    vi.useFakeTimers()
    const { engine, execute } = setup()
    const promise = execute('play_notes', { notes: [
      { midi: 60, velocity: 0.8, start: 0, duration: 0.1 },
      { midi: 64, velocity: 0.7, start: 0.05, duration: 0.1 }
    ] })
    await vi.advanceTimersByTimeAsync(200)
    await expect(promise).resolves.toMatchObject({ noteCount: 2, duration: 0.15 })
    expect(engine.noteOn).toHaveBeenCalledTimes(2)
    expect(engine.noteOff).toHaveBeenCalledTimes(2)
    expect(engine.allNotesOff).not.toHaveBeenCalled()
    expect(engine.heldNotes.size).toBe(0)
  })

  it('honors cancellation and only releases notes owned by the operation', async () => {
    vi.useFakeTimers()
    const { engine, execute } = setup()
    const controller = new AbortController()
    const promise = execute('play_notes', { notes: [{ midi: 60, velocity: 1, start: 0, duration: 10 }] }, controller.signal)
    await vi.advanceTimersByTimeAsync(10)
    controller.abort()
    await expect(promise).rejects.toThrow(/abort/i)
    expect(engine.noteOff).toHaveBeenCalledWith(60, expect.any(Symbol))
    expect(engine.allNotesOff).not.toHaveBeenCalled()
    expect(engine.heldNotes.size).toBe(0)
  })

  it('does not release a human owner that acquires the note after the WebMCP operation starts', async () => {
    vi.useFakeTimers()
    const { engine, execute } = setup()
    const controller = new AbortController()
    const promise = execute('play_notes', {
      notes: [{ midi: 60, velocity: 1, start: 0, duration: 10 }]
    }, controller.signal)
    await vi.advanceTimersByTimeAsync(1)

    engine.noteOn(60)
    controller.abort()
    await expect(promise).rejects.toThrow(/abort/i)

    expect(engine.noteOff).toHaveBeenCalledWith(60, expect.any(Symbol))
    expect(engine.heldNotes.has(60)).toBe(true)
    engine.noteOff(60)
    expect(engine.heldNotes.has(60)).toBe(false)
  })

  it('retriggers overlapping intervals for one MIDI note and rejects notes already held by another owner', async () => {
    vi.useFakeTimers()
    const first = setup()
    const retriggering = first.execute('play_notes', { notes: [
      { midi: 60, velocity: 1, start: 0, duration: 1 },
      { midi: 60, velocity: 1, start: 0.5, duration: 1 }
    ] })
    await vi.advanceTimersByTimeAsync(2000)
    await expect(retriggering).resolves.toMatchObject({ noteCount: 2, duration: 1.5, retriggered: 1, completed: true })
    // Release-then-restrike at 0.5s, then a single release at the later end.
    expect(first.engine.noteOn).toHaveBeenCalledTimes(2)
    expect(first.engine.noteOff).toHaveBeenCalledTimes(2)
    expect(first.engine.heldNotes.size).toBe(0)

    const second = setup()
    second.engine.heldNotes.add(60)
    await expect(second.execute('play_notes', { notes: [
      { midi: 60, velocity: 1, start: 0, duration: 0.1 }
    ] })).rejects.toThrow(/already held/i)
    expect(second.engine.heldNotes.has(60)).toBe(true)
    expect(second.engine.noteOff).not.toHaveBeenCalled()
  })

  it('uses one single-flight lock shared by play and render and releases it after abort', async () => {
    vi.useFakeTimers()
    const { execute } = setup()
    const controller = new AbortController()
    const playing = execute('play_notes', {
      notes: [{ midi: 60, velocity: 1, start: 0, duration: 10 }]
    }, controller.signal)
    await vi.advanceTimersByTimeAsync(1)
    await expect(execute('render_audio', {
      notes: [{ midi: 64, velocity: 1, start: 0, duration: 0.1 }], duration: 0.2
    })).rejects.toThrow(/performance.*progress/i)
    controller.abort()
    await expect(playing).rejects.toThrow(/abort/i)

    const afterAbort = execute('play_notes', {
      notes: [{ midi: 64, velocity: 1, start: 0, duration: 0.01 }]
    })
    await vi.advanceTimersByTimeAsync(20)
    await expect(afterAbort).resolves.toMatchObject({ completed: true })
  })

  it('blocks patch mutation for the complete performance window', async () => {
    vi.useFakeTimers()
    const { engine, execute } = setup()
    engine.toPreset.mockReturnValue({
      name: 'Before Performance', version: 1, params: { 'master.volume': 0.5 }, mods: [],
      lfoShapes: engine.lfoShapes.map(shape => shape.map(point => ({ ...point }))), fxOrder: [...FX_IDS]
    })
    await execute('save_preset', { name: 'Before Performance' })
    const controller = new AbortController()
    const playing = execute('play_notes', {
      notes: [{ midi: 60, velocity: 1, start: 0, duration: 10 }]
    }, controller.signal)
    await vi.advanceTimersByTimeAsync(1)

    await expect(execute('update_parameters', { updates: [{ id: 'master.volume', value: 0.5 }] }))
      .rejects.toThrow(/performance.*progress/i)
    await expect(execute('set_modulation', { action: 'clear' }))
      .rejects.toThrow(/performance.*progress/i)
    await expect(execute('load_preset', { name: 'Before Performance' }))
      .rejects.toThrow(/performance.*progress/i)
    expect(engine.setParam).not.toHaveBeenCalled()
    expect(engine.setModSlot).not.toHaveBeenCalled()
    expect(engine.loadPreset).not.toHaveBeenCalled()

    controller.abort()
    await expect(playing).rejects.toThrow(/abort/i)
    await expect(execute('update_parameters', { updates: [{ id: 'master.volume', value: 0.5 }] }))
      .resolves.toMatchObject({ applied: [{ id: 'master.volume' }] })
  })

  it.each([
    [{ midi: 60.5, velocity: 1, start: 0, duration: 1 }, /midi/i],
    [{ midi: 128, velocity: 1, start: 0, duration: 1 }, /midi/i],
    [{ midi: 60, velocity: 1.1, start: 0, duration: 1 }, /velocity/i],
    [{ midi: 60, velocity: 1, start: -1, duration: 1 }, /start/i],
    [{ midi: 60, velocity: 1, start: 0, duration: 0 }, /duration/i]
  ])('validates note %o', async (note, error) => {
    await expect(setup().execute('play_notes', { notes: [note] })).rejects.toThrow(error)
  })

  it('requires started audio and bounds the sequence', async () => {
    const first = setup(); first.engine.running = false
    // play_notes is now registered at page load, so an agent meets this error
    // rather than an absent tool. It has to name the thing to do instead.
    await expect(first.execute('play_notes', { notes: [{ midi: 60, velocity: 1, start: 0, duration: 1 }] }))
      .rejects.toThrow(/start audio.*render_audio/is)
    await expect(setup().execute('play_notes', { notes: [{ midi: 60, velocity: 1, start: 30, duration: 1 }] })).rejects.toThrow(/30 seconds/i)
    await expect(setup().execute('play_notes', { notes: Array.from({ length: 129 }, () => ({ midi: 60, velocity: 1, start: 0, duration: 1 })) })).rejects.toThrow(/128/i)
  })
})

describe('render and analysis tools', () => {
  it('records real-time output, analyzes it, returns a blob URL, and revokes the prior URL', async () => {
    vi.useFakeTimers()
    const { engine, execute } = setup()
    const input = { notes: [{ midi: 60, velocity: 0.8, start: 0, duration: 0.05 }], duration: 0.1, format: 'url' }
    const firstPromise = execute('render_audio', input)
    await vi.advanceTimersByTimeAsync(200)
    const first = await firstPromise
    expect(first).toMatchObject({ renderMode: 'realtime', mimeType: 'audio/webm', duration: 0.1, sampleRate: 8000, channels: 2, url: expect.stringMatching(/^blob:/) })
    expect(first.metrics.peakDb).toBeGreaterThan(-20)
    expect(engine.recordOutput).toHaveBeenCalledWith(0.1, expect.any(AbortSignal))
    const analysis = await execute('analyze_audio')
    expect(analysis.source).toBe('last-render')
    expect(analysis.metrics).toEqual(first.metrics)

    const secondPromise = execute('render_audio', input)
    await vi.advanceTimersByTimeAsync(200)
    await secondPromise
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(first.url)
    expect(engine.allNotesOff).not.toHaveBeenCalled()
  })

  it('revokes the latest blob URL and aborts an active performance on lifecycle disposal', async () => {
    vi.useFakeTimers()
    const lifecycle = new AbortController()
    const { engine, execute } = setup(lifecycle.signal)
    const rendered = execute('render_audio', {
      notes: [{ midi: 60, velocity: 1, start: 0, duration: 0.01 }], duration: 0.02, format: 'url'
    })
    await vi.advanceTimersByTimeAsync(30)
    const result = await rendered
    const active = execute('play_notes', {
      notes: [{ midi: 64, velocity: 1, start: 0, duration: 10 }]
    })
    await vi.advanceTimersByTimeAsync(1)
    lifecycle.abort()
    await expect(active).rejects.toThrow(/abort/i)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(result.url)
    expect(engine.noteOff).toHaveBeenCalledWith(64, expect.any(Symbol))
  })

  it('selects the analysis source explicitly', async () => {
    vi.useFakeTimers()
    const { byName, execute } = setup()
    expect((byName.get('analyze_audio')!.inputSchema as any).properties.source.enum).toEqual(['scope', 'recent', 'last-render', 'reference'])
    await expect(execute('analyze_audio', { source: 'last-render' })).rejects.toThrow(/render_audio first/i)

    const rendering = execute('render_audio', { notes: [{ midi: 60, velocity: 1, start: 0, duration: 0.01 }], duration: 0.02 })
    await vi.advanceTimersByTimeAsync(30)
    const render = await rendering
    expect(await execute('analyze_audio', { source: 'last-render' })).toMatchObject({ source: 'last-render', metrics: render.metrics })
    expect(await execute('analyze_audio', { source: 'scope' })).toMatchObject({ source: 'scope' })
    expect(await execute('analyze_audio')).toMatchObject({ source: 'last-render' })
    await expect(execute('analyze_audio', { source: 'nope' })).rejects.toThrow(/source/i)
  })

  it('documents the reference workflow as ordered steps and peakDb as instantaneous', async () => {
    vi.useFakeTimers()
    const { byName, execute } = setup()
    expect(byName.get('analyze_reference_audio')!.description).toMatch(/^Step 1 /)
    expect(byName.get('compare_audio')!.description).toMatch(/^Step 2/)
    // Both tools that report peakDb still say it is a peak — now in the
    // `metricNotes` that ship with the number instead of in the tool listing.
    const rendering = execute('render_audio', { notes: [{ midi: 60, velocity: 1, start: 0, duration: 0.01 }], duration: 0.02 })
    await vi.advanceTimersByTimeAsync(30)
    await rendering
    for (const name of ['render_audio', 'analyze_audio']) {
      const again = name === 'render_audio' ? execute(name, { notes: [{ midi: 60, velocity: 1, start: 0, duration: 0.01 }], duration: 0.02 }) : execute(name)
      await vi.advanceTimersByTimeAsync(30)
      const result = await again
      expect(result.metricNotes.peakDb, name).toContain('instantaneous peak — use `loudnessDb` or `rmsDb` to compare levels')
    }
    expect(byName.get('play_notes')!.description).toContain('{"notes":[{"note":"C4","velocity":0.8,"start":0,"duration":0.5}]}')
    expect(byName.get('update_parameters')!.description).toContain('{"id":"filter1.cutoff","value":1200}')
    expect(byName.get('set_modulation')!.description).toMatch(/bipolar.*normalized.*clamp/i)
  })

  it('falls back explicitly to current scope analysis, even before audio starts', async () => {
    const running = setup()
    const result = await running.execute('analyze_audio')
    expect(result).toMatchObject({ source: 'scope', sampleRate: 8000, channels: 2, metrics: { peakDb: expect.any(Number) } })

    const stopped = setup()
    stopped.engine.running = false
    ;(stopped.engine as unknown as { ctx: null }).ctx = null
    await expect(stopped.execute('analyze_audio')).resolves.toMatchObject({ source: 'scope', sampleRate: 48000 })
  })

  /**
   * A note that sounds for `noteSeconds` and then stops, followed by silence.
   * The shape of the real complaint: the human plays, releases, and asks whether
   * anything was heard, by which time the live scope holds only the silence.
   */
  function playedThenReleased(sampleRate: number, noteSeconds: number, silenceSeconds: number): Float32Array {
    const noteFrames = Math.round(noteSeconds * sampleRate)
    const total = noteFrames + Math.round(silenceSeconds * sampleRate)
    const buffer = new Float32Array(total)
    for (let index = 0; index < noteFrames; index++) {
      // Struck and decaying, so there is a real attack and a real T60 to find.
      const decay = Math.exp(-4 * index / noteFrames)
      buffer[index] = 0.8 * decay * Math.sin(2 * Math.PI * 220 * index / sampleRate)
    }
    return buffer
  }

  /** A fake engine at a real sample rate, so "1024 samples" means 21 ms. */
  function liveRateSetup() {
    const running = setup()
    running.engine.ctx = { sampleRate: 48000 }
    return running
  }

  it('hears a note on the rolling capture that the 21 ms scope has already thrown away', async () => {
    const { engine, execute } = liveRateSetup()
    const played = playedThenReleased(48000, 0.5, 0.5)
    engine.recentBuffer = [played, played.slice()]
    // What the worklet's scope holds a beat after note-off: the newest 1024
    // samples of a buffer whose last half-second is silence.
    engine.scopeL = played.slice(played.length - 1024)
    engine.scopeR = engine.scopeL.slice()

    const scope = await execute('analyze_audio', { source: 'scope' })
    const recent = await execute('analyze_audio', { source: 'recent' })

    // 1024 samples at 48 kHz is 21.3 ms. The whole of what the scope can see is
    // the silence after the note, so it answers "did you hear that?" with
    // digital silence — the exact failure this source exists to fix.
    expect(1024 / 48000).toBeCloseTo(0.0213, 4)
    expect(scope.metrics.peakDb).toBeLessThanOrEqual(-100)
    expect(scope.metrics.decayT60Ms).toBeNull()
    expect(scope.scopeNote).toContain('21 ms')

    // The same live output, kept instead of overwritten: a note with a level, an
    // attack that took longer than the scope's entire window, and a decay.
    expect(recent.source).toBe('recent')
    expect(recent.duration).toBeCloseTo(1, 2)
    expect(recent.metrics.peakDb).toBeGreaterThan(-6)
    expect(recent.metrics.decayT60Ms).toBeGreaterThan(0)
    expect(recent.metrics.envelopeDb).toHaveLength(64)
    // The envelope spans a note rather than a fragment: the last of its 64
    // points is far below the first, which 21 ms of steady tail can never show.
    expect(recent.metrics.envelopeDb.at(-1)).toBeLessThan(recent.metrics.envelopeDb[0] - 20)
    expect(recent.recentNote).toContain('LIVE output')
  })

  it('caps the analyzed window at what the buffer holds and refuses seconds on every other source', async () => {
    const { engine, execute } = liveRateSetup()
    const played = playedThenReleased(48000, 0.4, 0.1)
    engine.recentBuffer = [played, played.slice()]

    const half = await execute('analyze_audio', { source: 'recent', seconds: 0.25 })
    expect(half.duration).toBeCloseTo(0.25, 3)
    expect(half.heldSeconds).toBeCloseTo(0.5, 2)

    // Asking for more than the ring holds returns the ring, not padding.
    const all = await execute('analyze_audio', { source: 'recent', seconds: 4 })
    expect(all.duration).toBeCloseTo(0.5, 2)

    await expect(execute('analyze_audio', { source: 'recent', seconds: 5 })).rejects.toThrow(/limited to 4/)
    await expect(execute('analyze_audio', { source: 'scope', seconds: 1 })).rejects.toThrow(/only accepted with source: "recent"/)
  })

  it('says the capture is empty rather than analyzing a buffer that was never filled', async () => {
    const { execute } = liveRateSetup()
    await expect(execute('analyze_audio', { source: 'recent' })).rejects.toThrow(/rolling capture is empty/i)
    await expect(execute('capture_audio')).rejects.toThrow(/CLICK TO START AUDIO/)
    // Naming the offline escape matters: render_audio is what an agent should
    // reach for when no human is at the keyboard.
    await expect(execute('capture_audio')).rejects.toThrow(/render_audio/)
  })

  it('captures the requested window and hands back the samples the metrics describe', async () => {
    const { engine, byName, execute } = liveRateSetup()
    const played = playedThenReleased(48000, 1, 0)
    engine.recentBuffer = [played, played.slice()]

    const result = await execute('capture_audio', { captureSeconds: 0.5, format: 'base64' })
    expect(result.source).toBe('recent')
    expect(result.duration).toBeCloseTo(0.5, 3)
    expect(result.requestedSeconds).toBe(0.5)
    expect(result.silent).toBe(false)
    expect(result).not.toHaveProperty('silenceNote')
    expect(result.audio).toMatchObject({ mimeType: 'audio/wav', channels: 1, base64: expect.any(String) })
    expect(result.audio.base64.length).toBeGreaterThan(100)
    // The honest answer to "return actual audio content": WebMCP's execute
    // returns a JSON value and the API has no audio content block, so Base64
    // inside the JSON is the whole of what this transport can carry.
    expect(result.audio.transportNote).toMatch(/no audio content block/i)
    expect(byName.get('capture_audio')!.annotations).toMatchObject({ readOnlyHint: true })
    expect(await execute('capture_audio')).not.toHaveProperty('audio')
  })

  it('reports a silent buffer as silence instead of failing the call', async () => {
    const { engine, execute } = liveRateSetup()
    const silence = new Float32Array(48000)
    engine.recentBuffer = [silence, silence.slice()]

    const result = await execute('capture_audio', { captureSeconds: 0.5 })
    // Nobody played anything is an answer, not an error: the caller asked what
    // came out of the speakers and the truthful reply is "nothing".
    expect(result.silent).toBe(true)
    expect(result.metrics.peakDb).toBeLessThanOrEqual(-100)
    expect(result.silenceNote).toMatch(/digital silence/i)
    expect(result.silenceNote).toMatch(/render_audio/)
  })

  it('waits for a human to start playing, then captures the sound that arrived', async () => {
    vi.useFakeTimers()
    const { engine, execute } = liveRateSetup()
    const silence = new Float32Array(48000)
    engine.recentBuffer = [silence, silence.slice()]

    const capturing = execute('capture_audio', { waitForSignal: true, captureSeconds: 0.5, maxWaitSeconds: 3 })
    await vi.advanceTimersByTimeAsync(200)
    // The human plays a second into the wait; the ring fills behind the poll.
    const played = playedThenReleased(48000, 0.5, 0)
    engine.recentBuffer = [played, played.slice()]
    await vi.advanceTimersByTimeAsync(1000)

    const result = await capturing
    expect(result.waitForSignal).toBe(true)
    expect(result.signalDetected).toBe(true)
    expect(result.silent).toBe(false)
    expect(result.metrics.peakDb).toBeGreaterThan(-6)
    // Detected around 200 ms, then `captureSeconds` more so the window ends up
    // holding the note instead of the silence it began in.
    expect(result.waitedSeconds).toBeGreaterThanOrEqual(0.7)
    expect(result.waitedSeconds).toBeLessThan(1.2)
  })

  it('treats a wait that hears nothing as a silent window rather than a timeout error', async () => {
    vi.useFakeTimers()
    const { engine, execute } = liveRateSetup()
    const silence = new Float32Array(48000)
    engine.recentBuffer = [silence, silence.slice()]

    const capturing = execute('capture_audio', { waitForSignal: true, captureSeconds: 0.5, maxWaitSeconds: 1 })
    await vi.advanceTimersByTimeAsync(1500)
    const result = await capturing

    expect(result.signalDetected).toBe(false)
    expect(result.waitedSeconds).toBeGreaterThanOrEqual(1)
    expect(result.silent).toBe(true)
    expect(result.silenceNote).toMatch(/nobody played/i)
  })

  it('cancels a wait the moment the invocation is aborted, and bounds how long it may run', async () => {
    vi.useFakeTimers()
    const { engine, byName, execute } = liveRateSetup()
    const silence = new Float32Array(48000)
    engine.recentBuffer = [silence, silence.slice()]

    const controller = new AbortController()
    const capturing = execute('capture_audio', { waitForSignal: true, maxWaitSeconds: 10 }, controller.signal)
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await expect(capturing).rejects.toThrow(/aborted/i)

    // A call that sits waiting is a call the client is timing out against, so
    // the ceiling is part of the schema rather than a matter of taste.
    expect((byName.get('capture_audio')!.inputSchema as any).properties.maxWaitSeconds.maximum).toBe(10)
    await expect(execute('capture_audio', { waitForSignal: true, maxWaitSeconds: 11 })).rejects.toThrow(/limited to 10/)
    await expect(execute('capture_audio', { maxWaitSeconds: 3 })).rejects.toThrow(/waitForSignal: true/)
    await expect(execute('capture_audio', { captureSeconds: 9 })).rejects.toThrow(/limited to 4/)
  })

  it('refuses to capture once the page lifecycle has been torn down', async () => {
    const lifecycle = new AbortController()
    const { engine, execute } = setup(lifecycle.signal)
    engine.ctx = { sampleRate: 48000 }
    const played = playedThenReleased(48000, 0.5, 0)
    engine.recentBuffer = [played, played.slice()]
    await expect(execute('capture_audio', { captureSeconds: 0.25 })).resolves.toMatchObject({ silent: false })

    lifecycle.abort()
    await expect(execute('capture_audio', { captureSeconds: 0.25 })).rejects.toThrow(/aborted/i)
  })

  it('analyzes Base64 reference PCM with the same metrics without returning Base64 or PCM', async () => {
    const decodeAudio = vi.fn(async () => decodedReference({ mimeType: 'audio/wav' }))
    const { engine, execute } = setup(undefined, decodeAudio)
    const audioBase64 = 'data:audio/wav;base64,UklGRg=='
    const result = await execute('analyze_reference_audio', {
      audioBase64,
      name: 'reference.wav'
    })

    expect(result).toEqual({
      source: 'base64-reference',
      name: 'reference.wav',
      mimeType: 'audio/wav',
      decodedBytes: 4,
      duration: 4 / 8000,
      sampleRate: 8000,
      channels: 1,
      // This four-sample fixture holds nothing periodic, so `pitch` comes back
      // null and the result explains what that means. See the pitch-note test
      // below for the wording; here it only has to be part of the shape.
      pitchNote: expect.stringContaining('No fundamental was found'),
      // objectContaining so new AudioMetrics fields do not break this assertion.
      metrics: expect.objectContaining({
        peakDb: expect.any(Number), rmsDb: expect.any(Number), clippingCount: expect.any(Number),
        dcOffset: expect.any(Number), spectralCentroidHz: expect.any(Number), attackMs: expect.any(Number),
        stereoWidth: expect.any(Number)
      })
    })
    expect(decodeAudio).toHaveBeenCalledWith(audioBase64, {
      context: engine.ctx,
      signal: expect.any(AbortSignal)
    })
    expect(JSON.stringify(result)).not.toContain(audioBase64)
    expect(result).not.toHaveProperty('audioBase64')
    expect(result).not.toHaveProperty('channelData')
  })

  it('strictly validates reference properties, name, MIME type, and non-empty Base64', async () => {
    const { execute, decodeAudio } = setup()
    const invalid: Array<[Record<string, unknown>, RegExp]> = [
      [{ audioBase64: 'UklGRg==', extra: true }, /unexpected/i],
      [{}, /audioBase64.*required/i],
      [{ audioBase64: 4 }, /audioBase64.*string/i],
      [{ audioBase64: '' }, /audioBase64.*empty/i],
      [{ audioBase64: 'UklGRg==', name: '' }, /name/i],
      [{ audioBase64: 'UklGRg==', name: '   ' }, /name/i],
      [{ audioBase64: 'UklGRg==', name: 'x'.repeat(256) }, /255/i],
      [{ audioBase64: 'UklGRg==', name: 'bad\nname' }, /name/i],
      [{ audioBase64: 'UklGRg==', mimeType: 'text/plain' }, /audio MIME/i],
      [{ audioBase64: 'UklGRg==', mimeType: '' }, /audio MIME/i]
    ]
    for (const [input, error] of invalid) await expect(execute('analyze_reference_audio', input)).rejects.toThrow(error)
    expect(decodeAudio).not.toHaveBeenCalled()
  })

  it('normalizes explicit MIME case and rejects conflicts with data-URI-derived MIME', async () => {
    const decodeAudio = vi.fn(async () => decodedReference({ mimeType: 'AuDiO/WaV' }))
    const { execute } = setup(undefined, decodeAudio)
    await expect(execute('analyze_reference_audio', {
      audioBase64: 'DATA:AuDiO/WaV;BaSe64,UklGRg==',
      mimeType: 'AUDIO/WAV'
    })).resolves.toMatchObject({ mimeType: 'audio/wav' })
    await expect(execute('analyze_reference_audio', {
      audioBase64: 'data:audio/wav;base64,UklGRg==',
      mimeType: 'audio/mpeg'
    })).rejects.toThrow(/mimeType.*conflict/i)
  })

  it('refuses to score a reference against a silent scope instead of returning a baseline-looking number', async () => {
    const { engine, execute } = setup()
    // Before the audio gesture the scope is guaranteed digital silence. An
    // agent following the descriptions' own "Step 1 ... Step 2" ordering used
    // to get ok with similarity 0.209 against it — the only tells were
    // `candidate.source === "scope"` and a peakDb similarity of exactly 0.
    engine.running = false
    engine.scopeL = new Float32Array(256)
    engine.scopeR = new Float32Array(256)
    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })
    const rejection = expect(execute('compare_audio')).rejects
    await rejection.toThrow(/silent/i)
    await rejection.toThrow(/render_audio/)
    // Explicitly asking for the silent scope still works: -160 dB is legible.
    await expect(execute('analyze_audio', { source: 'scope' })).resolves.toMatchObject({ source: 'scope' })

    // The documented purpose of the fallback is untouched: a human IS playing,
    // so the scope carries real audio and the comparison is meaningful.
    const playing = setup()
    await playing.execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })
    await expect(playing.execute('compare_audio')).resolves.toMatchObject({ candidate: { source: 'scope' } })
  })

  it('requires a reference then compares against exactly the analyze_audio scope candidate', async () => {
    const { execute } = setup()
    await expect(execute('compare_audio')).rejects.toThrow(/analyze_reference_audio.*first/i)
    await expect(execute('compare_audio', { extra: true })).rejects.toThrow(/unexpected/i)

    const reference = await execute('analyze_reference_audio', { audioBase64: 'UklGRg==', mimeType: 'audio/wav' })
    const analysis = await execute('analyze_audio')
    // `format: "json"` is where "candidate is exactly what analyze_audio
    // returns" holds; text mode drops the arrays its table restates, and says so.
    const result = await execute('compare_audio', { format: 'json' })
    expect(result.reference).toEqual(reference)
    expect(result.candidate).toEqual(analysis)
    expect(result.comparison.similarity).toBeGreaterThanOrEqual(0)
    expect(result.comparison.similarity).toBeLessThanOrEqual(1)
    expect(Object.keys(result.comparison.details)).toEqual(expect.arrayContaining([
      'peakDb', 'rmsDb', 'clippingCount', 'dcOffset',
      'spectralCentroidHz', 'attackMs', 'stereoWidth'
    ]))
  })

  /**
   * A comparison against a reference long enough to carry real spectral
   * windows, so the response sizes below are the ones an agent actually pays.
   */
  async function comparisonSizes(windows: number) {
    const target = Float32Array.from({ length: 8000 }, (_, index) =>
      0.6 * Math.exp(-2 * index / 8000) * Math.sin(2 * Math.PI * 220 * index / 8000))
    const decodeAudio = vi.fn(async () => decodedReference({
      decodedBytes: target.length * 4, duration: 1, channelData: [target]
    }))
    const { execute } = setup(undefined, decodeAudio)
    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==', name: 'target.wav', windows })
    const comparing = execute('compare_audio', { format: 'text' })
    await vi.advanceTimersByTimeAsync(1200)
    const text = await comparing
    const comparingJson = execute('compare_audio', { format: 'json' })
    await vi.advanceTimersByTimeAsync(1200)
    const json = await comparingJson
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
    return { text, json, bytes, textBytes: bytes(text), jsonBytes: bytes(json) }
  }

  it('makes text mode a summary in the strict sense, without moving one byte of `comparison`', async () => {
    vi.useFakeTimers()
    const { text, json, bytes, textBytes, jsonBytes } = await comparisonSizes(4)

    // The defect: the table was additive on top of two complete metrics objects,
    // so every band, envelope point and spectral window was serialised twice —
    // once as the prose an agent reads and once as arrays it does not.
    for (const side of [text.reference, text.candidate]) {
      expect(side.metrics).not.toHaveProperty('envelopeDb')
      expect(side.metrics).not.toHaveProperty('bandsDb')
      expect(side.metrics).not.toHaveProperty('spectralWindows')
      expect(side).not.toHaveProperty('metricNotes')
      // Everything a text-mode caller might want and the table lacks survives.
      expect(side.metrics).toMatchObject({ peakDb: expect.any(Number), loudnessDb: expect.any(Number) })
    }
    expect(text.metricsOmitted.fields).toEqual(['envelopeDb', 'bandsDb', 'spectralWindows', 'metricNotes'])
    expect(text.metricsOmitted.note).toContain('format: "json"')
    expect(json.candidate.metrics.envelopeDb).toHaveLength(64)
    expect(json).not.toHaveProperty('metricsOmitted')

    // The eval-comparability guard. `docs/agent-match-eval.md` reads
    // `detailSimilarities` and `similarityTrajectory` off `comparison`; a
    // response that trimmed it in one mode would make every recorded run
    // incomparable with every other. Byte-identical, not merely equivalent.
    expect(JSON.stringify(text.comparison)).toBe(JSON.stringify(json.comparison))

    // The budget, and why it is measured the way it is.
    //
    // This block used to read `textBytes < previousTextBytes * 0.75`, where
    // `previousTextBytes` was `textBytes + the arrays this mode drops`. Multiply
    // that out and it says `textBytes < 3 * trimmed`: a ceiling on the WHOLE
    // response, denominated in the arrays, that tightened by three bytes for
    // every one the findings gained. It duly failed the round where a rule
    // learned to say WHY it was refusing a move — an improvement scored as a
    // regression, by a test written to assert something else entirely. The three
    // properties are measured directly now, and each fails for its own reason.
    const tableBytes = new TextEncoder().encode(text.text).length

    // 1. The contract: the arrays are not paid for twice. Measured on the fields
    // actually removed — 64 envelope points, 10 bands and `windows` x 12
    // partials per side — so it says nothing about how long the findings are.
    const trimmed = (bytes(json.reference) + bytes(json.candidate))
      - (bytes(text.reference) + bytes(text.candidate))
    expect(trimmed).toBeGreaterThan(2500)
    // Net of the block text mode adds back to say what it dropped.
    expect(trimmed - bytes(text.metricsOmitted)).toBeGreaterThan(2000)
    // Per side, so a trim that fired on only one of them cannot hide in a total.
    expect(bytes(text.reference)).toBeLessThan(bytes(json.reference) * 0.75)
    expect(bytes(text.candidate)).toBeLessThan(bytes(json.candidate) * 0.75)

    // 2. Smaller than the mode it claims to summarize, table and all — which it
    // was not while carrying json's arrays AND the table on top of them. And a
    // quarter smaller with the table set aside, since the structured half is the
    // part the two modes actually have in common.
    expect(tableBytes).toBeGreaterThan(1000)
    expect(textBytes).toBeLessThan(jsonBytes)
    expect(textBytes - tableBytes).toBeLessThan(jsonBytes * 0.75)

    // 3. An absolute cap, from measured reality, raised only by a decision
    // someone has to write down — the same rule the tool-listing ceiling keeps.
    // Today the response is 9615 B: 3036 table, 2360 structured actions, 1594
    // comparison, 1769 both metrics objects, 467 metricsOmitted, 264 progress.
    // 1777 B of that table is its ACTIONS block, restating the same five moves
    // `diff.actions` already carries WITH parameter ids and legal target values, so
    // `formatDiff` is told they ship structurally and prints one pointer line instead of
    // restating five moves — measured at 1779 B of block against a 138 B line, taking this
    // response from 9615 to ~7965. The cap keeps ~535 B of headroom, which is the right
    // order for a budget the findings' prose grows into: the assertion this replaced was a
    // ratio against the measured value itself, so it tightened every time a rule learned to
    // explain a refusal.
    expect(textBytes).toBeLessThanOrEqual(8500)
  })

  it('stops text mode growing with the window count, which is where the arrays hurt most', async () => {
    vi.useFakeTimers()
    const few = await comparisonSizes(4)
    const many = await comparisonSizes(12)

    // Each spectral window carries twelve partials per side, so `windows` is the
    // multiplier on the very arrays text mode drops. json triples them; text
    // mode pays only the handful of extra columns the BRIGHTNESS row prints.
    expect(many.jsonBytes - few.jsonBytes).toBeGreaterThan(1500)
    expect(many.textBytes - few.textBytes).toBeLessThan(400)
  })

  it('carries the session best so a peak that has passed is visible in one response', async () => {
    const { engine, execute } = setup()
    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })
    const compareAt = async (amplitude: number) => {
      engine.scopeL = Float32Array.from([0, amplitude, -amplitude, 0])
      engine.scopeR = engine.scopeL
      return await execute('compare_audio')
    }
    // The eval trajectory in miniature: climb toward the reference's own
    // amplitude, peak, then walk away from it and never get back. The real run
    // peaked at 0.847 on comparison 14, made 13 more comparisons that never
    // beat it, and saved the final 0.819 because `compare_audio` only ever
    // returned the current figure.
    const results = []
    for (const amplitude of [0.05, 0.15, 0.3, 0.5, 0.25, 0.18, 0.12, 0.09, 0.07]) results.push(await compareAt(amplitude))
    const similarity = results.map(result => result.comparison.similarity)
    const peak = 3
    // Sanity: the simulated trajectory really does climb, peak, then decline.
    for (let index = 1; index <= peak; index++) expect(similarity[index]).toBeGreaterThan(similarity[index - 1])
    for (let index = peak + 1; index < similarity.length; index++) expect(similarity[index]).toBeLessThan(similarity[index - 1])

    expect(results.map(result => result.progress.comparisonNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(results.map(result => result.progress.isBest)).toEqual([true, true, true, true, false, false, false, false, false])
    const best = Math.round(similarity[peak] * 1e4) / 1e4
    for (let index = peak + 1; index < results.length; index++) {
      const progress = results[index].progress
      expect(progress.best, `comparison ${index + 1} best`).toBe(best)
      expect(progress.bestComparisonNumber).toBe(peak + 1)
      expect(progress.comparisonsSinceBest).toBe(index - peak)
      expect(progress.deltaFromBest).toBeLessThan(0)
      expect(progress.deltaFromBest).toBeCloseTo(similarity[index] - similarity[peak], 4)
    }
    // The comparison at the peak names itself as the patch worth keeping.
    expect(results[peak].progress).toMatchObject({ isBest: true, deltaFromBest: 0, comparisonsSinceBest: 0 })
    expect(results[peak].progress.note).toMatch(/best/i)
    // And five fruitless comparisons later the response says so outright,
    // rather than leaving the agent to infer a plateau from 27 remembered numbers.
    const last = results[results.length - 1].progress
    expect(last.comparisonsSinceBest).toBe(5)
    expect(last.note).toMatch(/plateau/i)
    expect(last.note).toContain(String(best))
    expect(last.note).toMatch(/save_preset/)
  })

  it('points a lapsed run back at the render that scored best', async () => {
    vi.useFakeTimers()
    const engine = new FakeEngine()
    let soundEntryId = 'sound-peak'
    const tools = createWebMcpTools(engine as unknown as SynthEngine, undefined, {
      decodeAudio: vi.fn(async () => decodedReference()),
      currentSoundEntryId: () => soundEntryId
    })
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    const execute = async (name: string, input: Record<string, unknown> = {}) =>
      await byName.get(name)!.execute(input, { signal: new AbortController().signal }) as any
    const render = async () => {
      const rendering = execute('render_audio', { notes: [{ midi: 60, velocity: 1, start: 0, duration: 0.01 }], duration: 0.02 })
      await vi.advanceTimersByTimeAsync(30)
      await rendering
    }

    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })
    await render()
    const first = await execute('compare_audio')
    expect(first.progress).toMatchObject({ isBest: true, bestEntryId: 'sound-peak' })

    // A later render scores worse; the way back is the history entry of the
    // render that scored best, not the one in hand.
    soundEntryId = 'sound-worse'
    engine.recordOutput = vi.fn(async (duration: number) => {
      const length = Math.max(32, Math.round(duration * 8000))
      const left = Float32Array.from({ length }, (_, index) => 0.01 * Math.sin(2 * Math.PI * 50 * index / 8000) + 0.005)
      return { blob: new Blob(['audio'], { type: 'audio/webm' }), mimeType: 'audio/webm', duration, sampleRate: 8000, channelData: [left, new Float32Array(left)] }
    })
    await render()
    const second = await execute('compare_audio')
    expect(second.comparison.similarity).toBeLessThan(first.comparison.similarity)
    expect(second.progress).toMatchObject({ isBest: false, bestEntryId: 'sound-peak', bestComparisonNumber: 1 })
    expect(second.progress.note).toContain('navigate_history')
    expect(second.progress.note).toContain('sound-peak')
  })

  it('starts the best over when a new reference replaces the old matching problem', async () => {
    const decodeAudio = vi.fn()
      .mockResolvedValueOnce(decodedReference())
      .mockResolvedValueOnce(decodedReference({ decodedBytes: 8, channelData: [Float32Array.from([0, 0.02, -0.02, 0])] }))
    const { engine, execute } = setup(undefined, decodeAudio)
    engine.scopeL = Float32Array.from([0, 0.5, -0.5, 0])
    engine.scopeR = engine.scopeL

    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==', name: 'first.wav' })
    const matched = await execute('compare_audio')
    await execute('compare_audio')
    expect(matched.progress).toMatchObject({ comparisonNumber: 1, isBest: true })

    // A different target: a best earned against the previous one would be a lie.
    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==', name: 'second.wav' })
    const fresh = await execute('compare_audio')
    expect(fresh.progress).toMatchObject({ comparisonNumber: 1, isBest: true, bestComparisonNumber: 1, comparisonsSinceBest: 0, deltaFromBest: 0 })
    expect(fresh.progress.best).toBe(Math.round(fresh.comparison.similarity * 1e4) / 1e4)
    expect(fresh.progress.best).not.toBe(matched.progress.best)
  })

  it('calls a score equal to the best a tie, and keeps the remediation for a real regression', async () => {
    // Eval run 4, exactly: the final comparison scored 0.81727124416943 — the
    // same bits as comparison 23's best — and a `similarity > best` test called
    // it WORSE, told the agent to restore history away from its own best patch,
    // and warned that save_preset would save the wrong one. Every word false,
    // and all three acted on.
    let soundEntryId = 'sound-first'
    const { engine, execute } = setup(undefined, vi.fn(async () => decodedReference()), {
      currentSoundEntryId: () => soundEntryId
    })
    engine.scopeL = Float32Array.from([0, 0.5, -0.5, 0])
    engine.scopeR = engine.scopeL
    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })

    const first = await execute('compare_audio')
    expect(first.progress).toMatchObject({ standing: 'best', isBest: true, bestEntryId: 'sound-first' })

    // A different sound-history entry that happens to score identically, so this
    // is not the "you are holding the best patch" case below — it is a genuine
    // second patch that ties.
    soundEntryId = 'sound-second'
    const tie = await execute('compare_audio')
    expect(tie.comparison.similarity).toBe(first.comparison.similarity)

    expect(tie.progress).toMatchObject({ standing: 'tied', isBest: true, deltaFromBest: 0 })
    // The best keeps its own number: `comparisonsSinceBest` counts comparisons
    // that have not IMPROVED on it, which is what the plateau is about.
    expect(tie.progress.bestComparisonNumber).toBe(1)
    expect(tie.progress.comparisonsSinceBest).toBe(1)
    expect(tie.progress.note).toMatch(/ties the best/i)
    // The three pieces of false advice, none of which may fire on a tie.
    expect(tie.progress.note).not.toMatch(/worse/i)
    expect(tie.progress.note).not.toMatch(/navigate_history/)
    expect(tie.progress.note).not.toMatch(/save_preset would save this patch/)

    // A real regression still gets all three.
    engine.scopeL = Float32Array.from([0, 0.02, -0.02, 0])
    engine.scopeR = engine.scopeL
    const dropped = await execute('compare_audio')
    expect(dropped.progress).toMatchObject({ standing: 'worse', isBest: false })
    expect(dropped.progress.deltaFromBest).toBeLessThan(0)
    expect(dropped.progress.note).toMatch(/worse than comparison 1/i)
    expect(dropped.progress.note).toContain('navigate_history')
    expect(dropped.progress.note).toContain('sound-first')
    expect(dropped.progress.note).toMatch(/save_preset would save this patch/)
  })

  it('never pairs deltaFromBest 0 with a worse-than verdict, whatever the trajectory', async () => {
    // The invariant the run-4 bug broke: the verdict and the number beside it are
    // read off the same comparison, so they may never disagree. Swept rather than
    // spot-checked, because the failure was one arm of one branch.
    const trajectories = [
      [0.5, 0.5, 0.5, 0.5],
      [0.05, 0.5, 0.5, 0.25, 0.5],
      [0.5, 0.25, 0.12, 0.5],
      [0.05, 0.15, 0.3, 0.5, 0.25, 0.18, 0.12, 0.09, 0.07],
      [0.5, 0.05, 0.5, 0.05, 0.5],
      [0.3, 0.3, 0.05, 0.3, 0.3, 0.3, 0.3]
    ]
    for (const amplitudes of trajectories) {
      const { engine, execute } = setup()
      await execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })
      for (const [index, amplitude] of amplitudes.entries()) {
        engine.scopeL = Float32Array.from([0, amplitude, -amplitude, 0])
        engine.scopeR = engine.scopeL
        const { progress } = await execute('compare_audio')
        const where = `[${amplitudes.join(', ')}] #${index + 1}`
        const saysWorse = /worse than/i.test(progress.note)
        expect(saysWorse, where).toBe(progress.deltaFromBest < 0)
        expect(progress.standing === 'worse', where).toBe(saysWorse)
        expect(progress.isBest, where).toBe(!saysWorse)
        // Never above the best: the best IS the maximum seen.
        expect(progress.deltaFromBest, where).toBeLessThanOrEqual(0)
        expect(progress.best, where).toBeGreaterThanOrEqual(Math.round(progress.deltaFromBest * 1e4) / 1e4)
        if (saysWorse) continue
        // Remediation is emitted off the verdict, so it may not survive without it.
        expect(progress.note, where).not.toMatch(/navigate_history/)
        expect(progress.note, where).not.toMatch(/save_preset would save this patch/)
      }
    }
  })

  it('stops telling an agent to restore the very patch it is holding', async () => {
    // The same defect one branch over: `restore` and the save warning fired on
    // the VERDICT alone, so re-comparing the best patch against a different
    // render — other notes, another duration, the live scope — sent the agent to
    // navigate_history for a patch already loaded, and told it save_preset would
    // save the wrong one.
    const { engine, execute } = setup(undefined, vi.fn(async () => decodedReference()), {
      currentSoundEntryId: () => 'sound-best'
    })
    engine.scopeL = Float32Array.from([0, 0.5, -0.5, 0])
    engine.scopeR = engine.scopeL
    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })
    expect((await execute('compare_audio')).progress).toMatchObject({ isBest: true, bestEntryId: 'sound-best' })

    engine.scopeL = Float32Array.from([0, 0.02, -0.02, 0])
    engine.scopeR = engine.scopeL
    const { progress } = await execute('compare_audio')
    expect(progress.standing).toBe('worse')
    expect(progress.note).not.toMatch(/navigate_history/)
    expect(progress.note).not.toMatch(/save_preset would save this patch/)
    expect(progress.note).toMatch(/patch loaded now IS the one that scored best/)
    expect(progress.note).toContain('sound-best')
  })

  it('compares against the latest real render and retains only the latest reference analysis', async () => {
    vi.useFakeTimers()
    const first = decodedReference()
    const second = decodedReference({
      decodedBytes: 8,
      channelData: [new Float32Array([0, 0.25, -0.25, 0])]
    })
    const decodeAudio = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    const { execute } = setup(undefined, decodeAudio)
    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==', name: 'first.wav' })
    const latest = await execute('analyze_reference_audio', { audioBase64: 'UklGRg==', name: 'latest.wav' })

    const rendering = execute('render_audio', {
      notes: [{ midi: 60, velocity: 1, start: 0, duration: 0.01 }], duration: 0.02, format: 'url'
    })
    await vi.advanceTimersByTimeAsync(30)
    const render = await rendering
    const result = await execute('compare_audio', { format: 'json' })
    expect(result.reference).toEqual(latest)
    expect(result.reference.name).toBe('latest.wav')
    expect(result.candidate).toMatchObject({ source: 'last-render', metrics: render.metrics, url: render.url })
    expect(result.reference).not.toHaveProperty('channelData')
  })

  it('rejects stale out-of-order reference completion and compare_audio retains the newer reference', async () => {
    const resolvers: Array<(decoded: DecodedBase64Audio) => void> = []
    const decodeAudio = vi.fn(() => new Promise<DecodedBase64Audio>(resolve => resolvers.push(resolve)))
    const { execute } = setup(undefined, decodeAudio)
    const older = execute('analyze_reference_audio', { audioBase64: 'UklGRg==', name: 'older.wav' })
    const newer = execute('analyze_reference_audio', { audioBase64: 'UklGRg==', name: 'newer.wav' })
    await vi.waitFor(() => expect(resolvers).toHaveLength(2))

    resolvers[1](decodedReference({ decodedBytes: 8 }))
    await expect(newer).resolves.toMatchObject({ name: 'newer.wav', decodedBytes: 8 })
    resolvers[0](decodedReference({ decodedBytes: 4 }))
    await expect(older).rejects.toThrow(/superseded/i)

    await expect(execute('compare_audio')).resolves.toMatchObject({
      reference: { name: 'newer.wav', decodedBytes: 8 }
    })
  })

  it('promptly aborts a superseded decoder before starting the replacement and retains only B', async () => {
    let activeDecodes = 0
    let maxConcurrentDecodes = 0
    let firstSignal: AbortSignal | undefined
    const firstExecution = new AbortController()
    const decodeAudio = vi.fn((audioBase64: string, options: DecodeBase64AudioOptions = {}) => {
      activeDecodes++
      maxConcurrentDecodes = Math.max(maxConcurrentDecodes, activeDecodes)
      if (audioBase64 === 'Qg==') {
        activeDecodes--
        return Promise.resolve(decodedReference({
          decodedBytes: 8,
          channelData: [new Float32Array([0, 0.25, -0.25, 0])]
        }))
      }

      firstSignal = options.signal
      return new Promise<DecodedBase64Audio>((_resolve, reject) => {
        const abort = () => {
          activeDecodes--
          const error = new Error('Reference audio analysis superseded')
          error.name = 'AbortError'
          reject(error)
        }
        options.signal?.addEventListener('abort', abort, { once: true })
        if (options.signal?.aborted) abort()
      })
    })
    const { execute } = setup(undefined, decodeAudio)
    const first = execute('analyze_reference_audio', { audioBase64: 'QQ==', name: 'A.wav' }, firstExecution.signal)

    try {
      await vi.waitFor(() => expect(decodeAudio).toHaveBeenCalledOnce())
      const second = execute('analyze_reference_audio', { audioBase64: 'Qg==', name: 'B.wav' })

      await expect(second).resolves.toMatchObject({ name: 'B.wav', decodedBytes: 8 })
      await vi.waitFor(() => expect(firstSignal?.aborted).toBe(true), { timeout: 100 })
      await expect(first).rejects.toMatchObject({ name: 'AbortError' })
      expect(maxConcurrentDecodes).toBe(1)
      expect(activeDecodes).toBe(0)
      await expect(execute('compare_audio')).resolves.toMatchObject({
        reference: { name: 'B.wav', decodedBytes: 8 }
      })
    } finally {
      firstExecution.abort()
      await first.catch(() => undefined)
    }
  })

  it('promptly aborts the active reference decoder on lifecycle disposal', async () => {
    let activeDecodes = 0
    let decoderSignal: AbortSignal | undefined
    const lifecycle = new AbortController()
    const decodeAudio = vi.fn((_audioBase64: string, options: DecodeBase64AudioOptions = {}) => {
      activeDecodes++
      decoderSignal = options.signal
      return new Promise<DecodedBase64Audio>((_resolve, reject) => {
        const abort = () => {
          activeDecodes--
          const error = new Error('Reference audio analysis aborted')
          error.name = 'AbortError'
          reject(error)
        }
        options.signal?.addEventListener('abort', abort, { once: true })
        if (options.signal?.aborted) abort()
      })
    })
    const { execute } = setup(lifecycle.signal, decodeAudio)
    const pending = execute('analyze_reference_audio', { audioBase64: 'QQ==' })

    await vi.waitFor(() => expect(decodeAudio).toHaveBeenCalledOnce())
    lifecycle.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(decoderSignal?.aborted).toBe(true)
    expect(activeDecodes).toBe(0)
  })

  it('honors execute and lifecycle aborts around reference decoding and analysis', async () => {
    let finish!: () => void
    const decodeAudio = vi.fn((_value: string, _options: unknown) => new Promise<DecodedBase64Audio>(resolve => {
      finish = () => resolve(decodedReference())
    }))
    const execution = new AbortController()
    const first = setup(undefined, decodeAudio)
    const pending = first.execute('analyze_reference_audio', { audioBase64: 'UklGRg==' }, execution.signal)
    await vi.waitFor(() => expect(decodeAudio).toHaveBeenCalledOnce())
    execution.abort()
    finish()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })

    const lifecycle = new AbortController()
    const second = setup(lifecycle.signal, decodeAudio)
    const disposed = second.execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })
    await vi.waitFor(() => expect(decodeAudio).toHaveBeenCalledTimes(2))
    lifecycle.abort()
    finish()
    await expect(disposed).rejects.toMatchObject({ name: 'AbortError' })
    await expect(second.execute('compare_audio')).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('aborts the note sequence and cleans up if recording fails', async () => {
    vi.useFakeTimers()
    const { engine, execute } = setup()
    engine.recordOutput.mockRejectedValueOnce(new Error('recorder failed'))
    await expect(execute('render_audio', {
      notes: [{ midi: 60, velocity: 1, start: 0, duration: 10 }], duration: 10
    })).rejects.toThrow(/recorder failed/i)
    expect(engine.noteOff).toHaveBeenCalledWith(60, expect.any(Symbol))
    expect(engine.allNotesOff).not.toHaveBeenCalled()
    expect(engine.heldNotes.size).toBe(0)
    const afterError = execute('play_notes', {
      notes: [{ midi: 64, velocity: 1, start: 0, duration: 0.01 }]
    })
    await vi.advanceTimersByTimeAsync(20)
    await expect(afterError).resolves.toMatchObject({ completed: true })
  })

  it('requires audio and enforces the 15-second real-time bound', async () => {
    const stopped = setup(); stopped.engine.running = false
    await expect(stopped.execute('render_audio', { notes: [{ midi: 60, velocity: 1, start: 0, duration: 1 }] })).rejects.toThrow(/start audio/i)
    await expect(setup().execute('render_audio', { notes: [{ midi: 60, velocity: 1, start: 0, duration: 1 }], duration: 15.1 })).rejects.toThrow(/15 seconds/i)
  })
})

/**
 * Offline rendering (plan Task 10). jsdom has no `OfflineAudioContext`, so the
 * renderer is injected exactly as `decodeAudio` is; `offline-render.test.ts`
 * covers the real implementation against a fake offline context.
 */
describe('offline rendering', () => {
  const OFFLINE_RATE = 8000

  /** Deterministic: the same notes and duration always produce the same PCM. */
  function offlineRenderer() {
    return vi.fn(async (_engine: unknown, notes: readonly { midi: number }[], duration: number): Promise<RecordedAudio> => {
      const length = Math.max(64, Math.round(duration * OFFLINE_RATE))
      const f0 = 440 * Math.pow(2, ((notes[0]?.midi ?? 69) - 69) / 12)
      const channel = Float32Array.from({ length }, (_, index) => {
        const t = index / OFFLINE_RATE
        return 0.5 * Math.exp(-3 * t) * Math.sin(2 * Math.PI * f0 * t)
      })
      const channelData = [channel, channel.slice()]
      return {
        blob: new Blob([encodeWav(channelData, OFFLINE_RATE)], { type: 'audio/wav' }),
        mimeType: 'audio/wav',
        duration,
        sampleRate: OFFLINE_RATE,
        channelData
      }
    })
  }

  function offlineSetup(renderOffline = offlineRenderer()) {
    const engine = new FakeEngine()
    engine.running = false
    const tools = createWebMcpTools(engine as unknown as SynthEngine, undefined, { renderOffline })
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    const execute = async (name: string, input: Record<string, unknown> = {}) =>
      await byName.get(name)!.execute(input, { signal: new AbortController().signal }) as any
    return { engine, byName, execute, renderOffline }
  }

  it('advertises the mode and format choices and no longer demands a Start gesture', () => {
    const { byName } = offlineSetup()
    const tool = byName.get('render_audio')!
    expect((tool.inputSchema as any).properties.mode.enum).toEqual(['offline', 'realtime'])
    expect((tool.inputSchema as any).properties.format.enum).toEqual(['metrics', 'url', 'base64'])
    expect(tool.description).toMatch(/offline/i)
    expect(tool.description).not.toMatch(/CLICK TO START AUDIO/i)
    expect(byName.get('play_notes')!.description).toMatch(/CLICK TO START AUDIO/i)
    // play_notes registers at page load, so its description is read long
    // before it is usable: it must point at the tool that needs no gesture.
    expect(byName.get('play_notes')!.description).toMatch(/render_audio/)
  })

  it('renders offline by default, without a Start gesture, and repeats itself exactly', async () => {
    const { engine, execute, renderOffline } = offlineSetup()
    const input = { notes: [{ midi: 60, velocity: 0.8, start: 0, duration: 1 }], duration: 1.5 }
    const first = await execute('render_audio', input)
    expect(first).toMatchObject({ renderMode: 'offline', mimeType: 'audio/wav', duration: 1.5, sampleRate: OFFLINE_RATE, channels: 2 })
    expect(first).not.toHaveProperty('url')
    expect(first).not.toHaveProperty('audio')
    expect(first).not.toHaveProperty('renderModeFallback')
    expect(engine.recordOutput, 'no live capture, no gesture').not.toHaveBeenCalled()
    expect(engine.noteOn).not.toHaveBeenCalled()
    expect(renderOffline).toHaveBeenCalledWith(engine, expect.any(Array), 1.5, { signal: expect.any(AbortSignal) })

    const second = await execute('render_audio', input)
    expect(second.metrics).toEqual(first.metrics)
    // A single-pitch sequence gets harmonic analysis for free (plan Task 7.4).
    expect(first.metrics.harmonics?.inharmonicity).toBeTypeOf('number')
    expect(first.metrics.decayT60Ms).toBeGreaterThan(0)
  })

  it('hands the offline renderer the cancellation signal so an in-flight render can bail', async () => {
    const engine = new FakeEngine()
    engine.running = false
    let received: AbortSignal | undefined
    // Settles only on abort: if the signal never reached the renderer, the
    // tool call could not be cancelled at all.
    const renderOffline = vi.fn((
      _engine: unknown, _notes: unknown, _duration: number, options?: { signal?: AbortSignal }
    ): Promise<RecordedAudio> => {
      received = options?.signal
      return new Promise<RecordedAudio>((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => {
          const error = new Error('Execution aborted')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    })
    const tools = createWebMcpTools(engine as unknown as SynthEngine, undefined, { renderOffline })
    const controller = new AbortController()
    const pending = tools.find(tool => tool.name === 'render_audio')!.execute(
      { notes: [{ midi: 60, velocity: 1, start: 0, duration: 1 }], duration: 1.5 },
      { signal: controller.signal }
    ) as Promise<any>
    await vi.waitFor(() => expect(received, 'the renderer must receive an AbortSignal').toBeInstanceOf(AbortSignal))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(received!.aborted).toBe(true)
  })

  /**
   * A multi-pitch render used to report no harmonics at all: the tool passed
   * `f0Hz` only for a single-pitch sequence, and without one the analyzer
   * skipped detection.
   *
   * The decision now that detection is on by default: a chord is analyzed the
   * same way an uploaded chord would be — the fundamental is MEASURED, not
   * assumed from a note the analyzer was told about. That symmetry is the whole
   * point of the change, so the tool must not switch detection off just because
   * it happens to know the sequence had two notes. What separates the two cases
   * is `pitch.source`: `given` when the tool supplied the note's own f0,
   * `detected` when the analyzer had to find one, with `pitch.confidence`
   * saying how much to trust the partials that came with it.
   */
  it('detects rather than assumes the fundamental, for one pitch as well as for a chord', async () => {
    const { execute } = offlineSetup()
    const chord = await execute('render_audio', {
      notes: [
        { midi: 60, velocity: 0.8, start: 0, duration: 0.5 },
        { midi: 64, velocity: 0.8, start: 0, duration: 0.5 }
      ],
      duration: 1
    })
    expect(chord.renderMode).toBe('offline')
    expect(chord.metrics.pitch?.source ?? 'none').not.toBe('given')
    if (chord.metrics.pitch) {
      expect(chord.metrics.pitch.source).toBe('detected')
      expect(chord.metrics.pitch.confidence).toBeGreaterThanOrEqual(0)
      expect(chord.metrics.harmonics?.amplitudesDb ?? []).toHaveLength(12)
    } else {
      expect(chord.metrics.harmonics).toBeUndefined()
    }
    // Two pitches, so there is no single requested note to check a measured one against.
    expect(chord).not.toHaveProperty('pitchCheck')
    expect(chord.pitches).toEqual(['C4 (MIDI 60, 261.6 Hz)', 'E4 (MIDI 64, 329.6 Hz)'])

    // The single-pitch case is no longer the exception. It used to be told the
    // note it had asked for, which `resolvePitch` accepts as `source: "given"`,
    // `confidence: 1` without reading a sample — so `metrics.pitch` was the note
    // REQUESTED however far the patch moved the render off it, and
    // `compare_audio({autoRender: false})` scored a `centsError` of 0 against it.
    const single = await execute('render_audio', {
      notes: [{ midi: 60, velocity: 0.8, start: 0, duration: 0.5 }],
      duration: 1
    })
    expect(single.metrics.pitch).toMatchObject({ source: 'detected', midi: 60 })
    expect(single.metrics.pitch.f0Hz).toBeCloseTo(261.6, 0)
    expect(single.metrics.harmonics?.amplitudesDb).toHaveLength(12)
    expect(single.metricNotes.pitch).toMatch(/given.*detected/)
    // The interpretation, echoed back: reading "D2 (MIDI 38, 73.4 Hz)" after
    // asking for a 37 Hz reference is what makes an octave slip visible.
    expect(single.pitches).toEqual(['C4 (MIDI 60, 261.6 Hz)'])
    expect(single.pitchCheck.requested).toBe('C4 (MIDI 60, 261.6 Hz)')
    expect(single.pitchCheck.measured.note).toBe('C4 (MIDI 60, 261.6 Hz)')
    expect(Math.abs(single.pitchCheck.centsFromRequested)).toBeLessThan(10)
    expect(single.pitchCheck.note).toMatch(/sounds at the note requested/)
  })

  it('accepts a note name instead of a MIDI number and echoes back what it resolved to', async () => {
    const { execute, renderOffline } = offlineSetup()
    // The motivating session: a 37 Hz reference, correctly called "D1", rendered
    // as `midi: 38` — which is D2 at 73.4 Hz. The conversion step was the bug, so
    // it is gone from the caller, and the interpretation is read back in the same
    // turn the mistake is made.
    const named = await execute('render_audio', {
      notes: [{ note: 'D1', velocity: 0.8, start: 0, duration: 0.2 }],
      duration: 0.4
    })
    expect(renderOffline.mock.calls[0][1]).toEqual([{ midi: 26, velocity: 0.8, start: 0, duration: 0.2 }])
    expect(named.pitches).toEqual(['D1 (MIDI 26, 36.7 Hz)'])
    expect(named.pitchCheck.requested).toBe('D1 (MIDI 26, 36.7 Hz)')

    // Flats and lowercase resolve to the same pitch the sharp spelling does, and
    // `play_notes` echoes the interpretation the same way `render_audio` does.
    const live = setup()
    for (const note of ['A#1', 'Bb1', 'a#1']) {
      const result = await live.execute('play_notes', { notes: [{ note, velocity: 1, start: 0, duration: 0.005 }] })
      expect(result.pitches, note).toEqual(['A#1 (MIDI 34, 58.3 Hz)'])
    }

    // Exactly one spelling per note, and the errors say which rule was broken.
    await expect(execute('render_audio', { notes: [{ note: 'D1', midi: 26, velocity: 1, start: 0, duration: 0.1 }] }))
      .rejects.toThrow(/notes\[0\] has both 'midi' and 'note'/)
    await expect(execute('render_audio', { notes: [{ velocity: 1, start: 0, duration: 0.1 }] }))
      .rejects.toThrow(/notes\[0\] needs a pitch/)
    // The parse errors come from note-input.ts and are not reimplemented here.
    await expect(execute('render_audio', { notes: [{ note: 'C', velocity: 1, start: 0, duration: 0.1 }] }))
      .rejects.toThrow(/notes\[0\]\.note:.*has no octave/)
    await expect(execute('render_audio', { notes: [{ note: 'H4', velocity: 1, start: 0, duration: 0.1 }] }))
      .rejects.toThrow(/notes\[0\]\.note:.*Accepted forms/)
    await expect(execute('render_audio', { notes: [{ note: 'A9', velocity: 1, start: 0, duration: 0.1 }] }))
      .rejects.toThrow(/notes\[0\]\.note:.*out of range/)

    // And the schema advertises the alternative, so an agent reading only the
    // listing learns names are accepted at all.
    const schema = (await Promise.resolve(offlineSetup().byName.get('render_audio')!.inputSchema)) as any
    expect(schema.properties.notes.items.properties.note.type).toBe('string')
    expect(schema.properties.notes.items.required).toEqual(['velocity', 'start', 'duration'])
    expect(schema.properties.notes.items.oneOf).toEqual([{ required: ['midi'] }, { required: ['note'] }])
  })

  it('measures a transposed render at the pitch it actually sounds, not the note requested', async () => {
    // `osc1.transpose` is the cheapest way to make the note asked for and the
    // frequency produced two different numbers. Stating the requested f0 to the
    // analyzer reported `source: "given"`, `confidence: 1` on a frequency the
    // render did not contain — and `compare_audio({autoRender: false})` then
    // scored that render as perfectly in tune.
    const engine = new FakeEngine()
    engine.running = false
    const renderOffline = vi.fn(async (target: unknown, notes: readonly { midi: number }[], duration: number): Promise<RecordedAudio> => {
      const length = Math.max(64, Math.round(duration * 8000))
      const transpose = normToValue(paramDef('osc1.transpose'), (target as FakeEngine).values[paramIndex('osc1.transpose')])
      const f0 = 440 * Math.pow(2, ((notes[0]?.midi ?? 69) + transpose - 69) / 12)
      const channel = Float32Array.from({ length }, (_, index) => {
        const t = index / 8000
        return 0.5 * Math.exp(-2 * t) * Math.sin(2 * Math.PI * f0 * t)
      })
      const channelData = [channel, channel.slice()]
      return { blob: new Blob([encodeWav(channelData, 8000)], { type: 'audio/wav' }), mimeType: 'audio/wav', duration, sampleRate: 8000, channelData }
    })
    const tools = createWebMcpTools(engine as unknown as SynthEngine, undefined, { renderOffline })
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    const execute = async (name: string, input: Record<string, unknown> = {}) =>
      await byName.get(name)!.execute(input, { signal: new AbortController().signal }) as any

    await execute('update_parameters', { updates: [{ id: 'osc1.transpose', value: 12 }] })
    const result = await execute('render_audio', { notes: [{ note: 'C4', velocity: 1, start: 0, duration: 0.5 }], duration: 1 })

    expect(result.pitchCheck.requested).toBe('C4 (MIDI 60, 261.6 Hz)')
    expect(result.pitchCheck.measured.source).toBe('detected')
    expect(result.pitchCheck.measured.f0Hz).toBeCloseTo(523.25, -1)
    expect(result.pitchCheck.centsFromRequested).toBeGreaterThan(1150)
    expect(result.pitchCheck.centsFromRequested).toBeLessThan(1250)
    expect(result.pitchCheck.note).toMatch(/above C4 \(MIDI 60, 261\.6 Hz\)/)
    expect(result.pitchCheck.note).toMatch(/describes what was rendered, not what was requested/)
    // The metrics agree with the check: nothing here reports the requested note.
    expect(result.metrics.pitch.midi).toBe(72)
    expect(result.metrics.pitch.source).toBe('detected')
  })

  it('returns a blob URL or an inline mono WAV on request', async () => {
    const { execute } = offlineSetup()
    const input = { notes: [{ midi: 60, velocity: 0.8, start: 0, duration: 0.5 }], duration: 1 }
    const url = await execute('render_audio', { ...input, format: 'url' })
    expect(url.url).toMatch(/^blob:/)
    expect(url).not.toHaveProperty('audio')

    const base64 = await execute('render_audio', { ...input, format: 'base64' })
    expect(base64.audio).toMatchObject({ mimeType: 'audio/wav', channels: 1, sampleRate: 22050, truncated: false })
    expect(base64.audio.duration).toBeCloseTo(1, 2)
    expect(atob(base64.audio.base64).slice(0, 4)).toBe('RIFF')
    expect(base64).not.toHaveProperty('url')
  })

  it('renders far faster than real time — a 15-second render returns without waiting 15 seconds', async () => {
    // An honest, weak claim: jsdom has no real OfflineAudioContext, so this can
    // only show the offline path never runs a wall-clock capture. The plan's
    // "< 25 % of the requested duration" belongs in a browser benchmark.
    const { execute } = offlineSetup()
    const started = Date.now()
    const result = await execute('render_audio', {
      notes: [{ midi: 60, velocity: 0.8, start: 0, duration: 14 }], duration: 15
    })
    expect(result.renderMode).toBe('offline')
    expect(Date.now() - started).toBeLessThan(15000 * 0.25)
  })

  it('falls back to real time, and says so, when offline rendering is unavailable', async () => {
    vi.useFakeTimers()
    const { engine, execute } = setup()
    const rendering = execute('render_audio', {
      notes: [{ midi: 60, velocity: 1, start: 0, duration: 0.05 }], duration: 0.1, mode: 'offline'
    })
    await vi.advanceTimersByTimeAsync(200)
    const result = await rendering
    expect(result.renderMode).toBe('realtime')
    expect(result.renderModeFallback).toMatch(/offline rendering is unavailable/i)
    expect(engine.recordOutput).toHaveBeenCalled()
  })

  it('reports the missing gesture and the missing offline path separately', async () => {
    // Offline works here, so real time is the only thing the gesture blocks.
    const stopped = offlineSetup()
    await expect(stopped.execute('render_audio', {
      notes: [{ midi: 60, velocity: 1, start: 0, duration: 1 }], mode: 'realtime'
    })).rejects.toThrow(/mode: "offline"/)

    // No offline renderer: every failing path must say so instead of pointing
    // the agent at the one mode this browser cannot run.
    const noOffline = setup(); noOffline.engine.running = false
    const notes = [{ midi: 60, velocity: 1, start: 0, duration: 1 }]
    for (const mode of ['offline', 'realtime', undefined]) {
      await expect(noOffline.execute('render_audio', { notes, ...(mode === undefined ? {} : { mode }) }))
        .rejects.toThrow(/offline rendering is unavailable/i)
    }
  })

  it('still renders in real time when the agent asks for it', async () => {
    vi.useFakeTimers()
    const renderOffline = offlineRenderer()
    const engine = new FakeEngine()
    const tools = createWebMcpTools(engine as unknown as SynthEngine, undefined, { renderOffline })
    const render = tools.find(tool => tool.name === 'render_audio')!
    const rendering = render.execute({
      notes: [{ midi: 60, velocity: 1, start: 0, duration: 0.05 }], duration: 0.1, mode: 'realtime'
    }, { signal: new AbortController().signal }) as Promise<any>
    await vi.advanceTimersByTimeAsync(200)
    expect(await rendering).toMatchObject({ renderMode: 'realtime', mimeType: 'audio/webm' })
    expect(renderOffline).not.toHaveBeenCalled()
    expect(engine.recordOutput).toHaveBeenCalled()
  })

  it('rejects unknown mode and format values', async () => {
    const { execute } = offlineSetup()
    const notes = [{ midi: 60, velocity: 1, start: 0, duration: 0.1 }]
    await expect(execute('render_audio', { notes, mode: 'fast' })).rejects.toThrow(/mode must be one of offline, realtime/)
    await expect(execute('render_audio', { notes, format: 'wav' })).rejects.toThrow(/format must be one of metrics, url, base64/)
  })
})

describe('preset tools', () => {
  it('saves/replaces a named patch and loads it with compact confirmation', async () => {
    const { engine, execute } = setup()
    engine.toPreset.mockImplementation((name: string): PresetData => ({
      name, version: 1, params: { 'master.volume': engine.values[paramIndex('master.volume')] }, mods: [],
      lfoShapes: engine.lfoShapes.map(shape => shape.map(point => ({ ...point }))), fxOrder: [...FX_IDS]
    }))
    const saved = await execute('save_preset', { name: 'Agent Patch' })
    // "Which folder did you save it to?" took several tool calls to answer in
    // the motivating session, because the honest answer is "none".
    expect(saved).toMatchObject({ name: 'Agent Patch', saved: true, storage: 'localStorage' })
    expect(saved.where).toMatch(/localStorage/)
    expect(saved.where).toMatch(/"User"/)
    expect(saved.where).toMatch(/no folder|not to a file/)
    engine.values[paramIndex('master.volume')] = 0.25
    await execute('save_preset', { name: 'Agent Patch' })
    engine.values[paramIndex('master.volume')] = 0.9
    const loaded = await execute('load_preset', { name: 'Agent Patch' })
    expect(engine.loadPreset).toHaveBeenCalledTimes(1)
    expect(loaded).toEqual({ name: 'Agent Patch', loaded: true, source: 'user' })
    const state = await execute('get_synth_state', { search: 'master.volume' })
    expect(state.patch.parameters.items['master.volume'].normalized).toBeCloseTo(0.25)
    await expect(execute('load_preset', { name: 'Missing' })).rejects.toThrow(/not found/i)
    await expect(execute('save_preset', { name: ' ' })).rejects.toThrow(/preset name/i)
  })

  it('returns useful save/load errors when browser storage is unavailable', async () => {
    const { engine, execute } = setup()
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('blocked', 'SecurityError') }
    })
    await expect(execute('save_preset', { name: 'Blocked' })).rejects.toThrow(/storage.*unavailable/i)
    await expect(execute('load_preset', { name: 'Blocked' })).rejects.toThrow(/storage.*unavailable/i)
    expect(engine.loadPreset).not.toHaveBeenCalled()
    // A factory patch is compiled into the page and needs no storage, so an
    // unreadable localStorage must not make it unloadable.
    const factory = await execute('load_preset', { name: 'Deep Saw Bass' })
    expect(factory).toMatchObject({ name: 'Deep Saw Bass', loaded: true, source: 'factory' })
    expect(factory.note).toMatch(/could not be read/)
    expect(engine.loadPreset).toHaveBeenCalledTimes(1)
  })

  it('loads factory presets, prefers the user preset on a collision, and takes source: "factory" to override', async () => {
    const { engine, execute } = setup()
    // Factory presets were invisible to the tools: `load_preset` read
    // localStorage only, so every one of the 35 patches the dropdown lists was
    // unreachable and an agent had to read the DOM to learn a single name.
    const loaded = await execute('load_preset', { name: 'Deep Saw Bass' })
    expect(loaded).toEqual({ name: 'Deep Saw Bass', loaded: true, source: 'factory' })
    const [preset, origin] = engine.loadPreset.mock.calls[0]
    expect(origin).toBe('ai')
    // `getFactoryPreset` returns a complete, already-validated preset.
    expect(preset).toMatchObject({ name: 'Deep Saw Bass', version: 2, fxOrder: [...FX_IDS] })
    expect(preset.mods).toEqual([{ source: 'env2', dest: 'filter1.cutoff', depth: 0.45, enabled: true }])
    expect(preset.lfoShapes).toHaveLength(8)

    // A user preset wins the name: save_preset then load_preset must return the
    // patch just saved, and a factory preset can never be lost by being shadowed.
    engine.toPreset.mockImplementation((name: string): PresetData => ({
      name, version: 1, params: { 'master.volume': 0.125 }, mods: [],
      lfoShapes: engine.lfoShapes.map(shape => shape.map(point => ({ ...point }))), fxOrder: [...FX_IDS]
    }))
    await execute('save_preset', { name: 'Deep Saw Bass' })
    const shadowing = await execute('load_preset', { name: 'Deep Saw Bass' })
    expect(shadowing).toMatchObject({ source: 'user', shadowedFactoryPreset: true })
    expect(shadowing.note).toMatch(/{"source":"factory"}/)
    expect(engine.loadPreset.mock.calls[1][0].params).toEqual({ 'master.volume': 0.125 })

    // ...and the built-in one is still reachable by name.
    const explicit = await execute('load_preset', { name: 'Deep Saw Bass', source: 'factory' })
    expect(explicit).toMatchObject({ source: 'factory', shadowedFactoryPreset: true })
    expect(engine.loadPreset.mock.calls[2][0].mods).toHaveLength(1)

    // `source: "user"` never falls through to a factory patch of the same name.
    await expect(execute('load_preset', { name: 'Init', source: 'user' }))
      .rejects.toThrow(/among this browser's user presets: Init/)
    await expect(execute('load_preset', { name: 'Deep Saw Bas', source: 'factory' }))
      .rejects.toThrow(/among the factory presets.*Did you mean Deep Saw Bass\?/s)
    await expect(execute('load_preset', { name: 'Nothing At All' }))
      .rejects.toThrow(/in either the factory presets or this browser's user presets/)
    await expect(execute('load_preset', { name: 'Init', source: 'both' })).rejects.toThrow(/source must be one of/)
  })

  /** A preset that carries one real parameter, which `loadPreset` on the fake engine applies back. */
  function volumePreset(engine: FakeEngine) {
    return (name: string): PresetData => ({
      name, version: 2, params: { 'master.volume': engine.values[paramIndex('master.volume')] }, mods: [],
      lfoShapes: engine.lfoShapes.map(shape => shape.map(point => ({ ...point }))), fxOrder: [...FX_IDS]
    })
  }

  it('answers "is there unsaved work here" in get_synth_state, in both formats', async () => {
    const { engine, execute } = setup()
    engine.toPreset.mockImplementation(volumePreset(engine))

    // Nothing loaded: no name, and `dirty` is false because there is nothing to
    // differ from. Reporting an unattributed patch as modified would be true of
    // every fresh page and therefore useless.
    expect((await execute('get_synth_state')).patch.preset).toEqual({ name: null, source: null, dirty: false })

    await execute('save_preset', { name: 'Bench' })
    expect((await execute('get_synth_state')).patch.preset).toEqual({ name: 'Bench', source: 'user', dirty: false })

    await execute('update_parameters', { updates: [{ id: 'master.volume', value: 0.5 }] })
    expect((await execute('get_synth_state')).patch.preset).toEqual({ name: 'Bench', source: 'user', dirty: true })

    // A real round trip: the fake engine applies `master.volume` back out of the
    // stored preset, so this is the value returning, not the flag being reset.
    await execute('load_preset', { name: 'Bench' })
    expect((await execute('get_synth_state')).patch.preset).toEqual({ name: 'Bench', source: 'user', dirty: false })
    expect(normToValue(paramDef('master.volume'), engine.values[paramIndex('master.volume')])).toBeCloseTo(0.7)

    // A factory load is attributed to the factory space, and is clean on arrival:
    // the reference is read back out of the ENGINE, not off the file, so the
    // parameters a factory preset omits do not read as edits.
    await execute('load_preset', { name: 'Deep Saw Bass' })
    const factory = { name: 'Deep Saw Bass', source: 'factory', dirty: false }
    expect((await execute('get_synth_state')).patch.preset).toEqual(factory)
    // Compact is the format an agent verifying a patch actually calls, so the
    // answer has to be there too - and it is three short fields, not a page.
    expect((await execute('get_synth_state', { format: 'compact' })).patch.preset).toEqual(factory)
  })

  it('deletes a user preset, refuses a factory name, and says which space it searched', async () => {
    const { engine, execute } = setup()
    engine.toPreset.mockImplementation(volumePreset(engine))
    await execute('save_preset', { name: 'Scratch' })

    const deleted = await execute('delete_preset', { name: 'Scratch' })
    expect(deleted).toMatchObject({ name: 'Scratch', deleted: true, storage: 'localStorage', detachedCurrentPatch: true })
    expect(deleted.note).toMatch(/patch loaded in the synth is untouched/)
    expect(deleted.note).toMatch(/no longer attributed to one/)
    expect((await execute('list_presets')).user).toBe(0)
    // The patch on screen is untouched by a delete, but it is no longer a copy of
    // anything that exists, so it stops being attributed to the deleted preset.
    expect((await execute('get_synth_state')).patch.preset).toEqual({ name: null, source: null, dirty: false })

    // A factory preset is compiled into the page; deleting it is not a thing that
    // can be done, and the refusal says why rather than reporting "not found".
    await expect(execute('delete_preset', { name: 'Deep Saw Bass' }))
      .rejects.toThrow(/factory preset.*cannot be deleted/)
    expect((await execute('load_preset', { name: 'Deep Saw Bass' })).loaded).toBe(true)

    // An unknown name searched the user space, which is the only space a delete
    // can touch, and the message says so instead of leaving it to list_presets.
    await expect(execute('delete_preset', { name: 'Never Saved' }))
      .rejects.toThrow(/among this browser's user presets: Never Saved/)
    await expect(execute('delete_preset', { name: ' ' })).rejects.toThrow(/preset name/i)
  })

  it('deletes a user preset that shadows a factory name and hands the built-in one back', async () => {
    const { engine, execute } = setup()
    engine.toPreset.mockImplementation((name: string): PresetData => ({
      name, version: 2, params: { 'master.volume': 0.125 }, mods: [],
      lfoShapes: engine.lfoShapes.map(shape => shape.map(point => ({ ...point }))), fxOrder: [...FX_IDS]
    }))
    await execute('save_preset', { name: 'Deep Saw Bass' })
    expect((await execute('load_preset', { name: 'Deep Saw Bass' })).source).toBe('user')

    // Deliberate work saved under a factory name is still the only copy of it, so
    // it IS deletable - and what comes back is the built-in patch, which is the
    // only outcome a human would expect.
    const deleted = await execute('delete_preset', { name: 'Deep Saw Bass' })
    expect(deleted).toMatchObject({ name: 'Deep Saw Bass', deleted: true, factoryPresetRestored: true })
    expect(deleted.note).toMatch(/returns the built-in patch again/)
    expect(listPresets()).toEqual([])

    const restored = await execute('load_preset', { name: 'Deep Saw Bass' })
    expect(restored).toEqual({ name: 'Deep Saw Bass', loaded: true, source: 'factory' })
    expect(engine.loadPreset.mock.lastCall![0].mods).toEqual([
      { source: 'env2', dest: 'filter1.cutoff', depth: 0.45, enabled: true }
    ])
  })

  it('exports factory, user and live patches as JSON an import takes back', async () => {
    const { engine, execute } = setup()
    engine.toPreset.mockImplementation(volumePreset(engine))

    const factory = await execute('export_preset', { name: 'Deep Saw Bass' })
    expect(factory).toMatchObject({ name: 'Deep Saw Bass', source: 'factory', filename: 'deep-saw-bass.cosynth.json' })
    expect(factory.where).toMatch(/Nothing was written to disk/)
    // The round trip is the whole contract: what comes out has to go back in.
    const reimported = validatePresetData(JSON.parse(factory.json))
    expect(reimported).toEqual(getFactoryPreset('Deep Saw Bass'))
    expect(reimported.version).toBe(2)

    await execute('save_preset', { name: 'Mine' })
    const user = await execute('export_preset', { name: 'Mine' })
    expect(user).toMatchObject({ name: 'Mine', source: 'user', filename: 'mine.cosynth.json' })
    expect(validatePresetData(JSON.parse(user.json)).params['master.volume']).toBeCloseTo(engine.values[paramIndex('master.volume')])

    // No name at all is the live patch, named after whatever it came from.
    const live = await execute('export_preset')
    expect(live).toMatchObject({ name: 'Mine', source: 'live' })
    expect(live.note).toMatch(/still matches the user preset "Mine"/)
    await execute('update_parameters', { updates: [{ id: 'master.volume', value: 0.5 }] })
    const edited = await execute('export_preset')
    expect(edited.note).toMatch(/HAS been edited since/)
    expect(validatePresetData(JSON.parse(edited.json)).params['master.volume'])
      .toBeCloseTo(engine.values[paramIndex('master.volume')])

    // With nothing loaded the live patch still exports, under a name of its own.
    clearCurrentPreset()
    const unattributed = await execute('export_preset')
    expect(unattributed).toMatchObject({ name: 'coSynth Patch', filename: 'cosynth-patch.cosynth.json' })
    expect(unattributed.note).toMatch(/not a copy of any saved preset/)

    await expect(execute('export_preset', { name: 'Nope' })).rejects.toThrow(/in either the factory presets/)
    await expect(execute('export_preset', { source: 'user' })).rejects.toThrow(/needs a `name`/)
  })

  it('exports without announcing a load that never happened', async () => {
    const { engine, execute } = setup()
    engine.toPreset.mockImplementation(volumePreset(engine))
    await execute('save_preset', { name: 'Held' })
    await execute('update_parameters', { updates: [{ id: 'master.volume', value: 0.5 }] })
    const before = currentPresetState(engine as unknown as SynthEngine)
    expect(before).toEqual({ name: 'Held', source: 'user', dirty: true })

    // The trap this tool was written around: reading a stored preset through the
    // store's `loadPreset` notifies every preset-store listener, so an export
    // would jump the UI's dropdown to a patch nobody loaded and reattribute the
    // live patch to it. `listPresets` reads without announcing.
    await execute('export_preset', { name: 'Held' })
    await execute('export_preset', { name: 'Deep Saw Bass' })
    await execute('export_preset')
    expect(currentPresetState(engine as unknown as SynthEngine)).toEqual(before)
    expect(engine.loadPreset).not.toHaveBeenCalled()

    // A user preset wins the name here too, and says the built-in one was passed over.
    await execute('save_preset', { name: 'Init' })
    const shadowing = await execute('export_preset', { name: 'Init' })
    expect(shadowing).toMatchObject({ source: 'user', shadowedFactoryPreset: true })
    expect(JSON.parse(shadowing.json).params).toHaveProperty('master.volume')
    const builtIn = await execute('export_preset', { name: 'Init', source: 'factory' })
    expect(builtIn).toMatchObject({ source: 'factory' })
    expect(builtIn).not.toHaveProperty('shadowedFactoryPreset')
  })
})

describe('fx order tool', () => {
  it('reorders the chain as an agent change, and refuses anything that is not a permutation', async () => {
    const { engine, execute } = setup()
    const reversed = [...FX_IDS].reverse()
    const result = await execute('set_fx_order', { order: reversed })
    expect(result).toEqual({ fxOrder: reversed, previous: [...FX_IDS], changed: true })
    // Origin 'ai' is the whole point: `activity.ts` records the `{kind:'fx'}`
    // mutation as a pending change and Reject restores it with
    // `setFxOrder(change.before, 'restore')`. A 'human' origin would apply the
    // reorder and leave no way to undo it from the AI-changes panel.
    expect(engine.setFxOrder).toHaveBeenCalledWith(reversed.map(id => FX_IDS.indexOf(id as any)), 'ai')
    // Verifiable through the state tool, like every other patch edit.
    expect((await execute('get_synth_state')).patch.fxOrder).toEqual(reversed)
    expect((await execute('set_fx_order', { order: reversed })).changed).toBe(false)

    await expect(execute('set_fx_order', { order: [...FX_IDS].slice(1) }))
      .rejects.toThrow(`order must list all ${FX_IDS.length} effects exactly once (got ${FX_IDS.length - 1})`)
    await expect(execute('set_fx_order', { order: [...FX_IDS].slice(1).concat('reverb') }))
      .rejects.toThrow(/Duplicate effect 'reverb'/)
    await expect(execute('set_fx_order', { order: [...FX_IDS.slice(1), 'reverbs'] }))
      .rejects.toThrow(/Unknown effect 'reverbs'.*Did you mean reverb\?/)
    await expect(execute('set_fx_order', { order: 'reverb' })).rejects.toThrow(/order must be an array/)
    await expect(execute('set_fx_order', {})).rejects.toThrow(/order is required/)
    // The schema advertises the vocabulary, so the ids need no other lookup.
    const schema = setup().byName.get('set_fx_order')!.inputSchema as any
    expect(schema.properties.order.items.enum).toEqual([...FX_IDS])
    expect(schema.properties.order.minItems).toBe(FX_IDS.length)
  })
})

describe('apply_patch', () => {
  const RATE = 8000
  /** Tracks the requested note, so the audition's measured pitch is a real measurement. */
  function auditionRenderer() {
    return vi.fn(async (_engine: unknown, notes: readonly { midi: number }[], duration: number): Promise<RecordedAudio> => {
      const length = Math.max(64, Math.round(duration * RATE))
      const f0 = 440 * Math.pow(2, ((notes[0]?.midi ?? 69) - 69) / 12)
      const channel = Float32Array.from({ length }, (_, index) => {
        const t = index / RATE
        return 0.4 * Math.exp(-3 * t) * Math.sin(2 * Math.PI * f0 * t)
      })
      const channelData = [channel, channel.slice()]
      return { blob: new Blob([encodeWav(channelData, RATE)], { type: 'audio/wav' }), mimeType: 'audio/wav', duration, sampleRate: RATE, channelData }
    })
  }

  function patchSetup(dependencies: WebMcpToolDependencies = {}) {
    const engine = new FakeEngine()
    engine.running = false
    engine.toPreset.mockImplementation((name: string): PresetData => ({
      name, version: 1, params: { 'master.volume': engine.values[paramIndex('master.volume')] }, mods: [],
      lfoShapes: engine.lfoShapes.map(shape => shape.map(point => ({ ...point }))), fxOrder: [...FX_IDS]
    }))
    const renderOffline = auditionRenderer()
    const tools = createWebMcpTools(engine as unknown as SynthEngine, undefined, { renderOffline, ...dependencies })
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    const execute = async (name: string, input: Record<string, unknown> = {}) =>
      await byName.get(name)!.execute(input, { signal: new AbortController().signal }) as any
    return { engine, byName, execute, renderOffline }
  }

  it('applies parameters, modulation and FX order as one change, then saves and auditions it', async () => {
    // The motivating session needed separate calls for parameters, clearing
    // modulation, five routes, a save, a render and a play. This is that in one.
    const { engine, execute } = patchSetup({ currentSoundEntryId: () => 'sound-7' })
    engine.modSlots[3] = { source: modSourceIndex('lfo2'), dest: paramIndex('osc1.morph'), depth: 0.1, enabled: true }
    const reversed = [...FX_IDS].reverse()

    const result = await execute('apply_patch', {
      parameters: [{ id: 'filter1.cutoff', value: 900 }, { id: 'filter1.type', value: 'LP 24' }],
      modulations: {
        replace: true,
        routes: [
          { source: 'env2', destination: 'filter1.cutoff', depth: 0.45 },
          { source: 'lfo1', destination: 'osc1.morph', depth: 0.3, enabled: false }
        ]
      },
      fxOrder: reversed,
      presetName: 'One Call Bass',
      auditionNotes: [{ note: 'C2', velocity: 0.9, start: 0, duration: 0.4 }]
    })

    expect(result.applied.parameters).toEqual([
      { id: 'filter1.cutoff', raw: 900, normalized: expect.any(Number), formatted: '900.0 Hz' },
      { id: 'filter1.type', raw: 1, normalized: expect.any(Number), formatted: 'LP 24' }
    ])
    expect(result.applied.modulations).toMatchObject({ cleared: 1, total: 2 })
    expect(result.applied.modulations.routes).toEqual([
      { slot: 0, source: 'env2', destination: 'filter1.cutoff', depth: 0.45, enabled: true },
      { slot: 1, source: 'lfo1', destination: 'osc1.morph', depth: 0.3, enabled: false }
    ])
    expect(result.applied.fxOrder).toEqual(reversed)
    expect(engine.modSlots[3]).toBeNull()
    expect(result.preset).toMatchObject({ name: 'One Call Bass', saved: true, storage: 'localStorage' })
    expect((await execute('list_presets')).presets).toContainEqual({ name: 'One Call Bass', source: 'user' })

    // Rendered, not played: playing needs a Start gesture and this engine has none.
    expect(engine.running).toBe(false)
    expect(result.audition).toMatchObject({ rendered: true, renderMode: 'offline' })
    expect(result.audition.pitches).toEqual(['C2 (MIDI 36, 65.4 Hz)'])
    expect(result.audition.pitchCheck.measured.source).toBe('detected')
    expect(result.audition.metrics.pitch.midi).toBe(36)
    expect(result.audition.metricNotes.peakDb).toContain('instantaneous peak')

    // One batched sound change, so the whole call is one undoable version.
    expect(engine.batchSoundChange).toHaveBeenCalledTimes(1)
    expect(engine.batchSoundChange.mock.calls[0][0]).toBe('Apply patch')
    expect(result.rollbackId).toBe('sound-7')
    expect(result.rollback).toMatch(/navigate_history\({"action":"restore","entryId":"sound-7"/)
    expect(result.rollback).toMatch(/get_history/)
  })

  it('says so honestly when no sound history is wired up', async () => {
    const { execute } = patchSetup()
    const result = await execute('apply_patch', { parameters: [{ id: 'filter1.cutoff', value: 900 }] })
    expect(result).not.toHaveProperty('rollbackId')
    expect(result.rollback).toMatch(/no rollback id/)
    expect(result.rollback).toMatch(/Reject/)
  })

  it('validates everything before applying anything', async () => {
    const { engine, execute } = patchSetup()
    // A bad id late in the batch must not leave the good ones applied — the
    // property `update_parameters` already had, extended across the whole patch.
    await expect(execute('apply_patch', {
      parameters: [{ id: 'filter1.cutoff', value: 900 }, { id: 'filter1.cutof', value: 1 }]
    })).rejects.toThrow(/Unknown parameter 'filter1.cutof'/)
    await expect(execute('apply_patch', {
      parameters: [{ id: 'filter1.cutoff', value: 900 }],
      modulations: { routes: [{ source: 'lfo1', destination: 'filter1.nope', depth: 0.4 }] }
    })).rejects.toThrow(/Unknown modulation destination 'filter1.nope'/)
    await expect(execute('apply_patch', {
      parameters: [{ id: 'filter1.cutoff', value: 900 }],
      fxOrder: [...FX_IDS].slice(1)
    })).rejects.toThrow(/fxOrder must list all/)
    await expect(execute('apply_patch', {
      parameters: [{ id: 'filter1.cutoff', value: 900 }], presetName: ' '
    })).rejects.toThrow(/preset name/i)
    await expect(execute('apply_patch', {
      parameters: [{ id: 'filter1.cutoff', value: 900 }],
      auditionNotes: [{ note: 'C', velocity: 1, start: 0, duration: 0.2 }]
    })).rejects.toThrow(/auditionNotes\[0\]\.note:.*has no octave/)
    expect(engine.setParam).not.toHaveBeenCalled()
    expect(engine.setModSlot).not.toHaveBeenCalled()
    expect(engine.setFxOrder).not.toHaveBeenCalled()

    // A full matrix is found on the plan, not on the route that overflows:
    // `set_modulation` can only discover it after the earlier routes landed.
    const full = patchSetup()
    for (let slot = 0; slot < MAX_MOD_SLOTS; slot++) {
      full.engine.modSlots[slot] = { source: modSourceIndex('lfo1'), dest: paramIndex('osc1.morph') + slot, depth: 0.1, enabled: true }
    }
    await expect(full.execute('apply_patch', {
      parameters: [{ id: 'filter1.cutoff', value: 900 }],
      modulations: { routes: [{ source: 'env2', destination: 'filter1.cutoff', depth: 0.4 }] }
    })).rejects.toThrow(/Modulation matrix is full.*Nothing was applied/s)
    expect(full.engine.setParam).not.toHaveBeenCalled()

    await expect(execute('apply_patch', { presetName: 'Nothing To Apply' }))
      .rejects.toThrow(/at least one of parameters, modulations or fxOrder/)
    await expect(execute('apply_patch', { modulations: {} }))
      .rejects.toThrow(/modulations needs `routes`, or `replace: true`/)
  })

  it('reports what a dry run would change and touches nothing', async () => {
    const { engine, execute } = patchSetup()
    const result = await execute('apply_patch', {
      parameters: [{ id: 'filter1.cutoff', value: 900 }],
      fxOrder: [...FX_IDS].reverse(),
      presetName: 'Not Saved',
      auditionNotes: [{ note: 'C2', velocity: 1, start: 0, duration: 0.2 }],
      dryRun: true
    })
    expect(result).toMatchObject({ dryRun: true, applied: false })
    expect(result.wouldApply.parameters[0]).toMatchObject({ id: 'filter1.cutoff', formatted: '900.0 Hz', willChange: true })
    expect(result.wouldApply.parameters[0].from).toBe('8.00 kHz')
    expect(result.wouldApply.fxOrder).toEqual({ from: [...FX_IDS], to: [...FX_IDS].reverse() })
    expect(result.wouldApply.presetName).toBe('Not Saved')
    expect(result.wouldApply.audition.pitches).toEqual(['C2 (MIDI 36, 65.4 Hz)'])
    expect(engine.setParam).not.toHaveBeenCalled()
    expect(engine.setFxOrder).not.toHaveBeenCalled()
    expect((await execute('list_presets')).user).toBe(0)
  })

  it('rolls the whole patch back when a write fails part-way through', async () => {
    const { engine, execute } = patchSetup()
    const cutoff = paramIndex('filter1.cutoff')
    const before = engine.values[cutoff]
    let writes = 0
    engine.setModSlot.mockImplementation((slot: number, state: ModSlotState | null) => {
      // Fail on the second route, after the parameters have already landed.
      if (++writes === 2) throw new Error('worklet post failed')
      engine.modSlots[slot] = state
    })
    await expect(execute('apply_patch', {
      parameters: [{ id: 'filter1.cutoff', value: 900 }],
      modulations: {
        routes: [
          { source: 'env2', destination: 'filter1.cutoff', depth: 0.4 },
          { source: 'lfo1', destination: 'osc1.morph', depth: 0.3 }
        ]
      }
    })).rejects.toThrow(/apply_patch applied nothing: worklet post failed.*rolled back/s)
    // Both halves are back: the parameter that landed and the route that landed.
    expect(engine.values[cutoff]).toBe(before)
    expect(engine.modSlots.filter(Boolean)).toEqual([])
    // The revert used the same 'ai' origin the writes used, so the agent-change
    // ledger nets to zero instead of leaving a half-patch to Keep or Reject.
    expect(engine.setParam.mock.calls.map(call => call[2] ?? call[1])).not.toContain('restore')
    expect(engine.setParam).toHaveBeenLastCalledWith(cutoff, before, 'ai')
  })

  it('keeps a good patch when only the save or the audition fails', async () => {
    const { engine, execute } = patchSetup()
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('blocked', 'SecurityError') }
    })
    const saved = await execute('apply_patch', {
      parameters: [{ id: 'filter1.cutoff', value: 900 }], presetName: 'Blocked'
    })
    // Reverting a good patch because storage is full would be the wrong trade,
    // and swallowing the failure would be worse. Applied, and said out loud.
    expect(saved.applied.parameters).toHaveLength(1)
    expect(saved.preset).toMatchObject({ name: 'Blocked', saved: false })
    expect(saved.preset.error).toMatch(/storage/i)
    expect(saved.preset.note).toMatch(/patch IS applied/)
    expect(engine.setParam).toHaveBeenCalledTimes(1)

    const failing = patchSetup()
    failing.renderOffline.mockRejectedValue(new Error('offline context refused'))
    const audition = await failing.execute('apply_patch', {
      parameters: [{ id: 'filter1.cutoff', value: 900 }],
      auditionNotes: [{ note: 'C2', velocity: 1, start: 0, duration: 0.2 }]
    })
    expect(audition.applied.parameters).toHaveLength(1)
    expect(audition.audition).toMatchObject({ rendered: false })
    expect(audition.audition.error).toMatch(/offline context refused/)
    expect(failing.engine.setParam).toHaveBeenCalledTimes(1)
  })

  it('adds and updates routes without clearing when replace is omitted', async () => {
    const { engine, execute } = patchSetup()
    engine.modSlots[2] = { source: modSourceIndex('env2'), dest: paramIndex('filter1.cutoff'), depth: 0.1, enabled: false }
    const result = await execute('apply_patch', {
      parameters: [{ id: 'filter1.cutoff', value: 900 }],
      modulations: {
        routes: [
          // Same pair as slot 2: updated in place, keeping `enabled` where it is,
          // exactly as set_modulation's `add` resolves it.
          { source: 'env2', destination: 'filter1.cutoff', depth: 0.6 },
          { source: 'lfo1', destination: 'osc1.morph', depth: 0.3 }
        ]
      }
    })
    expect(result.applied.modulations.cleared).toBe(0)
    expect(result.applied.modulations.routes).toEqual([
      { slot: 2, source: 'env2', destination: 'filter1.cutoff', depth: 0.6, enabled: false },
      { slot: 0, source: 'lfo1', destination: 'osc1.morph', depth: 0.3, enabled: true }
    ])
    // `replace: true` with no routes is how the matrix is emptied.
    const cleared = await execute('apply_patch', { modulations: { replace: true } })
    expect(cleared.applied.modulations).toMatchObject({ cleared: 2, total: 0 })
    expect(engine.modSlots.filter(Boolean)).toEqual([])
  })
})

/**
 * The failure this whole change exists to fix. An agent matching a reference
 * sound got a similarity score with no gradient and could not see the
 * reference's harmonic content at all, because `analyze_reference_audio` never
 * passed an `f0Hz` and the analyzer therefore skipped harmonics. It gave up on
 * the tools and wrote Python.
 */
describe('matching a reference: harmonics on both sides, a gradient, and advice', () => {
  const RATE = 8000
  const REFERENCE_HZ = 220
  /** A3. The pitch the reference's own detection should land on. */
  const REFERENCE_MIDI = 57

  /** A decaying tone with real partials, so pitch detection and harmonics both have something to find. */
  function pitchedReference(seconds = 0.5): DecodedBase64Audio {
    const length = Math.round(seconds * RATE)
    const channel = Float32Array.from({ length }, (_, index) => {
      const t = index / RATE
      let value = 0
      for (let partial = 1; partial <= 6; partial++) {
        value += Math.sin(2 * Math.PI * REFERENCE_HZ * partial * t) / partial
      }
      return 0.45 * Math.exp(-2 * t) * value
    })
    return {
      decodedBytes: length * 4,
      duration: length / RATE,
      sampleRate: RATE,
      channels: 1,
      channelData: [channel],
      mimeType: 'audio/wav'
    }
  }

  const wav = (channelData: Float32Array[], duration: number): RecordedAudio => ({
    blob: new Blob([encodeWav(channelData, RATE)], { type: 'audio/wav' }),
    mimeType: 'audio/wav', duration, sampleRate: RATE, channelData
  })

  /**
   * A synth-side renderer that tracks the requested MIDI note AND the patch's
   * `osc1.transpose`, exactly as the real one does. The transpose is what makes the
   * candidate's pitch a thing to be measured rather than assumed: the note asked for
   * and the frequency produced are two different numbers the moment it is non-zero.
   */
  function renderer() {
    return vi.fn(async (engine: unknown, notes: readonly { midi: number }[], duration: number): Promise<RecordedAudio> => {
      const length = Math.max(64, Math.round(duration * RATE))
      // `engine.values` holds NORMALIZED values, as `update_parameters` writes them.
      const transpose = normToValue(paramDef('osc1.transpose'), (engine as FakeEngine).values[paramIndex('osc1.transpose')])
      const f0 = 440 * Math.pow(2, ((notes[0]?.midi ?? 69) + transpose - 69) / 12)
      const channel = Float32Array.from({ length }, (_, index) => {
        const t = index / RATE
        // Two partials only: darker than the reference's six, so the diff has a
        // real gradient for the advice to rank.
        return 0.3 * Math.exp(-4 * t) * (Math.sin(2 * Math.PI * f0 * t) + 0.2 * Math.sin(4 * Math.PI * f0 * t))
      })
      return wav([channel, channel.slice()], duration)
    })
  }

  /**
   * A patch that SUSTAINS while the note is held and releases after note-off —
   * the ordinary case, and the one the auto-render used to make unmeasurable by
   * holding the note to the last sample of the buffer.
   */
  function sustainingRenderer() {
    return vi.fn(async (_engine: unknown, notes: readonly { midi: number }[], duration: number): Promise<RecordedAudio> => {
      const length = Math.max(64, Math.round(duration * RATE))
      const note = notes[0] as { midi: number; start?: number; duration?: number } | undefined
      const f0 = 440 * Math.pow(2, ((note?.midi ?? 69) - 69) / 12)
      const noteOff = (note?.start ?? 0) + (note?.duration ?? duration)
      const channel = Float32Array.from({ length }, (_, index) => {
        const t = index / RATE
        // Flat while held, then a 50 ms release constant.
        const level = t <= noteOff ? 1 : Math.exp(-(t - noteOff) / 0.05)
        return 0.4 * level * (Math.sin(2 * Math.PI * f0 * t) + 0.2 * Math.sin(4 * Math.PI * f0 * t))
      })
      return wav([channel, channel.slice()], duration)
    })
  }

  /**
   * A renderer with no fundamental to find: deterministic white noise, which both
   * detectors disagree about and the YIN veto therefore rejects outright.
   */
  function noiseRenderer() {
    return vi.fn(async (_engine: unknown, _notes: readonly { midi: number }[], duration: number): Promise<RecordedAudio> => {
      const length = Math.max(64, Math.round(duration * RATE))
      let seed = 12345
      const channel = Float32Array.from({ length }, () => {
        seed = (seed * 1103515245 + 12345) % 2147483648
        return 0.3 * (seed / 1073741824 - 1)
      })
      return wav([channel, channel.slice()], duration)
    })
  }

  function matchSetup(
    decoded: () => DecodedBase64Audio = pitchedReference,
    renderOffline: ReturnType<typeof renderer> = renderer(),
    extra: Omit<WebMcpToolDependencies, 'renderOffline' | 'decodeAudio'> = {}
  ) {
    const engine = new FakeEngine()
    engine.running = false
    const decodeAudio = vi.fn(async () => decoded())
    const tools = createWebMcpTools(engine as unknown as SynthEngine, undefined, { renderOffline, decodeAudio, ...extra })
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    const execute = async (name: string, input: Record<string, unknown> = {}) =>
      await byName.get(name)!.execute(input, { signal: new AbortController().signal }) as any
    return { engine, byName, execute, renderOffline, decodeAudio }
  }

  it('gives the reference a pitch AND harmonics, without returning its PCM', async () => {
    const { execute } = matchSetup()
    const reference = await execute('analyze_reference_audio', { audioBase64: 'UklGRg==', name: 'target.wav' })
    expect(reference.metrics.pitch).toMatchObject({ source: 'detected', midi: REFERENCE_MIDI })
    expect(reference.metrics.pitch.f0Hz).toBeCloseTo(REFERENCE_HZ, -1)
    expect(reference.metrics.harmonics.amplitudesDb).toHaveLength(12)
    expect(reference.metrics.harmonicShape.amplitudesDbRelF0).toHaveLength(12)
    expect(reference.metrics.harmonicShape.amplitudesDbRelF0[0]).toBe(0)
    // The retained PCM is what makes a re-analysis cheap, and it must never be
    // in the payload: a 30 s stereo buffer as JSON would end the session.
    expect(reference).not.toHaveProperty('channelData')
    expect(JSON.stringify(reference).length).toBeLessThan(8000)
  })

  it('re-analyzes the retained reference PCM at a corrected f0Hz with no re-upload', async () => {
    const { execute, decodeAudio } = matchSetup()
    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })
    const octaveDown = await execute('analyze_audio', { source: 'reference', f0Hz: REFERENCE_HZ / 2, windows: 8 })
    expect(decodeAudio).toHaveBeenCalledTimes(1)
    expect(octaveDown.source).toBe('reference')
    expect(octaveDown.metrics.pitch).toMatchObject({ f0Hz: REFERENCE_HZ / 2, source: 'given' })
    expect(octaveDown.metrics.spectralWindows).toHaveLength(8)
    expect(octaveDown).not.toHaveProperty('channelData')
  })

  it('refuses an autoRender it has no pitch for, rather than rendering an arbitrary note', async () => {
    const { execute, renderOffline } = matchSetup(() => decodedReference())
    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })
    await expect(execute('compare_audio', { autoRender: true })).rejects.toThrow(/no fundamental was detected/i)
    expect(renderOffline).not.toHaveBeenCalled()
    // A pitchless reference simply does not auto-render; the old scope path stands.
    await expect(execute('compare_audio')).resolves.toMatchObject({ candidate: { source: 'scope' } })
    expect(renderOffline).not.toHaveBeenCalled()
  })

  it('refuses a reference re-analysis before there is a reference', async () => {
    const { execute } = matchSetup()
    await expect(execute('analyze_audio', { source: 'reference' })).rejects.toThrow(/analyze_reference_audio first/i)
  })

  it('renders the candidate at the reference\'s own detected pitch before comparing', async () => {
    const { execute, renderOffline } = matchSetup()
    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })
    // The motivating session hand-picked a MIDI note an octave off, and every
    // partial comparison was garbage while the scalars still looked plausible.
    const result = await execute('compare_audio')
    expect(renderOffline).toHaveBeenCalledTimes(1)
    const [, notes, duration] = renderOffline.mock.calls[0]
    expect(notes).toEqual([{ midi: REFERENCE_MIDI, velocity: 1, start: 0, duration: expect.any(Number) }])
    expect(duration).toBeCloseTo(0.5, 2)
    expect(result.candidate.source).toBe('last-render')
    expect(result.diff.similarity).toBe(result.comparison.similarity)
    // MEASURED, not asserted: the reference's f0 is not handed to the candidate's
    // analysis, so `centsError` reports what the patch actually produced. It lands
    // on the reference's pitch here because nothing detunes this render.
    expect(result.candidate.metrics.pitch).toMatchObject({ source: 'detected' })
    expect(result.candidate.metrics.pitch.f0Hz).toBeCloseTo(REFERENCE_HZ, -1)

    // Opting out compares whatever was rendered last, without rendering again.
    await execute('compare_audio', { autoRender: false })
    expect(renderOffline).toHaveBeenCalledTimes(1)
  })

  it('returns ranked, parameter-vocabulary actions and a text payload by default', async () => {
    const { execute } = matchSetup()
    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==', name: 'target.wav' })
    const result = await execute('compare_audio')
    expect(typeof result.text).toBe('string')
    expect(result.text).toContain('MATCH')
    expect(result.text).toContain('PARTIALS')
    expect(result.text).toContain('ref "target.wav"')
    expect(Array.isArray(result.diff.actions)).toBe(true)
    expect(result.diff.actions.length).toBeGreaterThan(0)
    for (const action of result.diff.actions) {
      expect(typeof action.finding).toBe('string')
      for (const id of action.paramIds) expect(PARAMS.some(def => def.id === id), id).toBe(true)
      if (action.suggested) {
        const def = PARAMS.find(candidate => candidate.id === action.suggested.id)!
        expect(action.suggested.to).toBeGreaterThanOrEqual(def.choices ? 0 : def.min)
        expect(action.suggested.to).toBeLessThanOrEqual(def.choices ? def.choices.length - 1 : def.max)
      }
    }
    // The text half carries the diff's numbers, so the numeric arrays are not
    // paid for twice; `actions` stays structured because it is applied, not read.
    expect(result.diff).not.toHaveProperty('bands')
    const capped = await execute('compare_audio', { maxActions: 1 })
    expect(capped.diff.actions).toHaveLength(1)
  })

  /**
   * A candidate whose upper partials collapse far faster than the reference's,
   * so the brightness error drifts across the buffer and `filter-envelope-depth`
   * has something to fire on. The reference decays as a whole and keeps its
   * partial balance; this one goes dark while it is still sounding.
   */
  function darkeningRenderer() {
    return vi.fn(async (_engine: unknown, notes: readonly { midi: number }[], duration: number): Promise<RecordedAudio> => {
      const length = Math.max(64, Math.round(duration * RATE))
      const f0 = 440 * Math.pow(2, ((notes[0]?.midi ?? 69) - 69) / 12)
      const channel = Float32Array.from({ length }, (_, index) => {
        const t = index / RATE
        const bright = Math.exp(-3 * t)
        let value = Math.sin(2 * Math.PI * f0 * t)
        for (let partial = 2; partial <= 6; partial++) {
          value += bright * Math.sin(2 * Math.PI * f0 * partial * t) / partial
        }
        return 0.45 * Math.exp(-2 * t) * value
      })
      return wav([channel, channel.slice()], duration)
    })
  }

  /** The `filter-envelope-depth` finding, whatever branch it fired from. */
  function envelopeDepthAction(result: any) {
    return result.diff.actions.find((action: any) =>
      action.paramIds?.includes('env2.decay') && action.finding.includes('env2 -> filter1.cutoff'))
  }

  it('reads the live mod matrix, so a missing route is advised as set_modulation rather than an inert env2.decay', async () => {
    const { execute } = matchSetup(pitchedReference, darkeningRenderer())
    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })

    // The reviewer's complaint: env2 reaches the sound through this one route and
    // nothing else, so with no route in the patch `env2.decay` is inert and
    // recommending it is advice that cannot work however many rounds it is applied.
    const missing = envelopeDepthAction(await execute('compare_audio'))
    expect(missing).toBeDefined()
    expect(missing.finding).toContain('set_modulation source=env2 destination=filter1.cutoff')
    expect(missing.finding).toMatch(/INERT in this patch/)
    // No move is offered, because the move that would help has no parameter id.
    expect(missing.suggested).toBeUndefined()
    expect(missing.finding).not.toMatch(/passed no modulation matrix/)

    // Create the route and the same measurement reads differently: the advice
    // now knows the lever exists, and reads its sign rather than assuming one.
    await execute('set_modulation', { action: 'add', source: 'env2', destination: 'filter1.cutoff', depth: 0.45 })
    const live = envelopeDepthAction(await execute('compare_audio'))
    expect(live).toBeDefined()
    expect(live.finding).toContain('route is live at depth 0.45')
    expect(live.finding).not.toContain('set_modulation source=env2')
    expect(live.suggested).toMatchObject({ id: 'env2.decay' })

    // suggest_patch re-reads the same comparison and must see the same matrix:
    // it builds its own advice rather than replaying the stored actions.
    const advised = (await execute('suggest_patch', { focus: 'envelope' })).actions
      .find((action: any) => action.finding.includes('env2 -> filter1.cutoff'))
    expect(advised.finding).toContain('route is live at depth 0.45')
  })

  it('keeps the legacy comparison shape, and the full numeric diff, under format json', async () => {
    const { execute } = matchSetup()
    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })
    const result = await execute('compare_audio', { format: 'json' })
    expect(result).not.toHaveProperty('text')
    // `docs/agent-match-eval.md` reads these off every recorded run.
    expect(result.comparison.similarity).toBeGreaterThanOrEqual(0)
    expect(result.comparison.similarity).toBeLessThanOrEqual(1)
    expect(Object.keys(result.comparison.details)).toEqual(expect.arrayContaining([
      'peakDb', 'rmsDb', 'clippingCount', 'dcOffset', 'spectralCentroidHz', 'attackMs', 'stereoWidth'
    ]))
    expect(result.diff.bands).toHaveLength(10)
    expect(result.diff.harmonics.deltaDb).toHaveLength(12)
    expect(result.diff.pitch.centsError).toBeCloseTo(0, 0)
    expect(result.progress.comparisonNumber).toBe(1)
  })

  it('suggest_patch re-reads the last comparison, and refuses cleanly when there is none', async () => {
    const { execute } = matchSetup()
    const refusal = expect(execute('suggest_patch')).rejects
    await refusal.toThrow(/analyze_reference_audio/)
    await refusal.toThrow(/compare_audio/)

    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==', name: 'target.wav' })
    const compared = await execute('compare_audio')
    const again = await execute('suggest_patch')
    expect(again.actions).toEqual(compared.diff.actions)
    expect(again.basedOn).toMatchObject({ referenceName: 'target.wav', comparisonNumber: 1 })

    const focused = await execute('suggest_patch', { focus: 'envelope', maxActions: 20 })
    expect(focused.actions.length).toBeLessThanOrEqual(again.actions.length + 20)
    await expect(execute('suggest_patch', { focus: 'nope' })).rejects.toThrow(/focus/i)
    expect(again.basedOn.note).not.toMatch(/CHANGED/)
    expect(again.basedOn).not.toHaveProperty('currentSoundEntryId')
  })

  it('warns that the sound moved under the advice, without withholding the advice', async () => {
    let currentSoundEntryId = 'entry-1'
    const { execute } = matchSetup(pitchedReference, renderer(), {
      currentSoundEntryId: () => currentSoundEntryId
    })
    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==', name: 'target.wav' })
    const compared = await execute('compare_audio')

    const fresh = await execute('suggest_patch')
    expect(fresh.basedOn.stale).toBe(false)

    // The agent takes the advice. Every patch edit commits a new sound-history
    // entry, which is exactly what makes the previous comparison describe a
    // sound that no longer exists.
    currentSoundEntryId = 'entry-2'
    const stale = await execute('suggest_patch')

    expect(stale.basedOn.stale).toBe(true)
    expect(stale.basedOn.comparedSoundEntryId).toBe('entry-1')
    expect(stale.basedOn.currentSoundEntryId).toBe('entry-2')
    expect(stale.basedOn.note).toMatch(/THE SOUND HAS CHANGED/)
    expect(stale.basedOn.note).toMatch(/scores the patch you REPLACED/)
    expect(stale.basedOn.note).toMatch(/compare_audio/)
    // Warn, do not refuse. The measurement really happened, and the moves are
    // re-derived against the patch as it is now, so they stay applicable — the
    // sequence that trips this warning (apply the advice, ask what is next) is
    // the one an agent should be doing. Only the *number* is about the old sound.
    expect(stale.actions).toEqual(compared.diff.actions)
    expect(stale.basedOn.similarity).toBe(fresh.basedOn.similarity)

    // Undo restores the entry the comparison was measured against, so returning
    // to that sound is not a change and must not keep warning.
    currentSoundEntryId = 'entry-1'
    expect((await execute('suggest_patch')).basedOn.stale).toBe(false)
  })

  it('claims nothing about staleness on a page with no sound history to compare against', async () => {
    const { execute } = matchSetup()
    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })
    await execute('compare_audio')
    // Without `currentSoundEntryId` there is no way to know whether the patch
    // moved, and `stale: false` would be a checked fact a caller is entitled to
    // trust. Absent says "unknown"; false would be a lie of the kind
    // SILENT_CANDIDATE_REFUSAL exists to prevent.
    const advice = await execute('suggest_patch')
    expect(advice.basedOn).not.toHaveProperty('stale')
    expect(advice.basedOn.note).toMatch(/Re-read of the last compare_audio/)
    // `addsNothing` rests on "the patch has not moved", which is the same
    // unknowable fact as `stale`. Absent, never false.
    expect(advice.basedOn).not.toHaveProperty('addsNothing')
  })

  it('names the suggest_patch call that only repeats the comparison it read', async () => {
    let currentSoundEntryId = 'entry-1'
    const { execute } = matchSetup(pitchedReference, renderer(), {
      currentSoundEntryId: () => currentSoundEntryId
    })
    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==', name: 'target.wav' })
    const compared = await execute('compare_audio', { format: 'json' })

    // Eval run 4 never called this tool: "compare_audio already returns the same
    // ranked moves, so paying a round trip to re-read them made no sense; that is
    // a real redundancy." For the call it had in mind — unchanged patch, no
    // focus, no more moves asked for — it was exactly right, and the list really
    // does come back identical. The response now says so, instead of leaving an
    // agent to work it out by diffing two payloads.
    const repeat = await execute('suggest_patch')
    expect(repeat.actions).toEqual(compared.diff.actions)
    expect(repeat.basedOn.addsNothing).toBe(true)
    expect(repeat.basedOn.note).toMatch(/Nothing new/)
    expect(repeat.basedOn.note).toMatch(/AFTER you have applied moves/)

    // The two inputs compare_audio has no answer for.
    expect((await execute('suggest_patch', { focus: 'envelope' })).basedOn.addsNothing).toBe(false)
    expect((await execute('suggest_patch', { maxActions: 20 })).basedOn.addsNothing).toBe(false)

    // And the capability that keeps the tool alive: apply an advised move and the
    // same stored diff yields a different list, because every from/to is derived
    // against the patch as it is NOW. compare_audio's `diff.actions` are frozen at
    // the moment they were measured and cannot do this without another render.
    const move = compared.diff.actions.find((action: { suggested?: unknown }) => action.suggested) as
      { suggested: { id: string; to: number } } | undefined
    expect(move, 'this fixture must produce at least one quantitative move').toBeTruthy()
    await execute('update_parameters', { updates: [{ id: move!.suggested.id, value: move!.suggested.to }] })
    currentSoundEntryId = 'entry-2'
    const reaimed = await execute('suggest_patch')
    expect(reaimed.actions).not.toEqual(compared.diff.actions)
    expect(reaimed.basedOn).toMatchObject({ stale: true, addsNothing: false })
  })

  it('says when the reference was resampled DOWN on the way in, and when it was not', async () => {
    // Playwright's Chromium reports a 16 kHz output device. Before audio-input
    // pinned an explicit decode rate, a 44.1 kHz reference decoded at 16 kHz:
    // everything above its 8 kHz Nyquist read empty, the 48 kHz candidate read
    // real energy there, and an eval agent spent a comparison proving it could
    // not close a gap that was never in the sound.
    const downsampled = matchSetup(() => ({ ...pitchedReference(), sourceSampleRate: 44100 }))
    const reference = await downsampled.execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })
    expect(reference.sourceSampleRate).toBe(44100)
    expect(reference.sampleRate).toBeLessThan(44100)
    expect(reference.downsampled).toMatchObject({ from: 44100, to: reference.sampleRate })
    expect(reference.downsampled.nyquistHz).toBe(Math.round(reference.sampleRate / 2))
    expect(reference.downsampled.note).toMatch(/BEFORE any of these metrics were measured/)
    // The distinction the agent could not make: absent content and discarded
    // content look identical in every band figure and call for opposite edits.
    expect(reference.downsampled.note).toMatch(/artefact of the decode/)

    // A file decoded at its own rate says nothing, and neither does one whose
    // header could not be read.
    const equal = matchSetup(() => ({ ...pitchedReference(), sourceSampleRate: RATE }))
    const plain = await equal.execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })
    expect(plain.sourceSampleRate).toBe(RATE)
    expect(plain).not.toHaveProperty('downsampled')
    const headerless = await matchSetup().execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })
    expect(headerless).not.toHaveProperty('sourceSampleRate')
    expect(headerless).not.toHaveProperty('downsampled')
  })

  it('names the band above which two rates make the comparison meaningless', async () => {
    const { engine, execute } = setup()
    // The reference decoded at 8 kHz; the live scope reads the context's rate.
    // Above the lower Nyquist one side cannot hold energy at all, so no edit to
    // the patch closes that difference — and nothing used to say so.
    engine.ctx = { sampleRate: 48000 }
    engine.scopeL = Float32Array.from([0, 0.5, -0.5, 0])
    engine.scopeR = engine.scopeL
    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })
    const mismatched = await execute('compare_audio', { format: 'json' })
    expect(mismatched.sampleRates).toMatchObject({ reference: 8000, candidate: 48000, comparableBelowHz: 4000 })
    expect(mismatched.sampleRates.note).toMatch(/reference's Nyquist/)
    expect(mismatched.sampleRates.note).toMatch(/no edit to the patch changes that/)

    // Equal rates is the ordinary case and costs nothing.
    const same = setup()
    same.engine.scopeL = Float32Array.from([0, 0.5, -0.5, 0])
    same.engine.scopeR = same.engine.scopeL
    await same.execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })
    expect(await same.execute('compare_audio', { format: 'json' })).not.toHaveProperty('sampleRates')
  })

  it('says why a null pitch is null, and stays quiet when one was measured', async () => {
    const measured = matchSetup()
    await measured.execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })
    const pitched = await measured.execute('compare_audio', { format: 'json' })
    expect(pitched.candidate.metrics.pitch).toMatchObject({ source: 'detected' })
    // Nothing to explain, so nothing is paid for.
    expect(pitched.candidate).not.toHaveProperty('pitchNote')
    expect(pitched.reference).not.toHaveProperty('pitchNote')

    // Run 4: "a +12 dB EQ boost silently killed pitch detection, zeroing three
    // dimensions. I blamed clipping, spent a round trip fixing gain, and it still
    // failed — only then did I suspect the EQ." From the tool layer every refusal
    // inside detectPitch looks the same, so the note states the evidence it has
    // and lists the rest as causes rather than asserting one.
    const lost = matchSetup(pitchedReference, noiseRenderer())
    await lost.execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })
    const noise = await lost.execute('compare_audio', { format: 'json' })
    expect(noise.candidate.metrics.pitch).toBeNull()
    const note: string = noise.candidate.pitchNote
    expect(note).toMatch(/No fundamental was found/)
    // The consequence the agent could not see: three terms scored 0, not excluded.
    expect(note).toMatch(/scores `harmonics`, `tilt` and `inharmonicity` 0/)
    for (const term of ['harmonics', 'tilt', 'inharmonicity']) {
      expect(noise.comparison.details[term].similarity, term).toBe(0)
    }
    // The evidence it actually measured, with the number beside it.
    expect(note).toContain('spectralFlatness')
    expect(note).toMatch(/reads as noise/)
    // The causes it cannot verify are named as causes, never asserted — and the
    // one that cost run 4 two calls is among them.
    expect(note).toMatch(/Causes it cannot tell apart/)
    expect(note).toMatch(/EQ band boosted far above it/)
    // The reference kept its fundamental, so it carries nothing.
    expect(noise.reference).not.toHaveProperty('pitchNote')

    // Text is compare_audio's default and it drops `metricNotes`. The pitch note
    // must not go with them: text mode is where the eval agent was standing.
    const text = await lost.execute('compare_audio')
    expect(text.candidate).not.toHaveProperty('metricNotes')
    expect(text.candidate.pitchNote).toBe(note)

    // Digital silence gets the short answer. Reciting the detector guards for a
    // buffer with nothing in it would be advice about nothing.
    const { engine, execute } = setup()
    engine.scopeL = new Float32Array(256)
    engine.scopeR = new Float32Array(256)
    const silent = await execute('analyze_audio', { source: 'scope' })
    expect(silent.metrics.pitch).toBeNull()
    expect(silent.pitchNote).toMatch(/digital silence/)
    expect(silent.pitchNote).not.toMatch(/Causes it cannot tell apart/)
  })

  it('measures the candidate\'s own pitch, so a transposed patch reports a real cents error', async () => {
    const { execute } = matchSetup()
    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })
    // Nothing detunes this patch yet, so the measured pitch lands on the target's.
    const inTune = await execute('compare_audio', { format: 'json' })
    expect(Math.abs(inTune.diff.pitch.centsError)).toBeLessThan(5)

    // The regression: the candidate used to be analyzed at the REFERENCE's f0, which
    // `resolvePitch` accepts as `source: "given"`, `confidence: 1` without reading a
    // sample. `centsError` was therefore 0 no matter how far the render was from the
    // target, and `pitch-error` — the rule that names an octave error — was dead code
    // on the default path. An octave of transpose has to show up as ~1200 cents.
    await execute('update_parameters', { updates: [{ id: 'osc1.transpose', value: 12 }] })
    const octaveUp = await execute('compare_audio', { format: 'json' })
    expect(octaveUp.diff.pitch.centsError).toBeGreaterThan(1150)
    expect(octaveUp.diff.pitch.centsError).toBeLessThan(1250)
    expect(octaveUp.diff.pitch.referenceHz).toBeCloseTo(REFERENCE_HZ, -1)
    expect(octaveUp.diff.pitch.candidateHz).toBeCloseTo(REFERENCE_HZ * 2, -1)
    expect(octaveUp.candidate.metrics.pitch).toMatchObject({ source: 'detected' })

    // And the advice that reads it now fires, naming the transpose rather than fine tuning.
    const pitchAction = octaveUp.diff.actions.find((action: any) => action.paramIds.includes('osc1.transpose'))
    expect(pitchAction.finding).toMatch(/octave error/i)
    expect(pitchAction.finding).toMatch(/-12 semitones/)
    expect(pitchAction.direction).toBe('decrease')

    // A sub-semitone detune is measured too, where a stated f0 would have hidden it.
    await execute('update_parameters', { updates: [{ id: 'osc1.transpose', value: 0 }, { id: 'osc1.fine', value: 0 }] })
    const inTuneAgain = await execute('compare_audio', { format: 'json' })
    expect(Math.abs(inTuneAgain.diff.pitch.centsError)).toBeLessThan(5)
  })

  it('releases the auto-rendered note before the buffer ends, so the candidate decays like the reference', async () => {
    const { execute, renderOffline } = matchSetup(pitchedReference, sustainingRenderer())
    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })
    const result = await execute('compare_audio', { format: 'json' })

    // Note-off used to land on the last sample of the buffer, so the candidate
    // never entered its release at all.
    const [, rendered, duration] = renderOffline.mock.calls[0]
    const notes = rendered as readonly { midi: number; start: number; duration: number }[]
    expect(notes).toHaveLength(1)
    expect(notes[0].start + notes[0].duration).toBeLessThan(duration)
    // 0.25 s of tail, capped at 40 % of the buffer: a 0.5 s reference holds the
    // note for 0.3 s and leaves 0.2 s for the release.
    expect(duration).toBeCloseTo(0.5, 2)
    expect(notes[0].duration).toBeCloseTo(0.3, 2)

    // The three metrics that were reading a still-sounding note: T60 is a real
    // measurement again, and the comparison it feeds is no longer `n/a`.
    expect(result.candidate.metrics.decayT60Ms).toBeGreaterThan(0)
    // The candidate half of the T60 comparison exists again. Whether the delta
    // resolves is then up to the reference, which is the honest dependency —
    // before this, the candidate half was structurally absent on every default
    // comparison however measurable the reference was.
    expect(result.comparison.details.decayT60Ms.candidate).toBeGreaterThan(0)
    // Sustain is sampled at 80 % of the buffer — inside the release now, as it is
    // for a reference that has already died away by then.
    expect(result.candidate.metrics.sustainDb).toBeLessThan(-10)

    // Held for the whole buffer, the same patch has no measurable decay at all:
    // that is exactly what the default path was doing to every comparison.
    const held = await execute('compare_audio', {
      format: 'json',
      notes: [{ midi: REFERENCE_MIDI, velocity: 1, start: 0, duration: 0.5 }],
      duration: 0.5
    })
    expect(held.candidate.metrics.decayT60Ms).toBeNull()
    expect(held.candidate.metrics.sustainDb).toBeGreaterThan(-3)
  })

  it('reports n/a rather than a borrowed fundamental when the candidate has no detectable pitch', async () => {
    const { execute } = matchSetup(pitchedReference, noiseRenderer())
    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==', name: 'target.wav' })
    // Noise has no fundamental. Falling back to the reference's f0 here would put
    // `confidence: 1` on a number nothing measured, so the answer is "not measurable".
    const result = await execute('compare_audio')
    expect(result.candidate.metrics.pitch).toBeNull()
    expect(result.candidate.metrics).not.toHaveProperty('harmonics')
    expect(result.candidate.metrics).not.toHaveProperty('harmonicShape')
    expect(result.text).toContain('PITCH   n/a (no fundamental measured on your sound)')
    expect(result.text).toContain('PARTIALS  n/a (one side has no fundamental')
    expect(result.diff.similarity).toBe(result.comparison.similarity)

    const json = await execute('compare_audio', { format: 'json' })
    expect(json.diff.pitch.referenceHz).toBeCloseTo(REFERENCE_HZ, -1)
    expect(json.diff.pitch.candidateHz).toBeNull()
    expect(json.diff.pitch.centsError).toBeNull()
    expect(json.diff.harmonics).toBeNull()
  })

  it('analyzes the candidate with the same window count as the reference', async () => {
    const { execute } = matchSetup()
    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==', windows: 8 })
    const result = await execute('compare_audio', { format: 'json' })
    // A 4-window candidate against an 8-window reference compares slices that cover
    // different fractions of each sound, and throws away half the resolution the
    // caller paid for on the reference.
    expect(result.reference.metrics.spectralWindows).toHaveLength(8)
    expect(result.candidate.metrics.spectralWindows).toHaveLength(8)
    expect(result.diff.brightness).toHaveLength(8)
  })

  it('makes a corrected reference re-analysis the one compare_audio scores against', async () => {
    const { execute, renderOffline } = matchSetup()
    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })
    const before = await execute('compare_audio', { format: 'json' })
    expect(before.reference.metrics.pitch).toMatchObject({ source: 'detected', midi: REFERENCE_MIDI })
    expect(before.reference.metrics.spectralWindows).toHaveLength(4)

    const corrected = await execute('analyze_audio', { source: 'reference', f0Hz: REFERENCE_HZ / 2, windows: 8 })
    expect(corrected.activeReference).toBe('replaced')

    // The correction used to be returned and then dropped: every later compare_audio
    // went on scoring against the metrics the caller had just replaced.
    const after = await execute('compare_audio', { format: 'json' })
    expect(after.reference.metrics.pitch).toMatchObject({ f0Hz: REFERENCE_HZ / 2, source: 'given' })
    expect(after.reference.metrics.spectralWindows).toHaveLength(8)
    expect(after.diff.pitch.referenceHz).toBeCloseTo(REFERENCE_HZ / 2, 3)
    // The candidate follows the corrected target, on both counts: an octave lower,
    // and cut into the reference's eight windows.
    expect(renderOffline.mock.calls[1][1]).toEqual([
      { midi: REFERENCE_MIDI - 12, velocity: 1, start: 0, duration: expect.any(Number) }
    ])
    expect(after.candidate.metrics.spectralWindows).toHaveLength(8)
  })

  it('resets the best-so-far when a re-analysis moves the reference, and says so', async () => {
    const { execute } = matchSetup()
    await execute('analyze_reference_audio', { audioBase64: 'UklGRg==' })
    await execute('compare_audio')
    expect((await execute('compare_audio')).progress.comparisonNumber).toBe(2)

    // A plain look changes nothing — same fundamental, same window count — so the
    // running best is not thrown away for a call that only read.
    const plain = await execute('analyze_audio', { source: 'reference' })
    expect(plain.activeReference).toBe('unchanged')
    expect(plain.matchProgressReset).toBe(false)
    expect(plain.note).toMatch(/untouched/i)
    expect((await execute('compare_audio')).progress.comparisonNumber).toBe(3)

    // A correction does move the target, and a similarity scored against the old
    // metrics is not comparable to one scored against the new ones.
    const corrected = await execute('analyze_audio', { source: 'reference', f0Hz: REFERENCE_HZ / 2 })
    expect(corrected.matchProgressReset).toBe(true)
    expect(corrected.note).toMatch(/best-so-far was reset/i)
    expect(corrected.note).toMatch(/restarts at 1/i)
    // The stale advice goes with it, rather than being re-read against a moved target.
    await expect(execute('suggest_patch')).rejects.toThrow(/No comparison to advise from yet/i)

    const fresh = await execute('compare_audio')
    expect(fresh.progress).toMatchObject({ comparisonNumber: 1, isBest: true, comparisonsSinceBest: 0 })
  })

  it('says out loud that the live scope is 1024 samples, so its envelope metrics mean nothing', async () => {
    const { execute } = matchSetup()
    const scope = await execute('analyze_audio', { source: 'scope' })
    expect(scope.scopeNote).toContain('1024 samples')
    expect(scope.scopeNote).toMatch(/21 ms/)
    expect(scope.scopeNote).toMatch(/decayT60Ms/)
    expect(scope.scopeNote).toMatch(/render_audio/)
  })
})
