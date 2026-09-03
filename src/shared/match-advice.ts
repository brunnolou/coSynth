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
 * ## The mod matrix is a THIRD state, not an absence
 *
 * `env2` reaches the sound through the mod matrix and nothing else. For a long
 * time this module could not see that matrix, so `filter-envelope-depth` hedged
 * in prose — "if the route does not exist then env2.decay is inert" — and moved
 * `env2.decay` anyway. That is the bypassed-switch bug in its third costume: a
 * move that cannot reach the sound, re-proposed identically every round.
 *
 * `AdviseOptions.mods` closes it. The matrix is TRI-STATE for exactly the reason
 * `switchState` is:
 *
 * - `undefined` — the caller did not pass one. "I have not looked" must never be
 *   reported as "there is no route", so this keeps the hedged probe.
 * - `[]` or a matrix with no matching route — READ, and the route is genuinely
 *   absent. `env2.decay` is then inert and no `suggested` is emitted at all;
 *   the finding names `set_modulation` with the concrete source, destination
 *   and depth to create.
 * - a live route — its DEPTH IS SIGNED, and the sign inverts the whole
 *   recommendation. With positive depth the cutoff follows env2, so a candidate
 *   that darkens too fast wants a LONGER decay; with negative depth the cutoff
 *   moves against env2, the sweep runs dark-to-bright, and the same error wants
 *   a SHORTER one. Reading the polarity and asserting the usual wiring are not
 *   the same thing, and only one of them is safe.
 *
 * Mod slots still carry no `PARAMS` id, so `set_modulation` can never be a
 * `suggested` move; it is named in the finding, in the vocabulary
 * `set_modulation` and `apply_patch`'s `modulations` block both take.
 *
 * ## Probe steps versus computed corrections
 *
 * Some rules can compute their correction exactly (`pitch-error`, `loudness`,
 * `attack-time`). Others cannot, because the parameter reaches the measurement
 * through a chain this module can see only part of: even with the
 * `env2 -> filter1.cutoff` route in hand, inverting "octaves of brightness
 * drift" into "seconds of env2.decay" needs the envelope curve and the filter
 * slope as well.
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
 * ## Clamping is a fact about the correction, not a detail of the move
 *
 * `legalValue` keeps every `suggested` inside its parameter's range. The bug is
 * never the clamp; it is the finding being phrased from the UNCLAMPED number
 * while the move carries the clamped one — the reviewer read prose recommending
 * `dist.drive` at `2.095` next to a structured suggestion of `1`, which is the
 * maximum. That is the octave bug again: two derivations of one quantity.
 *
 * So there is ONE derivation. `planMove` computes the value, legalizes it, and
 * KEEPS the fact that it had to, and `clampNote` is the only thing that writes
 * about it: the computed value, the limit it hit, and where the remainder has
 * to come from. Every quantitative rule routes through the pair, so a rule
 * cannot describe a correction larger than the one it applies without saying by
 * how much and what covers the difference.
 *
 * ## Atomic groups
 *
 * The enable/move pairs above are not merely adjacent, they are ATOMIC: the
 * distortion switch without the drive is an uncontrolled timbre change, and the
 * drive without the switch is nothing at all. The findings said "apply both or
 * neither" in prose while the list handed a caller two independent rows that a
 * `maxActions` cut could split down the middle.
 *
 * Both halves now carry the same `group` id, and the driver's truncation is
 * group-aware: a group is taken whole or not at all, and a group that does not
 * fit in the remaining slots is skipped so a smaller action can use them. A
 * caller can hand one group's `suggested` moves straight to `apply_patch`.
 *
 * The pitch pair is deliberately NOT a group. Its two halves are companions
 * rather than an atom — the transpose alone leaves half a semitone that the next
 * round finishes on `osc1.fine`, which is one extra iteration and never a loop —
 * and grouping them would let a `maxActions` of 1 return no pitch move at all.
 *
 * ## `estimatedGain`, honestly
 *
 * `estimatedGain = weight * min(1, |error| / scale) * CONFIDENCE_FACTOR[confidence]`.
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
 * - `CONFIDENCE_FACTOR` turns the first two into an EXPECTED value. Ranking on
 *   gain alone put a low-confidence `filter-envelope-depth` action — for a route
 *   that did not exist — above several medium-confidence moves that would have
 *   worked. A gain the advisor does not believe in is not worth a gain it does,
 *   and the ladder already carries the belief: `high`/`medium`/`low`.
 *
 * The factor is one 0.6 discount per step DOWN that ladder — `1`, `0.6`, `0.36`
 * — rather than a fitted weight, because there is nothing here to fit it
 * against. What it buys is a stated exchange rate: a `low` action has to promise
 * about 2.8x the raw gain of a `medium` one to outrank it, and a `medium` about
 * 1.7x a `high` one. Ordering by raw gain is the special case where every action
 * is equally trustworthy, which is exactly the assumption that was wrong.
 *
 * The gain is computed once per rule FIRING, not per action, and every outcome
 * of that firing carries it. Outcomes of one firing describe halves of ONE
 * correction, so they must rank together or the list can interleave someone
 * else's action between them; and an atomic group is only as trustworthy as its
 * least confident member, so the firing takes the MINIMUM factor across its
 * outcomes. Each action still reports its own `confidence`, which is why an
 * action can read `high` and be priced at a `medium` rate.
 *
 * So the number is an ORDERING device with a plausible magnitude, not a
 * prediction. Two actions with gains 0.31 and 0.29 should be read as "these two
 * matter about the same"; 0.31 versus 0.04 is the comparison the number is for.
 * Nothing here has been calibrated against measured similarity deltas, and it
 * should not be quoted as an expected score improvement.
 *
 * ## What is NOT mapped
 *
 * - A mod slot has no `PARAMS` id (it is a `{source, destination, depth}` slot,
 *   set with `set_modulation`), so it can never be a `suggested` move however
 *   well this module can read it. `paramIds` carries the envelope's own
 *   parameters and the finding names the route.
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

/**
 * One live mod-matrix route, in the vocabulary `set_modulation` and
 * `apply_patch`'s `modulations` block already speak: `source` a `MOD_SOURCES`
 * id, `destination` a `PARAMS` id, `depth` SIGNED in -1..1 normalized
 * destination units.
 *
 * `webmcp/tools.ts` already builds exactly this shape (`routeValue`), so the
 * call site is `engine.modSlots.flatMap((route, slot) => route ? [routeValue(slot, route)] : [])`
 * and nothing has to be converted. `PresetData.mods` spells the same field
 * `dest`, so a caller coming from `engine.toPreset()` has to rename it.
 */
