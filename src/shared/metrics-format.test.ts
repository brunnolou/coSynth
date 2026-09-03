import { describe, expect, it } from 'vitest'
import type { AudioMetrics, AudioMetricsComparison } from './audio-analysis'
import type { MatchAction } from './match-types'
import { diffAudioMetrics } from './match-diff'
import { formatDiff, formatMetrics } from './metrics-format'

function makeMetrics(overrides: Partial<AudioMetrics> = {}): AudioMetrics {
  return {
    peakDb: -1,
    rmsDb: -14,
    clippingCount: 0,
    dcOffset: 0,
    spectralCentroidHz: 1200,
    attackMs: 10,
    stereoWidth: 0.3,
    timeToPeakMs: 40,
    decayT60Ms: 800,
    sustainDb: -6,
    envelopeDb: Array.from({ length: 64 }, (_, index) => -index / 2),
    loudnessDb: -16,
    bandsDb: [-40, -30, -22, -16, -12, -14, -18, -24, -32, -44],
    spectralRolloffHz: 4000,
    spectralFlatness: 0.2,
    spectralWindows: [
      { startMs: 0, endMs: 165, spectralCentroidHz: 2000, spectralRolloffHz: 6000, levelDb: 0 },
      { startMs: 165, endMs: 330, spectralCentroidHz: 1600, spectralRolloffHz: 5200, levelDb: -3 },
      { startMs: 330, endMs: 495, spectralCentroidHz: 1200, spectralRolloffHz: 4400, levelDb: -7 },
      { startMs: 495, endMs: 660, spectralCentroidHz: 900, spectralRolloffHz: 3600, levelDb: -12 }
    ],
    harmonics: { amplitudesDb: [0, -6, -3, -11, -18, -23, -26, -30, -34, -38, -42, -45], inharmonicity: 3.1e-4 },
    pitch: { f0Hz: 261.9, confidence: 0.91, midi: 60, centsOffset: 2, source: 'detected' },
    harmonicShape: {
      amplitudesDbRelF0: [0, -6.2, -3.1, -11.4, -18, -22.7, -26.1, -30, -34.2, -38.1, -41.7, -45],
      tiltDbPerOctave: -6.1,
      oddEvenDb: 2.8
    },
    ...overrides
  }
}

const candidateMetrics = (): AudioMetrics =>
  makeMetrics({
    loudnessDb: -17.4,
    sustainDb: -12.2,
    attackMs: 14,
    timeToPeakMs: 28,
    decayT60Ms: 590,
    stereoWidth: 0.08,
    spectralFlatness: 0.02,
    bandsDb: [-41.2, -29.6, -19.9, -13, -11.2, -15.9, -22.4, -31.2, -41.8, -56],
    spectralWindows: makeMetrics().spectralWindows.map((window, index) => ({
      ...window,
      spectralCentroidHz: [1612, 1042, 583, 316][index]
    })),
    harmonics: { amplitudesDb: [0, -14, -9, -16, -20, -25, -30, -36, -44, -50, -55, -60], inharmonicity: 0 },
    pitch: { f0Hz: 261.6, confidence: 0.88, midi: 60, centsOffset: 0, source: 'detected' },
    harmonicShape: {
      amplitudesDbRelF0: [0, -14.8, -9.5, -16.2, -20.1, -25, -30.2, -36.6, -44.3, -50, -55.1, -60],
      tiltDbPerOctave: -11.4,
      oddEvenDb: 6.9
    }
  })

const comparison = (similarity: number): AudioMetricsComparison =>
  ({ similarity, details: {} } as unknown as AudioMetricsComparison)

const diffFixture = () => diffAudioMetrics(makeMetrics(), candidateMetrics(), comparison(0.612))

const context = { referenceName: 'bell-c4.wav', comparisonNumber: 3, bestSoFar: 0.588 }

/** No placeholder from the language ever reaches an agent's eyes. */
const forbidden = ['NaN', 'undefined', 'null', 'Infinity']

