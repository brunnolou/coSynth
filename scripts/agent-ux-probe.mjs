// Agent-UX measurement harness for the plan's Verification step 3.
//
// Keeps one live page open behind a tiny HTTP API so an evaluating agent can
// drive the WebMCP tools one call at a time, over curl, while session state
// (the patch, the last render, the last reference) persists between calls.
//
// The point is to measure FIRST CONTACT, so the API deliberately exposes only
// what a real WebMCP client sees: each tool's name, description and
// inputSchema. It never exposes the source, and every call is logged with its
// outcome and wall-clock cost so "how many round trips did that cost" is a
// measured number rather than a recollection.
//
//   node scripts/agent-ux-probe.mjs [url] [--port 4790] [--headed]
//
//   GET  /tools            the descriptors, and nothing else
//   POST /call             {"tool":"...","input":{...}} -> {ok, result|error, ms, call}
//   POST /start            dispatch the human Start gesture (logged, not free)
//   GET  /log              every call so far, plus the summary counters
//   POST /reset            reload the page for a fresh cold session
//   GET  /health           readiness
import { createServer } from 'node:http'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const value = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}
const url = args.find(arg => !arg.startsWith('--') && arg !== value('--port', null)) ?? 'http://localhost:4173/'
// 4790 is the agent-UX eval's port, and what `docs/agent-ux-eval.md` documents
// curling. The match and teaching evals run the same harness on 4792 and pass
// `--port` for it; the discovery probe holds 4791.
const port = Number(value('--port', '4790'))

function installShim(page) {
  return page.addInitScript(() => {
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
    Object.defineProperty(Document.prototype, 'modelContext', { configurable: true, get: () => modelContext })
    Object.defineProperty(window, '__webMcpTools', { value: tools })
  })
}

const browser = await chromium.launch({
  headless: !flag('--headed'),
  executablePath: process.env.CHROMIUM_PATH || undefined
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const pageErrors = []
page.on('pageerror', error => pageErrors.push(String(error)))
page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()) })

await installShim(page)
await page.goto(url, { waitUntil: 'networkidle' })
await page.waitForFunction(() => (window.__webMcpTools?.size ?? 0) > 0, { timeout: 30000 })

const log = []
let gestureAt = null

/** A digital-silence floor: the analyzer reports -160 dB for an all-zero buffer. */
const SILENT_PEAK_DB = -159

/**
 * A few fields from each result, so the log alone shows what came back. Logging
 * whole results would bury the file in 64-point envelopes and PCM, but logging
 * none of them hid a render that returned pure silence with ok:true - the log
 * said "ok, 210ms" and the failure was only visible in the agent's own notes.
 */
