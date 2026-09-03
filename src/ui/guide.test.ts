// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guideMarkdown, UiGuideController, validateGuide, type GuideTargetInfo } from './guide'
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
  const target = (id: string, parent = app, label = id, kind = 'button') => {
    const element = guideTarget(document.createElement('button'), id, label, kind)
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
    expect((guide.listTargets({}).items as GuideTargetInfo[]).some(t => t.id === 'outside')).toBe(false)
    expect(guide.listTargets({ search: 'overlay' }).items).toHaveLength(1)
    unregister()
    expect(guide.listTargets({ search: 'overlay' }).items).toHaveLength(0)
    expect(() => guide.listTargets({ limit: 21 })).toThrow()
  })

  /**
   * The teaching eval: both models spent ten calls hunting for two IDs because
   * 259 targets only came 20 at a time. One compact call must return the whole
   * space, exactly as `get_parameter_schema`'s compact format already does.
   */
  it('returns every teaching target as one line each in a single unpaged call', () => {
    target('param.env1.release', app, 'env1 Release', 'knob')
    // Active, as the tab whose knobs are the mounted ones always is: an
    // inactive ENV tab is what makes the rest of its parameters predictable.
    target('tab.env1', app, 'Env 1 amplitude envelope', 'tab').classList.add('on')
    target('fx.delay', app, 'Delay / echo effect', 'panel').hidden = true

    const page = guide.listTargets({ format: 'compact' })
    expect(page).toMatchObject({ format: 'compact', total: 3 })
    expect(page).not.toHaveProperty('nextOffset')
    // `id type label`, sorted by id, with visibility as a trailing marker:
    // an agent must be able to tell `tab.env1` from `param.env1.release`, and
    // to know which of them needs its panel opened first.
    expect(page.items).toEqual([
      'fx.delay panel Delay / echo effect (hidden)',
      'param.env1.release knob env1 Release',
      'tab.env1 tab Env 1 amplitude envelope'
    ])
  })

  it('keeps compact paging and filtering honest, and leaves the full format alone', () => {
    target('param.env1.release', app, 'env1 Release', 'knob')
    target('tab.env1', app, 'Env 1 amplitude envelope', 'tab').classList.add('on')
    target('fx.delay', app, 'Delay / echo effect', 'panel')

    expect(guide.listTargets({ format: 'compact', search: 'echo' })).toMatchObject({
      items: ['fx.delay panel Delay / echo effect'], total: 1, format: 'compact'
    })
    // An explicit limit still pages, and still says how much is left.
    expect(guide.listTargets({ format: 'compact', limit: 2 })).toMatchObject({ total: 3, nextOffset: 2 })
    // The paged object format is unchanged for callers that already use it.
    const full = guide.listTargets({ limit: 1 })
    expect(full).toMatchObject({ offset: 0, limit: 1, total: 3, nextOffset: 1 })
    expect(full.items).toEqual([{ id: 'fx.delay', label: 'Delay / echo effect', type: 'panel', visible: true }])
    expect(full).not.toHaveProperty('format')
    expect(() => guide.listTargets({ format: 'brief' })).toThrow(/format/)
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

  it('keeps AI guides open on outside clicks while allowing the welcome tour to close', async () => {
    guide.show({ steps: [{ markdown: 'AI walkthrough' }] })
    await tick()
    document.querySelector<SVGElement>('.driver-overlay path')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(guide.isActive()).toBe(true)
    guide.show({ steps: [{ markdown: 'Welcome walkthrough' }] }, { closeOnOverlay: true })
    await tick()
    document.querySelector<SVGElement>('.driver-overlay path')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(guide.isActive()).toBe(false)
  })

  it('leaves a text-only step an escape route because outside clicks are ignored', async () => {
    guide.show({ steps: [{ markdown: 'A long text-only explanation with no target.' }] })
    await tick()
    const close = document.querySelector<HTMLButtonElement>('.driver-popover-close-btn')
    expect(close).not.toBeNull()
    expect(close!.hidden).toBe(false)
    expect(getComputedStyle(close!).display).not.toBe('none')
    document.querySelector<SVGElement>('.driver-overlay path')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(guide.isActive()).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' }))
    expect(guide.isActive()).toBe(false)
    expect(document.querySelector('.driver-popover')).toBeNull()
  })

  /**
   * A guide that cannot open its own subject fails exactly where it matters.
   * A real session called show_ui_guide for `param.env1.release` and got back
   * "Target unavailable ... Open the relevant panel or tab", and recovered only
   * by finding and clicking `ENV 1 · AMP` itself before calling the guide again.
   *
   * "Unavailable" covered two different situations that need different fixes.
   * A control inside a closed `<details>` is mounted and can be walked to from
   * the element. The ENV and LFO knobs are not mounted at all — app.ts rebuilds
   * that row on every tab click — so there is nothing to walk from, and the
   * owning tab has to come from the ID the two targets share.
   */
  describe('revealing what hides a target', () => {
    /** A `<details>` panel, the way the preset actions menu is built. */
    const panel = (id: string, label: string) => {
      const details = document.createElement('details')
      const summary = guideTarget(document.createElement('summary'), `button.${id}.actions`, `${label} actions`, 'button')
      details.append(summary)
      app.append(details)
      return details
    }
    /**
     * A sub-tab group that mounts its controls on click and throws away the
     * previous tab's, exactly as `renderEnvKnobs` does.
     */
    const envTabs = () => {
      const tabs = document.createElement('div')
      const mount = document.createElement('div')
      app.append(tabs, mount)
      const show = (env: number) => mount.replaceChildren(
        guideTarget(document.createElement('div'), `param.env${env}.release`, `env${env} Release`, 'knob'))
      const buttons = [1, 2].map(env => {
        const button = guideTarget(document.createElement('button'), `tab.env${env}`, `Env ${env}`, 'tab')
        button.addEventListener('click', () => {
          for (const other of buttons) other.classList.toggle('on', other === button)
          show(env)
        })
        tabs.append(button)
        return button
      })
      buttons[1].classList.add('on')
      show(2)
      return { buttons, mount }
    }

    it('reports a control in a closed panel as revealable, and an unknown ID as neither', () => {
      const actions = panel('preset', 'Preset')
      target('button.preset.save', actions, 'Save preset')
      // Hidden by the app's own state rather than by a container: nothing the
      // guide opens brings this one back, and saying otherwise would be a lie.
      target('fx.delay', app, 'Delay / echo effect', 'panel').hidden = true

      expect(guide.listTargets({ format: 'compact' }).items).toEqual([
        'button.preset.actions button Preset actions',
        'button.preset.save button Save preset (hidden, revealable)',
        'fx.delay panel Delay / echo effect (hidden)'
      ])
      expect(guide.listTargets({ search: 'Save preset' }).items).toEqual([
        { id: 'button.preset.save', label: 'Save preset', type: 'button', visible: false, revealable: true }
      ])
      // A wrong ID is the one thing that still comes back empty, and it comes
      // back empty in a shape of its own rather than as a fabricated row.
      expect(guide.listTargets({ search: 'param.reverb.sizzle' })).toMatchObject({
        total: 0, unmatched: { search: 'param.reverb.sizzle', revealable: false, opens: [] }
      })
    })

    /**
     * The three states an agent has to tell apart, as three ordinary rows.
     *
     * The knobs of an unselected ENV tab are not in the document at all -
     * `renderEnvKnobs` throws the previous tab's away - so this used to be an
     * empty list with a note beside it. It is a row now, marked `mounted:
     * false` because it is predicted from `PARAMS` rather than read off an
     * element, and a wrong ID is still the only thing that returns nothing.
     */
    it('lists a control its tab has not built yet as an ordinary target', () => {
      envTabs()
      const visible = target('param.filter1.cutoff', app, 'filter1 Cutoff', 'knob')
      const hidden = target('param.osc1.morph', panel('osc', 'Osc'), 'osc1 Morph', 'knob')
      const find = (id: string) => (guide.listTargets({ search: id }).items as GuideTargetInfo[])
        .find(item => item.id === id)

      expect(find('param.env2.release')).toEqual({
        id: 'param.env2.release', label: 'env2 Release', type: 'knob', visible: true
      })
      // Present, hidden, and the guide can open what hides it.
      expect(find('param.osc1.morph')).toEqual({
        id: 'param.osc1.morph', label: 'osc1 Morph', type: 'knob', visible: false, revealable: true
      })
      // Not present at all, and honest about which of the two it is.
      expect(find('param.env1.release')).toEqual({
        id: 'param.env1.release', label: 'env1 Release', type: 'knob',
        visible: false, revealable: true, mounted: false
      })
      expect(find('param.filter1.cutoff')).toEqual({
        id: 'param.filter1.cutoff', label: 'filter1 Cutoff', type: 'knob', visible: true
      })
      expect(find('param.env1.nonsense')).toBeUndefined()
      expect(visible.isConnected && hidden.isConnected).toBe(true)

      // The compact line carries the same three states.
      const lines = guide.listTargets({ format: 'compact', search: 'env1' }).items as string[]
      expect(lines).toContain('param.env1.release knob env1 Release (not mounted, revealable)')
      expect(lines).toContain('tab.env1 tab Env 1')
      expect(guide.listTargets({ format: 'compact', search: 'osc1 Morph' }).items)
        .toEqual(['param.osc1.morph knob osc1 Morph (hidden, revealable)'])

      // And the row is not a claim: opening the tab produces exactly it.
      expect(guide.reveal({ id: 'param.env1.release' })).toMatchObject({ revealed: true, opened: ['tab.env1'] })
      expect(find('param.env1.release')).toEqual({
        id: 'param.env1.release', label: 'env1 Release', type: 'knob', visible: true
      })
    })

    /**
     * A parameter with no tab to open is left out rather than predicted: every
     * parameter outside a rebuilt row is mounted for the life of the page, so
     * an ID that fails that test has nothing behind it.
     */
    it('predicts nothing when no tab could produce it', () => {
      target('param.filter1.cutoff', app, 'filter1 Cutoff', 'knob')
      expect(guide.listTargets({ format: 'compact' }).items).toEqual([
        'param.filter1.cutoff knob filter1 Cutoff'
      ])
      expect(guide.listTargets({ search: 'param.env1.release' })).toMatchObject({
        total: 0, unmatched: { search: 'param.env1.release', revealable: false, opens: [] }
      })
    })

    /**
     * The prediction has to agree with what the app actually mounts, or the row
     * is a well-formed lie. Type comes from the same `ParamDef` fields the three
     * control factories switch on; this pins the answer for every parameter a
     * rebuilt ENV or LFO row owns, which is the whole set ever predicted.
     */
    it('predicts the control kind the app would build', () => {
      const kinds = new Map<string, string>()
      for (const id of ['env1', 'env2', 'env3', 'env4', 'env5', 'env6']) {
        for (const name of ['delay', 'attack', 'hold', 'decay', 'sustain', 'release', 'atk_curve', 'dec_curve', 'rel_curve']) {
          kinds.set(`${id}.${name}`, 'knob')
        }
      }
      for (let lfo = 1; lfo <= 8; lfo++) {
        // app.ts: a Knob for rate, phase and smooth, paramToggle for sync,
        // paramSelect for division and mode.
        kinds.set(`lfo${lfo}.rate`, 'knob')
        kinds.set(`lfo${lfo}.phase`, 'knob')
        kinds.set(`lfo${lfo}.smooth`, 'knob')
        kinds.set(`lfo${lfo}.sync`, 'button')
        kinds.set(`lfo${lfo}.division`, 'select')
        kinds.set(`lfo${lfo}.mode`, 'select')
      }
      const tabs = document.createElement('div')
      app.append(tabs)
      for (const group of [...new Set([...kinds.keys()].map(id => id.split('.')[0]))]) {
        guideTarget(tabs.appendChild(document.createElement('button')), `tab.${group}`, group, 'tab')
      }
      const listed = new Map((guide.listTargets({ format: 'compact' }).items as string[])
        .map(line => line.split(' ')).map(([id, type]) => [id, type]))
      for (const [id, type] of kinds) expect(listed.get(`param.${id}`), id).toBe(type)
      expect(listed.size).toBe(kinds.size + new Set([...kinds.keys()].map(id => id.split('.')[0])).size)
    })

    it('still warns, and reveals nothing, for an ID no tab could produce', async () => {
      envTabs()
      const result = guide.show({ steps: [{ target: { id: 'button.nope' }, markdown: 'Instructions survive' }] })
      expect(result).not.toHaveProperty('reveals')
      expect(result.warnings).toEqual([{ step: 1, message: expect.stringContaining('Nothing on the page carries that ID') }])
      await tick()
      expect(document.querySelector('.guide-warning')?.textContent).toContain('Target unavailable: button.nope')
      expect(document.querySelector('.driver-popover-description')?.textContent).toContain('Instructions survive')
    })

    it('opens the panel a step points into, so the human ends up looking at the control', async () => {
      const actions = panel('preset', 'Preset')
      const save = target('button.preset.save', actions, 'Save preset')

      const result = guide.show({ steps: [{ target: { id: 'button.preset.save' }, markdown: 'Name it, then save.' }] })
      expect(result).toMatchObject({ shown: true, warnings: [], reveals: [{ step: 1, opens: ['button.preset.actions'] }] })
      await tick()
      // The real DOM the guide drives, not the plan it returned.
      expect(actions.open).toBe(true)
      expect(save.classList.contains('driver-active-element')).toBe(true)
      expect(document.querySelector('.guide-warning')).toBeNull()
      // And the panel stays open once the guide is dismissed: closing it again
      // would leave the popover pointing at nothing and undo the whole point.
      document.querySelector<HTMLButtonElement>('.driver-popover-close-btn')!.click()
      expect(actions.open).toBe(true)
    })

    it('activates the tab that owns a control the page has not mounted yet', async () => {
      const { buttons } = envTabs()
      const result = guide.show({ steps: [{ target: { id: 'param.env1.release' }, markdown: 'Release' }] })
      expect(result).toMatchObject({ warnings: [], reveals: [{ step: 1, opens: ['tab.env1'] }] })
      await tick()
      expect(buttons[0].classList.contains('on')).toBe(true)
      expect(app.querySelector('[data-guide-id="param.env1.release"]')?.classList.contains('driver-active-element')).toBe(true)
    })

    it('leaves the screen alone when the caller opts out', async () => {
      const actions = panel('preset', 'Preset')
      target('button.preset.save', actions, 'Save preset')
      const result = guide.show({ reveal: false, steps: [{ target: { id: 'button.preset.save' } }] })
      expect(result).not.toHaveProperty('reveals')
      expect(result.warnings[0].message).toContain('Its panel or tab is closed')
      await tick()
      expect(actions.open).toBe(false)
      expect(() => guide.show({ reveal: 'yes', steps: [] })).toThrow(/reveal/)
    })

    it('is idempotent and never closes a panel the human already had open', () => {
      const actions = panel('preset', 'Preset')
      const save = target('button.preset.save', actions, 'Save preset')
      const other = panel('fx', 'FX')
      other.open = true
      target('button.fx.reset', other, 'Reset FX')

      expect(guide.reveal({ id: 'button.preset.save' })).toEqual({ revealed: true, opened: ['button.preset.actions'] })
      // Second call: already visible, so nothing to open and nothing to undo.
      expect(guide.reveal({ id: 'button.preset.save' })).toEqual({ revealed: true, opened: [] })
      expect(actions.open).toBe(true)
      expect(other.open).toBe(true)
      expect(guide.listTargets({ search: 'Save preset' }).items).toEqual([
        { id: 'button.preset.save', label: 'Save preset', type: 'button', visible: true }
      ])
      expect(save.classList.contains('driver-active-element')).toBe(false)
    })

    it('touches nothing but the container it opens, so no parameter can move', () => {
      const { buttons, mount } = envTabs()
      const knob = target('param.filter1.cutoff', app, 'filter1 Cutoff', 'knob')
      const seen: string[] = []
      const types = ['click', 'pointerdown', 'input', 'change']
      const spy = (event: Event) => seen.push(`${event.type}:${(event.target as HTMLElement).dataset?.guideId ?? 'unknown'}`)
      for (const type of types) document.addEventListener(type, spy, true)

      expect(guide.reveal({ id: 'param.env1.release' })).toMatchObject({ revealed: true, opened: ['tab.env1'] })
      for (const type of types) document.removeEventListener(type, spy, true)
      // Exactly one synthetic event, on the tab button. Every parameter in this
      // app moves through a pointer or input event on its own control, so a
      // reveal that dispatches none cannot have changed the patch.
      expect(seen).toEqual(['click:tab.env1'])
      expect(buttons[0].classList.contains('on')).toBe(true)
      expect(mount.querySelector('[data-guide-id="param.env1.release"]')).not.toBeNull()
      expect(knob.classList.contains('driver-active-element')).toBe(false)
    })
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
