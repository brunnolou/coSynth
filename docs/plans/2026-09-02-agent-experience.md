# Agent Experience Improvement Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make coSynth's WebMCP tools cheap to learn, hard to misuse, and measurable enough that an agent with no ears can design a sound to a target and know when it got there.

**Architecture:** Keep the eleven-tool surface and its strict validation. Improve four layers underneath it: (1) error messages that carry the schema the validator already holds, (2) discovery calls sized for a single round trip, (3) a metrics set that describes envelope, spectrum, and harmonic structure rather than seven scalars, and (4) an offline, deterministic render path so the design loop no longer runs at 1x wall-clock or waits for a user gesture. Every change is additive; existing response fields keep their names and meaning.

**Tech Stack:** TypeScript 5.5, Vite 8, Web Audio / AudioWorklet / OfflineAudioContext, WebMCP `document.modelContext`, Vitest, Playwright.

---

## Field evidence

Source: one agent session (Claude, 2026-09-01/02) building a piano patch from a cold start through the tool layer. The agent reached the tools through `registerWebMcpTools()` against the live `SynthEngine` in the page, so this is evidence about tool *semantics*, not MCP transport.

| Observation | Cost to the agent | Root cause |
|---|---|---|
| `"Unexpected input property: duration"` and `"...: changes"` on first use of `play_notes` / `update_parameters` | 2 wasted round trips (each one is a full model call) | `assertObject()` names the bad key and not the accepted ones — `src/webmcp/tools.ts:83-89`, mirrored in `validatePerformanceNotes()` — `src/history/performance.ts:124` |
| Learning the 224-parameter space | 45 sequential calls (only survivable because the agent looped inside one JS eval) | `MAX_PAGE_SIZE = 5` — `src/webmcp/tools.ts:36`; also caps `get_synth_state` paging |
| `"Note intervals overlap for MIDI 64"` when an arpeggio's E4 rang into a chord's E4 | Had to hand-schedule note-offs to avoid a normal piano gesture | Overlap rejected because `performNotes()` tracks `started` as `Set<number>` keyed by pitch — `src/history/performance.ts:105-118, 141-146` |
| `attackMs: 1277` on the first render — the "attack" was 1 Hz unison beating from a 7-cent detune | Correct diagnosis by luck; the metric measures something else | 10→90 % rise computed on the raw rectified waveform to the *global* peak, no smoothing — `src/shared/audio-analysis.ts:110-125` |
| `peakDb` non-monotonic across velocity (0.2 → -10.3 dB, 0.5 → -13.2 dB) | Could not trust peak as a loudness proxy | Peak of Opus-decoded, reverb-tailed, realtime capture; `rmsDb` is the sound choice but nothing says so |
| No way to see or measure decay while building an instrument defined by its decay | Trusted envelope arithmetic blind | No envelope or T60 in `AudioMetrics` |
| One collapsed `spectralCentroidHz` for timbre | Could tell "brighter/darker", nothing about shape or inharmonicity | No band energies, no harmonic analysis, even though `render_audio` knows the MIDI note |
| `analyze_audio`, `compare_audio` never used | Empty input schema made purpose opaque next to `render_audio.metrics`; no obvious entry to the reference workflow | `emptySchema` — `src/webmcp/tools.ts:658, 722`; descriptions describe mechanism, not when to reach for them |
| Every render is `renderMode: 'realtime'` | 4 s render = 4 s wall clock; a 4-point sweep ≈ 15 s; requires the human to have clicked Start | `recordOutput()` is MediaRecorder on the live graph — `src/audio/engine.ts:463`; `new AudioContext` hardcoded — `engine.ts:139` |
| No `list_presets` | Saved "Concert Grand" with no way to confirm what else exists | `listPresets()` exists in `src/shared/preset-store.ts:126` but is not exposed |

What worked and must not regress: 79 parameters applied atomically in one call; `set_modulation` add/update/remove/clear with slot addressing and normalized ±1 depth; `choices` labels on enum params; the `{ok:false, error:{code,message}}` shape; `get_synth_state`'s description style ("what you get by default, how to ask for more").

