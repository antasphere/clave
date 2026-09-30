import { pathToFileURL } from 'node:url'
import { createPluginAPI, type PluginDefinition } from '@clave/plugin-sdk'

// This bootstrap is bundled separately: plugin code never runs in Electron main.
process.parentPort.once('message', async (event) => {
  const port = event.ports[0]
  const listeners = new Set<(message: unknown) => void>()
  port.on('message', (event) => {
    for (const listener of listeners) listener(event.data)
  })
  port.start()
  const { api, dispose } = createPluginAPI({
    postMessage: (message) => port.postMessage(message),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  })
  let plugin: PluginDefinition | undefined
  let stopping = false
  port.on('message', async (message) => {
    if (message.data?.method !== 'host.deactivate' || stopping) return
    stopping = true
    try {
      await plugin?.deactivate?.()
    } finally {
      dispose()
      process.exit(0)
    }
  })
  try {
    const loaded = await import(/* @vite-ignore */ pathToFileURL(event.data.main).href)
    plugin = loaded.default ?? loaded
    if (!plugin || typeof plugin.activate !== 'function')
      throw new Error('Plugin must export activate(api)')
    await plugin.activate(api)
    port.postMessage({ jsonrpc: '2.0', method: 'plugin.ready' })
  } catch (error) {
    port.postMessage({
      jsonrpc: '2.0',
      method: 'plugin.failed',
      params: { message: String(error) }
    })
    process.exitCode = 1
    setTimeout(() => process.exit(1), 20)
  }
})
