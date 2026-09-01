// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guideMarkdown, UiGuideController, validateGuide } from './guide'
import { guideTarget } from './guide-target'

describe('guide validation', () => {
  it('accepts all supported step shapes and the clear operation', () => {
    expect(validateGuide({ steps: [] })).toEqual([])
    expect(validateGuide({ steps: [
      { target: { id: 'fx.delay' } }, { target: { selector: '.knob' }, title: 'Turn this' },
      { markdown: '**Text** only' }, { title: 'Heading only' }
    ] })).toHaveLength(4)
  })
  it.each([
    null, {}, { steps: [{}] }, { steps: Array(21).fill({ title: 'x' }) },
    { steps: [{ target: { id: 'x', selector: '#x' } }] }, { steps: [{ target: {} }] },
    { steps: [{ target: { selector: '['.repeat(513) } }] },
    { steps: [{ title: 'x'.repeat(121) }] }, { steps: [{ markdown: 'x'.repeat(4001) }] },
    { steps: [{ title: ' ' }] }, { steps: [{ title: 'x', action: 'setParam' }] },
    { steps: [{ target: { id: 'x' } }], extra: true }
  ])('rejects malformed or oversized input %#', input => expect(() => validateGuide(input)).toThrow())
})

describe('safe instruction Markdown', () => {
  it('renders CommonMark without loading images or executing HTML', () => {
    const host = document.createElement('div')
    host.append(guideMarkdown('# Heading\n\n**Bold** and `code`\n\n- one\n- two\n\n<script>alert(1)</script>\n\n![diagram](https://example.com/track.png)'))
    expect(host.querySelector('h1')?.textContent).toBe('Heading')
    expect(host.querySelector('strong')?.textContent).toBe('Bold')
    expect(host.querySelectorAll('li')).toHaveLength(2)
    expect(host.querySelector('img, script')).toBeNull()
    expect(host.textContent).toContain('diagram')
    expect(host.textContent).toContain('<script>')
  })
  it('only retains safe absolute web and mail links', () => {
    const host = document.createElement('div')
    host.append(guideMarkdown('[bad](javascript:alert%281%29) [data](data:text/html,bad) [relative](/x) [web](https://example.com) [mail](mailto:test@example.com)'))
    expect([...host.querySelectorAll('a')].map(a => a.getAttribute('href'))).toEqual(['https://example.com', 'mailto:test@example.com'])
    for (const link of host.querySelectorAll('a')) expect(link.rel).toBe('noopener noreferrer')
  })
})

