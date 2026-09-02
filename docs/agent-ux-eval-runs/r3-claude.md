# coSynth WebMCP tool surface — first-contact evaluation

**Rule 1 compliance: not broken.** I never opened, listed, grepped or otherwise touched anything under `~/Projects/coSynth`, and I did not grep the disk for tool names, parameter ids or defaults. Everything below comes from `GET /tools` and from what the tools returned. Working directory throughout: `/tmp/eval3-claude`.

## Measurements

| Measurement | Result |
|---|---|
| Calls to learn the full parameter space | **1** (`get_parameter_schema` with `format:"compact"`, `sourceLimit:60`) |
| Calls before first **successful** `update_parameters` | **1** (harness: `callsToFirstSuccessfulUpdateParameters: 2`, i.e. the update was call 2) |
| Total calls, and how many failed | **24 total, 0 failed** |
| Did an offline render work before `/start`? `renderMode`? | **Yes**, on call 5. `renderMode: "offline"`, `renderModeFallback` absent |
| Wall clock for the 4-render velocity sweep | **0.905 s** for all four (calls 10–13, 217/221/211/198 ms each) |
| Which loudness figure tracked velocity monotonically | **All three.** `loudnessDb` -33.45 → -28.95 → -25.05 → -23.28; `rmsDb` -37.08 → -32.58 → -28.68 → -26.92; `peakDb` -19.15 → -12.28 → -10.95 → -9.50 |
| `attackMs` reported with ~7-cent detune | **6.30 ms** (vs 5.78 ms undetuned). No masquerade |
| Could you read a decay time? What value? | Yes, but **I don't trust it**. `decayT60Ms` = 4625 ms on the patch whose own `envelopeDb` in the same payload crosses -60 dB at ~2.5 s |
| Could you read harmonic inharmonicity? What value? | Yes. `metrics.harmonics.inharmonicity` = **-4.5e-08** (≈ 0), and ~-1e-06 on every other single-pitch render |
| Did a repeated ringing pitch need a workaround? | **No.** Overlapping duplicate pitches accepted as-is; the result reported `retriggered: 3` |

## What I built

Patch v1 (call 2) applied 21 parameters in one atomic call and every one landed: `Basic Shapes` osc1 + an `FM Bell` osc2 at +12 st, `env1` 2 ms attack / 0 % sustain / long decay, `LP 24` with 60 % keytrack, `env2` as a fast filter envelope. Two routes: `env2 → filter1.cutoff` and `velocity → osc2.level`.

Measuring v1 showed it was wrong in one respect I could see and fix: `envelopeDb` was flat within 2 dB for two seconds and then fell off a cliff, which is not a piano. I had set `env1.dec_curve: -0.6` guessing negative meant "exponential/fast-first"; it means the opposite. Patch v2 (call 7) flipped it to `+0.6` and opened up the brightness range. v2 measured as a genuine plucked tone: `attackMs` 5.78, `timeToPeakMs` 9, `sustainDb` -100, a monotonically falling `envelopeDb`, and centroid falling 561 → 455 Hz across the spectral windows. **The figures reported in the table are from v2, except the `dec_curve` finding, which is from v1.**

Final phrase test: C-E-G arpeggio with a chord restriking all three pitches at 1.2 s while they were still ringing. `retriggered: 3`, `timeToPeakMs: 1209` correctly locating the restrike.

`save_preset` → `{"saved": true}`; `list_presets` → exactly the one preset, `total: 1`. Both first-try.

## The gesture

`toolCount` went **17 → 18** at `/start`. `play_notes` does not exist as a descriptor before the gesture — it is not a tool that fails with a helpful error, it is simply absent. That is the right design, but it means an agent reading `/tools` cold cannot see that live playback is even a capability, and the task instructions naming `play_notes` were the only reason I knew to look for it. `render_audio` in `mode:"realtime"` also only works after the gesture; post-gesture it returned `renderMode: "realtime"` and blocked for 3065 ms, versus ~220 ms for the same 3 seconds offline. `play_notes` blocked 2722 ms for a 2.7 s phrase.

