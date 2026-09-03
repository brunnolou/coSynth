// Central parameter registry, shared by the UI (main thread) and the DSP
// worklet. Parameters are addressed by numeric index (= position in PARAMS);
// presets and the mod matrix use the stable string id.
//
// All values travel over the message port NORMALIZED to 0..1. Mapping to real
// units (Hz, dB, semitones, ...) happens at the point of use via normToValue().

export interface ParamDef {
  id: string
  name: string
  group: string
  min: number
  max: number
  def: number            // default, in raw units
  curve?: 'lin' | 'exp'  // knob/normalization mapping (exp requires min > 0)
  step?: number          // quantize raw value (1 = integer)
  choices?: string[]     // enumerated parameter (min/max ignored, 0..len-1)
  /**
   * What each `choices` entry does, keyed by the choice label, for the choices
   * whose NAME does not say. A name is enough for `LP 12` or `1/8`; it is not
   * enough for a wavetable, where the name carries no timbre at all and the
   * only way to learn one is to render it and listen.
   *
   * Keyed rather than positional so a renderer can emit it verbatim and an
   * agent can read it without zipping two arrays, and so that inserting a
   * choice cannot silently shift every description by one.
   *
   * Deliberately NOT part of the compact line (`compactParameter`) or of the
   * tool listing: this is the detail `get_parameter_schema`'s full format
   * exists to hand over, paid by the one caller that asked about the parameter
   * rather than by every agent on every discovery call.
   */
  choiceNotes?: Readonly<Record<string, string>>
  unit?: string
  moddable?: boolean
  fmt?: (v: number) => string
}

export const FILTER_TYPES = ['LP 12', 'LP 24', 'HP 12', 'HP 24', 'BP 12', 'BP 24', 'Notch', 'Comb', 'Formant']
export const FILTER_TYPE_LABELS = [
  'Low Pass 12dB',
  'Low Pass 24dB',
  'High Pass 12dB',
  'High Pass 24dB',
  'Band Pass 12dB',
  'Band Pass 24dB',
  'Notch',
  'Comb',
  'Formant'
]
export const SUB_SHAPES = ['Sine', 'Triangle', 'Saw', 'Square']
export const NOISE_TYPES = ['White', 'Pink', 'Sample']
export const DIST_TYPES = ['Soft Clip', 'Hard Clip', 'Wavefold', 'Bitcrush']
export const FILTER_ROUTINGS = ['Series', 'Parallel']
export const LFO_MODES = ['Trigger', 'Free', 'Sync']
// Original one-bar-and-faster set. Presets store a division as its position in
// the array, so these thirteen entries are frozen: new divisions are appended,
// never inserted. The delay reuses this set on its own (see DELAY_DIVISIONS).
const BEAT_DIVISIONS = ['1/1', '1/2', '1/2T', '1/4.', '1/4', '1/4T', '1/8.', '1/8', '1/8T', '1/16.', '1/16', '1/16T', '1/32']
/** Whole note multiples 2/1..31/1 (N/1 = N whole notes = 4N beats), for slow LFO sweeps. */
const SLOW_DIVISIONS = Array.from({ length: 30 }, (_, i) => `${i + 2}/1`)
export const SYNC_DIVISIONS = [...BEAT_DIVISIONS, ...SLOW_DIVISIONS]
// The delay keeps the fast set. That is damage control, not a guarantee: a synced
// delay asks for divisionToBeats(div) * 60 / bpm seconds (worklet/processor.ts) and
// the delay line clamps at sr * 2.4 (worklet/effects.ts), so with master.bpm going
// down to 20 the fast set is ALREADY silently clamped -- `1/1` overruns 2.4 s below
// 100 BPM, `1/2` below 50, `1/4` below 25, and the echo drifts off the beat. Adding
// the slow set would widen an existing hole rather than open a new one (`2/1` clamps
// below 200 BPM), so it stays out. The real fix -- a longer buffer or a BPM-aware
// menu -- is not done here.
export const DELAY_DIVISIONS = BEAT_DIVISIONS
/** SYNC_DIVISIONS indices in menu order: slowest cycle first. */
/**
 * Menu order for `SYNC_DIVISIONS`: the slow multiples first, longest to
 * shortest, then the original thirteen in the grouped order they have always
 * been shown in. Sorting the whole list strictly by duration would interleave
 * dotted and triplet values (1/2, 1/4., 1/2T, 1/4, ...) and bury the 1/4
 * default thirty entries down, and it would disagree with the delay's menu,
 * which shows the same thirteen labels. Values stay the choice index, so this
 * changes presentation only.
 */
