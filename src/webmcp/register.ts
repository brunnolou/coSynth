import type { SynthEngine } from '../audio/engine'
import { createWebMcpTools } from './tools'

export interface WebMcpRegistration {
  ready: Promise<void>
  dispose(): void
}

export interface WebMcpRegistrationOptions {
  audioTools?: 'include' | 'exclude' | 'only'
}

const AUDIO_TOOL_NAMES = new Set(['play_notes', 'render_audio'])

function registeredTool(tool: WebMCP.ModelContextTool): WebMCP.ModelContextTool {
  const execute = tool.execute
  return {
    ...tool,
    async execute(input, options) {
      try {
        return await execute(input, options)
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error
        return {
          ok: false,
          error: {
            code: error instanceof Error && error.name !== 'Error' ? error.name : 'tool_error',
            message: error instanceof Error ? error.message : 'The tool could not complete the request'
          }
        }
      }
    }
  }
}

/** Register WebMCP as a progressive enhancement with one abortable lifecycle. */
export function registerWebMcpTools(
  engine: SynthEngine,
  modelContext: WebMCP.ModelContext | undefined = typeof document === 'undefined' ? undefined : document.modelContext,
  options: WebMcpRegistrationOptions = {}
): WebMcpRegistration {
  const controller = new AbortController()
  if (!modelContext) {
    return { ready: Promise.resolve(), dispose: () => controller.abort() }
  }

  const audioTools = options.audioTools ?? 'include'
  const tools = createWebMcpTools(engine, controller.signal)
    .filter(tool => audioTools === 'include' || (audioTools === 'only') === AUDIO_TOOL_NAMES.has(tool.name))
    .map(registeredTool)
  const registrations = tools.map(tool => {
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
