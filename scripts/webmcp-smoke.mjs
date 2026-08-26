// Production WebMCP smoke test using a standards-shaped shim; no experimental
// browser WebMCP implementation is required.
import { chromium } from 'playwright'

const url = process.argv[2] ?? 'http://localhost:4173/'
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--autoplay-policy=no-user-gesture-required']
})

async function trackedPage() {
  const page = await browser.newPage()
  const errors = []
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', error => errors.push(String(error)))
  return { page, errors }
}

try {
  // Progressive-enhancement path: the unmodified browser has no shim.
  const normal = await trackedPage()
  await normal.page.goto(url, { waitUntil: 'networkidle' })
  const normalState = await normal.page.evaluate(() => ({
    hasEngine: Boolean(window.soundgineer),
    hasOverlay: Boolean(document.getElementById('start-overlay')),
    hasModelContext: Boolean(document.modelContext)
  }))
  if (!normalState.hasEngine || !normalState.hasOverlay) throw new Error('App did not boot without WebMCP')
  if (normal.errors.length) throw new Error(`No-shim page errors:\n${normal.errors.join('\n')}`)
  await normal.page.close()

  const shimmed = await trackedPage()
  await shimmed.page.addInitScript(() => {
    const tools = new Map()
    const modelContext = {
      registerTool(tool, options = {}) {
        tools.set(tool.name, tool)
        options.signal?.addEventListener('abort', () => tools.delete(tool.name), { once: true })
        return Promise.resolve()
      },
      async getTools() { return [...tools.values()] },
      ontoolchange: null,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return true }
    }
    Object.defineProperty(Document.prototype, 'modelContext', {
      configurable: true,
      get: () => modelContext
    })
    Object.defineProperty(window, '__webMcpTools', { value: tools })
  })
  await shimmed.page.goto(url, { waitUntil: 'networkidle' })
  await shimmed.page.waitForFunction(() => window.__webMcpTools?.size === 9)
  await shimmed.page.click('#start-btn')
  await shimmed.page.waitForFunction(() => !document.getElementById('start-overlay'), { timeout: 10000 })

  const result = await shimmed.page.evaluate(async () => {
    const tools = window.__webMcpTools
    const call = async (name, input = {}) => {
      const tool = tools.get(name)
      if (!tool) throw new Error(`Missing tool: ${name}`)
      const controller = new AbortController()
      // Match the standards API callback shape exactly.
      return await tool.execute(input, { signal: controller.signal })
    }
    const names = [...tools.keys()]
    const state = await call('get_synth_state')
    const schema = await call('get_parameter_schema', { group: 'global' })
    const update = await call('update_parameters', { updates: [{ id: 'master.volume', value: 0.8 }] })
    const modulation = await call('set_modulation', {
      action: 'add', source: 'lfo1', destination: 'osc1.morph', depth: 0.2
    })
    const played = await call('play_notes', {
      notes: [{ midi: 60, velocity: 0.9, start: 0, duration: 0.15 }]
    })
    const render = await call('render_audio', {
      notes: [{ midi: 60, velocity: 0.9, start: 0, duration: 0.25 }], duration: 0.6
    })
    const renderedBlob = await (await fetch(render.url)).blob()
    const analysis = await call('analyze_audio')
    await call('save_preset', { name: 'WebMCP Smoke' })
    await call('update_parameters', { updates: [{ id: 'master.volume', value: 0.3 }] })
    const loaded = await call('load_preset', { name: 'WebMCP Smoke' })
    return {
      names, running: state.runtime.running,
      schemaCount: schema.parameters.length,
      appliedRaw: update.applied[0].raw,
      modulationCount: modulation.count,
      played,
      render: {
        mode: render.renderMode,
        mimeType: render.mimeType,
        blobSize: renderedBlob.size,
        peakDb: render.metrics.peakDb,
        rmsDb: render.metrics.rmsDb,
        channels: render.channels
      },
      analysisSource: analysis.source,
      loadedRaw: loaded.state.patch.parameters['master.volume'].raw,
      heldNotes: window.soundgineer.heldNotes.size
    }
  })

  const expectedNames = [
    'get_synth_state', 'get_parameter_schema', 'update_parameters', 'set_modulation',
    'play_notes', 'render_audio', 'analyze_audio', 'save_preset', 'load_preset'
  ]
  if (JSON.stringify(result.names) !== JSON.stringify(expectedNames)) throw new Error(`Unexpected tools: ${result.names}`)
  if (!result.running || !result.schemaCount || result.appliedRaw !== 0.8) throw new Error('State/schema/update check failed')
  if (result.modulationCount !== 1 || result.played.noteCount !== 1 || result.heldNotes !== 0) throw new Error('Modulation/note check failed')
  if (result.render.mode !== 'realtime' || result.render.blobSize <= 0 || result.render.channels < 1) throw new Error('Render metadata check failed')
  if (!Number.isFinite(result.render.peakDb) || result.render.peakDb <= -80 || !Number.isFinite(result.render.rmsDb)) {
    throw new Error(`Rendered audio is silent: ${JSON.stringify(result.render)}`)
  }
  if (result.analysisSource !== 'last-render' || Math.abs(result.loadedRaw - 0.8) > 1e-6) throw new Error('Analysis/preset check failed')
  if (shimmed.errors.length) throw new Error(`Shimmed page errors:\n${shimmed.errors.join('\n')}`)
  console.log(JSON.stringify(result, null, 2))
  console.log('WEBMCP SMOKE OK')
} finally {
  await browser.close()
}
