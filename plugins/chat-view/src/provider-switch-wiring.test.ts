import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The wiring of the provider road into the shell and the three views, pinned
 * on the sources (integration round 2, G8): no unit test renders a view or
 * the shell, and the integration tester found that unregistering the road at
 * boot, or dropping a view's `onSwitchProvider`, left every test green. The
 * pin is coarse by design: it says these calls are there, not that they work;
 * the end-to-end spec chat-provider-switch says that.
 */
const read = (path: string): string => readFileSync(join(import.meta.dirname, path), 'utf8')

describe('the provider road is wired where it must be (PRDCT-4300)', () => {
  it('the shell registers the road at boot', () => {
    const shell = read('../../../src/renderer/src/components/layout/AppShell.tsx')
    expect(shell).toContain("import { installProviderSwitchRoad } from '../../lib/switch-provider'")
    expect(shell).toMatch(/^\s*installProviderSwitchRoad\(\)\s*$/m)
  })
  for (const view of ['ChatView.tsx', 'TerminalView.tsx', 'lab/FolioView.tsx']) {
    it(`${view} hands the chip a move, opens the popover and draws the card`, () => {
      const source = read(view)
      expect(source).toContain('useProviderSwitch({')
      expect(source).toMatch(
        /onSwitchProvider=\{isRemoteKey\(session\.id\) \? undefined : providerSwitch\.begin\}/
      )
      expect(source).toContain('<ProviderSwitch')
      expect(source).toContain('<ContinuedFromCard')
      expect(source).toContain('onContinue={(options) => void providerSwitch.confirm(options)}')
    })
  }
})
