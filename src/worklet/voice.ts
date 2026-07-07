// One synthesizer voice: 3 wavetable oscillators (with unison), sub + noise,
// two routable filters, distortion section, six envelopes, eight LFOs, and
// per-voice modulation resolution.

import { PARAMS, NUM_PARAMS, paramIndex, normToValue } from '../shared/params'
import { NUM_MOD_SOURCES, MAX_UNISON, type LfoPoint } from '../shared/messages'
import { Envelope, Lfo, VoiceFilter, WavetableData, noteToFreq, type EnvParams } from './dsp'

// ---------------------------------------------------------------- param index tables

function idx(id: string): number {
  return paramIndex(id)
}

export const OSC_IDX = [1, 2, 3].map(o => ({
  enabled: idx(`osc${o}.enabled`),
  wavetable: idx(`osc${o}.wavetable`),
  morph: idx(`osc${o}.morph`),
  level: idx(`osc${o}.level`),
  pan: idx(`osc${o}.pan`),
  unison: idx(`osc${o}.unison`),
  detune: idx(`osc${o}.detune`),
  blend: idx(`osc${o}.blend`),
  spread: idx(`osc${o}.spread`),
  phase: idx(`osc${o}.phase`),
  phaseRand: idx(`osc${o}.phase_rand`),
  transpose: idx(`osc${o}.transpose`),
  fine: idx(`osc${o}.fine`),
  sync: idx(`osc${o}.sync`)
}))

export const SUB_IDX = {
  enabled: idx('sub.enabled'),
  shape: idx('sub.shape'),
  level: idx('sub.level'),
  pan: idx('sub.pan'),
  octave: idx('sub.octave')
}

export const NOISE_IDX = {
  enabled: idx('noise.enabled'),
  type: idx('noise.type'),
  level: idx('noise.level'),
  pan: idx('noise.pan'),
  pitch: idx('noise.pitch')
}

export const FILT_IDX = [1, 2].map(f => ({
  enabled: idx(`filter${f}.enabled`),
  type: idx(`filter${f}.type`),
  cutoff: idx(`filter${f}.cutoff`),
  resonance: idx(`filter${f}.resonance`),
  drive: idx(`filter${f}.drive`),
  keytrack: idx(`filter${f}.keytrack`),
  mix: idx(`filter${f}.mix`)
}))
export const FILTER_ROUTING_IDX = idx('filter.routing')

export const DIST_IDX = {
  type: idx('dist.type'),
  drive: idx('dist.drive'),
  mix: idx('dist.mix'),
  bits: idx('dist.bits'),
  downsample: idx('dist.downsample')
}

export const ENV_IDX = [1, 2, 3, 4, 5, 6].map(e => ({
  delay: idx(`env${e}.delay`),
  attack: idx(`env${e}.attack`),
  hold: idx(`env${e}.hold`),
  decay: idx(`env${e}.decay`),
  sustain: idx(`env${e}.sustain`),
  release: idx(`env${e}.release`),
  atkCurve: idx(`env${e}.atk_curve`),
  decCurve: idx(`env${e}.dec_curve`),
  relCurve: idx(`env${e}.rel_curve`)
}))

export const LFO_IDX = [1, 2, 3, 4, 5, 6, 7, 8].map(l => ({
  rate: idx(`lfo${l}.rate`),
  sync: idx(`lfo${l}.sync`),
  division: idx(`lfo${l}.division`),
  mode: idx(`lfo${l}.mode`),
  phase: idx(`lfo${l}.phase`),
  smooth: idx(`lfo${l}.smooth`)
}))

export const MACRO_IDX = [1, 2, 3, 4].map(m => idx(`macro${m}.value`))
export const MASTER_IDX = {
  volume: idx('master.volume'),
  bpm: idx('master.bpm'),
  polyphony: idx('master.polyphony'),
  bendRange: idx('master.bend_range')
}

// mod source layout (must match MOD_SOURCES in shared/messages.ts)
export const SRC_ENV0 = 0
export const SRC_LFO0 = 6
export const SRC_VELOCITY = 14
export const SRC_KEYTRACK = 15
export const SRC_RANDOM = 16
export const SRC_MACRO0 = 17
export const SRC_MODWHEEL = 21
export const SRC_PITCHWHEEL = 22
export const SRC_AFTERTOUCH = 23

