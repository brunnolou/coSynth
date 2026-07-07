# Soundgineer message & modulation-matrix protocol

All communication between the main thread (UI) and the DSP
`AudioWorkletProcessor` goes through the worklet node's `MessagePort`.
There is no shared state: the main thread owns the authoritative patch
(parameters, mod matrix, LFO shapes, FX order) and mirrors every change to the
worklet; the worklet streams telemetry (scope, levels, live source values)
back. The TypeScript source of truth for every message shape is
[`src/shared/messages.ts`](../src/shared/messages.ts).

## Parameters

Parameters are defined once in [`src/shared/params.ts`](../src/shared/params.ts)
and shared by both sides. Each parameter has:

- a stable string **id** (`osc1.morph`, `filter2.cutoff`, …) used by presets
  and this document,
- a numeric **index** (its position in `PARAMS`) used on the wire,
- a raw range/curve (`min`, `max`, `curve: 'lin' | 'exp'`, optional `step` or
  `choices`) and a `moddable` flag.

**Every parameter value on the wire is normalized to `0..1`.** Mapping to real
units (Hz, dB, semitones, enum index) happens at the point of use via
`normToValue()`. This is what makes the modulation system uniform: modulation
depths are expressed in the same normalized space for every destination.

```
main → worklet
{ type: 'param', index: number, value: number /* 0..1 */ }
```

The worklet stores values in a flat `Float32Array` indexed by parameter index.

## Modulation matrix

The matrix has `MAX_MOD_SLOTS = 32` slots. A slot is either empty (`null`) or:

```ts
interface ModSlotState {
  source: number   // index into MOD_SOURCES
  dest: number     // parameter index (must be `moddable`)
  depth: number    // -1..1, in normalized parameter units (bipolar)
  enabled: boolean
}
```

```
main → worklet
{ type: 'mod', slot: number, state: ModSlotState | null }
```

Sending a slot replaces it atomically; sending `null` clears it. The worklet
rebuilds an internal `dest → routes[]` map on every matrix message and clears
stale per-voice offsets.

### Sources

`MOD_SOURCES` (in order): `env1..env6`, `lfo1..lfo8`, `velocity`, `keytrack`,
`random`, `macro1..macro4`, `modwheel`, `pitchwheel`, `aftertouch`.

- **Per-voice** sources (envelopes, LFOs, velocity, keytrack, random) are
  evaluated independently inside each voice.
- **Global** sources (macros, mod wheel, pitch wheel, aftertouch) are shared.
- Unipolar sources emit `0..1`; `keytrack` and `pitchwheel` are bipolar
  (`-1..1`). `keytrack` is 0 at C4 and ±1 three octaves away. `random` is one
  uniform value drawn per note-on.

### Resolution

Once per 128-sample block, each voice computes, for every destination that has
routes:

```
offset(dest) = Σ over routes: depth × sourceValue
final(dest)  = normToValue(paramDef, clamp01(base(dest) + offset(dest)))
```

Modulated destinations on **global** processors (FX rack, master volume) are
resolved the same way, using the most recently started active voice for
per-voice source values.

Modulator parameters (LFO rate, envelope times…) are themselves moddable;
mod-of-mod resolves with the previous block's source values (one block of
latency, ~2.7 ms at 48 kHz).

## LFO shapes

LFO curves are multi-point functions, not an enum of waveforms:

```ts
interface LfoPoint { x: number; y: number; power: number }
// x, y in 0..1 — points sorted by x; power (-1..1) bends the segment
// that STARTS at this point (0 = linear).
```

```
main → worklet
{ type: 'lfoShape', lfo: 0..7, points: LfoPoint[] }
```

Both the editor UI and the DSP evaluate shapes with the same shared
`evalLfoShape()` (segment interpolation `t' = t^(2^(4·power))`).

Per-LFO parameters (`lfoN.rate/sync/division/mode/phase/smooth`) are ordinary
parameters. `mode` selects: **Trigger** (phase restarts at note-on), **Free**
(all voices follow one global free-running phase), **Sync** (phase locked to
the beat clock derived from `master.bpm`).

## Wavetables

Tables are generated/imported on the main thread. To keep the audio thread
glitch-free, the main thread also precomputes the band-limited mip pyramid
(`NUM_MIPS = 11` levels per frame, max harmonic `1024 >> mip`) and transfers
one flat `Float32Array`:

```
main → worklet   (buffer is transferred, not copied)
{ type: 'wavetable', osc: 0..2, frameSize: 2048, numFrames: N,
  mips: Float32Array /* N × 11 × 2048 */ }
```

The oscillator picks the mip whose highest harmonic stays below Nyquist for
the current phase increment, and linearly interpolates between adjacent
frames for the morph position.

## Notes, performance controllers, misc

```
{ type: 'noteOn',  note: 0..127, velocity: 0..1 }
{ type: 'noteOff', note: 0..127 }
{ type: 'sustain', down: boolean }          // CC64
{ type: 'pitchBend', value: -1..1 }         // scaled by master.bend_range
{ type: 'modWheel', value: 0..1 }           // CC1
{ type: 'aftertouch', value: 0..1 }         // channel pressure
{ type: 'allNotesOff' }
{ type: 'fxOrder', order: number[8] }       // permutation of FX indices
{ type: 'sample', data: Float32Array, sampleRate: number } // noise-osc sample slot
```

FX indices follow `FX_IDS`: `0 chorus, 1 phaser, 2 flanger, 3 delay,
4 reverb, 5 eq, 6 comp, 7 fxdist`.

## Worklet → main telemetry

```
{ type: 'ready' }                                   // once, after construction
{ type: 'scope', left: Float32Array(1024), right: Float32Array(1024) }
{ type: 'status', voices: number, peakL: number, peakR: number,
  sources: Float32Array /* live MOD_SOURCES values, newest voice */ }
```

Both arrive every 1024 samples (~47 Hz at 48 kHz, buffers transferred). The UI
uses `scope` for the oscilloscope/spectrum and `sources` to animate the
modulation arcs around knobs and the live markers in the ENV/LFO editors.

## Ordering & atomicity

Messages are processed in order (MessagePort guarantees FIFO). A preset load
is therefore just the natural sequence — params, mod slots, LFO shapes, FX
order, wavetables — with no special transaction message; the worklet applies
each message between 128-sample render quanta.
