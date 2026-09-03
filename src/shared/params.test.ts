import { describe, expect, it } from 'vitest'
import {
  DELAY_DIVISIONS, DIST_TYPES, divisionToBeats, FILTER_ROUTINGS, PARAMS, paramDef,
  SYNC_DIVISIONS, SYNC_DIVISION_ORDER, WAVETABLE_NAMES, WAVETABLE_NOTES
} from './params'
import { fft } from './fft'
import { FRAME_SIZE, generateWavetable, type Wavetable } from './wavetable-gen'

// `unit` is the only scale hint an agent gets before it sends a raw value, so
// it must describe the RAW `min..max` scale — never the scale `fmt` happens to
// render in. A `fmt` may rescale its number (0.005 s prints as "5 ms",
// 8000 Hz as "8.00 kHz"); every such rescaling is spelled out below, so a unit
// derived from a rendered suffix that means something else on the raw scale
// (a percentage of a 0..1 value, degrees off a 0..1 phase) cannot slip in.
// The empty token is the bare raw number: no `fmt`, or one with no suffix.
const RENDER_ALIASES: Record<string, Record<string, number>> = {
  s: { s: 1, ms: 1000 },
  Hz: { Hz: 1, kHz: 0.001 },
  ct: { ct: 1 },
  st: { st: 1, '': 1 },
  dB: { dB: 1 },
  bit: { bit: 1 },
  oct: { oct: 1 },
  ':1': { ':1': 1 },
  voices: { v: 1, '': 1 },
  x: { x: 1, '': 1 },
  BPM: { '': 1 }
}

/** Split a rendered value into its leading number and its trailing unit token. */
function parseRendered(rendered: string): { value: number, token: string } {
  const match = /-?\d+(?:\.\d+)?/.exec(rendered)
  expect(match, `no number in rendered value '${rendered}'`).not.toBeNull()
  return { value: Number(match![0]), token: rendered.slice(match!.index + match![0].length).trim() }
}

describe('parameter unit hints', () => {
  it('names the raw scale, not the rendered one', () => {
    const united = PARAMS.filter(def => def.unit !== undefined)
    expect(united.length).toBeGreaterThan(50)
    for (const def of united) {
      const aliases = RENDER_ALIASES[def.unit!]
      expect(aliases, `unit '${def.unit}' (${def.id}) has no documented rendering`).toBeDefined()
      // At least one rendering must print the raw number as-is: that is what
      // makes the hint a description of the raw scale rather than of a display
      // rescaling ('%' off a 0..1 value could never satisfy this).
      expect(Object.values(aliases), `unit '${def.unit}' never renders the raw value`).toContain(1)
      for (const raw of [def.min, def.def, def.max]) {
        const rendered = def.fmt ? def.fmt(raw) : String(raw)
        const { value, token } = parseRendered(rendered)
        const factor = aliases[token]
        expect(factor, `'${rendered}' (${def.id}) renders an undeclared '${token}' for unit '${def.unit}'`).toBeDefined()
        // Tolerance covers the rounding `fmt` applies for display only.
        expect(Math.abs(value - raw * factor), `${def.id} renders ${rendered} for raw ${raw}`).toBeLessThanOrEqual(0.5)
      }
    }
  })

  it('leaves display-only scales unlabelled', () => {
    expect(PARAMS.filter(def => def.unit === '%' || def.unit === '°')).toEqual([])
    // 0..1 raw, rendered as a percentage and as degrees respectively.
    expect(paramDef('master.volume').unit).toBeUndefined()
    expect(paramDef('osc1.phase').unit).toBeUndefined()
    // Seconds raw, rendered in milliseconds below 1 s.
    expect(paramDef('env1.attack').unit).toBe('s')
    expect(paramDef('delay.time').unit).toBe('s')
  })
})


// `group` is what `get_parameter_schema` advertises as the filter key, so a
// group name no id carries sends an agent looking for `<group>.*` parameters
// that do not exist. A group is legitimate when some id starts with its name,
// or when it deliberately collects several sections (`macros` holds
// macro1..macro4). `global` is the one grandfathered exception: it holds the
// `master.*` parameters under the section name the UI has always shown.
const AGGREGATE_GROUPS = ['global']

