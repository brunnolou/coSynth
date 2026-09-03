import { describe, expect, it } from 'vitest'
import type { AudioMetrics, AudioMetricsComparison } from './audio-analysis'
import { compareAudioMetrics } from './audio-analysis'
import type { MatchAction } from './match-types'
import { diffAudioMetrics } from './match-diff'
import { formatDiff, formatMetrics, COLUMN } from './metrics-format'

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

const bytes = (text: string): number => new TextEncoder().encode(text).length

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

/**
 * A sine as the analyzer renders one: partials 2-12 have no peak above the noise, so
 * `amplitudesDbRelF0` floors them and only the fundamental is measured. One partial is
 * enough for both parities to have a level and not enough for a slope.
 */
const sineShape = (): AudioMetrics['harmonicShape'] => ({
  amplitudesDbRelF0: [0, ...Array.from({ length: 11 }, () => -120)],
  tiltDbPerOctave: 0,
  oddEvenDb: 0
})

/** Nothing above the noise at all - a near-silent buffer, where even a parity has no level. */
const silentShape = (): AudioMetrics['harmonicShape'] => ({
  amplitudesDbRelF0: Array.from({ length: 12 }, () => -120),
  tiltDbPerOctave: 0,
  oddEvenDb: 0
})

/**
 * One raw row of the BANDS block. `row()` writes a space-prefixed label padded to `COLUMN`
 * and then `COLUMN`-wide cells, so the payload starts at column `COLUMN` - both widths come
 * from the formatter's own constant rather than from a literal repeated here.
 *
 * Found by label within the BANDS block specifically: PARTIALS carries a `d` row too, and a
 * whole-text search for one would silently assert about the wrong block.
 */
const bandLine = (text: string, label: 'hz' | 'db' | 'd'): string => {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.startsWith('BANDS'))
  expect(start, 'BANDS').toBeGreaterThanOrEqual(0)
  const line = lines.slice(start + 1).find((value) => value.startsWith(` ${label} `))
  expect(line, label).toBeDefined()
  return line!
}

/** That row, split back into its fixed-width cells. */
const bandRow = (text: string, label: 'hz' | 'db' | 'd'): string[] =>
  (bandLine(text, label).slice(COLUMN).match(new RegExp(`.{${COLUMN}}`, 'g')) ?? []).map((cell) => cell.trim())

/** Which band columns read `n/a`, in either block. */
const naBands = (text: string, label: 'db' | 'd'): number[] =>
  bandRow(text, label).flatMap((cell, index) => (cell === 'n/a' ? [index] : []))

/** The BRIGHTNESS block's lines, header excluded: the window row, and the note if present. */
const brightnessBlock = (text: string): string[] => {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.startsWith('BRIGHTNESS'))
  expect(start).toBeGreaterThanOrEqual(0)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line === '')
  return end === -1 ? rest : rest.slice(0, end)
}

/**
 * Five ranked moves the size the advisor really produces, so the byte figures below are
 * the ones a `compare_audio` response actually pays.
 *
 * The findings are held here rather than drawn from `adviseFromDiff` on purpose. A live
 * advisor makes the size of this block a function of how much a rule currently explains,
 * and the last test to tie a budget to that failed the round where a rule learned to say
 * WHY it was refusing a move - an improvement scored as a regression. These five are
 * transcribed from a real `adviseFromDiff` run and stay put: they render a 1,697 B block
 * against the 1,779 B a live `compare_audio` response carries, so the assertions below
 * move only when the FORMATTER does.
 */
