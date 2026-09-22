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
 * `include` covers `src/` broadly rather than listing directories (and the
 * release scripts' own tests under `scripts/`), so a new test runs by existing — `.tsx` included, or a component test would be skipped in
 * silence, which is the same failure this suite was written to stop. `environment: 'node'` is the default; a test that genuinely
 * needs a DOM declares `// @vitest-environment jsdom` in its own file.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
    environment: 'node'
  }
})
