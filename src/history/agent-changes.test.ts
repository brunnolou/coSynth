// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SynthEngine } from '../audio/engine'
import { paramIndex } from '../shared/params'
import { modSourceIndex } from '../shared/messages'
import { agentActivityFor } from '../webmcp/activity'
import { registerWebMcpTools } from '../webmcp/register'
import { UiGuideController } from '../ui/guide'
import { createHistoryServices } from './services'
import { AgentHighlights } from '../ui/agent-highlights'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(dispose => dispose()); document.body.replaceChildren(); vi.restoreAllMocks() })

async function setup() {
  const engine = new SynthEngine()
  const app = document.createElement('main')
  document.body.append(app)
  const guide = new UiGuideController(app)
  const services = createHistoryServices(engine, guide)
  const activity = agentActivityFor(engine)
  const tools = new Map<string, WebMCP.ModelContextTool>()
  const registration = registerWebMcpTools(engine, {
    registerTool(tool: WebMCP.ModelContextTool) { tools.set(tool.name, tool) }
  } as WebMCP.ModelContext, { services, guide })
  await registration.ready
  cleanups.push(() => { registration.dispose(); services.dispose(); activity.dispose(); guide.dispose() })
  const call = (name: string, input: Record<string, unknown>) => tools.get(name)!.execute(input, { signal: new AbortController().signal })
  return { engine, activity, app, ...services, call }
}

