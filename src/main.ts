import './style.css'
import { SynthEngine } from './audio/engine'
import { buildApp } from './ui/app'
import { registerWebMcpTools } from './webmcp/register'
import { bindWebMcpLifecycle } from './webmcp/lifecycle'
import { agentActivityFor } from './webmcp/activity'

const engine = new SynthEngine()
const agentActivity = agentActivityFor(engine)
const app = document.getElementById('app')!
buildApp(engine, app)

// Browsers require a user gesture before audio can start.
const overlay = document.createElement('div')
overlay.id = 'start-overlay'
overlay.innerHTML = `
  <div class="start-box">
    <h1>SOUNDGINEER</h1>
    <p>Wavetable synthesizer · Web Audio</p>
    <button id="start-btn">CLICK TO START AUDIO</button>
  </div>`
document.body.appendChild(overlay)

let starting = false
let audioWebMcp: ReturnType<typeof registerWebMcpTools> | null = null
const start = async () => {
  if (starting) return
  starting = true
  try {
    await engine.start()
    if (!audioWebMcp) {
      audioWebMcp = registerWebMcpTools(engine, undefined, { audioTools: 'only' })
      if (document.modelContext) void audioWebMcp.ready.then(() => agentActivity.setToolReadiness(11, false))
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
window.addEventListener('keydown', start, { once: false })

// expose for debugging / smoke tests
;(window as unknown as { soundgineer: SynthEngine }).soundgineer = engine

// Progressive enhancement: WebMCP registration must never block synth startup.
try {
  const webMcp = registerWebMcpTools(engine, undefined, { audioTools: 'exclude' })
  if (document.modelContext) void webMcp.ready.then(() => agentActivity.setToolReadiness(9, true))
  bindWebMcpLifecycle({
    ready: webMcp.ready,
    dispose() {
      webMcp.dispose()
      audioWebMcp?.dispose()
    }
  }, window, import.meta.hot)
} catch (error) {
  console.warn('WebMCP is unavailable:', error)
}
