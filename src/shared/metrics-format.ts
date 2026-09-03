/**
 * The plain-text rendering of an analysis and of a diff. This is the payload a model
 * actually reads, so the formatting is the feature rather than a presentation detail.
 *
 * Three rules run through every block:
 *
 * - The sign convention is stated once per block header, `(you - ref)`, so no reader ever
 *   has to infer it from a value that happens to be negative.
 * - Precision stops where the measurement does: one decimal for dB, integers for ms and
 *   cents. More digits than that invite false convergence on noise.
 * - An unmeasurable figure renders `n/a` followed by the reason, never `null`, never
 *   `undefined`, and never a bare `0` - the eval's complaint about a null `decayT60Ms`
 *   generalised to every field.
 *
 * Pure string functions; no DOM, no I/O.
 */

import type { AudioMetrics } from './audio-analysis'
import type { MatchAction, MatchDiff } from './match-types'
import { hzToNearestMidi, noteName } from './notes'

/** Width of one partial or band column. Wide enough for `-120.0` and for a 5-cell bar. */
const COLUMN = 6
/** Partials at or below this read as absent from the sparkline rather than as a short bar. */
const SPARK_FLOOR_DB = -40
/** Tallest bar. Five cells fit inside `COLUMN` with a separating space, so rows stay aligned. */
const SPARK_MAX = 5
/** dB of signed error per bar cell in a delta sparkline. */
const SPARK_DELTA_DB = 3
/** Beyond this the pitch line is flagged; inside it, a match. */
const PITCH_OK_CENTS = 5
/** `formatDiff` renders at most this many actions, in the order given. */
const MAX_ACTIONS = 5

const pad = (text: string, width = COLUMN): string => text.padStart(width)

/** Every number reaching the page goes through one of these, so no NaN can leak into text. */
const finite = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const db1 = (value: number | null | undefined): string => (finite(value) ? value.toFixed(1) : 'n/a')
/** Exact zero prints unsigned: `+0.0` reads as a small positive error rather than as none. */
const signedDb1 = (value: number | null | undefined): string => {
  if (!finite(value)) return 'n/a'
  if (value === 0) return '0.0'
  return `${value > 0 ? '+' : '-'}${Math.abs(value).toFixed(1)}`
}
const int = (value: number | null | undefined): string => (finite(value) ? String(Math.round(value)) : 'n/a')
const signedInt = (value: number | null | undefined): string => {
  if (!finite(value)) return 'n/a'
  const rounded = Math.round(value)
  return rounded === 0 ? '0' : `${rounded > 0 ? '+' : '-'}${Math.abs(rounded)}`
}
const ratio2 = (value: number | null | undefined): string => (finite(value) ? value.toFixed(2) : 'n/a')
/** Similarity keeps three decimals: the eval trajectories are read at that resolution. */
const score3 = (value: number | null | undefined): string => (finite(value) ? value.toFixed(3) : 'n/a')
/** Two decimals for the unitless 0..1 figures and for octaves, where a tenth is too coarse. */
const signedRatio2 = (value: number | null | undefined): string => {
  if (!finite(value)) return 'n/a'
  if (value === 0) return '0.00'
  return `${value > 0 ? '+' : '-'}${Math.abs(value).toFixed(2)}`
}
const sci = (value: number | null | undefined): string => (finite(value) ? value.toExponential(1) : 'n/a')

/** `31`, `1k`, `16k` - the band centres as an agent would say them aloud. */
const bandLabel = (hz: number): string => {
  if (!finite(hz)) return 'n/a'
  const rounded = Math.round(hz)
  return rounded >= 1000 ? `${Math.round(rounded / 1000)}k` : String(rounded)
}

const noteLabel = (hz: number | null | undefined): string => {
  if (!finite(hz) || hz <= 0) return 'n/a'
  const { midi, cents } = hzToNearestMidi(hz)
  return `${noteName(midi)} ${signedInt(cents)}c`
}

/**
 * One cell per `SPARK_FLOOR_DB / SPARK_MAX` dB. An amplitude-linear bar would be the more
 * physical choice and is unreadable here: it collapses everything below about -14 dB into a
 * single cell, which is most of a decaying partial series. Decibels spend the five cells on
 * the shape an agent is steering.
 */
const levelBar = (db: number | null | undefined): string => {
  if (!finite(db)) return ''
  if (db <= SPARK_FLOOR_DB) return '.'
  const cells = Math.round(SPARK_MAX * (1 + db / -SPARK_FLOOR_DB))
  return '#'.repeat(Math.max(1, Math.min(SPARK_MAX, cells)))
}

