import 'driver.js/dist/driver.css'
import './style.css'
import { SynthEngine } from './audio/engine'
import { buildApp } from './ui/app'
import { registerWebMcpTools } from './webmcp/register'
import { bindWebMcpLifecycle } from './webmcp/lifecycle'
import { agentActivityFor } from './webmcp/activity'
import { UiGuideController } from './ui/guide'
import { guideTarget } from './ui/guide-target'
import { createHistoryServices } from './history/services'
import { bindHistoryInteractions, isTextEditing } from './ui/history-bindings'

const engine = new SynthEngine()
const agentActivity = agentActivityFor(engine)
const app = document.getElementById('app')!
const guide = new UiGuideController(app)
const services = createHistoryServices(engine, guide)
const disposeApp = buildApp(engine, app, services)
const disposeInteractions = bindHistoryInteractions(app, services.history, error => agentActivity.reportHumanError(error))

// Browsers require a user gesture before audio can start.
const overlay = document.createElement('div')
overlay.id = 'start-overlay'
overlay.innerHTML = `
  <div class="start-box">
    <h1 class="brand-logo">coSynth</h1>
    <p>Wavetable synthesizer · Web Audio</p>
    <button id="start-btn">CLICK TO START AUDIO</button>
  </div>`
document.body.appendChild(overlay)
guide.registerOverlay(overlay)
overlay.dataset.guideBlocking = ''
guideTarget(overlay, 'panel.audio-start', 'Start audio screen', 'panel')
guideTarget(overlay.querySelector<HTMLButtonElement>('#start-btn')!, 'button.audio.start', 'Start audio', 'button')

let starting = false
let webMcp: ReturnType<typeof registerWebMcpTools> | null = null
let audioWebMcp: ReturnType<typeof registerWebMcpTools> | null = null
const updateReadiness = () => agentActivity.setToolReadiness(
  (webMcp?.registeredCount ?? 0) + (audioWebMcp?.registeredCount ?? 0), !engine.running,
  { available: webMcp?.available ?? false, registering: !!(webMcp?.pending || audioWebMcp?.pending),
    errors: [...(webMcp?.errors ?? []), ...(audioWebMcp?.errors ?? [])] }
)
const start = async () => {
  if (starting) return
  starting = true
  try {
    await engine.start()
    if (!audioWebMcp) {
      audioWebMcp = registerWebMcpTools(engine, undefined, { audioTools: 'only', services })
      updateReadiness()
      void audioWebMcp.ready.then(updateReadiness)
    }
    overlay.remove()
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
try {
  webMcp = registerWebMcpTools(engine, undefined, { audioTools: 'exclude', guide, services })
  updateReadiness()
  void webMcp.ready.then(updateReadiness)
  bindWebMcpLifecycle({
    ready: webMcp.ready,
    dispose() {
      webMcp?.dispose()
      audioWebMcp?.dispose()
      window.removeEventListener('keydown', startFromKey)
      disposeInteractions()
      disposeApp()
      services.dispose()
      guide.dispose()
      agentActivity.dispose()
    }
  }, window, import.meta.hot)
} catch (error) {
  agentActivity.setToolReadiness(0, !engine.running, { available: !!document.modelContext,
    errors: [{ tool: 'WebMCP', message: error instanceof Error ? error.message : String(error) }] })
  console.warn('WebMCP is unavailable:', error)
}