export interface ModRoute {
  source: number
  depth: number
}

export interface VoiceContext {
  sr: number
  blockSize: number
  base: Float32Array // normalized base parameter values
  routesByDest: Map<number, ModRoute[]>
  tables: (WavetableData | null)[]
  lfoShapes: LfoPoint[][]
  sample: { data: Float32Array; sampleRate: number } | null
  lfoGlobalPhases: Float32Array // 8, for Free mode
  lfoBeatPhases: Float32Array   // 8, for Sync mode
  lfoFreqs: Float32Array        // 8, resolved this block (global values)
  pitchBend: number   // -1..1
  modWheel: number    // 0..1
  aftertouch: number  // 0..1
  bendRange: number   // semitones
}

const envParamScratch: EnvParams = {
  delay: 0, attack: 0, hold: 0, decay: 0, sustain: 0, release: 0,
  atkCurve: 0, decCurve: 0, relCurve: 0
}

export class Voice {
  note = 60
  velocity = 1
  gate = false
  sustained = false // held only by sustain pedal
  age = 0

  readonly sources = new Float32Array(NUM_MOD_SOURCES)
  private readonly modOffsets = new Float32Array(NUM_PARAMS)
  private readonly phases = new Float64Array(3 * MAX_UNISON)
  private subPhase = 0
  private samplePos = 0
  private random = 0
  private prevAmp = 0

  private readonly envs: Envelope[]
  private readonly lfos: Lfo[]
  private readonly filters: [VoiceFilter, VoiceFilter]

  private readonly bufL: Float32Array
  private readonly bufR: Float32Array
  private readonly tmpL: Float32Array
  private readonly tmpR: Float32Array

  private distHoldL = 0
  private distHoldR = 0
  private distCount = 0
  private readonly pink = [0, 0, 0]

  constructor(private readonly sr: number, blockSize: number) {
    this.envs = Array.from({ length: 6 }, () => new Envelope(sr, blockSize))
    this.lfos = Array.from({ length: 8 }, () => new Lfo(sr, blockSize))
    this.filters = [new VoiceFilter(sr), new VoiceFilter(sr)]
    this.bufL = new Float32Array(blockSize)
    this.bufR = new Float32Array(blockSize)
    this.tmpL = new Float32Array(blockSize)
    this.tmpR = new Float32Array(blockSize)
  }

  get active(): boolean {
    return !this.envs[0].idle
  }
  get releasing(): boolean {
    return this.envs[0].releasing
  }
  get ampLevel(): number {
    return this.envs[0].value
  }

  noteOn(note: number, velocity: number, age: number, ctx: VoiceContext): void {
    this.note = note
    this.velocity = velocity
    this.gate = true
    this.sustained = false
    this.age = age
    this.random = Math.random()
    this.samplePos = 0
    this.prevAmp = 0
    this.subPhase = 0
    this.distHoldL = this.distHoldR = 0
    this.distCount = 0

    for (let o = 0; o < 3; o++) {
      const startPhase = ctx.base[OSC_IDX[o].phase]
      const rand = ctx.base[OSC_IDX[o].phaseRand]
      for (let u = 0; u < MAX_UNISON; u++) {
        this.phases[o * MAX_UNISON + u] = (startPhase + rand * Math.random()) % 1
      }
    }
    for (const env of this.envs) env.trigger()
    for (let l = 0; l < 8; l++) {
      this.lfos[l].trigger(ctx.base[LFO_IDX[l].phase])
    }
    for (const f of this.filters) f.reset()
    this.modOffsets.fill(0)
    this.sources.fill(0)
    this.sources[SRC_VELOCITY] = velocity
    this.sources[SRC_KEYTRACK] = Math.max(-1, Math.min(1, (note - 60) / 36))
    this.sources[SRC_RANDOM] = this.random
  }

  noteOff(): void {
    this.gate = false
    this.sustained = false
    for (const env of this.envs) env.gateOff()
  }

  /** Drop stale offsets after the mod matrix changes (removed routes). */
  clearMods(): void {
    this.modOffsets.fill(0)
  }

  kill(): void {
    for (const env of this.envs) env.kill()
  }

  /** normalized param value with modulation applied, mapped to raw units */
  private pv(index: number, ctx: VoiceContext): number {
    return normToValue(PARAMS[index], ctx.base[index] + this.modOffsets[index])
  }

