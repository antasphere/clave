import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { PiCache, findPiSession, piAgentDir, piSessionDir, scanPiText } from './pi'

describe('Pi session scanner', () => {
  it('reads identity, current model settings, and prompts from Pi JSONL', () => {
    const text = [
      {
        type: 'session',
        version: 3,
        id: 'pi-1',
        timestamp: '2026-08-27T10:00:00Z',
        cwd: '/tmp/project'
      },
      { type: 'model_change', provider: 'anthropic', modelId: 'claude-sonnet-4' },
      { type: 'thinking_level_change', thinkingLevel: 'high' },
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'First task' }] }
      },
      {
        type: 'message',
        message: { role: 'assistant', provider: 'openai', model: 'gpt-5', content: [] }
      },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Follow up' }] } }
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n')
    expect(scanPiText(text, 'fallback')).toEqual({
      id: 'pi-1',
      cwd: '/tmp/project',
      firstAt: '2026-08-27T10:00:00Z',
      provider: 'openai',
      model: 'gpt-5',
      thinking: 'high',
      firstUserText: 'First task',
      lastUserText: 'Follow up'
    })
  })

  it('rejects poisoned transcript launch metadata', () => {
    const text = [
      {
        type: 'session',
        id: '../../bad',
        timestamp: '2026-08-27T10:00:00Z',
        cwd: '/tmp/project'
      },
      { type: 'model_change', provider: '--api-key', modelId: 'bad\nmodel' }
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n')
    expect(scanPiText(text, 'safe-fallback')).toMatchObject({
      id: 'safe-fallback',
      provider: null,
      model: null
    })
    expect(scanPiText(text, '../../bad')).toBeNull()
  })

  it('uses large transcript tails for current Pi resume settings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-pi-history-'))
    try {
      const filePath = path.join(dir, 'session_pi-large.jsonl')
      const head = [
        {
          type: 'session',
          version: 3,
          id: 'pi-large',
          timestamp: '2026-08-27T10:00:00Z',
          cwd: '/tmp/project'
        },
        { type: 'model_change', provider: 'anthropic', modelId: 'claude-sonnet-4' },
        {
          type: 'message',
          message: { role: 'user', content: [{ type: 'text', text: 'First task' }] }
        }
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')
      const tail = [
        { type: 'model_change', provider: 'openai', modelId: 'gpt-5' },
        { type: 'thinking_level_change', thinkingLevel: 'max' },
        {
          type: 'message',
          message: { role: 'user', content: [{ type: 'text', text: 'Latest task' }] }
        }
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')
      fs.writeFileSync(filePath, `${head}\n${'x'.repeat(9 * 1024 * 1024)}\n${tail}\n`)

      const info = new PiCache().get(filePath)
      expect(info?.id).toBe('pi-large')
      expect(info?.provider).toBe('openai')
      expect(info?.model).toBe('gpt-5')
      expect(info?.thinking).toBe('max')
      expect(info?.firstUserText).toBe('First task')
      expect(info?.lastUserText).toBe('Latest task')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// Lane D (PRDCT-4427): a Pi chat resumes only a session Pi wrote.
describe("where Pi keeps a chat's session", () => {
  it("takes Pi's home from PI_CODING_AGENT_DIR, else ~/.pi/agent", () => {
    expect(piAgentDir({ PI_CODING_AGENT_DIR: '/pi/home' })).toBe('/pi/home')
    expect(piAgentDir({})).toBe(path.join(os.homedir(), '.pi', 'agent'))
  })
  it('encodes a cwd with spaces and colons the way Pi names its folders', () => {
    expect(piSessionDir('/Users/me/my project:v2', { PI_CODING_AGENT_DIR: '/pi' })).toBe(
      path.join('/pi', 'sessions', '--Users-me-my project-v2--')
    )
    expect(piSessionDir('C:\\work\\app', { PI_CODING_AGENT_DIR: '/pi' })).toBe(
      path.join('/pi', 'sessions', '--C--work-app--')
    )
  })
  it("finds the one file named for the id in that cwd's folder, and nothing else", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-pi-find-'))
    const env = { PI_CODING_AGENT_DIR: home }
    const cwd = '/tmp/my project:x'
    const id = '0198c7d2-1111-7222-8333-444455556666'
    try {
      const dir = piSessionDir(cwd, env)
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `2026-11-13T14-21-16-666Z_${id}.jsonl`)
      fs.writeFileSync(file, '{"type":"session"}\n')
      fs.writeFileSync(path.join(dir, '2026-11-13T14-21-16-666Z_other.jsonl'), '')
      expect(findPiSession(id, cwd, env)).toBe(file)
      expect(findPiSession('0198c7d2-0000-7222-8333-444455556666', cwd, env)).toBeNull()
      // Another cwd's folder is never read.
      expect(findPiSession(id, '/tmp/elsewhere', env)).toBeNull()
      // An id Pi would refuse is never looked up.
      expect(findPiSession('../x', cwd, env)).toBeNull()
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
  it('answers null when the folder does not exist', () => {
    expect(
      findPiSession('abc', '/nowhere/at/all', { PI_CODING_AGENT_DIR: '/definitely/missing' })
    ).toBeNull()
  })
})
