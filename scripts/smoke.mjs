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
await page.waitForSelector('.driver-popover-title')
if (await page.locator('.driver-popover-title').textContent() !== 'Create sounds with AI') {
  console.error('First-run walkthrough did not open after audio started')
  process.exit(1)
}
// This browser exposes no native modelContext, so the vendored webmcp.dev
// widget is the registration path. It does register, which moves the AI status
// button off "AI off" and makes the strip report a tool count - so this asserts
// the legacy fallback reached the tools end to end. Before that fallback
// existed, no-WebMCP meant no tools and the button stayed off.
const aiButton = page.locator('[data-guide-id="button.agent.checkpoint"] .agent-status-label')
try {
  await aiButton.filter({ hasText: 'AI ready' }).waitFor({ timeout: 10000 })
} catch {
  console.error(`Legacy WebMCP fallback did not register tools; AI button reads ${JSON.stringify(await aiButton.textContent())}`)
  process.exit(1)
}
const readiness = await page.locator('.agent-live-message').textContent()
if (!/\d+ tools ready/.test(readiness ?? '')) {
  console.error(`AI strip did not report a registered tool count; it reads ${JSON.stringify(readiness)}`)
  process.exit(1)
}

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
