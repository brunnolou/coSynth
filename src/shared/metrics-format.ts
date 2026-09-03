/**
 * The plain-text rendering of an analysis and of a diff. This is the payload a model
 * actually reads, so the formatting is the feature rather than a presentation detail.
 *
 * Three rules run through every block:
 *
 * - The sign convention is stated once per block header, `(you - ref)`, so no reader ever
 *   has to infer it from a value that happens to be negative.
 * - Precision stops where the measurement does: one decimal for dB, integers for ms and
 *   cents. More digits than that invite false convergence on noise. A SUGGESTED parameter
 *   value is the one exception and is rendered by its own rule - see `moveValue`.
 * - An unmeasurable figure renders `n/a` followed by the reason, never `null`, never
 *   `undefined`, and never a bare `0` - the eval's complaint about a null `decayT60Ms`
 *   generalised to every field.
 *
 * Pure string functions; no DOM, no I/O.
 */

import type { AudioMetrics } from './audio-analysis'
import {
  BAND_CENTERS_HZ, isBandMeasurable, isMeasuredPartial, isSpectralWindowBelowNoiseFloor,
  nyquistOrUnbounded
} from './audio-analysis'
import type { MatchAction, MatchDiff } from './match-types'
import { hzToNearestMidi, noteName } from './notes'

/**
 * Width of one partial or band column, INCLUDING the space that separates it from the cell
 * on its left. Seven, because the widest cell is six: `signedDb1(-100)` renders `-100.0`,
 * the band floor, and `signedDb1(+100)` the same length again.
 *
 * At six it was exactly the width of that widest cell and no more, so two floored cells sat
 * flush against each other and a real BANDS row read `-14.4-100.0+100.0` - three numbers a
 * reader has to re-segment by eye, and the minus sign of the second doing double duty as the
 * separator of the first. A column that only separates the values it happens to have seen is
 * the same defect as a figure that only reports the cases it could measure: the row LOOKS
 * uniform right up to the payload that breaks it, and the payload that breaks it is a
 * near-Nyquist band, which is exactly when a reader is trying to work out what is real.
 *
 * Exported so the tests slice rows by this rather than by a literal 6 - they asserted the
 * width they assumed rather than the width the formatter uses, which meant an alignment test
 * that could agree with a wrong answer. `row()` derives the LABEL field from it for the same
 * reason: the label used to be padded to a hardcoded 5 behind a hardcoded leading space, so
 * it occupied a column's width by coincidence, and widening the cells alone silently knocked
 * every row one character out of true.
 */
export const COLUMN = 7
/** Partials at or below this read as absent from the sparkline rather than as a short bar. */
const SPARK_FLOOR_DB = -40
/**
 * Tallest bar, and deliberately NOT derived from `COLUMN`: the cell count is the sparkline's
 * resolution - `SPARK_FLOOR_DB / SPARK_MAX` dB per cell, and `SPARK_DELTA_DB` per cell on the
 * delta row - so tying it to the column width would silently rescale what the bars MEAN every
 * time the layout moved. It only has to fit, which `SPARK_MAX < COLUMN` guarantees: five cells
 * inside a seven-wide column leave two spaces, so a full-height bar never touches its
 * neighbour and the rows stay aligned.
 */
const SPARK_MAX = 5
/** dB of signed error per bar cell in a delta sparkline. */
const SPARK_DELTA_DB = 3
/** Beyond this the pitch line is flagged; inside it, a match. */
const PITCH_OK_CENTS = 5
/**
 * `formatDiff` renders at most this many actions, in the order given, and SAYS SO when it
 * drops any - see `truncatedActionsNote`.
 */
const MAX_ACTIONS = 5

/**
 * Why a brightness cell reads `n/a`. Both blocks print this only when a window is actually
 * gated, so a run where every slice was measured is byte-identical to what it printed
 * before the gate existed - the common path stays as short as it was.
 *
 * The reason lives on its own line rather than in the cell because the brightness rows are
 * a timeline: `495-660ms n/a (below the noise floor)` in the middle of four pipe-separated
 * windows costs more width than the whole rest of the row and buries the times.
 */
