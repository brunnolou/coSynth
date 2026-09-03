import { RECENT_AUDIO_SECONDS, type PresetData, type RecentAudio, type RecordedAudio, type SynthEngine } from '../audio/engine'
import { agentActivityFor } from './activity'
import {
  PARAMS, PARAM_GROUP_NOTES, defaultNorm, formatValue, normToValue, paramDef, paramIndex, valueToNorm,
  type ParamDef
} from '../shared/params'
import { FX_IDS, MAX_MOD_SLOTS, MOD_SOURCES, modSourceIndex, type FxId, type ModSlotState, type ModSourceDef } from '../shared/messages'
import { describeMidi, toMidi, type NoteInput } from '../shared/note-input'
import { midiToHz } from '../shared/notes'
import { FACTORY_PRESETS, getFactoryPreset, listFactoryPresetNames } from '../shared/factory-presets'
import { analyzeAudio, compareAudioMetrics, type AnalyzeAudioOptions, type AudioMetrics, type AudioMetricsComparison } from '../shared/audio-analysis'
import { diffAudioMetrics } from '../shared/match-diff'
import { adviseFromDiff, type AdviceCategory, type ModRoute, type PatchValues } from '../shared/match-advice'
import { formatDiff, formatMetrics } from '../shared/metrics-format'
import type { MatchDiff } from '../shared/match-types'
import {
  currentPresetState, deletePreset, factoryDeleteRefusal, listPresets, loadPreset, markPresetLoaded,
  presetFileName, savePreset, serializePreset, validatePresetName, type PresetSource
} from '../shared/preset-store'
import { decodeBase64Audio, MAX_AUDIO_BASE64_CHARACTERS, normalizeAudioMimeType } from './audio-input'
import { analyzeAudioAbortably } from './audio-analysis-task'
import { offlineRenderAvailable, renderOffline, type OfflineRenderer } from './offline-render'
import { PerformanceManager, performNotes, assertNotesAvailable, validatePerformanceNotes } from '../history/performance'
import type { ReplayStore } from '../history/replays'

const MAX_NOTES = 128
const MAX_PLAY_SECONDS = 30
const MAX_RENDER_SECONDS = 15
const MAX_QUERY_LENGTH = 100
const MAX_REFERENCE_NAME_LENGTH = 255
const MAX_MIME_TYPE_LENGTH = 127
const MAX_PAGE_SIZE = 60
const COMPACT_PAGE_SIZE = PARAMS.length
const DEFAULT_PAGE_SIZE = 5
const PARAMETER_GROUPS = [...new Set(PARAMS.map(def => def.group))]
/** Derived at module load so the vocabulary in errors and descriptions cannot drift from `MOD_SOURCES`. */
const MOD_SOURCE_IDS = MOD_SOURCES.map(source => source.id)

/** Filtering advice belongs on the property an agent is filling in, not in the prose. */
const GROUP_PROPERTY_DESCRIPTION = 'Exact group id from `groups`, case-insensitive; an unknown name is an error.'
const SEARCH_PROPERTY_DESCRIPTION = 'Case-insensitive substring over parameter id, name, and group.'
/**
 * The discovery tool's own filters, where an evaluated agent decided to call
 * five times - one group per call - for what one unfiltered compact call
 * returns. `format: 'compact'` reads as a formatting flag, so the "one call
 * gets everything" property has to be stated here, not only in the prose.
 */
const GROUP_FILTER_DESCRIPTION = `Exact group id from \`groups\`, case-insensitive; an unknown name is an error, not an empty page. Groups are per instance (\`filter1\`, \`filter2\`, \`env1\`..\`env6\`), so \`filter\` is only the routing group. Usually skip it: omit \`group\` and \`search\`, and one call with \`format: "compact"\` returns all ${PARAMS.length} parameters.`
const SEARCH_FILTER_DESCRIPTION = `Case-insensitive substring over parameter id, name, and group; unlike \`group\` it spans instances (\`filter\` matches every filter1/filter2 parameter). Omit it too and one call with \`format: "compact"\` returns all ${PARAMS.length}.`

type Input = Record<string, unknown>
type DecodeAudio = typeof decodeBase64Audio

export interface WebMcpToolDependencies {
  decodeAudio?: DecodeAudio
  analyzeAudioAsync?: typeof analyzeAudioAbortably
  /**
   * Renders a note sequence without the live graph. Defaults to
   * `renderOffline()` when this browser has `OfflineAudioContext` and the
   * AudioWorklet; injected the same way as `decodeAudio` in tests.
   */
  renderOffline?: OfflineRenderer
  performance?: PerformanceManager
  replays?: ReplayStore
  currentSoundEntryId?: () => string
  onComparison?: (comparison: AudioMetricsComparison, soundEntryId?: string) => void
}

interface ReferenceAnalysis {
  source: 'base64-reference'
  name?: string
  mimeType?: string
  decodedBytes: number
  duration: number
  sampleRate: number
  /**
   * The rate in the uploaded file's own RIFF/WAVE `fmt ` header, when it had
   * one. Present alongside `sampleRate` — the rate the browser decoded it TO —
   * because `decodeAudioData` resamples to its context's rate without a word.
   */
  sourceSampleRate?: number
  /** Set only when the decode resampled DOWN; see `downsampleNote`. */
  downsampled?: { from: number; to: number; nyquistHz: number; note: string }
  channels: number
  /** Present only when a trim was applied, so an untrimmed reference reads exactly as before. */
  trimmedMs?: { start: number; end: number }
  metrics: AudioMetrics
}

/**
 * Running best-so-far for one matching problem, i.e. one reference. Held per
 * session because `compare_audio` used to return only the current figure: in
 * the match eval an agent peaked at 0.847 on comparison 14, spent 13 more
 * comparisons and ~40 calls never beating it, then saved the final 0.819. It
 * had no way to know it had already peaked without remembering 27 numbers
 * itself. Bound to the reference object so a new `analyze_reference_audio` —
 * a different matching problem — starts a fresh best rather than carrying a
 * figure earned against another target.
 */
interface MatchProgressState {
  reference: ReferenceAnalysis
  comparisons: number
  best: number
  bestComparison: number
  bestEntryId?: string
}

/**
 * The last comparison, kept so `suggest_patch` can re-read it without a render.
 * Only the diff and the two labels the text header needs; the metrics
 * themselves already live on `lastReference` and `lastRender`.
 */
interface LastComparisonState {
  diff: MatchDiff
  referenceName?: string
  comparisonNumber: number
  /**
   * How many ranked moves that `compare_audio` already handed back in
   * `diff.actions`. The one number that decides whether a `suggest_patch` call
   * on an unchanged patch, with no `focus`, could return anything the caller did
   * not already hold — see `basedOn.addsNothing`.
   */
  maxActions: number
  /**
   * The sound-history entry the compared candidate was made from, as
   * `apply_patch` records it for `rollbackId`. Every patch edit commits a new
   * entry, so `suggest_patch` comparing this against the current id is asking
   * exactly "is the diff still about the sound that is loaded?" — and an undo
   * back to the compared sound restores its own id, so returning to it counts
   * as unchanged rather than as another change.
   *
   * Absent when the page runs without history services (`currentSoundEntryId`
   * is optional), in which case staleness is unknowable and is not claimed.
   */
  soundEntryId?: string
}

interface WebMcpSessionState {
  lastRender: { metrics: AudioMetrics; sampleRate: number; channels: number; url: string; soundEntryId?: string } | null
  lastReference: ReferenceAnalysis | null
  /**
   * The reference's decoded PCM, held apart from `lastReference` so it can
   * never reach the model: `compare_audio` returns `lastReference` whole, and a
   * 30 s stereo buffer serialised into JSON would end a session. One reference
   * at a time (~11.5 MB for that same buffer), replaced on every upload, so an
   * agent can re-analyse at a corrected `f0Hz` or a higher `windows` count
   * without re-sending up to 16 MiB of Base64.
   */
  referencePcm: { channelData: Float32Array[]; sampleRate: number } | null
  referenceGeneration: number
  activeReferenceController: AbortController | null
  match: MatchProgressState | null
  lastComparison: LastComparisonState | null
  performance: PerformanceManager
}

const sessions = new WeakMap<SynthEngine, WebMcpSessionState>()

function sessionFor(engine: SynthEngine): WebMcpSessionState {
  let session = sessions.get(engine)
  if (!session) {
    session = {
      lastRender: null,
      lastReference: null,
      referencePcm: null,
      referenceGeneration: 0,
      activeReferenceController: null,
      match: null,
      lastComparison: null,
      performance: new PerformanceManager()
    }
    sessions.set(engine, session)
  }
  return session
}

function accepted(allowed: readonly string[]): string {
  return allowed.length === 0 ? 'Accepted: (no properties)' : `Accepted: ${allowed.join(', ')}`
}

function assertObject(value: unknown, label: string, allowed: readonly string[], required: readonly string[] = []): Input {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const input = value as Input
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new Error(`Unexpected ${label} property '${key}'. ${accepted(allowed)}`)
  }
  for (const key of required) {
    if (!(key in input)) throw new Error(`${label}.${key} is required. Required: ${required.join(', ')}. ${accepted(allowed)}`)
  }
  return input
}

/** Edit distance capped at `limit`; returns limit + 1 once the budget is exceeded. */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        previous[j] + 1,
        row[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
    if (Math.min(...row) > limit) return limit + 1
    previous = row
  }
  return previous[b.length]
}

/** Up to three near candidates: prefix matches first, then edit distance <= 2. */
function suggest(id: string, candidates: readonly string[], max = 3): string[] {
  const needle = id.toLowerCase()
  const prefix = candidates.filter(candidate => candidate.toLowerCase().startsWith(needle))
  const near = candidates
    .filter(candidate => !prefix.includes(candidate))
    .map(candidate => ({ candidate, distance: editDistance(needle, candidate.toLowerCase(), 2) }))
    .filter(entry => entry.distance <= 2)
    .sort((a, b) => a.distance - b.distance)
    .map(entry => entry.candidate)
  return [...prefix, ...near].slice(0, max)
}

function didYouMean(id: string, candidates: readonly string[]): string {
  const matches = suggest(id, candidates)
  return matches.length === 0 ? '' : ` Did you mean ${matches.join(', ')}?`
}

/** How `update`/`remove` may name a route; repeated in every addressing error. */
const ROUTE_ADDRESSING = 'Address an existing route either by `slot`, or by the same `source`+`destination` pair you added it with.'

/** A modulation source id to its index, with suggestions on any action. */
function assertModSource(value: unknown): number {
  if (typeof value !== 'string') throw new Error('source must be a string')
  try { return modSourceIndex(value) } catch {
    throw new Error(`Unknown modulation source '${value}'.${didYouMean(value, MOD_SOURCE_IDS)} Valid: ${MOD_SOURCE_IDS.join(', ')}`)
  }
}

/** A destination parameter id to its index; only moddable ids are routable. */
function assertModDestination(value: unknown): number {
  if (typeof value !== 'string') throw new Error('destination must be a string')
  const def = PARAMS.find(candidate => candidate.id === value)
  if (!def) {
    const moddable = PARAMS.filter(candidate => candidate.moddable).map(candidate => candidate.id)
    throw new Error(`Unknown modulation destination '${value}'.${didYouMean(value, moddable)} Destinations are moddable parameter ids; groups: ${PARAMETER_GROUPS.join(', ')}`)
  }
  if (!def.moddable) throw new Error(`Destination is not moddable: ${def.id}`)
  return paramIndex(def.id)
}

function assertModSlot(value: unknown): number {
  const slot = finite(value, 'slot')
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_MOD_SLOTS) throw new Error(`slot must be an integer in range 0..${MAX_MOD_SLOTS - 1}`)
  return slot
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return value
}

function clean(value: number): number {
  return Math.round(value * 1e8) / 1e8
}

function parameterValue(def: ParamDef, normalized: number) {
  return {
    raw: clean(normToValue(def, normalized)),
    normalized: clean(normalized),
    formatted: formatValue(def, normalized)
  }
}

/** One parameter as a single line: `filter1.cutoff Hz 20..20000 exp =8000 mod`. */
function compactParameter(def: ParamDef): string {
  const parts = [def.id]
  if (def.unit) parts.push(def.unit)
  if (def.choices) parts.push(`{${def.choices.join('|')}}`)
  else {
    parts.push(`${def.min}..${def.max}`)
    if (def.curve === 'exp') parts.push('exp')
    if (def.step !== undefined) parts.push(`step${def.step}`)
  }
  parts.push(`=${def.def}`)
  if (def.moddable === true) parts.push('mod')
  return parts.join(' ')
}

/**
 * The interpretation a metric needs at the point its number is read.
 *
 * These sentences used to sit in the `render_audio` and `analyze_audio`
 * descriptions, where they made the tool listing too big for a client to read
 * whole — a discoverability eval truncated the listing and lost `play_notes`
 * altogether. Each fact stays where an agent actually meets the number: in the
 * response that carries it, as `metricNotes`.
 */
const METRIC_NOTES = {
  peakDb: 'An instantaneous peak — use `loudnessDb` or `rmsDb` to compare levels.',
  pitch: '`source: "given"` when you passed `f0Hz`, `"detected"` when it was measured here; `null` means nothing periodic was found and every harmonic field is then absent rather than invented. Below `confidence` 0.5 the partials are untrustworthy.',
  harmonicShape: '`amplitudesDbRelF0`: 12 partials in dB relative to the FUNDAMENTAL, so two sounds compare even when their loudest partial is a different n (`harmonics.amplitudesDb` stays relative to the loudest). `tiltDbPerOctave` positive is brighter; `oddEvenDb` is mean(odd) - mean(even), high for square/pulse, near 0 for saw. -120 dB means "not measured".',
  decayT60Ms: "Measured from the rendered tail, not read back from `env1.decay`: the note's own `duration` and `env1.release` shape that tail, so the same patch reports a different T60 over a longer note. It is `null` — its most common value on short notes — whenever the buffer never falls the 20 dB the slope fit needs, or falls too abruptly for the envelope to resolve."
} as const

/**
 * A peak this low is digital silence: `analyzeAudio` floors an all-zero buffer
 * at -160 dB, and nothing audible sits below -100 dB.
 */
const SILENT_PEAK_DB = -100

/**
 * `spectralFlatness` (0 tonal, 1 noise) at or above which a buffer is called
 * noise-dominated. A synth tone sits near 0.05 even with a bright filter; white
 * noise reads well past this. Deliberately a loose threshold: it is quoted as
 * evidence in prose, never used to score anything.
 */
const NOISE_LIKE_FLATNESS = 0.3

/**
 * `stereoWidth` at or above which the mono sum has cancelled far enough for
 * `detectPitch` to abandon it and retry the channels one at a time. Its own
 * `COLLAPSE_RATIO` of 0.25 fires when midRms < 0.25 * the loudest channel, which
 * for equal-level channels is midRms/sideRms < ~0.26 — i.e. this width.
 */
const ANTI_PHASE_STEREO_WIDTH = 0.8

/**
 * Everything `pitchNoteFor` reads. Narrower than `AudioMetrics` on purpose: text
 * mode's `summarizeAnalysis` drops three arrays, and the note has to attach to
 * that shape too.
 */
type PitchNoteMetrics = Pick<AudioMetrics, 'peakDb' | 'clippingCount' | 'spectralFlatness' | 'stereoWidth' | 'pitch'>

/** What `detectPitch` demands before it will name a fundamental; quoted in `pitchNoteFor`. */
const PITCH_GUARDS =
  'Detection refuses rather than guesses: two detectors must agree within 50 cents, inside 16.35 Hz to 5 kHz, at clarity 0.85 or better, over at least 1024 samples (~23 ms at 44.1 kHz).'

/**
 * Why `metrics.pitch` is `null`, as far as the numbers beside it can say.
 *
 * From the tool layer every refusal in `detectPitch` looks identical — too short
 * a buffer, every frame under the clarity guard, every frame outside the range
 * guard, the two detectors never agreeing, a collapsed anti-phase sum — and in
 * eval run 4 that cost an agent two round trips: a +12 dB EQ boost killed
 * detection, it blamed clipping, fixed the gain, detection still failed, and only
 * then did it suspect the EQ.
 *
 * `detectPitch`'s signature cannot say which guard fired, but `peakDb`,
 * `clippingCount`, `spectralFlatness` and `stereoWidth` are all right here and
 * they separate "silent", "clipped", "noise-like" and "near anti-phase" from "a
 * perfectly ordinary-looking buffer with no fundamental in it". So the note
 * states the evidence it actually has, then lists the causes it CANNOT
 * distinguish as causes rather than as a diagnosis. It never names one cause it
 * has not measured.
 */
function pitchNoteFor(metrics: PitchNoteMetrics): string | undefined {
  if (metrics.pitch !== null && metrics.pitch !== undefined) return undefined
  if (metrics.peakDb <= SILENT_PEAK_DB) {
    return `No fundamental was found because there is nothing to find: peakDb ${clean(metrics.peakDb)} is digital silence. Every other metric here is measured on that silence and describes nothing.`
  }
  const evidence: string[] = []
  if (metrics.clippingCount > 0) {
    evidence.push(`clippingCount ${metrics.clippingCount}: samples are at or past full scale, and a flat-topped waveform is broadband enough to stop the two detectors agreeing. Cut the level — a large EQ or amp boost is the usual cause — and measure again.`)
  }
  if (metrics.spectralFlatness >= NOISE_LIKE_FLATNESS) {
    evidence.push(`spectralFlatness ${clean(metrics.spectralFlatness)} of 1: this buffer reads as noise rather than a tone, and noise has no fundamental to find.`)
  }
  if (metrics.stereoWidth >= ANTI_PHASE_STEREO_WIDTH) {
    evidence.push(`stereoWidth ${clean(metrics.stereoWidth)} of 1: the channels are near anti-phase. Detection already retries them one at a time when the mono sum cancels, so this alone rarely explains a null — but a heavily detuned unison or a deep chorus can genuinely hold no one stable fundamental.`)
  }
  if (evidence.length === 0) {
    evidence.push(`peakDb ${clean(metrics.peakDb)}, no clipping, spectralFlatness ${clean(metrics.spectralFlatness)} and stereoWidth ${clean(metrics.stereoWidth)} all look ordinary, so nothing measured here points at a cause.`)
  }
  return `No fundamental was found, so \`pitch\` is null and \`harmonics\`/\`harmonicShape\` are absent, and \`diff.pitch.centsError\` with them. On a CANDIDATE measured against a pitched reference, compare_audio treats that as a measured failure and scores \`harmonics\`, \`tilt\` and \`inharmonicity\` 0, so it costs real similarity; on the REFERENCE side those three are excluded from the mean. ${PITCH_GUARDS} Evidence here — ${evidence.join(' ')} Causes it cannot tell apart: a fundamental buried under a louder partial (a resonant filter or EQ band boosted far above it does this at a perfectly safe level), a pitch moving inside the analysis window (vibrato, a fast pitch envelope, portamento), a note outside 16.35-5000 Hz, or a buffer under 1024 samples. To score the partials against a fundamental you name, pass \`f0Hz\` to analyze_audio (source "scope", "recent" or "reference"); a render's PCM is not retained, so re-render to retry.`
}

/** `pitchNoteFor` attached to any result that carries metrics, and only when there is one to attach. */
function withPitchNote<T extends { metrics: PitchNoteMetrics }>(result: T): T & { pitchNote?: string } {
  const pitchNote = pitchNoteFor(result.metrics)
  return pitchNote === undefined ? result : { ...result, pitchNote }
}

/**
 * A reference whose file was resampled DOWN on the way in, and what that costs.
 *
 * `decodeAudioData` resamples to its context's rate silently. Playwright's
 * Chromium reports a 16 kHz output device, and before `audio-input.ts` pinned an
 * explicit rate a 44.1 kHz reference was decoded at 16 kHz: everything above its
 * 8 kHz Nyquist read as empty, the candidate rendered at 48 kHz read real energy
 * there, and a live eval agent spent a whole comparison proving it could not
 * close a 75 dB gap that was never in the sound. A residual low-rate context is
 * still reachable on hardware that refuses 48 kHz, so this is not merely
 * historical.
 *
 * The point is the distinction: "the reference genuinely has no high content"
 * and "the reference's high content was discarded before I saw it" look
 * identical in every band figure and lead to opposite edits.
 */
