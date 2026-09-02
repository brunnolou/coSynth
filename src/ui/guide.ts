import { driver, type Config, type Driver, type DriveStep } from 'driver.js'
import { micromark } from 'micromark'

export type GuideTarget = { id: string; selector?: never } | { selector: string; id?: never }
export interface GuideStep { target?: GuideTarget; title?: string; markdown?: string }
type Resolution = { element?: HTMLElement; warning?: string }
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
  const value = object(input, ['steps'], 'input')
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

function visible(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('dialog:not([open]), [hidden], [inert]')) return false
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

export interface GuideTargetInfo { id: string; label: string; type: string; visible: boolean }

const DEFAULT_TARGET_PAGE_SIZE = 5

/**
 * One teaching target as a single line: `param.env1.release knob env1 Release`,
 * mirroring `compactParameter` in src/webmcp/tools.ts so the two discovery
 * tools read as one API.
 *
 * Visibility stays on the line — as a trailing ` (hidden)`, the way a compact
 * parameter carries a trailing `mod` — because `show_ui_guide` degrades a step
 * whose target is off-screen into a warning ("open the relevant panel first").
 * An agent picking between `tab.env1` and `param.env1.release` needs to know
 * that the knob only exists once its tab is open, before it builds the guide
 * rather than after the human sees the warning.
 */
export function compactTarget(item: GuideTargetInfo): string {
  return `${item.id} ${item.type} ${item.label}${item.visible ? '' : ' (hidden)'}`
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

  private resolve(target?: GuideTarget): Resolution {
    if (!target) return {}
    let matches: HTMLElement[]
    if (target.id !== undefined) {
      matches = this.matches('[data-guide-id]').filter(element => element.dataset.guideId === target.id)
    } else {
      try { matches = this.matches(target.selector) }
      catch { throw new Error(`Invalid target selector: ${target.selector}`) }
    }
    const candidates = matches.filter(visible)
    if (candidates.length > 1) throw new Error(`Target ${target.id ?? target.selector} matches ${candidates.length} visible elements. Use a unique semantic ID or a more precise selector.`)
    const element = candidates[0]
    if (!element) return { warning: `Target unavailable: ${target.id ?? target.selector}. Open the relevant panel or tab, then revisit this step.` }
    const blocking = this.blockingRoot()
    if (blocking && !blocking.contains(element) && blocking !== element) {
      return { warning: 'The target is behind an open dialog or startup screen. Close it or start audio yourself, then revisit this step.' }
    }
    return { element }
  }

  listTargets(input: unknown) {
    const value = object(input, ['format', 'search', 'offset', 'limit'], 'input')
    const format = value.format ?? 'full'
    if (format !== 'full' && format !== 'compact') throw new Error("format must be 'full' or 'compact'")
    const search = value.search === undefined ? '' : text(value.search, 100, 'search').toLowerCase()
    const offset = value.offset ?? 0
    if (!Number.isInteger(offset) || (offset as number) < 0) throw new Error('offset must be a non-negative integer')
    if (value.limit !== undefined && (!Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 20)) {
      throw new Error('limit must be an integer from 1 to 20')
    }
    const blocking = this.blockingRoot()
    const items: GuideTargetInfo[] = this.matches('[data-guide-id]').map(element => ({
      id: element.dataset.guideId!, label: element.dataset.guideLabel ?? element.dataset.guideId!,
      type: element.dataset.guideKind ?? element.tagName.toLowerCase(),
      visible: visible(element) && (!blocking || blocking.contains(element) || blocking === element)
    })).filter(item => `${item.id} ${item.label} ${item.type}`.toLowerCase().includes(search)).sort((a, b) => a.id.localeCompare(b.id))
    // A compact call needs no page size: the whole space is the point of it.
    const limit = (value.limit ?? (format === 'compact' ? Math.max(items.length, 1) : DEFAULT_TARGET_PAGE_SIZE)) as number
    const page = items.slice(offset as number, (offset as number) + limit)
    const nextOffset = (offset as number) + page.length
    const more = nextOffset < items.length ? { nextOffset } : {}
    return format === 'compact'
      ? { items: page.map(compactTarget), total: items.length, format: 'compact' as const, ...more }
      : { items: page, total: items.length, offset, limit, ...more }
  }

  show(input: unknown, presentation: GuidePresentation = {}) {
    if (this.disposed) throw new Error('The guide controller has been disposed')
    const steps = validateGuide(input)
    const warnings = steps.flatMap((step, index) => {
      const result = this.resolve(step.target)
      return result.warning ? [{ step: index + 1, message: result.warning }] : []
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
          try { resolution = this.resolve(step.target) }
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
    return { shown: true, stepCount: steps.length, warnings }
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
