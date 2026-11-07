import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { PiCache, scanPiText } from './pi'

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
