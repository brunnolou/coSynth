import { normToValue, valueToNorm, type ParamDef } from '../shared/params'
import { clamp01 } from './common'

export const KNOB_COARSE_STEPS = 8

/** Keep the knob position aligned with the discrete value used by the synth. */
export function snapKnobValue(def: ParamDef, value: number): number {
  return def.step || def.choices
    ? valueToNorm(def, normToValue(def, value))
    : clamp01(value)
}

export function knobWheelValue(def: ParamDef, value: number, event: WheelEvent): number {
  if (!event.deltaY) return value
  const direction = event.deltaY < 0 ? 1 : -1
  const current = snapKnobValue(def, value)
  if (event.shiftKey && !event.metaKey) {
    // Go to the next 12.5% stop, including when starting between stops.
    const stop = direction > 0
      ? Math.floor(current * KNOB_COARSE_STEPS + 1e-6) + 1
      : Math.ceil(current * KNOB_COARSE_STEPS - 1e-6) - 1
    const coarse = snapKnobValue(def, clamp01(stop / KNOB_COARSE_STEPS))
    if (Math.abs(coarse - current) > 1e-6) return coarse
  }
  // Discrete knobs must advance at least one real step per wheel event.
  if (def.step || def.choices) {
    return clamp01(valueToNorm(def, normToValue(def, current) + direction * (def.choices ? 1 : def.step!)))
  }
  return clamp01(current + direction * (event.metaKey ? 0.002 : 0.02))
}
