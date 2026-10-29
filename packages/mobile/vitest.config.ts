import { defineConfig } from 'vitest/config'

/**
 * The package's unit tests: plain TypeScript over injected ports (fetch,
 * WebSocket, storage, the secure store), run under Node. Nothing here loads
 * React Native. The contract pin (`src/contract/contract-pin.test.ts`) loads
 * `@clave/contract` itself, which Node can, because the framework it drags
 * in ships TypeScript source that vite transforms, as the root config does.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    environment: 'node',
    server: { deps: { inline: [/@structure-ai\//] } }
  }
})
