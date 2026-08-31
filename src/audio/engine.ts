// Main-thread synth engine: owns the AudioContext + worklet node, the
// authoritative parameter/mod-matrix/LFO-shape state, wavetable generation
// and transfer, and preset (de)serialization.

import processorUrl from '../worklet/processor.ts?worker&url'
import {
  PARAMS, NUM_PARAMS, paramIndex, defaultValues, WAVETABLE_NAMES, DIST_TYPES
} from '../shared/params'
import {
  MAX_MOD_SLOTS, MOD_SOURCES, modSourceIndex, DEFAULT_FX_ORDER, FX_IDS,
  defaultLfoShape, type LfoPoint, type ModSlotState, type ToWorklet, type FromWorklet
} from '../shared/messages'
import { generateWavetable, buildMips, wavToWavetable, decodeWav, type Wavetable } from '../shared/wavetable-gen'
import { samePatchValue, type MutationOrigin, type PatchChange, type PatchMutation } from '../shared/patch-change'

export interface PresetData {
  name: string
  version: 1
  params: Record<string, number> // param id -> normalized value
  mods: { source: string; dest: string; depth: number; enabled: boolean }[]
  lfoShapes: LfoPoint[][]
  fxOrder: string[]
}

export interface RecordedAudio {
  blob: Blob
  mimeType: string
  duration: number
  sampleRate: number
  channelData: Float32Array[]
}

export type NoteOwner = symbol

/** Structured state is frozen; imported PCM buffers are shared and never mutated. */
export interface SoundSnapshot {
  readonly values: readonly number[]
  readonly modSlots: readonly (Readonly<ModSlotState> | null)[]
  readonly lfoShapes: readonly (readonly Readonly<LfoPoint>[])[]
  readonly fxOrder: readonly number[]
  readonly customTables: readonly (Wavetable | null)[]
  readonly noiseSample: Readonly<{ data: Float32Array; sampleRate: number }> | null
}

export interface SoundChange {
  label: string
  changed: string[]
  coalesceKey?: string
  /** A complete operation must not join an unrelated pending human gesture. */
  atomic?: boolean
}

/** Buffer identity lets history count shared imported assets only once. */
export function soundStateAssets(state: SoundSnapshot): readonly { byteLength: number }[] {
  const assets = new Set<ArrayBufferLike>()
  for (const table of state.customTables) if (table) assets.add(table.data.buffer)
  if (state.noiseSample) assets.add(state.noiseSample.data.buffer)
  return [...assets]
}

function changedSoundFields(before: SoundSnapshot, after: SoundSnapshot): string[] {
  const changed = before.values.flatMap((value, i) => value !== after.values[i] ? [PARAMS[i].id] : [])
  before.modSlots.forEach((slot, i) => {
    if (JSON.stringify(slot) !== JSON.stringify(after.modSlots[i])) changed.push(`mod.${i}`)
  })
  before.lfoShapes.forEach((shape, i) => {
    if (JSON.stringify(shape) !== JSON.stringify(after.lfoShapes[i])) changed.push(`lfo${i + 1}.shape`)
  })
  if (JSON.stringify(before.fxOrder) !== JSON.stringify(after.fxOrder)) changed.push('fx.order')
  before.customTables.forEach((table, i) => {
    if (table !== after.customTables[i]) changed.push(`osc${i + 1}.customTable`)
  })
  if (before.noiseSample !== after.noiseSample) changed.push('noise.sample')
  return changed
}

const OSC_WT_IDX = [1, 2, 3].map(o => paramIndex(`osc${o}.wavetable`))
const CUSTOM_WT = WAVETABLE_NAMES.indexOf('Custom')

function abortRecordingError(): Error {
  const error = new Error('Recording aborted')
  error.name = 'AbortError'
  return error
}

function migrateLegacyDistortionParams(params: Record<string, number>): Record<string, number> {
  const legacyType = params['dist.type']
  if (params['dist.enabled'] !== undefined || legacyType === undefined) return params
  const legacyTypeIndex = Math.round(legacyType * DIST_TYPES.length)
  return {
    ...params,
    'dist.enabled': legacyTypeIndex > 0 ? 1 : 0,
    'dist.type': legacyTypeIndex > 0 ? (legacyTypeIndex - 1) / (DIST_TYPES.length - 1) : 0
  }
}

type ParamListener = (value: number) => void

