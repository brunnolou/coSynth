/**
 * Note INPUT: accept `"C4"` or `60`, return one MIDI number.
 *
 * This exists because every agent used to convert a note name to a MIDI number itself
 * before calling `play_notes` or `render_audio`, and one of them got it wrong in the
 * quiet way: it measured a 37 Hz reference, correctly said "D1", and rendered `midi: 38`
 * - which is D2 at 73.4 Hz. An octave out, no error anywhere, and every harmonic
 * comparison downstream was garbage while the scalar metrics still looked plausible.
 * The conversion step is the bug surface, so this removes it from the caller.
 *
 * `describeMidi` is the other half of the fix: echoing "D2 (MIDI 38, 73.4 Hz)" back to
 * the model makes that mistake visible in the same turn it is made.
 *
 * All the pitch arithmetic that has a home in `notes.ts` comes from `notes.ts` - the
 * pitch-class table, the Hz mapping, the name formatting. What is written here is only
 * the inverse of `noteName`'s octave convention (`Math.floor(midi / 12) - 1`, so C-1 is
 * MIDI 0), and the round-trip test over the whole 0..127 range is what pins the two
 * together.
 */

import { midiToHz, noteName, NOTE_NAMES } from './notes'

export type NoteInput = number | string

const MIN_MIDI = 0
const MAX_MIDI = 127

/**
 * Sharps-only is right on OUTPUT: one spelling per pitch is what keeps the keyboard,
 * the pitch readout and the metrics comparable (see the note in `notes.ts`). INPUT is
 * the opposite problem - a model writes whichever spelling its source used - so `A#1`
 * and `Bb1` must both resolve to 34. Accept both spellings, emit one. The asymmetry is
 * deliberate; do not "fix" it by teaching `noteName` to spell flats.
 */
const FLAT = -1
const SHARP = 1

/**
 * Natural letter -> pitch class, read out of the shared table rather than retyped, so a
 * change to `NOTE_NAMES` cannot leave this file disagreeing with `noteName`.
 */
const NATURAL_SEMITONE: ReadonlyMap<string, number> = new Map(
  ['C', 'D', 'E', 'F', 'G', 'A', 'B'].map(letter => [letter, (NOTE_NAMES as readonly string[]).indexOf(letter)])
)

const ACCEPTED_FORMS =
  'Accepted forms: a MIDI number 0..127 (e.g. 60), or a note name with an explicit octave in scientific pitch ' +
  'notation (e.g. "C4", "D2", "F#3", "Bb1", "A#-1"), where C-1 is MIDI 0 and G9 is MIDI 127. The letter is ' +
  'case-insensitive; write a sharp as "#" or "s" and a flat as "b". Frequencies in Hz, solfege, octave-less ' +
  'names like "C", and combined forms like "C4/60" are not accepted.'

/** How the offending value is named back to the caller. Must never throw on exotic input. */
function received(input: unknown): string {
  if (typeof input === 'string') return `the string ${JSON.stringify(input)}`
  if (typeof input === 'number') return `the number ${String(input)}`
  if (typeof input === 'boolean' || typeof input === 'bigint') return `the ${typeof input} ${String(input)}`
  if (input === null) return 'null'
  if (input === undefined) return 'undefined'
  if (Array.isArray(input)) return `an array of length ${input.length}`
  return `a value of type ${typeof input}`
}

function reject(input: unknown, reason?: string): never {
  const head = reason ?? `Cannot read a MIDI note from ${received(input)}.`
  throw new Error(`${head} ${ACCEPTED_FORMS}`)
}

function outOfRange(midi: number): string {
  return `MIDI notes run 0..127 (${noteName(MIN_MIDI)} to ${noteName(MAX_MIDI)}), and that is ${midi}.`
}

/**
 * Parse a note name or MIDI number to a MIDI number.
 *
 * Throws a descriptive Error on anything unparseable: an agent reads the message and
 * retries, so the message is part of the interface.
 */
