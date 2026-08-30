import { el } from './common'
import { guideTarget } from './guide-target'

export class ModalDialog {
  readonly root: HTMLDialogElement
  readonly body: HTMLElement
  readonly footer: HTMLElement

  constructor(title: string, id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-')) {
    this.root = el('dialog', 'modal-dialog')
    guideTarget(this.root, `dialog.${id}`, title, 'dialog')
    const card = el('div', 'modal-card')
    const head = el('div', 'modal-head')
    const heading = el('h2', 'modal-title', title)
    const close = el('button', 'modal-close', '×')
    guideTarget(close, `button.dialog.${id}.close`, `Close ${title}`, 'button')
    close.type = 'button'
    close.setAttribute('aria-label', 'Close')
    close.addEventListener('click', () => this.close())
    head.append(heading, close)

    this.body = el('div', 'modal-body')
    this.footer = el('div', 'modal-footer')
    card.append(head, this.body, this.footer)
    this.root.appendChild(card)
    this.root.addEventListener('click', event => {
      if (event.target === this.root) this.close()
    })
  }

  open(): void {
    if (!this.root.open) this.root.showModal()
  }

  close(): void {
    if (this.root.open) this.root.close()
  }
}
