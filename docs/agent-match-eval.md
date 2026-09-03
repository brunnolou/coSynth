# Reference-matching eval

A repeatable measurement of whether an agent, meeting coSynth's WebMCP tools for
the first time, can **close the loop on a sound it cannot hear**: upload a target
recording, render a candidate, compare the two, change the patch, and repeat
until it converges.

It exists because of a specific gap. `analyze_reference_audio` and
`compare_audio` were built for exactly this workflow, and the original field
evidence recorded that a real agent session **never called either of them** —
their purpose was opaque next to `render_audio.metrics`, which is right there in
the result of a tool the agent was already using. Later rounds rewrote the
descriptions as "Step 1 of matching a target sound" / "Step 2". Nobody has ever
measured whether an agent actually completes the loop. That is what this
measures.

The agent-UX eval (`docs/agent-ux-eval.md`) asks *does an agent find out what to
send.* This asks a harder question: **once it can send anything, can it steer.**

## What passing means

**The bar is not a high similarity number.** It is that the loop makes sense to
the agent and that the similarity improves.

- An agent that renders once, sees a number and declares victory has **failed**,
  even at 0.9. A one-entry `similarityTrajectory` is a failed run by definition.
- An agent that iterates four times and climbs steadily has **passed**, even
  ending at 0.7.
- An agent that never calls `analyze_reference_audio` at all has failed the
  original question outright, and that is the single most important thing the
  run can report.

Read `matchingLoop.similarityTrajectory` first, `similarityImprovedMonotonically`
second, and the absolute figure last.

## Method

