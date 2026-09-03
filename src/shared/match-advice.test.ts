import { describe, expect, it } from 'vitest'
import { ADVICE_RULES, adviseFromDiff, assertRuleParamsExist, type AdviceCategory, type PatchValues } from './match-advice'
import type { MatchAction, MatchDiff } from './match-types'
import { PARAMS, type ParamDef } from './params'

// `diffAudioMetrics` is being written concurrently, so every fixture here is
// built by hand from the `MatchDiff` contract in `match-types.ts`.

const PARAM_BY_ID = new Map<string, ParamDef>(PARAMS.map(d => [d.id, d]))

/** Default patch in RAW units, matching the shape `PresetData.params` carries. */
function defaultPatch(overrides: Record<string, number | string> = {}): PatchValues {
  const patch: Record<string, number | string> = {}
  for (const d of PARAMS) patch[d.id] = d.def
  return { ...patch, ...overrides }
}

const BAND_CENTERS = Array.from({ length: 10 }, (_, i) => 31.25 * 2 ** i)

function zeroDiff(): MatchDiff {
  return {
    similarity: 1,
    pitch: { referenceHz: 220, candidateHz: 220, centsError: 0 },
    harmonics: {
      deltaDb: Array.from({ length: 12 }, () => 0),
      tiltDeltaDbPerOctave: 0,
      oddEvenDeltaDb: 0,
      inharmonicityDelta: 0
    },
    bands: BAND_CENTERS.map(centerHz => ({ centerHz, deltaDb: 0 })),
    envelope: { attackMsDelta: 0, timeToPeakMsDelta: 0, decayT60MsDelta: 0, sustainDbDelta: 0 },
    brightness: [
      { startMs: 0, endMs: 250, octaveDelta: 0 },
      { startMs: 250, endMs: 500, octaveDelta: 0 },
      { startMs: 500, endMs: 750, octaveDelta: 0 },
      { startMs: 750, endMs: 1000, octaveDelta: 0 }
    ],
    flatnessDelta: 0,
    stereoWidthDelta: 0,
    loudnessDbDelta: 0,
    actions: []
  }
}

function withBrightness(deltas: number[]): MatchDiff['brightness'] {
  return deltas.map((octaveDelta, i) => ({ startMs: i * 250, endMs: (i + 1) * 250, octaveDelta }))
}


/** Every category present in the table, for exhaustive focus checks. */
const CATEGORIES = [...new Set(ADVICE_RULES.map(r => r.category))] as AdviceCategory[]

function paramIdsOfCategory(category: AdviceCategory): Set<string> {
  const ids = new Set<string>()
  for (const rule of ADVICE_RULES) if (rule.category === category) for (const id of rule.paramIds) ids.add(id)
  return ids
}

/**
 * Apply every `suggested` in an advice list, the way an agent would, and report
 * which parameters actually CHANGED VALUE.
 *
 * The second half is the point. A suggestion that leaves the patch where it was
 * is the live-lock in miniature: the next comparison renders identical audio,
 * measures an identical error, and is handed the identical move. `changed` is
 * how these tests tell a real correction from a no-op dressed as one.
 */
function applySuggestions(
  patch: PatchValues,
  actions: readonly MatchAction[]
): { patch: PatchValues; changed: string[] } {
  const next: Record<string, number | string> = { ...patch }
  const changed: string[] = []
  for (const action of actions) {
    if (!action.suggested) continue
    const { id, to } = action.suggested
    if (next[id] !== to) changed.push(id)
    next[id] = to
  }
  return { patch: next, changed }
}

function expectLegalSuggestion(action: { suggested?: { id: string; to: number } }): void {
  const s = action.suggested
  if (!s) return
  const def = PARAM_BY_ID.get(s.id)
  expect(def, `suggested targets unknown param ${s.id}`).toBeDefined()
  if (!def) return
  if (def.choices) {
    expect(Number.isInteger(s.to)).toBe(true)
    expect(s.to).toBeGreaterThanOrEqual(0)
    expect(s.to).toBeLessThanOrEqual(def.choices.length - 1)
    return
  }
  expect(s.to).toBeGreaterThanOrEqual(def.min)
  expect(s.to).toBeLessThanOrEqual(def.max)
  if (def.step) expect(Math.abs(s.to / def.step - Math.round(s.to / def.step))).toBeLessThan(1e-6)
}

describe('rule table integrity', () => {
  it('references only parameter ids that exist in PARAMS', () => {
    const unknown: string[] = []
    for (const rule of ADVICE_RULES) {
      for (const id of rule.paramIds) if (!PARAM_BY_ID.has(id)) unknown.push(`${rule.id} -> ${id}`)
    }
    expect(unknown).toEqual([])
    expect(() => assertRuleParamsExist()).not.toThrow()
  })

  it('gives every rule a distinct id, a positive scale and a silence threshold', () => {
    const ids = ADVICE_RULES.map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const rule of ADVICE_RULES) {
      expect(rule.scale, rule.id).toBeGreaterThan(0)
      expect(rule.weight, rule.id).toBeGreaterThan(0)
      expect(rule.minError, rule.id).toBeGreaterThan(0)
      expect(rule.paramIds.length, rule.id).toBeGreaterThan(0)
      expect(rule.reads.length, rule.id).toBeGreaterThan(0)
    }
  })
})

describe('adviseFromDiff', () => {
  it('returns nothing for an all-zero diff', () => {
    expect(adviseFromDiff(zeroDiff(), defaultPatch())).toEqual([])
  })

  it('returns nothing when maxActions is zero', () => {
    const diff = zeroDiff()
    diff.loudnessDbDelta = -9
    expect(adviseFromDiff(diff, defaultPatch(), { maxActions: 0 })).toEqual([])
  })

  it('tolerates an empty patch by omitting the quantitative suggestion', () => {
    const diff = zeroDiff()
    diff.envelope.attackMsDelta = -120
    const [action] = adviseFromDiff(diff, {})
    expect(action.paramIds).toContain('env1.attack')
    expect(action.suggested).toBeUndefined()
  })

  it('emits only known params and legal suggestions across a spread of diffs', () => {
    // The negative half-semitone cases (+-1150, +-50) ride through here too, so
    // the general min/max/step assertion covers them.
    const magnitudes = [-3000, -1200, -1150, -120, -50, -12, -1.2, 1.2, 12, 50, 120, 1150, 1200, 3000]
    const patches = [
      defaultPatch(),
      {},
      defaultPatch({ 'osc1.unison': 7, 'osc1.detune': 40, 'noise.enabled': 1, 'noise.type': 'Pink' })
    ]
    let emitted = 0
    let suggestions = 0
    for (const patch of patches) {
      for (const m of magnitudes) {
        const diff = zeroDiff()
        diff.pitch.centsError = m
        diff.harmonics = {
          deltaDb: Array.from({ length: 12 }, (_, i) => (m / 100) * (i % 3 === 0 ? 1 : -1)),
          tiltDeltaDbPerOctave: m / 100,
          oddEvenDeltaDb: -m / 100,
          inharmonicityDelta: m * 1e-5
        }
        diff.bands = BAND_CENTERS.map((centerHz, i) => ({ centerHz, deltaDb: (m / 200) * (i > 6 ? 1 : -1) }))
        diff.envelope = {
          attackMsDelta: m,
          timeToPeakMsDelta: m,
          decayT60MsDelta: m * 2,
          sustainDbDelta: m / 40
        }
        diff.brightness = withBrightness([m / 1000, m / 800, m / 600, m / 400])
        diff.flatnessDelta = m / 4000
        diff.stereoWidthDelta = m / 4000
        diff.loudnessDbDelta = m / 100
        const actions = adviseFromDiff(diff, patch, { maxActions: 20 })
        for (const action of actions) {
          for (const id of action.paramIds) expect(PARAM_BY_ID.has(id), `unknown param ${id}`).toBe(true)
          expectLegalSuggestion(action)
          expect(action.finding.length).toBeGreaterThan(10)
          expect(action.estimatedGain).toBeGreaterThan(0)
          emitted++
          if (action.suggested) suggestions++
        }
      }
    }
    // Guard against the sweep silently exercising nothing.
    expect(emitted).toBeGreaterThan(100)
    expect(suggestions).toBeGreaterThan(50)
  })

  it('ranks by estimatedGain descending and caps at maxActions', () => {
    const diff = zeroDiff()
    diff.pitch.centsError = 1200
    diff.envelope.attackMsDelta = 300
    diff.envelope.decayT60MsDelta = -900
    diff.envelope.sustainDbDelta = -8
    diff.loudnessDbDelta = -9
    diff.stereoWidthDelta = -0.4
    diff.flatnessDelta = 0.3
    diff.brightness = withBrightness([-0.8, -0.8, -0.85, -0.8])

    const all = adviseFromDiff(diff, defaultPatch(), { maxActions: 50 })
    expect(all.length).toBeGreaterThan(5)
    const gains = all.map(a => a.estimatedGain)
    expect([...gains].sort((a, b) => b - a)).toEqual(gains)

    const capped = adviseFromDiff(diff, defaultPatch())
    expect(capped).toHaveLength(5)
    expect(capped.map(a => a.finding)).toEqual(all.slice(0, 5).map(a => a.finding))
  })
})

