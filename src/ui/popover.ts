import { el } from './common'

/** Small nonmodal help panel with keyboard, outside-click and focus cleanup. */
export class Popover {
  readonly root = el('div', 'app-popover')
  private anchor: HTMLElement | null = null
  constructor(label: string) {
    this.root.hidden = true
    this.root.tabIndex = -1
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-label', label)
  }
  toggle(anchor: HTMLElement): void {
    if (!this.root.hidden) { this.close(true); return }
    this.anchor = anchor
    anchor.setAttribute('aria-expanded', 'true')
    this.root.hidden = false
    this.position()
    this.root.focus()
    document.addEventListener('pointerdown', this.outside)
    document.addEventListener('keydown', this.keydown)
    window.addEventListener('resize', this.position)
  }
  close(restoreFocus = false): void {
    this.root.hidden = true
    this.anchor?.setAttribute('aria-expanded', 'false')
    if (restoreFocus) this.anchor?.focus()
    this.anchor = null
    document.removeEventListener('pointerdown', this.outside)
    document.removeEventListener('keydown', this.keydown)
    window.removeEventListener('resize', this.position)
  }
  private readonly outside = (event: PointerEvent) => {
    if (!this.root.contains(event.target as Node) && !this.anchor?.contains(event.target as Node)) this.close()
  }
  private readonly keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(true) }
  }
  private readonly position = () => {
    if (!this.anchor) return
    const anchor = this.anchor.getBoundingClientRect()
    const box = this.root.getBoundingClientRect()
    this.root.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8))}px`
    this.root.style.top = `${Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - box.height - 8))}px`
  }
}
