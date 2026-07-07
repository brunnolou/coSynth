// Small DOM helpers and shared UI state.

import { MOD_SOURCES } from '../shared/messages'

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

/** Color coding for modulation sources (envs / lfos / macros / performance). */
export function sourceColor(source: number): string {
  const id = MOD_SOURCES[source]?.id ?? ''
  if (id.startsWith('env')) return '#ff9a3c'
  if (id.startsWith('lfo')) return '#4cd97b'
  if (id.startsWith('macro')) return '#c77dff'
  return '#53a8ff'
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

let menuEl: HTMLElement | null = null

/** Show a popup menu element at (x, y); closes on outside pointerdown. */
export function showPopup(content: HTMLElement, x: number, y: number): void {
  closePopup()
  menuEl = content
  content.classList.add('popup')
  document.body.appendChild(content)
  const rect = content.getBoundingClientRect()
  content.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`
  content.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`
  setTimeout(() => {
    const close = (e: PointerEvent) => {
      if (menuEl && !menuEl.contains(e.target as Node)) closePopup()
    }
    window.addEventListener('pointerdown', close, { capture: true, once: false })
    menuEl!.dataset.closer = 'attached'
    ;(menuEl as HTMLElement & { _close?: (e: PointerEvent) => void })._close = close
  }, 0)
}

export function closePopup(): void {
  if (menuEl) {
    const close = (menuEl as HTMLElement & { _close?: (e: PointerEvent) => void })._close
    if (close) window.removeEventListener('pointerdown', close, { capture: true })
    menuEl.remove()
    menuEl = null
  }
}
