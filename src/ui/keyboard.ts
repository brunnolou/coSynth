// On-screen keyboard (pointer + computer-keyboard input) with octave shift.

import type { SynthEngine } from '../audio/engine'
import { el } from './common'
import { guideTarget } from './guide-target'
import { isTextEditing } from './history-bindings'

const KEYMAP: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6,
  KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13,
  KeyL: 14, KeyP: 15, Semicolon: 16
}

const WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11]
const BLACK_OFFSETS: Record<number, number> = { 0: 1, 1: 3, 3: 6, 4: 8, 5: 10 }

export class Keyboard {
  readonly root: HTMLElement
  private octave = 4 // C4-based
  private readonly keyEls = new Map<number, HTMLElement>()
  private readonly pointerNotes = new Map<number, number>()
  private readonly keyboardNotes = new Map<string, number>()
  private readonly disposeListeners: (() => void)[] = []

  constructor(private readonly engine: SynthEngine) {
    this.root = el('div', 'keyboard-wrap')
    guideTarget(this.root, 'panel.keyboard', 'Playable keyboard', 'panel')
    const octDown = el('button', 'oct-btn', '−')
    const octLabel = el('span', 'oct-label', 'C3–C6')
    const octUp = el('button', 'oct-btn', '+')
    guideTarget(octDown, 'button.octave.down', 'Keyboard octave down', 'button')
    guideTarget(octUp, 'button.octave.up', 'Keyboard octave up', 'button')
    const setOct = (o: number) => {
      this.octave = Math.max(0, Math.min(7, o))
      octLabel.textContent = `C${this.octave - 1}–C${this.octave + 2}`
    }
    octDown.addEventListener('click', () => setOct(this.octave - 1))
    octUp.addEventListener('click', () => setOct(this.octave + 1))
    const bar = el('div', 'kb-bar')
    bar.append(octDown, octLabel, octUp, el('span', 'kb-hint', 'Play: A W S E D F T G Y H U J K · octave Z / X'))

    const keys = el('div', 'keyboard')
    const startNote = 36 // C2; display 3 octaves + top C
    const numWhite = 3 * 7 + 1
    for (let w = 0; w < numWhite; w++) {
      const oct = Math.floor(w / 7)
      const inOct = w % 7
      const note = startNote + oct * 12 + WHITE_OFFSETS[inOct]
      const key = el('div', 'key white')
      key.dataset.note = String(note)
      keys.appendChild(key)
      this.keyEls.set(note, key)
      if (w < numWhite - 1 && inOct in BLACK_OFFSETS) {
        const bn = startNote + oct * 12 + BLACK_OFFSETS[inOct]
        const bk = el('div', 'key black')
        bk.dataset.note = String(bn)
        bk.style.left = `${((w + 1) / numWhite) * 100}%`
        keys.appendChild(bk)
        this.keyEls.set(bn, bk)
      }
    }

    keys.addEventListener('pointerdown', e => {
      const note = this.noteFromEvent(e)
      if (note < 0) return
      keys.setPointerCapture(e.pointerId)
      this.pointerNotes.set(e.pointerId, note)
      engine.noteOn(note, e.pressure > 0 && e.pressure !== 0.5 ? e.pressure : 0.8)
    })
    keys.addEventListener('pointermove', e => {
      if (!this.pointerNotes.has(e.pointerId)) return
      const note = this.noteFromEvent(e)
      const prev = this.pointerNotes.get(e.pointerId)!
      if (note >= 0 && note !== prev) {
        engine.noteOff(prev)
        engine.noteOn(note, 0.8)
        this.pointerNotes.set(e.pointerId, note)
      }
    })
    const release = (e: PointerEvent) => {
      const note = this.pointerNotes.get(e.pointerId)
      if (note !== undefined) {
        engine.noteOff(note)
        this.pointerNotes.delete(e.pointerId)
      }
    }
    keys.addEventListener('pointerup', release)
    keys.addEventListener('pointercancel', release)

    const keydown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTextEditing(e.target) || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (e.code === 'KeyZ') { setOct(this.octave - 1); return }
      if (e.code === 'KeyX') { setOct(this.octave + 1); return }
      const off = KEYMAP[e.code]
      if (off === undefined) return
      const note = (this.octave + 1) * 12 + off
      if (this.keyboardNotes.has(e.code)) return
      this.keyboardNotes.set(e.code, note)
      engine.noteOn(note, 0.8)
    }
    const keyup = (e: KeyboardEvent) => {
      const note = this.keyboardNotes.get(e.code)
      if (note !== undefined) {
        engine.noteOff(note)
        this.keyboardNotes.delete(e.code)
      }
    }
    window.addEventListener('keydown', keydown)
    window.addEventListener('keyup', keyup)
    this.disposeListeners.push(() => window.removeEventListener('keydown', keydown), () => window.removeEventListener('keyup', keyup))

    this.disposeListeners.push(engine.onNote((note, on) => {
      this.keyEls.get(note)?.classList.toggle('held', on)
    }))

    this.root.append(bar, keys)
  }

  dispose(): void {
    for (const cleanup of this.disposeListeners) cleanup()
    for (const note of this.keyboardNotes.values()) this.engine.noteOff(note)
    for (const note of this.pointerNotes.values()) this.engine.noteOff(note)
    this.keyboardNotes.clear()
    this.pointerNotes.clear()
  }

  private noteFromEvent(e: PointerEvent): number {
    const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
    const noteStr = target?.closest('.key')?.getAttribute('data-note')
    return noteStr ? Number(noteStr) : -1
  }
}
