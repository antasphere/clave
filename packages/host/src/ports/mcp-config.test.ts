import { expect, it } from 'vitest'
import { mcpConfigReadiness } from './mcp-config'

it('releases all boot waiters when the shell announces its MCP endpoint', async () => {
  const readiness = mcpConfigReadiness(100)
  const first = readiness.ready()
  const second = readiness.ready()
  readiness.announce(true)
  await Promise.all([first, second])
  await readiness.ready()
})

it('bounds unavailable startup and permits a later successful announcement', async () => {
  const readiness = mcpConfigReadiness(5)
  await expect(readiness.ready()).rejects.toThrow('Reopen this tab after the shell connects')
  readiness.announce(true)
  await readiness.ready()
  readiness.announce(false)
  await expect(readiness.ready()).rejects.toThrow('Clave MCP did not become available')
})