export class SynthEngine {
  readonly values = defaultValues()
  readonly modSlots: (ModSlotState | null)[] = new Array(MAX_MOD_SLOTS).fill(null)
  readonly lfoShapes: LfoPoint[][] = Array.from({ length: 8 }, () => defaultLfoShape())
  fxOrder: number[] = DEFAULT_FX_ORDER.slice()

  /** live feedback from the worklet */
  scopeL: Float32Array = new Float32Array(1024)
  scopeR: Float32Array = new Float32Array(1024)
  sourceValues: Float32Array = new Float32Array(MOD_SOURCES.length)
  voiceCount = 0
  peakL = 0
  peakR = 0

  ctx: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private readonly paramListeners: (Set<ParamListener> | undefined)[] = new Array(NUM_PARAMS)
  private readonly matrixListeners = new Set<() => void>()
  private readonly patchListeners = new Set<(mutation: PatchMutation) => void>()
  private readonly tableListeners = new Set<(osc: number) => void>()
  private readonly fxOrderListeners = new Set<() => void>()
  private readonly soundListeners = new Set<(change: SoundChange) => void>()
  private batchDepth = 0
  private noiseSample: SoundSnapshot['noiseSample'] = null
  private readonly tableCache = new Map<string, Wavetable>()
  private readonly customTables: (Wavetable | null)[] = [null, null, null]
  /** main-thread copy of each osc's current table, for the 3D view */
  readonly currentTables: (Wavetable | null)[] = [null, null, null]

  readonly heldNotes = new Set<number>()
  private readonly defaultNoteOwner: NoteOwner = Symbol('default-note-owner')
  private readonly noteOwners = new Map<number, Set<NoteOwner>>()
  private noteListeners = new Set<(note: number, on: boolean) => void>()

  get running(): boolean {
    return this.ctx !== null
  }

