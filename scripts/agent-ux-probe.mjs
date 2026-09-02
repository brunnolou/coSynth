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

const summarise = () => {
  const calls = log.filter(entry => entry.kind === 'call')
  const failed = calls.filter(entry => !entry.ok)
  const firstOkUpdate = calls.findIndex(entry => entry.tool === 'update_parameters' && entry.ok)
  const discovery = calls.filter(entry => entry.tool === 'get_parameter_schema' || entry.tool === 'get_synth_state')
  return {
    totalCalls: calls.length,
    failedCalls: failed.length,
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
        ...(outcome.ok ? {} : { error: outcome.error ?? outcome.result?.error })
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
