import { describe, expect, it } from 'vitest'
import { analyzeAudio } from './audio-analysis'

function sine(frequency: number, sampleRate: number, seconds: number, amplitude = 1, phase = 0): Float32Array {
  return Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_, i) =>
    amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate + phase))
}

describe('analyzeAudio', () => {
  it('measures peak, RMS, clipping, DC, and spectral centroid', () => {
    const sampleRate = 8192
    const signal = sine(1024, sampleRate, 1, 0.5)
    const metrics = analyzeAudio([signal], sampleRate)
    expect(metrics.peakDb).toBeCloseTo(-6.0206, 2)
    expect(metrics.rmsDb).toBeCloseTo(-9.0309, 2)
    expect(metrics.clippingCount).toBe(0)
    expect(metrics.dcOffset).toBeCloseTo(0, 5)
    expect(metrics.spectralCentroidHz).toBeCloseTo(1024, 0)
  })

  it('counts clipped samples and reports DC offset', () => {
    const metrics = analyzeAudio([new Float32Array([1, -1.2, 0.5, 0.5])], 1000)
    expect(metrics.clippingCount).toBe(2)
    expect(metrics.dcOffset).toBeCloseTo(0.2, 5)
    expect(metrics.peakDb).toBeGreaterThan(0)
  })

  it('finds 10%-to-90% attack time', () => {
    const sampleRate = 1000
    const signal = Float32Array.from({ length: 200 }, (_, i) => i < 100 ? i / 100 : 1)
    expect(analyzeAudio([signal], sampleRate).attackMs).toBeCloseTo(80, 0)
  })

  it('distinguishes mono and anti-phase stereo width', () => {
    const left = sine(200, 4096, 1, 0.5)
    const same = analyzeAudio([left, new Float32Array(left)], 4096)
    const opposite = analyzeAudio([left, Float32Array.from(left, value => -value)], 4096)
    expect(same.stereoWidth).toBeCloseTo(0, 5)
    expect(opposite.stereoWidth).toBeCloseTo(1, 5)
  })

  it('analyzes a tone that begins after 500ms instead of only the render prefix', () => {
    const sampleRate = 48000
    const signal = new Float32Array(sampleRate)
    for (let index = Math.round(sampleRate * 0.6); index < signal.length; index++) {
      signal[index] = 0.5 * Math.sin(2 * Math.PI * 3000 * index / sampleRate)
    }
    expect(analyzeAudio([signal], sampleRate).spectralCentroidHz).toBeCloseTo(3000, -1)
  })

  it('finds a short tone between the old sparse windows in a 15-second render', () => {
    const sampleRate = 48000
    const signal = new Float32Array(sampleRate * 15)
    for (let index = sampleRate * 0.5; index < sampleRate * 0.55; index++) {
      signal[index] = 0.5 * Math.sin(2 * Math.PI * 3000 * index / sampleRate)
    }
    expect(analyzeAudio([signal], sampleRate).spectralCentroidHz).toBeCloseTo(3000, -1)
  })

  it('preserves spectral energy for anti-phase stereo', () => {
    const left = sine(1024, 8192, 1, 0.5)
    const right = Float32Array.from(left, value => -value)
    expect(analyzeAudio([left, right], 8192).spectralCentroidHz).toBeCloseTo(1024, 0)
  })

  it('aggregates channel power independently when channels contain distinct tones', () => {
    const left = sine(512, 8192, 1, 1)
    const right = sine(1536, 8192, 1, 0.5)
    expect(analyzeAudio([left, right], 8192).spectralCentroidHz).toBeCloseTo(716.8, 0)
  })

  it('handles silence and rejects malformed input', () => {
    expect(analyzeAudio([new Float32Array(32)], 48000)).toMatchObject({
      peakDb: -160,
      rmsDb: -160,
      spectralCentroidHz: 0,
      attackMs: 0,
      stereoWidth: 0
    })
    expect(() => analyzeAudio([], 48000)).toThrow(/channel/i)
    expect(() => analyzeAudio([new Float32Array(2)], 0)).toThrow(/sample rate/i)
  })
})
