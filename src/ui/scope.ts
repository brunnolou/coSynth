// Oscilloscope + spectrum analyzer fed by the worklet's scope stream.

import { fft } from '../shared/fft'
import type { SynthEngine } from '../audio/engine'
import { el } from './common'

export class Scope {
  readonly root: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly cx: CanvasRenderingContext2D
  private w = 0
  private h = 0
  private mode: 'wave' | 'spectrum' = 'wave'
  private readonly re = new Float32Array(1024)
  private readonly im = new Float32Array(1024)
  private readonly smooth = new Float32Array(512)

  constructor(private readonly engine: SynthEngine) {
    this.root = el('div', 'scope')
    const tabs = el('div', 'scope-tabs')
    const waveBtn = el('button', 'scope-tab on', 'WAVE')
    const specBtn = el('button', 'scope-tab', 'SPECTRUM')
    waveBtn.addEventListener('click', () => {
      this.mode = 'wave'
      waveBtn.classList.add('on')
      specBtn.classList.remove('on')
    })
    specBtn.addEventListener('click', () => {
      this.mode = 'spectrum'
      specBtn.classList.add('on')
      waveBtn.classList.remove('on')
    })
    tabs.append(waveBtn, specBtn)
    this.canvas = el('canvas')
    this.root.append(tabs, this.canvas)
    this.cx = this.canvas.getContext('2d')!
    new ResizeObserver(() => this.resize()).observe(this.root)
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1
    this.w = this.root.clientWidth
    this.h = this.root.clientHeight - 22
    this.canvas.width = this.w * dpr
    this.canvas.height = Math.max(this.h, 10) * dpr
    this.canvas.style.width = `${this.w}px`
    this.canvas.style.height = `${Math.max(this.h, 10)}px`
    this.cx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  /** called from the app's requestAnimationFrame loop */
  draw(): void {
    const c = this.cx
    const w = this.w
    const h = this.h
    if (!w || h < 10) return
    c.clearRect(0, 0, w, h)
    c.fillStyle = '#101218'
    c.fillRect(0, 0, w, h)

    if (this.mode === 'wave') {
      const L = this.engine.scopeL
      c.beginPath()
      for (let i = 0; i < L.length; i++) {
        const x = (i / (L.length - 1)) * w
        const y = h / 2 - L[i] * h * 0.45
        if (i === 0) c.moveTo(x, y)
        else c.lineTo(x, y)
      }
      c.strokeStyle = '#53a8ff'
      c.lineWidth = 1.5
      c.stroke()
      const R = this.engine.scopeR
      c.beginPath()
      for (let i = 0; i < R.length; i++) {
        const x = (i / (R.length - 1)) * w
        const y = h / 2 - R[i] * h * 0.45
        if (i === 0) c.moveTo(x, y)
        else c.lineTo(x, y)
      }
      c.strokeStyle = '#53a8ff55'
      c.lineWidth = 1
      c.stroke()
      return
    }

    // spectrum: Hann window + FFT + log-frequency bins
    const L = this.engine.scopeL
    const R = this.engine.scopeR
    const n = 1024
    for (let i = 0; i < n; i++) {
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
      this.re[i] = ((L[i] ?? 0) + (R[i] ?? 0)) * 0.5 * win
      this.im[i] = 0
    }
    fft(this.re, this.im)
    const sr = this.engine.ctx?.sampleRate ?? 48000
    const bars = 96
    const fMin = 25
    const fMax = sr / 2
    for (let b = 0; b < bars; b++) {
      const f0 = fMin * Math.pow(fMax / fMin, b / bars)
      const f1 = fMin * Math.pow(fMax / fMin, (b + 1) / bars)
      let k0 = Math.max(1, Math.floor((f0 / sr) * n))
      const k1 = Math.min(n / 2, Math.max(k0 + 1, Math.ceil((f1 / sr) * n)))
      let peak = 0
      for (let k = k0; k < k1; k++) {
        const m = Math.hypot(this.re[k], this.im[k])
        if (m > peak) peak = m
      }
      const db = 20 * Math.log10(peak / (n / 4) + 1e-9)
      const v = Math.max(0, (db + 80) / 80)
      const sm = Math.max(v, this.smooth[b] * 0.85)
      this.smooth[b] = sm
      const bw = w / bars
      const bh = sm * (h - 4)
      c.fillStyle = `hsl(${210 - sm * 60}, 80%, ${35 + sm * 25}%)`
      c.fillRect(b * bw + 0.5, h - bh, bw - 1, bh)
    }
  }
}