describe('UiGuideController with Driver.js', () => {
  let app: HTMLElement
  let guide: UiGuideController
  const tick = () => vi.advanceTimersByTimeAsync(50)
  const target = (id: string, parent = app) => {
    const element = guideTarget(document.createElement('button'), id, id, 'button')
    parent.appendChild(element)
    return element
  }
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 30, y: 30, top: 30, left: 30, right: 130, bottom: 80, width: 100, height: 50, toJSON() {} })
    HTMLElement.prototype.scrollIntoView = vi.fn()
    document.body.replaceChildren()
    app = document.createElement('main')
    app.id = 'app'
    document.body.appendChild(app)
    guide = new UiGuideController(app)
  })
  afterEach(() => {
    guide.dispose()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('discovers live scoped IDs with search, pagination and visibility', () => {
    target('param.osc1.morph')
    target('param.osc1.level').hidden = true
    target('outside', document.body)
    const overlay = document.createElement('aside')
    document.body.append(overlay)
    const unregister = guide.registerOverlay(overlay)
    target('overlay.button', overlay)
    const page = guide.listTargets({ search: 'osc1', limit: 1 })
    expect(page).toMatchObject({ total: 2, nextOffset: 1, items: [{ id: 'param.osc1.level', visible: false }] })
    expect(guide.listTargets({}).items.some(t => t.id === 'outside')).toBe(false)
    expect(guide.listTargets({ search: 'overlay' }).items).toHaveLength(1)
    unregister()
    expect(guide.listTargets({ search: 'overlay' }).items).toHaveLength(0)
    expect(() => guide.listTargets({ limit: 21 })).toThrow()
  })

  it('highlights real controls without activating them and keeps a close control', async () => {
    const control = target('fx.delay')
    const clicked = vi.fn()
    control.addEventListener('click', clicked)
    expect(guide.show({ steps: [{ target: { id: 'fx.delay' } }] })).toMatchObject({ shown: true, warnings: [] })
    await tick()
    expect(control.classList.contains('driver-active-element')).toBe(true)
    expect(control.classList.contains('driver-no-interaction')).toBe(false)
    expect(clicked).not.toHaveBeenCalled()
    control.click()
    expect(clicked).toHaveBeenCalledOnce()
    expect(guide.isActive()).toBe(true)
    expect(document.querySelector('.driver-popover')?.classList.contains('guide-highlight-only')).toBe(true)
    document.querySelector<HTMLButtonElement>('.driver-popover-close-btn')!.click()
    expect(guide.isActive()).toBe(false)
    expect(document.querySelector('.driver-overlay')).toBeNull()
  })

  it('rejects ambiguous and invalid selectors without dismissing the current guide', async () => {
    target('one'); target('two')
    guide.show({ steps: [{ title: 'Keep me' }] })
    await tick()
    expect(() => guide.show({ steps: [{ target: { selector: 'button' } }] })).toThrow(/matches 2 visible/)
    expect(() => guide.show({ steps: [{ target: { selector: '[' } }] })).toThrow(/Invalid target selector/)
    expect(document.querySelector('.driver-popover-title')?.textContent).toBe('Keep me')
    expect(guide.show({ steps: [{ target: { selector: 'body' } }] }).warnings).toHaveLength(1)
  })

  it('does not target its own popover even inside a registered dialog', async () => {
    const modal = document.createElement('dialog')
    app.append(modal)
    modal.open = true
    target('inside', modal)
    guide.show({ steps: [{ target: { id: 'inside' }, title: 'Inside modal' }] })
    await tick()
    expect(modal.querySelector('.driver-popover')).not.toBeNull()
    expect(modal.querySelector('.driver-overlay')).not.toBeNull()
    expect(guide.show({ steps: [{ target: { selector: '.driver-popover' } }] }).warnings).toHaveLength(1)
  })

  it('re-resolves targets on navigation, preserves safe text and restores focus', async () => {
    const first = target('source.env1')
    const second = target('param.filter1.cutoff')
    first.focus()
    guide.show({ steps: [
      { target: { id: 'source.env1' }, title: '<img src=x onerror=alert(1)>', markdown: '**Source**. Next: cutoff.' },
      { target: { id: 'param.filter1.cutoff' }, markdown: 'Destination instructions' }
    ] })
    await tick()
    expect(document.querySelector('.driver-popover-title img')).toBeNull()
    expect(document.querySelector('.driver-popover-title')?.textContent).toContain('<img')
    expect(document.querySelector<HTMLElement>('.driver-popover-prev-btn')?.style.display).toBe('none')
    second.remove()
    document.querySelector<HTMLButtonElement>('.driver-popover-next-btn')!.click()
    await tick()
    expect(document.querySelector('.driver-popover-description')?.textContent).toContain('Target unavailable')
    expect(document.querySelector('.driver-popover-description')?.textContent).toContain('Destination instructions')
    expect(document.querySelector('.driver-popover')?.getAttribute('aria-label')).toBe('Guide step 2 of 2')
    app.append(second)
    document.querySelector<HTMLButtonElement>('.driver-popover-prev-btn')!.click()
    await tick()
    document.querySelector<HTMLButtonElement>('.driver-popover-next-btn')!.click()
    await tick()
    expect(second.classList.contains('driver-active-element')).toBe(true)
    document.querySelector<HTMLButtonElement>('.driver-popover-next-btn')!.click()
    await tick()
    expect(guide.isActive()).toBe(false)
    expect(document.activeElement).toBe(first)
  })

  it('supports replacement, clearing, and disposal without stale overlays', async () => {
    guide.show({ steps: [{ markdown: 'First' }] })
    await tick()
    guide.show({ steps: [{ markdown: 'Second' }] })
    await tick()
    expect(document.querySelectorAll('.driver-popover')).toHaveLength(1)
    expect(document.querySelector('.driver-popover-description')?.textContent).toBe('Second')
    expect(guide.show({ steps: [] })).toMatchObject({ cleared: true, stepCount: 0 })
    expect(document.querySelector('.driver-popover')).toBeNull()
    guide.show({ steps: [{ title: 'Last' }] })
    await tick()
    guide.dispose()
    expect(document.querySelector('.driver-overlay')).toBeNull()
    expect(() => guide.show({ steps: [] })).toThrow(/disposed/)
  })

  it('can suppress the initial overlay fade and removes the presentation class on close', async () => {
    guide.show({ steps: [{ markdown: 'Static overlay' }] }, { staticOverlay: true })
    await tick()
    expect(document.body.classList.contains('guide-overlay-static')).toBe(true)
    document.querySelector<HTMLButtonElement>('.driver-popover-close-btn')!.click()
    expect(document.body.classList.contains('guide-overlay-static')).toBe(false)
  })

  it('does not bypass blocking startup screens or leave a guide trapped in a closed dialog', async () => {
    target('app.control')
    const screen = document.createElement('div')
    screen.dataset.guideBlocking = ''
    document.body.append(screen)
    guide.registerOverlay(screen)
    expect(guide.show({ steps: [{ target: { id: 'app.control' } }] }).warnings[0].message).toContain('behind')
    guide.clear()
    screen.remove()
    const modal = document.createElement('dialog')
    app.append(modal)
    modal.open = true
    target('modal.control', modal)
    guide.show({ steps: [{ target: { id: 'modal.control' }, markdown: 'Help' }] })
    await tick()
    modal.open = false
    modal.dispatchEvent(new Event('close'))
    await tick()
    expect(document.body.querySelector(':scope > .driver-popover .guide-warning')).not.toBeNull()
    expect(document.body.querySelector(':scope > .driver-overlay')).not.toBeNull()
  })
})
