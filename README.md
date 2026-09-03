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

Presets are stored at format version 2. LFO tempo-sync divisions now run from `31/1` down to `1/32`, and because a choice parameter persists as its position in the list, growing that list changed the scale a stored division is read against. Version 1 presets and exported files are rescaled on load, so a patch saved before this change still sounds the same; the delay keeps its own thirteen-entry division list and is untouched. The LFO menu shows the slow multiples first, then the original divisions in their familiar grouping. A synced control's bypassed partner is dimmed and inert - turning SYNC on mutes the free-running rate, turning it off mutes the division - without altering either stored value.

## WebMCP agent tools

coSynth progressively exposes the same live `SynthEngine` used by the UI through the current WebMCP API, `document.modelContext.registerTool(tool, { signal })`. Chrome 146-149 origin-trial builds only expose the pre-2026-07-21 `navigator.modelContext` spelling, so both entry points are accepted. Where neither exists, it lazily imports the vendored legacy [webmcp.dev](https://webmcp.dev/) widget (`src/vendor/webmcp-widget.js`, taken from `@jason.today/webmcp@0.1.13`), which lets a user explicitly connect a local WebMCP bridge with a token. Browsers on the standard path never fetch that chunk. If neither path is available, the normal synth still runs without an agent integration.

All twenty-four semantic tools register at page load, so `GET /tools` returns the same set before and after the human starts audio. An agent that lists once cannot miss one: in the discoverability eval a listing taken before the Start gesture showed no `play_notes`, and the agent concluded playback was not a WebMCP tool and drove the DOM keyboard for the rest of the run. `play_notes` still needs the gesture to *run* - its description says so, and its error names `render_audio`, which renders offline with no gesture, so an agent can design and measure a sound before anyone clicks Start. The UI counts successful registrations rather than assuming every tool is available.

- `get_synth_state` — compact runtime summary plus FX order, preset identity and the modulation routes themselves: `patch.modulations.items` carries the first routes by default (with `total`, and `nextOffset` when a saturated matrix overflows the default page), `modulationLimit` widens that page, and `group`/`search`/`offset` or `lfo` request a parameter page or one LFO shape (`patch.lfoShape`) instead. `patch.preset` is `{name, source, dirty}` in every format: `dirty` compares the live patch against the preset it was loaded or saved from, exactly, with no tolerance — both sides are read back through the same accessor over the same `Float32Array`, so a knob moved away and back to the same value is genuinely not a change. It answers "is there work here I would lose", which is the question asked before deciding whether to save, so it is a field on the state an agent is already reading rather than a tool of its own.
- `get_parameter_schema` — canonical parameter metadata. Call once with `format: 'compact'` for all 224 parameters as one line each (`filter1.cutoff Hz 20..20000 exp =8000 mod`); use `group`/`search`/`offset` for full detail, up to 60 per page - `group` is one exact group id, matched case-insensitively, an unknown name is an error listing the groups rather than an empty page, and a filtered response carries a `groupFilter` note saying how much of the instrument the filter left and that one unfiltered compact call returns all 224. `sourceOffset`/`sourceLimit` — either one on its own is enough — add the modulation source vocabulary `set_modulation` accepts, one line each in compact format (`keytrack voice -1..1`). `groupNotes` carries what an agent cannot read off a parameter definition — env1 is the amplitude envelope (VCA) and env2-env6 and lfo1-lfo8 only reach the sound through `set_modulation`, and the envelope curve sign convention: 0 is linear, a positive `atk_curve` starts the attack slowly, while a positive `dec_curve`/`rel_curve` falls fast into a long tail and a negative one holds near its starting level and drops only at the end of the stage (`src/worklet/dsp.test.ts` pins both directions).
- `update_parameters` — atomic raw-unit/choice-label parameter batches with strict validation.
- `set_modulation` — add/update/remove/clear operations over the 32-slot modulation matrix. `add` takes `source`+`destination`; `update` and `remove` accept either `slot` or that same `source`+`destination` pair (one or the other, and a pair with no route on it is an error rather than a new route).
- `set_fx_order` — reorders the effect chain, which the UI can do and no tool could. Takes the full permutation of effect ids rather than a move, so "put reverb first" and "the chain is exactly this" cannot be the same call with only one of them predictable.
- `apply_patch` — parameters, modulation routes, effect order, a preset save and an audition render as one transaction. Everything is validated before anything is applied, mod slots included, so a full matrix is a validation error rather than a half-applied patch; a failure mid-apply rewrites every value it had written, so the pending-change ledger nets to zero and no history version is recorded. `dryRun` reports what would change without touching the engine, and `rollbackId` is the `navigate_history` restore handle for the state before the call.
- `play_notes` — bounded MIDI sequences with relative real-time timing and cancellation cleanup. Notes take either `midi: 38` or `note: "D2"`, and every result echoes the reading back as `D2 (MIDI 38, 73.4 Hz)`. Registered at page load; fails until the human has clicked Start, pointing at `render_audio` instead.
- `render_audio` — renders a note sequence and returns metrics. `mode: 'offline'` (the default) renders deterministically through `OfflineAudioContext`, faster than realtime and without a user gesture; `mode: 'realtime'` captures the live graph. `format` selects `'metrics'` (default), `'url'`, or `'base64'` for a mono 16-bit WAV an audio-capable agent can listen to.
- `analyze_audio` — re-analyzes the last render (`source: 'last-render'`), the rolling four-second capture of live output (`source: 'recent'`), the most recent 21 ms of it (`source: 'scope'`), or the retained reference PCM at a corrected `f0Hz` (`source: 'reference'`), without re-rendering.
- `capture_audio` — the "did you hear that?" tool: the last few seconds of live output from the same rolling buffer, with metrics and optionally the samples as a Base64 WAV. `waitForSignal` waits for sound to start. Offline renders bypass the live graph, so `render_audio` output never appears here.
- `analyze_reference_audio` — decodes a short Base64 reference in browser memory and analyzes it with exactly the same metrics as `analyze_audio`.
- `compare_audio` — compares the latest reference analysis against a candidate it renders itself, at the reference's own detected pitch and duration, so the matching loop needs no separate `render_audio` call and cannot score an octave-off render whose scalars still look plausible. `autoRender: false` falls back to the last render or the live scope; with nothing rendered and a silent scope it refuses rather than scoring the reference against silence, which returned a plausible-looking similarity an agent read as a baseline. Beside the `comparison` score it returns `diff`, the signed per-dimension error with ranked moves in this synth's parameter ids, and `progress`: the session best so far against this reference and how far the current comparison is from it.
- `suggest_patch` — re-reads the last `compare_audio` and returns its ranked moves again, optionally narrowed by `focus`. Nothing is rendered or measured, so it is the cheap way to ask "what next" without paying for another comparison.
- `save_preset`, `load_preset`, and `list_presets` — validated, replace-by-name browser presets in localStorage, and the names already saved.
- `delete_preset` — removes one user preset from localStorage. A factory name is refused with the reason, not a "not found": those patches are compiled into the page. A user preset saved *under* a factory name is deletable, because it is the only copy of deliberate work and what comes back is the built-in patch.
- `export_preset` — serializes a patch as the JSON an import takes back, validated on the way out and with a filename to suggest. No argument exports the live patch; `name` exports a stored one. It reads through `listPresets` rather than the store's `loadPreset`, so it never announces a load that did not happen: the current preset identity is the same before and after.
- `get_ui_targets` — semantic teaching targets with ID, label, type, and visibility. Call once with `format: 'compact'` for the whole teaching space as one line each (`param.env1.release knob env1 Release`, with a trailing `(hidden)` when the target's panel or tab is not open yet, `(not mounted)` when its tab has not built it, and `revealable` on either when the guide opens it for you); `search`/`offset`/`limit` page the full objects, up to 20 at a time.
- `show_ui_guide` — interactive Driver.js walkthroughs with safe CommonMark instructions, powered by micromark. No patch changes or checkpoints.
- `get_history` — bounded pages of retained sound states or replay entries, with the current sound ID and history revision.
- `navigate_history` — undo, redo, or restore a retained sound version using an expected revision to guard against stale AI requests.
- `replay_history` — play a saved AI note sequence with the current sound, or restart a saved walkthrough. No new history entry is created.
- `stop_performance` — cancel AI playback, rendering, or a history audition and wait for cleanup.

### Using coSynth from an AI agent

coSynth is deployed as a static site, so an agent that opens it has no
repository, no `AGENTS.md` and no README to read. The page is therefore its own
documentation: `src/webmcp/announce.ts` writes a clipped (never `display: none`)
`#cosynth-agent-brief` section into the body, plus a
`<script type="application/json">` descriptor and `ai-tools` / `ai-tool-names` /
`ai-workflow` meta tags in `index.html`. All of it survives both a plain DOM
snapshot and a text extraction of the page, which are the two things a browsing
agent reliably has. Point an agent at the URL and tell it to read the page text.

To match a reference sound, run this loop: `analyze_reference_audio` →
`compare_audio` → `update_parameters`, then repeat. There is no separate render
step: `compare_audio` renders the candidate for you, at the reference's own
detected pitch and duration, and returns ranked parameter moves alongside the
score. `suggest_patch` re-reads those moves without paying for another render.
Reach for `render_audio` to choose the notes yourself (`autoRender: false` then
compares that render), or for sound design no reference is driving. Each
`compare_audio` result carries a `progress` block naming the best similarity so
far against that reference, so stop when it reports a plateau instead of editing
past your own best patch. Open with one
`get_parameter_schema({ format: 'compact' })` call, which returns every
parameter, one line each.

Four traps cost a real evaluated session roughly a dozen tool calls:

- **The tools are page-scoped, so they are absent from any ambient tool list.**
  They are registered on the document via `document.modelContext.registerTool`.
  Filtering your own global tool inventory for `synth|preset|oscillator|audio`
  returns an empty array whether or not coSynth is open — an empty grep of
  `ALL_TOOLS` means nothing here.
- **They are bound to the document, so the tab has to be claimed in a browsing
  context that exposes the `webmcp` capability.** An external browser tab on the
  same URL may not have it, and a raw CDP probe there returns
  `{"hasMC":false,"keys":[],"ai":false}` — a confident false negative. Re-probe
  from a WebMCP-capable context before concluding the page exposes nothing.
- **`analyze_audio({ source: 'scope' })` reads a 1024-sample buffer (~21 ms), so
  a silent scope is the wrong buffer rather than a silent page.** A note the
  human finished a moment ago reads as silence there, and taking that for "they
  played nothing, I heard nothing" is the false negative. Live output is kept
  for about four seconds: `capture_audio` returns the last few seconds of it
  with metrics, and optionally the samples, and
  `analyze_audio({ source: 'recent' })` analyzes the same rolling buffer. One of
  those is the answer to "the human just played something, did you hear it?".
  Offline renders never reach the live graph and so never appear in it; for a
  sound nobody is playing, `render_audio` renders the whole note with no
  gesture.
- **Presets are saved to browser localStorage, not to a folder on disk.**
  A saved patch appears under the `User` optgroup of the preset select; there is
  no path to hand to anyone. `list_presets` is how you prove a save happened.

### Teaching with guides

After audio starts for the first time, coSynth opens a four-step introduction to its AI controls, playable keyboard, and synth workspace. Closing or finishing it records a versioned browser-local preference. The Help button in the activity toolbar restarts it from step one. This built-in tour never enters Replays or changes the sound.

Call `get_ui_targets({ format: 'compact' })` once to see the whole teaching space — roughly 350 targets, about 16 KB, one line each — rather than paging or guessing search terms; `get_ui_targets({ search: 'echo' })` narrows it to `fx.delay`, and search also spans parameter ID, panel, tab, and source. Common target IDs include `panel.osc1`, `tab.env1`, `param.env1.attack`, `source.env1`, and `param.filter1.cutoff`. The ENV and LFO tabs rebuild their knob rows on every click, so the knobs of an unselected tab are in no DOM node at all; discovery lists them anyway, as ordinary entries carrying `mounted: false` and predicted from the parameter registry, and `show_ui_guide` opens the owning tab when you point at one.

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

Pass this object to `show_ui_guide`. Each step accepts one optional target, optional plain-text `title`, and optional `markdown`. A target uses either a semantic `id` or a precise `selector`, never both. Selectors are restricted to the app and registered overlays; multiple visible matches are rejected. Omit the target for text only, omit text for a highlight with a close button, and pass `{ "steps": [] }` to clear. A new valid guide replaces the current one and returns immediately. A target whose tab or panel is closed is opened when the step is reached, and the result's `reveals` says which steps change what is on screen; what was opened stays open, since closing it again would leave the popover pointing at nothing. A target nothing can reveal - a wrong id, or a closed modal dialog - still becomes a centered instruction with a warning naming the way out.

Guides support at most 20 steps, 120 characters per title, 4,000 per Markdown body, and 512 per selector. Raw HTML is inert, images become alt text without loading, and only HTTP/HTTPS/mail links remain clickable. Next, Previous, Done, Close, and Escape use Driver.js behavior. An AI guide always keeps a close button and dismisses on Escape, but it ignores outside clicks so working the synth cannot wipe the instructions; only the built-in walkthrough closes on an overlay click. Active controls remain interactive. The guide may scroll, and will select a tab or open a panel to bring its own target into view. It never enables modules, starts audio, opens a modal dialog, or changes sound automatically.

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

Dots identify net AI changes. A new visible change appears in the center for one second, then moves and shrinks over 600 ms into a single static circle at the top left, using `cubic-bezier(0, .85, .6, 1)` easing. Each dot stays hidden until its individual animation starts; batch start times are scattered across a 500 ms window. Reduced motion shows the static marker immediately. Markers are always shown. The single AI status button pairs the status orb with its state (`AI off`, `AI starting`, `AI error`, `AI working`, `N changes`, `AI ready`) and opens the activity dialog for before/after values, the latest comparison, and tool activity. Before any AI has run, that dialog invites the reader to open the page in the ChatGPT Desktop app and offers prompt ideas instead of change controls. Keep accepts the iteration; Reject restores only AI-owned parameters, modulation slots, LFO shapes, and FX order, preserving manual edits. Reject adds one undoable sound-history entry. Keep does not change the sound or add a history entry.

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

WebMCP requires a secure context: deploy over HTTPS, or use `localhost` during development. At the time of writing it is an experimental browser feature; use a WebMCP-enabled Chrome build/flag and a compatible client such as ChatGPT's experimental browser integration. In browsers without either entry point, the legacy webmcp.dev fallback adds its blue connection widget; run its local bridge at the version the widget was vendored from (`npx -y @jason.today/webmcp@0.1.13 --mcp`), generate a token, then paste it into the widget. The bridge listens on `ws://localhost:4797`, so it must be reachable from the browser itself - an MCP client running in a different sandbox or VM than the browser will fail to connect. Audio still follows browser autoplay policy: a human user gesture must click **CLICK TO START AUDIO** before `play_notes` can run - the tool is registered and visible from page load either way. Offline `render_audio` does not need that gesture.

During `npm run dev`, `vite.config.ts` proxies two endpoints, `/register` and `/localhost_5173`, to `ws://[::1]:4797`. Two separate problems make the proxy necessary. The widget dials the bridge cross-origin, and embedded browsers refuse cross-origin loopback requests, so proxying keeps both endpoints same-origin with the page. The bridge also binds IPv6 only, which an IPv4 client cannot reach, so routing through Node performs the IPv6 hop. To use the proxy, rewrite the `server` field of the token the bridge prints from `ws://localhost:4797` to `ws://localhost:5173` before pasting it into the widget.

The `/localhost_5173` path slug is hardcoded to the dev port. Serving the dev server on another port means changing three things together: `server.port` in `vite.config.ts`, that proxy key (the bridge derives the slug from the port the page is served on), and the port in the rewritten token `server` URL.

### Measuring the agent experience

`scripts/agent-ux-probe.mjs` keeps one live page open behind a small HTTP API so an evaluating agent can drive the tools one call at a time while session state persists. It exposes only what a real WebMCP client sees - each tool's `name`, `description`, `inputSchema` and `annotations` - and logs every call with its outcome and wall-clock cost, so "how many round trips did that cost" is measured rather than recalled. `GET /tools`, `POST /call`, `POST /start` (the human gesture), `GET /log`, `POST /reset`.

It exists because the useful question is how the surface reads to an agent that has never seen the source, so an evaluating session must be given the descriptors and nothing else. The method, the prompt and the results of every run so far live in [`docs/agent-ux-eval.md`](docs/agent-ux-eval.md) and [`docs/agent-ux-eval-prompt.md`](docs/agent-ux-eval-prompt.md) — re-run it after changing the tools, with at least two different models, since independent convergence is what separates an API fault from model variance.

coSynth accepts both the current standards callback shape,
`execute(input, { signal })`, and experimental clients that omit the execution
options or its `AbortSignal`. Invocations without a signal remain cancellable
through page lifecycle disposal.

`render_audio` defaults to an **offline** render: a scratch `SynthEngine` on an `OfflineAudioContext` loads the current patch, schedules notes sample-accurately, and renders lossless WAV faster than real time. Offline renders are analyzed on uncompressed PCM and require no user gesture. Their scheduling is sample-accurate and repeatable, but they are not bit-for-bit deterministic: the DSP draws on `Math.random()` for noise oscillators, oscillator start-phase randomisation, and the `random` modulation source, so a patch using any of those varies between renders. `mode: 'realtime'` still taps the live AudioWorklet graph through `MediaStreamAudioDestinationNode`/`MediaRecorder`, which is Opus-encoded and therefore lossy; use it to capture what the speakers actually produce. When `OfflineAudioContext` or `AudioWorklet` is unavailable the render falls back to real time and says so in `renderModeFallback`, and `renderMode` always reports which path ran. Either way the render is capped at 15 seconds, revokes the previous blob URL, and cleans up notes and recorder connections. AI patch mutations and preset loads are blocked for the complete play/render window. Replay history stores the note sequence, not old audio recordings.

Metrics describe envelope, spectrum, and harmonic structure, not just level. Envelope: `attackMs` (10-90 % rise to the first local maximum of a 5 ms RMS envelope, so unison beating no longer reads as a slow attack), `timeToPeakMs`, `decayT60Ms` (a T60 of the rendered tail, so the note's own `duration` and `env1.release` shape it as well as `env1.decay`; `null` when the buffer never falls 20 dB), `sustainDb`, and `envelopeDb`, 64 points that let an agent see the shape. Level: `loudnessDb` (gated RMS) and `rmsDb` are the figures to compare; `peakDb` is an instantaneous peak and is not monotonic in velocity. Spectrum: `bandsDb` across 10 octave bands, `spectralCentroidHz`, `spectralRolloffHz`, and `spectralFlatness`. When a sequence has exactly one distinct pitch, `render_audio` passes that fundamental to the analyzer and the result also carries `harmonics.amplitudesDb` for the first 12 partials and `harmonics.inharmonicity`, fitted as B in `f_n = n * f0 * sqrt(1 + B * n^2)`. `clippingCount`, `dcOffset`, and `stereoWidth` are unchanged. `render_audio` and `analyze_audio` return a `metricNotes` object beside the metrics, carrying the interpretation `peakDb` and `decayT60Ms` need at the point their number is read; those sentences used to sit in the tool descriptions, where they made the tool listing large enough for a client to truncate.

Reference audio is Base64-only: pass either raw Base64 or a `data:audio/...;base64,...` value to `analyze_reference_audio` (ASCII whitespace in the Base64 is allowed). The encoded input is limited to 16 MiB characters and browser-decoded audio is limited to 30 seconds. An optional name and audio MIME type may be supplied. Expensive metric calculation runs in a disposable Web Worker and is cancellable without blocking synth controls. coSynth does not upload reference audio, create a URL for it, or persist Base64/PCM; only the latest reference metadata and its analysis metrics remain in the WebMCP tool closure until replacement or disposal.

A typical iterative agent workflow is: analyze the Base64 reference once, call `compare_audio` — which renders the candidate at the reference's own pitch — adjust synth parameters from the ranked moves it returns, then compare again. Comparison returns a bounded overall similarity and signed deltas/similarities for peak dB, RMS dB, clipping count, DC offset, spectral centroid, attack time, and stereo width. These are summary-feature similarities for sound-design guidance, not proof that two sounds are perceptually identical.

Because a bare similarity figure cannot say whether the loop is still working, every `compare_audio` result also carries a `progress` block alongside `comparison`: `comparisonNumber`, `isBest`, `best`, `bestComparisonNumber`, `deltaFromBest`, `comparisonsSinceBest`, the `bestEntryId` of the render that scored best (feed it to `navigate_history({ action: 'restore', entryId })`), and a `note` that spells out whether this is a new best or a plateau. The block is per reference: a new `analyze_reference_audio` is a new matching problem, so it starts the count and the best over.

The test shim follows the standards callback shape (`execute(input, { signal })`) and does not require experimental browser support:

```bash
npm test
npm run typecheck
npm run build
npm run preview
node scripts/history-smoke.mjs http://localhost:4173/
node scripts/guide-smoke.mjs http://localhost:4173/
node scripts/webmcp-smoke.mjs http://localhost:4173/   # includes the cold-page offline render_audio check
node scripts/agent-ux-probe.mjs http://localhost:4173/ --port 4790  # agent-UX measurement harness, see below
# in another terminal:
node scripts/webmcp-smoke.mjs
SHOT=/tmp/cosynth-smoke.png node scripts/smoke.mjs
```

## Credits

coSynth is built on [`noisyloop/soundgineer`](https://github.com/noisyloop/soundgineer), created by [noisyloop](https://github.com/noisyloop). The original project is available under the [MIT License](https://github.com/noisyloop/soundgineer/blob/main/LICENSE), with copyright © 2026 noisyloop. Its DSP engine and UI provided the foundation for this project.

## Hackathon work

The work added for coSynth includes the WebMCP progressive-enhancement adapter and semantic tool API, strict agent-facing validation and stable parameter semantics, abortable real-time output recording, reusable FFT-based audio analysis and Base64 reference comparison, shared validated preset persistence, and WebMCP unit/browser smoke coverage.

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
