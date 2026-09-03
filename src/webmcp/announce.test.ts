// @vitest-environment jsdom
/**
 * The page is coSynth's only agent documentation, so these tests guard the two
 * paths an agent actually has — a DOM snapshot and a text extraction — and the
 * one fact that rots on its own: the tool list.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SynthEngine } from '../audio/engine'
import { defaultValues } from '../shared/params'
import { DEFAULT_FX_ORDER, MAX_MOD_SLOTS, defaultLfoShape, type ModSlotState } from '../shared/messages'
import { HistoryStore } from '../history/store'
import { PerformanceManager } from '../history/performance'
import { ReplayStore } from '../history/replays'
import { createWebMcpTools } from './tools'
import { createHistoryTools } from './history-tools'
import { createGuideTools, type GuideService } from './guide-tools'
import {
  AGENT_BRIEF_ID,
  AGENT_BRIEF_JSON_ID,
  ANNOUNCED_TOOL_NAMES,
  announceAgentSurface,
  announcementDescriptor,
  announcementText,
  MATCHING_WORKFLOW
} from './announce'

/** Enough of a SynthEngine to build the descriptors; none of them are called. */
function fakeEngine(): SynthEngine {
  return {
    onPatchChange: vi.fn(() => () => {}),
    values: defaultValues(),
    modSlots: new Array(MAX_MOD_SLOTS).fill(null) as (ModSlotState | null)[],
    lfoShapes: Array.from({ length: 8 }, () => defaultLfoShape()),
    fxOrder: DEFAULT_FX_ORDER.slice(),
    running: false,
    ctx: { sampleRate: 48000 },
    scopeL: new Float32Array(4),
    scopeR: new Float32Array(4),
    voiceCount: 0,
    peakL: 0,
    peakR: 0,
    heldNotes: new Set<number>(),
    setParam: vi.fn(),
    setModSlot: vi.fn(),
    noteOn: vi.fn(),
    noteOff: vi.fn(),
    allNotesOff: vi.fn()
  } as unknown as SynthEngine
}

/** Every tool name the app really registers, from the real factories. */
function registeredToolNames(): string[] {
  const lifecycle = new AbortController().signal
  const performance = new PerformanceManager()
  let sound = 0
  const history = new HistoryStore({
    capture: () => sound,
    restore: (value: number) => { sound = value },
    equal: (a, b) => a === b,
    assets: () => [],
    subscribe: () => () => {}
  }, () => performance.stop())
  const replays = new ReplayStore(performance, {
    play: vi.fn(async () => {}),
    showGuide: vi.fn(),
    canPlay: () => true
  })
  const guide = {
    show: vi.fn(() => ({ shown: true, stepCount: 0, warnings: [] })),
    listTargets: vi.fn(() => ({ items: [], total: 0, offset: 0, limit: 5 }))
  } as unknown as GuideService
  return [
    ...createWebMcpTools(fakeEngine(), lifecycle),
    ...createHistoryTools({ history, replays, performance }, lifecycle),
    ...createGuideTools(guide, lifecycle)
  ].map(tool => tool.name)
}

function bareDocument(): Document {
  const doc = document.implementation.createHTMLDocument('coSynth')
  doc.body.innerHTML = '<div id="app"></div>'
  return doc
}

describe('agent announcement', () => {
  it('lands in the page text, which is one of the two things a visiting agent has', () => {
    const doc = bareDocument()
    announceAgentSurface(doc)
    const pageText = doc.body.textContent ?? ''
    expect(pageText).toContain('coSynth agent brief')
    expect(pageText).toContain(announcementText().split('\n')[0])
    for (const line of announcementText().split('\n\n')) {
      for (const part of line.split('\n')) expect(pageText).toContain(part)
    }
  })

  it('stays visible to a text extraction rather than hidden with display:none', () => {
    const doc = bareDocument()
    const section = announceAgentSurface(doc)!
    const style = section.getAttribute('style') ?? ''
    expect(style).not.toMatch(/display\s*:\s*none/)
    expect(style).not.toMatch(/visibility\s*:\s*hidden/)
    expect(style).toMatch(/clip/)
    // Written for agents, so it is kept out of the screen-reader narration;
    // neither a DOM dump nor an innerText extraction honours aria-hidden.
    expect(section.getAttribute('aria-hidden')).toBe('true')
  })

  it('names every tool the app actually registers', () => {
    const registered = registeredToolNames()
    expect(new Set(ANNOUNCED_TOOL_NAMES)).toEqual(new Set(registered))
    const doc = bareDocument()
    announceAgentSurface(doc)
    const pageText = doc.body.textContent ?? ''
    for (const name of registered) expect(pageText, `announcement must name ${name}`).toContain(name)
  })

  it('spells out the sound-matching loop in order', () => {
    expect([...MATCHING_WORKFLOW]).toEqual([
      'analyze_reference_audio', 'render_audio', 'compare_audio', 'update_parameters'
    ])
    const body = announcementText()
    const positions = MATCHING_WORKFLOW.map(name => body.indexOf(`\`${name}\``))
    expect(positions.every(position => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('warns about the false negatives that cost a real session a dozen calls', () => {
    const body = announcementText()
    expect(body).toMatch(/ambient tool list|global or ambient/i)
    expect(body).toMatch(/webmcp` capability|webmcp capability/i)
    expect(body).toMatch(/1024 samples|21 ms/)
    expect(body).toMatch(/localStorage/)
    expect(body).toMatch(/User` optgroup|User optgroup/)
  })

  it('carries a machine-readable twin of the same tool list', () => {
    const doc = bareDocument()
    announceAgentSurface(doc)
    const json = doc.getElementById(AGENT_BRIEF_JSON_ID)!
    expect(json.getAttribute('type')).toBe('application/json')
    const parsed = JSON.parse(json.textContent ?? '{}')
    expect(parsed.agentInterface.tools).toEqual([...ANNOUNCED_TOOL_NAMES])
    expect(parsed).toEqual(announcementDescriptor())
  })

  it('does not duplicate the block when injected twice', () => {
    const doc = bareDocument()
    announceAgentSurface(doc)
    const first = doc.body.textContent ?? ''
    announceAgentSurface(doc)
    expect(doc.querySelectorAll(`#${AGENT_BRIEF_ID}`)).toHaveLength(1)
    expect(doc.querySelectorAll(`#${AGENT_BRIEF_JSON_ID}`)).toHaveLength(1)
    expect(doc.body.textContent).toBe(first)
  })

  it('upgrades the static fallback already in the served HTML instead of adding a second one', () => {
    const doc = bareDocument()
    doc.body.insertAdjacentHTML('beforeend', '<section id="cosynth-agent-brief"><p>static fallback</p></section>')
    announceAgentSurface(doc)
    expect(doc.querySelectorAll('#cosynth-agent-brief')).toHaveLength(1)
    expect(doc.body.textContent).not.toContain('static fallback')
    expect(doc.body.textContent).toContain('coSynth agent brief')
  })

  it('does not throw in a bare document, and no-ops without a body', () => {
    expect(() => announceAgentSurface(bareDocument())).not.toThrow()
    const headless = document.implementation.createHTMLDocument('bare')
    headless.body.remove()
    expect(() => announceAgentSurface(headless)).not.toThrow()
  })
})