/** Signed bar for an error row: `+` the candidate is louder here, `-` it is quieter. */
const deltaBar = (db: number | null): string => {
  if (!finite(db)) return ''
  const cells = Math.min(SPARK_MAX, Math.round(Math.abs(db) / SPARK_DELTA_DB))
  if (cells === 0) return '·'
  return (db > 0 ? '+' : '-').repeat(cells)
}

/** A row of fixed-width cells behind a fixed-width label, so every column lines up. */
const row = (label: string, cells: string[]): string =>
  ` ${label.padEnd(5)}${cells.map((cell) => pad(cell)).join('')}`

const heading = (values: readonly unknown[]): string =>
  row('n', values.map((_, index) => String(index + 1)))

/**
 * One analysis, standalone. Used where there is no reference to compare against - the
 * output of an `analyze_audio` call - and as the absolute counterpart to `formatDiff`,
 * which carries only errors.
 */
export function formatMetrics(metrics: AudioMetrics): string {
  const lines: string[] = []
  const pitch = metrics.pitch ?? null

  lines.push('SOUND')
  lines.push(
    pitch
      ? `  pitch ${db1(pitch.f0Hz)} Hz  ${noteName(pitch.midi)} ${signedInt(pitch.centsOffset)}c` +
          `  (conf ${ratio2(pitch.confidence)}, ${pitch.source})`
      : '  pitch n/a (nothing periodic found in the buffer)'
  )
  lines.push(
    `  loudness ${db1(metrics.loudnessDb)} dB   peak ${db1(metrics.peakDb)} dB` +
      `   flatness ${ratio2(metrics.spectralFlatness)}   width ${ratio2(metrics.stereoWidth)}`
  )

  lines.push('')
  const shape = metrics.harmonicShape
  if (shape && metrics.harmonics) {
    lines.push('PARTIALS  dB relative to the fundamental')
    const amplitudes = shape.amplitudesDbRelF0
    lines.push(heading(amplitudes))
    lines.push(row('db', amplitudes.map((value) => db1(value))))
    lines.push(row('bar', amplitudes.map((value) => levelBar(value))))
    lines.push(
      `  tilt ${signedDb1(shape.tiltDbPerOctave)} dB/oct` +
        `   odd/even ${signedDb1(shape.oddEvenDb)} dB` +
        `   inharm ${sci(metrics.harmonics.inharmonicity)}`
    )
  } else {
    lines.push('PARTIALS  n/a (no fundamental given or detected, so partials were not analysed)')
  }

  lines.push('')
  lines.push('BANDS   dB vs total power')
  lines.push(row('hz', metrics.bandsDb.map((_, index) => bandLabel(31.25 * 2 ** index))))
  lines.push(row('db', metrics.bandsDb.map((value) => db1(value))))

  lines.push('')
  lines.push('ENVELOPE')
  lines.push(
    `  attack ${int(metrics.attackMs)} ms   time-to-peak ${int(metrics.timeToPeakMs)} ms` +
      `   T60 ${finite(metrics.decayT60Ms) ? `${int(metrics.decayT60Ms)} ms` : 'n/a (no decay to slope)'}` +
      `   sustain ${db1(metrics.sustainDb)} dB`
  )

  lines.push('')
  lines.push('BRIGHTNESS  centroid Hz, per window')
  lines.push(
    `  ${metrics.spectralWindows
      .map((window) => `${int(window.startMs)}-${int(window.endMs)}ms ${int(window.spectralCentroidHz)}`)
      .join(' | ')}`
  )

  return lines.join('\n')
}

function formatActions(actions: readonly MatchAction[]): string[] {
  const lines: string[] = ['', 'ACTIONS  ranked, best first']
  actions.slice(0, MAX_ACTIONS).forEach((action, index) => {
    lines.push(` ${index + 1}. ${action.finding}`)
    const move = action.suggested
      ? `${action.suggested.id} ${db1(action.suggested.from)} -> ${db1(action.suggested.to)} ${action.suggested.unit}`
      : `${action.direction} ${action.paramIds.join(', ') || 'n/a (no parameter mapped)'}`
    lines.push(`    -> ${move}  [${action.confidence}]`)
  })
  return lines
}

/**
 * The diff, as an agent reads it. Every block header restates that the numbers are
 * `you - ref`, so a negative always means the candidate is quieter, darker, shorter or
 * narrower - there is nothing per-block to re-derive.
 */
