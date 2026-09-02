# Agent-UX eval

A repeatable measurement of how coSynth's WebMCP tool surface reads to an AI
agent meeting it for the first time. It is the plan's verification step
(`docs/plans/2026-09-02-agent-experience.md`, "Verification" item 3) turned into
something we can re-run after every change to the tools.

The unit tests answer "does the tool do what it says". This answers a different
question: **does an agent with no access to the source find out what to send, in
one try.** Those come apart in practice — every finding below passed a green
suite.

## Method

The evaluated agent must never read the repo. If it does, it already knows the
answers and the numbers mean nothing. `scripts/agent-ux-probe.mjs` exists to
make that enforceable: it keeps one live page behind an HTTP API and exposes
only each tool's `name`, `description`, `inputSchema` and `annotations` — what a
real WebMCP client receives — logging every call with its outcome and
wall-clock cost.

```bash
npm run build
npx vite preview --port 4173 &
node scripts/agent-ux-probe.mjs http://localhost:4173/ &
curl -s http://localhost:4790/health
```

Then hand a fresh agent `docs/agent-ux-eval-prompt.md` and read
`GET /log` afterwards.

```bash
claude -p "$(cat docs/agent-ux-eval-prompt.md)" --allowedTools "Bash(curl:*)" "Write"
codex exec -s workspace-write --skip-git-repo-check -C /tmp/eval "$(cat docs/agent-ux-eval-prompt.md)"
```

Rules that keep a run comparable, learned by breaking each of them:

- **Identical prompt every time.** Diff it against the committed one before a run.
- **One agent at a time**, with `POST /reset` between, or the call logs interleave.
- **Run at least two different models.** Independent convergence is the signal:
  when two models waste a call in the same place the API is at fault, and when
  only one does it is model variance. With one model you cannot tell.
- **Never read the source to unblock a run.** Being stuck is the measurement.
- **Total call count is noise.** It swung 21 -> 33 -> 24 for one model with
  nothing getting worse, because the agent chose to verify more. Read the
  targeted metrics instead: discovery calls, failed calls, and whether something
  had to be guessed.
- Run the eval *before* landing the next change, not after, so a delta is
  attributable to one thing.

Known weakness in the harness's own numbers: `discoveryCalls` counts
`get_synth_state` as discovery, so it inflates when an agent inspects state at
the end. Read the call log, not just the summary.

Every run's agent report and harness log is archived in
[`agent-ux-eval-runs/`](agent-ux-eval-runs/) — the reports because an agent's own
wording for a complaint is usually the fix, and the logs because they are the
independent evidence behind the numbers below.

## Results

Baseline is the field evidence in the plan: one agent session, before any of this
work. Runs are against a production build, driven through the shim.

| | Baseline | C r1 | X r1 | C r2 | X r2 | C r3 | X r3 | C r4 | X r4 |
|---|---|---|---|---|---|---|---|---|---|
| Calls to learn 224 parameters | 45 | 4 | 1 | 2 | 4 | 1 | 1 | **1** | **1** |
| Calls before 1st good `update_parameters` | 3 | 5 | 2 | 2 | 5 | 2 | 2 | **2** | **2** |
| Total calls | — | 21 | 14 | 33 | 19 | 24 | 15 | **17** | **15** |
| Failed calls | — | 0 | 0 | 1 | 0 | 0 | 1\* | **0** | **0** |
| `attackMs` at 7-cent detune | 1277 ms | 5.8 | 8.2 | 7.0 | — | — | — | — | — |
| 4-render velocity sweep | ~15 s | 0.79 s | 0.88 s | 0.80 s | 0.88 s | — | — | — | — |
| Offline render before Start | impossible | yes | yes | yes | yes | yes | yes | yes | yes |
| Silent renders | — | — | — | 1 seen | — | 0 | 0 | **0** | **0** |

C = Claude, X = Codex. Each round follows the previous round's fixes.
\* `play_notes` before the gesture, which is by design.

Round 4 is the first with **zero failed calls on both models and one-call
discovery on both**. Neither hunted for the modulation sources, paged the
compact format, read routes back, or hit the addressing asymmetry — the four
things rounds 1-3 fixed. Claude's total went 21 -> 33 -> 24 -> 17.

## What each round found

Round 1 — both models independently had to **guess** the modulation source
vocabulary (nothing listed it, and `sourceLimit` without `sourceOffset`
silently returned nothing), and both had to guess that `env1` is the amplitude
envelope. Also `filterRouting` was a group name no parameter id matched, and
`harmonics`/`spectralCentroidHz` were whole-buffer only, so a brightness-decay
route was unverifiable.

Round 2 — the source vocabulary and `env1` were fixed and neither model guessed
again. Two new ones: `set_modulation` addressed routes by `source`+`destination`
on `add` but only by `slot` on `update`, and an explicit `limit` alongside
`format: 'compact'` paged four times because the schema never said compact needs
none. Both were caused by earlier fixes in this same file.

Round 2 also turned up **the most valuable finding of the exercise, which no
unit test could reach**: the offline render returned an all-zero buffer with
`ok: true`, about 12% of the time. `port.postMessage` crosses to the audio
thread asynchronously while an `OfflineAudioContext` renders at CPU speed, so
the frame-0 `noteOn` could arrive after its own note-off. It only surfaced
because an agent did seventeen real renders in a browser.

Round 3 — the addressing fix was used spontaneously (an agent added a route by
name then updated it by name, no error call), and Codex's discovery went back to
one call. New: `get_synth_state`'s description promised modulation routes it did
not return, and named neither `modulations` nor `lfoShape`, costing three calls;
`decayT60Ms` never said it measures the rendered tail rather than `env1.decay`;
and the envelope curve parameters advertised `-1..1` with no semantics, so the
sign was a coin flip an agent lost.

The pattern worth keeping in mind: each round removes the top blocker and
uncovers the next one, and the recurring class is **a description that promises
something the code does not do**. `filterRouting`, `sourceLimit`,
`get_synth_state`'s routes and `dec_curve` are all that same bug.

Round 4 — clean on every metric the earlier rounds targeted. What is left is
narrower and mostly about **stated behaviour rather than discoverability**: both
models want the voice-allocation/retrigger policy declared up front (`retriggered`
only tells you after the fact), the polarity and scaling of a unipolar source
under a bipolar `depth` spelled out, and `inharmonicity` given a formula. Codex
also notes `play_notes` is callable while absent from `GET /tools`, so its schema
still has to be inferred from `render_audio`.

## Still open

Both models, in their own words, could not close the loop on a target they
cannot hear. Time-windowed spectral data (`spectralWindows`) was added for
exactly this, and is not yet re-evaluated. `play_notes` has no descriptor before
the audio gesture while three other descriptions name it. `inharmonicity` has no
stated formula or units, and both models distrusted it.