describe('pitch', () => {
  /**
   * The semitone count the finding TELLS a model to apply. Read back out of the
   * prose rather than recomputed, so these tests prove that the sentence and the
   * machine-applied value agree instead of restating the formula twice.
   */
  function semitonesFromFinding(finding: string): number {
    const m = /transpose by ([+-]?\d+(?:\.\d+)?) semitones?/i.exec(finding)
    expect(m, `no semitone move in finding: ${finding}`).not.toBeNull()
    return Number(m![1])
  }

  function pitchActions(cents: number, patch: PatchValues = defaultPatch()) {
    const diff = zeroDiff()
    diff.pitch.centsError = cents
    return adviseFromDiff(diff, patch)
  }

  function pitchAction(cents: number, patch: PatchValues = defaultPatch()) {
    const [action] = pitchActions(cents, patch)
    expect(action, `no action for cents=${cents}`).toBeDefined()
    return action
  }

  /** Cents of pitch a `suggested` move actually adds. Transpose is 100 per step. */
  function movedCents(action: { suggested?: { id: string; from: number; to: number } }): number {
    const s = action.suggested
    if (!s) return 0
    if (s.id === 'osc1.transpose') return (s.to - s.from) * 100
    if (s.id === 'osc1.fine') return s.to - s.from
    return 0
  }

  /**
   * One matching iteration, as the agent runs it: apply the moves, re-measure.
   *
   * `osc1.transpose` and `osc1.fine` are pure pitch offsets, so the re-rendered
   * candidate's error is the old error plus exactly the cents applied - the
   * same number `compare_audio` would measure back off the new audio.
   */
  function iterate(startCents: number, patch: PatchValues, apply: 'all' | 'first', rounds = 6): number[] {
    const errors = [startCents]
    let cents = startCents
    let state: Record<string, number | string> = { ...patch }
    for (let i = 0; i < rounds; i++) {
      const moves = pitchActions(cents, state).filter(a => a.suggested && movedCents(a) !== 0)
      if (moves.length === 0) break
      const applied = apply === 'first' ? moves.slice(0, 1) : moves
      for (const action of applied) state = { ...state, [action.suggested!.id]: action.suggested!.to }
      cents = Number((cents + applied.reduce((sum, a) => sum + movedCents(a), 0)).toFixed(6))
      errors.push(cents)
    }
    return errors
  }

  it('names an octave error explicitly rather than quoting 1200 cents', () => {
    for (const cents of [1200, -1200, 2400, -2400, 1180]) {
      const diff = zeroDiff()
      diff.pitch.centsError = cents
      const [action] = adviseFromDiff(diff, defaultPatch())
      expect(action.finding.toLowerCase(), `cents=${cents}`).toContain('octave')
      expect(action.confidence).toBe('high')
    }
  })

  it('suggests the exact transpose that removes the octave', () => {
    const diff = zeroDiff()
    // The real bug this guards: a 37 Hz reference matched with MIDI 38 (73.4 Hz).
    diff.pitch = { referenceHz: 37, candidateHz: 73.4, centsError: 1200 }
    const [action] = adviseFromDiff(diff, defaultPatch())
    expect(action.suggested).toEqual({ id: 'osc1.transpose', from: 0, to: -12, unit: 'st' })
    expect(action.direction).toBe('decrease')
  })

  it('does not call a small detune an octave error', () => {
    const diff = zeroDiff()
    diff.pitch.centsError = -18
    const [action] = adviseFromDiff(diff, defaultPatch())
    expect(action.finding.toLowerCase()).not.toContain('octave')
    expect(action.finding).toContain('18.0 cents')
    expect(action.suggested?.id).toBe('osc1.fine')
    expect(action.suggested?.to).toBe(18)
  })

  it('stays silent for a few cents of error', () => {
    const diff = zeroDiff()
    diff.pitch.centsError = 4
    expect(adviseFromDiff(diff, defaultPatch())).toEqual([])
  })

  it('suggests exactly the semitone count its finding states', () => {
    // +-50 is deliberately absent: half a semitone belongs entirely to
    // osc1.fine now, and `treats the 50-cent boundary as a fine move` owns it.
    const sweep = [
      51, -51, 99, -99, 101, -101,
      // The octave band and both of its edges, inside and one cent outside.
      1140, -1140, 1139, -1139, 1150, -1150, 1200, -1200, 1250, -1250, 1260, -1260, 1261, -1261,
      2340, -2340, 2350, -2350, 2400, -2400, 2460, -2460, 2461, -2461
    ]
    for (const cents of sweep) {
      const action = pitchAction(cents)
      const s = action.suggested
      expect(s?.id, `cents=${cents}`).toBe('osc1.transpose')
      expect(s!.to - s!.from, `cents=${cents}`).toBe(semitonesFromFinding(action.finding))
      expectLegalSuggestion(action)
    }
  })

  it('rounds a negative half-semitone away from zero, not toward +Infinity', () => {
    // Math.round(-1150 / 100) is Math.round(-11.5) === -11, a semitone short of
    // the octave the same finding names. -12 is the only defensible answer.
    const action = pitchAction(-1150)
    expect(action.suggested).toEqual({ id: 'osc1.transpose', from: 0, to: 12, unit: 'st' })
    expect(semitonesFromFinding(action.finding)).toBe(12)
    expect(action.finding.toLowerCase()).toContain('octave')
    expect(action.direction).toBe('increase')
  })

  it('corrects +X and -X by equal and opposite amounts', () => {
    for (const cents of [20, 49, 50, 51, 99, 101, 175, 250, 1139, 1140, 1150, 1200, 1250, 1260, 1261, 2350, 2400, 3000]) {
      const up = pitchActions(cents)
      const down = pitchActions(-cents)
      expect(up.length, `cents=${cents}`).toBe(down.length)
      for (const [i, upAction] of up.entries()) {
        const downAction = down[i]
        expect(upAction.suggested!.id, `cents=${cents}`).toBe(downAction.suggested!.id)
        expect(upAction.suggested!.to, `cents=${cents}`).toBe(-downAction.suggested!.to)
        expect(upAction.confidence, `cents=${cents}`).toBe(downAction.confidence)
      }
      if (/transpose by/i.test(up[0].finding)) {
        expect(semitonesFromFinding(up[0].finding), `cents=${cents}`).toBe(-semitonesFromFinding(down[0].finding))
      }
    }
  })

  it('agrees on the octave word and the semitone count at every band edge', () => {
    // Inside the 60-cent band the octave decides the count; outside it the
    // nearest semitone does. No input gets one answer from each.
    const cases = [
      [1140, -12, true], [1139, -11, false], [1260, -12, true], [1261, -13, false],
      [-1140, 12, true], [-1139, 11, false], [-1260, 12, true], [-1261, 13, false],
      [2340, -24, true], [2339, -23, false], [2460, -24, true], [2461, -25, false],
      [-2340, 24, true], [-2339, 23, false], [-2460, 24, true], [-2461, 25, false]
    ] as const
    for (const [cents, semitones, isOctave] of cases) {
      const action = pitchAction(cents)
      expect(action.finding.toLowerCase().includes('octave'), `cents=${cents}`).toBe(isOctave)
      expect(semitonesFromFinding(action.finding), `cents=${cents}`).toBe(semitones)
      expect(action.suggested!.to - action.suggested!.from, `cents=${cents}`).toBe(semitones)
    }
  })

  it('names the leftover cents so the two moves add up to the whole error', () => {
    for (const cents of [1141, -1141, 1150, -1150, 1260, -1260, 175, -175]) {
      const action = pitchAction(cents)
      const m = /([+-]\d+(?:\.\d+)?) cents? on osc1\.fine/.exec(action.finding)
      expect(m, `no residual in: ${action.finding}`).not.toBeNull()
      expect(semitonesFromFinding(action.finding) * 100 + Number(m![1])).toBeCloseTo(-cents, 6)
    }
  })

  it('routes a sub-semitone error to osc1.fine and never to osc1.transpose', () => {
    for (const cents of [-49, -20, 20, 49]) {
      const action = pitchAction(cents)
      expect(action.suggested!.id, `cents=${cents}`).toBe('osc1.fine')
      expect(action.suggested!.to, `cents=${cents}`).toBe(-cents)
      expect(action.finding, `cents=${cents}`).not.toMatch(/transpose by/i)
      expect(action.confidence).toBe('medium')
      expect(action.paramIds).not.toContain('osc1.transpose')
    }
  })

  it('treats the 50-cent boundary as a fine move, in both directions', () => {
    // Half a semitone is the worst case for the semitone grid: a +-1 semitone
    // move leaves exactly the same error with the sign flipped, so classifying
    // it as a transpose was a LIVE-LOCK, and `Math.round(-0.5)` being -0 made
    // the two directions disagree about which way to live-lock. osc1.fine
    // reaches +-100 cents, so it takes the whole 50 and nothing is left over.
    expect(pitchAction(50).suggested).toEqual({ id: 'osc1.fine', from: 0, to: -50, unit: 'ct' })
    expect(pitchAction(-50).suggested).toEqual({ id: 'osc1.fine', from: 0, to: 50, unit: 'ct' })
    for (const cents of [50, -50]) {
      expect(pitchActions(cents), `cents=${cents}`).toHaveLength(1)
      expect(pitchAction(cents).finding, `cents=${cents}`).not.toMatch(/transpose by/i)
    }
  })

  it('emits both halves of a split move, and they add up to the whole error', () => {
    // The reviewer's case: a finding that describes a semitone AND a residual
    // while `suggested` applied only the semitone. Both are moves now.
    for (const cents of [51, -51, 150, -150, 250, -250, 1250, -1250, 1141, -1141, 175, -175]) {
      const actions = pitchActions(cents)
      const ids = actions.map(a => a.suggested?.id)
      expect(ids, `cents=${cents}`).toEqual(['osc1.transpose', 'osc1.fine'])
      const applied = actions.reduce((sum, a) => sum + movedCents(a), 0)
      expect(applied, `cents=${cents}`).toBeCloseTo(-cents, 6)
      for (const action of actions) expectLegalSuggestion(action)
      // Same gain, so the ranked list cannot separate them.
      expect(actions[0].estimatedGain, `cents=${cents}`).toBe(actions[1].estimatedGain)
    }
  })

  it('lands the whole correction in one iteration', () => {
    for (const cents of [50, -50, 49, -51, 150, -150, 250, -250, 1250, -1250, 2450, -2450]) {
      expect(iterate(cents, defaultPatch(), 'all'), `cents=${cents}`).toEqual([cents, 0])
    }
  })

  it('converges without oscillating even when only the top action is applied', () => {
    // A truncated `maxActions`, or an agent that applies just the best move.
    // The old rule turned this into a live-lock at half a semitone: +50 -> -50
    // -> +50 forever. Every sequence below must shrink strictly and then stop.
    const cases: [number, number[]][] = [
      [50, [50, 0]],
      [-50, [-50, 0]],
      [49, [49, 0]],
      [-51, [-51, 49, 0]],
      [150, [150, 50, 0]],
      [-150, [-150, -50, 0]],
      [250, [250, 50, 0]],
      [-250, [-250, -50, 0]],
      [1250, [1250, 50, 0]],
      [-1250, [-1250, -50, 0]],
      [2450, [2450, 50, 0]]
    ]
    for (const [cents, expected] of cases) {
      const errors = iterate(cents, defaultPatch(), 'first')
      expect(errors, `cents=${cents}`).toEqual(expected)
      for (let i = 1; i < errors.length; i++) {
        expect(Math.abs(errors[i]), `cents=${cents} step ${i}`).toBeLessThan(Math.abs(errors[i - 1]))
      }
      // Settled: the last error is below the rule's own silence threshold, and
      // asking again from there produces no further move.
      expect(Math.abs(errors[errors.length - 1]), `cents=${cents}`).toBeLessThan(8)
      expect(iterate(errors[errors.length - 1], defaultPatch(), 'first')).toHaveLength(1)
    }
  })

  it('borrows a semitone when osc1.fine cannot reach the target from where it sits', () => {
    // fine pinned near its limit used to clamp: 90 + 30 -> 100, a third of the
    // move applied, and the next round suggested 100 -> 100, which is no move
    // at all. The pitch then stayed wrong with nothing left to suggest.
    const patch = defaultPatch({ 'osc1.fine': 90 })
    const actions = pitchActions(-30, patch)
    expect(actions.map(a => a.suggested)).toEqual([
      { id: 'osc1.transpose', from: 0, to: 1, unit: 'st' },
      { id: 'osc1.fine', from: 90, to: 20, unit: 'ct' }
    ])
    expect(actions[0].finding).toContain('cannot reach that from there')
    expect(actions.reduce((sum, a) => sum + movedCents(a), 0)).toBeCloseTo(30, 6)
    expect(iterate(-30, patch, 'all')).toEqual([-30, 0])
    expect(iterate(-30, patch, 'first')).toEqual([-30, 70, 0])
  })

  it('settles from a quarter-tone reference at every offset around the grid', () => {
    // `compare_audio` auto-renders at the reference's nearest MIDI note, so a
    // quarter-tone reference lands the candidate here on every comparison.
    // Applying both moves is always exact; applying only the top one always
    // settles, and shrinks monotonically whenever osc1.fine has the headroom to
    // take the residual on its own (a borrow overshoots by design, then the
    // next round hands the cents back - it terminates, it just is not monotone).
    const patches = [defaultPatch(), defaultPatch({ 'osc1.fine': 90 }), defaultPatch({ 'osc1.fine': -90 })]
    for (const [index, patch] of patches.entries()) {
      for (let cents = -1300; cents <= 1300; cents += 25) {
        const all = iterate(cents, patch, 'all')
        // One round: the error, then nothing left of it. Below the rule's own
        // 8-cent silence threshold there is no round to run.
        expect(all, `cents=${cents} all`).toHaveLength(Math.abs(cents) < 8 ? 1 : 2)
        expect(Math.abs(all[all.length - 1]), `cents=${cents} all`).toBeLessThan(0.5)
        const first = iterate(cents, patch, 'first')
        expect(first.length, `cents=${cents} first ran out of rounds`).toBeLessThanOrEqual(4)
        expect(Math.abs(first[first.length - 1]), `cents=${cents} first`).toBeLessThan(8)
        if (index > 0) continue
        for (let i = 1; i < first.length; i++) {
          expect(Math.abs(first[i]), `cents=${cents} step ${i}`).toBeLessThan(Math.abs(first[i - 1]))
        }
      }
    }
  })

  it('quantizes a fractional transpose away from zero in both directions', () => {
    // legalValue's step rounding sees negative halves too: 0.5 - 12 is -11.5.
    expect(pitchAction(1200, defaultPatch({ 'osc1.transpose': 0.5 })).suggested!.to).toBe(-12)
    expect(pitchAction(-1200, defaultPatch({ 'osc1.transpose': -0.5 })).suggested!.to).toBe(12)
  })

  it('keeps every pitch suggestion inside its range and on its step', () => {
    const patches: PatchValues[] = [
      defaultPatch(),
      defaultPatch({ 'osc1.transpose': 44, 'osc1.fine': 90 }),
      defaultPatch({ 'osc1.transpose': -44, 'osc1.fine': -90 }),
      {}
    ]
    for (const patch of patches) {
      for (let cents = -3000; cents <= 3000; cents += 25) {
        const diff = zeroDiff()
        diff.pitch.centsError = cents
        for (const action of adviseFromDiff(diff, patch)) expectLegalSuggestion(action)
      }
    }
  })
})

describe('brightness windows', () => {
  const darkThroughout = () => {
    const diff = zeroDiff()
    diff.brightness = withBrightness([-0.9, -0.95, -0.9, -0.92])
    diff.bands = BAND_CENTERS.map(centerHz => ({ centerHz, deltaDb: centerHz >= 4000 ? -7 : 0 }))
    return diff
  }
  const darkensTooFast = () => {
    const diff = zeroDiff()
    diff.brightness = withBrightness([0.05, -0.3, -0.85, -1.5])
    return diff
  }

  it('reads a flat offset as a static cutoff', () => {
    const actions = adviseFromDiff(darkThroughout(), defaultPatch())
    const cutoff = actions.find(a => a.paramIds.includes('filter1.cutoff'))
    expect(cutoff).toBeDefined()
    expect(cutoff!.finding).toContain('every one of the 4 analysis windows')
    expect(cutoff!.direction).toBe('increase')
    // 0.92 octaves dark -> cutoff roughly doubles from the 8000 Hz default.
    expect(cutoff!.suggested?.id).toBe('filter1.cutoff')
    expect(cutoff!.suggested!.to).toBeGreaterThan(14000)
    expect(cutoff!.suggested!.to).toBeLessThanOrEqual(20000)
    // Upper bands corroborate the same direction, so this one earns `high`.
    expect(cutoff!.confidence).toBe('high')
    expect(actions.some(a => a.paramIds.includes('env2.decay'))).toBe(false)
  })

  it('reads a growing offset as envelope depth, not cutoff', () => {
    const actions = adviseFromDiff(darkensTooFast(), defaultPatch())
    const env = actions.find(a => a.paramIds.includes('env2.decay'))
    expect(env).toBeDefined()
    expect(env!.finding).toContain('darkens too fast')
    expect(env!.finding).toContain('filter1.cutoff')
    expect(env!.suggested?.id).toBe('env2.decay')
    expect(actions.some(a => a.suggested?.id === 'filter1.cutoff')).toBe(false)
  })

  it('produces different actions for the two shapes', () => {
    const a = adviseFromDiff(darkThroughout(), defaultPatch()).map(x => x.paramIds.join('+'))
    const b = adviseFromDiff(darkensTooFast(), defaultPatch()).map(x => x.paramIds.join('+'))
    expect(a).not.toEqual(b)
    expect(a.some(x => b.includes(x))).toBe(false)
  })

  it('falls back to octave bands when per-window brightness is unavailable', () => {
    const diff = zeroDiff()
    diff.brightness = []
    diff.bands = BAND_CENTERS.map(centerHz => ({ centerHz, deltaDb: centerHz >= 4000 ? -8 : 0 }))
    const [action] = adviseFromDiff(diff, defaultPatch())
    expect(action.paramIds).toContain('filter1.cutoff')
    expect(action.finding).toContain('4 kHz')
    expectLegalSuggestion(action)
  })
})

