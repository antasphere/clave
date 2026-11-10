import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The road's registration at boot, pinned on the shell's source (integration
 * round 2, G8): no unit test renders the shell, and unregistering the road
 * left every test green. The three views' wiring is pinned by behaviour in
 * the end-to-end spec chat-provider-switch (the chip's provider row opens the
 * popover and the card reads the move in the chat, Enclave and Folio views).
 */
describe('the provider road is registered at boot (PRDCT-4300)', () => {
  it('the shell installs the road beside the served events', () => {
    const shell = readFileSync(
      join(import.meta.dirname, '../../../src/renderer/src/components/layout/AppShell.tsx'),
      'utf8'
    )
    expect(shell).toContain("import { installProviderSwitchRoad } from '../../lib/switch-provider'")
    expect(shell).toMatch(/^\s*installProviderSwitchRoad\(\)\s*$/m)
  })
})
