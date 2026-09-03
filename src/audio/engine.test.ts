import { afterEach, describe, expect, it, vi } from 'vitest'
import { RECENT_AUDIO_SECONDS, SynthEngine } from './engine'
import { paramIndex } from '../shared/params'
import type { ToWorklet } from '../shared/messages'

/**
 * The fake stands in for an OfflineAudioContext: it owns `startRendering` and
 * `resume` (a real offline context has both) but no MediaStream plumbing, so it
 * also proves the live/offline split cannot rely on `resume` alone.
 */
function fakeOfflineContext() {
  return {
    sampleRate: 48000,
    length: 48000,
    destination: {},
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    resume: vi.fn(async () => undefined),
    suspend: vi.fn(async () => undefined),
    startRendering: vi.fn(async () => ({}))
  }
}

function fakeLiveContext() {
  return {
    sampleRate: 48000,
    destination: {},
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    resume: vi.fn(async () => undefined),
    createMediaStreamDestination: vi.fn(() => ({ stream: { getTracks: () => [] } })),
    decodeAudioData: vi.fn()
  }
}

/** Collects everything the engine posts to the worklet, in order. */
function stubWorkletNode(): { messages: ToWorklet[]; ports: { onmessage: unknown }[] } {
  const messages: ToWorklet[] = []
  const ports: { onmessage: unknown }[] = []
  vi.stubGlobal('AudioWorkletNode', class {
    port = {
      onmessage: null as unknown,
      postMessage: (message: ToWorklet, transfer: Transferable[]) => {
        messages.push(structuredClone(message, { transfer }))
      }
    }
    constructor() { ports.push(this.port) }
    connect() {}
  })
  return { messages, ports }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SynthEngine context injection', () => {
  it('starts on an injected offline context without a live AudioContext, resume, or a media-stream tap', async () => {
    stubWorkletNode()
    const AudioContextCtor = vi.fn()
    vi.stubGlobal('AudioContext', AudioContextCtor)
    const context = fakeOfflineContext()

    const engine = new SynthEngine({ context: context as unknown as BaseAudioContext })
    expect(engine.offline).toBe(true)
    expect(engine.context).toBe(context)

    await engine.start()

    expect(AudioContextCtor).not.toHaveBeenCalled()
    expect(context.audioWorklet.addModule).toHaveBeenCalledTimes(1)
    expect(context.resume).not.toHaveBeenCalled()
    expect(context.startRendering).not.toHaveBeenCalled()
    expect(engine.ctx).toBe(context)
    await expect(engine.recordOutput(0.1)).rejects.toThrow(/live audio context/i)
    expect(context).not.toHaveProperty('createMediaStreamDestination')
  })

  it('keeps the live path on the default factory: interactive latency hint, resume, and scope messaging', async () => {
    const { ports } = stubWorkletNode()
    const live = fakeLiveContext()
    const options: AudioContextOptions[] = []
    vi.stubGlobal('AudioContext', class {
      constructor(opts: AudioContextOptions) {
        options.push(opts)
        return live as unknown as AudioContext
      }
    })

    const engine = new SynthEngine()
    expect(engine.offline).toBe(false)
    await engine.start()

    expect(options).toEqual([{ latencyHint: 'interactive' }])
    expect(live.resume).toHaveBeenCalledTimes(1)
    expect(engine.running).toBe(true)
    expect(typeof ports[0].onmessage).toBe('function')
  })

  it('uses an injected createContext factory for the live path', async () => {
    stubWorkletNode()
    const live = fakeLiveContext()
    const createContext = vi.fn(() => live as unknown as BaseAudioContext)

    const engine = new SynthEngine({ createContext })
    await engine.start()

    expect(createContext).toHaveBeenCalledTimes(1)
    expect(engine.offline).toBe(false)
    expect(engine.running).toBe(true)
    expect(live.resume).toHaveBeenCalledTimes(1)
  })

  it('leaves `running` false offline while still exposing a started graph', async () => {
    stubWorkletNode()
    const engine = new SynthEngine({ context: fakeOfflineContext() as unknown as BaseAudioContext })

    expect(engine.running).toBe(false)
    expect(engine.started).toBe(false)
    await engine.start()

    expect(engine.running).toBe(false)
    expect(engine.started).toBe(true)
  })

  it('does not subscribe to scope/status messages on an offline context', async () => {
    const { ports } = stubWorkletNode()
    const engine = new SynthEngine({ context: fakeOfflineContext() as unknown as BaseAudioContext })

    await engine.start()

    expect(ports).toHaveLength(1)
    expect(ports[0].onmessage).toBe(null)
  })

  it('posts identical worklet traffic for loadPreset, setParam and setModSlot in both modes', async () => {
    const script = (engine: SynthEngine) => {
      engine.loadPreset({ name: 'p', params: { 'osc1.level': 0.75 }, mods: [], lfoShapes: [], fxOrder: [] })
      engine.setParam(paramIndex('filter1.cutoff'), 0.42)
      engine.setModSlot(0, { source: 0, dest: paramIndex('osc1.level'), depth: 0.5, enabled: true })
    }

    const offline = stubWorkletNode()
    const offlineEngine = new SynthEngine({ context: fakeOfflineContext() as unknown as BaseAudioContext })
    await offlineEngine.start()
    offline.messages.length = 0
    script(offlineEngine)
    vi.unstubAllGlobals()

    const liveMessages = stubWorkletNode().messages
    vi.stubGlobal('AudioContext', class {
      constructor() { return fakeLiveContext() as unknown as AudioContext }
    })
    const liveEngine = new SynthEngine()
    await liveEngine.start()
    liveMessages.length = 0
    script(liveEngine)

    expect(offline.messages).toEqual(liveMessages)
    expect(offline.messages.length).toBeGreaterThan(0)
    // Two full engines, and `start()` plus `loadPreset` builds every oscillator's
    // wavetable and its mip pyramid on each of them, twice over — then
    // `structuredClone` copies those buffers into the message log. It is a
    // couple of seconds of pure CPU on an idle machine and comfortably past the
    // 5 s default on a busy one, which is why it fails under a parallel run and
    // passes on its own. Nothing here is asynchronous or waiting on a timer, so
    // a generous ceiling costs nothing and removes a flake that is really just
    // an under-provisioned budget.
  }, 30000)
})

