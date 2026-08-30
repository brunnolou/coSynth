/** Stable teaching identifiers, independent of layout and visible labels. */
export function guideTarget<T extends HTMLElement>(element: T, id: string, label: string, kind = 'control'): T {
  element.dataset.guideId = id
  element.dataset.guideLabel = label
  element.dataset.guideKind = kind
  return element
}
