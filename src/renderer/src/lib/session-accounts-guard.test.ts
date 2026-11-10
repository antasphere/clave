import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The seam stays the seam (PRDCT-4328): a session's account id is an id of
 * its OWNER's list, this Mac's or a server's, so no reader of a session's
 * account may look it up in this Mac's lists or usage by itself; it asks
 * `lib/session-accounts.ts`. A file that names a session's account id AND
 * reads this Mac's account lists or usage is a finding unless it is listed
 * below with the reason it is about THIS Mac's accounts only.
 */
const ROOT = resolve(__dirname, '../../../..')
const SCANNED = ['src/renderer/src', 'plugins/chat-view/src']

const SESSION_ACCOUNT_ID = /\b(claudeProfileId|codexAccountId|sessionAccountId)\b/
const LOCAL_ACCOUNTS =
  /\b(useClaudeAccountsUsage|useCodexAccountsUsage|accountsUsageFor|claudeUsageStore\(|codexUsageStore\(|getClaudeProfile\(|getCodexAccount\(|useClaudeProfileStore|useCodexAccountStore)/

const ALLOWED: Record<string, string> = {
  'src/renderer/src/lib/session-accounts.ts': 'the seam itself',
  'src/renderer/src/lib/switch-account.ts':
    'the pool of a LAUNCH on this Mac; every session reader in it goes through the seam',
  'src/renderer/src/lib/account-policy.ts':
    'subscribes to this Mac’s stores to wake the policy; reads a tab through the seam',
  'src/renderer/src/store/claude-profile-store.ts': 'this Mac’s list',
  'src/renderer/src/store/codex-account-store.ts': 'this Mac’s list',
  'src/renderer/src/store/usage-store.ts': 'this Mac’s usage',
  'src/renderer/src/components/layout/SidebarFooter.tsx':
    'this Mac’s launcher pick and local tabs; a server tab goes through the seam',
  'src/renderer/src/components/layout/SessionLauncher.tsx': 'a launch on this Mac',
  'src/renderer/src/components/onboarding/Onboarding.tsx': 'a launch on this Mac',
  'src/renderer/src/lib/launch-session.ts': 'a launch on this Mac',
  'src/renderer/src/store/pinned-store.ts': 'a .clave launch on this Mac',
  'src/renderer/src/store/triage-store.ts': 'a launch on this Mac',
  'src/renderer/src/lib/session-history.ts': 'a resume from this Mac’s history'
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

describe('a session’s account is read through its owner', () => {
  it('no reader resolves a session’s account id against this Mac’s lists by itself', () => {
    const offenders = SCANNED.flatMap((dir) => files(join(ROOT, dir)))
      .map((path) => ({ rel: relative(ROOT, path), text: readFileSync(path, 'utf8') }))
      .filter(({ text }) => SESSION_ACCOUNT_ID.test(text) && LOCAL_ACCOUNTS.test(text))
      .map(({ rel }) => rel)
      .filter((rel) => !(rel in ALLOWED))
    expect(offenders).toEqual([])
  })

  it('the stores no longer answer for a session’s account', () => {
    for (const store of ['claude-profile-store.ts', 'codex-account-store.ts']) {
      const text = readFileSync(join(ROOT, 'src/renderer/src/store', store), 'utf8')
      expect(text).not.toMatch(/export function session(Codex)?Account\b/)
    }
  })
})