describe('AI changes alongside unified sound history', () => {
  it('records a batch once, rejects only AI-owned values, and can undo/redo rejection', async () => {
    const { engine, activity, history, call } = await setup()
    const attack = engine.getParam(paramIndex('env1.attack'))
    await call('update_parameters', { updates: [
      { id: 'osc1.morph', value: 0.6 }, { id: 'env1.attack', value: 0.15 }, { id: 'dist.enabled', value: 1 }
    ] })
    expect(history.snapshot().entries).toHaveLength(2)
    expect(history.snapshot().entries[1]).toMatchObject({ origin: 'ai', changed: ['osc1.morph', 'env1.attack', 'dist.enabled'] })
    expect(activity.snapshot().pendingChanges).toHaveLength(3)
    engine.setParamById('osc1.morph', 0.8)
    expect(activity.snapshot().pendingChanges).toHaveLength(2)
    expect(activity.restoreCheckpoint()).toBe(true)
    expect(history.snapshot().entries).toHaveLength(4)
    expect(history.snapshot().entries[3]).toMatchObject({ origin: 'human', label: 'Reject AI changes' })
    expect(engine.getParam(paramIndex('osc1.morph'))).toBe(Math.fround(0.8))
    expect(engine.getParam(paramIndex('env1.attack'))).toBe(attack)
    expect(engine.getParam(paramIndex('dist.enabled'))).toBe(0)
    await history.navigate('undo')
    expect(engine.getParam(paramIndex('dist.enabled'))).toBe(1)
    expect(engine.getParam(paramIndex('osc1.morph'))).toBe(Math.fround(0.8))
    expect(activity.snapshot().pendingChanges.map(change => change.index)).toEqual([
      paramIndex('env1.attack'), paramIndex('dist.enabled')
    ])
    await history.navigate('redo')
    expect(engine.getParam(paramIndex('dist.enabled'))).toBe(0)
    expect(activity.snapshot().pendingChanges).toEqual([])
  })

  it('preserves sparse slots and structural ownership in a single reject history entry', async () => {
    const { engine, activity, history } = await setup()
    const route = { source: modSourceIndex('env2'), dest: paramIndex('filter1.cutoff'), depth: 0.3, enabled: true }
    engine.setModSlot(7, route)
    const before = engine.captureSoundState()
    history.runAi('Structural changes', () => {
      engine.setModSlot(7, null, 'ai')
      engine.setModSlot(15, route, 'ai')
      engine.setLfoShape(0, [{ x: 0, y: 1, power: 0 }, { x: 1, y: 0, power: 0 }], 'ai')
      engine.setFxOrder([...engine.fxOrder].reverse(), 'ai')
    })
    engine.setModSlot(15, { ...route, depth: 0.8 })
    const count = history.snapshot().entries.length
    expect(activity.restoreCheckpoint()).toBe(true)
    expect(history.snapshot().entries).toHaveLength(count + 1)
    expect(engine.modSlots[7]).toEqual(route)
    expect(engine.modSlots[15]?.depth).toBe(0.8)
    expect(engine.modSlots[0]).toBeNull()
    expect(engine.lfoShapes[0]).toEqual(before.lfoShapes[0])
    expect(engine.fxOrder).toEqual(before.fxOrder)
    await history.navigate('undo')
    expect(engine.modSlots[7]).toBeNull()
    expect(engine.modSlots[15]?.depth).toBe(0.8)
    expect(activity.snapshot().pendingChanges.map(change => change.kind)).toEqual(['route', 'lfo', 'fx'])
  })

  it('restores the dot on Undo of a manual edit without replaying its arrival animation', async () => {
    const { engine, activity, history, call, app } = await setup()
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 10, bottom: 60, left: 10, right: 60 } as DOMRect)
    const knob = document.createElement('div')
    knob.dataset.guideId = 'param.osc1.morph'
    app.append(knob)
    const highlights = new AgentHighlights(app, activity)
    cleanups.push(() => highlights.dispose())
    await call('update_parameters', { updates: [{ id: 'osc1.morph', value: 0.6 }] })
    const aiChanges = activity.snapshot().pendingChanges
    expect(knob.classList.contains('ai-change-pulse')).toBe(true)
    history.beginGesture('Turn morph')
    engine.setParamById('osc1.morph', 0.7)
    engine.setParamById('osc1.morph', 0.8)
    history.endGesture()
    await Promise.resolve()
    expect(knob.classList.contains('ai-changed')).toBe(false)
    await history.navigate('undo')
    expect(engine.getParam(paramIndex('osc1.morph'))).toBe(Math.fround(0.6))
    expect(activity.snapshot().pendingChanges).toEqual(aiChanges)
    expect(knob.classList.contains('ai-changed')).toBe(true)
    expect(knob.classList.contains('ai-change-pulse')).toBe(false)
    await history.navigate('redo')
    expect(engine.getParam(paramIndex('osc1.morph'))).toBe(Math.fround(0.8))
    expect(knob.classList.contains('ai-changed')).toBe(false)
  })

  it('restores route, LFO and FX ownership while preserving manual edits to other units', async () => {
    const { engine, activity, history } = await setup()
    const route = { source: modSourceIndex('env2'), dest: paramIndex('filter1.cutoff'), depth: 0.3, enabled: true }
    history.runAi('Structural changes', () => {
      engine.setModSlot(15, route, 'ai')
      engine.setLfoShape(0, [{ x: 0, y: 1, power: 0 }, { x: 1, y: 0, power: 0 }], 'ai')
      engine.setFxOrder([...engine.fxOrder].reverse(), 'ai')
    })
    const aiChanges = activity.snapshot().pendingChanges
    engine.setParamById('osc1.morph', 0.9)
    engine.batchSoundChange('Manual structural changes', () => {
      engine.setModSlot(15, null)
      engine.setLfoShape(0, [{ x: 0, y: 0.3, power: 0 }, { x: 1, y: 0.6, power: 0 }])
      engine.setFxOrder([...engine.fxOrder].reverse())
    })
    expect(activity.snapshot().pendingChanges).toEqual([])
    await history.navigate('undo')
    expect(activity.snapshot().pendingChanges).toEqual(aiChanges)
    expect(engine.modSlots[15]).toEqual(route)
    expect(engine.modSlots[0]).toBeNull()
    expect(engine.getParam(paramIndex('osc1.morph'))).toBe(Math.fround(0.9))
    await history.navigate('redo')
    expect(activity.snapshot().pendingChanges).toEqual([])
  })

  it('does not resurrect accepted markers and uses the new baseline for later AI changes', async () => {
    const { engine, activity, history, call } = await setup()
    await call('update_parameters', { updates: [{ id: 'osc1.morph', value: 0.6 }] })
    activity.acceptCheckpoint()
    engine.setParamById('osc1.morph', 0.8)
    await history.navigate('undo')
    expect(activity.snapshot().pendingChanges).toEqual([])
    await history.navigate('undo')
    await history.navigate('redo')
    expect(activity.snapshot().pendingChanges).toEqual([])
    await call('update_parameters', { updates: [{ id: 'osc1.morph', value: 0.9 }] })
    expect(activity.snapshot().pendingChanges[0].before).toBe(Math.fround(0.6))
    engine.setParamById('osc1.morph', 0.7)
    await history.navigate('undo')
    expect(activity.snapshot().pendingChanges[0]).toMatchObject({ before: Math.fround(0.6), after: Math.fround(0.9) })
    expect(activity.restoreCheckpoint()).toBe(true)
    expect(engine.getParam(paramIndex('osc1.morph'))).toBe(Math.fround(0.6))
  })

  it('restores attribution with historical alternatives and an undone human preset load', async () => {
    const { engine, activity, history, call } = await setup()
    await call('update_parameters', { updates: [{ id: 'osc1.morph', value: 0.6 }] })
    const aiId = history.snapshot().currentId
    const aiChanges = activity.snapshot().pendingChanges
    engine.loadPreset({ name: 'Manual preset' })
    expect(activity.snapshot().pendingChanges).toEqual([])
    await history.navigate('undo')
    expect(activity.snapshot().pendingChanges).toEqual(aiChanges)
    await history.navigate('undo')
    engine.setParamById('osc1.morph', 0.8)
    const manualId = history.snapshot().currentId
    await history.navigate('restore', aiId)
    expect(activity.snapshot().pendingChanges).toEqual(aiChanges)
    await history.navigate('restore', manualId)
    expect(activity.snapshot().pendingChanges).toEqual([])
  })

  it('keeps without adding sound history and ignores no-op AI writes', async () => {
    const { activity, history, call } = await setup()
    await call('update_parameters', { updates: [{ id: 'osc1.morph', value: 0 }] })
    expect(history.snapshot().entries).toHaveLength(1)
    expect(activity.snapshot().pendingChanges).toEqual([])
    await call('update_parameters', { updates: [{ id: 'osc1.morph', value: 0.6 }] })
    expect(activity.acceptCheckpoint()).toBe(true)
    expect(history.snapshot().entries).toHaveLength(2)
    expect(activity.snapshot().pendingChanges).toEqual([])
  })

  it('retains human gesture coalescing and blocks AI changes/review during a gesture', async () => {
    const { engine, activity, history, call } = await setup()
    await call('update_parameters', { updates: [{ id: 'osc1.morph', value: 0.6 }] })
    const level = paramIndex('osc1.level')
    engine.setParam(level, 0.2, { coalesceKey: 'midi.level' })
    engine.setParam(level, 0.3, { coalesceKey: 'midi.level' })
    expect(history.snapshot().gestureActive).toBe(true)
    expect(activity.acceptCheckpoint()).toBe(false)
    expect(activity.restoreCheckpoint()).toBe(false)
    expect(await call('update_parameters', { updates: [{ id: 'osc1.morph', value: 0.9 }] }))
      .toMatchObject({ ok: false, error: { code: 'history_busy' } })
    history.endGesture()
    expect(history.snapshot().entries).toHaveLength(3)
    expect(activity.restoreCheckpoint()).toBe(true)
    expect(engine.getParam(level)).toBe(Math.fround(0.3))
  })

  it('blocks review during replay and during history navigation', async () => {
    const { activity, history, performance, call } = await setup()
    await call('update_parameters', { updates: [{ id: 'osc1.morph', value: 0.6 }] })
    let finish!: () => void
    const playing = performance.run(() => new Promise<void>(resolve => { finish = resolve }))
    await Promise.resolve()
    expect(activity.acceptCheckpoint()).toBe(false)
    expect(activity.restoreCheckpoint()).toBe(false)
    finish()
    await playing
    const navigating = history.navigate('undo')
    expect(activity.acceptCheckpoint()).toBe(false)
    expect(activity.restoreCheckpoint()).toBe(false)
    await navigating
    expect(activity.snapshot().pendingChanges).toEqual([])
  })
})
