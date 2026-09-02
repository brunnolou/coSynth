import type { SynthEngine } from '../audio/engine'
import { registerWebMcpTools, type WebMcpRegistration, type WebMcpRegistrationOptions } from './register'

/** The API exposed by the legacy WebMCP widget from webmcp.dev. */
export interface LegacyWebMcp {
  /**
   * Widget builds differ: most return void, some return a promise that settles
   * once the tool reaches the bridge. Either way the return value is the only
   * channel a failure can travel on besides a synchronous throw, so the adapter
   * awaits whatever comes back.
   */
  registerTool(name: string, description: string, schema: object, execute: (input: Record<string, unknown>) => unknown | Promise<unknown>): void | Promise<void>
  /**
   * The widget's own registry of accepted tools. `registerTool` returns void and
   * only `console.error`s on failure, so this map is the one honest signal that
   * a tool was taken. Optional: older widget builds and test fakes lack it, and
   * when it is absent we cannot tell success from failure, so we assume success.
   */
  availableTools?: Map<string, unknown>
  disconnect?(): void
}

function abortError(): DOMException {
  return new DOMException('The WebMCP lifecycle has ended', 'AbortError')
}

/** Adapt the pre-standard WebMCP widget to the current tool descriptors. */
export function registerLegacyWebMcpTools(
  engine: SynthEngine,
  legacy: LegacyWebMcp,
  options: WebMcpRegistrationOptions = {}
): WebMcpRegistration {
  const modelContext = {
    registerTool(tool: WebMCP.ModelContextTool, registrationOptions?: WebMCP.ModelContextRegisterToolOptions) {
      const signal = registrationOptions?.signal ?? new AbortController().signal
      if (signal?.aborted) throw abortError()
      const accepted = legacy.registerTool(tool.name, tool.description, tool.inputSchema ?? { type: 'object', properties: {} }, input => {
        if (signal?.aborted) throw abortError()
        return tool.execute(input, { signal })
      })
      // The widget swallows its own failures, so count a tool as registered only
      // once its name shows up in the widget's registry. An async build settles
      // that registry after it resolves, so check only once the call is done.
      const verify = () => {
        if (legacy.availableTools && !legacy.availableTools.has(tool.name)) {
          throw new Error(`The legacy WebMCP widget did not accept the tool ${tool.name}`)
        }
      }
      if (accepted && typeof (accepted as PromiseLike<void>).then === 'function') return Promise.resolve(accepted).then(verify)
      verify()
    }
  } as unknown as WebMCP.ModelContext
  const registration = registerWebMcpTools(engine, modelContext, options)
  return {
    ready: registration.ready,
    get registeredCount() { return registration.registeredCount },
    get available() { return registration.available },
    get pending() { return registration.pending },
    get errors() { return registration.errors },
    dispose: () => {
      registration.dispose()
      legacy.disconnect?.()
    }
  }
}

/**
 * Resolve the WebMCP entry point. The 2026-07-21 draft moved it from
 * `navigator` to `document`, but Chrome 146-149 origin-trial builds still only
 * expose the navigator spelling, so accept either.
 */
export function resolveModelContext(
  doc: { modelContext?: WebMCP.ModelContext } | undefined = typeof document === 'undefined' ? undefined : document,
  nav: { modelContext?: WebMCP.ModelContext } | undefined = typeof navigator === 'undefined' ? undefined : navigator
): WebMCP.ModelContext | undefined {
  return doc?.modelContext ?? nav?.modelContext
}

/**
 * Lazily load the vendored legacy webmcp.dev widget. Only called when no native
 * WebMCP entry point exists, so browsers on the standard path never fetch it.
 */
export async function loadLegacyWebMcp(): Promise<LegacyWebMcp | null> {
  try {
    const { default: LegacyWidget } = await import('../vendor/webmcp-widget.js')
    return new LegacyWidget()
  } catch (error) {
    console.warn('Legacy WebMCP widget could not be loaded:', error)
    return null
  }
}
