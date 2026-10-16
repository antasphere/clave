/** A clean Linux unit job does not run the application build. Compile the
 * real host helper for file-domain tests, never a mock filesystem fallback. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export function ensureFileHelper(): void {
  const root = resolve(__dirname, '../../../..')
  const source = join(root, 'native/secure-files/main.c')
  const target = join(root, 'resources/native/secure-files-helper')
  if (existsSync(target) && statSync(target).mtimeMs >= statSync(source).mtimeMs) return
  mkdirSync(join(root, 'resources/native'), { recursive: true })
  const temporary = `${target}-${randomUUID()}`
  try {
    execFileSync(
      'cc',
      ['-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', source, '-o', temporary],
      { timeout: 30_000, stdio: 'pipe' }
    )
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
}