  private computeMods(ctx: VoiceContext): void {
    // global sources are mirrored into the per-voice source array
    for (let m = 0; m < 4; m++) this.sources[SRC_MACRO0 + m] = ctx.base[MACRO_IDX[m]]
    this.sources[SRC_MODWHEEL] = ctx.modWheel
    this.sources[SRC_PITCHWHEEL] = ctx.pitchBend
    this.sources[SRC_AFTERTOUCH] = ctx.aftertouch

    for (const [dest, routes] of ctx.routesByDest) {
      let sum = 0
      for (let i = 0; i < routes.length; i++) sum += routes[i].depth * this.sources[routes[i].source]
      this.modOffsets[dest] = sum
    }
  }

  private advanceModulators(ctx: VoiceContext): void {
    for (let e = 0; e < 6; e++) {
      const ix = ENV_IDX[e]
      envParamScratch.delay = this.pv(ix.delay, ctx)
      envParamScratch.attack = this.pv(ix.attack, ctx)
      envParamScratch.hold = this.pv(ix.hold, ctx)
      envParamScratch.decay = this.pv(ix.decay, ctx)
      envParamScratch.sustain = this.pv(ix.sustain, ctx)
      envParamScratch.release = this.pv(ix.release, ctx)
      envParamScratch.atkCurve = this.pv(ix.atkCurve, ctx)
      envParamScratch.decCurve = this.pv(ix.decCurve, ctx)
      envParamScratch.relCurve = this.pv(ix.relCurve, ctx)
      this.sources[SRC_ENV0 + e] = this.envs[e].process(envParamScratch)
    }
    for (let l = 0; l < 8; l++) {
      const ix = LFO_IDX[l]
      const mode = Math.round(normToValue(PARAMS[ix.mode], ctx.base[ix.mode]))
      const smooth = ctx.base[ix.smooth]
      this.sources[SRC_LFO0 + l] = this.lfos[l].process(
        ctx.lfoShapes[l], ctx.lfoFreqs[l], mode, ctx.lfoGlobalPhases[l], ctx.lfoBeatPhases[l], smooth
      )
    }
  }

