// The synthesizer AudioWorkletProcessor: voice management, global modulation,
// the effects rack, and the message protocol endpoint.

import { PARAMS, NUM_PARAMS, paramIndex, normToValue, defaultValues, divisionToBeats } from '../shared/params'
import {
  MAX_MOD_SLOTS, MAX_VOICES, NUM_MOD_SOURCES, defaultLfoShape,
  type ToWorklet, type ModSlotState, type LfoPoint
} from '../shared/messages'
import { WavetableData } from './dsp'
import { Voice, LFO_IDX, MACRO_IDX, MASTER_IDX, SRC_MACRO0, SRC_MODWHEEL, SRC_PITCHWHEEL, SRC_AFTERTOUCH, type VoiceContext, type ModRoute } from './voice'
import { Chorus, Phaser, Flanger, StereoDelay, Reverb, Eq3, Compressor, FxDistortion } from './effects'

const BLOCK = 128
const SCOPE_SIZE = 1024

const FX_IDX = {
  chorus: { on: paramIndex('chorus.enabled'), rate: paramIndex('chorus.rate'), depth: paramIndex('chorus.depth'), mix: paramIndex('chorus.mix') },
  phaser: { on: paramIndex('phaser.enabled'), rate: paramIndex('phaser.rate'), depth: paramIndex('phaser.depth'), fb: paramIndex('phaser.feedback'), mix: paramIndex('phaser.mix') },
  flanger: { on: paramIndex('flanger.enabled'), rate: paramIndex('flanger.rate'), depth: paramIndex('flanger.depth'), fb: paramIndex('flanger.feedback'), mix: paramIndex('flanger.mix') },
  delay: { on: paramIndex('delay.enabled'), sync: paramIndex('delay.sync'), div: paramIndex('delay.division'), time: paramIndex('delay.time'), fb: paramIndex('delay.feedback'), pp: paramIndex('delay.pingpong'), mix: paramIndex('delay.mix') },
  reverb: { on: paramIndex('reverb.enabled'), size: paramIndex('reverb.size'), damp: paramIndex('reverb.damp'), width: paramIndex('reverb.width'), mix: paramIndex('reverb.mix') },
  eq: { on: paramIndex('eq.enabled'), low: paramIndex('eq.low_gain'), mid: paramIndex('eq.mid_gain'), midF: paramIndex('eq.mid_freq'), high: paramIndex('eq.high_gain') },
  comp: { on: paramIndex('comp.enabled'), th: paramIndex('comp.threshold'), ratio: paramIndex('comp.ratio'), atk: paramIndex('comp.attack'), rel: paramIndex('comp.release'), mk: paramIndex('comp.makeup') },
  fxdist: { on: paramIndex('fxdist.enabled'), drive: paramIndex('fxdist.drive'), tone: paramIndex('fxdist.tone'), mix: paramIndex('fxdist.mix') }
}

class SynthProcessor extends AudioWorkletProcessor {
  private readonly base = defaultValues()
  private readonly voices: Voice[] = []
  private noteAge = 0
  private sustainDown = false

  private readonly slots: (ModSlotState | null)[] = new Array(MAX_MOD_SLOTS).fill(null)
  private readonly routesByDest = new Map<number, ModRoute[]>()

  private readonly tables: (WavetableData | null)[] = [null, null, null]
  private readonly lfoShapes: LfoPoint[][] = Array.from({ length: 8 }, () => defaultLfoShape())
  private sample: { data: Float32Array; sampleRate: number } | null = null

  private readonly lfoGlobalPhases = new Float32Array(8)
  private readonly lfoBeatPhases = new Float32Array(8)
  private readonly lfoFreqs = new Float32Array(8)
  private beatCounter = 0

  private pitchBend = 0
  private modWheel = 0
  private aftertouch = 0

  private readonly globalOffsets = new Float32Array(NUM_PARAMS)
  private readonly globalSources = new Float32Array(NUM_MOD_SOURCES)

