import { app } from 'electron'
import { preferencesManager } from './preferences-manager'

const CONTACT_URL = 'https://ping.clave.work/api/contact'
const FETCH_TIMEOUT = 10 * 1000

export interface FeedbackState {
  /** Once collapsed, the expanded prompt never returns — only the one-line pill. */
  collapsed: boolean
}

export interface FeedbackSubmission {
  email: string
  message?: string
}

export type FeedbackResult = { ok: true } | { ok: false; error: string }

export function getFeedbackState(): FeedbackState {
  return { collapsed: preferencesManager.get('feedbackPromptCollapsed') }
}

export function setFeedbackCollapsed(): void {
  try {
    preferencesManager.set('feedbackPromptCollapsed', true)
  } catch (err) {
    console.log(
      '[feedback] Failed to persist collapsed flag:',
      err instanceof Error ? err.message : err
    )
  }
}

/**
 * Send a user-initiated contact submission.
 *
 * Version and platform are attached here rather than passed from the renderer,
 * which cannot be trusted to report them honestly. No install id is sent: this
 * is deliberately unlinkable to the anonymous ping in `telemetry.ts`.
 */
export async function submitFeedback(submission: FeedbackSubmission): Promise<FeedbackResult> {
  const email = submission.email?.trim() ?? ''
  const message = submission.message?.trim()

  if (!email) return { ok: false, error: 'Please enter your email address.' }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
  try {
    const response = await fetch(CONTACT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        ...(message ? { message } : {}),
        appVersion: app.getVersion(),
        platform: `${process.platform}-${process.arch}`
      }),
      signal: controller.signal
    })

    if (response.ok) return { ok: true }
    if (response.status === 400) return { ok: false, error: "That email doesn't look valid." }
    if (response.status === 429) {
      return { ok: false, error: 'Too many submissions. Please try again later.' }
    }
    return { ok: false, error: 'Something went wrong. Please try again.' }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    console.log('[feedback] Submission failed:', err instanceof Error ? err.message : err)
    return {
      ok: false,
      error: aborted
        ? 'The request timed out. Please try again.'
        : 'No connection. Please try again.'
    }
  } finally {
    clearTimeout(timeout)
  }
}