  async start(): Promise<void> {
    if (this.ctx) return
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    await ctx.audioWorklet.addModule(processorUrl)
    const node = new AudioWorkletNode(ctx, 'soundgineer', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    })
    node.port.onmessage = e => this.onWorkletMessage(e.data as FromWorklet)
    node.connect(ctx.destination)
    this.ctx = ctx
    this.node = node
    await ctx.resume()
    this.syncAll()
  }

  private post(msg: ToWorklet, transfer?: Transferable[]): void {
    this.node?.port.postMessage(msg, transfer ?? [])
  }

  /** Push the complete current state to the worklet (startup / preset load). */
  private syncAll(): void {
    for (let i = 0; i < NUM_PARAMS; i++) this.post({ type: 'param', index: i, value: this.values[i] })
    for (let s = 0; s < MAX_MOD_SLOTS; s++) this.post({ type: 'mod', slot: s, state: this.modSlots[s] })
    for (let l = 0; l < 8; l++) this.post({ type: 'lfoShape', lfo: l, points: this.lfoShapes[l] })
    this.post({ type: 'fxOrder', order: this.fxOrder })
    for (let o = 0; o < 3; o++) this.sendWavetable(o)
    this.sendSample()
  }

  captureSoundState(): SoundSnapshot {
    return Object.freeze({
      values: Object.freeze(Array.from(this.values)),
      modSlots: Object.freeze(this.modSlots.map(slot => slot ? Object.freeze({ ...slot }) : null)),
      lfoShapes: Object.freeze(this.lfoShapes.map(shape => Object.freeze(shape.map(point => Object.freeze({ ...point }))))),
      fxOrder: Object.freeze(this.fxOrder.slice()),
      customTables: Object.freeze(this.customTables.slice()),
      noiseSample: this.noiseSample
    })
  }

  restoreSoundState(state: SoundSnapshot): void {
    this.batchSoundChange('Restore sound', () => {
      this.values.set(state.values)
      state.modSlots.forEach((slot, i) => { this.modSlots[i] = slot ? { ...slot } : null })
      state.lfoShapes.forEach((shape, i) => { this.lfoShapes[i] = shape.map(point => ({ ...point })) })
      this.fxOrder = [...state.fxOrder]
      state.customTables.forEach((table, i) => { this.customTables[i] = table })
      this.noiseSample = state.noiseSample
      // Clear the live iteration; history services restore its saved attribution.
      this.notifyPatch('human', [], true)
      this.allNotesOff()
      this.syncAll()
      for (let i = 0; i < NUM_PARAMS; i++) this.paramListeners[i]?.forEach(fn => fn(this.values[i]))
      this.notifyMatrix()
      this.fxOrderListeners.forEach(fn => fn())
    })
  }

  onSoundChange(fn: (change: SoundChange) => void): () => void {
    this.soundListeners.add(fn)
    return () => this.soundListeners.delete(fn)
  }

  batchSoundChange<T>(label: string, fn: () => T): T {
    const before = this.batchDepth === 0 ? this.captureSoundState() : null
    this.batchDepth++
    try { return fn() }
    finally {
      this.batchDepth--
      if (before) {
        const changed = changedSoundFields(before, this.captureSoundState())
        if (changed.length) this.notifySound({ label, changed, atomic: true })
      }
    }
  }

  private notifySound(change: SoundChange): void {
    if (this.batchDepth === 0) this.soundListeners.forEach(fn => fn(change))
  }

  private onWorkletMessage(msg: FromWorklet): void {
    switch (msg.type) {
      case 'scope':
        this.scopeL = msg.left
        this.scopeR = msg.right
        break
      case 'status':
        this.voiceCount = msg.voices
        this.peakL = msg.peakL
        this.peakR = msg.peakR
        this.sourceValues = msg.sources
        break
    }
  }

  // ------------------------------------------------------------ parameters

  onPatchChange(listener: (mutation: PatchMutation) => void): () => void {
    this.patchListeners.add(listener)
    return () => this.patchListeners.delete(listener)
  }

  private notifyPatch(origin: MutationOrigin, changes: PatchChange[], reset = false): void {
    const actual = changes.filter(change => !samePatchValue(change.before, change.after))
    if (!actual.length && !reset) return
    const mutation = structuredClone({ origin, changes: actual, reset })
    this.patchListeners.forEach(listener => listener(mutation))
  }

  setParam(index: number, value: number, options: { coalesceKey?: string; origin?: MutationOrigin } | MutationOrigin = 'human'): void {
    if (!Number.isInteger(index) || index < 0 || index >= NUM_PARAMS || !Number.isFinite(value)) return
    const origin = typeof options === 'string' ? options : options.origin ?? 'human'
    value = Math.fround(Math.max(0, Math.min(1, value)))
    if (this.values[index] === value) return
    const before = this.values[index]
    this.values[index] = value
    this.notifyPatch(origin, [{ kind: 'param', index, before, after: value }])
    this.post({ type: 'param', index, value })
    this.paramListeners[index]?.forEach(fn => fn(value))
    const osc = OSC_WT_IDX.indexOf(index)
    if (osc >= 0) this.sendWavetable(osc)
    this.notifySound({ label: `Change ${PARAMS[index].id}`, changed: [PARAMS[index].id],
      ...(typeof options === 'object' ? { coalesceKey: options.coalesceKey } : {}) })
  }

  setParamById(id: string, value: number, origin: MutationOrigin = 'human'): void {
    this.setParam(paramIndex(id), value, origin)
  }

  getParam(index: number): number {
    return this.values[index]
  }

  onParam(index: number, fn: ParamListener): () => void {
    let set = this.paramListeners[index]
    if (!set) {
      set = new Set()
      this.paramListeners[index] = set
    }
    set.add(fn)
    return () => set.delete(fn)
  }

  // ------------------------------------------------------------ wavetables

  private tableForOsc(osc: number): Wavetable {
    const sel = Math.round(this.values[OSC_WT_IDX[osc]] * (WAVETABLE_NAMES.length - 1))
    if (sel === CUSTOM_WT && this.customTables[osc]) return this.customTables[osc]!
    const name = WAVETABLE_NAMES[Math.min(sel, CUSTOM_WT - 1)] ?? WAVETABLE_NAMES[0]
    let t = this.tableCache.get(name)
    if (!t) {
      t = generateWavetable(name)
      this.tableCache.set(name, t)
    }
    return t
  }

  private sendWavetable(osc: number): void {
    const t = this.tableForOsc(osc)
    this.currentTables[osc] = t
    if (this.node) {
      const mips = buildMips(t.data, t.frameSize, t.numFrames)
      this.post({ type: 'wavetable', osc, frameSize: t.frameSize, numFrames: t.numFrames, mips }, [mips.buffer])
    }
    this.tableListeners.forEach(fn => fn(osc))
  }

  /** Generate current tables for the UI before audio has started. */
  primeTables(): void {
    for (let o = 0; o < 3; o++) this.sendWavetable(o)
  }

  onTableChange(fn: (osc: number) => void): () => void {
    this.tableListeners.add(fn)
    return () => this.tableListeners.delete(fn)
  }

  async importWavetableFile(osc: number, file: File): Promise<void> {
    const buf = await file.arrayBuffer()
    const wav = decodeWav(buf)
    const table = Object.freeze(wavToWavetable(file.name.replace(/\.wav$/i, ''), wav))
    this.batchSoundChange(`Import OSC ${osc + 1} wavetable`, () => {
      this.customTables[osc] = table
      // Changing an existing Custom slot still needs to upload the new asset.
      this.setParam(OSC_WT_IDX[osc], CUSTOM_WT / (WAVETABLE_NAMES.length - 1))
      this.sendWavetable(osc)
    })
  }

  async importSampleFile(file: File): Promise<void> {
    const buf = await file.arrayBuffer()
    const wav = decodeWav(buf)
    this.batchSoundChange('Import noise sample', () => {
      this.noiseSample = Object.freeze({ data: wav.channelData, sampleRate: wav.sampleRate })
      this.sendSample()
    })
  }

  private sendSample(): void {
    if (!this.node) return
    const data = this.noiseSample ? new Float32Array(this.noiseSample.data) : new Float32Array(0)
    this.post({ type: 'sample', data, sampleRate: this.noiseSample?.sampleRate ?? 44100 }, [data.buffer])
  }

  // ------------------------------------------------------------ mod matrix

  onMatrixChange(fn: () => void): () => void {
    this.matrixListeners.add(fn)
    return () => this.matrixListeners.delete(fn)
  }

  private notifyMatrix(): void {
    this.matrixListeners.forEach(fn => fn())
  }

  setModSlot(slot: number, state: ModSlotState | null, origin: MutationOrigin = 'human'): void {
    const before = this.modSlots[slot]
    if (samePatchValue(before, state)) return
    this.modSlots[slot] = state ? { ...state } : null
    this.notifyPatch(origin, [{ kind: 'route', index: slot, before, after: this.modSlots[slot] }])
    this.post({ type: 'mod', slot, state })
    this.notifyMatrix()
    this.notifySound({ label: 'Edit modulation route', changed: [`mod.${slot}`] })
  }

  /** Create (or reuse) a route source -> dest. Returns the slot, or -1 if full. */
  addModRoute(source: number, dest: number, depth = 0.25): number {
    const existing = this.modSlots.findIndex(s => s && s.source === source && s.dest === dest)
    if (existing >= 0) return existing
    const slot = this.modSlots.findIndex(s => s === null)
    if (slot < 0) return -1
    this.setModSlot(slot, { source, dest, depth, enabled: true })
    return slot
  }

  routesForDest(dest: number): { slot: number; state: ModSlotState }[] {
    const out: { slot: number; state: ModSlotState }[] = []
    this.modSlots.forEach((s, slot) => {
      if (s && s.dest === dest) out.push({ slot, state: s })
    })
    return out
  }

  // ------------------------------------------------------------ LFO shapes

  setLfoShape(lfo: number, points: LfoPoint[], origin: MutationOrigin = 'human'): void {
    const before = this.lfoShapes[lfo]
    if (samePatchValue(before, points)) return
    this.lfoShapes[lfo] = points.map(point => ({ ...point }))
    this.notifyPatch(origin, [{ kind: 'lfo', index: lfo, before, after: this.lfoShapes[lfo] }])
    this.post({ type: 'lfoShape', lfo, points })
    this.notifySound({ label: `Edit LFO ${lfo + 1} shape`, changed: [`lfo${lfo + 1}.shape`] })
  }

  // ------------------------------------------------------------ FX order

  setFxOrder(order: number[], origin: MutationOrigin = 'human'): void {
    const before = this.fxOrder
    if (samePatchValue(before, order)) return
    this.fxOrder = order.slice()
    this.notifyPatch(origin, [{ kind: 'fx', index: 0, before, after: this.fxOrder }])
    this.post({ type: 'fxOrder', order: this.fxOrder })
    this.fxOrderListeners.forEach(fn => fn())
    this.notifySound({ label: 'Reorder effects', changed: ['fx.order'] })
  }

  onFxOrder(fn: () => void): () => void {
    this.fxOrderListeners.add(fn)
    return () => this.fxOrderListeners.delete(fn)
  }

  // ------------------------------------------------------------ performance

  noteOn(note: number, velocity = 1, owner: NoteOwner = this.defaultNoteOwner): void {
    let owners = this.noteOwners.get(note)
    if (owners) {
      owners.add(owner)
      return
    }
    owners = new Set([owner])
    this.noteOwners.set(note, owners)
    this.heldNotes.add(note)
    this.post({ type: 'noteOn', note, velocity })
    this.noteListeners.forEach(fn => fn(note, true))
  }

  noteOff(note: number, owner: NoteOwner = this.defaultNoteOwner): void {
    const owners = this.noteOwners.get(note)
    if (!owners?.delete(owner) || owners.size > 0) return
    this.noteOwners.delete(note)
    this.heldNotes.delete(note)
    this.post({ type: 'noteOff', note })
    this.noteListeners.forEach(fn => fn(note, false))
  }

  onNote(fn: (note: number, on: boolean) => void): () => void {
    this.noteListeners.add(fn)
    return () => this.noteListeners.delete(fn)
  }

  sustain(down: boolean): void {
    this.post({ type: 'sustain', down })
  }
  pitchBend(v: number): void {
    this.post({ type: 'pitchBend', value: v })
  }
  modWheel(v: number): void {
    this.post({ type: 'modWheel', value: v })
  }
  aftertouch(v: number): void {
    this.post({ type: 'aftertouch', value: v })
  }
  allNotesOff(): void {
    const notes = [...this.heldNotes]
    this.noteOwners.clear()
    this.heldNotes.clear()
    this.post({ type: 'allNotesOff' })
    notes.forEach(note => this.noteListeners.forEach(fn => fn(note, false)))
  }

  /**
   * Tap and record the live worklet output. This intentionally runs in real
   * time: MediaRecorder captures the same graph that reaches the speakers.
   */
  async recordOutput(duration: number, signal?: AbortSignal): Promise<RecordedAudio> {
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Recording duration must be a positive finite number')
    const ctx = this.ctx
    const node = this.node
    if (!ctx || !node) throw new Error('Start audio before recording output')
    if (signal?.aborted) throw abortRecordingError()

    const destination = ctx.createMediaStreamDestination()
    let connected = false
    let recorder: MediaRecorder | undefined
    let started = false
    let stopRequested = false
    let stopped: Promise<Blob> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectWait: ((error: Error) => void) | undefined
    const aborted = () => rejectWait?.(abortRecordingError())

    try {
      node.connect(destination)
      connected = true

      const preferredTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
      const mimeType = preferredTypes.find(type => MediaRecorder.isTypeSupported(type))
      const activeRecorder = new MediaRecorder(destination.stream, mimeType ? { mimeType } : undefined)
      recorder = activeRecorder
      const chunks: Blob[] = []
      let settleStop!: (blob: Blob) => void
      let rejectStop!: (error: Error) => void
      const activeStopped = new Promise<Blob>((resolve, reject) => {
        settleStop = resolve
        rejectStop = reject
      })
      stopped = activeStopped
      // The stop/error promise can lose a race to cancellation or elapsed time,
      // so install a rejection consumer before starting the recorder.
      void activeStopped.catch(() => undefined)
      activeRecorder.ondataavailable = event => { if (event.data.size > 0) chunks.push(event.data) }
      activeRecorder.onerror = () => rejectStop(new Error('MediaRecorder failed while capturing output'))
      activeRecorder.onstop = () => settleStop(new Blob(chunks, { type: activeRecorder.mimeType || mimeType || 'audio/webm' }))

      activeRecorder.start()
      started = true
      const elapsed = new Promise<void>((resolve, reject) => {
        rejectWait = reject
        timer = setTimeout(resolve, duration * 1000)
        signal?.addEventListener('abort', aborted, { once: true })
      })
      await Promise.race([elapsed, activeStopped.then(() => undefined)])
      if (activeRecorder.state !== 'inactive') {
        activeRecorder.stop()
        stopRequested = true
      }
      const blob = await activeStopped
      const encoded = await blob.arrayBuffer()
      if (signal?.aborted) throw abortRecordingError()
      const decoded = await ctx.decodeAudioData(encoded)
      if (signal?.aborted) throw abortRecordingError()
      const channelData = Array.from({ length: decoded.numberOfChannels }, (_, channel) =>
        new Float32Array(decoded.getChannelData(channel)))
      return {
        blob,
        mimeType: blob.type || activeRecorder.mimeType || mimeType || 'audio/webm',
        duration: decoded.duration,
        sampleRate: decoded.sampleRate,
        channelData
      }
    } catch (error) {
      if (started && recorder?.state !== 'inactive' && !stopRequested) {
        try {
          recorder?.stop()
          stopRequested = true
        } catch {
          // A synchronous stop failure cannot produce a reliable stop event.
        }
      }
      if (started && stopRequested && stopped) await stopped.catch(() => undefined)
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      if (recorder) {
        recorder.ondataavailable = null
        recorder.onerror = null
        recorder.onstop = null
      }
      for (const track of destination.stream.getTracks()) {
        try { track.stop() } catch { /* best-effort teardown */ }
      }
      if (connected) {
        try { node.disconnect(destination) } catch { /* best-effort teardown */ }
      }
    }
  }

  // ------------------------------------------------------------ presets

  toPreset(name: string): PresetData {
    const params: Record<string, number> = {}
    for (let i = 0; i < NUM_PARAMS; i++) params[PARAMS[i].id] = this.values[i]
    const mods = this.modSlots
      .filter((s): s is ModSlotState => s !== null)
      .map(s => ({
        source: MOD_SOURCES[s.source].id,
        dest: PARAMS[s.dest].id,
        depth: s.depth,
        enabled: s.enabled
      }))
    return {
      name,
      version: 1,
      params,
      mods,
      lfoShapes: this.lfoShapes.map(pts => pts.map(p => ({ ...p }))),
      fxOrder: this.fxOrder.map(i => FX_IDS[i])
    }
  }

  loadPreset(preset: Partial<PresetData>, origin: MutationOrigin = 'human'): void {
    this.batchSoundChange(`Load preset${preset.name ? ` ${preset.name}` : ''}`, () => this.applyPreset(preset, origin))
  }

  private applyPreset(preset: Partial<PresetData>, origin: MutationOrigin): void {
    const beforeParams = this.values.slice()
    const beforeRoutes = structuredClone(this.modSlots)
    const beforeShapes = structuredClone(this.lfoShapes)
    const beforeOrder = this.fxOrder.slice()
    // reset to defaults first so presets don't need every param
    const defs = defaultValues()
    this.values.set(defs)
    if (preset.params) {
      const params = migrateLegacyDistortionParams(preset.params)
      for (const [id, v] of Object.entries(params)) {
        try {
          this.values[paramIndex(id)] = Math.max(0, Math.min(1, v))
        } catch {
          /* unknown param in preset: ignore */
        }
      }
    }
    this.modSlots.fill(null)
    if (preset.mods) {
      preset.mods.slice(0, MAX_MOD_SLOTS).forEach((m, i) => {
        try {
          this.modSlots[i] = {
            source: modSourceIndex(m.source),
            dest: paramIndex(m.dest),
            depth: m.depth,
            enabled: m.enabled
          }
        } catch {
          /* unknown source/dest: ignore */
        }
      })
    }
    for (let l = 0; l < 8; l++) {
      this.lfoShapes[l] = preset.lfoShapes?.[l]?.length ? preset.lfoShapes[l].map(p => ({ ...p })) : defaultLfoShape()
    }
    this.fxOrder = preset.fxOrder
      ? preset.fxOrder.map(id => FX_IDS.indexOf(id as (typeof FX_IDS)[number])).filter(i => i >= 0)
      : DEFAULT_FX_ORDER.slice()
    if (this.fxOrder.length !== FX_IDS.length) this.fxOrder = DEFAULT_FX_ORDER.slice()

    this.notifyPatch(origin, [
      ...Array.from(this.values, (after, index): PatchChange => ({ kind: 'param', index, before: beforeParams[index], after })),
      ...this.modSlots.map((after, index): PatchChange => ({ kind: 'route', index, before: beforeRoutes[index], after })),
      ...this.lfoShapes.map((after, index): PatchChange => ({ kind: 'lfo', index, before: beforeShapes[index], after })),
      { kind: 'fx', index: 0, before: beforeOrder, after: this.fxOrder }
    ], origin === 'human')

    this.allNotesOff()
    if (this.node) this.syncAll()
    else for (let o = 0; o < 3; o++) this.sendWavetable(o) // still update UI table views
    for (let i = 0; i < NUM_PARAMS; i++) this.paramListeners[i]?.forEach(fn => fn(this.values[i]))
    this.notifyMatrix()
    this.fxOrderListeners.forEach(fn => fn())
  }
}
