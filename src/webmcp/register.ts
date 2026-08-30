import type { SynthEngine } from '../audio/engine'
import { agentActivityFor, type AgentActivityStore } from './activity'
import { createWebMcpTools } from './tools'
import { createGuideTools, type GuideService } from './guide-tools'
import { createHistoryTools } from './history-tools'
import type { AppHistoryServices } from '../history/services'
import { validateGuide } from '../ui/guide'

export interface WebMcpRegistration {
  ready: Promise<void>
  readonly registeredCount: number
  dispose(): void
}

export interface WebMcpRegistrationOptions {
  audioTools?: 'include' | 'exclude' | 'only'
  guide?: GuideService
  services?: AppHistoryServices
}

const AUDIO_TOOL_NAMES = new Set(['play_notes', 'render_audio'])

function registeredTool(tool: WebMCP.ModelContextTool, activity: AgentActivityStore, services?: AppHistoryServices): WebMCP.ModelContextTool {
  const execute = tool.execute
  return {
    ...tool,
    async execute(input, options) {
      const actionId = activity.startAction(tool.name)
      try {
        const changesSound = ['update_parameters', 'set_modulation', 'load_preset'].includes(tool.name)
        const result = await (changesSound && services
          ? services.history.runAi(tool.name.replaceAll('_', ' '), () => execute(input, options))
          : execute(input, options))
        if (tool.name === 'show_ui_guide' && services && (result as { shown?: boolean })?.shown) services.replays.addGuide(validateGuide(input))
        activity.finishAction(actionId, tool.name, input, result)
        return result
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          activity.failAction(actionId, tool.name, error)
          throw error
        }
        const result = {
          ok: false,
          error: {
            code: error instanceof Error && error.name !== 'Error' ? error.name : 'tool_error',
            message: error instanceof Error ? error.message : 'The tool could not complete the request',
            ...((error as { retryable?: boolean })?.retryable ? { retryable: true } : {})
          }
        }
        activity.finishAction(actionId, tool.name, input, result)
        return result
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
    return { ready: Promise.resolve(), registeredCount: 0, dispose: () => controller.abort() }
  }

  const audioTools = options.audioTools ?? 'include'
  const activity = agentActivityFor(engine)
  let registeredCount = 0
  const services = options.services
  const tools = [...createWebMcpTools(engine, controller.signal, services ? {
    performance: services.performance, replays: services.replays,
    currentSoundEntryId: () => services.history.snapshot().currentId,
    onComparison: (comparison, entryId) => services.history.attachComparison(comparison, entryId)
  } : {}), ...(options.guide ? createGuideTools(options.guide, controller.signal) : []),
    ...(services ? createHistoryTools(services, controller.signal) : [])]
    .filter(tool => audioTools === 'include' || (audioTools === 'only') === AUDIO_TOOL_NAMES.has(tool.name))
    .map(tool => registeredTool(tool, activity, services))
  const registrations = tools.map(tool => {
    try {
      return Promise.resolve(modelContext.registerTool(tool, { signal: controller.signal }))
        .then(() => { if (!controller.signal.aborted) registeredCount++ })
        .catch(error => console.warn(`WebMCP tool registration failed (${tool.name}):`, error))
    } catch (error) {
      console.warn(`WebMCP tool registration failed (${tool.name}):`, error)
      return Promise.resolve()
    }
  })

  return {
    ready: Promise.all(registrations).then(() => undefined),
    get registeredCount() { return registeredCount },
    dispose: () => controller.abort()
  }
}
