import { resolve } from 'path'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Conservatively include all main/shared dependencies and the lockfile. A restart
// must reject a builtin pin if the implementation or bundled dependencies changed.
function builtinRevision(): string {
  const hash = createHash('sha256')
  const visit = (directory: string): void => {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${directory}/${item.name}`
      if (item.isDirectory()) visit(path)
      else if (!path.endsWith('.test.ts')) hash.update(path).update(readFileSync(path))
    }
  }
  visit('src/main')
  visit('src/shared')
  hash.update(readFileSync('package-lock.json'))
  hash.update(readFileSync('electron.vite.config.ts'))
  return hash.digest('hex')
}

export default defineConfig({
  main: {
    define: { __CLAVE_BUILTIN_REVISION__: JSON.stringify(builtinRevision()) },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'conversation-daemon': resolve('src/main/conversations/daemon.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
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
