import { HELPER_SYSTEM_PREAMBLE } from '../../shared/helper-prompt'
import { parseSpokenReply, spokenPrompt, type SpokenDone } from '../../shared/spoken-rendering'
import { pageTitlePrompt, parsePageTitleReply, type PageTitleDone } from '../../shared/page-title'
import { defineHelper } from './registry'

/**
 * The two reads Folio asks for (plugins/chat-view, one page per question;
 * `src/main/exchange-digest.ts` runs them and files their answers like the
 * digests): the spoken rendering of a finished answer, read aloud, and the
 * title of a page, from the reader's message. The prompt builders and parsers
 * live in `src/shared/`, beside the types the renderer reads.
 */

/** The spoken rendering reads markdown already clipped by its caller
 *  (`SPOKEN_MAX_CHARS`). A person is waiting to hear it, so it runs ahead of
 *  the titles and the digests and is not background work. */
export const spokenRenderingHelper = defineHelper<string, SpokenDone>({
  id: 'spoken-rendering',
  label: 'Spoken renderings',
  systemPrompt: `${HELPER_SYSTEM_PREAMBLE} Your one task: write an answer as it should be spoken by a voice, word for word, with nothing summarised and nothing added.`,
  buildPrompt: spokenPrompt,
  parseReply: (stdout) => parseSpokenReply(stdout),
  model: 'haiku',
  fallbackModel: 'sonnet',
  // A long answer is a long reply: up to sixty thousand characters in.
  timeoutMs: 90_000,
  priority: 60,
  concurrency: 2,
  attempts: 2
})

/** The page title reads the reader's message, clipped by its caller
 *  (`PAGE_TITLE_MESSAGE_CHARS`). */
export const pageTitleHelper = defineHelper<string, PageTitleDone>({
  id: 'page-title',
  label: 'Page titles',
  systemPrompt: `${HELPER_SYSTEM_PREAMBLE} Your one task: title the question a reader asked a coding agent, as a book titles a chapter.`,
  buildPrompt: pageTitlePrompt,
  parseReply: (stdout) => parsePageTitleReply(stdout),
  model: 'haiku',
  timeoutMs: 30_000,
  priority: 50,
  concurrency: 2,
  attempts: 2
})
