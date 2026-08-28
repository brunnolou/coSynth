import { describe, expect, it } from 'vitest'
import type { Wavetable } from '../shared/wavetable-gen'
import { wavetableSample } from './osc-wave-preview'

describe('wavetableSample', () => {
  const table: Wavetable = {
    name: 'test',
    frameSize: 2,
    numFrames: 2,
    data: new Float32Array([0, 1, 1, -1])
  }

  it('reads each oscillator frame at its morph position', () => {
    expect(wavetableSample(table, 0, 1)).toBe(1)
    expect(wavetableSample(table, 1, 1)).toBe(-1)
  })

  it('interpolates between wavetable frames', () => {
    expect(wavetableSample(table, 0.5, 0)).toBeCloseTo(0.5)
  })
})
