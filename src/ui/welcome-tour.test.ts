// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { WELCOME_TOUR_STEPS, WELCOME_TOUR_STORAGE_KEY, WelcomeTour } from './welcome-tour'

function guide(active = false) {
  return {
    isActive: vi.fn(() => active),
    show: vi.fn(() => ({ shown: true, stepCount: 5, warnings: [] }))
  }
}

describe('welcome tour', () => {
  it('uses the agreed five-step story and semantic targets', () => {
    expect(WELCOME_TOUR_STEPS).toHaveLength(5)
    expect(WELCOME_TOUR_STEPS.map(step => step.title)).toEqual([
      'Create sounds with AI', 'Your sound-design partner', 'Play it', 'Ask for anything', 'Reopen this anytime'
    ])
    expect(WELCOME_TOUR_STEPS.map(step => step.target && 'id' in step.target ? step.target.id : null)).toEqual([
      null, 'panel.agent.ai', 'panel.keyboard', 'panel.synth', 'button.history.walkthrough'
    ])
    expect(WELCOME_TOUR_STEPS[2].markdown).toContain('A W S E D F T G Y H U J K')
    expect(WELCOME_TOUR_STEPS[2].markdown).toContain('Z / X')
  })

  it('opens automatically once and lets explicit replay start again', () => {
    const host = guide()
    const storage = window.localStorage
    storage.clear()
    const tour = new WelcomeTour(host, storage)

    expect(tour.startOnce()).toBe(true)
    expect(storage.getItem(WELCOME_TOUR_STORAGE_KEY)).toBe('1')
    expect(tour.startOnce()).toBe(false)
    expect(tour.start()).toBe(true)
    expect(host.show).toHaveBeenCalledTimes(2)
  })

  it('does not replace an active guide or mark the tour as seen', () => {
    const host = guide(true)
    const storage = window.localStorage
    storage.clear()

    expect(new WelcomeTour(host, storage).startOnce()).toBe(false)
    expect(host.show).not.toHaveBeenCalled()
    expect(storage.getItem(WELCOME_TOUR_STORAGE_KEY)).toBeNull()
  })

  it('still works when browser storage throws', () => {
    const host = guide()
    const storage = {
      getItem: vi.fn(() => { throw new Error('blocked') }),
      setItem: vi.fn(() => { throw new Error('blocked') })
    } as unknown as Storage

    expect(() => new WelcomeTour(host, storage).startOnce()).not.toThrow()
    expect(host.show).toHaveBeenCalledOnce()
  })
})
