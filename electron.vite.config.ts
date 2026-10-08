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
  '@structure-ai/grpc',
  '@structure-ai/http',
  '@structure-ai/observability',
  '@structure-ai/runtime'
]

/**
 * ESM-only dependencies of the main process, bundled rather than required:
 * openid-client and what it stands on ship no CommonJS build, and the main
 * bundle is CommonJS. Node 22 can `require` an ES module, but a bundle that
 * carries the code loads the same way packaged in an asar as it does from
 * `out/`, with nothing to resolve at runtime.
 */
const BUNDLED_ESM = ['openid-client', 'oauth4webapi', 'jose']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: [...BUNDLED_SOURCE, ...BUNDLED_ESM] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'plugin-runner': resolve('src/main/plugins/plugin-runner.ts'),
          // The terminal process of the standalone server (ADR 0003, wave
          // 3), run under plain Node from `out/main/terminal-process.js` by
          // scripts/server-process.mjs: it cannot run from its sources.
          'terminal-process': resolve('src/main/terminal-process/main.ts')
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
