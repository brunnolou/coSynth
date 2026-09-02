/**
 * What a model can see of the teaching tools before it calls one: the name,
 * the description and the input schema.
 *
 * The teaching eval (docs/agent-teaching-eval-prompt.md) put a human question
 * — "how do I make an echo, and how long the sound lasts after I let go" — to
 * both Claude and Codex. Both reached for `get_ui_targets` first and neither
 * touched the patch, but each then spent ten calls hunting for two IDs, six
 * and fourteen `get_ui_targets` lookups respectively, because 259 targets only
 * came 20 at a time. These assertions pin the two descriptor-level fixes.
 */
import { describe, expect, it, vi } from 'vitest'
import { createGuideTools, type GuideService } from './guide-tools'

const bytes = (value: string) => new TextEncoder().encode(value).length

function setup() {
  const guide: GuideService = {
    show: vi.fn(() => ({ shown: true, stepCount: 1, warnings: [] })),
    listTargets: vi.fn(() => ({ items: [], total: 0, offset: 0, limit: 5 }))
  } as unknown as GuideService
  const tools = createGuideTools(guide, new AbortController().signal)
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  const schemaOf = (name: string) => (byName.get(name)!.inputSchema as any)
  const descriptionOf = (name: string) => String(byName.get(name)!.description)
  /** The half a truncating client renders first. */
  const leadOf = (name: string) => descriptionOf(name).split(/(?<=\.)\s/)[0] ?? ''
  return { guide, tools, byName, schemaOf, descriptionOf, leadOf }
}

describe('teaching tool descriptors', () => {
  it('advertises a compact format that returns the whole target space in one call', () => {
    const { schemaOf } = setup()
    const format = schemaOf('get_ui_targets').properties.format
    expect(format?.enum, 'get_ui_targets must advertise a compact format').toContain('compact')
    expect(format?.enum).toContain('full')
    // The "one call is enough" fact has to sit on the property an agent is
    // filling in, the way GROUP_FILTER_DESCRIPTION does for get_parameter_schema:
    // `format: "compact"` otherwise reads as a mere formatting flag.
    expect(format?.description ?? '').toMatch(/one call/i)
    // `limit` stays optional and unmentioned as a requirement for compact.
    expect(schemaOf('get_ui_targets').required).toBeUndefined()
  })

  it('leads with the occasion for teaching rather than the mechanism', () => {
    const { leadOf } = setup()
    // A human asking how to do something themselves.
    expect(leadOf('get_ui_targets')).toMatch(/asks?|asking/i)
    expect(leadOf('get_ui_targets')).toMatch(/themsel(f|ves)|their own/i)
    // Showing beats doing, and beats describing in words.
    expect(leadOf('show_ui_guide')).toMatch(/instead of|rather than/i)
    expect(leadOf('show_ui_guide')).toMatch(/words|describing/i)
  })

  it('keeps both descriptors inside the per-tool listing budget', () => {
    const { descriptionOf, leadOf, byName } = setup()
    for (const name of ['get_ui_targets', 'show_ui_guide']) {
      // Same ceilings the twelve core tools are held to in tools.test.ts.
      expect(bytes(descriptionOf(name)), `${name} description`).toBeLessThanOrEqual(600)
      expect(bytes(leadOf(name)), `${name} lead sentence`).toBeLessThanOrEqual(200)
    }
    // These two tools were 1710 B of listing before compact mode; naming the
    // occasion and documenting `format` on the property itself costs ~800 B,
    // most of it schema rather than the prose a truncating client renders
    // first. That is the whole allowance - the next addition has to trade.
    const listing = [...byName.values()].map(tool =>
      ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
    expect(bytes(JSON.stringify(listing))).toBeLessThanOrEqual(2600)
  })

  it('passes the format through to the controller unchanged', async () => {
    const { guide, byName } = setup()
    const input = { format: 'compact' }
    await byName.get('get_ui_targets')!.execute(input, { signal: new AbortController().signal })
    expect(guide.listTargets).toHaveBeenCalledWith(input)
  })
})
