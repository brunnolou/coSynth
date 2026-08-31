import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SynthEngine, RecordedAudio } from '../audio/engine'
import { createWebMcpTools } from '../webmcp/tools'
import { PerformanceManager, performNotes } from './performance'
import { ReplayStore } from './replays'

const notes = [{ midi: 60, velocity: 0.8, start: 0, duration: 0.1 }]
function setup() {
  const performance = new PerformanceManager()
  const heldNotes = new Set<number>()
  const engine = {
    onPatchChange: vi.fn(() => () => {}),
    running: true, heldNotes,
    ctx: { sampleRate: 8000 },
    scopeL: new Float32Array([0, 0.2, -0.2, 0]), scopeR: new Float32Array([0, 0.2, -0.2, 0]),
    noteOn: vi.fn((midi: number) => { heldNotes.add(midi) }),
    noteOff: vi.fn((midi: number) => { heldNotes.delete(midi) }),
    recordOutput: vi.fn(async (duration: number, _signal: AbortSignal): Promise<RecordedAudio> => ({
      blob: new Blob(['audio']), mimeType: 'audio/webm', duration, sampleRate: 8000,
      channelData: [new Float32Array([0, 0.2, -0.2, 0])]
    }))
  }
  const replays = new ReplayStore(performance, {
    play: (sequence, signal) => performNotes(engine, sequence, signal), showGuide: vi.fn(), canPlay: () => engine.running
  })
  const currentSoundEntryId = vi.fn(() => 'sound-initial')
  const onComparison = vi.fn()
  const tools = new Map(createWebMcpTools(engine as unknown as SynthEngine, undefined, {
    performance, replays, currentSoundEntryId, onComparison,
    decodeAudio: async () => ({ decodedBytes: 4, duration: 0.001, sampleRate: 8000, channels: 1, channelData: [new Float32Array([0, 0.2, -0.2, 0])] })
  }).map(tool => [tool.name, tool]))
  const execute = async (name: string, input: Record<string, unknown>) => tools.get(name)!.execute(input, { signal: new AbortController().signal })
  return { performance, engine, replays, currentSoundEntryId, onComparison, execute }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('WebMCP replay capture', () => {
  it('captures successful playback once and replays through the same manager', async () => {
    vi.useFakeTimers()
    const { execute, replays, engine } = setup()
    const played = execute('play_notes', { notes })
    await vi.advanceTimersByTimeAsync(110)
    await played
    expect(replays.snapshot()).toMatchObject([{ kind: 'performance', status: 'completed', notes, soundEntryId: 'sound-initial' }])
    const replayed = replays.replay(replays.latestPerformanceId()!)
    await vi.advanceTimersByTimeAsync(110)
    await replayed
    expect(engine.noteOn).toHaveBeenCalledTimes(2)
    expect(replays.snapshot()).toHaveLength(1)
  })

  it('does not retain invalid, locked, or held-note requests, but retains interrupted playback', async () => {
    vi.useFakeTimers()
    const { execute, replays, performance, engine } = setup()
    await expect(execute('play_notes', { notes: [{ ...notes[0], midi: 500 }] })).rejects.toThrow(/midi/)
    engine.running = false
    await expect(execute('play_notes', { notes })).rejects.toThrow(/Start audio/)
    engine.running = true
    engine.heldNotes.add(60)
    await expect(execute('play_notes', { notes })).rejects.toThrow(/held/)
    expect(replays.snapshot()).toEqual([])
    engine.heldNotes.clear()
    const played = execute('play_notes', { notes })
    const aborted = expect(played).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(10)
    await performance.stop()
    await aborted
    expect(replays.snapshot()).toMatchObject([{ status: 'cancelled', notes }])
    expect(engine.heldNotes.size).toBe(0)
  })

  it('retains rendered notes and associates comparisons with the sound rendered', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:render', revokeObjectURL: vi.fn() })
    const { execute, replays, currentSoundEntryId, onComparison } = setup()
    const rendered = execute('render_audio', { notes, duration: 0.2 })
    await vi.advanceTimersByTimeAsync(250)
    await rendered
    expect(replays.snapshot()).toMatchObject([{ label: 'AI rendered sequence', notes, duration: 0.2, status: 'completed' }])
    currentSoundEntryId.mockReturnValue('sound-later')
    await execute('analyze_reference_audio', { audioBase64: 'AAAA' })
    await execute('compare_audio', {})
    expect(onComparison).toHaveBeenCalledWith(expect.any(Object), 'sound-initial')
  })

  it('cancels rendering and waits for recorder cleanup before unlocking', async () => {
    vi.useFakeTimers()
    const { execute, replays, performance, engine } = setup()
    let cleaned = false
    engine.recordOutput.mockImplementation(async (_duration, signal) => {
      try {
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('recording aborted'))))
        throw new Error('unreachable')
      } finally { cleaned = true }
    })
    const rendered = execute('render_audio', { notes })
    const failed = expect(rendered).rejects.toThrow(/abort/)
    await vi.advanceTimersByTimeAsync(10)
    await performance.stop()
    await failed
    expect(cleaned).toBe(true)
    expect(performance.active).toBe(false)
    expect(replays.snapshot()).toMatchObject([{ status: 'cancelled' }])
    expect(engine.heldNotes.size).toBe(0)
  })
})
