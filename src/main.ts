import 'driver.js/dist/driver.css'
import './style.css'
import { SynthEngine } from './audio/engine'
import { buildApp } from './ui/app'
import { registerWebMcpTools, type WebMcpRegistrationOptions } from './webmcp/register'
import { registerLegacyWebMcpTools, resolveModelContext, loadLegacyWebMcp, type LegacyWebMcp } from './webmcp/legacy'
import { bindWebMcpLifecycle } from './webmcp/lifecycle'
import { agentActivityFor } from './webmcp/activity'
import { UiGuideController } from './ui/guide'
import { guideTarget } from './ui/guide-target'
import { createHistoryServices } from './history/services'
import { bindHistoryInteractions, isTextEditing } from './ui/history-bindings'
import { WelcomeTour } from './ui/welcome-tour'

const engine = new SynthEngine()
const agentActivity = agentActivityFor(engine)
const app = document.getElementById('app')!
const guide = new UiGuideController(app)
const welcomeTour = new WelcomeTour(guide)
const services = createHistoryServices(engine, guide)
const disposeApp = buildApp(engine, app, services, () => welcomeTour.start())
const disposeInteractions = bindHistoryInteractions(app, services.history, error => agentActivity.reportHumanError(error))

// Browsers require a user gesture before audio can start.
const overlay = document.createElement('div')
overlay.id = 'start-overlay'
overlay.innerHTML = `
  <div class="start-box">
    <h1 class="brand-logo">coSynth</h1>
    <p>Wavetable synthesizer · Web Audio · WebMCP</p>
    <button id="start-btn">CLICK TO START AUDIO</button>
  </div>`
document.body.appendChild(overlay)
guide.registerOverlay(overlay)
overlay.dataset.guideBlocking = ''
guideTarget(overlay, 'panel.audio-start', 'Start audio screen', 'panel')
guideTarget(overlay.querySelector<HTMLButtonElement>('#start-btn')!, 'button.audio.start', 'Start audio', 'button')

let starting = false
let webMcp: ReturnType<typeof registerWebMcpTools> | null = null

// Standard entry point first (`document.modelContext`, then the deprecated
// `navigator` spelling). Only when neither exists do we pay to fetch the legacy
// webmcp.dev widget chunk, and only then does its blue connect button appear.
const modelContext = resolveModelContext()
let legacyWebMcp: LegacyWebMcp | null = null
let legacyLoading = !modelContext
const legacyReady: Promise<LegacyWebMcp | null> = modelContext
  ? Promise.resolve(null)
  : loadLegacyWebMcp().then(widget => { legacyWebMcp = widget; legacyLoading = false; return widget })

const registerTools = (options: WebMcpRegistrationOptions) => legacyWebMcp
  ? registerLegacyWebMcpTools(engine, legacyWebMcp, options)
  : registerWebMcpTools(engine, modelContext, options)

const updateReadiness = () => agentActivity.setToolReadiness(
  webMcp?.registeredCount ?? 0, !engine.running,
  { available: legacyLoading || (webMcp?.available ?? false),
    registering: !!(legacyLoading || webMcp?.pending),
    errors: webMcp?.errors ?? [] }
)
// Show the "registering" state while the legacy chunk is in flight.
if (legacyLoading) updateReadiness()

const start = async () => {
  if (starting) return
  starting = true
  try {
    await engine.start()
    // Audio is live the moment start() resolves, so the overlay has done its
    // job. There is nothing left to register: every tool went up at page load,
    // so the advertised set is identical before and after this gesture. Only
    // the readiness line changes, because live playback is now possible.
    overlay.remove()
    updateReadiness()
    try { welcomeTour.startOnce() }
    catch (error) { console.warn('Welcome walkthrough could not start:', error) }
  } catch (err) {
    starting = false
    const box = overlay.querySelector('.start-box')
    if (box) {
      const msg = document.createElement('p')
      msg.className = 'start-error'
      msg.textContent = `Audio failed to start: ${err}`
      box.appendChild(msg)
    }
  }
}
overlay.addEventListener('pointerdown', start)
const startFromKey = (event: KeyboardEvent) => {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTextEditing(event.target)) return
  if (!guide.isActive()) void start()
}
window.addEventListener('keydown', startFromKey)

// expose for debugging / smoke tests
;(window as unknown as { coSynth: SynthEngine }).coSynth = engine

// Progressive enhancement: WebMCP registration must never block synth startup.
const registerPageTools = () => {
  try {
    webMcp = registerTools({ guide, services })
    updateReadiness()
    void webMcp.ready.then(updateReadiness)
    bindWebMcpLifecycle({
      ready: webMcp.ready,
      dispose() {
        webMcp?.dispose()
        window.removeEventListener('keydown', startFromKey)
        disposeInteractions()
        disposeApp()
        services.dispose()
        guide.dispose()
        agentActivity.dispose()
      }
    }, window, import.meta.hot)
  } catch (error) {
    agentActivity.setToolReadiness(0, !engine.running, { available: !!modelContext,
      errors: [{ tool: 'WebMCP', message: error instanceof Error ? error.message : String(error) }] })
    console.warn('WebMCP is unavailable:', error)
  }
}

// With a native entry point this runs synchronously, exactly as before. Without
// one it waits for the legacy widget chunk so the same descriptors are reused.
if (modelContext) registerPageTools()
else void legacyReady.then(() => registerPageTools())
