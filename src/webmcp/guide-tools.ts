import type { UiGuideController } from '../ui/guide'

export type GuideService = Pick<UiGuideController, 'show' | 'listTargets'>

/**
 * The "one call gets everything" property has to sit on the property an agent
 * is filling in, not only in the prose: in the teaching eval both models paged
 * 259 targets 20 at a time — six lookups for Claude, fourteen for Codex —
 * because `format` read as a mere formatting flag. Same fix, same wording, as
 * `GROUP_FILTER_DESCRIPTION` in tools.ts.
 */
const FORMAT_DESCRIPTION = '`compact` returns every match, one `id type label` line each, in one call - no limit, no paging. A trailing `(hidden)` means that target\'s panel or tab has to be opened first. `full` (the default) returns objects, 5 per page.'

export function createGuideTools(guide: GuideService, lifecycle: AbortSignal): WebMCP.ModelContextTool[] {
  const check = (options?: WebMCP.ToolExecuteCallbackOptions) => {
    if (lifecycle.aborted || options?.signal?.aborted) throw new DOMException('Guide request cancelled', 'AbortError')
  }
  return [{
    name: 'get_ui_targets',
    description: 'Step 1 of teaching, for when someone asks how to do something themselves: find the control to point at instead of changing it for them. Returns the mounted panels, tabs, parameters, sources, and buttons by semantic ID, label, type, and visibility. Pass a returned ID to show_ui_guide, or give that tool a precise CSS selector scoped to the app and its overlays.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        format: { type: 'string', enum: ['full', 'compact'], description: FORMAT_DESCRIPTION },
        search: { type: 'string', minLength: 1, maxLength: 100, description: 'Case-insensitive substring over id, label, and type; usually skip it.' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Full-format page size (default 5); `format: "compact"` needs none.' }
      }
    },
    annotations: { readOnlyHint: true },
    execute(input, options) { check(options); return guide.listTargets(input) }
  }, {
    name: 'show_ui_guide',
    description: 'Step 2 of teaching: when someone asks how to do something themselves, highlight the real controls on their own screen instead of changing the patch for them or describing it in words. Up to 20 sequential steps of interactive highlights and safe CommonMark. Returns immediately; the human then uses Next/Previous/Done/Close. Never changes sound or activates tabs. Replaces the active guide; `steps: []` clears it.',
    inputSchema: {
      type: 'object', required: ['steps'], additionalProperties: false,
      properties: { steps: {
        type: 'array', maxItems: 20,
        description: 'Sequential steps, each with at most ONE target. Omit title and markdown for a highlight only; for an action spanning two elements, use two linked steps that name the next target.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            target: { type: 'object', additionalProperties: false, minProperties: 1, maxProperties: 1,
              description: 'One semantic ID from get_ui_targets, or one CSS selector matching a single visible element in the app or its overlays. Omit for text only; an unavailable target still shows its instructions, with a warning.',
              properties: {
                id: { type: 'string', minLength: 1, maxLength: 160 },
                selector: { type: 'string', minLength: 1, maxLength: 512 }
              } },
            title: { type: 'string', minLength: 1, maxLength: 120 },
            markdown: { type: 'string', minLength: 1, maxLength: 4000 }
          }, minProperties: 1
        }
      } }
    },
    annotations: { readOnlyHint: false },
    execute(input, options) { check(options); return guide.show(input) }
  }]
}
