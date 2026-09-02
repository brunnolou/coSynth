// Production-build regression test. The standards-shaped shim exercises the
// registered tools without depending on a browser's experimental WebMCP flag.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

// Only play_notes waits for the audio gesture; render_audio registers at load
// because it renders offline.
const TOOLS_AT_LOAD = 17
const TOOLS_AFTER_AUDIO = 18

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' })
  const errors = []
  const mediaRequests = []
  page.on('pageerror', error => errors.push(String(error)))
  page.on('request', request => { if (request.url().includes('never-load.example')) mediaRequests.push(request.url()) })
  await page.addInitScript(() => {
    const tools = new Map()
    Object.defineProperty(document, 'modelContext', { value: {
      registerTool(tool, options = {}) {
        tools.set(tool.name, tool)
        options.signal?.addEventListener('abort', () => tools.delete(tool.name), { once: true })
      }
    } })
    window.__guideTestTools = tools
  })
  await page.goto(process.argv[2] ?? 'http://localhost:4173/', { waitUntil: 'networkidle' })
  const call = (name, input = {}) => page.evaluate(async ({ name, input }) => window.__guideTestTools.get(name).execute(input), { name, input })
  const show = steps => call('show_ui_guide', { steps })
  const clear = () => show([])
  const snapshot = () => page.evaluate(() => window.coSynth.toPreset('Guide regression'))
  const highlighted = id => page.waitForFunction(id => document.querySelector('.driver-active-element')?.dataset.guideId === id, id)
  const next = () => page.locator('.driver-popover-next-btn').click()
  const previous = () => page.locator('.driver-popover-prev-btn').click()

  await page.waitForFunction(count => window.__guideTestTools.size === count, TOOLS_AT_LOAD)
  assert.equal(await page.locator('.agent-feed-line').textContent(), `${TOOLS_AT_LOAD} tools ready · Start audio to unlock 1`)
  await show([{ markdown: 'Introduction' }, { target: { id: 'button.audio.start' }, markdown: 'Start audio yourself when ready.' }])
  await page.keyboard.press('ArrowRight')
  await highlighted('button.audio.start')
  assert.equal(await page.locator('#start-overlay').count(), 1, 'Guide navigation must not start audio')
  await page.keyboard.press('Escape')
  await page.locator('.driver-popover').waitFor({ state: 'detached' })
  const replaysBeforeWelcome = await call('get_history', { view: 'replays', limit: 20 })
  await page.locator('#start-btn').click()
  await page.locator('#start-overlay').waitFor({ state: 'detached' })
  await page.waitForFunction(count => window.__guideTestTools.size === count, TOOLS_AFTER_AUDIO)

  // The built-in tour starts once after audio and stays separate from AI replay history.
  await page.locator('.driver-popover-title', { hasText: 'Create sounds with AI' }).waitFor()
  const welcomeStyles = await page.locator('.driver-popover').evaluate(popover => ({
    titleSize: getComputedStyle(popover.querySelector('.driver-popover-title')).fontSize,
    descriptionSize: getComputedStyle(popover.querySelector('.driver-popover-description')).fontSize,
    titleSelection: getComputedStyle(popover.querySelector('.driver-popover-title')).userSelect,
    descriptionSelection: getComputedStyle(popover.querySelector('.driver-popover-description')).userSelect,
    overlayAnimations: document.querySelector('.driver-overlay').getAnimations().length
  }))
  assert.deepEqual(welcomeStyles, {
    titleSize: '16px', descriptionSize: '14px', titleSelection: 'text', descriptionSelection: 'text', overlayAnimations: 0
  })
  assert.match(await page.locator('.driver-popover-description').textContent(), /ChatGPT Desktop/)
  assert.match(await page.locator('.driver-popover-description').textContent(), /WebMCP/)
  await next(); await highlighted('panel.agent.ai')
  assert.equal(await page.locator('.driver-popover-description li').count(), 5)
  await next(); await highlighted('panel.keyboard')
  assert.match(await page.locator('.driver-popover-description').textContent(), /A W S E D F T G Y H U J K/)
  assert.match(await page.locator('.driver-popover-description').textContent(), /Z \/ X/)
  await next(); await highlighted('panel.synth')
  assert.match(await page.locator('.driver-popover-description').textContent(), /80s synth bass/)
  await next()
  await page.locator('.driver-popover').waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(() => localStorage.getItem('cosynth.walkthrough.seen.v1')), '1')
  const replaysAfterWelcome = await call('get_history', { view: 'replays', limit: 20 })
  assert.equal(replaysAfterWelcome.total, replaysBeforeWelcome.total, 'Built-in tour must stay out of Replays')

  const walkthrough = page.locator('[data-guide-id="button.history.walkthrough"]')
  assert.equal(await walkthrough.getAttribute('aria-label'), 'Walkthrough')
  const activityBounds = await page.locator('.agent-activity-panel').boundingBox()
  const walkthroughBounds = await walkthrough.boundingBox()
  assert.ok(Math.abs(activityBounds.x + activityBounds.width - walkthroughBounds.x - walkthroughBounds.width) <= 8,
    'Walkthrough Help must align to the right edge of the activity bar')
  await walkthrough.click()
  await page.locator('.driver-popover-title', { hasText: 'Create sounds with AI' }).waitFor()
  await page.locator('.driver-popover-close-btn').click()
  await page.locator('.driver-popover').waitFor({ state: 'detached' })
  assert.equal(await page.locator('body').evaluate(body => body.classList.contains('guide-overlay-static')), false)
  const initial = await snapshot()

  const echo = await call('get_ui_targets', { search: 'echo' })
  assert.equal(echo.items[0].id, 'fx.delay')
  const allIds = await page.locator('[data-guide-id]').evaluateAll(nodes => nodes.map(n => n.dataset.guideId))
  assert.equal(new Set(allIds).size, allIds.length, 'Semantic IDs must be unique')
  await show([{ target: { id: 'fx.delay' } }])
  await highlighted('fx.delay')
  assert.equal(await page.locator('.guide-highlight-only .driver-popover-close-btn').isVisible(), true)
  assert.equal(await page.locator('[data-guide-id="fx.delay"]').evaluate(e => getComputedStyle(e).pointerEvents), 'auto')
  const ambiguous = await show([{ target: { selector: '.knob' } }])
  assert.equal(ambiguous.ok, false)
  await highlighted('fx.delay')
  assert.equal((await show([{ target: { selector: '[' } }])).ok, false)
  await clear()

  // Semantic targets survive a user reordering the effect rack.
  await page.locator('[data-guide-id="button.fx.delay.up"]').click()
  const reordered = await snapshot()
  await show([{ target: { id: 'fx.delay' }, markdown: 'Delay stays discoverable after reordering.' }])
  await highlighted('fx.delay')
  assert.deepEqual(await snapshot(), reordered)
  await clear()
  await page.locator('[data-guide-id="button.fx.delay.down"]').click()
  const soundHistoryBeforeGuides = await call('get_history', { view: 'sounds' })

  await show([
    { target: { id: 'panel.osc1' }, title: 'Choose the wave', markdown: 'Select **Basic Shapes**. Next: amplitude.' },
    { target: { id: 'tab.env1' }, title: 'Shape the amplitude', markdown: 'Attack **0**, Decay **0.2–0.4s**, Sustain **0%**.' },
    { target: { id: 'source.env1' }, markdown: 'This is the source. Next: Filter 1 Cutoff.' },
    { target: { id: 'param.filter1.cutoff' }, markdown: 'This is the destination.' }
  ])
  await highlighted('panel.osc1')
  assert.equal(await page.locator('.driver-popover-prev-btn').isVisible(), false)
  await next(); await highlighted('tab.env1')
  await previous(); await highlighted('panel.osc1')
  await next(); await next(); await highlighted('source.env1')
  await next(); await highlighted('param.filter1.cutoff')
  assert.equal(await page.locator('.driver-popover-next-btn').textContent(), 'Done')
  await next()
  await page.locator('.driver-popover').waitFor({ state: 'detached' })

  await show([{ target: { id: 'tab.lfo2' }, markdown: 'Select LFO 2.' }, { target: { id: 'param.lfo2.rate' }, markdown: 'Rate appears after selecting the tab.' }])
  await highlighted('tab.lfo2')
  assert.equal(await page.locator('[data-guide-id="param.lfo2.rate"]').count(), 0, 'Guide must not select the tab')
  await page.locator('[data-guide-id="tab.lfo2"]').click()
  await next(); await highlighted('param.lfo2.rate')
  await clear()
  await show([{ target: { id: 'tab.env2' }, markdown: 'Select Env 2.' }, { target: { id: 'param.env2.attack' }, markdown: 'Adjust Attack yourself.' }])
  await highlighted('tab.env2')
  assert.equal(await page.locator('[data-guide-id="param.env2.attack"]').count(), 0)
  await page.locator('[data-guide-id="tab.env2"]').click()
  await next(); await highlighted('param.env2.attack')
  await clear()
  await show([{ target: { id: 'param.env6.attack' }, markdown: 'Missing target instructions remain visible.' }])
  assert.match(await page.locator('.driver-popover-description').textContent(), /Target unavailable/)
  await clear()

  await show([{ title: '<img src=x onerror=alert(1)>', markdown: '# Learn\n\n- **Bold**\n- `Code`\n\n<img src="https://never-load.example/html.png">\n\n![Alt text](https://never-load.example/image.png)\n\n[unsafe](javascript:alert%281%29) [docs](https://driverjs.com)' }])
  assert.equal(await page.locator('.driver-popover img, .driver-popover script').count(), 0)
  assert.equal(await page.locator('.driver-popover a').count(), 1)
  assert.match(await page.locator('.driver-popover-title').textContent(), /<img/)
  assert.equal(mediaRequests.length, 0)
  await show([{ markdown: 'Replacement' }])
  assert.equal(await page.locator('.driver-popover').count(), 1)
  await clear()

  await page.locator('[data-guide-id="button.history.open"]').click()
  await show([{ target: { id: 'button.dialog.history.close' }, markdown: 'Close this dialog.' }])
  await highlighted('button.dialog.history.close')
  assert.equal(await page.locator('dialog[open] .driver-popover').count(), 1)
  await page.locator('[data-guide-id="button.dialog.history.close"]').click()
  await page.locator('body > .driver-popover .guide-warning').waitFor()
  await clear()
  assert.deepEqual(await snapshot(), initial, 'Teaching must not change synth state')
  const soundHistoryAfterGuides = await call('get_history', { view: 'sounds' })
  assert.equal(soundHistoryAfterGuides.revision, soundHistoryBeforeGuides.revision, 'Guides must not create sound undo entries')
  assert.equal(soundHistoryAfterGuides.total, soundHistoryBeforeGuides.total)
  const replays = await call('get_history', { view: 'replays', limit: 20 })
  assert.ok(replays.items.some(entry => entry.kind === 'guide'), 'Closed walkthroughs must remain replayable')

  // Adjust the real highlighted knob with the pointer, not through a test hook.
  await show([{ target: { id: 'param.osc1.morph' }, markdown: 'Turn Morph.' }])
  await highlighted('param.osc1.morph')
  const canvas = page.locator('[data-guide-id="param.osc1.morph"] .knob-main-canvas')
  const bounds = await canvas.boundingBox()
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y - 30)
  await page.mouse.up()
  assert.notDeepEqual(await snapshot(), initial, 'The human must be able to turn the highlighted knob')
  await clear()

  await page.setViewportSize({ width: 390, height: 844 })
  await show([{ target: { id: 'fx.delay' }, markdown: 'Delay scrolls into the visible main area.' }])
  await highlighted('fx.delay')
  const delayBounds = await page.locator('[data-guide-id="fx.delay"]').boundingBox()
  const mainBounds = await page.locator('main').boundingBox()
  assert.ok(delayBounds.y >= mainBounds.y && delayBounds.y + delayBounds.height <= mainBounds.y + mainBounds.height, 'Target must not be clipped by the inner scroll container')
  await clear()
  await show([{ markdown: 'Text-only help\n\n' + 'A readable explanation. '.repeat(70) }])
  const boundsSmall = await page.locator('.driver-popover').boundingBox()
  assert.ok(boundsSmall.x >= 0 && boundsSmall.x + boundsSmall.width <= 391)
  assert.ok(boundsSmall.y >= 0 && boundsSmall.y + boundsSmall.height <= 844)
  await page.locator('.driver-overlay').click({ position: { x: 3, y: 3 } })
  await page.locator('.driver-popover').waitFor({ state: 'detached' })

  // Every built-in step remains readable when the synth switches to its narrow layout.
  await walkthrough.click()
  for (const title of ['Create sounds with AI', 'Your sound-design partner', 'Play it', 'Ask for anything']) {
    await page.locator('.driver-popover-title', { hasText: title }).waitFor()
    const popover = await page.locator('.driver-popover').boundingBox()
    assert.ok(popover.x >= 0 && popover.x + popover.width <= 391, `${title} must fit horizontally`)
    assert.ok(popover.y >= 0 && popover.y + popover.height <= 844, `${title} must fit vertically`)
    await next()
  }
  await page.locator('.driver-popover').waitFor({ state: 'detached' })
  assert.deepEqual(errors, [])
  console.log(`Guide smoke passed: ${TOOLS_AFTER_AUDIO} tools; discovery, interactive tours, safe Markdown, dynamic targets, dialogs, mobile, and unchanged sound history verified.`)
} finally {
  await browser.close()
}
