import { HELPER_SYSTEM_PREAMBLE } from '../../shared/helper-prompt'
import {
  explainerPrompt,
  parseExplainerReply,
  type ExplainerInput,
  type ExplainerReading
} from '../../shared/permission-explainer'
import { defineHelper } from './registry'

/**
 * The permission explainer (PRDCT-4331): one plain sentence on what a
 * permission request does, the level the model reads in it, and whether it
 * matches what the person asked. A person is waiting on the card, so it runs
 * before every other helper. The prompt and the parser live in
 * `src/shared/permission-explainer.ts`; the session host's trigger
 * (`sessions/permission-explanations.ts`) runs it and applies the one rule
 * of its level: the model may raise the rules' floor, never lower it.
 */

export const EXPLAINER_TIMEOUT_MS = 30_000

export const permissionExplainerHelper = defineHelper<ExplainerInput, ExplainerReading>({
  id: 'permission-explainer',
  label: 'Permission explanations',
  systemPrompt: `${HELPER_SYSTEM_PREAMBLE} Your one task: say in one line of JSON, in plain words for someone who does not program, what allowing a coding agent's permission request would do. You never approve or refuse it.`,
  buildPrompt: explainerPrompt,
  parseReply: (stdout) => parseExplainerReply(stdout),
  model: 'haiku',
  fallbackModel: 'sonnet',
  timeoutMs: EXPLAINER_TIMEOUT_MS,
  // Above every other helper (commit message 80): a person waits on it. Not
  // background work: it never waits behind the digests or takes their room,
  // at most two at once, the newest request first (the card on screen), and
  // each one ended when its request is answered (`cancelOwned`).
  priority: 100,
  concurrency: 2,
  newestFirst: true,
  attempts: 2
})