function digest(result) {
  if (result === null || typeof result !== 'object') return result
  const out = {}
  const metrics = result.metrics
  if (metrics && typeof metrics === 'object') {
    for (const key of ['peakDb', 'rmsDb', 'loudnessDb', 'attackMs', 'decayT60Ms']) {
      if (key in metrics) out[key] = metrics[key]
    }
    if (metrics.harmonics && typeof metrics.harmonics === 'object') {
      out.inharmonicity = metrics.harmonics.inharmonicity
    }
    if (Array.isArray(metrics.spectralWindows)) {
      out.windowCentroidsHz = metrics.spectralWindows.map(w => w?.spectralCentroidHz)
    }
    if (out.peakDb !== undefined && out.peakDb <= SILENT_PEAK_DB) out.SILENT = true
  }
  // `compare_audio` renders its own candidate now, and returns that render's
  // metrics under `candidate` with nothing at the top level. The silence
  // detector above therefore saw nothing for the one call that renders most
  // often in a matching run: an all-zero buffer inside compare_audio logged as
  // "ok, 900ms" and no more. An all-zero render was the single most valuable
  // finding of the previous round, so the detector follows the metrics.
  const candidateMetrics = result.candidate?.metrics
  if (out.peakDb === undefined && candidateMetrics && typeof candidateMetrics === 'object' &&
      typeof candidateMetrics.peakDb === 'number') {
    out.peakDb = candidateMetrics.peakDb
    if (candidateMetrics.peakDb <= SILENT_PEAK_DB) out.SILENT = true
  }
  for (const key of ['renderMode', 'renderModeFallback', 'retriggered', 'completed', 'noteCount', 'saved', 'loaded']) {
    if (key in result) out[key] = result[key]
  }
  if (Array.isArray(result.applied)) out.appliedCount = result.applied.length
  if (result.route) out.route = result.route
  if (result.parameters?.total !== undefined) {
    out.parameters = { total: result.parameters.total, items: result.parameters.items?.length, nextOffset: result.parameters.nextOffset }
  }
  if (result.modulationSources?.total !== undefined) {
    out.modulationSources = { total: result.modulationSources.total, items: result.modulationSources.items?.length }
  }
  if (Array.isArray(result.presets)) out.presetCount = result.presets.length
  // The reference-matching loop is only legible if convergence is in the log.
  // `similarity` alone says "closer or not"; the per-metric similarities say
  // *which* metric moved, which is what an agent steers by.
  const comparison = result.comparison
  if (comparison && typeof comparison === 'object') {
    out.similarity = comparison.similarity
    if (comparison.details && typeof comparison.details === 'object') {
      out.detailSimilarities = Object.fromEntries(
        Object.entries(comparison.details)
          .filter(([, detail]) => detail && typeof detail === 'object' && typeof detail.similarity === 'number')
          .map(([key, detail]) => [key, detail.similarity])
      )
    }
  }
  if (result.reference && typeof result.reference === 'object') {
    out.reference = {
      source: result.reference.source,
      name: result.reference.name,
      duration: result.reference.duration,
      sampleRate: result.reference.sampleRate,
      channels: result.reference.channels,
      decodedBytes: result.reference.decodedBytes
    }
  }
  if (result.candidate && typeof result.candidate === 'object') out.candidateSource = result.candidate.source
  // analyze_reference_audio returns the analysis at the top level, not nested.
  if (result.source === 'base64-reference') {
    out.referenceDuration = result.duration
    out.referenceSampleRate = result.sampleRate
    out.referenceChannels = result.channels
    out.referenceDecodedBytes = result.decodedBytes
  }
  return Object.keys(out).length ? out : undefined
}

// Every tool that changes the sound. `apply_patch` and `set_fx_order` were added to the
// app after this probe was written, and their absence here made a real eval run report
// `editsBetweenComparisons: [0,0,0,...]` for an agent that had made 15 successful edits -
// the run looked like it changed nothing. Anything that mutates the patch belongs here.
const EDIT_TOOLS = new Set(['update_parameters', 'set_modulation', 'apply_patch', 'set_fx_order'])
/** EDIT_TOOLS plus the ways a whole patch arrives at once. */
const MUTATION_TOOLS = new Set([...EDIT_TOOLS, 'load_preset'])

/**
 * Convergence view of the run: the similarity trajectory in call order, and how
 * many patch edits sat between each comparison. An agent that renders once and
 * declares victory shows up here as a single-entry trajectory - which is a
 * failed run no matter how high that one number is.
 */
