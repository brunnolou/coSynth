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
 * A rule may answer with SEVERAL outcomes. `MatchAction.suggested` carries one
 * `{id, from, to, unit}`, so a correction that needs two parameters to land —
 * a pitch move split across `osc1.transpose` and `osc1.fine` — is emitted as
 * two actions rather than as one action that applies half of what its finding
 * describes. An agent that applies every `suggested` it is given must arrive
 * where the finding says it will; anything less is an iteration that can fail
 * to converge.
 *
 * ## The no-op rule, and why it is the same bug as a bad step size
 *
 * Half this synth's parameters are INERT until something else is switched on.
 * `worklet/voice.ts` skips the whole noise branch when `noise.enabled < 0.5`,
 * skips a filter when `filterN.enabled < 0.5`, skips the distortion section when
 * `dist.enabled < 0.5`, and collapses `osc1.detune`/`osc1.spread` to zero when
 * `osc1.unison === 1` (`off` is hardcoded to 0 for a single voice);
 * `worklet/processor.ts` skips the EQ when `eq.enabled < 0.5`. A rule that
 * suggests `noise.level` while noise is bypassed has proposed a move that
 * changes NOTHING, so the next comparison measures exactly the same error and
 * proposes exactly the same move — the `pitch-error` live-lock again, wearing a
 * different costume.
 *
 * Two ways out, and which one is right depends on the sign of the error:
 *
 * - When engaging the section is what the correction actually wants, the rule
 *   emits the switch as its OWN outcome, pushed first so the stable sort keeps
 *   it ahead of the move it unblocks.
 * - When engaging it cannot deliver the correction — a bypassed distortion is
 *   not the source of harmonic content you want LESS of, a bypassed lowpass is
 *   not why the candidate is too dark — the rule emits NO `suggested` at all and
 *   says in prose where the error really comes from. A finding with no move is
 *   honest; a move that does nothing is not.
 *
 * Which of the two applies is a question about the SIGN of the error and the
 * section TOGETHER, never about either on its own. A bypassed highpass is the
 * right switch for a candidate that is too dark and the wrong one for a
 * candidate that is too bright, so a guard that tests brightness and filter
 * type independently gets one of those two cases backwards — it did, and
 * `filter-cutoff-static` now asks the single conditional question instead.
 * Where engaging cannot be RELIED ON to deliver what is asked — a bandpass or a
 * notch, whose direction depends on a cutoff position no `MatchDiff` carries —
 * the rule states the situation and moves nothing.
 *
 * `switchState` is deliberately tri-state: `adviseFromDiff(diff, {})` is a
 * supported call, and "I could not read that switch" must never be reported as
 * "that section is bypassed".
 *
 * One consequence is easy to miss. While a section is bypassed its parameter
 * contributed NOTHING to the render that was just measured, so the correction
 * has to be computed from an effective value of ZERO, not from the value the
 * knob happens to be resting at. `noise.level` sitting at 0.8 behind a bypassed
 * switch put no noise in the buffer, so "raise it by the missing flatness" would
 * ask for 0.8 plus the whole error and land at nearly double the target. The
 * gated rules therefore suggest the value that produces the wanted contribution
 * outright. (`filter-cutoff-static` is the exception: a filter ATTENUATES rather
 * than adds, so there is no zero-frame formula for it, and its bypassed branch
 * says in prose that its cutoff is a starting point.)
 *
 * ## Probe steps versus computed corrections
 *
 * Some rules can compute their correction exactly (`pitch-error`, `loudness`,
 * `attack-time`). Others cannot, because the parameter reaches the measurement
 * through something this module cannot see: `env2.decay` only changes a
 * brightness trajectory if an `env2 -> filter1.cutoff` mod slot exists, and mod
 * slots carry no `PARAMS` id and are absent from `PatchValues` entirely.
 *
 * Those rules emit a PROBE, and say so. A probe is multiplicative and DAMPED —
 * `dampedFactor` scales it by how large the error is relative to the rule's own
 * `scale` — so it shrinks as the target is approached. A FIXED multiplicative
 * step is the live-lock in its purest form: `osc1.detune` moved by 0.5x and 2x
 * on alternate rounds is a period-2 cycle, `12 -> 6 -> 12 -> 6`, that never
 * terminates however many iterations you spend. Damping does not make the step
 * correct; it makes the sequence contract instead of ring. The findings say
 * "probe", the confidence stays below `high`, and neither claims a fit.
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

/**
 * What a rule returns when it fires. The driver turns this into a `MatchAction`.
 *
 * A rule may return SEVERAL of these when one correction needs more than one
 * parameter to land — see `pitch-error`, where the semitone half and the cents
 * half of the same move are two outcomes. `MatchAction.suggested` is a single
 * `{id, from, to, unit}` and `match-types.ts` is a shared contract, so two moves
 * are two actions rather than a widened field.
 */
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
  /**
   * One outcome, or several when a single correction needs several parameters
   * to land. Outcomes carrying the same `error` get the same `estimatedGain`,
   * and the driver's sort is stable, so they stay adjacent in the ranked list.
   */
  evaluate(ctx: AdviceContext): RuleOutcome | RuleOutcome[] | null
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

/**
 * Round half TOWARD zero. Mirror-symmetric the same way
 * `roundTiesAwayFromZero` is (`|f(-x)| === |f(x)|`), and it is the tie-break
 * the SEMITONE split needs: at exactly half a semitone a transpose move and a
 * fine move are equally valid, `osc1.fine` reaches +-100 cents so it can take
 * the whole 50 on its own, and taking it there leaves nothing over. Rounding
 * the other way is what made 50 cents a live-lock — see `pitchCorrection`.
 */