export const SYNC_DIVISION_ORDER = [
  ...SLOW_DIVISIONS.map((_, i) => BEAT_DIVISIONS.length + i).reverse(),
  ...BEAT_DIVISIONS.map((_, i) => i)
]
export const WAVETABLE_NAMES = ['Basic Shapes', 'Harmonic Sweep', 'PWM', 'Vocal', 'FM Bell', 'Digital', 'Custom']

/**
 * What each `osc*.wavetable` choice actually sounds like, and what `osc*.morph`
 * traverses inside it.
 *
 * These seven names are the parameter that decides the whole timbre, and a name
 * carries none of it: an evaluated matching agent burned four render-and-compare
 * rounds on tables that were all too dark before it happened to try `Digital`,
 * the one table with a near-flat spectrum. That was luck, and this is the fix.
 *
 * Every number here is MEASURED, not asserted from the comments in
 * `wavetable-gen.ts`: `params.test.ts` generates each table, reproduces
 * `WavetableData.read()`'s frame interpolation at the quoted morph positions,
 * FFTs the resulting cycle and checks the claim. A description that drifts from
 * the DSP fails the suite.
 *
 * The vocabulary is deliberately the match diff's own (`audio-analysis.ts`):
 * `tiltDbPerOctave` is a least-squares fit of partial level against log2(n) and
 * `oddEvenDb` is mean(odd) - mean(even), BOTH over partials 1..12 only
 * (`HARMONIC_COUNT`). So every tilt and odd/even figure below is over partials
 * 1..12 as well, which makes them directly comparable to a diff line: an agent
 * told "your odd/even is +9 dB too high" can read these and move toward the
 * `Basic Shapes` saw frame, and one told "too dark" can read them and go
 * straight to `Digital` instead of guessing four times.
 */
export const WAVETABLE_NOTES: Readonly<Record<string, string>> = {
  'Basic Shapes':
    'Morph lands exactly on four shapes: 0 sine (one partial), 1/3 triangle (odd only, -12 dB/oct), 2/3 saw (every partial, -6 dB/oct, odd/even +2 dB), 1 square (odd only, -6 dB/oct). Even partials fade in over 1/3..2/3 and back out by 1.',
  'Harmonic Sweep':
    'A 1/sqrt(k) series (-3 dB/oct, odd/even +1 dB) brick-walled at harmonic 2^(5*morph): 1 partial at morph 0, 2 at 0.2, 4 at 0.4, 8 at 0.6, 16 at 0.8, 32 at 1. Morph moves the cutoff, not the shape, and nothing exceeds harmonic 32.',
  PWM:
    'Pulse width 50% at morph 0 (exactly a square: odd only, -6 dB/oct) narrowing to 5% at morph 1, where partials 1..12 sit within 6 dB of each other (-1.5 dB/oct) and RMS is ~7 dB lower. Notches at every multiple of 1/width, moving down as morph rises.',
  Vocal:
    'Three resonances at fixed harmonic NUMBERS, so the formants transpose with the note instead of staying at fixed Hz. Nothing above harmonic 47 at all; odd/even stays within 3.2 dB. Morph 0 puts partial 6 about 19 dB ABOVE the fundamental (tilt +2.6); 0.5 is darkest (-14 dB/oct); 1 is -7.',
  'FM Bell':
    'Phase modulation, so partials arrive in gaps rather than as a series. Morph 0 is near-sine, odd only (3rd at -15 dB). Morph 1 keeps only k mod 5 = 1 or 4 (1, 4, 6, 9, 11, ...), with 9 and 11 as loud as the fundamental and every other partial silent. Widest around morph 0.7.',
  Digital:
    'Random hard-edged staircases, 15..31 equal steps per cycle, so partials at multiples of the step count drop out. The only near-flat table: tilt stays between -3.3 and +0.7 dB/oct over the whole morph and no partial 1..12 falls below -20 dB. Morph reshuffles which partials are loud, not brightness.',
  Custom:
    'Slot for a WAV imported through the browser UI; no tool can import one. With nothing imported the oscillator falls back to Digital, so selecting Custom from a tool changes the label and nothing else. An imported table brings its own frames, so morph means whatever that file means.'
} as const