  private fxOrder = [0, 1, 2, 3, 4, 5, 6, 7]
  private readonly chorus = new Chorus(sampleRate)
  private readonly phaser = new Phaser(sampleRate)
  private readonly flanger = new Flanger(sampleRate)
  private readonly delay = new StereoDelay(sampleRate)
  private readonly reverb = new Reverb(sampleRate)
  private readonly eq = new Eq3(sampleRate)
  private readonly comp = new Compressor(sampleRate)
  private readonly fxdist = new FxDistortion(sampleRate)

  private readonly scopeL = new Float32Array(SCOPE_SIZE)
  private readonly scopeR = new Float32Array(SCOPE_SIZE)
  private scopePos = 0
  private peakL = 0
  private peakR = 0

  private readonly ctx: VoiceContext

  constructor() {
    super()
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice(sampleRate, BLOCK))
    this.ctx = {
      sr: sampleRate,
      blockSize: BLOCK,
      base: this.base,
      routesByDest: this.routesByDest,
      tables: this.tables,
      lfoShapes: this.lfoShapes,
      sample: null,
      lfoGlobalPhases: this.lfoGlobalPhases,
      lfoBeatPhases: this.lfoBeatPhases,
      lfoFreqs: this.lfoFreqs,
      pitchBend: 0,
      modWheel: 0,
      aftertouch: 0,
      bendRange: 2
    }
    this.port.onmessage = (e: MessageEvent) => this.handleMessage(e.data as ToWorklet)
    this.port.postMessage({ type: 'ready' })
  }

  private handleMessage(msg: ToWorklet): void {
    switch (msg.type) {
      case 'param':
        this.base[msg.index] = msg.value
        break
      case 'noteOn':
        this.noteOn(msg.note, msg.velocity)
        break
      case 'noteOff':
        this.noteOff(msg.note)
        break
      case 'sustain':
        this.sustainDown = msg.down
        if (!msg.down) {
          for (const v of this.voices) {
            if (v.active && v.sustained) v.noteOff()
          }
        }
        break
      case 'pitchBend':
        this.pitchBend = msg.value
        break
      case 'modWheel':
        this.modWheel = msg.value
        break
      case 'aftertouch':
        this.aftertouch = msg.value
        break
      case 'mod':
        this.slots[msg.slot] = msg.state
        this.rebuildRoutes()
        break
      case 'lfoShape':
        this.lfoShapes[msg.lfo] = msg.points.length ? msg.points : defaultLfoShape()
        break
      case 'wavetable':
        this.tables[msg.osc] = new WavetableData(msg.mips, msg.frameSize, msg.numFrames)
        break
      case 'sample':
        this.sample = msg.data.length > 0 ? { data: msg.data, sampleRate: msg.sampleRate } : null
        break
      case 'fxOrder':
        if (msg.order.length === 8) this.fxOrder = msg.order.slice()
        break
      case 'allNotesOff':
        for (const v of this.voices) if (v.active) v.noteOff()
        break
    }
  }

  private rebuildRoutes(): void {
    this.routesByDest.clear()
    for (const s of this.slots) {
      if (!s || !s.enabled || s.depth === 0) continue
      if (s.dest < 0 || s.dest >= NUM_PARAMS || !PARAMS[s.dest].moddable) continue
      let list = this.routesByDest.get(s.dest)
      if (!list) {
        list = []
        this.routesByDest.set(s.dest, list)
      }
      list.push({ source: s.source, depth: s.depth })
    }
    for (const v of this.voices) v.clearMods()
    this.globalOffsets.fill(0)
  }

  private noteOn(note: number, velocity: number): void {
    const poly = Math.max(1, Math.round(normToValue(PARAMS[MASTER_IDX.polyphony], this.base[MASTER_IDX.polyphony])))
    let voice: Voice | null = null
    let activeCount = 0
    for (const v of this.voices) if (v.active) activeCount++

    if (activeCount < poly) {
      voice = this.voices.find(v => !v.active) ?? null
    }
    if (!voice) {
      // steal: quietest releasing voice, else the oldest
      let best: Voice | null = null
      for (const v of this.voices) {
        if (!v.active) { best = v; break }
        if (v.releasing && (!best || !best.releasing || v.ampLevel < best.ampLevel)) best = v
      }
      if (!best || !best.releasing) {
        for (const v of this.voices) {
          if (v.active && (!best || v.age < best.age)) best = v
        }
      }
      voice = best
    }
    if (voice) voice.noteOn(note, Math.max(0.001, velocity), this.noteAge++, this.ctx)
  }

  private noteOff(note: number): void {
    for (const v of this.voices) {
      if (v.active && v.note === note && v.gate) {
        if (this.sustainDown) v.sustained = true
        else v.noteOff()
      }
    }
  }

  private updateGlobalLfos(bpm: number): void {
    const dt = BLOCK / sampleRate
    this.beatCounter += (bpm / 60) * dt
    for (let l = 0; l < 8; l++) {
      const ix = LFO_IDX[l]
      const synced = this.base[ix.sync] >= 0.5
      let freq: number
      if (synced) {
        const div = Math.round(normToValue(PARAMS[ix.division], this.base[ix.division]))
        freq = bpm / 60 / divisionToBeats(div)
      } else {
        freq = normToValue(PARAMS[ix.rate], this.base[ix.rate] + this.globalOffsets[ix.rate])
      }
      this.lfoFreqs[l] = freq
      this.lfoGlobalPhases[l] = (this.lfoGlobalPhases[l] + freq * dt) % 1
      const beatsPerCycle = synced
        ? divisionToBeats(Math.round(normToValue(PARAMS[ix.division], this.base[ix.division])))
        : Math.max(60 / (freq * bpm), 1e-4)
      const phase0 = this.base[ix.phase]
      this.lfoBeatPhases[l] = (this.beatCounter / beatsPerCycle + phase0) % 1
    }
  }

  /** Resolve global modulation offsets, using the newest active voice for per-voice sources. */
  private updateGlobalMods(): void {
    let ref: Voice | null = null
    for (const v of this.voices) {
      if (v.active && (!ref || v.age > ref.age)) ref = v
    }
    if (ref) this.globalSources.set(ref.sources)
    else {
      this.globalSources.fill(0)
      for (let l = 0; l < 8; l++) {
        // keep global LFO motion audible on FX even with no voice playing
        this.globalSources[6 + l] = 0
      }
    }
    for (let m = 0; m < 4; m++) this.globalSources[SRC_MACRO0 + m] = this.base[MACRO_IDX[m]]
    this.globalSources[SRC_MODWHEEL] = this.modWheel
    this.globalSources[SRC_PITCHWHEEL] = this.pitchBend
    this.globalSources[SRC_AFTERTOUCH] = this.aftertouch

    for (const [dest, routes] of this.routesByDest) {
      let sum = 0
      for (const r of routes) sum += r.depth * this.globalSources[r.source]
      this.globalOffsets[dest] = sum
    }
  }

  /** Global (post-mix) parameter value with modulation. */
  private gv(index: number): number {
    return normToValue(PARAMS[index], this.base[index] + this.globalOffsets[index])
  }

  private runFx(l: Float32Array, r: Float32Array, n: number, bpm: number): void {
    for (const fx of this.fxOrder) {
      switch (fx) {
        case 0: {
          const p = FX_IDX.chorus
          if (this.base[p.on] >= 0.5) this.chorus.process(l, r, n, this.gv(p.rate), this.gv(p.depth), this.gv(p.mix))
          break
        }
        case 1: {
          const p = FX_IDX.phaser
          if (this.base[p.on] >= 0.5) this.phaser.process(l, r, n, this.gv(p.rate), this.gv(p.depth), this.gv(p.fb), this.gv(p.mix))
          break
        }
        case 2: {
          const p = FX_IDX.flanger
          if (this.base[p.on] >= 0.5) this.flanger.process(l, r, n, this.gv(p.rate), this.gv(p.depth), this.gv(p.fb), this.gv(p.mix))
          break
        }
        case 3: {
          const p = FX_IDX.delay
          if (this.base[p.on] >= 0.5) {
            let time: number
            if (this.base[p.sync] >= 0.5) {
              const div = Math.round(normToValue(PARAMS[p.div], this.base[p.div]))
              time = divisionToBeats(div) * (60 / bpm)
            } else time = this.gv(p.time)
            this.delay.process(l, r, n, time, this.gv(p.fb), this.base[p.pp] >= 0.5, this.gv(p.mix))
          }
          break
        }
        case 4: {
          const p = FX_IDX.reverb
          if (this.base[p.on] >= 0.5) this.reverb.process(l, r, n, this.gv(p.size), this.gv(p.damp), this.gv(p.width), this.gv(p.mix))
          break
        }
        case 5: {
          const p = FX_IDX.eq
          if (this.base[p.on] >= 0.5) this.eq.process(l, r, n, this.gv(p.low), this.gv(p.mid), this.gv(p.midF), this.gv(p.high))
          break
        }
        case 6: {
          const p = FX_IDX.comp
          if (this.base[p.on] >= 0.5) this.comp.process(l, r, n, this.gv(p.th), this.gv(p.ratio), this.gv(p.atk), this.gv(p.rel), this.gv(p.mk))
          break
        }
        case 7: {
          const p = FX_IDX.fxdist
          if (this.base[p.on] >= 0.5) this.fxdist.process(l, r, n, this.gv(p.drive), this.gv(p.tone), this.gv(p.mix))
          break
        }
      }
    }
  }

  override process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]
    const l = out[0]
    const r = out.length > 1 ? out[1] : out[0]
    const n = l.length
    l.fill(0)
    if (r !== l) r.fill(0)

    const bpm = normToValue(PARAMS[MASTER_IDX.bpm], this.base[MASTER_IDX.bpm])
    this.updateGlobalLfos(bpm)

    const ctx = this.ctx
    ctx.sample = this.sample
    ctx.pitchBend = this.pitchBend
    ctx.modWheel = this.modWheel
    ctx.aftertouch = this.aftertouch
    ctx.bendRange = Math.round(normToValue(PARAMS[MASTER_IDX.bendRange], this.base[MASTER_IDX.bendRange]))

    let voiceCount = 0
    for (const v of this.voices) {
      if (v.active) {
        v.render(ctx, l, r, n)
        voiceCount++
      }
    }

    this.updateGlobalMods()
    this.runFx(l, r, n, bpm)

    const vol = this.gv(MASTER_IDX.volume)
    for (let i = 0; i < n; i++) {
      let sl = l[i] * vol
      let sr = r[i] * vol
      // safety clamp
      if (sl > 2) sl = 2
      else if (sl < -2) sl = -2
      if (sr > 2) sr = 2
      else if (sr < -2) sr = -2
      l[i] = sl
      r[i] = sr
      const al = Math.abs(sl)
      const ar = Math.abs(sr)
      if (al > this.peakL) this.peakL = al
      if (ar > this.peakR) this.peakR = ar
    }

    // scope / status feed
    this.scopeL.set(l.subarray(0, n), this.scopePos)
    this.scopeR.set(r.subarray(0, n), this.scopePos)
    this.scopePos += n
    if (this.scopePos >= SCOPE_SIZE) {
      this.scopePos = 0
      const sl = new Float32Array(this.scopeL)
      const sr = new Float32Array(this.scopeR)
      this.port.postMessage({ type: 'scope', left: sl, right: sr }, [sl.buffer, sr.buffer])
      const sources = new Float32Array(this.globalSources)
      this.port.postMessage({
        type: 'status',
        voices: voiceCount,
        peakL: this.peakL,
        peakR: this.peakR,
        sources
      }, [sources.buffer])
      this.peakL = 0
      this.peakR = 0
    }

    return true
  }
}

registerProcessor('soundgineer', SynthProcessor)
