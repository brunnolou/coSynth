# Base64 Reference Audio Comparison Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Let an AI send a short audio file directly as Base64, analyze it with the exact same DSP metrics used for coSynth renders, and compare the reference against the latest system-generated sound.

**Architecture:** Add a strict Base64/audio decoder at the WebMCP boundary, retaining only decoded metadata and metrics in memory. Add a pure metric-comparison function and expose two additional composable tools: `analyze_reference_audio` and `compare_audio`. Keep `analyze_audio` as the system-sound analyzer and reuse the same `analyzeAudio()` function for reference and candidate.

**Tech Stack:** TypeScript, WebMCP, Web Audio `decodeAudioData`, Vitest, Playwright.

---

### Task 1: Base64 payload decoding

**Files:**
- Create: `src/webmcp/audio-input.ts`
- Create: `src/webmcp/audio-input.test.ts`

**Steps:**
1. Write failing tests for raw Base64, audio data URIs, whitespace, malformed data, oversize payloads, aborts, empty/too-long decoded audio, and context cleanup.
2. Implement strict decoding with a 16 MiB encoded-input limit and 30-second decoded-audio limit.
3. Decode through the existing `AudioContext` when available, otherwise a temporary context that is closed after use.
4. Return detached PCM channels, sample rate, duration, byte count, and MIME type; never return Base64 in tool output.

### Task 2: Pure metric comparison

**Files:**
- Modify: `src/shared/audio-analysis.ts`
- Modify: `src/shared/audio-analysis.test.ts`

**Steps:**
1. Write failing tests proving identical metrics score 1, meaningful differences reduce the score, all deltas are returned, and score remains finite for silence/zero values.
2. Implement `compareAudioMetrics(reference, candidate)` with per-metric reference/candidate/delta/similarity and a bounded overall 0..1 score.
3. Keep raw `clippingCount` visible but exclude duration-dependent counts from the overall score.

### Task 3: WebMCP reference and comparison tools

**Files:**
- Modify: `src/webmcp/tools.ts`
- Modify: `src/webmcp/tools.test.ts`
- Modify: `src/webmcp/register.test.ts`

**Tools:**
- `analyze_reference_audio({ audioBase64, name?, mimeType? })`
- `compare_audio({})`

**Steps:**
1. Write failing metadata and behavior tests before implementation.
2. `analyze_reference_audio` validates and decodes Base64, runs `analyzeAudio`, stores only the latest reference analysis in the tool-factory closure, and returns the same metrics shape as `analyze_audio` plus metadata.
3. `compare_audio` requires a reference and compares it with the latest render, falling back explicitly to current scope exactly as `analyze_audio` does.
4. Honor execution/lifecycle abort signals and clear reference state on lifecycle disposal.
5. Update the exact tool count/order from 9 to 11.

### Task 4: Browser smoke and documentation

**Files:**
- Modify: `scripts/webmcp-smoke.mjs`
- Modify: `README.md`

**Steps:**
1. Generate a tiny WAV in the browser smoke, convert it to Base64, call `analyze_reference_audio`, then `compare_audio` against a real non-silent render.
2. Verify outputs are finite, the comparison includes every metric, and the Base64 is not echoed.
3. Document the two tools, supported raw/data-URI inputs, 16 MiB/30-second limits, and the AI workflow.

### Task 5: Verification and delivery

1. Run focused RED/GREEN tests throughout.
2. Run `npm test`, `npm run typecheck`, `npm run build`, existing AudioWorklet smoke, and WebMCP smoke.
3. Independent spec and quality reviews.
4. Commit only this feature's files (do not include the existing `.gitignore` change) and push to `origin/main`.