/**
 * `dist.type` does not pick a flavour of one algorithm, it picks between two
 * branches that read DIFFERENT parameters (`worklet/voice.ts`): the three
 * waveshapers use `dist.drive`, Bitcrush uses `dist.bits` and
 * `dist.downsample` and reads `dist.drive` without ever applying it. An agent
 * turning up Drive under Bitcrush is turning a knob that is wired to nothing,
 * which is the sort of thing a schema should say out loud.
 */
export const DIST_TYPE_NOTES: Readonly<Record<string, string>> = {
  'Soft Clip': 'tanh(x * (1 + 15*drive)), compensated by 1/sqrt(gain): rounded saturation, adds mostly odd partials, never a hard edge.',
  'Hard Clip': 'Clamps at +-0.8 after the same 1 + 15*drive gain: flat-topped, a far brighter partial spray than Soft Clip at equal drive.',
  Wavefold: 'sin(x * 1.5 * (1 + 15*drive)): past the first fold the transfer curve turns back on itself, so partials appear and vanish non-monotonically as drive rises.',
  Bitcrush: 'Quantizes to 2^dist.bits levels and holds each sample dist.downsample times. dist.drive is read and then UNUSED on this branch; bits and downsample are ignored by the other three types.'
} as const

/** Parallel averages the two branches, which is a level change the label hides. */
export const FILTER_ROUTING_NOTES: Readonly<Record<string, string>> = {
  Series: 'filter1 feeds filter2; whichever one is enabled runs alone if the other is off.',
  Parallel: 'Both filters take the same input and their outputs are averaged (x0.5), so an enabled pair lands ~6 dB below the same pair in Series. With one filter enabled this is identical to Series.'
} as const

/** Beats per cycle for a sync division: `n/d` is 4n/d beats, `.` dotted, `T` triplet. */
export function divisionToBeats(divIndex: number): number {
  const name = SYNC_DIVISIONS[divIndex] ?? '1/4'
  const m = /^(\d+)\/(\d+)([.T]?)$/.exec(name)
  if (!m) return 1
  let b = (4 * Number(m[1])) / Number(m[2])
  if (m[3] === '.') b *= 1.5
  if (m[3] === 'T') b *= 2 / 3
  return b
}

/**
 * Beats per cycle of a free-running LFO at `freq` Hz under a `bpm` transport.
 * A cycle lasts `1 / freq` seconds and a beat lasts `60 / bpm` seconds, so the
 * cycle spans `(1 / freq) / (60 / bpm)` beats. Mirrors `divisionToBeats` for the
 * synced case, letting both feed the same beat-phase accumulator.
 */
export function freqToBeatsPerCycle(freq: number, bpm: number): number {
  return bpm / (60 * Math.max(freq, 1e-4))
}

const defs: ParamDef[] = []
function p(d: ParamDef): number {
  defs.push(d)
  return defs.length - 1
}

const pct = (v: number) => `${Math.round(v * 100)}%`
const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${v.toFixed(1)} Hz`)
const ms = (v: number) => (v >= 1 ? `${v.toFixed(2)} s` : `${Math.round(v * 1000)} ms`)
const st = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v)} st`
const db = (v: number) => `${v.toFixed(1)} dB`

// ---------------------------------------------------------------- global
p({ id: 'master.volume', name: 'Master', group: 'global', min: 0, max: 1.5, def: 0.7, moddable: true, fmt: pct })
p({ id: 'master.bpm', name: 'BPM', group: 'global', min: 20, max: 300, def: 120, step: 1, unit: 'BPM' })
p({ id: 'master.polyphony', name: 'Voices', group: 'global', min: 1, max: 16, def: 16, step: 1, unit: 'voices' })
p({ id: 'master.bend_range', name: 'Bend Rng', group: 'global', min: 1, max: 48, def: 2, step: 1, unit: 'st' })

