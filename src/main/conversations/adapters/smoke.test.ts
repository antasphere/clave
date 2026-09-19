import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createAdapter } from './index'
import type { ConversationEvent, ConversationProvider } from '../../../shared/agent-session'

// Opt-in only. Never submits a prompt or runs provider authentication commands.
// Storage/config homes are inside this repository and removed after shutdown.
describe.skipIf(process.env.CLAVE_PROVIDER_SMOKE !== '1')(
  'installed CLI handshakes, no model calls',
  () => {
    for (const provider of ['claude', 'codex', 'opencode', 'pi'] as ConversationProvider[]) {
      it(
        provider,
        async () => {
          const directory = await mkdtemp(resolve('.provider-smoke-'))
          const events: ConversationEvent[] = []
          const adapter = createAdapter(
            {
              command: [provider],
              additionalArgs:
                provider === 'pi' ? ['--offline', '--no-extensions', '--no-skills'] : [],
              env: {
                ...process.env,
                CLAUDE_CONFIG_DIR: directory,
                CODEX_HOME: directory,
                XDG_DATA_HOME: directory,
                XDG_STATE_HOME: directory,
                XDG_CACHE_HOME: directory,
                XDG_CONFIG_HOME: directory,
                PI_CODING_AGENT_DIR: directory,
                PI_OFFLINE: '1',
                OPENCODE_DISABLE_AUTOUPDATE: 'true'
              } as Record<string, string>,
              sessionDirectory: directory,
              options: { provider, cwd: directory }
            },
            (event) => events.push(event)
          )
          try {
            await adapter.start()
            expect(events).toContainEqual({ type: 'status', status: 'idle' })
            expect(events.some((event) => event.type === 'provider-session')).toBe(true)
            expect(
              events.some((event) => event.type === 'status' && event.status === 'error')
            ).toBe(false)
          } finally {
            await adapter.dispose()
            await rm(directory, { recursive: true, force: true })
          }
        },
        45_000
      )
    }
  }
)
