import type { AgentActivitySnapshot, AgentActivityStore, PendingChange } from '../webmcp/activity'
import { changeSummary, changeTargets } from './agent-change-summary'
import './agent-highlights.css'

const selector = '[data-guide-id], [data-ai-target]'
let nextDescriptionId = 0

interface Binding {
  signature: string
  summary: string
  description: HTMLElement
  timer?: ReturnType<typeof setTimeout>
}

/** One store subscription and delegated events, including controls rebuilt by tabs. */
export class AgentHighlights {
  private readonly bindings = new Map<HTMLElement, Binding>()
  private readonly observer: MutationObserver
  private readonly unsubscribe: () => void
  private readonly descriptions = document.createElement('div')
  private readonly tooltip = document.createElement('div')
  private state: AgentActivitySnapshot
  private queued = false
  private allowPulse = false
  private seenRevision = 0
  private disposed = false
  private hovered: HTMLElement | null = null

  constructor(private readonly root: HTMLElement, store: AgentActivityStore) {
    this.state = store.snapshot()
    this.rememberRevisions()
    this.descriptions.className = 'ai-change-descriptions'
    this.tooltip.className = 'ai-change-tooltip'
    this.tooltip.setAttribute('role', 'tooltip')
    this.tooltip.hidden = true
    root.append(this.descriptions, this.tooltip)
    this.unsubscribe = store.subscribe(state => {
      this.state = state
      this.schedule(true)
    })
    this.observer = new MutationObserver(records => {
      if (records.some(record => record.type === 'attributes' ||
        [...record.addedNodes, ...record.removedNodes].some(node =>
          node instanceof Element && (node.matches(selector) || node.querySelector(selector))))) this.schedule()
    })
    this.observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-guide-id', 'data-ai-target'] })
    root.addEventListener('pointerover', this.showTooltip)
    root.addEventListener('focusin', this.showTooltip)
    root.addEventListener('pointerout', this.leaveTooltip)
    root.addEventListener('focusout', this.leaveTooltip)
    root.addEventListener('keydown', this.dismissTooltip)
    root.addEventListener('scroll', this.hideTooltip, true)
    window.addEventListener('resize', this.hideTooltip)
  }

  private schedule(animate = false): void {
    this.allowPulse ||= animate
    if (this.queued) return
    this.queued = true
    queueMicrotask(() => {
      this.queued = false
      const pulse = this.allowPulse
      this.allowPulse = false
      if (!this.disposed) this.refresh(pulse)
    })
  }

  private refresh(animate: boolean): void {
    const targets = new Map<string, PendingChange[]>()
    if (this.state.showChanges) for (const change of this.state.pendingChanges) {
      for (const id of changeTargets(change)) targets.set(id, [...(targets.get(id) ?? []), change])
    }
    const active = new Set<HTMLElement>()
    let pulseIndex = 0
    for (const target of this.root.querySelectorAll<HTMLElement>(selector)) {
      const changes = targets.get(target.dataset.aiTarget ?? target.dataset.guideId ?? '')
      if (!changes?.length) continue
      active.add(target)
      const signature = changes.map(change => `${change.key}:${change.revision}`).join('|')
      let binding = this.bindings.get(target)
      const isNewRevision = binding?.signature !== signature
      if (!binding) {
        const description = document.createElement('span')
        description.id = `ai-change-${++nextDescriptionId}`
        this.descriptions.appendChild(description)
        binding = { signature: '', summary: '', description }
        this.bindings.set(target, binding)
        const ids = target.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ?? []
        target.setAttribute('aria-describedby', [...ids, description.id].join(' '))
      }
      const summary = `AI changed ${changes.map(changeSummary).join('\n')}`
      binding.signature = signature
      if (binding.summary !== summary) {
        binding.summary = summary
        binding.description.textContent = summary
      }
      target.classList.add('ai-changed')
      // Initial mount, tab reconstruction and Show changes never replay old pulses.
      if (animate && isNewRevision && changes.some(change => change.revision > this.seenRevision) && this.isVisible(target)) {
        this.clearPulse(target, binding)
        // Start one immediately; scatter the other elements over a 500ms window.
        const delay = pulseIndex++ === 0 ? 0 : 25 + Math.round(Math.random() * 475)
        if (delay) target.style.setProperty('--ai-change-delay', `${delay}ms`)
        void target.offsetWidth
        target.classList.add('ai-change-pulse')
        binding.timer = setTimeout(() => this.clearPulse(target, binding!), 1600 + delay)
      }
    }
    for (const [target, binding] of this.bindings) {
      if (!active.has(target)) this.removeBinding(target, binding)
    }
    this.rememberRevisions()
    if (this.hovered) this.renderTooltip(this.hovered)
  }

