# Agent teaching eval

Measures whether an agent, asked a *how do I* question by the person sitting in
front of the app, **shows them the control** instead of changing their patch or
describing it in words.

The prompt is [`agent-teaching-eval-prompt.md`](agent-teaching-eval-prompt.md).
It never names a tool and never says a teaching capability exists — whether the
agent recognises the intent and finds `show_ui_guide` is the measurement. Run it
the way [`agent-ux-eval.md`](agent-ux-eval.md) describes: identical prompt,
one agent at a time, at least two models, `POST /reset` between runs, and never
reading the source to get unstuck.

```bash
node scripts/agent-ux-probe.mjs http://localhost:4173/ --port 4792 &
claude -p "$(cat docs/agent-teaching-eval-prompt.md)" --allowedTools "Bash(curl:*)" "Write"
codex exec -s workspace-write --skip-git-repo-check -C /tmp/eval "$(cat docs/agent-teaching-eval-prompt.md)"
```

`GET /log`'s `summary.teaching` reports it: `taught`, `callsBeforeFirstGuide`,
`lookedUpTargets`, `changedSoundInstead`, `guideStepCounts`.

## Results

| | Claude r1 | Codex r1 | Claude r2 | Codex r2 |
|---|---|---|---|---|
| Taught rather than edited | yes | yes | yes | yes |
| Changed the sound instead | 0 | 0 | 0 | 0 |
| Calls before the first guide | 10 | 10 | **4** | **2** |
| `get_ui_targets` lookups | 6 | 14 | **1** | **1** |

## What round 1 found

The suspicion going in was that `show_ui_guide`'s description was not clear
enough about when to reach for it. **That turned out to be wrong, and the data
says so plainly**: both models called `get_ui_targets` as their very first call
and neither touched the patch. Intent recognition was never the problem.

What actually cost them was **finding the target ids**. Claude searched `delay`,
`release`, `tab`, `fx`, `start`, `panel`; Codex made fourteen lookups. The cause
was structural, and identical to one this project had already solved once:

```
get_ui_targets {}         -> total=259, items=5,  nextOffset=5
get_ui_targets {limit:20} -> total=259, items=20, nextOffset=20
get_ui_targets {limit:50} -> ERROR: limit must be an integer from 1 to 20
```

259 targets at 20 per page is 13 calls to see them all. `get_parameter_schema`
had exactly this shape — 224 parameters at 5 per page, which cost a real session
45 calls — and `format: 'compact'` fixed it. `get_ui_targets` had never been
given the same treatment.

Round 2 is that fix measured: one lookup instead of six or fourteen, and Codex
down to a two-call session. The descriptions were also reordered to lead with
the occasion rather than the mechanism, as
[`docs/plans/2026-09-02-agent-experience.md`](plans/2026-09-02-agent-experience.md)
did for the reference-matching pair — but that was insurance, not the fix, and
the results should not be read as evidence for it.

## Still open

A compact listing of all 259 targets is ~12 KB, and with the Start-audio overlay
up, 257 of them are marked `(hidden)` — 2.3 KB of the total spent on a marker
that says the same thing 257 times. A single top-level note ("a startup overlay
is covering everything") would carry that fact once.

Codex also reported being unsure whether a guide could point at controls behind
the startup overlay, and had to learn from the response that it can, with a
warning. That is a question the description could answer.
