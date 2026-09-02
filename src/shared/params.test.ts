import { describe, expect, it } from 'vitest'
import { PARAMS, paramDef } from './params'

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
