// Modulation matrix table: every active route as a row with source/destination
// selects, a bipolar depth knob, enable toggle, and delete.

import { PARAMS } from '../shared/params'
import { MOD_SOURCES, MAX_MOD_SLOTS } from '../shared/messages'
import type { SynthEngine } from '../audio/engine'
import { ACCENT_COLOR, el, sourceColor } from './common'
import { guideTarget } from './guide-target'
import { startKnobDrag } from './knob-drag'

const MODDABLE = PARAMS.map((d, i) => ({ d, i })).filter(({ d }) => d.moddable)

function destLabel(i: number): string {
  const d = PARAMS[i]
  return `${d.group} · ${d.name}`
}

function depthKnob(engine: SynthEngine, slot: number): { root: HTMLElement; update: () => void } {
  const root = el('div', 'knob matrix-depth-knob')
  const canvas = el('canvas', 'knob-main-canvas')
  const size = 34
  const dpr = window.devicePixelRatio || 1
  canvas.width = size * dpr
  canvas.height = size * dpr
  canvas.style.width = `${size}px`
  canvas.style.height = `${size}px`
  canvas.tabIndex = 0
  canvas.setAttribute('role', 'slider')
  canvas.setAttribute('aria-label', `Slot ${slot} depth`)
  canvas.setAttribute('aria-valuemin', '-100')
  canvas.setAttribute('aria-valuemax', '100')
  canvas.title = 'Drag up/right to increase, down/left to decrease. Double-click to reset.'
  const context = canvas.getContext('2d')
  context?.scale(dpr, dpr)

  const currentDepth = () => engine.modSlots[slot]?.depth ?? 0
  const setDepth = (depth: number) => {
    const current = engine.modSlots[slot]
    if (!current) return
    const stepped = Math.round(Math.max(-1, Math.min(1, depth)) * 100) / 100
    engine.setModSlot(slot, { ...current, depth: stepped })
  }
  const update = () => {
    const depth = currentDepth()
    const normalized = (depth + 1) / 2
    const center = size / 2
    const radius = size / 2 - 7
    const startAngle = 0.75 * Math.PI
    const sweep = 1.5 * Math.PI
    const centerAngle = startAngle + sweep / 2
    const valueAngle = startAngle + sweep * normalized
    if (context) {
      context.clearRect(0, 0, size, size)
      context.beginPath()
      context.arc(center, center, radius, startAngle, startAngle + sweep)
      context.strokeStyle = '#2a2d36'
      context.lineWidth = 3.5
      context.lineCap = 'round'
      context.stroke()
      if (Math.abs(valueAngle - centerAngle) > 1e-6) {
        context.beginPath()
        context.arc(center, center, radius, Math.min(centerAngle, valueAngle), Math.max(centerAngle, valueAngle))
        context.strokeStyle = ACCENT_COLOR
        context.stroke()
      }
      context.beginPath()
      context.moveTo(center + Math.cos(valueAngle) * (radius - 5), center + Math.sin(valueAngle) * (radius - 5))
      context.lineTo(center + Math.cos(valueAngle) * (radius - 1), center + Math.sin(valueAngle) * (radius - 1))
      context.strokeStyle = '#e8eaf0'
      context.lineWidth = 2
      context.stroke()
    }
    const percent = Math.round(depth * 100)
    canvas.title = `${percent}% depth. Drag up/right to increase, down/left to decrease. Double-click to reset.`
    canvas.setAttribute('aria-valuenow', String(percent))
    canvas.setAttribute('aria-valuetext', `${percent}%`)
  }

  canvas.addEventListener('pointerdown', event => {
    startKnobDrag(canvas, event, (currentDepth() + 1) / 2, value => setDepth(value * 2 - 1), () => {})
  })
  canvas.addEventListener('dblclick', () => setDepth(0))
  canvas.addEventListener('wheel', event => {
    event.preventDefault()
    const step = event.shiftKey ? 0.1 : event.metaKey ? 0.001 : 0.01
    setDepth(currentDepth() + (event.deltaY < 0 ? step : -step))
  }, { passive: false })
  canvas.addEventListener('keydown', event => {
    let next: number | null = null
    const step = event.shiftKey ? 0.1 : 0.01
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') next = currentDepth() + step
    else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') next = currentDepth() - step
    else if (event.key === 'PageUp') next = currentDepth() + 0.1
    else if (event.key === 'PageDown') next = currentDepth() - 0.1
    else if (event.key === 'Home') next = -1
    else if (event.key === 'End') next = 1
    if (next === null) return
    event.preventDefault()
    setDepth(next)
  })
  root.append(canvas)
  update()
  return { root, update }
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
      el('span', undefined, ''),
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

      const depth = depthKnob(this.engine, slot)

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

      const enable = el('button', `toggle matrix-route-toggle${state.enabled ? ' on' : ''}`, '●')
      enable.title = 'Enable/bypass'
      enable.addEventListener('click', () => {
        const current = this.engine.modSlots[slot]
        if (current) this.engine.setModSlot(slot, { ...current, enabled: !current.enabled })
      })
      const del = el('button', 'mod-del', '✕')
      guideTarget(row, `matrix.slot${slot}`, `Modulation slot ${slot}`, 'row')
      guideTarget(src, `matrix.slot${slot}.source`, `Slot ${slot} source`, 'select')
      guideTarget(dest, `matrix.slot${slot}.destination`, `Slot ${slot} destination`, 'select')
      guideTarget(depth.root, `matrix.slot${slot}.depth`, `Slot ${slot} depth`, 'knob')
      guideTarget(enable, `matrix.slot${slot}.enabled`, `Slot ${slot} enable`, 'button')
      guideTarget(del, `matrix.slot${slot}.remove`, `Remove slot ${slot}`, 'button')
      del.addEventListener('click', () => this.engine.setModSlot(slot, null))

      row.append(enable, src, depth.root, dest, del)
      this.rowUpdates.set(slot, { root: row, update: () => {
        const current = this.engine.modSlots[slot]
        if (!current) return
        src.value = String(current.source)
        src.style.borderLeft = `3px solid ${sourceColor(current.source)}`
        dest.value = String(current.dest)
        depth.update()
        enable.classList.toggle('on', current.enabled)
        row.classList.toggle('is-inactive', !current.enabled)
      } })
      row.classList.toggle('is-inactive', !state.enabled)
      this.rows.insertBefore(row, this.rows.children[index] ?? null)
      index++
    }
  }

  dispose(): void { this.unsubscribe() }
}