// ---------------------------------------------------------------- oscillators
for (let o = 1; o <= 3; o++) {
  const g = `osc${o}`
  p({ id: `${g}.enabled`, name: 'On', group: g, min: 0, max: 1, def: o === 1 ? 1 : 0, step: 1 })
  p({ id: `${g}.wavetable`, name: 'Table', group: g, min: 0, max: WAVETABLE_NAMES.length - 1, def: 0, choices: WAVETABLE_NAMES, choiceNotes: WAVETABLE_NOTES })
  p({ id: `${g}.morph`, name: 'Morph', group: g, min: 0, max: 1, def: 0, moddable: true, fmt: pct })
  p({ id: `${g}.level`, name: 'Level', group: g, min: 0, max: 1, def: 0.7, moddable: true, fmt: pct })
  p({ id: `${g}.pan`, name: 'Pan', group: g, min: -1, max: 1, def: 0, moddable: true, fmt: v => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? `${Math.round(-v * 100)}L` : `${Math.round(v * 100)}R`) })
  p({ id: `${g}.unison`, name: 'Unison', group: g, min: 1, max: 16, def: 1, step: 1, fmt: v => `${Math.round(v)}v` })
  p({ id: `${g}.detune`, name: 'Detune', group: g, min: 0, max: 100, def: 12, moddable: true, fmt: v => `${v.toFixed(0)} ct` })
  p({ id: `${g}.blend`, name: 'Blend', group: g, min: 0, max: 1, def: 0.7, moddable: true, fmt: pct })
  p({ id: `${g}.spread`, name: 'Spread', group: g, min: 0, max: 1, def: 0.6, moddable: true, fmt: pct })
  p({ id: `${g}.phase`, name: 'Phase', group: g, min: 0, max: 1, def: 0, moddable: true, fmt: v => `${Math.round(v * 360)}°` })
  p({ id: `${g}.phase_rand`, name: 'Rand', group: g, min: 0, max: 1, def: 1, fmt: pct })
  p({ id: `${g}.transpose`, name: 'Pitch', group: g, min: -48, max: 48, def: 0, step: 1, moddable: true, fmt: st })
  p({ id: `${g}.fine`, name: 'Fine', group: g, min: -100, max: 100, def: 0, moddable: true, fmt: v => `${v.toFixed(0)} ct` })
  p({ id: `${g}.sync`, name: 'Sync', group: g, min: 1, max: 4, def: 1, moddable: true, fmt: v => `${v.toFixed(2)}x` })
}

// ---------------------------------------------------------------- sub + noise
p({ id: 'sub.enabled', name: 'On', group: 'sub', min: 0, max: 1, def: 0, step: 1 })
p({ id: 'sub.shape', name: 'Shape', group: 'sub', min: 0, max: 3, def: 0, choices: SUB_SHAPES })
p({ id: 'sub.level', name: 'Level', group: 'sub', min: 0, max: 1, def: 0.6, moddable: true, fmt: pct })
p({ id: 'sub.pan', name: 'Pan', group: 'sub', min: -1, max: 1, def: 0, moddable: true })
p({ id: 'sub.octave', name: 'Octave', group: 'sub', min: -3, max: 0, def: -1, step: 1, fmt: v => `${Math.round(v)} oct` })

p({ id: 'noise.enabled', name: 'On', group: 'noise', min: 0, max: 1, def: 0, step: 1 })
p({ id: 'noise.type', name: 'Type', group: 'noise', min: 0, max: 2, def: 0, choices: NOISE_TYPES })
p({ id: 'noise.level', name: 'Level', group: 'noise', min: 0, max: 1, def: 0.5, moddable: true, fmt: pct })
p({ id: 'noise.pan', name: 'Pan', group: 'noise', min: -1, max: 1, def: 0, moddable: true })
p({ id: 'noise.pitch', name: 'Pitch', group: 'noise', min: -24, max: 24, def: 0, moddable: true, fmt: st })

// ---------------------------------------------------------------- filters
for (let f = 1; f <= 2; f++) {
  const g = `filter${f}`
  p({ id: `${g}.enabled`, name: 'On', group: g, min: 0, max: 1, def: f === 1 ? 1 : 0, step: 1 })
  p({ id: `${g}.type`, name: 'Type', group: g, min: 0, max: FILTER_TYPES.length - 1, def: 1, choices: FILTER_TYPES })
  p({ id: `${g}.cutoff`, name: 'Cutoff', group: g, min: 20, max: 20000, def: 8000, curve: 'exp', moddable: true, fmt: hz })
  p({ id: `${g}.resonance`, name: 'Res', group: g, min: 0, max: 1, def: 0.2, moddable: true, fmt: pct })
  p({ id: `${g}.drive`, name: 'Drive', group: g, min: 0, max: 1, def: 0, moddable: true, fmt: pct })
  p({ id: `${g}.keytrack`, name: 'Key Trk', group: g, min: 0, max: 1, def: 0, moddable: true, fmt: pct })
  p({ id: `${g}.mix`, name: 'Mix', group: g, min: 0, max: 1, def: 1, moddable: true, fmt: pct })
}
// Grouped as `filter` to match the id prefix: presets persist the id, never the
// group, and a `filterRouting` group had agents filtering on a name no id carries.
p({ id: 'filter.routing', name: 'Routing', group: 'filter', min: 0, max: 1, def: 0, choices: FILTER_ROUTINGS, choiceNotes: FILTER_ROUTING_NOTES })

