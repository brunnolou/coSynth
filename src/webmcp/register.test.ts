import { describe, expect, it, vi } from 'vitest'
import { registerWebMcpTools } from './register'
import { agentActivityFor } from './activity'
import { SynthEngine } from '../audio/engine'

const engine = new SynthEngine()

function context(registerTool: (tool: WebMCP.ModelContextTool, options?: WebMCP.ModelContextRegisterToolOptions) => Promise<void> | void) {
  return { registerTool } as unknown as WebMCP.ModelContext
}

describe('registerWebMcpTools', () => {
  it('is a harmless no-op when WebMCP is unavailable', async () => {
    const registration = registerWebMcpTools(engine, undefined)
    await expect(registration.ready).resolves.toBeUndefined()
    expect(() => registration.dispose()).not.toThrow()
    expect(registration.registeredCount).toBe(0)
    expect(registration.available).toBe(false)
    expect(registration.pending).toBe(false)
    expect(registration.errors).toEqual([])
  })

  it('registers each of the twelve tools exactly once with a shared lifecycle signal', async () => {
    const calls: Array<{ tool: WebMCP.ModelContextTool; signal?: AbortSignal }> = []
    const modelContext = context((tool, options) => {
      calls.push({ tool, signal: options?.signal })
      return Promise.resolve()
    })

    const registration = registerWebMcpTools(engine, modelContext)
    await registration.ready

    expect(calls.map(({ tool }) => tool.name)).toEqual([
      'get_synth_state', 'get_parameter_schema', 'update_parameters',
      'set_modulation', 'play_notes', 'render_audio', 'analyze_audio',
      'analyze_reference_audio', 'compare_audio', 'save_preset', 'load_preset', 'list_presets'
    ])
    expect(new Set(calls.map(call => call.signal)).size).toBe(1)
    expect(calls[0].signal?.aborted).toBe(false)
    expect(registration.registeredCount).toBe(12)
    registration.dispose()
    expect(calls[0].signal?.aborted).toBe(true)
  })

  it('has no option that can withhold a tool until the Start gesture', async () => {
    // In the discoverability eval Codex listed the tools once, before the
    // gesture, saw no `play_notes`, concluded playback was not a WebMCP tool
    // and drove the DOM for the rest of the run. The advertised set must be
    // the same before and after Start, so nothing may split it.
    const names: string[] = []
    // @ts-expect-error - `audioTools` is gone; a stray option must not gate a tool.
    await registerWebMcpTools(engine, context(tool => { names.push(tool.name) }), { audioTools: 'exclude' }).ready
    expect(names).toContain('play_notes')
    expect(names).toContain('render_audio')
    expect(names).toHaveLength(12)
  })

  it('returns actionable expected errors while preserving cancellation semantics', async () => {
    const calls: WebMCP.ModelContextTool[] = []
    const modelContext = context(tool => { calls.push(tool) })
    await registerWebMcpTools(engine, modelContext).ready

    const update = calls.find(tool => tool.name === 'update_parameters')!
    await expect(update.execute({ updates: [{ id: 'missing', value: 1 }] }, { signal: new AbortController().signal }))
      .resolves.toMatchObject({ ok: false, error: { code: 'tool_error', message: expect.stringContaining("Unknown parameter 'missing'") } })
    expect(agentActivityFor(engine).snapshot().lastAction).toMatchObject({
      tool: 'update_parameters', status: 'failed', summary: expect.stringContaining("Unknown parameter 'missing'")
    })

    const controller = new AbortController()
    controller.abort()
    const play = calls.find(tool => tool.name === 'play_notes')!
    await expect(play.execute({ notes: [] }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('isolates synchronous and asynchronous registration errors', async () => {
    const attempted: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const modelContext = context(tool => {
      attempted.push(tool.name)
      if (tool.name === 'get_parameter_schema') throw new Error('sync failure')
      if (tool.name === 'set_modulation') return Promise.reject(new Error('async failure'))
      return Promise.resolve()
    })

    const registration = registerWebMcpTools(engine, modelContext)
    await expect(registration.ready).resolves.toBeUndefined()
    expect(registration.registeredCount).toBe(10)
    expect(registration.available).toBe(true)
    expect(registration.pending).toBe(false)
    expect(registration.errors).toEqual(expect.arrayContaining([
      { tool: 'get_parameter_schema', message: 'sync failure' },
      { tool: 'set_modulation', message: 'async failure' }
    ]))
    expect(attempted).toHaveLength(12)
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('registers injected teaching tools at page load without patch checkpoints', async () => {
    const calls: WebMCP.ModelContextTool[] = []
    const engine = new SynthEngine()
    const guide = { show: vi.fn(() => ({ shown: true, stepCount: 1, warnings: [] })), listTargets: vi.fn(() => ({ items: [], total: 0, offset: 0, limit: 5 })) }
    const registration = registerWebMcpTools(engine, context(tool => { calls.push(tool) }), { guide })
    await registration.ready
    expect(registration.registeredCount).toBe(14)
    const show = calls.find(t => t.name === 'show_ui_guide')!
    const get = calls.find(t => t.name === 'get_ui_targets')!
    expect(show.annotations?.readOnlyHint).toBe(false)
    expect(get.annotations?.readOnlyHint).toBe(true)
    const input = { steps: [{ target: { id: 'fx.delay' } }] }
    await show.execute(input, { signal: new AbortController().signal })
    expect(guide.show).toHaveBeenCalledWith(input)
    expect(agentActivityFor(engine).snapshot()).toMatchObject({ changedParameters: [], lastAction: { summary: '1 guide steps shown' } })
    registration.dispose()
    await expect(show.execute(input, { signal: new AbortController().signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(guide.show).toHaveBeenCalledTimes(1)
  })
})
