import type { PerformanceNote, PerformanceService, PlaybackOrigin } from './types'

export function performanceAbortError(): Error {
  const error = new Error('Execution aborted')
  error.name = 'AbortError'
  return error
}

/** One owner for UI replay, AI playback, and live recording. */
export class PerformanceManager implements PerformanceService {
  private operation: { controller: AbortController; done: Promise<unknown> } | null = null
  private readonly listeners = new Set<() => void>()
  private playingCount = 0
  private aiPlayingCount = 0

  get active(): boolean { return this.operation !== null }
  get playing(): boolean { return this.playingCount > 0 }
  get aiPlaying(): boolean { return this.aiPlayingCount > 0 }
  async trackPlayback<T>(task: () => Promise<T>, origin: PlaybackOrigin = 'human'): Promise<T> {
    this.playingCount++
    if (origin === 'ai') this.aiPlayingCount++
    this.emit()
    try { return await task() }
    finally {
      this.playingCount--
      if (origin === 'ai') this.aiPlayingCount--
      this.emit()
    }
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private emit(): void { for (const listener of this.listeners) listener() }

  async run<T>(task: (signal: AbortSignal) => Promise<T>, externalSignal?: AbortSignal): Promise<T> {
    if (this.operation) throw new Error('A performance is already in progress')
    if (externalSignal?.aborted) throw performanceAbortError()
    const controller = new AbortController()
    const abort = () => controller.abort()
    externalSignal?.addEventListener('abort', abort, { once: true })
    const operation = {
      controller,
      done: Promise.resolve().then(() => {
        if (controller.signal.aborted) throw performanceAbortError()
        return task(controller.signal)
      })
    }
    this.operation = operation
    this.emit()
    try {
      return await operation.done
    } finally {
      externalSignal?.removeEventListener('abort', abort)
      if (this.operation === operation) this.operation = null
      this.emit()
    }
  }

  async stop(): Promise<void> {
    const operation = this.operation
    if (!operation) return
    operation.controller.abort()
    // The task owns cleanup. Restoration must not race its final note-offs.
    await operation.done.catch(() => undefined)
  }
}

export interface NoteEngine {
  readonly heldNotes: ReadonlySet<number>
  noteOn(midi: number, velocity: number, owner: symbol): void
  noteOff(midi: number, owner: symbol): void
}

export function assertNotesAvailable(engine: NoteEngine, notes: readonly PerformanceNote[]): void {
  const held = notes.find(note => engine.heldNotes.has(note.midi))
  if (held) throw new Error(`MIDI note ${held.midi} is already held by another input`)
}

function wait(seconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(performanceAbortError())
  if (seconds <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, seconds * 1000)
    signal.addEventListener('abort', aborted, { once: true })
    function cleanup() { clearTimeout(timer); signal.removeEventListener('abort', aborted) }
    function done() { cleanup(); resolve() }
    function aborted() { cleanup(); reject(performanceAbortError()) }
  })
}

export async function performNotes(engine: NoteEngine, notes: readonly PerformanceNote[], signal: AbortSignal): Promise<void> {
  assertNotesAvailable(engine, notes)
  const owner = Symbol('performance')
  const events = notes.flatMap(note => [
    { time: note.start, on: true, note },
    { time: note.start + note.duration, on: false, note }
  ]).sort((a, b) => a.time - b.time || Number(a.on) - Number(b.on))
  // Active instances per pitch. A repeated pitch retriggers the voice the way MIDI does:
  // release then restrike, and only the last instance's end releases the note.
  const active = new Map<number, number>()
  let elapsed = 0
  try {
    for (const event of events) {
      await wait(event.time - elapsed, signal)
      if (signal.aborted) throw performanceAbortError()
      const midi = event.note.midi
      const count = active.get(midi) ?? 0
      if (event.on) {
        if (count > 0) engine.noteOff(midi, owner)
        engine.noteOn(midi, event.note.velocity, owner)
        active.set(midi, count + 1)
      } else if (count > 0) {
        if (count === 1) {
          active.delete(midi)
          engine.noteOff(midi, owner)
        } else {
          active.set(midi, count - 1)
        }
      }
      elapsed = event.time
    }
  } finally {
    for (const midi of active.keys()) engine.noteOff(midi, owner)
    active.clear()
  }
}

const NOTE_KEYS = ['midi', 'velocity', 'start', 'duration']
const NOTE_SHAPE = `Each note is {${NOTE_KEYS.join(', ')}}`

export function validatePerformanceNotes(value: unknown, maxSeconds = 30): { notes: PerformanceNote[]; duration: number; overlaps: number } {
  if (!Array.isArray(value) || value.length === 0) throw new Error('notes must be a non-empty array')
  if (value.length > 128) throw new Error('notes is limited to 128 entries')
  const notes = value.map((item, index) => {
    const label = `notes[${index}]`
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${label} must be an object`)
    for (const key of Object.keys(item)) {
      if (!NOTE_KEYS.includes(key)) throw new Error(`${label}: unexpected property '${key}'. ${NOTE_SHAPE}`)
    }
    const numeric = (key: string): number => {
      if (!(key in item)) throw new Error(`${label}.${key} is required`)
      if (typeof item[key] !== 'number' || !Number.isFinite(item[key])) throw new Error(`${label}.${key} must be a finite number`)
      return item[key]
    }
    const midi = numeric('midi'), velocity = numeric('velocity'), start = numeric('start'), duration = numeric('duration')
    if (!Number.isInteger(midi) || midi < 0 || midi > 127) throw new Error(`${label}.midi must be an integer in range 0..127`)
    if (velocity < 0 || velocity > 1) throw new Error(`${label}.velocity must be in range 0..1`)
    if (start < 0) throw new Error(`${label}.start must be >= 0`)
    if (duration <= 0) throw new Error(`${label}.duration must be > 0`)
    return { midi, velocity, start, duration }
  })
  const duration = Math.round(Math.max(...notes.map(note => note.start + note.duration)) * 1e8) / 1e8
  if (duration > maxSeconds) throw new Error(`Note sequence is limited to ${maxSeconds} seconds`)
  // Overlapping instances of one pitch retrigger the voice (see performNotes); they are counted, not rejected.
  const lastEnd = new Map<number, number>()
  let overlaps = 0
  for (const note of [...notes].sort((a, b) => a.start - b.start)) {
    const previous = lastEnd.get(note.midi)
    if (previous !== undefined && note.start < previous) overlaps++
    lastEnd.set(note.midi, Math.max(previous ?? 0, note.start + note.duration))
  }
  return { notes, duration, overlaps }
}