export interface ModRoute {
  source: string
  destination: string
  depth: number
  /** Absent reads as enabled: `set_modulation` defaults it on, and so does this. */
  enabled?: boolean
}

export interface AdviseOptions {
  /** Cap on returned actions. Default 5. */
  maxActions?: number
  /** Keep only rules in this category. */
  focus?: AdviceCategory
  /**
   * The live mod matrix, if the caller can read it.
   *
   * TRI-STATE, and the distinction is load-bearing: OMITTING this is "I have not
   * looked", an empty array is "I looked and there are no routes". A rule that
   * treats the first as the second tells an agent to create a route that already
   * exists, or inverts a recommendation off a polarity it never read.
   */
  mods?: readonly ModRoute[]
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
  /**
   * Outcomes of one firing sharing this key are ATOMIC: applying some of them
   * and not the rest leaves the patch somewhere neither the rule nor the caller
   * asked for. The driver namespaces it with the rule id, keeps members
   * adjacent, and never lets a `maxActions` cut land inside one.
   *
   * Only for outcomes that really are inseparable. Companion moves that each do
   * their own share of the work — the two halves of a pitch correction — must
   * NOT set it, or a tight `maxActions` returns neither.
   */
  group?: string
}

export interface AdviceContext {
  diff: MatchDiff
  patch: PatchValues
  /** The live mod matrix, or `undefined` for "the caller could not read one". */
  mods?: readonly ModRoute[]
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
 * A quantitative move with the CLAMP still attached to it.
 *
 * `legalValue` used to be the end of the story: it returned the legal value and
 * the fact that it had had to pull one in was gone, so a rule wanting to say so
 * had to recompute the correction alongside the move. Two derivations of one
 * quantity is how `dist.drive` came to be described at `2.095` and suggested at
 * `1`. `clamped` is that fact, carried, so `clampNote` can write from the same
 * arithmetic the move was built from.
 */
interface MovePlan {
  suggested?: MatchAction['suggested']
  /** Present only when the computed value fell outside the parameter's range. */
  clamped?: {
    id: string
    /** What the rule's own arithmetic asked for, before any legalization. */
    computed: number
    /** The endpoint it hit. */
    limit: number
    bound: 'maximum' | 'minimum'
    unit: string
  }
}

/**
 * Compute a move for `id` ONCE: the raw correction, the legal value, and
 * whether the two differ because the range got in the way.
 *
 * `suggested` is absent when the patch does not carry the parameter or the move
 * rounds away to nothing. `clamped` is independent of that — a correction that
 * lands past an endpoint the knob is ALREADY sitting on produces no move and
 * still has to be reported, or the finding silently drops the whole error.
 */
function planMove(patch: PatchValues, id: string, compute: (from: number) => number): MovePlan {
  const def = PARAM_BY_ID.get(id)
  if (!def) return {}
  const from = patchRaw(patch, id)
  if (from === undefined) return {}
  const computed = compute(from)
  if (!Number.isFinite(computed)) return {}
  const to = legalValue(def, computed)
  // Choice params have no meaningful "past the maximum": `legalValue` snaps them
  // to an index and there is no remainder to account for.
  const clamped = def.choices || (computed >= def.min && computed <= def.max)
    ? undefined
    : {
      id,
      computed: round(computed, 3),
      limit: computed > def.max ? def.max : def.min,
      bound: computed > def.max ? ('maximum' as const) : ('minimum' as const),
      unit: unitOf(def)
    }
  if (Math.abs(to - legalValue(def, from)) < 1e-9) return clamped ? { clamped } : {}
  return { suggested: { id, from: round(from), to, unit: unitOf(def) }, ...(clamped ? { clamped } : {}) }
}

/**
 * Build a quantitative suggestion for `id`, or `undefined` when the patch does
 * not carry that parameter or the move rounds away to nothing.
 */
function suggest(patch: PatchValues, id: string, compute: (from: number) => number): MatchAction['suggested'] {
  return planMove(patch, id, compute).suggested
}

/** `raw`/`choice` are placeholders for "no unit", so they are not printed as one. */
function unitSuffix(unit: string): string {
  return unit === 'raw' || unit === 'choice' ? '' : ` ${unit}`
}

/**
 * `legalValue` addressed by id, for the ZERO-FRAME findings.
 *
 * A gated rule's second half names its landing value in prose ("dist.drive to
 * X") because the whole point of that sentence is the value, not the delta. It
 * used to name the raw product while `suggest` applied the legalized one, which
 * is the `2.095`-versus-`1` split in miniature. Routing the sentence through the
 * SAME `legalValue` the move is built from makes disagreeing impossible.
 */
function legalFor(id: string, v: number): number {
  const def = PARAM_BY_ID.get(id)
  return def ? legalValue(def, v) : round(v, 3)
}

/**
 * The one place a clamp is described. Empty string when nothing was clamped, so
 * a finding can interpolate it unconditionally.
 *
 * `remainder` is the rule's own answer to "then where does the rest come from",
 * which is the part that makes the note actionable rather than an apology.
 * `extra` carries a rule-specific quantification of the shortfall in the unit
 * the ERROR was measured in, which the parameter's own unit cannot express.
 */
function clampNote(plan: MovePlan, remainder: string, extra = ''): string {
  const c = plan.clamped
  if (!c) return ''
  const u = unitSuffix(c.unit)
  return ` ${c.id} cannot travel that far: the correction computes ${c.computed}${u}, past its ${c.bound} of ${c.limit}${u}, so the suggested value is clamped to ${c.limit}${u}${extra}. ${remainder}`
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

/**
 * The brightness rows that describe a brightness disagreement.
 *
 * `match-diff.ts` marks a row `belowNoiseFloor` when the reference slice, the
 * candidate slice or both sat under the analyzer's noise gate. Its `octaveDelta`
 * is still a finite number - deliberately, so the arithmetic here never meets a
 * `null` - but it is the distance between a sound and a noise floor rather than
 * between two sounds. `compareAudioMetrics` leaves exactly these rows out of the
 * score, so a rule that means, spreads or trends them steers against the number
 * it is trying to move: a -55 dB tail reading a 4,978 Hz centroid manufactures a
 * five-octave "swing" out of hiss, and this rule table put an `env2.decay` move
 * at the top of the list because of it.
 *
 * Every consumer of `diff.brightness` in this file goes through here.
 */
function measuredBrightness(brightness: MatchDiff['brightness']): MatchDiff['brightness'] {
  return brightness.filter(w => !w.belowNoiseFloor)
}

/** `` — or a clause naming the rows that were left out, so the count is explicable. */
function gatedWindowNote(brightness: MatchDiff['brightness'], used: number): string {
  const gated = brightness.length - used
  return gated > 0
    ? ` (${gated} of the ${brightness.length} windows sat below the analyzer's noise gate on one side or the other and are left out: their centroids describe the noise the sound decayed into, and the similarity score leaves them out too)`
    : ''
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

// ------------------------------------------------------------ the mod matrix

/**
 * Below this |depth| a route is on the books and inaudible.
 *
 * Depth is normalized destination units, and `filter1.cutoff` spans 20 Hz to
 * 20 kHz on an exponential curve, so 1.0 of depth is about 9.97 octaves of
 * cutoff travel and 0.01 is about 0.1 — a third of `filter-envelope-depth`'s own
 * 0.3-octave silence threshold. A route that quiet cannot be the thing shaping a
 * trend this rule is willing to talk about, so it is treated as no route: the
 * advice is to set a real depth, not to lengthen a decay hanging off a hair.
 */
const MIN_MOD_DEPTH = 0.01

/**
 * Tri-state, for the same reason `switchState` is.
 *
 * `seen: false` is "the caller passed no matrix", and it is NOT "there is no
 * route". Collapsing the two tells an agent to create a route it already has,
 * or asserts a polarity nobody read.
 */
type RouteState =
  | { seen: false }
  | { seen: true; route: ModRoute | undefined }

function routeState(
  mods: readonly ModRoute[] | undefined,
  source: string,
  destination: string
): RouteState {
  if (!mods) return { seen: false }
  return { seen: true, route: mods.find(m => m.source === source && m.destination === destination) }
}

/**
 * Does this route actually carry the source to the destination?
 *
 * Three ways it does not, and all three read the same from the sound's side:
 * absent, present but `enabled: false`, present and enabled at a depth too small
 * to hear. `enabled` missing counts as ON, matching `set_modulation`'s default.
 */
// Deliberately NOT a `route is ModRoute` predicate: the caller's negative branch
// still needs to tell "no route" from "a route that is off or too shallow" so it
// can say which, and narrowing to `undefined` there throws that away.
function routeIsLive(route: ModRoute | undefined): boolean {
  return route !== undefined && route.enabled !== false && Math.abs(route.depth) >= MIN_MOD_DEPTH
}

/**
 * Octaves of destination travel per 1.0 of normalized mod depth.
 *
 * Only meaningful for an exponentially-curved parameter, where normalized
 * position IS log-frequency: `normToValue` computes `min * (max/min) ** n`, so
 * the full 0..1 sweep is exactly `log2(max/min)` octaves and any fraction of it
 * scales linearly in octaves. Read off the definition rather than written as a
 * literal, so re-ranging `filter1.cutoff` cannot leave a stale constant behind.
 */
function octavesPerUnitDepth(id: string): number | undefined {
  const def = PARAM_BY_ID.get(id)
  if (!def || def.curve !== 'exp' || !(def.min > 0) || !(def.max > def.min)) return undefined
  return Math.log2(def.max / def.min)
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
      // Both moves are computed BEFORE the sentences that describe them, so the
      // clamp notes below are written from the same arithmetic that produced the
      // values. `fitToFineRange` already keeps `osc1.fine` reachable, so its
      // note is a backstop; `osc1.transpose` really can run out at +-48.
      const transposePlan = onTranspose ? planMove(patch, 'osc1.transpose', from => from + semitones) : {}
      const finePlan = onFine ? planMove(patch, 'osc1.fine', from => from + residualCents) : {}
      const transposeClamp = clampNote(
        transposePlan,
        'osc1.transpose spans 4 octaves in each direction and nothing here reaches further, so a correction past it is far more likely an octave the detector guessed wrong than a tuning error - check the reference pitch before chasing the remainder, or split it across osc2/osc3 transpose and sub.octave.'
      )
      const fineClamp = clampNote(
        finePlan,
        'osc1.fine spans one semitone each way; the leftover belongs on osc1.transpose.'
      )
      const finding = octaves !== 0
        // "Octave" is deliberate: a model acts on it far more reliably than on
        // "1200 cents sharp", which reads like any other detune.
        ? `Octave error: the candidate is ${Math.abs(octaves)} octave${Math.abs(octaves) === 1 ? '' : 's'} ${octaves < 0 ? 'above' : 'below'} the reference (${n1(cents)} cents). Transpose by ${signedUnits(semitones, 'semitone')}${fineNote}; do not chase the octave itself with fine tuning.${borrowNote}${transposeClamp}`
        : onTranspose
          ? `Candidate is ${n1(Math.abs(cents))} cents ${sharp ? 'sharp' : 'flat'}${hzNote}. Transpose by ${signedUnits(semitones, 'semitone')}${fineNote}.${borrowNote}${transposeClamp}`
          : `Candidate is ${n1(Math.abs(cents))} cents ${sharp ? 'sharp' : 'flat'}${hzNote}. Half a semitone or less, so this is osc1.fine (${signedUnits(residualCents, 'cent')}), not osc1.transpose.${fineClamp}`

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
      const fineMove = finePlan.suggested
      const outcomes: RuleOutcome[] = []
      if (onTranspose) {
        outcomes.push({
          error: cents,
          finding,
          direction: semitones < 0 ? 'decrease' : 'increase',
          // Pitch to transpose is one-to-one and exact.
          confidence: 'high',
          suggested: transposePlan.suggested,
          paramIds: ['osc1.transpose', 'osc1.fine']
        })
      }
      if (onFine && (!onTranspose || fineMove)) {
        outcomes.push({
          error: cents,
          finding: onTranspose
            ? `Second half of the same pitch move: ${signedUnits(residualCents, 'cent')} on osc1.fine. The ${signedUnits(semitones, 'semitone')} transpose on its own lands ${n1(Math.abs(residualCents))} cents ${residualCents < 0 ? 'sharp' : 'flat'}; apply both and the pitch is exact.${fineClamp}`
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
      //
      // `dist.drive` is 0..1, and 0.05 per dB/octave runs out of range at 20
      // dB/octave of error from rest - which is well inside what this rule
      // fires on. That is the reviewer's `2.095`: a finding phrased from the
      // raw product next to a suggestion of `1`. Both come off `drivePlan` now.
      const drivePlan = planMove(patch, 'dist.drive', from => from - tilt * 0.05)
      const driveRemainder = 'Drive alone cannot carry the rest of the tilt: take it at the oscillator (osc1.wavetable / osc1.morph), or with a harder dist.type, or with eq.high_gain once eq.enabled is on.'
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
          // From an effective ZERO, not from where the knob rests: a bypassed
          // drive put no harmonic content in the buffer, so `from - tilt * 0.05`
          // would charge the render for drive it never heard and land at nearly
          // double the amount.
          const zeroFramePlan = planMove(patch, 'dist.drive', () => -tilt * 0.05)
          return [
            {
              error: tilt,
              finding: `${headline} The distortion section is bypassed (dist.enabled is 0), so dist.drive adds nothing until this switch is on - that is what this action is. Engaging it runs the voice through dist.type at its current setting, which already brightens the series on its own; the companion action then sets the drive.`,
              direction: 'increase',
              confidence: 'medium',
              suggested: enable,
              paramIds: ['dist.enabled', 'dist.drive'],
              group: 'engage-dist'
            },
            {
              error: tilt,
              finding: `Second half of the same move: dist.drive to ${legalFor('dist.drive', -tilt * 0.05)}, which is the whole ${n1(Math.abs(tilt))} dB/octave measured from zero - the bypassed section contributed none of the drive it is currently showing. It does nothing until dist.enabled is on, so apply both or neither.${clampNote(zeroFramePlan, driveRemainder)}`,
              direction: 'increase',
              confidence: 'medium',
              suggested: zeroFramePlan.suggested,
              paramIds: ['dist.drive', 'dist.enabled'],
              group: 'engage-dist'
            }
          ]
        }
      }
      return {
        error: tilt,
        finding: `${headline} ${darker ? 'Add' : 'Remove'} harmonic content at the source.${clampNote(drivePlan, driveRemainder)}`,
        direction: darker ? 'increase' : 'decrease',
        confidence: 'medium',
        suggested: drivePlan.suggested
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
      const windows = measuredBrightness(diff.brightness)
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
      const headline = `Brightness is ${dark ? 'down' : 'up'} ${n1(Math.abs(m))} octaves in every one of the ${windows.length} analysis windows (spread only ${n1(spread)} octaves), so this is a STATIC cutoff offset, not an envelope shape${extra ? ` (${extra})` : ''}.${gatedWindowNote(diff.brightness, windows.length)}`
      const cutoffPlan = planMove(patch, 'filter1.cutoff', from => from * 2 ** -m)
      const cutoffRemainder = dark
        // A cutoff already at 20 kHz is above everything the oscillator makes,
        // so the missing brightness was never the filter's to give back.
        ? 'filter1.cutoff tops out above the audible band, so a correction past it means the high content is not in the source at all: add it upstream at osc1.wavetable / osc1.morph, or with dist.drive (dist.enabled on), before touching the filter again.'
        : 'filter1.cutoff bottoms out below the fundamental, so a correction past it asks the filter to remove brightness that is not the filter\'s to remove: take it upstream at osc1.wavetable / osc1.morph, at dist.drive, or with eq.high_gain once eq.enabled is on.'

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
            paramIds: ['filter1.enabled', 'filter1.cutoff', 'filter1.type'],
            group: 'engage-filter1'
          },
          {
            error: m,
            // No zero-frame formula here, unlike the other gated pairs: a filter
            // ATTENUATES rather than adds, so the brightness measured with it
            // bypassed is the source's, and engaging it at cutoff F does not
            // land at `source * 2 ** -m`. A starting point, and it says so.
            finding: `Second half of the same move: filter1.cutoff ${dark ? 'up' : 'down'} ${n1(Math.abs(m))} octaves, inert until filter1.enabled is on. This one is a STARTING POINT rather than a landing: the ${n1(Math.abs(m))} octaves were measured with the filter out of circuit, and a filter subtracts from the source rather than setting the centroid, so expect to re-measure and move again.${clampNote(cutoffPlan, cutoffRemainder)}`,
            direction: dark ? 'increase' : 'decrease',
            confidence: 'low',
            suggested: cutoffPlan.suggested,
            paramIds: ['filter1.cutoff', 'filter1.enabled'],
            group: 'engage-filter1'
          }
        ]
      }
      return {
        error: m,
        finding: `${headline}${clampNote(cutoffPlan, cutoffRemainder)}`,
        direction: dark ? 'increase' : 'decrease',
        // Centroid octaves to cutoff octaves is about as direct as this gets,
        // but only once the windows agree that nothing is moving over time.
        confidence: corroborated ? 'high' : 'medium',
        suggested: cutoffPlan.suggested
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
    evaluate({ diff, patch, mods }) {
      // Gated rows dropped BEFORE first and last are read: a trend is the most
      // fragile thing you can compute off this array, since one hiss-derived
      // endpoint sets the whole slope. The `env2.decay` action that ranked first
      // off a five-octave phantom swing was exactly this.
      const windows = measuredBrightness(diff.brightness)
      if (windows.length < 2) return null
      const first = windows[0].octaveDelta
      const last = windows[windows.length - 1].octaveDelta
      if (!Number.isFinite(first) || !Number.isFinite(last)) return null
      const trend = last - first
      const tooFast = trend < 0
      // A DAMPED probe, not a fit. Even with the route in hand, inverting
      // "octaves of brightness drift" into "seconds of env2.decay" needs the
      // envelope curve and the filter slope too. So the honest step is a guess,
      // and the only thing worth engineering about a guess is that it
      // CONTRACTS: the old fixed 1.5x/÷1.5 pair is its own inverse, so a step
      // that overshoots is undone in full on the next round and the sequence
      // rings around the target forever. Scaling by the error relative to
      // `scale` gives 1.5x at the saturation point and 1.075x at the 0.3-octave
      // silence threshold, so successive overshoots shrink geometrically.
      const factor = dampedFactor(trend, BRIGHTNESS_TREND_SCALE, 0.5)
      const drift = `Brightness error drifts ${n1(Math.abs(trend))} octaves across the buffer (${n1(first)} in the first window, ${n1(last)} in the last), so the candidate ${tooFast ? 'darkens too fast' : 'holds its brightness too long'}${gatedWindowNote(diff.brightness, windows.length)}. This is envelope shape, not static cutoff`
      const state = routeState(mods, 'env2', 'filter1.cutoff')

      // No matrix was passed. Unchanged from before it could be: hedge in prose,
      // stay `low`, and do NOT report "there is no route" - nobody looked.
      if (!state.seen) {
        return {
          error: trend,
          finding: `${drift}: ${tooFast ? 'lengthen env2.decay / raise env2.sustain, or reduce' : 'shorten env2.decay / lower env2.sustain, or increase'} the depth of the env2 -> filter1.cutoff mod slot (set_modulation). That mod slot is the REAL fix and has no parameter id, so it can never appear as a suggested move; env2 reaches the sound through it and nothing else, and if the route does not exist in this patch then env2.decay is inert and set_modulation is the whole job. The direction above assumes that slot has POSITIVE depth, the usual wiring: this call passed no modulation matrix, so its sign is as unreadable from here as its existence, and with an inverted slot the same move lengthens the wrong stage. The suggested ${tooFast ? 'x' : '÷'}${round(factor, 2)} on env2.decay is a PROBE sized from the error, not a computed correction - apply it, re-measure, expect several rounds.`,
          direction: tooFast ? 'increase' : 'decrease',
          // The route may not exist, the step is a probe rather than a fit, and
          // the trend can also come from an amplitude decay that reweights the
          // windows. Three reasons for `low`.
          confidence: 'low',
          suggested: suggest(patch, 'env2.decay', from => (tooFast ? from * factor : from / factor))
        }
      }

      // The matrix was READ and env2 does not reach the cutoff. Every env2
      // parameter is inert, exactly the way `noise.level` is behind a bypassed
      // switch, so there is no move to make - the route is the whole job.
      if (!routeIsLive(state.route)) {
        const span = octavesPerUnitDepth('filter1.cutoff')
        const sustainDef = PARAM_BY_ID.get('env2.sustain')
        const sustain = patchRaw(patch, 'env2.sustain') ?? sustainDef?.def ?? 0.5
        // env2 falls from its peak to `sustain` across the decay, so a route of
        // signed depth D moves the cutoff by `D * (sustain - 1)` in normalized
        // units, i.e. `-D * swing * span` octaves. Setting that equal to the
        // `-trend` octaves the candidate is missing gives D directly, and the
        // sign falls out rather than being assumed: a candidate that needs to
        // BRIGHTEN over time wants a NEGATIVE depth, because env2 only ever
        // falls.
        const swing = 1 - sustain
        const wanted = span && swing > 0.02 ? round(trend / (swing * span), 3) : 0
        const depth = Math.min(1, Math.max(-1, wanted))
        const depthNote = depth !== wanted
          ? ` The arithmetic actually asks for depth ${wanted}, past the -1..1 a mod slot allows, so ${depth} is what a slot can hold and the remainder has to come from filter1.cutoff itself or a second route.`
          : ''
        const sustainNote = swing <= 0.02
          ? ` env2.sustain is ${round(sustain, 3)}, so env2 barely falls at all and no depth would produce a sweep: lower env2.sustain first, then set the route.`
          : ''
        const why = state.route === undefined
          ? 'this patch carries no env2 -> filter1.cutoff route at all'
          : state.route.enabled === false
            ? `this patch's env2 -> filter1.cutoff route is switched OFF (depth ${round(state.route.depth, 3)})`
            : `this patch's env2 -> filter1.cutoff route sits at depth ${round(state.route.depth, 3)}, under the ${MIN_MOD_DEPTH} it takes to move the cutoff even a tenth of an octave`
        return {
          error: trend,
          finding: `${drift}, and it is not env2.decay either: ${why}, so env2 reaches nothing and env2.decay / env2.sustain are INERT in this patch. The whole job is the route - set_modulation source=env2 destination=filter1.cutoff depth=${depth}${depth < 0 ? ' (NEGATIVE on purpose: env2 only falls, so a negative depth is what makes the cutoff RISE across the note, which is what this trend asks for)' : ' (positive, the usual downward filter sweep)'}.${depthNote}${sustainNote} A mod slot has no parameter id, so this can never be a suggested move and no move is offered here. The depth is a STARTING POINT sized from the ${n1(Math.abs(trend))} octaves measured and env2.sustain at ${round(sustain, 3)}: a cutoff and a spectral centroid do not move octave for octave, so create the route, re-measure, and shape env2.decay after that.`,
          // Which env2 stage to move is not decidable until the route exists,
          // and the action being recommended is not a parameter move at all.
          direction: 'either',
          // The diagnosis is READ off the matrix rather than guessed; only the
          // depth is a starting point.
          confidence: 'medium',
          paramIds: ['env2.decay', 'env2.sustain', 'filter1.cutoff']
        }
      }

      // A live route, and its SIGN decides the recommendation.
      //
      // With positive depth the cutoff follows env2 and sweeps DOWN as the
      // envelope falls, so a candidate that darkens too fast wants a longer
      // decay. With negative depth the cutoff runs AGAINST env2 and sweeps UP,
      // and the very same error wants a shorter one. The old prose assumed the
      // first and said so; reading the sign is cheap once the matrix is here.
      // `routeIsLive` already established this is a route; it is not a type
      // predicate (see its comment), so the depth is read defensively.
      const depth = state.route?.depth ?? 0
      const positive = depth > 0
      const lengthen = tooFast === positive
      // The signed-depth advice needs no such case split. The route contributes
      // `-D * swing * span` octaves of drift, monotonically DECREASING in D, so
      // "darkening too fast wants a smaller signed depth" holds for either sign
      // - going from +0.4 to +0.2, or from -0.2 to -0.4, are the same move.
      const depthDirection = tooFast ? 'DOWN' : 'UP'
      const move = planMove(patch, 'env2.decay', from => (lengthen ? from * factor : from / factor))
      return {
        error: trend,
        finding: `${drift}. The env2 -> filter1.cutoff route is live at depth ${round(depth, 3)}${positive ? '' : ' - NEGATIVE'}, so the cutoff ${positive ? 'follows env2 and sweeps DOWN as the envelope falls' : 'runs AGAINST env2 and sweeps UP as the envelope falls'}: ${lengthen ? 'LENGTHEN env2.decay / raise env2.sustain' : 'SHORTEN env2.decay / lower env2.sustain'}. ${positive ? '' : 'That is the opposite of the usual advice for this error, and it is the polarity of the route that makes it so. '}The other lever is the route itself: move its signed depth ${depthDirection} from ${round(depth, 3)} with set_modulation (source=env2, destination=filter1.cutoff) - ${depthDirection.toLowerCase()} is right for this error whichever sign the depth carries, since the depth scales a sweep that only ever runs one way. The suggested ${lengthen ? 'x' : '÷'}${round(factor, 2)} on env2.decay is a PROBE sized from the error, not a computed correction: the envelope curve and the filter slope are still unread, so apply it, re-measure, expect several rounds.${clampNote(move, `Take the rest from the route depth, or from env2.sustain.`)}`,
        direction: lengthen ? 'increase' : 'decrease',
        // The route and its polarity are now read rather than assumed, but the
        // step is still a probe and the trend can also come from an amplitude
        // decay reweighting the windows.
        confidence: 'medium',
        suggested: move.suggested
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
      // `filter-cutoff-static` owns this territory with better evidence. Counted
      // over the MEASURED rows: a trajectory whose windows all sat under the
      // noise gate is exactly the "unusable" this fallback exists for, and
      // counting the gated rows too would hand the territory to a rule that has
      // just refused it.
      if (measuredBrightness(diff.brightness).length >= 2) return null
      const upper = bandMean(diff.bands, 4000)
      if (upper === null) return null
      const quiet = upper < 0
      const headline = `Octave bands at and above 4 kHz are ${n1(Math.abs(upper))} dB ${quiet ? 'quiet' : 'loud'} against the reference, with no usable per-window brightness to say whether that is static or swept.`
      // `eq.high_gain` is +-18 dB and this rule fires from 3 dB up, so a shelf
      // asked to cover 25 dB of band error is an ordinary occurrence, not an
      // edge case.
      const gainPlan = planMove(patch, 'eq.high_gain', from => from - upper)
      const gainRemainder = `A single 4 kHz shelf spans 36 dB in total and this asks for more than is left: move filter1.cutoff ${quiet ? 'up' : 'down'} for the rest, or change the source at osc1.wavetable / osc1.morph.`

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
      const zeroFrameGain = planMove(patch, 'eq.high_gain', () => -upper)
      if (enable) {
        return [
          {
            error: upper,
            finding: `${headline} The EQ is bypassed (eq.enabled is 0), so eq.high_gain is inert until this switch is on - that is what this action is. On its own it also puts eq.low_gain and eq.mid_gain into circuit at whatever they are already holding, so it is a no-op only while all three sit at 0 dB; the companion action sets the high shelf, so apply both.`,
            direction: 'increase',
            confidence: 'high',
            suggested: enable,
            paramIds: ['eq.enabled', 'eq.high_gain', 'filter1.cutoff'],
            group: 'engage-eq'
          },
          {
            error: upper,
            // From an effective ZERO dB, not from where the knob rests: a
            // bypassed EQ applied none of the gain it is currently showing.
            finding: `Second half of the same move: eq.high_gain to ${signedNumber(legalFor('eq.high_gain', -upper))} dB, the whole error measured from a flat 0 dB - the bypassed EQ applied none of the gain it is currently showing. It takes effect only once eq.enabled is on. Filter cutoff is the other lever: a wide shelf and a cutoff move sound different even at the same band energy.${clampNote(zeroFrameGain, gainRemainder)}`,
            direction: quiet ? 'increase' : 'decrease',
            confidence: 'medium',
            suggested: zeroFrameGain.suggested,
            paramIds: ['eq.high_gain', 'eq.enabled', 'filter1.cutoff'],
            group: 'engage-eq'
          }
        ]
      }
      return {
        error: upper,
        finding: `${headline}${clampNote(gainPlan, gainRemainder)}`,
        direction: quiet ? 'increase' : 'decrease',
        confidence: 'medium',
        suggested: gainPlan.suggested
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
      const detunePlan = detuned
        ? planMove(patch, 'osc1.detune', from =>
          moreStretched ? from / factor : Math.max(from * factor, MIN_DETUNE_PROBE_CENTS))
        : {}
      return {
        error: d,
        finding: `Partial series is ${moreStretched ? 'more' : 'less'} stretched than the reference (B delta ${d.toExponential(1)}). Two causes read alike here: unison detune smearing each partial into a band, and a genuinely inharmonic series. ${detuned ? `osc1.unison is ${unison}, so ${moreStretched ? `narrow osc1.detune first (the suggested ÷${round(factor, 2)} is a PROBE sized from the error, not a computed correction)` : `widen osc1.detune first (the suggested x${round(factor, 2)} is a PROBE sized from the error, not a computed correction)`} and re-measure; expect several rounds` : unisonNote}.${clampNote(detunePlan, 'osc1.detune is 0..100 cents; past that the smear has to come from more osc1.unison voices, or the stretch is genuinely in the partial series and wants a different osc1.wavetable.')}`,
        direction: moreStretched ? 'decrease' : 'increase',
        // The measurement cannot separate the two causes, and the step is a
        // probe. Never above medium.
        confidence: detuned ? 'medium' : 'low',
        suggested: detunePlan.suggested,
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
      // env1.attack is in SECONDS (min 0.001, max 10); the delta is in ms.
      const plan = planMove(patch, 'env1.attack', from => from - d / 1000)
      return {
        error: d,
        finding: `Attack is ${n1(Math.abs(d))} ms too ${tooFast ? 'fast' : 'slow'}. env1 is the VCA, so this is its attack directly.${clampNote(plan, tooFast ? 'env1.attack tops out at 10 s; a longer rise wants env1.delay or env1.hold in front of it.' : 'env1.attack bottoms out at 1 ms, which is already effectively instant, so the remaining time-to-peak is env1.delay / env1.hold or the attack CURVE (env1.atk_curve), not the attack length.')}`,
        direction: tooFast ? 'increase' : 'decrease',
        // Measured attack time to env1.attack is one-to-one by definition.
        confidence: 'high',
        suggested: plan.suggested
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
      // env1.decay is in SECONDS; the delta is in ms.
      const plan = planMove(patch, 'env1.decay', from => from - d / 1000)
      return {
        error: d,
        finding: `-60 dB decay time is ${n1(Math.abs(d))} ms too ${tooShort ? 'short' : 'long'}. Move env1.decay first; if the note is held past the decay stage, env1.release carries the tail instead.${clampNote(plan, tooShort ? 'env1.decay stops at 10 s, so the rest of the tail belongs to env1.release (up to 15 s) or a higher env1.sustain.' : 'env1.decay stops at 1 ms, so a still-too-long T60 is coming from env1.sustain holding the level up or env1.release carrying the tail, not from the decay stage.')}`,
        direction: tooShort ? 'increase' : 'decrease',
        // T60 is shared between decay, sustain level and release, so applying
        // the whole delta to decay is an upper bound rather than a fit.
        confidence: 'medium',
        suggested: plan.suggested
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
      // A ratio has no purchase on zero: `0 * 10 ** x` is 0, `planMove` drops the
      // move as no change, and the finding was then describing a correction with
      // nothing attached to it. The delta is relative to each side's own peak,
      // so it cannot say what the level should BE — only that scaling cannot get
      // there from zero.
      const from = patchRaw(patch, 'env1.sustain')
      // env1.sustain is a LINEAR 0..1 level; convert the dB delta to a ratio.
      const plan = planMove(patch, 'env1.sustain', v => v * 10 ** (-d / 20))
      const zeroNote = tooLow && from !== undefined && from <= 0
        ? ' env1.sustain is at 0 and this correction is a RATIO, which cannot lift a level off zero - set env1.sustain directly from the reference (its decay clearly settles onto a sustain, this one does not) rather than scaling the current value.'
        // A sustain pinned at 1 with the reference still higher means the two
        // envelopes differ in DECAY, not in sustain: there is no headroom left
        // and the rest of the finding is not this parameter's to fix.
        : clampNote(plan, 'The rest is a decay difference rather than a sustain one - look at env1.decay and env1.dec_curve.')
      return {
        error: d,
        finding: `Sustain level is ${n1(Math.abs(d))} dB too ${tooLow ? 'low' : 'high'} relative to the peak.${zeroNote}`,
        direction: tooLow ? 'increase' : 'decrease',
        // sustainDb is sampled at 80% of the buffer, so a long decay still
        // colours it; the link is direct but not clean.
        confidence: 'medium',
        suggested: plan.suggested
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
      const levelPlan = planMove(patch, 'noise.level', from => from - d)
      const levelRemainder = tooNoisy
        ? 'noise.level bottoms out at 0, so the flatness left over is not the noise generator: look at dist.drive, dist.type Bitcrush, and filter1.resonance self-noise.'
        : 'noise.level tops out at 1, so the rest of the flatness has to come from elsewhere: a noisier noise.type, dist.drive with dist.enabled on, or a brighter osc1.wavetable region.'
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
          finding: `${headline}${clampNote(levelPlan, levelRemainder)}`,
          direction: 'decrease',
          // Flatness lumps together the noise generator, distortion and any
          // inharmonic partials. Directionally right, quantitatively crude.
          confidence: 'low',
          suggested: levelPlan.suggested,
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
          // From an effective ZERO, not from where the knob rests: the bypassed
          // generator put no noise in the buffer at all, so `from - d` would
          // charge the render for a level it never heard.
          const zeroFrameLevel = planMove(patch, 'noise.level', () => -d)
          return [
            {
              error: d,
              finding: `${headline} noise.enabled is off, and noise.level does nothing at all while it is - that is what this action switches on. On its own it adds the noise generator at whatever noise.level currently holds, which is nothing if that level is 0; the companion action sets it, so apply both.`,
              direction: 'increase',
              confidence: 'medium',
              suggested: enable,
              paramIds: ['noise.enabled', 'noise.level', 'noise.type'],
              group: 'engage-noise'
            },
            {
              error: d,
              finding: `Second half of the same move: noise.level to ${legalFor('noise.level', -d)}, the whole flatness gap measured from zero - the bypassed generator contributed none of the level it is currently showing. It is inert until noise.enabled is on. The 1:1 flatness-to-level mapping is a placeholder, so treat the amount as a starting point and re-measure. Also try a different noise.type: Pink sits under a tone where White sits on top of it.${clampNote(zeroFrameLevel, levelRemainder)}`,
              direction: 'increase',
              confidence: 'low',
              suggested: zeroFrameLevel.suggested,
              paramIds: ['noise.level', 'noise.type', 'noise.enabled'],
              group: 'engage-noise'
            }
          ]
        }
      }
      return {
        error: d,
        finding: `${headline}${noise === 'on' ? ' Also try a different noise.type: Pink sits under a tone where White sits on top of it.' : ''}${clampNote(levelPlan, levelRemainder)}`,
        direction: 'increase',
        confidence: 'low',
        suggested: levelPlan.suggested,
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
      const spreadPlan = planMove(patch, 'osc1.spread', from => from - d)
      const spreadRemainder = tooNarrow
        ? 'osc1.spread tops out at 1, so the rest of the width has to come from more osc1.unison voices, more osc1.detune, or chorus.mix / reverb.width downstream.'
        : 'osc1.spread bottoms out at 0, which is fully mono at the oscillator, so the remaining width is downstream: chorus.mix, reverb.width, or an off-centre osc1.pan.'
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
          // From an effective ZERO, not from where the knob rests: with one
          // voice the spread was multiplied by zero, so the render carried none
          // of the width the knob is currently showing.
          const zeroFrameSpread = planMove(patch, 'osc1.spread', () => -d)
          return [
            {
              error: d,
              finding: `${headline} osc1.unison is 1, and a single voice multiplies both osc1.spread and osc1.detune by zero - they do nothing at all until this action raises unison to ${MIN_SPREADING_UNISON}. Unison is audible in its own right, not just in the stereo field: ${MIN_SPREADING_UNISON} voices at osc1.detune thickens the tone as well as widening it. The companion action then sets the spread.`,
              direction: 'increase',
              confidence: 'medium',
              suggested: unisonMove,
              group: 'engage-unison'
            },
            {
              error: d,
              finding: `Second half of the same move: osc1.spread to ${legalFor('osc1.spread', -d)}, the whole width gap measured from zero - a single voice multiplied the spread it is currently showing by zero. Inert until osc1.unison is above 1. Widen at the source like this before reaching for chorus.mix or reverb.width, which also change the timbre.${clampNote(zeroFrameSpread, spreadRemainder)}`,
              direction: 'increase',
              confidence: 'medium',
              suggested: zeroFrameSpread.suggested,
              paramIds: ['osc1.spread', 'osc1.detune', 'osc1.unison'],
              group: 'engage-unison'
            }
          ]
        }
      }
      return {
        error: d,
        finding: `${headline} ${tooNarrow ? 'Widen at the source first - osc1.unison above 1 with osc1.detune and osc1.spread - before reaching for chorus.mix or reverb.width, which also change the timbre' : 'Narrow osc1.spread and osc1.detune first; pulling chorus.mix or reverb.width down also removes body'}.${clampNote(spreadPlan, spreadRemainder)}`,
        direction: tooNarrow ? 'increase' : 'decrease',
        confidence: 'medium',
        suggested: spreadPlan.suggested
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
      // One gain, used by both the clip note and the suggestion. Spelling the
      // formula out twice is how the finding and the value drift apart.
      const gain = 10 ** (-d / 20)
      const plan = planMove(patch, 'master.volume', v => v * gain)
      // Clamping is not the live-lock the enable-gated rules had — the clamped
      // move still shifts loudness the right way, it just stops short — but the
      // finding used to describe a correction bigger than the move without
      // saying by how much. `clampNote` names the computed gain and the limit;
      // this adds the one thing a linear amplitude cannot show, which is how
      // many dB of the error the clamped move fails to deliver.
      const shortfall = plan.clamped && plan.clamped.computed > 0 && plan.clamped.limit > 0
        ? `, ${n1(Math.abs(20 * Math.log10(plan.clamped.computed / plan.clamped.limit)))} dB short of the ${n1(Math.abs(d))} dB asked for`
        : ''
      return {
        error: d,
        finding: `Gated loudness is ${n1(Math.abs(d))} dB ${quiet ? 'below' : 'above'} the reference.${clampNote(plan, 'Take the rest from oscillator levels or comp.makeup (itself inert unless comp.enabled is on).', shortfall)}`,
        direction: quiet ? 'increase' : 'decrease',
        // A gain change moves gated loudness by exactly that gain (R128's
        // relative gate), so this one really is one-to-one.
        confidence: 'high',
        suggested: plan.suggested
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
 * How much of a stated gain the advisor is prepared to bank on, per confidence
 * step. One 0.6 discount per step DOWN the `high`/`medium`/`low` ladder.
 *
 * These are priors, not measurements — nothing here is calibrated against
 * `compareAudioMetrics` — and 0.6 was chosen for the exchange rate it implies
 * rather than fitted: a `low` action must promise about 2.8x the raw gain of a
 * `medium` one to outrank it, and a `medium` about 1.7x a `high` one. The
 * previous rule, "rank on raw gain", is the special case where every confidence
 * step is worth 1.0, which is how a low-confidence Env 2 recommendation for a
 * route that did not exist came to sit above several usable moves.
 */
const CONFIDENCE_FACTOR: Readonly<Record<MatchAction['confidence'], number>> = {
  high: 1,
  medium: 0.6,
  low: 0.36
}

/**
 * Two values this close are the same value.
 *
 * Every `suggested` has already been through `round(_, 6)`, so anything below
 * the sixth decimal is rounding residue rather than a move.
 */
const NO_OP_EPSILON = 1e-9

/**
 * `MatchAction` plus the atomicity marker.
 *
 * `MatchAction` lives in `match-types.ts`, a shared contract this module only
 * consumes, so `group` is added by EXTENSION here rather than by widening that
 * type. A `GroupedMatchAction[]` is a `MatchAction[]`, so every existing caller
 * and every existing field keeps working and the marker survives serialization
 * — a caller that knows about groups can read it, one that does not is
 * unaffected. Promoting `group?: string` into `MatchAction` itself is the
 * one-line change that would make it first-class in the contract.
 */
export interface GroupedMatchAction extends MatchAction {
  /**
   * Actions sharing this id are ATOMIC: apply all of them or none. The ranked
   * list keeps them adjacent and a `maxActions` cut never lands inside one, so
   * a group can be handed to `apply_patch` as a single change.
   */
  group?: string
}

/**
 * Turn a measured diff into ranked parameter moves.
 *
 * Returns `[]` when nothing crosses its rule's `minError` - an empty list means
 * "no dimension is measurably wrong", and is more useful than five padded
 * actions about noise-floor differences.
 *
 * Ordering is by `estimatedGain`, which is expected value: the raw gain
 * discounted by confidence. See the module header for what that buys and what
 * it is not.
 */
export function adviseFromDiff(
  diff: MatchDiff,
  currentPatch: PatchValues,
  options?: AdviseOptions
): GroupedMatchAction[] {
  const maxActions = Math.max(0, Math.trunc(options?.maxActions ?? 5))
  if (maxActions === 0) return []
  const focus = options?.focus
  const ctx: AdviceContext = { diff, patch: currentPatch ?? {}, ...(options?.mods ? { mods: options.mods } : {}) }

  const actions: GroupedMatchAction[] = []
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
    const firing = (Array.isArray(outcome) ? outcome : [outcome])
      .filter(one => Number.isFinite(Math.abs(one.error)) && Math.abs(one.error) >= rule.minError)
    if (firing.length === 0) continue
    // ONE gain for the whole firing. Its outcomes are halves of one correction,
    // so ranking them apart lets an unrelated action land between them; and an
    // atomic pair is only as trustworthy as its least confident half, which is
    // why the factor is the MINIMUM rather than the mean. Each action still
    // reports its own `confidence`.
    const magnitude = Math.max(...firing.map(one => Math.abs(one.error)))
    const factor = Math.min(...firing.map(one => CONFIDENCE_FACTOR[one.confidence]))
    const estimatedGain = round(rule.weight * Math.min(1, magnitude / rule.scale) * factor, 4)
    for (const one of firing) {
      // A `suggested` whose `to` is its `from` renders identical audio, earns
      // identical advice next round, and costs a ranked slot to say nothing.
      // `planMove` already drops those, so this is the invariant rather than the
      // fix: it holds for a rule that builds a `suggested` by hand, or that
      // grows a path around `planMove` later. The finding SURVIVES - an
      // advisory with no move is legitimate, and several rules exist only to
      // give one - it is the empty move that goes.
      const move = one.suggested
      const noop = move !== undefined && Math.abs(move.to - move.from) < NO_OP_EPSILON
      actions.push({
        finding: one.finding,
        paramIds: [...(one.paramIds ?? rule.paramIds)],
        direction: one.direction,
        ...(move && !noop ? { suggested: move } : {}),
        estimatedGain,
        confidence: one.confidence,
        ...(one.group ? { group: `${rule.id}:${one.group}` } : {})
      })
    }
  }

  // Array.prototype.sort is stable, so equal gains keep table order — which is
  // what keeps a firing's outcomes adjacent, since they share a gain.
  actions.sort((a, b) => b.estimatedGain - a.estimatedGain)
  return takeWholeGroups(actions, maxActions)
}

/**
 * Cut the ranked list to `limit` without ever splitting a group.
 *
 * A group that does not fit in what is left is SKIPPED rather than truncated,
 * and the walk continues, so a smaller action behind it can use the slots. Half
 * a group is worse than none of it: `dist.enabled` on its own is an uncontrolled
 * timbre change, and `dist.drive` on its own is nothing at all — which is why
 * the findings have always said "apply both or neither" and why saying it in
 * prose was not enough.
 */
function takeWholeGroups(actions: readonly GroupedMatchAction[], limit: number): GroupedMatchAction[] {
  const sizes = new Map<string, number>()
  for (const action of actions) {
    if (action.group) sizes.set(action.group, (sizes.get(action.group) ?? 0) + 1)
  }
  const out: GroupedMatchAction[] = []
  // The FIRST member met decides for the whole group, and the decision is then
  // remembered. Re-asking per member is what splits one: the first member has
  // already spent a slot by the time the second is tested, so a pair that fit
  // when it was admitted no longer "fits" on the way in behind itself.
  const admitted = new Set<string>()
  const skipped = new Set<string>()
  for (const action of actions) {
    if (action.group && admitted.has(action.group)) {
      out.push(action)
      continue
    }
    if (out.length >= limit) break
    if (!action.group) {
      out.push(action)
      continue
    }
    if (skipped.has(action.group)) continue
    if ((sizes.get(action.group) ?? 1) > limit - out.length) {
      skipped.add(action.group)
      continue
    }
    admitted.add(action.group)
    out.push(action)
  }
  return out
}