function downsampleNote(sourceSampleRate: number | undefined, sampleRate: number) {
  if (sourceSampleRate === undefined || !(sourceSampleRate > sampleRate)) return undefined
  const nyquistHz = Math.round(sampleRate / 2)
  return {
    downsampled: {
      from: sourceSampleRate,
      to: sampleRate,
      nyquistHz,
      note: `The uploaded file says ${sourceSampleRate} Hz and the browser decoded it at ${sampleRate} Hz, so everything above ${nyquistHz} Hz was resampled away BEFORE any of these metrics were measured. The top bands, \`spectralRolloffHz\` and the upper partials therefore describe a truncated file, and a candidate rendered at a higher rate will show real energy up there that the reference cannot match however the patch is edited. Treat that gap as an artefact of the decode, not as brightness to remove.`
    }
  }
}

/**
 * Two sides measured at different rates, said out loud in the comparison itself.
 *
 * Every band, rolloff and partial above the LOWER Nyquist is incomparable: one
 * side can hold energy there and the other cannot, whatever the patch does. That
 * is the 75 dB error an eval agent could not diagnose, and `downsampled` on the
 * reference only explains it when the decode was the cause — a candidate
 * rendered at a rate the reference never had produces the same asymmetry with no
 * downsample anywhere. So it is reported from the two rates in hand.
 *
 * Surfacing only: the scoring side of this lives in `compareAudioMetrics`.
 */
function sampleRateMismatch(reference: ReferenceAnalysis, candidateSampleRate: number) {
  if (reference.sampleRate === candidateSampleRate) return {}
  const lower = Math.min(reference.sampleRate, candidateSampleRate)
  const quieter = reference.sampleRate < candidateSampleRate ? 'reference' : 'candidate'
  return {
    sampleRates: {
      reference: reference.sampleRate,
      candidate: candidateSampleRate,
      comparableBelowHz: Math.round(lower / 2),
      note: `These two were measured at different rates, so nothing above ${Math.round(lower / 2)} Hz — the ${quieter}'s Nyquist — is comparable: the ${quieter} cannot carry energy there at all, and no edit to the patch changes that.${reference.downsampled ? ' The reference reached this rate through a decode that resampled it DOWN; see `reference.downsampled`.' : ''} Read the top bands, \`spectralRolloffHz\` and the upper partials with that in mind.`
    }
  }
}

/** Refusal text for `compare_audio` with no render and a silent live scope. */
const SILENT_CANDIDATE_REFUSAL =
  'Nothing has been rendered yet and the live scope is silent (peak below -100 dB), so there is nothing to compare the reference against; scoring it against silence would return a similarity that means nothing. Call render_audio first — it renders offline and needs no user gesture — then call compare_audio again. The scope fallback is only for comparing against a human who is actually playing.'

/** Comparisons without a new best after which a run is flatly called a plateau. */
const PLATEAU_COMPARISONS = 5

const roundSimilarity = (value: number): number => Math.round(value * 1e4) / 1e4

/**
 * Where this comparison stands against the best so far. `worse` is decided by
 * `deltaFromBest` and nothing else, so the verdict and the number cannot
 * disagree; `best` and `tied` differ only in whether THIS comparison is the one
 * that set the best, which no single delta can express.
 */
type MatchStanding = 'best' | 'tied' | 'worse'

/**
 * Fold one comparison into the session's best-so-far and describe where it
 * stands. Returned alongside `comparison` (never inside it — `similarity` and
 * `details` keep their shape for the UI) so a single response answers "better,
 * worse, or done" without the agent keeping its own ledger.
 *
 * ## Why a tie is not "worse", and why the tolerance is the reported precision
 *
 * In eval run 4 an agent's final comparison scored 0.81727124416943 — byte
 * identical to comparison 23's best — and a `similarity > state.best` test
 * called it WORSE. The label was the small part of the damage: the "worse"
 * branch also emits remediation, so the agent was told to restore history away
 * from its own best patch and warned that `save_preset` would save the wrong
 * one. Both false, and both acted on. A wrong number an agent trusts is the
 * defect `SILENT_CANDIDATE_REFUSAL` exists to refuse; wrong ADVICE derived from
 * one is the same defect with a shorter fuse.
 *
 * So the standing is derived from `deltaFromBest` rather than computed beside
 * it — the two used to be independent expressions over the same numbers, which
 * is exactly how `deltaFromBest: 0` came to sit under "Worse than comparison
 * 23". Now: `deltaFromBest < 0` IS `worse`, `deltaFromBest === 0` IS `best` or
 * `tied`, and no branch can disagree with the number printed beside it.
 *
 * The delta is rounded by `roundSimilarity` — 1e-4, the precision every score in
 * this block is reported at — before it decides anything. That IS the tolerance,
 * and it is deliberately not a new magic epsilon: it makes the message consistent
 * with the response *by construction*. Two renders of one patch differ in the last
 * bits (float summation order, a realtime capture, a different note length), and a
 * 1e-15 fall must not cost an agent its best patch when the response prints the
 * two scores as the same number. `state.best` still tracks the raw maximum, so
 * the running best is never understated by the rounding.
 */
function trackMatchProgress(
  session: WebMcpSessionState,
  reference: ReferenceAnalysis,
  similarity: number,
  entryId: string | undefined
) {
  // Identity, not equality: a replacement reference is a different matching
  // problem, and carrying its predecessor's best forward would be a lie.
  if (!session.match || session.match.reference !== reference) {
    session.match = { reference, comparisons: 0, best: Number.NEGATIVE_INFINITY, bestComparison: 0 }
  }
  const state = session.match
  state.comparisons += 1
  // A strict improvement on the raw maximum, so `best`/`bestEntryId` name the
  // highest-scoring patch. A tie leaves them alone: `comparisonsSinceBest` then
  // keeps counting comparisons that have not IMPROVED on it, which is what the
  // plateau is about, and re-scoring the same patch cannot reset that counter.
  if (similarity > state.best) {
    state.best = similarity
    state.bestComparison = state.comparisons
    state.bestEntryId = entryId
  }
  const deltaFromBest = roundSimilarity(similarity - state.best)
  const standing: MatchStanding =
    state.bestComparison === state.comparisons ? 'best' : deltaFromBest < 0 ? 'worse' : 'tied'
  const isBest = standing !== 'worse'
  const sinceBest = state.comparisons - state.bestComparison
  const best = roundSimilarity(state.best)
  const plural = (count: number) => (count === 1 ? '' : 's')
  // The patch on screen already IS the best-scoring one: an agent that restored
  // it, or re-compared it against a different render. Telling it to restore what
  // is loaded, and warning that save_preset saves the wrong patch, is the same
  // class of false advice as calling a tie "worse" — the sound moved, the patch
  // did not. Only claimed when both ids are known.
  const holdingBest = entryId !== undefined && entryId === state.bestEntryId
  const restore = state.bestEntryId && !holdingBest
    ? ` navigate_history({ action: "restore", entryId: "${state.bestEntryId}" }) goes back to the patch that scored it.`
    : ''
  const plateau = sinceBest >= PLATEAU_COMPARISONS
  const note = standing === 'best'
    ? `Best of ${state.comparisons} comparison${plural(state.comparisons)} against this reference. This is the patch to beat, and the one worth save_preset if you stop now.`
    : standing === 'tied'
      ? `Ties the best, comparison ${state.bestComparison} (${best}) — the same score at the 1e-4 precision these figures carry — so the patch in hand is as good as the best one. Nothing to restore, and save_preset saves a patch that scores the same as the best.${plateau ? ` Nothing has IMPROVED on it in ${sinceBest} comparison${plural(sinceBest)} — this is a plateau, so stop here rather than keep editing.` : ''}`
      : `Worse than comparison ${state.bestComparison} (${best}), ${sinceBest} comparison${plural(sinceBest)} ago.${plateau ? ` Nothing has beaten it in ${sinceBest} tries — this is a plateau, so ${holdingBest ? 'stop' : 'restore the best and stop'} rather than keep editing.` : ''}${restore} ${holdingBest
        ? `The patch loaded now IS the one that scored best (sound-history entry ${state.bestEntryId}), so save_preset saves the best patch; this comparison scored lower because the RENDER differed — different notes, a different duration, or the live scope — not because the patch changed.`
        : 'save_preset would save this patch, not the best one.'}`
  return {
    comparisonNumber: state.comparisons,
    standing,
    isBest,
    best,
    bestComparisonNumber: state.bestComparison,
    ...(state.bestEntryId === undefined ? {} : { bestEntryId: state.bestEntryId }),
    // Never positive, and negative only when `standing` is 'worse'. See above:
    // the note is derived from this number, so the two cannot contradict.
    deltaFromBest,
    comparisonsSinceBest: sinceBest,
    note
  }
}

/** One modulation source as a single line: `keytrack voice -1..1`. */
function compactSource(def: ModSourceDef): string {
  return `${def.id} ${def.perVoice ? 'voice' : 'global'} ${def.bipolar ? '-1..1' : '0..1'}`
}

function assertFormat(value: unknown): 'full' | 'compact' {
  if (value === undefined) return 'full'
  if (value !== 'full' && value !== 'compact') throw new Error("format must be 'full' or 'compact'")
  return value
}

const RENDER_MODES = ['offline', 'realtime'] as const
const RENDER_FORMATS = ['metrics', 'url'] as const
type RenderMode = (typeof RENDER_MODES)[number]
type RenderFormat = (typeof RENDER_FORMATS)[number]

function assertRenderMode(value: unknown): RenderMode | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !RENDER_MODES.includes(value as RenderMode)) {
    throw new Error(`mode must be one of ${RENDER_MODES.join(', ')}`)
  }
  return value as RenderMode
}

function assertRenderFormat(value: unknown): RenderFormat {
  if (value === undefined) return 'metrics'
  if (typeof value !== 'string' || !RENDER_FORMATS.includes(value as RenderFormat)) {
    throw new Error(`format must be one of ${RENDER_FORMATS.join(', ')}`)
  }
  return value as RenderFormat
}

/**
 * The one pitch a sequence holds, or `null` when it holds none or several.
 *
 * This used to feed `analysisOptionsFor`, which handed that pitch to the analyzer
 * as `f0Hz` - and `resolvePitch` takes a supplied `f0Hz` as `source: 'given'` at
 * `confidence: 1` without reading a sample. The number was therefore the note ASKED
 * FOR, never the note produced: `osc1.transpose`, `osc1.fine` or a mod route on
 * either moves the render off that frequency and nothing said so. It is the same
 * defect `candidateAnalysisOptions` describes for `compare_audio`, and it leaked
 * back in through `compare_audio({autoRender: false})`, which scores whatever
 * `render_audio` last measured. So nothing is stated any more; the pitch of a render
 * is measured from the render, and this only says what was requested so the two can
 * be shown side by side (`pitchCheck`).
 */
function singlePitch(notes: readonly { midi: number }[]): number | null {
  const pitches = new Set(notes.map(note => note.midi))
  if (pitches.size !== 1) return null
  const [midi] = [...pitches]
  return midi
}

/** Distinct pitches echoed back, beyond which the list is summarised rather than printed. */
const MAX_ECHOED_PITCHES = 12

/**
 * What the tool understood the notes to be, in words: `"D2 (MIDI 38, 73.4 Hz)"`.
 *
 * Returned by every tool that takes notes. A session measured a 37 Hz reference,
 * wrote "D1", passed `midi: 38` - which is D2 at 73.4 Hz - and nothing in any
 * response contradicted it, so an octave error survived the whole run while the
 * scalar metrics stayed plausible. Reading the interpretation back in the same turn
 * is what makes that visible while it can still be corrected.
 */
function pitchEcho(notes: readonly { midi: number }[]): { pitches: string[]; morePitches?: number } {
  const distinct = [...new Set(notes.map(note => note.midi))]
  const shown = distinct.slice(0, MAX_ECHOED_PITCHES)
  return {
    pitches: shown.map(describeMidi),
    ...(distinct.length > shown.length ? { morePitches: distinct.length - shown.length } : {})
  }
}

/** Cents beyond which a render is called detuned from the note that was asked for. */
const PITCH_CHECK_CENTS = 25

/**
 * The requested note against the measured one, for a single-pitch render.
 *
 * The point of measuring rather than stating: a patch with `osc1.transpose: 12`
 * renders an octave above the note named in the call, and this is where that shows
 * up as a number instead of being absorbed into a `source: "given"` claim.
 */
function pitchCheckFor(midi: number, metrics: AudioMetrics) {
  const requestedHz = midiToHz(midi)
  const measured = metrics.pitch
  if (!measured) {
    return {
      requested: describeMidi(midi),
      measured: null,
      note: 'No fundamental was measured in this render, so nothing here confirms it sounded at the note requested. An unpitched or near-silent patch reads this way; so does a render too short for detection.'
    }
  }
  const cents = Math.round(1200 * Math.log2(measured.f0Hz / requestedHz))
  const detuned = Math.abs(cents) >= PITCH_CHECK_CENTS
  return {
    requested: describeMidi(midi),
    measured: {
      f0Hz: clean(measured.f0Hz),
      note: describeMidi(measured.midi),
      centsOffset: clean(measured.centsOffset),
      confidence: clean(measured.confidence),
      source: measured.source
    },
    centsFromRequested: cents,
    note: detuned
      ? `This render sounds ${Math.abs(cents)} cents ${cents > 0 ? 'above' : 'below'} ${describeMidi(midi)} — the patch itself moves it (osc transpose/fine, or a mod route on either). Every metric below describes what was rendered, not what was requested.`
      : 'The render sounds at the note requested, measured from its own samples rather than assumed.'
  }
}

/**
 * Normalize `{note: "D2"}` to `{midi: 38}` before `validatePerformanceNotes`, which
 * accepts exactly `{midi, velocity, start, duration}` and rejects anything else.
 *
 * The parsing itself belongs to `note-input.ts` and stays there. What is here is the
 * per-note bookkeeping the tool layer owns: exactly one of the two spellings, and an
 * error that names the offending index.
 */
