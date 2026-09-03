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
