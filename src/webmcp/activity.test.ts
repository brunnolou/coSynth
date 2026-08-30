import { describe, expect, it, vi } from 'vitest'
import type { PresetData, SynthEngine } from '../audio/engine'
import { AgentActivityStore } from './activity'

function preset(name = 'Agent checkpoint'): PresetData {
  return { name, version: 1, params: { 'master.volume': 0.5 }, mods: [], lfoShapes: [], fxOrder: [] }
}

function setup() {
  const engine = {
    toPreset: vi.fn(() => preset()),
    loadPreset: vi.fn()
  } as unknown as SynthEngine
  return { engine, store: new AgentActivityStore(engine) }
}

describe('AgentActivityStore', () => {
  it('publishes tool readiness and action results', () => {
    const { store } = setup()
    const listener = vi.fn()
    store.subscribe(listener)
    store.setToolReadiness(9, true)
    const id = store.startAction('update_parameters')
    store.finishAction(id, 'update_parameters', {}, { applied: [{ id: 'master.volume' }, { id: 'filter1.cutoff' }] })

    expect(store.snapshot()).toMatchObject({
      readyTools: 9,
      audioToolsLocked: true,
      changedParameters: ['master.volume', 'filter1.cutoff'],
      lastAction: { label: 'Updated parameters', status: 'completed', summary: '2 parameters' }
    })
    expect(listener).toHaveBeenCalled()
  })

  it('reports only the latest mutation instead of retaining a disposable checkpoint', () => {
    const { engine, store } = setup()
    const id = store.startAction('update_parameters')
    store.finishAction(id, 'update_parameters', {}, { applied: [{ id: 'osc1.level' }] })
    const second = store.startAction('update_parameters')
    store.finishAction(second, 'update_parameters', {}, { applied: [{ id: 'osc2.level' }] })
    expect(store.snapshot().changedParameters).toEqual(['osc2.level'])
    expect(engine.toPreset).not.toHaveBeenCalled()
    expect(engine.loadPreset).not.toHaveBeenCalled()
  })

  it('tracks concurrent performance completion without losing the active operation', () => {
    const { store } = setup()
    const id = store.startAction('render_audio')
    const rejectedConcurrent = store.startAction('play_notes')
    store.failAction(rejectedConcurrent, 'play_notes', new Error('A WebMCP performance is already in progress'))
    expect(store.snapshot().performanceActive).toBe(true)
    store.finishAction(id, 'render_audio', {}, { duration: 1.25 })
    expect(store.snapshot().performanceActive).toBe(false)
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
