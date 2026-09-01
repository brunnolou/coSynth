# coSynth

A browser-based, Vital-style **wavetable synthesizer** built on the Web Audio
API. Vanilla TypeScript + Vite: all DSP runs
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

coSynth progressively exposes the same live `SynthEngine` used by the UI through the current WebMCP API, `document.modelContext.registerTool(tool, { signal })`. Browsers without WebMCP continue to run the normal synth with no polyfill or runtime dependency.

Seventeen semantic tools are available over the full audio-enabled lifecycle. Fifteen discovery, editing, teaching, and history tools register at page load; `play_notes` and `render_audio` register only after the human starts audio. The UI counts successful registrations rather than assuming every tool is available.

- `get_synth_state` — compact runtime summary plus FX/modulation counts, with bounded pages for filtered parameters, modulation routes, or one LFO shape.
- `get_parameter_schema` — searchable, paginated canonical parameter metadata and optional paginated modulation sources, plus safety limits.
- `update_parameters` — atomic raw-unit/choice-label parameter batches with strict validation.
- `set_modulation` — add/update/remove/clear operations over the 32-slot modulation matrix.
- `play_notes` — bounded MIDI sequences with relative real-time timing and cancellation cleanup.
- `render_audio` — records the actual AudioWorklet output while notes play and returns a temporary blob URL plus metrics.
- `analyze_audio` — analyzes the latest render, explicitly falling back to the current scope buffers.
- `analyze_reference_audio` — decodes a short Base64 reference in browser memory and analyzes it with exactly the same metrics as `analyze_audio`.
- `compare_audio` — compares that latest reference analysis against the same latest-render/current-scope candidate selected by `analyze_audio`.
- `save_preset` and `load_preset` — validated, replace-by-name browser presets in localStorage.
- `get_ui_targets` — searchable, paginated semantic teaching targets with ID, label, type, and visibility.
- `show_ui_guide` — interactive Driver.js walkthroughs with safe CommonMark instructions, powered by micromark. No patch changes or checkpoints.
- `get_history` — bounded pages of retained sound states or replay entries, with the current sound ID and history revision.
- `navigate_history` — undo, redo, or restore a retained sound version using an expected revision to guard against stale AI requests.
- `replay_history` — play a saved AI note sequence with the current sound, or restart a saved walkthrough. No new history entry is created.
- `stop_performance` — cancel AI playback, rendering, or a history audition and wait for cleanup.

### Teaching with guides

Use `get_ui_targets({ search: 'echo' })` to discover `fx.delay`, or search by parameter ID, panel, tab, or source. Common target IDs include `panel.osc1`, `tab.env1`, `param.env1.attack`, `source.env1`, and `param.filter1.cutoff`. Only currently mounted targets appear in discovery; changing the ENV/LFO tab updates the available knob IDs.

```json
{
  "steps": [
    { "target": { "id": "panel.osc1" }, "title": "Choose the wave", "markdown": "Select **Basic Shapes** and turn Morph toward a saw or square. Next: shape the amplitude envelope." },
    { "target": { "id": "tab.env1" }, "title": "Shape the amplitude", "markdown": "Select **ENV 1 · AMP**. Set Attack to zero, Decay to **0.2–0.4 seconds**, and Sustain to **0%**." },
    { "target": { "id": "source.env1" }, "markdown": "This badge is the modulation source. Next: locate Filter 1 Cutoff." },
    { "target": { "id": "param.filter1.cutoff" }, "markdown": "This is the destination. After closing this guide, drag the Env 1 badge here to assign modulation." }
  ]
}
```

Pass this object to `show_ui_guide`. Each step accepts one optional target, optional plain-text `title`, and optional `markdown`. A target uses either a semantic `id` or a precise `selector`, never both. Selectors are restricted to the app and registered overlays; multiple visible matches are rejected. Omit the target for text only, omit text for a highlight with a close button, and pass `{ "steps": [] }` to clear. A new valid guide replaces the current one and returns immediately. Missing targets become centered instructions with a warning. Open the relevant tab manually and use Previous/Next to revisit the step.

Guides support at most 20 steps, 120 characters per title, 4,000 per Markdown body, and 512 per selector. Raw HTML is inert, images become alt text without loading, and only HTTP/HTTPS/mail links remain clickable. Next, Previous, Done, Close, Escape, and outside-click dismissal use Driver.js behavior. Active controls remain interactive. The guide may scroll but never enables modules, selects tabs, starts audio, or changes sound automatically.