// ---------------------------------------------------------------- distortion section (per-voice)
p({ id: 'dist.enabled', name: 'On', group: 'dist', min: 0, max: 1, def: 0, step: 1 })
p({ id: 'dist.type', name: 'Type', group: 'dist', min: 0, max: DIST_TYPES.length - 1, def: 0, choices: DIST_TYPES, choiceNotes: DIST_TYPE_NOTES })
p({ id: 'dist.drive', name: 'Drive', group: 'dist', min: 0, max: 1, def: 0.3, moddable: true, fmt: pct })
p({ id: 'dist.mix', name: 'Mix', group: 'dist', min: 0, max: 1, def: 1, moddable: true, fmt: pct })
p({ id: 'dist.bits', name: 'Bits', group: 'dist', min: 1, max: 16, def: 8, moddable: true, fmt: v => `${v.toFixed(1)} bit` })
p({ id: 'dist.downsample', name: 'Rate', group: 'dist', min: 1, max: 64, def: 1, curve: 'exp', moddable: true, unit: 'x', fmt: v => `÷${v.toFixed(1)}` })

/**
 * Facts about a group that its parameter definitions cannot express, surfaced
 * by `get_parameter_schema`. Two kinds live here: hardwired routing - env1 is
 * the VCA (`voice.ts` multiplies the voice by `sources[SRC_ENV0]` and takes
 * voice lifetime from it), while env2..env6 and every LFO reach the sound only
 * through the mod matrix - and the curve sign convention, which is a bare
 * `-1..1` in the definitions and so a coin flip without it.
 *
 * The curve wording is measured, not guessed: `curveShape(t, c) = t^(2^(3c))`
 * in `worklet/dsp.ts`, applied as `curveShape(t, atkCurve)` for the attack and
 * as `1 - curveShape(t, -decCurve)` for decay and release, which is why the
 * sign reads opposite between them. `worklet/dsp.test.ts` pins both directions.
 */
const ENVELOPE_CURVE_NOTE = 'atk_curve, dec_curve, and rel_curve shape a stage, they do not lengthen it: 0 is linear. Positive atk_curve starts the attack slowly and rises steeply at its end; negative atk_curve jumps up and eases into the peak. dec_curve and rel_curve read the opposite way: positive falls fast and trails off into a long low tail (the usual exponential-sounding decay), negative holds near the level it started from and drops steeply only at the end of the stage - the default -0.4 is still at 96% of its starting level a quarter of the way through decay, which sounds like a delay before the decay rather than a slow one.'

/**
 * The other hardwired routing an agent cannot read off a parameter list: a
 * `filter*.mix` of 0 is a full bypass of that filter AND of its drive, because
 * `VoiceFilter.process` (`worklet/dsp.ts`) applies drive inside the wet path
 * only - `dry * input + wet * filtered(tanh(input * driveGain))`. A patch left
 * at mix 0.5 reads as "too bright" in a match diff no matter where the cutoff
 * goes, and nothing in `mix 0..1 =1` says why.
 *
 * These land on `filter1` and `filter2`, not on `filter`, because an agent that
 * filters the schema to one filter is exactly the one about to set its mix.
 */
const FILTER_MIX_NOTE = (g: string) => `${g}.mix is dry/wet against this filter's own input and ${g}.drive sits inside the wet path, so mix 0 bypasses both and mix 1 is fully filtered. Cutoff is multiplied by 2^((note - 60)/12 * ${g}.keytrack).`

export const PARAM_GROUP_NOTES: Readonly<Record<string, string>> = {
  filter1: FILTER_MIX_NOTE('filter1'),
  filter2: FILTER_MIX_NOTE('filter2'),
  // Chain position, which decides what the section even hears. `voice.ts` runs
  // oscillators+sub+noise -> filters -> dist -> env1 (VCA), per voice, so dist
  // shapes each note before the notes sum and before the amp envelope scales
  // them; `fxdist` is the master-bus distortion that works on the sum.
  dist: 'The dist section is PER VOICE and sits between the filters and the amp envelope, so it distorts each note on its own, before the voices sum and before env1 scales them; fxdist is the master-bus distortion. Which of its parameters do anything at all depends on dist.type.',
  env1: 'env1 is the amplitude envelope (VCA), hardwired to voice level and voice lifetime: a note stops sounding when env1 finishes its release. env2..env6 and lfo1..lfo8 have no hardwired destination and do nothing until routed with set_modulation. ' + ENVELOPE_CURVE_NOTE,
  ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`env${i + 2}`, ENVELOPE_CURVE_NOTE]))
}

