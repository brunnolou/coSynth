// Modulation matrix table: every active route as a row with source/destination
// selects, a bipolar depth slider, enable toggle, and delete.

import { PARAMS } from '../shared/params'
import { MOD_SOURCES, MAX_MOD_SLOTS } from '../shared/messages'
import type { SynthEngine } from '../audio/engine'
import { el, sourceColor } from './common'

const MODDABLE = PARAMS.map((d, i) => ({ d, i })).filter(({ d }) => d.moddable)

function destLabel(i: number): string {
  const d = PARAMS[i]
  return `${d.group} · ${d.name}`
}

export class ModMatrix {
  readonly root: HTMLElement
  private readonly rows: HTMLElement

  constructor(private readonly engine: SynthEngine) {
    this.root = el('div', 'matrix')
    const head = el('div', 'matrix-head')
    head.append(
      el('span', undefined, 'SOURCE'),
      el('span', undefined, 'DEPTH'),
      el('span', undefined, 'DESTINATION'),
      el('span', undefined, '')
    )
    this.rows = el('div', 'matrix-rows')
    const add = el('button', 'matrix-add', '+ Add route')
    add.addEventListener('click', () => {
      const slot = this.engine.modSlots.findIndex(s => s === null)
      if (slot >= 0) {
        this.engine.setModSlot(slot, { source: 6, dest: MODDABLE[0].i, depth: 0.25, enabled: true })
      }
    })
    this.root.append(head, this.rows, add)
    engine.onMatrixChange(() => this.render())
    this.render()
  }

  private render(): void {
    this.rows.textContent = ''
    for (let slot = 0; slot < MAX_MOD_SLOTS; slot++) {
      const state = this.engine.modSlots[slot]
      if (!state) continue
      const row = el('div', 'matrix-row')

      const src = el('select', 'param-select') as HTMLSelectElement
      MOD_SOURCES.forEach((s, i) => {
        const o = el('option', undefined, s.name) as HTMLOptionElement
        o.value = String(i)
        src.appendChild(o)
      })
      src.value = String(state.source)
      src.style.borderLeft = `3px solid ${sourceColor(state.source)}`
      src.addEventListener('change', () => {
        this.engine.setModSlot(slot, { ...state, source: Number(src.value) })
      })

      const depthWrap = el('div', 'matrix-depth')
      const depth = el('input') as HTMLInputElement
      depth.type = 'range'
      depth.min = '-100'
      depth.max = '100'
      depth.value = String(Math.round(state.depth * 100))
      const depthLabel = el('span', 'matrix-depth-label', `${Math.round(state.depth * 100)}%`)
      depth.addEventListener('input', () => {
        depthLabel.textContent = `${depth.value}%`
        this.engine.setModSlot(slot, { ...this.engine.modSlots[slot]!, depth: Number(depth.value) / 100 })
      })
      depthWrap.append(depth, depthLabel)

      const dest = el('select', 'param-select') as HTMLSelectElement
      for (const { i } of MODDABLE) {
        const o = el('option', undefined, destLabel(i)) as HTMLOptionElement
        o.value = String(i)
        dest.appendChild(o)
      }
      dest.value = String(state.dest)
      dest.addEventListener('change', () => {
        this.engine.setModSlot(slot, { ...state, dest: Number(dest.value) })
      })

      const controls = el('div', 'matrix-controls')
      const enable = el('button', `toggle${state.enabled ? ' on' : ''}`, '●')
      enable.title = 'Enable/bypass'
      enable.addEventListener('click', () => {
        this.engine.setModSlot(slot, { ...state, enabled: !state.enabled })
      })
      const del = el('button', 'mod-del', '✕')
      del.addEventListener('click', () => this.engine.setModSlot(slot, null))
      controls.append(enable, del)

      row.append(src, depthWrap, dest, controls)
      this.rows.appendChild(row)
    }
  }
}
