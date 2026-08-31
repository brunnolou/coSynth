import { describe, expect, it, vi } from 'vitest'
import { SynthEngine } from '../audio/engine'
import { paramIndex } from '../shared/params'
import { AgentActivityStore } from './activity'

function setup() {
  const engine = new SynthEngine()
  return { engine, store: new AgentActivityStore(engine) }
}

describe('AgentActivityStore', () => {
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
