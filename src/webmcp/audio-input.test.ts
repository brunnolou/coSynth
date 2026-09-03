import { afterEach, describe, expect, it, vi } from 'vitest'
import { SynthEngine } from '../audio/engine'
import { renderOffline } from './offline-render'
import {
  MAX_AUDIO_BASE64_CHARACTERS,
  MAX_REFERENCE_CHANNELS,
  MAX_REFERENCE_PCM_SAMPLES,
  REFERENCE_DECODE_SAMPLE_RATE,
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

/**
 * The rate a reference is measured on, which nothing in the pipeline used to
 * state out loud.
 *
 * `decodeAudioData` resamples to the rate of the context it is handed and
 * reports nothing about it, so the decode context's rate silently decides how
 * much of the reference survives. Playwright's Chromium reports a 16 kHz output
 * device — measured, headless and headed alike — which put a 44.1 kHz reference
 * through an 8 kHz ceiling while the candidate rendered at the 48 kHz fallback.
 * `bandsDb`'s top octave band then reads the -100 dB floor on the reference and
 * real energy on the candidate: a live eval measured +75.1 dB there and spent a
 * comparison establishing that no patch could close it.
 */
describe('reference decode sample rate', () => {
  /**
   * The first 48 bytes of `docs/agent-match-eval-reference.wav`, verbatim: its
   * RIFF preamble, its whole `fmt ` chunk and the head of the `LIST` chunk
   * behind it. The eval's own reference material, run through the real parser,
   * rather than a hand-built stand-in that could agree with a wrong reading.
   *
   * The bytes are inlined because this project ships no Node type definitions
   * on purpose — a browser app that can see `Buffer` and `node:fs` in every
   * file is one careless import away from shipping them. Regenerate with:
   * `node -e "console.log(require('fs').readFileSync('docs/agent-match-eval-reference.wav').subarray(0, 48).toString('base64'))"`
   */
  const referenceBase64 = 'UklGRtivAgBXQVZFZm10IBAAAAABAAIARKwAAJgJBAAGABgATElTVHYAAABJTkZP'

  /** Base64 for a handmade header, so the malformed cases stay readable inline. */
  const encode = (...values: number[]) => btoa(String.fromCharCode(...values))
  const ascii = (text: string) => [...text].map(character => character.charCodeAt(0))
  const u32 = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]
  const u16 = (value: number) => [value & 0xff, (value >> 8) & 0xff]

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the 44.1 kHz rate out of the shipped reference file header', () => {
    expect(parseBase64Audio(referenceBase64)).toMatchObject({ sourceSampleRate: 44100 })
    expect(parseBase64Audio(`data:audio/wav;base64,${referenceBase64}`)).toMatchObject({
      mimeType: 'audio/wav',
      sourceSampleRate: 44100
    })
  })

  it('reports the file rate beside the decoded rate, so a downsample is visible rather than silent', async () => {
    const downsampled = audioBuffer({ sampleRate: 16000, duration: 4 / 16000 })
    await expect(decodeBase64Audio(referenceBase64, { context: context(downsampled) })).resolves.toMatchObject({
      sourceSampleRate: 44100,
      sampleRate: 16000
    })
  })

  it('builds its own decode context at an explicit rate instead of inheriting the output device', async () => {
    const constructed: unknown[] = []
    class StubAudioContext {
      readonly sampleRate: number
      constructor(options?: { sampleRate?: number }) {
        constructed.push(options)
        // What this browser hands out when nobody asks for a rate.
        this.sampleRate = options?.sampleRate ?? 16000
      }
      async decodeAudioData() {
        return audioBuffer({ sampleRate: this.sampleRate, duration: 4 / this.sampleRate })
      }
      async close() {}
    }
    vi.stubGlobal('AudioContext', StubAudioContext)

    await expect(decodeBase64Audio(referenceBase64, { context: null })).resolves.toMatchObject({
      sourceSampleRate: 44100,
      sampleRate: REFERENCE_DECODE_SAMPLE_RATE
    })
    expect(constructed).toEqual([{ sampleRate: REFERENCE_DECODE_SAMPLE_RATE }])
  })

  it('falls back to a device-rate context when the browser refuses the explicit rate', async () => {
    const constructed: unknown[] = []
    class PickyAudioContext {
      readonly sampleRate = 44100
      constructor(options?: { sampleRate?: number }) {
        constructed.push(options)
        if (options?.sampleRate !== undefined) throw new Error('NotSupportedError')
      }
      async decodeAudioData() {
        return audioBuffer({ sampleRate: 44100, duration: 4 / 44100 })
      }
      async close() {}
    }
    vi.stubGlobal('AudioContext', PickyAudioContext)

    await expect(decodeBase64Audio(referenceBase64, { context: null })).resolves.toMatchObject({ sampleRate: 44100 })
    expect(constructed).toEqual([{ sampleRate: REFERENCE_DECODE_SAMPLE_RATE }, undefined])
  })

  /**
   * The invariant the phantom band error came out of: with no engine context the
   * reference decode and the candidate render each pick their own fallback rate,
   * and the two have to name the same number. They were 16000 and 48000.
   * `createContext` throws once it has recorded what the render asked for, since
   * the rate is settled before any rendering starts.
   */
  it('decodes at exactly the rate an engine-less render falls back to', async () => {
    const asked: number[] = []
    const engine = new SynthEngine()
    expect(engine.context).toBeNull()

    await expect(renderOffline(engine, [{ midi: 60, velocity: 1, start: 0, duration: 0.1 }], 0.2, {
      createContext: options => {
        asked.push(options.sampleRate)
        throw new Error('rate recorded')
      }
    })).rejects.toThrow('rate recorded')
    expect(asked).toEqual([REFERENCE_DECODE_SAMPLE_RATE])
  })

  it.each([
    ['a non-RIFF container', encode(...ascii('ID3'), ...u32(0), ...ascii('meta'))],
    ['a RIFF form that is not WAVE', encode(...ascii('RIFF'), ...u32(36), ...ascii('AVI '), ...ascii('fmt '))],
    ['a header shorter than the RIFF preamble', encode(...ascii('RIFF'), ...u32(0))],
    [
      'a fmt chunk too short to hold a rate',
      encode(...ascii('RIFF'), ...u32(20), ...ascii('WAVE'), ...ascii('fmt '), ...u32(8), ...u16(1), ...u16(2), ...u32(44100))
    ],
    [
      'a fmt chunk truncated mid-field',
      encode(...ascii('RIFF'), ...u32(24), ...ascii('WAVE'), ...ascii('fmt '), ...u32(16), ...u16(1), ...u16(2))
    ],
    [
      'a zero-size chunk that cannot be walked past',
      encode(...ascii('RIFF'), ...u32(28), ...ascii('WAVE'), ...ascii('LIST'), ...u32(0), ...ascii('fmt '), ...u32(16),
        ...u16(1), ...u16(2), ...u32(44100), ...u32(0), ...u16(0), ...u16(0))
    ],
    [
      'a fmt chunk declaring a zero rate',
      encode(...ascii('RIFF'), ...u32(28), ...ascii('WAVE'), ...ascii('fmt '), ...u32(16), ...u16(1), ...u16(2),
        ...u32(0), ...u32(0), ...u16(0), ...u16(0))
    ],
    ['no chunks at all after the preamble', encode(...ascii('RIFF'), ...u32(4), ...ascii('WAVE'))]
  ])('reports no source rate for %s, without throwing', (_label, value) => {
    expect(parseBase64Audio(value).sourceSampleRate).toBeUndefined()
  })

  it('walks past a leading metadata chunk to the fmt chunk behind it', () => {
    const value = encode(
      ...ascii('RIFF'), ...u32(40), ...ascii('WAVE'),
      // Odd-sized, so the word-alignment pad byte has to be counted.
      ...ascii('LIST'), ...u32(5), ...ascii('INFO'), 0, 0,
      ...ascii('fmt '), ...u32(16), ...u16(1), ...u16(2), ...u32(96000), ...u32(0), ...u16(0), ...u16(0)
    )
    expect(parseBase64Audio(value).sourceSampleRate).toBe(96000)
  })
})