---

## Priority 0 — one afternoon, removes most first-contact friction

### Task 1: Errors that carry the schema

**Objective:** Every validation error tells the agent what *would* have been accepted, so a wrong guess costs one round trip, never two.

**Files:**
- Modify: `src/webmcp/tools.ts` (`assertObject`, `canonicalRaw`, `set_modulation` source/destination errors, `update_parameters` unknown id)
- Modify: `src/history/performance.ts` (`validatePerformanceNotes`)
- Modify: `src/webmcp/tools.test.ts`

**Steps:**
1. Write failing tests asserting the new message shapes:
   - `Unexpected input property 'changes'. Accepted: updates`
   - `Unknown parameter 'filter.cutoff'. Did you mean filter1.cutoff, filter2.cutoff? Groups: global, osc1, …`
   - `Unknown modulation source 'vel'. Valid: env1…env6, lfo1…lfo8, velocity, keytrack, random, macro1…macro4, modwheel, pitchwheel, aftertouch`
   - `Unknown choice 'Lowpass' for filter1.type. Choices: LP 12, LP 24, HP 12, …`
   - `notes[0]: unexpected property 'name'. Each note is {midi, velocity, start, duration}`
2. Extend `assertObject(value, label, allowed, required)` to append `Accepted: ${allowed.join(', ')}` and, when a required key is missing, `Required: …`.
3. Add a small `suggest(id, candidates)` helper (prefix match, then Levenshtein ≤ 2, max 3 suggestions) used by unknown-parameter and unknown-destination errors.
4. Keep `error.code` values unchanged; only `message` grows.
5. Run focused tests, then the full suite and typecheck.

### Task 2: Discovery in one round trip

**Objective:** An agent can learn the whole instrument — every parameter's id, range, default, unit hint, and moddability — in a single call that fits comfortably in context.

**Files:**
- Modify: `src/webmcp/tools.ts` (`get_parameter_schema`, `get_synth_state`)
- Modify: `src/webmcp/tools.test.ts`
- Modify: `README.md` (WebMCP section)

**Steps:**
1. Write failing tests for `get_parameter_schema({ format: 'compact' })` returning `parameters.items` as strings, one per parameter, e.g. `filter1.cutoff Hz 20..20000 exp =8000 mod` and `filter1.type {LP 12|LP 24|HP 12|…} =1`, with `total === items.length` and no `nextOffset`; and for `limit` accepting up to 60 in full format.
2. Raise `MAX_PAGE_SIZE` to 60 and introduce `COMPACT_PAGE_SIZE = PARAMS.length` so compact mode never pages.
3. Derive the unit hint from `fmt` output on the default value (e.g. `hz`, `ct`, `ms`) — `ParamDef.unit` is unset on every parameter today; either populate `unit` in `src/shared/params.ts` or infer it once at module load. Populating is preferred; it also fixes the always-absent `unit` field in full format.
4. Apply the same limit change to `get_synth_state`'s `parameterLimit`/`modulationLimit`/`lfoPointLimit`, and add `format: 'compact'` there too (`id=formatted` lines for non-default parameters only, so an agent can verify a patch cheaply).
5. Update the tool descriptions to name the compact mode first: "Call once with `format: 'compact'` to see every parameter; use group/search/offset for detail."
6. Run focused tests, then full suite.

### Task 3: Same-pitch retrigger in note sequences

**Objective:** A repeated pitch whose previous instance is still sounding retriggers the voice — as MIDI does — instead of rejecting the whole sequence.

**Files:**
- Modify: `src/history/performance.ts`
- Modify: `src/history/performance.test.ts` (create if absent)
- Modify: `src/webmcp/tools.test.ts`

