/**
 * The page as its own agent documentation.
 *
 * coSynth ships as a static site, so a visiting agent has no repository to
 * read: no AGENTS.md, no CLAUDE.md, no README. The only two things such an
 * agent reliably has are a DOM snapshot and a text extraction of the page, and
 * in one observed session an agent had both and still concluded coSynth
 * exposed no model context at all — it grepped an ambient tool list, found
 * nothing, probed a tab in an external browser whose context has no `webmcp`
 * capability, got a confident false negative, and gave up.
 *
 * So the brief is plain prose in the document body, visually hidden by
 * clipping rather than by `display: none` (which would strip it from both an
 * `innerText` extraction and most accessibility-tree dumps), plus a JSON
 * descriptor in a `<script type="application/json">` for anything that parses
 * rather than reads. Nothing here needs JavaScript evaluation to be found,
 * which is the whole point.
 */

/** The id both the static markup in `index.html` and this module own. */
export const AGENT_BRIEF_ID = 'cosynth-agent-brief'

/** The id of the machine-readable twin of the prose. */
export const AGENT_BRIEF_JSON_ID = 'cosynth-agent-tools'

/**
 * Every tool coSynth registers, in registration order: the thirteen synth tools
 * from `createWebMcpTools`, the four from `createHistoryTools`, and the two
 * from `createGuideTools`.
 *
 * Hardcoded on purpose. Importing the real factories would pull the audio
 * engine, the offline renderer and the analysis worker into the startup path
 * of a module whose only job is to write text into the document. The drift
 * risk that buys is paid for in `announce.test.ts`, which builds the real tool
 * sets and fails if this list stops matching them.
 */
export const ANNOUNCED_TOOL_NAMES = [
  'get_synth_state',
  'get_parameter_schema',
  'update_parameters',
  'set_modulation',
  'play_notes',
  'render_audio',
  'analyze_audio',
  'analyze_reference_audio',
  'compare_audio',
  'suggest_patch',
  'save_preset',
  'load_preset',
  'list_presets',
  'get_history',
  'navigate_history',
  'replay_history',
  'stop_performance',
  'get_ui_targets',
  'show_ui_guide'
] as const

/** The sound-matching loop, named in the order an agent should run it. */
export const MATCHING_WORKFLOW = [
  'analyze_reference_audio',
  'render_audio',
  'compare_audio',
  'update_parameters'
] as const

/**
 * The traps that cost a real session about a dozen tool calls. Each one is a
 * false negative an agent can reach honestly, so each says what the wrong
 * conclusion looks like as well as what is true.
 */
export const AGENT_PITFALLS: readonly { title: string; body: string }[] = [
  {
    title: 'These are page-scoped tools, so an ambient tool list will not list them.',
    body: 'They are registered on this document through `document.modelContext.registerTool` (older builds: `navigator.modelContext`). They never appear in a global or ambient tool inventory, so filtering your own tool list for "synth", "preset", "oscillator" or "audio" returns an empty array whether or not coSynth is present. An empty grep proves nothing here — list the tools the page offers instead.'
  },
  {
    title: 'The tools live on the tab, so claim the tab in a context that has the `webmcp` capability.',
    body: 'A tab you claimed in an external browser may report no model context on this exact URL, because that browsing context does not expose the `webmcp` capability at all. `{"hasMC":false,"keys":[],"ai":false}` from a raw CDP probe means "wrong context", not "no tools". Open the same URL in a WebMCP-capable browser context and probe again before concluding anything.'
  },
  {
    title: '`analyze_audio({"source":"scope"})` reads about 21 ms of live output.',
    body: 'The scope buffer is 1024 samples of whatever is sounding at that instant, so it is silence unless a note is ringing right now. Anything about attack, decay, release or the shape of a tail needs `render_audio`, which renders offline, needs no user gesture, and returns metrics for the whole note.'
  },
  {
    title: 'Presets are saved to browser localStorage, not to a folder on disk.',
    body: '`save_preset` writes into this browser profile\'s localStorage and the patch then appears under the `User` optgroup of the preset select in the UI. There is no file, no path and no folder to point anyone at. `list_presets` is the way to prove a save happened.'
  }
]

/** The one call that hands over the whole parameter space in a single round trip. */
const START_HERE = 'Start with `get_parameter_schema({"format":"compact"})`: one unfiltered call returns every parameter as one line each, which is cheaper than paging or guessing search terms. `get_synth_state({"format":"compact"})` then returns every parameter that differs from its default.'

