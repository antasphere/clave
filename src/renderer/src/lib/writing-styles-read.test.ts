import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import { readWritingStyles } from './writing-styles-read'

const view = {
  styles: [
    {
      id: 'quiet',
      name: 'Quiet',
      description: 'For work nobody watches.',
      text: 'Say little.',
      statusCard: true,
      builtIn: true
    }
  ],
  defaultStyleId: 'quiet',
  claudeOutputStyle: null
}

// PRDCT-5166: the window reads a machine's styles through the preload's typed
// members, this Mac's from its settings and a server's over the fleet.
describe('readWritingStyles', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("reads this Mac's styles from writingStylesList, never from the fleet", async () => {
    const writingStylesList = vi.fn(async () => view)
    const fleetWritingStyles = vi.fn(async () => view)
    vi.stubGlobal('window', { electronAPI: { writingStylesList, fleetWritingStyles } })
    expect(await readWritingStyles(LOCAL_SERVER_ID)).toBe(view)
    expect(writingStylesList).toHaveBeenCalledTimes(1)
    expect(fleetWritingStyles).not.toHaveBeenCalled()
  })

  it("reads a server's styles from fleetWritingStyles with its id", async () => {
    const writingStylesList = vi.fn(async () => view)
    const fleetWritingStyles = vi.fn(async (serverId: string) => {
      void serverId
      return view
    })
    vi.stubGlobal('window', { electronAPI: { writingStylesList, fleetWritingStyles } })
    expect(await readWritingStyles('srv')).toBe(view)
    expect(fleetWritingStyles).toHaveBeenCalledWith('srv')
    expect(writingStylesList).not.toHaveBeenCalled()
  })

  it('answers null when the read fails or the preload has no such member', async () => {
    vi.stubGlobal('window', {
      electronAPI: {
        fleetWritingStyles: vi.fn(async () => {
          throw new Error('This server needs an update to show its writing styles.')
        })
      }
    })
    expect(await readWritingStyles('srv')).toBeNull()
    expect(await readWritingStyles(LOCAL_SERVER_ID)).toBeNull()
  })
})
