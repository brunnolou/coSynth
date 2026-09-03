import { describe, expect, it } from 'vitest'
import { ADVICE_RULES, adviseFromDiff, assertRuleParamsExist, type AdviceCategory, type PatchValues } from './match-advice'
import type { MatchDiff } from './match-types'
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
    const magnitudes = [-3000, -1200, -120, -12, -1.2, 1.2, 12, 120, 1200, 3000]
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
