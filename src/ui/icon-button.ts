import { createElement, type Play } from 'lucide'
import { el } from './common'

export function setButtonIcon(button: HTMLButtonElement, label: string, icon: typeof Play): void {
  button.setAttribute('aria-label', label)
  button.title = label
  button.replaceChildren(createElement(icon, { width: 16, height: 16, 'aria-hidden': 'true', focusable: 'false' }))
}

export function iconButton(label: string, icon: typeof Play): HTMLButtonElement {
  const button = el('button', 'agent-btn agent-icon-button')
  button.type = 'button'
  setButtonIcon(button, label, icon)
  return button
}