**Steps:**
1. Write failing tests: two overlapping notes on MIDI 64 produce `noteOn, noteOn` (retrigger) and exactly one `noteOff` at the *later* end; the cleanup path still releases everything on abort; `validatePerformanceNotes` no longer throws on overlap.
2. In `performNotes()`, replace `started: Set<number>` with `Map<number, number>` (active count per pitch). On note-on for an already-active pitch, call `noteOff` then `noteOn` and increment; on note-off, decrement and only call `engine.noteOff` when the count reaches zero.
3. Remove the overlap throw in `validatePerformanceNotes()`; return `overlaps: number` alongside `duration` so `play_notes`/`render_audio` can echo `retriggered: n` in their result for transparency.
4. Confirm `assertNotesAvailable()` (human-held notes) is unchanged.
5. Run focused tests, then full suite.

### Task 4: Make the analysis tools legible

**Objective:** An agent reading only descriptions and schemas understands when to call `analyze_audio` versus reading `render_audio.metrics`, and how the reference workflow fits together.

**Files:**
- Modify: `src/webmcp/tools.ts` (descriptions; `analyze_audio` input)
- Modify: `src/webmcp/tools.test.ts`

**Steps:**
1. Write failing tests for `analyze_audio({ source: 'scope' })` and `{ source: 'last-render' }` (error if no render exists), default unchanged.
2. Replace `emptySchema` on `analyze_audio` with an optional `source` enum and describe it: "Re-analyze the last `render_audio` result, or analyze the live output right now (`source: 'scope'`) — useful while a human is playing. `render_audio` already returns the same metrics, so call this only when you need a fresh look without re-rendering."
3. Rewrite the reference workflow descriptions as a sequence: `analyze_reference_audio` — "Step 1 of matching a target sound: send the target as Base64 …"; `compare_audio` — "Step 2: compare the latest reference with the latest render …".
4. Add one inline example to `play_notes` and `update_parameters` descriptions (agents pattern-match on examples; both first-contact errors in the field evidence would have been avoided): `Example: {"updates":[{"id":"filter1.cutoff","value":1200}]}`.
5. Document `set_modulation.depth` semantics in its description (bipolar, added to the destination's normalized value, clamped) — the session had to infer this.
6. Run tests.

### Task 5: Expose `list_presets`

**Objective:** An agent can see what it (and the human) has saved.

**Files:**
- Modify: `src/webmcp/tools.ts`
- Modify: `src/webmcp/register.ts` (tool count expectations), `src/webmcp/activity.ts` (label)
- Modify: `src/webmcp/tools.test.ts`, `README.md`

**Steps:**
1. Failing test: `list_presets()` returns `{ presets: [{ name, savedAt? }] }` from `listPresets()`.
2. Implement with `readOnlyHint: true`, add the activity label, bump the documented tool count (17 → 18).
3. Run tests.

---

## Priority 1 — the ears: metrics an agent can design against

### Task 6: A real amplitude envelope, and an `attackMs` that means attack

**Objective:** Replace the rectified-sample rise time with measurements on a smoothed envelope, and return the envelope itself.

**Files:**
- Modify: `src/shared/audio-analysis.ts`
- Modify: `src/shared/audio-analysis.test.ts`
- Modify: `src/webmcp/audio-analysis-task.ts` (worker payload size)

**Steps:**
1. Write failing tests with synthetic signals: (a) a 440 Hz sine with a 5 ms linear attack and exponential decay of known T60 = 2.0 s → `attackMs ≈ 5`, `decayT60Ms ≈ 2000 ± 5 %`; (b) two sines 1 Hz apart (beating) with a 2 ms attack → `attackMs ≈ 2`, not ~500; (c) silence → all zeros, no throw.
2. Compute an RMS envelope with a 5 ms window / 1 ms hop (mono-summed). Measure `attackMs` as 10→90 % of the **first local maximum** (first hop where the envelope stops rising for ≥ 10 ms), not the global peak. Add `timeToPeakMs` (global peak) as a separate field so the old behaviour is still observable.
3. Add `decayT60Ms`: from the first local maximum, find the time the envelope falls 20 dB (fit over the −5…−25 dB span, least squares in dB) and extrapolate to −60 dB; `null` if the signal never falls 20 dB within the buffer. Add `sustainDb`: envelope level at 80 % of buffer length relative to peak.
4. Add `envelopeDb: number[]` — 64 points, evenly spaced across the buffer, in dB relative to peak, rounded to 0.1. Sixty-four numbers is the cheapest way to let an agent *see* the shape.
5. Keep every existing field; extend `metricKeys` and `compareAudioMetrics()` with `decayT60Ms` (log-ratio similarity) and an envelope similarity (Pearson correlation of the two `envelopeDb` arrays).
6. Run tests, including the existing `attackMs` golden values — update any that were measuring beating.

### Task 7: Spectral shape and harmonic structure

**Objective:** Describe timbre with enough detail to tell a piano from an organ, and tell an agent how inharmonic its partials are.

**Files:**
- Modify: `src/shared/audio-analysis.ts`, `src/shared/audio-analysis.test.ts`
- Modify: `src/webmcp/tools.ts` (`render_audio` passes `f0Hz` when the sequence has exactly one distinct pitch)
- Modify: `src/webmcp/audio-analysis-task.ts`

**Steps:**
1. Failing tests: a sawtooth at 220 Hz reports `bandsDb` with energy falling ~6 dB/octave; a pure sine has `spectralFlatness < 0.05`; a synthetic stretched-partial tone (partials at n·f0·√(1+B·n²), B = 0.0004) reports `inharmonicity ≈ 0.0004 ± 20 %`.
2. Add `bandsDb: number[]` — 10 octave bands centred 31.25 Hz … 16 kHz, dB relative to total power. Add `spectralRolloffHz` (85 % energy) and `spectralFlatness` (0 = tonal, 1 = noise).
3. Add optional `analyzeAudio(channels, sampleRate, { f0Hz })`. When given, locate the first 12 partials by peak-picking ±3 % around `n·f0`, and return `harmonics: { amplitudesDb: number[], inharmonicity: number }` with `inharmonicity` fitted as the coefficient B of `f_n = n·f0·√(1 + B·n²)`.
4. In `render_audio`, when `sequence.notes` has one distinct `midi`, pass `f0Hz = 440·2^((midi−69)/12)` to the analyzer so single-note renders get harmonic data for free.
5. Extend `compareAudioMetrics()` with band-vector distance (mean absolute dB difference across `bandsDb`, scale 6 dB).
6. Run tests.

### Task 8: Loudness the agent can trust

**Objective:** Give a monotonic, velocity-tracking loudness figure and say so.

**Files:**
- Modify: `src/shared/audio-analysis.ts`, tests
- Modify: `src/webmcp/tools.ts` (descriptions)

**Steps:**
1. Failing test: the same tone at 0.25×, 0.5×, 1.0× amplitude yields strictly increasing `loudnessDb`.
2. Add `loudnessDb`: gated RMS (drop windows below −60 dBFS, i.e. exclude the reverb tail and silence), computed on the 5 ms envelope from Task 6. Document `peakDb` as "instantaneous peak — use `loudnessDb` or `rmsDb` to compare levels".
3. Run tests.

---

## Priority 2 — offline rendering: fast, deterministic, no gesture required

### Task 9: `SynthEngine` over any `BaseAudioContext`

**Objective:** Let an engine be constructed against an `OfflineAudioContext` so the same worklet, wavetables, and parameter state can render without the live graph.

**Files:**
- Modify: `src/audio/engine.ts`
- Modify: `src/audio/engine.test.ts` (or create)

**Steps:**
1. Failing test: `new SynthEngine({ context: fakeOfflineContext })` skips `latencyHint`, does not create a `MediaStreamDestination`, and `start()` resolves after `addModule` without `resume()`.
2. Extract the `new AudioContext({ latencyHint: 'interactive' })` at `engine.ts:139` into an injected factory / optional constructor option; guard every live-only call (`resume`, scope messaging, `recordOutput`) behind `ctx instanceof AudioContext`.
3. Ensure `loadPreset()` / `setParam()` / `setModSlot()` post to the worklet identically in both modes.
4. Run tests.

### Task 10: `render_audio` offline mode

**Objective:** Renders complete in a fraction of realtime, are bit-for-bit repeatable, are analysed on lossless PCM, and work before the human has clicked Start.

**Files:**
- Modify: `src/webmcp/tools.ts` (`render_audio`)
- Create: `src/webmcp/offline-render.ts`, `src/webmcp/offline-render.test.ts`
- Modify: `README.md`

**Steps:**
1. Failing tests: `render_audio({ notes, mode: 'offline' })` returns `renderMode: 'offline'`, `mimeType: 'audio/wav'`, identical `metrics` across two calls, and completes in < 25 % of the requested duration in wall-clock on the test machine; when `OfflineAudioContext` or the worklet is unavailable it falls back to `'realtime'` and says so.
2. Implement `renderOffline(engine, notes, duration)`: create `OfflineAudioContext({ numberOfChannels: 2, length, sampleRate: engine.ctx?.sampleRate ?? 48000 })`, construct a scratch `SynthEngine` on it (Task 9), `loadPreset(engine.toPreset('render'))`, schedule note-on/off at sample-accurate times via `ctx.suspend(t)`/`resume()`, `startRendering()`, encode WAV.
3. Add `mode: 'offline' | 'realtime'` to the input schema; default `'offline'` when available. Drop the `engine.running` requirement for offline renders — this is the change that lets an agent design sounds before the human starts audio; only `play_notes` still needs the gesture.
4. Add `format: 'metrics' | 'url' | 'base64'` (default `'metrics'`): `'base64'` returns mono 16-bit WAV at 22.05 kHz, capped at 8 s, so an audio-capable agent can actually listen. A blob URL is useless to a remote client.
5. Update descriptions and README; keep `renderMode` so existing consumers can tell which path ran.
6. Run tests, then Playwright smoke: cold page, no Start click, `render_audio` offline succeeds.

---

## Priority 3 — hygiene carried over from the transport work

### Task 11: Honest registration counts on the legacy widget path

**Files:** `src/webmcp/legacy.ts`, `src/webmcp/legacy.test.ts`

**Steps:**
1. Failing test: when the widget's `registerTool` throws or leaves the name absent from its `availableTools`, `registeredCount` does not increment and `errors` gains an entry.
2. Extend `LegacyWebMcp` with optional `availableTools?: Map<string, unknown>`; after calling `registerTool`, verify presence and throw into the adapter's `.catch` when missing.

### Task 12: Document the dev proxy

**Files:** `README.md`, `vite.config.ts`

**Steps:**
1. In the README fallback paragraph, explain why `vite.config.ts` proxies `/register` and `/localhost_5173` to `ws://[::1]:4797` (bridge binds IPv6 only; embedded browsers refuse cross-origin loopback), and that the token's `server` must be rewritten to `ws://localhost:5173` to use it.
2. Note the port slug is hardcoded to 5173 and how to change it.

---

## Verification

1. `npm run typecheck && npm test` green after every task; new golden-signal tests in `audio-analysis.test.ts` are the regression guard for Tasks 6–8.
2. **First-contact smoke** (new, `src/webmcp/first-contact.test.ts`): a scripted "agent" that sees only `name`, `description`, and `inputSchema`, and must complete: discover parameters in ≤ 2 calls → apply a 10-parameter patch → add 2 routes → render one note offline → read `decayT60Ms` and `harmonics.inharmonicity`. Fails if any step needs a retry.
3. Re-run the piano session against the new build and record: calls to first successful `update_parameters` (target: 1), calls to full discovery (target: 1), wall-clock for a 4-point velocity sweep (target: < 3 s offline), and whether `attackMs` reports < 10 ms with 7-cent detune.
