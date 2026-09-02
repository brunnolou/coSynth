import { afterEach, describe, expect, it, vi } from 'vitest'
import { SynthEngine } from './engine'
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
  })
})
