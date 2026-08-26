import { afterEach, describe, expect, it, vi } from 'vitest'
import { SynthEngine } from './engine'

class FakeMediaRecorder {
  static isTypeSupported = vi.fn(() => true)
  static instances: FakeMediaRecorder[] = []
  state: RecordingState = 'inactive'
  mimeType = 'audio/webm'
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstop: (() => void) | null = null
  onerror: ((event: Event) => void) | null = null
  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    if (options?.mimeType) this.mimeType = options.mimeType
    FakeMediaRecorder.instances.push(this)
  }
  start() { this.state = 'recording' }
  stop() {
    if (this.state === 'inactive') return
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['encoded'], { type: this.mimeType }) } as BlobEvent)
    this.onstop?.()
  }
}

class FailingMediaRecorder extends FakeMediaRecorder {
  override start() {
    this.state = 'recording'
    queueMicrotask(() => this.onerror?.(new Event('error')))
  }
}

class ConstructorThrowingMediaRecorder extends FakeMediaRecorder {
  constructor(stream: MediaStream, options?: MediaRecorderOptions) {
    super(stream, options)
    throw new Error('constructor failed')
  }
}

class StartThrowingMediaRecorder extends FakeMediaRecorder {
  override start() {
    throw new Error('start failed')
  }
}

class TypeCheckThrowingMediaRecorder extends FakeMediaRecorder {
  static override isTypeSupported = vi.fn(() => {
    throw new Error('type check failed')
  })
}

async function expectQuickRejection(promise: Promise<unknown>, message: RegExp): Promise<void> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('timed out waiting for rejection')), 50)
  })
  await expect(Promise.race([promise, timeout])).rejects.toThrow(message)
}

async function expectFollowingRecordingToSucceed(engine: SynthEngine): Promise<void> {
  vi.useFakeTimers()
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  const promise = engine.recordOutput(0.01)
  await vi.advanceTimersByTimeAsync(11)
  await expect(promise).resolves.toMatchObject({ sampleRate: 48000 })
}

function runningEngine() {
  const engine = new SynthEngine()
  const connect = vi.fn()
  const disconnect = vi.fn()
  const decoded = {
    duration: 0.1,
    sampleRate: 48000,
    numberOfChannels: 2,
    getChannelData: (channel: number) => new Float32Array(channel ? [0, -0.2] : [0, 0.2])
  }
  const stopTrack = vi.fn()
  const destination = { stream: { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream }
  ;(engine as any).node = { connect, disconnect }
  ;(engine as any).ctx = {
    createMediaStreamDestination: vi.fn(() => destination),
    decodeAudioData: vi.fn(async () => decoded)
  }
  return { engine, connect, disconnect, destination, stopTrack }
}

afterEach(() => {
  FakeMediaRecorder.instances = []
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('SynthEngine.recordOutput', () => {
  it('requires a running audio graph', async () => {
    const engine = new SynthEngine()
    await expect(engine.recordOutput(0.1)).rejects.toThrow(/start audio/i)
  })

  it('records, decodes, copies channels, and disconnects the tap', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    const { engine, connect, disconnect, destination, stopTrack } = runningEngine()
    const promise = engine.recordOutput(0.1)
    await vi.advanceTimersByTimeAsync(101)
    const result = await promise
    expect(connect).toHaveBeenCalledWith(destination)
    expect(disconnect).toHaveBeenCalledWith(destination)
    expect(result).toMatchObject({ duration: 0.1, sampleRate: 48000 })
    expect(result.mimeType).toMatch(/^audio\/webm/)
    expect(result.channelData).toHaveLength(2)
    expect(result.channelData[0]).toEqual(new Float32Array([0, 0.2]))
    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(FakeMediaRecorder.instances.at(-1)).toMatchObject({ ondataavailable: null, onstop: null, onerror: null })
  })

  it('stops and disconnects on cancellation', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    const { engine, disconnect, destination } = runningEngine()
    const controller = new AbortController()
    const promise = engine.recordOutput(10, controller.signal)
    controller.abort()
    await expect(promise).rejects.toThrow(/abort/i)
    expect(disconnect).toHaveBeenCalledWith(destination)
  })

  it('rejects immediately and disconnects when MediaRecorder errors', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('MediaRecorder', FailingMediaRecorder)
    const { engine, disconnect, destination } = runningEngine()
    let rejected = false
    const promise = engine.recordOutput(10).catch(error => {
      rejected = true
      throw error
    })
    const expectation = expect(promise).rejects.toThrow(/MediaRecorder failed/i)
    await vi.advanceTimersByTimeAsync(0)
    expect(rejected).toBe(true)
    await expectation
    expect(disconnect).toHaveBeenCalledWith(destination)
  })

  it('cleans up immediately when the MediaRecorder constructor throws and permits another recording', async () => {
    vi.stubGlobal('MediaRecorder', ConstructorThrowingMediaRecorder)
    const { engine, disconnect, destination, stopTrack } = runningEngine()

    await expectQuickRejection(engine.recordOutput(10), /constructor failed/i)

    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledWith(destination)
    await expectFollowingRecordingToSucceed(engine)
  })

  it('cleans up immediately when MediaRecorder.start throws and permits another recording', async () => {
    vi.stubGlobal('MediaRecorder', StartThrowingMediaRecorder)
    const { engine, disconnect, destination, stopTrack } = runningEngine()

    await expectQuickRejection(engine.recordOutput(10), /start failed/i)

    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledWith(destination)
    expect(FakeMediaRecorder.instances.at(-1)).toMatchObject({ ondataavailable: null, onstop: null, onerror: null })
    await expectFollowingRecordingToSucceed(engine)
  })

  it('cleans up immediately when MediaRecorder type support detection throws', async () => {
    vi.stubGlobal('MediaRecorder', TypeCheckThrowingMediaRecorder)
    const { engine, disconnect, destination, stopTrack } = runningEngine()

    await expectQuickRejection(engine.recordOutput(10), /type check failed/i)

    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledWith(destination)
  })

  it('validates the duration before mutating the graph', async () => {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    const { engine, connect } = runningEngine()
    await expect(engine.recordOutput(0)).rejects.toThrow(/duration/i)
    await expect(engine.recordOutput(Infinity)).rejects.toThrow(/duration/i)
    expect(connect).not.toHaveBeenCalled()
  })

  it('checks cancellation after reading the blob and before decoding it', async () => {
    vi.useFakeTimers()
    const NativeBlob = Blob
    let release!: () => void
    class DeferredBlob extends NativeBlob {
      override async arrayBuffer(): Promise<ArrayBuffer> {
        await new Promise<void>(resolve => { release = resolve })
        return super.arrayBuffer()
      }
    }
    vi.stubGlobal('Blob', DeferredBlob)
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    const { engine } = runningEngine()
    const decode = vi.mocked((engine.ctx as AudioContext).decodeAudioData)
    const controller = new AbortController()
    const promise = engine.recordOutput(0.01, controller.signal)
    await vi.advanceTimersByTimeAsync(11)
    controller.abort()
    release()
    await expect(promise).rejects.toThrow(/abort/i)
    expect(decode).not.toHaveBeenCalled()
  })
})
