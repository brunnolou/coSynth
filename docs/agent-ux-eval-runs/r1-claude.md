# coSynth WebMCP surface — first-contact evaluation

**Rule 1 compliance:** I did not read anything under `~/Projects/coSynth`, and did not grep for tool names, parameter ids or defaults anywhere on disk. Everything below came from `GET /tools` and from tool return values. Working directory was `/tmp/eval-claude` throughout.

## Measurements

| Measurement | Result |
|---|---|
| Calls to learn the full parameter space | **1** (`get_parameter_schema {format:"compact"}` returned all 224 params with unit/range/curve/default/moddable). Harness counted 4 discovery calls total; 2 of the extra 3 were me hunting for the modulation **source** list, which no tool exposes. |
| Calls before first **successful** `update_parameters` | **5** (harness: `callsToFirstSuccessfulUpdateParameters: 5`) — 19 parameters applied in one batch, first try, zero rejects. |
| Total calls / failed | **21 total, 0 failed** (harness summary). One malformed request never reached a tool (my own missing `}` in the curl body) so it is not in the log. |
| Offline render before `/start`? `renderMode`? | **Yes.** `renderMode: "offline"`, 255 ms, before any gesture. No fallback. |
| Wall clock, 4-render velocity sweep | **0.84 s** for all four (191–207 ms each) |
| Loudness figure monotonic with velocity | **All three.** peakDb −19.04 → −15.83 → −13.14 → −11.00; rmsDb −27.37 → −24.53 → −21.50 → −19.27; loudnessDb −24.95 → −22.12 → −19.08 → −16.85 (v = 0.2/0.4/0.7/1.0) |
| `attackMs` with ~7-cent detune | **5.83 ms** (undetuned: 6.57 ms). The beat did **not** masquerade as a slow attack in `attackMs`. It *did* fool `timeToPeakMs`: 181 ms → **332 ms**, and `envelopeDb` shows the ~1 Hz ripple plainly. |
| Decay time readable? | **Yes, conditionally.** `decayT60Ms = 5145 ms` on a note long enough for the decay to run. On my first render (1.5 s note, 3.5 s decay) it was `null` with no reason given. |
| Inharmonicity readable? | **Yes.** `−9.6e−8` clean, `6.7e−5` with the 7-cent detune. Only on single-pitch renders (documented). |
| Repeated ringing pitch need a workaround? | **No.** Two overlapping `midi: 64` events were accepted silently. But see caveat below — I could not verify the restrike actually retriggered. |

## Patch built

19 params in one call: `osc1.wavetable=Basic Shapes`, `osc1.morph=0.18`, `osc1.level=0.7`, `env1.attack=2 ms`, `env1.decay=3.5 s`, `env1.sustain=0`, `env1.release=350 ms`, `env1.dec_curve=−0.6`, `filter1.type=LP 24`, `filter1.cutoff` (4.5 kHz, later 1.3 kHz), `filter1.resonance=0.1`, `filter1.keytrack=0.5`, `env2.{attack,decay,sustain,release}`, `sub.{enabled,level,octave}`. Routes: `env2 → filter1.cutoff` depth 0.35, `velocity → filter1.cutoff` depth 0.2. Saved as `Plucked Piano Eval`; `list_presets` confirmed it, total 1.

## Where I wasted calls

- **Two calls hunting the modulation source list.** `get_parameter_schema` has `sourceOffset`/`sourceLimit` in its `inputSchema`, so I called it with `sourceLimit: 60` (call 3) — the response has no sources key at all in `compact`, and none in `full` either (call 2). I then tried `get_synth_state {format:"full"}` (call 4) because its description promises "modulation routes"; that returns *existing* routes, not the source vocabulary. **What would have saved them:** either make `sourceLimit` actually emit sources, or say in `set_modulation`'s description what the legal `source` values are. As it stands the only source name an agent has is `lfo1`, from the example string.
- **One wasted render** (call 9): `decayT60Ms: null` because my note was shorter than the decay. Nothing in `render_audio`'s description warns that a decay metric needs the gate held open, and `null` carries no reason.

## What I had to infer that should have been stated

