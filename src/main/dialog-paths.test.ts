import { describe, expect, it } from 'vitest'
import { rememberedOpenDialogs } from './dialog-paths'

describe('rememberedOpenDialogs', () => {
  const harness = (
    answers: { canceled: boolean; filePaths: string[] }[]
  ): { dialogs: ReturnType<typeof rememberedOpenDialogs>; shown: (string | undefined)[] } => {
    const shown: (string | undefined)[] = []
    const dialogs = rememberedOpenDialogs({
      show: async (_win, options) => {
        shown.push(options.defaultPath)
        return answers.shift() ?? { canceled: true, filePaths: [] }
      },
      home: () => '/Users/me'
    })
    return { dialogs, shown }
  }

  it('opens at home the first time, then where the last pick of that kind was browsed', async () => {
    const { dialogs, shown } = harness([
      { canceled: false, filePaths: ['/Users/me/code/app'] },
      { canceled: false, filePaths: ['/Users/me/code/other/README.md'] }
    ])
    await dialogs.open('folder', undefined, { properties: ['openDirectory'] })
    await dialogs.open('folder', undefined, { properties: ['openDirectory'] })
    await dialogs.open('folder', undefined, { properties: ['openDirectory'] })
    expect(shown).toEqual(['/Users/me', '/Users/me/code', '/Users/me/code/other'])
  })

  it('keeps kinds apart, forgets nothing on a cancel, and leaves a named defaultPath alone', async () => {
    const { dialogs, shown } = harness([
      { canceled: false, filePaths: ['/Users/me/code/app'] },
      { canceled: true, filePaths: [] },
      { canceled: false, filePaths: [] }
    ])
    await dialogs.open('folder', undefined, { properties: ['openDirectory'] })
    await dialogs.open('file', undefined, { properties: ['openFile'] })
    await dialogs.open('folder', undefined, { properties: ['openDirectory'] })
    await dialogs.open('folder', undefined, { properties: ['openDirectory'], defaultPath: '/tmp' })
    expect(shown).toEqual(['/Users/me', '/Users/me', '/Users/me/code', '/tmp'])
  })
})
