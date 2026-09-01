// Headless smoke test: boot the built app, start audio, play a note, and
// verify the worklet produces non-silent output + no console errors.
import { chromium } from 'playwright'

const url = process.argv[2] ?? 'http://localhost:4173/'
const browser = await chromium.launch({
  // CHROMIUM_PATH lets CI/sandboxes point at a pre-installed binary
  // (e.g. /opt/pw-browsers/chromium) instead of downloading one.
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--autoplay-policy=no-user-gesture-required']
})
const page = await browser.newPage()
const errors = []
page.on('console', m => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', e => errors.push(String(e)))

await page.goto(url, { waitUntil: 'networkidle' })
await page.click('#start-btn')
await page.waitForFunction(() => !document.getElementById('start-overlay'), { timeout: 10000 })

const state = await page.evaluate(async () => {
  const eng = window.coSynth
  eng.noteOn(48, 0.9)
  eng.noteOn(60, 0.9)
  eng.noteOn(64, 0.9)
  await new Promise(r => setTimeout(r, 600))
  let peak = 0
  for (const v of eng.scopeL) peak = Math.max(peak, Math.abs(v))
  const voiceCount = eng.voiceCount
  eng.noteOff(48); eng.noteOff(60); eng.noteOff(64)
  // exercise morph + a mod route + filter + fx params
  eng.setParamById('osc1.morph', 0.8)
  eng.setParamById('filter1.cutoff', 0.4)
  eng.setParamById('reverb.enabled', 1)
  eng.addModRoute(6, 4) // lfo1 -> some param
  await new Promise(r => setTimeout(r, 300))
  return {
    ctxState: eng.ctx.state,
    sampleRate: eng.ctx.sampleRate,
    peak,
    voiceCount,
    tables: eng.currentTables.map(t => t && `${t.name}:${t.numFrames}f`)
  }
})

await page.screenshot({ path: process.env.SHOT || 'smoke.png', fullPage: false })
await browser.close()

console.log(JSON.stringify(state, null, 2))
if (errors.length) {
  console.error('CONSOLE ERRORS:\n' + errors.join('\n'))
  process.exit(1)
}
if (state.ctxState !== 'running') {
  console.error('AudioContext not running')
  process.exit(1)
}
if (!(state.peak > 0.01)) {
  console.error('No audio produced (peak ' + state.peak + ')')
  process.exit(1)
}
console.log('SMOKE OK')