function summariseMatchingLoop(calls) {
  const comparisons = []
  let editsSinceLastComparison = 0
  for (const entry of calls) {
    if (EDIT_TOOLS.has(entry.tool) && entry.ok) editsSinceLastComparison++
    if (entry.tool !== 'compare_audio') continue
    if (entry.ok) {
      comparisons.push({
        call: entry.call,
        similarity: entry.result?.similarity ?? null,
        editsSincePrevious: editsSinceLastComparison
      })
    }
    editsSinceLastComparison = 0
  }
  const trajectory = comparisons.map(item => item.similarity).filter(value => typeof value === 'number')
  const improvedMonotonically = trajectory.length < 2
    ? null
    : trajectory.every((value, index) => index === 0 || value >= trajectory[index - 1])
  return {
    // Was step 1 of the workflow ever reached at all? The whole reason this
    // eval exists is that field evidence showed it never was.
    analyzeReferenceAudioCalls: calls.filter(entry => entry.tool === 'analyze_reference_audio').length,
    compareAudioCalls: calls.filter(entry => entry.tool === 'compare_audio').length,
    similarityTrajectory: trajectory,
    similarityImprovedMonotonically: improvedMonotonically,
    bestSimilarity: trajectory.length ? Math.max(...trajectory) : null,
    finalSimilarity: trajectory.length ? trajectory[trajectory.length - 1] : null,
    similarityGain: trajectory.length > 1 ? trajectory[trajectory.length - 1] - trajectory[0] : null,
    editsBetweenComparisons: comparisons.map(item => item.editsSincePrevious),
    comparisons
  }
}

const summarise = () => {
  const calls = log.filter(entry => entry.kind === 'call')
  const failed = calls.filter(entry => !entry.ok)
  const firstOkUpdate = calls.findIndex(entry => entry.tool === 'update_parameters' && entry.ok)
  // Kept separate from the line above on purpose: the recorded runs in docs/ measured
  // `update_parameters` specifically, so widening that field would silently make old and
  // new numbers incomparable. This one answers "how long until the agent changed the sound
  // at all", which is what the older field was being read as.
  const firstOkEdit = calls.findIndex(entry => EDIT_TOOLS.has(entry.tool) && entry.ok)
  const discovery = calls.filter(entry => entry.tool === 'get_parameter_schema' || entry.tool === 'get_synth_state')
  return {
    totalCalls: calls.length,
    failedCalls: failed.length,
    callsToFirstSuccessfulEdit: firstOkEdit === -1 ? null : firstOkEdit + 1,
    // The headline number: how many calls the agent spent before its first
    // parameter change stuck. The plan's target is 1.
    callsToFirstSuccessfulUpdateParameters: firstOkUpdate < 0 ? null : firstOkUpdate + 1,
    discoveryCalls: discovery.length,
    perTool: Object.fromEntries(Object.entries(
      calls.reduce((acc, entry) => {
        acc[entry.tool] ??= { calls: 0, failed: 0, totalMs: 0 }
        acc[entry.tool].calls++
        if (!entry.ok) acc[entry.tool].failed++
        acc[entry.tool].totalMs += entry.ms
        return acc
      }, {})
    ).sort(([a], [b]) => a.localeCompare(b))),
    // Teaching: when a human asks how to do something themselves, the right
    // answer is to show them the controls, not to reach in and change the
    // sound for them. `taught` false with `changedSoundInstead` true is the
    // failure this measures - the agent did the job rather than explaining it.
    teaching: (() => {
      const guides = calls.filter(entry => entry.tool === 'show_ui_guide' && entry.ok)
      const mutations = calls.filter(entry => MUTATION_TOOLS.has(entry.tool) && entry.ok)
      const firstGuide = calls.findIndex(entry => entry.tool === 'show_ui_guide' && entry.ok)
      return {
        taught: guides.length > 0,
        showGuideCalls: guides.length,
        lookedUpTargets: calls.filter(entry => entry.tool === 'get_ui_targets' && entry.ok).length,
        callsBeforeFirstGuide: firstGuide < 0 ? null : firstGuide + 1,
        changedSoundInstead: mutations.length,
        guideStepCounts: guides.map(entry => Array.isArray(entry.input?.steps) ? entry.input.steps.length : null)
      }
    })(),
    // Renders that came back as an all-zero buffer, counting the one
    // `compare_audio` performs for itself. This must stay at zero; a nonzero
    // count means the offline path silently produced nothing.
    silentRenders: calls.filter(entry => entry.result?.SILENT).length,
    matchingLoop: summariseMatchingLoop(calls),
    startGestureDispatchedAtCall: gestureAt,
    pageErrors: [...pageErrors]
  }
}

