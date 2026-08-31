/** Compact duration for the visible chart span or one LFO cycle. */
export function formatChartDuration(seconds: number): string {
  const milliseconds = Math.round(seconds * 1000)
  return milliseconds < 1000
    ? `${milliseconds} ms`
    : `${Number((milliseconds / 1000).toFixed(1))} s`
}

/** Match the filter chart caption, aligned to the right edge. */
export function drawChartTiming(c: CanvasRenderingContext2D, label: string, width: number): void {
  c.save()
  c.fillStyle = '#8d93a3'
  c.font = '8px system-ui, sans-serif'
  c.textAlign = 'right'
  c.fillText(label, width - 5, 10)
  c.restore()
}