The evaluated agent must never read the repo — the one exception being the
reference wav itself, which is committed at
[`agent-match-eval-reference.wav`](agent-match-eval-reference.wav) so a run is
self-contained and reproducible (176 KB, 24-bit stereo PCM, 44.1 kHz, 0.66 s;
~235 K Base64 characters, well inside the tool's 16 MiB cap).

This eval uses the **tool-only** harness, `scripts/agent-ux-probe.mjs` — no page
access. Discovery of the UI is a different eval's question; here the agent should
have the WebMCP channel and nothing else.

```bash
# Against an already-running preview. Do not rebuild mid-series.
node scripts/agent-ux-probe.mjs http://localhost:4173/ --port 4792 &
curl -s http://localhost:4792/health
```

Port 4792 keeps this out of the way of the agent-UX (4790) and discovery (4791)
harnesses, which are often running at the same time.

Then hand a fresh agent `docs/agent-match-eval-prompt.md` and read `GET /log`
afterwards.

```bash
claude -p "$(cat docs/agent-match-eval-prompt.md)" --allowedTools "Bash(curl:*)" "Bash(base64:*)" "Read" "Write"
codex exec -s workspace-write --skip-git-repo-check -C /tmp/eval "$(cat docs/agent-match-eval-prompt.md)"
```

### What the harness reports

`GET /log`'s `summary.matchingLoop`:

| Field | Meaning |
|---|---|
| `analyzeReferenceAudioCalls` | Was step 1 reached at all — the original question |
| `compareAudioCalls` | How many times the agent measured its distance |
| `similarityTrajectory` | Every `comparison.similarity`, in call order |
| `similarityImprovedMonotonically` | `null` under two comparisons, i.e. no loop happened |
| `bestSimilarity` / `finalSimilarity` | Diverging means the agent walked away from its best patch |
| `similarityGain` | Last minus first — the headline for "did the loop work" |
| `editsBetweenComparisons` | `update_parameters` + `set_modulation` per iteration. A run of zeros means the agent re-measured without changing anything |
| `comparisons` | The above joined to call numbers, for reading the log |

Each `compare_audio` entry in the log also carries `detailSimilarities` — the
per-metric breakdown — so you can see *which* metric the agent's change actually
moved, and which never moves at all.

### Rules that keep a run comparable

Learned by breaking each of them in the agent-UX eval; they apply unchanged here.

- **Identical prompt every time.** Diff it against the committed one before a run.
- **One agent at a time**, with `POST /reset` between, or the call logs interleave.
- **Run at least two different models.** Independent convergence is the signal:
  when two models get stuck in the same place the API is at fault, and when only
  one does it is model variance. With one model you cannot tell.
- **Never read the source to unblock a run.** Being stuck is the measurement.
- **Total call count is noise.** Read the targeted metrics.
- Run the eval *before* landing the next change, not after, so a delta is
  attributable to one thing.

One extra rule specific to this eval:

- **Do not change the reference file between runs.** Similarity figures are
  meaningless across different targets. If a second target is wanted, it is a
  second column, not a replacement.

## Runs

| | run 1 | run 2 | run 3 |
|---|---|---|---|
| Total calls / failed | 87 / 0 | 78 / 7 | **36 / 0** |
| Comparisons | 27 | 20 | 16 |
| Similarity, first -> best (10-term) | 0.520 -> 0.847 | 0.513 -> 0.837 | 0.505 -> 0.814 |
| Similarity, first -> best (13-term) | n/a | n/a | 0.472 -> 0.800 |
| Comparisons spent after the peak | **13** | **3** | **0** |
| Returned to the best patch | no | **yes**, via `navigate_history` restore | n/a, never left it |
| Saved which patch | the final (0.819) | **the best** (`ref-match-best-0.8368`) | **the best** (`agent-match-eval-best`) |

Run 3 is the first on the analysis rewrite: detected reference pitch, harmonics
on both sides, a signed per-dimension diff, and ranked moves in parameter ids.

**Read the two similarity rows carefully; they are not the same scale.** Adding
`harmonics`, `tilt` and `inharmonicity` to the score took the unweighted mean
from 10 terms to 13, so run 3's raw figure is not comparable with runs 1 and 2.
The 10-term row recomputes the old mean from that run's own `detailSimilarities`,
which is what runs 1 and 2 measured. Only that row may be compared. Run 3's
first comparison recomputes to 0.505 against 0.520 and 0.513, which is the
evidence that the recomputation is sound rather than flattering.

On the comparable scale run 3 peaked **lower** - 0.814 against 0.847 and 0.837 -
in **less than half the calls**, with no failures and nothing spent past the
peak. The gain is cost and reliability, not quality of match, and it should be
reported that way.

Both runs found the loop without the prompt naming a single tool, which is the
thing this eval was built to check: the field evidence that started this work
recorded `analyze_reference_audio` and `compare_audio` as never used.

Run 1 showed the loop converging and then wasting half its calls: it peaked at
comparison 14 and spent thirteen more oscillating without beating it, because
`compare_audio` returned only the current figure. Remembering 27 numbers across
87 calls is not a reasonable thing to ask of the caller. `compare_audio` now
returns a `progress` block naming the best, the delta from it, how many
comparisons have passed since, and the history entry that produced it.

Run 2 is that fix measured: three comparisons after the peak instead of
thirteen, then `get_history`, a `navigate_history` restore of the best render,
and a `save_preset` whose name carries the best score. Nothing in the prompt
mentions `navigate_history`.

Run 2 also exposed a bug no unit test could reach: `render_audio` failed six
times with `Unable to load a worklet's module` and never recovered, leaving the
agent unable to render at all — and the error's own advice pointed at
`mode: "realtime"`, which loads the same module and additionally needs a
gesture. The cause was not resource exhaustion (400 retained contexts and 200
consecutive renders both pass): `addModule()` is a network fetch, the assets are
served `no-cache`, and one scratch context per render meant **one HTTP round
trip per render**. Every offline render was a live dependency on the page's own
asset server still answering. Killing that server mid-loop reproduces the
message verbatim, six times, with no recovery. Both scripts are now fetched once
and reused from memory, which also took mean render time from ~230 ms to
~179 ms.

A caveat on run 2's evidence: the harness and the preview server were being
restarted around that run, so the server may have died from the orchestration
rather than from the workload. The bug is real either way — a render should not
need the network every time — but the run is not clean proof of spontaneous
failure.

## Results

| | C r3 |
|---|---|
| Reached `analyze_reference_audio` | yes, call 3 of 36 |
| `compare_audio` calls | 16 |
| Similarity trajectory (13-term) | 0.472 0.644 0.560 0.637 0.688 0.681 0.742 0.759 0.752 0.747 0.788 0.771 0.791 0.798 0.727 0.800 |
| Improved monotonically | no - 5 of 12 edit rounds went backwards |
| Best / final | 0.800 / 0.800 - finished on its best, after reverting a regression |
| Edits between comparisons | not measured; see the probe bug below |
| Total calls / failed | 36 / 0 |
| What ended the run | the agent stopped, having reverted a 0.798 -> 0.727 regression and confirmed the recovery |

C = Claude, X = Codex. The `## Runs` table above carries runs 1 and 2, which
predate this table; this one starts at run 3. The harness proof below is the
author's own hand-driven check that the loop is physically possible, and is not
an eval result.

### What run 3 found

The measurement layer held up; every defect was in the advice built on top of
it, which is the part with no prior art in this codebase.

- **The score rewards becoming unmeasurable.** A high shelf pushed the candidate
  past the pitch detector, `PITCH` and `PARTIALS` both went `n/a`, and similarity
  reached a new best of 0.688 - because a term that is null is excluded from the
  mean, so losing a dimension the candidate was failing raises the average. The
  agent named this as the number it trusted least, correctly.
- **A silent window produced a real-looking brightness swing.** The final window
  sat near -55 dB with every harmonic on the -120 floor, and its centroid read
  4,978 Hz. That fake +4.9-octave swing is what pushed an `env2.decay` move to
  rank 1.
- **A ranked action recommended an envelope that was not routed.** `env2` reaches
  the sound only through a mod slot, the patch had none, and the rule hedged in
  prose instead of reading the matrix the app already has.
- **`editsBetweenComparisons` read all zeros** across 15 successful `apply_patch`
  calls: the probe counted `update_parameters` only, so a tool added after it was
  written made the run look like it changed nothing.
- **A degenerate `env1.sustain 0.0 -> 0.0` was printed as a ranked move.**
- **Resolution falls between the two spectral views.** Partials stop at n=12,
  which is 444 Hz on a 37 Hz fundamental, and the bands are octave-wide. The
  1-2 kHz region carrying this sound's centroid is described by neither, and the
  agent fought a deficit there for the whole back half without closing it.

One result worth keeping. The agent declined the rank-1 `env2.decay` move in six
consecutive comparisons, reasoning that it would darken a sound already too dark,
then ran it as an isolated experiment to settle the argument: **0.742 -> 0.759**.
Its own reasoning was about brightness *level*; the action was about the
brightness *curve*. That distinction is the reason per-window brightness exists,
and the ranked action was right where the model was wrong.

### Harness proof (author-driven, not an eval run)

Driven by hand over curl against the tool-only harness on 4792, to establish that
every step works end to end before an agent is asked to find it:

| Step | Result |
|---|---|
| `analyze_reference_audio` with the 24-bit wav | ok in 266 ms — `duration: 0.665`, `sampleRate: 44100`, `channels: 2`, `decodedBytes: 176096` |
| `render_audio` (default patch, C4) | ok, `renderMode: "offline"` |
| `compare_audio` | **0.463** |
| `update_parameters` — sustain 0, decay 0.35, unison 4, detune 10 | ok |
| `compare_audio` | **0.556** |
| `update_parameters` — morph 0.65, cutoff 2600, decay 0.45 | ok |
| `compare_audio` | **0.598** |

`similarityGain` 0.389, `similarityImprovedMonotonically: true`, zero silent
renders. The loop converges and the harness makes the convergence visible.

## Findings from building this

- **24-bit PCM decodes fine.** `decodeAudioData` in Chromium handled the
  less-common 24-bit stereo case without complaint, at the correct duration and
  channel count. No workaround needed, no conversion.
- **`compare_audio` before any render compares against silence, and says so only
  obliquely.** With no render yet and the audio gesture not dispatched, it falls
  back to the live scope — which is digital silence — and returns `ok` with a
  plausible-looking `similarity` of 0.21. The only tell is `candidate.source ===
  'scope'` and a `peakDb` similarity of 0, both of which an agent has to notice
  on its own. The description does mention the scope fallback; what it does not
  say is that before `POST /start` the scope is guaranteed silent, so the
  fallback is never useful there. An agent that calls step 1 then step 2 in
  order, exactly as the descriptions instruct, gets a number that means nothing.
  Worth watching for in the first agent run.
- **`details.bands` sat at 0.000–0.008 through every iteration** while eight other
  metrics moved. A metric that never responds cannot be steered by, and it is one
  of ten contributing equally to the overall `similarity`, so it caps the
  achievable figure. Either it is genuinely that far off, or its scale is too
  tight to be informative — an agent has no way to tell which.
- **`decayT60Ms` is `null` on a sustaining patch** and its comparison detail
  scores 0. That is correct behaviour, but the agent sees a zero rather than an
  absence, and zero on a metric is indistinguishable from "very wrong" — which
  points at a different fix than "your note never decayed".
