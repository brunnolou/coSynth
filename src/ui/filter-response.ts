import type { SynthEngine } from '../audio/engine'
import { FILTER_TYPES, PARAMS, normToValue, paramIndex } from '../shared/params'
import { modSourceIndex, type ModSlotState } from '../shared/messages'
import { el } from './common'

const MIN_FREQ = 20
const MAX_FREQ = 20000
const MIN_DB = -36
const MAX_DB = 12
const KEY_TRACK_SOURCE = modSourceIndex('keytrack')
const FORMANTS = [
  [800, 1150, 2900],
  [400, 2000, 2800],
  [250, 2300, 3000],
  [400, 800, 2600],
  [350, 600, 2700]
]

export interface FilterResponseParams {
  type: number
  cutoff: number
  resonance: number
  drive: number
  keytrack: number
  mix: number
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))
const logDistance = (frequency: number, center: number): number => Math.log2(frequency / center)
const gaussian = (distance: number, width: number): number => Math.exp(-0.5 * (distance / width) ** 2)

export function applyModulation(
  base: number,
  routes: readonly Pick<ModSlotState, 'source' | 'depth' | 'enabled'>[],
  sourceValues: ArrayLike<number>
): number {
  let value = base
  for (const route of routes) {
    if (route.enabled) value += route.depth * (sourceValues[route.source] ?? 0)
  }
  return clamp(value, 0, 1)
}

/** Match the voice DSP's note-following cutoff shift. The source spans +/-36 semitones around C4. */
export function applyKeyTracking(cutoff: number, amount: number, keyTrackSource: number): number {
  const noteOffset = clamp(keyTrackSource, -1, 1) * 36
  return cutoff * 2 ** ((noteOffset / 12) * amount)
}

/** Approximate the audible magnitude of the synth's filter models for UI display. */
export function filterMagnitude(frequency: number, params: FilterResponseParams): number {
  const { type, cutoff, resonance, drive, mix } = params
  const ratio = Math.max(frequency / Math.max(cutoff, MIN_FREQ), 1e-6)
  const is24dB = type === 1 || type === 3 || type === 5
  const poles = is24dB ? 2 : 1
  let wet = 1

  if (type === 0 || type === 1) {
    wet = (1 / Math.sqrt(1 + ratio ** 2)) ** poles
    wet *= 1 + resonance * 2.8 * gaussian(logDistance(frequency, cutoff), 0.18 + (1 - resonance) * 0.22)
  } else if (type === 2 || type === 3) {
    wet = (ratio / Math.sqrt(1 + ratio ** 2)) ** poles
    wet *= 1 + resonance * 2.8 * gaussian(logDistance(frequency, cutoff), 0.18 + (1 - resonance) * 0.22)
  } else if (type === 4 || type === 5) {
    const width = (is24dB ? 0.52 : 0.8) * (1 - resonance * 0.65)
    wet = gaussian(logDistance(frequency, cutoff), width) * (1 + resonance * 2.2)
  } else if (type === 6) {
    const width = 0.42 * (1 - resonance * 0.72)
    wet = 1 - (0.82 + resonance * 0.17) * gaussian(logDistance(frequency, cutoff), width)
  } else if (type === 7) {
    const feedback = 0.5 + resonance * 0.48
    const phase = 2 * Math.PI * frequency / Math.max(cutoff, MIN_FREQ)
    wet = (1 - feedback) / Math.sqrt(1 + feedback ** 2 - 2 * feedback * Math.cos(phase))
  } else {
    // Match the DSP's logarithmic A–E–I–O–U morph across the cutoff range.
    const vowel = clamp(Math.log(cutoff / MIN_FREQ) / Math.log(MAX_FREQ / MIN_FREQ), 0, 1) * (FORMANTS.length - 1)
    const lo = Math.floor(vowel)
    const hi = Math.min(lo + 1, FORMANTS.length - 1)
    const blend = vowel - lo
    wet = 0.06
    for (let i = 0; i < 3; i++) {
      const center = FORMANTS[lo][i] + (FORMANTS[hi][i] - FORMANTS[lo][i]) * blend
      wet += (1 - i * 0.18) * gaussian(logDistance(frequency, center), 0.18 + (1 - resonance) * 0.18)
    }
    wet *= 0.8 + resonance * 1.8
  }

  const driven = wet * (1 + drive * 0.8)
  return Math.max(1e-4, (1 - mix) + mix * driven)
}

function frequencyToX(frequency: number, width: number): number {
  return Math.log(frequency / MIN_FREQ) / Math.log(MAX_FREQ / MIN_FREQ) * width
}

export class FilterResponseView {
  readonly root: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly context: CanvasRenderingContext2D
  private width = 0
  private height = 0

