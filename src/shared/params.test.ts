import { describe, expect, it } from 'vitest'
import { DELAY_DIVISIONS, divisionToBeats, PARAMS, paramDef, SYNC_DIVISIONS, SYNC_DIVISION_ORDER } from './params'

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

  it('orders the menu slowest first without touching the stored indices', () => {
    const beats = SYNC_DIVISION_ORDER.map(divisionToBeats)
    expect(beats).toEqual([...beats].sort((a, b) => b - a))
    expect(SYNC_DIVISIONS[SYNC_DIVISION_ORDER[0]]).toBe('31/1')
    expect(SYNC_DIVISIONS[SYNC_DIVISION_ORDER.at(-1)!]).toBe('1/32')
    expect([...SYNC_DIVISION_ORDER].sort((a, b) => a - b)).toEqual(SYNC_DIVISIONS.map((_, i) => i))
  })

  it('keeps the delay on the fast set the 2.5 s delay line can reach', () => {
    expect(DELAY_DIVISIONS).toEqual(ORIGINAL)
    const def = paramDef('delay.division')
    expect(def.choices).toBe(DELAY_DIVISIONS)
    expect(def.max).toBe(ORIGINAL.length - 1)
    expect(def.def).toBe(7)
  })

  it('offers the full set to the LFOs', () => {
    const def = paramDef('lfo1.division')
    expect(def.choices).toBe(SYNC_DIVISIONS)
    expect(def.max).toBe(SYNC_DIVISIONS.length - 1)
    expect(def.def).toBe(4)
  })
})
