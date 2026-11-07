import { pathToFileURL } from 'node:url'
import { createPluginAPI, type PluginDefinition } from '@clave/plugin-sdk'

// This bootstrap is bundled separately: plugin code never runs in the process
// that hosts it. Two roads bring it up, and the plugin sees neither: Electron
// main spawns it on utilityProcess and hands it a MessagePort in the first
// message (`electron-runner.ts`); a server outside Electron forks it under
// Node IPC, the channel itself carrying the messages (`fork-runner.ts`,
// PRDCT-3433). Both first messages name the plugin's `main`.
interface Transport {
  post(message: unknown): void
  subscribe(listener: (message: unknown) => void): () => void
}

async function boot(main: string, transport: Transport): Promise<void> {
  const { api, dispose } = createPluginAPI({
    postMessage: (message) => transport.post(message),
    subscribe: (listener) => transport.subscribe(listener)
  })
  let plugin: PluginDefinition | undefined
  let stopping = false
  transport.subscribe((message) => {
    if ((message as { method?: unknown } | null)?.method !== 'host.deactivate' || stopping) return
    stopping = true
    void (async () => {
      try {
        await plugin?.deactivate?.()
      } finally {
        dispose()
        process.exit(0)
      }
    })()
  })
  try {
    const loaded = await import(/* @vite-ignore */ pathToFileURL(main).href)
    plugin = loaded.default ?? loaded
    if (!plugin || typeof plugin.activate !== 'function')
      throw new Error('Plugin must export activate(api)')
    await plugin.activate(api)
    transport.post({ jsonrpc: '2.0', method: 'plugin.ready' })
  } catch (error) {
    transport.post({
      jsonrpc: '2.0',
      method: 'plugin.failed',
      params: { message: String(error) }
    })
    process.exitCode = 1
    setTimeout(() => process.exit(1), 20)
  }
}

const parentPort = (process as NodeJS.Process & { parentPort?: Electron.ParentPort }).parentPort
if (parentPort) {
  parentPort.once('message', (event) => {
    const port = event.ports[0]
    const listeners = new Set<(message: unknown) => void>()
    port.on('message', (message) => {
      for (const listener of listeners) listener(message.data)
    })
    port.start()
    void boot((event.data as { main: string }).main, {
      post: (message) => port.postMessage(message),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    })
  })
} else {
  process.once('message', (first) => {
    const listeners = new Set<(message: unknown) => void>()
    process.on('message', (message) => {
      for (const listener of listeners) listener(message)
    })
    void boot((first as { main: string }).main, {
      post: (message) => {
        process.send?.(message)
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    })
  })
}