function resolveNoteInputs(value: unknown, label = 'notes'): unknown {
  if (!Array.isArray(value)) return value
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    const note = item as Record<string, unknown>
    const hasName = 'note' in note
    const hasMidi = 'midi' in note
    if (hasName && hasMidi) {
      throw new Error(`${label}[${index}] has both 'midi' and 'note'. Pass exactly one — they are two spellings of the same field, and a disagreement between them is the octave error this accepts note names to prevent.`)
    }
    if (!hasName && !hasMidi) {
      throw new Error(`${label}[${index}] needs a pitch: either 'midi' (an integer 0..127) or 'note' (a name with an octave, e.g. "D2").`)
    }
    if (!hasName) return item
    const { note: name, ...rest } = note
    try {
      return { ...rest, midi: toMidi(name as NoteInput) }
    } catch (error) {
      throw new Error(`${label}[${index}].note: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

/**
 * How much buffer `compare_audio` leaves after note-off when it picks the note itself.
 *
 * The auto-render used to hold the note for the whole buffer: note-on at 0, note-off
 * on the last sample. The candidate therefore never entered its release, and three
 * parts of the diff quietly stopped meaning anything. `decayT60Ms` needs the tail to
 * fall 20 dB, so it read `null` on every default comparison and `decayT60MsDelta`
 * reported `n/a`; `sustainDb` is sampled at 80 % of the buffer, so it read a note that
 * was still sounding against a reference that had already died away; and `loudnessDb`
 * averaged a held note against a decayed one. A reference is nearly always a one-shot
 * that has finished by the end of its file, so the candidate has to finish too.
 *
 * The rule: the note ends one release tail before the buffer does — 0.25 s, the same
 * tail `render_audio` adds after a sequence, capped at 40 % of the buffer so a short
 * reference keeps the majority of its windows on the sounding part of the note. The
 * buffer length itself is untouched (it stays the reference's duration), because the
 * spectral windows on both sides have to cover the same span to be comparable.
 */
const RELEASE_TAIL_SECONDS = 0.25
const MAX_RELEASE_TAIL_SHARE = 0.4

function heldSecondsWithin(buffer: number): number {
  return clean(buffer - Math.min(RELEASE_TAIL_SECONDS, buffer * MAX_RELEASE_TAIL_SHARE))
}

/** Bounds `AnalyzeAudioOptions.windows` accepts; mirrored here for the schema and the errors. */
const MIN_ANALYSIS_WINDOWS = 4
const MAX_ANALYSIS_WINDOWS = 32

/**
 * The live scope buffer, as `src/worklet/processor.ts` publishes it
 * (`SCOPE_SIZE = 1024`, one frame per 1024 rendered samples).
 */
const SCOPE_SAMPLES = 1024

/**
 * Said out loud on every scope result. 1024 samples is about 21 ms at 48 kHz:
 * shorter than one attack, let alone a decay, so the time-domain metrics on it
 * describe a slice of a steady note rather than a note.
 */
const SCOPE_NOTE =
  `The live scope holds only the most recent ${SCOPE_SAMPLES} samples (~21 ms at 48 kHz). ` +
  'Level, spectrum and pitch on that slice are real; `attackMs`, `timeToPeakMs`, `envelopeDb`, ' +
  '`decayT60Ms`, `sustainDb` and the per-window brightness trajectory are not — they describe ' +
  '21 ms of a sound, not its shape. For those use `source: "recent"`, which reads the rolling ' +
  `${RECENT_AUDIO_SECONDS} s capture of the same live output, or render_audio (offline, no user gesture needed).`

/**
 * Said out loud on every result read from the rolling capture. Two things an
 * agent gets wrong otherwise: that it is a recording of the LIVE graph only —
 * an offline render never passes through it — and that it is a fixed-length
 * window ending now, so a note played six seconds ago has already been
 * overwritten by the silence that followed it.
 */
const RECENT_NOTE =
  `The rolling capture holds the last ${RECENT_AUDIO_SECONDS} s of LIVE output, fed from the same worklet ` +
  'frames as the scope but kept rather than overwritten, so every envelope and brightness ' +
  'figure here describes a real span of sound. It records only what the live graph played: ' +
  'play_notes and a human at the keyboard land in it, render_audio\'s offline renders never do. ' +
  'The window always ends at the present moment, so silence since the note ends up in it too.'

/** `analyze_audio({source:'recent'})` and `capture_audio` with nothing captured yet. */
const NO_RECENT_AUDIO =
  'The rolling capture is empty: this page has produced no live output yet, so there is nothing to listen back to. ' +
  'It fills only while audio is running — a human clicks CLICK TO START AUDIO, then plays, or play_notes plays for you. ' +
  'render_audio renders offline and never reaches it; call render_audio and read its metrics instead if no human is playing.'

/**
 * Peak above which `capture_audio`'s `waitForSignal` calls it a sound rather
 * than a noise floor. -60 dBFS (0.001 of full scale) is far below anything a
 * played note reaches and far above the residue a running-but-idle graph leaves,
 * so onset detection neither misses a quiet pad nor fires on nothing.
 */
const SIGNAL_ONSET_DB = -60
const SIGNAL_ONSET_AMPLITUDE = 10 ** (SIGNAL_ONSET_DB / 20)

/**
 * How long `waitForSignal` may hold the invocation open. The reviewer asked for
 * ten and ten is the cap: a WebMCP call that sits waiting is a call the client
 * is timing out against, and the buffer is rolling anyway — an agent that waits
 * in vain can simply call again.
 */
const MAX_WAIT_SECONDS = 10
const DEFAULT_WAIT_SECONDS = 5
/** Onset poll interval. One scope frame is ~21 ms, so this misses no frame by much. */
const SIGNAL_POLL_MS = 50
/** Slice of the ring inspected per poll: long enough to span a scope frame. */
const SIGNAL_POLL_SECONDS = 0.05

const DEFAULT_CAPTURE_SECONDS = 3

/** `f0Hz` as the analyzer takes it: a positive, finite frequency or nothing at all. */
function assertF0Hz(value: unknown): number | undefined {
  if (value === undefined) return undefined
  const hz = finite(value, 'f0Hz')
  if (hz <= 0 || hz > 20000) throw new Error('f0Hz must be a positive frequency in range 0..20000')
  return hz
}

function assertWindows(value: unknown): number | undefined {
  if (value === undefined) return undefined
  return boundedInteger(value, 'windows', MIN_ANALYSIS_WINDOWS, MIN_ANALYSIS_WINDOWS, MAX_ANALYSIS_WINDOWS)
}

/**
 * How `compare_audio` analyses the candidate it renders, against a given reference.
 *
 * Deliberately carries NO `f0Hz`. `resolvePitch` treats a supplied one as
 * `source: 'given'` with `confidence: 1` and never inspects the samples, so passing
 * the reference's fundamental here - as this used to - meant the candidate's pitch
 * was asserted rather than measured: `diff.pitch.centsError` was structurally 0, the
 * `pitch-error` advice rule could never fire, and the harmonic picker searched bins
 * the render had no partials in whenever `osc1.transpose`, `osc1.fine` or a reference
 * sitting between two equal-tempered notes moved it off that frequency. An octave-off
 * candidate is the exact failure this comparison exists to catch, so its fundamental
 * is detected from its own samples.
 *
 * `windows` is copied from the reference so both sides are cut into the same number of
 * time slices. The reference is analysable at `windows: 4…32`; a 4-window candidate
 * against an 8-window reference makes the two brightness trajectories describe
 * different fractions of sound and costs half the resolution the caller paid for.
 * Anything outside the analyzer's bounds is dropped rather than passed on, so a
 * stubbed or older metrics object cannot make the render throw.
 */
function candidateAnalysisOptions(reference: ReferenceAnalysis): AnalyzeAudioOptions {
  const windows = reference.metrics.spectralWindows?.length ?? 0
  return Number.isInteger(windows) && windows >= MIN_ANALYSIS_WINDOWS && windows <= MAX_ANALYSIS_WINDOWS
    ? { windows }
    : {}
}

/** Milliseconds trimmed off one end of a reference before it is analysed. */
function assertTrimMs(value: unknown, label: string): number {
  if (value === undefined) return 0
  const ms = finite(value, label)
  if (ms < 0) throw new Error(`${label} must be >= 0`)
  return ms
}

const PAYLOAD_FORMATS = ['json', 'text'] as const
type PayloadFormat = (typeof PAYLOAD_FORMATS)[number]

/** `json` or `text`; the default differs per tool, so it is passed in. */
function assertPayloadFormat(value: unknown, fallback: PayloadFormat): PayloadFormat {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !PAYLOAD_FORMATS.includes(value as PayloadFormat)) {
    throw new Error(`format must be one of ${PAYLOAD_FORMATS.join(', ')}`)
  }
  return value as PayloadFormat
}

/**
 * What TEXT mode drops from `reference.metrics` and `candidate.metrics`.
 *
 * `compare_audio({format:"text"})` used to return the compact table *on top of*
 * both complete metrics objects, so every band, every envelope point and every
 * spectral window was paid for twice — once as prose an agent reads and once as
 * an array it does not. These three fields are where the weight is: `envelopeDb`
 * is 64 points per side, `spectralWindows` carries 12 partials per window per
 * side, `bandsDb` ten more. The table already states each of them as a signed
 * error (its BANDS, ENVELOPE and BRIGHTNESS blocks), and `comparison` — which
 * nothing here touches — still scores them.
 *
 * Deliberately narrow. Everything else on both sides survives, so the numbers a
 * text-mode agent might want and the table lacks (`peakDb`, `loudnessDb`,
 * `pitch`, `harmonicShape`, `stereoWidth`, `decayT60Ms`) are still there.
 */
const TEXT_MODE_OMITTED_METRICS = ['envelopeDb', 'bandsDb', 'spectralWindows'] as const

/**
 * Dropped with them: the candidate's `metricNotes`, a kilobyte of prose that
 * explains how to read fields the table has just restated and two of which are
 * no longer in the object. It is the single largest remaining duplicate in a
 * text-mode response, and `format: "json"` brings it back with everything else.
 */
const TEXT_MODE_OMITTED_FIELDS = [...TEXT_MODE_OMITTED_METRICS, 'metricNotes'] as const

type SummarizedMetrics = Omit<AudioMetrics, (typeof TEXT_MODE_OMITTED_METRICS)[number]>

function summarizeAnalysis<T extends { metrics: AudioMetrics }>(analysis: T) {
  const { envelopeDb: _envelope, bandsDb: _bands, spectralWindows: _windows, ...metrics } = analysis.metrics
  const { metricNotes: _notes, ...rest } = analysis as T & { metricNotes?: unknown }
  return { ...rest, metrics: metrics satisfies SummarizedMetrics }
}

const METRICS_OMITTED_NOTE =
  'TEXT mode: the table above already states these numbers, as the signed errors under BANDS, ENVELOPE ' +
  'and BRIGHTNESS, so the arrays holding them are gone from reference.metrics and candidate.metrics. ' +
  '`comparison` is untouched and byte-identical in both modes, and still scores all of them. ' +
  'format: "json" returns everything, and is the mode in which candidate matches analyze_audio exactly.'

/** `setTimeout` that rejects the moment the composed signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const aborted = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted)
      resolve()
    }, ms)
    signal.addEventListener('abort', aborted, { once: true })
  })
}

/** Loudest absolute sample across every channel; 0 for an empty window. */
function peakAmplitude(channels: readonly Float32Array[]): number {
  let peak = 0
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index++) {
      const value = Math.abs(channel[index])
      if (value > peak) peak = value
    }
  }
  return peak
}

const ADVICE_CATEGORIES = ['timbre', 'envelope', 'level', 'space'] as const

function assertAdviceFocus(value: unknown): AdviceCategory | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !ADVICE_CATEGORIES.includes(value as AdviceCategory)) {
    throw new Error(`focus must be one of ${ADVICE_CATEGORIES.join(', ')}`)
  }
  return value as AdviceCategory
}

/** Default number of ranked moves returned beside a diff. */
const DEFAULT_MAX_ACTIONS = 5
const MAX_ADVICE_ACTIONS = 20

/**
 * Trim `startMs`/`endMs` off a decoded buffer. Applied here rather than in the
 * analyzer because `AnalyzeAudioOptions` has no trim: what is trimmed is what
 * the caller means by "the reference", so the retained PCM is the trimmed one.
 */
function trimChannels(
  channels: readonly Float32Array[],
  sampleRate: number,
  startMs: number,
  endMs: number
): Float32Array[] {
  if (startMs === 0 && endMs === 0) return channels.map(channel => channel)
  const length = channels[0]?.length ?? 0
  const from = Math.min(length, Math.round(startMs * sampleRate / 1000))
  const to = Math.max(from, length - Math.min(length, Math.round(endMs * sampleRate / 1000)))
  if (to - from < 1) {
    throw new Error('trimStartMs and trimEndMs leave no audio to analyze')
  }
  return channels.map(channel => channel.slice(from, to))
}

/**
 * The live patch in the raw units `adviseFromDiff` reads. `engine.toPreset()`
 * stores NORMALIZED values under the same ids, which would make every
 * `suggested` move nonsense, so the conversion happens here.
 */
function currentPatchValues(engine: SynthEngine): PatchValues {
  const values = engine.values as ArrayLike<number> | undefined
  // A patch that cannot be read costs the advice its quantitative `suggested`
  // moves — `adviseFromDiff` still ranks the findings — and must never cost the
  // caller the comparison it just paid a render for.
  if (!values) return {}
  const patch: Record<string, number> = {}
  for (const def of PARAMS) {
    const normalized = values[paramIndex(def.id)]
    if (typeof normalized !== 'number' || !Number.isFinite(normalized)) continue
    patch[def.id] = clean(normToValue(def, normalized))
  }
  return patch
}

/**
 * Resolve the offline renderer once per tool set: an injected dependency, then
 * an engine that carries its own renderer, then the real implementation when
 * this browser can render offline at all.
 */
function resolveOfflineRenderer(engine: SynthEngine, dependencies: WebMcpToolDependencies): OfflineRenderer | null {
  if (dependencies.renderOffline) return dependencies.renderOffline
  const own = (engine as Partial<{
    renderOffline: (notes: readonly { midi: number; velocity: number; start: number; duration: number }[], duration: number) => Promise<RecordedAudio>
  }>).renderOffline
  if (typeof own === 'function') return (target, notes, duration) => own.call(target, notes, duration)
  return offlineRenderAvailable() ? renderOffline : null
}

function routeValue(slot: number, route: ModSlotState) {
  return {
    slot,
    source: MOD_SOURCES[route.source].id,
    destination: PARAMS[route.dest].id,
    depth: route.depth,
    enabled: route.enabled
  }
}

/**
 * The live mod matrix in the vocabulary `adviseFromDiff` reads, or `undefined`
 * when this engine cannot report one.
 *
 * `currentPatchValues` walks `PARAMS`, and a mod slot has no `PARAMS` id, so
 * without this the advisor cannot see the matrix at all — which is how it came
 * to recommend `env2.decay` on patches where no `env2 -> filter1.cutoff` route
 * exists and that parameter therefore reaches nothing.
 *
 * `undefined` and `[]` are DIFFERENT answers downstream: an absent `mods` means
 * "nobody looked" and keeps the hedged probe, while an empty array means "I
 * looked and the route is gone" and turns the advice into a `set_modulation`
 * instruction. An engine with no readable matrix has not told us the route is
 * gone, so it gets the first, never the second. Same tolerance, same reason, as
 * `currentPatchValues` returning `{}` for an engine with no `values`: a patch
 * this module cannot read must never cost the caller the render it paid for.
 */
function currentModRoutes(engine: SynthEngine): ModRoute[] | undefined {
  const slots = engine.modSlots as readonly (ModSlotState | null)[] | undefined
  if (!Array.isArray(slots)) return undefined
  return slots.flatMap((route, slot) => (route ? [routeValue(slot, route)] : []))
}

function runtimeSnapshot(engine: SynthEngine) {
  return {
    running: engine.running,
    heldNotes: [...engine.heldNotes].sort((a, b) => a - b),
    voices: engine.voiceCount,
    peaks: { left: engine.peakL, right: engine.peakR }
  }
}

function fxOrder(engine: SynthEngine) {
  return {
    fxOrder: engine.fxOrder.map(index => FX_IDS[index]).filter((id): id is (typeof FX_IDS)[number] => id !== undefined)
  }
}

function boundedInteger(value: unknown, label: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  const number = finite(value, label)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer in range ${min}..${max}`)
  }
  return number
}

/** Groups whose id extends this one: `filter` -> `filter1`, `filter2`. */
function relatedGroups(group: string): string[] {
  return PARAMETER_GROUPS.filter(candidate => candidate !== group && candidate.toLowerCase().startsWith(group.toLowerCase()))
}

/**
 * The canonical group id for a case-insensitively matched name. A name that
 * matches nothing used to return an empty page that looked like an answer;
 * `{ group: 'Filter' }` still resolves - to the one-parameter routing group,
 * which `groupFilter` in the response then says out loud.
 */
function assertGroup(value: string): string {
  const match = PARAMETER_GROUPS.find(candidate => candidate.toLowerCase() === value.toLowerCase())
  if (!match) {
    throw new Error(
      `Unknown group '${value}'.${didYouMean(value, PARAMETER_GROUPS)} Groups: ${PARAMETER_GROUPS.join(', ')}. ` +
      `One call with {"format":"compact"} and no group returns all ${PARAMS.length} parameters.`
    )
  }
  return match
}

function filteredParameters(group?: string, search?: string): ParamDef[] {
  const normalizedGroup = group?.toLowerCase()
  const normalizedSearch = search?.toLowerCase()
  return PARAMS.filter(def =>
    (!normalizedGroup || def.group.toLowerCase() === normalizedGroup) &&
    (!normalizedSearch || `${def.id} ${def.name} ${def.group}`.toLowerCase().includes(normalizedSearch))
  )
}

function abortError(): Error {
  const error = new Error('Execution aborted')
  error.name = 'AbortError'
  return error
}

/**
 * Some experimental WebMCP clients omit the per-invocation AbortSignal even
 * though the current type definition requires it. Treat that as an
 * uncancellable invocation while retaining lifecycle cancellation.
 */
function invocationSignal(options?: WebMCP.ToolExecuteCallbackOptions): AbortSignal {
  return options?.signal ?? new AbortController().signal
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

function validateReferenceName(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('name must be a non-empty string without control characters')
  }
  if (value.length > MAX_REFERENCE_NAME_LENGTH) throw new Error(`name is limited to ${MAX_REFERENCE_NAME_LENGTH} characters`)
  return value
}

function validateAudioMimeType(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return normalizeAudioMimeType(value)
}

function canonicalRaw(def: ParamDef, value: unknown): number {
  if (typeof value === 'string') {
    if (!def.choices) throw new Error(`${def.id} does not accept a choice label`)
    const choice = def.choices.indexOf(value)
    if (choice < 0) {
      throw new Error(`Unknown choice '${value}' for ${def.id}.${didYouMean(value, def.choices)} Choices: ${def.choices.join(', ')}`)
    }
    return choice
  }
  const raw = finite(value, `${def.id} value`)
  const max = def.choices ? def.choices.length - 1 : def.max
  const min = def.choices ? 0 : def.min
  if (raw < min || raw > max) throw new Error(`${def.id} value is outside range ${min}..${max}`)
  if (def.choices && !Number.isInteger(raw)) throw new Error(`${def.id} choice index must be an integer`)
  if (def.step && Math.abs(raw / def.step - Math.round(raw / def.step)) > 1e-9) {
    throw new Error(`${def.id} value must align to step ${def.step}`)
  }
  return raw
}

const emptySchema = { type: 'object', properties: {}, additionalProperties: false } as const

/**
 * Said on `note`, in four schemas, so it is kept to one line. The full grammar
 * ships with every parse failure instead (`ACCEPTED_FORMS` in `note-input.ts`),
 * where an agent that got it wrong is the one reading it.
 */
const NOTE_NAME_DESCRIPTION =
  'Pitch as a name with an octave: "C4" is MIDI 60, "D2" is 73.4 Hz. Sharps "#", flats "b". Pass this or `midi`, never both.'

const noteSchema = {
  type: 'object',
  properties: {
    midi: { type: 'integer', minimum: 0, maximum: 127, description: 'Pitch as a number. Pass this or `note`, never both.' },
    note: { type: 'string', minLength: 2, maxLength: 5, description: NOTE_NAME_DESCRIPTION },
    velocity: { type: 'number', minimum: 0, maximum: 1 },
    start: { type: 'number', minimum: 0 },
    duration: { type: 'number', exclusiveMinimum: 0 }
  },
  // `midi` left out of `required` and pinned by `oneOf` instead: an object naming
  // both matches both branches, which `oneOf` rejects, so the schema says "exactly
  // one" rather than "at least one". Runtime validation says it again, because a
  // client that ignores `oneOf` must still get the error rather than a silent pick.
  required: ['velocity', 'start', 'duration'],
  oneOf: [{ required: ['midi'] }, { required: ['note'] }],
  additionalProperties: false
} as const

/**
 * The two preset spaces, named once.
 *
 * `PresetSource` is the store's own union, and this object is keyed by it, so a
 * space added, removed or renamed in `preset-store.ts` breaks this declaration
 * rather than quietly leaving a schema `enum` and an error message a member
 * short. The values are the phrase each space is described by in `presetNotFound`,
 * which is why the vocabulary lives in one object instead of a bare array: the
 * list and the prose that reads it cannot drift apart if they are the same thing.
 */
const PRESET_SPACES: Record<PresetSource, string> = {
  factory: 'the factory presets',
  user: "this browser's user presets"
}
const PRESET_SOURCES = Object.keys(PRESET_SPACES) as PresetSource[]

/** Factory names as a set, built once: every save and load asks whether one collides. */
const factoryNames = new Set(listFactoryPresetNames())

function assertPresetSource(value: unknown): PresetSource | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !PRESET_SOURCES.includes(value as PresetSource)) {
    throw new Error(`source must be one of ${PRESET_SOURCES.join(', ')}`)
  }
  return value as PresetSource
}

/** User preset names without announcing a load: `loadPreset` notifies, `listPresets` does not. */
function userPresetNames(): Set<string> {
  return new Set(listPresets().map(preset => preset.name))
}

/** What an export of the live patch is called when no preset is currently loaded. */
const LIVE_PATCH_EXPORT_NAME = 'coSynth Patch'

/**
 * A preset as the JSON an import takes back, plus the name to save it under.
 *
 * `serializePreset` validates on the way out, so this cannot emit a file the app
 * would reject, and it carries `version: PRESET_VERSION` - not decoration, since
 * a format 1 file has its LFO divisions rescaled on load and a format 2 file does
 * not, and nothing but that tag separates them.
 */
function exportedPreset(name: string, preset: PresetData, source: PresetSource | 'live') {
  return {
    name,
    source,
    filename: presetFileName(name),
    json: serializePreset(preset),
    // Same honesty as `save_preset`'s `where`, for the same reason: an agent that
    // reports "exported to a file" has told the human to look somewhere empty.
    where: 'Nothing was written to disk - this page cannot save a file on its own. `json` above IS the export: hand it over, or paste it back into an import.'
  }
}

/**
 * "Not found" that says which space was searched and names the near misses in it.
 * A bare `Preset not found: X` sent an agent to `list_presets` to find out whether
 * the name was wrong or the space was.
 */
function presetNotFound(name: string, source: PresetSource | undefined): string {
  const factory = listFactoryPresetNames()
  const user = [...userPresetNames()]
  const candidates = source === 'factory' ? factory : source === 'user' ? user : [...factory, ...user]
  const where = source ? `among ${PRESET_SPACES[source]}` : `in either ${PRESET_SPACES.factory} or ${PRESET_SPACES.user}`
  return `Preset not found ${where}: ${name}.${didYouMean(name, candidates)} list_presets returns every name with its source.`
}

interface ValidatedParameterUpdate {
  id: string
  index: number
  def: ParamDef
  raw: number
  normalized: number
}

/**
 * The parameter batch `update_parameters` and `apply_patch` both take.
 *
 * Shared rather than mirrored on purpose: two validators that disagree about which
 * values a parameter accepts would be worse than having only one of the tools, since
 * the difference would show up as a patch that applies through one call and not the
 * other. `label` only names the property in the errors.
 */
