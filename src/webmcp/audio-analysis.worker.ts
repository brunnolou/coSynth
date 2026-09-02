/// <reference lib="webworker" />

import { analyzeAudio, type AnalyzeAudioOptions } from '../shared/audio-analysis'

interface AnalysisRequest {
  channels: ArrayBuffer[]
  sampleRate: number
  options?: AnalyzeAudioOptions
}

self.addEventListener('message', (event: MessageEvent<AnalysisRequest>) => {
  try {
    const metrics = analyzeAudio(
      event.data.channels.map(buffer => new Float32Array(buffer)),
      event.data.sampleRate,
      event.data.options ?? {}
    )
    self.postMessage({ ok: true, metrics })
  } catch (error) {
    self.postMessage({
      ok: false,
      message: error instanceof Error ? error.message : 'Audio analysis failed'
    })
  }
})

