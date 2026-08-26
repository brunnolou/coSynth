import { describe, expect, it, vi } from 'vitest'
import { bindWebMcpLifecycle } from './lifecycle'

function pagehide(persisted: boolean): Event {
  const event = new Event('pagehide')
  Object.defineProperty(event, 'persisted', { value: persisted })
  return event
}

describe('bindWebMcpLifecycle', () => {
  it('survives bfcache pagehide and disposes on a later terminal pagehide', () => {
    const target = new EventTarget()
    const dispose = vi.fn()
    bindWebMcpLifecycle({ ready: Promise.resolve(), dispose }, target)
    target.dispatchEvent(pagehide(true))
    expect(dispose).not.toHaveBeenCalled()
    target.dispatchEvent(pagehide(false))
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('registers HMR disposal and keeps disposal idempotent', () => {
    const target = new EventTarget()
    const dispose = vi.fn()
    let hotDispose: (() => void) | undefined
    const hot = { dispose(callback: () => void) { hotDispose = callback } }
    bindWebMcpLifecycle({ ready: Promise.resolve(), dispose }, target, hot)
    hotDispose?.()
    target.dispatchEvent(pagehide(false))
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
