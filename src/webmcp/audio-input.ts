export const MAX_AUDIO_BASE64_CHARACTERS = 16 * 1024 * 1024
export const MAX_REFERENCE_AUDIO_SECONDS = 30
export const MAX_REFERENCE_CHANNELS = 2
export const MAX_REFERENCE_PCM_SAMPLES = 6_000_000

/**
 * The rate a decode-only `AudioContext` is built at when the engine has none of
 * its own. Deliberately explicit rather than whatever the output device runs at.
 *
 * `decodeAudioData` resamples to the rate of the context it is called on and
 * reports nothing about having done so, so a decode context that follows the
 * output device silently rewrites the reference. Playwright's bundled Chromium
 * reports a **16 kHz** device rate — measured, headless and headed alike, and
 * unchanged by every audio launch flag tried (`--use-fake-device-for-media-stream`,
 * `--audio-output-channels`, `--disable-features=AudioServiceOutOfProcess`,
 * `--alsa-output-device`). At 16 kHz a 44.1 kHz reference loses everything above
 * 8 kHz: its top octave band drops to the -100 dB floor and the 8 kHz band below
 * it loses half its span, while the candidate — rendered by `renderOffline` at
 * *its* fallback rate — reads real energy in both. Measured on the shipped
 * reference: -23.3 dB in the 16 kHz band at 48 kHz, -100 dB at 16 kHz, for a
 * phantom +75.1 dB error a live eval spent a comparison failing to close.
 *
 * 48000 is not a free choice: it is `DEFAULT_SAMPLE_RATE` in `offline-render.ts`,
 * the rate a render falls back to in exactly the same "no engine context" case.
 * The two fallbacks have to name the same number or the reference and the
 * candidate are measured on different frequency axes.
 */
export const REFERENCE_DECODE_SAMPLE_RATE = 48000

export interface ParsedBase64Audio {
  bytes: Uint8Array
  decodedBytes: number
  mimeType?: string
  /**
   * The rate written in the file's own header, when the container states one.
   * Absent for containers this module does not read (only RIFF/WAVE is parsed)
   * and for headers too short to hold a rate.
   *
   * Kept separate from the decoded rate because `decodeAudioData` resamples to
   * its context's rate silently. The two together are what lets a caller say
   * "your 44.1 kHz reference was analysed at 16 kHz, so every band above 8 kHz
   * reads empty for reasons that have nothing to do with the patch" instead of
   * presenting that emptiness as a gap to close.
   */
  sourceSampleRate?: number
}

export interface DecodedBase64Audio extends Omit<ParsedBase64Audio, 'bytes'> {
  sampleRate: number
  duration: number
  channels: number
  channelData: Float32Array[]
}

export interface AudioDecodeContext {
  decodeAudioData(audioData: ArrayBuffer): Promise<AudioBuffer>
  close?(): Promise<void>
}

export interface DecodeBase64AudioOptions {
  context?: AudioDecodeContext | null
  signal?: AbortSignal
  createContext?: () => AudioDecodeContext
}

const AUDIO_MIME_TYPE = /^audio\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/i
const ASCII_WHITESPACE = /[\u0009-\u000d\u0020]/g
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export function normalizeAudioMimeType(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 127 || !AUDIO_MIME_TYPE.test(value)) {
    throw new Error('mimeType must be a valid audio MIME type')
  }
  return value.toLowerCase()
}

function abortError(): Error {
  const error = new Error('Reference audio analysis aborted')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function defaultContext(): AudioDecodeContext {
  if (typeof AudioContext === 'undefined') throw new Error('AudioContext is unavailable for reference audio decoding')
  try {
    return new AudioContext({ sampleRate: REFERENCE_DECODE_SAMPLE_RATE })
  } catch {
    // A browser may refuse a rate its hardware cannot run — Safari has. A
    // device-rate context still decodes; it may just resample, and
    // `sourceSampleRate` is what makes that visible rather than silent.
    return new AudioContext()
  }
}

/** RIFF magic, total size, and the `WAVE` form type: the bytes before the first chunk. */
const RIFF_HEADER_BYTES = 12
/** `audioFormat` u16, `numChannels` u16, `sampleRate` u32, and four more fields. */
const WAV_FMT_MINIMUM_BYTES = 16

/**
 * The sample rate declared by a RIFF/WAVE `fmt ` chunk, or undefined for any
 * other container and for a header too truncated or malformed to hold one.
 *
 * Header-only: it never touches the audio data, and it never throws — an
 * unreadable header is simply an unknown rate, not a decode failure.
 */
function readWavSampleRate(bytes: Uint8Array): number | undefined {
  if (bytes.byteLength < RIFF_HEADER_BYTES) return undefined
  const fourCc = (at: number) =>
    String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])
  if (fourCc(0) !== 'RIFF' || fourCc(8) !== 'WAVE') return undefined

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = RIFF_HEADER_BYTES
  while (at + 8 <= bytes.byteLength) {
    const size = view.getUint32(at + 4, true)
    if (fourCc(at) === 'fmt ') {
      if (size < WAV_FMT_MINIMUM_BYTES || at + 8 + WAV_FMT_MINIMUM_BYTES > bytes.byteLength) return undefined
      const rate = view.getUint32(at + 12, true)
      return rate > 0 ? rate : undefined
    }
    // Chunks are word-aligned. A zero-size chunk cannot be walked past, so a
    // header claiming one is malformed rather than something to keep scanning.
    const advance = 8 + size + (size % 2)
    if (advance <= 8) return undefined
    at += advance
  }
  return undefined
}