export function formatDiff(
  diff: MatchDiff,
  context?: { referenceName?: string; comparisonNumber?: number; bestSoFar?: number }
): string {
  const lines: string[] = []

  const header: string[] = []
  if (context?.referenceName) header.push(`ref "${context.referenceName}"`)
  if (finite(context?.comparisonNumber)) header.push(`comparison ${int(context?.comparisonNumber)}`)
  if (finite(context?.bestSoFar)) header.push(`best so far ${score3(context?.bestSoFar)}`)
  lines.push(header.length > 0 ? `MATCH  ${header.join('  |  ')}` : 'MATCH')
  lines.push(`overall ${score3(diff.similarity)}   (all deltas below are you - ref)`)

  lines.push('')
  const { referenceHz, candidateHz, centsError } = diff.pitch
  if (finite(referenceHz) && finite(candidateHz) && finite(centsError)) {
    const verdict = Math.abs(centsError) <= PITCH_OK_CENTS ? 'ok' : 'off'
    lines.push(
      `PITCH   ref ${db1(referenceHz)} Hz  ${noteLabel(referenceHz)}` +
        `   you ${db1(candidateHz)} Hz  ${noteLabel(candidateHz)}` +
        `   ->  ${signedInt(centsError)} cents   ${verdict}`
    )
  } else {
    const missing = !finite(referenceHz) && !finite(candidateHz) ? 'neither side' : !finite(referenceHz) ? 'the reference' : 'your sound'
    lines.push(`PITCH   n/a (no fundamental measured on ${missing})`)
  }

  lines.push('')
  if (diff.harmonics) {
    lines.push('PARTIALS  dB relative to the fundamental, signed error (you - ref)')
    lines.push(heading(diff.harmonics.deltaDb))
    lines.push(row('d', diff.harmonics.deltaDb.map((value) => (value === null ? 'n/a' : signedDb1(value)))))
    lines.push(row('bar', diff.harmonics.deltaDb.map((value) => deltaBar(value))))
    const tilt = diff.harmonics.tiltDeltaDbPerOctave
    const tiltWord = !finite(tilt) ? '' : tilt < 0 ? '  (you darker)' : tilt > 0 ? '  (you brighter)' : '  (same slope)'
    lines.push(
      `  tilt ${signedDb1(tilt)} dB/oct${tiltWord}` +
        `   odd/even ${signedDb1(diff.harmonics.oddEvenDeltaDb)} dB` +
        `   inharm ${sci(diff.harmonics.inharmonicityDelta)}`
    )
    lines.push('  n/a in a column means that partial was above the noise on one side only.')
  } else {
    lines.push('PARTIALS  n/a (one side has no fundamental, so partials are not comparable)')
  }

  lines.push('')
  lines.push('BANDS   dB vs total power, signed error (you - ref)')
  lines.push(row('hz', diff.bands.map((band) => bandLabel(band.centerHz))))
  lines.push(row('d', diff.bands.map((band) => signedDb1(band.deltaDb))))

  lines.push('')
  lines.push('ENVELOPE  signed error (you - ref)')
  lines.push(
    `  attack ${signedInt(diff.envelope.attackMsDelta)} ms` +
      `   time-to-peak ${signedInt(diff.envelope.timeToPeakMsDelta)} ms` +
      `   T60 ${
        finite(diff.envelope.decayT60MsDelta)
          ? `${signedInt(diff.envelope.decayT60MsDelta)} ms`
          : 'n/a (no decay to slope on one side)'
      }` +
      `   sustain ${signedDb1(diff.envelope.sustainDbDelta)} dB`
  )

  lines.push('')
  if (diff.brightness.length > 0) {
    lines.push('BRIGHTNESS  centroid, octaves (you - ref), per window')
    lines.push(
      `  ${diff.brightness
        .map((window) => `${int(window.startMs)}-${int(window.endMs)}ms ${signedRatio2(window.octaveDelta)}`)
        .join(' | ')}`
    )
  } else {
    lines.push('BRIGHTNESS  n/a (no spectral windows on one side)')
  }

  lines.push('')
  lines.push(
    `OTHER   flatness ${signedRatio2(diff.flatnessDelta)}   width ${signedRatio2(diff.stereoWidthDelta)}` +
      `   loudness ${signedDb1(diff.loudnessDbDelta)} dB`
  )

  // An empty header would read as "nothing is wrong" rather than "nothing was ranked".
  if (diff.actions.length > 0) lines.push(...formatActions(diff.actions))

  return lines.join('\n')
}
