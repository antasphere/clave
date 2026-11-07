import { defineConfig } from 'vitest/config'

// Explicit dependency diagnostic, PRDCT-3634. The original SSR assertions are
// retained verbatim apart from the two imports needed at this location.
export default defineConfig({
  test: {
    include: ['scripts/diagnostics/react-ssr-deep-original.test.ts'],
    environment: 'node',
    server: { deps: { inline: [/@structure-ai\//] } }
  }
})
