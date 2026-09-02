// Discovery harness: which channel does an agent actually reach for?
//
// The sibling harness (agent-ux-probe.mjs) answers "once an agent knows the
// WebMCP tools exist, can it use them". This one answers the question before
// that: given BOTH a page it can read and click, and a set of registered
// WebMCP tools, which does it pick, how long does it take to notice the tools
// at all, and does it ever fall back to poking the UI like a human would.
//
// Both channels are advertised in the prompt on purpose. Hiding the page tools
// to see whether an agent "thinks of" reading the page cannot work: to let it
// read the page you must tell it how, and telling it how is the very knowledge
// under test. So the question is narrowed to a fair one - with both channels on
// the table, which wins - and the page's own self-description is measured
// separately by `GET /whatpagesays`, which reports what a reader would learn
// from the page WITHOUT being told anything.
//
//   node scripts/agent-discovery-probe.mjs [url] [--port 4791] [--headed]
//
//   GET  /whatpagesays     what the page tells a reader, unprompted (for us, not the agent)
//   GET  /health           readiness
//
//   Page channel - what a browser-using agent has:
//   GET  /page/text        visible text of the rendered page
//   GET  /page/html        raw served HTML, as a fetch would see it
//   GET  /page/a11y        the accessibility tree
//   POST /page/click       {"selector":"..."} or {"text":"..."}
//   POST /page/eval        {"expression":"..."} read-only JS, for inspection
//
//   Tool channel - what a WebMCP client has:
//   GET  /webmcp/tools     the registered descriptors
//   POST /webmcp/call      {"tool":"...","input":{...}}
//
//   GET  /log              every call, which channel it used, and the summary
//   POST /reset            reload for a fresh session
import { createServer } from 'node:http'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const value = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}
const url = args.find(arg => !arg.startsWith('--') && arg !== value('--port', null)) ?? 'http://localhost:4173/'
const port = Number(value('--port', '4791'))

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

const summarise = () => {
  const calls = log.filter(entry => entry.kind === 'call')
  const webmcp = calls.filter(entry => entry.channel === 'webmcp')
  const pageCalls = calls.filter(entry => entry.channel === 'page')
  const firstWebmcp = calls.findIndex(entry => entry.channel === 'webmcp')
  const firstMutation = calls.findIndex(entry =>
    (entry.channel === 'webmcp' && !['get_synth_state', 'get_parameter_schema', 'list_presets', 'get_ui_targets', 'get_history'].includes(entry.tool)) ||
    (entry.channel === 'page' && entry.tool === 'click'))
  return {
    totalCalls: calls.length,
    failedCalls: calls.filter(entry => !entry.ok).length,
    webmcpCalls: webmcp.length,
    pageCalls: pageCalls.length,
    // The headline: did the agent ever find the tools, and how much did it
    // spend on the page first. null means it never used them at all.
    usedWebMcp: webmcp.length > 0,
    callsBeforeFirstWebMcp: firstWebmcp < 0 ? null : firstWebmcp,
    firstChannel: calls[0]?.channel ?? null,
    // Which page endpoint it reached for first says how it looked: reading the
    // rendered text, fetching raw HTML, or going straight for the a11y tree.
    firstPageEndpoint: pageCalls[0]?.tool ?? null,
    // Clicking the UI is the human path. An agent doing this while 18 tools sit
    // unused is the failure this harness exists to catch.
    uiClicks: pageCalls.filter(entry => entry.tool === 'click').length,
    callsBeforeFirstChange: firstMutation < 0 ? null : firstMutation + 1,
    perTool: Object.fromEntries(Object.entries(
      calls.reduce((acc, entry) => {
        const key = `${entry.channel}:${entry.tool}`
        acc[key] ??= { calls: 0, failed: 0 }
        acc[key].calls++
        if (!entry.ok) acc[key].failed++
        return acc
      }, {})
    ).sort(([a], [b]) => a.localeCompare(b))),
    pageErrors: [...pageErrors]
  }
}

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body, null, 2))
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

const record = (channel, tool, input, ok, extra = {}) => {
  const entry = { kind: 'call', call: log.filter(e => e.kind === 'call').length + 1, at: new Date().toISOString(), channel, tool, input, ok, ...extra }
  log.push(entry)
  return entry
}

async function visibleText() {
  return page.evaluate(() => document.body?.innerText?.replace(/\s+/g, ' ').trim() ?? '')
}

async function a11yTree() {
  // `page.accessibility` was removed in recent Playwright; ariaSnapshot is the
  // supported replacement and yields the same thing an assistive client sees.
  return page.locator('body').ariaSnapshot()
}