## Where I wasted calls

**Three calls (20, 21, 22) reading back two modulation routes I already knew.** `get_synth_state`'s description says "Runtime, modulation routes, and FX order are returned by default." They are not. `format:"compact"` returns `modulationCount: 2` and no routes; the default format returns `modulationCount: 2` and no routes. You must pass `modulationLimit` explicitly, and the payload key is `modulations`, not the `modulation` the description's wording implies. Removing the words "modulation routes" from that sentence, or actually returning them, saves two round trips. The same shape bit me on `lfo`: the key is `lfoShape`, not `lfo`.

**One call (6) confirming a suspicion the metric name created.** `decayT60Ms` came back 1677 ms on a patch with `env1.decay = 3500 ms`, so I re-rendered the identical patch with a 5 s note instead of a 1 s note and got 5142 ms. The field is a T60 of the rendered tail, which is legitimate, but nothing in `render_audio`'s description says the note's own `duration` and `env1.release` dominate it. One clause — "measured from the render, not from `env1.decay`" — saves that call.

**One call (9) re-rendering after fixing `dec_curve`.** That one is on the schema: `env1.dec_curve -1..1 =-0.4` with no unit and no semantics. I had a 50/50 guess on the sign and lost it.

Against that: learning 224 parameters with units, ranges, defaults, curves, choice labels and per-parameter `mod` flags plus all 24 modulation sources in **one** call is excellent, and it is the single biggest thing this surface gets right. The compact one-line format (`filter1.cutoff Hz 20..20000 exp =8000 mod`) is dense enough to read and complete enough to act on. `update_parameters` accepting 21 mixed numeric and textual-label values atomically, echoing back `raw`/`normalized`/`formatted` for each, meant I never had to probe a single value.

## What I had to infer that should have been stated

- **`env1.dec_curve` / `atk_curve` / `rel_curve` sign** (`get_parameter_schema`). Nothing says which end is convex. I guessed wrong and paid two calls.
- **`osc1.detune` is ±the stated value, not total spread** (`get_parameter_schema`, `osc*.detune`). At 7 ct on 2 unison voices the beat minima in `envelopeDb` sit ~437 ms apart, i.e. ~2.3 Hz, which is the beat of ~14 cents at C4, not the ~1.06 Hz that 7 cents total would give. So "7 ct" is a per-voice deviation. The unit `ct` does not tell you that, and neither does `osc1.spread`, whose relationship to `detune` I still cannot state.
- **`render_audio`'s `retriggered` field.** It is the single most useful thing in the phrase result and it appears in neither the description nor the schema. I only found it because I dumped the whole payload.
- **`velocity` is hardwired to amplitude.** `get_parameter_schema`'s `groupNotes` says "env1 … is the only hardwired modulator" and that non-env1 sources "do nothing until routed". But `peakDb` moved 9.6 dB across the velocity sweep and my only velocity route was to `osc2.level`, a 25 %-level oscillator. Velocity is clearly reaching voice gain without a route. The note is actively misleading on this, and it is the one modulator whose behaviour a patch designer most needs to know.
- **`spectralWindows` resolution is `duration/4`.** Not stated anywhere. It means "brightness that falls with time" is only observable at 4 points, and on a 6 s render three of those points were silence.

## What I did not trust

**`decayT60Ms`.** On patch v2 it reported 4625 ms while `envelopeDb` in the same response reached -100 dB by index 27 of 64 over a 6 s window, i.e. ~2.5 s. Those two numbers cannot both describe the same audio. I suspect an early-slope extrapolation rather than a measured -60 dB crossing, but I could not confirm that through the tools, and for an instrument defined by its decay that is the one number I most needed to believe. I ended up reading decay off `envelopeDb` by hand instead — which worked, and is the honest answer to "could you read a decay time": yes, from the array, not from the field named for it.

