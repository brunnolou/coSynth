import type { LegacyWebMcp } from '../webmcp/legacy'

declare const WebMCP: new (options?: Record<string, unknown>) => LegacyWebMcp
export default WebMCP