function roundTiesTowardZero(v: number): number {
  return Math.sign(v) * Math.ceil(Math.abs(v) - 0.5) + 0
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

/** Below this the fine move is inaudible and is neither named nor emitted. */
const MIN_FINE_CENTS = 0.5

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
 * - Outside it, the nearest semitone, rounded half TOWARD zero so +X and -X are
 *   corrected by equal and opposite amounts AND exactly half a semitone stays
 *   off `osc1.transpose`. `osc1.fine` spans +-100 cents, a whole semitone in
 *   each direction, so it can absorb any 50 on its own. Rounding 50 the other
 *   way was a LIVE-LOCK, not an inaccuracy: a +50 error became a -1 semitone
 *   move, applying it left -50, the next comparison proposed +1, and the loop
 *   never settled. `compare_audio` auto-renders at the reference's nearest MIDI
 *   note, so every quarter-tone reference landed exactly there.
 *
 * `residualCents` is always what is left over, so `semitones * 100 +
 * residualCents === -cents` exactly, for every input. `|residualCents|` is
 * therefore at most 50 outside the octave band and at most 60 inside it, which
 * is what makes the correction terminate even when only its semitone half is
 * applied: the leftover is by construction small enough for the next round to
 * finish on `osc1.fine` alone.
 */
function pitchCorrection(cents: number): PitchCorrection {
  const nearestOctave = roundTiesAwayFromZero(cents / OCTAVE_CENTS)
  const isOctave = nearestOctave !== 0 && Math.abs(cents - nearestOctave * OCTAVE_CENTS) <= OCTAVE_TOLERANCE_CENTS
  const octaves = isOctave ? -nearestOctave : 0
  const semitones = isOctave ? octaves * OCTAVE_SEMITONES : -roundTiesTowardZero(cents / SEMITONE_CENTS)
  return { semitones, residualCents: round(-cents - semitones * SEMITONE_CENTS), octaves }
}

/**
 * Move whole semitones from `osc1.fine` onto `osc1.transpose` until the fine
 * target is a value `osc1.fine` can actually hold.
 *
 * `pitchCorrection` splits the error against a fine knob assumed to be at rest.
 * The real one is somewhere in -100..100 already, and `legalValue` would CLAMP a
 * target outside that — silently applying part of the move. That is its own dead
 * end: fine pinned at 100 with 30 cents still wanted suggests 100 -> 100, which
 * `suggest` drops as no move at all, and the advice then has nothing left to
 * say while the pitch is still wrong. Borrowing a semitone costs nothing (100
 * cents of transpose IS 100 cents of fine) and re-centres fine near zero, so
 * the next correction has headroom in both directions.
 *
 * The invariant survives: only whole hundreds move between the two fields, so
 * `semitones * 100 + residualCents === -cents` still holds exactly, and the
 * prose stays phrased from the same numbers that get applied.
 */
function fitToFineRange(plan: PitchCorrection, currentFine: number | undefined): PitchCorrection {
  const def = PARAM_BY_ID.get('osc1.fine')
  if (!def || currentFine === undefined) return plan
  const wanted = currentFine + plan.residualCents
  if (wanted >= def.min && wanted <= def.max) return plan
  const borrowed = roundTiesAwayFromZero(wanted / SEMITONE_CENTS)
  return {
    ...plan,
    semitones: plan.semitones + borrowed,
    residualCents: round(plan.residualCents - borrowed * SEMITONE_CENTS)
  }
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

// -------------------------------------------------------- bypass switches

/**
 * A bypass switch reads ON at or above this.
 *
 * Not a convention invented here: `params.ts` declares every `*.enabled` as a
 * plain `min 0, max 1, step 1` NUMBER (never a choice), and both
 * `worklet/voice.ts` and `worklet/processor.ts` gate on `>= 0.5`. Same constant,
 * same meaning, so a suggestion of `1` is a switch the DSP will honour.
 */
const SWITCH_ON = 0.5

/**
 * Tri-state on purpose.
 *
 * `patchRaw` returns `undefined` both for a parameter the patch does not carry
 * and for one it carries unreadably, and `?? 0` collapses that into the
 * confident claim "that section is bypassed". `adviseFromDiff(diff, {})` is a
 * supported call — `currentPatchValues` returns `{}` whenever the engine cannot
 * be read — so that collapse had the advisor telling agents to switch on
 * sections it had never looked at.
 */
type SwitchState = 'on' | 'off' | 'unknown'

function switchState(patch: PatchValues, id: string): SwitchState {
  const v = patchRaw(patch, id)
  if (v === undefined) return 'unknown'
  return v >= SWITCH_ON ? 'on' : 'off'
}

/**
 * The move that flips a bypass switch on, or `undefined` when it already is on
 * or the patch does not carry it. `suggest` does the whole job — `legalValue`
 * quantizes to the 0/1 step and it drops a move that changes nothing.
 */
function enableMove(patch: PatchValues, id: string): MatchAction['suggested'] {
  return suggest(patch, id, () => 1)
}

/**
 * The `dist.type` index whose branch in `worklet/voice.ts` never reads
 * `dist.drive`. Resolved from the parameter's own `choices` rather than written
 * as a literal, so reordering `DIST_TYPES` cannot silently point this at
 * Wavefold; `-1` when the label is gone, which matches no index and so makes
 * `isBitcrush` answer `false` rather than guess.
 */
const BITCRUSH_DIST_TYPE = PARAM_BY_ID.get('dist.type')?.choices?.indexOf('Bitcrush') ?? -1

/**
 * Is `dist.type` the one setting under which `dist.drive` reaches nothing?
 *
 * Same shape of trap as a bypass switch, one level deeper: the section can be
 * fully enabled and the knob still be arithmetically absent from the render,
 * because the branch that runs never reads it. Unknown reads `false` — the
 * tri-state discipline again, "I could not read that choice" is not "it is
 * Bitcrush".
 */
function isBitcrush(patch: PatchValues): boolean {
  const t = patchRaw(patch, 'dist.type')
  return t !== undefined && Math.round(t) === BITCRUSH_DIST_TYPE
}

/**
 * A multiplicative probe factor that SHRINKS with the error.
 *
 * Returns `1` at zero error and `1 + maxExtra` once `|error|` reaches `scale`,
 * the same point where `estimatedGain` saturates. Used where the parameter's
 * effect on the measurement cannot honestly be inverted, so the step is a guess:
 * a guess that contracts as the error contracts still terminates, while a fixed
 * factor and its reciprocal ring forever around the target.
 *
 * It does NOT make the step correct, and no caller should present it as one.
 */
function dampedFactor(error: number, scale: number, maxExtra: number): number {
  const t = Math.min(1, Math.abs(error) / scale)
  return 1 + maxExtra * (Number.isFinite(t) ? t : 1)
}

/** Error magnitude, in octaves of brightness drift, at which `filter-envelope-depth` saturates. */
const BRIGHTNESS_TREND_SCALE = 2

/** Error magnitude, in stretch coefficient B, at which `inharmonicity` saturates. */
const INHARMONICITY_SCALE = 2e-3

/**
 * `osc1.detune` and `osc1.spread` are multiplied by a per-voice offset that
 * `voice.ts` hardcodes to 0 when `unison === 1`, so both are exactly inert on a
 * single voice. Two voices is the smallest unison that spreads at all; three
 * keeps a centre voice, which is why it is the probe's starting point.
 */
const MIN_SPREADING_UNISON = 3

/** Where the detune probe starts when `osc1.detune` sits at zero and a ratio has no purchase. */
const MIN_DETUNE_PROBE_CENTS = 4

/**
 * Which way ENGAGING a bypassed filter moves the spectral centroid, per
 * `FILTER_TYPES` index, plus the one clause that says why.
 *
 * `shift` is `1` for up, `-1` for down, and `null` where the answer depends on
 * where the cutoff sits and this module cannot find out. `null` is a VERDICT,
 * not a gap: `MatchDiff.brightness` carries `octaveDelta`, a signed error
 * against the reference, and never an absolute centroid, so "is the cutoff
 * above or below the spectrum this filter would act on" is a question the
 * contract this module reads cannot answer. Guessing it is exactly the
 * confidently wrong move the bypass branch exists to withhold.
 *
 * Read off `worklet/dsp.ts` (`VoiceFilter.process`), which maps indices 0-1 to
 * the SVF lowpass mode, 2-3 to highpass, 4-5 to bandpass, 6 to notch, 7 to a
 * feedback comb and 8 to a three-band formant bank.
 *
 * A missing entry - an out-of-range index, or a type appended to `params.ts`
 * and not classified here - reads as `undefined`, which is neither `1` nor
 * `-1`, so an unclassified filter fails SAFE: the caller withholds.
 */
const FILTER_CENTROID_EFFECT: readonly { shift: 1 | -1 | null; why: string }[] = [
  { shift: -1, why: 'a lowpass only ever takes highs away, so it can only pull the centroid DOWN' },
  { shift: -1, why: 'a lowpass only ever takes highs away, so it can only pull the centroid DOWN' },
  { shift: 1, why: 'a highpass only ever takes lows away, so it can only push the centroid UP' },
  { shift: 1, why: 'a highpass only ever takes lows away, so it can only push the centroid UP' },
  { shift: null, why: 'a bandpass removes energy on BOTH sides of its cutoff, so it drags the centroid towards that cutoff - up from below it, down from above it - and this diff carries a brightness DELTA rather than an absolute centroid, so which side the cutoff falls on is not knowable from here' },
  { shift: null, why: 'a bandpass removes energy on BOTH sides of its cutoff, so it drags the centroid towards that cutoff - up from below it, down from above it - and this diff carries a brightness DELTA rather than an absolute centroid, so which side the cutoff falls on is not knowable from here' },
  { shift: null, why: 'a notch removes a band around its cutoff, so the centroid moves whichever way that band was weighted, and a brightness DELTA says nothing about where the band lands - not knowable from here' },
  { shift: null, why: 'a feedback comb ADDS a resonant series rather than only attenuating, and its peaks and nulls follow the cutoff, so its net effect on the centroid is not knowable from here' },
  { shift: null, why: 'the formant bank replaces the spectrum with three vowel resonances placed by the cutoff, so whether that lands above or below the current centroid is not knowable from here' }
]

/**
 * What engaging `id`'s filter would do to the centroid, with the label to call
 * it by, or `undefined` when the patch does not carry the type.
 *
 * Tri-state for the same reason `switchState` is: "I could not read that
 * choice" must never be reported as a filter type, and it must never be
 * treated as one either.
 */
function filterCentroidEffect(
  patch: PatchValues,
  id: string
): { label: string; shift: 1 | -1 | null; why: string } | undefined {
  const raw = patchRaw(patch, id)
  if (raw === undefined) return undefined
  const index = Math.round(raw)
  const effect = FILTER_CENTROID_EFFECT[index]
  const label = PARAM_BY_ID.get(id)?.choices?.[index] ?? `type ${index}`
  if (!effect) return { label, shift: null, why: `${label} is a filter type this advisor has never classified, so which way engaging it moves the centroid is not knowable from here` }
  return { label, ...effect }
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
      // A silent osc1 makes BOTH of this rule's knobs inert — `voice.ts` skips
      // the oscillator entirely on `enabled < 0.5` or `level <= 0.0001` — while
      // the pitch being measured comes from whatever is still sounding. Emitting
      // the transpose anyway is a no-op that the next comparison asks for again.
      // Turning osc1 back on is not the answer either: that adds a whole
      // oscillator nobody asked for. So this one states the problem and moves
      // nothing.
      const osc1Level = patchRaw(patch, 'osc1.level')
      const osc1Silent =
        switchState(patch, 'osc1.enabled') === 'off' || (osc1Level !== undefined && osc1Level <= 1e-4)
      if (osc1Silent) {
        const sharpNow = cents > 0
        return {
          error: cents,
          finding: `Candidate is ${n1(Math.abs(cents))} cents ${sharpNow ? 'sharp' : 'flat'}, but osc1 is ${osc1Level !== undefined && osc1Level <= 1e-4 ? 'at zero level' : 'switched off'}, so osc1.transpose and osc1.fine change nothing. The pitch you are measuring belongs to whatever else is sounding - the sub (sub.octave), osc2/osc3 (their own transpose/fine), or noise.pitch. Retune that, or switch osc1 back on before using this rule's parameters.`,
          direction: sharpNow ? 'decrease' : 'increase',
          confidence: 'low'
        }
      }
      // ONE computation, fitted once to the fine knob's real range. Everything
      // below — both sentences and both moves — is phrased from it.
      const ideal = pitchCorrection(cents)
      const currentFine = patchRaw(patch, 'osc1.fine')
      const { semitones, residualCents, octaves } = fitToFineRange(ideal, currentFine)
      // Before the fine-range fit, `semitones !== 0` is exactly `|cents| > 50`
      // under half-toward-zero rounding, so the old `Math.abs(cents) >= 50 &&
      // semitones !== 0` guard collapses to this — and stops sending the one
      // error size that cannot converge on a semitone move to osc1.transpose.
      // After the fit it can also be set by a fine knob out of headroom.
      const onTranspose = semitones !== 0
      const onFine = Math.abs(residualCents) >= MIN_FINE_CENTS
      const sharp = cents > 0
      // The whole error rarely lands on a semitone. Naming the leftover here is
      // what the second action APPLIES, so the sentence and the move agree.
      const fineNote = onFine ? `, then ${signedUnits(residualCents, 'cent')} on osc1.fine` : ''
      const hzNote = diff.pitch.referenceHz !== null && diff.pitch.candidateHz !== null
        ? ` (${n1(diff.pitch.candidateHz)} Hz against ${n1(diff.pitch.referenceHz)} Hz)`
        : ''
      // Only when the fine knob had to hand a semitone over; explains a
      // transpose move that the raw error size would not have asked for.
      const borrowNote = semitones !== ideal.semitones && currentFine !== undefined
        ? ` osc1.fine is at ${n1(currentFine)} ct and cannot reach that from there, so a semitone of the move rides on osc1.transpose.`
        : ''
      const finding = octaves !== 0
        // "Octave" is deliberate: a model acts on it far more reliably than on
        // "1200 cents sharp", which reads like any other detune.
        ? `Octave error: the candidate is ${Math.abs(octaves)} octave${Math.abs(octaves) === 1 ? '' : 's'} ${octaves < 0 ? 'above' : 'below'} the reference (${n1(cents)} cents). Transpose by ${signedUnits(semitones, 'semitone')}${fineNote}; do not chase the octave itself with fine tuning.${borrowNote}`
        : onTranspose
          ? `Candidate is ${n1(Math.abs(cents))} cents ${sharp ? 'sharp' : 'flat'}${hzNote}. Transpose by ${signedUnits(semitones, 'semitone')}${fineNote}.${borrowNote}`
          : `Candidate is ${n1(Math.abs(cents))} cents ${sharp ? 'sharp' : 'flat'}${hzNote}. Half a semitone or less, so this is osc1.fine (${signedUnits(residualCents, 'cent')}), not osc1.transpose.`

      // Two moves, two actions. `MatchAction.suggested` holds ONE move and
      // lives in the shared `match-types.ts`, so the alternative to a second
      // action is naming the leftover in prose and applying only half of it —
      // which is the bug this is fixing. Both outcomes carry the same `error`,
      // so they take the same `estimatedGain` and the stable sort keeps them
      // adjacent: an agent that applies every `suggested` it is handed lands on
      // the pitch in ONE round trip. If a `maxActions` cut ever separates them,
      // the transpose half alone leaves exactly `-residualCents` of error —
      // half a semitone or less, which the next round finishes on osc1.fine
      // alone. One extra iteration, never a loop. (After a borrow the leftover
      // is bigger than the error it replaced; it still lands on the next round,
      // because fine can reach the target once the semitone is in place.)
      const fineMove = onFine ? suggest(patch, 'osc1.fine', from => from + residualCents) : undefined
      const outcomes: RuleOutcome[] = []
      if (onTranspose) {
        outcomes.push({
          error: cents,
          finding,
          direction: semitones < 0 ? 'decrease' : 'increase',
          // Pitch to transpose is one-to-one and exact.
          confidence: 'high',
          suggested: suggest(patch, 'osc1.transpose', from => from + semitones),
          paramIds: ['osc1.transpose', 'osc1.fine']
        })
      }
      if (onFine && (!onTranspose || fineMove)) {
        outcomes.push({
          error: cents,
          finding: onTranspose
            ? `Second half of the same pitch move: ${signedUnits(residualCents, 'cent')} on osc1.fine. The ${signedUnits(semitones, 'semitone')} transpose on its own lands ${n1(Math.abs(residualCents))} cents ${residualCents < 0 ? 'sharp' : 'flat'}; apply both and the pitch is exact.`
            : finding,
          direction: residualCents < 0 ? 'decrease' : 'increase',
          // Sub-semitone errors can also come out of unison detune, so a fine
          // move on its own stays medium.
          confidence: 'medium',
          suggested: fineMove,
          paramIds: onTranspose ? ['osc1.fine', 'osc1.transpose'] : ['osc1.fine', 'osc1.detune']
        })
      }
      return outcomes.length > 0 ? outcomes : null
    }
  },

  {
    id: 'low-partials-quiet',
    category: 'timbre',
    reads: ['harmonics.deltaDb[1..3]'],
    paramIds: ['osc1.morph', 'osc1.wavetable', 'dist.drive', 'dist.enabled'],
    scale: 12,
    weight: 0.12,
    minError: 2,
    errorUnit: 'dB',
    evaluate({ diff, patch }) {
      const h = diff.harmonics
      if (!h) return null
      const m = partialMean(h.deltaDb, 1, 3)
      if (m === null) return null
      const span = partialSpan(h.deltaDb, 1, 3)
      const quiet = m < 0
      const range = span && span.hi - span.lo > 1
        ? `${n1(span.lo)}-${n1(span.hi)} dB`
        : `${n1(Math.abs(m))} dB`
      // This rule suggests nothing (the morph direction is table-dependent), so
      // a bypassed distortion cannot live-lock it. It can still send an agent
      // to a knob that does nothing, which is worth one clause.
      const distNote = switchState(patch, 'dist.enabled') === 'off'
        ? ' dist.enabled is off, so dist.drive is inert until that switch is on.'
        : ''
      return {
        error: m,
        finding: `Partials 2-4 are ${range} ${quiet ? 'quiet' : 'loud'} against the reference (mean ${n1(m)} dB). The low-order harmonic balance is a wavetable choice: try a different table or move the morph, and use dist.drive only to add what the table cannot.${distNote}`,
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
    paramIds: ['osc1.morph', 'osc1.wavetable', 'dist.drive', 'dist.enabled'],
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
      const headline = `Spectral tilt is ${n1(Math.abs(tilt))} dB/octave ${darker ? 'steeper' : 'shallower'} than the reference, so the candidate's partial series is ${darker ? 'duller' : 'brighter'} overall.`
      // Coarse: 0.05 of drive per dB/octave of tilt error. Drive is the only
      // monotone harmonic-content knob here; morph is table-dependent. Linear
      // in the error, so it contracts on its own once drive actually applies.
      const driveMove = suggest(patch, 'dist.drive', from => from - tilt * 0.05)
      const dist = switchState(patch, 'dist.enabled')

      // `dist.enabled` is not the only thing that can make `dist.drive` inert.
      // `voice.ts` branches on `dist.type` FIRST, and its bitcrush branch reads
      // `dist.bits`, `dist.downsample` and `dist.mix` and never touches the
      // drive gain at all — the `gain`/`comp` pair it computes is used only by
      // the clip/wavefold branch. So under Bitcrush this rule's one
      // quantitative move is the same guaranteed no-op the bypass produces,
      // in BOTH directions, and no amount of enabling the section fixes it.
      if (isBitcrush(patch)) {
        return {
          error: tilt,
          finding: `${headline} dist.type is Bitcrush, whose branch in voice.ts never reads dist.drive - that quantizer is driven by dist.bits and dist.downsample alone - so a drive move changes nothing here, whichever way it goes.${dist === 'off' ? ' The section is bypassed on top of that, so none of it reaches the render.' : ''} ${darker ? 'Fewer dist.bits (or more dist.downsample) adds quantization noise across the top' : 'More dist.bits (or less dist.downsample) takes quantization noise off the top'}, or take the tilt at the oscillator with osc1.wavetable / osc1.morph, or pick a dist.type whose drive does something.`,
          direction: darker ? 'increase' : 'decrease',
          confidence: 'medium',
          paramIds: ['osc1.morph', 'osc1.wavetable']
        }
      }

      // `dist.enabled` defaults to 0, so on a factory patch this rule's only
      // quantitative move was a guaranteed no-op: drive crept up round after
      // round while the tilt never budged.
      if (dist === 'off') {
        if (!darker) {
          // Nothing to take away. A bypassed distortion is not where the extra
          // harmonic content came from, and lowering an inert drive is the
          // no-op that never converges.
          return {
            error: tilt,
            finding: `${headline} dist.enabled is off, so dist.drive is inert and cannot be the source of the extra content - take it out at the oscillator (a darker osc1.wavetable region, or a lower osc1.morph).`,
            direction: 'decrease',
            confidence: 'medium',
            paramIds: ['osc1.morph', 'osc1.wavetable']
          }
        }
        const enable = enableMove(patch, 'dist.enabled')
        if (enable) {
          return [
            {
              error: tilt,
              finding: `${headline} The distortion section is bypassed (dist.enabled is 0), so dist.drive adds nothing until this switch is on - that is what this action is. Engaging it runs the voice through dist.type at its current setting, which already brightens the series on its own; the companion action then sets the drive.`,
              direction: 'increase',
              confidence: 'medium',
              suggested: enable,
              paramIds: ['dist.enabled', 'dist.drive']
            },
            {
              error: tilt,
              // From an effective ZERO, not from where the knob rests: a
              // bypassed drive put no harmonic content in the buffer, so
              // `from - tilt * 0.05` would charge the render for drive it never
              // heard and land at nearly double the amount.
              finding: `Second half of the same move: dist.drive to ${round(-tilt * 0.05, 3)}, which is the whole ${n1(Math.abs(tilt))} dB/octave measured from zero - the bypassed section contributed none of the drive it is currently showing. It does nothing until dist.enabled is on, so apply both or neither.`,
              direction: 'increase',
              confidence: 'medium',
              suggested: suggest(patch, 'dist.drive', () => -tilt * 0.05),
              paramIds: ['dist.drive', 'dist.enabled']
            }
          ]
        }
      }
      return {
        error: tilt,
        finding: `${headline} ${darker ? 'Add' : 'Remove'} harmonic content at the source.`,
        direction: darker ? 'increase' : 'decrease',
        confidence: 'medium',
        suggested: driveMove
      }
    }
  },

  {
    id: 'filter-cutoff-static',
    category: 'timbre',
    reads: ['brightness[].octaveDelta', 'bands', 'harmonics.deltaDb[6..11]'],
    paramIds: ['filter1.cutoff', 'filter1.enabled', 'filter1.type'],
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
      const headline = `Brightness is ${dark ? 'down' : 'up'} ${n1(Math.abs(m))} octaves in every one of the ${windows.length} analysis windows (spread only ${n1(spread)} octaves), so this is a STATIC cutoff offset, not an envelope shape${extra ? ` (${extra})` : ''}.`
      const cutoffMove = suggest(patch, 'filter1.cutoff', from => from * 2 ** -m)

      // `filter1.enabled` defaults to 1, so this is the uncommon patch — but
      // `voice.ts` skips the whole filter on `enabled < 0.5`, and then every
      // cutoff move this rule has ever suggested is a no-op it will suggest
      // again next round.
      if (switchState(patch, 'filter1.enabled') === 'off') {
        // ONE question, asked once: does engaging THIS filter type move the
        // centroid the way THIS error needs it moved?
        //
        // Asking the two halves independently — "is it too bright" OR "is it a
        // highpass" — is what made this wrong. Too bright counted as reason
        // enough on its own, so a bypassed HIGHPASS was offered to a too-bright
        // candidate; engaging that highpass takes lows away, pushes the centroid
        // further UP, and steers the patch away from the reference. The relation
        // is CONDITIONAL ON DIRECTION, so the guard has to be too:
        //
        // - too bright, centroid must come DOWN -> only a lowpass delivers it
        // - too dark, centroid must go UP       -> only a highpass delivers it
        //
        // Everything else — bandpass, notch, comb, formant, an unreadable type,
        // a type this table has not classified — moves the centroid a way that
        // depends on the cutoff, and `FILTER_CENTROID_EFFECT` explains why the
        // cutoff's position is not knowable from a `MatchDiff`. Those get the
        // finding with no move at all, which is what the bypassed-lowpass case
        // has always got.
        const wantedShift = dark ? 1 : -1
        const type = filterCentroidEffect(patch, 'filter1.type')
        const enable = type?.shift === wantedShift ? enableMove(patch, 'filter1.enabled') : undefined
        if (!enable) {
          // A lowpass in front of a dark candidate is the one case with a
          // sharper thing to say than "it depends": no filter of any kind adds
          // content the source never produced.
          const cannot = type === undefined
            ? 'filter1.type is not readable in this patch, so there is no telling which way engaging the filter would move the centroid'
            : `engaging filter1.type ${type.label} cannot deliver it: ${type.why}${type.shift === null ? '' : ', the opposite of what this error asks for'}`
          const elsewhere = dark
            ? 'A filter cannot add high content that is not there: the darkness is upstream, in osc1.wavetable / osc1.morph, or in dist.drive with dist.enabled on.'
            : 'Take the brightness out upstream instead, at osc1.wavetable / osc1.morph or at dist.drive.'
          return {
            error: m,
            finding: `${headline} filter1 is bypassed (filter1.enabled is 0), so filter1.cutoff is inert, and ${cannot}. ${elsewhere} If a filter is where you want to do this, set filter1.type to a ${dark ? 'highpass' : 'lowpass'} first and this rule will offer the switch.`,
            direction: dark ? 'increase' : 'decrease',
            confidence: 'low',
            paramIds: ['filter1.enabled', 'filter1.cutoff', 'filter1.type']
          }
        }
        return [
          {
            error: m,
            finding: `${headline} filter1 is bypassed (filter1.enabled is 0), so filter1.cutoff does nothing at all until this switch is on - that is what this action is. Engaging the filter at filter1.type changes more than the cutoff alone; the companion action sets the cutoff, so apply both and re-measure.`,
            direction: dark ? 'increase' : 'decrease',
            confidence: 'medium',
            suggested: enable,
            paramIds: ['filter1.enabled', 'filter1.cutoff', 'filter1.type']
          },
          {
            error: m,
            // No zero-frame formula here, unlike the other gated pairs: a filter
            // ATTENUATES rather than adds, so the brightness measured with it
            // bypassed is the source's, and engaging it at cutoff F does not
            // land at `source * 2 ** -m`. A starting point, and it says so.
            finding: `Second half of the same move: filter1.cutoff ${dark ? 'up' : 'down'} ${n1(Math.abs(m))} octaves, inert until filter1.enabled is on. This one is a STARTING POINT rather than a landing: the ${n1(Math.abs(m))} octaves were measured with the filter out of circuit, and a filter subtracts from the source rather than setting the centroid, so expect to re-measure and move again.`,
            direction: dark ? 'increase' : 'decrease',
            confidence: 'low',
            suggested: cutoffMove,
            paramIds: ['filter1.cutoff', 'filter1.enabled']
          }
        ]
      }
      return {
        error: m,
        finding: headline,
        direction: dark ? 'increase' : 'decrease',
        // Centroid octaves to cutoff octaves is about as direct as this gets,
        // but only once the windows agree that nothing is moving over time.
        confidence: corroborated ? 'high' : 'medium',
        suggested: cutoffMove
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
    scale: BRIGHTNESS_TREND_SCALE,
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
      // A DAMPED probe, not a fit. Inverting "octaves of brightness drift" into
      // "seconds of env2.decay" needs the mod-slot depth, the envelope curve and
      // the filter slope, and this module can see none of them - `PatchValues`
      // carries `PARAMS` ids only, and a mod slot is not one. So the honest step
      // is a guess, and the only thing worth engineering about a guess is that
      // it CONTRACTS: the old fixed 1.5x/÷1.5 pair is its own inverse, so a step
      // that overshoots is undone in full on the next round and the sequence
      // rings around the target forever. Scaling by the error relative to
      // `scale` gives 1.5x at the saturation point and 1.075x at the 0.3-octave
      // silence threshold, so successive overshoots shrink geometrically.
      const factor = dampedFactor(trend, BRIGHTNESS_TREND_SCALE, 0.5)
      return {
        error: trend,
        finding: `Brightness error drifts ${n1(Math.abs(trend))} octaves across the buffer (${n1(first)} in the first window, ${n1(last)} in the last), so the candidate ${tooFast ? 'darkens too fast' : 'holds its brightness too long'}. This is envelope shape, not static cutoff: ${tooFast ? 'lengthen env2.decay / raise env2.sustain, or reduce' : 'shorten env2.decay / lower env2.sustain, or increase'} the depth of the env2 -> filter1.cutoff mod slot (set_modulation). That mod slot is the REAL fix and has no parameter id, so it can never appear as a suggested move; env2 reaches the sound through it and nothing else, and if the route does not exist in this patch then env2.decay is inert and set_modulation is the whole job. The direction above assumes that slot has POSITIVE depth, the usual wiring: a mod slot carries no parameter id, so its sign is as unreadable from here as its existence, and with an inverted slot the same move lengthens the wrong stage. The suggested ${round(factor, 2)}x on env2.decay is a PROBE sized from the error, not a computed correction - apply it, re-measure, expect several rounds.`,
        direction: tooFast ? 'increase' : 'decrease',
        // The env -> cutoff route may not even exist in the patch, the step is
        // a probe rather than a fit, and the trend can also come from an
        // amplitude decay that reweights the windows. Three reasons for `low`.
        confidence: 'low',
        suggested: suggest(patch, 'env2.decay', from => (tooFast ? from * factor : from / factor))
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
      const headline = `Octave bands at and above 4 kHz are ${n1(Math.abs(upper))} dB ${quiet ? 'quiet' : 'loud'} against the reference, with no usable per-window brightness to say whether that is static or swept.`
      const gainMove = suggest(patch, 'eq.high_gain', from => from - upper)

      // `eq.enabled` defaults to 0 and `processor.ts` skips the EQ entirely
      // below 0.5, so on a factory patch the only move this rule made was a
      // guaranteed no-op — and the finding did not even mention the bypass.
      // Unlike the filter, an EQ shelf cuts AND boosts, so engaging it serves
      // either sign of the error; the switch is always the right first move.
      // That is what makes this rule's guard unconditional where
      // `filter-cutoff-static`'s has to be conditional on the sign: `eq.high_gain`
      // spans -18..18 dB around a 4 kHz high shelf (`Eq3` in `worklet/effects.ts`,
      // the same 4 kHz this rule measures from), so the direction it can deliver
      // is not a function of the error's direction.
      const enable = switchState(patch, 'eq.enabled') === 'off' ? enableMove(patch, 'eq.enabled') : undefined
      if (enable) {
        return [
          {
            error: upper,
            finding: `${headline} The EQ is bypassed (eq.enabled is 0), so eq.high_gain is inert until this switch is on - that is what this action is. On its own it also puts eq.low_gain and eq.mid_gain into circuit at whatever they are already holding, so it is a no-op only while all three sit at 0 dB; the companion action sets the high shelf, so apply both.`,
            direction: 'increase',
            confidence: 'high',
            suggested: enable,
            paramIds: ['eq.enabled', 'eq.high_gain', 'filter1.cutoff']
          },
          {
            error: upper,
            // From an effective ZERO dB, not from where the knob rests: a
            // bypassed EQ applied none of the gain it is currently showing.
            finding: `Second half of the same move: eq.high_gain to ${signedNumber(-upper)} dB, the whole error measured from a flat 0 dB - the bypassed EQ applied none of the gain it is currently showing. It takes effect only once eq.enabled is on. Filter cutoff is the other lever: a wide shelf and a cutoff move sound different even at the same band energy.`,
            direction: quiet ? 'increase' : 'decrease',
            confidence: 'medium',
            suggested: suggest(patch, 'eq.high_gain', () => -upper),
            paramIds: ['eq.high_gain', 'eq.enabled', 'filter1.cutoff']
          }
        ]
      }
      return {
        error: upper,
        finding: headline,
        direction: quiet ? 'increase' : 'decrease',
        confidence: 'medium',
        suggested: gainMove
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
    scale: INHARMONICITY_SCALE,
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
      // Same tri-state discipline as `switchState`: an unread `osc1.unison` is
      // not a claim that osc1 is running one voice.
      const unisonNote = unison === undefined
        ? 'This patch could not be read, so whether unison detune is even in play is unknown - check osc1.unison first, because osc1.detune and osc1.spread are inert below 2 voices'
        : 'osc1 is not in unison, so detune cannot explain it - and with unison at 1 osc1.detune and osc1.spread are inert anyway. This synth has no partial-stretch control, so the closest lever is a different wavetable'
      // A DAMPED probe. There is no honest inversion of "stretch coefficient B"
      // into "cents of unison detune": the smear is symmetric and how it biases
      // a fitted B depends entirely on the analyzer's peak picking. What the old
      // step got wrong was not its size but its SHAPE — 0.5x and 2x are exact
      // inverses, so alternating firings gave `12 -> 6 -> 12 -> 6`, a period-2
      // cycle that no number of iterations escapes. Sizing the factor from the
      // error (up to 2x at saturation, 1.05x at the silence threshold) keeps the
      // same coarse search while making every overshoot smaller than the last.
      const factor = dampedFactor(d, INHARMONICITY_SCALE, 1)
      return {
        error: d,
        finding: `Partial series is ${moreStretched ? 'more' : 'less'} stretched than the reference (B delta ${d.toExponential(1)}). Two causes read alike here: unison detune smearing each partial into a band, and a genuinely inharmonic series. ${detuned ? `osc1.unison is ${unison}, so ${moreStretched ? `narrow osc1.detune first (the suggested ÷${round(factor, 2)} is a PROBE sized from the error, not a computed correction)` : `widen osc1.detune first (the suggested x${round(factor, 2)} is a PROBE sized from the error, not a computed correction)`} and re-measure; expect several rounds` : unisonNote}.`,
        direction: moreStretched ? 'decrease' : 'increase',
        // The measurement cannot separate the two causes, and the step is a
        // probe. Never above medium.
        confidence: detuned ? 'medium' : 'low',
        suggested: detuned
          ? suggest(patch, 'osc1.detune', from =>
            moreStretched ? from / factor : Math.max(from * factor, MIN_DETUNE_PROBE_CENTS))
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
      // A ratio has no purchase on zero: `0 * 10 ** x` is 0, `suggest` drops the
      // move as no change, and the finding was then describing a correction with
      // nothing attached to it. The delta is relative to each side's own peak,
      // so it cannot say what the level should BE — only that scaling cannot get
      // there from zero.
      const from = patchRaw(patch, 'env1.sustain')
      const def = PARAM_BY_ID.get('env1.sustain')
      const wanted = from === undefined ? undefined : from * 10 ** (-d / 20)
      const zeroNote = tooLow && from !== undefined && from <= 0
        ? ' env1.sustain is at 0 and this correction is a RATIO, which cannot lift a level off zero - set env1.sustain directly from the reference (its decay clearly settles onto a sustain, this one does not) rather than scaling the current value.'
        // A sustain pinned at 1 with the reference still higher means the two
        // envelopes differ in DECAY, not in sustain: there is no headroom left
        // and the rest of the finding is not this parameter's to fix.
        : wanted !== undefined && def !== undefined && (wanted > def.max || wanted < def.min)
          ? ` env1.sustain cannot travel that far (range ${def.min}..${def.max}); it stops at ${round(Math.min(def.max, Math.max(def.min, wanted)), 3)}, and the rest is a decay difference rather than a sustain one - look at env1.decay and env1.dec_curve.`
          : ''
      return {
        error: d,
        finding: `Sustain level is ${n1(Math.abs(d))} dB too ${tooLow ? 'low' : 'high'} relative to the peak.${zeroNote}`,
        direction: tooLow ? 'increase' : 'decrease',
        // sustainDb is sampled at 80% of the buffer, so a long decay still
        // colours it; the link is direct but not clean.
        confidence: 'medium',
        // env1.sustain is a LINEAR 0..1 level; convert the dB delta to a ratio.
        suggested: suggest(patch, 'env1.sustain', v => v * 10 ** (-d / 20))
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
      const noise = switchState(patch, 'noise.enabled')
      const headline = `Spectral flatness is ${d.toFixed(3)} ${tooNoisy ? 'higher' : 'lower'} than the reference (0 tonal, 1 noise), so the candidate is too ${tooNoisy ? 'noisy' : 'clean'}.`
      // 1:1 flatness-to-level is a placeholder mapping, not a calibration.
      const levelMove = suggest(patch, 'noise.level', from => from - d)
      const distNote = switchState(patch, 'dist.enabled') === 'off' ? ' (itself inert while dist.enabled is off)' : ''

      if (tooNoisy) {
        // `voice.ts` skips the noise branch entirely below 0.5, so with the
        // generator bypassed a `noise.level` cut removes nothing — and the old
        // rule suggested one anyway, right underneath prose saying the noise
        // came from somewhere else. No move at all is the honest answer.
        if (noise === 'off') {
          return {
            error: d,
            finding: `${headline} noise.enabled is off, so noise.level is inert and cutting it removes nothing - the noise floor comes from somewhere else. Check dist.drive${distNote}, dist.type Bitcrush, and filter1.resonance self-noise.`,
            direction: 'decrease',
            confidence: 'low',
            paramIds: ['noise.enabled', 'noise.level']
          }
        }
        return {
          error: d,
          finding: headline,
          direction: 'decrease',
          // Flatness lumps together the noise generator, distortion and any
          // inharmonic partials. Directionally right, quantitatively crude.
          confidence: 'low',
          suggested: levelMove,
          paramIds: ['noise.level', 'noise.enabled']
        }
      }

      // Too clean with the generator bypassed: the old finding said "turn
      // noise.enabled on first" and then moved only noise.level, which changes
      // nothing while the switch is off. Both halves are moves now, the switch
      // first — and the level move matters even so, because `noise.level` can
      // itself be sitting at 0, which would make the switch alone inaudible.
      if (noise === 'off') {
        const enable = enableMove(patch, 'noise.enabled')
        if (enable) {
          return [
            {
              error: d,
              finding: `${headline} noise.enabled is off, and noise.level does nothing at all while it is - that is what this action switches on. On its own it adds the noise generator at whatever noise.level currently holds, which is nothing if that level is 0; the companion action sets it, so apply both.`,
              direction: 'increase',
              confidence: 'medium',
              suggested: enable,
              paramIds: ['noise.enabled', 'noise.level', 'noise.type']
            },
            {
              error: d,
              // From an effective ZERO, not from where the knob rests: the
              // bypassed generator put no noise in the buffer at all, so
              // `from - d` would charge the render for a level it never heard.
              finding: `Second half of the same move: noise.level to ${round(-d, 3)}, the whole flatness gap measured from zero - the bypassed generator contributed none of the level it is currently showing. It is inert until noise.enabled is on. The 1:1 flatness-to-level mapping is a placeholder, so treat the amount as a starting point and re-measure. Also try a different noise.type: Pink sits under a tone where White sits on top of it.`,
              direction: 'increase',
              confidence: 'low',
              suggested: suggest(patch, 'noise.level', () => -d),
              paramIds: ['noise.level', 'noise.type', 'noise.enabled']
            }
          ]
        }
      }
      return {
        error: d,
        finding: `${headline}${noise === 'on' ? ' Also try a different noise.type: Pink sits under a tone where White sits on top of it.' : ''}`,
        direction: 'increase',
        confidence: 'low',
        suggested: levelMove,
        paramIds: ['noise.level', 'noise.enabled', 'noise.type']
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
      const headline = `Stereo width is ${d.toFixed(3)} ${tooNarrow ? 'narrower' : 'wider'} than the reference (0 is mono).`
      const spreadMove = suggest(patch, 'osc1.spread', from => from - d)
      // Not an `enabled` switch, but exactly the same gate: `voice.ts` computes
      // the per-voice offset as `unison === 1 ? 0 : ...` and multiplies both
      // osc1.spread and osc1.detune by it, so on a single voice both are
      // ARITHMETICALLY zero. `osc1.unison` defaults to 1, so this rule's only
      // move was a no-op on every factory patch — the prose said "osc1.unison
      // above 1 with osc1.detune and osc1.spread" and then moved spread alone.
      const unison = patchRaw(patch, 'osc1.unison')
      const spreadInert = unison !== undefined && unison <= 1

      if (spreadInert) {
        if (!tooNarrow) {
          // Nothing to narrow. With one voice the oscillator is already as mono
          // as it gets, so the excess width is downstream and lowering an inert
          // spread would be the no-op that never converges.
          return {
            error: d,
            finding: `${headline} osc1.unison is 1, so osc1.spread and osc1.detune are already inert - the oscillator is as mono as it goes and cannot be the source of the extra width. It is downstream: pull chorus.mix or reverb.width down (each only if its own enabled switch is on), or centre osc1.pan.`,
            direction: 'decrease',
            confidence: 'medium',
            paramIds: ['chorus.mix', 'reverb.width', 'osc1.unison']
          }
        }
        const unisonMove = suggest(patch, 'osc1.unison', () => MIN_SPREADING_UNISON)
        if (unisonMove) {
          return [
            {
              error: d,
              finding: `${headline} osc1.unison is 1, and a single voice multiplies both osc1.spread and osc1.detune by zero - they do nothing at all until this action raises unison to ${MIN_SPREADING_UNISON}. Unison is audible in its own right, not just in the stereo field: ${MIN_SPREADING_UNISON} voices at osc1.detune thickens the tone as well as widening it. The companion action then sets the spread.`,
              direction: 'increase',
              confidence: 'medium',
              suggested: unisonMove
            },
            {
              error: d,
              // From an effective ZERO, not from where the knob rests: with one
              // voice the spread was multiplied by zero, so the render carried
              // none of the width the knob is currently showing.
              finding: `Second half of the same move: osc1.spread to ${round(-d, 3)}, the whole width gap measured from zero - a single voice multiplied the spread it is currently showing by zero. Inert until osc1.unison is above 1. Widen at the source like this before reaching for chorus.mix or reverb.width, which also change the timbre.`,
              direction: 'increase',
              confidence: 'medium',
              suggested: suggest(patch, 'osc1.spread', () => -d),
              paramIds: ['osc1.spread', 'osc1.detune', 'osc1.unison']
            }
          ]
        }
      }
      return {
        error: d,
        finding: `${headline} ${tooNarrow ? 'Widen at the source first - osc1.unison above 1 with osc1.detune and osc1.spread - before reaching for chorus.mix or reverb.width, which also change the timbre' : 'Narrow osc1.spread and osc1.detune first; pulling chorus.mix or reverb.width down also removes body'}.`,
        direction: tooNarrow ? 'increase' : 'decrease',
        confidence: 'medium',
        suggested: spreadMove
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
      // Clamping is not the live-lock the enable-gated rules had — the clamped
      // move still shifts loudness the right way, it just stops short — but the
      // finding used to describe a correction bigger than the move without
      // saying by how much. Quoting the shortfall in dB is what makes the two
      // agree: an agent knows exactly what is left for the other levers.
      const reachable = wanted !== undefined && def !== undefined
        ? Math.min(def.max, Math.max(def.min, wanted))
        : undefined
      const shortfallDb = wanted !== undefined && reachable !== undefined && wanted > 0 && reachable > 0
        ? 20 * Math.log10(wanted / reachable)
        : undefined
      const clipNote = wanted !== undefined && def !== undefined && (wanted > def.max || wanted < def.min)
        ? ` master.volume cannot travel that far (range ${def.min}..${def.max}): it stops at ${round(reachable ?? def.max, 3)}${shortfallDb === undefined ? '' : `, ${n1(Math.abs(shortfallDb))} dB short`}. Take the rest from oscillator levels or comp.makeup (itself inert unless comp.enabled is on).`
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
    let outcome: RuleOutcome | RuleOutcome[] | null
    try {
      outcome = rule.evaluate(ctx)
    } catch {
      // A malformed diff must not take the whole advisor down.
      continue
    }
    if (!outcome) continue
    // A rule that needs two parameters to land one correction returns two
    // outcomes; equal `error` gives them equal gain, and the stable sort below
    // keeps them next to each other in the ranked list.
    for (const one of Array.isArray(outcome) ? outcome : [outcome]) {
      const magnitude = Math.abs(one.error)
      if (!Number.isFinite(magnitude) || magnitude < rule.minError) continue
      actions.push({
        finding: one.finding,
        paramIds: [...(one.paramIds ?? rule.paramIds)],
        direction: one.direction,
        ...(one.suggested ? { suggested: one.suggested } : {}),
        estimatedGain: round(rule.weight * Math.min(1, magnitude / rule.scale), 4),
        confidence: one.confidence
      })
    }
  }

  // Array.prototype.sort is stable, so equal gains keep table order.
  actions.sort((a, b) => b.estimatedGain - a.estimatedGain)
  return actions.slice(0, maxActions)
}
