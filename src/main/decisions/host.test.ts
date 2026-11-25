import { describe, expect, it, vi } from 'vitest'
import type { TabProjects } from '@clave/contract/tab-projects-rules'
import { DECISION_FAILURE_REASONS } from '@clave/contract/decisions'
import type { RegistryWorkspace } from '../routines/resolve'
import { hostDecisions, type DecisionRecord, type HostDecisionsOptions } from './host'
import type { ProjectOption } from './project-options'
import type { TabReading, TabSource } from './tab-reading'
import { basisOf, tabProjectDecision, type TabProjectInput } from './tab-project'
import type { DecisionOutcome } from './runner'
import type { TabProjectOutcome } from './tab-project'

// The decisions' host (PRDCT-5179) over fakes for the records, the
// transcript, the options and the request: nothing is read from disk and
// nothing reaches TypeSafe. Invented workspaces, projects and tabs only.

const W = '/w/lab'
const lab: RegistryWorkspace = { id: 'ws-lab', name: 'Lab', rootDir: W, profileFile: null }
const other: RegistryWorkspace = {
  id: 'ws-other',
  name: 'Other',
  rootDir: '/w/other',
  profileFile: null
}
const quill: ProjectOption = {
  file: `${W}/.clave/workspaces/default.clave`,
  name: 'Quill',
  folder: 'quill',
  description: 'The Quill editor.'
}
const atlas: ProjectOption = {
  file: `${W}/.clave/workspaces/default.clave`,
  name: 'Atlas',
  folder: 'atlas',
  description: 'The Atlas maps.'
}
const tab: TabReading = {
  firstMessage: 'Fix the Quill toolbar.',
  latestMessages: ['Now the tests.'],
  touched: { [`${W}/quill/bar.tsx`]: 3 }
}
const claudeTab = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  claudeMode: true,
  claudeSessionId: 'conv-claude',
  cwd: `${W}/quill`,
  workspaceId: lab.id,
  ...over
})
const decided: TabProjectOutcome = {
  status: 'decided',
  picks: [{ file: quill.file, name: 'Quill', p: 0.95 }],
  fits: 0.93
}

interface Setup {
  records: Map<string, DecisionRecord>
  written: Array<[string, TabProjects]>
  reads: TabSource[]
  optionReads: string[]
  runs: TabProjectInput[]
  host: ReturnType<typeof hostDecisions>
}

function setup(
  records: Record<string, DecisionRecord>,
  over: Partial<HostDecisionsOptions> & {
    outcome?: (input: TabProjectInput) => DecisionOutcome<TabProjectOutcome>
  } = {}
): Setup {
  const s: Omit<Setup, 'host'> = {
    records: new Map(Object.entries(records)),
    written: [],
    reads: [],
    optionReads: [],
    runs: []
  }
  const host = hostDecisions({
    recordOf: (id) => s.records.get(id),
    setProjects: (id, projects) => {
      const record = s.records.get(id)
      if (!record) return false
      s.records.set(id, { ...record, projects })
      s.written.push([id, projects])
      return true
    },
    workspaces: () => [lab, other],
    files: () => undefined,
    readTab: async (source) => {
      s.reads.push(source)
      return tab
    },
    optionsOf: async (workspace) => {
      s.optionReads.push(workspace.id)
      return workspace.id === lab.id ? [quill, atlas] : []
    },
    run: async (input) => {
      s.runs.push(input)
      return over.outcome
        ? over.outcome(input)
        : { ok: true, value: decided, model: 'jev-1.14.0', ms: 220, inputTokens: 900 }
    },
    now: () => 5_000,
    home: '/w',
    preflight: () => null,
    ...over
  })
  return { ...s, host }
}

const basisFor = (options: ProjectOption[]): string =>
  basisOf(
    tabProjectDecision.build({ tab, options, workspaceRoot: W, home: '/w' })!,
    tabProjectDecision.model
  )

