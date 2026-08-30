// Reorderable effects rack. Each unit: enable toggle, parameter knobs, and
// up/down buttons plus header dragging to change the processing order.

import { FX_IDS } from '../shared/messages'
import type { SynthEngine } from '../audio/engine'
import { el } from './common'
import { bindEnabledState, paramToggle, paramSelect, knobRow } from './controls'
import { guideTarget } from './guide-target'

const FX_LABELS: Record<string, string> = {
  chorus: 'CHORUS',
  phaser: 'PHASER',
  flanger: 'FLANGER',
  delay: 'DELAY',
  reverb: 'REVERB',
  eq: 'EQ',
  comp: 'COMPRESSOR',
  fxdist: 'DISTORTION'
}

const FX_KNOBS: Record<string, string[]> = {
  chorus: ['chorus.rate', 'chorus.depth', 'chorus.mix'],
  phaser: ['phaser.rate', 'phaser.depth', 'phaser.feedback', 'phaser.mix'],
  flanger: ['flanger.rate', 'flanger.depth', 'flanger.feedback', 'flanger.mix'],
  delay: ['delay.time', 'delay.feedback', 'delay.mix'],
  reverb: ['reverb.size', 'reverb.damp', 'reverb.width', 'reverb.mix'],
  eq: ['eq.low_gain', 'eq.mid_gain', 'eq.mid_freq', 'eq.high_gain'],
  comp: ['comp.threshold', 'comp.ratio', 'comp.attack', 'comp.release', 'comp.makeup'],
  fxdist: ['fxdist.drive', 'fxdist.tone', 'fxdist.mix']
}

export class FxRack {
  readonly root: HTMLElement
  private readonly units = new Map<number, HTMLElement>()
  private readonly unsubscribe: () => void

  constructor(private readonly engine: SynthEngine) {
    this.root = el('div', 'fx-rack')
    for (let i = 0; i < FX_IDS.length; i++) this.units.set(i, this.buildUnit(i))
    this.render()
    this.unsubscribe = engine.onFxOrder(() => this.render())
  }

  dispose(): void { this.unsubscribe() }

  private buildUnit(fx: number): HTMLElement {
    const id = FX_IDS[fx]
    const unit = el('div', 'fx-unit')
    guideTarget(unit, `fx.${id}`, id === 'delay' ? 'Delay / echo effect' : `${FX_LABELS[id]} effect`, 'panel')
    const head = el('div', 'fx-head')
    head.appendChild(paramToggle(this.engine, `${id}.enabled`, '●'))
    head.appendChild(el('span', 'fx-name', FX_LABELS[id]))
    const spacer = el('span', 'fx-spacer')
    head.appendChild(spacer)
    const up = el('button', 'fx-move', '▲')
    const down = el('button', 'fx-move', '▼')
    guideTarget(up, `button.fx.${id}.up`, `Move ${FX_LABELS[id]} earlier`, 'button')
    guideTarget(down, `button.fx.${id}.down`, `Move ${FX_LABELS[id]} later`, 'button')
    up.addEventListener('click', () => this.move(fx, -1))
    down.addEventListener('click', () => this.move(fx, 1))
    head.append(up, down)
    unit.appendChild(head)

    const body = el('div', 'fx-body')
    if (id === 'delay') {
      const opts = el('div', 'fx-opts')
      opts.appendChild(paramToggle(this.engine, 'delay.sync', 'SYNC'))
      opts.appendChild(paramSelect(this.engine, 'delay.division'))
      opts.appendChild(paramToggle(this.engine, 'delay.pingpong', 'PING'))
      body.appendChild(opts)
    }
    body.appendChild(knobRow(this.engine, FX_KNOBS[id], 40))
    unit.appendChild(body)
    bindEnabledState(this.engine, `${id}.enabled`, unit)
    return unit
  }

  private move(fx: number, dir: number): void {
    const order = this.engine.fxOrder.slice()
    const pos = order.indexOf(fx)
    const to = pos + dir
    if (to < 0 || to >= order.length) return
    order.splice(pos, 1)
    order.splice(to, 0, fx)
    this.engine.setFxOrder(order)
  }

  private render(): void {
    this.root.textContent = ''
    for (const fx of this.engine.fxOrder) this.root.appendChild(this.units.get(fx)!)
  }
}
