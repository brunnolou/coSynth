import { soundStateAssets, type SoundSnapshot, type SynthEngine } from '../audio/engine'
import { PARAMS, formatValue } from '../shared/params'
import type { UiGuideController } from '../ui/guide'
import { agentActivityFor } from '../webmcp/activity'
import { HistoryStore } from './store'
import { PerformanceManager, performNotes, assertNotesAvailable } from './performance'
import { ReplayStore } from './replays'

export function equalSoundStates(a: SoundSnapshot, b: SoundSnapshot): boolean {
  return a.noiseSample === b.noiseSample && a.customTables.every((table, index) => table === b.customTables[index]) &&
    JSON.stringify([a.values, a.modSlots, a.lfoShapes, a.fxOrder]) === JSON.stringify([b.values, b.modSlots, b.lfoShapes, b.fxOrder])
}

function describeSoundChanges(before: SoundSnapshot, after: SoundSnapshot, changed: readonly string[]) {
  return changed.flatMap(id => {
    const index = PARAMS.findIndex(param => param.id === id)
    if (index < 0) return []
    return [{ id, before: formatValue(PARAMS[index], before.values[index]), after: formatValue(PARAMS[index], after.values[index]) }]
  })
}

export function createHistoryServices(engine: SynthEngine, guide: UiGuideController) {
  const performance = new PerformanceManager()
  const history = new HistoryStore({
    capture: () => engine.captureSoundState(),
    restore: state => engine.restoreSoundState(state),
    equal: equalSoundStates,
    assets: soundStateAssets,
    describe: describeSoundChanges,
    subscribe: listener => engine.onSoundChange(listener)
  }, () => performance.stop())
  const replays = new ReplayStore(performance, {
    canPlay: () => engine.running,
    play: async (notes, signal) => { assertNotesAvailable(engine, notes); await performNotes(engine, notes, signal) },
    showGuide: steps => { guide.show({ steps }) }
  })
  const activity = agentActivityFor(engine)
  activity.setReviewGuard(() => {
    const state = history.snapshot()
    return !performance.active && !state.navigating && !state.gestureActive
  })
  return {
    history, replays, performance,
    dispose() { activity.setReviewGuard(() => false); history.dispose(); replays.dispose() }
  }
}
export type AppHistoryServices = ReturnType<typeof createHistoryServices>
