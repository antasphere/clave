/**
 * `clave_request_input` and `clave_input_result`: an agent asks the person
 * for a plain value, a choice, a confirmation, a file, a link to open and come
 * back from, or several of those at once, and the person answers in a card
 * drawn in the chat under the agent's turn (PRDCT-4157). The plain
 * counterpart of `clave_request_secret`: here the value IS returned to the
 * agent, so nothing sensitive belongs in it.
 *
 * One module for both MCP servers: the desktop's (`mcp-server.ts`, which
 * creates the request on whichever server hosts the session through the
 * typed client) and the standalone server's (`standalone-mcp.ts`, which
 * holds the request itself). The schema, the mapping onto the wire's question
 * shape and the result the agent reads live here so the two never drift.
 */
import { z } from 'zod'
import type { AgentQuestion } from '@clave/contract/sessions'
import type { HostedRequestInput, RequestResultView } from '@clave/contract/requests'
import { INPUT_KINDS, questionsShapeProblem } from '@clave/contract/input-kinds'

/** The longest one result poll holds the wire: under the client's deadline
 *  (`VIEW_REQUEST_MAX_TIMEOUT_MS`), and under a host's MCP tool timeout. */
export const RESULT_POLL_MS = 45_000

const label = z.string().min(1).max(2000)
export const inputQuestionSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/)
      .describe('The key the answer comes back under (lowercase, digits, - and _)'),
    label: label.describe('The question, shown verbatim above the field'),
    kind: z
      .enum(INPUT_KINDS)
      .default('text')
      .describe(
        'text (one line), long-text, email, url, github-login, number, date (YYYY-MM-DD), choice (with options), file, folder (a path picked in a native dialog on a local tab, typed on a server tab), link (url + confirm: the person opens it in the browser and confirms they are back; the answer is "done")'
      ),
    hint: z.string().max(500).optional().describe('One line under the field'),
    placeholder: z.string().max(200).optional(),
    default: z.string().max(16_384).optional().describe('Pre-filled; the person may change it'),
    optional: z.boolean().optional().describe('May be left empty (default false)'),
    options: z
      .array(
        z.object({
          label: z.string().min(1).max(500),
          description: z.string().max(1000).optional()
        })
      )
      .min(2)
      .max(100)
      .optional()
      .describe('choice only: the options, shown as buttons'),
    multiSelect: z.boolean().optional().describe('choice only: several may be picked'),
    url: z.string().url().optional().describe('link only: the https address to open'),
    confirm: z
      .string()
      .max(100)
      .optional()
      .describe('link only: the words on the button that says the person is back'),
    min: z.number().optional().describe('number only'),
    max: z.number().optional().describe('number only')
  })
  .strict()
export type InputQuestionArgs = z.infer<typeof inputQuestionSchema>

export const requestInputSchema = {
  description: z
    .string()
    .min(1)
    .max(2000)
    .describe('What is asked and why, in one or two sentences, shown verbatim above the fields'),
  questions: z
    .array(inputQuestionSchema)
    .min(1)
    .max(20)
    .describe('One field per question; ask everything you will need at once'),
  layout: z
    .enum(['form', 'steps'])
    .default('form')
    .describe('form: every field at once, one Send (default). steps: one question per page.'),
  timeoutSeconds: z
    .number()
    .int()
    .min(5)
    .max(300)
    .default(30)
    .describe(
      'How long to block waiting for the person before returning status "pending". Keep it well under your MCP client\'s tool timeout (commonly ~60s); the person can take as long as they like, you poll clave_input_result.'
    )
}
export type RequestInputArgs = {
  description: string
  questions: InputQuestionArgs[]
  layout: 'form' | 'steps'
  timeoutSeconds: number
}

export const inputResultSchema = {
  requestId: z.string().min(1).max(256),
  waitSeconds: z
    .number()
    .int()
    .min(0)
    .max(300)
    .default(0)
    .describe('Wait up to this long for the person before answering; 0 answers at once')
}

export const REQUEST_INPUT_DESCRIPTION =
  'Ask the person for a plain value, a choice, a yes or no, a file, a link to open and come back from, or several of those at once, in a card drawn in the chat under your turn (the plain counterpart of clave_request_secret: the answers ARE returned to you, so never ask for a secret here). Use it for anything the person must type or pick (an e-mail, a GitHub login, a project name, a path, a date), typed answers are checked where they are typed (email, url, github-login, number, date). Ask everything you will need at once, as one form, so a long run is never interrupted later. The result is {status:"completed", answers:{<id>: value}} (a multi-select answers with an array), {status:"dismissed"} when the person skipped, or {status:"pending", requestId} when they have not answered within timeoutSeconds: then poll clave_input_result with waitSeconds up to 45 and keep polling in the same turn, never end it waiting. A bare multiple choice of one to four questions can also go through your own question tool.'

export const INPUT_RESULT_DESCRIPTION =
  'Fetch the outcome of a clave_request_input call that returned {status:"pending"}. Optionally wait up to waitSeconds (45 at most per call is safe) for the person to answer. Outcomes are kept ~10 minutes.'

/** The one place a question's shape is judged beyond its types: a choice
 *  needs its options and nothing else does, a link needs its address. */
export function toHostedInput(args: RequestInputArgs, sessionId: string): HostedRequestInput {
  const questions: AgentQuestion[] = args.questions.map((q) => ({
    id: q.id,
    question: q.label,
    kind: q.kind,
    options: (q.options ?? []).map((o) => ({ ...o })),
    ...(q.multiSelect !== undefined && { multiSelect: q.multiSelect }),
    ...(q.hint !== undefined && { hint: q.hint }),
    ...(q.placeholder !== undefined && { placeholder: q.placeholder }),
    ...(q.default !== undefined && { default: q.default }),
    ...(q.optional !== undefined && { optional: q.optional }),
    ...(q.url !== undefined && { url: q.url }),
    ...(q.confirm !== undefined && { confirm: q.confirm }),
    ...(q.min !== undefined && { min: q.min }),
    ...(q.max !== undefined && { max: q.max })
  }))
  // The shape rules are the contract's (`questionsShapeProblem`), the same
  // the server applies when it stores the request: judged here first so the
  // agent reads the reason as the tool's own error.
  const problem = questionsShapeProblem(questions)
  if (problem) throw new Error(problem)
  return { sessionId, description: args.description, questions, layout: args.layout }
}

/** What the agent reads: the status, the answers once there are any. */
export function inputResultPayload(view: RequestResultView): Record<string, unknown> {
  return {
    requestId: view.requestId,
    status: view.status,
    ...(view.answers && { answers: view.answers })
  }
}

/** Poll the result until it settles or the budget is spent, one bounded
 *  wait per round so no single call outlives the wire. */
export async function pollResult(
  fetch: (waitMs: number) => Promise<RequestResultView>,
  totalMs: number
): Promise<RequestResultView> {
  const deadline = Date.now() + totalMs
  for (;;) {
    const remaining = deadline - Date.now()
    const view = await fetch(Math.max(0, Math.min(remaining, RESULT_POLL_MS)))
    if (view.status !== 'pending' && view.status !== 'running') return view
    if (deadline - Date.now() <= 0) return view
  }
}