describe('SynthEngine rolling capture', () => {
  const SCOPE_SIZE = 1024
  const SAMPLE_RATE = 48000
  const CAPACITY = RECENT_AUDIO_SECONDS * SAMPLE_RATE

  /** A live engine with its worklet port in hand, ready to be fed scope frames. */
  async function liveEngine() {
    const { ports } = stubWorkletNode()
    vi.stubGlobal('AudioContext', class {
      constructor() { return fakeLiveContext() as unknown as AudioContext }
    })
    const engine = new SynthEngine()
    await engine.start()
    // Every sample carries its own index, so a gap or a reordering in the ring
    // shows up as an arithmetic error rather than as a plausible waveform.
    let written = 0
    const post = (frames = 1) => {
      for (let frame = 0; frame < frames; frame++) {
        const left = Float32Array.from({ length: SCOPE_SIZE }, (_, index) => written + index)
        const right = Float32Array.from({ length: SCOPE_SIZE }, (_, index) => -(written + index))
        written += SCOPE_SIZE
        ;(ports[0].onmessage as (event: { data: unknown }) => void)({ data: { type: 'scope', left, right } })
      }
    }
    return { engine, post, total: () => written }
  }

  it('holds nothing until the graph has produced output', async () => {
    const { engine } = await liveEngine()
    expect(engine.recentAudio()).toBeNull()
  })

  it('keeps the live output gapless, oldest sample first, from the very frames the meters read', async () => {
    const { engine, post, total } = await liveEngine()
    post(10)

    const recent = engine.recentAudio()!
    expect(recent.sampleRate).toBe(SAMPLE_RATE)
    expect(recent.channelData[0]).toHaveLength(total())
    expect(recent.duration).toBeCloseTo(total() / SAMPLE_RATE, 6)
    expect(recent.full).toBe(false)
    // The worklet posts one contiguous 1024-sample frame per 1024 rendered
    // samples, so the ring is a recording rather than a series of snapshots:
    // sample k is exactly k, across every frame boundary.
    for (let index = 0; index < total(); index += 337) {
      expect(recent.channelData[0][index]).toBe(index)
      expect(recent.channelData[1][index]).toBe(-index)
    }
    // The scope itself still holds only the newest frame — the 21 ms that made
    // `analyze_audio({source:"scope"})` report silence for a note just played.
    expect(engine.scopeL).toHaveLength(SCOPE_SIZE)
    expect(engine.scopeL[0]).toBe(total() - SCOPE_SIZE)
  })

  it('returns the newest window when asked for less than it holds', async () => {
    const { engine, post, total } = await liveEngine()
    post(20)

    const window = engine.recentAudio(0.1)!
    const frames = Math.round(0.1 * SAMPLE_RATE)
    expect(window.channelData[0]).toHaveLength(frames)
    expect(window.channelData[0][0]).toBe(total() - frames)
    expect(window.channelData[0].at(-1)).toBe(total() - 1)
    expect(window.heldSeconds).toBeCloseTo(total() / SAMPLE_RATE, 6)
  })

  it('wraps without a seam and then holds exactly the buffer length', async () => {
    const { engine, post, total } = await liveEngine()
    // 192000 frames of capacity is not a whole number of 1024-sample frames, so
    // going past it forces the split write this test exists to cover.
    post(Math.ceil(CAPACITY / SCOPE_SIZE) + 3)
    expect(total()).toBeGreaterThan(CAPACITY)

    const recent = engine.recentAudio()!
    expect(recent.full).toBe(true)
    expect(recent.heldSeconds).toBe(RECENT_AUDIO_SECONDS)
    expect(recent.channelData[0]).toHaveLength(CAPACITY)
    // Still one unbroken run ending at the newest sample: the wrap moved where
    // the samples live, not what order they come back in.
    const first = total() - CAPACITY
    for (let index = 0; index < CAPACITY; index += 4099) {
      expect(recent.channelData[0][index]).toBe(first + index)
    }
    expect(recent.channelData[0].at(-1)).toBe(total() - 1)

    // Asking for more than the buffer holds returns the buffer, never padding.
    expect(engine.recentAudio(RECENT_AUDIO_SECONDS * 4)!.channelData[0]).toHaveLength(CAPACITY)
  })

  it('releases the buffer with the graph', async () => {
    const { engine, post } = await liveEngine()
    post(4)
    expect(engine.recentAudio()).not.toBeNull()

    engine.dispose()
    // 1.5 MB of audio a released graph has no claim on, and a restart refills
    // it from its own output rather than replaying the previous session's.
    expect(engine.recentAudio()).toBeNull()
  })

  it('costs an offline engine nothing, because it subscribes to no scope frames', async () => {
    stubWorkletNode()
    const engine = new SynthEngine({ context: fakeOfflineContext() as unknown as BaseAudioContext })
    await engine.start()
    expect(engine.recentAudio()).toBeNull()
  })
})