const GATED_WINDOW_NOTE = {
  absolute: '  n/a in a window means it fell below the noise floor, so its centroid measured the noise rather than the sound.',
  diff: '  n/a in a window means one side or both fell below the noise floor there, so nothing was compared - the score leaves those windows out too.'
} as const

/**
 * Why a partial cell reads `n/a`. The absolute wording states the fact - the partial is not
 * there - because that is a real, useful reading of a sound; the diff wording states that
 * nothing was differenced, because a dB error against a clamp is not an error.
 */
const FLOORED_PARTIAL_NOTE = {
  absolute: '  n/a in a column means no peak above the noise for that partial: it is missing from this sound, not merely quiet.',
  diff: '  n/a in a column means that partial was above the noise on one side only, or on neither; a one-sided partial still scores as a full mismatch.'
} as const

/**
 * Why a band cell reads `n/a`. Not a quiet band and not a gate: the band's lower edge sits
 * above the Nyquist of this sample rate, so `bandsDb` reads its -100 dB floor there whatever
 * the sound is.
 *
 * Printing that -100 is the same defect the brightness row was fixed for twice, one axis
 * over. It looks exactly like a level - "the 8k band is 100 dB down" - and an agent that
 * reads it reaches for brightness parameters to fix an emptiness no patch move can fill,
 * because the FILE cannot represent those frequencies at all. Worse in the diff, where two
 * floors subtract to a clean `0.0`: a perfect match, in a band `bandsDetail` never counted.
 *
 * On its own line rather than in the cell, for the reason `GATED_WINDOW_NOTE` gives, and
 * printed only when a band is actually marked - a 44.1 kHz pair marks none, so the common
 * path is byte-identical to what it printed before the flag existed.
 */
const NYQUIST_BAND_NOTE = {
  absolute: '  n/a in a band means it sits above this sample rate\'s Nyquist: nothing can be there at any level, so there is nothing to measure.',
  diff: '  n/a in a band means it sits above one side\'s Nyquist, so neither the file nor any patch move can put energy there - the score leaves those bands out too.'
} as const

/**
 * Highest frequency this sound can carry, or `Infinity` when the rate is not recorded - a
 * metrics object built by hand, or serialized before `sampleRateHz` existed, which then
 * takes every band as measurable exactly as it did before the flag.
 *
 * `nyquistOrUnbounded` and `isBandMeasurable` come from `audio-analysis.ts`, which defines
 * the bands and argues the rule. This was a third hand-written statement of it until those
 * two were exported. The test below still earns its keep: it renders an `AudioMetrics`
 * through `formatMetrics` and a self-diff of it through `formatDiff` and requires the two to
 * mark the SAME bands, which now checks that both call sites read the shared predicate
 * rather than that three copies happen to agree.
 */
const measurableBands = (sampleRateHz: number | undefined): boolean[] => {
  const limitHz = nyquistOrUnbounded(sampleRateHz)
  return BAND_CENTERS_HZ.map((_, index) => isBandMeasurable(index, limitHz))
}

/**
 * Why this row and `spectralCentroidHz` can name different sides as the brighter one. Both
 * are centroids of the same audio, and an eval agent reading the two together - the row here
 * and `comparison.details.spectralCentroidHz` beside it - took the pair for a contradiction
 * and could not tell which to act on: "brightness said I was too bright (888 vs 620) while
 * spectralCentroidHz said too dark (574 vs 837) on the same buffer". They are two honest
 * answers to two questions. This row weights every slice equally; `spectralCentroidHz`
 * weights by power over the whole buffer, so a quiet bright tail moves this row and barely
 * moves that number. On one probe buffer with nothing gated at all they read 596 Hz and
 * 239 Hz, and when the two sides put their brightness in differently-loud slices the sign
 * between them flips.
 *
 * It rides on the block header rather than on a line of its own. Both blocks print it on
 * every payload - there is no condition to hang it on, since neither formatter can see the
 * whole-buffer figure it is warning about - and a standing line of prose is a cost the
 * text-mode byte budget in `tools.test.ts` actually notices. Four words in a header a reader
 * is already looking at cost a third of that and land in the same eye.
 */
