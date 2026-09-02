import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PARAMS, defaultValues, paramIndex } from '../shared/params'
import { DEFAULT_FX_ORDER, FX_IDS, MAX_MOD_SLOTS, MOD_SOURCES, defaultLfoShape, modSourceIndex, type ModSlotState } from '../shared/messages'
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
  voiceCount = 2
  peakL = 0.2
  peakR = 0.1
  heldNotes = new Set<number>()
  private readonly defaultNoteOwner = Symbol('human')
  private readonly noteOwners = new Map<number, Set<symbol>>()
  setParam = vi.fn((index: number, value: number) => { this.values[index] = value })
  setModSlot = vi.fn((slot: number, state: ModSlotState | null) => { this.modSlots[slot] = state })
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
  loadPreset = vi.fn((preset: Partial<PresetData>) => {
    if (preset.params?.['master.volume'] !== undefined) this.values[paramIndex('master.volume')] = preset.params['master.volume']
  })
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
  decodeAudio: NonNullable<WebMcpToolDependencies['decodeAudio']> = vi.fn(async () => decodedReference())
) {
  const engine = new FakeEngine()
  const tools = createWebMcpTools(engine as unknown as SynthEngine, lifecycleSignal, { decodeAudio })
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  const execute = async (name: string, input: Record<string, unknown> = {}, signal = new AbortController().signal) =>
    await byName.get(name)!.execute(input, { signal }) as any
  return { engine, tools, byName, execute, decodeAudio }
}

beforeEach(() => {
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
  it('exposes exactly twelve strict object schemas in composable workflow order', () => {
    const { tools } = setup()
    expect(tools.map(tool => tool.name)).toEqual([
      'get_synth_state', 'get_parameter_schema', 'update_parameters', 'set_modulation',
      'play_notes', 'render_audio', 'analyze_audio', 'analyze_reference_audio',
      'compare_audio', 'save_preset', 'load_preset', 'list_presets'
    ])
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(10)
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
      expect(tool.execute).toBeTypeOf('function')
    }
    expect(tools.filter(tool => tool.annotations?.readOnlyHint).map(tool => tool.name)).toEqual([
      'get_synth_state', 'get_parameter_schema', 'analyze_audio',
      'compare_audio', 'list_presets'
    ])
    expect(tools.filter(tool => tool.annotations?.readOnlyHint === false).map(tool => tool.name)).toEqual([
      'update_parameters', 'set_modulation', 'play_notes', 'render_audio',
      'analyze_reference_audio', 'save_preset', 'load_preset'
    ])
    expect(tools.find(tool => tool.name === 'analyze_reference_audio')?.annotations?.untrustedContentHint).toBe(true)
    expect(tools[7].inputSchema).toMatchObject({
      required: ['audioBase64'],
      properties: {
        audioBase64: { type: 'string', maxLength: 16 * 1024 * 1024 },
        name: { type: 'string' },
        mimeType: { type: 'string' }
      }
    })
    expect((tools[7].inputSchema as any).properties.mimeType.pattern).toBe('^[aA][uU][dD][iI][oO]/')
  })

  it('keeps the whole tool listing small enough to survive a client that truncates it', () => {
    const { tools } = setup()
    const listing = tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
    const bytes = (value: string) => new TextEncoder().encode(value).length
    // In the discoverability eval Codex truncated the 17-tool listing and lost
    // `play_notes` entirely, then drove the page through <select> elements
    // instead. These 12 tools were 10751 B of that listing (5019 B of prose,
    // 4958 B of schema) after four rounds of per-tool clarity fixes.
    expect(bytes(JSON.stringify(listing))).toBeLessThanOrEqual(9900)
    // The prose half — what a truncating client renders first — must stay well
    // under what those four rounds had grown it to.
    const prose = listing.reduce((total, tool) => total + bytes(tool.description), 0)
    expect(prose).toBeLessThanOrEqual(3400)
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
  it('lists saved presets by name', async () => {
    const { engine, execute } = setup()
    engine.toPreset.mockImplementation((name: string): PresetData => ({
      name, version: 1, params: { 'master.volume': 0.5 }, mods: [],
      lfoShapes: engine.lfoShapes.map(shape => shape.map(point => ({ ...point }))), fxOrder: [...FX_IDS]
    }))
    expect(await execute('list_presets')).toEqual({ presets: [], total: 0 })
    await execute('save_preset', { name: 'Concert Grand' })
    await execute('save_preset', { name: 'Rhodes' })
    expect(await execute('list_presets')).toEqual({
      presets: [{ name: 'Concert Grand' }, { name: 'Rhodes' }], total: 2
    })
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
    expect((byName.get('compare_audio')!.execute as any)({}, {}))
      .toMatchObject({ candidate: { source: 'last-render' } })
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
    expect(description).toContain('metrics.harmonics')
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
    expect((byName.get('analyze_audio')!.inputSchema as any).properties.source.enum).toEqual(['scope', 'last-render'])
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
    expect(byName.get('play_notes')!.description).toContain('{"notes":[{"midi":60,"velocity":0.8,"start":0,"duration":0.5}]}')
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
    const result = await execute('compare_audio')
    expect(result.reference).toEqual(reference)
    expect(result.candidate).toEqual(analysis)
    expect(result.comparison.similarity).toBeGreaterThanOrEqual(0)
    expect(result.comparison.similarity).toBeLessThanOrEqual(1)
    expect(Object.keys(result.comparison.details)).toEqual(expect.arrayContaining([
      'peakDb', 'rmsDb', 'clippingCount', 'dcOffset',
      'spectralCentroidHz', 'attackMs', 'stereoWidth'
    ]))
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
    const result = await execute('compare_audio')
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

  it('omits harmonics when the sequence holds more than one pitch', async () => {
    const { execute } = offlineSetup()
    const result = await execute('render_audio', {
      notes: [
        { midi: 60, velocity: 0.8, start: 0, duration: 0.5 },
        { midi: 64, velocity: 0.8, start: 0, duration: 0.5 }
      ],
      duration: 1
    })
    expect(result.renderMode).toBe('offline')
    expect(result.metrics.harmonics).toBeUndefined()
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
    await execute('save_preset', { name: 'Agent Patch' })
    engine.values[paramIndex('master.volume')] = 0.25
    await execute('save_preset', { name: 'Agent Patch' })
    engine.values[paramIndex('master.volume')] = 0.9
    const loaded = await execute('load_preset', { name: 'Agent Patch' })
    expect(engine.loadPreset).toHaveBeenCalledTimes(1)
    expect(loaded).toEqual({ name: 'Agent Patch', loaded: true })
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
  })
})
