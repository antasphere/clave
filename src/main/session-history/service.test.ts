/**
 * The message trail's read and the Ongoing card's last exchange (PRDCT-4207):
 * a conversation whose tab ran on its own account directory keeps its
 * transcript under that directory, and is read from there.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

import { conversationRoot, getConversation } from './service'
import { transcriptPath } from './transcript-peek'

const j = (v: unknown): string => JSON.stringify(v)

let tmp: string
let shared: string
let account: string
const cwd = '/Users/someone/work'

function writeTranscript(root: string, id: string, said: string): void {
  const file = transcriptPath(root, cwd, id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    [
      j({ type: 'user', timestamp: '2026-11-08T10:00:00.000Z', message: { content: said } }),
      j({ type: 'assistant', message: { content: [{ type: 'text', text: 'Noted.' }] } })
    ].join('\n') + '\n'
  )
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-history-root-'))
  shared = path.join(tmp, 'shared-projects')
  account = path.join(tmp, 'account-home')
  fs.mkdirSync(shared, { recursive: true })
  process.env.CLAVE_TRANSCRIPTS_ROOT = shared
  writeTranscript(path.join(account, 'projects'), 'conv-acct', 'Send the accountant the Q3 file')
  writeTranscript(shared, 'conv-shared', 'Draft the reply')
})

afterAll(() => {
  delete process.env.CLAVE_TRANSCRIPTS_ROOT
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the conversation read follows its account directory', () => {
  it('reads a conversation kept under its account directory', () => {
    const res = getConversation({ cwd, claudeSessionId: 'conv-acct', configDir: account })
    expect(res.exists).toBe(true)
    expect(res.turns.at(-1)?.userText).toBe('Send the accountant the Q3 file')
  })

  it('does not find it in the shared root without the directory', () => {
    expect(getConversation({ cwd, claudeSessionId: 'conv-acct' }).exists).toBe(false)
  })

  it('keeps reading the shared root for a conversation with no directory', () => {
    const res = getConversation({ cwd, claudeSessionId: 'conv-shared' })
    expect(res.exists).toBe(true)
    expect(res.turns.at(-1)?.userText).toBe('Draft the reply')
  })

  it('takes only an absolute directory; anything else is the shared root', () => {
    expect(conversationRoot(account)).toBe(path.join(account, 'projects'))
    expect(conversationRoot('relative/dir')).toBe(shared)
    expect(conversationRoot('   ')).toBe(shared)
    expect(conversationRoot(42)).toBe(shared)
    expect(conversationRoot(undefined)).toBe(shared)
    // As the spawn sets CLAUDE_CONFIG_DIR: never trimmed into another directory.
    expect(conversationRoot(`${account} `)).toBe(path.join(`${account} `, 'projects'))
    expect(conversationRoot(` ${account}`)).toBe(shared)
  })
})
