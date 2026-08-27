export const MAX_AUDIO_BASE64_CHARACTERS = 16 * 1024 * 1024
export const MAX_REFERENCE_AUDIO_SECONDS = 30
export const MAX_REFERENCE_CHANNELS = 2
export const MAX_REFERENCE_PCM_SAMPLES = 6_000_000

export interface ParsedBase64Audio {
  bytes: Uint8Array
  decodedBytes: number
  mimeType?: string
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
  return new AudioContext()
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
  return { bytes, decodedBytes: bytes.byteLength, ...(mimeType ? { mimeType } : {}) }
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
