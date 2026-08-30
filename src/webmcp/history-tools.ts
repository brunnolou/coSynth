import type { HistoryServices } from '../history/types'

function inputObject(input: unknown, allowed: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('input must be an object')
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`Unknown input property: ${key}`)
  return input as Record<string, unknown>
}
function id(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 100) throw new Error('entryId must be a non-empty string of at most 100 characters')
  return input
}
function integer(input: unknown, name: string, min: number, max: number): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) throw new Error(`${name} must be an integer from ${min} to ${max}`)
  return input
}

export function createHistoryTools(services: HistoryServices, lifecycle: AbortSignal): WebMCP.ModelContextTool[] {
  const signalFor = (options?: WebMCP.ToolExecuteCallbackOptions) => {
    if (lifecycle.aborted || options?.signal?.aborted) throw new DOMException('History request cancelled', 'AbortError')
    return options?.signal
  }
  return [{
    name: 'get_history',
    description: 'Read retained sound versions or replayable AI performances and walkthroughs. Undo skips replays. Use the returned revision with navigate_history. Earlier alternatives remain recoverable until retention eviction.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      view: { type: 'string', enum: ['sounds', 'replays'] }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 }
    } },
    annotations: { readOnlyHint: true },
    execute(input, options) {
      signalFor(options)
      const value = inputObject(input, ['view', 'offset', 'limit'])
      const view = value.view ?? 'sounds'
      if (view !== 'sounds' && view !== 'replays') throw new Error('view must be sounds or replays')
      const offset = integer(value.offset ?? 0, 'offset', 0, Number.MAX_SAFE_INTEGER)
      const limit = integer(value.limit ?? 5, 'limit', 1, 20)
      const state = services.history.snapshot()
      const entries = view === 'sounds' ? [...state.entries].reverse() : services.replays.snapshot().map(({ notes, steps, ...entry }) => ({
        ...entry, ...(notes ? { noteCount: notes.length } : {}), ...(steps ? { stepCount: steps.length } : {})
      })).reverse()
      const items = entries.slice(offset, offset + limit)
      return { view, items, total: entries.length, offset, limit,
        ...(offset + items.length < entries.length ? { nextOffset: offset + items.length } : {}),
        currentId: state.currentId, revision: state.revision, canUndo: state.canUndo, canRedo: state.canRedo,
        gestureActive: state.gestureActive, performanceActive: services.performance.active,
        limits: { sounds: 120, replays: 120, historicalAssetBytes: 128 * 1024 * 1024 } }
    }
  }, {
    name: 'navigate_history',
    description: 'Undo, redo, or restore a retained sound version. Requires the revision from get_history; stale requests fail without restoring. Stops active performances first. Replays and alternative sound versions are preserved. Never starts audio.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['action', 'expectedRevision'], properties: {
      action: { type: 'string', enum: ['undo', 'redo', 'restore'] }, entryId: { type: 'string', minLength: 1, maxLength: 100 }, expectedRevision: { type: 'integer', minimum: 0 }
    } },
    annotations: { readOnlyHint: false },
    async execute(input, options) {
      signalFor(options)
      const value = inputObject(input, ['action', 'entryId', 'expectedRevision'])
      if (value.action !== 'undo' && value.action !== 'redo' && value.action !== 'restore') throw new Error('action must be undo, redo, or restore')
      if (value.action !== 'restore' && value.entryId !== undefined) throw new Error('entryId is only valid for restore')
      const entryId = value.action === 'restore' ? id(value.entryId) : undefined
      const revision = integer(value.expectedRevision, 'expectedRevision', 0, Number.MAX_SAFE_INTEGER)
      const controller = new AbortController()
      const abort = () => controller.abort()
      lifecycle.addEventListener('abort', abort, { once: true })
      options?.signal?.addEventListener('abort', abort, { once: true })
      try {
        const state = await services.history.navigate(value.action, entryId, revision, controller.signal)
        return { currentId: state.currentId, revision: state.revision, canUndo: state.canUndo, canRedo: state.canRedo }
      } finally { lifecycle.removeEventListener('abort', abort); options?.signal?.removeEventListener('abort', abort) }
    }
  }, {
    name: 'replay_history',
    description: 'Play saved AI notes with the CURRENT sound, or restart a saved walkthrough at step one against the current UI. Does not restore a patch or duplicate history. Performance replay requires audio to be started.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['entryId'], properties: { entryId: { type: 'string', minLength: 1, maxLength: 100 } } },
    annotations: { readOnlyHint: false },
    async execute(input, options) {
      signalFor(options)
      const value = inputObject(input, ['entryId'])
      const entryId = id(value.entryId)
      const controller = new AbortController()
      const abort = () => controller.abort()
      lifecycle.addEventListener('abort', abort, { once: true })
      options?.signal?.addEventListener('abort', abort, { once: true })
      try { await services.replays.replay(entryId, controller.signal); return { replayed: entryId } }
      finally { lifecycle.removeEventListener('abort', abort); options?.signal?.removeEventListener('abort', abort) }
    }
  }, {
    name: 'stop_performance',
    description: 'Stop the active AI performance or history audition and wait for owned notes and recording tasks to clean up. Keeps the saved note sequence available for replay.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: false },
    async execute(input, options) {
      signalFor(options); inputObject(input, [])
      await services.performance.stop()
      return { stopped: true }
    }
  }]
}
