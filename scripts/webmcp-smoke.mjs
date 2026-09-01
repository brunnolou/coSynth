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
    hasEngine: Boolean(window.coSynth),
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
  await shimmed.page.waitForFunction(() => window.__webMcpTools?.size === 15)
  const toolsBeforeAudio = await shimmed.page.evaluate(() => [...window.__webMcpTools.keys()])
  if (toolsBeforeAudio.includes('play_notes') || toolsBeforeAudio.includes('render_audio')) {
    throw new Error('Audio tools were exposed before audio startup')
  }
  await shimmed.page.click('#start-btn')
  await shimmed.page.waitForFunction(() => !document.getElementById('start-overlay'), { timeout: 10000 })
  await shimmed.page.waitForFunction(() => window.__webMcpTools?.size === 17)

  const result = await shimmed.page.evaluate(async () => {
    const tools = window.__webMcpTools
    const call = async (name, input = {}) => {
      const tool = tools.get(name)
      if (!tool) throw new Error(`Missing tool: ${name}`)
      const controller = new AbortController()
      // Match the standards API callback shape exactly.
      return await tool.execute(input, { signal: controller.signal })
    }
    const callWithoutOptions = async (name, input = {}) => {
      const tool = tools.get(name)
      if (!tool) throw new Error(`Missing tool: ${name}`)
      return await tool.execute(input)
    }
    const callWithoutSignal = async (name, input = {}) => {
      const tool = tools.get(name)
      if (!tool) throw new Error(`Missing tool: ${name}`)
      return await tool.execute(input, {})
    }
    const names = [...tools.keys()]
    const makeReferenceWavBase64 = () => {
      const sampleRate = 8000
      const frames = 800
      const channels = 2
      const bytesPerSample = 2
      const blockAlign = channels * bytesPerSample
      const buffer = new ArrayBuffer(44 + frames * blockAlign)
      const view = new DataView(buffer)
      const text = (offset, value) => {
        for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index))
      }
      text(0, 'RIFF')
      view.setUint32(4, buffer.byteLength - 8, true)
      text(8, 'WAVE')
      text(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, channels, true)
      view.setUint32(24, sampleRate, true)
      view.setUint32(28, sampleRate * blockAlign, true)
      view.setUint16(32, blockAlign, true)
      view.setUint16(34, bytesPerSample * 8, true)
      text(36, 'data')
      view.setUint32(40, frames * blockAlign, true)
      for (let frame = 0; frame < frames; frame++) {
        const left = Math.sin(2 * Math.PI * 440 * frame / sampleRate) * 0.4
        const right = Math.sin(2 * Math.PI * 660 * frame / sampleRate) * 0.25
        view.setInt16(44 + frame * blockAlign, Math.round(left * 32767), true)
        view.setInt16(46 + frame * blockAlign, Math.round(right * 32767), true)
      }
      const data = new Uint8Array(buffer)
      let binary = ''
      for (let index = 0; index < data.length; index++) binary += String.fromCharCode(data[index])
      return btoa(binary)
    }
    const state = await call('get_synth_state')
    const schema = await call('get_parameter_schema', { group: 'global' })
    const update = await call('update_parameters', { updates: [{ id: 'master.volume', value: 0.8 }] })
    const modulation = await call('set_modulation', {
      action: 'add', source: 'lfo1', destination: 'osc1.morph', depth: 0.2
    })
    const played = await callWithoutOptions('play_notes', {
      notes: [{ midi: 60, velocity: 0.9, start: 0, duration: 0.15 }]
    })
    const referenceBase64 = makeReferenceWavBase64()
    const reference = await call('analyze_reference_audio', {
      audioBase64: `data:audio/wav;base64,${referenceBase64}`,
      name: 'browser-reference.wav'
    })
    const render = await callWithoutSignal('render_audio', {
      notes: [{ midi: 60, velocity: 0.9, start: 0, duration: 0.25 }], duration: 0.6
    })
    const renderedBlob = await (await fetch(render.url)).blob()
    const analysis = await call('analyze_audio')
    const comparison = await call('compare_audio')
    await call('save_preset', { name: 'WebMCP Smoke' })
    await call('update_parameters', { updates: [{ id: 'master.volume', value: 0.3 }] })
    const loaded = await call('load_preset', { name: 'WebMCP Smoke' })
    const loadedState = await call('get_synth_state', { search: 'master.volume' })
    const expectedError = await call('update_parameters', { updates: [{ id: 'missing', value: 1 }] })
    const history = await call('get_history', { view: 'sounds', limit: 20 })
    const replays = await call('get_history', { view: 'replays', limit: 20 })
    return {
      names, running: state.runtime.running,
      schemaCount: schema.parameters.items.length,
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
      reference: {
        source: reference.source,
        name: reference.name,
        mimeType: reference.mimeType,
        decodedBytes: reference.decodedBytes,
        duration: reference.duration,
        sampleRate: reference.sampleRate,
        channels: reference.channels,
        metrics: reference.metrics,
        echoedBase64: JSON.stringify(reference).includes(referenceBase64)
      },
      comparison: comparison.comparison,
      comparisonCandidateSource: comparison.candidate.source,
      loaded: loaded.loaded,
      loadedRaw: loadedState.patch.parameters.items['master.volume'].raw,
      expectedError,
      activity: {
        toolStatus: document.querySelector('.agent-status-button')?.title,
        undoEnabled: !document.querySelector('[data-guide-id="button.history.undo"]')?.disabled,
        changedParameters: [...document.querySelectorAll('.agent-param, .history-change')].map(element => element.textContent),
        retainedComparison: history.items.some(entry => Number.isFinite(entry.comparison?.similarity)),
        soundCount: history.total,
        replayCount: replays.items.filter(entry => entry.kind === 'performance').length
      },
      heldNotes: window.coSynth.heldNotes.size
    }
  })

  const expectedNames = [
    'get_synth_state', 'get_parameter_schema', 'update_parameters', 'set_modulation',
    'play_notes', 'render_audio', 'analyze_audio', 'analyze_reference_audio',
    'compare_audio', 'save_preset', 'load_preset', 'get_ui_targets', 'show_ui_guide',
    'get_history', 'navigate_history', 'replay_history', 'stop_performance'
  ]
  if (JSON.stringify([...result.names].sort()) !== JSON.stringify([...expectedNames].sort())) throw new Error(`Unexpected tools: ${result.names}`)
  if (!result.running || !result.schemaCount || result.appliedRaw !== 0.8) throw new Error('State/schema/update check failed')
  if (result.modulationCount !== 1 || result.played.noteCount !== 1 || result.heldNotes !== 0) throw new Error('Modulation/note check failed')
  if (result.render.mode !== 'realtime' || result.render.blobSize <= 0 || result.render.channels < 1) throw new Error('Render metadata check failed')
  if (!Number.isFinite(result.render.peakDb) || result.render.peakDb <= -80 || !Number.isFinite(result.render.rmsDb)) {
    throw new Error(`Rendered audio is silent: ${JSON.stringify(result.render)}`)
  }
  if (result.analysisSource !== 'last-render' || !result.loaded || Math.abs(result.loadedRaw - 0.8) > 1e-6) {
    throw new Error(`Analysis/preset check failed: ${JSON.stringify({ analysisSource: result.analysisSource, loaded: result.loaded, loadedRaw: result.loadedRaw })}`)
  }
  if (result.expectedError?.ok !== false || !/unknown parameter/i.test(result.expectedError?.error?.message ?? '')) {
    throw new Error(`Structured error check failed: ${JSON.stringify(result.expectedError)}`)
  }
  if (!result.activity.toolStatus?.startsWith('17 tools ready.') || !result.activity.undoEnabled ||
      !result.activity.retainedComparison || !result.activity.changedParameters.some(text => text === 'master.volume' || text.startsWith('master.volume:')) ||
      result.activity.soundCount < 5 || result.activity.replayCount !== 2) {
    throw new Error(`Agent activity check failed: ${JSON.stringify(result.activity)}`)
  }
  const metricKeys = ['peakDb', 'rmsDb', 'clippingCount', 'dcOffset', 'spectralCentroidHz', 'attackMs', 'stereoWidth']
  if (result.reference.source !== 'base64-reference' || result.reference.mimeType !== 'audio/wav' ||
      result.reference.decodedBytes <= 0 || result.reference.duration <= 0 || result.reference.duration > 30 ||
      result.reference.channels < 1 || result.reference.echoedBase64) {
    throw new Error(`Reference analysis check failed: ${JSON.stringify(result.reference)}`)
  }
  if (!metricKeys.every(key => Number.isFinite(result.reference.metrics[key]))) throw new Error('Reference metrics are not finite')
  if (result.comparisonCandidateSource !== 'last-render' || !Number.isFinite(result.comparison.similarity) ||
      result.comparison.similarity < 0 || result.comparison.similarity > 1 ||
      !metricKeys.every(key => {
        const detail = result.comparison.details[key]
        return detail && Number.isFinite(detail.reference) && Number.isFinite(detail.candidate) &&
          Number.isFinite(detail.delta) && Number.isFinite(detail.similarity) &&
          detail.similarity >= 0 && detail.similarity <= 1
      })) {
    throw new Error(`Comparison check failed: ${JSON.stringify(result.comparison)}`)
  }
  if (shimmed.errors.length) throw new Error(`Shimmed page errors:\n${shimmed.errors.join('\n')}`)
  console.log(JSON.stringify(result, null, 2))
  console.log('WEBMCP SMOKE OK')
} finally {
  await browser.close()
}