describe('parameter groups', () => {
  it('names every group after a prefix its parameters actually use', () => {
    const prefixes = new Set(PARAMS.map(def => def.id.split('.')[0]))
    for (const group of new Set(PARAMS.map(def => def.group))) {
      if (AGGREGATE_GROUPS.includes(group)) continue
      const memberPrefixes = new Set(PARAMS.filter(def => def.group === group).map(def => def.id.split('.')[0]))
      const named = prefixes.has(group) || memberPrefixes.size > 1
      expect(named, `group '${group}' matches no parameter id prefix (${[...memberPrefixes].join(', ')})`).toBe(true)
    }
  })

  it('keeps the persisted filter.routing id while grouping it with the filters', () => {
    expect(paramDef('filter.routing').id).toBe('filter.routing')
    expect(paramDef('filter.routing').group).toBe('filter')
  })
})


// The thirteen divisions that shipped first. Presets address a division by its
// position in SYNC_DIVISIONS, so this list has to stay put at the front.
const ORIGINAL = ['1/1', '1/2', '1/2T', '1/4.', '1/4', '1/4T', '1/8.', '1/8', '1/8T', '1/16.', '1/16', '1/16T', '1/32']
const ORIGINAL_BEATS = [4, 2, 4 / 3, 1.5, 1, 2 / 3, 0.75, 0.5, 1 / 3, 0.375, 0.25, 1 / 6, 0.125]

describe('sync divisions', () => {
  it('keeps every pre-existing index pointing at the same division', () => {
    expect(SYNC_DIVISIONS.slice(0, ORIGINAL.length)).toEqual(ORIGINAL)
    expect(SYNC_DIVISIONS[4]).toBe('1/4')  // lfo*.division default
    expect(SYNC_DIVISIONS[7]).toBe('1/8')  // delay.division default
  })

  it('appends the slow whole note multiples 2/1..31/1', () => {
    expect(SYNC_DIVISIONS.slice(ORIGINAL.length)).toEqual(
      Array.from({ length: 30 }, (_, i) => `${i + 2}/1`)
    )
    expect(SYNC_DIVISIONS).toHaveLength(43)
  })

  it('leaves the beats of every original division unchanged', () => {
    ORIGINAL_BEATS.forEach((beats, i) => expect(divisionToBeats(i)).toBeCloseTo(beats, 10))
  })

  it('reads N/1 as N whole notes, i.e. 4N beats', () => {
    for (let n = 2; n <= 31; n++) {
      expect(divisionToBeats(SYNC_DIVISIONS.indexOf(`${n}/1`))).toBe(4 * n)
    }
  })

  it('spans 62 s per cycle at the slow end at 120 BPM', () => {
    const seconds = (index: number) => divisionToBeats(index) * 60 / 120
    expect(seconds(SYNC_DIVISIONS.indexOf('31/1'))).toBe(62)
    expect(seconds(SYNC_DIVISIONS.indexOf('1/32'))).toBeCloseTo(0.0625, 10)
  })

  it('falls back to one beat for an out-of-range index', () => {
    expect(divisionToBeats(-1)).toBe(1)
    expect(divisionToBeats(SYNC_DIVISIONS.length)).toBe(1)
  })

  it('prepends the slow multiples and keeps the original grouping after them', () => {
    const labels = SYNC_DIVISION_ORDER.map(i => SYNC_DIVISIONS[i])
    // Slow block: longest first, down to 2/1.
    expect(labels.slice(0, 30)).toEqual(Array.from({ length: 30 }, (_, i) => `${31 - i}/1`))
    // Then the thirteen originals, in their own order - not re-sorted by
    // duration, so dotted and triplet values stay grouped with their beat and
    // this menu still agrees with the delay's.
    expect(labels.slice(30)).toEqual(ORIGINAL)
    expect(labels[30]).toBe('1/1')
    expect(labels.at(-1)).toBe('1/32')
    // Every index appears exactly once: presentation only, nothing dropped.
    expect([...SYNC_DIVISION_ORDER].sort((a, b) => a - b)).toEqual(SYNC_DIVISIONS.map((_, i) => i))
  })

  it('keeps the delay on the fast set, which limits but does not remove the buffer clamp', () => {
    expect(DELAY_DIVISIONS).toEqual(ORIGINAL)
    const def = paramDef('delay.division')
    expect(def.choices).toBe(DELAY_DIVISIONS)
    expect(def.max).toBe(ORIGINAL.length - 1)
    expect(def.def).toBe(7)

    // Not a clamp-free set: worklet/effects.ts caps the delay line at 2.4 s while
    // worklet/processor.ts asks for divisionToBeats(div) * 60 / bpm, so the fast set
    // already overruns the buffer at the low end of master.bpm (20..300). Excluding
    // the slow set narrows that hole; it does not close it.
    const seconds = (name: string, bpm: number) => divisionToBeats(SYNC_DIVISIONS.indexOf(name)) * 60 / bpm
    expect(seconds('1/1', 90)).toBeGreaterThan(2.4)   // already clamped today
    expect(seconds('1/1', 100)).toBeCloseTo(2.4, 10)  // exactly at the cap
    expect(seconds('1/2', 40)).toBeGreaterThan(2.4)
    expect(seconds('2/1', 190)).toBeGreaterThan(2.4)  // why the slow set stays out
    expect(seconds('1/8', 20)).toBeLessThan(2.4)      // the default is safe everywhere
  })

  it('offers the full set to the LFOs', () => {
    const def = paramDef('lfo1.division')
    expect(def.choices).toBe(SYNC_DIVISIONS)
    expect(def.max).toBe(SYNC_DIVISIONS.length - 1)
    expect(def.def).toBe(4)
  })
})