describe('category separation', () => {
  const envelopeOnly = () => {
    const diff = zeroDiff()
    diff.pitch = { referenceHz: null, candidateHz: null, centsError: null }
    diff.harmonics = null
    diff.envelope = { attackMsDelta: 140, timeToPeakMsDelta: 140, decayT60MsDelta: -800, sustainDbDelta: -7 }
    return diff
  }
  const timbreOnly = () => {
    const diff = zeroDiff()
    diff.harmonics = {
      deltaDb: [0, -8, -6, -5, 0, 0, 0, 0, 0, 0, 0, 0],
      tiltDeltaDbPerOctave: -4,
      oddEvenDeltaDb: 7,
      inharmonicityDelta: 0
    }
    // Flat across windows: a static timbre error, no envelope story.
    diff.brightness = withBrightness([-0.7, -0.7, -0.7, -0.7])
    return diff
  }

  it('an envelope-only diff yields no timbre actions', () => {
    const actions = adviseFromDiff(envelopeOnly(), defaultPatch(), { maxActions: 20 })
    expect(actions.length).toBeGreaterThan(0)
    const envelopeIds = paramIdsOfCategory('envelope')
    for (const action of actions) {
      for (const id of action.paramIds) expect(envelopeIds.has(id), `non-envelope param ${id}`).toBe(true)
    }
    expect(actions.every(a => a.paramIds.every(id => id.startsWith('env1.')))).toBe(true)
  })

  it('a timbre-only diff yields no envelope actions', () => {
    const actions = adviseFromDiff(timbreOnly(), defaultPatch(), { maxActions: 20 })
    expect(actions.length).toBeGreaterThan(0)
    expect(actions.some(a => a.paramIds.some(id => /^env\d\./.test(id)))).toBe(false)
  })
})

describe('focus', () => {
  const busy = () => {
    const diff = zeroDiff()
    diff.pitch.centsError = 700
    diff.harmonics = {
      deltaDb: [0, -9, -7, -5, 0, 0, -6, -6, -6, -6, -6, -6],
      tiltDeltaDbPerOctave: -5,
      oddEvenDeltaDb: 6,
      inharmonicityDelta: 8e-4
    }
    diff.brightness = withBrightness([0, -0.4, -0.9, -1.6])
    diff.envelope = { attackMsDelta: 90, timeToPeakMsDelta: 90, decayT60MsDelta: -700, sustainDbDelta: -5 }
    diff.flatnessDelta = 0.25
    diff.stereoWidthDelta = -0.35
    diff.loudnessDbDelta = -6
    return diff
  }

  it('keeps only the rules of the requested category', () => {
    for (const category of CATEGORIES) {
      const allowed = paramIdsOfCategory(category)
      const actions = adviseFromDiff(busy(), defaultPatch({ 'osc1.unison': 7, 'osc1.detune': 40 }), {
        focus: category,
        maxActions: 20
      })
      expect(actions.length, category).toBeGreaterThan(0)
      for (const action of actions) {
        for (const id of action.paramIds) expect(allowed.has(id), `${category} leaked ${id}`).toBe(true)
      }
    }
  })

  it('an unfocused call is the union of the focused ones', () => {
    const unfocused = adviseFromDiff(busy(), defaultPatch(), { maxActions: 50 }).map(a => a.finding)
    const union = CATEGORIES.flatMap(category =>
      adviseFromDiff(busy(), defaultPatch(), { focus: category, maxActions: 50 }).map(a => a.finding)
    )
    expect(new Set(unfocused)).toEqual(new Set(union))
  })
})

describe('envelope arithmetic', () => {
  it('converts an attack delta in ms to env1.attack in seconds', () => {
    const diff = zeroDiff()
    diff.envelope.attackMsDelta = -95 // candidate 95 ms too fast
    const [action] = adviseFromDiff(diff, defaultPatch({ 'env1.attack': 0.005 }))
    expect(action.paramIds).toEqual(['env1.attack'])
    expect(action.direction).toBe('increase')
    expect(action.suggested).toEqual({ id: 'env1.attack', from: 0.005, to: 0.1, unit: 's' })
    expect(action.confidence).toBe('high')
  })

  it('clamps an impossible attack to the parameter minimum', () => {
    const diff = zeroDiff()
    diff.envelope.attackMsDelta = 9000
    const [action] = adviseFromDiff(diff, defaultPatch({ 'env1.attack': 0.02 }))
    expect(action.suggested!.to).toBe(0.001)
  })

  it('converts a T60 delta to env1.decay seconds', () => {
    const diff = zeroDiff()
    diff.envelope.decayT60MsDelta = -400
    const [action] = adviseFromDiff(diff, defaultPatch({ 'env1.decay': 0.5 }))
    expect(action.paramIds).toEqual(['env1.decay', 'env1.release'])
    expect(action.suggested).toEqual({ id: 'env1.decay', from: 0.5, to: 0.9, unit: 's' })
  })

  it('leaves T60 alone when the buffer held no decay', () => {
    const diff = zeroDiff()
    diff.envelope.decayT60MsDelta = null
    expect(adviseFromDiff(diff, defaultPatch())).toEqual([])
  })

  it('converts a sustain dB delta to a linear level', () => {
    const diff = zeroDiff()
    diff.envelope.sustainDbDelta = -6
    const [action] = adviseFromDiff(diff, defaultPatch({ 'env1.sustain': 0.4 }))
    expect(action.paramIds).toEqual(['env1.sustain'])
    expect(action.suggested!.to).toBeCloseTo(0.4 * 10 ** (6 / 20), 4)
    expect(action.suggested!.to).toBeLessThanOrEqual(1)
  })
})

describe('level and space', () => {
  it('turns a loudness delta into a master.volume gain', () => {
    const diff = zeroDiff()
    diff.loudnessDbDelta = -6
    const [action] = adviseFromDiff(diff, defaultPatch({ 'master.volume': 0.5 }))
    expect(action.paramIds).toEqual(['master.volume'])
    expect(action.suggested!.to).toBeCloseTo(0.5 * 10 ** (6 / 20), 4)
    expect(action.confidence).toBe('high')
  })

  it('says so when master.volume cannot cover the gap', () => {
    const diff = zeroDiff()
    diff.loudnessDbDelta = -24
    const [action] = adviseFromDiff(diff, defaultPatch({ 'master.volume': 1.0 }))
    expect(action.finding).toContain('cannot travel that far')
    expect(action.suggested!.to).toBe(1.5)
  })

  it('steers width at the source before the effects', () => {
    const diff = zeroDiff()
    diff.stereoWidthDelta = -0.3
    const [action] = adviseFromDiff(diff, defaultPatch())
    expect(action.paramIds.slice(0, 3)).toEqual(['osc1.unison', 'osc1.detune', 'osc1.spread'])
    expect(action.paramIds).toContain('reverb.width')
    expectLegalSuggestion(action)
  })
})

describe('noise and harmonics', () => {
  it('reduces noise.level when the candidate is too noisy', () => {
    const diff = zeroDiff()
    diff.flatnessDelta = 0.3
    const [action] = adviseFromDiff(diff, defaultPatch({ 'noise.enabled': 1, 'noise.level': 0.5 }))
    expect(action.direction).toBe('decrease')
    expect(action.suggested).toEqual({ id: 'noise.level', from: 0.5, to: 0.2, unit: 'raw' })
    expect(action.confidence).toBe('low')
  })

  it('points at noise.enabled when the candidate is too clean and noise is off', () => {
    const diff = zeroDiff()
    diff.flatnessDelta = -0.25
    const [action] = adviseFromDiff(diff, defaultPatch({ 'noise.enabled': 0 }))
    expect(action.direction).toBe('increase')
    expect(action.paramIds).toContain('noise.type')
    expect(action.finding).toContain('noise.enabled')
  })

  it('quotes the measured range for quiet low partials', () => {
    const diff = zeroDiff()
    diff.harmonics = {
      deltaDb: [0, -5, -7, -9, null, null, null, null, null, null, null, null],
      tiltDeltaDbPerOctave: 0,
      oddEvenDeltaDb: 0,
      inharmonicityDelta: 0
    }
    const [action] = adviseFromDiff(diff, defaultPatch())
    expect(action.finding).toContain('Partials 2-4 are 5.0-9.0 dB quiet')
    expect(action.direction).toBe('either')
  })

  it('skips every harmonic rule when the diff has no harmonic block', () => {
    const diff = zeroDiff()
    diff.harmonics = null
    diff.loudnessDbDelta = -6
    const actions = adviseFromDiff(diff, defaultPatch(), { maxActions: 20 })
    expect(actions.map(a => a.paramIds.join('+'))).toEqual(['master.volume'])
  })

  it('never claims better than medium confidence on inharmonicity', () => {
    for (const unison of [1, 8]) {
      const diff = zeroDiff()
      diff.harmonics = {
        deltaDb: Array.from({ length: 12 }, () => 0),
        tiltDeltaDbPerOctave: 0,
        oddEvenDeltaDb: 0,
        inharmonicityDelta: 1.5e-3
      }
      const [action] = adviseFromDiff(diff, defaultPatch({ 'osc1.unison': unison }))
      expect(action.confidence).not.toBe('high')
      expect(action.paramIds).toContain('osc1.detune')
      expectLegalSuggestion(action)
    }
  })

  it('resolves choice parameters given as labels', () => {
    const diff = zeroDiff()
    diff.flatnessDelta = -0.25
    const patch = defaultPatch({ 'noise.type': 'Pink', 'noise.enabled': 1, 'noise.level': 0.2 })
    const [action] = adviseFromDiff(diff, patch)
    expect(action.suggested).toEqual({ id: 'noise.level', from: 0.2, to: 0.45, unit: 'raw' })
  })
})

describe('bypass switches', () => {
  /**
   * Which switch has to be ON for a parameter to reach the render at all.
   *
   * Read off the DSP, not guessed: `worklet/voice.ts` skips an oscillator, the
   * sub, the noise branch, a filter and the distortion section on
   * `base[enabled] < 0.5`, and `worklet/processor.ts` does the same for every
   * master effect. A `suggested` move on a parameter whose gate is off changes
   * the rendered audio by exactly nothing, so the next comparison measures the
   * same error and is handed the same move - forever.
   */
  const GATE_OF: Readonly<Record<string, string>> = {
    'osc1.transpose': 'osc1.enabled',
    'osc1.fine': 'osc1.enabled',
    'osc1.morph': 'osc1.enabled',
    'noise.level': 'noise.enabled',
    'noise.type': 'noise.enabled',
    'filter1.cutoff': 'filter1.enabled',
    'dist.drive': 'dist.enabled',
    'eq.high_gain': 'eq.enabled',
    'chorus.mix': 'chorus.enabled',
    'reverb.width': 'reverb.enabled',
    'comp.makeup': 'comp.enabled'
  }

  /**
   * `osc1.detune` and `osc1.spread` are gated too, just not by a switch:
   * `voice.ts` computes the per-voice offset as `unison === 1 ? 0 : ...` and
   * multiplies both by it, so on a single voice they are arithmetically zero.
   */
  function reachesTheRender(patch: PatchValues, id: string): boolean {
    if (id === 'osc1.detune' || id === 'osc1.spread') return Number(patch['osc1.unison']) > 1
    const gate = GATE_OF[id]
    return gate === undefined || Number(patch[gate]) >= 0.5
  }

  /** Everything switched off and every knob parked somewhere non-default. */
  const allBypassed = () =>
    defaultPatch({
      'noise.enabled': 0,
      'noise.level': 0.8,
      'eq.enabled': 0,
      'eq.high_gain': 12,
      'dist.enabled': 0,
      'dist.drive': 0.6,
      'filter1.enabled': 0,
      'chorus.enabled': 0,
      'reverb.enabled': 0,
      'comp.enabled': 0,
      'osc1.unison': 1
    })

  const everythingWrong = () => {
    const diff = zeroDiff()
    diff.pitch.centsError = 700
    diff.harmonics = {
      deltaDb: [0, -9, -7, -5, 0, 0, -6, -6, -6, -6, -6, -6],
      tiltDeltaDbPerOctave: -5,
      oddEvenDeltaDb: 6,
      inharmonicityDelta: 8e-4
    }
    diff.bands = BAND_CENTERS.map(centerHz => ({ centerHz, deltaDb: centerHz >= 4000 ? -7 : 0 }))
    diff.envelope = { attackMsDelta: 90, timeToPeakMsDelta: 90, decayT60MsDelta: -700, sustainDbDelta: -5 }
    diff.flatnessDelta = -0.25
    diff.stereoWidthDelta = -0.35
    diff.loudnessDbDelta = -6
    return diff
  }

  it('never suggests a parameter its own bypass switch is holding inert', () => {
    // The ordering is the whole point: an enable may appear in the same list,
    // but it has to come BEFORE the move it unblocks, because an agent applies
    // the list in order and a truncated list must still be coherent.
    for (const brightness of [[] as number[], [-0.9, -0.92, -0.9, -0.91], [0, -0.4, -0.9, -1.6]]) {
      const diff = everythingWrong()
      diff.brightness = withBrightness(brightness)
      const actions = adviseFromDiff(diff, allBypassed(), { maxActions: 50 })
      expect(actions.length).toBeGreaterThan(0)
      let state = allBypassed()
      for (const action of actions) {
        if (action.suggested) {
          expect(
            reachesTheRender(state, action.suggested.id),
            `${action.suggested.id} is inert in this patch: ${action.finding}`
          ).toBe(true)
        }
        state = applySuggestions(state, [action]).patch
      }
    }
  })

  it('makes every suggested move an actual change of state', () => {
    // A `suggested` that lands on the value already there renders identical
    // audio and earns the identical advice next round. That is the live-lock.
    for (const patch of [allBypassed(), defaultPatch(), defaultPatch({ 'osc1.unison': 7, 'noise.enabled': 1, 'eq.enabled': 1 })]) {
      for (const brightness of [[] as number[], [-0.9, -0.92, -0.9, -0.91], [0, -0.4, -0.9, -1.6]]) {
        const diff = everythingWrong()
        diff.brightness = withBrightness(brightness)
        const actions = adviseFromDiff(diff, patch, { maxActions: 50 })
        const withMoves = actions.filter(a => a.suggested)
        const { changed } = applySuggestions(patch, withMoves)
        expect(changed.length, `no-op moves in ${JSON.stringify(withMoves.map(a => a.suggested))}`).toBe(withMoves.length)
      }
    }
  })

  it('never reports a switch as off when it has never read the patch', () => {
    // `currentPatchValues` returns `{}` whenever the engine cannot be read, and
    // `?? 0` used to turn that silence into a confident "that section is off".
    const diff = everythingWrong()
    for (const brightness of [[] as number[], [-0.9, -0.92, -0.9, -0.91], [0, -0.4, -0.9, -1.6]]) {
      diff.brightness = withBrightness(brightness)
      for (const action of adviseFromDiff(diff, {}, { maxActions: 50 })) {
        expect(action.finding, action.finding).not.toMatch(/\bis (?:off|bypassed)\b|\bis 0\)|\bis not in unison\b/i)
      }
    }
  })

  it('keeps every narrowed paramIds a subset of its own rule', () => {
    const diffs = [everythingWrong(), zeroDiff()]
    diffs[0].brightness = withBrightness([])
    const patches = [allBypassed(), defaultPatch(), {}, defaultPatch({ 'osc1.unison': 7, 'osc1.detune': 40 })]
    for (const rule of ADVICE_RULES) {
      for (const diff of diffs) {
        for (const patch of patches) {
          const outcome = rule.evaluate({ diff, patch })
          if (!outcome) continue
          for (const one of Array.isArray(outcome) ? outcome : [outcome]) {
            for (const id of one.paramIds ?? []) {
              expect(rule.paramIds, `${rule.id} narrowed to a param it does not declare`).toContain(id)
            }
          }
        }
      }
    }
  })
})

