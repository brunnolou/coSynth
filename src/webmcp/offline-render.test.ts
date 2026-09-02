import { afterEach, describe, expect, it, vi } from 'vitest'
import { SynthEngine } from '../audio/engine'
import { performNotes, type NoteEngine } from '../history/performance'
import type { PerformanceNote } from '../history/types'
import type { ToWorklet } from '../shared/messages'
import {
  BASE64_MAX_SECONDS, BASE64_SAMPLE_RATE, encodeWav, monoWavBase64, offlineRenderAvailable, renderOffline
} from './offline-render'

const SAMPLE_RATE = 48000
/** The fake's envelope tail, so a note that ends still leaves an audible edge. */
const RELEASE_SECONDS = 0.01

/**
 * Stands in for `OfflineAudioContext`: jsdom has no Web Audio at all. It drives
 * the suspend callbacks in timeline order when rendering starts, which is what
 * a real offline context does, and — crucially — it *synthesises* the buffer
 * from the note messages the scratch engine posted, stamped with the frame they
 * arrived at. A lost, duplicated or misordered event therefore shows up in the
 * returned samples and not only in the message log.
 */
class FakeOfflineContext {
  readonly sampleRate: number
  readonly length: number
  readonly numberOfChannels: number
  readonly destination = {}
  readonly audioWorklet = { addModule: vi.fn(async () => undefined) }
  readonly suspendTimes: number[] = []
  readonly resumes: number[] = []
  private readonly waiting: { time: number; resolve: () => void }[] = []

  constructor(
    options: { numberOfChannels: number; length: number; sampleRate: number },
    /** The worklet message log shared with `stubWorkletNode`. */
    private readonly messages: ToWorklet[] = []
  ) {
    this.numberOfChannels = options.numberOfChannels
    this.length = options.length
    this.sampleRate = options.sampleRate
  }

  suspend(time: number): Promise<void> {
    this.suspendTimes.push(time)
    return new Promise<void>(resolve => this.waiting.push({ time, resolve }))
  }

  resume(): Promise<void> {
    this.resumes.push(this.resumes.length)
    return Promise.resolve()
  }

  async startRendering() {
    // Everything posted before rendering starts belongs to frame 0.
    const marks: { frame: number; upTo: number }[] = [{ frame: 0, upTo: this.messages.length }]
    for (const entry of [...this.waiting].sort((a, b) => a.time - b.time)) {
      entry.resolve()
      // Let the suspension callback (and its `resume`) run before the next one.
      await new Promise(resolve => setTimeout(resolve, 0))
      marks.push({ frame: Math.round(entry.time * this.sampleRate), upTo: this.messages.length })
    }
    const mono = this.synthesize(marks)
    const channels = Array.from({ length: this.numberOfChannels }, (_, channel) =>
      channel === 0 ? mono : mono.map(sample => sample * 0.5))
    return {
      length: this.length,
      sampleRate: this.sampleRate,
      numberOfChannels: this.numberOfChannels,
      duration: this.length / this.sampleRate,
      getChannelData: (channel: number) => channels[channel]
    } as unknown as AudioBuffer
  }

  /** One decaying sine per note-on, released by the matching note-off. */
  private synthesize(marks: readonly { frame: number; upTo: number }[]): Float32Array {
    const voices: { start: number; end: number | null; midi: number; velocity: number }[] = []
    let cursor = 0
    for (const mark of marks) {
      for (; cursor < mark.upTo; cursor++) {
        const message = this.messages[cursor]
        if (message.type === 'noteOn') {
          voices.push({ start: mark.frame, end: null, midi: message.note, velocity: message.velocity })
        } else if (message.type === 'noteOff') {
          // Release the newest still-sounding voice for that pitch, as a synth does.
          const voice = [...voices].reverse().find(item => item.midi === message.note && item.end === null)
          if (voice) voice.end = mark.frame
        }
      }
    }
    const release = Math.max(1, Math.round(RELEASE_SECONDS * this.sampleRate))
    const data = new Float32Array(this.length)
    for (const voice of voices) {
      const end = voice.end ?? this.length
      const last = Math.min(this.length, end + release)
      const frequency = 440 * 2 ** ((voice.midi - 69) / 12)
      for (let frame = voice.start; frame < last; frame++) {
        const fade = frame < end ? 1 : 1 - (frame - end) / release
        data[frame] += voice.velocity * fade * Math.sin((2 * Math.PI * frequency * frame) / this.sampleRate)
      }
    }
    return data
  }
}

