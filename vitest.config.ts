import { defineConfig } from 'vitest/config'

/**
 * The unit tests: pure logic only. Nothing here boots Electron or renders a
 * component — the running app is verified by the Electron end-to-end specs
 * (`npm run test:e2e`, tests/e2e/), and the split is deliberate. Anything that
 * can be decided without a window belongs here, where it runs in milliseconds
 * and cannot be skipped: the `.clave` trust boundary is the clearest example,
 * since an untrusted file whose prompt is neither disclosed nor stripped looks
 * exactly like one that is.
 *
 * Every app folder is included, including workers and CLI entrypoints.
 * A new .test.ts or .test.tsx runs by existing. Tests needing a DOM declare
 * `// @vitest-environment jsdom` in their own file.
 */
export default defineConfig({
  test: {
    include: [
      'apps/**/*.test.{ts,tsx,mjs}',
      'packages/**/*.test.{ts,tsx,mjs}',
      'scripts/**/*.test.mjs',
      'tests/e2e/**/*.test.mjs'
    ],
    environment: 'node',
    // The framework ships TypeScript source, not compiled output, so Node
    // cannot load it from node_modules on its own: vite transforms it instead.
    server: { deps: { inline: [/@structure-ai\//] } }
  }
})
