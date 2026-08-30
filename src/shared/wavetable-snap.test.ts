import { describe, expect, it } from 'vitest'
import { ifft } from './fft'
import { FRAME_SIZE, generateWavetable, wavToWavetable } from './wavetable-gen'
import { nextSnapPoint, SNAP_EPSILON, wavetableSnapPoints } from './wavetable-snap'

const basic = generateWavetable('Basic Shapes')
const anchors = wavetableSnapPoints(basic)

describe('Basic Shapes snap metadata', () => {
  it('places named recipes on exact stored frames', () => {
    expect(basic.numFrames).toBe(34)
    expect(anchors).toEqual([
      { label: 'Sine', position: 0 }, { label: 'Triangle', position: 1 / 3 },
      { label: 'Saw', position: 2 / 3 }, { label: 'Square', position: 1 }
    ])
    expect(anchors.map(point => point.position * (basic.numFrames - 1))).toEqual([0, 11, 22, 33])
  })

  it.each([0, 1, 2, 3])('matches source harmonics at anchor %i, up to normalization', anchor => {
    const real = new Float32Array(FRAME_SIZE)
    const imaginary = new Float32Array(FRAME_SIZE)
    for (let harmonic = 1; harmonic <= (anchor < 2 ? 512 : 800); harmonic++) {
      const amplitude = anchor === 0 ? (harmonic === 1 ? 1 : 0)
        : anchor === 1 ? (harmonic % 2 ? (harmonic % 4 === 1 ? 1 : -1) * 8 / (Math.PI ** 2 * harmonic ** 2) : 0)
          : anchor === 2 ? 2 / (Math.PI * harmonic)
            : harmonic % 2 ? 4 / (Math.PI * harmonic) : 0
      imaginary[harmonic] = -amplitude * FRAME_SIZE / 2
      imaginary[FRAME_SIZE - harmonic] = amplitude * FRAME_SIZE / 2
    }
    ifft(real, imaginary)
    const frame = anchors[anchor].position * (basic.numFrames - 1)
    const actual = basic.data.subarray(frame * FRAME_SIZE, (frame + 1) * FRAME_SIZE)
    const expectedPeak = Math.max(...real.map(Math.abs))
    const actualPeak = Math.max(...actual.map(Math.abs))
    let maxError = 0
    for (let i = 0; i < FRAME_SIZE; i++) maxError = Math.max(maxError, Math.abs(real[i] / expectedPeak - actual[i] / actualPeak))
    expect(maxError).toBeLessThan(0.00001)
  })

  it('leaves other tables and imported names without invented metadata', () => {
    for (const name of ['Harmonic Sweep', 'PWM', 'Vocal', 'FM Bell', 'Digital']) {
      const table = generateWavetable(name)
      expect(table.numFrames).toBe(32)
      expect(table.snapPoints).toBeUndefined()
    }
    const imported = wavToWavetable('Basic Shapes', { sampleRate: 44100, channelData: new Float32Array(FRAME_SIZE) })
    expect(wavetableSnapPoints(imported)).toEqual([])
  })
})

describe('nextSnapPoint', () => {
  it('cycles through the next anchor and wraps', () => {
    expect(anchors.map(point => nextSnapPoint(anchors, point.position)?.label)).toEqual(['Triangle', 'Saw', 'Square', 'Sine'])
  })
  it('advances from intermediate values and respects the anchor tolerance', () => {
    expect(nextSnapPoint(anchors, 0.2)?.label).toBe('Triangle')
    expect(nextSnapPoint(anchors, 0.5)?.label).toBe('Saw')
    expect(nextSnapPoint(anchors, 1 / 3 - SNAP_EPSILON / 2)?.label).toBe('Saw')
    expect(nextSnapPoint(anchors, 1 / 3 + SNAP_EPSILON / 2)?.label).toBe('Saw')
    expect(nextSnapPoint(anchors, 1 / 3 - SNAP_EPSILON * 2)?.label).toBe('Triangle')
    expect(nextSnapPoint(anchors, Math.fround(1 / 3))?.label).toBe('Saw')
  })
  it('leaves absent, single-anchor, and invalid input passive', () => {
    expect(wavetableSnapPoints()).toEqual([])
    expect(wavetableSnapPoints(null)).toEqual([])
    expect(nextSnapPoint([], 0)).toBeUndefined()
    expect(nextSnapPoint([anchors[0]], 0.8)).toBeUndefined()
    expect(nextSnapPoint(anchors, NaN)).toBeUndefined()
  })
  it('sorts and filters metadata without mutating the source', () => {
    const points = [anchors[3], { label: 'Bad', position: NaN }, anchors[0],
      { label: 'Duplicate', position: 0 }, { label: ' ', position: 0.5 }, { label: 'Out', position: 2 }]
    expect(wavetableSnapPoints({ ...basic, snapPoints: points })).toEqual([anchors[0], anchors[3]])
    expect(points[0]).toBe(anchors[3])
  })
})
