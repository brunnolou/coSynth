// Modulation matrix table: every active route as a row with source/destination
// selects, a bipolar depth slider, enable toggle, and delete.

import { PARAMS } from '../shared/params'
import { MOD_SOURCES, MAX_MOD_SLOTS } from '../shared/messages'
import type { SynthEngine } from '../audio/engine'
import { el, sourceColor } from './common'
import { guideTarget } from './guide-target'

const MODDABLE = PARAMS.map((d, i) => ({ d, i })).filter(({ d }) => d.moddable)

function destLabel(i: number): string {
  const d = PARAMS[i]
  return `${d.group} · ${d.name}`
}

export class ModMatrix {
  readonly root: HTMLElement
  private readonly rows: HTMLElement
  private readonly rowUpdates = new Map<number, { root: HTMLElement; update: () => void }>()
  private readonly unsubscribe: () => void

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
    guideTarget(add, 'button.matrix.add', 'Add modulation route', 'button')
    add.addEventListener('click', () => {
      const slot = this.engine.modSlots.findIndex(s => s === null)
      if (slot >= 0) {
        this.engine.setModSlot(slot, { source: 6, dest: MODDABLE[0].i, depth: 0.25, enabled: true })
      }
    })
    this.root.append(head, this.rows, add)
    this.unsubscribe = engine.onMatrixChange(() => this.render())
    this.render()
  }

  private render(): void {
    for (const [slot, row] of this.rowUpdates) {
      if (!this.engine.modSlots[slot]) { row.root.remove(); this.rowUpdates.delete(slot) }
    }
    let index = 0
    for (let slot = 0; slot < MAX_MOD_SLOTS; slot++) {
      const state = this.engine.modSlots[slot]
      if (!state) continue
      const existing = this.rowUpdates.get(slot)
      if (existing) { existing.update(); index++; continue }
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
        const current = this.engine.modSlots[slot]
        if (current) this.engine.setModSlot(slot, { ...current, source: Number(src.value) })
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
        const current = this.engine.modSlots[slot]
        if (current) this.engine.setModSlot(slot, { ...current, dest: Number(dest.value) })
      })

      const controls = el('div', 'matrix-controls')
      const enable = el('button', `toggle${state.enabled ? ' on' : ''}`, '●')
      enable.title = 'Enable/bypass'
      enable.addEventListener('click', () => {
        const current = this.engine.modSlots[slot]
        if (current) this.engine.setModSlot(slot, { ...current, enabled: !current.enabled })
      })
      const del = el('button', 'mod-del', '✕')
      guideTarget(row, `matrix.slot${slot}`, `Modulation slot ${slot}`, 'row')
      guideTarget(src, `matrix.slot${slot}.source`, `Slot ${slot} source`, 'select')
      guideTarget(dest, `matrix.slot${slot}.destination`, `Slot ${slot} destination`, 'select')
      guideTarget(depth, `matrix.slot${slot}.depth`, `Slot ${slot} depth`, 'slider')
      guideTarget(enable, `matrix.slot${slot}.enabled`, `Slot ${slot} enable`, 'button')
      guideTarget(del, `matrix.slot${slot}.remove`, `Remove slot ${slot}`, 'button')
      del.addEventListener('click', () => this.engine.setModSlot(slot, null))
      controls.append(enable, del)

      row.append(src, depthWrap, dest, controls)
      this.rowUpdates.set(slot, { root: row, update: () => {
        const current = this.engine.modSlots[slot]
        if (!current) return
        src.value = String(current.source)
        src.style.borderLeft = `3px solid ${sourceColor(current.source)}`
        dest.value = String(current.dest)
        depth.value = String(Math.round(current.depth * 100))
        depthLabel.textContent = `${Math.round(current.depth * 100)}%`
        enable.classList.toggle('on', current.enabled)
      } })
      this.rows.insertBefore(row, this.rows.children[index] ?? null)
      index++
    }
  }

  dispose(): void { this.unsubscribe() }
}
