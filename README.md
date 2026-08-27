# Soundgineer

A browser-based, Vital-style **wavetable synthesizer** built on the Web Audio
API. Vanilla TypeScript + Vite, zero runtime dependencies: all DSP runs
sample-accurately inside an `AudioWorkletProcessor`, the UI is hand-rolled
Canvas/WebGL2/DOM.

Architecture: main thread (UI, parameter state, wavetable generation) ⇄
`MessagePort` ⇄ AudioWorklet (16-voice engine, mod matrix, FX rack).

## Quick start

```bash
npm install
npm run dev        # → http://localhost:5173
```

Click to start audio, then play with the on-screen keyboard (`A W S E D F T G
Y H U J K`, octave `Z`/`X`) or a MIDI keyboard (Chrome/Edge — grant MIDI
permission).

Other scripts:

```bash
npm run build      # typecheck + production build to dist/
npm run preview    # serve the production build
npm run typecheck
node scripts/smoke.mjs                      # headless end-to-end check
# CHROMIUM_PATH=/path/to/chromium node scripts/smoke.mjs   (pre-installed browser)
```

## What's inside

**Per-voice signal path** (16 voices, oldest/released-first stealing):

- **3 wavetable oscillators** — morph (wavetable position), unison up to 16
  voices with detune/blend/stereo-spread, start phase + randomization, level,
  pan, transpose/fine, hard sync. Band-limited playback via per-frame mip
  pyramids (FFT low-passed copies, one per octave).
- **Sub oscillator** (sine/tri/saw/square, −3..0 oct) and **noise oscillator**
  (white / pink / WAV sample slot with pitch).
- **2 filters**, series or parallel — analog-style TPT SVF (LP/HP/BP/notch,
  12 & 24 dB), feedback comb, vowel-morphing formant. Cutoff, resonance,
  drive, key-track, mix per filter.
- **Shape section** — soft clip, hard clip, wavefolder, bitcrusher (+ sample
  rate divider).
- Envelope 1 is hard-wired to voice amplitude (velocity-scaled).

**Modulators**

- **6 envelopes** — DAHDSR (delay/attack/hold/decay/sustain/release) with
  per-stage curve shaping.
- **8 LFOs** — drawable multi-point curves (click to add points, drag
  segment midpoints to bend, right-click to delete, Ctrl to snap), Hz or
  BPM-synced rates, Trigger/Free/Sync retrigger modes, output smoothing.
- Velocity, key track, per-note random, mod wheel, pitch wheel, channel
  pressure, and **4 macro knobs** (MIDI CC 20–23).

**Modulation matrix** — any source → any moddable parameter, 32 slots,
bipolar depth. Assign by dragging a source badge onto a knob, or right-click
a knob. Depth arcs render around each knob with live animated value dots
(Vital-style). Full protocol: [docs/modulation-protocol.md](docs/modulation-protocol.md).

**Effects rack** (global, reorderable): chorus, phaser, flanger, BPM-syncable
ping-pong delay, Freeverb-style reverb, 3-band EQ, compressor, distortion.

**Wavetable engine** — 2048-sample frames; built-in tables are generated from
additive/FM/formula recipes with **FFT spectral morphing** between key frames
(magnitude + shortest-path phase interpolation). Import your own via the
**WAV** button on each oscillator: Serum-style concatenated 2048-sample-frame
WAVs load as-is; any other WAV is treated as a single cycle, FFT-resampled,
and expanded into a morph table.

**Visualizers** — WebGL2 3D wavetable view with the live (modulated) morph
position highlighted, oscilloscope, and log-frequency spectrum analyzer.

**Presets** — JSON patches (parameters + matrix + LFO shapes + FX order).
Factory patches included; save to localStorage, or export/import files.

## WebMCP agent tools

Soundgineer progressively exposes the same live `SynthEngine` used by the UI through the current WebMCP API, `document.modelContext.registerTool(tool, { signal })`. Browsers without WebMCP continue to run the normal synth with no polyfill or runtime dependency.

Exactly eleven semantic tools are available:

