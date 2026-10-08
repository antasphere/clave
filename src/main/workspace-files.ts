/**
 * The workspace files domain as the shell runs it (wave 3, lane A,
 * PRDCT-3291). ONE `WorkspaceFiles` instance in this process, its trust
 * store (`clave-trusted.json`, `clave-trusted-roots.json`) in the app's own
 * data folder where it has always been, its watchers the same directory
 * watchers as before. The in-process server is handed this very instance
 * (`src/main/index.ts` passes it to `startClaveServer`), so a command that
 * arrives over its API and an IPC call from a window change the same object
 * and read the same trust.
 *
 * The REVIEW DIALOG stays here, in the shell: Electron's `dialog`, on the
 * window that asked. Two roads reach it. A window whose read went over IPC
 * (no server named yet) gets it through `shellReviewer`, which the IPC
 * handler hands the instance. A window whose read went through the server
 * hears `workspace_files.review_needed` on the push channel and asks main
 * over IPC to show the same dialog (`clave:review-dialog`), then answers the
 * server itself (`src/preload/workspace-files-relay.ts`). The text of the
 * dialog is built once, `reviewDialog`, so the two roads show one dialog
 * and the end-to-end stub (`stubReviewDialog`) reads one shape.
 *
 * The server package's light entry carries no Effect import, so building
 * the instance at boot costs nothing (`src/main/server/lazy-load.test.ts`).
 */
import { app, dialog, type BrowserWindow, type MessageBoxOptions } from 'electron'
import * as path from 'path'
import {
  WorkspaceFiles,
  fileWorkspaceFilesStorage,
  type ReviewRequest,
  type Reviewer
} from '@clave/server/workspace-files'
import type { ReviewAnswer } from '@clave/contract/workspace-files'

let instance: WorkspaceFiles | null = null

/** The shell's instance, built on first use so `--user-data-dir` is honoured. */
export function workspaceFiles(): WorkspaceFiles {
  if (!instance) instance = new WorkspaceFiles(fileWorkspaceFilesStorage(app.getPath('userData')))
  return instance
}

/** What the dialog shows for a review: the shape the harness's
 *  `stubReviewDialog` records (`message`, `detail`) and asserts on. */
export function reviewDialog(review: ReviewRequest): MessageBoxOptions {
  const detailLines: string[] = []
  if (review.autoCommands.length > 0) {
    detailLines.push('Commands that would run automatically:')
    detailLines.push(...review.autoCommands.map((c) => `  • ${c}`))
  }
  if (review.prompts.length > 0) {
    if (detailLines.length > 0) detailLines.push('')
    detailLines.push('Instructions that would be auto-submitted to an agent:')
    detailLines.push(
      ...review.prompts.map((p) => {
        const flat = p.replace(/\s+/g, ' ').trim()
        return `  • ${flat.length > 120 ? flat.slice(0, 117) + '…' : flat}`
      })
    )
  }
  if (review.dangerous) {
    detailLines.push('')
    detailLines.push(
      'One or more agents would start with permission prompts disabled (--dangerously-skip-permissions).'
    )
  }
  return {
    type: 'warning',
    buttons: ['Open safely', 'Trust and run', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    checkboxLabel: `Trust all workspace files in “${path.basename(review.folder)}”`,
    checkboxChecked: false,
    title: 'Review workspace file',
    message: `“${path.basename(review.path)}” wants to run content automatically.`,
    detail:
      detailLines.join('\n') +
      '\n\nOnly trust this file if you recognise and understand what it would run.'
  }
}

/** Show the review on a window and answer the person's word. */
export async function showReview(
  win: BrowserWindow | null,
  review: ReviewRequest
): Promise<ReviewAnswer> {
  const options = reviewDialog(review)
  const { response, checkboxChecked } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  return { response: response as 0 | 1 | 2, checkboxChecked }
}

/** The reviewer of a read that came over IPC: the dialog on the asking window. */
export const shellReviewer =
  (win: BrowserWindow | null): Reviewer =>
  (review) =>
    showReview(win, review)
