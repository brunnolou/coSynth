// Web MIDI input: notes, pitch bend, mod wheel (CC1), sustain (CC64),
// channel pressure, and CC20-23 mapped to the four macros.

import { paramIndex } from '../shared/params'
import type { SynthEngine } from '../audio/engine'

const MACRO_CCS = [20, 21, 22, 23]

export type MidiStatus = {
  state: 'ready' | 'no-inputs' | 'unavailable' | 'blocked' | 'error'
  text: string
}

export function isMidiPermissionBlocked(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; message?: unknown }
  const name = typeof candidate.name === 'string' ? candidate.name : ''
  const message = typeof candidate.message === 'string' ? candidate.message : ''
  return name === 'NotAllowedError' || name === 'SecurityError' || /permission|denied|not allowed/i.test(message)
}

export async function initMidi(engine: SynthEngine, onStatus: (status: MidiStatus) => void): Promise<void> {
  if (!('requestMIDIAccess' in navigator)) {
    onStatus({ state: 'unavailable', text: 'MIDI: unavailable' })
    return
  }
  try {
    const access = await navigator.requestMIDIAccess()
    const attach = () => {
      let count = 0
      access.inputs.forEach(input => {
        count++
        input.onmidimessage = e => handle(engine, e.data as Uint8Array)
      })
      onStatus(count > 0
        ? { state: 'ready', text: `MIDI: ${count} input${count > 1 ? 's' : ''}` }
        : { state: 'no-inputs', text: 'MIDI: no inputs' })
    }
    attach()
    access.onstatechange = attach
  } catch (error) {
    onStatus(isMidiPermissionBlocked(error)
      ? { state: 'blocked', text: 'MIDI: blocked' }
      : { state: 'error', text: 'MIDI: error' })
  }
}

function handle(engine: SynthEngine, data: Uint8Array): void {
  if (!data || data.length < 2) return
  const status = data[0] & 0xf0
  switch (status) {
    case 0x90: // note on (velocity 0 = off)
      if (data[2] > 0) engine.noteOn(data[1], data[2] / 127)
      else engine.noteOff(data[1])
      break
    case 0x80:
      engine.noteOff(data[1])
      break
    case 0xb0: {
      const cc = data[1]
      const v = data[2] / 127
      if (cc === 1) engine.modWheel(v)
      else if (cc === 64) engine.sustain(data[2] >= 64)
      else if (cc === 120 || cc === 123) engine.allNotesOff()
      else {
        const macro = MACRO_CCS.indexOf(cc)
        if (macro >= 0) engine.setParam(paramIndex(`macro${macro + 1}.value`), v)
      }
      break
    }
    case 0xd0: // channel pressure
      engine.aftertouch(data[1] / 127)
      break
    case 0xe0: {
      const bend = ((data[2] << 7) | data[1]) / 8192 - 1
      engine.pitchBend(bend)
      break
    }
  }
}