const BRIGHTNESS_BASIS = ' - slices weighted equally, unlike spectralCentroidHz'

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
/**
 * `signedDb1`'s rule on the integer units: the guard is on the VALUE, never on the rounded
 * value, so an unsigned `0` means an exact zero and nothing else.
 *
 * It guarded the rounded value, and that made the two facts a reader most needs to tell
 * apart print identically: a +0.4 ms attack error and a true zero both rendered `0`. That is
 * this file's recurring defect in miniature - a measurement that WAS made, reported as
 * though it had not been - and it is the one the sign exists to prevent, since below one
 * unit the sign is the entire remaining content of the reading.
 *
 * A sub-unit reading therefore prints `+0` / `-0`, ugly and honest, rather than a bound like
 * `<1c`. The bound is prettier and throws away the half of the datum that survived the
 * rounding: `<1c` cannot say WHICH SIDE, and direction is the thing every block header here
 * spends a clause establishing (`you - ref`). `-0c` costs a reader one beat to parse and
 * then tells them the truth - flat, by less than a cent - while `<1c` reads as a tolerance
 * band and quietly asks them to guess. It also keeps one rule across the file: `+0.0` dB has
 * meant exactly this since the dB renderer was fixed for the same bug.
 */
const signedInt = (value: number | null | undefined): string => {
  if (!finite(value)) return 'n/a'
  if (value === 0) return '0'
  return `${value > 0 ? '+' : '-'}${Math.abs(Math.round(value))}`
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

/**
 * The producer, `match-advice.ts`, puts every `suggested` value through `round(v, 6)`, so
 * six decimals is the FULL precision of the datum rather than a cap chosen here. Rendering
 * at or below it always round-trips to the number that was computed and never invents a
 * digit. One decimal is the floor so the common move - `filter1.cutoff 8000.0 -> 12278.5` -
 * prints exactly as it always has.
 */
const MOVE_DECIMALS_MAX = 6
const MOVE_DECIMALS_MIN = 1

/**
 * A SUGGESTED parameter value: as many decimals as it actually carries, at least one.
 *
 * This deliberately does NOT follow the fixed one-decimal rule the rest of the file uses.
 * That rule is about MEASUREMENTS - deltas, dB, centroids - where printing more digits than
 * the instrument supports invites false convergence on noise. A suggested value is not a
 * measurement. It is an exact number the agent will hand to `update_parameters` verbatim,
 * and shortening it does not suppress noise: it destroys the datum. A real eval run ranked
 * `env1.sustain 0.000001 -> 0.001` and `toFixed(1)` printed it as `0.0 -> 0.0`, advice that
 * reads as a no-op and gets skipped - the formatter silently discarding a useful move is
 * worse than a blemish. 80 of 395 probed moves rendered as `X -> X` that way.
 *
 * Precision is chosen per VALUE rather than per unit, because the requirement is that the
 * reader can see the change and a fixed per-unit rule still collapses a small move inside a
 * wide-ranging unit: `s` covers both `delay.time 0.35` and `comp.attack 0.0005`.
 */
const moveValue = (value: number | null | undefined): string => {
  if (!finite(value)) return 'n/a'
  if (value === 0) return '0.0'
  const exact = Number(value.toFixed(MOVE_DECIMALS_MAX))
  // Smaller than the last decimal place. `0.000000` would show a real setting as none, the
  // same sin as a fake `0.0`; exponential keeps it honest and short.
  if (exact === 0) return value.toExponential(1)
  for (let decimals = MOVE_DECIMALS_MIN; decimals < MOVE_DECIMALS_MAX; decimals++) {
    const text = exact.toFixed(decimals)
    if (Number(text) === exact) return text
  }
  return exact.toFixed(MOVE_DECIMALS_MAX)
}

/**
 * One ranked move. `from -> to` whenever the two ends differ at the precision above.
 *
 * They should always differ - `match-advice.ts` drops a move whose legal landing value
 * equals its start - but a move that survives that guard and still cannot be told apart
 * here is stated as a sentence rather than as `X -> X`. Advice that argues against itself
 * costs the reader the finding above it, so the one thing this line must never print is a
 * change that looks like none.
 */
const formatMove = (suggested: NonNullable<MatchAction['suggested']>): string => {
  const from = moveValue(suggested.from)
  const to = moveValue(suggested.to)
  if (from !== to) return `${suggested.id} ${from} -> ${to} ${suggested.unit}`
  return (
    `${suggested.id} stays at ${from} ${suggested.unit}` +
    ' (the correction is smaller than the six decimals a suggested value carries, so there is nothing to apply)'
  )
}

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

/**
 * A row of fixed-width cells behind a LABEL FIELD OF THE SAME WIDTH, so every column lines
 * up. The label used to be padded to a hardcoded 5 behind a hardcoded leading space, which
 * happened to total `COLUMN` while `COLUMN` was 6; the two could disagree and the rows would
 * still look plausible, just shifted. Padding the space-prefixed label to `COLUMN` makes the
 * agreement structural.
 */
const row = (label: string, cells: string[]): string =>
  `${` ${label}`.padEnd(COLUMN)}${cells.map((cell) => pad(cell)).join('')}`

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
  // TWO DIFFERENT QUESTIONS GET ASKED OF THIS BLOCK, AND ONLY ONE OF THEM IS THE NOISE GATE.
  //
  // 1. Should a WINDOW gate apply? No, deliberately. This renders
  //    `harmonicShape.amplitudesDbRelF0`, fitted once over the WHOLE buffer and therefore
  //    dominated by the loud part of it; it is not a per-slice reading and there is no
  //    window to gate it against. Marking it would say something false about a measurement
  //    that is fine.
  //
  //    The reading that does need that gate is `SpectralWindow.harmonicsDb`, which no
  //    formatter prints today. It is the more dangerous of the two: on a gated slice it does
  //    not collapse to the -120 dB floor but reads a flat fake spectrum - roughly [-80, -82,
  //    -82, -80, -83, -81] - whose fitted tilt is about 0 dB/octave, so it renders as a
  //    bright, perfectly even partial series rather than as an obviously dead one. Whoever
  //    adds a per-window partials row must print `n/a` on a `belowNoiseFloor` slice; a
  //    caveat under a plausible-looking spectrum will not undo it.
  //
  // 2. Should a PARTIAL on the -120 floor print as a number? No. `-120.0` looks like a level
  //    and is not one: `partialsDb` clamps there, and the reading under the clamp was -240
  //    or -Infinity. The honest statement is "no peak above the noise for this partial",
  //    which is what `n/a` plus the note below says, and it is the same statement `formatDiff`
  //    already makes for the same entry. Printing the depth also invites the arithmetic
  //    `harmonicsDetail` refuses to do - differencing against a clamp - and the `bar` row
  //    would have drawn `.` for it, a partial as quiet as a real one 40 dB down.
  const shape = metrics.harmonicShape
  if (shape && metrics.harmonics) {
    lines.push('PARTIALS  dB relative to the fundamental')
    const amplitudes = shape.amplitudesDbRelF0
    lines.push(heading(amplitudes))
    lines.push(row('db', amplitudes.map((value) => (isMeasuredPartial(value) ? db1(value) : 'n/a'))))
    lines.push(row('bar', amplitudes.map((value) => (isMeasuredPartial(value) ? levelBar(value) : ''))))
    // BOTH of these figures carry a 0 that means "nothing to measure", and it is the same 0
    // a real reading produces, so neither can be printed raw.
    //
    // `measureHarmonicShape` writes `tiltDbPerOctave = 0` for a series with fewer than two
    // partials above the noise. A rendered sine floors partials 2-12, so it has exactly one,
    // and this row read `tilt 0.0 dB/oct` for it: a flat-spectrum claim about a sound with
    // one partial in it, indistinguishable from the genuinely flat spectrum that also reads
    // 0.0. `oddEvenDb` falls back to 0 on the narrower condition of NO partial above the
    // noise at all - a parity group sitting entirely on the floor is a measurement, and the
    // whole content of this axis, so a band-limited square keeps its real (large) reading.
    //
    // The predicates are the analyzer's own, imported, for the reason `harmonicsDetail`
    // gives: two definitions of "this partial exists" eventually disagree. They are also
    // exactly what `measuredTilt` / `measuredOddEven` in `match-diff.ts` ask before nulling
    // the same two fields, so this block and the diff's go n/a on the same sounds.
    const measured = amplitudes.filter(isMeasuredPartial)
    lines.push(
      `  tilt ${
        measured.length >= 2
          ? `${signedDb1(shape.tiltDbPerOctave)} dB/oct`
          : 'n/a (fewer than two partials above the noise, so there is no slope to fit)'
      }` +
        `   odd/even ${
          measured.length > 0
            ? `${signedDb1(shape.oddEvenDb)} dB`
            : 'n/a (no partial above the noise, so neither parity has a level)'
        }` +
        `   inharm ${sci(metrics.harmonics.inharmonicity)}`
    )
    if (amplitudes.some((value) => !isMeasuredPartial(value))) lines.push(FLOORED_PARTIAL_NOTE.absolute)
  } else {
    lines.push('PARTIALS  n/a (no fundamental given or detected, so partials were not analysed)')
  }

  lines.push('')
  lines.push('BANDS   dB vs total power')
  // The `hz` heading keeps all ten bands whatever the sample rate, the same rule the
  // brightness timeline follows: the frequency axis stays readable and the row length stays
  // predictable, and it is the CELL that says what was measurable.
  const bandMeasurable = measurableBands(metrics.sampleRateHz)
  lines.push(row('hz', metrics.bandsDb.map((_, index) => bandLabel(BAND_CENTERS_HZ[index]))))
  lines.push(row('db', metrics.bandsDb.map((value, index) => (bandMeasurable[index] ? db1(value) : 'n/a'))))
  if (metrics.bandsDb.some((_, index) => !bandMeasurable[index])) lines.push(NYQUIST_BAND_NOTE.absolute)

  lines.push('')
  lines.push('ENVELOPE')
  lines.push(
    `  attack ${int(metrics.attackMs)} ms   time-to-peak ${int(metrics.timeToPeakMs)} ms` +
      `   T60 ${finite(metrics.decayT60Ms) ? `${int(metrics.decayT60Ms)} ms` : 'n/a (no decay to slope)'}` +
      `   sustain ${db1(metrics.sustainDb)} dB`
  )

  lines.push('')
  lines.push(`BRIGHTNESS  centroid Hz, per window${BRIGHTNESS_BASIS}`)
  // A gated slice still carries a centroid - the analyzer keeps the measured number rather
  // than zeroing it - and that number is the one that misleads: a -55 dB tail read 4,978 Hz,
  // brighter than the note that produced it. Printing it with a caveat would still put a
  // plausible figure in front of a reader who reads the row and not the footnote.
  lines.push(
    `  ${metrics.spectralWindows
      .map(
        (window) =>
          `${int(window.startMs)}-${int(window.endMs)}ms ${
            isSpectralWindowBelowNoiseFloor(window) ? 'n/a' : int(window.spectralCentroidHz)
          }`
      )
      .join(' | ')}`
  )
  if (metrics.spectralWindows.some((window) => isSpectralWindowBelowNoiseFloor(window))) {
    lines.push(GATED_WINDOW_NOTE.absolute)
  }

  return lines.join('\n')
}

