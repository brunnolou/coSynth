import type { LfoPoint, ModSlotState } from './messages'

export type MutationOrigin = 'human' | 'ai' | 'restore'
export type PatchChange =
  | { kind: 'param'; index: number; before: number; after: number }
  | { kind: 'route'; index: number; before: ModSlotState | null; after: ModSlotState | null }
  | { kind: 'lfo'; index: number; before: LfoPoint[]; after: LfoPoint[] }
  | { kind: 'fx'; index: 0; before: number[]; after: number[] }

export interface PatchMutation {
  origin: MutationOrigin
  changes: PatchChange[]
  reset?: boolean
}

/** Value equality, independent of object property insertion order. */
export function samePatchValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key =>
    Object.hasOwn(right, key) && samePatchValue(left[key], right[key]))
}

export function changeKey(change: Pick<PatchChange, 'kind' | 'index'>): string {
  return `${change.kind}.${change.index}`
}
