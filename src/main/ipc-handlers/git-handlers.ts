import { ipcMain } from 'electron'
import { gitManager } from '../git-manager'
import { repoIndexManager } from '../repo-index'
import type { GitBatchProgress } from '../git-manager'
import type { GitRangeDirection } from '../../shared/git-range'

export function registerGitHandlers(): void {
  ipcMain.handle('git:check-ignored', (_event, cwd: string, paths: string[]) =>
    gitManager.checkIgnored(cwd, paths)
  )
  ipcMain.handle('git:fetch', (_event, cwd: string) => gitManager.fetch(cwd))
  ipcMain.handle('git:fetch-batch', (_event, paths: string[]) => gitManager.fetchBatch(paths))
  ipcMain.handle('git:status', (_event, cwd: string) => gitManager.getStatus(cwd))
  ipcMain.handle('git:status-batch', (_event, paths: string[]) => gitManager.getStatusBatch(paths))
  ipcMain.handle('git:discover-repos', (_event, cwd: string, force?: boolean) =>
    repoIndexManager.discover(cwd, force)
  )
  ipcMain.handle('git:stage', (_event, cwd: string, files: string[]) =>
    gitManager.stage(cwd, files)
  )
  ipcMain.handle('git:unstage', (_event, cwd: string, files: string[]) =>
    gitManager.unstage(cwd, files)
  )
  ipcMain.handle('git:commit', (_event, cwd: string, message: string) =>
    gitManager.commit(cwd, message)
  )
  ipcMain.handle('git:push', (_event, cwd: string) => gitManager.push(cwd))
  ipcMain.handle('git:publish-branch', (_event, cwd: string) => gitManager.publishBranch(cwd))
  ipcMain.handle(
    'git:pull',
    (_event, cwd: string, strategy?: 'auto' | 'merge' | 'rebase' | 'ff-only') =>
      gitManager.pull(cwd, strategy)
  )
  ipcMain.handle(
    'git:discard',
    (_event, cwd: string, files: Array<{ path: string; status: string; staged: boolean }>) =>
      gitManager.discard(cwd, files)
  )
  ipcMain.handle(
    'git:diff',
    (_event, cwd: string, filePath: string, staged: boolean, isUntracked: boolean) =>
      gitManager.getDiff(cwd, filePath, staged, isUntracked)
  )
  ipcMain.handle('git:log', (_event, cwd: string, maxCount?: number) =>
    gitManager.getLog(cwd, maxCount)
  )
  ipcMain.handle('git:outgoing-commits', (_event, cwd: string) =>
    gitManager.getOutgoingCommits(cwd)
  )
  ipcMain.handle('git:incoming-commits', (_event, cwd: string) =>
    gitManager.getIncomingCommits(cwd)
  )
  ipcMain.handle('git:range-files', (_event, cwd: string, direction: GitRangeDirection) =>
    gitManager.getRangeFiles(cwd, direction)
  )
  ipcMain.handle('git:range-diff', (_event, cwd: string, direction: GitRangeDirection, filePath: string) =>
    gitManager.getRangeDiff(cwd, direction, filePath)
  )
  ipcMain.handle('git:commit-files', (_event, cwd: string, hash: string) =>
    gitManager.getCommitFiles(cwd, hash)
  )
  ipcMain.handle('git:commit-diff', (_event, cwd: string, hash: string, filePath: string) =>
    gitManager.getCommitDiff(cwd, hash, filePath)
  )
  ipcMain.handle('git:generate-commit-message', (_event, cwd: string) =>
    gitManager.generateCommitMessage(cwd)
  )
  // Both batch ops report on ONE channel, with `op` saying which. That is what
  // lets a single progress row in the git bar serve Pull all and Magic sync.
  ipcMain.handle('git:magic-sync', (event, repoPaths: string[]) =>
    gitManager.magicSync(repoPaths, (progress: GitBatchProgress) => {
      event.sender.send('git:batch-progress', progress)
    })
  )
  ipcMain.handle('git:magic-pull', (event, repoPaths: string[]) =>
    gitManager.magicPull(repoPaths, (progress: GitBatchProgress) => {
      event.sender.send('git:batch-progress', progress)
    })
  )
  // The discovery sweep the panel's refresh runs — the one operation that goes
  // to every remote, reporting on the same channel as the other two.
  ipcMain.handle('git:refresh-remotes', (event, repoPaths: string[]) =>
    gitManager.refreshRemotes(repoPaths, (progress: GitBatchProgress) => {
      event.sender.send('git:batch-progress', progress)
    })
  )
  ipcMain.handle('git:journey', (_event, cwd: string, maxCount?: number) =>
    gitManager.getJourney(cwd, maxCount)
  )
  ipcMain.handle(
    'git:summarize-push',
    (_event, cwd: string, commitMessages: string[], diffStats: string) =>
      gitManager.summarizePushGroup(cwd, commitMessages, diffStats)
  )
}