/** An `OfflineAudioContext` without `suspend()` — Safari has shipped one. */
class LegacyOfflineContext {
  readonly length: number
  readonly sampleRate: number
  readonly numberOfChannels: number
  readonly destination = {}
  readonly audioWorklet = { addModule: vi.fn(async () => undefined) }

  constructor(options: { numberOfChannels: number; length: number; sampleRate: number }) {
    this.numberOfChannels = options.numberOfChannels
    this.length = options.length
    this.sampleRate = options.sampleRate
  }

  async startRendering() {
    const silence = new Float32Array(this.length)
    return {
      length: this.length,
      sampleRate: this.sampleRate,
      numberOfChannels: this.numberOfChannels,
      duration: this.length / this.sampleRate,
      getChannelData: () => silence
    } as unknown as AudioBuffer
  }
}

/** Collects everything a scratch engine posts to the worklet, in order. */
function stubWorkletNode(): ToWorklet[] {
  const messages: ToWorklet[] = []
  vi.stubGlobal('AudioWorkletNode', class {
    port = {
      onmessage: null as unknown,
      postMessage: (message: ToWorklet, transfer: Transferable[]) => {
        messages.push(structuredClone(message, { transfer }))
      }
    }
    connect() {}
  })
  return messages
}

function liveEngineStub(sampleRate = SAMPLE_RATE) {
  const engine = new SynthEngine()
  ;(engine as unknown as { ctx: { sampleRate: number } }).ctx = { sampleRate }
  return engine
}

/** A stubbed worklet plus contexts wired to it, so renders produce real samples. */
function harness() {
  const messages = stubWorkletNode()
  const contexts: FakeOfflineContext[] = []
  const createContext = (options: { numberOfChannels: number; length: number; sampleRate: number }) => {
    const context = new FakeOfflineContext(options, messages)
    contexts.push(context)
    return context as unknown as BaseAudioContext
  }
  const noteMessages = () => messages
    .filter(message => message.type === 'noteOn' || message.type === 'noteOff')
    .map(message => message.type === 'noteOn'
      ? `on:${message.note}@${message.velocity}`
      : `off:${message.note}`)
  return { messages, contexts, createContext, noteMessages }
}

/** RMS of `[from, to)` seconds of the rendered left channel. */
function rms(channel: Float32Array, sampleRate: number, from: number, to: number): number {
  const start = Math.max(0, Math.floor(from * sampleRate))
  const end = Math.min(channel.length, Math.ceil(to * sampleRate))
  let sum = 0
  for (let frame = start; frame < end; frame++) sum += channel[frame] * channel[frame]
  return end > start ? Math.sqrt(sum / (end - start)) : 0
}

