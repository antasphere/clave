import { createHash } from 'node:crypto'
import * as path from 'node:path'
import {
  readProjectChoice,
  type ProjectPick,
  type ProjectStatus
} from '@clave/contract/tab-projects-rules'
import { JEV_FALLBACK_MODEL, JEV_MODEL } from '../../shared/jev'
import type { JevAnswers, JevQuestion, JevRequest } from './jev-client'
import type { ProjectOption } from './project-options'
import { defineDecision } from './registry'
import { clip, scrubText, type ScrubContext } from './scrub'
import type { TabReading } from './tab-reading'

/**
 * The first decision (PRDCT-5179): which project a tab is working on, a
 * project being a group of the workspace's `.clave` files
 * (`project-options.ts`). Jev is asked two questions about what the tab said
 * and the folders its tools touched: a choice among the projects, and whether
 * the work belongs to any of them at all (a choice always names one, even
 * when none fits). The answer becomes a decision by the floors of the
 * contract (`readProjectChoice`), measured, never chosen here.
 *
 * The state has the shape the floors were measured on: one session, its
 * first message, its latest ones and its folders. Change it only with a
 * measurement of the same kind.
 */

export interface TabProjectInput {
  tab: TabReading
  options: ProjectOption[]
  workspaceRoot: string
  home: string
}

export interface TabProjectOutcome {
  status: ProjectStatus
  picks: ProjectPick[]
  fits: number
}

/** The lengths what the tab said is clipped at before it is sent. */
export const FIRST_MESSAGE_MAX = 1500
export const LATEST_MESSAGE_MAX = 400
/** How many folders the state names, `elsewhere` among them. */
export const FOLDER_KEYS_KEPT = 6
/** How many components of a folder name its key. */
export const FOLDER_KEY_DEPTH = 4
/** The key every touched path under no project's folder adds up under. */
export const ELSEWHERE = 'elsewhere'
/** A question past this many tokens (with the state) shortens the
 *  descriptions: Jev 1.14 takes 32k per question, and the count is an
 *  estimate (`CHARS_PER_TOKEN`). */
export const QUESTION_TOKEN_BUDGET = 28_000
export const CHARS_PER_TOKEN = 3.5
/** The descriptions' first clip, and the shortest they are cut to. */
export const DESCRIPTION_CLIP = 1200
export const DESCRIPTION_FLOOR = 200

export const PROJECT_INSTRUCTIONS =
  'Which project is this agent session working on? Judge by what is said in it and by the folders its tools touched.'
export const FITS_STATEMENT = 'The work in this session belongs to one of the listed projects.'

/** The folder a path relative to the workspace is counted under: its first
 *  `FOLDER_KEY_DEPTH` components. Pure. */
function folderKey(folder: string): string {
  return folder.split('/').filter(Boolean).slice(0, FOLDER_KEY_DEPTH).join('/')
}

/**
 * The folders the tab's tools touched, as the state names them. Pure. A path
 * a project's folder holds is counted under the folder the path itself sits
 * in, cut at four components (`suite/tools/ledger`, not `suite` alone): that
 * is the state the floors were measured on, and the part of a project a tab
 * touched is what tells two projects of one tree apart. A path under no
 * project's folder adds up under `elsewhere`, so no folder outside the
 * projects is ever named. An option whose folder is the root names no key
 * (it holds every path, so it would say nothing), and a path it alone holds
 * counts as `elsewhere`. The six largest keys are kept, `elsewhere` among
 * them when it ranks; the largest first, equals by name.
 */
export function touchedFolders(
  touched: Readonly<Record<string, number>>,
  options: ReadonlyArray<Pick<ProjectOption, 'folder'>>,
  workspaceRoot: string
): Record<string, number> {
  const folders = options
    .map((option) => option.folder)
    .filter((folder) => folder !== '')
    .sort((a, b) => b.length - a.length)
  const counts = new Map<string, number>()
  const root = path.resolve(workspaceRoot)
  for (const [absolute, times] of Object.entries(touched)) {
    if (!Number.isFinite(times) || times <= 0) continue
    const relative = path.relative(root, path.resolve(absolute)).split(path.sep).join('/')
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue
    const holder = folders.find(
      (folder) => relative === folder || relative.startsWith(`${folder}/`)
    )
    let key = ELSEWHERE
    if (holder !== undefined) {
      // The folder the path sits in, when that is inside the project's; the
      // project's own folder when the path IS it or sits right in it.
      const own = relative.split('/').slice(0, -1).join('/')
      key = folderKey(own === holder || own.startsWith(`${holder}/`) ? own : holder)
    }
    counts.set(key, (counts.get(key) ?? 0) + times)
  }
  const kept = [...counts.entries()]
    .filter(([, times]) => times > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, FOLDER_KEYS_KEPT)
  return Object.fromEntries(kept)
}