  /** Render one block, mixing into outL/outR. Returns false when the voice has finished. */
  render(ctx: VoiceContext, outL: Float32Array, outR: Float32Array, n: number): boolean {
    this.computeMods(ctx)
    this.advanceModulators(ctx)
    if (!this.active) return false

    const bufL = this.bufL
    const bufR = this.bufR
    bufL.fill(0, 0, n)
    bufR.fill(0, 0, n)

    const baseFreq = noteToFreq(this.note + ctx.pitchBend * ctx.bendRange)

    // ---- wavetable oscillators
    for (let o = 0; o < 3; o++) {
      const ix = OSC_IDX[o]
      if (ctx.base[ix.enabled] < 0.5) continue
      const table = ctx.tables[o]
      if (!table) continue

      const morph = Math.max(0, Math.min(1, ctx.base[ix.morph] + this.modOffsets[ix.morph]))
      const level = this.pv(ix.level, ctx)
      if (level <= 0.0001) continue
      const pan = this.pv(ix.pan, ctx)
      const unison = Math.max(1, Math.min(MAX_UNISON, Math.round(this.pv(ix.unison, ctx))))
      const detune = this.pv(ix.detune, ctx)
      const blend = this.pv(ix.blend, ctx)
      const spread = this.pv(ix.spread, ctx)
      const transpose = this.pv(ix.transpose, ctx)
      const fine = this.pv(ix.fine, ctx)
      const sync = this.pv(ix.sync, ctx)
      const freq = baseFreq * Math.pow(2, (transpose + fine / 100) / 12)

      // per-unison gains/pans, normalized for constant power
      let norm = 0
      for (let u = 0; u < unison; u++) {
        const off = unison === 1 ? 0 : (2 * u) / (unison - 1) - 1
        const w = (1 - blend) * (1 - Math.abs(off)) + blend
        norm += w * w
      }
      norm = 1 / Math.sqrt(Math.max(norm, 1e-9))

      for (let u = 0; u < unison; u++) {
        const off = unison === 1 ? 0 : (2 * u) / (unison - 1) - 1
        const ratio = Math.pow(2, (detune * off) / 1200)
        const inc = (freq * ratio) / this.sr
        if (inc >= 0.5) continue
        const w = ((1 - blend) * (1 - Math.abs(off)) + blend) * norm * level
        const p = Math.max(-1, Math.min(1, pan + spread * off * 0.9))
        const gl = w * Math.cos(((p + 1) * Math.PI) / 4)
        const gr = w * Math.sin(((p + 1) * Math.PI) / 4)
        const mip = table.mipForInc(inc * sync)
        let phase = this.phases[o * MAX_UNISON + u]
        if (sync <= 1.001) {
          for (let i = 0; i < n; i++) {
            phase += inc
            if (phase >= 1) phase -= 1
            const s = table.read(morph, phase, mip)
            bufL[i] += s * gl
            bufR[i] += s * gr
          }
        } else {
          // hard sync: master phase at note freq, slave reads at sync multiple
          for (let i = 0; i < n; i++) {
            phase += inc
            if (phase >= 1) phase -= 1
            const sp = (phase * sync) % 1
            const s = table.read(morph, sp, mip)
            bufL[i] += s * gl
            bufR[i] += s * gr
          }
        }
        this.phases[o * MAX_UNISON + u] = phase
      }
    }

    // ---- sub oscillator
    if (ctx.base[SUB_IDX.enabled] >= 0.5) {
      const level = this.pv(SUB_IDX.level, ctx)
      if (level > 0.0001) {
        const pan = this.pv(SUB_IDX.pan, ctx)
        const shape = Math.round(normToValue(PARAMS[SUB_IDX.shape], ctx.base[SUB_IDX.shape]))
        const oct = this.pv(SUB_IDX.octave, ctx)
        const inc = (baseFreq * Math.pow(2, oct)) / this.sr
        const gl = level * Math.cos(((pan + 1) * Math.PI) / 4)
        const gr = level * Math.sin(((pan + 1) * Math.PI) / 4)
        let ph = this.subPhase
        for (let i = 0; i < n; i++) {
          ph += inc
          if (ph >= 1) ph -= 1
          let s: number
          switch (shape) {
            case 1: s = 1 - 4 * Math.abs(ph - 0.5); break            // triangle
            case 2: s = 2 * ph - 1; break                            // saw
            case 3: s = ph < 0.5 ? 1 : -1; break                     // square
            default: s = Math.sin(ph * 2 * Math.PI)
          }
          bufL[i] += s * gl
          bufR[i] += s * gr
        }
        this.subPhase = ph
      }
    }

    // ---- noise oscillator / sample slot
    if (ctx.base[NOISE_IDX.enabled] >= 0.5) {
      const level = this.pv(NOISE_IDX.level, ctx)
      if (level > 0.0001) {
        const pan = this.pv(NOISE_IDX.pan, ctx)
        const type = Math.round(normToValue(PARAMS[NOISE_IDX.type], ctx.base[NOISE_IDX.type]))
        const gl = level * Math.cos(((pan + 1) * Math.PI) / 4)
        const gr = level * Math.sin(((pan + 1) * Math.PI) / 4)
        if (type === 2 && ctx.sample) {
          const pitch = this.pv(NOISE_IDX.pitch, ctx)
          const rate = Math.pow(2, pitch / 12) * (ctx.sample.sampleRate / this.sr)
          const data = ctx.sample.data
          let pos = this.samplePos
          for (let i = 0; i < n; i++) {
            const i0 = pos | 0
            const s = data[i0 % data.length]
            bufL[i] += s * gl
            bufR[i] += s * gr
            pos += rate
            if (pos >= data.length) pos -= data.length
          }
          this.samplePos = pos
        } else if (type === 1) {
          const pk = this.pink
          for (let i = 0; i < n; i++) {
            const white = Math.random() * 2 - 1
            pk[0] = 0.99765 * pk[0] + white * 0.099046
            pk[1] = 0.963 * pk[1] + white * 0.2965164
            pk[2] = 0.57 * pk[2] + white * 1.0526913
            const s = (pk[0] + pk[1] + pk[2] + white * 0.1848) * 0.2
            bufL[i] += s * gl
            bufR[i] += s * gr
          }
        } else {
          for (let i = 0; i < n; i++) {
            const s = Math.random() * 2 - 1
            bufL[i] += s * gl
            bufR[i] += s * gr
          }
        }
      }
    }

    // ---- filters
    const routing = Math.round(normToValue(PARAMS[FILTER_ROUTING_IDX], ctx.base[FILTER_ROUTING_IDX]))
    const f1on = ctx.base[FILT_IDX[0].enabled] >= 0.5
    const f2on = ctx.base[FILT_IDX[1].enabled] >= 0.5
    const keyOffset = this.note - 60

    const runFilter = (f: number, l: Float32Array, r: Float32Array) => {
      const ix = FILT_IDX[f]
      const type = Math.round(normToValue(PARAMS[ix.type], ctx.base[ix.type]))
      const kt = this.pv(ix.keytrack, ctx)
      const cutoff = this.pv(ix.cutoff, ctx) * Math.pow(2, (keyOffset / 12) * kt)
      this.filters[f].process(l, r, n, type, cutoff, this.pv(ix.resonance, ctx), this.pv(ix.drive, ctx), this.pv(ix.mix, ctx))
    }

    if (routing === 0) {
      if (f1on) runFilter(0, bufL, bufR)
      if (f2on) runFilter(1, bufL, bufR)
    } else if (f1on || f2on) {
      if (f1on && f2on) {
        this.tmpL.set(bufL.subarray(0, n))
        this.tmpR.set(bufR.subarray(0, n))
        runFilter(0, bufL, bufR)
        runFilter(1, this.tmpL, this.tmpR)
        for (let i = 0; i < n; i++) {
          bufL[i] = (bufL[i] + this.tmpL[i]) * 0.5
          bufR[i] = (bufR[i] + this.tmpR[i]) * 0.5
        }
      } else {
        runFilter(f1on ? 0 : 1, bufL, bufR)
      }
    }

    // ---- distortion section
    const distType = Math.round(normToValue(PARAMS[DIST_IDX.type], ctx.base[DIST_IDX.type]))
    if (distType > 0) {
      const drive = this.pv(DIST_IDX.drive, ctx)
      const mix = this.pv(DIST_IDX.mix, ctx)
      const gain = 1 + drive * 15
      const comp = 1 / Math.pow(gain, 0.5)
      if (distType === 4) {
        // bitcrush + downsample
        const bits = this.pv(DIST_IDX.bits, ctx)
        const levels = Math.pow(2, bits)
        const down = Math.max(1, Math.round(this.pv(DIST_IDX.downsample, ctx)))
        for (let i = 0; i < n; i++) {
          if (this.distCount <= 0) {
            this.distHoldL = Math.round(bufL[i] * levels) / levels
            this.distHoldR = Math.round(bufR[i] * levels) / levels
            this.distCount = down
          }
          this.distCount--
          bufL[i] = bufL[i] * (1 - mix) + this.distHoldL * mix
          bufR[i] = bufR[i] * (1 - mix) + this.distHoldR * mix
        }
      } else {
        for (let i = 0; i < n; i++) {
          let sl: number
          let sr2: number
          if (distType === 1) {
            sl = Math.tanh(bufL[i] * gain) * comp
            sr2 = Math.tanh(bufR[i] * gain) * comp
          } else if (distType === 2) {
            sl = Math.max(-0.8, Math.min(0.8, bufL[i] * gain)) * comp
            sr2 = Math.max(-0.8, Math.min(0.8, bufR[i] * gain)) * comp
          } else {
            sl = Math.sin(bufL[i] * gain * 1.5) * comp
            sr2 = Math.sin(bufR[i] * gain * 1.5) * comp
          }
          bufL[i] = bufL[i] * (1 - mix) + sl * mix
          bufR[i] = bufR[i] * (1 - mix) + sr2 * mix
        }
      }
    }

    // ---- amplitude envelope (per-sample interpolated) + velocity
    const velGain = 0.25 + 0.75 * this.velocity
    const targetAmp = this.sources[SRC_ENV0] * velGain
    const ampStep = (targetAmp - this.prevAmp) / n
    let amp = this.prevAmp
    for (let i = 0; i < n; i++) {
      amp += ampStep
      outL[i] += bufL[i] * amp
      outR[i] += bufR[i] * amp
    }
    this.prevAmp = targetAmp

    return this.active
  }
}
