// Small bound controls: enum selects, on/off toggles, knob rows.

import { PARAMS, paramIndex, normToValue, valueToNorm } from '../shared/params'
import type { SynthEngine } from '../audio/engine'
import { el } from './common'
import { Knob } from './knob'

export function paramSelect(engine: SynthEngine, id: string): HTMLSelectElement {
  const index = paramIndex(id)
  const def = PARAMS[index]
  const choices = def.choices ?? []
  const sel = el('select', 'param-select') as HTMLSelectElement
  choices.forEach((c, i) => {
    const o = el('option', undefined, c) as HTMLOptionElement
    o.value = String(i)
    sel.appendChild(o)
  })
  const sync = () => {
    sel.value = String(Math.round(normToValue(def, engine.getParam(index))))
  }
  sync()
  sel.addEventListener('change', () => {
    engine.setParam(index, valueToNorm(def, Number(sel.value)))
  })
  engine.onParam(index, sync)
  return sel
}

export function paramToggle(engine: SynthEngine, id: string, label = 'ON'): HTMLButtonElement {
  const index = paramIndex(id)
  const b = el('button', 'toggle', label) as HTMLButtonElement
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

export function knobRow(engine: SynthEngine, ids: string[], size = 46): HTMLElement {
  const row = el('div', 'knob-row')
  for (const id of ids) row.appendChild(new Knob(engine, paramIndex(id), size).root)
  return row
}