const server = createServer(async (request, response) => {
  const { pathname } = new URL(request.url, 'http://localhost')
  const route = `${request.method} ${pathname}`
  try {
    if (route === 'GET /health') {
      const toolCount = await page.evaluate(() => window.__webMcpTools.size)
      return json(response, 200, { ok: true, url, toolCount })
    }

    // Diagnostic for US, not for the evaluated agent: everything the page says
    // about itself through channels a reader gets for free. If an agent has to
    // be told the tools exist, this is where the omission lives.
    if (route === 'GET /whatpagesays') {
      const served = await fetch(url).then(r => r.text()).catch(() => '')
      const meta = await page.evaluate(() => ({
        title: document.title,
        metas: [...document.querySelectorAll('meta[name], meta[property]')]
          .map(m => ({ name: m.getAttribute('name') ?? m.getAttribute('property'), content: m.getAttribute('content') })),
        landmarks: [...document.querySelectorAll('[role], main, nav, header, aside')].slice(0, 20)
          .map(el => `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''}`),
        jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => s.textContent?.slice(0, 400))
      }))
      const wellKnown = {}
      for (const path of ['/llms.txt', '/robots.txt', '/.well-known/ai-plugin.json']) {
        const res = await fetch(new URL(path, url)).catch(() => null)
        const body = res ? await res.text().catch(() => '') : ''
        // A SPA fallback answers 200 with HTML for any path, which is worse
        // than a 404: an agent asking for llms.txt gets a page and may believe
        // the file exists.
        wellKnown[path] = res ? { status: res.status, isHtmlFallback: body.trimStart().startsWith('<!doctype html'), bytes: body.length } : { status: null }
      }
      const text = await visibleText()
      const mentions = ['webmcp', 'modelcontext', 'tool', 'ai', 'agent']
        .map(word => [word, new RegExp(word, 'i').test(text)])
      return json(response, 200, {
        servedHtmlBytes: served.length,
        servedHtmlMentionsTools: /tool|webmcp|modelcontext/i.test(served),
        ...meta,
        wellKnown,
        renderedTextBytes: text.length,
        renderedTextMentions: Object.fromEntries(mentions),
        renderedTextHead: text.slice(0, 400)
      })
    }

    if (route === 'GET /log') return json(response, 200, { summary: summarise(), log })

    if (route === 'POST /reset') {
      await page.reload({ waitUntil: 'networkidle' })
      await page.waitForFunction(() => (window.__webMcpTools?.size ?? 0) > 0, { timeout: 30000 })
      log.length = 0
      pageErrors.length = 0
      return json(response, 200, { ok: true, reset: true })
    }

    // ---- page channel ----
    if (route === 'GET /page/text') {
      const text = await visibleText()
      record('page', 'text', {}, true)
      return json(response, 200, { text })
    }
    if (route === 'GET /page/html') {
      const html = await fetch(url).then(r => r.text())
      record('page', 'html', {}, true)
      return json(response, 200, { html })
    }
    if (route === 'GET /page/a11y') {
      const tree = await a11yTree()
      record('page', 'a11y', {}, true)
      return json(response, 200, { tree })
    }
    if (route === 'POST /page/click') {
      const body = await readBody(request)
      try {
        if (body.selector) await page.click(body.selector, { timeout: 5000 })
        else if (body.text) await page.getByText(body.text, { exact: false }).first().click({ timeout: 5000 })
        else throw new Error('Send {"selector":"..."} or {"text":"..."}')
        record('page', 'click', body, true)
        return json(response, 200, { ok: true })
      } catch (error) {
        record('page', 'click', body, false, { error: String(error?.message ?? error).split('\n')[0] })
        return json(response, 200, { ok: false, error: String(error?.message ?? error).split('\n')[0] })
      }
    }
    if (route === 'POST /page/eval') {
      const body = await readBody(request)
      try {
        const result = await page.evaluate(expression => {
          // eslint-disable-next-line no-eval
          const value = eval(expression)
          return typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value
        }, String(body.expression ?? ''))
        record('page', 'eval', body, true)
        return json(response, 200, { ok: true, result })
      } catch (error) {
        record('page', 'eval', body, false, { error: String(error?.message ?? error).split('\n')[0] })
        return json(response, 200, { ok: false, error: String(error?.message ?? error).split('\n')[0] })
      }
    }

    // ---- tool channel ----
    if (route === 'GET /webmcp/tools') {
      const tools = await page.evaluate(() => [...window.__webMcpTools.values()].map(tool => ({
        name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations ?? null
      })))
      record('webmcp', 'list_tools', {}, true)
      return json(response, 200, { tools })
    }
    if (route === 'POST /webmcp/call') {
      const body = await readBody(request)
      if (typeof body.tool !== 'string') return json(response, 400, { ok: false, error: 'Send {"tool":"...","input":{...}}' })
      const outcome = await page.evaluate(async ({ tool, input }) => {
        const descriptor = window.__webMcpTools.get(tool)
        if (!descriptor) return { ok: false, error: { code: 'not_registered', message: `No tool named ${tool} is registered right now` } }
        try {
          const result = await descriptor.execute(input, { signal: new AbortController().signal })
          return { ok: result?.ok !== false, result }
        } catch (error) {
          return { ok: false, error: { code: error?.name ?? 'error', message: String(error?.message ?? error) } }
        }
      }, { tool: body.tool, input: body.input ?? {} })
      const entry = record('webmcp', body.tool, body.input ?? {}, outcome.ok, outcome.ok ? {} : { error: outcome.error })
      return json(response, 200, { ok: outcome.ok, call: entry.call, ...(outcome.ok ? { result: outcome.result } : { error: outcome.error }) })
    }

    return json(response, 404, { ok: false, error: `Unknown route ${route}` })
  } catch (error) {
    return json(response, 500, { ok: false, error: String(error?.message ?? error) })
  }
})

server.listen(port, () => {
  console.log(`agent-discovery-probe on http://localhost:${port} against ${url}`)
})

const shutdown = async () => { server.close(); await browser.close().catch(() => {}); process.exit(0) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