export function toMidi(input: NoteInput): number {
  if (typeof input === 'number') return fromNumber(input)
  if (typeof input === 'string') return fromName(input)
  reject(input)
}

/** Non-throwing variant: `null` where `toMidi` would throw. */
export function tryToMidi(input: NoteInput): number | null {
  try {
    return toMidi(input)
  } catch {
    return null
  }
}

function fromNumber(input: number): number {
  if (!Number.isFinite(input)) reject(input)
  if (!Number.isInteger(input)) {
    reject(input, `MIDI note ${input} must be a whole number; fractional pitches are not supported.`)
  }
  if (input < MIN_MIDI || input > MAX_MIDI) {
    reject(input, `MIDI note ${input} is out of range: ${outOfRange(input)}`)
  }
  return input
}

/**
 * Letter, at most one accidental, then a signed octave. Deliberately narrow:
 * no double accidentals, no naturals ("Cn4"), no trailing text, no `C4/60`.
 * Uppercase "B" is NOT read as a flat - only lowercase "b" is - because the letter
 * itself is case-insensitive and "CB4" would otherwise be a coin flip.
 */
const NAME = /^([A-Ga-g])([#sSb]?)(-?\d{1,2})$/
const BARE_INTEGER = /^-?\d+$/
const LETTER_ONLY = /^[A-Ga-g][#sSb]?$/

function fromName(raw: string): number {
  const text = raw.trim()
  if (text === '') reject(raw)

  // Two shapes that get a pointed message instead of the generic one, because both are
  // near-misses an agent can fix on the next call without guessing.
  if (BARE_INTEGER.test(text)) {
    reject(raw, `${JSON.stringify(raw)} is a string, not a note name. Pass the MIDI number ${text} itself, unquoted.`)
  }
  if (LETTER_ONLY.test(text)) {
    reject(raw, `${JSON.stringify(raw)} has no octave. Scientific pitch notation requires one - "C4" is middle C (MIDI 60).`)
  }

  const match = NAME.exec(text)
  if (!match) reject(raw)
  const [, letter, accidental, octaveText] = match

  // Reject "C04" and "C-0": a canonical octave keeps one spelling per pitch on input too,
  // and a stray leading zero is far more likely a typo than an intent.
  const octave = Number(octaveText)
  if (String(octave) !== octaveText) reject(raw)

  const semitone = NATURAL_SEMITONE.get(letter.toUpperCase())!
  const offset = accidental === '' ? 0 : accidental === 'b' ? FLAT : SHARP
  // Inverse of `noteName`'s `Math.floor(midi / 12) - 1`, so C-1 is MIDI 0.
  const midi = 12 * (octave + 1) + semitone + offset

  // Cb and B# are the only accidentals that cross an octave boundary, and sources
  // disagree about whether the octave digit belongs to the letter or to the sounding
  // pitch. That disagreement IS the octave error this module exists to prevent, so
  // neither spelling is accepted - the message names the note to write instead.
  if ((letter.toUpperCase() === 'C' && offset === FLAT) || (letter.toUpperCase() === 'B' && offset === SHARP)) {
    const equivalent = midi >= MIN_MIDI && midi <= MAX_MIDI ? ` Write ${JSON.stringify(noteName(midi))} instead.` : ''
    reject(raw, `${JSON.stringify(raw)} is not accepted: Cb and B# straddle the octave boundary and are read inconsistently.${equivalent}`)
  }

  if (midi < MIN_MIDI || midi > MAX_MIDI) {
    reject(raw, `${JSON.stringify(raw)} is out of range: ${outOfRange(midi)}`)
  }
  return midi
}

/**
 * `describeMidi(38)` is `"D2 (MIDI 38, 73.4 Hz)"`.
 *
 * Echo this back whenever a note is accepted. Reading "D2" after asking for a 37 Hz
 * reference is what makes an octave slip obvious while it can still be corrected.
 */
export function describeMidi(midi: number): string {
  const value = fromNumber(midi)
  return `${noteName(value)} (MIDI ${value}, ${midiToHz(value).toFixed(1)} Hz)`
}
