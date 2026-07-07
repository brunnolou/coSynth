// Ambient declarations for the AudioWorkletGlobalScope, which is not covered
// by TypeScript's DOM lib.

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean
}

declare function registerProcessor(
  name: string,
  ctor: new (options?: unknown) => AudioWorkletProcessor
): void

declare const sampleRate: number
declare const currentFrame: number
declare const currentTime: number