// ---------------------------------------------------------------- envelopes (env1 = amp)
for (let e = 1; e <= 6; e++) {
  const g = `env${e}`
  p({ id: `${g}.delay`, name: 'Delay', group: g, min: 0, max: 2, def: 0, fmt: ms })
  p({ id: `${g}.attack`, name: 'Attack', group: g, min: 0.001, max: 10, def: e === 1 ? 0.005 : 0.05, curve: 'exp', moddable: true, fmt: ms })
  p({ id: `${g}.hold`, name: 'Hold', group: g, min: 0, max: 2, def: 0, fmt: ms })
  p({ id: `${g}.decay`, name: 'Decay', group: g, min: 0.001, max: 10, def: 0.5, curve: 'exp', moddable: true, fmt: ms })
  p({ id: `${g}.sustain`, name: 'Sustain', group: g, min: 0, max: 1, def: e === 1 ? 0.8 : 0.5, moddable: true, fmt: pct })
  p({ id: `${g}.release`, name: 'Release', group: g, min: 0.002, max: 15, def: 0.2, curve: 'exp', moddable: true, fmt: ms })
  p({ id: `${g}.atk_curve`, name: 'A Curve', group: g, min: -1, max: 1, def: 0.4 })
  p({ id: `${g}.dec_curve`, name: 'D Curve', group: g, min: -1, max: 1, def: -0.4 })
  p({ id: `${g}.rel_curve`, name: 'R Curve', group: g, min: -1, max: 1, def: -0.4 })
}

// ---------------------------------------------------------------- LFOs
for (let l = 1; l <= 8; l++) {
  const g = `lfo${l}`
  p({ id: `${g}.rate`, name: 'Rate', group: g, min: 0.01, max: 40, def: 2, curve: 'exp', moddable: true, fmt: hz })
  p({ id: `${g}.sync`, name: 'Sync', group: g, min: 0, max: 1, def: 1, step: 1 })
  p({ id: `${g}.division`, name: 'Div', group: g, min: 0, max: SYNC_DIVISIONS.length - 1, def: 4, choices: SYNC_DIVISIONS })
  p({ id: `${g}.mode`, name: 'Mode', group: g, min: 0, max: 2, def: 0, choices: LFO_MODES })
  p({ id: `${g}.phase`, name: 'Phase', group: g, min: 0, max: 1, def: 0, fmt: pct })
  p({ id: `${g}.smooth`, name: 'Smooth', group: g, min: 0, max: 1, def: 0, fmt: pct })
}

// ---------------------------------------------------------------- macros
for (let m = 1; m <= 4; m++) {
  p({ id: `macro${m}.value`, name: `Macro ${m}`, group: 'macros', min: 0, max: 1, def: 0, moddable: true, fmt: pct })
}

// ---------------------------------------------------------------- effects
p({ id: 'chorus.enabled', name: 'On', group: 'chorus', min: 0, max: 1, def: 0, step: 1 })
p({ id: 'chorus.rate', name: 'Rate', group: 'chorus', min: 0.05, max: 8, def: 0.4, curve: 'exp', moddable: true, fmt: hz })
p({ id: 'chorus.depth', name: 'Depth', group: 'chorus', min: 0, max: 1, def: 0.5, moddable: true, fmt: pct })
p({ id: 'chorus.mix', name: 'Mix', group: 'chorus', min: 0, max: 1, def: 0.5, moddable: true, fmt: pct })

p({ id: 'phaser.enabled', name: 'On', group: 'phaser', min: 0, max: 1, def: 0, step: 1 })
p({ id: 'phaser.rate', name: 'Rate', group: 'phaser', min: 0.02, max: 10, def: 0.3, curve: 'exp', moddable: true, fmt: hz })
p({ id: 'phaser.depth', name: 'Depth', group: 'phaser', min: 0, max: 1, def: 0.7, moddable: true, fmt: pct })
p({ id: 'phaser.feedback', name: 'Fdbk', group: 'phaser', min: 0, max: 0.95, def: 0.4, moddable: true, fmt: pct })
p({ id: 'phaser.mix', name: 'Mix', group: 'phaser', min: 0, max: 1, def: 0.5, moddable: true, fmt: pct })

