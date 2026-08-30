import { describe, expect, it } from 'vitest'
import { isMidiPermissionBlocked } from './midi'

describe('MIDI permission errors', () => {
  it.each([
    { name: 'NotAllowedError', message: 'Permission denied' },
    { name: 'SecurityError', message: 'Blocked by the embedding browser' },
    { name: 'Error', message: 'MIDI permission was denied' }
  ])('recognizes a browser permission block', error => {
    expect(isMidiPermissionBlocked(error)).toBe(true)
  })

  it('keeps unrelated MIDI failures generic', () => {
    expect(isMidiPermissionBlocked({ name: 'AbortError', message: 'Device disconnected' })).toBe(false)
  })
})