describe('a tab read on the host', () => {
  it('decided: the reading is written on the record with the model that answered, and said written', async () => {
    const s = setup({ a: claudeTab({ configDir: '/w/accounts/work' }) })
    const [answer] = await s.host.readTabProjects(['a'])
    const reading: TabProjects = {
      status: 'decided',
      picks: decided.picks,
      fits: 0.93,
      readAt: 5_000,
      model: 'jev-1.14.0',
      basis: basisFor([quill, atlas])
    }
    expect(answer).toEqual({ sessionId: 'a', projects: reading, written: true })
    expect(s.written).toEqual([['a', reading]])
    expect(s.reads).toEqual([
      {
        harness: 'claude',
        cwd: `${W}/quill`,
        conversationId: 'conv-claude',
        configDir: '/w/accounts/work',
        workspaceRoot: W
      }
    ])
    expect(s.runs[0]).toMatchObject({ options: [quill, atlas], workspaceRoot: W, home: '/w' })
  })

  it('undecided and none are readings like any other', async () => {
    const torn: TabProjectOutcome = {
      status: 'undecided',
      picks: [
        { file: quill.file, name: 'Quill', p: 0.5 },
        { file: atlas.file, name: 'Atlas', p: 0.4 }
      ],
      fits: 0.8
    }
    const none: TabProjectOutcome = { status: 'none', picks: [], fits: 0.3 }
    const s = setup(
      { torn: claudeTab(), none: claudeTab({ claudeSessionId: 'conv-2' }) },
      {
        outcome: () => ({
          ok: true,
          value: s.runs.length === 1 ? torn : none,
          model: 'jev-latest-1.15.0',
          ms: 1,
          inputTokens: null
        })
      }
    )
    const answers = await s.host.readTabProjects(['torn'])
    expect(answers[0].projects).toMatchObject({ status: 'undecided', model: 'jev-latest-1.15.0' })
    const [noneAnswer] = await s.host.readTabProjects(['none'])
    expect(noneAnswer).toMatchObject({ projects: { status: 'none', picks: [] }, written: true })
  })

  it('the same basis asks nothing: the record’s reading is answered as it is', async () => {
    const held: TabProjects = {
      status: 'decided',
      picks: decided.picks,
      fits: 0.9,
      readAt: 1,
      model: 'jev-1.14.0',
      basis: basisFor([quill, atlas])
    }
    const s = setup({ a: claudeTab({ projects: held }) })
    expect(await s.host.readTabProjects(['a'])).toEqual([
      { sessionId: 'a', projects: held, written: false }
    ])
    expect(s.runs).toEqual([])
    expect(s.written).toEqual([])
    // Another basis (the tab said more since) is asked again.
    const stale = setup({ a: claudeTab({ projects: { ...held, basis: 'an-older-basis' } }) })
    expect((await stale.host.readTabProjects(['a']))[0].written).toBe(true)
    expect(stale.runs).toHaveLength(1)
  })

  it('a failure leaves the record as it was and answers its old reading with the reason', async () => {
    const held: TabProjects = {
      status: 'decided',
      picks: decided.picks,
      fits: 0.9,
      readAt: 1,
      model: 'jev-1.14.0',
      basis: 'an-older-basis'
    }
    for (const reason of ['no-key', 'unreachable', 'limit', 'disabled'] as const) {
      const s = setup(
        { a: claudeTab({ projects: held }), b: claudeTab({ claudeSessionId: 'conv-b' }) },
        { outcome: () => ({ ok: false, reason, detail: 'said' }) }
      )
      expect(await s.host.readTabProjects(['a', 'b'])).toEqual([
        { sessionId: 'a', projects: held, reason, written: false },
        { sessionId: 'b', projects: null, reason, written: false }
      ])
      expect(s.written).toEqual([])
      expect(s.records.get('a')?.projects).toBe(held)
    }
  })

  it('a terminal, another harness, an unknown id, a tab with no workspace or none known answer nothing', async () => {
    const s = setup({
      terminal: { cwd: W, workspaceId: lab.id },
      antigravity: { cwd: W, workspaceId: lab.id, claudeMode: false },
      noConversation: claudeTab({ claudeSessionId: undefined }),
      noWorkspace: claudeTab({ workspaceId: undefined }),
      goneWorkspace: claudeTab({ workspaceId: 'ws-gone' })
    })
    const ids = [
      'terminal',
      'antigravity',
      'noConversation',
      'noWorkspace',
      'goneWorkspace',
      'unknown'
    ]
    const answers = await s.host.readTabProjects(ids)
    expect(answers).toEqual(
      ids.map((sessionId) => ({ sessionId, projects: null, reason: 'nothing', written: false }))
    )
    expect(s.reads).toEqual([])
    expect(s.runs).toEqual([])
  })

  it('reads Codex and Pi tabs by their own conversation, and a live one when the record has none', async () => {
    const s = setup(
      {
        codex: { codexMode: true, codexThreadId: 'thread-1', cwd: W, workspaceId: lab.id },
        pi: { piMode: true, piSessionId: 'pi-1', cwd: W, workspaceId: lab.id },
        codexTerminal: { codexMode: true, cwd: W, workspaceId: lab.id }
      },
      { conversationOf: (id) => (id === 'codexTerminal' ? 'rollout-7' : null) }
    )
    await s.host.readTabProjects(['codex', 'pi', 'codexTerminal'])
    expect(s.reads.map((r) => [r.harness, r.conversationId])).toEqual([
      ['codex', 'thread-1'],
      ['pi', 'pi-1'],
      ['codex', 'rollout-7']
    ])
  })

  it('a tab with nothing to ask (no options in its workspace, nothing said) answers nothing', async () => {
    const silentRead = vi.fn(async (source: TabSource) =>
      source.conversationId === 'conv-silent' ? null : tab
    )
    const quiet = setup(
      {
        elsewhere: claudeTab({ workspaceId: other.id }),
        silent: claudeTab({ claudeSessionId: 'conv-silent' })
      },
      { readTab: silentRead }
    )
    expect(await quiet.host.readTabProjects(['elsewhere', 'silent'])).toEqual([
      { sessionId: 'elsewhere', projects: null, reason: 'nothing', written: false },
      { sessionId: 'silent', projects: null, reason: 'nothing', written: false }
    ])
    expect(quiet.runs).toEqual([])
  })

  it('reads one workspace’s options once within a call, and again at the next call', async () => {
    const s = setup({
      a: claudeTab(),
      b: claudeTab({ claudeSessionId: 'conv-b' }),
      c: claudeTab({ claudeSessionId: 'conv-c' }),
      d: claudeTab({ claudeSessionId: 'conv-d', workspaceId: other.id })
    })
    await s.host.readTabProjects(['a', 'b', 'c', 'd'])
    expect(s.optionReads.sort()).toEqual([lab.id, other.id])
    await s.host.readTabProjects(['a'])
    expect(s.optionReads.filter((id) => id === lab.id)).toHaveLength(2)
  })

  it('one tab that throws fails alone', async () => {
    const s = setup(
      { a: claudeTab(), b: claudeTab({ claudeSessionId: 'conv-b' }) },
      {
        readTab: async (source) => {
          if (source.conversationId === 'conv-b') throw new Error('unreadable transcript')
          return tab
        }
      }
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const answers = await s.host.readTabProjects(['a', 'b'])
      expect(answers[0]).toMatchObject({ sessionId: 'a', written: true })
      expect(answers[1]).toEqual({
        sessionId: 'b',
        projects: null,
        reason: 'failed',
        written: false
      })
    } finally {
      error.mockRestore()
    }
  })

  it('the wire’s reasons are the runner’s own', () => {
    // The type-level check is in host.ts; this holds the list's order too.
    expect([...DECISION_FAILURE_REASONS]).toEqual([
      'no-key',
      'disabled',
      'nothing',
      'refused',
      'unreachable',
      'limit',
      'unreadable',
      'failed',
      'cancelled'
    ])
  })
})

