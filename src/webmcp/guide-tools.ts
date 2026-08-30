import type { UiGuideController } from '../ui/guide'

export type GuideService = Pick<UiGuideController, 'show' | 'listTargets'>

export function createGuideTools(guide: GuideService, lifecycle: AbortSignal): WebMCP.ModelContextTool[] {
  const check = (options?: WebMCP.ToolExecuteCallbackOptions) => {
    if (lifecycle.aborted || options?.signal?.aborted) throw new DOMException('Guide request cancelled', 'AbortError')
  }
  return [{
    name: 'get_ui_targets',
    description: 'Discover currently mounted teaching targets by semantic ID, label, type, and visibility. Search for panels, tabs, parameters, sources, and buttons. Use a returned ID with show_ui_guide, or provide a precise CSS selector scoped to the app and its overlays.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { search: { type: 'string', minLength: 1, maxLength: 100 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }
    },
    annotations: { readOnlyHint: true },
    execute(input, options) { check(options); return guide.listTargets(input) }
  }, {
    name: 'show_ui_guide',
    description: 'Teach using interactive highlights and safe CommonMark instructions. Supply up to 20 sequential steps, each with at most ONE target: a semantic ID or a unique visible CSS selector. For actions involving two elements, create two linked steps and briefly describe the upcoming target. Omit target for text only; omit title/markdown for highlight only. Returns immediately; the human uses Next/Previous/Done/Close. Never changes sound or activates tabs. Replaces the active guide; steps: [] clears it. Missing targets display instructions with a warning.',
    inputSchema: {
      type: 'object', required: ['steps'], additionalProperties: false,
      properties: { steps: { type: 'array', maxItems: 20, items: {
        type: 'object', additionalProperties: false,
        properties: {
          target: { type: 'object', additionalProperties: false, minProperties: 1, maxProperties: 1,
            properties: { id: { type: 'string', minLength: 1, maxLength: 160 }, selector: { type: 'string', minLength: 1, maxLength: 512 } } },
          title: { type: 'string', minLength: 1, maxLength: 120 }, markdown: { type: 'string', minLength: 1, maxLength: 4000 }
        }, minProperties: 1
      } } }
    },
    annotations: { readOnlyHint: false },
    execute(input, options) { check(options); return guide.show(input) }
  }]
}