p({ id: 'flanger.enabled', name: 'On', group: 'flanger', min: 0, max: 1, def: 0, step: 1 })
p({ id: 'flanger.rate', name: 'Rate', group: 'flanger', min: 0.02, max: 10, def: 0.25, curve: 'exp', moddable: true, fmt: hz })
p({ id: 'flanger.depth', name: 'Depth', group: 'flanger', min: 0, max: 1, def: 0.6, moddable: true, fmt: pct })
p({ id: 'flanger.feedback', name: 'Fdbk', group: 'flanger', min: 0, max: 0.95, def: 0.5, moddable: true, fmt: pct })
p({ id: 'flanger.mix', name: 'Mix', group: 'flanger', min: 0, max: 1, def: 0.5, moddable: true, fmt: pct })

p({ id: 'delay.enabled', name: 'On', group: 'delay', min: 0, max: 1, def: 0, step: 1 })
p({ id: 'delay.sync', name: 'Sync', group: 'delay', min: 0, max: 1, def: 1, step: 1 })
p({ id: 'delay.division', name: 'Div', group: 'delay', min: 0, max: DELAY_DIVISIONS.length - 1, def: 7, choices: DELAY_DIVISIONS })
p({ id: 'delay.time', name: 'Time', group: 'delay', min: 0.01, max: 2, def: 0.35, curve: 'exp', moddable: true, fmt: ms })
p({ id: 'delay.feedback', name: 'Fdbk', group: 'delay', min: 0, max: 0.98, def: 0.4, moddable: true, fmt: pct })
p({ id: 'delay.pingpong', name: 'PingPong', group: 'delay', min: 0, max: 1, def: 0, step: 1 })
p({ id: 'delay.mix', name: 'Mix', group: 'delay', min: 0, max: 1, def: 0.3, moddable: true, fmt: pct })

p({ id: 'reverb.enabled', name: 'On', group: 'reverb', min: 0, max: 1, def: 0, step: 1 })
p({ id: 'reverb.size', name: 'Size', group: 'reverb', min: 0, max: 1, def: 0.7, moddable: true, fmt: pct })
p({ id: 'reverb.damp', name: 'Damp', group: 'reverb', min: 0, max: 1, def: 0.5, moddable: true, fmt: pct })
p({ id: 'reverb.width', name: 'Width', group: 'reverb', min: 0, max: 1, def: 1, moddable: true, fmt: pct })
p({ id: 'reverb.mix', name: 'Mix', group: 'reverb', min: 0, max: 1, def: 0.3, moddable: true, fmt: pct })

p({ id: 'eq.enabled', name: 'On', group: 'eq', min: 0, max: 1, def: 0, step: 1 })
p({ id: 'eq.low_gain', name: 'Low', group: 'eq', min: -18, max: 18, def: 0, moddable: true, fmt: db })
p({ id: 'eq.mid_gain', name: 'Mid', group: 'eq', min: -18, max: 18, def: 0, moddable: true, fmt: db })
p({ id: 'eq.mid_freq', name: 'Mid Freq', group: 'eq', min: 100, max: 8000, def: 1000, curve: 'exp', moddable: true, fmt: hz })
p({ id: 'eq.high_gain', name: 'High', group: 'eq', min: -18, max: 18, def: 0, moddable: true, fmt: db })

p({ id: 'comp.enabled', name: 'On', group: 'comp', min: 0, max: 1, def: 0, step: 1 })
p({ id: 'comp.threshold', name: 'Thresh', group: 'comp', min: -60, max: 0, def: -18, moddable: true, fmt: db })
p({ id: 'comp.ratio', name: 'Ratio', group: 'comp', min: 1, max: 20, def: 4, curve: 'exp', fmt: v => `${v.toFixed(1)}:1` })
p({ id: 'comp.attack', name: 'Attack', group: 'comp', min: 0.0005, max: 0.2, def: 0.01, curve: 'exp', fmt: ms })
p({ id: 'comp.release', name: 'Release', group: 'comp', min: 0.01, max: 2, def: 0.2, curve: 'exp', fmt: ms })
p({ id: 'comp.makeup', name: 'Makeup', group: 'comp', min: 0, max: 24, def: 0, fmt: db })

