// Assembles the full synth UI.

import { FILTER_TYPE_LABELS, paramIndex, SYNC_DIVISION_ORDER } from '../shared/params'
import type { SynthEngine } from '../audio/engine'
import { el } from './common'
import { Knob, sourceBadge, animatedKnobs } from './knob'
import { cancelKnobDrag } from './knob-drag'
import { bindEnabledState, bindSyncGating, paramSelect, paramToggle, knobRow } from './controls'
import { EnvDisplay } from './enveditor'
import { LfoEditor } from './lfoeditor'
import { ModMatrix } from './matrix'
import { FxRack } from './fxrack'
import { Scope } from './scope'
import { WavetableView } from './wt3d'
import { Keyboard } from './keyboard'
import { AgentActivityPanel } from './agent-activity'
import { PresetBrowser } from './presets'
import { initMidi } from './midi'
import { FilterResponseView } from './filter-response'
import { OscWavePreview } from './osc-wave-preview'
import { ModalDialog } from './dialog'
import { guideTarget } from './guide-target'
import type { HistoryServices } from '../history/types'
import { AgentHighlights } from './agent-highlights'
import { agentActivityFor } from '../webmcp/activity'
import { iconButton } from './icon-button'
import { History as HistoryIcon } from 'lucide'

export function buildApp(engine: SynthEngine, container: HTMLElement, services: HistoryServices, openWalkthrough: () => void): () => void {
  engine.primeTables()

  // ------------------------------------------------------------ header
  const header = el('header')
  guideTarget(header, 'panel.header', 'Main toolbar', 'panel')
  header.appendChild(el('div', 'logo brand-logo', 'coSynth'))
  header.appendChild(new PresetBrowser(engine).root)
  const hdrRight = el('div', 'hdr-right')
  hdrRight.appendChild(new Knob(engine, paramIndex('master.volume'), 40).root)
  hdrRight.appendChild(new Knob(engine, paramIndex('master.bpm'), 40).root)
  const voiceLabel = el('span', 'hdr-stat hdr-voices', 'voices 0')
  const midiLabel = el('button', 'hdr-stat hdr-midi', 'MIDI: …')
  guideTarget(midiLabel, 'button.midi', 'MIDI status and help', 'button')
  midiLabel.type = 'button'
  midiLabel.disabled = true
  const midiDialog = new ModalDialog('MIDI unavailable in ChatGPT')
  midiDialog.body.append(
    el('p', '', "OpenAI MIDI support isn't working in the ChatGPT browser."),
    el('p', '', "Hardware permission can't be granted here, even after enabling browser flags, as of August 2026."),
    el('p', 'midi-recommendation', 'Open coSynth in Chrome or another browser to test MIDI hardware.')
  )
  const midiDialogClose = el('button', 'agent-btn primary', 'Close')
  midiDialogClose.type = 'button'
  midiDialogClose.addEventListener('click', () => midiDialog.close())
  midiDialog.footer.appendChild(midiDialogClose)
  midiLabel.addEventListener('click', () => midiDialog.open())
  const hdrStats = el('div', 'hdr-stats')
  hdrStats.append(voiceLabel, midiLabel)
  const meter = el('div', 'meter')
  guideTarget(meter, 'visualizer.meter', 'Output level meters', 'visualizer')
  const meterLTrack = el('div', 'meter-track')
  const meterRTrack = el('div', 'meter-track')
  const meterL = el('div', 'meter-bar')
  const meterR = el('div', 'meter-bar')
  meterLTrack.appendChild(meterL)
  meterRTrack.appendChild(meterR)
  meter.append(meterLTrack, meterRTrack)
  const scope = new Scope(engine)
  guideTarget(scope.root, 'visualizer.scope', 'Waveform / spectrum toggle', 'visualizer')
  hdrRight.append(hdrStats, meter, scope.root)
  header.appendChild(hdrRight)

  // ------------------------------------------------------------ oscillators
  const oscCol = el('div', 'col osc-col')
  const wt3d = new WavetableView(engine)
  guideTarget(wt3d.root, 'visualizer.wavetable', '3D oscillator wavetable', 'visualizer')
  const oscWavePreviews: OscWavePreview[] = []
  wt3d.root.classList.add('osc-preview')
  oscCol.appendChild(wt3d.root)
  for (let o = 1; o <= 3; o++) {
    const panel = el('section', 'panel')
    guideTarget(panel, `panel.osc${o}`, `Oscillator ${o}`, 'panel')
    panel.addEventListener('click', () => wt3d.setOsc(o - 1))
    const head = el('div', 'panel-head')
    head.appendChild(paramToggle(engine, `osc${o}.enabled`, '●'))
    head.appendChild(el('span', 'panel-title', `OSC ${o}`))
    const file = el('input') as HTMLInputElement
    file.type = 'file'
    file.accept = '.wav'
    file.style.display = 'none'
    file.addEventListener('change', () => {
      const f = file.files?.[0]
      if (f) engine.importWavetableFile(o - 1, f).catch(err => alert(`Import failed: ${err}`))
      file.value = ''
    })
    const wavetableSelect = paramSelect(engine, `osc${o}.wavetable`, {
      separatorBefore: 'Custom',
      onSelect: choice => {
        if (choice !== 'Custom') return
        file.click()
        return false
      }
    })
    wavetableSelect.title = 'Choose a wavetable. Custom imports a single-cycle or Serum-format WAV.'
    const wavePreview = new OscWavePreview(engine, o - 1)
    guideTarget(wavePreview.root, `visualizer.osc${o}`, `Oscillator ${o} waveform`, 'visualizer')
    oscWavePreviews.push(wavePreview)
    head.append(wavetableSelect, file, wavePreview.root)
    panel.appendChild(head)
    const oscKnobs = knobRow(engine, [
      `osc${o}.morph`, `osc${o}.level`, `osc${o}.pan`, `osc${o}.transpose`, `osc${o}.fine`, `osc${o}.sync`,
      `osc${o}.unison`, `osc${o}.detune`, `osc${o}.blend`, `osc${o}.spread`, `osc${o}.phase`, `osc${o}.phase_rand`
    ], 42)
    panel.appendChild(oscKnobs)
    bindEnabledState(engine, `osc${o}.enabled`, panel)
    oscCol.appendChild(panel)
  }

  // sub
  const subPanel = el('section', 'panel')
  guideTarget(subPanel, 'panel.sub', 'Sub oscillator', 'panel')
  const subHead = el('div', 'panel-head')
  subHead.appendChild(paramToggle(engine, 'sub.enabled', '●'))
  subHead.appendChild(el('span', 'panel-title', 'SUB'))
  subHead.appendChild(paramSelect(engine, 'sub.shape'))
  subPanel.appendChild(subHead)
  subPanel.appendChild(knobRow(engine, ['sub.level', 'sub.pan', 'sub.octave'], 42))
  bindEnabledState(engine, 'sub.enabled', subPanel)
  oscCol.appendChild(subPanel)

  // noise
  const noisePanel = el('section', 'panel')
  guideTarget(noisePanel, 'panel.noise', 'Noise oscillator', 'panel')
  const noiseHead = el('div', 'panel-head')
  noiseHead.appendChild(paramToggle(engine, 'noise.enabled', '●'))
  noiseHead.appendChild(el('span', 'panel-title', 'NOISE'))
  noiseHead.appendChild(paramSelect(engine, 'noise.type'))
  const sampleBtn = el('button', 'hdr-btn', 'SMP')
  guideTarget(sampleBtn, 'button.noise.sample', 'Import noise sample', 'button')
  sampleBtn.title = 'Load a WAV into the sample slot (Noise type: Sample)'
  const sampleFile = el('input') as HTMLInputElement
  sampleFile.type = 'file'
  sampleFile.accept = '.wav'
  sampleFile.style.display = 'none'
  sampleFile.addEventListener('change', () => {
    const f = sampleFile.files?.[0]
    if (f) engine.importSampleFile(f).catch(err => alert(`Sample load failed: ${err}`))
    sampleFile.value = ''
  })
  sampleBtn.addEventListener('click', () => sampleFile.click())
  noiseHead.append(sampleBtn, sampleFile)
  noisePanel.appendChild(noiseHead)
  noisePanel.appendChild(knobRow(engine, ['noise.level', 'noise.pan', 'noise.pitch'], 42))
  bindEnabledState(engine, 'noise.enabled', noisePanel)
  oscCol.appendChild(noisePanel)

  // ------------------------------------------------------------ center column
  const centerCol = el('div', 'col center-col')
  const filterRow = el('div', 'filter-row')
  const filterViews: FilterResponseView[] = []

  for (let f = 1; f <= 2; f++) {
    const panel = el('section', 'panel filter-panel')
    guideTarget(panel, `panel.filter${f}`, `Filter ${f}`, 'panel')
    const head = el('div', 'panel-head')
    head.appendChild(paramToggle(engine, `filter${f}.enabled`, '●'))
    head.appendChild(el('span', 'panel-title', `FILTER ${f}`))
    head.appendChild(paramSelect(engine, `filter${f}.type`, { choiceLabels: FILTER_TYPE_LABELS }))
    panel.appendChild(head)
    const filterView = new FilterResponseView(engine, f as 1 | 2)
    guideTarget(filterView.root, `visualizer.filter${f}`, `Filter ${f} response`, 'visualizer')
    filterViews.push(filterView)
    panel.appendChild(filterView.root)
    panel.appendChild(knobRow(engine, [
      `filter${f}.cutoff`, `filter${f}.resonance`, `filter${f}.drive`, `filter${f}.keytrack`, `filter${f}.mix`
    ], 42))
    bindEnabledState(engine, `filter${f}.enabled`, panel)
    filterRow.appendChild(panel)
  }

  // ------------------------------------------------------------ right column
  const sideCol = el('div', 'col side-col')
  const distPanel = el('section', 'panel filter-panel')
  guideTarget(distPanel, 'panel.shape', 'Waveshaper', 'panel')
  const distHead = el('div', 'panel-head')
  distHead.appendChild(paramToggle(engine, 'dist.enabled', '●'))
  distHead.appendChild(el('span', 'panel-title', 'SHAPE'))
  distHead.appendChild(paramSelect(engine, 'dist.type'))
  distPanel.appendChild(distHead)
  distPanel.appendChild(knobRow(engine, ['dist.drive', 'dist.mix', 'dist.bits', 'dist.downsample'], 42))
  const routingWrap = el('div', 'routing-wrap')
  routingWrap.appendChild(el('span', 'routing-label', 'ROUTING'))
  routingWrap.appendChild(paramSelect(engine, 'filter.routing'))
  distPanel.appendChild(routingWrap)
  bindEnabledState(engine, 'dist.enabled', distPanel)
  sideCol.appendChild(distPanel)

  // ------------------------------------------------------------ envelopes
  const envPanel = el('section', 'panel module-panel env-panel')
  guideTarget(envPanel, 'panel.env', 'Envelope editor', 'panel')
  const envBody = el('div', 'mod-tab')
  const envSelector = el('div', 'sub-tabs')
  const envDisplay = new EnvDisplay(engine, 1)
  guideTarget(envDisplay.root, 'visualizer.env', 'Selected envelope shape', 'visualizer')
  const envKnobArea = el('div')
  let currentEnv = 1
  const renderEnvKnobs = () => {
    envKnobArea.textContent = ''
    envKnobArea.appendChild(knobRow(engine, [
      `env${currentEnv}.delay`, `env${currentEnv}.attack`, `env${currentEnv}.hold`,
      `env${currentEnv}.decay`, `env${currentEnv}.sustain`, `env${currentEnv}.release`,
      `env${currentEnv}.atk_curve`, `env${currentEnv}.dec_curve`, `env${currentEnv}.rel_curve`
    ], 42))
  }
  const envBtns: HTMLButtonElement[] = []
  for (let e = 1; e <= 6; e++) {
    const wrap = el('div', e === 1 ? 'sub-tab-wrap on' : 'sub-tab-wrap')
    const b = el('button', e === 1 ? 'sub-tab on' : 'sub-tab', `ENV ${e}${e === 1 ? ' · AMP' : ''}`) as HTMLButtonElement
    guideTarget(b, `tab.env${e}`, e === 1 ? 'Env 1 amplitude envelope' : `Env ${e}`, 'tab')
    b.addEventListener('click', () => {
      currentEnv = e
      envBtns.forEach((x, i) => {
        const active = i === e - 1
        x.classList.toggle('on', active)
        x.parentElement?.classList.toggle('on', active)
      })
      envDisplay.setEnv(e)
      renderEnvKnobs()
    })
    envBtns.push(b)
    wrap.append(b, sourceBadge(engine, `env${e}`))
    envSelector.appendChild(wrap)
  }
  renderEnvKnobs()
  envBody.append(envSelector, envDisplay.root, envKnobArea)
  envPanel.appendChild(envBody)
  centerCol.appendChild(envPanel)

  // ------------------------------------------------------------ LFOs
  const lfoPanel = el('section', 'panel module-panel lfo-panel')
  guideTarget(lfoPanel, 'panel.lfo', 'LFO editor', 'panel')
  const lfoBody = el('div', 'mod-tab')
  const lfoSelector = el('div', 'sub-tabs')
  const lfoEditor = new LfoEditor(engine, 0)
  guideTarget(lfoEditor.root, 'visualizer.lfo', 'Selected LFO shape', 'visualizer')
  lfoEditor.root.dataset.aiTarget = 'lfo.0'
  const lfoKnobArea = el('div')
  let currentLfo = 1
  let disposeLfoGating: (() => void) | undefined
  const renderLfoKnobs = () => {
    disposeLfoGating?.()
    lfoKnobArea.textContent = ''
    const row = el('div', 'knob-row lfo-controls')
    const rate = new Knob(engine, paramIndex(`lfo${currentLfo}.rate`), 42).root
    const division = paramSelect(engine, `lfo${currentLfo}.division`, { choiceOrder: SYNC_DIVISION_ORDER })
    row.appendChild(rate)
    row.appendChild(paramToggle(engine, `lfo${currentLfo}.sync`, 'SYNC'))
    row.appendChild(division)
    row.appendChild(paramSelect(engine, `lfo${currentLfo}.mode`))
    row.appendChild(new Knob(engine, paramIndex(`lfo${currentLfo}.phase`), 42).root)
    row.appendChild(new Knob(engine, paramIndex(`lfo${currentLfo}.smooth`), 42).root)
    lfoKnobArea.appendChild(row)
    disposeLfoGating = bindSyncGating(engine, `lfo${currentLfo}.sync`, { free: rate, division })
  }
  const lfoBtns: HTMLButtonElement[] = []
  for (let l = 1; l <= 8; l++) {
    const wrap = el('div', l === 1 ? 'sub-tab-wrap on' : 'sub-tab-wrap')
    const b = el('button', l === 1 ? 'sub-tab on' : 'sub-tab', `LFO ${l}`) as HTMLButtonElement
    guideTarget(b, `tab.lfo${l}`, `LFO ${l}`, 'tab')
    b.addEventListener('click', () => {
      currentLfo = l
      lfoBtns.forEach((x, i) => {
        const active = i === l - 1
        x.classList.toggle('on', active)
        x.parentElement?.classList.toggle('on', active)
      })
      lfoEditor.setLfo(l - 1)
      lfoEditor.root.dataset.aiTarget = `lfo.${l - 1}`
      renderLfoKnobs()
    })
    lfoBtns.push(b)
    wrap.append(b, sourceBadge(engine, `lfo${l}`))
    lfoSelector.appendChild(wrap)
  }
  renderLfoKnobs()
  lfoBody.append(lfoSelector, lfoEditor.root, lfoKnobArea)
  lfoPanel.appendChild(lfoBody)
  centerCol.appendChild(lfoPanel)
  centerCol.appendChild(filterRow)

  // ------------------------------------------------------------ matrix
  const matrixPanel = el('section', 'panel module-panel matrix-panel')
  guideTarget(matrixPanel, 'panel.matrix', 'Modulation matrix', 'panel')
  const matrixHead = el('div', 'panel-head')
  matrixHead.appendChild(el('span', 'panel-title', 'MATRIX'))
  const matrix = new ModMatrix(engine)
  matrixPanel.append(matrixHead, matrix.root)
  centerCol.appendChild(matrixPanel)

  // ------------------------------------------------------------ performance sources
  const performancePanel = el('section', 'panel performance-panel')
  guideTarget(performancePanel, 'panel.performance', 'Macros and performance sources', 'panel')
  const srcRow = el('div', 'source-row')
  const macroKnobs = el('div', 'knob-row')
  for (let m = 1; m <= 4; m++) {
    const wrap = el('div', 'macro-wrap')
    wrap.appendChild(new Knob(engine, paramIndex(`macro${m}.value`), 42).root)
    wrap.appendChild(sourceBadge(engine, `macro${m}`))
    macroKnobs.appendChild(wrap)
  }
  srcRow.appendChild(macroKnobs)
  const perfBadges = el('div', 'badge-row')
  for (const id of ['velocity', 'keytrack', 'random', 'modwheel', 'pitchwheel', 'aftertouch']) {
    perfBadges.appendChild(sourceBadge(engine, id))
  }
  srcRow.appendChild(perfBadges)
  performancePanel.appendChild(srcRow)

  // ------------------------------------------------------------ effects
  const fxPanel = el('section', 'panel fx-panel')
  guideTarget(fxPanel, 'panel.fx', 'Effects rack', 'panel')
  const fxHead = el('div', 'panel-head')
  fxHead.appendChild(el('span', 'panel-title', 'FX'))
  const fxRack = new FxRack(engine)
  fxPanel.append(fxHead, fxRack.root)
  sideCol.appendChild(fxPanel)

  // ------------------------------------------------------------ layout
  const main = el('main')
  guideTarget(main, 'panel.synth', 'Synth controls', 'panel')
  main.append(oscCol, centerCol, sideCol)
  const agentActivity = new AgentActivityPanel(engine, services, openWalkthrough)
  // A second entry to the same dialog, within reach while playing the keyboard.
  const keyboardHistory = iconButton('History', HistoryIcon)
  keyboardHistory.classList.add('kb-history')
  guideTarget(keyboardHistory, 'button.history.open-keyboard', 'Open history from the keyboard bar', 'button')
  keyboardHistory.addEventListener('click', () => agentActivity.openHistory())
  const keyboard = new Keyboard(engine, keyboardHistory)
  container.append(header, agentActivity.root, main, performancePanel, keyboard.root, midiDialog.root)
  const highlights = new AgentHighlights(container, agentActivityFor(engine))

  initMidi(engine, status => {
    midiLabel.textContent = status.text
    const blocked = status.state === 'blocked'
    midiLabel.disabled = !blocked
    midiLabel.classList.toggle('is-error', blocked)
    midiLabel.title = blocked
      ? 'MIDI access is blocked here in the ChatGPT desktop browser. To test MIDI, export your preset, open coSynth in Chrome, import the preset, and allow MIDI input when prompted. Click for details.'
      : ''
  })

  // ------------------------------------------------------------ animation loop
  let frame = 0
  const tick = () => {
    scope.draw()
    wt3d.draw()
    for (const preview of oscWavePreviews) if (preview.animated) preview.draw()
    for (const k of animatedKnobs()) k.draw()
    for (const view of filterViews) if (view.animated) view.draw()
    lfoEditor.draw()
    envDisplay.draw()
    voiceLabel.textContent = `voices ${engine.voiceCount}`
    meterL.style.width = `${Math.min(engine.peakL * 100, 100)}%`
    meterR.style.width = `${Math.min(engine.peakR * 100, 100)}%`
    meterL.classList.toggle('hot', engine.peakL > 1)
    meterR.classList.toggle('hot', engine.peakR > 1)
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
  return () => {
    cancelKnobDrag(container.ownerDocument)
    cancelAnimationFrame(frame)
    highlights.dispose()
    agentActivity.dispose()
    keyboard.dispose()
    matrix.dispose()
    fxRack.dispose()
  }
}