// ---------------------------------------------------------------- choice notes

/**
 * A `choices` array hands an agent a list of names. For most enumerations that
 * is enough - `LP 12` and `1/8` say what they are - but for a few the name
 * carries none of the behaviour, and the only way to learn it is to render the
 * sound and listen. `choiceNotes` is for exactly those, and these tests are
 * what stop it decaying into decoration: a choice added without a note fails,
 * and every harmonic claim in a note is re-measured from the DSP below.
 */
describe('choice notes', () => {
  const annotated = PARAMS.filter(def => def.choiceNotes !== undefined)

  it('covers every choice of every annotated parameter, and nothing else', () => {
    expect(annotated.map(def => def.id)).toEqual([
      'osc1.wavetable', 'osc2.wavetable', 'osc3.wavetable', 'filter.routing', 'dist.type'
    ])
    for (const def of annotated) {
      // Same order as `choices`, so a renderer can walk either one, and exactly
      // the same membership, so adding a wavetable without describing it fails
      // here rather than shipping a name with no timbre behind it.
      expect(Object.keys(def.choiceNotes!), `${def.id} choiceNotes must match its choices`).toEqual(def.choices)
      for (const [choice, note] of Object.entries(def.choiceNotes!)) {
        expect(note.trim(), `${def.id}/${choice} note is empty`).not.toBe('')
      }
    }
    expect(Object.keys(WAVETABLE_NOTES)).toEqual(WAVETABLE_NAMES)
    expect(Object.keys(paramDef('dist.type').choiceNotes!)).toEqual(DIST_TYPES)
    expect(Object.keys(paramDef('filter.routing').choiceNotes!)).toEqual(FILTER_ROUTINGS)
  })

  it('stays inside a length budget a schema response can afford', () => {
    // The whole point of putting these on the parameter rather than in the tool
    // listing is that they are paid once, by the caller that asked about the
    // parameter. That only holds while they stay small: 300 characters each is
    // about three sentences, and the seven wavetable notes together must stay
    // under 2 kB so a full-format page carrying all three oscillators' tables
    // adds single-digit kB, not tens.
    for (const def of PARAMS) {
      for (const [choice, note] of Object.entries(def.choiceNotes ?? {})) {
        expect(note.length, `${def.id}/${choice} note is ${note.length} characters`).toBeLessThanOrEqual(300)
      }
    }
    const wavetableBytes = Object.values(WAVETABLE_NOTES).reduce((sum, note) => sum + note.length, 0)
    expect(wavetableBytes).toBeLessThanOrEqual(2000)
  })

  it('says which dist parameters each dist.type branch actually reads', () => {
    // `worklet/voice.ts` computes `drive` for every type and then never uses it
    // on the Bitcrush branch, which reads `dist.bits` and `dist.downsample`
    // instead - the one thing about this enum an agent cannot guess.
    const notes = paramDef('dist.type').choiceNotes!
    expect(notes.Bitcrush).toMatch(/UNUSED/)
    expect(notes.Bitcrush).toMatch(/dist\.bits/)
    expect(notes.Bitcrush).toMatch(/dist\.downsample/)
    for (const type of ['Soft Clip', 'Hard Clip', 'Wavefold']) {
      expect(notes[type], `${type} must name the drive gain law`).toMatch(/15\*drive/)
    }
  })
})


