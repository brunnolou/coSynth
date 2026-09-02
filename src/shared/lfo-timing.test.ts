import { describe, it, expect } from 'vitest'
import { divisionToBeats, freqToBeatsPerCycle, SYNC_DIVISIONS } from './params'

describe('freqToBeatsPerCycle', () => {
  it('counts beats per cycle, not cycles per beat', () => {
    // 120 BPM = 2 beats/sec. A 1 Hz LFO cycles once a second, so 2 beats/cycle.
    expect(freqToBeatsPerCycle(1, 120)).toBeCloseTo(2, 10)
    // A 4 Hz LFO cycles four times a second: half a beat per cycle.
    expect(freqToBeatsPerCycle(4, 120)).toBeCloseTo(0.5, 10)
  })

  it('scales with tempo and inversely with rate', () => {
    // Twice the tempo fits twice as many beats into the same cycle.
    expect(freqToBeatsPerCycle(2, 240)).toBeCloseTo(2 * freqToBeatsPerCycle(2, 120), 10)
    // Twice the rate halves the cycle, so half the beats.
    expect(freqToBeatsPerCycle(4, 120)).toBeCloseTo(freqToBeatsPerCycle(2, 120) / 2, 10)
  })

  it('agrees with divisionToBeats where a free rate matches a sync division', () => {
    // The processor derives a synced LFO's rate as bpm / 60 / divisionToBeats(div);
    // feeding that rate back must recover the same beats per cycle.
    const bpm = 137
    for (let div = 0; div < SYNC_DIVISIONS.length; div++) {
      const beats = divisionToBeats(div)
      const freq = bpm / 60 / beats
      expect(freqToBeatsPerCycle(freq, bpm)).toBeCloseTo(beats, 10)
    }
  })

  it('matches the period the LFO editor displays for a free-running rate', () => {
    // The editor labels a free LFO's period as 1 / rate seconds.
    const bpm = 90
    const rate = 3
    const seconds = freqToBeatsPerCycle(rate, bpm) * (60 / bpm)
    expect(seconds).toBeCloseTo(1 / rate, 10)
  })

  it('stays finite at a zero rate', () => {
    expect(Number.isFinite(freqToBeatsPerCycle(0, 120))).toBe(true)
  })
})

describe('free-run beat phase', () => {
  // Mirrors processor.ts updateGlobalLfos: lfoBeatPhases[l] = (beatCounter / beatsPerCycle + phase0) % 1
  const beatPhase = (beatCounter: number, freq: number, bpm: number, phase0 = 0) =>
    (beatCounter / freqToBeatsPerCycle(freq, bpm) + phase0) % 1

  it('advances one full cycle per 1/freq seconds of transport', () => {
    const bpm = 120
    const freq = 2 // 2 Hz -> a cycle every 0.5 s -> every 1 beat at 120 BPM
    expect(beatPhase(0, freq, bpm)).toBeCloseTo(0, 10)
    expect(beatPhase(0.5, freq, bpm)).toBeCloseTo(0.5, 10)
    // One beat later the LFO is back at the top of its cycle.
    expect(beatPhase(1, freq, bpm)).toBeCloseTo(0, 10)
  })

  it('runs faster, not slower, as the rate rises', () => {
    // Regression guard: with the inverted 60 / (freq * bpm) form, beatsPerCycle
    // grew with freq, so the LFO slowed down as its rate knob went up. Count
    // whole cycles rather than wrapped phase, which can compare equal by luck.
    const bpm = 120
    const beats = 4
    const cycles = (freq: number) => beats / freqToBeatsPerCycle(freq, bpm)
    expect(cycles(8)).toBeGreaterThan(cycles(1))
    // 1 Hz over 4 beats at 120 BPM is 2 seconds: 2 cycles, then 16 at 8 Hz.
    expect(cycles(1)).toBeCloseTo(2, 10)
    expect(cycles(8)).toBeCloseTo(16, 10)
  })
})
