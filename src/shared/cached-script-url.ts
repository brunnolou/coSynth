/**
 * Same-origin script URLs, fetched once and kept in memory as `blob:` URLs.
 *
 * `audioWorklet.addModule(url)` and `new Worker(url)` both load their script
 * over the network, and both get a fresh global scope every time, so a fresh
 * context or a fresh worker re-loads the script from scratch. The live engine
 * pays that once; `render_audio` does not. One offline render builds an
 * `OfflineAudioContext` (single-use, so it cannot be reused) *and* spawns an
 * analysis worker, which means every render was two network round trips to the
 * page's own asset server — and therefore a live dependency on that server
 * still answering, on every render, forever.
 *
 * That dependency is the bug this module exists to remove. In a real eval run
 * nineteen renders succeeded and every render after them failed with
 * `Unable to load a worklet's module`, never recovering, because the assets are
 * served `Cache-Control: no-cache` and each new scope revalidated over the
 * network rather than reusing the copy the page already had. Killing the preview
 * server mid-loop reproduces that message verbatim.
 *
 * Caching the source as a `blob:` URL makes every load after the first resolve
 * from memory, so a render that worked once keeps working. Both scripts this is
 * used for are self-contained bundles — Vite emits them with no imports or
 * exports — so neither needs a base URL of its own, which a `blob:` URL cannot
 * provide.
 *
 * Every failure path returns the original URL, so the worst case is exactly the
 * behaviour this replaced rather than a broken load.
 */

/** Source URL -> `blob:` URL. */
const cached = new Map<string, string>()
/** In-flight loads, so concurrent callers share one fetch. */
const loading = new Map<string, Promise<string>>()

function canCache(): boolean {
  return typeof fetch === 'function'
    && typeof Blob === 'function'
    && typeof URL?.createObjectURL === 'function'
}

/**
 * The URL to load `source` from: a cached `blob:` URL when one can be made,
 * otherwise `source` itself.
 *
 * A failed fetch caches nothing, so a later call is free to try again — the
 * first render after a blip should not be permanently downgraded.
 */
export async function cachedScriptUrl(source: string): Promise<string> {
  const hit = cached.get(source)
  if (hit) return hit
  const inFlight = loading.get(source)
  if (inFlight) return await inFlight
  if (!canCache()) return source
  const load = (async () => {
    try {
      const response = await fetch(source)
      if (!response.ok) return source
      const url = URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }))
      cached.set(source, url)
      return url
    } catch {
      return source
    } finally {
      loading.delete(source)
    }
  })()
  loading.set(source, load)
  return await load
}

/**
 * The cached `blob:` URL for `source` if there already is one, otherwise
 * `source` itself — and either way, start caching it for next time.
 *
 * The synchronous form exists for callers whose timing is observable.
 * `analyzeAudioAbortably` must create its worker in the same turn it is called,
 * because cancelling the analysis means terminating that worker, and a worker
 * that does not exist yet cannot be terminated. So the first call uses the
 * network URL — exactly what it did before — and warms the cache behind itself;
 * every later call gets the in-memory copy with no await at all.
 */
export function cachedScriptUrlNow(source: string): string {
  const hit = cached.get(source)
  if (hit) return hit
  if (!loading.has(source) && canCache()) void cachedScriptUrl(source)
  return source
}

/**
 * Drop the cached copy of `source`.
 *
 * For a browser that refuses to load a worklet or worker from a `blob:` URL:
 * the caller falls back to the network URL for that one load and calls this so
 * later loads stop trying the copy.
 */
export function forgetCachedScript(source: string): void {
  const url = cached.get(source)
  if (url && typeof URL?.revokeObjectURL === 'function') URL.revokeObjectURL(url)
  cached.delete(source)
}

/** Tests only: forget every cached copy so each case starts from a clean slate. */
export function resetCachedScriptUrls(): void {
  for (const source of [...cached.keys()]) forgetCachedScript(source)
  loading.clear()
}