// ---------------------------------------------------------------- wavetable timbre

/**
 * The wavetable descriptions, re-measured from the tables the synth actually
 * plays.
 *
 * Every helper here mirrors a specific piece of production code so that a claim
 * proved against it is a claim about the sound:
 * - `cycleAtMorph` reproduces `WavetableData.read()` (`worklet/dsp.ts`), which
 *   picks frames with `morph * (numFrames - 1)` and crossfades them in the TIME
 *   domain. Measuring a key frame directly would flatter the descriptions at
 *   morph positions the oscillator reaches by interpolation.
 * - `partialsDbRelF0`, `tilt` and `oddEven` mirror `measureHarmonicShape()`
 *   (`shared/audio-analysis.ts`): levels relative to the fundamental, a
 *   least-squares fit of level against log2(n) for the tilt, mean(odd) minus
 *   mean(even) for the balance, and both over the first HARMONIC_COUNT partials
 *   only. That cap is why every figure in the notes is qualified "partials
 *   1..12": it is the window the match diff reports from, so a number measured
 *   over any other window would not be the number an agent is reading.
 */
const HARMONIC_COUNT = 12
const FLOOR_DB = -120
/** Morph positions swept whenever a note claims something "across the morph". */
const MORPH_SWEEP = Array.from({ length: 21 }, (_, i) => i / 20)

function cycleAtMorph(table: Wavetable, morph: number): Float32Array {
  const fpos = morph * (table.numFrames - 1)
  let f0 = Math.floor(fpos)
  if (f0 >= table.numFrames - 1) f0 = table.numFrames - 2
  if (f0 < 0) f0 = 0
  const t = table.numFrames > 1 ? fpos - f0 : 0
  const out = new Float32Array(FRAME_SIZE)
  for (let i = 0; i < FRAME_SIZE; i++) {
    const a = table.data[f0 * FRAME_SIZE + i]
    const b = table.data[(f0 + 1) * FRAME_SIZE + i]
    out[i] = a + (b - a) * t
  }
  return out
}

/** Partial levels in dB relative to the fundamental; unmeasurable partials read the floor. */
function partialsDbRelF0(cycle: Float32Array, count = HARMONIC_COUNT): number[] {
  const re = new Float32Array(cycle)
  const im = new Float32Array(FRAME_SIZE)
  fft(re, im)
  const magnitude = (k: number) => Math.hypot(re[k], im[k]) * 2 / FRAME_SIZE
  const f0 = magnitude(1)
  return Array.from({ length: count }, (_, i) => {
    const m = magnitude(i + 1)
    return f0 > 0 && m > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(m / f0)) : FLOOR_DB
  })
}

const measurable = (db: readonly number[]) => db.map((value, i) => ({ n: i + 1, db: value })).filter(point => point.db > FLOOR_DB)

function tilt(db: readonly number[]): number {
  const points = measurable(db)
  if (points.length < 2) return 0
  const meanX = points.reduce((sum, p) => sum + Math.log2(p.n), 0) / points.length
  const meanY = points.reduce((sum, p) => sum + p.db, 0) / points.length
  let covariance = 0
  let variance = 0
  for (const p of points) {
    const x = Math.log2(p.n) - meanX
    covariance += x * (p.db - meanY)
    variance += x * x
  }
  return variance > 0 ? covariance / variance : 0
}

function oddEven(db: readonly number[]): number {
  const points = measurable(db)
  const mean = (subset: { db: number }[]) => subset.length > 0 ? subset.reduce((sum, p) => sum + p.db, 0) / subset.length : FLOOR_DB
  return mean(points.filter(p => p.n % 2 === 1)) - mean(points.filter(p => p.n % 2 === 0))
}

