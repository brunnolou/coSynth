# coSynth WebMCP evaluation

I did not inspect the coSynth project or any files beneath it. I used the harness API only.

I learned all 224 parameters and 24 modulation sources in one `get_parameter_schema` call using `format: "compact"` and `sourceLimit: 60`. The patch was a 17-parameter atomic update: FM Bell oscillator, two unison voices, LP24 filter at 9.50 kHz, 2 ms VCA attack, 3.20 s decay, zero sustain, 2.20 s release, and a separate fast-decaying envelope for filter brightness. The routes were `env2 -> filter1.cutoff` at 0.45 and `velocity -> osc1.level` at 0.35.

| Measurement | Your result |
|---|---|
| Calls to learn the full parameter space | 1 |
| Calls before your first **successful** `update_parameters` | 2 |
| Total calls, and how many failed | 15 total, 0 failed |
| Did an offline render work before `/start`? `renderMode`? | Yes. `offline` |
| Wall clock for the 4-render velocity sweep | 20.56 s, from the first request timestamp to the last result timestamp |
| Which loudness figure tracked velocity monotonically (if any) | `loudnessDb`: -25.60, -21.85, -18.24, -15.91 dB for velocities 0.2, 0.4, 0.7, 1.0. `rmsDb` and `peakDb` also rose monotonically. |
| `attackMs` reported with ~7-cent detune | 5.794 ms |
| Could you read a decay time? What value? | Yes. `decayT60Ms` was 3858.14 ms on the initial one-note 8 s render. With 7 ct detune it was 3734.31 ms. |
| Could you read harmonic inharmonicity? What value? | Yes. Initial one-note render: -0.000003885. With 7 ct detune: -0.000169980. |
| Did a repeated ringing pitch need a workaround? | No. A phrase with E4 at 0.75 s and another E4 at 1.00 s rendered directly and returned `retriggered: 3`. |

The first offline render worked before `/start`, returned `renderMode: "offline"`, and provided both a rendered decay measurement and a one-pitch `harmonics` object. The 7-cent unison did not create a fake slow attack by this metric: attack changed only from 5.811 ms to 5.794 ms. The repeated-pitch phrase did expose 97 clipped samples and a 0.875 dB peak, so I would not trust that phrase render as a clean level reference.

I saved `Eval plucked piano`. `list_presets` returned two user presets: `Plucked Piano Eval4` and `Eval plucked piano`. It explicitly excludes factory presets, so factory-preset availability remains unknown.

After `POST /start`, `play_notes` completed a three-note phrase in 1.15 s. This was the only feature exercised that required the gesture. Oddly, `play_notes` was absent from the preceding `GET /tools` response, despite being callable. I inferred its `notes` input from `render_audio` and the task wording. It succeeded on the first attempt, but a first-time client should not have to infer a missing tool's schema.

There were no failed calls, so there are no error messages to quote.

## What cost calls or remained unclear

I did not waste a discovery call. `get_parameter_schema` compact mode put the complete parameter space, units, ranges, defaults, choices, modifiability, and every modulation source in one response. That was excellent. The only unnecessary uncertainty was `play_notes`: its descriptor was missing from `GET /tools`. Its name and payload should have appeared there, including its maximum duration and whether it owns or retriggers same-pitch voices.

I had to infer two things that should be stated. First, although `set_modulation` explained that `depth` is added to the normalized destination, it did not say how a 0..1 source is transformed for a *bipolar* depth. The intended positive envelope-to-cutoff behavior was plausible, but the exact equation for source polarity was not explicit. Second, `render_audio` did not say whether repeated same-pitch events steal an existing voice, coexist, or retrigger it. The result's `retriggered: 3` appeared only after the fact.

I did not trust the apparent harmonic inharmonicity as a physical piano measurement. It was nearly zero before detune and only -0.000169980 after detuning an oscillator pair, while the patch uses an FM Bell wavetable and the metric description did not define sign, units, estimator, or whether it separates unison beating from partial stretching. I also did not trust the phrase `attackMs` or T60 as patch-only values: the descriptor correctly says note duration and release affect T60, and the phrase time-to-peak was 1025 ms because later notes entered, not because the synth attacked in one second.

I could not find factory presets, an audible audition payload without asking for base64, a declared voice-stealing policy, the exact mapping of each wavetable choice to its harmonic content, or a defined interpretation of `inharmonicity`. For target design without hearing, I would still want partial frequencies and levels over time, a stable attack estimator that ignores later note onsets, clear per-source modulation polarity and scaling, voice allocation/retrigger rules, and level headroom or automatic gain guidance for chords.
