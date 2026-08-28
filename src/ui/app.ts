// Assembles the full synth UI.

import { paramIndex } from '../shared/params'
import type { SynthEngine } from '../audio/engine'
import { el } from './common'
import { Knob, sourceBadge, animatedKnobs } from './knob'
import { bindEnabledState, paramSelect, paramToggle, knobRow } from './controls'
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

export function buildApp(engine: SynthEngine, container: HTMLElement): void {
  engine.primeTables()

  // ------------------------------------------------------------ header
  const header = el('header')
  header.appendChild(el('div', 'logo', 'SOUNDGINEER'))
  header.appendChild(new PresetBrowser(engine).root)
  const hdrRight = el('div', 'hdr-right')
  hdrRight.appendChild(new Knob(engine, paramIndex('master.volume'), 40).root)
  hdrRight.appendChild(new Knob(engine, paramIndex('master.bpm'), 40).root)
  const voiceLabel = el('span', 'hdr-stat hdr-voices', 'voices 0')
  const midiLabel = el('span', 'hdr-stat', 'MIDI: …')
  const hdrStats = el('div', 'hdr-stats')
  hdrStats.append(voiceLabel, midiLabel)
  const meter = el('div', 'meter')
  const meterLTrack = el('div', 'meter-track')
  const meterRTrack = el('div', 'meter-track')
  const meterL = el('div', 'meter-bar')
  const meterR = el('div', 'meter-bar')
  meterLTrack.appendChild(meterL)
  meterRTrack.appendChild(meterR)
  meter.append(meterLTrack, meterRTrack)
  const scope = new Scope(engine)
  hdrRight.append(hdrStats, meter, scope.root)
  header.appendChild(hdrRight)

  // ------------------------------------------------------------ oscillators
  const oscCol = el('div', 'col osc-col')
  const wt3d = new WavetableView(engine)
  const oscWavePreviews: OscWavePreview[] = []
  wt3d.root.classList.add('osc-preview')
  oscCol.appendChild(wt3d.root)
  for (let o = 1; o <= 3; o++) {
    const panel = el('section', 'panel')
    panel.addEventListener('click', () => wt3d.setOsc(o - 1))
    const head = el('div', 'panel-head')
    head.appendChild(paramToggle(engine, `osc${o}.enabled`, '●'))
    head.appendChild(el('span', 'panel-title', `OSC ${o}`))
    head.appendChild(paramSelect(engine, `osc${o}.wavetable`))
    const importBtn = el('button', 'hdr-btn', 'WAV')
    importBtn.title = 'Import single-cycle or Serum-format wavetable WAV'
    const file = el('input') as HTMLInputElement
    file.type = 'file'
    file.accept = '.wav'
    file.style.display = 'none'
    file.addEventListener('change', () => {
      const f = file.files?.[0]
      if (f) engine.importWavetableFile(o - 1, f).catch(err => alert(`Import failed: ${err}`))
      file.value = ''
    })
    importBtn.addEventListener('click', () => file.click())
    const wavePreview = new OscWavePreview(engine, o - 1)
    oscWavePreviews.push(wavePreview)
    head.append(importBtn, file, wavePreview.root)
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
  const noiseHead = el('div', 'panel-head')
  noiseHead.appendChild(paramToggle(engine, 'noise.enabled', '●'))
  noiseHead.appendChild(el('span', 'panel-title', 'NOISE'))
  noiseHead.appendChild(paramSelect(engine, 'noise.type'))
  const sampleBtn = el('button', 'hdr-btn', 'SMP')
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
    const head = el('div', 'panel-head')
    head.appendChild(paramToggle(engine, `filter${f}.enabled`, '●'))
    head.appendChild(el('span', 'panel-title', `FILTER ${f}`))
    head.appendChild(paramSelect(engine, `filter${f}.type`))
    panel.appendChild(head)
    const filterView = new FilterResponseView(engine, f as 1 | 2)
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
  const envBody = el('div', 'mod-tab')
  const envSelector = el('div', 'sub-tabs')
  const envDisplay = new EnvDisplay(engine, 1)
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
    const wrap = el('div', 'sub-tab-wrap')
    const b = el('button', e === 1 ? 'sub-tab on' : 'sub-tab', `ENV ${e}${e === 1 ? ' · AMP' : ''}`) as HTMLButtonElement
    b.addEventListener('click', () => {
      currentEnv = e
      envBtns.forEach((x, i) => x.classList.toggle('on', i === e - 1))
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
  const lfoBody = el('div', 'mod-tab')
  const lfoSelector = el('div', 'sub-tabs')
  const lfoEditor = new LfoEditor(engine, 0)
  const lfoKnobArea = el('div')
  let currentLfo = 1
  const renderLfoKnobs = () => {
    lfoKnobArea.textContent = ''
    const row = el('div', 'knob-row lfo-controls')
    row.appendChild(new Knob(engine, paramIndex(`lfo${currentLfo}.rate`), 42).root)
    row.appendChild(paramToggle(engine, `lfo${currentLfo}.sync`, 'SYNC'))
    row.appendChild(paramSelect(engine, `lfo${currentLfo}.division`))
    row.appendChild(paramSelect(engine, `lfo${currentLfo}.mode`))
    row.appendChild(new Knob(engine, paramIndex(`lfo${currentLfo}.phase`), 42).root)
    row.appendChild(new Knob(engine, paramIndex(`lfo${currentLfo}.smooth`), 42).root)
    lfoKnobArea.appendChild(row)
  }
  const lfoBtns: HTMLButtonElement[] = []
  for (let l = 1; l <= 8; l++) {
    const wrap = el('div', 'sub-tab-wrap')
    const b = el('button', l === 1 ? 'sub-tab on' : 'sub-tab', `LFO ${l}`) as HTMLButtonElement
    b.addEventListener('click', () => {
      currentLfo = l
      lfoBtns.forEach((x, i) => x.classList.toggle('on', i === l - 1))
      lfoEditor.setLfo(l - 1)
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
  const matrixHead = el('div', 'panel-head')
  matrixHead.appendChild(el('span', 'panel-title', 'MATRIX'))
  matrixPanel.append(matrixHead, new ModMatrix(engine).root)
  centerCol.appendChild(matrixPanel)

  // ------------------------------------------------------------ performance sources
  const performancePanel = el('section', 'panel performance-panel')
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
  const fxHead = el('div', 'panel-head')
  fxHead.appendChild(el('span', 'panel-title', 'FX'))
  fxPanel.append(fxHead, new FxRack(engine).root)
  sideCol.appendChild(fxPanel)

  // ------------------------------------------------------------ layout
  const main = el('main')
  main.append(oscCol, centerCol, sideCol)
  const agentActivity = new AgentActivityPanel(engine)
  const keyboard = new Keyboard(engine)
  container.append(header, main, agentActivity.root, performancePanel, keyboard.root)

  initMidi(engine, text => {
    midiLabel.textContent = text
  })

  // ------------------------------------------------------------ animation loop
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
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