function validateParameterUpdates(value: unknown, label: string): ValidatedParameterUpdate[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`)
  const seen = new Set<string>()
  return value.map((item, index) => {
    const update = assertObject(item, `${label}[${index}]`, ['id', 'value'], ['id', 'value'])
    if (typeof update.id !== 'string') throw new Error(`${label}[${index}].id must be a string`)
    const id = update.id
    const def = PARAMS.find(candidate => candidate.id === id)
    if (!def) {
      throw new Error(`Unknown parameter '${id}'.${didYouMean(id, PARAMS.map(candidate => candidate.id))} Groups: ${PARAMETER_GROUPS.join(', ')}`)
    }
    if (seen.has(id)) throw new Error(`Duplicate parameter ID: ${id}`)
    seen.add(id)
    const raw = canonicalRaw(def, update.value)
    return { id, index: paramIndex(id), def, raw, normalized: valueToNorm(def, raw) }
  })
}

/** The oscillator wavetable choice that resolves to something else when its slot is empty. */
const CUSTOM_WAVETABLE = 'Custom'

/** What `engine.tableForOsc` falls back to for `Custom`: `WAVETABLE_NAMES[min(sel, CUSTOM_WT - 1)]`. */
const CUSTOM_WAVETABLE_FALLBACK = 'Digital'

/** The three parameters that can hold `Custom`, in oscillator order. */
const OSC_WAVETABLE_IDS: readonly string[] = ['osc1.wavetable', 'osc2.wavetable', 'osc3.wavetable']

/**
 * `osc{n}.wavetable` reading `Custom` with nothing imported into slot `n`.
 *
 * `engine.tableForOsc` resolves the choice as
 * `WAVETABLE_NAMES[Math.min(sel, CUSTOM_WT - 1)]` unless `customTables[osc]`
 * holds a table, so with an empty slot `Custom` IS `Digital`. And no WebMCP tool
 * can fill that slot: `importWavetableFile` takes a browser `File` and exists
 * only for the UI. An agent that writes `Custom` is therefore told the write
 * succeeded, reads `Custom` back out of `get_synth_state`, and reasons about a
 * table it is not hearing — a value presented as real when it is not, which is
 * the defect `SILENT_CANDIDATE_REFUSAL` and `trackMatchProgress` both exist to
 * refuse.
 *
 * Reported rather than refused. The UI accepts `Custom` on this parameter, and a
 * tool surface that rejected a value the app allows would be a second,
 * disagreeing model of the same patch — worse than the silence it replaces.
 *
 * `captureSoundState()` is the authoritative answer to "is a table imported":
 * `currentTables[osc].name` would have to guess it from a label an imported WAV
 * could legitimately carry ("Digital.wav"). It is called only once a `Custom`
 * selection is already established, so the ordinary path pays nothing. A build
 * without it cannot know, and an unknowable fact is not claimed.
 */
function customWavetableIsEmpty(engine: SynthEngine, paramId: string): boolean {
  const osc = OSC_WAVETABLE_IDS.indexOf(paramId)
  if (osc < 0 || typeof engine.captureSoundState !== 'function') return false
  return engine.captureSoundState().customTables[osc] == null
}

/** The sentence that travels with a `Custom` selection nothing backs. */
function emptyCustomWavetableNote(paramId: string): string {
  return `${paramId} reads "${CUSTOM_WAVETABLE}" but no wavetable has been imported into that slot, so the oscillator is playing "${CUSTOM_WAVETABLE_FALLBACK}": the label changed and the sound did not. No tool here can import one — the importer takes a browser file and belongs to the UI — so ask the human to import a WAV, or name a built-in table instead (get_parameter_schema's \`choiceNotes\` says what each one sounds like).`
}

/** `osc{n}.wavetable` ids currently reading `Custom` over an empty slot. */
function emptyCustomWavetables(engine: SynthEngine): string[] {
  return OSC_WAVETABLE_IDS.filter(id => {
    const def = paramDef(id)
    return formatValue(def, engine.values[paramIndex(id)]) === CUSTOM_WAVETABLE && customWavetableIsEmpty(engine, id)
  })
}

function appliedParameter(update: ValidatedParameterUpdate, engine?: SynthEngine) {
  const emptyCustom = engine !== undefined
    && formatValue(update.def, update.normalized) === CUSTOM_WAVETABLE
    && customWavetableIsEmpty(engine, update.id)
  return {
    id: update.id,
    raw: update.raw,
    normalized: clean(update.normalized),
    formatted: formatValue(update.def, update.normalized),
    ...(emptyCustom ? { resolvesTo: CUSTOM_WAVETABLE_FALLBACK, note: emptyCustomWavetableNote(update.id) } : {})
  }
}

/** How the fx chain is named in both schemas that take one; first in the list runs first. */
const FX_ORDER_DESCRIPTION =
  `All ${FX_IDS.length} effect ids exactly once, in processing order (default ${FX_IDS.join(', ')}). A missing, repeated or unknown id is an error, not a partial reorder.`

/**
 * An fx permutation as slot indices. A partial list is refused rather than
 * completed: "move reverb first" and "the chain is exactly this" would then be the
 * same call, and the second is the only one whose result an agent can predict.
 */
function validateFxOrder(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of the ${FX_IDS.length} effect ids: ${FX_IDS.join(', ')}`)
  if (value.length !== FX_IDS.length) {
    throw new Error(`${label} must list all ${FX_IDS.length} effects exactly once (got ${value.length}). Effects: ${FX_IDS.join(', ')}`)
  }
  const seen = new Set<string>()
  return value.map((entry, index) => {
    if (typeof entry !== 'string') throw new Error(`${label}[${index}] must be a string`)
    const slot = FX_IDS.indexOf(entry as FxId)
    if (slot < 0) throw new Error(`Unknown effect '${entry}'.${didYouMean(entry, FX_IDS)} Effects: ${FX_IDS.join(', ')}`)
    if (seen.has(entry)) throw new Error(`Duplicate effect '${entry}': ${label} must be a permutation of ${FX_IDS.join(', ')}, each exactly once`)
    seen.add(entry)
    return slot
  })
}

interface ValidatedRoute {
  source: number
  destination: number
  depth: number
  enabled?: boolean
}

/** `apply_patch`'s modulation block, validated with the same helpers `set_modulation` uses. */
function validateModulationInput(value: unknown): { replace: boolean; routes: ValidatedRoute[] } {
  const input = assertObject(value, 'modulations', ['replace', 'routes'])
  if (input.replace !== undefined && typeof input.replace !== 'boolean') throw new Error('modulations.replace must be boolean')
  const replace = input.replace === true
  if (input.routes !== undefined && !Array.isArray(input.routes)) throw new Error('modulations.routes must be an array')
  const raw = (input.routes ?? []) as unknown[]
  if (raw.length === 0 && !replace) {
    throw new Error('modulations needs `routes`, or `replace: true` on its own to clear the matrix')
  }
  if (raw.length > MAX_MOD_SLOTS) throw new Error(`modulations.routes is limited to ${MAX_MOD_SLOTS} entries`)
  const seen = new Set<string>()
  return {
    replace,
    routes: raw.map((item, index) => {
      const label = `modulations.routes[${index}]`
      const route = assertObject(item, label, ['source', 'destination', 'depth', 'enabled'], ['source', 'destination', 'depth'])
      const source = assertModSource(route.source)
      const destination = assertModDestination(route.destination)
      const depth = finite(route.depth, `${label}.depth`)
      if (depth < -1 || depth > 1) throw new Error(`${label}.depth must be in range -1..1`)
      if (route.enabled !== undefined && typeof route.enabled !== 'boolean') throw new Error(`${label}.enabled must be boolean`)
      const pair = `${source}:${destination}`
      if (seen.has(pair)) {
        throw new Error(`Duplicate modulation route ${String(route.source)} -> ${String(route.destination)} at ${label}: one route per source+destination pair, as set_modulation's 'add' resolves it`)
      }
      seen.add(pair)
      return { source, destination, depth, ...(route.enabled === undefined ? {} : { enabled: route.enabled as boolean }) }
    })
  }
}

