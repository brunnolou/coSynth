# coSynth WebMCP first-contact evaluation

Contamination: none. I did not inspect the coSynth project or any files beneath it.

I made one schema call (`get_parameter_schema` with compact format and all sources) to discover 224 parameters, their ranges/defaults/units/choices, modulation flags, 24 sources, and limits. I then applied 27 parameters atomically: a fast 4 ms amplitude attack, 2.8 s decay, zero sustain, 1.2 s release, bright LP24 filter, short filter envelope, two unison oscillator voices at 7 ct, a small harmonic layer, and restrained reverb. The two routes were `env2 -> filter1.cutoff` at 0.32 and `velocity -> master.volume` at 0.45.

`set_modulation` was unusually clear: `depth` is explicitly bipolar, added to the destination's normalized 0..1 value and clamped. It even gives a numerical example. I did not have to infer its scale.

| Measurement | Your result |
|---|---|
| Calls to learn the full parameter space | 1 |
| Calls before your first **successful** `update_parameters` | 2 |
| Total calls, and how many failed | 15 total; 1 failed |
| Did an offline render work before `/start`? `renderMode`? | Yes; `offline` |
| Wall clock for the 4-render velocity sweep | 30.243 s (client wall clock; harness render work totalled 878 ms) |
| Which loudness figure tracked velocity monotonically (if any) | `loudnessDb`: -23.764, -19.874, -15.342, -11.848 dB at 0.2/0.4/0.7/1.0. `rmsDb` and `peakDb` also rose monotonically. |
| `attackMs` reported with ~7-cent detune | 8.498 ms |
| Could you read a decay time? What value? | Yes; `decayT60Ms`: 2607.168 ms on the initial 7 s render (2451.642 ms on the later 4 s detuned render). |
| Could you read harmonic inharmonicity? What value? | Yes; `harmonics.inharmonicity`: -0.0000120648 on the initial render. |
| Did a repeated ringing pitch need a workaround? | Yes: before the gesture the tool was unavailable; after `/start`, one overlapping E4 retriggered successfully (`retriggered: 1`). No voice-management workaround was needed. |

The initial single C4 render succeeded before `/start`, with `renderMode: "offline"`, 8.463 ms attack, 2607.168 ms T60, and harmonic amplitudes plus inharmonicity. Its spectral windows also showed centroid movement (561.5 Hz initially, 474.1 Hz at 1.75–3.5 s), so both the level decay and harmonic structure were visible.

The required pre-gesture phrase attempt failed exactly as follows:

> No tool named play_notes is registered right now

That did tell me enough to fix the next attempt in one try: after `/start`, the same tool worked. A one-note `play_notes` also became available only after the gesture; the post-gesture six-note phrase completed in 2014 ms.

Saving `Evaluation Plucked Piano` worked. `list_presets` reported two user presets: `Plucked Piano eval3` and `Evaluation Plucked Piano`. Its descriptor correctly says factory presets are excluded, so this did not establish the factory-preset inventory.

## Assessment

I wasted call 11 trying `play_notes` before the gesture. Its absence from the original `GET /tools` response made the task instruction and the advertised surface conflict: I could only guess the tool name/input shape. The `render_audio` descriptor says only `play_notes` needs the gesture, but `/tools` did not expose `play_notes` or say that it is dynamically registered after `/start`. A descriptor or an availability entry before the gesture would have saved that call.

What I had to infer: the exact practical contour of `env2` as a modulation source (including how its envelope is applied over a note), and what sonic meaning to assign to oscillator `morph`, `blend`, `spread`, and the named wavetables. The schema supplied ranges/defaults but not those behavioral definitions. `depth` itself did not require inference: `set_modulation` stated its normalized relative meaning precisely.

I did not trust `timeToPeakMs: 467` on the initial render as an attack measurement because the same render reports `attackMs: 8.463`, while the patch attack is 4 ms and later comparable renders reported `timeToPeakMs: 12`. The 467 ms value is plausibly a later amplitude maximum caused by the unison/beating or processing, not the onset. I would not use it as attack time.

I still could not find the factory-preset names, because `list_presets` explicitly excludes them. Nor could I discover pre-gesture `play_notes` from the descriptors, or obtain semantic definitions for wavetable/morph/blend/spread behavior.

For designing to an unheard target, the surface is still missing target-facing controls/metrics such as perceptual brightness over time tied to named bands, partial-frequency trajectories and tuning, a clear oscillator wavetable/parameter semantic model, and a way to compare a candidate against a target without having to supply and personally interpret an audio reference. The supplied T60, harmonic amplitudes, inharmonicity, centroid windows, and velocity loudness are a useful base, but not enough to reliably identify or engineer a piano-like transient and timbral evolution.