/** The choice's criteria: per project, its folder and what it is. Pure. */
export function criteriaOf(
  options: ReadonlyArray<ProjectOption>,
  scrub: ScrubContext,
  descriptionClip: number = DESCRIPTION_CLIP
): Record<string, string> {
  const criteria: Record<string, string> = {}
  for (const option of options) {
    const folder = option.folder === '' ? '(the workspace root)' : option.folder
    const description = clip(scrubText(option.description, scrub), descriptionClip)
    criteria[option.name] = `Folder ${folder}. ${description}`
  }
  return criteria
}

/** The two questions on a set of criteria. */
function questionsOf(criteria: Record<string, string>): Record<string, JevQuestion> {
  return {
    project: { type: 'choice', instructions: PROJECT_INSTRUCTIONS, criteria },
    fits: { type: 'noul', instructions: { statement: FITS_STATEMENT, projects: criteria } }
  }
}

/** The estimated tokens of the state with the largest question. Pure. */
export function largestQuestionTokens(request: JevRequest): number {
  const state = JSON.stringify(request.state).length
  let largest = 0
  for (const question of Object.values(request.questions))
    largest = Math.max(largest, JSON.stringify(question).length)
  return (state + largest) / CHARS_PER_TOKEN
}

/** The request for a tab; null when the tab said nothing or there is no
 *  project to choose from. Pure. */
export function buildTabProjectRequest(input: TabProjectInput): JevRequest | null {
  const first = input.tab.firstMessage?.trim() ?? ''
  if (!first || input.options.length === 0) return null
  const scrub: ScrubContext = { workspaceRoot: input.workspaceRoot, home: input.home }
  const state = {
    sessions: [
      {
        first_message: clip(scrubText(first, scrub), FIRST_MESSAGE_MAX),
        latest_messages: input.tab.latestMessages.map((message) =>
          clip(scrubText(message, scrub), LATEST_MESSAGE_MAX)
        ),
        folders_its_tools_touched: touchedFolders(
          input.tab.touched,
          input.options,
          input.workspaceRoot
        )
      }
    ]
  }
  let descriptionClip = DESCRIPTION_CLIP
  let request: JevRequest = {
    state,
    questions: questionsOf(criteriaOf(input.options, scrub, descriptionClip))
  }
  // Too long for one question: every description shortened evenly, by
  // halves, never under the floor.
  while (
    largestQuestionTokens(request) > QUESTION_TOKEN_BUDGET &&
    descriptionClip > DESCRIPTION_FLOOR
  ) {
    descriptionClip = Math.max(DESCRIPTION_FLOOR, Math.floor(descriptionClip / 2))
    request = { state, questions: questionsOf(criteriaOf(input.options, scrub, descriptionClip)) }
  }
  return request
}

/** The answers read into a decision; null when either is missing or not
 *  the asked type, or when a share names a project that was not an option:
 *  a reading is kept whole or not at all. The shares are mapped back to the
 *  options by name. Pure. */
export function readTabProjectAnswers(
  answers: JevAnswers,
  input: Pick<TabProjectInput, 'options'>
): TabProjectOutcome | null {
  const project = answers.project
  const fits = answers.fits
  if (!project || project.type !== 'choice' || !fits || fits.type !== 'noul') return null
  const reading = readProjectChoice(project.probabilities, fits.noul)
  const byName = new Map(input.options.map((option) => [option.name, option]))
  const picks: ProjectPick[] = []
  for (const share of reading.shares) {
    const option = byName.get(share.name)
    if (!option) return null
    picks.push({ file: option.file, name: option.name, p: share.p })
  }
  return { status: reading.status, picks, fits: fits.noul }
}

/** What a reading was made on: the SHA-256, in hex, of the model and the
 *  request. The same basis is never asked twice (the caller's rule). Pure. */
export function basisOf(request: JevRequest, model: string): string {
  return createHash('sha256').update(JSON.stringify({ model, request })).digest('hex')
}

export const tabProjectDecision = defineDecision<TabProjectInput, TabProjectOutcome>({
  id: 'tab-project',
  label: 'Tab project',
  description:
    'Which project a tab works on, to name the groups you make. Sends the tab’s first and latest messages, the folders its tools touched and the workspace’s projects.',
  model: JEV_MODEL,
  fallbackModel: JEV_FALLBACK_MODEL,
  timeoutMs: 8000,
  build: buildTabProjectRequest,
  read: readTabProjectAnswers
})
