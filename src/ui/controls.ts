// Small bound controls: enum selects, on/off toggles, knob rows.

import { PARAMS, paramIndex, normToValue, valueToNorm } from '../shared/params'
import type { SynthEngine } from '../audio/engine'
import { el } from './common'
import { Knob } from './knob'
import { guideTarget, paramGuideId, paramGuideLabel } from './guide-target'

export interface ParamSelectOptions {
  choiceLabels?: readonly string[]
  /** Choice indices in menu order. Only reorders the options; values stay the choice index. */
  choiceOrder?: readonly number[]
  separatorBefore?: string
  onSelect?: (choice: string, index: number) => boolean | void
}

export function paramSelect(engine: SynthEngine, id: string, options: ParamSelectOptions = {}): HTMLSelectElement {
  const index = paramIndex(id)
  const def = PARAMS[index]
  const choices = def.choices ?? []
  const sel = el('select', 'param-select') as HTMLSelectElement
  guideTarget(sel, paramGuideId(id), paramGuideLabel(def), 'select')
  const order = options.choiceOrder ?? choices.map((_, i) => i)
  order.forEach(i => {
    const c = choices[i]
    if (c === options.separatorBefore) {
      const separator = el('option', undefined, '──────────') as HTMLOptionElement
      separator.disabled = true
      separator.value = ''
      sel.appendChild(separator)
    }
    const o = el('option', undefined, options.choiceLabels?.[i] ?? c) as HTMLOptionElement
    o.value = String(i)
    sel.appendChild(o)
  })
  const sync = () => {
    sel.value = String(Math.round(normToValue(def, engine.getParam(index))))
  }
  sync()
  sel.addEventListener('change', () => {
    const selected = Number(sel.value)
    if (options.onSelect?.(choices[selected], selected) === false) {
      sync()
      return
    }
    engine.setParam(index, valueToNorm(def, selected))
  })
  engine.onParam(index, sync)
  return sel
}

export function paramToggle(engine: SynthEngine, id: string, label = 'ON'): HTMLButtonElement {
  const index = paramIndex(id)
  const b = el('button', 'toggle', label) as HTMLButtonElement
  guideTarget(b, paramGuideId(id), paramGuideLabel(PARAMS[index]), 'button')
  const sync = () => b.classList.toggle('on', engine.getParam(index) >= 0.5)
  sync()
  b.addEventListener('click', () => {
    engine.setParam(index, engine.getParam(index) >= 0.5 ? 0 : 1)
  })
  engine.onParam(index, sync)
  return b
}

export function bindEnabledState(engine: SynthEngine, id: string, target: HTMLElement): () => void {
  const index = paramIndex(id)
  const sync = (value = engine.getParam(index)) => {
    target.classList.toggle('is-disabled', value < 0.5)
  }
  sync()
  return engine.onParam(index, sync)
}

export interface SyncGating {
  /** Gate the free-running control (LFO rate, delay time): it is bypassed while synced. */
  free: boolean
  /** Gate the tempo division: it is bypassed while free-running. */
  division: boolean
}

/** Which half of a SYNC pair has no effect for the given toggle state. */
export function syncGating(syncOn: boolean): SyncGating {
  return { free: syncOn, division: !syncOn }
}

/**
 * Mute a control and stop its value from being edited. Never writes the param.
 *
 * How far that reaches depends on the control. A `<select>` genuinely leaves pointer,
 * keyboard and AT reach, because `disabled` lands on it. A knob is a role-less `<div>`
 * that binds pointer events only, so it has no keyboard or AT reach to lose and its
 * `aria-disabled` is not announced; there, gating is purely a pointer affair --
 * `.knob.is-gated` (style.css) makes the canvas stack inert while leaving the root
 * live, so an existing modulation route can still be inspected and removed.
 */
export function setControlGated(target: HTMLElement, gated: boolean): void {
  target.classList.toggle('is-gated', gated)
  target.setAttribute('aria-disabled', String(gated))
  if ('disabled' in target) (target as HTMLElement & { disabled: boolean }).disabled = gated
}

/** Keep a SYNC pair's inactive half gated, on first render and on every later change. */
export function bindSyncGating(engine: SynthEngine, syncId: string, pair: { free: HTMLElement; division: HTMLElement }): () => void {
  const index = paramIndex(syncId)
  const sync = (value = engine.getParam(index)) => {
    const gated = syncGating(value >= 0.5)
    setControlGated(pair.free, gated.free)
    setControlGated(pair.division, gated.division)
  }
  sync()
  return engine.onParam(index, sync)
}

export function knobRow(engine: SynthEngine, ids: string[], size = 46): HTMLElement {
  const row = el('div', 'knob-row')
  for (const id of ids) row.appendChild(new Knob(engine, paramIndex(id), size).root)
  return row
}
