import { describe, expect, it } from 'vitest'
import { SynthEngine } from '../audio/engine'
import { loadLegacyWebMcp, registerLegacyWebMcpTools, resolveModelContext, type LegacyWebMcp } from './legacy'

describe('registerLegacyWebMcpTools', () => {
  it('adapts tool descriptors to the webmcp.dev widget and disconnects on disposal', async () => {
    const calls: Array<{ name: string, execute: (input: Record<string, unknown>) => unknown | Promise<unknown> }> = []
    let disconnected = 0
    const legacy: LegacyWebMcp = {
      registerTool(name, _description, _schema, execute) { calls.push({ name, execute }) },
      disconnect() { disconnected++ }
    }
    const registration = registerLegacyWebMcpTools(new SynthEngine(), legacy, { audioTools: 'exclude' })
    await registration.ready
    expect(calls).toHaveLength(10)
    expect(calls.map(call => call.name)).toContain('get_synth_state')
    await expect(calls.find(call => call.name === 'update_parameters')!.execute({ updates: [{ id: 'missing', value: 1 }] }))
      .resolves.toMatchObject({ ok: false, error: { code: 'tool_error', message: expect.stringContaining("Unknown parameter 'missing'") } })
    registration.dispose()
    expect(disconnected).toBe(1)
    await expect(Promise.resolve().then(() => calls[0].execute({}))).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('counts every tool when the widget exposes no availableTools map', async () => {
    const legacy: LegacyWebMcp = { registerTool() {} }
    const registration = registerLegacyWebMcpTools(new SynthEngine(), legacy, { audioTools: 'exclude' })
    await registration.ready
    expect(registration.registeredCount).toBe(10)
    expect(registration.errors).toEqual([])
  })

  it('does not count a tool the widget rejects by throwing', async () => {
    const legacy: LegacyWebMcp = {
      availableTools: new Map<string, unknown>(),
      registerTool(name) {
        if (name === 'get_synth_state') throw new Error('widget refused the tool')
        legacy.availableTools!.set(name, {})
      }
    }
    const registration = registerLegacyWebMcpTools(new SynthEngine(), legacy, { audioTools: 'exclude' })
    await registration.ready
    expect(registration.registeredCount).toBe(9)
    expect(registration.errors).toEqual([{ tool: 'get_synth_state', message: 'widget refused the tool' }])
  })

  it('does not count a tool the widget silently drops from availableTools', async () => {
    // The real widget's registerTool returns void and only console.error()s on
    // failure, so the only honest signal is whether the name landed in its map.
    const legacy: LegacyWebMcp = {
      availableTools: new Map<string, unknown>(),
      registerTool(name) {
        if (name === 'update_parameters') return
        legacy.availableTools!.set(name, {})
      }
    }
    const registration = registerLegacyWebMcpTools(new SynthEngine(), legacy, { audioTools: 'exclude' })
    await registration.ready
    expect(registration.registeredCount).toBe(9)
    expect(registration.errors).toHaveLength(1)
    expect(registration.errors[0].tool).toBe('update_parameters')
    expect(registration.errors[0].message).toContain('update_parameters')
  })

  it('does not count a tool an async widget build rejects', async () => {
    // Some widget builds return a promise from registerTool. Dropping that
    // return value would count a rejected tool as registered and leak an
    // unhandled rejection, so the adapter has to hand it back to the caller.
    const legacy: LegacyWebMcp = {
      availableTools: new Map<string, unknown>(),
      registerTool(name) {
        if (name === 'get_synth_state') return Promise.reject(new Error('widget refused the tool'))
        legacy.availableTools!.set(name, {})
        return Promise.resolve()
      }
    }
    const registration = registerLegacyWebMcpTools(new SynthEngine(), legacy, { audioTools: 'exclude' })
    await registration.ready
    expect(registration.registeredCount).toBe(9)
    expect(registration.errors).toEqual([{ tool: 'get_synth_state', message: 'widget refused the tool' }])
  })

  it('waits for an async widget to populate availableTools before counting', async () => {
    const legacy: LegacyWebMcp = {
      availableTools: new Map<string, unknown>(),
      registerTool(name) {
        return Promise.resolve().then(() => { legacy.availableTools!.set(name, {}) })
      }
    }
    const registration = registerLegacyWebMcpTools(new SynthEngine(), legacy, { audioTools: 'exclude' })
    await registration.ready
    expect(registration.errors).toEqual([])
    expect(registration.registeredCount).toBe(10)
  })
})

describe('resolveModelContext', () => {
  const current = {} as WebMCP.ModelContext
  const deprecated = {} as WebMCP.ModelContext

  it('prefers the current document.modelContext entry point', () => {
    expect(resolveModelContext({ modelContext: current }, { modelContext: deprecated })).toBe(current)
  })

  it('falls back to the deprecated navigator spelling for Chrome 146-149 builds', () => {
    expect(resolveModelContext({}, { modelContext: deprecated })).toBe(deprecated)
  })

  it('reports no entry point when neither surface exists', () => {
    expect(resolveModelContext({}, {})).toBeUndefined()
  })
})

describe('vendored legacy widget', () => {
  // Guards the bug this fallback originally shipped with: the widget's
  // published IIFE build exposes no export at all, so nothing could construct it.
  it('default-exports a constructor', async () => {
    const { default: LegacyWidget } = await import('../vendor/webmcp-widget.js')
    expect(typeof LegacyWidget).toBe('function')
  })

  it('loadLegacyWebMcp resolves instead of rejecting when the widget cannot initialise', async () => {
    // Without a DOM the widget constructor throws; the loader must swallow that
    // so a failed fallback can never block synth startup.
    await expect(loadLegacyWebMcp()).resolves.not.toBeUndefined()
  })
})
