import type { WebMcpRegistration } from './register'

interface HotLifecycle {
  dispose(callback: () => void): void
}

/** Attach bfcache-aware page and HMR cleanup to an idempotent registration. */
export function bindWebMcpLifecycle(
  registration: WebMcpRegistration,
  target: EventTarget = window,
  hot?: HotLifecycle
): () => void {
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    target.removeEventListener('pagehide', onPageHide)
    registration.dispose()
  }
  const onPageHide = (event: Event) => {
    if ((event as PageTransitionEvent).persisted === false) dispose()
  }
  target.addEventListener('pagehide', onPageHide)
  hot?.dispose(dispose)
  return dispose
}