describe('a host where the decision cannot run', () => {
  const read: DecisionRecord = {
    claudeMode: true,
    claudeSessionId: 'c-1',
    cwd: W,
    workspaceId: lab.id,
    projects: {
      status: 'decided',
      picks: [{ file: quill.file, name: quill.name, p: 0.97 }],
      fits: 0.95,
      readAt: 1,
      model: 'jev-1.14.0',
      basis: 'b'
    }
  }

  for (const reason of ['no-key', 'disabled'] as const) {
    it(`reads nothing, asks nothing and serves no reading (${reason})`, async () => {
      const s = setup({ a: read, b: { ...read, projects: undefined } }, { preflight: () => reason })
      expect(await s.host.readTabProjects(['a', 'b'])).toEqual([
        { sessionId: 'a', projects: null, reason, written: false },
        { sessionId: 'b', projects: null, reason, written: false }
      ])
      expect(s.reads).toEqual([])
      expect(s.optionReads).toEqual([])
      expect(s.runs).toEqual([])
      expect(s.written).toEqual([])
      // The record keeps its reading for the day the decision runs again.
      expect(s.records.get('a')?.projects).toEqual(read.projects)
    })
  }

  it('goes on when whether it may run cannot be read', async () => {
    const s = setup(
      { a: { ...read, projects: undefined } },
      {
        preflight: () => {
          throw new Error('the settings are unreadable')
        }
      }
    )
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const [answer] = await s.host.readTabProjects(['a'])
    errors.mockRestore()
    expect(answer.written).toBe(true)
    expect(s.runs).toHaveLength(1)
  })
})
