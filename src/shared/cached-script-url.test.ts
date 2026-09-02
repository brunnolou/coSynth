import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cachedScriptUrl, cachedScriptUrlNow, forgetCachedScript, resetCachedScriptUrls } from './cached-script-url'

/**
 * These cover the one property the whole fix rests on: after a script has been
 * fetched once, loading it again must not touch the network. An offline render
 * builds a fresh `OfflineAudioContext` and a fresh analysis worker every time,
 * and both load their script from scratch, so without this every render stayed
 * a live dependency on the page's asset server.
 */
const SOURCE = 'https://example.test/assets/processor-abc123.js'

let created: string[] = []

beforeEach(() => {
  created = []
  let counter = 0
  vi.stubGlobal('Blob', class {
    constructor(readonly parts: unknown[], readonly options?: unknown) {}
  })
  vi.stubGlobal('URL', {
    createObjectURL: () => {
      const url = `blob:cached-${++counter}`
      created.push(url)
      return url
    },
    revokeObjectURL: vi.fn()
  })
})

afterEach(() => {
  resetCachedScriptUrls()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('cachedScriptUrl', () => {
  it('fetches the source once and hands out the in-memory copy after that', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => 'registerProcessor()' }))
    vi.stubGlobal('fetch', fetchMock)

    const first = await cachedScriptUrl(SOURCE)
    expect(first).toBe('blob:cached-1')
    expect(fetchMock).toHaveBeenCalledOnce()

    // The point of the whole exercise: no second network round trip, so a
    // server that stops answering cannot break a load that worked once.
    for (let i = 0; i < 5; i++) expect(await cachedScriptUrl(SOURCE)).toBe('blob:cached-1')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('shares one fetch between concurrent callers', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => 'x' }))
    vi.stubGlobal('fetch', fetchMock)
    const urls = await Promise.all([cachedScriptUrl(SOURCE), cachedScriptUrl(SOURCE), cachedScriptUrl(SOURCE)])
    expect(new Set(urls).size).toBe(1)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  /**
   * Every failure path returns the original URL, so the worst case is exactly
   * the behaviour this replaced — a plain network load — rather than a script
   * that cannot be loaded at all.
   */
  it('falls back to the network URL when the fetch fails, and stays willing to retry', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, text: async () => 'x' })
    vi.stubGlobal('fetch', fetchMock)

    expect(await cachedScriptUrl(SOURCE)).toBe(SOURCE)
    // Nothing was cached, so the next attempt tries again rather than being
    // permanently downgraded by one blip.
    expect(await cachedScriptUrl(SOURCE)).toBe('blob:cached-1')
  })

  it('falls back to the network URL on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, text: async () => '' })))
    expect(await cachedScriptUrl(SOURCE)).toBe(SOURCE)
    expect(created).toEqual([])
  })

  it('falls back to the network URL where blobs cannot be made at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => 'x' })))
    vi.stubGlobal('URL', { createObjectURL: undefined, revokeObjectURL: undefined })
    expect(await cachedScriptUrl(SOURCE)).toBe(SOURCE)
  })

  it('forgets a copy on request, so a rejected blob is not handed out again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => 'x' })))
    expect(await cachedScriptUrl(SOURCE)).toBe('blob:cached-1')
    forgetCachedScript(SOURCE)
    expect(await cachedScriptUrl(SOURCE)).toBe('blob:cached-2')
  })
})

describe('cachedScriptUrlNow', () => {
  /**
   * `analyzeAudioAbortably` must create its worker in the turn it is called —
   * cancelling means terminating that worker — so it cannot await the cache.
   * The first call takes the network URL and warms the cache behind itself.
   */
  it('returns the source first, then the cached copy once warm', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => 'x' }))
    vi.stubGlobal('fetch', fetchMock)

    expect(cachedScriptUrlNow(SOURCE)).toBe(SOURCE)
    await vi.waitFor(() => expect(created).toHaveLength(1))
    expect(cachedScriptUrlNow(SOURCE)).toBe('blob:cached-1')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('does not pile up fetches while one is in flight', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => 'x' }))
    vi.stubGlobal('fetch', fetchMock)
    for (let i = 0; i < 4; i++) expect(cachedScriptUrlNow(SOURCE)).toBe(SOURCE)
    await vi.waitFor(() => expect(created).toHaveLength(1))
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
