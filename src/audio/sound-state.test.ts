import { afterEach, describe, expect, it, vi } from 'vitest'
import { SynthEngine, soundStateAssets } from './engine'
import { HistoryStore } from '../history/store'
import { paramIndex } from '../shared/params'
import type { ToWorklet } from '../shared/messages'

function wavFile(name = 'sample.wav', amplitude = 0.5): File {
  const samples = 2048
  const buffer = new ArrayBuffer(44 + samples * 2)
  const view = new DataView(buffer)
  const ascii = (offset: number, text: string) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)))
  ascii(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); ascii(8, 'WAVE')
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, 1, true); view.setUint32(24, 48000, true)
  view.setUint32(28, 96000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  ascii(36, 'data'); view.setUint32(40, samples * 2, true)
  for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(i / samples * Math.PI * 2) * 32767 * amplitude), true)
  return { name, arrayBuffer: async () => buffer } as File
}

afterEach(() => vi.unstubAllGlobals())

describe('sound state snapshots', () => {
  it('freezes structural snapshots, preserves empty modulation slots, and restores all structured state', () => {
    const engine = new SynthEngine()
    engine.setParamById('filter1.cutoff', 0.4)
    const route = { source: 2, dest: paramIndex('filter1.cutoff'), depth: 0.2, enabled: false }
    engine.setModSlot(19, route)
    engine.setLfoShape(3, [{ x: 0, y: 0.2, power: 0.5 }, { x: 1, y: 0.8, power: 0 }])
    engine.setFxOrder(engine.fxOrder.slice().reverse())
    const saved = engine.captureSoundState()
    expect(saved.modSlots).toHaveLength(32)
    expect(saved.modSlots[18]).toBeNull()
    expect(saved.modSlots[19]).toEqual(route)
    expect(Object.isFrozen(saved)).toBe(true)
    expect(Object.isFrozen(saved.values)).toBe(true)
    expect(Object.isFrozen(saved.lfoShapes[3][0])).toBe(true)
    route.depth = 0.9
    expect(saved.modSlots[19]?.depth).toBe(0.2)
    engine.loadPreset({ params: {} })
    const fxListener = vi.fn()
    const matrixListener = vi.fn()
    const paramListener = vi.fn()
    engine.onFxOrder(fxListener)
    engine.onMatrixChange(matrixListener)
    engine.onParam(paramIndex('filter1.cutoff'), paramListener)
    engine.restoreSoundState(saved)
    expect(engine.captureSoundState()).toEqual(saved)
    expect(fxListener).toHaveBeenCalledOnce()
    expect(matrixListener).toHaveBeenCalledOnce()
    expect(paramListener).toHaveBeenCalledWith(saved.values[paramIndex('filter1.cutoff')])
  })

  it('notifies actual setters and batches nested changes once, including net no-op suppression', () => {
    const engine = new SynthEngine()
    const changed = vi.fn()
    const unsubscribe = engine.onSoundChange(changed)
    const index = paramIndex('macro1.value')
    engine.setParam(index, 0.4, { coalesceKey: 'midi:macro1' })
    engine.setParam(index, 0.4)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed.mock.calls[0][0]).toMatchObject({ changed: ['macro1.value'], coalesceKey: 'midi:macro1' })
    engine.batchSoundChange('Grouped action', () => {
      engine.setParam(index, 0.8)
      engine.batchSoundChange('Inner action', () => engine.setParamById('macro2.value', 0.2))
    })
    expect(changed).toHaveBeenCalledTimes(2)
    expect(changed.mock.calls[1][0]).toEqual({ label: 'Grouped action', changed: ['macro1.value', 'macro2.value'], atomic: true })
    engine.batchSoundChange('No-op', () => {
      engine.setParam(index, 0)
      engine.setParam(index, 0.8)
    })
    engine.setFxOrder(engine.fxOrder)
    engine.setLfoShape(0, engine.lfoShapes[0])
    engine.setModSlot(0, null)
    expect(changed).toHaveBeenCalledTimes(2)
    unsubscribe()
    engine.setParam(index, 0)
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('loads presets as one action and ignores identical loads', () => {
    const engine = new SynthEngine()
    const changed = vi.fn()
    engine.onSoundChange(changed)
    const preset = { name: 'Warm', params: { 'macro1.value': 0.25, 'macro2.value': 0.5 } }
    engine.loadPreset(preset)
    engine.loadPreset(preset)
    expect(changed).toHaveBeenCalledOnce()
    expect(changed.mock.calls[0][0].label).toBe('Load preset Warm')
    expect(changed.mock.calls[0][0].changed).toEqual(['macro1.value', 'macro2.value'])
  })

  it('retains imported sample data before audio, shares asset identities, and transfers only copies', async () => {
    const engine = new SynthEngine()
    const initial = engine.captureSoundState()
    const changed = vi.fn()
    engine.onSoundChange(changed)
    await engine.importSampleFile(wavFile())
    const saved = engine.captureSoundState()
    expect(saved.noiseSample?.sampleRate).toBe(48000)
    expect(saved.noiseSample?.data.length).toBe(2048)
    expect(engine.captureSoundState().noiseSample).toBe(saved.noiseSample)
    expect(soundStateAssets(saved)).toEqual([saved.noiseSample!.data.buffer])
    expect(changed).toHaveBeenCalledOnce()

    const messages: ToWorklet[] = []
    vi.stubGlobal('AudioContext', class {
      audioWorklet = { addModule: async () => undefined }
      destination = {}
      resume = async () => undefined
    })
    vi.stubGlobal('AudioWorkletNode', class {
      port = { postMessage: (message: ToWorklet, transfer: Transferable[]) => {
        messages.push(structuredClone(message, { transfer }))
      } }
      connect() {}
    })
    await engine.start()
    const uploaded = messages.filter(message => message.type === 'sample').at(-1)!
    expect(uploaded.type).toBe('sample')
    if (uploaded.type === 'sample') {
      expect(uploaded.data).toEqual(saved.noiseSample!.data)
      expect(uploaded.data.buffer).not.toBe(saved.noiseSample!.data.buffer)
    }
    expect(saved.noiseSample!.data.byteLength).toBe(4096 * 2)
    engine.restoreSoundState(initial)
    const cleared = messages.filter(message => message.type === 'sample').at(-1)!
    expect(cleared.type === 'sample' && cleared.data.length).toBe(0)
    engine.restoreSoundState(saved)
    expect(engine.captureSoundState().noiseSample).toBe(saved.noiseSample)
    expect(saved.noiseSample!.data.length).toBe(2048)
  })

  it('retains both replacements of a Custom wavetable and restores their visualizer references', async () => {
    const engine = new SynthEngine()
    const changed = vi.fn()
    engine.onSoundChange(changed)
    await engine.importWavetableFile(0, wavFile('first.wav'))
    const first = engine.captureSoundState()
    await engine.importWavetableFile(0, wavFile('second.wav', 0.7))
    const second = engine.captureSoundState()
    expect(changed).toHaveBeenCalledTimes(2)
    expect(first.customTables[0]).not.toBe(second.customTables[0])
    expect(soundStateAssets(first)[0]).toBe(first.customTables[0]!.data.buffer)
    engine.restoreSoundState(first)
    expect(engine.currentTables[0]).toBe(first.customTables[0])
    engine.restoreSoundState(second)
    expect(engine.currentTables[0]).toBe(second.customTables[0])
  })

  it('separates a pending MIDI gesture from an import that finishes decoding later', async () => {
    const engine = new SynthEngine()
    const history = new HistoryStore({
      capture: () => engine.captureSoundState(),
      restore: state => engine.restoreSoundState(state),
      equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      assets: soundStateAssets,
      subscribe: listener => engine.onSoundChange(listener)
    }, async () => {})
    const bytes = await wavFile().arrayBuffer()
    let decoded!: (bytes: ArrayBuffer) => void
    const pendingImport = engine.importSampleFile({ name: 'slow.wav', arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { decoded = resolve }) } as File)
    engine.setParam(paramIndex('macro1.value'), 0.7, { coalesceKey: 'midi:macro1' })
    expect(history.snapshot().gestureActive).toBe(true)
    decoded(bytes)
    await pendingImport
    expect(history.snapshot().entries).toHaveLength(3)
    expect(history.snapshot().entries[1].changed).toEqual(['macro1.value'])
    expect(history.snapshot().entries[2]).toMatchObject({ label: 'Import noise sample', changed: ['noise.sample'] })
    await history.navigate('undo')
    expect(engine.captureSoundState().noiseSample).toBeNull()
    expect(engine.getParam(paramIndex('macro1.value'))).toBe(Math.fround(0.7))
    await history.navigate('undo')
    expect(engine.getParam(paramIndex('macro1.value'))).toBe(0)
    await history.navigate('redo')
    await history.navigate('redo')
    expect(engine.captureSoundState().noiseSample?.data.length).toBe(2048)
    history.dispose()
  })

  it('notifies note-off observers for every released note', () => {
    const engine = new SynthEngine()
    const notes = vi.fn()
    engine.onNote(notes)
    engine.noteOn(48)
    engine.noteOn(55)
    engine.allNotesOff()
    expect(notes.mock.calls).toEqual([[48, true], [55, true], [48, false], [55, false]])
    expect(engine.heldNotes.size).toBe(0)
  })
})
