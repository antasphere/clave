/**
 * The permission card's reading (PRDCT-4331): the level from the rules on
 * the first frame, "Reading what this does…" while the host reads, then the
 * sentence; a reading never brings the level below the rules' floor, and a
 * tab that can go back to skipping permissions says so.
 */
import { describe, expect, it, vi } from 'vitest'
import * as ReactModule from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  BackToBypass,
  ModeLine,
  PermissionLevelTag,
  PermissionReading
} from '../../../../plugins/chat-view/src/PermissionReading'
import {
  PermissionReadingProvider,
  type PermissionReadingValue
} from '../../../../plugins/chat-view/src/permission-reading-context'
import type { Permission } from '../../../../plugins/chat-view/src/reducer'

vi.mock('../../../../plugins/chat-view/src/permission-reading.css', () => ({}))
// The plugin's files sit outside the renderer's tsconfig, so vitest compiles
// their JSX to the classic runtime, which reads React off the scope.
;(globalThis as { React?: unknown }).React = ReactModule

const request = (command: string): Permission => ({
  type: 'permission_request',
  id: 'r1',
  description: 'Allow Bash?',
  toolName: 'Bash',
  input: { command },
  options: [{ id: 'allow-once', label: 'Allow once' }]
})
const render = (node: React.JSX.Element, value: PermissionReadingValue | null): string =>
  renderToStaticMarkup(
    value ? <PermissionReadingProvider value={value}>{node}</PermissionReadingProvider> : node
  )

describe('the reading on the card', () => {
  it('shows the rules level at once and says it is reading', () => {
    const html = render(<PermissionReading request={request('rm -rf build')} />, {
      explained: {},
      cwd: '/repo'
    })
    expect(html).toContain('data-level="irreversible"')
    expect(html).toContain('Hard to undo')
    expect(html).toContain('Reading what this does…')
  })

  it('shows the sentence once read, and the mismatch with the ask', () => {
    const html = render(<PermissionReading request={request('ls')} />, {
      explained: {
        r1: {
          type: 'permission_explained',
          id: 'r1',
          level: 'reads',
          sentence: 'Lists the files of the project. Changes nothing.',
          asked: 'no'
        }
      }
    })
    expect(html).toContain('Lists the files of the project. Changes nothing.')
    expect(html).toContain('Not what you asked for')
    expect(html).not.toContain('Reading what this does')
  })

  it('never shows a level below the rules, whatever the reading says', () => {
    const html = render(<PermissionReading request={request('git push --force')} />, {
      explained: {
        r1: { type: 'permission_explained', id: 'r1', level: 'reads', sentence: 'Harmless.' }
      }
    })
    expect(html).toContain('data-level="irreversible"')
  })

  it('takes a raise from the reading', () => {
    const html = render(<PermissionReading request={request('ls')} />, {
      explained: {
        r1: { type: 'permission_explained', id: 'r1', level: 'outside', sentence: 'Hm.' }
      }
    })
    expect(html).toContain('data-level="outside"')
  })

  it('stops saying it reads once the host said it could not', () => {
    const html = render(<PermissionReading request={request('ls')} />, {
      explained: { r1: { type: 'permission_explained', id: 'r1', level: 'reads', failed: 'auth' } }
    })
    expect(html).toContain('Reads only')
    expect(html).not.toContain('Reading what this does')
  })

  it('shows the level in the transcript record too', () => {
    expect(render(<PermissionLevelTag request={request('npm install')} />, null)).toContain(
      'Reaches outside the project'
    )
  })
})

describe('the way back to skipping permissions', () => {
  it('is offered only when the view gives one', () => {
    expect(render(<BackToBypass />, { explained: {} })).toBe('')
    expect(render(<BackToBypass />, { explained: {}, backToBypass: () => {} })).toContain(
      'Back to skipping permissions'
    )
  })
})

describe('the mode line', () => {
  it('says the change and who asked', () => {
    expect(
      renderToStaticMarkup(<ModeLine label="Manual" fromLabel="Bypass permissions" />)
    ).toMatch(/Switched permissions from Bypass permissions to <strong>Manual<\/strong>/)
    expect(renderToStaticMarkup(<ModeLine label="Manual" fromLabel="Plan" by="you" />)).toMatch(
      /^<div[^>]*>You switched/
    )
  })
})
