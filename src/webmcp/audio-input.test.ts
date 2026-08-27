import { describe, expect, it, vi } from 'vitest'
import {
  MAX_AUDIO_BASE64_CHARACTERS,
  MAX_REFERENCE_CHANNELS,
  MAX_REFERENCE_PCM_SAMPLES,
  decodeBase64Audio,
  normalizeAudioMimeType,
  parseBase64Audio,
  type AudioDecodeContext
} from './audio-input'

const bytes = Uint8Array.from([0x52, 0x49, 0x46, 0x46])
const rawBase64 = 'UklGRg=='

function audioBuffer(overrides: Record<string, unknown> = {}) {
  const channels = [new Float32Array([0, 0.25, -0.25, 0])]
  return {
    numberOfChannels: channels.length,
    sampleRate: 8000,
    duration: channels[0].length / 8000,
    length: channels[0].length,
    getChannelData: (index: number) => channels[index],
    ...overrides
  } as unknown as AudioBuffer
}

function context(result: AudioBuffer = audioBuffer()) {
  return {
    decodeAudioData: vi.fn(async (_data: ArrayBuffer) => result)
  } as unknown as AudioDecodeContext
}

describe('parseBase64Audio', () => {
  it('accepts raw Base64 and audio data URIs and derives the MIME type', () => {
    expect(parseBase64Audio(rawBase64)).toEqual({ bytes, decodedBytes: 4 })
    expect(parseBase64Audio(`data:audio/wav;base64,${rawBase64}`)).toEqual({
      bytes,
      decodedBytes: 4,
      mimeType: 'audio/wav'
    })
  })

  it('tolerates ASCII whitespace in Base64', () => {
    expect(parseBase64Audio('UklG\r\n Rg==\t').bytes).toEqual(bytes)
    expect(parseBase64Audio('data:audio/wav;base64,UklG\nRg==').bytes).toEqual(bytes)
  })

  it('accepts only canonical padded Base64, including whitespace-wrapped canonical input', () => {
    for (const value of ['TQ', 'TWE', 'Zh==', 'Zm9=']) {
      expect(() => parseBase64Audio(value)).toThrow(/malformed/i)
    }
    for (const value of ['TQ==', 'TWE=', 'Zg==', 'Zm8=', ' \r\nZm8=\t ']) {
      expect(parseBase64Audio(value).decodedBytes).toBeGreaterThan(0)
    }
  })

  it('parses data-URI and MIME case variants through the shared normalizer', () => {
    expect(normalizeAudioMimeType('AuDiO/WaV')).toBe('audio/wav')
    expect(parseBase64Audio(`DATA:AuDiO/WaV;BaSe64,${rawBase64}`)).toMatchObject({
      bytes,
      mimeType: 'audio/wav'
    })
  })

  it.each([
    ['', /empty/i],
    ['   \n\t', /empty/i],
    ['not*base64', /malformed/i],
    ['abcde', /malformed/i],
    ['AAAA=AAA', /malformed/i],
    ['data:text/plain;base64,UklGRg==', /audio data URI/i],
    ['data:audio/wav,UklGRg==', /audio data URI/i],
    ['data:audio/;base64,UklGRg==', /audio data URI/i],
    ['data:audio/wav;base64,', /empty/i],
    ['datax:audio/wav;base64,UklGRg==', /malformed/i]
  ])('strictly rejects invalid payload %j', (value, error) => {
    expect(() => parseBase64Audio(value)).toThrow(error)
  })

  it('rejects non-string and oversized encoded input before decoding', () => {
    expect(() => parseBase64Audio(123 as unknown as string)).toThrow(/string/i)
    expect(() => parseBase64Audio('A'.repeat(MAX_AUDIO_BASE64_CHARACTERS + 1))).toThrow(/16 MiB/i)
  })
})