- **`env1` is the amplitude envelope.** Nothing says so. `get_parameter_schema` gives every one of `env1`–`env6` the identical name set (Delay/Attack/Hold/Decay/Sustain/…); only `env1`'s *defaults* (2 ms attack, 0.8 sustain vs `env2`'s 0.5) hint that it is hardwired to the VCA. Every amplitude decision I made rests on that guess.
- **`start` and `duration` units in `render_audio.notes`.** Neither the schema nor the description says seconds. `master.bpm` exists, so beats was a live possibility. I assumed seconds and the results were consistent with it.
- **`envelopeDb` frame count and spacing.** 64 values, no field saying they span `duration`, no field saying what 0 dB is relative to. I inferred 64 equal frames over the render and peak-relative dB.
- **`attackMs` vs `timeToPeakMs`.** Two attack numbers, neither defined. I only worked out that `attackMs` is threshold-based and `timeToPeakMs` is literal-argmax by watching them diverge under detune — that is the kind of thing one clause in the description would fix.
- **`play_notes` does not exist until `/start`.** `GET /tools` returns 17 descriptors cold and 18 after the gesture. Three descriptions (`render_audio`, `replay_history`, `stop_performance`) reference `play_notes` by name while it is unlistable. I guessed its input matched `render_audio.notes` and it worked first try — that was luck, not discovery. A cold-page agent has no schema for it.

## What I did not trust

- **The `velocity → filter1.cutoff` route.** `set_modulation` accepted `source: "velocity"` and returned it in slot 1 as `enabled: true`, but across the velocity sweep `spectralCentroidHz` moved 288 → 290 Hz. A depth of 0.2 on a normalized cutoff at 0.604 should walk 1.3 kHz up toward ~2.8 kHz — an unmissable centroid shift. Either the source name is silently accepted and unbound, or the route works and the centroid is pinned by the fundamental. **I cannot tell which through the tools**, and that is the worst finding here: `set_modulation` validated a string I invented and gave me a success object for it.
- **`decayT60Ms = 5145 ms` against `env1.decay = 3.5 s`.** A 47% overshoot. `dec_curve = −0.6` could plausibly stretch the tail to −60 dB, but with no definition of what T60 is measured between, I cannot use this number to hit a decay target — only to compare two renders of my own.
- **`sustainDb = −100`** on a patch with `env1.sustain = 0` is right, but the same field read `−4.03` on the polyphonic phrase, where "sustain" of a six-note arpeggio means nothing in particular.

## What I could not find out at all

1. The legal `source` values for `set_modulation`, and whether a given route is actually doing anything.
2. Which envelope is bound to which destination by default (the VCA assignment).
3. Whether the restruck E4 allocated a new voice or reused/stole the ringing one. `render_audio` returns no voice count; `get_synth_state.runtime.voices` reads the *live* engine and was 0 during offline render. So step 8 "needed no workaround" only means "was not rejected".
4. What `filterRouting` contains — it is in the `groups` list but no parameter in the 224 carries that prefix.
5. Per-note or per-voice metrics of any kind. All metrics are whole-buffer, so in a phrase I cannot ask "how did *that* note decay".

## Designing to a target I cannot hear — what is missing

The metric set is good for **A/B**: render, change one thing, render, compare. It is weak for **absolute targeting**, which is what designing blind requires. Three specific gaps:

- **No time-anchored envelope.** `envelopeDb` is 64 undated numbers. I want `[{tMs, db}]`, or a stated frame interval, so I can say "at 800 ms the note is 12 dB down" — the actual language of a piano decay. `decayT60Ms` is one scalar that goes `null` exactly when the decay is longer than the gate.
- **No harmonic trajectory.** `harmonics.amplitudesDb` is one snapshot of the whole buffer. A piano's defining feature is that its brightness *falls with time*, and I asked for exactly that with `env2 → cutoff`. I have no way to see it: I would need `harmonics` or `spectralCentroidHz` sampled in a few time windows. As it is, my brightness-decay route is unverified and possibly, per the velocity finding, unbound.
- **No effect confirmation on modulation.** `set_modulation` should report either the source's resolved identity or the destination's realized min/max under the route. A success response for an invented source name means every mod route I add is faith-based.

The parts that were plainly good, without padding: 224 parameters with units, ranges, curves and moddability in **one** call; a 19-parameter atomic batch accepted first try with normalized+formatted echo for each; and offline render at ~200 ms on a cold page with no gesture, 15× faster than the 3083 ms realtime equivalent and agreeing with it within 0.8 dB on loudness. That last one is the single best thing about this surface — it makes the measure-verify loop cheap enough to actually use.