describe('formatDiff', () => {
  it('renders the match payload', () => {
    expect(formatDiff(diffFixture(), context)).toMatchSnapshot()
  })

  it('never prints a language placeholder in place of a measurement', () => {
    const cases = [
      formatDiff(diffFixture(), context),
      formatDiff(diffFixture()),
      formatDiff(
        diffAudioMetrics(
          makeMetrics({ decayT60Ms: null, pitch: null, harmonics: undefined, harmonicShape: undefined }),
          candidateMetrics(),
          comparison(0.2)
        ),
        context
      ),
      formatMetrics(makeMetrics()),
      formatMetrics(makeMetrics({ decayT60Ms: null, pitch: null, harmonics: undefined, harmonicShape: undefined }))
    ]
    for (const text of cases) {
      for (const token of forbidden) expect(text).not.toContain(token)
    }
  })

  it('says why a figure is missing instead of leaving a hole', () => {
    const text = formatDiff(
      diffAudioMetrics(
        makeMetrics({ decayT60Ms: null, pitch: null, harmonics: undefined, harmonicShape: undefined }),
        candidateMetrics(),
        comparison(0.2)
      ),
      context
    )
    expect(text).toContain('T60 n/a (no decay to slope on one side)')
    expect(text).toContain('PITCH   n/a (no fundamental measured on the reference)')
    expect(text).toContain('PARTIALS  n/a (one side has no fundamental, so partials are not comparable)')
  })

  it('marks a partial measurable on one side only as n/a, distinct from a zero delta', () => {
    const candidate = candidateMetrics()
    const text = formatDiff(
      diffAudioMetrics(
        makeMetrics(),
        {
          ...candidate,
          harmonicShape: {
            ...candidate.harmonicShape!,
            amplitudesDbRelF0: candidate.harmonicShape!.amplitudesDbRelF0.map((value, index) =>
              index === 10 ? -120 : value
            )
          }
        },
        comparison(0.5)
      ),
      context
    )
    expect(text).toContain('n/a')
    expect(text).toContain('above the noise on one side only')
  })

  it('states the sign convention once per block', () => {
    const text = formatDiff(diffFixture(), context)
    for (const line of ['PARTIALS', 'BANDS ', 'ENVELOPE', 'BRIGHTNESS']) {
      const block = text.split('\n').find((candidate) => candidate.startsWith(line))
      expect(block, line).toBeDefined()
      expect(block).toContain('you - ref')
    }
  })

  it('keeps columns aligned through 4-digit Hz, 3-digit ms and negative signs', () => {
    const lines = formatDiff(diffFixture(), context).split('\n')
    const blockRows = (header: string): string[] => {
      const start = lines.findIndex((line) => line.startsWith(header))
      expect(start, header).toBeGreaterThanOrEqual(0)
      return lines.slice(start + 1).slice(0, lines.slice(start + 1).findIndex((line) => line === ''))
        .filter((line) => /^ \S{1,3}\s/.test(line))
    }
    for (const header of ['PARTIALS', 'BANDS ']) {
      const rows = blockRows(header)
      expect(rows.length, header).toBeGreaterThan(1)
      // Fixed-width cells: every row of a block is the same length, and every cell boundary
      // falls on the same column, through 4-digit Hz labels and negative signs alike.
      expect(new Set(rows.map((line) => line.length)).size, header).toBe(1)
      for (const line of rows) expect((line.length - 6) % 6, `${header}: ${line}`).toBe(0)
    }
    // 3-digit millisecond bounds keep the brightness windows separated by their own delimiter.
    const brightness = lines[lines.findIndex((line) => line.startsWith('BRIGHTNESS')) + 1]
    expect(brightness.split(' | ')).toHaveLength(4)
  })

  it('stays inside the token budget', () => {
    // ~4 characters per token; the block layout is ASCII, so the proxy is generous.
    expect(formatDiff(diffFixture(), context).length).toBeLessThan(4000)
    expect(formatMetrics(makeMetrics()).length).toBeLessThan(4000)
  })

  it('omits the actions section entirely when nothing is ranked', () => {
    expect(formatDiff(diffFixture(), context)).not.toContain('ACTIONS')
  })

  it('renders finding, param move and confidence, capped at five', () => {
    const action = (index: number): MatchAction => ({
      finding: `partial ${index} is 8.6 dB quiet`,
      paramIds: ['osc1.wave'],
      direction: 'increase',
      suggested: { id: 'filter.cutoff', from: 400, to: 1200, unit: 'Hz' },
      estimatedGain: 0.1,
      confidence: 'high'
    })
    const diff = { ...diffFixture(), actions: Array.from({ length: 7 }, (_, index) => action(index + 1)) }
    const text = formatDiff(diff, context)
    expect(text).toContain('ACTIONS  ranked, best first')
    expect(text).toContain('partial 1 is 8.6 dB quiet')
    expect(text).toContain('-> filter.cutoff 400.0 -> 1200.0 Hz  [high]')
    expect(text).toContain(' 5. ')
    expect(text).not.toContain(' 6. ')
    for (const token of forbidden) expect(text).not.toContain(token)
  })
})

describe('formatMetrics', () => {
  it('renders a standalone analysis', () => {
    expect(formatMetrics(makeMetrics())).toMatchSnapshot()
  })

  it('names the reason a block is absent', () => {
    const text = formatMetrics(makeMetrics({ decayT60Ms: null, pitch: null, harmonics: undefined, harmonicShape: undefined }))
    expect(text).toContain('pitch n/a (nothing periodic found in the buffer)')
    expect(text).toContain('T60 n/a (no decay to slope)')
    expect(text).toContain('PARTIALS  n/a (no fundamental given or detected, so partials were not analysed)')
  })
})
