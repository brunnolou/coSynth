import type { Wavetable, WavetableSnapPoint } from './wavetable-gen'

export const SNAP_EPSILON = 0.000001

/** Only explicitly authored, finite anchors can make a preview interactive. */
export function wavetableSnapPoints(table?: Wavetable | null): readonly WavetableSnapPoint[] {
  const sorted = (table?.snapPoints ?? [])
    .filter(point => point.label.trim() && Number.isFinite(point.position) && point.position >= 0 && point.position <= 1)
    .slice().sort((a, b) => a.position - b.position)
  return sorted.filter((point, index) => index === 0 || point.position - sorted[index - 1].position > SNAP_EPSILON)
}

export function nextSnapPoint(points: readonly WavetableSnapPoint[], morph: number): WavetableSnapPoint | undefined {
  if (points.length < 2 || !Number.isFinite(morph)) return undefined
  return points.find(point => point.position > morph + SNAP_EPSILON) ?? points[0]
}
