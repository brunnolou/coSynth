import type { SynthEngine } from '../audio/engine'
import { createWebMcpTools } from './tools'

export interface WebMcpRegistration {
  ready: Promise<void>
  dispose(): void
}

/** Register WebMCP as a progressive enhancement with one abortable lifecycle. */
export function registerWebMcpTools(
  engine: SynthEngine,
  modelContext: WebMCP.ModelContext | undefined = typeof document === 'undefined' ? undefined : document.modelContext
): WebMcpRegistration {
  const controller = new AbortController()
  if (!modelContext) {
    return { ready: Promise.resolve(), dispose: () => controller.abort() }
  }

  const registrations = createWebMcpTools(engine, controller.signal).map(tool => {
    try {
      return Promise.resolve(modelContext.registerTool(tool, { signal: controller.signal }))
        .catch(error => console.warn(`WebMCP tool registration failed (${tool.name}):`, error))
    } catch (error) {
      console.warn(`WebMCP tool registration failed (${tool.name}):`, error)
      return Promise.resolve()
    }
  })

  return {
    ready: Promise.all(registrations).then(() => undefined),
    dispose: () => controller.abort()
  }
}
