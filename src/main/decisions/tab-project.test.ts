import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { JEV_FALLBACK_MODEL, JEV_MODEL } from '../../shared/jev'
import type { JevAnswers, JevRequest } from './jev-client'
import type { ProjectOption } from './project-options'
import {
  basisOf,
  buildTabProjectRequest,
  ELSEWHERE,
  largestQuestionTokens,
  QUESTION_TOKEN_BUDGET,
  readTabProjectAnswers,
  tabProjectDecision,
  touchedFolders,
  type TabProjectInput
} from './tab-project'

// The first decision (PRDCT-5179), on an invented tab and three invented
// projects: the request is exactly the measured shape, and the answers are
// read by the contract's floors.

const W = '/Users/ada/w'
const quill: ProjectOption = {
  file: `${W}/.clave/workspaces/default.clave`,
  name: 'Quill',
  folder: 'labs/products/quill',
  description: 'The Quill editor, its web app and its API.'
}
const atlas: ProjectOption = {
  file: `${W}/labs/products/atlas/.clave/workspaces/default.clave`,
  name: 'Atlas',
  folder: 'labs/products/atlas',
  description: 'The Atlas maps.'
}
const lumen: ProjectOption = {
  file: `${W}/.clave/workspaces/default.clave`,
  name: 'Lumen',
  folder: 'studio/lumen',
  description: 'The Lumen site for a client, written by ada@lumen.example.'
}
const options = [quill, atlas, lumen]

const input = (over: Partial<TabProjectInput['tab']> = {}): TabProjectInput => ({
  tab: {
    firstMessage: `Fix the toolbar in ${W}/labs/products/quill/quill-web/src/bar.tsx,\nsee https://quill.example/issues/7`,
    latestMessages: ['Now the tests.', `Open /Users/ada/Desktop/shot.png`],
    touched: {
      [`${W}/labs/products/quill/quill-web/src/bar.tsx`]: 5,
      [`${W}/labs/products/quill/quill-api/x.ts`]: 2,
      [`${W}/labs/products/atlas/a.ts`]: 1,
      [`${W}/private/notes.md`]: 3
    },
    ...over
  },
  options,
  workspaceRoot: W,
  home: '/Users/ada'
})

describe('the tab-project request', () => {
  it('is exactly the measured shape: one session, two questions', () => {
    const criteria = {
      Quill: 'Folder labs/products/quill. The Quill editor, its web app and its API.',
      Atlas: 'Folder labs/products/atlas. The Atlas maps.',
      Lumen: 'Folder studio/lumen. The Lumen site for a client, written by <email>.'
    }
    expect(buildTabProjectRequest(input())).toEqual({
      state: {
        sessions: [
          {
            first_message:
              'Fix the toolbar in labs/products/quill/quill-web/src/bar.tsx, see https://quill.example/…',
            latest_messages: ['Now the tests.', 'Open <path>'],
            folders_its_tools_touched: {
              'labs/products/quill/quill-web': 5,
              [ELSEWHERE]: 3,
              'labs/products/quill/quill-api': 2,
              'labs/products/atlas': 1
            }
          }
        ]
      },
      questions: {
        project: {
          type: 'choice',
          instructions:
            'Which project is this agent session working on? Judge by what is said in it and by the folders its tools touched.',
          criteria
        },
        fits: {
          type: 'noul',
          instructions: {
            statement: 'The work in this session belongs to one of the listed projects.',
            projects: criteria
          }
        }
      }
    })
  })

  it('clips the first message at 1,500 and each latest one at 400', () => {
    const request = buildTabProjectRequest(
      input({ firstMessage: 'quill '.repeat(600), latestMessages: ['atlas '.repeat(150)] })
    )!
    const session = (request.state as { sessions: Array<Record<string, unknown>> }).sessions[0]
    expect((session.first_message as string).length).toBe(1500)
    expect((session.latest_messages as string[])[0].length).toBe(400)
  })

  it('nothing said, or no project: null', () => {
    expect(buildTabProjectRequest(input({ firstMessage: '  ' }))).toBeNull()
    expect(buildTabProjectRequest({ ...input(), options: [] })).toBeNull()
  })

  it('the root option is named the workspace root and names no folder key', () => {
    const root: ProjectOption = {
      ...quill,
      name: 'Workspace',
      folder: '',
      description: 'All of it.'
    }
    const request = buildTabProjectRequest({ ...input(), options: [root, atlas] })!
    const criteria = (request.questions.project as { criteria: Record<string, string> }).criteria
    expect(criteria.Workspace).toBe('Folder (the workspace root). All of it.')
    expect(touchedFolders(input().tab.touched, [root, atlas], W)).toEqual({
      [ELSEWHERE]: 10,
      'labs/products/atlas': 1
    })
  })

  it('counts a path under the folder it sits in, cut at four components', () => {
    const deep: ProjectOption = {
      ...quill,
      name: 'Quill web',
      folder: 'labs/products/quill/quill-web/src'
    }
    expect(touchedFolders(input().tab.touched, [quill, deep], W)).toEqual({
      'labs/products/quill/quill-web': 5,
      [ELSEWHERE]: 4,
      'labs/products/quill/quill-api': 2
    })
    // The project's folder itself, and a file right in it, count under it.
    expect(
      touchedFolders(
        { [`${W}/labs/products/quill`]: 2, [`${W}/labs/products/quill/README.md`]: 1 },
        [quill],
        W
      )
    ).toEqual({ 'labs/products/quill': 3 })
  })

  it('keeps the six largest keys, elsewhere among them', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      ...atlas,
      name: `P${i}`,
      folder: `p/${i}`
    }))
    const touched: Record<string, number> = { [`${W}/nowhere/x`]: 4 }
    many.forEach((option, i) => (touched[`${W}/${option.folder}/f.ts`] = 10 - i))
    expect(touchedFolders(touched, many, W)).toEqual({
      'p/0': 10,
      'p/1': 9,
      'p/2': 8,
      'p/3': 7,
      'p/4': 6,
      'p/5': 5
    })
    // Two paths under no folder add up to 8: elsewhere ranks with the rest
    // (a tie goes by name), and the smallest folder leaves.
    touched[`${W}/nowhere/y`] = 4
    expect(Object.keys(touchedFolders(touched, many, W))).toEqual([
      'p/0',
      'p/1',
      ELSEWHERE,
      'p/2',
      'p/3',
      'p/4'
    ])
  })

  it('shortens every description evenly when a question would pass the budget', () => {
    const wide = Array.from({ length: 120 }, (_, i) => ({
      ...atlas,
      name: `Project ${i}`,
      folder: `p/${i}`,
      description: `Project ${i}: ${'words '.repeat(400)}`
    }))
    const request = buildTabProjectRequest({ ...input(), options: wide })!
    expect(largestQuestionTokens(request)).toBeLessThanOrEqual(QUESTION_TOKEN_BUDGET)
    const criteria = (request.questions.project as { criteria: Record<string, string> }).criteria
    const lengths = Object.values(criteria).map((c) => c.replace(/^Folder p\/\d+\. /, '').length)
    // 1,200 passes the budget, 600 fits: every description cut at 600 (a
    // space before the cut is dropped, so one character less at most).
    for (const length of lengths) expect(length === 600 || length === 599).toBe(true)
    const unshortened: JevRequest = {
      ...request,
      questions: {
        project: {
          type: 'choice',
          instructions: 'Which project?',
          criteria: Object.fromEntries(wide.map((o) => [o.name, o.description]))
        }
      }
    }
    expect(largestQuestionTokens(unshortened)).toBeGreaterThan(QUESTION_TOKEN_BUDGET)
    // A request that fits is never shortened.
    const small = buildTabProjectRequest(input())!
    expect(
      (small.questions.project as { criteria: Record<string, string> }).criteria.Quill
    ).toContain(quill.description)
  })
})

