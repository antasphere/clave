import { defineConfig } from 'vitest/config'

/** The package's own runner, for a checkout of the package alone; the Clave
 *  monorepo's root `vitest.config.ts` includes these tests too. */
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], environment: 'node' }
})
