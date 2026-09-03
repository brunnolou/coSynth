import type { UiGuideController, GuideStep } from './guide'

export const WELCOME_TOUR_STORAGE_KEY = 'cosynth.walkthrough.seen.v1'

export const WELCOME_TOUR_STEPS: readonly GuideStep[] = [
  {
    title: 'Create sounds with AI',
    markdown: 'For the full AI experience, open coSynth in **ChatGPT Desktop\'s in-app browser**. WebMCP lets ChatGPT work directly with the synth.'
  },
  {
    target: { id: 'panel.agent.ai' },
    title: 'Your sound-design partner',
    markdown: [
      'Ask the AI to:',
      '',
      '- **Create** or **reshape** a sound.',
      '- **Adjust** oscillators, filters, modulation, effects, and presets.',
      '- **Play**, **analyze**, **compare**, and **refine** the result.',
      '- **Show** every change, then **keep**, **reject**, **undo**, or **redo** it.',
      '- **Point** to controls and **teach** you step by step.'
    ].join('\n')
  },
  {
    target: { id: 'panel.keyboard' },
    title: 'Play it',
    markdown: [
      'Use your computer keyboard or click the on-screen keys.',
      '',
      '- Notes: `A W S E D F T G Y H U J K`',
      '- Octave down and up: `Z / X`'
    ].join('\n')
  },
  {
    target: { id: 'panel.synth' },
    title: 'Ask for anything',
    markdown: [
      'Keep talking to the AI while you listen and tweak the controls yourself. Try:',
      '',
      '- Make an 80s synth bass.',
      '- Make a warm deep-house chord.',
      '- Make it brighter and punchier.',
      '- Add a slow filter sweep.',
      '- Play a syncopated bass melody.',
      '- Show me how the filter shapes the sound.',
      '- Where can I find the echo?'
    ].join('\n')
  },
  {
    target: { id: 'button.history.walkthrough' },
    title: 'Reopen this anytime',
    markdown: 'This walkthrough lives behind the **help button**. Click it whenever you want the tour again.'
  }
]

type GuideHost = Pick<UiGuideController, 'isActive' | 'show'>

function browserStorage(): Storage | null {
  try { return window.localStorage }
  catch { return null }
}

/** Owns the built-in first-run tour without adding it to AI replay history. */
export class WelcomeTour {
  constructor(private readonly guide: GuideHost, private readonly storage: Storage | null = browserStorage()) {}

  start(): boolean {
    return this.guide.show({ steps: WELCOME_TOUR_STEPS }, { staticOverlay: true, closeOnOverlay: true }).shown === true
  }

  startOnce(): boolean {
    if (this.guide.isActive() || this.seen()) return false
    const shown = this.start()
    if (shown) this.markSeen()
    return shown
  }

  private seen(): boolean {
    try { return this.storage?.getItem(WELCOME_TOUR_STORAGE_KEY) === '1' }
    catch { return false }
  }

  private markSeen(): void {
    try { this.storage?.setItem(WELCOME_TOUR_STORAGE_KEY, '1') }
    catch { /* Storage can be unavailable in restricted browser contexts. */ }
  }
}