/**
 * What the block says when it printed fewer moves than it was given.
 *
 * `MAX_ACTIONS` is a rendering cap and nothing else, while `compare_audio` takes a
 * `maxActions` input: a caller who asks for eight gets eight in `diff.actions` and five
 * here. Truncating them away in silence makes the block answer a question it was never
 * asked - an agent reads five ranked moves ending at 5. and concludes that is all the advice
 * there is, which is the absence-as-measurement error `n/a` exists to prevent everywhere
 * else in this file, one axis over: a list that was CUT and a list that ENDED look the same.
 *
 * The fix is the one already applied one field over, where the block collapses to a pointer
 * line that states `diff.actions.length` rather than the five it would have printed. Same
 * honesty here: lead with the number dropped, name the cap that dropped them so the reader
 * knows this is a layout limit rather than the advisor running out, and name the field that
 * still has all of them.
 *
 * It costs nothing on the common path. `adviseFromDiff` at the default `maxActions` returns
 * at most five, and text mode ships the moves structurally and prints no block at all, so
 * this line appears only for the caller that actually asked for more than fits.
 */
const truncatedActionsNote = (total: number): string => {
  const dropped = total - MAX_ACTIONS
  return (
    ` ${dropped} further ranked ${dropped === 1 ? 'move is' : 'moves are'} not printed here:` +
    ` this block stops at ${MAX_ACTIONS}. All ${total} are in diff.actions,` +
    ' with the parameter ids and target values to apply them.'
  )
}

