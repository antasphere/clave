import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { rendererModuleMetadata } from './scripts/renderer-module-audit.mjs'
import { buildPlugins } from './scripts/build-plugins.mjs'

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
    plugins: [
      externalizeDepsPlugin({ exclude: [...BUNDLED_SOURCE, ...BUNDLED_ESM] }),
      // The bundled plugins written in TypeScript (apps/plugins/analytics) are built where the
      // plugin store reads bundled plugins from, by dev and build alike.
      {
        name: 'clave-bundled-plugins',
        async buildStart() {
          await buildPlugins()
        }
      }
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve('apps/desktop/src/main/index.ts'),
          'plugin-runner': resolve('apps/plugin-runner/src/main.ts'),
          // The terminal process of the standalone server (ADR 0003, wave
          // 3), run under plain Node from `out/main/terminal-process.js` by
          // scripts/server-process.mjs: it cannot run from its sources.
          'terminal-process': resolve('apps/terminals/src/main.ts'),
          // The server as its own process (ADR 0003, wave 5): run from
          // `out/main/server-entry.js` under the app's own Node
          // (ELECTRON_RUN_AS_NODE) by the packaged app, and still from its
          // sources under Bun by the dev script and the harness.
          'server-entry': resolve('apps/server/src/main.ts')
        }
      }
    }
  },
  preload: {
    build: { rollupOptions: { input: resolve('apps/desktop/src/preload/index.ts') } },
    plugins: [externalizeDepsPlugin({ exclude: BUNDLED_SOURCE })]
  },
  renderer: {
    root: resolve('apps/desktop/src/renderer'),
    build: {
      outDir: resolve('out/renderer'),
      rollupOptions: { input: resolve('apps/desktop/src/renderer/index.html') }
    },
    resolve: {
      alias: {
        '@renderer': resolve('apps/desktop/src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss(), rendererModuleMetadata()]
  }
})
