/**
 * The missing map between what `audio-analysis.ts` MEASURES and what `params.ts`
 * can be TOLD.
 *
 * Before this module the two never referenced each other, so every matching
 * iteration re-derived the inverse mapping "the candidate is 6 dB dark in the
 * top three octave bands, therefore raise filter1.cutoff" from scratch, from
 * scalars, and learned roughly one bit per round trip. `adviseFromDiff` turns a
 * `MatchDiff` into ranked, parameter-vocabulary moves so the next iteration
 * starts from a gradient instead of a guess.
 *
 * ## Shape of the thing
 *
 * `ADVICE_RULES` is a declarative, `readonly` table. Each rule declares which
 * `MatchDiff` fields it reads, which `PARAMS` ids it steers, the error scale at
 * which its dimension counts as fully wrong, a relative weight, and a silence
 * threshold. All ranking, clamping, filtering and capping is done once by the
 * driver below; a rule only decides "did this fire, by how much, and what do I
 * say about it". Adding a rule is a table entry, never a branch.
 *
 * ## `estimatedGain`, honestly
 *
 * `estimatedGain = weight * min(1, |error| / scale)`.
 *
 * - `weight` is a HAND-SET PRIOR for how much of the overall similarity score
 *   this dimension can move. The weights are relative to each other and do NOT
 *   sum to 1; they were chosen by ear-reasoning about which errors dominate a
 *   perceptual match (pitch first, gross brightness next, fine partial balance
 *   last), and are NOT regressed against the actual scorer in
 *   `compareAudioMetrics`.
 * - `scale` is the error magnitude, in that rule's own unit, at which the
 *   dimension is treated as maximally wrong. Beyond it the gain saturates, so a
 *   catastrophically wrong dimension cannot swamp the list with one entry.
 *
 * So the number is an ORDERING device with a plausible magnitude, not a
 * prediction. Two actions with gains 0.31 and 0.29 should be read as "these two
 * matter about the same"; 0.31 versus 0.04 is the comparison the number is for.
 * Nothing here has been calibrated against measured similarity deltas, and it
 * should not be quoted as an expected score improvement.
 *
 * ## What is NOT mapped
 *
 * - The mod-matrix depth of `env -> filter1.cutoff` is the correct fix for
 *   "brightness falls too fast", but a mod slot has no `PARAMS` id (it is a
 *   `{source, dest, depth}` slot, set with `set_modulation`). `paramIds` can
 *   therefore only carry the envelope's own parameters; the finding names the
 *   route in prose.
 * - There is no global master tune parameter. `master.bend_range` is a bend
 *   range, not a tuning offset, so pitch corrections steer `osc1.transpose` and
 *   `osc1.fine`.
 * - `MatchDiff.envelope.timeToPeakMsDelta` has no parameter of its own that
 *   `attackMsDelta` does not already cover (delay/hold would explain the rest,
 *   and a real ADSR fit is out of scope until `envelope-fit.ts`), so no rule
 *   reads it.
 * - `MatchDiff.similarity` is carried through for eval trajectories and steers
 *   nothing.
 */

import type { MatchAction, MatchDiff } from './match-types'
import { PARAMS, type ParamDef } from './params'

export type AdviceCategory = 'timbre' | 'envelope' | 'level' | 'space'

/** Live parameter values, raw units, choice params optionally as their label. Matches `PresetData.params` in raw form. */
export type PatchValues = Readonly<Record<string, number | string>>

export interface AdviseOptions {
  /** Cap on returned actions. Default 5. */
  maxActions?: number
  /** Keep only rules in this category. */
  focus?: AdviceCategory
}

/** What a rule returns when it fires. The driver turns this into a `MatchAction`. */
export interface RuleOutcome {
  /** Signed or unsigned error in the rule's own unit; `|error|` drives `estimatedGain`. */
  error: number
  finding: string
  direction: MatchAction['direction']
  confidence: MatchAction['confidence']
  suggested?: MatchAction['suggested']
  /** Narrow the advertised ids for this firing (must be a subset of `paramIds`). */
  paramIds?: readonly string[]
}

export interface AdviceContext {
  diff: MatchDiff
  patch: PatchValues
}

export interface AdviceRule {
  id: string
  category: AdviceCategory
  /** `MatchDiff` fields this rule reads. Documentation, and a test surface. */
  reads: readonly string[]
  /** Every id must exist in `PARAMS`; `assertRuleParamsExist` enforces it. */
  paramIds: readonly string[]
  /** Error magnitude, in the rule's unit, at which the dimension is fully wrong. */
  scale: number
  /** Relative prior for how much overall similarity this dimension can move. */
  weight: number
  /** `|error|` below this and the rule stays silent. */
  minError: number
  /** The rule's own unit, for documentation. */
  errorUnit: string
  evaluate(ctx: AdviceContext): RuleOutcome | null
}

