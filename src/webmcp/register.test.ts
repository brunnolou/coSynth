import { describe, expect, it, vi } from 'vitest'
import { registerWebMcpTools } from './register'
import { agentActivityFor } from './activity'
import type { SynthEngine } from '../audio/engine'

const engine = {} as SynthEngine

function context(registerTool: (tool: WebMCP.ModelContextTool, options?: WebMCP.ModelContextRegisterToolOptions) => Promise<void> | void) {
  return { registerTool } as unknown as WebMCP.ModelContext
}

describe('registerWebMcpTools', () => {
  it('is a harmless no-op when WebMCP is unavailable', async () => {
    const registration = registerWebMcpTools(engine, undefined)
    await expect(registration.ready).resolves.toBeUndefined()
    expect(() => registration.dispose()).not.toThrow()
  })

  it('registers each of the eleven tools exactly once with a shared lifecycle signal', async () => {
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
      'analyze_reference_audio', 'compare_audio', 'save_preset', 'load_preset'
    ])
    expect(new Set(calls.map(call => call.signal)).size).toBe(1)
    expect(calls[0].signal?.aborted).toBe(false)
    registration.dispose()
    expect(calls[0].signal?.aborted).toBe(true)
  })

  it('can expose safe tools before audio and audio tools only after startup', async () => {
    const names: string[] = []
    const modelContext = context(tool => { names.push(tool.name) })
    await registerWebMcpTools(engine, modelContext, { audioTools: 'exclude' }).ready
    expect(names).not.toContain('play_notes')
    expect(names).not.toContain('render_audio')
    expect(names).toHaveLength(9)

    names.length = 0
    await registerWebMcpTools(engine, modelContext, { audioTools: 'only' }).ready
    expect(names).toEqual(['play_notes', 'render_audio'])
  })

  it('returns actionable expected errors while preserving cancellation semantics', async () => {
    const calls: WebMCP.ModelContextTool[] = []
    const modelContext = context(tool => { calls.push(tool) })
    await registerWebMcpTools(engine, modelContext).ready

    const update = calls.find(tool => tool.name === 'update_parameters')!
    await expect(update.execute({ updates: [{ id: 'missing', value: 1 }] }, { signal: new AbortController().signal }))
      .resolves.toEqual({ ok: false, error: { code: 'tool_error', message: 'Unknown parameter: missing' } })
    expect(agentActivityFor(engine).snapshot().lastAction).toMatchObject({
      tool: 'update_parameters', status: 'failed', summary: 'Unknown parameter: missing'
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

    await expect(registerWebMcpTools(engine, modelContext).ready).resolves.toBeUndefined()
    expect(attempted).toHaveLength(11)
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
