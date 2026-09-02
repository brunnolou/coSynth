import { afterEach, describe, expect, it, vi } from 'vitest'
import { SynthEngine } from '../audio/engine'
import type { ToWorklet } from '../shared/messages'
import {
  BASE64_MAX_SECONDS, BASE64_SAMPLE_RATE, encodeWav, monoWavBase64, offlineRenderAvailable, renderOffline
} from './offline-render'

const SAMPLE_RATE = 48000

/**
 * Stands in for `OfflineAudioContext`: jsdom has no Web Audio at all. It drives
 * the suspend callbacks in timeline order when rendering starts, which is what
 * a real offline context does.
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

  constructor(options: { numberOfChannels: number; length: number; sampleRate: number }) {
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
    for (const entry of [...this.waiting].sort((a, b) => a.time - b.time)) {
      entry.resolve()
      // Let the suspension callback (and its `resume`) run before the next one.
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    const channels = Array.from({ length: this.numberOfChannels }, (_, channel) =>
      Float32Array.from({ length: this.length }, (_, index) =>
        0.5 * Math.sin((2 * Math.PI * 220 * index) / this.sampleRate) * (channel === 0 ? 1 : 0.5)))
    return {
      length: this.length,
      sampleRate: this.sampleRate,
      numberOfChannels: this.numberOfChannels,
      duration: this.length / this.sampleRate,
      getChannelData: (channel: number) => channels[channel]
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

afterEach(() => {
  vi.unstubAllGlobals()
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
})

describe('renderOffline', () => {
  it('renders a scratch engine on a single-use offline context and returns WAV plus PCM', async () => {
    const messages = stubWorkletNode()
    const contexts: FakeOfflineContext[] = []
    const engine = liveEngineStub()
    const recording = await renderOffline(
      engine,
      [{ midi: 60, velocity: 0.8, start: 0, duration: 0.5 }],
      1,
      {
        createContext: options => {
          const context = new FakeOfflineContext(options)
          contexts.push(context)
          return context as unknown as BaseAudioContext
        }
      }
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
    const notes = messages.filter(message => message.type === 'noteOn' || message.type === 'noteOff')
    expect(notes).toEqual([
      { type: 'noteOn', note: 60, velocity: 0.8 },
      { type: 'noteOff', note: 60 }
    ])
    // The note-off is scheduled, the note-on happens before rendering starts.
    expect(contexts[0].suspendTimes).toEqual([Math.floor((0.5 * SAMPLE_RATE) / 128) * 128 / SAMPLE_RATE])
    expect(contexts[0].suspendTimes[0]).toBeCloseTo(0.5, 2)
    expect(contexts[0].resumes).toHaveLength(1)
  })

  it('quantizes event times to render quanta and merges events sharing a quantum', async () => {
    stubWorkletNode()
    const contexts: FakeOfflineContext[] = []
    await renderOffline(
      liveEngineStub(),
      [
        { midi: 60, velocity: 1, start: 0.25, duration: 0.25 },
        { midi: 64, velocity: 1, start: 0.2500005, duration: 0.25 }
      ],
      1,
      {
        createContext: options => {
          const context = new FakeOfflineContext(options)
          contexts.push(context)
          return context as unknown as BaseAudioContext
        }
      }
    )
    const quantum = 128 / SAMPLE_RATE
    for (const time of contexts[0].suspendTimes) {
      expect(Math.round(time / quantum)).toBeCloseTo(time / quantum, 9)
    }
    expect(new Set(contexts[0].suspendTimes).size, 'one suspension per quantum').toBe(contexts[0].suspendTimes.length)
    expect(contexts[0].suspendTimes).toHaveLength(2)
  })

  it('loads the live engine patch into the scratch engine and never touches the live graph', async () => {
    stubWorkletNode()
    const engine = liveEngineStub()
    const scratchEngines: SynthEngine[] = []
    await renderOffline(engine, [{ midi: 60, velocity: 1, start: 0, duration: 0.1 }], 0.2, {
      createContext: options => new FakeOfflineContext(options) as unknown as BaseAudioContext,
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
    stubWorkletNode()
    const contexts: FakeOfflineContext[] = []
    const recording = await renderOffline(new SynthEngine(), [{ midi: 60, velocity: 1, start: 0, duration: 0.1 }], 0.2, {
      createContext: options => {
        const context = new FakeOfflineContext(options)
        contexts.push(context)
        return context as unknown as BaseAudioContext
      }
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
})