describe('gated convergence', () => {
  /**
   * One matching loop over a gated parameter: ask, apply, re-measure, ask again.
   *
   * `render` carries the ONE fact about the DSP these tests are entitled to
   * assume, and it is the fact `voice.ts` and `processor.ts` actually guarantee:
   * while the section is bypassed the parameter contributes NOTHING. What it
   * contributes once engaged is the rule's own declared mapping, so a loop that
   * terminates here proves the LOOP terminates - it does not prove the mapping
   * is calibrated, and nothing in this file could.
   *
   * `noop` is the failure these rules were shipped with: a round in which every
   * suggested move left the patch exactly where it was.
   */
  function loop(
    startError: number,
    patch: PatchValues,
    setError: (diff: MatchDiff, error: number) => void,
    render: (patch: PatchValues) => number,
    rounds = 8
  ): { errors: number[]; noop: boolean } {
    let state: PatchValues = patch
    // Back-solved so the opening render really does read `startError`.
    const reference = render(state) - startError
    const errors = [startError]
    let noop = false
    for (let i = 0; i < rounds; i++) {
      const diff = zeroDiff()
      setError(diff, errors[errors.length - 1])
      const actions = adviseFromDiff(diff, state, { maxActions: 20 }).filter(a => a.suggested)
      if (actions.length === 0) break
      const applied = applySuggestions(state, actions)
      if (applied.changed.length === 0) {
        noop = true
        break
      }
      state = applied.patch
      errors.push(Number((render(state) - reference).toFixed(9)))
    }
    return { errors, noop }
  }

  function expectSettles(result: { errors: number[]; noop: boolean }, silence: number, label: string): void {
    expect(result.noop, `${label} proposed a move that changed nothing`).toBe(false)
    const last = result.errors[result.errors.length - 1]
    expect(Math.abs(last), `${label} never settled: ${result.errors.join(' -> ')}`).toBeLessThan(silence)
    for (let i = 1; i < result.errors.length; i++) {
      expect(
        Math.abs(result.errors[i]),
        `${label} did not shrink at step ${i}: ${result.errors.join(' -> ')}`
      ).toBeLessThan(Math.abs(result.errors[i - 1]))
    }
  }

  it('turns noise.enabled on and lands the flatness in one round', () => {
    const setError = (diff: MatchDiff, e: number) => { diff.flatnessDelta = e }
    // Bypassed, so `noise.level` put nothing in the buffer whatever it reads.
    const render = (p: PatchValues) => (Number(p['noise.enabled']) >= 0.5 ? Number(p['noise.level']) : 0)
    for (const level of [0, 0.2, 0.5, 0.9]) {
      for (const start of [-0.1, -0.25, -0.6]) {
        const patch = defaultPatch({ 'noise.enabled': 0, 'noise.level': level })
        const result = loop(start, patch, setError, render)
        expectSettles(result, 0.05, `noise level=${level} start=${start}`)
        expect(result.errors.length, `noise level=${level} start=${start}`).toBe(2)
      }
    }
  })

  it('flips noise.enabled from 0 to 1 rather than nudging an inert level', () => {
    const diff = zeroDiff()
    diff.flatnessDelta = -0.25
    const patch = defaultPatch({ 'noise.enabled': 0, 'noise.level': 0.5 })
    const actions = adviseFromDiff(diff, patch)
    expect(actions.map(a => a.suggested)).toEqual([
      { id: 'noise.enabled', from: 0, to: 1, unit: 'raw' },
      // From an effective ZERO, not 0.5 + 0.25: the bypassed generator
      // contributed none of the level it was showing.
      { id: 'noise.level', from: 0.5, to: 0.25, unit: 'raw' }
    ])
    const { changed } = applySuggestions(patch, actions)
    expect(changed).toEqual(['noise.enabled', 'noise.level'])
    expect(actions[0].estimatedGain).toBe(actions[1].estimatedGain)
  })

  it('does not offer to cut a noise.level that is already switched out', () => {
    const diff = zeroDiff()
    diff.flatnessDelta = 0.3
    const [action] = adviseFromDiff(diff, defaultPatch({ 'noise.enabled': 0, 'noise.level': 0.7 }))
    expect(action.suggested).toBeUndefined()
    expect(action.finding).toContain('inert')
    expect(action.finding).toContain('filter1.resonance')
  })

  it('turns eq.enabled on and lands the upper bands in one round', () => {
    const setError = (diff: MatchDiff, e: number) => {
      // The fallback rule only owns this territory with no per-window brightness.
      diff.brightness = []
      diff.bands = BAND_CENTERS.map(centerHz => ({ centerHz, deltaDb: centerHz >= 4000 ? e : 0 }))
    }
    const render = (p: PatchValues) => (Number(p['eq.enabled']) >= 0.5 ? Number(p['eq.high_gain']) : 0)
    for (const gain of [-12, 0, 9]) {
      for (const start of [-8, -4, 5]) {
        const patch = defaultPatch({ 'eq.enabled': 0, 'eq.high_gain': gain })
        const result = loop(start, patch, setError, render)
        expectSettles(result, 3, `eq gain=${gain} start=${start}`)
        expect(result.errors.length, `eq gain=${gain} start=${start}`).toBe(2)
      }
    }
  })

  it('puts the eq.enabled flip ahead of the eq.high_gain move', () => {
    const diff = zeroDiff()
    diff.brightness = []
    diff.bands = BAND_CENTERS.map(centerHz => ({ centerHz, deltaDb: centerHz >= 4000 ? -8 : 0 }))
    const patch = defaultPatch({ 'eq.enabled': 0, 'eq.high_gain': 5 })
    const actions = adviseFromDiff(diff, patch)
    expect(actions.map(a => a.suggested)).toEqual([
      { id: 'eq.enabled', from: 0, to: 1, unit: 'raw' },
      { id: 'eq.high_gain', from: 5, to: 8, unit: 'dB' }
    ])
    expect(applySuggestions(patch, actions).changed).toEqual(['eq.enabled', 'eq.high_gain'])
    expect(actions[0].finding).toContain('bypassed')
  })

  it('raises osc1.unison before it moves a spread a single voice zeroes out', () => {
    const setError = (diff: MatchDiff, e: number) => { diff.stereoWidthDelta = e }
    const render = (p: PatchValues) => (Number(p['osc1.unison']) > 1 ? Number(p['osc1.spread']) : 0)
    for (const spread of [0, 0.6, 1]) {
      for (const start of [-0.1, -0.4]) {
        const patch = defaultPatch({ 'osc1.unison': 1, 'osc1.spread': spread })
        const result = loop(start, patch, setError, render)
        expectSettles(result, 0.05, `width spread=${spread} start=${start}`)
        expect(result.errors.length, `width spread=${spread} start=${start}`).toBe(2)
      }
    }
    const diff = zeroDiff()
    diff.stereoWidthDelta = -0.3
    const patch = defaultPatch({ 'osc1.unison': 1 })
    const actions = adviseFromDiff(diff, patch)
    expect(actions.map(a => a.suggested?.id)).toEqual(['osc1.unison', 'osc1.spread'])
    expect(actions[0].suggested!.to).toBeGreaterThan(1)
    expect(applySuggestions(patch, actions).changed).toEqual(['osc1.unison', 'osc1.spread'])
  })

  it('does not offer to narrow a spread that is already multiplied by zero', () => {
    const diff = zeroDiff()
    diff.stereoWidthDelta = 0.3
    const [action] = adviseFromDiff(diff, defaultPatch({ 'osc1.unison': 1, 'osc1.spread': 0.9 }))
    expect(action.suggested).toBeUndefined()
    expect(action.finding).toContain('already inert')
    expect(action.paramIds).toContain('chorus.mix')
  })

  it('engages the distortion before it moves dist.drive, and lands the tilt', () => {
    const setError = (diff: MatchDiff, e: number) => {
      diff.harmonics = { deltaDb: Array.from({ length: 12 }, () => 0), tiltDeltaDbPerOctave: e, oddEvenDeltaDb: 0, inharmonicityDelta: 0 }
    }
    // The rule's own declared 0.05-of-drive-per-dB/octave mapping, and zero
    // while the section is bypassed.
    const render = (p: PatchValues) => (Number(p['dist.enabled']) >= 0.5 ? Number(p['dist.drive']) / 0.05 : 0)
    for (const drive of [0, 0.3, 0.8]) {
      for (const start of [-2, -5]) {
        const patch = defaultPatch({ 'dist.enabled': 0, 'dist.drive': drive })
        const result = loop(start, patch, setError, render)
        expectSettles(result, 1.5, `tilt drive=${drive} start=${start}`)
        expect(result.errors.length, `tilt drive=${drive} start=${start}`).toBe(2)
      }
    }
  })

  it('does not offer to cut a dist.drive the bypass already removed', () => {
    const diff = zeroDiff()
    diff.harmonics = { deltaDb: Array.from({ length: 12 }, () => 0), tiltDeltaDbPerOctave: 5, oddEvenDeltaDb: 0, inharmonicityDelta: 0 }
    const [action] = adviseFromDiff(diff, defaultPatch({ 'dist.enabled': 0, 'dist.drive': 0.8 }))
    expect(action.suggested).toBeUndefined()
    expect(action.finding).toContain('inert')
    expect(action.paramIds).toEqual(['osc1.morph', 'osc1.wavetable'])
  })

  it('does not move a dist.drive whose own dist.type never reads it', () => {
    // The same defect one level below the bypass switch. `voice.ts` branches on
    // `dist.type` FIRST, and its bitcrush branch reads `dist.bits`,
    // `dist.downsample` and `dist.mix` only - the `gain`/`comp` pair it computes
    // from the drive belongs to the clip/wavefold branch and is never applied.
    // So under Bitcrush a drive move is the guaranteed no-op in BOTH directions,
    // and engaging the section does not rescue it.
    const tiltDiff = (tilt: number) => {
      const diff = zeroDiff()
      diff.harmonics = { deltaDb: Array.from({ length: 12 }, () => 0), tiltDeltaDbPerOctave: tilt, oddEvenDeltaDb: 0, inharmonicityDelta: 0 }
      return diff
    }
    for (const tilt of [-5, 5]) {
      for (const enabled of [0, 1]) {
        const patch = defaultPatch({ 'dist.enabled': enabled, 'dist.type': 'Bitcrush', 'dist.drive': 0.4 })
        const [action] = adviseFromDiff(tiltDiff(tilt), patch, { maxActions: 50 })
        const label = `tilt=${tilt} enabled=${enabled}`
        expect(action.finding, label).toContain('Spectral tilt')
        expect(action.suggested, label).toBeUndefined()
        expect(action.finding, label).toContain('dist.bits')
        expect(action.paramIds, label).toEqual(['osc1.morph', 'osc1.wavetable'])
      }
    }
    // A dist.type whose branch does read the drive keeps the ordinary move.
    const live = defaultPatch({ 'dist.enabled': 1, 'dist.type': 'Wavefold', 'dist.drive': 0.4 })
    expect(adviseFromDiff(tiltDiff(-5), live)[0].suggested?.id).toBe('dist.drive')
  })

  it('engages a bypassed filter1 only when engaging it can deliver the correction', () => {
    const tooBright = zeroDiff()
    tooBright.brightness = withBrightness([0.9, 0.92, 0.9, 0.91])
    const patch = defaultPatch({ 'filter1.enabled': 0 })
    const up = adviseFromDiff(tooBright, patch).filter(a => a.paramIds.includes('filter1.cutoff'))
    expect(up.map(a => a.suggested?.id)).toEqual(['filter1.enabled', 'filter1.cutoff'])
    expect(applySuggestions(patch, up).changed).toEqual(['filter1.enabled', 'filter1.cutoff'])

    // A lowpass cannot add high content that is not there, so engaging it is
    // the wrong answer and the cutoff move is inert. Say so, move nothing.
    const tooDark = zeroDiff()
    tooDark.brightness = withBrightness([-0.9, -0.92, -0.9, -0.91])
    const [dark] = adviseFromDiff(tooDark, patch).filter(a => a.paramIds.includes('filter1.cutoff'))
    expect(dark.suggested).toBeUndefined()
    expect(dark.finding).toContain('cannot add high content')
    expect(dark.confidence).toBe('low')

    // A bypassed HIGHPASS is different: engaging it raises the centroid by
    // taking lows away, so there the enable really is the correction.
    const hp = defaultPatch({ 'filter1.enabled': 0, 'filter1.type': 'HP 24' })
    const lifted = adviseFromDiff(tooDark, hp).filter(a => a.paramIds.includes('filter1.cutoff'))
    expect(lifted.map(a => a.suggested?.id)).toEqual(['filter1.enabled', 'filter1.cutoff'])
  })

  it('stops steering osc1 tuning when osc1 is not making the sound', () => {
    const silenced: Record<string, number | string>[] = [{ 'osc1.enabled': 0 }, { 'osc1.level': 0 }]
    for (const overrides of silenced) {
      const diff = zeroDiff()
      diff.pitch.centsError = 700
      const actions = adviseFromDiff(diff, defaultPatch(overrides))
      expect(actions).toHaveLength(1)
      expect(actions[0].suggested, JSON.stringify(overrides)).toBeUndefined()
      expect(actions[0].finding).toContain('change nothing')
      expect(actions[0].finding).toContain('sub.octave')
      expect(actions[0].confidence).toBe('low')
    }
    // And it is still the ordinary exact correction when osc1 is audible.
    const diff = zeroDiff()
    diff.pitch.centsError = 700
    expect(adviseFromDiff(diff, defaultPatch())[0].suggested?.id).toBe('osc1.transpose')
  })
})

