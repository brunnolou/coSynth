import { describe, expect, it } from 'vitest'
import { FILTER_TYPES, FILTER_TYPE_LABELS } from '../shared/params'
import { applyKeyTracking, applyModulation, filterMagnitude, type FilterResponseParams } from './filter-response'

const base: FilterResponseParams = {
  type: 0,
  cutoff: 1000,
  resonance: 0,
  drive: 0,
  keytrack: 0,
  mix: 1
}

describe('filterMagnitude', () => {
  it('has a full display name for every stable filter type', () => {
    expect(FILTER_TYPE_LABELS).toHaveLength(FILTER_TYPES.length)
    expect(FILTER_TYPE_LABELS.slice(0, 6)).toEqual([
      'Low Pass 12dB', 'Low Pass 24dB',
      'High Pass 12dB', 'High Pass 24dB',
      'Band Pass 12dB', 'Band Pass 24dB'
    ])
  })

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

describe('applyKeyTracking', () => {
  it('moves cutoff by the played note offset and tracking amount', () => {
    expect(applyKeyTracking(1000, 1, 1 / 3)).toBeCloseTo(2000)
    expect(applyKeyTracking(1000, 1, -1 / 3)).toBeCloseTo(500)
    expect(applyKeyTracking(1000, 0, 1)).toBe(1000)
  })
})