  constructor(private readonly engine: SynthEngine, private readonly filter: 1 | 2) {
    this.root = el('div', 'filter-response')
    this.canvas = el('canvas')
    this.canvas.setAttribute('aria-label', `Filter ${filter} frequency response`)
    this.root.appendChild(this.canvas)
    this.context = this.canvas.getContext('2d')!

    new ResizeObserver(() => this.resize()).observe(this.root)
    for (const name of ['type', 'cutoff', 'resonance', 'drive', 'keytrack', 'mix']) {
      engine.onParam(paramIndex(`filter${filter}.${name}`), () => this.draw())
    }
    engine.onMatrixChange(() => this.draw())
  }

  get animated(): boolean {
    if (this.engine.getParam(paramIndex(`filter${this.filter}.keytrack`)) > 0.001) return true
    return ['cutoff', 'resonance', 'drive', 'keytrack', 'mix'].some(name =>
      this.engine.routesForDest(paramIndex(`filter${this.filter}.${name}`)).some(({ state }) => state.enabled)
    )
  }

  private value(name: string, modulated = true): number {
    const index = paramIndex(`filter${this.filter}.${name}`)
    const base = this.engine.getParam(index)
    const normalized = modulated
      ? applyModulation(base, this.engine.routesForDest(index).map(({ state }) => state), this.engine.sourceValues)
      : base
    return normToValue(PARAMS[index], normalized)
  }

  private params(): FilterResponseParams {
    const keytrack = this.value('keytrack')
    const cutoff = applyKeyTracking(
      this.value('cutoff'),
      keytrack,
      this.engine.sourceValues[KEY_TRACK_SOURCE] ?? 0
    )
    return {
      type: this.value('type', false),
      cutoff,
      resonance: this.value('resonance'),
      drive: this.value('drive'),
      keytrack,
      mix: this.value('mix')
    }
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
    if (!w || !h) return
    const params = this.params()
    c.clearRect(0, 0, w, h)

    c.strokeStyle = '#252832'
    c.lineWidth = 1
    for (const frequency of [100, 1000, 10000]) {
      const x = frequencyToX(frequency, w)
      c.beginPath()
      c.moveTo(x, 0)
      c.lineTo(x, h)
      c.stroke()
    }
    for (const db of [-24, -12, 0]) {
      const y = (MAX_DB - db) / (MAX_DB - MIN_DB) * h
      c.beginPath()
      c.moveTo(0, y)
      c.lineTo(w, y)
      c.stroke()
    }

    if (params.keytrack > 0) {
      const low = clamp(params.cutoff * 2 ** (-3 * params.keytrack), MIN_FREQ, MAX_FREQ)
      const high = clamp(params.cutoff * 2 ** (3 * params.keytrack), MIN_FREQ, MAX_FREQ)
      const x1 = frequencyToX(low, w)
      const x2 = frequencyToX(high, w)
      c.fillStyle = '#53a8ff0c'
      c.fillRect(x1, 0, Math.max(1, x2 - x1), h)
    }

    const cutoffX = frequencyToX(params.cutoff, w)
    c.strokeStyle = '#53a8ff45'
    c.setLineDash([2, 3])
    c.beginPath()
    c.moveTo(cutoffX, 0)
    c.lineTo(cutoffX, h)
    c.stroke()
    c.setLineDash([])

    const points: Array<[number, number]> = []
    const steps = Math.max(96, Math.round(w))
    for (let i = 0; i <= steps; i++) {
      const x = i / steps * w
      const frequency = MIN_FREQ * (MAX_FREQ / MIN_FREQ) ** (i / steps)
      const db = clamp(20 * Math.log10(filterMagnitude(frequency, params)), MIN_DB, MAX_DB)
      const y = (MAX_DB - db) / (MAX_DB - MIN_DB) * h
      points.push([x, y])
    }

    c.beginPath()
    c.moveTo(points[0][0], points[0][1])
    for (let i = 1; i < points.length; i++) c.lineTo(points[i][0], points[i][1])
    c.lineTo(w, h)
    c.lineTo(0, h)
    c.closePath()
    const gradient = c.createLinearGradient(0, 0, 0, h)
    gradient.addColorStop(0, '#53a8ff38')
    gradient.addColorStop(1, '#53a8ff05')
    c.fillStyle = gradient
    c.fill()

    c.beginPath()
    c.moveTo(points[0][0], points[0][1])
    for (let i = 1; i < points.length; i++) c.lineTo(points[i][0], points[i][1])
    c.strokeStyle = '#53a8ff'
    c.lineWidth = 1.5
    c.lineJoin = 'round'
    c.stroke()

    c.fillStyle = '#8d93a3'
    c.font = '8px system-ui, sans-serif'
    c.fillText(FILTER_TYPES[params.type] ?? '', 5, 10)
  }
}