p({ id: 'fxdist.enabled', name: 'On', group: 'fxdist', min: 0, max: 1, def: 0, step: 1 })
p({ id: 'fxdist.drive', name: 'Drive', group: 'fxdist', min: 0, max: 1, def: 0.4, moddable: true, fmt: pct })
p({ id: 'fxdist.tone', name: 'Tone', group: 'fxdist', min: 200, max: 18000, def: 8000, curve: 'exp', moddable: true, fmt: hz })
p({ id: 'fxdist.mix', name: 'Mix', group: 'fxdist', min: 0, max: 1, def: 1, moddable: true, fmt: pct })

// ---------------------------------------------------------------- units
// `unit` is a short machine-readable hint for agents reading the parameter
// schema, and it must describe the RAW scale that `min`/`max`/`def` and the
// update API speak. `fmt` is a display concern that is free to rescale, so the
// rendered suffix is only a clue to the raw unit, never the unit itself:
// `ms` renders "5 ms" off a raw 0.005 SECONDS, so its hint is `s`. Formatters
// whose rendered unit has no honest raw counterpart contribute no hint at all
// (`pct` renders "70%" off a raw 0.7, the degree formatter "252°" off 0.7) —
// advertising `%` or `°` there would invite values a hundredfold too large.
// Where a raw unit exists but cannot be inferred, declare `unit` on the param.
const UNIT_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/k?Hz$/, 'Hz'],
  [/\bct$/, 'ct'],
  [/\bst$/, 'st'],
  [/\bdB$/, 'dB'],
  [/\bbit$/, 'bit'],
  [/\boct$/, 'oct'],
  [/\b(?:s|ms)$/, 's'],
  [/:1$/, ':1'],
  [/\dv$/, 'voices'],
  [/\dx$/, 'x']
]

function deriveUnit(d: ParamDef): string | undefined {
  if (d.choices || !d.fmt) return undefined
  let unit: string | undefined
  for (const value of [d.min, d.def, d.max]) {
    const formatted = d.fmt(value)
    const match = UNIT_RULES.find(([pattern]) => pattern.test(formatted))?.[1]
    if (!match || (unit !== undefined && unit !== match)) return undefined
    unit = match
  }
  return unit
}

for (const d of defs) {
  if (d.unit === undefined) {
    const unit = deriveUnit(d)
    if (unit) d.unit = unit
  }
}

export const PARAMS: readonly ParamDef[] = defs
export const NUM_PARAMS = PARAMS.length

const indexById = new Map<string, number>()
PARAMS.forEach((d, i) => indexById.set(d.id, i))

export function paramIndex(id: string): number {
  const i = indexById.get(id)
  if (i === undefined) throw new Error(`unknown param: ${id}`)
  return i
}
export function paramDef(id: string): ParamDef {
  return PARAMS[paramIndex(id)]
}

/** Map normalized 0..1 to the raw value. */
export function normToValue(d: ParamDef, n: number): number {
  n = n < 0 ? 0 : n > 1 ? 1 : n
  if (d.choices) return Math.round(n * (d.choices.length - 1))
  let v: number
  if (d.curve === 'exp') v = d.min * Math.pow(d.max / d.min, n)
  else v = d.min + (d.max - d.min) * n
  if (d.step) v = Math.round(v / d.step) * d.step
  return v
}

/** Map a raw value to normalized 0..1. */
export function valueToNorm(d: ParamDef, v: number): number {
  if (d.choices) return d.choices.length > 1 ? v / (d.choices.length - 1) : 0
  let n: number
  if (d.curve === 'exp') n = Math.log(v / d.min) / Math.log(d.max / d.min)
  else n = (v - d.min) / (d.max - d.min)
  return n < 0 ? 0 : n > 1 ? 1 : n
}

export function defaultNorm(d: ParamDef): number {
  return valueToNorm(d, d.def)
}

export function formatValue(d: ParamDef, n: number): string {
  const v = normToValue(d, n)
  if (d.choices) return d.choices[v] ?? String(v)
  if (d.fmt) return d.fmt(v)
  return Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(0)
}

/** Default normalized values for the whole parameter set (init patch). */
export function defaultValues(): Float32Array {
  const a = new Float32Array(NUM_PARAMS)
  for (let i = 0; i < NUM_PARAMS; i++) a[i] = defaultNorm(PARAMS[i])
  return a
}