const json = (response, status, body) => {
  const payload = JSON.stringify(body, null, 2)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(payload)
}

const readBody = request => new Promise((resolve, reject) => {
  let raw = ''
  request.on('data', chunk => { raw += chunk })
  request.on('end', () => {
    if (!raw.trim()) return resolve({})
    try { resolve(JSON.parse(raw)) } catch (error) { reject(error) }
  })
  request.on('error', reject)
})

const server = createServer(async (request, response) => {
  const route = `${request.method} ${new URL(request.url, 'http://localhost').pathname}`
  try {
    if (route === 'GET /health') {
      return json(response, 200, { ok: true, url, toolCount: (await page.evaluate(() => window.__webMcpTools.size)) })
    }

    if (route === 'GET /tools') {
      // Exactly what a WebMCP client is given. No more.
      const tools = await page.evaluate(() => [...window.__webMcpTools.values()].map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations ?? null
      })))
      return json(response, 200, { tools })
    }

    if (route === 'GET /log') return json(response, 200, { summary: summarise(), log })

    if (route === 'POST /start') {
      const before = await page.evaluate(() => ({ running: window.coSynth?.running ?? null }))
      await page.click('#start-btn')
      await page.waitForFunction(() => window.coSynth?.running === true, { timeout: 15000 })
      await page.waitForFunction(() => window.__webMcpTools.has('play_notes'), { timeout: 15000 })
      gestureAt = log.filter(entry => entry.kind === 'call').length
      log.push({ kind: 'gesture', at: new Date().toISOString(), before })
      return json(response, 200, { ok: true, startedAfterCalls: gestureAt })
    }

    if (route === 'POST /reset') {
      await page.reload({ waitUntil: 'networkidle' })
      await page.waitForFunction(() => (window.__webMcpTools?.size ?? 0) > 0, { timeout: 30000 })
      log.length = 0
      pageErrors.length = 0
      gestureAt = null
      return json(response, 200, { ok: true, reset: true })
    }

    if (route === 'POST /call') {
      const body = await readBody(request)
      if (typeof body.tool !== 'string') return json(response, 400, { ok: false, error: 'Send {"tool":"...","input":{...}}' })
      const input = body.input ?? {}
      const started = Date.now()
      const outcome = await page.evaluate(async ({ tool, input }) => {
        const descriptor = window.__webMcpTools.get(tool)
        if (!descriptor) return { ok: false, error: { code: 'not_registered', message: `No tool named ${tool} is registered right now` } }
        try {
          const result = await descriptor.execute(input, { signal: new AbortController().signal })
          // The registered boundary already turns expected failures into
          // {ok:false,...}; pass that through untouched so the agent sees
          // exactly the message a real client would.
          return { ok: result?.ok !== false, result }
        } catch (error) {
          return { ok: false, error: { code: error?.name ?? 'error', message: String(error?.message ?? error) } }
        }
      }, { tool: body.tool, input })
      const ms = Date.now() - started
      const entry = {
        kind: 'call',
        call: log.filter(item => item.kind === 'call').length + 1,
        at: new Date().toISOString(),
        tool: body.tool,
        input,
        ok: outcome.ok,
        ms,
        ...(outcome.ok ? {} : { error: outcome.error ?? outcome.result?.error }),
        ...(outcome.ok ? { result: digest(outcome.result) } : {})
      }
      log.push(entry)
      return json(response, 200, { ok: outcome.ok, call: entry.call, ms, ...(outcome.ok ? { result: outcome.result } : { error: entry.error }) })
    }

    return json(response, 404, { ok: false, error: `Unknown route ${route}` })
  } catch (error) {
    return json(response, 500, { ok: false, error: String(error?.message ?? error) })
  }
})

server.listen(port, () => {
  console.log(`agent-ux-probe listening on http://localhost:${port} against ${url}`)
  console.log('GET /tools | POST /call | POST /start | GET /log | POST /reset')
})

const shutdown = async () => {
  server.close()
  await browser.close().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
