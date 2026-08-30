import type { SoundHistoryService } from '../history/types'

export function isTextEditing(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return true
  const input = target.closest('input')
  return input !== null && !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'color'].includes(input.type)
}

/** Capture before controls mutate, commit after their final pointer handler. */
export function bindHistoryInteractions(app: HTMLElement, history: SoundHistoryService, onError: (error: unknown) => void): () => void {
  const win = app.ownerDocument.defaultView!
  const pointers = new Map<number, Element>()
  const cleanups: (() => void)[] = []
  let disposed = false
  const label = (node: Element) => node.closest<HTMLElement>('[data-guide-label]')?.dataset.guideLabel ?? (node.closest('.lfo-editor') ? 'LFO shape' : 'Sound control')
  const control = (target: EventTarget | null): Element | null => target instanceof Element
    ? target.closest('.knob, .lfo-editor, input[type="range"], .source-badge') : null
  const scoped = (target: EventTarget | null): target is Element => target instanceof Element
    && (app.contains(target) || target.closest('.mod-menu') !== null)
  const listen = (node: EventTarget, type: string, handler: EventListener, capture = false) => {
    node.addEventListener(type, handler, { capture })
    cleanups.push(() => node.removeEventListener(type, handler, capture))
  }
  const cancelPointers = () => {
    if (!pointers.size) return
    const active = [...pointers]
    pointers.clear()
    for (const [pointerId, target] of active) {
      const cancel = new Event('pointercancel', { bubbles: true })
      Object.defineProperty(cancel, 'pointerId', { value: pointerId })
      target.dispatchEvent(cancel)
      try { if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId) } catch { /* Pointer may already be released. */ }
    }
    history.endGesture()
  }
  listen(app.ownerDocument, 'pointerdown', event => {
    const e = event as PointerEvent
    if (!scoped(e.target)) return
    const node = control(e.target)
    if (!node) { history.endGesture(); return }
    if (e.button !== 0 && !node.closest('.lfo-editor')) return
    if (pointers.size === 0) history.beginGesture(label(node))
    pointers.set(e.pointerId, e.target)
  }, true)
  const finishPointer = (event: Event) => {
    const id = (event as PointerEvent).pointerId
    if (!pointers.has(id)) return
    // Native control updates and app pointer handlers finish before this microtask.
    queueMicrotask(() => {
      pointers.delete(id)
      if (!disposed && pointers.size === 0) history.endGesture()
    })
  }
  listen(win, 'pointerup', finishPointer, true)
  listen(win, 'pointercancel', finishPointer, true)
  listen(win, 'blur', () => {
    cancelPointers()
  })
  // Keyboard/button clicks and select changes must not join a pending wheel/MIDI group.
  for (const type of ['click', 'change', 'dblclick']) listen(app.ownerDocument, type, event => {
    if (!scoped(event.target) || pointers.size) return
    if (type !== 'dblclick' && event.target.closest('input[type="range"]')) return
    history.endGesture()
  }, true)
  listen(app.ownerDocument, 'wheel', event => {
    if (!scoped(event.target)) return
    const node = control(event.target)
    if (node?.closest('.knob')) history.coalesce(node.getAttribute('data-guide-id') ?? label(node), label(node))
  }, true)
  listen(app.ownerDocument, 'keydown', event => {
    const e = event as KeyboardEvent
    if (!scoped(e.target)) return
    if (e.metaKey || e.ctrlKey || e.altKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) return
    const node = control(e.target)
    if (node?.matches('input[type="range"]')) history.coalesce(node.getAttribute('data-guide-id') ?? label(node), label(node))
  }, true)
  listen(win, 'keydown', event => {
    const e = event as KeyboardEvent
    if (!(e.metaKey || e.ctrlKey) || e.altKey || isTextEditing(e.target)) return
    const key = e.key.toLowerCase()
    const action = key === 'z' ? e.shiftKey ? 'redo' : 'undo' : key === 'y' && e.ctrlKey && !e.metaKey && !e.shiftKey ? 'redo' : null
    if (!action) return
    e.preventDefault()
    e.stopImmediatePropagation()
    if (e.repeat) return
    cancelPointers()
    void history.navigate(action).catch(onError)
  }, true)
  cleanups.push(history.subscribe(() => {
    if (history.snapshot().navigating) cancelPointers()
  }))
  return () => {
    if (disposed) return
    disposed = true
    for (const cleanup of cleanups) cleanup()
    cancelPointers()
  }
}
