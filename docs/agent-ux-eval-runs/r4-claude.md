# coSynth WebMCP surface — first-contact agent evaluation

**Rule 1 compliance:** I did not read anything under `~/Projects/coSynth`. I never listed, opened, grepped or searched that path, and I did not grep for tool names or parameter ids anywhere on disk. My only knowledge sources were `GET /tools` and what the tools returned.

## Measurements

| Measurement | Your result |
|---|---|
| Calls to learn the full parameter space | **1** (`get_parameter_schema` with `format:"compact"`, `sourceLimit:60`) — returned all 224 parameters with unit/range/curve/default/`mod` flag, all 24 modulation source ids, `groups`, `groupNotes`, and a `limits` block, in 11 ms. Harness `discoveryCalls: 2` (it also counts my later `get_synth_state`). |
| Calls before your first **successful** `update_parameters` | **1** prior call (harness `callsToFirstSuccessfulUpdateParameters: 2`, i.e. it was call #2). 23 parameters applied in one batch, first attempt, no failures. |
| Total calls, and how many failed | **17 total, 0 failed** |
| Did an offline render work before `/start`? `renderMode`? | **Yes.** `renderMode: "offline"`, 48 kHz stereo, 228 ms wall clock. Start gesture was not dispatched until call 16. |
| Wall clock for the 4-render velocity sweep | **0.99 s** for all four (216–247 ms each) |
| Which loudness figure tracked velocity monotonically | **All three did**, cleanly. `loudnessDb` −32.88 → −30.05 → −26.98 → −24.72; `rmsDb` −35.88 → −33.04 → −29.95 → −27.70; `peakDb` −18.57 → −14.87 → −10.47 → −8.50, for velocity 0.2/0.4/0.7/1.0. `spectralCentroidHz` also rose 264.2 → 269.8, confirming my `velocity → filter1.cutoff` route was live. |
| `attackMs` reported with ~7-cent detune | **8.70 ms** (`timeToPeakMs` 12). Baseline without detune was 4.5–6.3 ms. **The beat did not masquerade as a slow attack** — a 7 ct detune at C4 beats at ~1.06 Hz (≈940 ms period), and nothing near that appeared. |
| Could you read a decay time? What value? | **Yes, but only on a long note.** `decayT60Ms` was `null` on my first render (1.5 s note, 6 s buffer). On an 8 s held note it read **6551 ms** for `env1.decay = 3.50 s`. The 2 s notes in the sweep gave ~5015–5114 ms. |
| Could you read harmonic inharmonicity? What value? | **Yes.** `metrics.harmonics.inharmonicity` = **−4.32e−06** on the single-pitch renders (i.e. zero, as expected for wavetable oscillators), rising to **4.15e−05** with the 7 ct unison detune. Also got a 12-partial `amplitudesDb` ladder (0, −6.7, −20.6, −100.6, −30.2, …) and per-window `harmonicsDb` in four 1.5 s `spectralWindows`, which is what actually let me see brightness falling with time. |
| Did a repeated ringing pitch need a workaround? | **No.** I passed E4 at `start 0.25 dur 2` and E4 again at `start 1.0 dur 2` in one `render_audio` `notes` array. Accepted, no error, no dedup complaint. `play_notes` on the same phrase returned `retriggered: 3`. |

## Errors

**There were none.** Zero failed calls out of 17. Nothing was rejected, so I have no error messages to quote and no "did it tell me enough to fix it in one try" judgement to make. This is the strongest single result in the run: every call I made on my first guess was accepted, including a 23-parameter atomic batch and two modulation routes, off one discovery call.

## Where did I waste a call?

**One call, arguably two.**

- **Render #1 (call 5) was wasted for the purpose of step 5.** I chose a 1.5 s note on a patch with `env1.decay = 3.5 s`, and got `decayT60Ms: null`. The `render_audio` description *does* warn about this ("It is `null` — its most common value on short notes — whenever the buffer never falls the 20 dB the slope fit needs, or falls too abruptly"), so this is on me — but the warning stops one step short of actionable. It tells me *when* the fit fails, not *what to pass instead*. "Hold the note for at least ~2× `env1.decay` to get a T60" would have saved the call outright. As written I had to reason from the failure to the fix.
- **`set_modulation` cost me an avoidable second call.** Every other write tool on this surface batches — `update_parameters` took 23 edits atomically — but `set_modulation` takes exactly one route per call. Two routes, two calls. Nothing in the description misled me; the capability just isn't there. A `routes: [...]` array would have made step 3 a single call.

## What did I have to infer that should have been stated?

- **`osc1.detune` (unit `ct`, range 0..100) — what the number spans.** For unison voices, 7 ct could be ±7 (14 ct total), 7 ct total spread across the voices, or 7 ct between adjacent voices. With `unison: 2` the three readings give different beat rates. The schema gave me the unit and the range but not the geometry, and `osc1.spread`/`osc1.blend` sit next to it with no statement of what they distribute either. I guessed "detune amount applied across the unison stack" and moved on. The measured inharmonicity shift (4.15e−05) confirms *something* happened but not which reading is right.
- **`render_audio` never says whether a repeated pitch retriggers or layers.** `play_notes` states it plainly ("A repeated pitch retriggers its voice") and even returns `retriggered: 3`. `render_audio` says neither, and its metrics contain no retrigger count. So the answer to step 8 for the *offline* path is something I inferred by analogy from a *different tool's* description — exactly the kind of cross-tool inference a first-contact agent should not have to make. Put the sentence and the counter on both.
- **`osc1.morph` (0..1) has no stated meaning.** It is a wavetable position, so 0.3 means "30% through the Basic Shapes table" — but which shapes, in what order, is nowhere in the schema. I set it blind. `osc1.wavetable` enumerates seven table names but nothing enumerates what is *inside* one, so the single parameter that most determines the raw timbre is the one I had least grip on.
- **`depth` semantics: stated well, and I want to say so.** `set_modulation` spells out that depth is bipolar, added to the destination's **normalized 0..1** value, and clamped, with a worked example ("depth 0.5 on a parameter sitting at 0.5 sweeps it up to 1.0"). That is the single most useful sentence in the whole surface. It let me compute my filter route in my head: cutoff 1200 Hz is normalized 0.593 on the exp 20..20000 scale, +0.35 lands at 0.943 ≈ 13.5 kHz peak, so the note opens bright and closes to 1.2 kHz. I could not have picked that depth by trial and error in under five renders. **Answering the question as asked: yes, I could tell what `depth` means and what it is relative to, from the description alone.**

## What did I not trust, and why?

- **`decayT60Ms`, as a number I could design against.** It reported 6551 ms for `env1.decay = 3.50 s`. The description is honest that it is measured from the tail and that `duration` and `release` shape it, so I know it is not a read-back — but 1.9× the decay setting is a big enough gap that I cannot tell whether it reflects my `dec_curve = 0.6` (which by the `groupNotes` explanation trails off into a long low tail, so a stretched T60 is plausible) or something else. The confirming evidence is that it *moved the wrong way for the wrong reason*: across the velocity sweep, T60 drifted 5114 → 5016 ms as velocity rose. Velocity should not change the decay of a fixed envelope. That drift is small and probably an artifact of the fit window starting from a higher peak, but I have no way to check it, so I treat T60 as ordinal (longer/shorter) and not cardinal.
- **`envelopeDb` is too noisy to read a decay shape off.** On the detuned render it went −6.5, −2.5, −6.3, −8.9, −9.1, −6.2, −8.1, −8.6, −8.1, −12.6, −11.9, −11.1, −9.2 — non-monotonic by up to 3.5 dB, because the 1 Hz beat and the octave oscillator are interfering inside each bucket. Its bucket duration is never stated either (I back-computed ~94 ms from 64 buckets over 6 s). For "is my decay smooth", this array is unusable; the four `spectralWindows` `levelDb` values were far more trustworthy.
- **`spectralFlatness: 2.5e-09`.** Nine orders of magnitude below anything I'd expect from an audio signal with a −6.7 dB second harmonic. No unit or expected range is given, so I ignored it entirely rather than treat it as a brightness proxy.
- **`sustainDb: -100`** is correct (I set sustain to 0) but is a magic sentinel, not a measurement, and `-100` also appears throughout `envelopeDb` as "silence". Two meanings, one value.

## What could I still not find out through the tools at all?

1. **Whether the offline renderer retriggers or layers a repeated pitch**, and how many voices were actually allocated for my 6-note phrase. `runtime.voices` exists in `get_synth_state` but reads 0 when nothing is running, and there is no post-render voice report. `play_notes` has `retriggered`; `render_audio` has nothing.
2. **What a wavetable actually contains.** No tool exposes the shapes behind `osc1.wavetable` or the axis `osc1.morph` travels. I chose the timbre by name.
3. **Where velocity goes by default.** `groupNotes` says env1 is the only hardwired modulator and that velocity is a *source*, but not whether velocity→amplitude is already wired. My sweep proved it is (loudness moved before I routed velocity to anything but cutoff), so there is a hardwired velocity path the schema does not document.
4. **Whether my filter route peaked where I calculated.** `spectralCentroidHz` sat at ~269 Hz — the fundamental — across every render, and `spectralRolloffHz` was also 269.5. Both metrics are dominated by the fundamental and never showed me the 13.5 kHz opening my depth arithmetic predicted. The per-window `harmonicsDb` was the only place I could see brightness change at all, and only over four coarse windows.
5. **Any absolute reference for "is this loud enough".** `loudnessDb −25` is a number; I have no target, no headroom guidance, and no statement of what `loudnessDb` is (LUFS? A-weighted?).

## If I had to design this sound to a target I could not hear, what is still missing?

I got a *defensible* plucked patch in 17 calls with zero failures, and that is genuinely good. But I could not close the loop on the one thing that defines this instrument.

The gap is **time-resolved spectral detail**. A piano is a brightness trajectory: bright strike, fast rolloff, a long dull tail. My only view of that was four 1.5 s `spectralWindows` — a resolution at which the entire piano-defining first 150 ms is one twentieth of one bucket. What I needed was windows I could set (say 25 ms over the first 300 ms), and a `spectralCentroidHz` that is not pinned to the fundamental — a centroid computed above the fundamental, or a plain "energy above 1 kHz over time" curve.

Second, **T60 per partial**. On a real piano the upper partials die first; that is most of what "piano" means. I got one global T60 and one static harmonic ladder. A per-harmonic decay rate would have told me directly whether my `env2 → cutoff` route was doing the job, and I still do not know that it is.

Third, **a target to compare against**. `analyze_reference_audio` + `compare_audio` exist and are described as the two-step matching workflow, which is the right shape — but they need me to supply a reference WAV in Base64. Designing blind, I have none. `compare_audio` returning per-metric similarity against a *named factory reference* ("acoustic piano") would turn "I think this sounds right" into a number. Without either that or an ear, the honest position at the end of this run is: the envelope is measurably correct, the decay is measurably long, the velocity response is measurably monotonic — and whether it sounds like a piano is still a guess.

## Harness summary (verbatim)

```json
{
 "totalCalls": 17,
 "failedCalls": 0,
 "callsToFirstSuccessfulUpdateParameters": 2,
 "discoveryCalls": 2,
 "silentRenders": 0,
 "startGestureDispatchedAtCall": 16,
 "pageErrors": [],
 "perTool": {
  "get_parameter_schema": {"calls": 1, "failed": 0, "totalMs": 11},
  "get_synth_state":     {"calls": 1, "failed": 0, "totalMs": 5},
  "list_presets":        {"calls": 1, "failed": 0, "totalMs": 2},
  "play_notes":          {"calls": 1, "failed": 0, "totalMs": 3015},
  "render_audio":        {"calls": 8, "failed": 0, "totalMs": 1966},
  "save_preset":         {"calls": 1, "failed": 0, "totalMs": 3},
  "set_modulation":      {"calls": 2, "failed": 0, "totalMs": 26},
  "update_parameters":   {"calls": 2, "failed": 0, "totalMs": 19}
 }
}
```

## Step-by-step trace

| # | Tool | Purpose | ok | ms |
|---|---|---|---|---|
| — | `GET /tools` | 17 descriptors; **`play_notes` absent** | — | — |
| 1 | `get_parameter_schema` | all 224 params + 24 sources, one call | ✅ | 11 |
| 2 | `update_parameters` | 23-param piano patch, atomic | ✅ | 13 |
| 3 | `set_modulation` | env2 → filter1.cutoff, depth 0.35 | ✅ | 20 |
| 4 | `set_modulation` | velocity → filter1.cutoff, depth 0.15 | ✅ | 6 |
| 5 | `render_audio` | 1.5 s note — `renderMode: "offline"`, T60 `null` | ✅ | 228 |
| 6 | `render_audio` | 8 s held note — **T60 6551 ms** | ✅ | 309 |
| 7–10 | `render_audio` ×4 | velocity sweep 0.2/0.4/0.7/1.0 — **0.99 s wall** | ✅ | 216–247 |
| 11 | `update_parameters` | `osc1.unison 2`, `osc1.detune 7 ct` | ✅ | 6 |
| 12 | `render_audio` | detuned — **attackMs 8.70**, inharm 4.15e−05 | ✅ | 244 |
| 13 | `render_audio` | 6-note phrase, E4 restruck while ringing | ✅ | 260 |
| 14 | `save_preset` | "Plucked Piano Eval4" | ✅ | 3 |
| 15 | `list_presets` | 1 preset, total 1 | ✅ | 2 |
| 16 | `get_synth_state` | compact: 21 non-default params + 2 routes | ✅ | 5 |
| — | `POST /start` | `startedAfterCalls: 16`; tools **17 → 18** | — | — |
| 17 | `play_notes` | same phrase live — `retriggered: 3` | ✅ | 3015 |

**Only after `/start`:** `play_notes` exists at all — it is absent from `GET /tools` beforehand, which is the correct and honest way to gate it. Everything else I needed (full discovery, a 23-parameter patch, two modulation routes, eight offline renders with metrics, preset save/list, state verification) worked with no audio context and no human present.

## Final patch

`env1`: attack 2 ms, decay 3.50 s, sustain 0%, release 350 ms, dec_curve 0.60, rel_curve 0.50 · `filter1`: LP 24, cutoff 1.20 kHz, resonance 5%, keytrack 60% · `osc1`: Basic Shapes, morph 30%, unison 2v, detune 7 ct · `osc2`: on, +12 st, level 28% · `sub`: on, level 22% · `env2`: attack 1 ms, decay 900 ms, sustain 0%, dec_curve 0.60 · routes: `env2 → filter1.cutoff` 0.35, `velocity → filter1.cutoff` 0.15
