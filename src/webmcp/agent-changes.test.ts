// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SynthEngine } from '../audio/engine'
import { paramIndex } from '../shared/params'
import { modSourceIndex } from '../shared/messages'
import { agentActivityFor } from './activity'
import { createWebMcpTools } from './tools'
import { savePreset } from '../shared/preset-store'

function setup() {
  const engine = new SynthEngine()
  const store = agentActivityFor(engine)
  const tools = createWebMcpTools(engine)
  const call = (name: string, input: Record<string, unknown>) => tools.find(tool => tool.name === name)!
    .execute(input, { signal: new AbortController().signal })
  return { engine, store, call }
}

const route = () => ({ source: modSourceIndex('env2'), dest: paramIndex('filter1.cutoff'), depth: 0.3, enabled: true })
afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks() })

describe('AI patch ownership', () => {
  it('compares stored float32 values and does not checkpoint no-ops', () => {
    const { engine, store } = setup()
    engine.setParamById('osc1.morph', 0.2)
    engine.setParamById('osc1.morph', 0.2, 'ai')
    expect(store.snapshot().checkpointAvailable).toBe(false)
    engine.setParamById('osc1.morph', 0.4, 'ai')
    const first = store.snapshot().pendingChanges[0]
    engine.setParamById('osc1.morph', 0.7, 'ai')
    expect(store.snapshot().pendingChanges[0]).toMatchObject({ before: Math.fround(0.2), after: Math.fround(0.7) })
    expect(store.snapshot().pendingChanges[0].revision).toBeGreaterThan(first.revision)
    engine.setParamById('osc1.morph', 0.2, 'ai')
    expect(store.snapshot()).toMatchObject({ pendingChanges: [], checkpointAvailable: false })
  })

  it('lets humans take ownership and uses their next value as the baseline', () => {
    const { engine, store } = setup()
    engine.setParamById('osc1.morph', 0.4, 'ai')
    engine.setParamById('osc1.morph', 0.6)
    expect(store.snapshot().pendingChanges).toEqual([])
    engine.setParamById('osc1.morph', 0.9, 'ai')
    engine.setParamById('osc2.morph', 0.8)
    expect(store.snapshot().pendingChanges[0].before).toBe(Math.fround(0.6))
    expect(store.restoreCheckpoint()).toBe(true)
    expect(engine.getParam(paramIndex('osc1.morph'))).toBe(Math.fround(0.6))
    expect(engine.getParam(paramIndex('osc2.morph'))).toBe(Math.fround(0.8))
  })

  it('restores sparse routes without compaction and preserves manually edited routes', () => {
    const { engine, store } = setup()
    engine.setModSlot(7, route())
    engine.setModSlot(7, null, 'ai')
    engine.setModSlot(11, route(), 'ai')
    engine.setModSlot(11, { ...route(), depth: 0.8 })
    engine.setModSlot(15, route(), 'ai')
    store.restoreCheckpoint()
    expect(engine.modSlots[7]).toEqual(route())
    expect(engine.modSlots[11]?.depth).toBe(0.8)
    expect(engine.modSlots[15]).toBeNull()
    expect(engine.modSlots[0]).toBeNull()
  })

  it('handles slot reuse and returning a route to its exact baseline', () => {
    const { engine, store } = setup()
    engine.setModSlot(3, route())
    engine.setModSlot(3, null, 'ai')
    engine.setModSlot(3, { ...route(), depth: -0.4 }, 'ai')
    expect(store.snapshot().pendingChanges).toHaveLength(1)
    engine.setModSlot(3, route(), 'ai')
    expect(store.snapshot().pendingChanges).toEqual([])
    engine.setModSlot(3, null, 'ai')
    engine.setModSlot(3, { ...route(), depth: 0.1 })
    expect(store.restoreCheckpoint()).toBe(false)
    expect(engine.modSlots[3]?.depth).toBe(0.1)
  })

  it('treats LFO shapes and FX ordering as whole ownership units', () => {
    const { engine, store } = setup()
    const originalShape = structuredClone(engine.lfoShapes[1])
    const originalOrder = [...engine.fxOrder]
    const changedShape = [{ x: 0, y: 0.3, power: 0 }, { x: 1, y: 0.9, power: 0 }]
    engine.setLfoShape(1, changedShape, 'ai')
    engine.setFxOrder([...originalOrder].reverse(), 'ai')
    store.restoreCheckpoint()
    expect(engine.lfoShapes[1]).toEqual(originalShape)
    expect(engine.fxOrder).toEqual(originalOrder)
    engine.setLfoShape(1, changedShape, 'ai')
    engine.setFxOrder([...originalOrder].reverse(), 'ai')
    engine.setLfoShape(1, [{ ...changedShape[0], y: 0.2 }, changedShape[1]])
    const humanOrder = [...originalOrder.slice(1), originalOrder[0]]
    engine.setFxOrder(humanOrder)
    engine.setParamById('osc1.morph', 0.5, 'ai')
    store.restoreCheckpoint()
    expect(engine.lfoShapes[1][0].y).toBe(0.2)
    expect(engine.fxOrder).toEqual(humanOrder)
  })

  it('captures every patch category for AI preset load, but human load clears the iteration', async () => {
    const { engine, store, call } = setup()
    const original = engine.toPreset('Original')
    const preset = engine.toPreset('Agent patch')
    preset.params['osc1.morph'] = 0.6
    preset.mods = [{ source: 'env2', dest: 'filter1.cutoff', depth: 0.3, enabled: true }]
    preset.lfoShapes[0][0].y = 0.2
    preset.fxOrder.reverse()
    savePreset(preset)
    await call('load_preset', { name: preset.name })
    expect(new Set(store.snapshot().pendingChanges.map(change => change.kind))).toEqual(new Set(['param', 'route', 'lfo', 'fx']))
    store.restoreCheckpoint()
    expect(engine.toPreset('Original')).toEqual(original)
    await call('load_preset', { name: preset.name })
    engine.loadPreset(preset)
    expect(store.snapshot()).toMatchObject({ pendingChanges: [], comparison: null, checkpointAvailable: false })
  })

  it('tracks actual WebMCP parameter and every route operation', async () => {
    const { engine, store, call } = setup()
    await call('update_parameters', { updates: [{ id: 'osc1.morph', value: 0 }] })
    expect(store.snapshot().checkpointAvailable).toBe(false)
    await call('update_parameters', { updates: [{ id: 'osc1.morph', value: 0.4 }] })
    expect(store.snapshot().changedParameters).toEqual(['osc1.morph'])
    store.acceptCheckpoint()
    await call('set_modulation', { action: 'add', source: 'env2', destination: 'filter1.cutoff', depth: 0.3 })
    expect(store.snapshot().pendingChanges[0].kind).toBe('route')
    store.acceptCheckpoint()
    await call('set_modulation', { action: 'update', slot: 0, depth: 0.7 })
    expect(store.snapshot().pendingChanges[0].after).toMatchObject({ depth: 0.7 })
    await call('set_modulation', { action: 'remove', slot: 0 })
    expect(store.snapshot().pendingChanges[0].after).toBeNull()
    store.restoreCheckpoint()
    expect(engine.modSlots[0]?.depth).toBe(0.3)
    engine.setModSlot(8, route())
    await call('set_modulation', { action: 'clear' })
    expect(store.snapshot().pendingChanges).toHaveLength(2)
    store.restoreCheckpoint()
    expect(engine.modSlots[8]).toEqual(route())
  })

  it('clears markers and comparison on Keep and preserves the visibility preference', () => {
    const { engine, store } = setup()
    engine.setParamById('osc1.morph', 0.3, 'ai')
    store.finishAction(store.startAction('compare_audio'), 'compare_audio', {}, { comparison: { similarity: 0.8, details: {} } })
    store.setShowChanges(false)
    expect(store.snapshot().pendingChanges).toHaveLength(1)
    expect(store.acceptCheckpoint()).toBe(true)
    expect(store.snapshot()).toMatchObject({ pendingChanges: [], changedParameters: [], comparison: null, showChanges: false })
  })

  it('does not attribute human edits made during long actions or trust claimed applied IDs', () => {
    const { engine, store } = setup()
    const id = store.startAction('render_audio')
    engine.setParamById('osc1.morph', 0.6)
    store.finishAction(id, 'render_audio', {}, { duration: 1 })
    store.finishAction(store.startAction('update_parameters'), 'update_parameters', {}, { applied: [{ id: 'osc1.morph' }] })
    expect(store.snapshot().pendingChanges).toEqual([])
  })

  it('copies pending data, ignores human no-ops, and stops listening on disposal', () => {
    const { engine, store } = setup()
    engine.setModSlot(3, route(), 'ai')
    const snapshot = store.snapshot()
    if (snapshot.pendingChanges[0].kind === 'route') snapshot.pendingChanges[0].after!.depth = 0.8
    engine.setModSlot(3, route())
    expect(store.snapshot().pendingChanges[0].after).toMatchObject({ depth: 0.3 })
    const listener = vi.fn()
    store.subscribe(listener)
    store.dispose()
    listener.mockClear()
    engine.setParamById('osc1.morph', 0.6, 'ai')
    expect(listener).not.toHaveBeenCalled()
  })
})
