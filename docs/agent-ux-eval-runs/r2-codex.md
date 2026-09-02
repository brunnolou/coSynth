# coSynth WebMCP first-contact evaluation

I did not inspect the coSynth project or any of its files. I used only `GET /tools`, calls through the harness, and the returned results.

I paged `get_parameter_schema` four times to read all 224 parameters and the 24 modulation sources. The compact descriptor was legible enough to select a patch. I applied 13 parameters together: FM Bell oscillator, 2-voice unison, a 2 ms / 3.5 s / zero-sustain amplitude envelope, 7.5 kHz filter, and low pink noise. I then configured env2 (2 ms attack, 2 s decay, zero sustain) and routed it to filter cutoff at +0.35, plus velocity to osc1 level at +0.3. The `set_modulation` description did state depth precisely: bipolar −1..1, added to the destination's normalized 0..1 value and clamped. I did not have to infer its reference.

| Measurement | Your result |
|---|---|
| Calls to learn the full parameter space | 4 (`get_parameter_schema`, 224 parameters over four 60-item pages) |
| Calls before your first **successful** `update_parameters` | 5 |
| Total calls, and how many failed | 19 total; 0 failed (harness summary) |
| Did an offline render work before `/start`? `renderMode`? | Yes; `offline` |
| Wall clock for the 4-render velocity sweep | 32.231 s agent wall clock (first decision to final result); 22.163 s from harness timestamp of first call start to final render completion |
| Which loudness figure tracked velocity monotonically (if any) | None across all four: loudness dB was −21.303, −18.281, −160, −12.009 at 0.2/0.4/0.7/1.0 |
| `attackMs` reported with ~7-cent detune | 5.970 ms (with `timeToPeakMs` 250 ms) |
| Could you read a decay time? What value? | Yes: `decayT60Ms` 2164.660 ms on the first render (2279.116 ms after 7 ct detune) |
| Could you read harmonic inharmonicity? What value? | Yes: 0.000089277 on the first render (0.000103054 after 7 ct detune) |
| Did a repeated ringing pitch need a workaround? | No. The rendered E4/chord phrase returned `retriggered: 1`. |

The first offline render, before `/start`, succeeded: peak −8.773 dB, loudness −14.466 dB, `attackMs` 6.349 ms, and both the harmonic series and inharmonicity were returned. The 7-cent unison retest also succeeded. The post-gesture `play_notes` call completed three notes in 1.1 s.

The velocity sweep produced a bad but successful third result at velocity 0.7: silence by every reported measure (`peakDb`, `rmsDb`, and `loudnessDb` all −160; `decayT60Ms: null`). I did not retry it. Consequently no loudness measure can honestly be called monotonic, even though 0.2 → 0.4 → 1.0 increased normally.

## Friction and trust

I wasted no discovery call beyond pagination, but four discovery calls were required because compact schema pages cap at 60 items. A higher maximum or an explicit export-all mode would have saved three calls. The parameter descriptor did announce this 60-item cap through the schema, so it was not misleading; it is simply expensive for first contact.

I had to infer the musical meaning of several fields. `env1.dec_curve` and `env2.dec_curve` report only a normalized-looking range of −1..1, not what endpoints mean perceptually or mathematically. The parameter schema also calls `osc1.detune` `ct 0..100` but does not say whether that is the individual unison spread, a symmetric range, or a one-sided offset. `set_modulation.depth`, in contrast, was well specified.

I did not trust `attackMs` as a complete account of perceived onset: an explicitly 2 ms envelope measured about 6 ms, while `timeToPeakMs` was 144 ms initially and 250 ms with 7 ct detune. Those numbers may be valid measurements of different things, but the tool does not define the attack algorithm or explain why a slow unison beat does or does not influence it. I also do not trust the sweep as a reliable velocity characterization because the 0.7 result was silent with `ok: true` and no error. The repeated-note phrase had 17 clipped samples, which is another reason the phrase-level figures are not clean timbral evidence.

There were no failed tool calls, hence no error strings to quote or assess. The only disappointing result was the silent but successful velocity render; it provided no diagnostic or recovery hint.

## What the tools still do not reveal

`GET /tools` did not list `play_notes` at all, despite the task's post-gesture call succeeding. A first-time agent could not discover the only live performance tool from the stated surface. The tools also cannot establish audible sound quality without requesting Base64 audio and an audio-capable listener; metrics do not state perceived brightness trajectory, piano realism, transient character, or whether the 7-cent beat is musically objectionable. For designing to an unheard target, I would still need target-level temporal spectral measurements (brightness over time), a defined attack/decay measurement method, per-voice/retrigger and voice-steal telemetry, deterministic render status/seed, and a clear mapping from modulation depth to raw units for exponential parameters such as cutoff.

Saved presets confirmed by `list_presets`: `Plucked Piano E1` and `Evaluation Piano Pluck` (the latter created in this run). The harness reported no page errors.
