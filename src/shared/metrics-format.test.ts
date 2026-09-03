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

/**
 * The last window decayed into the noise: -55 dB, carrying the 4,978 Hz centroid the
 * analyzer measured off that noise. `belowNoiseFloor` is deliberately left unset, so the
 * formatter has to reach the same verdict from `levelDb` through the exported predicate.
 */
const withDecayedTail = (metrics: AudioMetrics): AudioMetrics => ({
  ...metrics,
  spectralWindows: metrics.spectralWindows.map((window, index) =>
    index === 3 ? { ...window, levelDb: -55, spectralCentroidHz: 4978 } : window
  )
})

/** The BRIGHTNESS block's lines, header excluded: the window row, and the note if present. */
const brightnessBlock = (text: string): string[] => {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.startsWith('BRIGHTNESS'))
  expect(start).toBeGreaterThanOrEqual(0)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line === '')
  return end === -1 ? rest : rest.slice(0, end)
}

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

  it('prints n/a and the reason for a brightness window under the noise gate', () => {
    const diff = diffAudioMetrics(makeMetrics(), withDecayedTail(candidateMetrics()), comparison(0.4))
    const text = formatDiff(diff, context)
    const [windows, note] = brightnessBlock(text)
    const cells = windows.split(' | ')

    expect(cells).toHaveLength(4)
    expect(cells[3]).toBe('495-660ms n/a')
    // The three measured windows are untouched and still carry their signed octave figures.
    for (const cell of cells.slice(0, 3)) expect(cell).toMatch(/[+-]\d\.\d\d$/)

    // The number the analyzer measured off the noise - +2.44 octaves, the phantom that
    // ranked `env2.decay` first - reaches the page in no form at all.
    expect(diff.brightness[3].octaveDelta).toBeCloseTo(2.4415, 3)
    expect(windows).not.toContain('2.4')
    expect(windows).not.toContain('4978')

    expect(note).toContain('below the noise floor')
    expect(note).toContain('the score leaves those windows out too')
    for (const token of forbidden) expect(text).not.toContain(token)
  })

  it('marks a gated window on either side and never prints a placeholder for it', () => {
    const cases = [
      diffAudioMetrics(withDecayedTail(makeMetrics()), candidateMetrics(), comparison(0.4)),
      diffAudioMetrics(makeMetrics(), withDecayedTail(candidateMetrics()), comparison(0.4)),
      diffAudioMetrics(withDecayedTail(makeMetrics()), withDecayedTail(candidateMetrics()), comparison(0.4))
    ]
    for (const diff of cases) {
      const text = formatDiff(diff, context)
      expect(brightnessBlock(text)[0].split(' | ')[3]).toBe('495-660ms n/a')
      for (const token of forbidden) expect(text).not.toContain(token)
    }
  })

  it('adds no noise-floor note when every window was measured', () => {
    // The common path, both blocks: one row under the header and nothing else, exactly as
    // the snapshots record it.
    for (const text of [formatDiff(diffFixture(), context), formatMetrics(makeMetrics())]) {
      expect(brightnessBlock(text)).toHaveLength(1)
      expect(text).not.toContain('noise floor')
    }
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

/**
 * The move line of a one-action diff, with the leading arrow and the trailing confidence
 * stripped, so a case reads as the move an agent sees and nothing else.
 */
type Suggested = NonNullable<MatchAction['suggested']>
const moveLine = (suggested: Suggested): string => {
  const action: MatchAction = {
    finding: 'the candidate is off',
    paramIds: [suggested.id],
    direction: 'increase',
    suggested,
    estimatedGain: 0.1,
    confidence: 'high'
  }
  const text = formatDiff({ ...diffFixture(), actions: [action] }, context)
  const line = text.split('\n').find((candidate) => candidate.startsWith('    -> '))
  expect(line, JSON.stringify(suggested)).toBeDefined()
  for (const token of forbidden) expect(text, JSON.stringify(suggested)).not.toContain(token)
  return line!.slice('    -> '.length).replace(/ {2}\[[a-z]+\]$/, '')
}

/**
 * Realistic `suggested` pairs, one or more per unit that `PARAMS` actually produces, sized
 * the way `match-advice.ts` sizes a correction: some coarse, some a hair above the 1e-9
 * guard it drops a move at. `ms` is not a registry unit - `params.ts` maps a millisecond
 * formatter back to a raw `s` hint - but a move renderer keyed off nothing but the numbers
 * should not care, so it is swept too.
 */
const MOVE_SWEEP: Suggested[] = [
  // raw: the 0..1 knobs, where one decimal did all its damage
  { id: 'env1.sustain', from: 0.000001, to: 0.001, unit: 'raw' },
  { id: 'env1.sustain', from: 0.8, to: 0.800001, unit: 'raw' },
  { id: 'osc1.morph', from: 0, to: 0.5, unit: 'raw' },
  { id: 'dist.drive', from: 0.3, to: 1, unit: 'raw' },
  { id: 'delay.feedback', from: 0.4, to: 0.4002, unit: 'raw' },
  { id: 'phaser.feedback', from: 0.949, to: 0.95, unit: 'raw' },
  { id: 'osc1.pan', from: -0.02, to: -0.021, unit: 'raw' },
  // s: one unit spanning four orders of magnitude, which is why per-unit precision fails
  { id: 'env2.decay', from: 0.001, to: 0.0015, unit: 's' },
  { id: 'env1.attack', from: 0.005, to: 0.0051, unit: 's' },
  { id: 'env1.release', from: 0.2, to: 0.21, unit: 's' },
  { id: 'delay.time', from: 0.35, to: 0.3512, unit: 's' },
  { id: 'comp.attack', from: 0.0005, to: 0.00051, unit: 's' },
  // ms
  { id: 'probe.attackMs', from: 10, to: 10.4, unit: 'ms' },
  { id: 'probe.attackMs', from: 0.5, to: 0.9, unit: 'ms' },
  // Hz
  { id: 'filter1.cutoff', from: 8000, to: 12278.5, unit: 'Hz' },
  { id: 'filter1.cutoff', from: 200, to: 200.05, unit: 'Hz' },
  { id: 'lfo1.rate', from: 2, to: 2.05, unit: 'Hz' },
  { id: 'chorus.rate', from: 0.4, to: 0.4004, unit: 'Hz' },
  // dB
  { id: 'comp.threshold', from: -18, to: -18.4, unit: 'dB' },
  { id: 'comp.threshold', from: -60, to: -59.95, unit: 'dB' },
  { id: 'comp.makeup', from: 0, to: 0.05, unit: 'dB' },
  // ct
  { id: 'osc1.detune', from: 12, to: 12.4, unit: 'ct' },
  { id: 'osc2.detune', from: 0, to: 0.5, unit: 'ct' },
  // st
  { id: 'osc1.transpose', from: -12, to: -11, unit: 'st' },
  { id: 'master.bend_range', from: 2, to: 3, unit: 'st' }
]

describe('suggested moves', () => {
  it('shows the move the eval saw as `env1.sustain 0.0 -> 0.0`', () => {
    // The reported no-op. `to` is a thousand times `from`; one decimal printed both as zero.
    expect(moveLine({ id: 'env1.sustain', from: 0.000001, to: 0.001, unit: 'raw' })).toBe(
      'env1.sustain 0.000001 -> 0.001 raw'
    )
  })

  it('never renders a real move as a pair of identical values', () => {
    for (const suggested of MOVE_SWEEP) {
      const label = `${suggested.id} ${suggested.from} -> ${suggested.to}`
      expect(suggested.from, label).not.toBe(suggested.to)

      const line = moveLine(suggested)
      // The below-resolution sentence is the only licensed escape, and no sweep pair earns it.
      expect(line, label).toContain(' -> ')
      expect(line, label).not.toContain('stays at')

      const [, from, to] = /^\S+ (\S+) -> (\S+) /.exec(line) ?? []
      expect(from, label).toBeDefined()
      expect(from, label).not.toBe(to)
      // Stronger than "visibly different": what is printed is the number the agent will send.
      expect(Number(from), label).toBeCloseTo(suggested.from, 6)
      expect(Number(to), label).toBeCloseTo(suggested.to, 6)
      // And a value that is not zero never prints as one.
      for (const [text, value] of [[from, suggested.from], [to, suggested.to]] as const) {
        if (value !== 0) expect(Number(text), `${label}: ${text}`).not.toBe(0)
      }
    }
  })

  it('renders ordinary moves exactly as it did before', () => {
    expect(moveLine({ id: 'filter1.cutoff', from: 8000, to: 12278.5, unit: 'Hz' })).toBe(
      'filter1.cutoff 8000.0 -> 12278.5 Hz'
    )
    expect(moveLine({ id: 'dist.drive', from: 0.3, to: 1, unit: 'raw' })).toBe('dist.drive 0.3 -> 1.0 raw')
    expect(moveLine({ id: 'filter.cutoff', from: 400, to: 1200, unit: 'Hz' })).toBe('filter.cutoff 400.0 -> 1200.0 Hz')
  })

  it('says a move is below the resolution rather than printing it as no move', () => {
    for (const to of [0.5, 0.5 + 1e-9]) {
      const line = moveLine({ id: 'env1.sustain', from: 0.5, to, unit: 'raw' })
      expect(line).not.toContain('0.5 -> 0.5')
      expect(line).toContain('env1.sustain stays at 0.5 raw')
      expect(line).toContain('nothing to apply')
    }
  })

  it('never shows a real setting as zero, however small it is', () => {
    const line = moveLine({ id: 'env1.attack', from: 1e-9, to: 0.005, unit: 's' })
    expect(line).toBe('env1.attack 1.0e-9 -> 0.005 s')
  })
})

describe('formatMetrics', () => {
  it('renders a standalone analysis', () => {
    expect(formatMetrics(makeMetrics())).toMatchSnapshot()
  })

  it('prints n/a for a per-window centroid measured below the noise floor', () => {
    const text = formatMetrics(withDecayedTail(makeMetrics()))
    const [windows, note] = brightnessBlock(text)

    expect(windows.split(' | ')[3]).toBe('495-660ms n/a')
    // The centroid is still on the metrics object - the analyzer keeps what it measured -
    // and it is the number that misleads, so the absolute table must not print it either.
    expect(withDecayedTail(makeMetrics()).spectralWindows[3].spectralCentroidHz).toBe(4978)
    expect(windows).not.toContain('4978')
    expect(windows).toContain('0-165ms 2000')

    expect(note).toContain('measured the noise rather than the sound')
    for (const token of forbidden) expect(text).not.toContain(token)
  })

  it('names the reason a block is absent', () => {
    const text = formatMetrics(makeMetrics({ decayT60Ms: null, pitch: null, harmonics: undefined, harmonicShape: undefined }))
    expect(text).toContain('pitch n/a (nothing periodic found in the buffer)')
    expect(text).toContain('T60 n/a (no decay to slope)')
    expect(text).toContain('PARTIALS  n/a (no fundamental given or detected, so partials were not analysed)')
  })
})
