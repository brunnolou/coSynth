import { describe, expect, it, vi } from 'vitest'
import { SynthEngine } from './engine'

function engineWithPostedMessages() {
  const engine = new SynthEngine()
  const postMessage = vi.fn()
  ;(engine as any).node = { port: { postMessage } }
  return { engine, postMessage }
}

describe('SynthEngine note ownership', () => {
  it('keeps a note held when the default human owner acquires it after another owner', () => {
    const { engine, postMessage } = engineWithPostedMessages()
    const listener = vi.fn()
    engine.onNote(listener)
    const operationOwner = Symbol('operation')

    engine.noteOn(60, 0.8, operationOwner)
    engine.noteOn(60)

    expect(engine.heldNotes.has(60)).toBe(true)
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'noteOn', note: 60, velocity: 0.8 }, [])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenLastCalledWith(60, true)

    engine.noteOff(60, operationOwner)

    expect(engine.heldNotes.has(60)).toBe(true)
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(listener).not.toHaveBeenCalledWith(60, false)

    engine.noteOff(60)

    expect(engine.heldNotes.has(60)).toBe(false)
    expect(postMessage).toHaveBeenCalledTimes(2)
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'noteOff', note: 60 }, [])
    expect(listener).toHaveBeenLastCalledWith(60, false)
  })

  it('treats repeated noteOn and noteOff calls from one owner as idempotent', () => {
    const { engine, postMessage } = engineWithPostedMessages()
    const listener = vi.fn()
    engine.onNote(listener)
    const owner = Symbol('owner')

    engine.noteOn(64, 0.5, owner)
    engine.noteOn(64, 1, owner)
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)

    engine.noteOff(64, owner)
    engine.noteOff(64, owner)
    expect(postMessage).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(engine.heldNotes.has(64)).toBe(false)
  })
})