**`spectralRolloffHz`.** It returned exactly `527.34375` on four renders with visibly different spectra — including one where `spectralCentroidHz` was 558.9, i.e. the centroid sat *above* the rolloff. A rolloff below the centroid is not physically sensible for any of the usual definitions, and a bit-exact constant across different patches suggests it is pinned to a bin rather than measured.

**`sustainDb: -100`.** Correct here, but it is also what you would get from a silent render, so it carries no information about whether the patch is right or the render failed. The harness's own `silentRenders: 0` counter existing at all suggests silent renders are a known failure mode; the metric block gives an agent no way to distinguish "no sustain, as designed" from "nothing came out".

## What I could not find out through the tools at all

- **How to write an LFO shape.** `get_synth_state` with `lfo:1` happily returns `lfoShape` as breakpoints (`{x,y,power}` — three of them, a triangle). There is no `lfo*.shape` among the 224 parameters and no tool that accepts breakpoints. The shape is readable and, as far as the tool surface goes, unwritable. `power` is undocumented.
- **What `osc1.morph` actually morphs to.** `{Basic Shapes|Harmonic Sweep|PWM|Vocal|FM Bell|Digital|Custom}` names a table; `morph 0..1` traverses it blind. Going from 0.35 to 0.75 changed harmonic 3 from -20.1 to -12.5 dB, which I only learned by rendering. There is no way to ask what a wavetable contains, so every timbre choice is an empirical probe. This is the most expensive gap in the surface for sound design.
- **How to load a factory preset.** `load_preset` and `list_presets` both explicitly exclude them. I can see there is a UI dropdown of factory presets and I cannot enumerate or load one, so I cannot use the instrument's own piano-adjacent starting points.
- **Whether any per-partial or stretch tuning exists.** `inharmonicity` is *reported* but nothing in the 224 parameters plausibly sets it, and it read ≈0 (-4.5e-08 to -7.7e-06) on every render including the detuned one. A metric you can measure but not steer.

## Designing to a target I cannot hear — what is still missing

Three things.

**A trustworthy decay number.** I am building an instrument whose identity *is* its decay, and the field called `decayT60Ms` disagrees with the envelope beside it. I want a decay measured at a stated definition, ideally per-band, and I want it attributed: how much of this tail is `env1.decay` and how much is note-off release. Right now the only way to separate them is to render the same patch at two note lengths and diff — which is exactly the call I wasted.

**Time-resolved brightness at a useful resolution.** "Brightness that falls with time" is the whole character of a struck string, and `spectralWindows` gives me four samples of it, sized by total render length, three of which were silence on a 6 s render. A fixed-size window (say 100 ms) or a per-window harmonic tilt figure would let me actually shape the fall instead of confirming it went down at all.

**Reachability of the metrics I am shown.** `inharmonicity` and `spectralFlatness` are reported but not settable; `morph` is settable but its effect is undiscoverable. That asymmetry is what makes this surface expensive: the loop is always render-and-look rather than read-and-decide. The parameter schema is genuinely one of the best I have met — one call, complete, unambiguous on ranges. The measurement side has not been built to the same standard, and for a target I cannot hear, the measurement side is the only side I have.

## Errors

None. Zero failed calls out of 24, so I have no verbatim error messages to report and no data on error quality. I did not force failures to generate them. The one thing that behaved like an error — `get_synth_state` returning no routes — returned `ok: true` with a silently absent field, which is worse than an error message: nothing told me I had asked wrongly, so I re-asked twice.

## Harness summary (verbatim)

```
totalCalls: 24
failedCalls: 0
callsToFirstSuccessfulUpdateParameters: 2
discoveryCalls: 5
silentRenders: 0
startGestureDispatchedAtCall: 18
pageErrors: []
perTool: get_parameter_schema 1 | get_synth_state 4 | list_presets 1 | play_notes 1
         render_audio 10 | save_preset 1 | set_modulation 3 | update_parameters 3
```