For new UI components, call `guideTarget(element, id, label, kind)` from `src/ui/guide-target.ts`. Add external overlay roots with `UiGuideController.registerOverlay`; normal app dialogs already belong to the app scope. Run `node scripts/guide-smoke.mjs` against the preview server for the teaching-flow checks.

Every tool explicitly declares whether it is read-only. State-changing tools
set `readOnlyHint: false` so clients can classify them as write tools instead
of leaving them unclassified. Reference-audio analysis also declares that its
result may contain user-supplied metadata. Discovery responses are paginated to keep individual tool results compact. Request parameter, modulation, and LFO detail in separate `get_synth_state` calls. Expected validation and state failures return `{ ok: false, error: { code, message } }` through the registered WebMCP boundary, while cancellation remains an `AbortError`.

### Shared history and replay

The toolbar stays below the main navbar while the synth panels scroll. Undo, Redo, History, and Play again/Stop use icon-only buttons with accessible labels and tooltips. Macros and the keyboard stay at the bottom. History has two tabs:

- **Sound history** retains 120 sound states shared by human and AI edits. Each drag or AI mutation call is one step; wheel and MIDI macro changes group after 300 ms inactivity. Restoring an earlier sound preserves later alternatives. Edit from there to create a new path, then expand **Earlier alternatives** to return to abandoned versions.
- **Replays** retains 120 AI performances and walkthroughs independently of sound history. **Play again** auditions the same notes through the current sound. Closing a guide does not remove it; reopening starts at step one. Undo never consumes or clears replay entries.

Use `Cmd/Ctrl+Z` to undo, `Cmd/Ctrl+Shift+Z` to redo, or `Ctrl+Y` on Windows/Linux. Text fields keep native undo. Undo or restore stops active performances before restoring the sound. Human controls remain usable during playback; AI patch writes reject while playback or a human gesture is active.

Sound snapshots preserve modulation slot identities, LFO shapes, FX order, imported wavetables, and imported noise samples. They do not restore playing notes, oscillator phase, effect tails, or UI navigation. Shared imported assets retained only by old versions have a 128 MiB cap; oldest states are evicted when the count or byte limit is exceeded. The current sound is never evicted. History is memory-only and clears on reload or lifecycle disposal; ordinary bfcache navigation preserves it. Preset files/storage are unchanged and storage writes are not undoable.

### Pending AI changes

Dots identify net AI changes. A new visible change appears in the center for one second, then moves and shrinks over 600 ms into a single static circle at the top left, using `cubic-bezier(0, .85, .6, 1)` easing. Each dot stays hidden until its individual animation starts; batch start times are scattered across a 500 ms window. Reduced motion shows the static marker immediately. The Bot button toggles these markers without discarding pending changes or disabling AI tools. Click the adjacent status orb to review before/after values, the latest comparison, and tool activity. Keep accepts the iteration; Reject restores only AI-owned parameters, modulation slots, LFO shapes, and FX order, preserving manual edits. Reject adds one undoable sound-history entry. Keep does not change the sound or add a history entry.

A manual edit takes ownership of that parameter or structural unit and removes its dot. Undo restores the previous sound and its AI attribution; Redo restores the manual edit and removes the dot again. Restored markers do not replay the arrival animation. Loading a preset manually clears the current iteration, and undoing that load restores the previous attribution. Keep acknowledges the pending iteration across retained history, so navigation will not revive accepted markers. The review dialog remains available during playback, recording, history navigation, or an active editing gesture, but Keep/Reject are disabled until those operations finish. Tracking and visibility preferences remain session-local.

### AI status and tool activity

The single-line feed starts with the registered tool count. Each new invocation slides in from below and replaces the visible sentence; completion updates the same entry. Bursts show the newest call without queuing an animation backlog. The activity dialog retains the latest 100 invocations by ID, including overlapping calls, failures, and cancellation. Human edits, Keep/Reject, and shortcut errors do not create tool-call entries.

During tool activity the Bot rocks left and right and the centered orb animates for at least two seconds per burst. It stays active while any call is running, then shrinks over 600 ms with the same easing as control markers. During AI note playback and performance replays, the Bot instead bobs once per global BPM beat. Manual keyboard/MIDI notes do not trigger it, and render analysis after the notes end does not keep it bobbing. Reduced-motion preferences disable these animations.

