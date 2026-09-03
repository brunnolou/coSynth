import type { ParamDef } from '../shared/params'

/** Stable teaching identifiers, independent of layout and visible labels. */
export function guideTarget<T extends HTMLElement>(element: T, id: string, label: string, kind = 'control'): T {
  element.dataset.guideId = id
  element.dataset.guideLabel = label
  element.dataset.guideKind = kind
  return element
}

/**
 * How a parameter becomes a teaching target.
 *
 * Every control bound to a parameter carries these two - the knob, the enum
 * select and the on/off toggle all build them from the same `ParamDef` - and
 * `guide.ts` builds the same pair for a parameter whose control is not mounted
 * right now, so that a closed ENV or LFO tab still lists what it owns. They are
 * one function each so that the predicted form and the mounted form cannot
 * drift apart into two registries.
 */
export function paramGuideId(id: string): string {
  return `param.${id}`
}

export function paramGuideLabel(def: ParamDef): string {
  return `${def.group} ${def.name}`
}
