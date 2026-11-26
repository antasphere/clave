import { describe, expect, it, vi } from 'vitest'

// The artefact service must load without Electron (PRDCT-4472): the
// standalone server builds it under Bun or the app's binary as Node, and has
// no Electron to ask. Asking for it fails the import, so a chain that comes
// back (a window broadcast, `app.getPath`) fails this test rather than the
// standalone server.
vi.mock('electron', () => {
  throw new Error('the artefact service imported electron')
})

describe('the artefact service without Electron', () => {
  it('loads the service, the previews, the links, the host and the command line', async () => {
    const service = await import('./service')
    const previews = await import('./preview-servers')
    const links = await import('./links')
    const host = await import('./preview-host')
    const cli = await import('./slideless-cli')
    expect(typeof service.createArtefactService).toBe('function')
    expect(typeof previews.PreviewServers).toBe('function')
    expect(typeof links.ArtefactLinks).toBe('function')
    expect(typeof host.writePreviewHost).toBe('function')
    expect(typeof cli.resolveCli).toBe('function')
  })

  it('loads the Slideless accounts, the sign-in and the links (PRDCT-4266)', async () => {
    const modules = await Promise.all([
      import('./slideless-run'),
      import('./slideless-json'),
      import('./slideless-settings'),
      import('./slideless-accounts'),
      import('./slideless-sign-in'),
      import('./artefact-decks'),
      import('./artefact-share'),
      import('./refusal')
    ])
    const [run, json, settings, accounts, signIn, decks, share, refusal] = modules
    expect(typeof run.runSlideless).toBe('function')
    expect(typeof json.parseSharedLink).toBe('function')
    expect(typeof settings.normalOrigin).toBe('function')
    expect(typeof accounts.createSlidelessAccounts).toBe('function')
    expect(typeof signIn.createSlidelessSignIns).toBe('function')
    expect(typeof decks.ArtefactDecks).toBe('function')
    expect(typeof share.createArtefactShare).toBe('function')
    expect(typeof refusal.ArtefactRefusal).toBe('function')
  })
})
