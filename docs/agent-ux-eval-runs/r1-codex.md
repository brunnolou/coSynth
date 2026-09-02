# coSynth WebMCP first-contact evaluation

I did not read or inspect any coSynth project file. I used `GET /tools` and the tool results only.

I made one compact `get_parameter_schema` call to learn the space. It returned 224 parameters, their raw ranges, units, defaults, choices, curves where applicable, and `mod` markers. I then applied a 24-parameter patch in one successful `update_parameters` call: a two-voice, 7-cent-detuned Harmonic Sweep oscillator plus an octave-up FM Bell, 3 ms amplitude attack, 3.2 s decay, zero sustain, 800 ms release, a 7.2 kHz low-pass filter, and restrained reverb. I added `env2 -> filter1.cutoff` at `0.45` and `lfo1 -> osc1.pan` at `0.08`.

The `set_modulation` description made `depth` unusually clear. It explicitly says depth is bipolar, added to the destination's normalized 0..1 value, then clamped. I did not have to infer its scale.

| Measurement | Your result |
|---|---|
| Calls to learn the full parameter space | 1 |
| Calls before your first **successful** `update_parameters` | 2 |
| Total calls, and how many failed | 14 total, 0 failed |
| Did an offline render work before `/start`? `renderMode`? | Yes. `offline` |
| Wall clock for the 4-render velocity sweep | 31.851 s end to end. The four harness render times totalled 877 ms. |
| Which loudness figure tracked velocity monotonically (if any) | `loudnessDb`: -32.408, -29.647, -26.670, -24.445 dB for velocity 0.2, 0.4, 0.7, 1.0. `rmsDb` and `peakDb` also rose monotonically. |
| `attackMs` reported with ~7-cent detune | 8.215 ms |
| Could you read a decay time? What value? | Yes. `decayT60Ms`: 1560.746 ms on the first single-note render. |
| Could you read harmonic inharmonicity? What value? | Yes. `harmonics.inharmonicity`: -0.0000010701 on the first render. |
| Did a repeated ringing pitch need a workaround? | No. I sent E4 at 0 s for 2 s and again at 1 s in a chord. Render succeeded and returned `retriggered: 2`. |

The first offline C4 render, before `/start`, worked and returned `renderMode: "offline"`. Its first-note metrics included `attackMs: 10.110`, `decayT60Ms: 1560.746`, and harmonic amplitudes plus inharmonicity. The 7-cent test was a second render with the already configured `osc1.unison: 2` and `osc1.detune: 7 ct`; it reported 8.215 ms attack. That does not expose a slow 1 Hz beating artefact as a slow attack, at least in the returned attack metric.

I saved `evaluation-plucked-piano`. `list_presets` returned it and the pre-existing `Plucked Piano Eval`; it explicitly excludes factory presets. After `POST /start`, `play_notes` was successful with three notes, `duration: 1.3`, and `completed: true`. Offline render was the useful pre-gesture facility. Live playback was the thing that depended on the gesture.

## Failures and wasted calls

No harness tool call failed. My first shell submission of the batch did not reach the harness because of a local quoting mistake: `zsh:1: unmatched '`. I resent the exact same patch and it became harness call 2. Since the tool never saw that request, it is not part of the harness failure count.

I did not waste a discovery call. The compact schema was enough to identify every editable parameter, range, default, unit, choices, and modulation destination. The real friction was outside the tool itself: `play_notes` was not in the returned 17 descriptors even though the task later named it and the harness accepted it. A descriptor for it would have removed the need to rely on the task text.

## What I had to infer

`get_parameter_schema` marks modulation-capable parameters with `mod`, but does not list valid modulation sources or say which envelope controls amplitude by default. I guessed that `env2` was a valid source and that `env1` was the amplitude envelope. Both guesses produced a working patch, but the schema did not establish either fact. The LFO entries expose rate, sync, division, mode, phase, and smoothing, but not an LFO waveform in this compact response.

## What I did not trust

I do not trust the negative inharmonicity value as a direct physical measure. A value of `-0.0000010701` is effectively zero but a quantity named inharmonicity normally needs an explicit definition and likely a non-negative scale. The tool gives neither its formula nor units. I also would not treat the 8.215 ms reported attack as proof that the 7-cent unison cannot create a slow beat. It measures onset, not modulation over the following second.

## Still unavailable through the tools

I could not find a stated mapping from envelopes to synth destinations, an enumerated source list for modulation, an LFO waveform definition, the inharmonicity formula, or per-partial frequency offsets. Those omissions matter for a sound target that cannot be heard. The metrics provide level, broad spectrum, an envelope trace, and partial amplitudes, but not time-varying partial decay, pitch drift or beat rate, velocity-to-timbre mapping, or a target-oriented parameter search. I could shape this patch by reasonable synthesis knowledge and verify coarse output, but I could not close the loop on a piano-like target defined by changing brightness and partial decay over time.
