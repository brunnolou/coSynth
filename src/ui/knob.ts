// Canvas knob with Vital-style modulation arcs.
//  - drag vertically to turn, Shift = fine
//  - double-click = reset to default
//  - right-click = modulation menu (assign sources, adjust depths)
//  - drop target for drag-to-assign from a modulation source badge

import { PARAMS, formatValue, defaultNorm } from '../shared/params'
import { MOD_SOURCES } from '../shared/messages'
import type { SynthEngine } from '../audio/engine'
import { el, sourceColor, clamp01, showPopup, closePopup } from './common'
import { guideTarget } from './guide-target'

const knobRegistry = new Map<HTMLElement, Knob>()
const MOD_CANVAS_PADDING = 12

export class Knob {
  readonly root: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly modCanvas: HTMLCanvasElement
  private readonly labelEl: HTMLElement
  private readonly cx: CanvasRenderingContext2D
  private readonly modCx: CanvasRenderingContext2D
  private readonly modSize: number
  private dragging = false
  private dragStartY = 0
  private dragStartVal = 0
  private hasRoutes = false

  constructor(
    private readonly engine: SynthEngine,
    readonly paramIndex: number,
    private readonly size = 46,
    label?: string
  ) {
    const def = PARAMS[paramIndex]
    this.root = el('div', 'knob')
    guideTarget(this.root, `param.${def.id}`, `${def.group} ${def.name}`, 'knob')
    const canvasStack = el('div', 'knob-canvases')
    canvasStack.style.width = `${size}px`
    canvasStack.style.height = `${size}px`
    this.canvas = el('canvas', 'knob-main-canvas')
    this.modCanvas = el('canvas', 'knob-mod-canvas')
    this.modSize = size + MOD_CANVAS_PADDING * 2
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = size * dpr
    this.canvas.height = size * dpr
    this.canvas.style.width = `${size}px`
    this.canvas.style.height = `${size}px`
    this.modCanvas.width = this.modSize * dpr
    this.modCanvas.height = this.modSize * dpr
    this.modCanvas.style.width = `${this.modSize}px`
    this.modCanvas.style.height = `${this.modSize}px`
    this.cx = this.canvas.getContext('2d')!
    this.modCx = this.modCanvas.getContext('2d')!
    this.cx.scale(dpr, dpr)
    this.modCx.scale(dpr, dpr)
    this.labelEl = el('div', 'knob-label', label ?? def.name)
    canvasStack.append(this.canvas, this.modCanvas)
    this.root.appendChild(canvasStack)
    this.root.appendChild(this.labelEl)
    if (def.moddable) this.root.classList.add('moddable')
    knobRegistry.set(this.root, this)

    this.canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0) return
      e.preventDefault()
      this.dragging = true
      this.dragStartY = e.clientY
      this.dragStartVal = engine.getParam(paramIndex)
      this.canvas.setPointerCapture(e.pointerId)
    })
    this.canvas.addEventListener('pointermove', e => {
      if (!this.dragging) return
      const scale = (e.shiftKey ? 0.0005 : 0.005)
      const v = clamp01(this.dragStartVal + (this.dragStartY - e.clientY) * scale)
      engine.setParam(paramIndex, v)
      this.showValue()
    })
    const endDrag = () => {
      if (this.dragging) {
        this.dragging = false
        this.labelEl.textContent = label ?? def.name
      }
    }
    this.canvas.addEventListener('pointerup', endDrag)
    this.canvas.addEventListener('pointercancel', endDrag)
    this.canvas.addEventListener('dblclick', () => {
      engine.setParam(paramIndex, defaultNorm(def))
    })
    this.canvas.addEventListener('wheel', e => {
      e.preventDefault()
      const step = (e.shiftKey ? 0.002 : 0.02) * (e.deltaY > 0 ? -1 : 1)
      engine.setParam(paramIndex, clamp01(engine.getParam(paramIndex) + step))
      this.showValue()
    }, { passive: false })
    this.canvas.addEventListener('contextmenu', e => {
      e.preventDefault()
      if (def.moddable) this.openModMenu(e.clientX, e.clientY)
    })

    engine.onParam(paramIndex, () => this.draw())
    engine.onMatrixChange(() => {
      this.hasRoutes = engine.routesForDest(paramIndex).length > 0
      this.draw()
    })
    this.hasRoutes = engine.routesForDest(paramIndex).length > 0
    this.draw()
  }

  private showValue(): void {
    this.labelEl.textContent = formatValue(PARAMS[this.paramIndex], this.engine.getParam(this.paramIndex))
  }

  /** Redraw each animation frame only when modulated (animated arcs). */
  get animated(): boolean {
    return this.hasRoutes
  }

  draw(): void {
    const c = this.cx
    const mc = this.modCx
    const s = this.size
    const ms = this.modSize
    const r = s / 2 - 8
    const cx = s / 2
    const cy = s / 2
    const mcx = ms / 2
    const mcy = ms / 2
    const a0 = 0.75 * Math.PI
    const sweep = 1.5 * Math.PI
    const v = this.engine.getParam(this.paramIndex)

    c.clearRect(0, 0, s, s)
    mc.clearRect(0, 0, ms, ms)

    // track
    c.beginPath()
    c.arc(cx, cy, r, a0, a0 + sweep)
    c.strokeStyle = '#2a2d36'
    c.lineWidth = 3.5
    c.lineCap = 'round'
    c.stroke()

    // value arc (bipolar params draw from center)
    const def = PARAMS[this.paramIndex]
    const bipolar = !def.choices && def.min < 0 && def.max > 0
    const start = bipolar ? a0 + sweep * (0 - def.min) / (def.max - def.min) : a0
    c.beginPath()
    if (bipolar) {
      const va = a0 + sweep * v
      c.arc(cx, cy, r, Math.min(start, va), Math.max(start, va))
    } else {
      c.arc(cx, cy, r, a0, a0 + sweep * v)
    }
    c.strokeStyle = '#53a8ff'
    c.stroke()

    // modulation arcs
    const routes = this.engine.routesForDest(this.paramIndex)
    if (routes.length) {
      let ring = r + 3.5
      for (const { state } of routes) {
        if (!state.enabled) continue
        const col = sourceColor(state.source)
        const va = a0 + sweep * v
        const depthA = sweep * state.depth
        // static depth range arc
        mc.beginPath()
        mc.arc(mcx, mcy, ring, Math.min(va, va + depthA), Math.max(va, va + depthA))
        mc.strokeStyle = col + '55'
        mc.lineWidth = 2
        mc.lineCap = 'round'
        mc.stroke()
        // animated current-value dot
        const src = this.engine.sourceValues[state.source] ?? 0
        const cur = clamp01(v + state.depth * src)
        const ca = a0 + sweep * cur
        mc.beginPath()
        mc.arc(mcx + Math.cos(ca) * ring, mcy + Math.sin(ca) * ring, 1.8, 0, 2 * Math.PI)
        mc.fillStyle = col
        mc.fill()
        ring += 3
      }
    }

    // pointer
    const pa = a0 + sweep * v
    c.beginPath()
    c.moveTo(cx + Math.cos(pa) * (r - 6), cy + Math.sin(pa) * (r - 6))
    c.lineTo(cx + Math.cos(pa) * (r - 1), cy + Math.sin(pa) * (r - 1))
    c.strokeStyle = '#e8eaf0'
    c.lineWidth = 2
    c.stroke()
  }

  private openModMenu(x: number, y: number): void {
    const menu = el('div', 'mod-menu')
    menu.appendChild(el('div', 'mod-menu-title', `Modulation → ${PARAMS[this.paramIndex].name}`))

    const routesBox = el('div')
    const renderRoutes = () => {
      routesBox.textContent = ''
      for (const { slot, state } of this.engine.routesForDest(this.paramIndex)) {
        const row = el('div', 'mod-menu-row')
        const chip = el('span', 'mod-chip', MOD_SOURCES[state.source].name)
        chip.style.background = sourceColor(state.source)
        const slider = el('input') as HTMLInputElement
        slider.type = 'range'
        slider.min = '-100'
        slider.max = '100'
        slider.value = String(Math.round(state.depth * 100))
        guideTarget(slider, `mod-menu.slot${slot}.depth`, `${MOD_SOURCES[state.source].name} modulation depth`, 'slider')
        slider.addEventListener('input', () => {
          const current = this.engine.modSlots[slot]
          if (current) this.engine.setModSlot(slot, { ...current, depth: Number(slider.value) / 100 })
        })
        const del = el('button', 'mod-del', '✕')
        del.addEventListener('click', () => {
          this.engine.setModSlot(slot, null)
          renderRoutes()
        })
        row.append(chip, slider, del)
        routesBox.appendChild(row)
      }
    }
    renderRoutes()
    menu.appendChild(routesBox)

    menu.appendChild(el('div', 'mod-menu-sub', 'Add source'))
    const grid = el('div', 'mod-menu-grid')
    MOD_SOURCES.forEach((s, i) => {
      const b = el('button', 'mod-src-btn', s.name)
      b.style.borderColor = sourceColor(i)
      b.addEventListener('click', () => {
        this.engine.addModRoute(i, this.paramIndex)
        renderRoutes()
      })
      grid.appendChild(b)
    })
    menu.appendChild(grid)
    showPopup(menu, x, y)
  }
}

