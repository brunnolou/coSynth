# coSynth WebMCP surface — first-contact evaluation

**Rule 1 compliance: not broken.** I never opened, listed, grepped or searched anything under `~/Projects/coSynth`, and I ran no filesystem search for tool names, parameter ids or defaults. Everything below comes from `GET /tools` and from what the tools returned. The only local files I read were `tools.json` etc. — my own saved copies of the harness's HTTP responses in `/tmp/eval2-claude`.

## Measurements

| Measurement | Result |
|---|---|
| Calls to learn the full parameter space | **1** tool call (`get_parameter_schema` with `format:"compact"`, `sourceLimit:60`) after 1 `GET /tools`. Returned all 224 parameters with units/ranges/curves/defaults/`mod` flags, all 24 modulation sources, and a `limits` block, in one response. |
| Calls before first **successful** `update_parameters` | **2** (harness: `callsToFirstSuccessfulUpdateParameters: 2`). It succeeded on the first attempt, applying 18 parameters atomically. |
| Total calls, and how many failed | **33 total, 1 failed** (harness summary). |
| Offline render before `/start`? `renderMode`? | **Yes.** `renderMode: "offline"`, `renderModeFallback: null`, 48 kHz stereo, ~180–260 ms per render. Worked from call 5, gesture not dispatched until call 30. |
| Wall clock for the 4-render velocity sweep | **0.80 s** (first attempt); **0.81 s** on the repeat. ~185 ms per render. |
| Loudness figure tracking velocity monotonically | On the **second** sweep, all three — `peakDb` (−22.67 → −18.87 → −14.53 → −11.14), `rmsDb` and `loudnessDb` — were monotonic. On the **first** sweep the same three were monotonic for 0.2/0.4/0.7 and then the v=1.0 render returned **−160 dB (silence)** with `ok:true`. See "What I did not trust". |
| `attackMs` with ~7-cent detune | **7.04 ms** (vs 6.29 ms undetuned). `attackMs` was **not** fooled by the beat. `timeToPeakMs` was: it jumped **62 ms → 308 ms**, and `envelopeDb` went from a clean decay to a visible ripple (`-11.5, -5, -0.1, -5.9, -2.9, -5.5 …`). |
| Could I read a decay time? Value? | **Yes, conditionally.** `decayT60Ms` was `null` on every 1.5-s note. With an 8-s held note it read **4321 ms**, and **3664 ms** after I shortened `env1.decay` to 2.2 s (3813 ms with unison detune on). |
| Could I read harmonic inharmonicity? Value? | **Yes**, on single-pitch renders: `harmonics.inharmonicity` = **−1.2e-06** (final patch); −3.3e-06 and −4.5e-06 on earlier renders. Effectively zero, and negative, which is unexplained. `harmonics.amplitudesDb` was genuinely useful: it showed my first patch was odd-harmonics-only (square-like: `0, -120, -20.4, -108.1, …`) and the corrected one a proper saw series (`0, -10.6, -12.3, -16.6, …`). |
| Did a repeated ringing pitch need a workaround? | **No.** `render_audio` accepted an arpeggio whose E4 was restruck by a chord 0.95 s later, with no error and no de-duplication needed. `play_notes` went further and reported `retriggered: 1` explicitly. |

## The patch

18 parameters in one atomic call, later refined: `env1` attack 2 ms / decay 2.2 s / sustain 0% / release 250 ms / dec_curve −0.20; `filter1` LP 24 at 4.5 kHz, resonance 8%, keytrack 50%; `osc1` Basic Shapes, morph 55%, unison 2v, detune 7 ct; `env2` 1 ms / 800 ms / sustain 0 as the brightness envelope. Two routes: `env2 → filter1.cutoff` depth 0.28, `velocity → osc1.level` depth 0.4. Final verified render: attack 6.3 ms, T60 3.66 s, no sustain, centroid 552 Hz. Saved as "Plucked Piano E1"; `list_presets` confirmed exactly that one preset.

## Errors encountered

One failure, verbatim:

> `Unexpected input property 'source'. Accepted: action, slot, depth, enabled`

**It told me enough to fix it in one try** — I re-sent with `slot: 1` and it worked. But the call should never have failed: `set_modulation`'s `inputSchema` declares `source` and `destination` as valid top-level properties with no indication that they are `add`-only, and the description's single example is an `add`. The per-action property sets are enforced by the server and are absent from the schema.

## Where I wasted a call, and what would have saved it

That `set_modulation` `update` call is the only outright wasted one. A one-clause addition to the description — "`update`/`remove` address a route by `slot`, not by source/destination" — or a schema that expressed the per-action shape (a `oneOf`) would have saved it.

The larger waste was not a failed call but a wrong-model call: my first render was dark and wrong (centroid 336 Hz, odd harmonics only) because I guessed `osc1.morph` 0.3 on "Basic Shapes". Nothing in the schema says what the morph axis traverses — `osc1.morph 0..1 =0 mod` is the entire specification, and the wavetable choices are bare names. I burned a render, read the harmonics, and re-guessed 0.55. Naming the endpoints (e.g. "sine → triangle → saw → square") would have saved a render-and-correct cycle.

I also spent four calls (14–17) chasing the v=1.0 silence into a dead end, because the render reported success. See below.

## What I had to infer that should have been stated

