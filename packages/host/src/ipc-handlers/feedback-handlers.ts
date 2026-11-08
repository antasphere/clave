import { ipcMain } from 'electron'
import {
  getFeedbackState,
  setFeedbackCollapsed,
  submitFeedback,
  type FeedbackSubmission
} from '../feedback'

export function registerFeedbackHandlers(): void {
  ipcMain.handle('feedback:get-state', () => getFeedbackState())
  ipcMain.handle('feedback:set-collapsed', () => setFeedbackCollapsed())
  ipcMain.handle('feedback:submit', (_event, submission: FeedbackSubmission) =>
    submitFeedback({
      email: typeof submission?.email === 'string' ? submission.email : '',
      message: typeof submission?.message === 'string' ? submission.message : undefined
    })
  )
}
