// Envelope display: renders the DAHDSR shape from the current parameters.
// Editing happens through the knob row below the display.

import { paramIndex, normToValue, PARAMS } from '../shared/params'
import type { SynthEngine } from '../audio/engine'
import { el } from './common'

function shape(t: number, c: number): number {
  return Math.pow(t, Math.pow(2, c * 3))
}

export class EnvDisplay {
  readonly root: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly cx: CanvasRenderingContext2D
  private w = 0
  private h = 0

  constructor(private readonly engine: SynthEngine, private env: number) {
    this.root = el('div', 'env-display')
    this.canvas = el('canvas')
    this.root.appendChild(this.canvas)
    this.cx = this.canvas.getContext('2d')!
    new ResizeObserver(() => this.resize()).observe(this.root)
    // redraw when any env param of any envelope changes (cheap enough)
    for (let e = 1; e <= 6; e++) {
      for (const f of ['delay', 'attack', 'hold', 'decay', 'sustain', 'release', 'atk_curve', 'dec_curve', 'rel_curve']) {
        engine.onParam(paramIndex(`env${e}.${f}`), () => this.draw())
      }
    }
  }

  setEnv(env: number): void {
    this.env = env
    this.draw()
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1
    this.w = this.root.clientWidth
    this.h = this.root.clientHeight
    this.canvas.width = this.w * dpr
    this.canvas.height = this.h * dpr
    this.canvas.style.width = `${this.w}px`
    this.canvas.style.height = `${this.h}px`
    this.cx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.draw()
  }

  private v(field: string): number {
    const i = paramIndex(`env${this.env}.${field}`)
    return normToValue(PARAMS[i], this.engine.getParam(i))
  }

  draw(): void {
    const c = this.cx
    const w = this.w
    const h = this.h
    if (!w || !h) return
    c.clearRect(0, 0, w, h)

    const del = this.v('delay')
    const atk = this.v('attack')
    const hold = this.v('hold')
    const dec = this.v('decay')
    const sus = this.v('sustain')
    const rel = this.v('release')
    const ac = this.v('atk_curve')
    const dc = this.v('dec_curve')
    const rc = this.v('rel_curve')

    const susTime = Math.max(0.15 * (del + atk + hold + dec + rel), 0.05)
    const total = del + atk + hold + dec + susTime + rel
    const X = (t: number) => (t / total) * (w - 8) + 4
    const Y = (v: number) => (1 - v) * (h - 10) + 5

    // Time divisions make the envelope controls legible in milliseconds.
    c.strokeStyle = '#252832'
    c.lineWidth = 1
    for (let time = 0.1; time < total; time += 0.1) {
      const x = X(time)
      c.beginPath()
      c.moveTo(x, 0)
      c.lineTo(x, h)
      c.stroke()
    }
    for (const level of [0.25, 0.5, 0.75]) {
      const y = Y(level)
      c.beginPath()
      c.moveTo(0, y)
      c.lineTo(w, y)
      c.stroke()
    }

    c.beginPath()
    c.moveTo(X(0), Y(0))
    c.lineTo(X(del), Y(0))
    const N = 40
    for (let i = 1; i <= N; i++) c.lineTo(X(del + (i / N) * atk), Y(shape(i / N, ac)))
    c.lineTo(X(del + atk + hold), Y(1))
    for (let i = 1; i <= N; i++) c.lineTo(X(del + atk + hold + (i / N) * dec), Y(sus + (1 - sus) * (1 - shape(i / N, -dc))))
    c.lineTo(X(del + atk + hold + dec + susTime), Y(sus))
    for (let i = 1; i <= N; i++) c.lineTo(X(del + atk + hold + dec + susTime + (i / N) * rel), Y(sus * (1 - shape(i / N, -rc))))
    c.strokeStyle = '#ff9a3c'
    c.lineWidth = 2
    c.stroke()
    c.lineTo(X(total), Y(0) + 5)
    c.lineTo(X(0), Y(0) + 5)
    c.closePath()
    const gradient = c.createLinearGradient(0, 0, 0, h)
    gradient.addColorStop(0, '#ff9a3c38')
    gradient.addColorStop(1, '#ff9a3c05')
    c.fillStyle = gradient
    c.fill()

    // live value line
    const live = this.engine.sourceValues[this.env - 1] ?? 0
    if (live > 0.001) {
      c.beginPath()
      c.moveTo(0, Y(live))
      c.lineTo(w, Y(live))
      c.strokeStyle = '#ff9a3c50'
      c.lineWidth = 1
      c.stroke()
    }
  }
}