describe('engaging a bypassed filter1', () => {
  /**
   * The whole cross-product of {too bright, too dark} x {every filter type},
   * as a table, because the property being tested is CONDITIONAL and a
   * conditional property read one case at a time is how the bug got in: the
   * guard asked "is it too bright?" OR "is it a highpass?" and every too-bright
   * candidate passed, bypassed highpass included. Engaging a highpass removes
   * lows and drives the centroid UP, so that enable steered a too-bright patch
   * further from the reference.
   *
   * `enable` is whether the rule should offer to switch filter1 on. It is `true`
   * on exactly the cells where engaging that type moves the centroid the way
   * that error needs it moved:
   *
   *   too bright (centroid must come DOWN)  ->  lowpass only
   *   too dark   (centroid must go UP)      ->  highpass only
   *
   * Everything else is a REFUSAL, and each refusal is a decision with a reason,
   * not an unhandled case:
   *
   * - Bandpass removes energy on both sides of its cutoff, so it drags the
   *   centroid TOWARDS the cutoff - up from below, down from above. Notch
   *   removes a band around the cutoff and splits the same way. Answering
   *   either needs the candidate's ABSOLUTE centroid, and `MatchDiff.brightness`
   *   carries `octaveDelta`, an error against the reference, and nothing else.
   *   Not "unclassified pending more work": the fact needed to classify it is
   *   not in the contract this module reads.
   * - The comb in `worklet/dsp.ts` is `y = x + damped_delay * fb`, which ADDS a
   *   resonant series rather than only attenuating, and its peaks track the
   *   cutoff. The formant bank swaps the spectrum for three vowel resonances
   *   placed by the cutoff. Neither has a direction that holds for every cutoff.
   */
  const FILTER_TYPE_EXPECTATIONS: ReadonlyArray<{ type: string; tooBright: boolean; tooDark: boolean }> = [
    { type: 'LP 12', tooBright: true, tooDark: false },
    { type: 'LP 24', tooBright: true, tooDark: false },
    { type: 'HP 12', tooBright: false, tooDark: true },
    { type: 'HP 24', tooBright: false, tooDark: true },
    { type: 'BP 12', tooBright: false, tooDark: false },
    { type: 'BP 24', tooBright: false, tooDark: false },
    { type: 'Notch', tooBright: false, tooDark: false },
    { type: 'Comb', tooBright: false, tooDark: false },
    { type: 'Formant', tooBright: false, tooDark: false }
  ]

  /** Every action `filter-cutoff-static` produced: it is the only rule declaring `filter1.enabled`. */
  function staticCutoffActions(dark: boolean, patch: PatchValues): MatchAction[] {
    const diff = zeroDiff()
    const d = dark ? -0.9 : 0.9
    // Flat across the windows, so this is the static-cutoff rule's territory and
    // the trend rule stays under its own silence threshold.
    diff.brightness = withBrightness([d, d + 0.02, d, d + 0.01])
    return adviseFromDiff(diff, patch, { maxActions: 50 }).filter(a => a.paramIds.includes('filter1.enabled'))
  }

  it('answers the four cases that decide the guard', () => {
    // The whole conditional, in four rows, asserting nothing but whether the
    // enable is offered. Row 2 is the regression: the guard used to read
    // `tooBright || isHighpass`, so every too-bright candidate passed on the
    // first term alone and a bypassed HIGHPASS got offered the switch -
    // engaging it removes lows, lifts the centroid, and makes the measured
    // error larger.
    const CASES = [
      { type: 'LP 24', dark: false, enable: true },  // engaging darkens: correct
      { type: 'HP 24', dark: false, enable: false }, // engaging brightens: the bug
      { type: 'HP 24', dark: true, enable: true },
      { type: 'LP 24', dark: true, enable: false }   // already correct; keep it correct
    ]
    for (const { type, dark, enable } of CASES) {
      const patch = defaultPatch({ 'filter1.enabled': 0, 'filter1.type': type })
      const actions = staticCutoffActions(dark, patch)
      const offered = actions.some(a => a.suggested?.id === 'filter1.enabled')
      expect(offered, `${type}, too ${dark ? 'dark' : 'bright'}`).toBe(enable)
    }
  })

  it('covers every filter type params.ts declares', () => {
    // Pins the table to the registry: a tenth filter type fails HERE, loudly,
    // rather than falling into whichever branch happens to catch it.
    expect(FILTER_TYPE_EXPECTATIONS.map(e => e.type)).toEqual(PARAM_BY_ID.get('filter1.type')!.choices)
  })

  it('offers the enable only where engaging that type moves the centroid the right way', () => {
    for (const { type, tooBright, tooDark } of FILTER_TYPE_EXPECTATIONS) {
      for (const [dark, shouldEnable] of [[true, tooDark], [false, tooBright]] as const) {
        const patch = defaultPatch({ 'filter1.enabled': 0, 'filter1.type': type })
        const actions = staticCutoffActions(dark, patch)
        const label = `${type}, too ${dark ? 'dark' : 'bright'}, bypassed`

        if (shouldEnable) {
          expect(actions.map(a => a.suggested?.id), label).toEqual(['filter1.enabled', 'filter1.cutoff'])
          // Both halves have to be real moves, or the pair is the live-lock.
          expect(applySuggestions(patch, actions).changed, label).toEqual(['filter1.enabled', 'filter1.cutoff'])
          // And the cutoff goes the way the error asks: down for a bright
          // candidate, up for a dark one.
          const cutoff = actions[1].suggested!
          expect(dark ? cutoff.to > cutoff.from : cutoff.to < cutoff.from, label).toBe(true)
          continue
        }

        // Refusal: ONE finding, no move at all - not an enable, and not the
        // cutoff move the enable would have unblocked.
        expect(actions, label).toHaveLength(1)
        expect(actions[0].suggested, label).toBeUndefined()
        expect(actions[0].finding, label).toContain(type)
        expect(actions[0].confidence, label).toBe('low')
        expect(actions[0].direction, label).toBe(dark ? 'increase' : 'decrease')
      }
    }
  })

  it('leaves an already-engaged filter1 alone, whichever type it is', () => {
    // The guard governs ENGAGING a bypassed filter. With the filter in circuit
    // the cutoff move is live for every type, and there is no switch to flip.
    for (const { type } of FILTER_TYPE_EXPECTATIONS) {
      for (const dark of [true, false]) {
        const patch = defaultPatch({ 'filter1.enabled': 1, 'filter1.type': type })
        const actions = staticCutoffActions(dark, patch)
        const label = `${type}, too ${dark ? 'dark' : 'bright'}, engaged`
        expect(actions.map(a => a.suggested?.id), label).toEqual(['filter1.cutoff'])
        expect(applySuggestions(patch, actions).changed, label).toEqual(['filter1.cutoff'])
      }
    }
  })

  it('names the type and the reason it cannot deliver the correction', () => {
    // The bug case, in prose: a bypassed highpass under a too-bright candidate.
    const [bright] = staticCutoffActions(false, defaultPatch({ 'filter1.enabled': 0, 'filter1.type': 'HP 24' }))
    expect(bright.finding).toContain('HP 24')
    expect(bright.finding).toMatch(/takes lows away/i)
    expect(bright.finding).toMatch(/push the centroid UP/i)

    // The mirror, which has always been right and stays right.
    const [dark] = staticCutoffActions(true, defaultPatch({ 'filter1.enabled': 0, 'filter1.type': 'LP 24' }))
    expect(dark.finding).toContain('cannot add high content')

    // A type whose direction is a function of the cutoff says exactly that,
    // rather than picking a side.
    for (const type of ['BP 24', 'Notch', 'Comb', 'Formant']) {
      for (const isDark of [true, false]) {
        const [action] = staticCutoffActions(isDark, defaultPatch({ 'filter1.enabled': 0, 'filter1.type': type }))
        expect(action.finding, `${type} too ${isDark ? 'dark' : 'bright'}`).toMatch(/not knowable from here/i)
      }
    }
  })

  it('withholds the enable when the patch does not carry filter1.type', () => {
    // Same tri-state discipline as `switchState`: "I could not read that choice"
    // is not a filter type, and it is certainly not a direction.
    const patch: Record<string, number | string> = { ...defaultPatch({ 'filter1.enabled': 0 }) }
    delete patch['filter1.type']
    for (const dark of [true, false]) {
      const actions = staticCutoffActions(dark, patch)
      expect(actions).toHaveLength(1)
      expect(actions[0].suggested).toBeUndefined()
      expect(actions[0].finding).toMatch(/filter1\.type is not readable/i)
    }
  })
})

describe('probe steps', () => {
  /** The multiplicative factor a rule asked for, read back off its own move. */
  function factorOf(action: MatchAction | undefined): number {
    expect(action?.suggested, 'no suggested move to read a factor from').toBeDefined()
    const { from, to } = action!.suggested!
    return to > from ? to / from : from / to
  }

  function envAction(trend: number, patch: PatchValues = defaultPatch()) {
    const diff = zeroDiff()
    // A drift across the buffer, which is what this rule reads: first window at
    // 0, last at `trend`.
    diff.brightness = withBrightness([0, trend / 3, (2 * trend) / 3, trend])
    return adviseFromDiff(diff, patch).find(a => a.suggested?.id === 'env2.decay')
  }

  function detuneAction(delta: number, patch: PatchValues = defaultPatch({ 'osc1.unison': 7, 'osc1.detune': 12 })) {
    const diff = zeroDiff()
    diff.harmonics = {
      deltaDb: Array.from({ length: 12 }, () => 0),
      tiltDeltaDbPerOctave: 0,
      oddEvenDeltaDb: 0,
      inharmonicityDelta: delta
    }
    return adviseFromDiff(diff, patch).find(a => a.suggested?.id === 'osc1.detune')
  }

  /**
   * The env2 -> filter1.cutoff route has no `PARAMS` id and is absent from
   * `PatchValues` entirely, so how `env2.decay` moves a brightness trajectory
   * cannot be simulated here without inventing the mod depth, the envelope curve
   * and the filter slope. These tests therefore assert the properties that ARE
   * checkable - the step shrinks with the error, it never claims to be a fit -
   * and deliberately assert nothing about where the measurement lands.
   */
  it('shrinks the env2.decay probe as the brightness drift shrinks', () => {
    const trends = [-0.35, -0.5, -0.8, -1.2, -1.6, -2, -3]
    const factors = trends.map(t => factorOf(envAction(t)))
    for (let i = 1; i < factors.length; i++) {
      expect(factors[i], `trend ${trends[i]}`).toBeGreaterThanOrEqual(factors[i - 1])
    }
    // Strictly smaller below saturation, and never larger than the fixed step
    // it replaces: the old 1.5x is now the step at MAXIMUM error, not at every
    // error.
    expect(factors[0]).toBeLessThan(factors[factors.length - 1])
    expect(Math.max(...factors)).toBeCloseTo(1.5, 6)
    expect(factorOf(envAction(-0.35))).toBeLessThan(1.1)
    // Saturated at and beyond the rule's own scale, same point estimatedGain caps.
    expect(factorOf(envAction(-2))).toBeCloseTo(factorOf(envAction(-3)), 6)
  })

  it('shrinks the osc1.detune probe as the inharmonicity shrinks', () => {
    const deltas = [1.5e-4, 4e-4, 8e-4, 1.5e-3, 2e-3, 5e-3]
    const factors = deltas.map(d => factorOf(detuneAction(d)))
    for (let i = 1; i < factors.length; i++) {
      expect(factors[i], `delta ${deltas[i]}`).toBeGreaterThanOrEqual(factors[i - 1])
    }
    expect(factors[0]).toBeLessThan(1.1)
    // The old fixed 0.5x/2x pair survives only as the step at maximum error.
    expect(Math.max(...factors)).toBeCloseTo(2, 6)
    expect(factorOf(detuneAction(2e-3))).toBeCloseTo(factorOf(detuneAction(5e-3)), 6)
  })

  it('cannot compose a shrink and a grow back to where it started', () => {
    // The exact failure the fixed step had: 0.5x then 2x is the IDENTITY, so
    // `12 -> 6 -> 12 -> 6` is a period-2 cycle no number of iterations escapes,
    // whatever the parameter actually does to the measurement. Sizing the step
    // from the error breaks the cycle for any two errors of different size -
    // which is what an overshoot produces, since going past a target by less
    // than you were short of it is a smaller error.
    const start = 12
    const down = detuneAction(2e-3, defaultPatch({ 'osc1.unison': 7, 'osc1.detune': start }))
    const overshot = down!.suggested!.to
    expect(overshot).toBeLessThan(start)
    const back = detuneAction(-1e-3, defaultPatch({ 'osc1.unison': 7, 'osc1.detune': overshot }))
    expect(back!.suggested!.to).not.toBeCloseTo(start, 6)
    expect(back!.suggested!.to).toBeLessThan(start)
    // Same shape for the envelope probe.
    const shrunk = envAction(-2, defaultPatch({ 'env2.decay': 0.5 }))!.suggested!.to
    const regrown = envAction(1, defaultPatch({ 'env2.decay': shrunk }))!.suggested!.to
    expect(regrown).not.toBeCloseTo(0.5, 6)
  })

  it('calls a probe a probe and never claims high confidence for one', () => {
    const env = envAction(-1.2)!
    expect(env.confidence).toBe('low')
    expect(env.finding).toContain('PROBE')
    // The real fix has no parameter id, so the finding has to carry it in prose
    // AND say that the parameter it does suggest is inert without that route.
    expect(env.finding).toContain('set_modulation')
    expect(env.finding).toContain('env2 -> filter1.cutoff')
    expect(env.finding).toMatch(/no parameter id/i)
    expect(env.finding).toMatch(/inert/i)

    const detune = detuneAction(1.5e-3)!
    expect(detune.confidence).not.toBe('high')
    expect(detune.finding).toContain('PROBE')
  })
})