- **`render_audio.decayT60Ms` returns `null` with no reason.** I had to infer that the note must be held long enough for the envelope to fall 60 dB — with `env1.decay` 2.2 s and a 1.5 s note it is simply `null`. For an instrument defined by its decay, this is the single most important metric, and its most common value is an unexplained null. It should say why, or measure the post-release tail.
- **`render_audio` `start` and `duration` units.** The schema gives bare numbers with no unit; `play_notes` states "in seconds" in its description, `render_audio` never does. I assumed seconds.
- **`update_parameters`: whether an unrecognised id fails the whole batch.** It is called "atomically validate and apply", which I read as all-or-nothing, but that is my reading of one adverb.
- **`env1.dec_curve` sign convention.** `-1..1 =-0.4` with no units. At −0.7 my "3 second decay" was audibly flat for 1.5 s (envelope fell 1.9 dB); at −0.2 it decayed properly. Which end is concave is unstated, and it silently defeated the plucked shape I was trying to build.
- **`set_modulation` `depth`, in contrast, was stated well** — "added to the destination's normalized 0..1 value and the sum is clamped, so depth 0.5 on a parameter sitting at 0.5 sweeps it up to 1.0" told me exactly what I needed. For an exponential parameter I still had to compute the normalized position of 2 kHz on a 20–20000 exp curve myself to predict where the sweep landed; the schema gives the curve type, so this is fair, but a `normalized` echo in `get_synth_state`'s compact output would remove the arithmetic. (`update_parameters` does echo `normalized` — that is how I checked.)
- **`play_notes` exists but is not in `GET /tools` before the gesture** (17 tools; 18 after). Meanwhile `render_audio`'s description says "only `play_notes` needs that gesture", referring to a tool a cold client cannot see. That is genuinely confusing on first contact: the obvious reading is that the tool is missing, not gated.

## What I did not trust

**The first velocity sweep.** Call 9 — velocity 1.0, identical in every other respect to calls 6–8 — returned `peakDb`, `rmsDb` and `loudnessDb` all at exactly **−160 dB**, `spectralCentroidHz` 0, `attackMs` 0, and `ok: true` in 167 ms. The harness logged it as a success.

I did not trust it, and chasing it cost me four calls: velocity 0.99 rendered fine (−11.25 dB), velocity 1.0 with the mod depth lowered rendered fine, and `osc1.level` at exactly 1.0 rendered fine. So none of my hypotheses held. I then restored the exact original state and re-ran the identical sweep: calls 19–21 came back **bit-identical** to calls 6–8 (−22.67 / −18.87 / −14.53), and call 22 at v=1.0 came back at −11.14 dB, perfectly monotonic.

So the renders are deterministic, and one of them nevertheless returned digital silence and called it success. **I am reporting both attempts; the monotonic result is the second one.** An agent tuning by measurement here can be handed a silent render with no error and no way to know, and if it had happened on a single verification call instead of inside a sweep, I would have concluded the patch was broken and "fixed" a sound that was already correct.

Two smaller doubts: the negative `inharmonicity` (−1.2e-06 — sign meaningless at that magnitude, but why negative at all?), and a +23 dB jump in `envelopeDb` at ~2.5 s in the arpeggio render, right where the first three notes release. I could not resolve either through the tools.

## What I could not find out through the tools at all

- **What `osc1.morph` morphs between**, for any of the seven wavetables. Only discoverable by rendering and reading harmonics.
- **Whether `velocity` is hardwired to amplitude.** The `groupNotes` say `env1` is the only hardwired modulator and that `env2..env6`/`lfo1..8` do nothing until routed — but `velocity` is listed as a source alongside them and is not covered by either statement. I routed `velocity → osc1.level` defensively without ever learning whether it was redundant.
- **Whether the restruck E4 got a new voice or stole the ringing one.** `play_notes` answers this (`retriggered: 1`); `render_audio` does not report it, and no metric distinguishes the two.
- **Any per-voice or per-note measurement.** Every metric is a mix-bus summary, so in a chord I cannot attribute anything to a note.
- **What the curve shapes actually do** (`atk_curve`/`dec_curve`/`rel_curve`), beyond the empirical fact that −0.7 nearly flattened my decay.

## Designing to a target I cannot hear — what is still missing

The metric set is better than I expected: `attackMs`, `decayT60Ms`, `harmonics.amplitudesDb`, `spectralCentroidHz` and `loudnessDb` let me steer a plucked patch by number alone, and `attackMs` proved robust against the detune beat that fooled `timeToPeakMs`. Three things are missing:

1. **A decay I can always read.** `decayT60Ms` null-by-default is the biggest gap. A decay-rate figure valid over any window — dB/second over the sustained portion — would work regardless of note length.
2. **Brightness as a function of time.** I built an `env2 → cutoff` route specifically so the tone would darken as it decays, and there is no way to verify it happened: `spectralCentroidHz` is one number for the whole render. A centroid trajectory alongside `envelopeDb` would make that route measurable instead of hopeful.
3. **A trustworthy success signal.** A silent render returning `ok:true` undermines every number above it. A render that produced no audio should say so.

Also, for a *piano* specifically: `inharmonicity` reads ~0 and there is no parameter that would make it nonzero. Real piano partials are stretched, and neither the synth nor the metric gives me a way to aim at that.

## Harness summary (verbatim counts)

```
totalCalls: 33
failedCalls: 1
callsToFirstSuccessfulUpdateParameters: 2
discoveryCalls: 2
startGestureDispatchedAtCall: 30
pageErrors: []
per-tool: render_audio 17 (0 failed) · set_modulation 6 (1 failed) · update_parameters 5 (0 failed)
          get_parameter_schema 1 · get_synth_state 1 · save_preset 1 · list_presets 1 · play_notes 1
```