- `get_synth_state` — complete stable-ID patch snapshot (raw, normalized, and formatted parameter values; modulation, LFO shapes, FX order) plus live voices, held notes, and peaks.
- `get_parameter_schema` — searchable canonical parameter metadata, modulation sources, and safety limits.
- `update_parameters` — atomic raw-unit/choice-label parameter batches with strict validation.
- `set_modulation` — add/update/remove/clear operations over the 32-slot modulation matrix.
- `play_notes` — bounded MIDI sequences with relative real-time timing and cancellation cleanup.
- `render_audio` — records the actual AudioWorklet output while notes play and returns a temporary blob URL plus metrics.
- `analyze_audio` — analyzes the latest render, explicitly falling back to the current scope buffers.
- `analyze_reference_audio` — decodes a short Base64 reference in browser memory and analyzes it with exactly the same metrics as `analyze_audio`.
- `compare_audio` — compares that latest reference analysis against the same latest-render/current-scope candidate selected by `analyze_audio`.
- `save_preset` and `load_preset` — validated, replace-by-name browser presets in localStorage.

Every tool explicitly declares whether it is read-only. State-changing tools
set `readOnlyHint: false` so clients can classify them as write tools instead
of leaving them unclassified. Reference-audio analysis also declares that its
result may contain user-supplied metadata.

WebMCP requires a secure context: deploy over HTTPS, or use `localhost` during development. At the time of writing it is an experimental browser feature; use a WebMCP-enabled Chrome build/flag and a compatible client such as ChatGPT's experimental browser integration. Audio still follows browser autoplay policy: a human user gesture must click **CLICK TO START AUDIO** before `play_notes` or `render_audio` can run.

Soundgineer accepts both the current standards callback shape,
`execute(input, { signal })`, and experimental clients that omit the execution
options or its `AbortSignal`. Invocations without a signal remain cancellable
through page lifecycle disposal.

`render_audio` is intentionally **real-time**, not offline and not deterministic. It taps the current AudioWorklet graph through `MediaStreamAudioDestinationNode`/`MediaRecorder`, is capped at 15 seconds, revokes the previous blob URL, and always cleans up notes and recorder connections. Rendered audio metrics include peak/RMS dB, clipping count, DC offset, spectral centroid, attack time, and stereo width.

Reference audio is Base64-only: pass either raw Base64 or a `data:audio/...;base64,...` value to `analyze_reference_audio` (ASCII whitespace in the Base64 is allowed). The encoded input is limited to 16 MiB characters and browser-decoded audio is limited to 30 seconds. An optional name and audio MIME type may be supplied. Soundgineer does not upload reference audio, create a URL for it, or persist Base64/PCM; only the latest reference metadata and seven analysis metrics remain in the WebMCP tool closure until replacement or disposal.

A typical iterative agent workflow is: analyze the Base64 reference once, adjust synth parameters, render actual synth output, call `compare_audio`, then repeat adjust/render/compare. Comparison returns a bounded overall similarity and signed deltas/similarities for peak dB, RMS dB, clipping count, DC offset, spectral centroid, attack time, and stereo width. These are summary-feature similarities for sound-design guidance, not proof that two sounds are perceptually identical.

The test shim follows the standards callback shape (`execute(input, { signal })`) and does not require experimental browser support:

```bash
npm test
npm run typecheck
npm run build
npm run preview
# in another terminal:
node scripts/webmcp-smoke.mjs
SHOT=/tmp/aisoundgineer-smoke.png node scripts/smoke.mjs
```

## Hackathon work

The synthesizer base is [`noisyloop/soundgineer`](https://github.com/noisyloop/soundgineer), used under its MIT license. This hackathon extension preserves and credits that upstream DSP/UI foundation. The work added here is the WebMCP progressive-enhancement adapter and eleven-tool semantic API, strict agent-facing validation and stable parameter semantics, abortable real-time output recording, reusable FFT-based audio analysis and Base64 reference comparison, shared validated preset persistence, and WebMCP unit/browser smoke coverage.

## Repository layout

```
src/shared/     parameter registry, message protocol, FFT, wavetable
                generation/import — imported by BOTH threads
src/worklet/    the DSP: processor (voice manager, FX, telemetry),
                voice (signal path), dsp (osc/env/LFO/filters), effects
src/audio/      main-thread engine: worklet lifecycle, state, presets
src/ui/         knobs, editors, matrix, FX rack, scope, 3D view, keyboard, MIDI
docs/           modulation-matrix / message protocol spec
scripts/        headless Playwright smoke test
```

The worklet is bundled by Vite via `?worker&url` as a standalone ES module
(`worker.format = 'es'`), so `AudioWorklet.addModule()` works in both dev and
production. ES-module worklets require a Chromium-based browser or recent
Firefox; Chrome/Edge recommended.

## Known limits

- Hard sync (>1×) is not band-limited — it aliases on purpose, like the
  classic dirty setting.
- Vital's binary `.vitaltable` format is not parsed (JSON presets +
  Serum-style WAV import cover the common interchange path).
- White/pink noise ignore the pitch knob (it applies to the sample slot).