describe('findings that outrun their own move', () => {
  it('quotes how many dB master.volume leaves on the table when it clamps', () => {
    const diff = zeroDiff()
    diff.loudnessDbDelta = -24
    const [action] = adviseFromDiff(diff, defaultPatch({ 'master.volume': 1.0 }))
    expect(action.suggested!.to).toBe(1.5)
    expect(action.finding).toContain('cannot travel that far')
    // 20*log10(15.85/1.5) — the part the move does NOT apply, named.
    expect(action.finding).toContain('20.5 dB short')
    expect(action.finding).toContain('comp.enabled')
  })

  it('says nothing about a shortfall when master.volume can cover the gap', () => {
    const diff = zeroDiff()
    diff.loudnessDbDelta = -6
    const [action] = adviseFromDiff(diff, defaultPatch({ 'master.volume': 0.5 }))
    expect(action.finding).not.toContain('short')
    expect(action.finding).not.toContain('cannot travel')
  })

  it('admits that a sustain ratio has no purchase on zero', () => {
    const diff = zeroDiff()
    diff.envelope.sustainDbDelta = -9
    const [action] = adviseFromDiff(diff, defaultPatch({ 'env1.sustain': 0 }))
    // `0 * 10 ** x` is 0, so there is no move to make and the finding used to
    // describe one anyway.
    expect(action.suggested).toBeUndefined()
    expect(action.finding).toContain('RATIO')
    expect(action.finding).toContain('cannot lift a level off zero')
    // Still an ordinary scaling whenever there is something to scale.
    const gentle = zeroDiff()
    gentle.envelope.sustainDbDelta = -6
    const ok = adviseFromDiff(gentle, defaultPatch({ 'env1.sustain': 0.4 }))[0]
    expect(ok.suggested!.to).toBeCloseTo(0.4 * 10 ** (6 / 20), 4)
    expect(ok.finding).not.toContain('RATIO')
    expect(ok.finding).not.toContain('cannot travel')
  })

  it('names the decay when env1.sustain runs out of headroom', () => {
    // 0.4 x 10^(9/20) is 1.13, past the 0..1 range: the move clamps to 1 and
    // the finding used to describe the whole 9 dB regardless.
    const diff = zeroDiff()
    diff.envelope.sustainDbDelta = -9
    const [action] = adviseFromDiff(diff, defaultPatch({ 'env1.sustain': 0.4 }))
    expect(action.suggested!.to).toBe(1)
    expect(action.finding).toContain('cannot travel that far')
    expect(action.finding).toContain('env1.decay')
  })
})

describe('the env2 -> filter1.cutoff route', () => {
  /**
   * The reviewer's top finding: the top action asked for `env2.decay` while the
   * patch carried no `env2 -> filter1.cutoff` route, so the move could not reach
   * the sound at all. The finding hedged about it in prose - "if the route does
   * not exist then env2.decay is inert" - because the rule could not see the
   * matrix. It can now, and the three states have to stay three.
   */
  const darkensTooFast = () => {
    const diff = zeroDiff()
    diff.brightness = withBrightness([0.05, -0.3, -0.85, -1.5])
    return diff
  }
  const holdsTooLong = () => {
    const diff = zeroDiff()
    diff.brightness = withBrightness([-1.5, -0.85, -0.3, 0.05])
    return diff
  }
  const routed = (depth: number, extra: Record<string, unknown> = {}) => [
    { source: 'env2', destination: 'filter1.cutoff', depth, ...extra }
  ]
  const envAction = (diff: MatchDiff, options: Parameters<typeof adviseFromDiff>[2] = {}) =>
    adviseFromDiff(diff, defaultPatch(), { maxActions: 20, ...options })
      .find(a => a.paramIds.includes('env2.decay'))

  it('recommends set_modulation instead of an inert env2.decay when the route is absent', () => {
    const action = envAction(darkensTooFast(), { mods: [] })!
    expect(action).toBeDefined()
    // The whole defect: no move at all, because there is nothing for a move to
    // reach. A finding with no `suggested` is legitimate; a `suggested` that
    // changes nothing is the live-lock.
    expect(action.suggested).toBeUndefined()
    expect(action.finding).toContain('set_modulation source=env2 destination=filter1.cutoff depth=')
    expect(action.finding).toContain('INERT')
    // And nothing else in the list quietly moves env2 either.
    const all = adviseFromDiff(darkensTooFast(), defaultPatch(), { maxActions: 20, mods: [] })
    expect(all.some(a => a.suggested?.id.startsWith('env2.'))).toBe(false)
  })

  /** The depth the finding tells an agent to create, read back out of its prose. */
  function recommendedDepth(finding: string): number {
    const m = /depth=(-?[\d.]+)/.exec(finding)
    expect(m, `no depth in: ${finding}`).not.toBeNull()
    return Number(m![1])
  }

  it('signs the recommended depth from the trend rather than assuming the usual wiring', () => {
    // env2 only ever FALLS, so a candidate that has to brighten across the note
    // needs a NEGATIVE depth. Assuming the usual positive wiring here would hand
    // back a route that makes the error worse.
    const brighten = recommendedDepth(envAction(darkensTooFast(), { mods: [] })!.finding)
    expect(brighten).toBeLessThan(0)
    expect(brighten).toBeGreaterThanOrEqual(-1)
    const darken = recommendedDepth(envAction(holdsTooLong(), { mods: [] })!.finding)
    expect(darken).toBeGreaterThan(0)
    expect(darken).toBeLessThanOrEqual(1)
  })

  it('reads a disabled or negligible route as no route', () => {
    for (const mods of [routed(0.45, { enabled: false }), routed(0.001), routed(-0.001)]) {
      const action = envAction(darkensTooFast(), { mods })!
      expect(action.suggested, JSON.stringify(mods)).toBeUndefined()
      expect(action.finding).toContain('set_modulation')
    }
  })

  it('behaves as it always did on a routed patch with positive depth', () => {
    const withRoute = envAction(darkensTooFast(), { mods: routed(0.45) })!
    const noMatrix = envAction(darkensTooFast())!
    expect(withRoute.suggested?.id).toBe('env2.decay')
    // Same probe, same landing: reading a positive route confirms the wiring the
    // unread case had to assume.
    expect(withRoute.suggested!.to).toBe(noMatrix.suggested!.to)
    expect(withRoute.suggested!.to).toBeGreaterThan(withRoute.suggested!.from)
    expect(withRoute.direction).toBe('increase')
  })

  it('inverts the recommendation on a negative route instead of lengthening the wrong stage', () => {
    const positive = envAction(darkensTooFast(), { mods: routed(0.45) })!
    const negative = envAction(darkensTooFast(), { mods: routed(-0.45) })!
    // With the cutoff running against env2 the sweep is dark-to-bright, so the
    // very same error wants the decay SHORTENED.
    expect(negative.suggested!.to).toBeLessThan(negative.suggested!.from)
    expect(negative.direction).toBe('decrease')
    expect(positive.direction).toBe('increase')
    expect(negative.finding).toContain('NEGATIVE')
    expect(negative.finding).toContain('SHORTEN env2.decay')
    expect(negative.finding).not.toContain('LENGTHEN env2.decay')
    // Mirror case: the other error direction flips with it.
    const heldNegative = envAction(holdsTooLong(), { mods: routed(-0.45) })!
    expect(heldNegative.suggested!.to).toBeGreaterThan(heldNegative.suggested!.from)
  })

  it('never reports a route as missing when no matrix was passed', () => {
    // Same tri-state discipline as the bypass switches: "I have not looked" is
    // not "there is none".
    for (const diff of [darkensTooFast(), holdsTooLong()]) {
      const action = envAction(diff)!
      expect(action.finding).not.toMatch(/carries no env2 -> filter1\.cutoff route|is switched OFF/)
      expect(action.finding).toContain('PROBE')
      expect(action.suggested?.id).toBe('env2.decay')
      expect(action.confidence).toBe('low')
    }
  })

  it('reads the polarity rather than the source name, so an unrelated route is not one', () => {
    const wrongDest = envAction(darkensTooFast(), { mods: [{ source: 'env2', destination: 'osc1.morph', depth: 0.5 }] })!
    const wrongSource = envAction(darkensTooFast(), { mods: [{ source: 'lfo1', destination: 'filter1.cutoff', depth: 0.5 }] })!
    for (const action of [wrongDest, wrongSource]) {
      expect(action.suggested).toBeUndefined()
      expect(action.finding).toContain('set_modulation')
    }
  })
})

/**
 * Eval run 4, first finding. The `env2 -> filter1.cutoff` route was offered five
 * times and declined four; followed as written it dropped the score 0.747 ->
 * 0.655, and the SAME mechanism shaped as hold-then-decay took brightness 0.571
 * -> 0.702 and the score to 0.783. Right mechanism, wrong contour - and
 * `last - first` is exactly the reading that cannot tell the two contours apart.
 */
describe("a trajectory's shape picks the env2 stage", () => {
  /** Steady offset through the first three windows, then the whole drift. */
  const fallsLate = () => {
    const diff = zeroDiff()
    diff.brightness = withBrightness([-0.02, 0, -0.03, -0.8, -1.6])
    return diff
  }
  /** The same total drift, spread evenly from the first window. */
  const fallsThroughout = () => {
    const diff = zeroDiff()
    diff.brightness = withBrightness([-0.05, -0.45, -0.85, -1.2, -1.6])
    return diff
  }
  const routed = (depth: number) => [{ source: 'env2', destination: 'filter1.cutoff', depth }]
  const envOf = (diff: MatchDiff, patch: PatchValues = defaultPatch(), options = {}) =>
    adviseFromDiff(diff, patch, { maxActions: 20, ...options }).find(a => a.suggested?.id.startsWith('env2.'))

  it('prescribes hold for a drift that starts late and decay for one that starts at note-on', () => {
    const late = envOf(fallsLate())!
    const throughout = envOf(fallsThroughout())!
    expect(late.suggested!.id).toBe('env2.hold')
    expect(throughout.suggested!.id).toBe('env2.decay')
    // The two shapes carry the same total drift, so the old first-vs-last read
    // is identical for both: only the shape separates them.
    expect(late.paramIds).not.toEqual(throughout.paramIds)
    expect(late.finding).not.toBe(throughout.finding)
    expect(late.paramIds.some(id => throughout.paramIds.includes(id) && id === 'env2.hold')).toBe(false)
  })

  it('says why the decay is the wrong lever for a late drift rather than only which one is right', () => {
    const late = envOf(fallsLate())!
    // The break point is read off the trajectory, and the move lands on it.
    expect(late.finding).toContain('500 ms')
    expect(late.suggested!.to).toBeCloseTo(0.5, 6)
    expect(late.direction).toBe('increase')
    expect(late.finding).toMatch(/move the early windows that already agree/)
    expect(late.finding).toContain('PROBE')
    expectLegalSuggestion(late)

    const throughout = envOf(fallsThroughout())!
    expect(throughout.finding).toContain('The drift runs from the first measured window')
    expect(throughout.finding).not.toContain('env2.hold')
  })

  it('brings the sweep forward when the candidate is the one holding too long', () => {
    const diff = zeroDiff()
    diff.brightness = withBrightness([0.02, 0, 0.03, 0.8, 1.6])
    const held = envOf(diff, defaultPatch({ 'env2.hold': 1.2 }))!
    expect(held.suggested!.id).toBe('env2.hold')
    expect(held.suggested!.to).toBeLessThan(held.suggested!.from)
    expect(held.direction).toBe('decrease')
  })

  it('falls back to env2.dec_curve when env2.hold cannot deliver the contour', () => {
    // Same shape, but the sweep has to come EARLIER and env2.hold is already at
    // 0. The contour then lives inside the decay stage as its curve.
    const diff = zeroDiff()
    diff.brightness = withBrightness([0.02, 0, 0.03, 0.8, 1.6])
    const action = envOf(diff)!
    expect(action.suggested!.id).toBe('env2.dec_curve')
    expect(action.paramIds[0]).toBe('env2.dec_curve')
    expect(action.suggested!.to).toBeGreaterThan(action.suggested!.from)
    expect(action.finding).toContain('drops steeply at the END of the stage')
    expectLegalSuggestion(action)
  })

  it('refuses to invent a contour it has too few windows to read', () => {
    const short = zeroDiff()
    short.brightness = withBrightness([0, -0.7, -1.6])
    const action = envOf(short, defaultPatch(), { mods: routed(0.45) })!
    // The probe survives - the drift is real and the mechanism is known - but
    // it says which reading it is assuming, and it costs a confidence step.
    expect(action.suggested!.id).toBe('env2.decay')
    expect(action.finding).toContain('only 3 measured windows')
    expect(action.finding).toContain('assumes the drift starts at note-on')
    expect(action.finding).toContain('env2.hold')
    expect(action.confidence).toBe('low')
    // The same route, on a trajectory long enough to place the drift, keeps the
    // confidence the route earned.
    expect(envOf(fallsThroughout(), defaultPatch(), { mods: routed(0.45) })!.confidence).toBe('medium')
  })

  it('shapes the advice for a route that does not exist yet, without moving anything', () => {
    const late = envOf(fallsLate(), defaultPatch(), { mods: [] })
    expect(late, 'no env2 move belongs on a patch with no route').toBeUndefined()
    const action = adviseFromDiff(fallsLate(), defaultPatch(), { maxActions: 20, mods: [] })
      .find(a => a.paramIds.includes('env2.decay'))!
    expect(action.suggested).toBeUndefined()
    expect(action.finding).toContain('the stage to reach for then is env2.hold')
  })
})