const RANKED_ACTIONS: MatchAction[] = [
  {
    finding:
      'Spectral tilt is 5.3 dB/octave steeper than the reference, so the candidate\'s partial series is duller overall. Add harmonic content at the source.',
    paramIds: ['osc1.morph', 'osc1.wavetable', 'dist.drive'],
    direction: 'increase',
    suggested: { id: 'dist.drive', from: 0.12, to: 0.385, unit: 'raw' },
    estimatedGain: 0.11,
    confidence: 'medium'
  },
  {
    finding:
      'Partials 2-4 are 4.8-8.6 dB quiet against the reference (mean -6.6 dB). The low-order harmonic balance is a wavetable choice: try a different table or move the morph, and use dist.drive only to add what the table cannot.',
    paramIds: ['osc1.morph', 'osc1.wavetable'],
    direction: 'either',
    estimatedGain: 0.09,
    confidence: 'medium'
  },
  {
    finding:
      'Brightness error drifts 1.1 octaves across the buffer (-0.3 in the first window, -1.5 in the last), so the candidate darkens too fast. This is envelope shape, not static cutoff: lengthen env2.decay / raise env2.sustain, or reduce the depth of the env2 -> filter1.cutoff mod slot (set_modulation). That mod slot is the REAL fix and has no parameter id, so it can never appear as a suggested move; env2 reaches the sound through it and nothing else, and if the route does not exist in this patch then every env2 stage is inert and set_modulation is the whole job.',
    paramIds: ['env2.decay', 'env2.sustain'],
    direction: 'increase',
    suggested: { id: 'env2.decay', from: 0.42, to: 0.5418, unit: 's' },
    estimatedGain: 0.07,
    confidence: 'low'
  },
  {
    finding:
      'Odd partials sit 4.1 dB above even ones relative to the reference, so the candidate reads more square/pulse-like than it should. Change wavetable or morph position; a full-spectrum table (Basic Shapes saw region, Harmonic Sweep) restores the even partials.',
    paramIds: ['osc1.morph', 'osc1.wavetable'],
    direction: 'either',
    estimatedGain: 0.05,
    confidence: 'medium'
  },
  {
    finding:
      'Stereo width is -0.220 narrower than the reference (0 is mono). Widen at the source first - osc1.unison above 1 with osc1.detune and osc1.spread - before reaching for chorus.mix or reverb.width, which also change the timbre.',
    paramIds: ['osc1.unison', 'osc1.detune', 'osc1.spread'],
    direction: 'increase',
    suggested: { id: 'osc1.spread', from: 0, to: 22, unit: 'raw' },
    estimatedGain: 0.04,
    confidence: 'medium'
  }
]

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

  /**
   * The one payload where `compareAudioMetrics` reports `brightness` as not measurable: a
   * decaying reference against a late-starting candidate gates one side of every pair, so
   * the whole term is `null`. Built through the real comparison rather than the `comparison`
   * stub, so the null actually reaches the page rather than being assumed away.
   */
  it('prints every window as n/a when the whole brightness term is not measurable', () => {
    const levels = (levelsDb: readonly number[], centroids: readonly number[]) =>
      (metrics: AudioMetrics): AudioMetrics => ({
        ...metrics,
        spectralWindows: metrics.spectralWindows.map((window, index) => ({
          ...window, levelDb: levelsDb[index], spectralCentroidHz: centroids[index]
        }))
      })
    const reference = levels([0, -20, -50, -70], [1200, 1000, 7100, 8300])(makeMetrics())
    const candidate = levels([-70, -50, -20, 0], [7900, 8600, 1050, 1150])(candidateMetrics())

    const scored = compareAudioMetrics(reference, candidate)
    expect(scored.details.brightness.similarity).toBeNull()

    const text = formatDiff(diffAudioMetrics(reference, candidate, scored), context)
    const [windows, note] = brightnessBlock(text)
    for (const cell of windows.split(' | ')) expect(cell.trim()).toMatch(/^\d+-\d+ms n\/a$/)
    expect(note).toContain('below the noise floor')
    // The whole point: no centroid figure from a half-hiss pair reaches the reader, and the
    // nullable term prints nothing the language would have to spell.
    for (const token of forbidden) expect(text).not.toContain(token)
  })

  it('adds no noise-floor note when every window was measured', () => {
    // The common path, both blocks: the window row, and no gate note, exactly as the
    // snapshots record it.
    for (const text of [formatDiff(diffFixture(), context), formatMetrics(makeMetrics())]) {
      expect(text).not.toContain('noise floor')
    }
    // One row under the header and nothing else, in both blocks. What these windows weight -
    // and that `spectralCentroidHz` weights something else, so the two can name different
    // sides as the brighter one - rides on the header rather than on a line of its own.
    for (const text of [formatDiff(diffFixture(), context), formatMetrics(makeMetrics())]) {
      expect(brightnessBlock(text)).toHaveLength(1)
      const header = text.split('\n').find((line) => line.startsWith('BRIGHTNESS'))
      expect(header).toContain('unlike spectralCentroidHz')
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
      for (const line of rows) expect((line.length - COLUMN) % COLUMN, `${header}: ${line}`).toBe(0)
    }
    // 3-digit millisecond bounds keep the brightness windows separated by their own delimiter.
    const brightness = lines[lines.findIndex((line) => line.startsWith('BRIGHTNESS')) + 1]
    expect(brightness.split(' | ')).toHaveLength(4)
  })

  /**
   * The payload that motivated widening `COLUMN` from 6 to 7, and the reason the test above
   * could not catch it: `signedDb1(-100)` is six characters, so at the old width two floored
   * cells rendered flush - `-14.4-100.0+100.0`, with one value's minus sign doubling as the
   * separator of the value before it. Every cell was still the same width and every boundary
   * still fell on the same column, so the alignment assertions all passed on a row a reader
   * cannot segment. What was missing was the assertion that a SEPARATOR survives, which is
   * what a column width is for.
   *
   * -100 dB is `bandsDb`'s floor, so a floor on one side against a real level on the other is
   * exactly how a +-100 pair arises - a band-limited sample against a full-range reference.
   */
  it('keeps a visible gap between cells at the +-100 dB extremes', () => {
    const at = (bandsDb: number[]) => makeMetrics({ sampleRateHz: 48000, bandsDb })
    const text = formatDiff(
      diffAudioMetrics(
        at([-40, -30, -22, -16, 0, -100, -18, -24, -32, -44]),
        at([-41.2, -29.6, -19.9, -30.4, -100, 0, -22.4, -31.2, -41.8, -56]),
        comparison(0.3)
      ),
      context
    )
    // No band is above the Nyquist at 48 kHz, so these are printed numbers rather than n/a.
    expect(bandRow(text, 'd').slice(3, 6)).toEqual(['-14.4', '-100.0', '+100.0'])
    expect(bandLine(text, 'd')).toContain('-14.4 -100.0 +100.0')
    // The exact rendering the old width produced, stated so a narrowing cannot come back.
    expect(bandLine(text, 'd')).not.toContain('-14.4-100.0')
    // And the block is still a block: same length rows, boundaries on the same columns.
    expect(bandLine(text, 'd').length).toBe(bandLine(text, 'hz').length)
    for (const token of forbidden) expect(text).not.toContain(token)
  })

  it('stays inside the token budget', () => {
    // ~4 characters per token; the block layout is ASCII, so the proxy is generous.
    expect(formatDiff(diffFixture(), context).length).toBeLessThan(4000)
    expect(formatMetrics(makeMetrics()).length).toBeLessThan(4000)
  })

  it('omits the actions section entirely when nothing is ranked', () => {
    expect(formatDiff(diffFixture(), context)).not.toContain('ACTIONS')
  })

  it('never prints a language placeholder when the moves ship structurally', () => {
    const diff = { ...diffFixture(), actions: RANKED_ACTIONS }
    const text = formatDiff(diff, { ...context, actionsShipStructurally: true })
    for (const token of forbidden) expect(text).not.toContain(token)
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
 * A signed integer smaller than the unit it is printed in is still a MEASUREMENT, and the
 * sign is all of it that survives the rounding. `signedDb1` has said so since it was fixed
 * for this - `+0.0` dB is a small positive error, `0.0` is none - and `signedInt` guarded the
 * ROUNDED value instead, so a +0.4 ms attack error and a true zero both printed `0`.
 */
describe('a signed integer smaller than its unit', () => {
  /** Under half a millisecond late, and under half a millisecond early, against the same ref. */
  const subMillisecond = () =>
    formatDiff(
      diffAudioMetrics(makeMetrics(), makeMetrics({ attackMs: 10.4, timeToPeakMs: 39.6 }), comparison(0.9)),
      context
    )

  it('keeps the sign on an error too small to round to a whole unit', () => {
    const text = subMillisecond()
    expect(text).toContain('attack +0 ms')
    expect(text).toContain('time-to-peak -0 ms')
    for (const token of forbidden) expect(text).not.toContain(token)
  })

  it('prints an exact zero unsigned, so the two cannot be confused', () => {
    const text = formatDiff(diffAudioMetrics(makeMetrics(), makeMetrics(), comparison(1)), context)
    expect(text).toContain('attack 0 ms   time-to-peak 0 ms')
    expect(text).not.toContain('attack +0 ms')
    expect(text).not.toContain('attack -0 ms')
    // Both renderings really are reachable from the same field, so an agreement of two
    // identical strings is not what passed the pair.
    expect(subMillisecond()).not.toContain('attack 0 ms')
  })

  /**
   * The chosen rendering for cents, argued in `signedInt`: `-0c` keeps the direction, and a
   * bound like `<1c` throws it away. The fixture's candidate really is 261.6 Hz, 0.17 cents
   * under C4, and it used to read `C4 0c` - flat by a measured amount, printed as in tune.
   */
  it('says which side of the note a sub-cent offset falls on', () => {
    const text = formatDiff(diffFixture(), context)
    expect(text).toContain('you 261.6 Hz  C4 -0c')
    expect(text).toContain('ref 261.9 Hz  C4 +2c')
    // Not a tolerance band: the reader is told the direction, not merely the magnitude.
    expect(text).not.toContain('<1c')
  })

  it('leaves an offset the analyzer reported as exactly zero unsigned', () => {
    // `centsOffset` is carried on the pitch object rather than derived, so the candidate's
    // own analysis says 0 - and that is a different fact from the -0.17 the same frequency
    // derives against C4. The absolute block prints the first, the diff the second.
    expect(formatMetrics(candidateMetrics())).toContain('pitch 261.6 Hz  C4 0c')
    for (const token of forbidden) expect(formatMetrics(candidateMetrics())).not.toContain(token)
  })
})

/**
 * `MAX_ACTIONS` is a rendering cap, and `compare_audio` takes a `maxActions` input, so the
 * two can disagree: eight ranked moves in `diff.actions` and five in the block. Dropping the
 * other three in silence makes the block answer a question nobody asked - a list that was CUT
 * reads exactly like a list that ENDED.
 */
describe('an actions block that printed fewer moves than it was given', () => {
  const ranked = (count: number): MatchAction[] =>
    Array.from({ length: count }, (_, index) => ({
      ...RANKED_ACTIONS[index % RANKED_ACTIONS.length],
      finding: `ranked move ${index + 1}`
    }))
  const block = (count: number) => formatDiff({ ...diffFixture(), actions: ranked(count) }, context)

  it('says how many were dropped, why, and where the rest are', () => {
    const text = block(8)
    expect(text).toContain(' 5. ranked move 5')
    expect(text).not.toContain('ranked move 6')
    // The count of what is MISSING leads: the five that printed are visible already, and the
    // number a reader needs is the one they cannot see.
    expect(text).toContain('3 further ranked moves are not printed here')
    // A layout limit rather than the advisor running out of findings.
    expect(text).toContain('this block stops at 5')
    // And the field that still has every one of them, named the way the other note names it.
    expect(text).toContain('All 8 are in diff.actions')
    expect(text).toContain('parameter ids and target values')
    for (const token of forbidden) expect(text).not.toContain(token)
  })

  it('counts one dropped move in the singular', () => {
    expect(block(6)).toContain('1 further ranked move is not printed here')
    expect(block(6)).toContain('All 6 are in diff.actions')
  })

  it('adds nothing when every ranked move was printed', () => {
    // The common path: `adviseFromDiff` at the default `maxActions` returns at most five, so
    // a full block is byte-identical to what it printed before the note existed.
    for (const count of [1, 3, 5]) {
      expect(block(count), String(count)).not.toContain('further ranked')
      expect(block(count), String(count)).not.toContain('diff.actions')
    }
  })
})

/**
 * `compare_audio`'s text mode ships `{ similarity, actions }` structurally beside this
 * text, so the ACTIONS block there restates moves the array already carries - and carries
 * better, since only the array has the `suggested.id/from/to/unit` an agent hands to
 * `update_parameters`. `actionsShipStructurally` is the caller saying so.
 */
describe('actions that ship structurally beside the text', () => {
  const ranked = () => ({ ...diffFixture(), actions: RANKED_ACTIONS })
  const shipped = (actions: MatchAction[] = RANKED_ACTIONS) =>
    formatDiff({ ...diffFixture(), actions }, { ...context, actionsShipStructurally: true })
  /** The one line the block collapses to, wherever it sits. */
  const noteLine = (text: string): string | undefined =>
    text.split('\n').find((line) => line.startsWith('ACTIONS'))

  it('keeps the block for a caller that renders the text alone', () => {
    // The default, and it has to be: only a caller that can see the response it is
    // building knows whether the array is in it. Text rendered on its own - a log line, a
    // chat message, a file - is all its reader gets, so the moves stay in it.
    for (const text of [formatDiff(ranked(), context), formatDiff(ranked())]) {
      expect(text).toContain('ACTIONS  ranked, best first')
      expect(text).toContain('Spectral tilt is 5.3 dB/octave steeper')
      expect(text).toContain('-> dist.drive 0.12 -> 0.385 raw  [medium]')
    }
  })

  it('drops the block when the caller ships diff.actions', () => {
    const text = shipped()
    expect(text).not.toContain('ranked, best first')
    expect(text).not.toContain('Spectral tilt is 5.3 dB/octave steeper')
    expect(text).not.toContain('dist.drive 0.12')
    // Everything that is not the actions block is byte-identical to what it always was.
    const upTo = (value: string) => value.slice(0, value.lastIndexOf('\nACTIONS'))
    expect(upTo(text)).toBe(upTo(formatDiff(ranked(), context)))
  })

  it('says where the moves went, in terms an agent can act on', () => {
    const line = noteLine(shipped())
    expect(line).toBeDefined()
    // The name of the field to read, and what makes it the better copy: the ids and the
    // target values, which the prose block never carried.
    expect(line).toContain('diff.actions')
    expect(line).toContain('parameter ids')
    expect(line).toContain('target values')
    // One line, not a second block dressed as a note.
    expect(shipped().split('\n').filter((value) => value.includes('diff.actions'))).toHaveLength(1)
    expect(bytes(line!)).toBeLessThan(200)
  })

  it('never lets the absent block read as "no moves were suggested"', () => {
    // The distinction this line exists to hold: a MISSING block and an EMPTY ranking are
    // different facts, and a reader who has only ever seen the block must not take the
    // first for the second. The count leads, because no "there were none" reading of a
    // sentence that opens with `5 ranked moves` survives.
    const line = noteLine(shipped())!
    expect(line).toMatch(/^ACTIONS {2}5 ranked moves\b/)
    for (const denial of [/\bno\b/i, /\bnone\b/i, /\bnothing\b/i, /\bempty\b/i]) {
      expect(line, denial.source).not.toMatch(denial)
    }
    // It counts the array the reader is sent to, not the five the block would have shown.
    const seven = RANKED_ACTIONS.concat(RANKED_ACTIONS.slice(0, 2))
    expect(noteLine(shipped(seven))).toMatch(/^ACTIONS {2}7 ranked moves\b/)
    expect(noteLine(shipped([RANKED_ACTIONS[0]]))).toMatch(/^ACTIONS {2}1 ranked move\b/)
  })

  it('says nothing at all when there were no moves to ship', () => {
    // Pointing at an empty array is the lie in the other direction, and `diffFixture`
    // ranks nothing. Neither the block nor the line: the section is simply absent, exactly
    // as it is for a caller that is not shipping anything.
    const text = shipped([])
    expect(text).not.toContain('ACTIONS')
    expect(text).not.toContain('diff.actions')
    expect(text).toBe(formatDiff({ ...diffFixture(), actions: [] }, context))
  })

  it('pays for the ranked moves once, and the saving is the point', () => {
    const withBlock = formatDiff(ranked(), context)
    const text = shipped()
    const saved = bytes(withBlock) - bytes(text)

    // Measured, not estimated: on a live `compare_audio` response this block is 1,779 B
    // of a 9,615 B payload, the largest duplicate in it and bigger than any array text
    // mode already drops. The fixture above is the same shape and saves rather more. A
    // change that reinstates the duplication - a caller quietly losing the flag, the line
    // growing back into a block - fails here.
    expect(saved).toBeGreaterThan(1400)
    expect(bytes(withBlock)).toBeGreaterThan(2500)
    // What replaces it is one line, so the section costs a fixed ~140 B whatever the
    // advisor found rather than growing with every rule that learns to explain itself.
    const none = bytes(formatDiff({ ...diffFixture(), actions: [] }, context))
    expect(bytes(text) - none).toBeLessThan(200)
  })
})

/**
 * A band whose lower edge sits above the Nyquist reads the -100 dB band floor whatever the
 * sound is, so `bandsDetail` leaves it out of the score and both tables have to leave it out
 * of the numbers. The failure it prevents is sharper in the diff than in the absolute block:
 * two floors subtract to `0.0`, which reads as the one band the candidate got exactly right.
 */
describe('bands above the Nyquist', () => {
  const at = (sampleRateHz: number | undefined) => makeMetrics({ sampleRateHz })
  const selfDiff = (sampleRateHz: number | undefined) => {
    const metrics = at(sampleRateHz)
    return diffAudioMetrics(metrics, metrics, comparison(1))
  }

  it('prints n/a rather than a level in both blocks', () => {
    // 8 kHz puts the Nyquist at 4 kHz, which is under the lower edge of the 8k and 16k
    // octave bands and above the 4k band's, so exactly the top two go.
    const absolute = formatMetrics(at(8000))
    const diff = formatDiff(selfDiff(8000), context)
    expect(naBands(absolute, 'db')).toEqual([8, 9])
    expect(naBands(diff, 'd')).toEqual([8, 9])
    // The number each cell replaces, and the reason it must not be printed: -100.0 in the
    // absolute block reads as a level 100 dB down, and the diff's 0.0 as a perfect match.
    expect(at(8000).bandsDb.slice(8)).not.toContain(-100)
    expect(absolute).not.toContain('-100.0')
    expect(bandRow(diff, 'd').slice(8)).toEqual(['n/a', 'n/a'])
  })

  it('says why, once, and only when a band is actually marked', () => {
    expect(formatMetrics(at(8000))).toContain('above this sample rate\'s Nyquist')
    expect(formatDiff(selfDiff(8000), context)).toContain('above one side\'s Nyquist')
    // The diff's wording carries the extra fact its reader needs: the score dropped them
    // too, so the table and the number it explains counted the same bands.
    expect(formatDiff(selfDiff(8000), context)).toContain('the score leaves those bands out too')
    // Nothing can be done about it from the patch, which is what stops an agent steering.
    expect(formatDiff(selfDiff(8000), context)).toContain('neither the file nor any patch move can put energy there')
  })

  it('adds nothing at a rate that carries every band', () => {
    // The common path: 44.1 kHz marks no band, and neither does a metrics object with no
    // rate recorded at all, so both are byte-identical to what they printed before the flag.
    for (const sampleRateHz of [44100, 48000, undefined]) {
      expect(naBands(formatMetrics(at(sampleRateHz)), 'db'), String(sampleRateHz)).toEqual([])
      expect(formatMetrics(at(sampleRateHz)), String(sampleRateHz)).not.toContain('Nyquist')
      expect(formatDiff(selfDiff(sampleRateHz), context), String(sampleRateHz)).not.toContain('Nyquist')
    }
    expect(formatMetrics(at(44100))).toBe(formatMetrics(at(undefined)))
  })

  it('keeps the frequency axis at all ten bands whatever the rate', () => {
    // The brightness timeline's rule, one axis over: the heading is what makes the row
    // readable, and it is the CELL that says whether anything was measured.
    for (const sampleRateHz of [8000, 11025, 22050, 44100, undefined]) {
      expect(bandRow(formatMetrics(at(sampleRateHz)), 'hz'), String(sampleRateHz)).toHaveLength(10)
      expect(bandRow(formatDiff(selfDiff(sampleRateHz), context), 'hz'), String(sampleRateHz)).toHaveLength(10)
      expect(bandRow(formatMetrics(at(sampleRateHz)), 'hz')[9]).toBe('16k')
    }
  })

  /**
   * The drift guard. This file states the Nyquist rule for a third time - it is private in
   * `audio-analysis.ts` and private again in `match-diff.ts` - so the thing that must be
   * true is not that the arithmetic looks the same but that the two tables mark the same
   * bands as the flag, which is itself tied to `details.bands.bandsCompared` by its own test.
   */
  it('marks exactly the bands diffAudioMetrics flags, at every rate', () => {
    for (const sampleRateHz of [8000, 11025, 16000, 22050, 32000, 44100, 48000, 96000, undefined]) {
      const diff = selfDiff(sampleRateHz)
      const flagged = diff.bands.flatMap((band, index) => (band.aboveNyquist ? [index] : []))
      expect(naBands(formatMetrics(at(sampleRateHz)), 'db'), String(sampleRateHz)).toEqual(flagged)
      expect(naBands(formatDiff(diff, context), 'd'), String(sampleRateHz)).toEqual(flagged)
    }
    // And the sweep really did exercise both answers, so an agreement of two empty sets
    // cannot be what passed it.
    expect(selfDiff(8000).bands.some((band) => band.aboveNyquist)).toBe(true)
    expect(selfDiff(48000).bands.some((band) => band.aboveNyquist)).toBe(false)
  })

  it('never prints a language placeholder for a band it could not measure', () => {
    for (const text of [formatMetrics(at(8000)), formatDiff(selfDiff(8000), context)]) {
      for (const token of forbidden) expect(text).not.toContain(token)
    }
  })
})

/**
 * `tiltDbPerOctave` and `oddEvenDb` both fall back to 0 when there is nothing to measure,
 * and 0 is what a flat spectrum and a balanced one really read, so neither can be printed
 * raw. The two fall back on DIFFERENT conditions, which is why they get different sentences:
 * a sine earns the tilt's and not the odd/even's.
 */
describe('a tilt or an odd/even with nothing behind it', () => {
  const sine = () => makeMetrics({ harmonicShape: sineShape() })
  const silent = () => makeMetrics({ harmonicShape: silentShape() })

  it('does not let a sine claim a flat spectrum', () => {
    // The defect: one partial above the noise, no slope at all, and the row said `0.0`.
    const text = formatMetrics(sine())
    expect(text).not.toContain('tilt 0.0 dB/oct')
    expect(text).toContain('tilt n/a (fewer than two partials above the noise, so there is no slope to fit)')
    // The odd/even is a real reading on the same sound and stays a number: the fundamental
    // gives the odd parity a level, and the even parity's absence is the measurement.
    expect(text).toMatch(/odd\/even [+-]?\d+\.\d dB/)
  })

  it('nulls the odd/even only when no partial was found at all', () => {
    const text = formatMetrics(silent())
    expect(text).toContain('tilt n/a (fewer than two partials above the noise')
    expect(text).toContain('odd/even n/a (no partial above the noise, so neither parity has a level)')
  })

  it('leaves a measured sound exactly as it was', () => {
    // No condition to hang either sentence on, so the common path pays nothing for them.
    const text = formatMetrics(makeMetrics())
    expect(text).toContain('tilt -6.1 dB/oct   odd/even +2.8 dB')
    expect(text).not.toContain('n/a (')
  })

  it('gives the diff row its reason, per figure, on its own line', () => {
    // A sine reference against a full series: the tilt cannot be differenced because one
    // side has no slope, while both sides' parities have levels, so one sentence appears
    // and the other must not.
    const diff = diffAudioMetrics(sine(), candidateMetrics(), comparison(0.3))
    expect(diff.harmonics!.tiltDeltaDbPerOctave).toBeNull()
    expect(diff.harmonics!.oddEvenDeltaDb).not.toBeNull()

    const text = formatDiff(diff, context)
    expect(text).toContain('tilt n/a dB/oct')
    expect(text).toContain('  tilt n/a: one side had fewer than two partials above the noise')
    expect(text).not.toContain('odd/even n/a')
    // The verdict word is the thing a bare `n/a` invites a reader to supply for themselves.
    for (const word of ['you darker', 'you brighter', 'same slope']) expect(text).not.toContain(word)
  })

  it('gives both reasons when both figures are missing', () => {
    const diff = diffAudioMetrics(silent(), candidateMetrics(), comparison(0.1))
    expect(diff.harmonics!.oddEvenDeltaDb).toBeNull()
    const text = formatDiff(diff, context)
    expect(text).toContain('  tilt n/a: one side had fewer than two partials above the noise')
    expect(text).toContain('  odd/even n/a: one side had no partial above the noise at all')
  })

  it('adds neither line when both figures were measured', () => {
    const text = formatDiff(diffFixture(), context)
    expect(text).not.toContain('tilt n/a')
    expect(text).not.toContain('odd/even n/a')
    expect(text).toContain('tilt -5.3 dB/oct  (you darker)')
  })

  it('never prints a language placeholder for either', () => {
    for (const metrics of [sine(), silent()]) {
      for (const text of [formatMetrics(metrics), formatDiff(diffAudioMetrics(metrics, candidateMetrics(), comparison(0.2)), context)]) {
        for (const token of forbidden) expect(text).not.toContain(token)
      }
    }
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