describe('decodeBase64Audio', () => {
  it('uses the supplied engine context, passes an exact standalone copy, and copies PCM', async () => {
    const source = new Float32Array([0, 0.25, -0.25, 0])
    const activeContext = context(audioBuffer({ getChannelData: () => source }))
    const result = await decodeBase64Audio(rawBase64, { context: activeContext })

    expect(activeContext.decodeAudioData).toHaveBeenCalledTimes(1)
    const passed = vi.mocked(activeContext.decodeAudioData).mock.calls[0][0]
    expect(passed).toBeInstanceOf(ArrayBuffer)
    expect(passed.byteLength).toBe(4)
    expect(new Uint8Array(passed)).toEqual(bytes)
    expect(result).toMatchObject({ decodedBytes: 4, sampleRate: 8000, channels: 1 })
    expect(result.channelData).toHaveLength(1)
    expect(result.channelData[0]).toEqual(source)
    expect(result.channelData[0]).not.toBe(source)
  })

  it('creates and always closes a temporary AudioContext when the engine has none', async () => {
    const temporary = { ...context(), close: vi.fn(async () => undefined) }
    const createContext = vi.fn(() => temporary)
    await expect(decodeBase64Audio(rawBase64, { context: null, createContext })).resolves.toMatchObject({ channels: 1 })
    expect(createContext).toHaveBeenCalledOnce()
    expect(temporary.close).toHaveBeenCalledOnce()

    temporary.decodeAudioData = vi.fn(async () => { throw new Error('bad codec') })
    await expect(decodeBase64Audio(rawBase64, { context: null, createContext })).rejects.toThrow(/decode/i)
    expect(temporary.close).toHaveBeenCalledTimes(2)
  })

  it('honors abort before parsing, after decode, and while using a lifecycle-combined signal', async () => {
    const before = new AbortController()
    before.abort()
    const unused = context()
    await expect(decodeBase64Audio(rawBase64, { context: unused, signal: before.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(unused.decodeAudioData).not.toHaveBeenCalled()

    const after = new AbortController()
    const aborting = context()
    vi.mocked(aborting.decodeAudioData).mockImplementation(async () => {
      after.abort()
      return audioBuffer()
    })
    await expect(decodeBase64Audio(rawBase64, { context: aborting, signal: after.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('promptly aborts a never-settling decoder and closes a temporary context exactly once', async () => {
    const controller = new AbortController()
    let decodingStarted!: () => void
    const started = new Promise<void>(resolve => { decodingStarted = resolve })
    const temporary: AudioDecodeContext = {
      decodeAudioData: vi.fn(() => {
        decodingStarted()
        return new Promise<AudioBuffer>(() => undefined)
      }),
      close: vi.fn(async () => undefined)
    }
    const pending = decodeBase64Audio(rawBase64, {
      context: null,
      createContext: () => temporary,
      signal: controller.signal
    })
    await started
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(temporary.close).toHaveBeenCalledOnce()
  })

  it('preserves a primary decode error when temporary context close also rejects', async () => {
    const temporary: AudioDecodeContext = {
      decodeAudioData: vi.fn(async () => { throw new Error('bad codec') }),
      close: vi.fn(async () => { throw new Error('close failed') })
    }
    await expect(decodeBase64Audio(rawBase64, {
      context: null,
      createContext: () => temporary
    })).rejects.toThrow(/bad codec/i)
    expect(temporary.close).toHaveBeenCalledOnce()
  })

  it('rejects a close failure when decoding otherwise succeeds', async () => {
    const temporary = {
      ...context(),
      close: vi.fn(async () => { throw new Error('close failed') })
    }
    await expect(decodeBase64Audio(rawBase64, {
      context: null,
      createContext: () => temporary
    })).rejects.toThrow(/close failed/i)
  })

  it.each([
    [audioBuffer({ numberOfChannels: 0 }), /channel/i],
    [audioBuffer({ numberOfChannels: MAX_REFERENCE_CHANNELS + 1 }), /2 channels/i],
    [audioBuffer({ length: 0 }), /length/i],
    [audioBuffer({ length: 1.5 }), /length/i],
    [audioBuffer({ length: Number.NaN }), /length/i],
    [audioBuffer({ numberOfChannels: 1, sampleRate: 0 }), /sample rate/i],
    [audioBuffer({ sampleRate: 192001 }), /192000/i],
    [audioBuffer({ duration: Number.NaN }), /duration/i],
    [audioBuffer({ duration: 0 }), /duration/i],
    [audioBuffer({ duration: 0.5 }), /duration.*consistent/i],
    [audioBuffer({ length: 240_008, duration: 30.001 }), /30 seconds/i],
    [audioBuffer({ numberOfChannels: 2, getChannelData: (index: number) => new Float32Array(index ? 3 : 4) }), /equal lengths/i],
    [audioBuffer({ getChannelData: () => [0, 1] }), /Float32Array/i]
  ])('rejects invalid decoded audio %#', async (decoded, error) => {
    await expect(decodeBase64Audio(rawBase64, { context: context(decoded) })).rejects.toThrow(error)
  })

  it('rejects oversized total PCM before reading or copying channel data', async () => {
    const getChannelData = vi.fn(() => { throw new Error('must not read PCM') })
    const length = MAX_REFERENCE_PCM_SAMPLES / MAX_REFERENCE_CHANNELS + 1
    const decoded = audioBuffer({
      numberOfChannels: MAX_REFERENCE_CHANNELS,
      sampleRate: 192000,
      length,
      duration: length / 192000,
      getChannelData
    })
    await expect(decodeBase64Audio(rawBase64, { context: context(decoded) })).rejects.toThrow(/PCM.*6000000/i)
    expect(getChannelData).not.toHaveBeenCalled()
  })

  it('returns duration canonically derived from length and sample rate within decoder tolerance', async () => {
    const decoded = audioBuffer({ duration: 0.009 })
    await expect(decodeBase64Audio(rawBase64, { context: context(decoded) })).resolves.toMatchObject({
      duration: 4 / 8000
    })
  })
})
