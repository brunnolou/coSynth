import './style.css'
import { SynthEngine } from './audio/engine'
import { buildApp } from './ui/app'

const engine = new SynthEngine()
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
const start = async () => {
  if (starting) return
  starting = true
  try {
    await engine.start()
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