// ------------------------------------------------------------ drag-to-assign

class ModDragController {
  private ghost: HTMLElement | null = null
  private source = -1
  private engine: SynthEngine | null = null

  start(engine: SynthEngine, source: number, e: PointerEvent): void {
    this.engine = engine
    this.source = source
    this.ghost = el('div', 'mod-ghost', MOD_SOURCES[source].name)
    this.ghost.style.background = sourceColor(source)
    document.body.appendChild(this.ghost)
    document.body.classList.add('mod-dragging')
    this.move(e)
    const onMove = (ev: PointerEvent) => this.move(ev)
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
    const onUp = (ev: PointerEvent) => {
      cleanup()
      this.drop(ev)
    }
    const onCancel = () => {
      cleanup()
      document.body.classList.remove('mod-dragging')
      this.ghost?.remove()
      this.ghost = null
      this.engine = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }

  private move(e: PointerEvent): void {
    if (this.ghost) {
      this.ghost.style.left = `${e.clientX + 10}px`
      this.ghost.style.top = `${e.clientY + 10}px`
    }
  }

  private drop(e: PointerEvent): void {
    document.body.classList.remove('mod-dragging')
    this.ghost?.remove()
    this.ghost = null
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.knob') as HTMLElement | null
    if (target && this.engine) {
      const knob = knobRegistry.get(target)
      if (knob && PARAMS[knob.paramIndex].moddable) {
        this.engine.addModRoute(this.source, knob.paramIndex)
        target.classList.add('mod-flash')
        setTimeout(() => target.classList.remove('mod-flash'), 400)
      }
    }
  }
}

export const modDrag = new ModDragController()

/** A draggable modulation-source badge. */
export function sourceBadge(engine: SynthEngine, sourceId: string): HTMLElement {
  const i = MOD_SOURCES.findIndex(s => s.id === sourceId)
  const badge = el('div', 'source-badge', MOD_SOURCES[i].name)
  guideTarget(badge, `source.${sourceId}`, `${MOD_SOURCES[i].name} modulation source`, 'source')
  badge.style.borderColor = sourceColor(i)
  badge.title = 'Drag onto a knob to assign modulation'
  badge.addEventListener('pointerdown', e => {
    e.preventDefault()
    closePopup()
    modDrag.start(engine, i, e)
  })
  return badge
}

export function animatedKnobs(): Knob[] {
  return [...knobRegistry.values()].filter(k => k.animated)
}
