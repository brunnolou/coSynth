import type { SynthEngine } from '../audio/engine'
import { PARAMS, normToValue, paramIndex } from '../shared/params'
import type { Wavetable } from '../shared/wavetable-gen'
import { nextSnapPoint, SNAP_EPSILON, wavetableSnapPoints } from '../shared/wavetable-snap'
import { ACCENT_COLOR, el } from './common'
import './osc-wave-preview.css'

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

export function wavetableSample(table: Wavetable, morph: number, phase: number): number {
  if (table.numFrames === 0 || table.frameSize === 0) return 0
  const framePosition = clamp01(morph) * Math.max(table.numFrames - 1, 0)
  const frame0 = Math.min(Math.floor(framePosition), Math.max(table.numFrames - 2, 0))
  const frame1 = Math.min(frame0 + 1, table.numFrames - 1)
  const frameMix = table.numFrames > 1 ? framePosition - frame0 : 0
  const sample = Math.min(Math.floor(clamp01(phase) * (table.frameSize - 1)), table.frameSize - 1)
  const a = table.data[frame0 * table.frameSize + sample] ?? 0
  const b = table.data[frame1 * table.frameSize + sample] ?? a
  return a + (b - a) * frameMix
}

export function syncedPhase(phase: number, sync: number): number {
  const centered = (clamp01(phase) - 0.5) * Math.max(1, sync)
  return ((centered % 1) + 1) % 1
}

export class OscWavePreview {
  readonly root: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly context: CanvasRenderingContext2D
  private readonly morphIndex: number
  private readonly syncIndex: number
  private width = 0
  private height = 0

  constructor(private readonly engine: SynthEngine, private readonly osc: number) {
    this.root = el('div', 'osc-wave-preview')
    this.canvas = el('canvas')
    this.canvas.setAttribute('aria-label', `Oscillator ${osc + 1} waveform preview`)
    this.root.appendChild(this.canvas)
    this.context = this.canvas.getContext('2d')!
    this.morphIndex = paramIndex(`osc${osc + 1}.morph`)
    this.syncIndex = paramIndex(`osc${osc + 1}.sync`)

    new ResizeObserver(() => this.resize()).observe(this.root)
    engine.onParam(this.morphIndex, () => {
      this.refreshInteraction()
      this.draw()
    })
    engine.onParam(this.syncIndex, () => this.draw())
    engine.onTableChange(changedOsc => {
      if (changedOsc === osc) {
        this.refreshInteraction()
        this.draw()
      }
    })
    engine.onMatrixChange(() => this.draw())
    this.root.addEventListener('click', () => {
      const next = nextSnapPoint(wavetableSnapPoints(engine.currentTables[osc]), engine.getParam(this.morphIndex))
      if (next) engine.setParam(this.morphIndex, next.position)
    })
    this.root.addEventListener('keydown', event => {
      if (this.root.getAttribute('role') !== 'button' || (event.key !== 'Enter' && event.key !== ' ')) return
      event.preventDefault()
      event.stopPropagation()
      // Reuse click so keyboard activation also selects this oscillator's 3D view.
      if (!event.repeat) this.root.click()
    })
    this.refreshInteraction()
  }

  private refreshInteraction(): void {
    const points = wavetableSnapPoints(this.engine.currentTables[this.osc])
    const morph = this.engine.getParam(this.morphIndex)
    const next = nextSnapPoint(points, morph)
    this.root.classList.toggle('has-snap-points', !!next)
    if (!next) {
      this.root.removeAttribute('role')
      this.root.removeAttribute('tabindex')
      this.root.removeAttribute('aria-label')
      this.root.removeAttribute('title')
      this.canvas.removeAttribute('aria-hidden')
      return
    }
    const current = points.find(point => Math.abs(point.position - morph) <= SNAP_EPSILON)
    const label = `Oscillator ${this.osc + 1}. Base shape: ${current?.label ?? 'between shapes'}. Next: ${next.label}. Click to cycle.`
    this.root.setAttribute('role', 'button')
    this.root.tabIndex = 0
    this.root.title = label
    this.root.setAttribute('aria-label', label)
    this.canvas.setAttribute('aria-hidden', 'true')
  }

  get animated(): boolean {
    return [this.morphIndex, this.syncIndex].some(index =>
      this.engine.routesForDest(index).some(({ state }) => state.enabled)
    )
  }

  private normalizedValue(index: number): number {
    let value = this.engine.getParam(index)
    for (const { state } of this.engine.routesForDest(index)) {
      if (state.enabled) value += state.depth * (this.engine.sourceValues[state.source] ?? 0)
    }
    return clamp01(value)
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1
    this.width = this.root.clientWidth
    this.height = this.root.clientHeight
    this.canvas.width = Math.round(this.width * dpr)
    this.canvas.height = Math.round(this.height * dpr)
    this.canvas.style.width = `${this.width}px`
    this.canvas.style.height = `${this.height}px`
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.draw()
  }

  draw(): void {
    const c = this.context
    const w = this.width
    const h = this.height
    const table = this.engine.currentTables[this.osc]
    if (!w || !h) return
    c.clearRect(0, 0, w, h)

    const middle = h / 2
    c.beginPath()
    c.moveTo(0, middle)
    c.lineTo(w, middle)
    c.strokeStyle = '#2a2d36'
    c.lineWidth = 1
    c.stroke()
    if (!table) return

    const morph = this.normalizedValue(this.morphIndex)
    const sync = normToValue(PARAMS[this.syncIndex], this.normalizedValue(this.syncIndex))
    const points = Math.max(32, Math.round(w))
    c.beginPath()
    for (let i = 0; i < points; i++) {
      const x = i / (points - 1) * w
      const phase = syncedPhase(i / (points - 1), sync)
      const sample = wavetableSample(table, morph, phase)
      const y = middle - sample * (h * 0.38)
      if (i === 0) c.moveTo(x, y)
      else c.lineTo(x, y)
    }
    c.strokeStyle = ACCENT_COLOR
    c.lineWidth = 1.4
    c.lineJoin = 'round'
    c.stroke()
  }
}
