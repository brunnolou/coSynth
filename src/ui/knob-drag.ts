import { clamp01 } from './common'
import { KNOB_COARSE_STEPS } from './knob-value'

/** Also ends the shared history gesture when no native pointerup is delivered. */
export const KNOB_DRAG_END = 'knob-drag-end'

const activeDrags = new WeakMap<Document, () => void>()
const pendingLocks = new WeakSet<Document>()

export function cancelKnobDrag(document: Document): void {
  activeDrags.get(document)?.()
}

/** Listeners exist only during a drag, including for dynamically mounted knobs. */
export function startKnobDrag(
  target: HTMLElement,
  down: PointerEvent,
  initialValue: number,
  onChange: (value: number) => void,
  onEnd: () => void,
  snapValue: (value: number) => number = clamp01
): void {
  const doc = target.ownerDocument
  const win = doc.defaultView!
  if (down.button !== 0 || activeDrags.has(doc)) return
  down.preventDefault()
  const pointerId = down.pointerId
  let active = true
  let locked = false
  let lockRequested = false
  let lastX = down.clientX
  let lastY = down.clientY
  let value = snapValue(initialValue)
  let displayedValue = value
  const modeFor = (event: MouseEvent) => event.metaKey ? 'fine' : event.shiftKey ? 'coarse' : 'normal'
  let mode = modeFor(down)
  const cleanups: (() => void)[] = []
  const listen = (node: EventTarget, type: string, handler: EventListener) => {
    node.addEventListener(type, handler)
    cleanups.push(() => node.removeEventListener(type, handler))
  }
  const unlock = () => {
    // Never release a different control's lock.
    if (doc.pointerLockElement === target) doc.exitPointerLock()
  }
  const finish = () => {
    if (!active) return
    active = false
    activeDrags.delete(doc)
    for (const cleanup of cleanups) cleanup()
    try {
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
    } catch { /* Capture may already have been released by the browser. */ }
    unlock()
    onEnd()
    // Dispatch on window even if an ENV/LFO tab removed the original canvas.
    win.dispatchEvent(new CustomEvent(KNOB_DRAG_END, { detail: { pointerId } }))
  }
  activeDrags.set(doc, finish)

  const move = (delta: number, event: MouseEvent) => {
    if (!active) return
    if (!target.isConnected || (event.buttons & 1) === 0) { finish(); return }
    if (!Number.isFinite(delta) || delta === 0) return
    const nextMode = modeFor(event)
    // Discard hidden snap remainder when changing modifiers, not on each move.
    // Otherwise small movements could never accumulate to the next stop.
    if (nextMode !== mode) value = displayedValue
    mode = nextMode
    value = clamp01(value + delta * (mode === 'fine' ? 0.0005 : 0.005))
    displayedValue = snapValue(mode === 'coarse' ? Math.round(value * KNOB_COARSE_STEPS) / KNOB_COARSE_STEPS : value)
    onChange(displayedValue)
  }
  listen(win, 'pointermove', event => {
    const e = event as PointerEvent
    if (e.pointerId !== pointerId || doc.pointerLockElement === target) return
    const dx = e.clientX - lastX
    const dy = e.clientY - lastY
    lastX = e.clientX
    lastY = e.clientY
    move(dx - dy, e)
    if (dx !== 0 || dy !== 0) requestLock()
  })
  // Pointer Lock specifies mouse events. Do not also consume pointermove deltas.
  listen(win, 'mousemove', event => {
    const e = event as MouseEvent
    if (doc.pointerLockElement === target) move(e.movementX - e.movementY, e)
  })
  const endPointer = (event: Event) => {
    if ((event as PointerEvent).pointerId === pointerId) finish()
  }
  listen(win, 'pointerup', endPointer)
  listen(win, 'pointercancel', endPointer)
  // A detached canvas no longer bubbles cancellation to window.
  listen(target, 'pointercancel', endPointer)
  listen(win, 'mouseup', event => {
    if (down.pointerType === 'mouse' && (event as MouseEvent).button === 0) finish()
  })
  listen(target, 'lostpointercapture', event => {
    // Acquiring pointer lock implicitly releases pointer capture.
    if (doc.pointerLockElement !== target) endPointer(event)
  })
  listen(win, 'blur', finish)
  listen(win, 'pagehide', finish)
  listen(doc, 'visibilitychange', () => { if (doc.hidden) finish() })
  listen(win, 'keydown', event => {
    if ((event as KeyboardEvent).key === 'Escape') { event.preventDefault(); finish() }
  })
  listen(doc, 'pointerlockchange', () => {
    if (doc.pointerLockElement === target && lockRequested) locked = true
    else if (locked) finish()
  })
  const observer = new MutationObserver(() => { if (!target.isConnected) finish() })
  observer.observe(doc.documentElement, { childList: true, subtree: true })
  cleanups.push(() => observer.disconnect())
  try { target.setPointerCapture(pointerId) } catch { /* Window listeners still cover ordinary dragging. */ }

  const requestLock = () => {
    // Delay this until real movement. Browser click/dblclick generation must
    // stay intact, especially in embedded browsers which reject Pointer Lock.
    if (lockRequested || !active || down.pointerType !== 'mouse' || !target.requestPointerLock || doc.pointerLockElement || pendingLocks.has(doc)) return
    lockRequested = true
    pendingLocks.add(doc)
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      pendingLocks.delete(doc)
      doc.removeEventListener('pointerlockchange', granted)
      doc.removeEventListener('pointerlockerror', failed)
    }
    const granted = () => {
      if (settled || doc.pointerLockElement !== target) return
      settle()
      // Mouse-up, Escape, blur, removal or disposal may precede an async grant.
      if (!active) unlock()
      else locked = true
    }
    const failed = () => { settle() }
    // Keep only these two listeners until a pending legacy (non-Promise)
    // request settles, so a late grant cannot trap the cursor after a drag.
    doc.addEventListener('pointerlockchange', granted)
    doc.addEventListener('pointerlockerror', failed)
    try {
      const request = target.requestPointerLock() as Promise<void> | undefined
      request?.then(() => { granted(); settle() }, failed)
    } catch { failed() }
  }
}