  private rememberRevisions(): void {
    for (const change of this.state.pendingChanges) this.seenRevision = Math.max(this.seenRevision, change.revision)
  }

  private isVisible(target: HTMLElement): boolean {
    if (!target.isConnected || target.closest('[hidden], [inert]') || !target.getClientRects().length) return false
    const rect = target.getBoundingClientRect()
    if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) return false
    for (let element: HTMLElement | null = target; element; element = element.parentElement) {
      const style = getComputedStyle(element)
      if (style.visibility === 'hidden' || style.display === 'none') return false
      if (/(auto|scroll|hidden|clip)/.test(style.overflow + style.overflowY + style.overflowX)) {
        const clip = element.getBoundingClientRect()
        if (rect.bottom <= clip.top || rect.top >= clip.bottom || rect.right <= clip.left || rect.left >= clip.right) return false
      }
    }
    return true
  }

  private clearPulse(target: HTMLElement, binding: Binding): void {
    clearTimeout(binding.timer)
    target.classList.remove('ai-change-pulse')
    target.style.removeProperty('--ai-change-delay')
  }

  private removeBinding(target: HTMLElement, binding: Binding): void {
    this.clearPulse(target, binding)
    target.classList.remove('ai-changed')
    const ids = (target.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(id => id && id !== binding.description.id)
    if (ids.length) target.setAttribute('aria-describedby', ids.join(' '))
    else target.removeAttribute('aria-describedby')
    binding.description.remove()
    this.bindings.delete(target)
  }

  private showTooltip = (event: Event): void => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.ai-changed') : null
    if (target) this.renderTooltip(target)
  }

  private renderTooltip(target: HTMLElement): void {
    const binding = this.bindings.get(target)
    if (!binding) { this.hideTooltip(); return }
    this.hovered = target
    this.tooltip.textContent = [target.title, binding.summary].filter(Boolean).join('\n')
    this.tooltip.hidden = false
    const rect = target.getBoundingClientRect()
    this.tooltip.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - this.tooltip.offsetWidth - 8))}px`
    this.tooltip.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - this.tooltip.offsetHeight - 8))}px`
  }

  private leaveTooltip = (event: Event): void => {
    const next = (event as FocusEvent).relatedTarget
    if (next instanceof Node && this.hovered?.contains(next)) return
    this.hideTooltip()
  }

  private hideTooltip = (): void => {
    this.hovered = null
    this.tooltip.hidden = true
  }

  private dismissTooltip = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.hideTooltip()
  }

  dispose(): void {
    this.disposed = true
    this.observer.disconnect()
    this.unsubscribe()
    for (const [target, binding] of this.bindings) this.removeBinding(target, binding)
    this.root.removeEventListener('pointerover', this.showTooltip)
    this.root.removeEventListener('focusin', this.showTooltip)
    this.root.removeEventListener('pointerout', this.leaveTooltip)
    this.root.removeEventListener('focusout', this.leaveTooltip)
    this.root.removeEventListener('keydown', this.dismissTooltip)
    this.root.removeEventListener('scroll', this.hideTooltip, true)
    window.removeEventListener('resize', this.hideTooltip)
    this.descriptions.remove()
    this.tooltip.remove()
  }
}