function formatActions(actions: readonly MatchAction[]): string[] {
  const lines: string[] = ['', 'ACTIONS  ranked, best first']
  actions.slice(0, MAX_ACTIONS).forEach((action, index) => {
    lines.push(` ${index + 1}. ${action.finding}`)
    const move = action.suggested
      ? formatMove(action.suggested)
      : `${action.direction} ${action.paramIds.join(', ') || 'n/a (no parameter mapped)'}`
    lines.push(`    -> ${move}  [${action.confidence}]`)
  })
  if (actions.length > MAX_ACTIONS) lines.push(truncatedActionsNote(actions.length))
  return lines
}

/**
 * What stands in for the ACTIONS block when the caller ships `diff.actions` beside this
 * text, and why it is a line rather than nothing at all.
 *
 * The block is the largest duplicate in a `compare_audio` text-mode response: it restates
 * the same ranked moves the structured array already carries, and carries them WORSE -
 * `diff.actions` has the parameter ids, the `suggested.id/from/to/unit` an agent hands
 * to `update_parameters`, the confidence and the estimated gain, while the prose has a
 * rendering of a subset of that. Text mode already drops `envelopeDb`, `bandsDb` and
 * `spectralWindows` because the tables restate them; this is the same duplication with
 * the sides swapped, and the prose is the copy to drop.
 *
 * Dropping it SILENTLY is the one thing that must not happen. A reader who has only ever
 * seen the block reads its absence as "nothing was ranked" - the same absence-as-
 * measurement error `n/a` exists to prevent everywhere else in this file - and a missing
 * block and an empty `actions` array are different facts. So the line leads with the
 * COUNT, which no "there were no suggestions" reading survives, and then names where the
 * moves are and what they carry, so an agent holding only this text knows the next move
 * is to read `diff.actions` rather than to conclude it is done.
 *
 * The count is `actions.length`, the number in the array the reader is being sent to,
 * rather than the `MAX_ACTIONS` the block would have printed.
 */
