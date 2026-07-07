// Minimal in-place radix-2 complex FFT. Used for band-limited wavetable
// mipmaps, spectral morphing between key frames, single-cycle resampling on
// import, and the spectrum analyzer. Zero dependencies, worklet-safe.

/** In-place complex FFT. re/im length must be a power of two. */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  if ((n & (n - 1)) !== 0) throw new Error('fft size must be a power of two')

  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr
      const ti = im[i]; im[i] = im[j]; im[j] = ti
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cwr = 1
      let cwi = 0
      const half = len >> 1
      for (let j = 0; j < half; j++) {
        const ur = re[i + j]
        const ui = im[i + j]
        const vr = re[i + j + half] * cwr - im[i + j + half] * cwi
        const vi = re[i + j + half] * cwi + im[i + j + half] * cwr
        re[i + j] = ur + vr
        im[i + j] = ui + vi
        re[i + j + half] = ur - vr
        im[i + j + half] = ui - vi
        const nwr = cwr * wr - cwi * wi
        cwi = cwr * wi + cwi * wr
        cwr = nwr
      }
    }
  }
}

/** In-place inverse complex FFT (includes 1/n scaling). */
export function ifft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 0; i < n; i++) im[i] = -im[i]
  fft(re, im)
  for (let i = 0; i < n; i++) {
    re[i] /= n
    im[i] = -im[i] / n
  }
}

/**
 * Band-limit a single cycle: keep harmonics 1..maxHarmonic, zero the rest
 * (and DC). Returns a new array of the same length.
 */
export function bandlimitCycle(cycle: Float32Array, maxHarmonic: number): Float32Array {
  const n = cycle.length
  const re = new Float32Array(cycle)
  const im = new Float32Array(n)
  fft(re, im)
  re[0] = 0
  im[0] = 0
  const half = n >> 1
  for (let k = 1; k <= half; k++) {
    if (k > maxHarmonic) {
      re[k] = 0; im[k] = 0
      if (k !== half) { re[n - k] = 0; im[n - k] = 0 }
    }
  }
  ifft(re, im)
  return re
}

/**
 * FFT-resample an arbitrary-length single cycle to `size` samples
 * (zero-pad / truncate in the frequency domain).
 */
export function resampleCycle(input: Float32Array, size: number): Float32Array {
  // Pad/truncate input to a power of two first (time-domain linear resample
  // to the nearest power of two keeps this simple and is inaudible for
  // wavetable import purposes).
  let n = 1
  while (n < input.length) n <<= 1
  const src = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const pos = (i / n) * input.length
    const i0 = Math.floor(pos) % input.length
    const i1 = (i0 + 1) % input.length
    src[i] = input[i0] + (input[i1] - input[i0]) * (pos - i0)
  }
  const re = new Float32Array(src)
  const im = new Float32Array(n)
  fft(re, im)

  const outRe = new Float32Array(size)
  const outIm = new Float32Array(size)
  const bins = Math.min(n >> 1, size >> 1)
  const scale = size / n
  for (let k = 1; k < bins; k++) {
    outRe[k] = re[k] * scale
    outIm[k] = im[k] * scale
    outRe[size - k] = re[n - k] * scale
    outIm[size - k] = im[n - k] * scale
  }
  ifft(outRe, outIm)
  return outRe
}