/** The note calls `performNotes` makes for the same sequence, in order. */
async function realtimeNoteCalls(notes: readonly PerformanceNote[]): Promise<string[]> {
  const calls: string[] = []
  const engine: NoteEngine = {
    heldNotes: new Set<number>(),
    noteOn: (midi, velocity) => { calls.push(`on:${midi}@${velocity}`) },
    noteOff: midi => { calls.push(`off:${midi}`) }
  }
  vi.useFakeTimers()
  try {
    const span = Math.max(...notes.map(note => note.start + note.duration))
    const done = performNotes(engine, notes, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(span * 1000 + 10)
    await done
  } finally {
    vi.useRealTimers()
  }
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('offline availability', () => {
  it('is false without Web Audio, and true once the offline constructors exist', () => {
    expect(offlineRenderAvailable()).toBe(false)
    vi.stubGlobal('OfflineAudioContext', FakeOfflineContext)
    expect(offlineRenderAvailable(), 'a context without AudioWorkletNode cannot host the processor').toBe(false)
    stubWorkletNode()
    const BaseStub = function BaseAudioContextStub() {}
    ;(BaseStub.prototype as Record<string, unknown>).audioWorklet = {}
    vi.stubGlobal('BaseAudioContext', BaseStub)
    expect(offlineRenderAvailable()).toBe(true)
  })

  it('is false when the offline context cannot suspend, because events cannot be placed in time', () => {
    stubWorkletNode()
    const BaseStub = function BaseAudioContextStub() {}
    ;(BaseStub.prototype as Record<string, unknown>).audioWorklet = {}
    vi.stubGlobal('BaseAudioContext', BaseStub)
    vi.stubGlobal('OfflineAudioContext', LegacyOfflineContext)
    expect(offlineRenderAvailable(), 'no suspend() means every event lands at t=0').toBe(false)
    vi.stubGlobal('OfflineAudioContext', FakeOfflineContext)
    expect(offlineRenderAvailable()).toBe(true)
  })
})

describe('renderOffline', () => {
  it('renders a scratch engine on a single-use offline context and returns WAV plus PCM', async () => {
    const { contexts, createContext, noteMessages } = harness()
    const engine = liveEngineStub()
    const recording = await renderOffline(
      engine,
      [{ midi: 60, velocity: 0.8, start: 0, duration: 0.5 }],
      1,
      { createContext }
    )

    expect(contexts).toHaveLength(1)
    expect(contexts[0].length).toBe(SAMPLE_RATE)
    expect(contexts[0].numberOfChannels).toBe(2)
    expect(contexts[0].audioWorklet.addModule).toHaveBeenCalledTimes(1)

    expect(recording.mimeType).toBe('audio/wav')
    expect(recording.blob.type).toBe('audio/wav')
    expect(recording.sampleRate).toBe(SAMPLE_RATE)
    expect(recording.duration).toBeCloseTo(1, 6)
    expect(recording.channelData).toHaveLength(2)
    expect(recording.channelData[0]).toHaveLength(SAMPLE_RATE)
    // 44-byte header + interleaved 16-bit stereo frames.
    expect(recording.blob.size).toBe(44 + SAMPLE_RATE * 2 * 2)

    // The note landed on the worklet, note-off after note-on and after the patch.
    expect(noteMessages()).toEqual(['on:60@0.8', 'off:60'])
    // The note-off is scheduled, the note-on happens before rendering starts.
    expect(contexts[0].suspendTimes).toEqual([Math.floor((0.5 * SAMPLE_RATE) / 128) * 128 / SAMPLE_RATE])
    expect(contexts[0].suspendTimes[0]).toBeCloseTo(0.5, 2)
    expect(contexts[0].resumes).toHaveLength(1)
    // Sound while the note is held, silence once its release has run out.
    expect(rms(recording.channelData[0], SAMPLE_RATE, 0, 0.5)).toBeGreaterThan(0.5)
    expect(rms(recording.channelData[0], SAMPLE_RATE, 0.6, 1)).toBeCloseTo(0, 6)
  })

  it('quantizes event times to render quanta and merges events sharing a quantum', async () => {
    const { contexts, createContext } = harness()
    await renderOffline(
      liveEngineStub(),
      [
        { midi: 60, velocity: 1, start: 0.25, duration: 0.25 },
        { midi: 64, velocity: 1, start: 0.2500005, duration: 0.25 }
      ],
      1,
      { createContext }
    )
    const quantum = 128 / SAMPLE_RATE
    for (const time of contexts[0].suspendTimes) {
      expect(Math.round(time / quantum)).toBeCloseTo(time / quantum, 9)
    }
    expect(new Set(contexts[0].suspendTimes).size, 'one suspension per quantum').toBe(contexts[0].suspendTimes.length)
    expect(contexts[0].suspendTimes).toHaveLength(2)
  })

  it('retriggers an overlapping repeat of one pitch exactly as performNotes does', async () => {
    const { createContext, noteMessages } = harness()
    const notes: PerformanceNote[] = [
      { midi: 60, velocity: 1, start: 0, duration: 1 },
      { midi: 60, velocity: 1, start: 0.5, duration: 1 }
    ]
    const recording = await renderOffline(liveEngineStub(), notes, 2, { createContext })

    // Release then restrike at 0.5 s; only the last instance's end releases the note.
    expect(noteMessages()).toEqual(['on:60@1', 'off:60', 'on:60@1', 'off:60'])
    expect(noteMessages(), 'offline must agree with the realtime path').toEqual(await realtimeNoteCalls(notes))

    const left = recording.channelData[0]
    // The restrike is audible and the note runs to 1.5 s, not to 1.0 s.
    expect(rms(left, SAMPLE_RATE, 0.6, 1.4), 'the second instance still sounds past 1.0 s').toBeGreaterThan(0.5)
    expect(rms(left, SAMPLE_RATE, 1.55, 2), 'and stops after the last note-off').toBeCloseTo(0, 6)
  })

  it('turns off a note shorter than one render quantum instead of holding it forever', async () => {
    const { createContext, noteMessages } = harness()
    const recording = await renderOffline(
      liveEngineStub(),
      [{ midi: 60, velocity: 1, start: 0, duration: 0.002 }],
      2,
      { createContext }
    )
    // Both events quantize to frame 0: within one note, the on still comes first.
    expect(noteMessages()).toEqual(['on:60@1', 'off:60'])
    const left = recording.channelData[0]
    expect(rms(left, SAMPLE_RATE, 0, 0.005), 'a blip').toBeGreaterThan(0.1)
    expect(rms(left, SAMPLE_RATE, 0.1, 2), 'not two seconds of sustain').toBeCloseTo(0, 6)
  })

  it('releases an earlier note before striking a new one that shares its quantum', async () => {
    const { createContext, noteMessages } = harness()
    await renderOffline(
      liveEngineStub(),
      [
        { midi: 60, velocity: 1, start: 0, duration: 0.5 },
        { midi: 64, velocity: 1, start: 0.5, duration: 0.5 }
      ],
      1,
      { createContext }
    )
    expect(noteMessages()).toEqual(['on:60@1', 'off:60', 'on:64@1', 'off:64'])
  })

  it('refuses to render on a context that cannot suspend rather than returning silence', async () => {
    stubWorkletNode()
    await expect(renderOffline(liveEngineStub(), [{ midi: 60, velocity: 1, start: 0.25, duration: 0.25 }], 1, {
      createContext: options => new LegacyOfflineContext(options) as unknown as BaseAudioContext
    })).rejects.toThrow(/suspend/i)
  })

  it('loads the live engine patch into the scratch engine and never touches the live graph', async () => {
    const { createContext } = harness()
    const engine = liveEngineStub()
    const scratchEngines: SynthEngine[] = []
    await renderOffline(engine, [{ midi: 60, velocity: 1, start: 0, duration: 0.1 }], 0.2, {
      createContext,
      createEngine: context => {
        const scratch = new SynthEngine({ context })
        scratchEngines.push(scratch)
        return scratch
      }
    })
    expect(scratchEngines).toHaveLength(1)
    expect(scratchEngines[0].offline).toBe(true)
    expect(scratchEngines[0].running, 'an offline engine never "runs"').toBe(false)
    expect(scratchEngines[0].started).toBe(true)
    expect(engine.started, 'the live engine was never started').toBe(false)
    expect(engine.heldNotes.size).toBe(0)
  })

  it('uses the default sample rate when no context exists yet, and rejects a zero duration', async () => {
    const { contexts, createContext } = harness()
    const recording = await renderOffline(new SynthEngine(), [{ midi: 60, velocity: 1, start: 0, duration: 0.1 }], 0.2, {
      createContext
    })
    expect(contexts[0].sampleRate).toBe(48000)
    expect(recording.sampleRate).toBe(48000)
    await expect(renderOffline(new SynthEngine(), [], 0)).rejects.toThrow(/greater than zero/i)
  })
})

describe('WAV encoding', () => {
  it('writes a 16-bit PCM header that matches the payload', () => {
    const wav = new DataView(encodeWav([Float32Array.from([0, 1, -1, 0.5])], 8000))
    const text = (offset: number) => String.fromCharCode(
      wav.getUint8(offset), wav.getUint8(offset + 1), wav.getUint8(offset + 2), wav.getUint8(offset + 3))
    expect(text(0)).toBe('RIFF')
    expect(text(8)).toBe('WAVE')
    expect(text(36)).toBe('data')
    expect(wav.getUint16(22, true)).toBe(1)
    expect(wav.getUint32(24, true)).toBe(8000)
    expect(wav.getUint16(34, true)).toBe(16)
    expect(wav.getUint32(40, true)).toBe(8)
    expect(wav.getInt16(44 + 2, true)).toBe(32767)
    expect(wav.getInt16(44 + 4, true)).toBe(-32767)
  })

  it('downmixes to mono 22.05 kHz base64 and caps the payload at eight seconds', () => {
    const frames = 10 * SAMPLE_RATE
    const left = Float32Array.from({ length: frames }, (_, index) => Math.sin(index / 50))
    const encoded = monoWavBase64([left, left.slice()], SAMPLE_RATE)
    expect(encoded.mimeType).toBe('audio/wav')
    expect(encoded.channels).toBe(1)
    expect(encoded.sampleRate).toBe(BASE64_SAMPLE_RATE)
    expect(encoded.duration).toBeCloseTo(BASE64_MAX_SECONDS, 2)
    expect(encoded.truncated).toBe(true)
    expect(encoded.bytes).toBe(44 + Math.floor(BASE64_MAX_SECONDS * BASE64_SAMPLE_RATE) * 2)
    expect(encoded.base64).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(atob(encoded.base64).slice(0, 4)).toBe('RIFF')

    const short = monoWavBase64([left.subarray(0, SAMPLE_RATE)], SAMPLE_RATE)
    expect(short.truncated).toBe(false)
    expect(short.duration).toBeCloseTo(1, 2)
  })

  it('attenuates content above the preview Nyquist instead of folding it back', () => {
    const tone = (hertz: number) => Float32Array.from(
      { length: SAMPLE_RATE }, (_, index) => Math.sin((2 * Math.PI * hertz * index) / SAMPLE_RATE))
    const level = (samples: Float32Array) => {
      let sum = 0
      for (const sample of samples) sum += sample * sample
      return Math.sqrt(sum / Math.max(1, samples.length))
    }
    const decoded = (source: Float32Array) => {
      const bytes = atob(monoWavBase64([source], SAMPLE_RATE).base64)
      const view = new DataView(Uint8Array.from(bytes, character => character.charCodeAt(0)).buffer)
      const frames = (view.byteLength - 44) / 2
      return Float32Array.from({ length: frames }, (_, index) => view.getInt16(44 + index * 2, true) / 32767)
    }
    // 20 kHz has no home below 11.025 kHz: it must be attenuated, not aliased down.
    expect(level(decoded(tone(20000)))).toBeLessThan(0.4 * level(tone(20000)))
    // A tone well inside the preview band survives.
    expect(level(decoded(tone(1000)))).toBeGreaterThan(0.6 * level(tone(1000)))
  })
})
