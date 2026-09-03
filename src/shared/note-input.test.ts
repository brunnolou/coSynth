import { describe, expect, it } from 'vitest'
import { noteName } from './notes'
import { describeMidi, toMidi, tryToMidi } from './note-input'

/** The message is read by an agent that has to retry, so it is asserted like any other output. */
function messageFor(input: unknown): string {
  try {
    toMidi(input as never)
  } catch (error) {
    return (error as Error).message
  }
  throw new Error(`expected toMidi(${JSON.stringify(input)}) to throw`)
}

describe('toMidi', () => {
  it('passes a valid MIDI number through', () => {
    expect(toMidi(60)).toBe(60)
    expect(toMidi(0)).toBe(0)
    expect(toMidi(127)).toBe(127)
  })

  it('parses scientific pitch notation', () => {
    expect(toMidi('C4')).toBe(60)
    expect(toMidi('A4')).toBe(69)
    expect(toMidi('F#3')).toBe(54)
    expect(toMidi('Eb0')).toBe(15)
    expect(toMidi('G9')).toBe(127)
  })

  it('resolves the octave the D1/MIDI-38 incident got wrong', () => {
    // A 37 Hz reference is D1. Rendering `midi: 38` played D2 at 73.4 Hz, an octave up,
    // and nothing downstream noticed. Both spellings now land where the name says.
    expect(toMidi('D1')).toBe(26)
    expect(toMidi('D2')).toBe(38)
  })

  it('reads sharps and flats of the same pitch identically', () => {
    expect(toMidi('A#1')).toBe(toMidi('Bb1'))
    expect(toMidi('A#1')).toBe(34)
    expect(toMidi('C#4')).toBe(toMidi('Db4'))
    expect(toMidi('G#7')).toBe(toMidi('Ab7'))
  })

  it('accepts "s" for a sharp', () => {
    expect(toMidi('Fs3')).toBe(toMidi('F#3'))
    expect(toMidi('cS4')).toBe(toMidi('C#4'))
  })

  it('is case-insensitive on the letter', () => {
    expect(toMidi('c4')).toBe(60)
    expect(toMidi('bb1')).toBe(34)
    expect(toMidi('f#3')).toBe(54)
  })

  it('handles negative octaves', () => {
    expect(toMidi('C-1')).toBe(0)
    expect(toMidi('A#-1')).toBe(10)
    expect(toMidi('B-1')).toBe(11)
    expect(toMidi('C0')).toBe(12)
  })

  it('tolerates surrounding whitespace', () => {
    expect(toMidi('  C4  ')).toBe(60)
  })

  it('accepts E# and Fb, which do not cross an octave boundary', () => {
    expect(toMidi('E#3')).toBe(toMidi('F3'))
    expect(toMidi('Fb3')).toBe(toMidi('E3'))
  })

  it('round-trips every MIDI note through noteName', () => {
    for (let midi = 0; midi <= 127; midi++) {
      expect(toMidi(noteName(midi))).toBe(midi)
    }
  })
})

describe('toMidi rejections', () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['a letter that is not a note', 'H4'],
    ['a name with no octave', 'C'],
    ['an octave above the range', 'C99'],
    ['an octave below the range', 'C-2'],
    ['a MIDI number above the range', 128],
    ['a negative MIDI number', -1],
    ['an empty string', ''],
    ['blank space', '  '],
    ['null', null],
    ['undefined', undefined],
    ['an object', { midi: 60 }],
    ['an array', [60]],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY]
  ]

  for (const [label, input] of cases) {
    it(`rejects ${label}`, () => {
      expect(() => toMidi(input as never)).toThrow()
      expect(tryToMidi(input as never)).toBeNull()
    })
  }

  it('rejects a fractional MIDI number', () => {
    expect(() => toMidi(60.5)).toThrow(/whole number/)
  })

  it('refuses forms that are not scientific pitch notation', () => {
    // One ambiguous accepted form is worse than a rejection: a frequency, a solfege
    // syllable and a combined name/number all read as pitches to a human.
    for (const input of ['440', '440Hz', '73.4', 'do', 'Do4', 'C4/60', 'C##4', 'Cn4', 'C4 major', 'C 4', 'C4b']) {
      expect(tryToMidi(input)).toBeNull()
    }
  })

  it('refuses a non-canonical octave', () => {
    expect(tryToMidi('C04')).toBeNull()
    expect(tryToMidi('C-0')).toBeNull()
  })

  it('refuses Cb and B#, which straddle the octave boundary', () => {
    expect(tryToMidi('Cb4')).toBeNull()
    expect(tryToMidi('B#3')).toBeNull()
    expect(messageFor('Cb4')).toContain('"B3"')
    expect(messageFor('B#3')).toContain('"C4"')
  })

  it('refuses an uppercase B as a flat marker', () => {
    // The letter is case-insensitive, so "CB4" would otherwise be Cb4 or C4 by coin flip.
    expect(tryToMidi('CB4')).toBeNull()
  })

  it('names the offending input and the accepted forms in every message', () => {
    for (const [, input] of cases) {
      const message = messageFor(input)
      expect(message.length).toBeGreaterThan(0)
      expect(message).toContain('Accepted forms')
      expect(message).toContain('0..127')
    }
    expect(messageFor('H4')).toContain('"H4"')
    expect(messageFor('C-2')).toContain('"C-2"')
    expect(messageFor(128)).toContain('128')
    expect(messageFor(null)).toContain('null')
    expect(messageFor(undefined)).toContain('undefined')
    expect(messageFor({ midi: 60 })).toContain('object')
    expect(messageFor(Number.NaN)).toContain('NaN')
  })

  it('tells a caller that quoted a MIDI number what to send instead', () => {
    expect(messageFor('60')).toContain('60')
    expect(messageFor('60')).toMatch(/unquoted/)
  })

  it('tells a caller that omitted the octave that one is required', () => {
    expect(messageFor('C')).toMatch(/octave/)
  })
})

describe('tryToMidi', () => {
  it('returns the same numbers toMidi does', () => {
    expect(tryToMidi('C4')).toBe(60)
    expect(tryToMidi(38)).toBe(38)
    expect(tryToMidi('Bb1')).toBe(34)
  })
})

describe('describeMidi', () => {
  it('states the name, the MIDI number and the frequency', () => {
    const described = describeMidi(38)
    expect(described).toContain('D2')
    expect(described).toContain('38')
    expect(described).toBe('D2 (MIDI 38, 73.4 Hz)')
    const hz = Number(/([\d.]+) Hz/.exec(described)![1])
    expect(hz).toBeCloseTo(73.4, 1)
  })

  it('describes the ends of the range', () => {
    expect(describeMidi(0)).toBe('C-1 (MIDI 0, 8.2 Hz)')
    expect(describeMidi(69)).toBe('A4 (MIDI 69, 440.0 Hz)')
  })

  it('describes what toMidi parsed, closing the loop', () => {
    expect(describeMidi(toMidi('D1'))).toContain('D1')
    expect(describeMidi(toMidi('D1'))).toContain('36.7 Hz')
  })

  it('rejects a MIDI number outside the range', () => {
    expect(() => describeMidi(128)).toThrow(/128/)
    expect(() => describeMidi(-1)).toThrow()
  })
})