const actionsShippedStructurallyNote = (count: number): string =>
  `ACTIONS  ${count} ranked ${count === 1 ? 'move' : 'moves'} ship as diff.actions beside this text,` +
  ' with the parameter ids and target values to apply them; not restated here.'

/**
 * The diff, as an agent reads it. Every block header restates that the numbers are
 * `you - ref`, so a negative always means the candidate is quieter, darker, shorter or
 * narrower - there is nothing per-block to re-derive.
 */
export function formatDiff(
  diff: MatchDiff,
  context?: {
    referenceName?: string
    comparisonNumber?: number
    bestSoFar?: number
    /**
     * The caller is shipping `diff.actions` structurally in the same response, so the
     * ACTIONS block is dropped in favour of one line pointing at it. See
     * `actionsShippedStructurallyNote`.
     *
     * Defaults to `false`, and has to: it is an ASSERTION about the response being built
     * around this text, and only a caller that can see that response can make it. A caller
     * that renders this text ALONE - a log line, a chat message, a file - and got the block
     * dropped by default would lose the ranked moves outright and be told to go read an
     * array that is not there. Off by default, the untrue version of the line can never be
     * printed.
     */
    actionsShipStructurally?: boolean
  }
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
    const oddEven = diff.harmonics.oddEvenDeltaDb
    const tiltWord = !finite(tilt) ? '' : tilt < 0 ? '  (you darker)' : tilt > 0 ? '  (you brighter)' : '  (same slope)'
    lines.push(
      `  tilt ${signedDb1(tilt)} dB/oct${tiltWord}` +
        `   odd/even ${signedDb1(oddEven)} dB` +
        `   inharm ${sci(diff.harmonics.inharmonicityDelta)}`
    )
    if (diff.harmonics.deltaDb.some((value) => value === null)) lines.push(FLOORED_PARTIAL_NOTE.diff)
    // Two nulls on one row, with two different causes, so one shared note would be wrong
    // about whichever it did not describe - and a sound can easily earn one without the
    // other. A rendered sine is the case: one partial above the noise means no slope to fit,
    // while its single odd partial still gives both parities a level to difference.
    //
    // The reasons go under the row rather than into the cells because the row is a triple -
    // `tilt X dB/oct   odd/even Y dB   inharm Z` - and a parenthetical inside it pushes the
    // two figures that ARE measured off where the eye expects them. Each prints only when
    // its own figure is null, so a comparison with both measured is byte-identical to what
    // it printed before these fields could go null at all.
    if (!finite(tilt)) {
      lines.push('  tilt n/a: one side had fewer than two partials above the noise, so it has no slope to difference against.')
    }
    if (!finite(oddEven)) {
      lines.push('  odd/even n/a: one side had no partial above the noise at all, so neither of its parities has a level.')
    }
  } else {
    lines.push('PARTIALS  n/a (one side has no fundamental, so partials are not comparable)')
  }

  lines.push('')
  lines.push('BANDS   dB vs total power, signed error (you - ref)')
  // `aboveNyquist` rather than a re-derived threshold, and for the same reason the brightness
  // row reads `belowNoiseFloor`: `diffAudioMetrics` set it from the two sample rates this row
  // was built from, and those are not recoverable from the row. The number under the flag is
  // finite and, worse than merely wrong, usually a clean `0.0` - two -100 dB floors
  // subtracting - which reads as the one band the candidate got exactly right. `bandsDetail`
  // left those bands out of the score, so printing them puts the table and the score it
  // explains in disagreement about which bands counted.
  //
  // The `hz` heading still carries all ten: the axis is the thing that makes the row
  // readable, and the cell is what says whether anything was measured.
  lines.push(row('hz', diff.bands.map((band) => bandLabel(band.centerHz))))
  lines.push(row('d', diff.bands.map((band) => (band.aboveNyquist ? 'n/a' : signedDb1(band.deltaDb)))))
  if (diff.bands.some((band) => band.aboveNyquist)) lines.push(NYQUIST_BAND_NOTE.diff)

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
    lines.push(`BRIGHTNESS  centroid, octaves (you - ref), per window${BRIGHTNESS_BASIS}`)
    // `belowNoiseFloor` rather than a re-derived threshold: `diffBrightness` set it from the
    // two slices this row actually differenced, after resampling, and those are not
    // recoverable from the row. A gated row's `octaveDelta` is finite and often large - it
    // is the distance from a sound to a noise floor - so printing it and adding a caveat
    // would hand a model a number to steer by that no pair of slices supports.
    lines.push(
      `  ${diff.brightness
        .map(
          (window) =>
            `${int(window.startMs)}-${int(window.endMs)}ms ${
              window.belowNoiseFloor ? 'n/a' : signedRatio2(window.octaveDelta)
            }`
        )
        .join(' | ')}`
    )
    if (diff.brightness.some((window) => window.belowNoiseFloor)) lines.push(GATED_WINDOW_NOTE.diff)
  } else {
    lines.push('BRIGHTNESS  n/a (no spectral windows on one side)')
  }

  lines.push('')
  lines.push(
    `OTHER   flatness ${signedRatio2(diff.flatnessDelta)}   width ${signedRatio2(diff.stereoWidthDelta)}` +
      `   loudness ${signedDb1(diff.loudnessDbDelta)} dB`
  )

  // An empty header would read as "nothing is wrong" rather than "nothing was ranked" -
  // and, for the same reason, an empty `actions` array gets NEITHER the block nor the line
  // that says the moves ship separately. There are no moves to ship, and a pointer to an
  // empty array is a lie in the opposite direction.
  if (diff.actions.length > 0) {
    lines.push(
      ...(context?.actionsShipStructurally
        ? ['', actionsShippedStructurallyNote(diff.actions.length)]
        : formatActions(diff.actions))
    )
  }

  return lines.join('\n')
}
