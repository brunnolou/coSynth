import type { PendingChange } from '../webmcp/activity'
import { PARAMS, formatValue } from '../shared/params'
import { FX_IDS, MOD_SOURCES, type ModSlotState } from '../shared/messages'

function routeLabel(route: ModSlotState | null): string {
  if (!route) return 'No route'
  const dest = PARAMS[route.dest]
  return `${MOD_SOURCES[route.source].name} → ${dest.group} ${dest.name}, ${Math.round(route.depth * 100)}%, ${route.enabled ? 'enabled' : 'bypassed'}`
}

export function changeSummary(change: PendingChange): string {
  switch (change.kind) {
    case 'param': {
      const def = PARAMS[change.index]
      return `${def.group} ${def.name}: ${formatValue(def, change.before)} → ${formatValue(def, change.after)}`
    }
    case 'route':
      return `Route ${change.index + 1} ${!change.after ? 'removed' : !change.before ? 'added' : 'changed'}: ${routeLabel(change.before)} → ${routeLabel(change.after)}`
    case 'lfo':
      return `LFO ${change.index + 1} shape: ${change.before.length} points → ${change.after.length} points; ${change.after.length === change.before.length ? 'point positions or curves changed' : 'point layout changed'}`
    case 'fx':
      return `FX order: ${change.before.map(i => FX_IDS[i]).join(' → ')} → [${change.after.map(i => FX_IDS[i]).join(' → ')}]`
  }
}

/** Derive visible targets without requiring a particular UI layout. */
export function changeTargets(change: PendingChange): string[] {
  switch (change.kind) {
    case 'param': {
      const id = PARAMS[change.index].id
      const group = id.split('.')[0]
      return [`param.${id}`, ...(/^(env|lfo)\d+$/.test(group) ? [`tab.${group}`] : [])]
    }
    case 'lfo': return [`lfo.${change.index}`, `tab.lfo${change.index + 1}`]
    case 'fx': return ['panel.fx']
    case 'route': {
      const row = `matrix.slot${change.index}`
      if (!change.after) {
        return ['panel.matrix', ...(change.before ? [`param.${PARAMS[change.before.dest].id}`] : [])]
      }
      return ['source', 'destination', 'depth', 'enabled'].flatMap(field => {
        const key = field === 'destination' ? 'dest' : field as keyof ModSlotState
        return !change.before || change.before[key] !== change.after![key] ? [`${row}.${field}`] : []
      })
    }
  }
}