const rms = (cycle: Float32Array) => Math.sqrt(cycle.reduce((sum, v) => sum + v * v, 0) / cycle.length)
const shapeAt = (table: Wavetable, morph: number, count = HARMONIC_COUNT) => partialsDbRelF0(cycleAtMorph(table, morph), count)
const evensSilent = (db: readonly number[]) => db.every((value, i) => (i + 1) % 2 === 1 || value <= FLOOR_DB)

const tables = Object.fromEntries(
  WAVETABLE_NAMES.filter(name => name !== 'Custom').map(name => [name, generateWavetable(name)])
) as Record<string, Wavetable>

describe('wavetable descriptions match the generated tables', () => {
  it('Basic Shapes: sine, triangle, saw, square on exact morph positions', () => {
    const table = tables['Basic Shapes']
    // 34 frames is (4 recipes - 1) * 11 + 1, chosen so each named shape lands on
    // a frame; that is what lets the note quote exact morph positions.
    expect(table.snapPoints?.map(point => point.label)).toEqual(['Sine', 'Triangle', 'Saw', 'Square'])

    // Numbers quoted in the note are asserted as text too, so a description
    // edited away from the DSP fails alongside the measurement that backs it.
    const note = WAVETABLE_NOTES['Basic Shapes']
    expect(note).toContain('-12 dB/oct')
    expect(note).toContain('-6 dB/oct')
    expect(note).toContain('odd/even +2 dB')

    const sine = shapeAt(table, 0)
    expect(measurable(sine)).toHaveLength(1)

    const triangle = shapeAt(table, 1 / 3)
    expect(evensSilent(triangle)).toBe(true)
    expect(tilt(triangle)).toBeCloseTo(-12, 0)

    const saw = shapeAt(table, 2 / 3)
    expect(measurable(saw)).toHaveLength(HARMONIC_COUNT)
    expect(tilt(saw)).toBeCloseTo(-6, 0)
    expect(oddEven(saw)).toBeCloseTo(2, 0)

    const square = shapeAt(table, 1)
    expect(evensSilent(square)).toBe(true)
    expect(tilt(square)).toBeCloseTo(-6, 0)

    // "Even partials fade in over 1/3..2/3 and back out by 1."
    expect(evensSilent(shapeAt(table, 0.5))).toBe(false)
    expect(evensSilent(shapeAt(table, 0.9))).toBe(false)
  })

  it('Harmonic Sweep: the partial count is 2^(5*morph), capped at 32', () => {
    const table = tables['Harmonic Sweep']
    const note = WAVETABLE_NOTES['Harmonic Sweep']
    expect(note).toContain('2^(5*morph)')
    expect(note).toContain('-3 dB/oct')
    expect(note).toContain('harmonic 32')
    // Within 30 dB of the fundamental: the brick wall is ~35 dB deep at every
    // key frame, so this counts the harmonics that are on rather than the
    // crossfade skirt of the next key frame.
    const audible = (morph: number) => shapeAt(table, morph, 64).filter(value => value > -30).length
    for (const [morph, expected] of [[0, 1], [0.2, 2], [0.4, 4], [0.6, 8], [0.8, 16], [1, 32]] as const) {
      expect(audible(morph), `morph ${morph}`).toBe(expected)
    }
    // "Morph moves the cutoff, not the shape": 1/sqrt(k) is -3 dB per doubling.
    expect(tilt(shapeAt(table, 1))).toBeCloseTo(-3, 1)
    expect(oddEven(shapeAt(table, 1))).toBeCloseTo(1, 0)
    // "nothing exceeds harmonic 32", at any morph.
    for (const morph of MORPH_SWEEP) {
      const tail = shapeAt(table, morph, 200).slice(32)
      expect(Math.max(...tail), `morph ${morph} has content above harmonic 32`).toBe(FLOOR_DB)
    }
  })

  it('PWM: a pulse of width 0.50 down to 0.05, notches and all', () => {
    const table = tables.PWM
    expect(WAVETABLE_NOTES.PWM).toContain('50%')
    expect(WAVETABLE_NOTES.PWM).toContain('5%')
    expect(WAVETABLE_NOTES.PWM).toContain('1/width')
    // The whole description in one assertion: `pwmFrame` is an additive pulse
    // whose k-th partial is |sin(pi*k*w)|/k, so predicting every partial from w
    // alone proves the width sweep, the -6 dB/oct envelope AND the notches at
    // multiples of 1/w. Frames are addressed directly (morph f/31 lands on frame
    // f) because a crossfade between two widths is not itself a pulse.
    for (const frame of [0, 5, 10, 20, 25, 31]) {
      const width = 0.5 - (frame / (table.numFrames - 1)) * 0.45
      const measured = shapeAt(table, frame / (table.numFrames - 1), 24)
      const reference = Math.abs(Math.sin(Math.PI * width))
      measured.forEach((value, i) => {
        const k = i + 1
        const amplitude = Math.abs(Math.sin(Math.PI * k * width)) / k
        const predicted = amplitude > 0 ? 20 * Math.log10(amplitude / reference) : FLOOR_DB
        if (value > -55 && predicted > -55) {
          expect(value, `frame ${frame} (width ${width.toFixed(3)}) partial ${k}`).toBeCloseTo(predicted, 1)
        }
      })
    }

    // Morph 0 is a 50% pulse, which IS a square: same partials as Basic Shapes' own.
    const square = shapeAt(table, 0)
    expect(evensSilent(square)).toBe(true)
    expect(tilt(square)).toBeCloseTo(-6, 0)
    square.forEach((value, i) => expect(value).toBeCloseTo(shapeAt(tables['Basic Shapes'], 1)[i], 1))

    // Morph 1 is the 5% pulse: near-flat over partials 1..12, and much quieter.
    const narrow = shapeAt(table, 1)
    expect(Math.max(...narrow) - Math.min(...narrow)).toBeLessThanOrEqual(6)
    expect(tilt(narrow)).toBeCloseTo(-1.5, 0)
    const rmsDrop = 20 * Math.log10(rms(cycleAtMorph(table, 1)) / rms(cycleAtMorph(table, 0)))
    expect(rmsDrop).toBeCloseTo(-7, 0)
  })

  it('Vocal: formants pinned to harmonic numbers, so they transpose with the note', () => {
    const table = tables.Vocal
    expect(WAVETABLE_NOTES.Vocal).toContain('tilt +2.6')
    expect(WAVETABLE_NOTES.Vocal).toContain('-14 dB/oct')
    expect(WAVETABLE_NOTES.Vocal).toContain('harmonic 47')
    // `vocalFrame` weights harmonic k by Gaussians centred on harmonic NUMBERS,
    // not on frequencies, so a formant sits on the same partial at every pitch.
    // At morph 0 those centres are 6/9/22, which puts partial 6 far above the
    // fundamental - the tilt reads POSITIVE, which no other table does.
    const open = shapeAt(table, 0)
    expect(open.indexOf(Math.max(...open)) + 1).toBe(6)
    expect(Math.max(...open)).toBeGreaterThan(15)
    expect(tilt(open)).toBeCloseTo(2.6, 0)

    const tilts = MORPH_SWEEP.map(morph => tilt(shapeAt(table, morph)))
    expect(MORPH_SWEEP[tilts.indexOf(Math.min(...tilts))]).toBe(0.5)
    expect(Math.min(...tilts)).toBeCloseTo(-14.3, 0)
    expect(tilt(shapeAt(table, 1))).toBeCloseTo(-7, 0)

    for (const morph of MORPH_SWEEP) {
      expect(Math.abs(oddEven(shapeAt(table, morph))), `morph ${morph}`).toBeLessThanOrEqual(3.2)
      // "Nothing above harmonic 47 at all": the Gaussians have run out by then.
      expect(Math.max(...shapeAt(table, morph, 200).slice(47)), `morph ${morph}`).toBe(FLOOR_DB)
    }
  })

  it('FM Bell: partials in gaps, and at morph 1 only k mod 5 = 1 or 4 survives', () => {
    const table = tables['FM Bell']
    expect(WAVETABLE_NOTES['FM Bell']).toContain('k mod 5 = 1 or 4')
    expect(WAVETABLE_NOTES['FM Bell']).toContain('morph 0.7')
    // Key frames are sin(ph + index*sin(ratio*ph)); sidebands land at |1 +- n*ratio|.
    const near = shapeAt(table, 0)          // index 0.5, ratio 2 -> odd only
    expect(evensSilent(near)).toBe(true)
    expect(near[2]).toBeCloseTo(-15, 0)

    const bell = shapeAt(table, 1)          // index 7, ratio 5
    const alive = measurable(bell).map(point => point.n)
    expect(alive).toEqual([1, 4, 6, 9, 11])
    expect(alive.every(n => n % 5 === 1 || n % 5 === 4)).toBe(true)
    // "9 and 11 as loud as the fundamental."
    expect(bell[8]).toBeCloseTo(0, 0)
    expect(bell[10]).toBeCloseTo(0, 0)

    // "Widest around morph 0.7": highest partial still within 60 dB of the peak.
    const width = (morph: number) => {
      const db = shapeAt(table, morph, 300)
      const peak = Math.max(...db)
      let highest = 1
      db.forEach((value, i) => { if (value > peak - 60) highest = i + 1 })
      return highest
    }
    const widths = MORPH_SWEEP.map(width)
    const widest = MORPH_SWEEP[widths.indexOf(Math.max(...widths))]
    expect(widest).toBeGreaterThanOrEqual(0.6)
    expect(widest).toBeLessThanOrEqual(0.8)
  })

  it('Digital: the only near-flat table, with nulls at multiples of the step count', () => {
    const table = tables.Digital
    expect(WAVETABLE_NOTES.Digital).toContain('-3.3 and +0.7 dB/oct')
    expect(WAVETABLE_NOTES.Digital).toContain('-20 dB')
    expect(WAVETABLE_NOTES.Digital).toContain('15..31')
    for (const morph of MORPH_SWEEP) {
      const db = shapeAt(table, morph)
      expect(tilt(db), `morph ${morph} tilt`).toBeGreaterThanOrEqual(-3.4)
      expect(tilt(db), `morph ${morph} tilt`).toBeLessThanOrEqual(0.8)
      expect(Math.min(...db), `morph ${morph} weakest partial`).toBeGreaterThan(-20)
    }

    // "The ONLY near-flat table": every other generated table is at least
    // 6 dB/oct darker somewhere in its sweep, which is what makes Digital the
    // answer to a match diff that says the candidate is too dark.
    for (const name of Object.keys(tables)) {
      if (name === 'Digital') continue
      const darkest = Math.min(...MORPH_SWEEP.map(morph => tilt(shapeAt(tables[name], morph))))
      expect(darkest, `${name} is never steeply falling`).toBeLessThanOrEqual(-6)
    }

    // "15..31 equal steps per cycle, so partials at multiples of the step count
    // drop out": a staircase of S equal steps is a sum of rectangles of width
    // 1/S, whose transform has zeros at every multiple of S. Morph 0 and morph 1
    // are the outer key frames (`digitalFrame(7)` = 15 steps, `digitalFrame(31415)`
    // = 31), so they pin both ends of the quoted range.
    // The levels between nulls are random, so a null is measured against the
    // typical partial rather than against its immediate neighbours - two random
    // levels either side of a null can both land low by chance.
    for (const [morph, steps] of [[0, 15], [1, 31]] as const) {
      const db = shapeAt(table, morph, 3 * steps)
      const between = db.filter((_, i) => (i + 1) % steps !== 0).sort((a, b) => a - b)
      const median = between[Math.floor(between.length / 2)]
      for (const multiple of [1, 2, 3]) {
        const k = steps * multiple
        expect(db[k - 1], `morph ${morph} partial ${k}`).toBeLessThan(median - 15)
      }
    }
  })

  it('Custom: an empty slot that silently plays Digital', () => {
    // `engine.ts` resolves the choice with `WAVETABLE_NAMES[Math.min(sel, CUSTOM_WT - 1)]`
    // whenever no WAV has been imported for that oscillator, and no WebMCP tool
    // imports one - `importWavetableFile` takes a `File` from the browser UI. So
    // an agent that selects Custom gets Digital and no error, which is the only
    // thing worth saying about this choice.
    const custom = WAVETABLE_NAMES.indexOf('Custom')
    expect(custom).toBe(WAVETABLE_NAMES.length - 1)
    expect(WAVETABLE_NAMES[Math.min(custom, custom - 1)]).toBe('Digital')
    expect(WAVETABLE_NOTES.Custom).toMatch(/falls back to Digital/)
  })
})
