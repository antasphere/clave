import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * What the bundles carry rather than require at runtime. The workspace
 * packages are TypeScript source, and so is the framework (`@structure-ai/*`
 * publishes its `src/`, no compiled output), so both must be bundled; Effect
 * and its platform packages ship JavaScript and stay external.
 */
const BUNDLED_SOURCE = [
  '@clave/plugin-sdk',
  '@clave/contract',
  '@clave/server',
  '@clave/client',
  '@structure-ai/client',
  '@structure-ai/config',
  '@structure-ai/cqrs',
  '@structure-ai/domain',
  '@structure-ai/eventsourcing',
  '@structure-ai/http',
  '@structure-ai/observability',
  '@structure-ai/runtime'
]

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: BUNDLED_SOURCE })],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'plugin-runner': resolve('src/main/plugins/plugin-runner.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: BUNDLED_SOURCE })]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
