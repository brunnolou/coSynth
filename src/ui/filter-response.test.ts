import { describe, expect, it } from 'vitest'
import { applyModulation, filterMagnitude, type FilterResponseParams } from './filter-response'

const base: FilterResponseParams = {
  type: 0,
  cutoff: 1000,
  resonance: 0,
  drive: 0,
  keytrack: 0,
  mix: 1
}

describe('filterMagnitude', () => {
  it('rolls off frequencies above a low-pass cutoff', () => {
    expect(filterMagnitude(100, base)).toBeGreaterThan(filterMagnitude(10000, base))
  })

  it('rolls off frequencies below a high-pass cutoff', () => {
    const highPass = { ...base, type: 2 }
    expect(filterMagnitude(10000, highPass)).toBeGreaterThan(filterMagnitude(100, highPass))
  })

  it('returns finite magnitudes for every filter model', () => {
    for (let type = 0; type < 9; type++) {
      expect(Number.isFinite(filterMagnitude(1000, { ...base, type, resonance: 1 }))).toBe(true)
    }
  })
})

describe('applyModulation', () => {
  it('tracks enabled source values and clamps the result', () => {
    const routes = [
      { source: 0, depth: 0.5, enabled: true },
      { source: 1, depth: -0.25, enabled: true },
      { source: 2, depth: 1, enabled: false }
    ]
    expect(applyModulation(0.3, routes, [0.8, 0.4, 1])).toBeCloseTo(0.6)
    expect(applyModulation(0.8, [{ source: 0, depth: 1, enabled: true }], [1])).toBe(1)
  })
})
