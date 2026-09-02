<!-- The eval prompt. Hand this verbatim to a fresh agent; see docs/agent-ux-eval.md
     for the method and the accumulated results. Keep it byte-identical between runs -
     a changed prompt makes the numbers incomparable. -->


You are evaluating how good coSynth's WebMCP tool surface is **for an AI agent meeting it for the first time**. You are the subject of the experiment, not its author. Your job is to build a sound through the tools and honestly record what it cost you.

## Hard rules — read these twice, the result is worthless without them

1. **Do not read the coSynth project at all.** It lives at `~/Projects/coSynth`. Do not open, cat, grep, list or search ANY file under it - not `src/`, not `docs/`, not `README.md`, not `scripts/`, not the git history. You are deliberately running from a working directory outside it. Do not grep for tool names, parameter ids, or defaults anywhere on disk.
2. **Your only legitimate source of knowledge is `GET /tools`** — each tool's `name`, `description`, `inputSchema` and `annotations`, exactly what a real WebMCP client receives — plus whatever the tools themselves return to you.
3. **If you get stuck, do not go looking at the code.** Being stuck IS the measurement. Make your best next guess through the tools, and record that you were stuck and why. A session that reads the source to recover produces a number that means nothing.
4. **One decision, one call.** Do not write a loop or a script that fires many tool calls inside a single step to make discovery look cheap. Every call you make should be one you actually decided on, because the thing being measured is round trips. (An earlier baseline session hid 45 discovery calls inside one JS eval; that is the exact distortion to avoid.)
5. Do not modify any file in the repo. This is a read-and-drive exercise. The one exception is your final report, which you write to a new file.

## Setup (already done for you)

The app and the measurement harness are ALREADY RUNNING. Do not build or start anything.

- app: http://localhost:4173/
- harness: http://localhost:4790

Check it responds, then go straight to the task:

```bash
curl -s http://localhost:4790/health
```

The harness keeps one live browser page open and logs every call with its outcome and wall-clock cost:

- `GET  /tools` - the descriptors, and nothing else
- `POST /call` - `{"tool":"...","input":{...}}` -> `{ok, result|error, ms, call}`
- `POST /start` - dispatch the human "Start audio" gesture. **Do not call this until the task tells you to.**
- `GET  /log` - every call so far plus summary counters

Do NOT call `POST /reset` - it would erase the measurement.

Example call:

```bash
curl -s -X POST http://localhost:4790/call -d '{"tool":"get_synth_state","input":{}}'
```

## Your task

Build a **plucked, piano-like patch** from a cold page, then verify it by measurement rather than by hope. Work in this order and keep going even if a step disappoints you:

1. **Learn the instrument.** Find out what parameters exist, their ranges, defaults and units, and which can be modulated. Note how many calls this took.
2. **Apply a patch of at least 10 parameters in one go.** A piano is a fast attack, no sustain, a long decay, and some brightness that falls with time.
3. **Add at least 2 modulation routes.** Note whether you could tell, from the descriptions alone, what `depth` means and what it is relative to.
4. **Render a single note and read its measurements.** Do this *before* calling `/start`. Report whether it worked, and what `renderMode` you got.
5. **Read the decay and the harmonic structure** off that render — you are building an instrument defined by its decay, so find out whether you can actually see it.
6. **Sweep velocity across 4 renders** (e.g. 0.2 / 0.4 / 0.7 / 1.0) and check whether any loudness figure moves monotonically with velocity. Time the whole sweep in wall clock.
7. **Detune a unison oscillator by about 7 cents** and re-render one note. Report what attack time you are told. (A slow 1 Hz beat from a detune like this can masquerade as a slow attack; find out whether it does.)
8. **Play a phrase where a pitch repeats while still ringing** — e.g. an arpeggio whose E4 is still sounding when a chord restrikes the same E4. Report whether you had to work around anything.
9. **Save the patch, then confirm what presets exist.**
10. Now call `POST /start` and try `play_notes`. Report anything that only works after the gesture.

Along the way, whenever a call fails, **record the error message verbatim** and say whether it told you enough to fix your next attempt in one try, or whether you had to guess again.

## What to report

Write your report to `/tmp/agent-ux-eval-report.md` and also summarise it in your reply. Finish with `curl -s http://localhost:4790/log` and use its `summary` for the counts — report the harness's numbers, not your impressions of them.

Include a table of these measurements:

| Measurement | Your result |
|---|---|
| Calls to learn the full parameter space | |
| Calls before your first **successful** `update_parameters` | |
| Total calls, and how many failed | |
| Did an offline render work before `/start`? `renderMode`? | |
| Wall clock for the 4-render velocity sweep | |
| Which loudness figure tracked velocity monotonically (if any) | |
| `attackMs` reported with ~7-cent detune | |
| Could you read a decay time? What value? | |
| Could you read harmonic inharmonicity? What value? | |
| Did a repeated ringing pitch need a workaround? | |

Then answer in prose, briefly and without flattery:

- **Where did you waste a call, and what would have saved it?** Be specific about which description or schema misled you.
- **What did you have to infer that should have been stated?** Name the tool and the field.
- **What did you not trust, and why?** If a number looked wrong, say so and say what made you doubt it.
- **What could you still not find out through the tools at all?**
- **If you had to design this sound to a target you could not hear, what is still missing?**

## Honesty requirements

- If something worked well, say so plainly and move on; do not pad the report.
- If you failed a step, report the failure and leave it failed. Do not retry with knowledge you gained from a later step and then present it as a first attempt — if you do retry, say which attempt is being reported.
- Do not soften a bad number. The whole value of this exercise is the numbers being real.
- If you broke rule 1 at any point, even accidentally, say so at the top of your report. A contaminated run that admits it is useful; one that hides it is not.