describe('reading the answers', () => {
  const answers = (probabilities: Record<string, number>, noul: number): JevAnswers => ({
    project: { type: 'choice', choice: 'Quill', confidence: 0.5, probabilities },
    fits: { type: 'noul', noul }
  })

  it('a decided tab names its project with the file it is declared in', () => {
    expect(
      readTabProjectAnswers(answers({ Quill: 0.95, Atlas: 0.03, Lumen: 0.02 }, 0.98), { options })
    ).toEqual({
      status: 'decided',
      picks: [{ file: quill.file, name: 'Quill', p: 0.95 }],
      fits: 0.98
    })
  })

  it('a pair that holds the floor together is decided as two', () => {
    expect(
      readTabProjectAnswers(answers({ Quill: 0.6, Atlas: 0.35, Lumen: 0.05 }, 0.9), { options })
    ).toEqual({
      status: 'decided',
      picks: [
        { file: quill.file, name: 'Quill', p: 0.6 },
        { file: atlas.file, name: 'Atlas', p: 0.35 }
      ],
      fits: 0.9
    })
  })

  it('an undecided tab keeps the two nearest', () => {
    expect(
      readTabProjectAnswers(answers({ Quill: 0.5, Atlas: 0.15, Lumen: 0.35 }, 0.9), { options })
    ).toMatchObject({
      status: 'undecided',
      picks: [{ name: 'Quill' }, { name: 'Lumen' }]
    })
  })

  it('no project fits: none, whatever the choice says', () => {
    expect(
      readTabProjectAnswers(answers({ Quill: 0.97, Atlas: 0.02, Lumen: 0.01 }, 0.1), { options })
    ).toEqual({
      status: 'none',
      picks: [],
      fits: 0.1
    })
  })

  it('a share naming a project that was not an option: null, never half a reading', () => {
    expect(
      readTabProjectAnswers(
        {
          project: {
            type: 'choice',
            choice: 'Nowhere',
            confidence: 0.9,
            probabilities: { Nowhere: 0.95, Quill: 0.05 }
          },
          fits: { type: 'noul', noul: 0.9 }
        },
        { options }
      )
    ).toBeNull()
  })

  it('a missing or wrong-shaped answer: null', () => {
    expect(readTabProjectAnswers({}, { options })).toBeNull()
    expect(
      readTabProjectAnswers(
        { project: { type: 'noul', noul: 1 }, fits: { type: 'noul', noul: 1 } },
        { options }
      )
    ).toBeNull()
    expect(
      readTabProjectAnswers(
        { project: answers({ Quill: 1 }, 1).project, fits: answers({ Quill: 1 }, 1).project },
        { options }
      )
    ).toBeNull()
  })
})

describe('the declaration', () => {
  it('is the tab-project decision on the measured model, the basis a digest of model and request', () => {
    expect(tabProjectDecision).toMatchObject({
      id: 'tab-project',
      label: 'Tab project',
      model: JEV_MODEL,
      fallbackModel: JEV_FALLBACK_MODEL,
      timeoutMs: 8000
    })
    const request = buildTabProjectRequest(input())!
    const basis = basisOf(request, JEV_MODEL)
    expect(basis).toBe(
      createHash('sha256')
        .update(JSON.stringify({ model: JEV_MODEL, request }))
        .digest('hex')
    )
    expect(basis).toMatch(/^[0-9a-f]{64}$/)
    expect(basisOf(request, JEV_FALLBACK_MODEL)).not.toBe(basis)
  })
})
