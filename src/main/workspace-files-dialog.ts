/**
 * The text of the `.clave` review dialog: what the shell shows for a review,
 * built from what the server disclosed. Pure (no Electron), so the one
 * builder both roads use is tested without a window: the harness's
 * `stubReviewDialog` records `message` and `detail` and `trust-gate` asserts
 * the prompt is named in them; this module is where that promise is kept.
 */
import * as path from 'path'

export interface ReviewDisclosure {
  readonly path: string
  readonly folder: string
  readonly autoCommands: ReadonlyArray<string>
  readonly prompts: ReadonlyArray<string>
  readonly dangerous: boolean
}

export interface ReviewDialogText {
  readonly title: string
  readonly message: string
  readonly detail: string
  readonly buttons: readonly ['Open safely', 'Trust and run', 'Cancel']
  readonly checkboxLabel: string
}

export function reviewDialogText(review: ReviewDisclosure): ReviewDialogText {
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
    title: 'Review workspace file',
    message: `“${path.basename(review.path)}” wants to run content automatically.`,
    detail:
      detailLines.join('\n') +
      '\n\nOnly trust this file if you recognise and understand what it would run.',
    buttons: ['Open safely', 'Trust and run', 'Cancel'],
    checkboxLabel: `Trust all workspace files in “${path.basename(review.folder)}”`
  }
}
