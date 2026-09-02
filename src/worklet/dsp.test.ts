// Pins the envelope curve sign convention that `PARAM_GROUP_NOTES` now
// advertises. `atk_curve`/`dec_curve`/`rel_curve` are a bare `-1..1` in the
// parameter definitions, so an agent can only get the direction from the note,
// and the note is only true while these measurements hold.
import { describe, expect, it } from 'vitest'
import { Envelope, type EnvParams } from './dsp'

const SR = 48000
const BLOCK = 128

const params = (over: Partial<EnvParams>): EnvParams => ({
  delay: 0, attack: 0.005, hold: 0, decay: 1, sustain: 0, release: 0.1,
  atkCurve: 0, decCurve: 0, relCurve: 0, ...over
})

/** Levels at 25/50/75 % of a stage that runs from `trigger()` for `seconds`. */
function stage(p: EnvParams, seconds: number, gateOffAfter?: number): number[] {
  const env = new Envelope(SR, BLOCK)
  env.trigger()
  if (gateOffAfter !== undefined) {
    for (let i = 0; i < Math.round((gateOffAfter * SR) / BLOCK); i++) env.process(p)
    env.gateOff()
  }
  const levels: number[] = []
  for (let i = 0; i < Math.round((seconds * SR) / BLOCK); i++) levels.push(env.process(p))
  return [0.25, 0.5, 0.75].map(fraction => levels[Math.round(fraction * levels.length) - 1])
}

describe('envelope curve sign', () => {
  it('rises slowly at first for a positive atk_curve and fast for a negative one', () => {
    const [slowQuarter, slowHalf] = stage(params({ attack: 0.5, atkCurve: 0.8 }), 0.5)
    const [fastQuarter, fastHalf] = stage(params({ attack: 0.5, atkCurve: -0.8 }), 0.5)
    const [linearQuarter, linearHalf] = stage(params({ attack: 0.5, atkCurve: 0 }), 0.5)
    expect(linearQuarter).toBeCloseTo(0.25, 1)
    expect(linearHalf).toBeCloseTo(0.5, 1)
    expect(slowQuarter).toBeLessThan(0.05)
    expect(slowHalf).toBeLessThan(linearHalf)
    expect(fastQuarter).toBeGreaterThan(0.7)
    expect(fastHalf).toBeGreaterThan(linearHalf)
  })

  it('falls fast for a positive dec_curve and holds near the peak for a negative one', () => {
    const [fastQuarter] = stage(params({ decay: 1, decCurve: 0.8 }), 1)
    const [heldQuarter, heldHalf] = stage(params({ decay: 1, decCurve: -0.8 }), 1)
    const [defaultQuarter] = stage(params({ decay: 1, decCurve: -0.4 }), 1)
    expect(fastQuarter).toBeLessThan(0.3)
    expect(heldQuarter).toBeGreaterThan(0.99)
    expect(heldHalf).toBeGreaterThan(0.9)
    // The number the group note quotes for the shipped default.
    expect(defaultQuarter).toBeCloseTo(0.96, 2)
  })

  it('applies the same convention to rel_curve as to dec_curve', () => {
    const sustained = { attack: 0.001, decay: 0.001, sustain: 1, release: 1 }
    const [fastQuarter] = stage(params({ ...sustained, relCurve: 0.8 }), 1, 0.1)
    const [heldQuarter] = stage(params({ ...sustained, relCurve: -0.8 }), 1, 0.1)
    expect(fastQuarter).toBeLessThan(0.3)
    expect(heldQuarter).toBeGreaterThan(0.99)
  })
})