function decodeAudioDataAbortably(
  context: AudioDecodeContext,
  audioData: ArrayBuffer,
  signal?: AbortSignal
): Promise<AudioBuffer> {
  const decoder = Promise.resolve().then(() => context.decodeAudioData(audioData))
  if (!signal) return decoder

  return new Promise<AudioBuffer>((resolve, reject) => {
    let settled = false
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', aborted)
      action()
    }
    const aborted = () => finish(() => reject(abortError()))
    signal.addEventListener('abort', aborted, { once: true })
    decoder.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error))
    )
    if (signal.aborted) aborted()
  })
}

export function parseBase64Audio(audioBase64: string, signal?: AbortSignal): ParsedBase64Audio {
  throwIfAborted(signal)
  if (typeof audioBase64 !== 'string') throw new Error('audioBase64 must be a string')
  if (audioBase64.length > MAX_AUDIO_BASE64_CHARACTERS) {
    throw new Error('audioBase64 is limited to 16 MiB characters')
  }

  let encoded = audioBase64
  let mimeType: string | undefined
  if (/^data:/i.test(audioBase64)) {
    const match = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(audioBase64)
    if (!match) throw new Error('audioBase64 data URI must be an audio data URI using Base64')
    try {
      mimeType = normalizeAudioMimeType(match[1])
    } catch {
      throw new Error('audioBase64 data URI must be an audio data URI using Base64')
    }
    encoded = match[2]
  }

  const compact = encoded.replace(ASCII_WHITESPACE, '')
  if (compact.length === 0) throw new Error('audioBase64 must not be empty')
  if (compact.length % 4 !== 0 || !STRICT_BASE64.test(compact)) {
    throw new Error('audioBase64 is malformed Base64')
  }

  let binary: string
  try {
    binary = atob(compact)
  } catch {
    throw new Error('audioBase64 is malformed Base64')
  }
  if (btoa(binary) !== compact) throw new Error('audioBase64 is malformed Base64')
  if (binary.length === 0) throw new Error('audioBase64 must not decode to empty data')
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  throwIfAborted(signal)
  const sourceSampleRate = readWavSampleRate(bytes)
  return {
    bytes,
    decodedBytes: bytes.byteLength,
    ...(mimeType ? { mimeType } : {}),
    ...(sourceSampleRate ? { sourceSampleRate } : {})
  }
}

export async function decodeBase64Audio(
  audioBase64: string,
  options: DecodeBase64AudioOptions = {}
): Promise<DecodedBase64Audio> {
  const parsed = parseBase64Audio(audioBase64, options.signal)
  throwIfAborted(options.signal)
  const temporary = !options.context
  const context = options.context ?? (options.createContext ?? defaultContext)()
  let primaryFailure = false

  try {
    throwIfAborted(options.signal)
    let decoded: AudioBuffer
    try {
      const copy = parsed.bytes.slice().buffer as ArrayBuffer
      decoded = await decodeAudioDataAbortably(context, copy, options.signal)
    } catch (error) {
      if (options.signal?.aborted) throw abortError()
      const detail = error instanceof Error ? `: ${error.message}` : ''
      throw new Error(`Unable to decode reference audio${detail}`)
    }
    throwIfAborted(options.signal)

    if (!Number.isInteger(decoded.numberOfChannels) || decoded.numberOfChannels < 1 ||
        decoded.numberOfChannels > MAX_REFERENCE_CHANNELS) {
      throw new Error(`Decoded reference audio must have 1 to ${MAX_REFERENCE_CHANNELS} channels`)
    }
    if (!Number.isInteger(decoded.length) || decoded.length <= 0) {
      throw new Error('Decoded reference audio length must be a positive integer')
    }
    if (!Number.isFinite(decoded.sampleRate) || decoded.sampleRate <= 0 || decoded.sampleRate > 192000) {
      throw new Error('Decoded reference audio sample rate must be finite, positive, and at most 192000 Hz')
    }
    if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) {
      throw new Error('Decoded reference audio duration must be finite and positive')
    }

    const derivedDuration = decoded.length / decoded.sampleRate
    if (derivedDuration > MAX_REFERENCE_AUDIO_SECONDS) {
      throw new Error(`Decoded reference audio is limited to ${MAX_REFERENCE_AUDIO_SECONDS} seconds`)
    }
    const durationTolerance = Math.max(0.01, 1 / decoded.sampleRate)
    if (Math.abs(decoded.duration - derivedDuration) > durationTolerance) {
      throw new Error('Decoded reference audio duration must be consistent with its length and sample rate')
    }
    const totalSamples = decoded.numberOfChannels * decoded.length
    if (totalSamples > MAX_REFERENCE_PCM_SAMPLES) {
      throw new Error(`Decoded reference audio PCM is limited to ${MAX_REFERENCE_PCM_SAMPLES} total samples`)
    }

    const channelData: Float32Array[] = []
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
      throwIfAborted(options.signal)
      const source = decoded.getChannelData(channel)
      if (!(source instanceof Float32Array)) throw new Error('Decoded reference audio channels must be Float32Array data')
      if (source.length !== decoded.length) {
        throw new Error('Decoded reference audio channels must have equal lengths matching decoded length')
      }
      channelData.push(new Float32Array(source))
    }
    throwIfAborted(options.signal)
    return {
      decodedBytes: parsed.decodedBytes,
      ...(parsed.mimeType ? { mimeType: parsed.mimeType } : {}),
      ...(parsed.sourceSampleRate ? { sourceSampleRate: parsed.sourceSampleRate } : {}),
      sampleRate: decoded.sampleRate,
      duration: derivedDuration,
      channels: decoded.numberOfChannels,
      channelData
    }
  } catch (error) {
    primaryFailure = true
    throw error
  } finally {
    if (temporary) {
      try {
        await context.close?.()
      } catch (error) {
        if (!primaryFailure) throw error
      }
    }
  }
}