The idle orb is a small blended-color dot when edits await review and neutral otherwise. A failed call turns it red until the next successful call; cancellation does not clear a previous failure. BotOff and a dark dot mean WebMCP is unavailable. The help popover explains the ChatGPT Desktop workflow. Registration errors remain distinct from missing browser support, including partial registration failures. Tool readiness describes available browser tools, not an authenticated or connected agent.

Example AI workflow:

```js
const state = await get_history({ view: 'sounds', limit: 5 })
await navigate_history({ action: 'undo', expectedRevision: state.revision })
const saved = await get_history({ view: 'replays', limit: 5 })
// Choose a performance entry from the returned page.
await replay_history({ entryId: saved.items.find(item => item.kind === 'performance').id })
```

For a restore, provide `action: 'restore'`, `entryId`, and a fresh `expectedRevision`. Stale navigation returns a retryable `history_conflict`; an active human gesture blocks AI edits with `history_busy`. Read history again before retrying. Discovery defaults to five entries and allows at most twenty per page. Comparison results attach to the sound version used for the render.

WebMCP requires a secure context: deploy over HTTPS, or use `localhost` during development. At the time of writing it is an experimental browser feature; use a WebMCP-enabled Chrome build/flag and a compatible client such as ChatGPT's experimental browser integration. Audio still follows browser autoplay policy: a human user gesture must click **CLICK TO START AUDIO** before `play_notes` or `render_audio` can run.

coSynth accepts both the current standards callback shape,
`execute(input, { signal })`, and experimental clients that omit the execution
options or its `AbortSignal`. Invocations without a signal remain cancellable
through page lifecycle disposal.

`render_audio` is intentionally **real-time**, not offline and not deterministic. It taps the current AudioWorklet graph through `MediaStreamAudioDestinationNode`/`MediaRecorder`, is capped at 15 seconds, revokes the previous blob URL, and always cleans up notes and recorder connections. AI patch mutations and preset loads are blocked for the complete play/render window. Rendered audio metrics include peak/RMS dB, clipping count, DC offset, spectral centroid, attack time, and stereo width. Replay history stores the note sequence, not old audio recordings.

Reference audio is Base64-only: pass either raw Base64 or a `data:audio/...;base64,...` value to `analyze_reference_audio` (ASCII whitespace in the Base64 is allowed). The encoded input is limited to 16 MiB characters and browser-decoded audio is limited to 30 seconds. An optional name and audio MIME type may be supplied. Expensive metric calculation runs in a disposable Web Worker and is cancellable without blocking synth controls. coSynth does not upload reference audio, create a URL for it, or persist Base64/PCM; only the latest reference metadata and seven analysis metrics remain in the WebMCP tool closure until replacement or disposal.

A typical iterative agent workflow is: analyze the Base64 reference once, adjust synth parameters, render actual synth output, call `compare_audio`, then repeat adjust/render/compare. Comparison returns a bounded overall similarity and signed deltas/similarities for peak dB, RMS dB, clipping count, DC offset, spectral centroid, attack time, and stereo width. These are summary-feature similarities for sound-design guidance, not proof that two sounds are perceptually identical.

The test shim follows the standards callback shape (`execute(input, { signal })`) and does not require experimental browser support:

```bash
npm test
npm run typecheck
npm run build
npm run preview
node scripts/history-smoke.mjs http://localhost:4173/
node scripts/guide-smoke.mjs http://localhost:4173/
node scripts/webmcp-smoke.mjs http://localhost:4173/
# in another terminal:
node scripts/webmcp-smoke.mjs
SHOT=/tmp/cosynth-smoke.png node scripts/smoke.mjs
```

## Hackathon work

The synthesizer base is [`noisyloop/soundgineer`](https://github.com/noisyloop/soundgineer), used under its MIT license. coSynth preserves and credits that upstream DSP/UI foundation. The work added here is the WebMCP progressive-enhancement adapter and semantic tool API, strict agent-facing validation and stable parameter semantics, abortable real-time output recording, reusable FFT-based audio analysis and Base64 reference comparison, shared validated preset persistence, and WebMCP unit/browser smoke coverage.

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
