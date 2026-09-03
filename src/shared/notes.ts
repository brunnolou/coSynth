/**
 * The single source of truth for MIDI, frequency and note names.
 *
 * Three copies of this arithmetic already existed - the keyboard's naming, the worklet's
 * `dsp.ts` midi->Hz, and the tool layer's - and a fourth in the pitch detector would be the
 * mistake. The worklet keeps its own inline copy on purpose: its hot path should not import
 * across a module boundary it does not need.
 *
 * Conventions, settled here so the keyboard, the pitch readout and any future chord display
 * can never disagree on screen: A4 = 440 Hz, and scientific pitch notation with C-1 = MIDI 0,
 * which is what `@tonaljs/note` also produces. Adopting a theory library later is therefore a
 * change to this one file, not a renumbering of every octave label.
 *
 * Spelling is sharps-only today. When keys ship, spelling becomes key-context-dependent and
 * `noteName` grows an optional key argument; keeping every caller on this function is what
 * makes that a one-file change.
 */

export const A4_HZ = 440

/** Sharps-only. See the note on spelling above. */
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

export function midiToHz(midi: number, a4 = A4_HZ): number {
  return a4 * Math.pow(2, (midi - 69) / 12)
}

/** Fractional, so callers can see how far from a note a measurement actually fell. */
export function hzToMidi(hz: number, a4 = A4_HZ): number {
  return 69 + 12 * Math.log2(hz / a4)
}

/** `cents` is -50…+50, the offset of `hz` from the returned note. */
export function hzToNearestMidi(hz: number, a4 = A4_HZ): { midi: number; cents: number } {
  const exact = hzToMidi(hz, a4)
  const midi = Math.round(exact)
  return { midi, cents: (exact - midi) * 100 }
}

/** `noteName(38)` is `D2`. */
export function noteName(midi: number): string {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
}
