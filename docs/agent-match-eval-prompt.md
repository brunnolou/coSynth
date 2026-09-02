<!-- The reference-matching eval prompt. Hand this verbatim to a fresh agent; see
     docs/agent-match-eval.md for the method and the accumulated results. Keep it
     byte-identical between runs - a changed prompt makes the numbers incomparable. -->


You are evaluating whether coSynth's WebMCP tool surface lets an AI agent **match a sound it cannot hear**. You are the subject of the experiment, not its author. Your job is to get the synth as close as you can to a supplied audio file, and to report honestly on what the tools did and did not tell you.

## Hard rules — read these twice, the result is worthless without them

1. **Do not read the coSynth project.** It lives at `~/Projects/coSynth`. Do not open, cat, grep, list or search ANY file under it — not `src/`, not `docs/`, not `README.md`, not `scripts/`, not the git history. The single exception is the reference audio file named below, which you may read as bytes. Do not grep for tool names, parameter ids, metric names or defaults anywhere on disk.
2. **Your only legitimate source of knowledge is `GET /tools`** — each tool's `name`, `description`, `inputSchema` and `annotations`, exactly what a real WebMCP client receives — plus whatever the tools themselves return to you.
3. **If you get stuck, do not go looking at the code.** Being stuck IS the measurement. Make your best next guess through the tools, and record that you were stuck and why.
4. **One decision, one call.** Do not write a loop or a script that fires many tool calls inside a single step. Every call should be one you actually decided on, because round trips are being counted. (Scripting the Base64 encoding of the file is fine — that is data preparation, not a tool call.)
5. Do not modify any file in the repo. The one exception is your final report, which you write to a new file outside it.

## Setup (already done for you)

The app and the measurement harness are ALREADY RUNNING. Do not build or start anything.

- app: http://localhost:4173/
- harness: http://localhost:4792

```bash
curl -s http://localhost:4792/health
```

The harness keeps one live browser page open and logs every call with its outcome and wall-clock cost:

- `GET  /tools` — the descriptors, and nothing else
- `POST /call` — `{"tool":"...","input":{...}}` -> `{ok, result|error, ms, call}`
- `POST /start` — dispatch the human "Start audio" gesture. You do not need it; the offline path works without it.
- `GET  /log` — every call so far plus summary counters

Do NOT call `POST /reset` — it would erase the measurement.

Some payloads are large. Write the body to a file and post it with `--data-binary @file` rather than pasting it on the command line.

## The target

`~/Projects/coSynth/docs/agent-match-eval-reference.wav` — a short recorded sound, 24-bit stereo PCM, 44.1 kHz, about two thirds of a second. You may read this file's bytes and you may need to encode it as Base64 to get it into the app. Nothing else under that directory is open to you.

**You cannot hear it, and neither can the synth's designer.** That is the point of the exercise.

## Your task

Get coSynth's output as close to that recording as you can, and know — by measurement, not by hope — whether you are getting closer.

Work it out from `GET /tools`. Nothing here will tell you which tools to call or in what order; finding that out is exactly what is being measured.

**You must not stop at your first attempt.** A single change followed by a declaration of success is a failed run, whatever number it ends on. Keep going until either your measure of closeness has stopped improving across several honest attempts, or you have run out of ideas you can justify — and say which of the two ended the run. Each attempt should be a change you can explain: name what you were trying to move and why, *before* you find out whether it worked.

Along the way, whenever a call fails, **record the error message verbatim** and say whether it told you enough to fix your next attempt in one try, or whether you had to guess again.

## What to report

Write your report to `/tmp/agent-match-eval-report.md` and also summarise it in your reply. Finish with `curl -s http://localhost:4792/log` and use its `summary` for the counts — report the harness's numbers, not your impressions of them.

Include a table of these measurements:

| Measurement | Your result |
|---|---|
| Calls before you first had any measure of closeness | |
| How many attempts you made | |
| Your closeness figure at each attempt, in order | |
| Best and final figure | |
| Did it improve every time? Where did it go backwards? | |
| Total calls, and how many failed | |
| What ended the run — no further improvement, or no further ideas | |

Then answer in prose, briefly and without flattery:

- **How did you know whether you were getting closer?** Name the exact field.
- **Which single number did you steer by, and why that one?** If you steered by different ones at different points, say when you switched and what made you switch.
- **Where did a number move but the sound plainly could not have?** Or the reverse — a change you were confident in that moved nothing.
- **What could you not tell from the tools at all?** Be specific: name the tool and the field whose meaning, units, scale or direction you had to guess.
- **What would have got you closer, faster?** One concrete thing.

## Honesty requirements

- If something worked well, say so plainly and move on; do not pad the report.
- If you failed a step, report the failure and leave it failed. Do not retry with knowledge you gained from a later step and then present it as a first attempt — if you do retry, say which attempt is being reported.
- Do not soften a bad number. A run that ends far from the target and says so is worth more than one that stops early on a flattering figure.
- If you broke rule 1 at any point, even accidentally, say so at the top of your report. A contaminated run that admits it is useful; one that hides it is not.
