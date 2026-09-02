# Agent-UX eval — run archive

Raw output of every eval run. See [`../agent-ux-eval.md`](../agent-ux-eval.md)
for the method, the results table, and what each round found;
[`../agent-ux-eval-prompt.md`](../agent-ux-eval-prompt.md) is the prompt each
run was given, byte-identical across all of them.

Two files per run:

- `rN-<model>.md` — the agent's own report. It wrote this having never read the
  repo, so the wording is what the tool surface actually communicated, not what
  we intended it to. That is the point of keeping them: the phrasing of a
  complaint is usually the fix.
- `rN-<model>.log.json` — the harness log. Every call with its input, outcome
  and wall-clock cost, plus the summary counters. This is the independent
  evidence behind every number in the results table; the reports are the
  agent's account, the logs are the measurement.

`r1` predates any eval-driven fixes. Each later round follows the previous
round's fixes, so `rN` measures the state after `rN-1`'s findings were
addressed.

A caveat that applies to the whole archive: n = 1 per model per round. The large
movements are real (45 discovery calls down to 1; failed calls to 0), but total
call count swung 21 → 33 → 24 → 17 for one model with nothing getting worse,
because an agent may simply choose to verify more. Read the targeted metrics and
the call logs, not the totals.

Also note the harness's `discoveryCalls` counter includes `get_synth_state`, so
it overstates the cost of learning the instrument whenever an agent inspects
state at the end of a run.
