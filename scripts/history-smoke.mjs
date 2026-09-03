// Production history regression using real controls and a standards-shaped WebMCP shim.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

// Every tool registers at page load and the set never changes across the
// gesture, so one constant covers both sides of the Start click. play_notes is
// registered but refuses until audio starts: an agent that could not see it
// concluded playback was not a tool at all and went off to drive the DOM
// instead.
// Thirteen synth tools, four history tools, two guide tools. `webmcp-smoke.mjs`
// holds the names; this file only ever needs the total.
const TOOL_COUNT = 24

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.addInitScript(() => {
    const tools = new Map()
    Object.defineProperty(document, 'modelContext', { value: {
      registerTool(tool, options = {}) {
        tools.set(tool.name, tool)
        options.signal?.addEventListener('abort', () => tools.delete(tool.name), { once: true })
      }
    } })
    window.__historyTools = tools
    // History is a returning-user concern. The first-run walkthrough (covered by
    // guide-smoke) opens right after audio starts and its driver.js overlay makes
    // the whole app `pointer-events: none`, so every synthetic gesture below would
    // silently land on the overlay instead of a control.
    try { localStorage.setItem('cosynth.walkthrough.seen.v1', '1') } catch { /* Storage can be blocked. */ }
  })
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:4175/', { waitUntil: 'networkidle' })
  const call = (name, input = {}) => page.evaluate(async ({ name, input }) =>
    window.__historyTools.get(name).execute(input, { signal: new AbortController().signal }), { name, input })
  const sounds = () => call('get_history', { view: 'sounds', limit: 20 })
  const replays = () => call('get_history', { view: 'replays', limit: 20 })
  const patch = () => page.evaluate(() => window.coSynth.toPreset('History smoke'))
  const update = (id, value) => call('update_parameters', { updates: [{ id, value }] })
  const navigate = async (action, entryId) => call('navigate_history', { action, entryId, expectedRevision: (await sounds()).revision })
  const target = id => page.locator(`[data-guide-id="${id}"]`)
  const clearGuide = () => call('show_ui_guide', { steps: [] })
  const startInBackground = async (name, input) => page.evaluate(({ name, input }) => {
    window.__pendingHistoryResult = undefined
    window.__historyTools.get(name).execute(input, { signal: new AbortController().signal })
      .then(result => { window.__pendingHistoryResult = result })
      .catch(error => { window.__pendingHistoryResult = { error: String(error) } })
  }, { name, input })
  const finishBackground = async () => {
    await page.waitForFunction(() => window.__pendingHistoryResult !== undefined)
    return page.evaluate(() => window.__pendingHistoryResult)
  }
  const held = () => page.evaluate(() => window.coSynth.heldNotes.size)
  const noteOns = () => page.evaluate(() => window.__historyNotes.filter(event => event.on).map(event => event.midi))
  // Returns how many separate patch mutations the gesture produced. Grouping is
  // only meaningful when the drag really emitted several of them, so the caller
  // asserts on this instead of trusting that the pointer did anything at all.
  const drag = async (id, moves = 4) => {
    const canvas = target(id).locator('.knob-main-canvas')
    await canvas.scrollIntoViewIfNeeded()
    const bounds = await canvas.boundingBox()
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2
    // An overlay (guide, dialog, modal) would swallow the whole drag without any
    // assertion below noticing that nothing was dragged.
    assert.equal(await page.evaluate(([px, py]) =>
      document.elementFromPoint(px, py)?.classList.contains('knob-main-canvas') === true, [x, y]),
    true, `The pointer must reach the ${id} knob canvas`)
    await page.evaluate(() => {
      window.__dragMutations = 0
      window.__dragStop = window.coSynth.onPatchChange(mutation => {
        if (mutation.changes.some(change => change.kind === 'param')) window.__dragMutations++
      })
    })
    await page.mouse.move(x, y)
    await page.mouse.down()
    for (let move = 1; move <= moves; move++) await page.mouse.move(x, y - move * 8)
    await page.mouse.up()
    return page.evaluate(() => { window.__dragStop(); return window.__dragMutations })
  }

  await page.waitForFunction(count => window.__historyTools.size === count, TOOL_COUNT)
  const preAudio = await sounds()
  const octave = await page.locator('.oct-label').textContent()
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Meta+z')
  assert.equal(await page.locator('#start-overlay').count(), 1, 'Undo must not unlock audio')
  assert.equal(await page.locator('.oct-label').textContent(), octave, 'Undo must not shift octave')
  assert.equal((await sounds()).revision, preAudio.revision)
  await call('show_ui_guide', { steps: [{ markdown: 'History works before audio starts.' }] })
  await clearGuide()
  const intro = (await replays()).items.find(entry => entry.kind === 'guide')
  assert.ok(intro)
  await call('replay_history', { entryId: intro.id })
  assert.equal(await page.locator('.driver-popover-description').textContent(), 'History works before audio starts.')
  await clearGuide()
  await page.locator('#start-btn').click()
  await page.waitForFunction(count => window.__historyTools.size === count, TOOL_COUNT)
  await page.evaluate(() => {
    window.__historyNotes = []
    window.coSynth.onNote((midi, on) => window.__historyNotes.push({ midi, on }))
  })

  // AI performs once. Subsequent human edits and history navigation never erase it.
  await update('master.volume', 0.6)
  const notes = [
    { midi: 48, velocity: 0.7, start: 0, duration: 0.08 },
    { midi: 55, velocity: 0.6, start: 0.13, duration: 0.08 },
    { midi: 51, velocity: 0.8, start: 0.26, duration: 0.08 }
  ]
  const played = await call('play_notes', { notes })
  assert.equal(played.noteCount, 3)
  const performance = (await replays()).items.find(entry => entry.kind === 'performance')
  assert.equal(performance.noteCount, 3)
  const beforeDrag = await sounds()
  const beforeDragPatch = await patch()
  const dragMutations = await drag('param.osc1.morph')
  assert.ok(dragMutations > 1, `The drag must emit several patch mutations to group, got ${dragMutations}`)
  const afterDrag = await sounds()
  assert.equal(afterDrag.total, beforeDrag.total + 1, 'A multi-event drag must create exactly one sound entry')
  const humanEntry = afterDrag.items.find(entry => entry.current)
  assert.equal(humanEntry.origin, 'human')
  assert.ok(humanEntry.changed.includes('osc1.morph'))
  const afterDragPatch = await patch()
  assert.notDeepEqual(afterDragPatch, beforeDragPatch)
  const replayCount = (await replays()).total
  await call('replay_history', { entryId: performance.id })
  assert.deepEqual((await noteOns()).slice(-3), notes.map(note => note.midi))
  assert.deepEqual(await patch(), afterDragPatch, 'Replay uses the current patch without restoring sound')
  await page.keyboard.press('Control+z')
  assert.deepEqual(await patch(), beforeDragPatch)
  assert.equal(await page.locator('.oct-label').textContent(), octave)
  assert.equal(await held(), 0)
  // The button is an icon button: its label lives in aria-label, and a short
  // performance can pass through Stop faster than a poll, so record the labels.
  await page.evaluate(() => {
    const button = document.querySelector('[data-guide-id="button.history.play"]')
    window.__playLabels = [button.getAttribute('aria-label')]
    new MutationObserver(() => window.__playLabels.push(button.getAttribute('aria-label')))
      .observe(button, { attributes: true, attributeFilter: ['aria-label'] })
  })
  await target('button.history.play').click()
  await page.waitForFunction(() => window.__playLabels.includes('Stop'))
  await page.waitForFunction(() => window.__playLabels.at(-1) === 'Play again')
  assert.deepEqual((await noteOns()).slice(-3), notes.map(note => note.midi))
  assert.equal((await replays()).total, replayCount, 'Replaying must not duplicate a saved performance')
  await page.keyboard.press('Control+Shift+z')
  assert.deepEqual(await patch(), afterDragPatch)
  await page.keyboard.press('Meta+z')
  assert.deepEqual(await patch(), beforeDragPatch)

  // An edit from an older sound keeps the abandoned version restorable.
  const staleRevision = (await sounds()).revision
  await update('macro1.value', 0.35)
  const branch = await sounds()
  assert.ok(branch.items.some(entry => entry.id === humanEntry.id && !entry.activePath))
  const stale = await call('navigate_history', { action: 'undo', expectedRevision: staleRevision })
  assert.equal(stale.ok, false)
  assert.equal((await sounds()).currentId, branch.currentId)
  await target('button.history.open').click()
  assert.equal(await page.locator('.history-alternatives').isVisible(), true)
  assert.equal(await page.locator('.history-alternatives').getAttribute('open'), null)
  await target('button.dialog.history.close').click()
  await navigate('restore', humanEntry.id)
  assert.deepEqual(await patch(), afterDragPatch)

  // Text inputs keep native undo. This fixture represents editable app/dialog fields.
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.id = 'history-native-undo-fixture'
    input.setAttribute('aria-label', 'Native undo test')
    input.style.cssText = 'position:fixed;top:70px;left:10px;z-index:9999'
    input.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        queueMicrotask(() => { window.__nativeUndoPrevented = event.defaultPrevented })
      }
    })
    document.querySelector('#app').append(input)
  })
  const native = page.locator('#history-native-undo-fixture')
  await native.focus()
  await page.keyboard.type('Native editing')
  const beforeNativeUndo = await sounds()
  // Chromium follows the host platform's native editing accelerator.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  assert.equal(await page.evaluate(() => window.__nativeUndoPrevented), false, 'The app must not prevent native input undo')
  // Native editing may split typing into multiple undo units; verify undo/redo
  // changes text and restores it, without assuming Chromium's grouping policy.
  assert.notEqual(await native.inputValue(), 'Native editing')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z')
  assert.equal(await native.inputValue(), 'Native editing')
  assert.equal((await sounds()).revision, beforeNativeUndo.revision)
  await native.evaluate(input => input.remove())
  assert.equal(await page.locator('.oct-label').textContent(), octave)

  // AI cannot join a human gesture mid-drag.
  const knob = target('param.osc1.morph').locator('.knob-main-canvas')
  await knob.scrollIntoViewIfNeeded()
  const bounds = await knob.boundingBox()
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y - 20)
  const busy = await update('macro2.value', 0.4)
  assert.equal(busy.ok, false, 'AI patch mutations must be rejected during a human gesture')
  await page.mouse.up()

  // Invalid input never becomes replayable; Stop and Undo retain cancelled performances.
  const beforeInvalid = (await replays()).total
  assert.equal((await call('play_notes', { notes: [{ midi: 900, velocity: 1, start: 0, duration: 1 }] })).ok, false)
  assert.equal((await replays()).total, beforeInvalid)
  await startInBackground('play_notes', { notes: [{ midi: 60, velocity: 0.5, start: 0, duration: 3 }] })
  await page.waitForFunction(() => window.coSynth.heldNotes.has(60))
  await call('stop_performance')
  await finishBackground()
  assert.equal(await held(), 0)
  assert.ok((await replays()).items.some(entry => entry.kind === 'performance' && entry.status === 'cancelled'))
  // Explicitly real time: render_audio is offline by default now, and only the
  // live path holds notes on the engine that history restoration has to wait for.
  await startInBackground('render_audio', { notes: [{ midi: 62, velocity: 0.5, start: 0, duration: 3 }], duration: 4, mode: 'realtime' })
  await page.waitForFunction(() => window.coSynth.heldNotes.has(62))
  await navigate('undo')
  await finishBackground()
  assert.equal(await held(), 0, 'History restoration must await render note cleanup')
  assert.equal(await target('button.history.play').getAttribute('aria-label'), 'Play again')

  // Reopen a closed walkthrough through History. It starts from step one, not the closed step.
  const beforeGuide = await patch()
  const beforeGuideHistory = await sounds()
  await call('show_ui_guide', { steps: [
    { target: { id: 'panel.osc1' }, title: 'Replayable lesson', markdown: 'First step.' },
    { target: { id: 'param.filter1.cutoff' }, markdown: 'Second step.' }
  ] })
  await page.locator('.driver-popover-next-btn').click()
  await page.keyboard.press('Escape')
  const guide = (await replays()).items.find(entry => entry.kind === 'guide' && entry.stepCount === 2)
  await target('button.history.open').click()
  await page.getByRole('tab', { name: 'Replays', exact: true }).click()
  await page.locator(`[data-replay-id="${guide.id}"]`).getByRole('button', { name: 'Open walkthrough' }).click()
  await page.waitForFunction(() => document.querySelector('.driver-active-element')?.dataset.guideId === 'panel.osc1')
  assert.equal(await page.locator('dialog[open]').count(), 0)
  assert.equal(await page.locator('.driver-popover-title').textContent(), 'Replayable lesson')
  await clearGuide()
  assert.deepEqual(await patch(), beforeGuide)
  assert.equal((await sounds()).revision, beforeGuideHistory.revision)

  await page.setViewportSize({ width: 390, height: 844 })
  await target('button.history.open').click()
  await page.getByRole('tab', { name: 'Sound history', exact: true }).click()
  const dialog = await target('dialog.history').boundingBox()
  assert.ok(dialog.x >= 0 && dialog.x + dialog.width <= 391)
  assert.ok(dialog.y >= 0 && dialog.y + dialog.height <= 845)
  assert.match(await page.locator('.history-retention').textContent(), /120 entries per tab.*128 MiB/)
  await page.getByRole('tab', { name: 'Replays', exact: true }).click()
  assert.equal(await page.locator('#history-view-replays').isVisible(), true)
  await target('button.dialog.history.close').click()
  assert.deepEqual(errors, [])
  console.log('HISTORY SMOKE OK: human/AI undo, grouped gestures, retained branches, current-patch replay, native shortcuts, cancellation, walkthroughs, and narrow History verified.')
} finally {
  await browser.close()
}
