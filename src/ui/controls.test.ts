// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SynthEngine } from '../audio/engine'
import { paramIndex, SYNC_DIVISIONS, SYNC_DIVISION_ORDER } from '../shared/params'
import { bindSyncGating, paramSelect, setControlGated, syncGating } from './controls'

describe('sync gating', () => {
  it('gates the free-running control while synced and the division while free', () => {
    expect(syncGating(true)).toEqual({ free: true, division: false })
    expect(syncGating(false)).toEqual({ free: false, division: true })
  })

  it('mutes a control and takes it out of pointer and AT reach', () => {
    const select = document.createElement('select')
    setControlGated(select, true)
    expect(select.classList.contains('is-gated')).toBe(true)
    expect(select.getAttribute('aria-disabled')).toBe('true')
    expect(select.disabled).toBe(true)
    setControlGated(select, false)
    expect(select.classList.contains('is-gated')).toBe(false)
    expect(select.getAttribute('aria-disabled')).toBe('false')
    expect(select.disabled).toBe(false)
  })

  it('marks a non-form control aria-disabled without a disabled property', () => {
    const knob = document.createElement('div')
    setControlGated(knob, true)
    expect(knob.classList.contains('is-gated')).toBe(true)
    expect(knob.getAttribute('aria-disabled')).toBe('true')
    expect('disabled' in knob).toBe(false)
  })
})

describe('bindSyncGating', () => {
  let engine: SynthEngine
  let free: HTMLElement
  let division: HTMLElement
  const gated = () => ({ free: free.classList.contains('is-gated'), division: division.classList.contains('is-gated') })

  beforeEach(() => {
    engine = new SynthEngine()
    free = document.createElement('div')
    division = document.createElement('div')
  })

  it('is correct on first render', () => {
    // lfo1.sync defaults to on
    bindSyncGating(engine, 'lfo1.sync', { free, division })
    expect(gated()).toEqual({ free: true, division: false })
  })

  it('follows the toggle live', () => {
    bindSyncGating(engine, 'lfo1.sync', { free, division })
    engine.setParam(paramIndex('lfo1.sync'), 0)
    expect(gated()).toEqual({ free: false, division: true })
    engine.setParam(paramIndex('lfo1.sync'), 1)
    expect(gated()).toEqual({ free: true, division: false })
  })

  it('follows a preset load', () => {
    bindSyncGating(engine, 'delay.sync', { free, division })
    engine.loadPreset({ name: 'free delay', params: { 'delay.sync': 0 } })
    expect(gated()).toEqual({ free: false, division: true })
    engine.loadPreset({ name: 'synced delay', params: {} })
    expect(gated()).toEqual({ free: true, division: false })
  })

  it('never writes the gated parameter', () => {
    const set = vi.spyOn(engine, 'setParam')
    const rate = engine.getParam(paramIndex('lfo1.rate'))
    const dispose = bindSyncGating(engine, 'lfo1.sync', { free, division })
    expect(set).not.toHaveBeenCalled()
    expect(engine.getParam(paramIndex('lfo1.rate'))).toBe(rate)
    dispose()
    engine.setParam(paramIndex('lfo1.sync'), 0)
    expect(gated()).toEqual({ free: true, division: false })  // unsubscribed
  })
})

describe('paramSelect choiceOrder', () => {
  it('reorders options for display while keeping the choice index as the value', () => {
    const engine = new SynthEngine()
    const select = paramSelect(engine, 'lfo1.division', { choiceOrder: SYNC_DIVISION_ORDER })
    const options = [...select.options]
    expect(options).toHaveLength(SYNC_DIVISIONS.length)
    expect(options[0].textContent).toBe('31/1')
    expect(options[0].value).toBe(String(SYNC_DIVISIONS.indexOf('31/1')))
    expect(options.at(-1)!.textContent).toBe('1/32')
    expect(select.value).toBe(String(SYNC_DIVISIONS.indexOf('1/4')))  // default

    select.value = String(SYNC_DIVISIONS.indexOf('8/1'))
    select.dispatchEvent(new Event('change'))
    expect(select.value).toBe(String(SYNC_DIVISIONS.indexOf('8/1')))
  })
})