/**
 * Eval run 4, second finding: `env1.sustain` suggested nine times, wrong nine
 * times, with `env1.decay` the real lever. `sustainDb` is the envelope level at
 * 80% of the buffer, which decay TIME and sustain LEVEL set together, so the
 * rule was measuring one thing and steering another.
 */
describe('sustain level against decay time', () => {
  const sustainOf = (sustainDbDelta: number, decayT60MsDelta: number | null, patch = defaultPatch()) => {
    const diff = zeroDiff()
    diff.envelope.sustainDbDelta = sustainDbDelta
    diff.envelope.decayT60MsDelta = decayT60MsDelta
    return adviseFromDiff(diff, patch, { maxActions: 20 }).find(a => a.paramIds.includes('env1.sustain'))!
  }

  it('steers env1.sustain when the two decays agree', () => {
    const action = sustainOf(-6, 0, defaultPatch({ 'env1.sustain': 0.4 }))
    expect(action.paramIds).toEqual(['env1.sustain'])
    expect(action.suggested!.id).toBe('env1.sustain')
    expect(action.suggested!.to).toBeCloseTo(0.4 * 10 ** (6 / 20), 4)
    expect(action.confidence).toBe('medium')
    expect(action.finding).toContain('agree within 20 ms')
  })

  it('refuses to steer env1.sustain when the decay explains the reading', () => {
    // The eval case: a candidate that decays too FAST reads low at 80% of the
    // buffer whatever its sustain is set to, so both deltas are negative and
    // `env1.sustain` is the wrong parameter.
    const action = sustainOf(-6, -400, defaultPatch({ 'env1.sustain': 0.4 }))
    expect(action.suggested, 'a move here fights the wrong parameter').toBeUndefined()
    expect(action.paramIds[0]).toBe('env1.decay')
    expect(action.paramIds).toContain('env1.sustain')
    expect(action.confidence).toBe('low')
    expect(action.direction).toBe('either')
    expect(action.finding).toContain('NOT steering env1.sustain')
    expect(action.finding).toContain('decay TIME and sustain LEVEL together')
    // And it names the measurement that would settle it rather than guessing.
    expect(action.finding).toContain('envelopeDb')
    // The mirror: a candidate that decays too SLOWLY reads high at 80%.
    const high = sustainOf(6, 400, defaultPatch({ 'env1.sustain': 0.4 }))
    expect(high.suggested).toBeUndefined()
    expect(high.confidence).toBe('low')
  })

  it('keeps the sustain move when the decay pushes the reading the other way', () => {
    // Decay too LONG while the level at 80% reads LOW: the decay is masking the
    // sustain error rather than causing it, so the move stands and the finding
    // says the error is at least the size measured.
    const action = sustainOf(-6, 400, defaultPatch({ 'env1.sustain': 0.4 }))
    expect(action.suggested!.id).toBe('env1.sustain')
    expect(action.confidence).toBe('medium')
    expect(action.finding).toContain('OPPOSITE way')
    expect(action.finding).toContain('at least the 6.0 dB measured')
    expect(action.paramIds).toContain('env1.decay')
  })

  it('names both levers when there is no decay reading to weigh against', () => {
    const action = sustainOf(-6, null, defaultPatch({ 'env1.sustain': 0.4 }))
    expect(action.suggested).toBeUndefined()
    expect(action.confidence).toBe('low')
    expect(action.direction).toBe('either')
    expect(action.paramIds).toEqual(['env1.sustain', 'env1.decay'])
    expect(action.finding).toContain('decayT60Ms came back null')
    expect(action.finding).toContain('envelopeDb')
  })

  it('never repeats a sustain move the decay already explains, however many rounds it runs', () => {
    // Nine rounds of the eval's own loop: the level error stays because the
    // decay is what produces it, and the rule must not hand back the same
    // `env1.sustain` move every time.
    let patch = defaultPatch({ 'env1.sustain': 0.4, 'env1.decay': 0.5 })
    for (let round = 0; round < 9; round++) {
      const diff = zeroDiff()
      diff.envelope.sustainDbDelta = -6
      diff.envelope.decayT60MsDelta = -400
      const actions = adviseFromDiff(diff, patch, { maxActions: 20 })
      expect(actions.some(a => a.suggested?.id === 'env1.sustain'), `round ${round}`).toBe(false)
      expect(actions.some(a => a.suggested?.id === 'env1.decay'), `round ${round}`).toBe(true)
      patch = applySuggestions(patch, actions).patch
    }
  })
})

describe('a finding never describes a bigger move than it applies', () => {
  /** The clamp claim a finding makes, read back out of its own prose. */
  function clampClaim(finding: string): { id: string; computed: number; bound: string; limit: number } | null {
    const m = /([\w.]+) cannot travel that far: the correction computes (-?[\d.]+(?:e[+-]?\d+)?)(?: [^,]*)?, past its (maximum|minimum) of (-?[\d.]+(?:e[+-]?\d+)?)/.exec(finding)
    return m ? { id: m[1], computed: Number(m[2]), bound: m[3], limit: Number(m[4]) } : null
  }

  it('reproduces the reviewer dist.drive case with the clamp stated', () => {
    // 0.3 - (-35.9 * 0.05) is 2.095, and dist.drive's maximum is 1. The
    // structured suggestion was already right; the prose quoted 2.095.
    const diff = zeroDiff()
    diff.harmonics = {
      deltaDb: Array.from({ length: 12 }, () => 0),
      tiltDeltaDbPerOctave: -35.9,
      oddEvenDeltaDb: 0,
      inharmonicityDelta: 0
    }
    const patch = defaultPatch({ 'dist.enabled': 1, 'dist.drive': 0.3 })
    const action = adviseFromDiff(diff, patch, { maxActions: 20 }).find(a => a.suggested?.id === 'dist.drive')!
    expect(action.suggested!.to).toBe(1)
    const claim = clampClaim(action.finding)
    expect(claim, action.finding).not.toBeNull()
    expect(claim!.id).toBe('dist.drive')
    expect(claim!.computed).toBeCloseTo(2.095, 6)
    expect(claim!.bound).toBe('maximum')
    expect(claim!.limit).toBe(1)
    // And it says where the missing tilt has to come from.
    expect(action.finding).toContain('osc1.wavetable')
  })

  it('agrees with the move it emitted, on every rule that clamps', () => {
    // Driven from the emitted action, the way the other consistency tests are:
    // the finding is only allowed to claim what the suggestion actually did.
    const magnitudes = [-9000, -3000, -1200, -240, -48, -6, 6, 48, 240, 1200, 3000, 9000]
    const patches = [
      defaultPatch(),
      defaultPatch({ 'master.volume': 1.4, 'env1.sustain': 0.9, 'dist.enabled': 1, 'dist.drive': 0.9, 'eq.enabled': 1, 'eq.high_gain': 16 }),
      defaultPatch({ 'master.volume': 0.05, 'env1.sustain': 0.05, 'dist.enabled': 1, 'dist.drive': 0.05, 'eq.enabled': 1, 'eq.high_gain': -16, 'osc1.unison': 7, 'osc1.detune': 95, 'noise.enabled': 1, 'noise.level': 0.95 })
    ]
    let claims = 0
    for (const patch of patches) {
      for (const m of magnitudes) {
        const diff = zeroDiff()
        diff.pitch.centsError = m
        diff.harmonics = {
          deltaDb: Array.from({ length: 12 }, (_, i) => (m / 50) * (i % 3 === 0 ? 1 : -1)),
          tiltDeltaDbPerOctave: m / 30,
          oddEvenDeltaDb: -m / 100,
          inharmonicityDelta: m * 1e-5
        }
        diff.bands = BAND_CENTERS.map((centerHz, i) => ({ centerHz, deltaDb: (m / 40) * (i > 6 ? 1 : -1) }))
        diff.envelope = { attackMsDelta: m, timeToPeakMsDelta: m, decayT60MsDelta: m * 4, sustainDbDelta: m / 10 }
        diff.brightness = withBrightness([m / 400, m / 300, m / 200, m / 100])
        diff.flatnessDelta = m / 2000
        diff.stereoWidthDelta = m / 2000
        diff.loudnessDbDelta = m / 40
        for (const mods of [undefined, [], [{ source: 'env2', destination: 'filter1.cutoff', depth: 0.5 }]]) {
          for (const action of adviseFromDiff(diff, patch, { maxActions: 50, ...(mods ? { mods } : {}) })) {
            const claim = clampClaim(action.finding)
            if (!claim) {
              // The other half of the contract: a suggestion sitting exactly on
              // an endpoint is fine, but only a CLAMPED one is allowed to be
              // silent about it, and those all carry a claim.
              continue
            }
            claims++
            const def = PARAM_BY_ID.get(claim.id)
            expect(def, `clamp claim names unknown param ${claim.id}`).toBeDefined()
            const label = `${claim.id} @ m=${m}: ${action.finding}`
            // The limit is a real endpoint of that parameter.
            expect(claim.limit, label).toBe(claim.bound === 'maximum' ? def!.max : def!.min)
            // The computed value really is past it, on the side claimed.
            if (claim.bound === 'maximum') expect(claim.computed, label).toBeGreaterThan(def!.max)
            else expect(claim.computed, label).toBeLessThan(def!.min)
            // And the move, when there is one, landed on the limit rather than
            // on the number the prose quoted.
            if (action.suggested?.id === claim.id) {
              expect(action.suggested.to, label).toBe(claim.limit)
              expect(action.suggested.to, label).not.toBe(claim.computed)
            }
          }
        }
      }
    }
    expect(claims, 'the sweep never exercised a clamp').toBeGreaterThan(10)
  })
})

describe('no emitted move is a no-op', () => {
  it('never suggests a value equal to the one already there', () => {
    // The eval case: `env1.sustain 0.0 -> 0.0` printed as a ranked action. A
    // suggestion that lands where the patch already is renders identical audio
    // and earns the identical advice next round.
    const magnitudes = [-9000, -1200, -150, -50, -12, -3, -0.5, 0.5, 3, 12, 50, 150, 1200, 9000]
    const knobs = [0, 1e-6, 0.05, 0.5, 0.95, 1]
    let suggestions = 0
    for (const m of magnitudes) {
      for (const k of knobs) {
        const patch = defaultPatch({
          'env1.sustain': k,
          'env1.attack': Math.max(0.001, k * 10),
          'env1.decay': Math.max(0.001, k * 10),
          'env2.decay': Math.max(0.001, k * 10),
          'master.volume': k * 1.5,
          'noise.level': k,
          'noise.enabled': k > 0.5 ? 1 : 0,
          'dist.drive': k,
          'dist.enabled': k > 0.5 ? 1 : 0,
          'eq.high_gain': (k - 0.5) * 36,
          'eq.enabled': k > 0.5 ? 1 : 0,
          'osc1.spread': k,
          'osc1.detune': k * 100,
          'osc1.unison': k > 0.5 ? 7 : 1,
          'osc1.fine': (k - 0.5) * 200,
          'filter1.cutoff': 20 + k * 19980
        })
        const diff = zeroDiff()
        diff.pitch.centsError = m
        diff.harmonics = {
          deltaDb: Array.from({ length: 12 }, (_, i) => (m / 60) * (i % 2 === 0 ? 1 : -1)),
          tiltDeltaDbPerOctave: m / 40,
          oddEvenDeltaDb: m / 80,
          inharmonicityDelta: m * 2e-5
        }
        diff.bands = BAND_CENTERS.map((centerHz, i) => ({ centerHz, deltaDb: (m / 60) * (i > 6 ? 1 : -1) }))
        diff.envelope = { attackMsDelta: m, timeToPeakMsDelta: m, decayT60MsDelta: m * 3, sustainDbDelta: m / 20 }
        diff.flatnessDelta = m / 3000
        diff.stereoWidthDelta = m / 3000
        diff.loudnessDbDelta = m / 60
        for (const brightness of [[], [m / 500, m / 400, m / 300, m / 200], [m / 300, m / 300, m / 300, m / 300]]) {
          diff.brightness = withBrightness(brightness)
          for (const mods of [undefined, [], [{ source: 'env2', destination: 'filter1.cutoff', depth: -0.4 }]]) {
            for (const action of adviseFromDiff(diff, patch, { maxActions: 50, ...(mods ? { mods } : {}) })) {
              if (!action.suggested) continue
              suggestions++
              expect(
                action.suggested.to,
                `no-op move ${action.suggested.id} ${action.suggested.from} -> ${action.suggested.to}`
              ).not.toBe(action.suggested.from)
            }
          }
        }
      }
    }
    expect(suggestions, 'the sweep never exercised a suggestion').toBeGreaterThan(500)
  })
})

