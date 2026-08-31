import { describe, expect, it, vi } from 'vitest'
import { SynthEngine } from '../audio/engine'
import { paramIndex } from '../shared/params'
import { AgentActivityStore } from './activity'

function setup() {
  const engine = new SynthEngine()
  return { engine, store: new AgentActivityStore(engine) }
}

describe('AgentActivityStore', () => {
  it('retains overlapping calls by invocation ID and latches errors until a successful completion', () => {
    const { store } = setup()
    const first = store.startAction('render_audio')
    const second = store.startAction('get_synth_state')
    store.finishAction(second, 'get_synth_state', {}, {})
    expect(store.snapshot().activeToolCalls).toBe(1)
    store.failAction(first, 'render_audio', new Error('Recording failed'))
    expect(store.snapshot().actions.map(action => action.status)).toEqual(['failed', 'completed'])
    expect(store.snapshot().lastAction?.id).toBe(second)
    expect(store.snapshot().lastError?.id).toBe(first)
    expect(store.snapshot().activeToolCalls).toBe(0)
    const third = store.startAction('play_notes')
    store.failAction(third, 'play_notes', Object.assign(new Error('Stopped'), { name: 'AbortError' }))
    expect(store.snapshot().lastError?.id).toBe(first)
    const fourth = store.startAction('get_synth_state')
    expect(store.snapshot().lastError?.id).toBe(first)
    store.finishAction(fourth, 'get_synth_state', {}, {})
    expect(store.snapshot().lastError).toBeNull()
    expect(store.snapshot().actions).toHaveLength(4)
  })

  it('bounds the log without dropping active-call tracking and returns isolated snapshots', () => {
    const { engine, store } = setup()
    const first = store.startAction('render_audio')
    for (let i = 0; i < 110; i++) {
      const id = store.startAction('get_synth_state')
      store.finishAction(id, 'get_synth_state', {}, {})
    }
    expect(store.snapshot().actions).toHaveLength(100)
    expect(store.snapshot().activeToolCalls).toBe(1)
    store.finishAction(first, 'render_audio', {}, { duration: 1 })
    expect(store.snapshot().activeToolCalls).toBe(0)
    expect(store.snapshot().actions).toHaveLength(100)
    const snapshot = store.snapshot()
    snapshot.actions[0].summary = 'mutated'
    expect(store.snapshot().actions[0].summary).not.toBe('mutated')
    engine.setParamById('osc1.level', 0.1, 'ai')
    store.acceptCheckpoint()
    store.reportHumanError(new Error('Shortcut failed'))
    expect(store.snapshot().actions).toHaveLength(100)
    expect(store.snapshot().activeToolCalls).toBe(0)
  })

  it('distinguishes missing support, startup, and partial registration failures', () => {
    const { store } = setup()
    expect(store.snapshot().toolAvailability).toBe('checking')
    store.setToolReadiness(0, true, { available: false })
    expect(store.snapshot().toolAvailability).toBe('unavailable')
    store.setToolReadiness(0, true, { available: true, registering: true })
    expect(store.snapshot().toolAvailability).toBe('checking')
    store.setToolReadiness(14, true, { available: true, errors: [{ tool: 'save_preset', message: 'Denied' }] })
    expect(store.snapshot()).toMatchObject({ toolAvailability: 'error', readyTools: 14 })
    store.setToolReadiness(17, false, { available: true })
    expect(store.snapshot()).toMatchObject({ toolAvailability: 'ready', registrationErrors: [], audioToolsLocked: false })
  })

  it('publishes tool readiness and action results', () => {
    const { engine, store } = setup()
    const listener = vi.fn()
    store.subscribe(listener)
    store.setToolReadiness(9, true)
    const id = store.startAction('update_parameters')
    engine.setParamById('master.volume', 0.2, 'ai')
    engine.setParamById('filter1.cutoff', 0.2, 'ai')
    store.finishAction(id, 'update_parameters', {}, { applied: [{ id: 'master.volume' }, { id: 'filter1.cutoff' }] })

    expect(store.snapshot()).toMatchObject({
      readyTools: 9,
      audioToolsLocked: true,
      changedParameters: ['master.volume', 'filter1.cutoff'],
      lastAction: { label: 'Updated parameters', status: 'completed', summary: '2 parameters' }
    })
    expect(listener).toHaveBeenCalled()
  })

  it('restores the checkpoint captured before an agent mutation', () => {
    const { engine, store } = setup()
    const before = engine.getParam(paramIndex('osc1.level'))
    const id = store.startAction('update_parameters')
    engine.setParamById('osc1.level', 0.1, 'ai')
    store.finishAction(id, 'update_parameters', {}, { applied: [{ id: 'osc1.level' }] })

    expect(store.snapshot().checkpointAvailable).toBe(true)
    expect(store.restoreCheckpoint()).toBe(true)
    expect(engine.getParam(paramIndex('osc1.level'))).toBe(before)
    expect(store.snapshot()).toMatchObject({
      checkpointAvailable: false,
      changedParameters: [],
      lastAction: { label: 'Rejected agent changes; kept manual edits' }
    })
  })

  it('does not restore or accept while a performance is active', () => {
    const { engine, store } = setup()
    engine.setParamById('osc1.level', 0.1, 'ai')
    const restore = vi.spyOn(engine, 'setParam')
    const id = store.startAction('render_audio')
    const rejectedConcurrent = store.startAction('play_notes')
    store.failAction(rejectedConcurrent, 'play_notes', new Error('A WebMCP performance is already in progress'))
    expect(store.restoreCheckpoint()).toBe(false)
    expect(store.acceptCheckpoint()).toBe(false)
    expect(restore).not.toHaveBeenCalled()

    store.finishAction(id, 'render_audio', {}, { duration: 1.25 })
    expect(store.acceptCheckpoint()).toBe(true)
    expect(store.snapshot()).toMatchObject({ checkpointAvailable: false, lastAction: { label: 'Kept agent changes' } })
  })

  it('keeps the latest comparison for review', () => {
    const { store } = setup()
    const comparison = {
      similarity: 0.72,
      details: {
        peakDb: { reference: -8, candidate: -10, delta: -2, similarity: 0.8 },
        rmsDb: { reference: -12, candidate: -13, delta: -1, similarity: 0.9 },
        clippingCount: { reference: 0, candidate: 0, delta: 0, similarity: 1 },
        dcOffset: { reference: 0, candidate: 0.01, delta: 0.01, similarity: 0.8 },
        spectralCentroidHz: { reference: 500, candidate: 450, delta: -50, similarity: 0.8 },
        attackMs: { reference: 5, candidate: 7, delta: 2, similarity: 0.7 },
        stereoWidth: { reference: 0.5, candidate: 0.4, delta: -0.1, similarity: 0.7 }
      }
    }
    const id = store.startAction('compare_audio')
    store.finishAction(id, 'compare_audio', {}, { comparison })
    expect(store.snapshot()).toMatchObject({
      comparison: { similarity: 0.72 },
      lastAction: { summary: '72% similarity' }
    })
  })
})