const INTRO = 'coSynth is a browser wavetable synthesizer that exposes the same live engine its UI drives to AI agents as WebMCP tools. If you are an AI agent reading this page, those tools are the supported way to control it — prefer them over automating the on-screen knobs.'

const PLAYBACK_NOTE = '`play_notes` plays through the speakers and only works after a human has clicked CLICK TO START AUDIO; it is registered from page load either way. `render_audio` needs no gesture, so a sound can be designed and measured before anyone starts audio.'

/** The prose block, as an ordered list of headed sections. */
export function announcementSections(): readonly { title: string; body: string }[] {
  return [
    { title: 'What this page offers an agent', body: INTRO },
    {
      title: `WebMCP tools registered by this page (${ANNOUNCED_TOOL_NAMES.length})`,
      body: `${ANNOUNCED_TOOL_NAMES.join(', ')}.`
    },
    {
      title: 'Sound-matching workflow',
      body: `To match a reference sound, call ${MATCHING_WORKFLOW.map(name => `\`${name}\``).join(' → ')}, then repeat that loop. ` +
        'By default `compare_audio` renders the candidate at the reference\'s own detected pitch and returns a signed diff with ranked parameter moves; `suggest_patch` re-reads those moves without paying for another render. ' +
        'Each `compare_audio` result carries a `progress` block with the best similarity so far against this reference, so stop when it reports a plateau rather than editing past your own best patch.'
    },
    { title: 'Where to start', body: `${START_HERE} ${PLAYBACK_NOTE}` },
    ...AGENT_PITFALLS
  ]
}

/** The full brief as one string; the same text the injected block carries. */
export function announcementText(): string {
  return announcementSections().map(section => `${section.title}\n${section.body}`).join('\n\n')
}

/** The machine-readable twin: same facts, no prose parsing required. */
export function announcementDescriptor() {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'coSynth',
    applicationCategory: 'MultimediaApplication',
    description: INTRO,
    agentInterface: {
      protocol: 'WebMCP',
      registration: 'document.modelContext.registerTool (fallback: navigator.modelContext)',
      scope: 'page',
      tools: [...ANNOUNCED_TOOL_NAMES],
      soundMatchingWorkflow: [...MATCHING_WORKFLOW],
      startHere: 'get_parameter_schema({"format":"compact"})',
      notes: AGENT_PITFALLS.map(pitfall => `${pitfall.title} ${pitfall.body}`)
    }
  }
}

/**
 * Hidden from sighted layout, kept in the text extraction. `display: none` and
 * `visibility: hidden` both remove an element from `innerText` and from the
 * accessibility tree; clipping keeps it in both, which is exactly the property
 * this block is here for.
 */
const HIDDEN_STYLE = [
  'position:absolute',
  'width:1px',
  'height:1px',
  'margin:-1px',
  'padding:0',
  'border:0',
  'overflow:hidden',
  'clip:rect(0 0 0 0)',
  'clip-path:inset(50%)',
  'white-space:normal'
].join(';')

function text(doc: Document, tag: string, value: string): HTMLElement {
  const element = doc.createElement(tag)
  element.textContent = value
  return element
}

/**
 * Write (or rewrite) the agent brief into `doc`. Idempotent: the block is
 * addressed by id, so calling this twice — or calling it over the static
 * fallback already in `index.html` — replaces the contents instead of adding a
 * second copy.
 *
 * Returns the block, or `null` when the document has no body to write into.
 */
export function announceAgentSurface(doc: Document = document): HTMLElement | null {
  const body = doc.body
  if (!body) return null

  let section = doc.getElementById(AGENT_BRIEF_ID)
  if (!section) {
    section = doc.createElement('section')
    section.id = AGENT_BRIEF_ID
    body.append(section)
  }
  section.replaceChildren()
  section.setAttribute('data-agent-brief', 'cosynth')
  section.setAttribute('style', HIDDEN_STYLE)
  // The brief is written for agents, and a screen-reader user has the real UI.
  // Reading a wall of tool names to them would be noise, and `aria-hidden`
  // costs nothing here because neither a DOM snapshot nor a text extraction
  // honours it.
  section.setAttribute('aria-hidden', 'true')

  section.append(text(doc, 'h2', 'coSynth agent brief'))
  for (const entry of announcementSections()) {
    section.append(text(doc, 'h3', entry.title))
    section.append(text(doc, 'p', entry.body))
  }

  const json = doc.createElement('script')
  json.id = AGENT_BRIEF_JSON_ID
  json.type = 'application/json'
  json.textContent = JSON.stringify(announcementDescriptor(), null, 2)
  section.append(json)

  return section
}