describe('atomic groups', () => {
  /** Everything switched off, so every enable/move pair in the table fires. */
  const allBypassed = () =>
    defaultPatch({
      'noise.enabled': 0,
      'noise.level': 0.8,
      'eq.enabled': 0,
      'eq.high_gain': 12,
      'dist.enabled': 0,
      'dist.drive': 0.6,
      'filter1.enabled': 0,
      'filter1.type': 'HP 24',
      'osc1.unison': 1
    })

  const everythingWrong = () => {
    const diff = zeroDiff()
    diff.pitch.centsError = 700
    diff.harmonics = {
      deltaDb: [0, -9, -7, -5, 0, 0, -6, -6, -6, -6, -6, -6],
      tiltDeltaDbPerOctave: -5,
      oddEvenDeltaDb: 6,
      inharmonicityDelta: 8e-4
    }
    diff.bands = BAND_CENTERS.map(centerHz => ({ centerHz, deltaDb: centerHz >= 4000 ? -7 : 0 }))
    diff.brightness = withBrightness([-0.9, -0.92, -0.9, -0.91])
    diff.envelope = { attackMsDelta: 90, timeToPeakMsDelta: 90, decayT60MsDelta: -700, sustainDbDelta: -5 }
    diff.flatnessDelta = -0.25
    diff.stereoWidthDelta = -0.35
    diff.loudnessDbDelta = -6
    return diff
  }

  function groupSizes(actions: readonly { group?: string }[]): Map<string, number> {
    const sizes = new Map<string, number>()
    for (const a of actions) if (a.group) sizes.set(a.group, (sizes.get(a.group) ?? 0) + 1)
    return sizes
  }

  it('marks each enable/move pair as one group and keeps its members adjacent', () => {
    const all = adviseFromDiff(everythingWrong(), allBypassed(), { maxActions: 50 })
    const sizes = groupSizes(all)
    // dist, filter1, unison and (with no per-window brightness) eq or noise.
    expect(sizes.size).toBeGreaterThanOrEqual(3)
    for (const [id, size] of sizes) expect(size, id).toBe(2)
    // Adjacent, and the enable comes first: an agent applies the list in order.
    for (const [id] of sizes) {
      const at = all.map((a, i) => (a.group === id ? i : -1)).filter(i => i >= 0)
      expect(at[1] - at[0], id).toBe(1)
      expect(all[at[0]].suggested?.id, id).toMatch(/\.enabled$|osc1\.unison/)
    }
    // Members of one group are ranked as one thing, so nothing can wedge in.
    for (const [id] of sizes) {
      const members = all.filter(a => a.group === id)
      expect(new Set(members.map(a => a.estimatedGain)).size, id).toBe(1)
    }
  })

  it('never lets a maxActions cut split a group', () => {
    for (const brightness of [[] as number[], [-0.9, -0.92, -0.9, -0.91], [0, -0.4, -0.9, -1.6]]) {
      const diff = everythingWrong()
      diff.brightness = withBrightness(brightness)
      const all = adviseFromDiff(diff, allBypassed(), { maxActions: 50 })
      const full = groupSizes(all)
      expect(full.size, `no group to cut at brightness ${brightness.length}`).toBeGreaterThan(0)
      for (let limit = 1; limit <= all.length + 2; limit++) {
        const capped = adviseFromDiff(diff, allBypassed(), { maxActions: limit })
        expect(capped.length).toBeLessThanOrEqual(limit)
        for (const [id, size] of groupSizes(capped)) {
          expect(size, `group ${id} split at maxActions=${limit}`).toBe(full.get(id))
        }
      }
    }
  })

  it('spends a slot a group cannot use on the next action instead of leaving it empty', () => {
    const diff = everythingWrong()
    diff.brightness = withBrightness([])
    const all = adviseFromDiff(diff, allBypassed(), { maxActions: 50 })
    // Somewhere in this list a two-action group straddles a cut; at that limit
    // the group is dropped whole and the list still fills up behind it.
    const lengths = Array.from({ length: all.length }, (_, i) => adviseFromDiff(diff, allBypassed(), { maxActions: i + 1 }).length)
    // Never over the cap, never gratuitously short: at worst one slot goes
    // unused, and only when the group that wanted it needed two.
    lengths.forEach((len, i) => {
      expect(len).toBeLessThanOrEqual(i + 1)
      expect(len).toBeGreaterThanOrEqual(i)
    })
  })
})

describe('confidence in the ranking', () => {
  it('ranks a low-confidence action below a comparable higher-confidence one', () => {
    // The reviewer's case, in the small: `filter-envelope-depth` carries the
    // larger weight and both dimensions are saturated, so ranking on raw gain
    // alone put its low-confidence action above a medium-confidence one that
    // would actually have worked.
    const weightOf = (id: string) => ADVICE_RULES.find(r => r.id === id)!.weight
    expect(weightOf('filter-envelope-depth')).toBeGreaterThan(weightOf('decay-t60'))

    const diff = zeroDiff()
    diff.brightness = withBrightness([0, -0.8, -1.6, -2.4]) // saturated trend, low
    diff.envelope.decayT60MsDelta = -1500                   // saturated T60, medium
    const actions = adviseFromDiff(diff, defaultPatch(), { maxActions: 20 })
    const env = actions.findIndex(a => a.paramIds.includes('env2.decay'))
    const decay = actions.findIndex(a => a.paramIds.includes('env1.decay'))
    expect(env, 'no envelope-depth action').toBeGreaterThanOrEqual(0)
    expect(decay, 'no T60 action').toBeGreaterThanOrEqual(0)
    expect(actions[env].confidence).toBe('low')
    expect(actions[decay].confidence).toBe('medium')
    expect(decay).toBeLessThan(env)
  })

  it('leaves the order alone between two actions of equal confidence', () => {
    // The discount is a factor, not a reshuffle: within one confidence step the
    // ranking is exactly the raw gain ordering it always was.
    const diff = zeroDiff()
    diff.envelope.attackMsDelta = 200   // attack-time, high, weight 0.12
    diff.loudnessDbDelta = -12          // loudness, high, weight 0.10
    const actions = adviseFromDiff(diff, defaultPatch(), { maxActions: 20 })
    expect(actions.map(a => a.confidence)).toEqual(['high', 'high'])
    expect(actions[0].paramIds).toContain('env1.attack')
    expect(actions[1].paramIds).toContain('master.volume')
  })

  it('discounts a gain by one step per confidence step down', () => {
    // Read off the emitted numbers rather than restated: the same saturated
    // dimension, priced at its own confidence.
    const gainOf = (diff: MatchDiff, id: string) =>
      adviseFromDiff(diff, defaultPatch(), { maxActions: 20 }).find(a => a.paramIds.includes(id))!
    const attack = zeroDiff()
    attack.envelope.attackMsDelta = 400 // saturated, high
    const t60 = zeroDiff()
    t60.envelope.decayT60MsDelta = -3000 // saturated, medium
    const high = gainOf(attack, 'env1.attack')
    const medium = gainOf(t60, 'env1.decay')
    expect(high.estimatedGain).toBeCloseTo(0.12, 6)
    expect(medium.estimatedGain).toBeCloseTo(0.13 * 0.6, 6)
  })

  it('prices an atomic group at its least confident member', () => {
    // You cannot apply half a group, so the pair is worth what its weakest step
    // is worth - and both rows quote the same number, which is what keeps the
    // ranked list monotone in `estimatedGain`.
    const diff = zeroDiff()
    diff.flatnessDelta = -0.25
    const patch = defaultPatch({ 'noise.enabled': 0, 'noise.level': 0.5 })
    const actions = adviseFromDiff(diff, patch, { maxActions: 20 })
    expect(actions.map(a => a.confidence)).toEqual(['medium', 'low'])
    expect(actions[0].estimatedGain).toBe(actions[1].estimatedGain)
    expect(actions[0].estimatedGain).toBeCloseTo(0.08 * (0.25 / 0.5) * 0.36, 6)
  })

  it('keeps the returned list sorted by the number it reports', () => {
    const diff = zeroDiff()
    diff.pitch.centsError = 1200
    diff.envelope = { attackMsDelta: 300, timeToPeakMsDelta: 300, decayT60MsDelta: -900, sustainDbDelta: -8 }
    diff.loudnessDbDelta = -9
    diff.stereoWidthDelta = -0.4
    diff.flatnessDelta = -0.3
    diff.brightness = withBrightness([0, -0.5, -1.1, -1.9])
    for (const patch of [defaultPatch(), defaultPatch({ 'osc1.unison': 1, 'noise.enabled': 0, 'eq.enabled': 0 })]) {
      const gains = adviseFromDiff(diff, patch, { maxActions: 50 }).map(a => a.estimatedGain)
      expect([...gains].sort((a, b) => b - a)).toEqual(gains)
    }
  })
})

describe('brightness rows below the noise gate', () => {
  /**
   * `match-diff.ts` keeps a gated row in the array with a finite `octaveDelta`
   * and marks it, precisely so the arithmetic here never meets a `null` - and
   * says in its own contract that every consumer that means, spreads or trends
   * the trajectory drops the marked rows first. `compareAudioMetrics` leaves
   * them out of the score, so a rule that reads them steers against the number
   * it is trying to move.
   */
  const gated = (octaveDelta: number) => ({ startMs: 0, endMs: 0, octaveDelta, belowNoiseFloor: true as const })

  function brightness(rows: { octaveDelta: number; belowNoiseFloor?: true }[]): MatchDiff['brightness'] {
    return rows.map((row, i) => ({ ...row, startMs: i * 250, endMs: (i + 1) * 250 }))
  }

  it('ignores a phantom swing manufactured by a decayed tail', () => {
    // The real shape: three honest windows agreeing on a flat offset, and a
    // near-silent fourth whose centroid was picked out of hiss. Read raw, the
    // +4.9-octave last row is a huge trend and `env2.decay` ranks first.
    const diff = zeroDiff()
    diff.brightness = brightness([
      { octaveDelta: -0.9 },
      { octaveDelta: -0.92 },
      { octaveDelta: -0.9 },
      gated(4.9)
    ])
    const actions = adviseFromDiff(diff, defaultPatch(), { maxActions: 20 })
    expect(actions.some(a => a.paramIds.includes('env2.decay'))).toBe(false)
    const cutoff = actions.find(a => a.suggested?.id === 'filter1.cutoff')!
    expect(cutoff, 'the three measured windows still read as a static offset').toBeDefined()
    expect(cutoff.finding).toContain('every one of the 3 analysis windows')
    expect(cutoff.finding).toContain("below the analyzer's noise gate")
  })

  it('reads the same trend whether the gated rows are there or not', () => {
    const measured = [{ octaveDelta: 0.05 }, { octaveDelta: -0.3 }, { octaveDelta: -0.85 }, { octaveDelta: -1.5 }]
    const clean = zeroDiff()
    clean.brightness = brightness(measured)
    const padded = zeroDiff()
    padded.brightness = brightness([...measured, gated(6), gated(-6)])
    const of = (d: MatchDiff) => adviseFromDiff(d, defaultPatch(), { maxActions: 20 }).find(a => a.suggested?.id === 'env2.decay')!
    expect(of(padded).suggested).toEqual(of(clean).suggested)
  })

  it('hands the territory to the octave-band fallback when every window is gated', () => {
    const diff = zeroDiff()
    diff.brightness = brightness([gated(-3), gated(-3.2), gated(-3.1), gated(-3)])
    diff.bands = BAND_CENTERS.map(centerHz => ({ centerHz, deltaDb: centerHz >= 4000 ? -8 : 0 }))
    const actions = adviseFromDiff(diff, defaultPatch(), { maxActions: 20 })
    expect(actions.some(a => a.paramIds.includes('env2.decay'))).toBe(false)
    // `upper-bands-quiet`, which exists for exactly this "no usable per-window
    // brightness" case, has to fire rather than defer to a rule that just
    // refused the same evidence.
    const [action] = actions
    expect(action.finding).toContain('4 kHz')
    expect(action.paramIds).toContain('eq.high_gain')
  })

  it('stays silent rather than trending a single measured window', () => {
    const diff = zeroDiff()
    diff.brightness = brightness([{ octaveDelta: -1.4 }, gated(3), gated(-3), gated(2)])
    const actions = adviseFromDiff(diff, defaultPatch(), { maxActions: 20 })
    expect(actions.some(a => a.paramIds.includes('env2.decay'))).toBe(false)
    expect(actions.some(a => a.suggested?.id === 'filter1.cutoff')).toBe(false)
  })

  it('turns on the flag alone, and nothing else', () => {
    // The end-to-end shape of the original failure, and its own control. ONE
    // field differs between the two runs, so the filter is what decides the
    // outcome: without it both trajectories read the same -1.6-octave drift and
    // both rank an `env2.decay` move first, which is the bug. Neither half of
    // this pair can pass vacuously - one asserts the action is absent, the other
    // that the very same numbers still produce it.
    const rows = [{ octaveDelta: 0.05 }, { octaveDelta: 0.02 }, { octaveDelta: 0 }, { octaveDelta: -1.6 }]
    const envOf = (last: { octaveDelta: number; belowNoiseFloor?: true }) => {
      const diff = zeroDiff()
      diff.brightness = brightness([...rows.slice(0, 3), last])
      return adviseFromDiff(diff, defaultPatch(), { maxActions: 20 }).find(a => a.paramIds.includes('env2.decay'))
    }
    const measured = envOf(rows[3])!
    expect(measured, 'the control must fire, or the negative case proves nothing').toBeDefined()
    expect(measured.finding).toContain('darkens too fast')
    // `env2.hold`, not `env2.decay`: these rows hold a steady offset for three
    // windows and only fall in the fourth, which is the flat-early/falls-late
    // shape - the rule prescribes the stage that moves the tail and leaves the
    // early windows alone. See `a trajectory's shape picks the env2 stage`.
    expect(measured.suggested?.id).toBe('env2.hold')

    // Same trajectory, last window measured off the noise the sound decayed
    // into. There is no measurable drift left, so there is no action.
    expect(envOf({ ...rows[3], belowNoiseFloor: true })).toBeUndefined()
  })
})
