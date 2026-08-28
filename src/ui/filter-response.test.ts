import { describe, expect, it } from 'vitest'
import { filterMagnitude, type FilterResponseParams } from './filter-response'

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
