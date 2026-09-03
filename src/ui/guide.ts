import { driver, type Config, type Driver, type DriveStep } from 'driver.js'
import { micromark } from 'micromark'
import { PARAMS, type ParamDef } from '../shared/params'
import { paramGuideId, paramGuideLabel } from './guide-target'

export type GuideTarget = { id: string; selector?: never } | { selector: string; id?: never }
export interface GuideStep { target?: GuideTarget; title?: string; markdown?: string }
/**
 * `opens` is the plan (what a reveal *would* open), `opened` the receipt (what
 * it did open). They are separate because `show` classifies every step before
 * it drives any of them, and must not open step 5's tab while step 1 is on
 * screen.
 */
type Resolution = { element?: HTMLElement; warning?: string; opens?: string[]; opened?: string[] }
/** One container to open so a target can be seen. */
type Opener = { element: HTMLElement; kind: 'details' | 'tab'; label: string }
interface GuidePresentation { staticOverlay?: boolean; closeOnOverlay?: boolean }
const GUIDE_UI = '.driver-popover, .driver-overlay, #driver-dummy-element'

function object(input: unknown, fields: string[], context: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${context} must be an object`)
  for (const key of Object.keys(input)) if (!fields.includes(key)) throw new Error(`Unknown ${context} field: ${key}`)
  return input as Record<string, unknown>
}

function text(input: unknown, limit: number, context: string): string {
  if (typeof input !== 'string' || !input.trim() || input.length > limit) {
    throw new Error(`${context} must be non-empty text of at most ${limit} characters`)
  }
  return input
}

export function validateGuide(input: unknown): GuideStep[] {
  const value = object(input, ['steps', 'reveal'], 'input')
  if (value.reveal !== undefined && typeof value.reveal !== 'boolean') throw new Error('reveal must be a boolean')
  if (!Array.isArray(value.steps) || value.steps.length > 20) throw new Error('steps must be an array of at most 20 steps; use [] to clear')
  return value.steps.map((item, index) => {
    const step = object(item, ['target', 'title', 'markdown'], `steps[${index}]`)
    const result: GuideStep = {}
    if (step.title !== undefined) result.title = text(step.title, 120, 'title')
    if (step.markdown !== undefined) result.markdown = text(step.markdown, 4000, 'markdown')
    if (step.target !== undefined) {
      const target = object(step.target, ['id', 'selector'], 'target')
      if (Object.keys(target).length !== 1) throw new Error('target must contain exactly one id or selector')
      result.target = target.id !== undefined
        ? { id: text(target.id, 160, 'target.id') }
        : { selector: text(target.selector, 512, 'target.selector') }
    }
    if (!result.target && !result.title && !result.markdown) throw new Error(`steps[${index}] is empty`)
    return result
  })
}

/**
 * Revealing defaults on. A guide that cannot open its own subject fails exactly
 * where it is needed most — on a control the human cannot currently see — and
 * the only recovery is the one a real session had to improvise: find and click
 * the tab yourself, then call the guide again.
 */
export function revealRequested(input: unknown): boolean {
  return (input as { reveal?: boolean } | null | undefined)?.reveal ?? true
}

/** Compile safe CommonMark into an inert fragment, stripping media before insertion. */
export function guideMarkdown(markdown: string, doc: Document = document): DocumentFragment {
  const template = doc.createElement('template')
  template.innerHTML = micromark(markdown, { allowDangerousHtml: false, allowDangerousProtocol: false })
  for (const img of template.content.querySelectorAll('img')) img.replaceWith(doc.createTextNode(img.alt))
  for (const link of template.content.querySelectorAll('a')) {
    const href = link.getAttribute('href') ?? ''
    if (!/^(https?:\/\/|mailto:)/i.test(href)) {
      link.replaceWith(...link.childNodes)
    } else {
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
    }
  }
  return template.content
}

/**
 * Closed `<details>` ancestors between `element` and the document, innermost
 * first. A browser hides these children through the summary slot's
 * `content-visibility`, so they measure as a zero rect rather than as
 * `display: none`; asking the markup directly is both cheaper and the only
 * form that survives jsdom, where nothing has a rect at all.
 */
function collapsedDetails(element: HTMLElement): HTMLDetailsElement[] {
  const closed: HTMLDetailsElement[] = []
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const parent = node.parentElement
    if (parent?.tagName === 'DETAILS' && node.tagName !== 'SUMMARY' && !(parent as HTMLDetailsElement).open) {
      closed.push(parent as HTMLDetailsElement)
    }
  }
  return closed
}

/**
 * Whether a tab is already the selected one. Checked before clicking so that
 * revealing a target that is already on screen — or one whose ID is simply
 * wrong — never switches the tab the human was looking at. ARIA tablists say
 * `aria-selected`; the synth's own sub-tabs mark the live one with `.on`.
 */
function isActiveTab(tab: HTMLElement): boolean {
  return tab.getAttribute('aria-selected') === 'true' || tab.getAttribute('aria-current') === 'true'
    || tab.classList.contains('on')
}

function openerLabel(element: HTMLElement): string {
  return element.dataset.guideId ?? element.dataset.guideLabel
    ?? ((element.textContent ?? '').trim().slice(0, 40) || element.tagName.toLowerCase())
}

function visible(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('dialog:not([open]), [hidden], [inert]')) return false
  if (collapsedDetails(element).length) return false
  const rect = element.getBoundingClientRect()
  if (!rect.width || !rect.height) return false
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
  }
  return true
}

// Driver checks viewport visibility, but the synth scrolls inside <main>.
// Reveal controls clipped by a nested scroll container before Driver measures them.
function revealInScrollContainer(element: HTMLElement): void {
  const rect = element.getBoundingClientRect()
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    const bounds = parent.getBoundingClientRect()
    const clippedY = /(auto|scroll)/.test(style.overflowY) && (rect.top < bounds.top || rect.bottom > bounds.bottom)
    const clippedX = /(auto|scroll)/.test(style.overflowX) && (rect.left < bounds.left || rect.right > bounds.right)
    if (clippedX || clippedY) {
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
      return
    }
  }
}

/**
 * Open every container in `openers`, and report what actually moved.
 *
 * Idempotent by construction: an already-open `<details>` and an already-active
 * tab are skipped, so revealing a target twice is a no-op the second time.
 * Nothing is ever closed — opening a `<details>` leaves its siblings alone, and
 * the only state a tab click replaces is that tab group's own selection, which
 * is what "activate the owning tab" means.
 */
function openAll(openers: Opener[]): string[] {
  const opened: string[] = []
  for (const opener of openers) {
    if (opener.kind === 'details') {
      const details = opener.element as HTMLDetailsElement
      if (details.open) continue
      details.open = true
    } else {
      if (isActiveTab(opener.element)) continue
      opener.element.click()
    }
    opened.push(opener.label)
  }
  return opened
}

/**
 * One teaching target. `visible` and `revealable` describe where it stands;
 * `mounted: false` marks the one row that is not read off an element, because
 * the tab that owns it has not built it yet. Both optional fields are omitted
 * in the state that needs no word for it - visible, and mounted.
 */
export interface GuideTargetInfo {
  id: string
  label: string
  type: string
  visible: boolean
  revealable?: boolean
  mounted?: boolean
}

const DEFAULT_TARGET_PAGE_SIZE = 5

/**
 * The type an unmounted parameter control will have once its tab builds it,
 * predicted from the definition the three control factories already switch on:
 * `paramSelect` takes the enumerated parameters, `paramToggle` the 0..1 step-1
 * ones, and everything else is a `Knob`. Only these three kinds exist for a
 * parameter, and `guide.test.ts` pins the prediction against every parameter
 * an ENV or LFO tab owns - the only ones this is ever asked about.
 */
function predictedParamKind(def: ParamDef): string {
  if (def.choices) return 'select'
  return def.min === 0 && def.max === 1 && def.step === 1 ? 'button' : 'knob'
}

/**
 * Every ID a parameter control carries when it is mounted.
 *
 * `PARAMS` is the registry the controls are built from, so this is a projection
 * of it rather than a second list to keep in step: an id, a label and a type
 * that go stale are ones `knob.ts` and `controls.ts` stopped agreeing with,
 * which is a change to `PARAMS` and to both of them at once.
 */
const PARAM_TARGETS: ReadonlyMap<string, { id: string; label: string; type: string }> =
  new Map(PARAMS.map(def => [paramGuideId(def.id), {
    id: paramGuideId(def.id), label: paramGuideLabel(def), type: predictedParamKind(def)
  }]))

/**
 * One teaching target as a single line: `param.env1.release knob env1 Release`,
 * mirroring `compactParameter` in src/webmcp/tools.ts so the two discovery
 * tools read as one API.
 *
 * Visibility stays on the line — as a trailing ` (hidden)`, the way a compact
 * parameter carries a trailing `mod` — because an agent picking between
 * `tab.env1` and `param.env1.release` needs to know that the knob only exists
 * once its tab is open, before it builds the guide rather than after the human
 * sees the warning. ` (hidden, revealable)` narrows that further: the guide can
 * open this one itself, so it costs the agent nothing but a `show_ui_guide`
 * call. A bare ` (hidden)` is a control the human has to reach on their own.
 *
 * ` (not mounted, revealable)` is the same promise about a control that does
 * not exist yet: its tab rebuilds its knobs on every click, so the row is
 * predicted from the parameter registry rather than read off an element.
 */
export function compactTarget(item: GuideTargetInfo): string {
  const state = item.visible ? ''
    : item.mounted === false ? ' (not mounted, revealable)'
    : item.revealable ? ' (hidden, revealable)' : ' (hidden)'
  return `${item.id} ${item.type} ${item.label}${state}`
}

export class UiGuideController {
  private active: Driver | null = null
  private disposed = false
  private readonly roots: Set<HTMLElement>

  constructor(app: HTMLElement, private readonly createDriver: (config: Config) => Driver = driver) {
    this.roots = new Set([app])
  }

  registerOverlay(root: HTMLElement): () => void {
    this.roots.add(root)
    return () => this.roots.delete(root)
  }

  isActive(): boolean { return this.active?.isActive() ?? false }

  private matches(selector: string): HTMLElement[] {
    const matches = new Set<HTMLElement>()
    // Parsing first also rejects invalid selectors if no roots are currently connected.
    document.createDocumentFragment().querySelector(selector)
    for (const root of this.roots) {
      if (!root.isConnected) continue
      if (root.matches(selector)) matches.add(root)
      for (const element of root.querySelectorAll<HTMLElement>(selector)) matches.add(element)
    }
    return [...matches].filter(element => element instanceof HTMLElement && !element.closest(GUIDE_UI))
  }

  private blockingRoot(): HTMLElement | undefined {
    return this.matches('dialog[open], [data-guide-blocking]').filter(visible).at(-1)
  }

  /**
   * Containers to open so that `element`, which is already in the DOM, can be
   * seen. A walk up from the element itself, so there is no second registry to
   * keep in step with `data-guide-id`.
   */
  private openersFor(element: HTMLElement): Opener[] {
    const openers: Opener[] = collapsedDetails(element).map(details => ({
      element: details, kind: 'details' as const,
      label: openerLabel(details.querySelector<HTMLElement>(':scope > summary') ?? details)
    }))
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      if (node.getAttribute('role') !== 'tabpanel' || !node.hidden || !/^[\w-]+$/.test(node.id)) continue
      const tab = this.matches(`[role="tab"][aria-controls="${node.id}"]`).find(visible)
      if (tab) openers.push({ element: tab, kind: 'tab', label: openerLabel(tab) })
    }
    return openers
  }

  /**
   * Tabs that plausibly own a semantic ID with no DOM node behind it at all.
   *
   * The ENV and LFO knob rows are rebuilt from scratch on every tab click
   * (`renderEnvKnobs` in app.ts), so while ENV 1 is selected `param.env2.decay`
   * has no element to walk up from — which is what "Target unavailable" meant
   * for the IDs that started this. The link is the group segment the two IDs
   * already share (`env2` in `param.env2.decay` and in `tab.env2`), read out of
   * the same `data-guide-id` registry the target itself comes from.
   *
   * It is inference, so it can be wrong: `param.env2.nonsense` also "matches"
   * `tab.env2`. Nothing is claimed on the strength of it — the caller opens the
   * tab, looks again, and reports whatever it actually finds.
   */
  private owningTabs(id: string, tabs = this.inactiveTabs()): HTMLElement[] {
    const parts = new Set(id.split('.').filter(part => part && part !== 'tab'))
    return tabs
      .filter(tab => (tab.dataset.guideId ?? '').split('.').some(part => part !== 'tab' && parts.has(part)))
      .sort((a, b) => a.dataset.guideId!.localeCompare(b.dataset.guideId!))
  }

  /** Hoisted out of `owningTabs` so a whole-registry pass queries the DOM once. */
  private inactiveTabs(): HTMLElement[] {
    return this.matches('[data-guide-kind="tab"][data-guide-id]').filter(tab => visible(tab) && !isActiveTab(tab))
  }

  /** Where a target stands right now, and what would fix it. Never mutates. */
  private locate(target: GuideTarget): { element?: HTMLElement; reason?: string; openers?: Opener[] } {
    let matches: HTMLElement[]
    if (target.id !== undefined) {
      matches = this.matches('[data-guide-id]').filter(element => element.dataset.guideId === target.id)
    } else {
      try { matches = this.matches(target.selector) }
      catch { throw new Error(`Invalid target selector: ${target.selector}`) }
    }
    const name = target.id ?? target.selector
    const candidates = matches.filter(visible)
    if (candidates.length > 1) throw new Error(`Target ${name} matches ${candidates.length} visible elements. Use a unique semantic ID or a more precise selector.`)
    const element = candidates[0]
    if (element) {
      const blocking = this.blockingRoot()
      return blocking && !blocking.contains(element) && blocking !== element
        ? { reason: 'The target is behind an open dialog or startup screen. Close it or start audio yourself, then revisit this step.' }
        : { element }
    }
    const openers = matches.flatMap(match => this.openersFor(match))
    if (openers.length) return { reason: `Target unavailable: ${name}. Its panel or tab is closed.`, openers }
    if (matches.length) {
      // Present but unreachable. Opening a modal on someone is a mode change,
      // not a reveal, so this stays a warning that names the way out.
      return { reason: matches.some(match => match.closest('dialog:not([open])'))
        ? `Target unavailable: ${name}. It lives inside a closed dialog; point at the control that opens the dialog first.`
        : `Target unavailable: ${name}. It is mounted but hidden by the current state of the app.` }
    }
    // One guess at a time. Whatever gets clicked becomes the active tab, so the
    // next pass of `resolve` naturally falls through to the next candidate
    // instead of opening several tab groups on a hunch.
    const owner = target.id === undefined ? undefined : this.owningTabs(target.id)[0]
    if (owner) {
      return {
        reason: `Target unavailable: ${name}. It only exists while its tab is open.`,
        openers: [{ element: owner, kind: 'tab', label: openerLabel(owner) }]
      }
    }
    return { reason: `Target unavailable: ${name}. Nothing on the page carries that ID; call get_ui_targets for the live list.` }
  }

  /**
   * Resolve a target, optionally opening whatever hides it.
   *
   * The loop re-checks after each pass because openers nest: activating a tab
   * can mount a control that is itself inside a closed `<details>`.
   */
  private resolve(target?: GuideTarget, reveal = false): Resolution {
    if (!target) return {}
    const opened: string[] = []
    for (let pass = 0; pass < 3; pass++) {
      const found = this.locate(target)
      if (found.element) return opened.length ? { element: found.element, opened } : { element: found.element }
      if (!found.openers) return opened.length ? { warning: found.reason, opened } : { warning: found.reason }
      if (!reveal) return { warning: found.reason, opens: found.openers.map(opener => opener.label) }
      const applied = openAll(found.openers)
      if (!applied.length) return { warning: found.reason }
      opened.push(...applied)
    }
    return { warning: this.locate(target).reason, opened }
  }

  /**
   * Bring one target into view without showing a guide. The capability a
   * `reveal_ui_target` tool would be, kept public so adding that tool is a
   * descriptor and nothing else.
   */
  reveal(target: GuideTarget): { revealed: boolean; opened: string[]; reason?: string } {
    const result = this.resolve(target, true)
    if (result.element) revealInScrollContainer(result.element)
    return { revealed: !!result.element, opened: result.opened ?? [], ...(result.warning ? { reason: result.warning } : {}) }
  }

  listTargets(input: unknown) {
    const value = object(input, ['format', 'search', 'offset', 'limit'], 'input')
    const format = value.format ?? 'full'
    if (format !== 'full' && format !== 'compact') throw new Error("format must be 'full' or 'compact'")
    const query = value.search === undefined ? '' : text(value.search, 100, 'search')
    const search = query.toLowerCase()
    const offset = value.offset ?? 0
    if (!Number.isInteger(offset) || (offset as number) < 0) throw new Error('offset must be a non-negative integer')
    if (value.limit !== undefined && (!Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 20)) {
      throw new Error('limit must be an integer from 1 to 20')
    }
    const blocking = this.blockingRoot()
    const mounted = new Set<string>()
    const items: GuideTargetInfo[] = this.matches('[data-guide-id]').map(element => {
      const shown = visible(element) && (!blocking || blocking.contains(element) || blocking === element)
      mounted.add(element.dataset.guideId!)
      const info: GuideTargetInfo = {
        id: element.dataset.guideId!, label: element.dataset.guideLabel ?? element.dataset.guideId!,
        type: element.dataset.guideKind ?? element.tagName.toLowerCase(), visible: shown
      }
      // Only a hidden target needs the extra word, and there are 259 of these.
      if (!shown) info.revealable = this.openersFor(element).length > 0
      return info
    }).concat(this.unmountedTargets(mounted))
      .filter(item => `${item.id} ${item.label} ${item.type}`.toLowerCase().includes(search)).sort((a, b) => a.id.localeCompare(b.id))
    // A compact call needs no page size: the whole space is the point of it.
    const limit = (value.limit ?? (format === 'compact' ? Math.max(items.length, 1) : DEFAULT_TARGET_PAGE_SIZE)) as number
    const page = items.slice(offset as number, (offset as number) + limit)
    const nextOffset = (offset as number) + page.length
    const more = nextOffset < items.length ? { nextOffset } : {}
    return format === 'compact'
      ? { items: page.map(compactTarget), total: items.length, format: 'compact' as const, ...more, ...this.unmatched(query, items.length) }
      : { items: page, total: items.length, offset, limit, ...more, ...this.unmatched(query, items.length) }
  }

  /**
   * Parameter controls that exist as far as the app is concerned, but have no
   * element to describe: the ENV and LFO knob rows are thrown away and rebuilt
   * on every tab click, so while ENV 1 is selected there is nothing anywhere in
   * the document for `param.env2.decay`.
   *
   * These were the entries a search used to answer with an empty list and a
   * separate note beside it. They are ordinary rows now, on two pieces of
   * evidence and no invention: the ID is in `PARAMS`, which is the registry the
   * control would be built from, and a tab on screen plausibly owns it. What
   * cannot be read off an element is said out loud - `mounted: false` marks a
   * row as predicted, so a caller can always tell one from a live element.
   *
   * A parameter with no owning tab is left out entirely. Every parameter that
   * is not in a rebuilt row is mounted for the life of the page, so failing
   * that test means the guess has nothing behind it.
   */
  private unmountedTargets(mounted: ReadonlySet<string>): GuideTargetInfo[] {
    const tabs = this.inactiveTabs()
    if (!tabs.length) return []
    const items: GuideTargetInfo[] = []
    for (const [id, target] of PARAM_TARGETS) {
      if (mounted.has(id) || !this.owningTabs(id, tabs).length) continue
      items.push({ ...target, visible: false, revealable: true, mounted: false })
    }
    return items
  }

  /**
   * The residue of "is this target available?" that a row cannot answer.
   *
   * A search matching nothing is ambiguous in the worst way: a wrong ID and a
   * real control whose tab happens to be closed both come back empty. For a
   * parameter that ambiguity is gone - `unmountedTargets` lists it - so what
   * reaches here is an ID no registry knows, where a tab merely shares a word
   * with it. That is a hunch, not a control, and it keeps a shape of its own
   * rather than being dressed up as a row that claims an element exists.
   */
  private unmatched(query: string, matched: number) {
    if (!query || matched) return {}
    const opens = this.owningTabs(query).map(tab => tab.dataset.guideId!)
    return { unmatched: { search: query, revealable: opens.length > 0, opens } }
  }

  show(input: unknown, presentation: GuidePresentation = {}) {
    if (this.disposed) throw new Error('The guide controller has been disposed')
    const steps = validateGuide(input)
    const reveal = revealRequested(input)
    // Classify every step first, and open nothing yet: the reveal for step 5
    // would otherwise switch the tab out from under step 1. Each step opens
    // what it needs at the moment the human actually arrives on it.
    const warnings: { step: number; message: string }[] = []
    const reveals: { step: number; opens: string[] }[] = []
    steps.forEach((step, index) => {
      const result = this.resolve(step.target)
      if (reveal && result.opens) reveals.push({ step: index + 1, opens: result.opens })
      else if (result.warning) warnings.push({ step: index + 1, message: result.warning })
    })
    // Validate all steps before dismissing an existing guide.
    this.clear()
    if (!steps.length) return { shown: false, cleared: true, stepCount: 0, warnings: [] }
    const initialFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    let instance: Driver
    const moveIntoDialog = (node?: Element) => {
      const dialog = this.blockingRoot()
      if (node) (dialog instanceof HTMLDialogElement && dialog.open ? dialog : document.body).appendChild(node)
    }
    const onDialogClose = (event: Event) => {
      if (!(event.target instanceof HTMLDialogElement) || !this.active) return
      const index = instance.getActiveIndex()
      if (index !== undefined) instance.moveTo(index)
    }
    const driverSteps: DriveStep[] = steps.map((step, index) => {
      let resolution: Resolution = {}
      return {
        // Driver's runtime accepts an unresolved function result and centers the step.
        element: step.target ? () => {
          try { resolution = this.resolve(step.target, reveal) }
          catch (error) { resolution = { warning: error instanceof Error ? error.message : 'Target unavailable' } }
          if (resolution.element) revealInScrollContainer(resolution.element)
          return resolution.element!
        } : undefined,
        popover: {
          showButtons: steps.length === 1 ? ['close'] : index === 0 ? ['next', 'close'] : ['previous', 'next', 'close'],
          onPopoverRender: popover => {
            popover.title.textContent = step.title ?? ''
            popover.title.style.display = step.title ? 'block' : 'none'
            popover.description.replaceChildren(guideMarkdown(step.markdown ?? ''))
            if (resolution.warning) {
              const warning = document.createElement('p')
              warning.className = 'guide-warning'
              warning.textContent = resolution.warning
              popover.description.appendChild(warning)
            }
            const hasDescription = !!(step.markdown || resolution.warning)
            popover.description.style.display = hasDescription ? 'block' : 'none'
            if (!hasDescription) popover.wrapper.removeAttribute('aria-describedby')
            if (!step.title) {
              popover.wrapper.removeAttribute('aria-labelledby')
              popover.wrapper.setAttribute('aria-label', `Guide step ${index + 1} of ${steps.length}`)
            }
            popover.wrapper.classList.toggle('guide-highlight-only', !step.title && !hasDescription && steps.length === 1)
            popover.progress.setAttribute('aria-live', 'polite')
            moveIntoDialog(popover.wrapper)
          }
        },
        onHighlighted: () => moveIntoDialog(instance.getState('__overlaySvg'))
      }
    })
    instance = this.createDriver({
      steps: driverSteps, popoverClass: 'guide-popover', disableActiveInteraction: false,
      overlayClickBehavior: presentation.closeOnOverlay ? 'close' : () => {},
      showProgress: steps.length > 1,
      animate: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      onDestroyed: () => {
        document.body.classList.remove('guide-overlay-static')
        document.removeEventListener('close', onDialogClose, true)
        if (this.active === instance) this.active = null
        queueMicrotask(() => { if (!this.active && initialFocus?.isConnected) initialFocus.focus({ preventScroll: true }) })
      }
    })
    document.body.classList.toggle('guide-overlay-static', !!presentation.staticOverlay)
    this.active = instance
    document.addEventListener('close', onDialogClose, true)
    try { instance.drive() }
    catch (error) { this.clear(); throw error }
    // `reveals` is the honest half of opening someone's panels for them: the
    // caller is told which steps will change what is on screen, and the panels
    // stay open afterwards because the human is meant to be looking at them.
    return { shown: true, stepCount: steps.length, warnings, ...(reveals.length ? { reveals } : {}) }
  }

  clear(): void {
    const active = this.active
    this.active = null
    active?.destroy()
  }

  dispose(): void {
    this.clear()
    this.roots.clear()
    this.disposed = true
  }
}