/** Build WebMCP descriptors over the exact live engine used by the UI. */
export function createWebMcpTools(
  engine: SynthEngine,
  lifecycleSignal?: AbortSignal,
  dependencies: WebMcpToolDependencies = {}
): WebMCP.ModelContextTool[] {
  const session = sessionFor(engine)
  const performance = dependencies.performance ?? session.performance
  agentActivityFor(engine)
  const decodeAudio = dependencies.decodeAudio ?? decodeBase64Audio
  const analyzeAudioAsync = dependencies.analyzeAudioAsync ?? analyzeAudioAbortably
  const offlineRenderer = resolveOfflineRenderer(engine, dependencies)

  const cleanup = () => {
    session.referenceGeneration++
    session.activeReferenceController?.abort()
    session.activeReferenceController = null
    if (session.lastRender) URL.revokeObjectURL(session.lastRender.url)
    session.lastRender = null
    session.lastReference = null
    session.referencePcm = null
    session.match = null
    session.lastComparison = null
  }
  lifecycleSignal?.addEventListener('abort', cleanup, { once: true })

  async function runAbortable<T>(signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    lifecycleSignal?.addEventListener('abort', abort, { once: true })
    if (signal.aborted || lifecycleSignal?.aborted) controller.abort()
    try {
      throwIfAborted(controller.signal)
      return await task(controller.signal)
    } finally {
      signal.removeEventListener('abort', abort)
      lifecycleSignal?.removeEventListener('abort', abort)
    }
  }

  async function runReferenceAnalysis<T>(
    signal: AbortSignal,
    invocationGeneration: number,
    task: (signal: AbortSignal, assertCurrent: () => void) => Promise<T>
  ): Promise<T> {
    const superseded = new Error('Reference audio analysis was superseded by a newer invocation')
    session.activeReferenceController?.abort(superseded)

    const controller = new AbortController()
    session.activeReferenceController = controller
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    lifecycleSignal?.addEventListener('abort', abort, { once: true })
    if (signal.aborted || lifecycleSignal?.aborted) controller.abort()

    const assertCurrent = () => {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason
        if (reason instanceof Error && /superseded/i.test(reason.message)) throw reason
        throw abortError()
      }
      if (invocationGeneration !== session.referenceGeneration) {
        throw new Error('Reference audio analysis was superseded by a newer invocation')
      }
    }

    try {
      assertCurrent()
      return await task(controller.signal, assertCurrent)
    } finally {
      signal.removeEventListener('abort', abort)
      lifecycleSignal?.removeEventListener('abort', abort)
      if (session.activeReferenceController === controller) session.activeReferenceController = null
    }
  }

  async function runPerformance<T>(signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return performance.run(operationSignal => runAbortable(operationSignal, task), signal)
  }

  function assertPerformanceIdle(action: string): void {
    if (performance.active) throw new Error(`${action} is unavailable while a performance is in progress`)
  }

  /**
   * Where `apply_patch`'s routes will land, decided against a COPY of the matrix
   * before a single slot is written.
   *
   * Slot choice is the same rule `set_modulation`'s `add` uses - an existing
   * source+destination pair is replaced in place, otherwise the first free slot -
   * so a route means the same thing through either tool. Resolving it on a copy is
   * what makes "the matrix is full" a validation error instead of a partial apply:
   * `set_modulation` can only discover it on the route that overflows, after the
   * earlier ones have already been written.
   */
  function planModulations(input: { replace: boolean; routes: ValidatedRoute[] } | null) {
    if (!input) return null
    const simulated: (ModSlotState | null)[] = engine.modSlots.map(route => route ? { ...route } : null)
    const clearSlots: number[] = []
    if (input.replace) {
      simulated.forEach((route, slot) => {
        if (route) {
          clearSlots.push(slot)
          simulated[slot] = null
        }
      })
    }
    const assignments = input.routes.map(route => {
      const existing = simulated.findIndex(candidate => candidate?.source === route.source && candidate.dest === route.destination)
      const slot = existing >= 0 ? existing : simulated.findIndex(candidate => candidate === null)
      if (slot < 0) {
        throw new Error(`Modulation matrix is full: ${MOD_SOURCES[route.source].id} -> ${PARAMS[route.destination].id} needs a slot and all ${MAX_MOD_SLOTS} are taken. Nothing was applied. Free one with set_modulation({"action":"remove",...}), or pass modulations.replace: true to rebuild the matrix from these routes alone.`)
      }
      const state: ModSlotState = {
        source: route.source,
        dest: route.destination,
        depth: route.depth,
        enabled: route.enabled ?? simulated[slot]?.enabled ?? true
      }
      simulated[slot] = state
      return { slot, state }
    })
    return { clearSlots, assignments, totalAfter: simulated.filter(Boolean).length }
  }

  function scopeCandidate(options: AnalyzeAudioOptions = {}) {
    const sampleRate = engine.ctx?.sampleRate ?? 48000
    // `withPitchNote` here, and on every other result carrying metrics: a null
    // `pitch` is silent from the tool layer otherwise, and it zeroes three
    // comparison dimensions. See `pitchNoteFor`. Deliberately NOT folded into
    // `metricNotes`, which text mode drops (`TEXT_MODE_OMITTED_FIELDS`) — that
    // is the mode `compare_audio` defaults to, i.e. exactly where the eval agent
    // needed it.
    return withPitchNote({
      source: 'scope' as const,
      sampleRate,
      channels: 2,
      metrics: analyzeAudio([engine.scopeL, engine.scopeR], sampleRate, options),
      metricNotes: METRIC_NOTES,
      // Ships with every scope result, `compare_audio`'s fallback candidate
      // included: the buffer is ~21 ms long, and its envelope figures read as
      // measurements of a note when they are measurements of a fragment.
      scopeNote: SCOPE_NOTE
    })
  }

  /**
   * The newest `seconds` of the rolling capture, or the refusal that names what
   * fills it. Separate from the analysis below so one read of the ring can serve
   * both the metrics and the WAV `capture_audio` hands back.
   */
  function requireRecentAudio(seconds: number): RecentAudio {
    const recent = engine.recentAudio(seconds)
    if (!recent) throw new Error(NO_RECENT_AUDIO)
    return recent
  }

  /**
   * That window, analysed. The counterpart to `scopeCandidate`: the same live
   * output, read from the engine's ring instead of from the 1024-sample scope,
   * so the envelope and brightness figures describe a note.
   *
   * Analysed off-thread like every other multi-second buffer — the ring holds up
   * to 192 000 frames per channel, which is a real FFT workload, not the 1024
   * samples `scopeCandidate` can afford to analyse inline.
   */
  async function recentCandidate(recent: RecentAudio, signal: AbortSignal, options: AnalyzeAudioOptions = {}) {
    const metrics = await analyzeAudioAsync(recent.channelData, recent.sampleRate, signal, options)
    return withPitchNote({
      source: 'recent' as const,
      sampleRate: recent.sampleRate,
      channels: recent.channelData.length,
      duration: clean(recent.duration),
      /** What the ring holds right now; `duration` is capped by it. */
      heldSeconds: clean(recent.heldSeconds),
      bufferSeconds: RECENT_AUDIO_SECONDS,
      metrics,
      metricNotes: METRIC_NOTES,
      recentNote: RECENT_NOTE
    })
  }

  function currentCandidate() {
    if (session.lastRender) return withPitchNote({
      source: 'last-render' as const,
      sampleRate: session.lastRender.sampleRate,
      channels: session.lastRender.channels,
      url: session.lastRender.url,
      metrics: session.lastRender.metrics,
      metricNotes: METRIC_NOTES
    })
    return scopeCandidate()
  }

  /**
   * One render, analysed and stored as `session.lastRender`. Extracted from
   * `render_audio` so `compare_audio`'s `autoRender` renders exactly the same
   * way — same offline preference, same replay bookkeeping, same analysis
   * options — instead of growing a second, subtly different render path.
   */
  async function renderSequence(
    notes: { midi: number; velocity: number; start: number; duration: number }[],
    duration: number,
    requestedMode: RenderMode | undefined,
    operationSignal: AbortSignal,
    replayLabel: string,
    analysisOptions: AnalyzeAudioOptions
  ): Promise<{
    recording: RecordedAudio
    metrics: AudioMetrics
    renderMode: RenderMode
    renderModeFallback?: string
    url: string
  }> {
    // Whether offline works here is a property of the browser, not of the
    // request: a default (mode-less) call on a browser without an offline
    // renderer must not be told to retry with `mode: "offline"`.
    const offlineUnavailable = offlineRenderer === null
    const wantsOffline = requestedMode === undefined ? !offlineUnavailable : requestedMode === 'offline'
    const renderModeFallback = wantsOffline && offlineUnavailable
      ? 'Offline rendering is unavailable here (no OfflineAudioContext or AudioWorklet); captured the live output in real time instead'
      : undefined
    const soundEntryId = dependencies.currentSoundEntryId?.()
    const commit = (recording: RecordedAudio, metrics: AudioMetrics, renderMode: RenderMode) => {
      if (session.lastRender) URL.revokeObjectURL(session.lastRender.url)
      const url = URL.createObjectURL(recording.blob)
      session.lastRender = { metrics, sampleRate: recording.sampleRate, channels: recording.channelData.length, url, soundEntryId }
      return { recording, metrics, renderMode, ...(renderModeFallback ? { renderModeFallback } : {}), url }
    }

    if (wantsOffline && offlineRenderer) {
      // No live graph, no held-note conflict, no Start gesture: the whole
      // point of the offline path.
      throwIfAborted(operationSignal)
      // The signal goes *into* the renderer: an offline render burns CPU
      // for as long as it takes, and without it a cancellation could only
      // be reported once the whole render had finished.
      const recording = await offlineRenderer(engine, notes, duration, { signal: operationSignal })
      throwIfAborted(operationSignal)
      const metrics = await analyzeAudioAsync(recording.channelData, recording.sampleRate, operationSignal, analysisOptions)
      return commit(recording, metrics, 'offline')
    }

    if (!engine.running) {
      throw new Error(offlineUnavailable
        ? 'Start audio with a user gesture before rendering audio: offline rendering is unavailable in this browser'
        : 'Start audio with a user gesture before rendering audio, or use mode: "offline"')
    }
    assertNotesAvailable(engine, notes)
    throwIfAborted(operationSignal)
    const replayId = dependencies.replays?.startPerformance(notes, duration, replayLabel, soundEntryId)
    const controller = new AbortController()
    const forwardAbort = () => controller.abort()
    operationSignal.addEventListener('abort', forwardAbort, { once: true })
    let recordingTask: ReturnType<SynthEngine['recordOutput']> | undefined
    let notesTask: Promise<void> | undefined
    try {
      recordingTask = engine.recordOutput(duration, controller.signal)
      notesTask = performance.trackPlayback(() => performNotes(engine, notes, controller.signal), 'ai')
      const [recording] = await Promise.all([recordingTask, notesTask])
      throwIfAborted(operationSignal)
      const metrics = await analyzeAudioAsync(recording.channelData, recording.sampleRate, operationSignal, analysisOptions)
      if (replayId) dependencies.replays!.finishPerformance(replayId, 'completed')
      return commit(recording, metrics, 'realtime')
    } catch (error) {
      controller.abort()
      await Promise.allSettled([recordingTask, notesTask])
      if (replayId) dependencies.replays!.finishPerformance(replayId, operationSignal.aborted ? 'cancelled' : 'failed')
      throw error
    } finally {
      controller.abort()
      operationSignal.removeEventListener('abort', forwardAbort)
    }
  }

  return [
    {
      name: 'get_synth_state',
      description: 'Get live synth state: runtime, FX order, modulation routes, and preset identity. One call with `format: "compact"` also returns every parameter that differs from its default as `id=formatted` lines — the cheapest way to verify a patch. `patch.preset` is `{name, source, dirty}`; `dirty: true` means the patch was edited since that preset was loaded or saved, so read it before deciding whether to save. Routes ship by default in `patch.modulations` (with `total`, and `nextOffset` when more exist — raise `modulationLimit`). `lfo: 1` returns one shape as `patch.lfoShape`.',
      inputSchema: {
        type: 'object', properties: {
          format: { type: 'string', enum: ['full', 'compact'] },
          group: {
            type: 'string', maxLength: MAX_QUERY_LENGTH,
            description: GROUP_PROPERTY_DESCRIPTION
          },
          search: {
            type: 'string', maxLength: MAX_QUERY_LENGTH,
            description: SEARCH_PROPERTY_DESCRIPTION
          },
          parameterOffset: {
            type: 'integer', minimum: 0,
            description: 'Full-format paging cursor; omit it with `format: "compact"`.'
          },
          parameterLimit: {
            type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE,
            description: `Full-format page size (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}); omit it with \`format: "compact"\`, which needs none and returns every non-default parameter in one response.`
          },
          modulationOffset: { type: 'integer', minimum: 0 },
          modulationLimit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE },
          lfo: { type: 'integer', minimum: 1, maximum: 8 },
          lfoPointOffset: { type: 'integer', minimum: 0 },
          lfoPointLimit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE }
        }, additionalProperties: false
      },
      annotations: { readOnlyHint: true },
      execute(input) {
        const value = assertObject(input, 'input', [
          'format', 'group', 'search', 'parameterOffset', 'parameterLimit', 'modulationOffset', 'modulationLimit',
          'lfo', 'lfoPointOffset', 'lfoPointLimit'
        ])
        const format = assertFormat(value.format)
        if (value.group !== undefined && typeof value.group !== 'string') throw new Error('group must be a string')
        if (value.search !== undefined && typeof value.search !== 'string') throw new Error('search must be a string')
        const requestedGroup = value.group as string | undefined
        const search = value.search as string | undefined
        if (requestedGroup && requestedGroup.length > MAX_QUERY_LENGTH) throw new Error(`group is limited to ${MAX_QUERY_LENGTH} characters`)
        const group = requestedGroup ? assertGroup(requestedGroup) : requestedGroup
        if (search && search.length > MAX_QUERY_LENGTH) throw new Error(`search is limited to ${MAX_QUERY_LENGTH} characters`)
        const offset = boundedInteger(value.parameterOffset, 'parameterOffset', 0, 0, PARAMS.length)
        const limit = boundedInteger(value.parameterLimit, 'parameterLimit', format === 'compact' ? COMPACT_PAGE_SIZE : DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE)
        const matches = filteredParameters(group, search)
        const includeParameters = format === 'compact' || group !== undefined || search !== undefined || value.parameterOffset !== undefined || value.parameterLimit !== undefined
        const includeModulations = value.modulationOffset !== undefined || value.modulationLimit !== undefined
        const includeLfo = value.lfo !== undefined || value.lfoPointOffset !== undefined || value.lfoPointLimit !== undefined
        // Modulation paging is deliberately not part of this exclusivity: the
        // routes always ship, so a wider page of them is a bigger slice of a
        // field that is already there, not a competing view. It used to count,
        // which made `{format:'compact', modulationLimit:32}` throw - exactly
        // the recovery this tool's own description tells an agent to reach for.
        if (Number(includeParameters) + Number(includeLfo) > 1) {
          throw new Error('Request a detailed parameter page or one LFO shape in separate calls')
        }
        if (includeLfo && value.lfo === undefined) throw new Error('lfo is required when paging LFO points')
        const modulations = currentModRoutes(engine) ?? []
        const modulationOffset = boundedInteger(value.modulationOffset, 'modulationOffset', 0, 0, MAX_MOD_SLOTS)
        const modulationLimit = boundedInteger(value.modulationLimit, 'modulationLimit', 5, 1, MAX_PAGE_SIZE)
        const modulationPage = modulations.slice(modulationOffset, modulationOffset + modulationLimit)
        const lfo = value.lfo === undefined ? undefined : boundedInteger(value.lfo, 'lfo', 1, 1, 8)
        const lfoPoints = lfo === undefined ? [] : engine.lfoShapes[lfo - 1]
        const lfoPointOffset = boundedInteger(value.lfoPointOffset, 'lfoPointOffset', 0, 0, lfoPoints.length)
        const lfoPointLimit = boundedInteger(value.lfoPointLimit, 'lfoPointLimit', 5, 1, MAX_PAGE_SIZE)
        const lfoPointPage = lfoPoints.slice(lfoPointOffset, lfoPointOffset + lfoPointLimit)
        const page = matches.slice(offset, offset + limit)
        const changed = format !== 'compact' ? [] : matches.flatMap(def => {
          const normalized = engine.values[paramIndex(def.id)]
          return Math.abs(normalized - defaultNorm(def)) < 1e-6 ? [] : [`${def.id}=${formatValue(def, normalized)}`]
        })
        // `Custom` reads back as `Custom` from `engine.values` however empty the
        // slot is, so a patch verified here would confirm a table the oscillator
        // is not playing. Named at `patch` level rather than inside
        // `parameters`, because the page an agent asks for often does not hold
        // osc*.wavetable at all — and it costs nothing while no slot is affected.
        const emptyCustom = emptyCustomWavetables(engine)
        return {
          runtime: runtimeSnapshot(engine),
          patch: {
            ...fxOrder(engine),
            ...(emptyCustom.length === 0 ? {} : {
              wavetableFallback: {
                parameters: emptyCustom,
                resolvesTo: CUSTOM_WAVETABLE_FALLBACK,
                note: emptyCustom.map(emptyCustomWavetableNote).join(' ')
              }
            }),
            // Three short fields, in every format, because this is the question
            // asked BEFORE deciding whether a save is needed - and a tool of its
            // own would have to be discovered first, then called as a second
            // round trip by an agent that is already reading the patch here.
            // `name: null` is the honest answer before anything has been loaded;
            // `dirty` is then false, because there is nothing to differ from.
            preset: currentPresetState(engine),
            modulationCount: modulations.length,
            // Returned by default: an agent verifying a patch it just wrote
            // needs the routes, and the default page keeps a saturated matrix
            // inside the discovery output budget.
            modulations: {
              items: modulationPage, offset: modulationOffset, limit: modulationLimit, total: modulations.length,
              ...(modulationOffset + modulationPage.length < modulations.length ? { nextOffset: modulationOffset + modulationPage.length } : {})
            },
            ...(includeParameters ? {
              parameters: format === 'compact'
                ? { items: changed, total: changed.length, format: 'compact' as const }
                : {
                  items: Object.fromEntries(page.map(def => [def.id, parameterValue(def, engine.values[paramIndex(def.id)])])),
                  offset, limit, total: matches.length,
                  ...(offset + page.length < matches.length ? { nextOffset: offset + page.length } : {})
                }
            } : {}),
            ...(!includeLfo || lfo === undefined ? {} : {
              lfoShape: {
                id: `lfo${lfo}`,
                points: {
                  items: lfoPointPage.map(point => ({ ...point })), offset: lfoPointOffset, limit: lfoPointLimit, total: lfoPoints.length,
                  ...(lfoPointOffset + lfoPointPage.length < lfoPoints.length ? { nextOffset: lfoPointOffset + lfoPointPage.length } : {})
                }
              }
            })
          }
        }
      }
    },
    {
      name: 'get_parameter_schema',
      description: `Discover parameter units, ranges, defaults, curves, choices, and modulation capabilities. One unfiltered call with \`format: "compact"\` returns all ${PARAMS.length} parameters, one line each (\`filter1.cutoff Hz 20..20000 exp =8000 mod\`). env1 is the amplitude envelope (VCA) and the only hardwired modulator: env2-env6 and lfo1-lfo8 do nothing until routed with \`set_modulation\`; \`groupNotes\` repeats such facts for the groups on the page. Add \`sourceLimit\` for the modulation source ids \`set_modulation\` accepts.`,
      inputSchema: {
        type: 'object', properties: {
          format: { type: 'string', enum: ['full', 'compact'] },
          group: {
            type: 'string', maxLength: MAX_QUERY_LENGTH,
            description: GROUP_FILTER_DESCRIPTION
          },
          search: {
            type: 'string', maxLength: MAX_QUERY_LENGTH,
            description: SEARCH_FILTER_DESCRIPTION
          },
          offset: {
            type: 'integer', minimum: 0,
            description: 'Full-format paging cursor; omit it with `format: "compact"`.'
          },
          limit: {
            type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE,
            description: `Full-format page size (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}); omit it with \`format: "compact"\`, which needs none and returns all ${PARAMS.length} parameters in one response.`
          },
          sourceOffset: { type: 'integer', minimum: 0 },
          sourceLimit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE }
        }, additionalProperties: false
      },
      annotations: { readOnlyHint: true },
      execute(input) {
        const value = assertObject(input, 'input', ['format', 'group', 'search', 'offset', 'limit', 'sourceOffset', 'sourceLimit'])
        const format = assertFormat(value.format)
        if (value.group !== undefined && typeof value.group !== 'string') throw new Error('group must be a string')
        if (value.search !== undefined && typeof value.search !== 'string') throw new Error('search must be a string')
        if ((value.group as string | undefined)?.length && (value.group as string).length > MAX_QUERY_LENGTH) throw new Error(`group is limited to ${MAX_QUERY_LENGTH} characters`)
        if ((value.search as string | undefined)?.length && (value.search as string).length > MAX_QUERY_LENGTH) throw new Error(`search is limited to ${MAX_QUERY_LENGTH} characters`)
        const requestedGroup = value.group as string | undefined
        const group = requestedGroup ? assertGroup(requestedGroup) : undefined
        const matches = filteredParameters(group, value.search as string | undefined)
        const related = group === undefined ? [] : relatedGroups(group)
        const offset = boundedInteger(value.offset, 'offset', 0, 0, PARAMS.length)
        // An explicit limit is bounded by what the schema advertises; only the
        // compact default reaches past it, to hand over the whole space at once.
        const limit = boundedInteger(value.limit, 'limit', format === 'compact' ? COMPACT_PAGE_SIZE : DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE)
        const page = matches.slice(offset, offset + limit)
        // What each choice SOUNDS like, for the parameters whose names say
        // nothing — an eval agent spent four render-and-compare rounds guessing
        // which of the seven wavetables was the bright one and found it by luck.
        //
        // Emitted once per distinct notes object. `osc1/2/3.wavetable` share ONE
        // (`WAVETABLE_NOTES`, by reference) and it is ~2 kB, so a page wide
        // enough to hold all three — which is the page an agent asks for when it
        // wants to see everything — used to be the only way to read them and
        // would have paid ~6 kB for one table's worth of prose. Identity, not
        // deep equality: two parameters that happened to describe their choices
        // the same way would still be two separate facts.
        const notesCarriedBy = new Map<object, string>()
        const parameters = page.map(def => {
          const sharedWith = def.choiceNotes ? notesCarriedBy.get(def.choiceNotes) : undefined
          if (def.choiceNotes && sharedWith === undefined) notesCarriedBy.set(def.choiceNotes, def.id)
          return {
            id: def.id, name: def.name, group: def.group,
            min: def.choices ? 0 : def.min,
            max: def.choices ? def.choices.length - 1 : def.max,
            default: def.def,
            normalizedDefault: clean(defaultNorm(def)),
            ...(def.step === undefined ? {} : { step: def.step }),
            ...(def.choices ? { choices: [...def.choices] } : {}),
            ...(def.choiceNotes === undefined
              ? {}
              : sharedWith === undefined
                ? { choiceNotes: def.choiceNotes }
                : { choiceNotesSameAs: sharedWith }),
            ...(def.unit === undefined ? {} : { unit: def.unit }),
            curve: def.curve ?? 'lin',
            moddable: def.moddable === true
          }
        })
        // Either paging key asks for the source vocabulary; a limit on its own
        // implies offset 0, so `{ sourceLimit: 60 }` hands over the whole list.
        const includeSources = value.sourceOffset !== undefined || value.sourceLimit !== undefined
        const sourceOffset = boundedInteger(value.sourceOffset, 'sourceOffset', 0, 0, MOD_SOURCES.length)
        const sourceLimit = boundedInteger(value.sourceLimit, 'sourceLimit', DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE)
        const sources = includeSources ? MOD_SOURCES.slice(sourceOffset, sourceOffset + sourceLimit) : []
        const nextSourceOffset = sourceOffset + sources.length < MOD_SOURCES.length
          ? { nextOffset: sourceOffset + sources.length }
          : {}
        // Only the notes for groups actually on this page, so the default
        // response stays inside the discovery output budget.
        const groupNotes = Object.fromEntries(
          [...new Set(page.map(def => def.group))]
            .flatMap(group => PARAM_GROUP_NOTES[group] ? [[group, PARAM_GROUP_NOTES[group]]] : [])
        )
        return {
          groups: [...PARAMETER_GROUPS],
          // Says out loud what a group filter actually narrowed to, and that
          // the unfiltered compact call would have been one round trip. An
          // evaluated agent spent five calls, one group at a time, on what
          // `{ format: 'compact' }` alone returns.
          ...(group === undefined ? {} : {
            groupFilter: {
              group,
              total: matches.length,
              ...(related.length === 0 ? {} : { relatedGroups: related }),
              note: `group "${group}" is ${matches.length} of ${PARAMS.length} parameters` +
                (related.length === 0 ? '' : `, and ${related.join(', ')} ${related.length === 1 ? 'is a separate group' : 'are separate groups'}`) +
                `. One call with {"format":"compact"} and no group returns all ${PARAMS.length}.`
            }
          }),
          ...(Object.keys(groupNotes).length === 0 ? {} : { groupNotes }),
          parameters: format === 'compact'
            ? {
              items: page.map(compactParameter), total: matches.length, format: 'compact' as const,
              ...(offset + page.length < matches.length ? { nextOffset: offset + page.length } : {})
            }
            : { items: parameters, offset, limit, total: matches.length, ...(offset + page.length < matches.length ? { nextOffset: offset + page.length } : {}) },
          ...(!includeSources ? {} : {
            modulationSources: format === 'compact'
              ? { items: sources.map(compactSource), total: MOD_SOURCES.length, format: 'compact' as const, ...nextSourceOffset }
              : { items: sources.map(source => ({ ...source })), offset: sourceOffset, limit: sourceLimit, total: MOD_SOURCES.length, ...nextSourceOffset }
          }),
          limits: {
            modulationSlots: MAX_MOD_SLOTS,
            modulationDepth: [-1, 1],
            midiNotes: [0, 127],
            maxNotes: MAX_NOTES,
            maxPlaySeconds: MAX_PLAY_SECONDS,
            maxRenderSeconds: MAX_RENDER_SECONDS
          }
        }
      }
    },
    {
      name: 'update_parameters',
      description: 'Atomically validate and apply a batch of raw-unit parameter values or textual choice labels. Example: {"updates":[{"id":"filter1.cutoff","value":1200},{"id":"filter1.type","value":"LP 24"}]}',
      inputSchema: {
        type: 'object',
        properties: {
          updates: {
            type: 'array', minItems: 1,
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, value: { anyOf: [{ type: 'number' }, { type: 'string' }] } },
              required: ['id', 'value'], additionalProperties: false
            }
          }
        },
        required: ['updates'], additionalProperties: false
      },
      annotations: { readOnlyHint: false },
      execute(input) {
        assertPerformanceIdle('Parameter updates')
        const value = assertObject(input, 'input', ['updates'], ['updates'])
        const validated = validateParameterUpdates(value.updates, 'updates')
        for (const update of validated) engine.setParam(update.index, update.normalized, 'ai')
        return { applied: validated.map(update => appliedParameter(update, engine)) }
      }
    },
    {
      name: 'set_modulation',
      description: `Add, update, remove, or clear modulation routes in the shared ${MAX_MOD_SLOTS}-slot matrix. \`add\` takes \`source\`+\`destination\` and replaces any route on that pair; \`update\`/\`remove\` address a route by \`slot\` or by that same pair — never both, and a pair with no route is an error, not a new route. \`depth\` is bipolar (-1..1): added to the destination's normalized 0..1 value, then clamped, so depth 0.5 on a parameter at 0.5 sweeps it to 1.0. Example: {"action":"add","source":"lfo1","destination":"filter1.cutoff","depth":0.4}`,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'update', 'remove', 'clear'] },
          source: {
            type: 'string',
            description: `Source id: ${MOD_SOURCE_IDS.join(', ')}. Required by \`add\`; on \`update\`/\`remove\` it pairs with \`destination\` instead of \`slot\`.`
          },
          destination: {
            type: 'string',
            description: 'Moddable parameter id (`mod` in the compact schema). Required by `add`; pairs with `source` on `update`/`remove`.'
          },
          depth: { type: 'number', minimum: -1, maximum: 1 },
          enabled: { type: 'boolean' },
          slot: {
            type: 'integer', minimum: 0, maximum: MAX_MOD_SLOTS - 1,
            description: 'Matrix slot from `route.slot`; the alternative to a `source`+`destination` pair on `update`/`remove` — passing both is ambiguous.'
          }
        },
        required: ['action'], additionalProperties: false
      },
      annotations: { readOnlyHint: false },
      execute(input) {
        assertPerformanceIdle('Modulation changes')
        const value = assertObject(input, 'input', ['action', 'source', 'destination', 'depth', 'enabled', 'slot'], ['action'])
        if (!['add', 'update', 'remove', 'clear'].includes(value.action as string)) throw new Error('Unknown modulation action')
        const action = value.action as string
        const count = () => engine.modSlots.filter(Boolean).length
        if (action === 'clear') {
          assertObject(input, 'input', ['action'], ['action'])
          engine.modSlots.forEach((route, slot) => { if (route) engine.setModSlot(slot, null, 'ai') })
          return { cleared: true, count: count() }
        }
        /**
         * The slot an `update`/`remove` means. A `source`+`destination` pair
         * resolves the way `add` resolves it, so both actions mean exactly the
         * route `add` would have replaced; naming both forms is ambiguous
         * rather than merely redundant, and a pair that names nothing is an
         * error instead of a new route.
         */
        const addressedSlot = (): number => {
          const byPair = value.source !== undefined || value.destination !== undefined
          if (!byPair) {
            if (value.slot === undefined) throw new Error(`Modulation route address missing. ${ROUTE_ADDRESSING}`)
            return assertModSlot(value.slot)
          }
          if (value.slot !== undefined) throw new Error(`Ambiguous route address: pass either 'slot' or 'source'+'destination', not both. ${ROUTE_ADDRESSING}`)
          if (value.source === undefined || value.destination === undefined) {
            throw new Error(`Addressing a route by name needs both source and destination. ${ROUTE_ADDRESSING}`)
          }
          const source = assertModSource(value.source)
          const dest = assertModDestination(value.destination)
          const slot = engine.modSlots.findIndex(route => route?.source === source && route.dest === dest)
          if (slot < 0) throw new Error(`No modulation route from '${value.source}' to '${value.destination}'. Create it with action 'add'. ${ROUTE_ADDRESSING}`)
          return slot
        }
        if (action === 'remove') {
          assertObject(input, 'input', ['action', 'slot', 'source', 'destination'], ['action'])
          const slot = addressedSlot()
          if (!engine.modSlots[slot]) throw new Error(`Modulation slot ${slot} is empty`)
          engine.setModSlot(slot, null, 'ai')
          return { removed: slot, count: count() }
        }
        if (action === 'update') {
          assertObject(input, 'input', ['action', 'slot', 'source', 'destination', 'depth', 'enabled'], ['action'])
          const slot = addressedSlot()
          const current = engine.modSlots[slot]
          if (!current) throw new Error(`Modulation slot ${slot} is empty`)
          if (value.depth === undefined && value.enabled === undefined) throw new Error('update requires depth and/or enabled')
          const depth = value.depth === undefined ? current.depth : finite(value.depth, 'depth')
          if (depth < -1 || depth > 1) throw new Error('depth must be in range -1..1')
          if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('enabled must be boolean')
          const route = { ...current, depth, enabled: value.enabled === undefined ? current.enabled : value.enabled }
          engine.setModSlot(slot, route, 'ai')
          return { route: routeValue(slot, route), count: count() }
        }
        assertObject(input, 'input', ['action', 'source', 'destination', 'depth', 'enabled'], ['action', 'source', 'destination', 'depth'])
        const source = assertModSource(value.source)
        const dest = assertModDestination(value.destination)
        const depth = finite(value.depth, 'depth')
        if (depth < -1 || depth > 1) throw new Error('depth must be in range -1..1')
        if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('enabled must be boolean')
        const existingSlot = engine.modSlots.findIndex(route => route?.source === source && route.dest === dest)
        let slot = existingSlot
        if (slot < 0) slot = engine.modSlots.findIndex(route => route === null)
        if (slot < 0) throw new Error('Modulation matrix is full')
        const existing = existingSlot >= 0 ? engine.modSlots[existingSlot] : null
        const route = {
          source,
          dest,
          depth,
          enabled: value.enabled === undefined ? (existing?.enabled ?? true) : value.enabled
        }
        engine.setModSlot(slot, route, 'ai')
        return { route: routeValue(slot, route), count: count() }
      }
    },
    {
      name: 'set_fx_order',
      description: `Reorder the effects chain — the one patch edit with no parameter behind it, so until now an agent could switch every effect on without being able to say which came first. \`order\` is all ${FX_IDS.length} effect ids exactly once, first processed first; whether an effect does anything is \`<id>.enabled\` in update_parameters. Example: {"order":["fxdist","chorus","phaser","flanger","delay","reverb","eq","comp"]}`,
      inputSchema: {
        type: 'object',
        properties: {
          order: {
            type: 'array',
            minItems: FX_IDS.length,
            maxItems: FX_IDS.length,
            items: { type: 'string', enum: [...FX_IDS] },
            description: FX_ORDER_DESCRIPTION
          }
        },
        required: ['order'], additionalProperties: false
      },
      annotations: { readOnlyHint: false },
      execute(input) {
        assertPerformanceIdle('FX order changes')
        const value = assertObject(input, 'input', ['order'], ['order'])
        const order = validateFxOrder(value.order, 'order')
        const previous = fxOrder(engine).fxOrder
        // Origin 'ai', like every other agent edit: `activity.ts` records the
        // `{kind:'fx'}` mutation as a pending change, so the FX rack glows and
        // Reject restores this exact array through `setFxOrder(change.before,
        // 'restore')`. A 'human' origin here would apply the change and leave the
        // human no way to undo it from the AI-changes panel.
        engine.setFxOrder(order, 'ai')
        const applied = fxOrder(engine).fxOrder
        return {
          fxOrder: applied,
          previous,
          changed: previous.join() !== applied.join()
        }
      }
    },
    {
      name: 'apply_patch',
      description: 'Build a whole sound in one call: parameters, modulation routes and FX order applied together, then optionally saved and auditioned. Everything is validated before anything is applied and the patch lands all or nothing, using the same validation `update_parameters` and `set_modulation` use. `dryRun: true` reports what would change and touches nothing. `auditionNotes` RENDERS the result rather than playing it, so it needs no Start gesture. `rollbackId` in the result is the history version that undoes the whole call.',
      inputSchema: {
        type: 'object',
        properties: {
          parameters: {
            type: 'array', minItems: 1,
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, value: { anyOf: [{ type: 'number' }, { type: 'string' }] } },
              required: ['id', 'value'], additionalProperties: false
            },
            description: 'What `update_parameters` takes: raw-unit values or choice labels.'
          },
          modulations: {
            type: 'object',
            description: 'Routes as `set_modulation`\'s `add` resolves them. `replace: true` clears the matrix first, so `routes` becomes all of it; on its own it just clears.',
            properties: {
              replace: { type: 'boolean' },
              routes: {
                type: 'array', maxItems: MAX_MOD_SLOTS,
                items: {
                  type: 'object',
                  properties: {
                    source: { type: 'string', description: `One of: ${MOD_SOURCE_IDS.join(', ')}.` },
                    destination: { type: 'string', description: 'Moddable parameter id.' },
                    depth: { type: 'number', minimum: -1, maximum: 1 },
                    enabled: { type: 'boolean' }
                  },
                  required: ['source', 'destination', 'depth'], additionalProperties: false
                }
              }
            },
            additionalProperties: false
          },
          fxOrder: {
            type: 'array',
            minItems: FX_IDS.length,
            maxItems: FX_IDS.length,
            items: { type: 'string', enum: [...FX_IDS] },
            description: FX_ORDER_DESCRIPTION
          },
          presetName: {
            type: 'string', minLength: 1, maxLength: 80,
            description: 'Save the applied patch under this name, as save_preset would.'
          },
          auditionNotes: {
            type: 'array', minItems: 1, maxItems: MAX_NOTES, items: noteSchema,
            description: 'Render these against the new patch and return its metrics: the render_audio step without a second round trip.'
          },
          dryRun: { type: 'boolean', description: 'Validate and report what would change, applying, saving and rendering nothing.' }
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: false },
      async execute(input, options) {
        // ---------------------------------------------------------------------
        // Everything up to the audition is deliberately SYNCHRONOUS, with no
        // `await` before the last engine write. `register.ts` runs this tool
        // inside `services.history.runAi(...)`, and `runAi` is synchronous: it
        // ends its transaction as soon as the callback returns. An `await`
        // anywhere above the apply would hand back a pending promise, close the
        // transaction early, and split one patch into a string of separate
        // history versions attributed to the human. Keep the awaits below the
        // apply.
        // ---------------------------------------------------------------------
        assertPerformanceIdle('Patch changes')
        const value = assertObject(input, 'input', ['parameters', 'modulations', 'fxOrder', 'presetName', 'auditionNotes', 'dryRun'])
        if (value.dryRun !== undefined && typeof value.dryRun !== 'boolean') throw new Error('dryRun must be boolean')
        const dryRun = value.dryRun === true

        // Validate everything first, so a bad mod destination cannot be found out
        // after the parameters have already moved.
        const parameters = value.parameters === undefined ? [] : validateParameterUpdates(value.parameters, 'parameters')
        const modulations = value.modulations === undefined ? null : validateModulationInput(value.modulations)
        const order = value.fxOrder === undefined ? null : validateFxOrder(value.fxOrder, 'fxOrder')
        const presetName = value.presetName === undefined ? undefined : validatePresetName(value.presetName)
        const audition = value.auditionNotes === undefined
          ? null
          : validatePerformanceNotes(resolveNoteInputs(value.auditionNotes, 'auditionNotes'), MAX_RENDER_SECONDS)
        if (parameters.length === 0 && !modulations && !order) {
          throw new Error('apply_patch needs at least one of parameters, modulations or fxOrder. presetName saves the patch as it already is (save_preset), and auditionNotes renders it (render_audio); neither is a change on its own.')
        }
        // Slot assignment, and the matrix-full check with it, happen against the
        // live matrix before anything is written: `set_modulation` can only find
        // out it is full on the route that overflows, by which point earlier
        // routes have already landed.
        const plan = planModulations(modulations)
        const rollbackId = dependencies.currentSoundEntryId?.()

        if (dryRun) {
          return {
            dryRun: true,
            applied: false,
            wouldApply: {
              ...(parameters.length === 0 ? {} : {
                parameters: parameters.map(update => ({
                  ...appliedParameter(update, engine),
                  from: formatValue(update.def, engine.values[update.index]),
                  willChange: Math.abs(engine.values[update.index] - update.normalized) > 1e-9
                }))
              }),
              ...(plan === null ? {} : {
                modulations: {
                  cleared: plan.clearSlots.length,
                  routes: plan.assignments.map(assignment => routeValue(assignment.slot, assignment.state)),
                  totalAfter: plan.totalAfter
                }
              }),
              ...(order === null ? {} : { fxOrder: { from: fxOrder(engine).fxOrder, to: order.map(index => FX_IDS[index]) } }),
              ...(presetName === undefined ? {} : { presetName }),
              ...(audition === null ? {} : { audition: pitchEcho(audition.notes) })
            },
            note: 'Nothing was changed, saved or rendered. Everything above validated; call again without dryRun to apply it.'
          }
        }

        // What has to go back if a write throws part-way. Only the fields this call
        // writes are captured, which is exactly the fields it can damage.
        const beforeParameters = parameters.map(update => ({ index: update.index, normalized: engine.values[update.index] }))
        const touchedSlots = plan === null ? [] : [...new Set([...plan.clearSlots, ...plan.assignments.map(assignment => assignment.slot)])]
        const beforeSlots = touchedSlots.map(slot => ({ slot, state: engine.modSlots[slot] ? { ...engine.modSlots[slot]! } : null }))
        const beforeOrder = engine.fxOrder.slice()

        // One batch: `batchSoundChange` emits a single atomic sound change for the
        // whole patch, so it is one history version whether or not `runAi` is
        // wrapping this call. A revert inside the batch leaves the captured state
        // identical, so a failed apply records no version at all.
        engine.batchSoundChange('Apply patch', () => {
          try {
            for (const update of parameters) engine.setParam(update.index, update.normalized, 'ai')
            if (plan) {
              for (const slot of plan.clearSlots) engine.setModSlot(slot, null, 'ai')
              for (const assignment of plan.assignments) engine.setModSlot(assignment.slot, assignment.state, 'ai')
            }
            if (order) engine.setFxOrder(order, 'ai')
          } catch (error) {
            // Rolled back with the same 'ai' origin the writes used, so the
            // agent-change ledger nets to zero: `activity.ts` drops a pending
            // change whose value returns to what it was before, and the human is
            // not left with a half-patch to Keep or Reject.
            for (const parameter of beforeParameters) engine.setParam(parameter.index, parameter.normalized, 'ai')
            for (const slot of beforeSlots) engine.setModSlot(slot.slot, slot.state, 'ai')
            if (order) engine.setFxOrder(beforeOrder, 'ai')
            throw new Error(`apply_patch applied nothing: ${error instanceof Error ? error.message : String(error)}. Every write this call had made was rolled back, so the patch is exactly as it was before the call.`)
          }
        })

        const applied = {
          ...(parameters.length === 0 ? {} : { parameters: parameters.map(update => appliedParameter(update, engine)) }),
          ...(plan === null ? {} : {
            modulations: {
              cleared: plan.clearSlots.length,
              routes: plan.assignments.map(assignment => routeValue(assignment.slot, assignment.state)),
              total: engine.modSlots.filter(Boolean).length
            }
          }),
          ...(order === null ? {} : fxOrder(engine))
        }

        // The patch is the deliverable and it is already live. A storage failure is
        // reported rather than allowed to revert a good patch, and it is reported
        // loudly rather than swallowed.
        let preset: Record<string, unknown> | undefined
        if (presetName !== undefined) {
          try {
            savePreset(engine.toPreset(presetName))
            markPresetLoaded(presetName, 'user', engine)
            preset = {
              name: presetName, saved: true, storage: 'localStorage',
              ...(factoryNames.has(presetName) ? { shadowsFactoryPreset: true } : {})
            }
          } catch (error) {
            preset = {
              name: presetName,
              saved: false,
              error: error instanceof Error ? error.message : String(error),
              note: 'The patch IS applied and live; only writing it to localStorage failed. Call save_preset again to retry the save, or read it back with get_synth_state.'
            }
          }
        }

        const result = {
          applied,
          ...(preset === undefined ? {} : { preset }),
          ...(rollbackId === undefined ? {} : { rollbackId }),
          rollback: rollbackId === undefined
            ? 'This build registers no sound history, so there is no rollback id. Reject in the AI-changes panel still reverts everything this call changed.'
            : `Everything above landed as ONE sound-history version. To undo the whole call: read \`revision\` from get_history({"view":"sounds"}), then navigate_history({"action":"restore","entryId":"${rollbackId}","expectedRevision":<revision>}). That id is the version this call started from, so restoring it also undoes nothing else.`
        }
        if (audition === null) return result

        // The first `await` in this tool, and deliberately the last thing it does.
        // Render, never play: playing needs the human's Start gesture and this tool
        // has to work before it. The render also measures its own pitch, so a
        // transposed patch is visible here rather than in the next call.
        const duration = Math.min(MAX_RENDER_SECONDS, clean(audition.duration + 0.25))
        try {
          const rendered = await runPerformance(invocationSignal(options), operationSignal => renderSequence(
            audition.notes, duration, undefined, operationSignal, 'AI patch audition', {}
          ))
          const requested = singlePitch(audition.notes)
          return {
            ...result,
            audition: withPitchNote({
              rendered: true,
              renderMode: rendered.renderMode,
              duration: rendered.recording.duration,
              sampleRate: rendered.recording.sampleRate,
              channels: rendered.recording.channelData.length,
              ...pitchEcho(audition.notes),
              ...(requested === null ? {} : { pitchCheck: pitchCheckFor(requested, rendered.metrics) }),
              metrics: rendered.metrics,
              metricNotes: METRIC_NOTES,
              ...(rendered.renderModeFallback ? { renderModeFallback: rendered.renderModeFallback } : {}),
              ...(audition.overlaps > 0 ? { retriggered: audition.overlaps } : {})
            })
          }
        } catch (error) {
          if ((error as Error | undefined)?.name === 'AbortError') throw error
          // The patch landed. Throwing here would report a failed call for a
          // successful patch, and an agent would apply it a second time.
          return {
            ...result,
            audition: {
              rendered: false,
              error: error instanceof Error ? error.message : String(error),
              note: 'The patch IS applied; only the audition render failed. Call render_audio to hear it, or get_synth_state to verify the patch.'
            }
          }
        }
      }
    },
    {
      name: 'play_notes',
      description: 'Play a bounded note sequence live; start/duration relative, in seconds. Each note names its pitch as `note` ("D2") or `midi` (38), never both, and `pitches` in the result echoes back what each resolved to. Runs only once a human clicks CLICK TO START AUDIO (runtime.running=true); before that use `render_audio`, which needs no gesture. A repeated pitch retriggers. Example: {"notes":[{"note":"C4","velocity":0.8,"start":0,"duration":0.5}]}',
      inputSchema: {
        type: 'object', properties: { notes: { type: 'array', minItems: 1, maxItems: MAX_NOTES, items: noteSchema } },
        required: ['notes'], additionalProperties: false
      },
      annotations: { readOnlyHint: false },
      async execute(input, options) {
        return runPerformance(invocationSignal(options), async operationSignal => {
          const value = assertObject(input, 'input', ['notes'], ['notes'])
          const sequence = validatePerformanceNotes(resolveNoteInputs(value.notes), MAX_PLAY_SECONDS)
          if (!engine.running) throw new Error('Start audio with a user gesture before playing notes; render_audio needs no gesture and renders the same notes offline')
          assertNotesAvailable(engine, sequence.notes)
          throwIfAborted(operationSignal)
          const replayId = dependencies.replays?.startPerformance(sequence.notes, sequence.duration, 'AI note sequence', dependencies.currentSoundEntryId?.())
          try {
            await performance.trackPlayback(() => performNotes(engine, sequence.notes, operationSignal), 'ai')
            if (replayId) dependencies.replays!.finishPerformance(replayId, 'completed')
            return {
              noteCount: sequence.notes.length,
              duration: sequence.duration,
              completed: true,
              ...pitchEcho(sequence.notes),
              ...(sequence.overlaps > 0 ? { retriggered: sequence.overlaps } : {})
            }
          } catch (error) {
            if (replayId) dependencies.replays!.finishPerformance(replayId, operationSignal.aborted ? 'cancelled' : 'failed')
            throw error
          }
        })
      }
    },
    {
      name: 'render_audio',
      description: 'Render a bounded note sequence and return `metrics` for it (plus `metricNotes`, which says how to read them). Offline by default: repeatable scheduling, far faster than real time, and available before the human starts audio. Each note names its pitch as `note` ("D2") or `midi` (38), never both. The fundamental is MEASURED from the render, never assumed from the note asked for, so a transposed or detuned patch shows up as a real number: `pitchCheck` puts the requested note and the measured one side by side.',
      inputSchema: {
        type: 'object',
        properties: {
          notes: { type: 'array', minItems: 1, maxItems: MAX_NOTES, items: noteSchema },
          duration: { type: 'number', exclusiveMinimum: 0, maximum: MAX_RENDER_SECONDS },
          mode: {
            type: 'string', enum: [...RENDER_MODES],
            description: 'Default "offline". "realtime" captures the live AudioWorklet output and needs running audio; with no OfflineAudioContext an offline request falls back to real time via `renderModeFallback`.'
          },
          format: {
            type: 'string', enum: [...RENDER_FORMATS],
            description: 'Payload beside the metrics: "metrics" (default) or "url", a page-local blob URL of the rendered WAV a human can click to hear it. The URL costs a few dozen bytes; the samples themselves are never returned.'
          }
        },
        required: ['notes'], additionalProperties: false
      },
      annotations: { readOnlyHint: false },
      async execute(input, options) {
        return runPerformance(invocationSignal(options), async operationSignal => {
          const value = assertObject(input, 'input', ['notes', 'duration', 'mode', 'format'], ['notes'])
          const sequence = validatePerformanceNotes(resolveNoteInputs(value.notes), MAX_RENDER_SECONDS)
          const requestedMode = assertRenderMode(value.mode)
          const format = assertRenderFormat(value.format)
          const duration = value.duration === undefined
            ? Math.min(MAX_RENDER_SECONDS, clean(sequence.duration + 0.25))
            : finite(value.duration, 'duration')
          if (duration <= 0 || duration > MAX_RENDER_SECONDS) throw new Error(`Render duration must be > 0 and limited to ${MAX_RENDER_SECONDS} seconds`)
          if (duration < sequence.duration) throw new Error('Render duration must cover the complete note sequence')
          // No `f0Hz`: the render's own samples settle its pitch. See `singlePitch`
          // for what stating it instead cost, and `pitchCheck` below for what
          // measuring it buys.
          const rendered = await renderSequence(
            sequence.notes, duration, requestedMode, operationSignal,
            'AI rendered sequence', {}
          )
          const { recording, metrics } = rendered
          const requested = singlePitch(sequence.notes)
          return withPitchNote({
            renderMode: rendered.renderMode,
            mimeType: recording.mimeType,
            duration: recording.duration,
            sampleRate: recording.sampleRate,
            channels: recording.channelData.length,
            ...pitchEcho(sequence.notes),
            // Only for a single-pitch sequence: a chord has no one requested
            // fundamental to check the measured one against.
            ...(requested === null ? {} : { pitchCheck: pitchCheckFor(requested, metrics) }),
            metrics,
            metricNotes: METRIC_NOTES,
            ...(format === 'url' ? { url: rendered.url } : {}),
            ...(rendered.renderModeFallback ? { renderModeFallback: rendered.renderModeFallback } : {}),
            ...(sequence.overlaps > 0 ? { retriggered: sequence.overlaps } : {})
          })
        })
      }
    },
    {
      name: 'analyze_audio',
      description: `Re-analyze the last render (default), the live output, or the uploaded reference. \`source: "recent"\` reads the rolling ${RECENT_AUDIO_SECONDS} s capture — what a human just played, still there after they released the key — where \`source: "scope"\` holds 21 ms and reports silence for a note that has ended. \`source: "reference"\` re-analyzes the retained reference PCM, so a corrected \`f0Hz\` or a higher \`windows\` count costs no re-upload and replaces the active reference. render_audio already returns these metrics, so call this only for a fresh look without re-rendering.`,
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['scope', 'recent', 'last-render', 'reference'] },
          seconds: {
            type: 'number', exclusiveMinimum: 0, maximum: RECENT_AUDIO_SECONDS,
            description: `Only for "recent": seconds of capture to analyze, ending now. Default and max ${RECENT_AUDIO_SECONDS}.`
          },
          f0Hz: {
            type: 'number', exclusiveMinimum: 0, maximum: 20000,
            description: 'Fundamental for the partials, overriding detection. Only for "scope", "recent" and "reference": a render\'s PCM is not retained.'
          },
          windows: { type: 'integer', minimum: MIN_ANALYSIS_WINDOWS, maximum: MAX_ANALYSIS_WINDOWS, description: `Spectral windows, default ${MIN_ANALYSIS_WINDOWS}.` },
          format: { type: 'string', enum: [...PAYLOAD_FORMATS], description: 'Default "json"; "text" adds the same metrics as a compact table.' }
        },
        additionalProperties: false
      },
      // Not read-only: `source: "reference"` with a corrected `f0Hz` or a raised
      // `windows` replaces the active reference and resets the best-so-far with
      // it. Every other branch only reads, but an annotation is per tool, and
      // claiming read-only for a call that moves the matching target is the kind
      // of quiet inaccuracy this file refuses elsewhere.
      annotations: { readOnlyHint: false },
      async execute(input, options) {
        const signal = invocationSignal(options)
        const value = assertObject(input, 'input', ['source', 'seconds', 'f0Hz', 'windows', 'format'])
        const sources = ['scope', 'recent', 'last-render', 'reference']
        if (value.source !== undefined && !sources.includes(value.source as string)) {
          throw new Error(`source must be one of ${sources.map(name => `'${name}'`).join(', ')}`)
        }
        if (value.seconds !== undefined && value.source !== 'recent') {
          throw new Error('seconds is only accepted with source: "recent"; every other source has a length of its own')
        }
        const seconds = value.seconds === undefined ? RECENT_AUDIO_SECONDS : finite(value.seconds, 'seconds')
        if (seconds <= 0 || seconds > RECENT_AUDIO_SECONDS) {
          throw new Error(`seconds must be > 0 and limited to ${RECENT_AUDIO_SECONDS}, the length of the rolling capture`)
        }
        const f0Hz = assertF0Hz(value.f0Hz)
        const windows = assertWindows(value.windows)
        const format = assertPayloadFormat(value.format, 'json')
        const analysisOptions: AnalyzeAudioOptions = {
          ...(f0Hz === undefined ? {} : { f0Hz }),
          ...(windows === undefined ? {} : { windows })
        }
        // Every source this tool can return goes through here, so the null-pitch
        // note is attached once rather than per branch.
        const withText = <T extends { metrics: AudioMetrics }>(result: T) =>
          withPitchNote(format === 'text' ? { ...result, text: formatMetrics(result.metrics) } : result)

        if (value.source === 'reference') {
          if (!session.lastReference || !session.referencePcm) {
            throw new Error('No reference is available yet. Call analyze_reference_audio first; its decoded PCM is retained so this call can re-analyze it at a different f0Hz or window count')
          }
          const previous = session.lastReference
          const pcm = session.referencePcm
          const metrics = await analyzeAudioAsync(pcm.channelData, pcm.sampleRate, signal, analysisOptions)
          // The re-analysis BECOMES the reference. Returning it and leaving
          // `lastReference` untouched made the correction this branch advertises -
          // detection picked the wrong octave, re-analyse at the right f0 without
          // re-uploading - a no-op: every later `compare_audio` went on scoring
          // against the very metrics the caller had just corrected, and a raised
          // `windows` count was discarded with them.
          //
          // `f0Hz` and `windows` are the only inputs that can change the result: the
          // PCM is unchanged and `analyzeAudio` is deterministic on it, so the
          // fundamental and the window count settle whether this analysis differs
          // from the stored one. A plain look at the reference therefore costs
          // nothing - it re-derives the same numbers and leaves the session alone.
          const replaced =
            previous.metrics.pitch?.f0Hz !== metrics.pitch?.f0Hz ||
            previous.metrics.pitch?.source !== metrics.pitch?.source ||
            previous.metrics.spectralWindows?.length !== metrics.spectralWindows?.length
          if (replaced) {
            session.lastReference = { ...previous, metrics }
            // A similarity scored against the old metrics is not comparable to one
            // scored against these, so the running best starts over rather than
            // carrying a figure earned against a different measurement of the same
            // file - the same class of wrong-number-an-agent-trusts that
            // `SILENT_CANDIDATE_REFUSAL` refuses. `trackMatchProgress` keys on
            // reference identity, so the replacement above already resets it; this
            // says so out loud and clears `lastComparison`, which `suggest_patch`
            // would otherwise keep re-reading against a target that has moved.
            session.match = null
            session.lastComparison = null
          }
          return withText({
            source: 'reference' as const,
            ...(previous.name ? { name: previous.name } : {}),
            duration: previous.duration,
            sampleRate: pcm.sampleRate,
            channels: pcm.channelData.length,
            metrics,
            metricNotes: METRIC_NOTES,
            activeReference: replaced ? ('replaced' as const) : ('unchanged' as const),
            matchProgressReset: replaced,
            note: replaced
              ? 'These metrics are now the active reference: every later compare_audio scores against them. The best-so-far was reset with them, because a similarity measured against the previous analysis of this file cannot be compared with one measured against this analysis. Comparison numbering restarts at 1.'
              : 'Same fundamental and same window count as the stored analysis, so this changed nothing: the active reference and the running best-so-far are untouched.'
          })
        }
        if (value.source === 'scope') return withText(scopeCandidate(analysisOptions))
        if (value.source === 'recent') return withText(await recentCandidate(requireRecentAudio(seconds), signal, analysisOptions))
        if (value.source === 'last-render' && !session.lastRender) {
          throw new Error('No render is available yet. Call render_audio first, or pass source: "recent" to analyze the last few seconds of live output (source: "scope" sees only the most recent 21 ms of it)')
        }
        // Re-analysis needs PCM, and only the reference and the live scope keep
        // theirs. Saying so beats silently returning the stored metrics, which
        // were measured at a different f0Hz than the one just asked for.
        if (Object.keys(analysisOptions).length > 0 && session.lastRender) {
          throw new Error('f0Hz and windows cannot be applied to source "last-render": the render\'s PCM is not retained, only its metrics. Call render_audio again (a single-pitch sequence is analyzed at its own f0 automatically), or analyze the reference with source: "reference"')
        }
        return withText(session.lastRender ? currentCandidate() : scopeCandidate(analysisOptions))
      }
    },
    {
      name: 'capture_audio',
      description: `The one tool that WAITS for a human to play: \`waitForSignal: true\` blocks up to \`maxWaitSeconds\` for the live output to rise above ${SIGNAL_ONSET_DB} dBFS, then measures the \`captureSeconds\` that follow. Left off, it reads the rolling ${RECENT_AUDIO_SECONDS} s buffer and returns at once, as analyze_audio({source:"recent"}) does. A window nobody played into comes back as \`silent: true\`. Offline renders bypass the live graph, so render_audio's output never appears here.`,
      inputSchema: {
        type: 'object',
        properties: {
          captureSeconds: {
            type: 'number', exclusiveMinimum: 0, maximum: RECENT_AUDIO_SECONDS,
            description: `Window length, ending at the capture. Default ${DEFAULT_CAPTURE_SECONDS}, max ${RECENT_AUDIO_SECONDS} — the whole buffer.`
          },
          waitForSignal: {
            type: 'boolean',
            description: `Wait for output above ${SIGNAL_ONSET_DB} dBFS, then capture \`captureSeconds\` from there. Default false: read the buffer and return at once.`
          },
          maxWaitSeconds: {
            type: 'number', exclusiveMinimum: 0, maximum: MAX_WAIT_SECONDS,
            description: `Wait budget, default ${DEFAULT_WAIT_SECONDS}, capped at ${MAX_WAIT_SECONDS}. Waiting in vain returns \`signalDetected: false\`, not an error.`
          }
        },
        additionalProperties: false
      },
      // Reads a buffer the engine fills on its own; captures nothing, plays
      // nothing, and leaves no `last-render` behind.
      annotations: { readOnlyHint: true },
      async execute(input, options) {
        return runAbortable(invocationSignal(options), async operationSignal => {
          const value = assertObject(input, 'input', ['captureSeconds', 'waitForSignal', 'maxWaitSeconds'])
          if (value.waitForSignal !== undefined && typeof value.waitForSignal !== 'boolean') {
            throw new Error('waitForSignal must be boolean')
          }
          const waitRequested = value.waitForSignal === true
          if (value.maxWaitSeconds !== undefined && !waitRequested) {
            throw new Error('maxWaitSeconds only means something with waitForSignal: true; without it the buffer is read and returned at once')
          }
          const captureSeconds = value.captureSeconds === undefined
            ? DEFAULT_CAPTURE_SECONDS
            : finite(value.captureSeconds, 'captureSeconds')
          if (captureSeconds <= 0 || captureSeconds > RECENT_AUDIO_SECONDS) {
            throw new Error(`captureSeconds must be > 0 and limited to ${RECENT_AUDIO_SECONDS}, the length of the rolling buffer`)
          }
          const maxWaitSeconds = value.maxWaitSeconds === undefined
            ? DEFAULT_WAIT_SECONDS
            : finite(value.maxWaitSeconds, 'maxWaitSeconds')
          if (waitRequested && (maxWaitSeconds <= 0 || maxWaitSeconds > MAX_WAIT_SECONDS)) {
            throw new Error(`maxWaitSeconds must be > 0 and limited to ${MAX_WAIT_SECONDS}`)
          }

          // Waiting for output from a graph that is not running would burn the
          // whole budget on a certainty. Said before the wait rather than after.
          if (!engine.recentAudio(SIGNAL_POLL_SECONDS)) throw new Error(NO_RECENT_AUDIO)

          let waitedSeconds: number | undefined
          let signalDetected: boolean | undefined
          if (waitRequested) {
            const started = Date.now()
            const deadline = started + maxWaitSeconds * 1000
            signalDetected = false
            for (;;) {
              throwIfAborted(operationSignal)
              const probe = engine.recentAudio(SIGNAL_POLL_SECONDS)
              if (probe && peakAmplitude(probe.channelData) >= SIGNAL_ONSET_AMPLITUDE) {
                signalDetected = true
                break
              }
              const remaining = deadline - Date.now()
              if (remaining <= 0) break
              await sleep(Math.min(SIGNAL_POLL_MS, remaining), operationSignal)
            }
            // Let the buffer fill with the sound that was just detected: the
            // window is read backwards from now, so returning at the onset would
            // return `captureSeconds` of the silence before it.
            if (signalDetected) await sleep(captureSeconds * 1000, operationSignal)
            waitedSeconds = clean((Date.now() - started) / 1000)
          }

          throwIfAborted(operationSignal)
          const recent = requireRecentAudio(captureSeconds)
          const captured = await recentCandidate(recent, operationSignal)
          const silent = captured.metrics.peakDb <= SILENT_PEAK_DB
          return {
            ...captured,
            requestedSeconds: clean(captureSeconds),
            ...(waitRequested ? { waitForSignal: true, maxWaitSeconds, waitedSeconds, signalDetected } : {}),
            // A silent window is a fact about the room, not a failure of the
            // tool: reporting it beats throwing, because "nobody played
            // anything" is the answer the caller asked for.
            silent,
            ...(silent ? {
              silenceNote: signalDetected === false
                ? `Nothing rose above ${SIGNAL_ONSET_DB} dBFS in ${waitedSeconds} s and the window is digital silence — nobody played. Ask the human to play, then call again, or use render_audio to hear the patch without them.`
                : `This window is digital silence (peak below ${SILENT_PEAK_DB} dB): the live graph produced nothing in the last ${clean(captureSeconds)} s. Every metric below is measured on silence and describes nothing. Pass waitForSignal: true to wait for a human to play, or call render_audio to hear the patch yourself.`
            } : {})
          }
        })
      }
    },
    {
      name: 'analyze_reference_audio',
      description: 'Step 1 of matching a target sound: send the target as Base64 audio, decoded in memory and analyzed with the same metrics as synth output. `pitch` is detected automatically and `harmonics`/`harmonicShape` come with it, so the target\'s partials are visible on the same terms as your own. Its PCM is retained (one at a time) for analyze_audio({source:"reference"}). Then call compare_audio (step 2), which renders the candidate for you.',
      inputSchema: {
        type: 'object',
        properties: {
          audioBase64: { type: 'string', minLength: 1, maxLength: MAX_AUDIO_BASE64_CHARACTERS },
          name: { type: 'string', minLength: 1, maxLength: MAX_REFERENCE_NAME_LENGTH },
          mimeType: { type: 'string', minLength: 1, maxLength: MAX_MIME_TYPE_LENGTH, pattern: '^[aA][uU][dD][iI][oO]/' },
          f0Hz: { type: 'number', exclusiveMinimum: 0, maximum: 20000, description: 'Known target fundamental; overrides detection when it reports the wrong octave.' },
          trimStartMs: { type: 'number', minimum: 0, description: 'Milliseconds dropped from the start (leading silence).' },
          trimEndMs: { type: 'number', minimum: 0, description: 'Milliseconds dropped from the end. What survives is the reference.' },
          windows: { type: 'integer', minimum: MIN_ANALYSIS_WINDOWS, maximum: MAX_ANALYSIS_WINDOWS, description: `Spectral windows, default ${MIN_ANALYSIS_WINDOWS}.` },
          format: { type: 'string', enum: [...PAYLOAD_FORMATS], description: 'Default "json"; "text" adds the same metrics as a compact table.' }
        },
        required: ['audioBase64'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input, options) {
        const signal = invocationSignal(options)
        const invocationGeneration = ++session.referenceGeneration
        return runReferenceAnalysis(signal, invocationGeneration, async (operationSignal, assertCurrent) => {
          const value = assertObject(
            input, 'input',
            ['audioBase64', 'name', 'mimeType', 'f0Hz', 'trimStartMs', 'trimEndMs', 'windows', 'format'],
            ['audioBase64']
          )
          if (typeof value.audioBase64 !== 'string') throw new Error('audioBase64 must be a string')
          if (value.audioBase64.length === 0 || value.audioBase64.trim().length === 0) {
            throw new Error('audioBase64 must not be empty')
          }
          if (value.audioBase64.length > MAX_AUDIO_BASE64_CHARACTERS) {
            throw new Error('audioBase64 is limited to 16 MiB characters')
          }
          const name = validateReferenceName(value.name)
          const requestedMimeType = validateAudioMimeType(value.mimeType)
          const f0Hz = assertF0Hz(value.f0Hz)
          const trimStartMs = assertTrimMs(value.trimStartMs, 'trimStartMs')
          const trimEndMs = assertTrimMs(value.trimEndMs, 'trimEndMs')
          const windows = assertWindows(value.windows)
          const format = assertPayloadFormat(value.format, 'json')
          const analysisOptions: AnalyzeAudioOptions = {
            ...(f0Hz === undefined ? {} : { f0Hz }),
            ...(windows === undefined ? {} : { windows })
          }
          assertCurrent()
          const decoded = await decodeAudio(value.audioBase64, { context: engine.ctx, signal: operationSignal })
          assertCurrent()
          // What survives the trim is what "the reference" means from here on:
          // it is what is analyzed, what is retained, and what a later
          // re-analysis at a corrected f0Hz sees.
          const channelData = trimChannels(decoded.channelData, decoded.sampleRate, trimStartMs, trimEndMs)
          const trimmedSamples = decoded.channelData[0].length - channelData[0].length
          const duration = trimmedSamples > 0 ? channelData[0].length / decoded.sampleRate : decoded.duration
          const metrics = await analyzeAudioAsync(channelData, decoded.sampleRate, operationSignal, analysisOptions)
          assertCurrent()
          const decodedMimeType = decoded.mimeType === undefined ? undefined : normalizeAudioMimeType(decoded.mimeType)
          if (requestedMimeType && decodedMimeType && requestedMimeType !== decodedMimeType) {
            throw new Error(`mimeType conflicts with data URI MIME type ${decodedMimeType}`)
          }
          const mimeType = requestedMimeType ?? decodedMimeType
          const analysis: ReferenceAnalysis = {
            source: 'base64-reference',
            ...(name ? { name } : {}),
            ...(mimeType ? { mimeType } : {}),
            decodedBytes: decoded.decodedBytes,
            duration,
            sampleRate: decoded.sampleRate,
            // What the FILE says, read from its own RIFF header, beside what the
            // decode produced. See `downsampleNote` for why the pair matters.
            ...(decoded.sourceSampleRate === undefined ? {} : { sourceSampleRate: decoded.sourceSampleRate }),
            channels: decoded.channels,
            ...(trimmedSamples > 0 ? { trimmedMs: { start: trimStartMs, end: trimEndMs } } : {}),
            ...(downsampleNote(decoded.sourceSampleRate, decoded.sampleRate) ?? {}),
            metrics
          }
          assertCurrent()
          session.lastReference = analysis
          // Deliberately NOT on `analysis`: `compare_audio` returns that object
          // whole, and a decoded buffer inside it would be serialised to the
          // model. One reference at a time, replaced here on every upload.
          session.referencePcm = { channelData, sampleRate: decoded.sampleRate }
          // A new target is a new matching problem: the best-so-far starts over.
          // Only the winning (non-superseded) invocation reaches this line.
          session.match = null
          session.lastComparison = null
          // A reference with no measurable fundamental is the case that makes
          // `compare_audio({autoRender:true})` refuse for want of a note to
          // render, so the explanation belongs here, on the upload.
          return withPitchNote(format === 'text' ? { ...analysis, text: formatMetrics(metrics) } : analysis)
        })
      }
    },
    {
      name: 'compare_audio',
      description: 'Step 2 of matching a target sound: the signed, per-dimension error between the reference and your sound (`diff`). It also returns ranked moves in this synth\'s parameter ids (`diff.actions`) and the `comparison` score. It renders the candidate first by default, at the reference\'s own detected pitch and duration, releasing the note a tail before the buffer ends so its decay is measurable — never an octave-off render whose scalars still look plausible. Falls back to the last render or the live scope with `autoRender: false`, and refuses a silent scope rather than scoring against silence.',
      inputSchema: {
        type: 'object',
        properties: {
          autoRender: { type: 'boolean', description: 'Default true when the reference has a pitch: render at that pitch and duration first. False compares the last render, or the live scope.' },
          notes: { type: 'array', minItems: 1, maxItems: MAX_NOTES, items: noteSchema, description: 'Notes for that render, when the reference\'s own pitch is not what you want.' },
          duration: { type: 'number', exclusiveMinimum: 0, maximum: MAX_RENDER_SECONDS, description: 'Render seconds; defaults to the reference\'s duration.' },
          format: {
            type: 'string', enum: [...PAYLOAD_FORMATS],
            description: `Default "text": the diff as a compact table, and a summary in the strict sense — the arrays that table restates (\`${TEXT_MODE_OMITTED_FIELDS.join('`, `')}\`) are dropped from both metrics objects, cutting about a third off the response and more as \`windows\` rises. "json" returns everything whole.`
          },
          maxActions: { type: 'integer', minimum: 0, maximum: MAX_ADVICE_ACTIONS, description: `Ranked moves, default ${DEFAULT_MAX_ACTIONS}.` }
        },
        additionalProperties: false
      },
      // Not read-only: the default path renders, which stores a new
      // `last-render` and, on the realtime fallback, makes sound.
      annotations: { readOnlyHint: false },
      async execute(input, options) {
        const signal = invocationSignal(options)
        if (signal.aborted || lifecycleSignal?.aborted) throw abortError()
        const value = assertObject(input, 'input', ['autoRender', 'notes', 'duration', 'format', 'maxActions'])
        if (value.autoRender !== undefined && typeof value.autoRender !== 'boolean') throw new Error('autoRender must be boolean')
        const format = assertPayloadFormat(value.format, 'text')
        const maxActions = boundedInteger(value.maxActions, 'maxActions', DEFAULT_MAX_ACTIONS, 0, MAX_ADVICE_ACTIONS)
        if (!session.lastReference) throw new Error('Call analyze_reference_audio first before compare_audio')
        const reference = session.lastReference
        const referencePitch = reference.metrics.pitch ?? null
        // A candidate rendered at the wrong pitch scores plausibly on every
        // scalar and nonsensically on every partial, so the default is to
        // render at the reference's own measured pitch rather than to trust
        // whatever note was last played.
        const autoRender = value.autoRender === undefined
          ? referencePitch !== null || value.notes !== undefined
          : value.autoRender
        if (autoRender && value.notes === undefined && referencePitch === null) {
          throw new Error('autoRender needs a pitch: no fundamental was detected in the reference, so there is no note to render. Pass `notes` explicitly, or re-run analyze_reference_audio with a known `f0Hz`, or pass autoRender: false')
        }
        if (autoRender) {
          const duration = value.duration === undefined
            ? Math.min(MAX_RENDER_SECONDS, Math.max(0.05, clean(reference.duration)))
            : finite(value.duration, 'duration')
          if (duration <= 0 || duration > MAX_RENDER_SECONDS) throw new Error(`Render duration must be > 0 and limited to ${MAX_RENDER_SECONDS} seconds`)
          // Note-off lands one release tail before the buffer ends, so the candidate
          // decays inside the window the way the reference does. See
          // `RELEASE_TAIL_SECONDS`. Explicit `notes` are left exactly as written:
          // choosing the note is the reason to pass them.
          const held = heldSecondsWithin(duration)
          const sequence = value.notes === undefined
            ? {
              notes: [{ midi: referencePitch!.midi, velocity: 1, start: 0, duration: held }],
              duration: held,
              overlaps: 0
            }
            : validatePerformanceNotes(resolveNoteInputs(value.notes), MAX_RENDER_SECONDS)
          if (duration < sequence.duration) throw new Error('Render duration must cover the complete note sequence')
          try {
            // The candidate's fundamental is MEASURED here, never assumed - see
            // `candidateAnalysisOptions` for what assuming it cost.
            //
            // The consequence, decided deliberately: the two sides are now analysed
            // at their OWN fundamentals, so "partial 3" is a different absolute
            // frequency on each side. The per-partial diff nonetheless stays indexed
            // by partial NUMBER rather than aligned by frequency. Timbre is the shape
            // of the series relative to its own fundamental - which is exactly what
            // `harmonicShape.amplitudesDbRelF0` holds - so partial n against partial n
            // is the comparison a synthesist makes: "your third partial is 6 dB down
            // on the target's" is a sentence about the patch, and it stays true after
            // the tuning is fixed. Aligning by frequency would let an octave-high
            // candidate match its partial 2k against the reference's partial k and
            // score a near-perfect timbre match on half the reference's series, which
            // is the very confusion this change exists to remove. The tuning error is
            // reported on its own as `diff.pitch.centsError`, so the model fixes the
            // octave first and reads the partials afterwards instead of letting one
            // error absorb the other.
            //
            // When detection finds nothing - an unpitched or near-silent render -
            // `metrics.pitch` is `null`, the harmonic blocks are absent, `centsError`
            // is `null` and the text payload reads `PITCH n/a (no fundamental
            // measured on your sound)`. That is the honest answer; falling back to
            // the reference's f0 would reinstate the confidence-1 lie under a
            // different name.
            await runPerformance(signal, operationSignal => renderSequence(
              sequence.notes, duration, undefined, operationSignal, 'AI comparison render',
              candidateAnalysisOptions(reference)
            ))
          } catch (error) {
            if ((error as Error | undefined)?.name === 'AbortError') throw error
            // The render is this tool's default, not something the caller asked
            // for by name, so its failure has to say how to compare anyway.
            throw new Error(`${(error as Error | undefined)?.message ?? String(error)} (compare_audio renders the candidate by default; pass autoRender: false to compare the last render or the live scope instead)`)
          }
          if (signal.aborted || lifecycleSignal?.aborted) throw abortError()
        }
        const candidate = currentCandidate()
        // The scope fallback exists for a human who IS playing. Before the
        // audio gesture the scope is guaranteed digital silence, and scoring a
        // reference against it returned `ok` with a plausible similarity
        // (0.209 in the match eval) that an agent following "Step 1 ... Step 2"
        // reads as a baseline. A wrong number an agent trusts is worse than an
        // error, so refuse and say what to call first.
        if (candidate.source === 'scope' && candidate.metrics.peakDb <= SILENT_PEAK_DB) {
          throw new Error(SILENT_CANDIDATE_REFUSAL)
        }
        if (signal.aborted || lifecycleSignal?.aborted) throw abortError()
        // Unchanged, and deliberately so: `docs/agent-match-eval.md` reads
        // `detailSimilarities` and `similarityTrajectory` off this object, and a
        // new shape would make every recorded run incomparable.
        const comparison = compareAudioMetrics(reference.metrics, candidate.metrics)
        const entryId = candidate.source === 'last-render' ? session.lastRender?.soundEntryId : dependencies.currentSoundEntryId?.()
        dependencies.onComparison?.(comparison, entryId)
        const progress = trackMatchProgress(session, reference, comparison.similarity, entryId)
        const diff = diffAudioMetrics(reference.metrics, candidate.metrics, comparison)
        const mods = currentModRoutes(engine)
        diff.actions = adviseFromDiff(diff, currentPatchValues(engine), { maxActions, ...(mods ? { mods } : {}) })
        session.lastComparison = {
          diff,
          ...(reference.name ? { referenceName: reference.name } : {}),
          comparisonNumber: progress.comparisonNumber,
          maxActions,
          // The same id `onComparison` files this comparison under, so
          // `suggest_patch` can tell whether the patch moved underneath it.
          ...(entryId === undefined ? {} : { soundEntryId: entryId })
        }
        const text = format === 'text'
          ? formatDiff(diff, {
            ...(reference.name ? { referenceName: reference.name } : {}),
            comparisonNumber: progress.comparisonNumber,
            bestSoFar: progress.best,
            // The `diff` block six lines below ships `actions` structurally, with the
            // parameter ids and target values the prose version leaves out. Restating them
            // as prose costs ~1.6 kB to hand back the weaker copy of what is already there.
            actionsShipStructurally: true
          })
          : undefined
        return {
          // The bulky arrays go only in text mode, where the table restates
          // them; `format: "json"` keeps `reference`/`candidate` exactly as
          // `analyze_audio` shapes them. See `TEXT_MODE_OMITTED_METRICS`.
          // `withPitchNote` on both sides, and on this tool it is load-bearing:
          // a null on the CANDIDATE is what the last edit did (an EQ boost can
          // do it at a perfectly safe level) and it scores the pitch, harmonics
          // and tilt terms 0; a null on the REFERENCE is why autoRender has no
          // note to render. It costs nothing when both sides are pitched, which
          // is every comparison that is going well.
          reference: withPitchNote(format === 'text' ? summarizeAnalysis(reference) : reference),
          candidate: withPitchNote(format === 'text' ? summarizeAnalysis(candidate) : candidate),
          ...(format === 'text' ? {
            metricsOmitted: { fields: [...TEXT_MODE_OMITTED_FIELDS], note: METRICS_OMITTED_NOTE }
          } : {}),
          // Byte-identical in both modes, and deliberately so: see the comment
          // above `compareAudioMetrics`.
          comparison,
          // In text mode the table already carries every band, partial and
          // window figure, so shipping the numeric arrays as well would pay for
          // the same numbers twice. `actions` stays structured either way: it
          // carries parameter ids and legal target values an agent applies
          // directly with update_parameters.
          diff: format === 'text' ? { similarity: diff.similarity, actions: diff.actions } : diff,
          ...(text === undefined ? {} : { text }),
          ...sampleRateMismatch(reference, candidate.sampleRate),
          progress
        }
      }
    },
    /**
     * ## Why this tool still exists after an eval agent refused to call it
     *
     * Run 4's agent never used it, and said why: "`compare_audio` already returns
     * the same ranked moves, so paying a round trip to re-read them made no sense;
     * that is a real redundancy." On the call it was picturing — straight after a
     * comparison, same patch, no `focus` — it was exactly right, and the old
     * description ("ask what next without paying for a render") described precisely
     * that useless call.
     *
     * What it has that `compare_audio` does not, and what the description now leads
     * with instead:
     *
     * - `adviseFromDiff` re-derives every `from`/`to` against the patch as it is
     *   RIGHT NOW. Apply three moves and `compare_audio`'s `actions` are a list of
     *   targets you have already hit, with `from` values that no longer exist; this
     *   returns the same findings aimed at the current patch. That is the call worth
     *   making, and nothing said so.
     * - `focus` narrows to one of timbre/envelope/level/space. `compare_audio` has no
     *   such input, so a focused list costs a render there.
     * - `maxActions` here is independent of the comparison's, so more moves can be
     *   drawn out of a diff that was returned with the default five.
     *
     * Kept rather than folded into `compare_audio`, because folding it in means
     * making `focus` and a bigger `maxActions` cost a render — which is the cost this
     * tool exists to avoid. Kept rather than deleted, because deleting it costs the
     * post-edit re-derivation above, and there is nowhere else to get it.
     *
     * And the redundant call is now named at the moment it happens:
     * `basedOn.addsNothing` is true when the patch has not moved, no `focus` narrowed
     * anything, and `maxActions` asks for no more than the comparison already
     * returned — i.e. when this response is byte-for-byte the `diff.actions` the
     * caller is already holding.
     */
    {
      name: 'suggest_patch',
      // Under the 600 B per-tool cap and inside the listing total the metadata
      // test holds: the long version of this reasoning is in the block comment
      // above, which costs an agent nothing.
      description: 'Re-aims the last compare_audio\'s ranked moves at the patch as it is NOW: every from/to recomputed against current values, nothing rendered. Call it AFTER applying moves, or for a `focus` (timbre/envelope/level/space) compare_audio lacks. On an unchanged patch with no `focus` it just repeats compare_audio\'s `diff.actions`; `basedOn.addsNothing` says so. `basedOn.stale` means `basedOn.similarity` scores the patch you replaced.',
      inputSchema: {
        type: 'object',
        properties: {
          maxActions: { type: 'integer', minimum: 0, maximum: MAX_ADVICE_ACTIONS, description: `Default ${DEFAULT_MAX_ACTIONS}.` },
          focus: { type: 'string', enum: [...ADVICE_CATEGORIES] }
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: true },
      execute(input) {
        const value = assertObject(input, 'input', ['maxActions', 'focus'])
        const maxActions = boundedInteger(value.maxActions, 'maxActions', DEFAULT_MAX_ACTIONS, 0, MAX_ADVICE_ACTIONS)
        const focus = assertAdviceFocus(value.focus)
        // Advice with no measurement behind it would be advice about nothing,
        // and an agent would spend edits on it. Refuse and name the call.
        if (!session.lastComparison) {
          throw new Error('No comparison to advise from yet. Call analyze_reference_audio to set a target, then compare_audio — which renders the candidate for you — and call suggest_patch again; it re-reads that comparison rather than measuring anything itself')
        }
        const { diff, referenceName, comparisonNumber, soundEntryId, maxActions: comparedMaxActions } = session.lastComparison
        // Warn, do not refuse. `SILENT_CANDIDATE_REFUSAL` refuses because the
        // alternative is a fabricated number: scoring against silence invents a
        // similarity for a comparison that never happened. Stale advice is a
        // different kind of wrong — the measurement did happen, on a real sound,
        // and `adviseFromDiff` re-derives every `from`/`to` against the patch as
        // it is RIGHT NOW, so the moves stay legal and applicable. Refusing would
        // fire on the one sequence an agent should be praised for (apply the
        // advice, ask what is next) and force a render this tool exists to save.
        // What must not survive the edit is the *number*: `similarity` reads as
        // "where I am" and after an edit it is where the agent was. So the number
        // is labelled rather than removed, and the label says which sound it
        // describes.
        const currentEntryId = dependencies.currentSoundEntryId?.()
        // Unknowable without history services, and an unknowable staleness is not
        // reported as `false`: a caller reading `stale === false` is entitled to
        // treat it as a checked fact.
        const knowable = soundEntryId !== undefined && currentEntryId !== undefined
        const stale = knowable && soundEntryId !== currentEntryId
        // The call an eval agent correctly refused to make: the patch has not
        // moved, so no from/to was re-derived; no `focus` dropped anything; and
        // `maxActions` asks for no more than `compare_audio` already returned. The
        // list below is then identical to the `diff.actions` in hand, and saying
        // so is the only way an agent finds out — reading two identical lists
        // teaches nothing about which call to skip next time. Unknowable without
        // history services, and, like `stale`, an unknowable fact is omitted
        // rather than reported as `false`.
        const addsNothing = knowable && !stale && focus === undefined && maxActions <= comparedMaxActions
        const adviceMods = currentModRoutes(engine)
        return {
          actions: adviseFromDiff(diff, currentPatchValues(engine), {
            maxActions, ...(adviceMods ? { mods: adviceMods } : {}), ...(focus ? { focus } : {})
          }),
          basedOn: {
            ...(referenceName ? { referenceName } : {}),
            comparisonNumber,
            similarity: roundSimilarity(diff.similarity),
            ...(knowable ? { stale, addsNothing } : {}),
            ...(stale ? { comparedSoundEntryId: soundEntryId, currentSoundEntryId: currentEntryId } : {}),
            note: stale
              ? `THE SOUND HAS CHANGED since comparison ${comparisonNumber} was measured: the patch moved from sound-history entry ${soundEntryId} to ${currentEntryId}, so \`similarity\` above scores the patch you REPLACED, not the one loaded now. The ranked moves are still the findings of that comparison, and their from/to values are computed against the current patch, so they remain applicable — but nothing here tells you whether your last edit helped. Call compare_audio to measure the sound as it is.`
              : addsNothing
                ? `Nothing new: the patch has not changed since comparison ${comparisonNumber}, so every from/to is what it already was, and these ${maxActions === comparedMaxActions ? 'are' : 'are the first of'} the ranked moves compare_audio returned as \`diff.actions\`. That call answered this one — reach for suggest_patch AFTER you have applied moves (the from/to values are then re-derived against the new patch), or to narrow the list with \`focus\`, or to pull more than the ${comparedMaxActions} moves that comparison returned.`
                : 'Re-read of the last compare_audio, aimed at the patch as it is right now. Nothing was rendered or measured for this call; call compare_audio to measure the effect of a change.'
          }
        }
      }
    },
    {
      name: 'save_preset',
      description: "Save the complete current patch under a validated name, replacing that name if present. It goes to this browser's localStorage and shows up in the preset select under `User` — no file, no folder. The result says so; `list_presets` confirms it.",
      inputSchema: {
        type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 80 } },
        required: ['name'], additionalProperties: false
      },
      annotations: { readOnlyHint: false },
      execute(input) {
        const value = assertObject(input, 'input', ['name'], ['name'])
        const name = validatePresetName(value.name)
        savePreset(engine.toPreset(name))
        // The patch on screen is now a copy of something that exists, so it stops
        // being unattributed and `get_synth_state`'s `patch.preset.dirty` goes
        // false until the next edit. Read back out of the engine, after the write.
        markPresetLoaded(name, 'user', engine)
        return {
          name,
          saved: true,
          storage: 'localStorage',
          // The motivating session: "which folder did you save it to?" cost
          // several calls to answer, because the answer was "none".
          where: `Saved in this browser's localStorage, not to a file: no folder holds it. It is in the preset select under the "User" group as "${name}", and list_presets returns it.`,
          // A user preset wins a name collision in `load_preset`, so saving over a
          // factory name silently changes what that name loads. Said here, at the
          // call that caused it, rather than left to be discovered later.
          ...(factoryNames.has(name) ? {
            shadowsFactoryPreset: true,
            shadowNote: `A factory preset is also called "${name}". load_preset({"name":"${name}"}) now returns THIS patch, because a user preset is the only copy of deliberate work; the built-in one is untouched and still reachable with {"source":"factory"}.`
          } : {})
        }
      }
    },
    {
      name: 'load_preset',
      description: 'Load a preset into the live engine: the factory patches the UI dropdown lists, and the user presets saved to this browser\'s localStorage. `list_presets` names both. On a name held by both, the USER preset wins — it is the only copy of deliberate work, and save_preset followed by load_preset must return the patch just saved — and the result says a factory preset was shadowed. Pass `source: "factory"` for the built-in one by name.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 80 },
          source: {
            type: 'string', enum: [...PRESET_SOURCES],
            description: 'Which space to load from. Omitted, a user preset of that name wins over a factory one; "factory" asks for the built-in patch by name even when a user preset shadows it.'
          }
        },
        required: ['name'], additionalProperties: false
      },
      annotations: { readOnlyHint: false },
      execute(input) {
        assertPerformanceIdle('Preset loading')
        const value = assertObject(input, 'input', ['name', 'source'], ['name'])
        const source = assertPresetSource(value.source)
        const name = validatePresetName(value.name)
        // Only the space actually asked for is read: `loadPreset` announces a load to
        // the preset-store listeners, so probing storage for a factory-only request
        // would report a user preset load that never happened.
        const isFactory = source !== 'user' && factoryNames.has(name)
        const shadowed = isFactory && userPresetNames().has(name)
        // A factory preset needs no storage to load. When storage is blocked and
        // the name is a factory one, say so and load it rather than refusing a
        // patch that is compiled into the page.
        let storageError: string | undefined
        let user: ReturnType<typeof loadPreset> = null
        if (source !== 'factory') {
          try {
            user = loadPreset(name)
          } catch (error) {
            if (!isFactory) throw error
            storageError = error instanceof Error ? error.message : String(error)
          }
        }
        // Already validated twice on the way here - `readPresets` validates every
        // stored entry and `loadPreset` re-validates the match - and `getFactoryPreset`
        // runs `validatePresetData` itself. A third pass would only re-derive the same
        // object.
        const preset = user ?? (source === 'user' ? null : getFactoryPreset(name))
        if (!preset) throw new Error(presetNotFound(name, source))
        engine.loadPreset(preset, 'ai')
        // AFTER the load, never before: the reference is read back out of the
        // engine, which fills in every parameter the preset omits and stores into
        // a Float32Array. Comparing against the file instead would report a fresh
        // load as already modified, which is honest and useless.
        markPresetLoaded(name, user ? 'user' : 'factory', engine)
        return {
          name,
          loaded: true,
          source: user ? 'user' as const : 'factory' as const,
          ...(shadowed ? {
            shadowedFactoryPreset: true,
            note: `A factory preset is also called "${name}"; this loaded the USER preset. Pass {"source":"factory"} for the built-in patch.`
          } : {}),
          ...(storageError === undefined ? {} : {
            note: `Loaded the factory preset. This browser's preset storage could not be read (${storageError}), so a user preset of the same name — if one exists — was not consulted.`
          })
        }
      }
    },
    {
      name: 'list_presets',
      description: `Every preset this page can load, as ONE ordered list: the ${FACTORY_PRESETS.length} factory patches first, in the dropdown's own order, then this browser's user presets in the order they were saved (oldest first). Each row carries \`source\`, and \`total\`/\`factory\`/\`user\` count them. A name held by both spaces appears twice, once per source.`,
      inputSchema: emptySchema,
      annotations: { readOnlyHint: true },
      execute(input) {
        assertObject(input, 'input', [])
        // One list, not two. Two arrays let a reader answer "what presets are there?"
        // from the first one it meets, which is exactly how the factory patches stayed
        // invisible to every agent: `list_presets` returned user presets only, and an
        // empty array reads as "this synth has no presets". A single ordered list is
        // read in one pass, and a collision is visible as two rows rather than hidden
        // in the array the reader skipped.
        const factory = listFactoryPresetNames().map(name => ({ name, source: 'factory' as const }))
        const user = listPresets().map(preset => ({ name: preset.name, source: 'user' as const }))
        const names = new Set(user.map(preset => preset.name))
        const shadowed = factory.flatMap(preset => names.has(preset.name) ? [preset.name] : [])
        return {
          presets: [...factory, ...user],
          total: factory.length + user.length,
          factory: factory.length,
          user: user.length,
          ...(shadowed.length === 0 ? {} : {
            shadowedFactoryPresets: shadowed,
            note: `${shadowed.join(', ')} ${shadowed.length === 1 ? 'names' : 'name'} both a factory and a user preset. load_preset returns the user one; pass {"source":"factory"} for the built-in patch.`
          })
        }
      }
    },
    {
      name: 'delete_preset',
      description: "Delete a preset saved in this browser's localStorage. Factory presets are compiled into the page and cannot be deleted, so a factory name is refused unless a user preset shadows it — then the USER copy goes and the built-in patch is loadable again under that name. The patch on screen is never touched; only the entry in storage.",
      inputSchema: {
        type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 80 } },
        required: ['name'], additionalProperties: false
      },
      annotations: { readOnlyHint: false },
      execute(input) {
        const value = assertObject(input, 'input', ['name'], ['name'])
        const name = validatePresetName(value.name)
        const shadowsFactory = factoryNames.has(name)
        // Read before the delete, because the delete is what clears it.
        const attributed = currentPresetState(engine)
        // Attempted before the factory check, deliberately: a user preset saved
        // under a factory name is deliberate work and the only copy of it, so it
        // IS deletable. Only when storage held nothing does the name get read as
        // a request to delete the built-in one.
        const removed = deletePreset(name)
        if (!removed) throw new Error(shadowsFactory ? factoryDeleteRefusal(name) : presetNotFound(name, 'user'))
        // A delete never touches the sound, but it can take away what the sound
        // was a copy OF, and an agent about to answer "is this saved?" needs to
        // be told that rather than to discover it in the next get_synth_state.
        const detached = attributed.source === 'user' && attributed.name === name
        return {
          name,
          deleted: true,
          storage: 'localStorage',
          ...(shadowsFactory ? { factoryPresetRestored: true } : {}),
          ...(detached ? { detachedCurrentPatch: true } : {}),
          note: 'The patch loaded in the synth is untouched; only the entry in storage is gone, and list_presets confirms it.' +
            (shadowsFactory ? ` A factory preset is also called "${name}", so load_preset({"name":"${name}"}) now returns the built-in patch again.` : '') +
            (detached ? ' It was the preset this patch came from, so the patch is no longer attributed to one: get_synth_state reports `patch.preset.name` as null. Nothing was lost from the sound — save_preset stores it again, export_preset hands it over as JSON.' : '')
        }
      }
    },
    {
      name: 'export_preset',
      description: `Serialize a patch as the JSON a coSynth import takes back. No argument exports the LIVE patch as it sounds right now; \`name\` exports a stored preset instead, factory or user, on load_preset's shadowing rule. Reading is all it does: nothing is loaded and \`get_synth_state\`'s \`patch.preset\` is the same after. Returns \`json\`, validated on the way out, and a \`filename\` to suggest. No file is written; the page cannot save one.`,
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string', minLength: 1, maxLength: 80,
            description: 'A stored preset to export. Omit it to export the live patch.'
          },
          source: {
            type: 'string', enum: [...PRESET_SOURCES],
            description: 'Which space `name` is in. Only meaningful with `name`; omitted, a user preset of that name wins over a factory one.'
          }
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: true },
      execute(input) {
        const value = assertObject(input, 'input', ['name', 'source'])
        const source = assertPresetSource(value.source)
        if (value.name === undefined) {
          if (source !== undefined) throw new Error('source says which space to read `name` from, so it needs a `name`. Omit both to export the live patch.')
          const identity = currentPresetState(engine)
          const name = identity.name ?? LIVE_PATCH_EXPORT_NAME
          return {
            ...exportedPreset(name, engine.toPreset(name), 'live'),
            note: identity.name === null
              ? `The live patch, which is not a copy of any saved preset, so it is named "${name}". save_preset stores it in this browser under a name of your choosing.`
              : `The live patch, which ${identity.dirty ? 'HAS been edited since' : 'still matches'} the ${identity.source} preset "${identity.name}" it came from.${identity.dirty ? ' This export carries the edits; the saved preset does not.' : ''}`
          }
        }
        const name = validatePresetName(value.name)
        // `listPresets`, never the store's `loadPreset`: that one notifies the
        // preset-store listeners, so reading a preset through it would announce a
        // load that never happened and jump the UI's dropdown to a patch nobody
        // asked for. Reading is the whole job here.
        const user = source === 'factory' ? undefined : listPresets().find(preset => preset.name === name)
        const preset = user ?? (source === 'user' ? null : getFactoryPreset(name))
        if (!preset) throw new Error(presetNotFound(name, source))
        const shadowed = user !== undefined && factoryNames.has(name)
        return {
          ...exportedPreset(name, preset, user ? 'user' : 'factory'),
          ...(shadowed ? {
            shadowedFactoryPreset: true,
            note: `A factory preset is also called "${name}"; this exported the USER preset. Pass {"source":"factory"} for the built-in patch.`
          } : {})
        }
      }
    }
  ]
}