// ------------------------------------------------------------------ helpers

const PARAM_BY_ID: ReadonlyMap<string, ParamDef> = new Map(PARAMS.map(d => [d.id, d]))

/**
 * Round half AWAY FROM ZERO.
 *
 * `Math.round` breaks ties toward +Infinity, so `Math.round(11.5)` is 12 while
 * `Math.round(-11.5)` is -11. Every quantity in this module is a SIGNED error,
 * and half of them are negative by construction, so that asymmetry means an
 * error and its mirror image get corrected by different amounts: a flat octave
 * lands a semitone short of the sharp one of the same size. `|f(-x)| === |f(x)|`
 * is the property this file needs, and this is the cheapest form of it.
 *
 * `Math.sign(-0.2) * Math.round(0.2)` is `-0`; the `+ 0` normalizes it so a
 * suggested value never serializes as `-0`.
 */
function roundTiesAwayFromZero(v: number): number {
  return Math.sign(v) * Math.round(Math.abs(v)) + 0
}

function round(v: number, places = 6): number {
  const f = 10 ** places
  return roundTiesAwayFromZero(v * f) / f
}

const n1 = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1))

/** Read a raw parameter value out of the patch, resolving choice labels to indices. */
export function patchRaw(patch: PatchValues, id: string): number | undefined {
  const def = PARAM_BY_ID.get(id)
  if (!def) return undefined
  const v = patch[id]
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string') {
    if (def.choices) {
      const i = def.choices.indexOf(v)
      return i >= 0 ? i : undefined
    }
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** Clamp to `min..max`, quantize to `step`, and keep choice params on a legal index. */
export function legalValue(def: ParamDef, v: number): number {
  if (def.choices) {
    const i = Math.round(v)
    return Math.min(def.choices.length - 1, Math.max(0, Number.isFinite(i) ? i : 0))
  }
  let x = Math.min(def.max, Math.max(def.min, v))
  // Half away from zero, not `Math.round`: `osc1.transpose` (-48..48, step 1)
  // and `sub.octave` (-3..0, step 1) both span negative values, and rounding
  // -11.5 to -11 while rounding 11.5 to 12 would bias every downward move.
  if (def.step) x = Math.min(def.max, Math.max(def.min, roundTiesAwayFromZero(x / def.step) * def.step))
  x = round(x)
  // Rounding for display can push a value a hair past an endpoint; re-clamp.
  return Math.min(def.max, Math.max(def.min, x))
}

function unitOf(def: ParamDef): string {
  if (def.unit) return def.unit
  return def.choices ? 'choice' : 'raw'
}

/**
 * Build a quantitative suggestion for `id`, or `undefined` when the patch does
 * not carry that parameter or the move rounds away to nothing.
 */
function suggest(patch: PatchValues, id: string, compute: (from: number) => number): MatchAction['suggested'] {
  const def = PARAM_BY_ID.get(id)
  if (!def) return undefined
  const from = patchRaw(patch, id)
  if (from === undefined) return undefined
  const wanted = compute(from)
  if (!Number.isFinite(wanted)) return undefined
  const to = legalValue(def, wanted)
  if (Math.abs(to - legalValue(def, from)) < 1e-9) return undefined
  return { id, from: round(from), to, unit: unitOf(def) }
}

/** Mean of the non-null entries of `deltaDb` over `[lo, hi]` inclusive, or `null`. */
function partialMean(deltaDb: (number | null)[], lo: number, hi: number): number | null {
  const vals: number[] = []
  for (let i = lo; i <= hi && i < deltaDb.length; i++) {
    const v = deltaDb[i]
    if (typeof v === 'number' && Number.isFinite(v)) vals.push(v)
  }
  if (vals.length === 0) return null
  return vals.reduce((a, b) => a + b, 0) / vals.length
}

/** Absolute magnitude range across `[lo, hi]`, for findings like "5-9 dB quiet". */
function partialSpan(deltaDb: (number | null)[], lo: number, hi: number): { lo: number; hi: number } | null {
  const vals: number[] = []
  for (let i = lo; i <= hi && i < deltaDb.length; i++) {
    const v = deltaDb[i]
    if (typeof v === 'number' && Number.isFinite(v)) vals.push(Math.abs(v))
  }
  if (vals.length === 0) return null
  return { lo: Math.min(...vals), hi: Math.max(...vals) }
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}

/** Mean band error over bands centred at or above `minHz`. */
function bandMean(bands: MatchDiff['bands'], minHz: number): number | null {
  const vals = bands.filter(b => b.centerHz >= minHz).map(b => b.deltaDb)
  return vals.length === 0 ? null : mean(vals)
}

const SEMITONE_CENTS = 100
const OCTAVE_SEMITONES = 12
const OCTAVE_CENTS = OCTAVE_SEMITONES * SEMITONE_CENTS

/**
 * How far off a whole octave a pitch error may sit and still be CALLED an
 * octave error. Detectors miss by an exact octave, so anything inside this band
 * is one, and whatever is left over (up to 60 cents) is an ordinary detune
 * riding on top of it — reported separately rather than folded into the octave.
 */
const OCTAVE_TOLERANCE_CENTS = 60

/** The pitch move, as ONE value. Prose and `suggested` are both read off this. */
interface PitchCorrection {
  /** Semitones to ADD to `osc1.transpose`. 0 when the whole error fits in `osc1.fine`. */
  semitones: number
  /** Cents to ADD to `osc1.fine` after `semitones` is applied. */
  residualCents: number
  /** Signed octave count when this is an octave error, 0 otherwise. `semitones` is 12x it. */
  octaves: number
}

/**
 * Turn a signed cents error into the correction that removes it.
 *
 * This is the single source of truth for the `pitch-error` rule: the finding
 * text is PHRASED from the numbers it returns rather than recomputed alongside
 * them, so the sentence an agent reads and the value an agent applies cannot
 * disagree. They used to. The rule classified an octave error from
 * `Math.round(cents / 1200)` and then derived the transpose independently from
 * `Math.round(cents / 100)`, which parts company anywhere in the 50..60 cent
 * shell of the tolerance band (-1141 cents read "1 octave below, +12 semitones"
 * and suggested +11), and `Math.round`'s tie-break toward +Infinity widened that
 * to the exact half-octave case: `Math.round(-11.5)` is -11, so -1150 cents said
 * "+12 semitones" and suggested +11 while +1150 cents said and suggested -12.
 *
 * Two rules settle every case:
 *
 * - Inside the octave band the OCTAVE wins the semitone count. The band is wider
 *   (60 cents) than the semitone grid's own rounding (50 cents), so the count
 *   has to come from the same classification that produces the word "octave".
 * - Outside it, the nearest semitone, rounded half away from zero so +X and -X
 *   are corrected by equal and opposite amounts.
 *
 * `residualCents` is always what is left over, so `semitones * 100 +
 * residualCents === -cents` exactly, for every input.
 */
function pitchCorrection(cents: number): PitchCorrection {
  const nearestOctave = roundTiesAwayFromZero(cents / OCTAVE_CENTS)
  const isOctave = nearestOctave !== 0 && Math.abs(cents - nearestOctave * OCTAVE_CENTS) <= OCTAVE_TOLERANCE_CENTS
  const octaves = isOctave ? -nearestOctave : 0
  const semitones = isOctave ? octaves * OCTAVE_SEMITONES : -roundTiesAwayFromZero(cents / SEMITONE_CENTS)
  return { semitones, residualCents: round(-cents - semitones * SEMITONE_CENTS), octaves }
}

/** `+12`, `-3`, `+49.7` — a signed number for prose an agent has to parse back. */
function signedNumber(v: number): string {
  return `${v > 0 ? '+' : ''}${round(v, 1)}`
}

/** `-12 semitones`, `+1 cent`. Signed, and singular only at exactly one unit. */
function signedUnits(v: number, unit: string): string {
  const rounded = round(v, 1)
  return `${signedNumber(rounded)} ${unit}${Math.abs(rounded) === 1 ? '' : 's'}`
}

// ------------------------------------------------------------------ rules

export const ADVICE_RULES: readonly AdviceRule[] = [
  {
    id: 'pitch-error',
    category: 'timbre',
    reads: ['pitch.centsError'],
    // No global tune parameter exists; osc1 carries coarse and fine tuning.
    // osc1.detune is listed because a sub-semitone error is often unison spread.
    paramIds: ['osc1.transpose', 'osc1.fine', 'osc1.detune'],
    scale: 200,
    weight: 0.35,
    minError: 8,
    errorUnit: 'cents',
    evaluate({ diff, patch }) {
      const cents = diff.pitch.centsError
      if (cents === null || !Number.isFinite(cents)) return null
      // ONE computation. Everything below is phrased from it, never recomputed.
      const { semitones, residualCents, octaves } = pitchCorrection(cents)
      // `semitones !== 0` is exactly `|cents| >= 50` under half-away-from-zero
      // rounding, so the old `Math.abs(cents) >= 50 && semitones !== 0` guard
      // collapses to this — and stops treating -50 and +50 differently.
      const onTranspose = semitones !== 0
      const sharp = cents > 0
      // The whole error rarely lands on a semitone. Naming the leftover lets an
      // agent finish the move in one round trip instead of two.
      const fineNote = Math.abs(residualCents) >= 0.5
        ? `, then ${signedUnits(residualCents, 'cent')} on osc1.fine`
        : ''
      const hzNote = diff.pitch.referenceHz !== null && diff.pitch.candidateHz !== null
        ? ` (${n1(diff.pitch.candidateHz)} Hz against ${n1(diff.pitch.referenceHz)} Hz)`
        : ''
      const finding = octaves !== 0
        // "Octave" is deliberate: a model acts on it far more reliably than on
        // "1200 cents sharp", which reads like any other detune.
        ? `Octave error: the candidate is ${Math.abs(octaves)} octave${Math.abs(octaves) === 1 ? '' : 's'} ${octaves < 0 ? 'above' : 'below'} the reference (${n1(cents)} cents). Transpose by ${signedUnits(semitones, 'semitone')}${fineNote}; do not chase the octave itself with fine tuning.`
        : onTranspose
          ? `Candidate is ${n1(Math.abs(cents))} cents ${sharp ? 'sharp' : 'flat'}${hzNote}. Transpose by ${signedUnits(semitones, 'semitone')}${fineNote}.`
          : `Candidate is ${n1(Math.abs(cents))} cents ${sharp ? 'sharp' : 'flat'}${hzNote}. Under a semitone, so this is osc1.fine (${signedUnits(residualCents, 'cent')}), not osc1.transpose.`
      return {
        error: cents,
        finding,
        direction: (onTranspose ? semitones : residualCents) < 0 ? 'decrease' : 'increase',
        // Pitch to transpose is one-to-one and exact. Sub-semitone errors can
        // also come out of unison detune, so those stay medium.
        confidence: onTranspose ? 'high' : 'medium',
        suggested: onTranspose
          ? suggest(patch, 'osc1.transpose', from => from + semitones)
          : suggest(patch, 'osc1.fine', from => from + residualCents),
        paramIds: onTranspose ? ['osc1.transpose', 'osc1.fine'] : ['osc1.fine', 'osc1.detune']
      }
    }
  },

  {
    id: 'low-partials-quiet',
    category: 'timbre',
    reads: ['harmonics.deltaDb[1..3]'],
    paramIds: ['osc1.morph', 'osc1.wavetable', 'dist.drive'],
    scale: 12,
    weight: 0.12,
    minError: 2,
    errorUnit: 'dB',
    evaluate({ diff }) {
      const h = diff.harmonics
      if (!h) return null
      const m = partialMean(h.deltaDb, 1, 3)
      if (m === null) return null
      const span = partialSpan(h.deltaDb, 1, 3)
      const quiet = m < 0
      const range = span && span.hi - span.lo > 1
        ? `${n1(span.lo)}-${n1(span.hi)} dB`
        : `${n1(Math.abs(m))} dB`
      return {
        error: m,
        finding: `Partials 2-4 are ${range} ${quiet ? 'quiet' : 'loud'} against the reference (mean ${n1(m)} dB). The low-order harmonic balance is a wavetable choice: try a different table or move the morph, and use dist.drive only to add what the table cannot.`,
        // Which way morph goes depends entirely on the loaded table.
        direction: 'either',
        confidence: 'medium'
      }
    }
  },

  {
    id: 'spectral-tilt',
    category: 'timbre',
    reads: ['harmonics.tiltDeltaDbPerOctave'],
    paramIds: ['osc1.morph', 'osc1.wavetable', 'dist.drive'],
    scale: 8,
    weight: 0.1,
    minError: 1.5,
    errorUnit: 'dB/octave',
    evaluate({ diff, patch }) {
      const h = diff.harmonics
      if (!h) return null
      const tilt = h.tiltDeltaDbPerOctave
      if (!Number.isFinite(tilt)) return null
      const darker = tilt < 0
      return {
        error: tilt,
        finding: `Spectral tilt is ${n1(Math.abs(tilt))} dB/octave ${darker ? 'steeper' : 'shallower'} than the reference, so the candidate's partial series is ${darker ? 'duller' : 'brighter'} overall. ${darker ? 'Add' : 'Remove'} harmonic content at the source.`,
        direction: darker ? 'increase' : 'decrease',
        confidence: 'medium',
        // Coarse: 0.05 of drive per dB/octave of tilt error. Drive is the only
        // monotone harmonic-content knob here; morph is table-dependent.
        suggested: suggest(patch, 'dist.drive', from => from - tilt * 0.05)
      }
    }
  },

  {
    id: 'filter-cutoff-static',
    category: 'timbre',
    reads: ['brightness[].octaveDelta', 'bands', 'harmonics.deltaDb[6..11]'],
    paramIds: ['filter1.cutoff', 'filter1.enabled'],
    scale: 2,
    weight: 0.18,
    minError: 0.2,
    errorUnit: 'octaves',
    evaluate({ diff, patch }) {
      const windows = diff.brightness
      if (windows.length < 2) return null
      const deltas = windows.map(w => w.octaveDelta)
      if (!deltas.every(Number.isFinite)) return null
      const m = mean(deltas)
      const spread = Math.max(...deltas) - Math.min(...deltas)
      const sameSign = deltas.every(d => d > 0) || deltas.every(d => d < 0)
      // "Dark throughout": every window off by a SIMILAR amount. A trend that
      // grows across windows is the envelope's business, not the cutoff's.
      if (!sameSign || spread > 0.5 * Math.abs(m)) return null
      const dark = m < 0
      const upper = bandMean(diff.bands, 4000)
      const highPartials = diff.harmonics ? partialMean(diff.harmonics.deltaDb, 6, 11) : null
      const corroborated =
        (upper !== null && Math.abs(upper) >= 3 && Math.sign(upper) === Math.sign(m)) ||
        (highPartials !== null && Math.abs(highPartials) >= 3 && Math.sign(highPartials) === Math.sign(m))
      const extra = [
        upper !== null ? `bands >=4 kHz ${n1(upper)} dB` : null,
        highPartials !== null ? `partials 7-12 ${n1(highPartials)} dB` : null
      ].filter(Boolean).join(', ')
      return {
        error: m,
        finding: `Brightness is ${dark ? 'down' : 'up'} ${n1(Math.abs(m))} octaves in every one of the ${windows.length} analysis windows (spread only ${n1(spread)} octaves), so this is a STATIC cutoff offset, not an envelope shape${extra ? ` (${extra})` : ''}.`,
        direction: dark ? 'increase' : 'decrease',
        // Centroid octaves to cutoff octaves is about as direct as this gets,
        // but only once the windows agree that nothing is moving over time.
        confidence: corroborated ? 'high' : 'medium',
        suggested: suggest(patch, 'filter1.cutoff', from => from * 2 ** -m)
      }
    }
  },

  {
    id: 'filter-envelope-depth',
    category: 'envelope',
    reads: ['brightness[].octaveDelta'],
    // The real knob is the env -> filter1.cutoff mod slot depth, which has no
    // PARAMS id. These are the envelope parameters that shape the same sweep.
    paramIds: ['env2.decay', 'env2.sustain', 'filter1.cutoff'],
    scale: 2,
    weight: 0.15,
    minError: 0.3,
    errorUnit: 'octaves',
    evaluate({ diff, patch }) {
      const windows = diff.brightness
      if (windows.length < 2) return null
      const first = windows[0].octaveDelta
      const last = windows[windows.length - 1].octaveDelta
      if (!Number.isFinite(first) || !Number.isFinite(last)) return null
      const trend = last - first
      const tooFast = trend < 0
      return {
        error: trend,
        finding: `Brightness error drifts ${n1(Math.abs(trend))} octaves across the buffer (${n1(first)} in the first window, ${n1(last)} in the last), so the candidate ${tooFast ? 'darkens too fast' : 'holds its brightness too long'}. This is envelope shape, not static cutoff: ${tooFast ? 'lengthen env2.decay / raise env2.sustain, or reduce' : 'shorten env2.decay / lower env2.sustain, or increase'} the depth of the env2 -> filter1.cutoff mod slot (set_modulation).`,
        direction: tooFast ? 'increase' : 'decrease',
        // The env -> cutoff route may not even exist in the patch, and the
        // trend can also come from an amplitude decay that reweights windows.
        confidence: 'medium',
        // Coarse multiplicative step, not a fit: 1.5x per firing, re-measured
        // on the next iteration.
        suggested: suggest(patch, 'env2.decay', from => (tooFast ? from * 1.5 : from / 1.5))
      }
    }
  },

  {
    id: 'upper-bands-quiet',
    category: 'timbre',
    reads: ['bands'],
    paramIds: ['filter1.cutoff', 'eq.high_gain', 'eq.enabled'],
    scale: 12,
    weight: 0.1,
    minError: 3,
    errorUnit: 'dB',
    evaluate({ diff, patch }) {
      // Only the fallback when per-window brightness is unusable; otherwise
      // `filter-cutoff-static` owns this territory with better evidence.
      if (diff.brightness.length >= 2) return null
      const upper = bandMean(diff.bands, 4000)
      if (upper === null) return null
      const quiet = upper < 0
      return {
        error: upper,
        finding: `Octave bands at and above 4 kHz are ${n1(Math.abs(upper))} dB ${quiet ? 'quiet' : 'loud'} against the reference, with no usable per-window brightness to say whether that is static or swept.`,
        direction: quiet ? 'increase' : 'decrease',
        confidence: 'medium',
        suggested: suggest(patch, 'eq.high_gain', from => from - upper)
      }
    }
  },

  {
    id: 'odd-even-balance',
    category: 'timbre',
    reads: ['harmonics.oddEvenDeltaDb'],
    paramIds: ['osc1.morph', 'osc1.wavetable'],
    scale: 12,
    weight: 0.1,
    minError: 2,
    errorUnit: 'dB',
    evaluate({ diff }) {
      const h = diff.harmonics
      if (!h) return null
      const d = h.oddEvenDeltaDb
      if (!Number.isFinite(d)) return null
      const oddHeavy = d > 0
      return {
        error: d,
        finding: `Odd partials sit ${n1(Math.abs(d))} dB ${oddHeavy ? 'above' : 'below'} even ones relative to the reference, so the candidate reads ${oddHeavy ? 'more square/pulse-like than it should' : 'more saw-like than it should'}. Change wavetable or morph position; ${oddHeavy ? 'a full-spectrum table (Basic Shapes saw region, Harmonic Sweep) restores the even partials' : 'a pulse/square region (Basic Shapes, PWM) restores the odd emphasis'}.`,
        direction: 'either',
        confidence: 'medium'
      }
    }
  },

  {
    id: 'inharmonicity',
    category: 'timbre',
    reads: ['harmonics.inharmonicityDelta'],
    paramIds: ['osc1.unison', 'osc1.detune', 'osc1.spread'],
    scale: 2e-3,
    weight: 0.07,
    minError: 1e-4,
    errorUnit: 'B (stretch coefficient)',
    evaluate({ diff, patch }) {
      const h = diff.harmonics
      if (!h) return null
      const d = h.inharmonicityDelta
      if (!Number.isFinite(d)) return null
      const unison = patchRaw(patch, 'osc1.unison')
      const detuned = unison !== undefined && unison > 1
      const moreStretched = d > 0
      return {
        error: d,
        finding: `Partial series is ${moreStretched ? 'more' : 'less'} stretched than the reference (B delta ${d.toExponential(1)}). Two causes read alike here: unison detune smearing each partial into a band, and a genuinely inharmonic series. ${detuned ? `osc1.unison is ${unison}, so ${moreStretched ? 'narrow osc1.detune/osc1.spread first' : 'widen osc1.detune/osc1.spread first'} and re-measure` : 'osc1 is not in unison, so detune cannot explain it; this synth has no partial-stretch control, and the closest lever is a different wavetable'}.`,
        direction: moreStretched ? 'decrease' : 'increase',
        // The measurement cannot separate the two causes. Never above medium.
        confidence: detuned ? 'medium' : 'low',
        // Coarse bisection on detune, only when unison could plausibly be the cause.
        suggested: detuned
          ? suggest(patch, 'osc1.detune', from => (moreStretched ? from * 0.5 : Math.max(from * 2, 4)))
          : undefined,
        paramIds: detuned ? ['osc1.detune', 'osc1.spread', 'osc1.unison'] : ['osc1.unison', 'osc1.detune', 'osc1.spread']
      }
    }
  },

  {
    id: 'attack-time',
    category: 'envelope',
    reads: ['envelope.attackMsDelta'],
    paramIds: ['env1.attack'],
    scale: 200,
    weight: 0.12,
    minError: 5,
    errorUnit: 'ms',
    evaluate({ diff, patch }) {
      const d = diff.envelope.attackMsDelta
      if (!Number.isFinite(d)) return null
      const tooFast = d < 0
      return {
        error: d,
        finding: `Attack is ${n1(Math.abs(d))} ms too ${tooFast ? 'fast' : 'slow'}. env1 is the VCA, so this is its attack directly.`,
        direction: tooFast ? 'increase' : 'decrease',
        // Measured attack time to env1.attack is one-to-one by definition.
        confidence: 'high',
        // env1.attack is in SECONDS (min 0.001, max 10); the delta is in ms.
        suggested: suggest(patch, 'env1.attack', from => from - d / 1000)
      }
    }
  },

  {
    id: 'decay-t60',
    category: 'envelope',
    reads: ['envelope.decayT60MsDelta'],
    paramIds: ['env1.decay', 'env1.release'],
    scale: 1500,
    weight: 0.13,
    minError: 20,
    errorUnit: 'ms',
    evaluate({ diff, patch }) {
      const d = diff.envelope.decayT60MsDelta
      if (d === null || !Number.isFinite(d)) return null
      const tooShort = d < 0
      return {
        error: d,
        finding: `-60 dB decay time is ${n1(Math.abs(d))} ms too ${tooShort ? 'short' : 'long'}. Move env1.decay first; if the note is held past the decay stage, env1.release carries the tail instead.`,
        direction: tooShort ? 'increase' : 'decrease',
        // T60 is shared between decay, sustain level and release, so applying
        // the whole delta to decay is an upper bound rather than a fit.
        confidence: 'medium',
        // env1.decay is in SECONDS; the delta is in ms.
        suggested: suggest(patch, 'env1.decay', from => from - d / 1000)
      }
    }
  },

  {
    id: 'sustain-level',
    category: 'envelope',
    reads: ['envelope.sustainDbDelta'],
    paramIds: ['env1.sustain'],
    scale: 24,
    weight: 0.1,
    minError: 1.5,
    errorUnit: 'dB',
    evaluate({ diff, patch }) {
      const d = diff.envelope.sustainDbDelta
      if (!Number.isFinite(d)) return null
      const tooLow = d < 0
      return {
        error: d,
        finding: `Sustain level is ${n1(Math.abs(d))} dB too ${tooLow ? 'low' : 'high'} relative to the peak.`,
        direction: tooLow ? 'increase' : 'decrease',
        // sustainDb is sampled at 80% of the buffer, so a long decay still
        // colours it; the link is direct but not clean.
        confidence: 'medium',
        // env1.sustain is a LINEAR 0..1 level; convert the dB delta to a ratio.
        suggested: suggest(patch, 'env1.sustain', from => from * 10 ** (-d / 20))
      }
    }
  },

  {
    id: 'noise-content',
    category: 'timbre',
    reads: ['flatnessDelta'],
    paramIds: ['noise.level', 'noise.enabled', 'noise.type'],
    scale: 0.5,
    weight: 0.08,
    minError: 0.05,
    errorUnit: 'flatness (0..1)',
    evaluate({ diff, patch }) {
      const d = diff.flatnessDelta
      if (!Number.isFinite(d)) return null
      const tooNoisy = d > 0
      const noiseOn = (patchRaw(patch, 'noise.enabled') ?? 0) >= 0.5
      const level = patchRaw(patch, 'noise.level')
      const aside = tooNoisy
        ? noiseOn
          ? ''
          : ' noise.enabled is off, so the noise floor comes from something else - check dist.drive, dist.type Bitcrush, and filter1.resonance self-noise.'
        : noiseOn
          ? ' Also try a different noise.type: Pink sits under a tone where White sits on top of it.'
          : ' Turn noise.enabled on first; noise.level does nothing while it is off.'
      return {
        error: d,
        finding: `Spectral flatness is ${d.toFixed(3)} ${tooNoisy ? 'higher' : 'lower'} than the reference (0 tonal, 1 noise), so the candidate is too ${tooNoisy ? 'noisy' : 'clean'}.${aside}`,
        direction: tooNoisy ? 'decrease' : 'increase',
        // Flatness lumps together the noise generator, distortion and any
        // inharmonic partials. Directionally right, quantitatively crude.
        confidence: 'low',
        // 1:1 flatness-to-level is a placeholder mapping, not a calibration.
        suggested: level === undefined ? undefined : suggest(patch, 'noise.level', from => from - d),
        paramIds: tooNoisy ? ['noise.level', 'noise.enabled'] : ['noise.level', 'noise.enabled', 'noise.type']
      }
    }
  },

  {
    id: 'stereo-width',
    category: 'space',
    reads: ['stereoWidthDelta'],
    paramIds: ['osc1.unison', 'osc1.detune', 'osc1.spread', 'chorus.mix', 'reverb.width'],
    scale: 0.6,
    weight: 0.08,
    minError: 0.05,
    errorUnit: 'width (0..1)',
    evaluate({ diff, patch }) {
      const d = diff.stereoWidthDelta
      if (!Number.isFinite(d)) return null
      const tooNarrow = d < 0
      return {
        error: d,
        finding: `Stereo width is ${d.toFixed(3)} ${tooNarrow ? 'narrower' : 'wider'} than the reference (0 is mono). ${tooNarrow ? 'Widen at the source first - osc1.unison above 1 with osc1.detune and osc1.spread - before reaching for chorus.mix or reverb.width, which also change the timbre' : 'Narrow osc1.spread and osc1.detune first; pulling chorus.mix or reverb.width down also removes body'}.`,
        direction: tooNarrow ? 'increase' : 'decrease',
        confidence: 'medium',
        suggested: suggest(patch, 'osc1.spread', from => from - d)
      }
    }
  },

  {
    id: 'loudness',
    category: 'level',
    reads: ['loudnessDbDelta'],
    paramIds: ['master.volume'],
    scale: 12,
    weight: 0.1,
    minError: 0.75,
    errorUnit: 'dB',
    evaluate({ diff, patch }) {
      const d = diff.loudnessDbDelta
      if (!Number.isFinite(d)) return null
      const quiet = d < 0
      const from = patchRaw(patch, 'master.volume')
      const def = PARAM_BY_ID.get('master.volume')
      // One gain, used by both the clip note and the suggestion. Spelling the
      // formula out twice is how the finding and the value drift apart.
      const gain = 10 ** (-d / 20)
      const wanted = from === undefined ? undefined : from * gain
      const clipNote = wanted !== undefined && def !== undefined && (wanted > def.max || wanted < def.min)
        ? ` master.volume cannot travel that far (range ${def.min}..${def.max}); take the rest from oscillator levels or comp.makeup.`
        : ''
      return {
        error: d,
        finding: `Gated loudness is ${n1(Math.abs(d))} dB ${quiet ? 'below' : 'above'} the reference.${clipNote}`,
        direction: quiet ? 'increase' : 'decrease',
        // A gain change moves gated loudness by exactly that gain (R128's
        // relative gate), so this one really is one-to-one.
        confidence: 'high',
        suggested: suggest(patch, 'master.volume', v => v * gain)
      }
    }
  }
]

// ------------------------------------------------------------------ driver

/** Every id in every rule must exist in `PARAMS`. Throws on the first that does not. */
export function assertRuleParamsExist(rules: readonly AdviceRule[] = ADVICE_RULES): void {
  const missing: string[] = []
  for (const rule of rules) {
    for (const id of rule.paramIds) if (!PARAM_BY_ID.has(id)) missing.push(`${rule.id}: ${id}`)
  }
  if (missing.length > 0) throw new Error(`match-advice references unknown params -> ${missing.join(', ')}`)
}

// Fail loudly at module load. An invented param id is the failure mode this
// whole table exists to prevent, and a dozen map lookups cost nothing, so this
// runs in every build rather than behind a dev flag.
assertRuleParamsExist()

/**
 * Turn a measured diff into ranked parameter moves.
 *
 * Returns `[]` when nothing crosses its rule's `minError` - an empty list means
 * "no dimension is measurably wrong", and is more useful than five padded
 * actions about noise-floor differences.
 */
export function adviseFromDiff(
  diff: MatchDiff,
  currentPatch: PatchValues,
  options?: AdviseOptions
): MatchAction[] {
  const maxActions = Math.max(0, Math.trunc(options?.maxActions ?? 5))
  if (maxActions === 0) return []
  const focus = options?.focus
  const ctx: AdviceContext = { diff, patch: currentPatch ?? {} }

  const actions: MatchAction[] = []
  for (const rule of ADVICE_RULES) {
    if (focus && rule.category !== focus) continue
    let outcome: RuleOutcome | null
    try {
      outcome = rule.evaluate(ctx)
    } catch {
      // A malformed diff must not take the whole advisor down.
      continue
    }
    if (!outcome) continue
    const magnitude = Math.abs(outcome.error)
    if (!Number.isFinite(magnitude) || magnitude < rule.minError) continue
    actions.push({
      finding: outcome.finding,
      paramIds: [...(outcome.paramIds ?? rule.paramIds)],
      direction: outcome.direction,
      ...(outcome.suggested ? { suggested: outcome.suggested } : {}),
      estimatedGain: round(rule.weight * Math.min(1, magnitude / rule.scale), 4),
      confidence: outcome.confidence
    })
  }

  // Array.prototype.sort is stable, so equal gains keep table order.
  actions.sort((a, b) => b.estimatedGain - a.estimatedGain)
  return actions.slice(0, maxActions)
}
