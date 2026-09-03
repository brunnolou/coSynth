/**
 * `@audio/pitch-yin` ships `index.d.ts` but its package.json `exports` map has no `types`
 * condition for `.`, so under `moduleResolution: bundler` TypeScript cannot reach it. This
 * mirrors the published signature until the package fixes its own exports.
 */
declare module '@audio/pitch-yin' {
  export interface YinOptions {
    /** Sample rate (Hz), default 44100. */
    fs?: number
    /** CMND threshold - lower is stricter, default 0.15. */
    threshold?: number
    minFreq?: number
    maxFreq?: number
  }
  /** `null` when the frame holds no periodic structure. */
  export default function yin(
    data: Float32Array | Float64Array,
    options?: YinOptions
  ): { freq: number; clarity: number } | null
}
