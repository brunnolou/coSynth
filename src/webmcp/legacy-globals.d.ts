declare global {
  interface Navigator {
    /**
     * Pre-2026-07-21 location of the WebMCP entry point. Chrome 146-149
     * origin-trial builds expose it here; the 2026-07-21 draft moved it to
     * `document.modelContext` and Chrome 150 deprecated this spelling.
     */
    readonly modelContext?: WebMCP.ModelContext
  }
}

export {}
