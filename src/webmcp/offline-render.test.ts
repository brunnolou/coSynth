import { afterEach, describe, expect, it, vi } from 'vitest'
import { SynthEngine } from '../audio/engine'
import { performNotes, type NoteEngine } from '../history/performance'
import type { PerformanceNote } from '../history/types'
import type { ToWorklet } from '../shared/messages'
import { paramIndex, WAVETABLE_NAMES } from '../shared/params'
import { NUM_MIPS, type Wavetable } from '../shared/wavetable-gen'
import { encodeWav, offlineRenderAvailable, renderOffline, WORKLET_LOAD_FAILURE } from './offline-render'

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
  /** True once `startRendering()` has actually produced its buffer. */
  rendered = false
  /** True as soon as `startRendering()` is entered, buffer or not. */
  startedRendering = false
  /** Awaited just before the buffer is returned, so a test can stall a render. */
  hold: Promise<void> | null = null
  /** Called after each suspension callback (and its `resume`) has run. */
  afterResume: ((index: number) => void) | null = null
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
    this.startedRendering = true
    // Everything posted before rendering starts belongs to frame 0.
    const marks: { frame: number; upTo: number }[] = [{ frame: 0, upTo: this.messages.length }]
    const order = [...this.waiting].sort((a, b) => a.time - b.time)
    for (let index = 0; index < order.length; index++) {
      order[index].resolve()
      // Let the suspension callback (and its `resume`) run before the next one.
      await new Promise(resolve => setTimeout(resolve, 0))
      marks.push({ frame: Math.round(order[index].time * this.sampleRate), upTo: this.messages.length })
      this.afterResume?.(index)
    }
    if (this.hold) await this.hold
    const mono = this.synthesize(marks)
    this.rendered = true
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
        // The real processor answers `ping` from inside the same handler that
        // applies every other message, which is what makes the acknowledgement
        // proof the queue has drained. `SynthEngine.awaitWorkletSync` waits on
        // that reply, so a double that stayed silent would model a browser
        // whose worklet never answers rather than this one.
        if (message.type === 'ping') {
          message.port.postMessage(true)
          return
        }
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
function harness(configure?: (context: FakeOfflineContext) => void) {
  const messages = stubWorkletNode()
  const contexts: FakeOfflineContext[] = []
  const createContext = (options: { numberOfChannels: number; length: number; sampleRate: number }) => {
    const context = new FakeOfflineContext(options, messages)
    contexts.push(context)
    configure?.(context)
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
    expect(scratchEngines[0].everStarted, 'the scratch engine built its worklet graph').toBe(true)
    expect(scratchEngines[0].disposed, 'and released it once the render was done').toBe(true)
    expect(scratchEngines[0].started, 'so it holds no graph any more').toBe(false)
    expect(engine.started, 'the live engine was never started').toBe(false)
    expect(engine.heldNotes.size).toBe(0)
  })

  it('carries imported PCM assets into the scratch engine, not just the preset parameters', async () => {
    const { messages, createContext } = harness()
    const engine = liveEngineStub()
    // An imported Custom wavetable and an imported noise sample: neither is
    // part of a preset, so a preset round-trip would substitute a built-in
    // table and no sample at all.
    const table: Wavetable = {
      name: 'Imported',
      frameSize: 8,
      numFrames: 1,
      data: Float32Array.from([0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25])
    }
    const noise = { data: Float32Array.from([0.1, -0.2, 0.3, -0.4]), sampleRate: 32000 }
    engine.setParam(paramIndex('osc1.wavetable'), WAVETABLE_NAMES.indexOf('Custom') / (WAVETABLE_NAMES.length - 1))
    engine.restoreSoundState({
      ...engine.captureSoundState(),
      customTables: [table, null, null],
      noiseSample: noise
    })

    await renderOffline(engine, [{ midi: 60, velocity: 1, start: 0, duration: 0.1 }], 0.2, { createContext })

    const wavetables = messages.filter((message): message is Extract<ToWorklet, { type: 'wavetable' }> =>
      message.type === 'wavetable' && message.osc === 0)
    expect(wavetables.length).toBeGreaterThan(0)
    const posted = wavetables[wavetables.length - 1]
    expect(posted.frameSize, 'the imported table, not a built-in substitute').toBe(table.frameSize)
    expect(posted.numFrames).toBe(table.numFrames)
    expect(posted.mips).toHaveLength(table.numFrames * NUM_MIPS * table.frameSize)
    // Mip 0 is the untouched cycle, so the imported PCM is verifiable verbatim.
    expect(Array.from(posted.mips.subarray(0, table.frameSize))).toEqual(Array.from(table.data))

    const samples = messages.filter((message): message is Extract<ToWorklet, { type: 'sample' }> =>
      message.type === 'sample')
    expect(samples.length).toBeGreaterThan(0)
    const sample = samples[samples.length - 1]
    expect(sample.sampleRate, 'the imported sample reached the render worklet').toBe(noise.sampleRate)
    expect(Array.from(sample.data)).toEqual(Array.from(noise.data))
  })

  it('rejects with AbortError before doing any work when the signal is already aborted', async () => {
    const { contexts, createContext } = harness()
    const controller = new AbortController()
    controller.abort()
    await expect(renderOffline(liveEngineStub(), [{ midi: 60, velocity: 1, start: 0, duration: 0.1 }], 0.2, {
      createContext,
      signal: controller.signal
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(contexts, 'no render context is even created').toHaveLength(0)
  })

  it('bails when the abort lands during the scratch engine start, not after the render', async () => {
    const controller = new AbortController()
    // The render itself would succeed: only the abort inside `start()` can
    // stop it, so nothing here masks a missed cancellation.
    const { contexts, createContext, noteMessages } = harness()
    let releaseStart = () => {}
    const startBlocked = new Promise<void>(resolve => { releaseStart = resolve })
    const settled: string[] = []

    const pending = renderOffline(
      liveEngineStub(),
      [{ midi: 60, velocity: 1, start: 0, duration: 0.25 }, { midi: 64, velocity: 1, start: 0.5, duration: 0.25 }],
      1,
      {
        createContext,
        signal: controller.signal,
        // `start()` awaits the worklet module in the real engine; here it awaits
        // a promise the test controls, so the abort lands squarely inside it.
        createEngine: context => {
          const scratch = new SynthEngine({ context })
          const start = scratch.start.bind(scratch)
          scratch.start = async () => { await startBlocked; await start() }
          return scratch
        }
      }
    )
    pending.then(() => settled.push('resolved'), error => settled.push(`rejected:${(error as Error).name}`))

    // Abort while `start()` is still pending, then let it finish: the signal is
    // already aborted by the time the render would be set up, so a listener-only
    // abort path would never fire.
    controller.abort()
    releaseStart()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(settled, 'a cancelled render must never resolve with a recording').toEqual(['rejected:AbortError'])
    expect(noteMessages(), 'no note event was applied').toEqual([])
    expect(contexts[0].suspendTimes, 'no suspension was scheduled').toEqual([])
    expect(contexts[0].rendered, 'rendering never started').toBe(false)
  })

  it('stops scheduling and returns promptly when cancelled mid-render, without waiting for startRendering', async () => {
    const controller = new AbortController()
    // The render never completes: only the abort can settle the caller.
    const { contexts, createContext, noteMessages } = harness(context => {
      context.hold = new Promise<void>(() => {})
      context.afterResume = index => { if (index === 0) controller.abort() }
    })
    const pending = renderOffline(
      liveEngineStub(),
      [
        { midi: 60, velocity: 1, start: 0.25, duration: 0.1 },
        { midi: 64, velocity: 1, start: 0.5, duration: 0.1 }
      ],
      1,
      { createContext, signal: controller.signal }
    )
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(contexts[0].rendered, 'startRendering() is still in flight — it cannot be cancelled').toBe(false)

    // Let the orphaned render drive its remaining suspensions: they must be
    // no-ops now, so a cancelled render stops feeding the scratch engine.
    await new Promise(resolve => setTimeout(resolve, 10))
    // Only the first suspension's events made it; the abort landed right after.
    expect(noteMessages(), 'nothing was scheduled after the abort').toEqual(['on:60@1'])
    expect(contexts[0].resumes.length, 'later suspensions still resume so the render can be collected')
      .toBe(contexts[0].suspendTimes.length)
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

describe('renderOffline worklet barrier and silence guard', () => {
  /**
   * A worklet stub whose `ping` acknowledgements are held back, so a test can
   * decide whether — and when — the processor confirms it has the queue. This
   * models the real bug: `port.postMessage` reaches the audio thread
   * asynchronously while an `OfflineAudioContext` renders at CPU speed, so a
   * note-on posted just before `startRendering()` can arrive after the note is
   * already over.
   */
  function heldWorkletNode(options: { autoAck?: (index: number) => boolean } = {}) {
    const messages: ToWorklet[] = []
    const held: (() => void)[] = []
    let pings = 0
    vi.stubGlobal('AudioWorkletNode', class {
      port = {
        onmessage: null as unknown,
        postMessage: (message: ToWorklet, transfer: Transferable[]) => {
          if (message.type === 'ping') {
            const reply = () => message.port.postMessage(true)
            // `autoAck` decides per barrier, in the order they are posted (the
            // pre-render barrier is 0). Answering some and not others is how a
            // browser that does NOT flush the port queue while the context is
            // suspended behaves: the barrier before `startRendering()` comes
            // back, every mid-render one times out.
            if (options.autoAck?.(pings++)) reply()
            else held.push(reply)
            return
          }
          messages.push(structuredClone(message, { transfer }))
        }
      }
      connect() {}
    })
    return { messages, held, ack: () => { for (const reply of held.splice(0)) reply() } }
  }

  /** A context with `suspend()` that renders nothing at all. */
  class SilentOfflineContext extends FakeOfflineContext {
    override async startRendering() {
      const buffer = await super.startRendering()
      const silence = new Float32Array(this.length)
      return { ...buffer, getChannelData: () => silence } as unknown as AudioBuffer
    }
  }

  const NOTES: PerformanceNote[] = [{ midi: 60, velocity: 1, start: 0, duration: 0.1 }]

  /** Let the pending microtasks and zero-delay timers drain. */
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))

  afterEach(() => { vi.unstubAllGlobals() })

  it('does not start rendering until the worklet acknowledges the patch and note events', async () => {
    const { messages, held, ack } = heldWorkletNode()
    let context: FakeOfflineContext | null = null
    const pending = renderOffline(liveEngineStub(), NOTES, 0.3, {
      createContext: options => {
        context = new FakeOfflineContext(options, messages)
        return context as unknown as BaseAudioContext
      }
    })
    await settle()
    expect(held.length, 'a barrier was posted').toBe(1)
    expect(context!.startedRendering, 'rendering must wait behind the acknowledgement').toBe(false)
    expect(messages.some(message => message.type === 'noteOn'), 'the frame-0 note-on was posted first').toBe(true)
    ack()
    await pending
    expect(context!.rendered).toBe(true)
  })

  it('gives up on an unanswered barrier and renders anyway rather than hanging', async () => {
    const { messages } = heldWorkletNode()
    const recording = await renderOffline(liveEngineStub(), NOTES, 0.3, {
      createContext: options => new FakeOfflineContext(options, messages) as unknown as BaseAudioContext,
      syncTimeoutMs: 5
    })
    // The fake still synthesises from the posted messages, so this is a real
    // buffer: the barrier is an ordering guarantee, never a precondition.
    expect(recording.channelData[0].some(sample => sample !== 0)).toBe(true)
  })

  it('retries once, then throws, when an unconfirmed render comes back as digital silence', async () => {
    const { messages } = heldWorkletNode()
    const contexts: SilentOfflineContext[] = []
    await expect(renderOffline(liveEngineStub(), NOTES, 0.3, {
      createContext: options => {
        const context = new SilentOfflineContext(options, messages)
        contexts.push(context)
        return context as unknown as BaseAudioContext
      },
      syncTimeoutMs: 5
    })).rejects.toThrow(/digital silence twice/)
    expect(contexts.length, 'exactly one retry, on a fresh context').toBe(2)
  })

  it('returns silence the barrier confirmed, because a muted patch is a real answer', async () => {
    const messages = stubWorkletNode()
    const contexts: SilentOfflineContext[] = []
    const recording = await renderOffline(liveEngineStub(), NOTES, 0.3, {
      createContext: options => {
        const context = new SilentOfflineContext(options, messages)
        contexts.push(context)
        return context as unknown as BaseAudioContext
      }
    })
    expect(recording.channelData[0].every(sample => sample === 0)).toBe(true)
    expect(contexts.length, 'a confirmed result is never re-rendered').toBe(1)
  })

  it('does not treat a render with no notes as suspect, however unconfirmed', async () => {
    const { messages } = heldWorkletNode()
    const contexts: SilentOfflineContext[] = []
    const recording = await renderOffline(liveEngineStub(), [], 0.3, {
      createContext: options => {
        const context = new SilentOfflineContext(options, messages)
        contexts.push(context)
        return context as unknown as BaseAudioContext
      },
      syncTimeoutMs: 5
    })
    expect(recording.channelData[0].every(sample => sample === 0)).toBe(true)
    expect(contexts.length, 'nothing was asked to sound, so nothing is missing').toBe(1)
  })

  it('holds each mid-render suspension until its events are acknowledged, then resumes', async () => {
    const { messages, held, ack } = heldWorkletNode()
    let context: FakeOfflineContext | null = null
    const pending = renderOffline(liveEngineStub(), [{ midi: 60, velocity: 1, start: 0.25, duration: 0.1 }], 0.5, {
      createContext: options => {
        context = new FakeOfflineContext(options, messages)
        return context as unknown as BaseAudioContext
      }
    })
    await settle()
    // The pre-render barrier: rendering has not begun.
    expect(context!.startedRendering).toBe(false)
    ack()
    await settle()
    expect(context!.startedRendering, 'the acknowledgement let rendering start').toBe(true)
    // The first suspension applied its note-on and is now behind its own
    // barrier, so it has not resumed yet.
    expect(context!.resumes.length, 'a suspension does not resume ahead of its own events').toBe(0)
    ack()
    await settle()
    expect(context!.resumes.length).toBeGreaterThan(0)
    ack()
    await pending
    expect(context!.rendered).toBe(true)
  })

  it('holds a mid-render barrier on its own short budget, not the pre-render one', async () => {
    // The reviewer's portability worry, modelled: the pre-render barrier is
    // answered, every mid-render one is ignored forever. jsdom cannot measure a
    // real browser's render clock, but it can prove the *budget* a stalled
    // mid-render barrier is charged against, which is the part that would make
    // renders pathologically slow on a non-flushing engine.
    const { messages } = heldWorkletNode({ autoAck: index => index === 0 })
    let context: FakeOfflineContext | null = null
    const started = Date.now()
    const recording = await renderOffline(
      liveEngineStub(),
      [{ midi: 60, velocity: 1, start: 0.1, duration: 0.05 }, { midi: 64, velocity: 1, start: 0.2, duration: 0.05 }],
      0.4,
      {
        createContext: options => {
          context = new FakeOfflineContext(options, messages)
          return context as unknown as BaseAudioContext
        },
        // Deliberately generous, and deliberately not overriding the mid-render
        // budget: the point is that the four unanswered suspensions do NOT get
        // to spend this. It is far larger than any plausible jsdom overhead so
        // the two outcomes cannot be confused by a slow runner.
        syncTimeoutMs: 5000
      }
    )
    const elapsed = Date.now() - started
    expect(context!.suspendTimes.length, 'four scheduled events, four suspensions').toBe(4)
    // Four unanswered barriers on the 50 ms mid-render budget is ~200 ms of
    // deliberate waiting; the rest is whatever jsdom's timers cost that day,
    // which under the parallel suite ran to several hundred milliseconds and
    // made a 300 ms ceiling flap. The claim is about the BUDGET, so the two
    // outcomes are separated by an order of magnitude instead of by a margin:
    // one barrier charged to the pre-render budget would take 5 s here, and
    // four would take 20 s.
    expect(elapsed, `a stalled mid-render barrier must not cost the pre-render budget (took ${elapsed}ms)`)
      .toBeLessThan(1500)
    // Giving up is not skipping: the render finished and the events are in it.
    expect(context!.rendered).toBe(true)
    expect(messages.filter(message => message.type === 'noteOn').map(message => message.note)).toEqual([60, 64])
    expect(messages.filter(message => message.type === 'noteOff').map(message => message.note)).toEqual([60, 64])
    expect(recording.channelData[0].some(sample => sample !== 0), 'the render still sounds').toBe(true)
  })

  it('abandons an open pre-render barrier the moment the signal aborts, instead of waiting out its timeout', async () => {
    const { messages, held } = heldWorkletNode()
    const controller = new AbortController()
    let context: FakeOfflineContext | null = null
    const started = Date.now()
    const pending = renderOffline(liveEngineStub(), NOTES, 0.3, {
      createContext: options => {
        context = new FakeOfflineContext(options, messages)
        return context as unknown as BaseAudioContext
      },
      signal: controller.signal,
      // Long enough that waiting it out would be plainly visible: a
      // `stop_performance` must not sit behind it.
      syncTimeoutMs: 2000
    })
    await settle()
    expect(held.length, 'the pre-render barrier is open').toBe(1)
    expect(context!.startedRendering, 'and rendering is waiting behind it').toBe(false)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const elapsed = Date.now() - started
    expect(elapsed, `the cancel must not wait out the barrier (took ${elapsed}ms)`).toBeLessThan(500)
    expect(context!.startedRendering, 'and the render never began').toBe(false)
  })

  it('reports an unavailable barrier instead of waiting on an engine with no worklet', async () => {
    // No `start()` has run, so there is no node to ask and no guarantee to give.
    expect(await new SynthEngine().awaitWorkletSync(5)).toBe(false)
  })
})


/**
 * A render that cannot load the worklet module is the one failure whose cause
 * is neither the patch nor the request, and it used to surface as the raw
 * `Unable to load a worklet's module` paired with advice to retry in real time
 * — the one suggestion guaranteed not to help, since the real-time graph loads
 * the same module and additionally needs a user gesture.
 */
describe('renderOffline worklet module failures', () => {
  afterEach(() => vi.unstubAllGlobals())

  const notes: PerformanceNote[] = [{ midi: 60, velocity: 1, start: 0, duration: 0.1 }]

  it('reports a module that will not load in terms a caller can act on', async () => {
    const { createContext } = harness(context => {
      context.audioWorklet.addModule = vi.fn(async () => {
        throw new Error("Unable to load a worklet's module.")
      })
    })
    const error = await renderOffline(liveEngineStub(), notes, 0.2, { createContext })
      .then(() => null, (reason: Error) => reason)

    expect(error).toBeInstanceOf(Error)
    expect(error!.name).toBe(WORKLET_LOAD_FAILURE)
    const message = error!.message
    // It says the result is not a measurement of the patch...
    expect(message).toMatch(/never started/)
    expect(message).toMatch(/nothing here is a fact about the \s*patch or the notes/)
    // ...keeps the underlying cause for anyone who wants it...
    expect(message).toMatch(/Unable to load a worklet's module/)
    // ...and gives advice that can actually work, having ruled out the one
    // that cannot.
    expect(message).toMatch(/Reload the page/)
    expect(message).toMatch(/mode: "realtime" cannot help/)
  })

  it('does not retry a module failure as if it were the silence guard', async () => {
    const addModule = vi.fn(async () => { throw new Error("Unable to load a worklet's module.") })
    const { createContext } = harness(context => { context.audioWorklet.addModule = addModule })
    await expect(renderOffline(liveEngineStub(), notes, 0.2, { createContext })).rejects.toThrow()
    // The retry exists for a render that came back as unconfirmed silence. A
    // module that will not load will not load twice either, and the caller is
    // told so rather than being made to wait for a second identical failure.
    expect(addModule).toHaveBeenCalledOnce()
  })

  it('keeps a cancellation classified as a cancellation', async () => {
    const controller = new AbortController()
    const { createContext } = harness(context => {
      context.audioWorklet.addModule = vi.fn(async () => {
        controller.abort()
        const error = new Error('Execution aborted')
        error.name = 'AbortError'
        throw error
      })
    })
    // A cancel that lands inside `addModule` is a cancel, not a broken module:
    // `register.ts` classifies by name, so mislabelling it would report a
    // user-requested stop as an environment failure.
    await expect(renderOffline(liveEngineStub(), notes, 0.2, { createContext, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})

/**
 * An `OfflineAudioContext` is single-use and, in Chromium, has no `close()` at
 * all, so the scratch engine's graph is the only thing a render can actually
 * release. It must be released on every exit, including the abort path — an
 * abandoned render is precisely the case where the graph would otherwise be
 * left attached with nobody to drop it.
 */
describe('renderOffline scratch engine disposal', () => {
  afterEach(() => vi.unstubAllGlobals())

  const notes: PerformanceNote[] = [{ midi: 60, velocity: 1, start: 0, duration: 0.1 }]

  const withScratch = () => {
    const scratchEngines: SynthEngine[] = []
    const { createContext } = harness()
    const createEngine = (context: BaseAudioContext) => {
      const scratch = new SynthEngine({ context })
      scratchEngines.push(scratch)
      return scratch
    }
    return { scratchEngines, createContext, createEngine }
  }

  it('disposes the scratch engine after a successful render', async () => {
    const { scratchEngines, createContext, createEngine } = withScratch()
    await renderOffline(liveEngineStub(), notes, 0.2, { createContext, createEngine })
    expect(scratchEngines).toHaveLength(1)
    expect(scratchEngines[0].everStarted).toBe(true)
    expect(scratchEngines[0].disposed).toBe(true)
    expect(scratchEngines[0].started, 'the graph is gone, not merely finished with').toBe(false)
  })

  it('disposes the scratch engine when the render is cancelled', async () => {
    const controller = new AbortController()
    const { scratchEngines, createContext, createEngine } = withScratch()
    const pending = renderOffline(liveEngineStub(), notes, 0.2, {
      createContext, createEngine, signal: controller.signal
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(scratchEngines).toHaveLength(1)
    expect(scratchEngines[0].disposed, 'an abandoned render still releases its graph').toBe(true)
  })

  it('disposes the scratch engine when the module never loaded', async () => {
    const scratchEngines: SynthEngine[] = []
    const { createContext } = harness(context => {
      context.audioWorklet.addModule = vi.fn(async () => { throw new Error('nope') })
    })
    await expect(renderOffline(liveEngineStub(), notes, 0.2, {
      createContext,
      createEngine: context => {
        const scratch = new SynthEngine({ context })
        scratchEngines.push(scratch)
        return scratch
      }
    })).rejects.toThrow()
    expect(scratchEngines[0].disposed).toBe(true)
    expect(scratchEngines[0].everStarted, 'it never got a graph to begin with').toBe(false)
  })

  it('leaves a disposed engine inert rather than throwing on later posts', () => {
    const engine = new SynthEngine()
    // Never started: dispose must be safe on an engine with no graph, and
    // idempotent, because it runs from a `finally` that cannot know how far
    // the render got.
    expect(() => { engine.dispose(); engine.dispose() }).not.toThrow()
    expect(engine.disposed).toBe(true)
    expect(() => engine.noteOn(60, 1)).not.toThrow()
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
})
