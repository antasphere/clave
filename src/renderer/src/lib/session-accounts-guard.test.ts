import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The seam stays the seam (PRDCT-4328): a session's account id is an id of
 * its OWNER's list, this Mac's or a server's, so no reader of a session's
 * account may look it up in this Mac's lists or usage by itself; it asks
 * `lib/session-accounts.ts`. A file that names a session's account id AND
 * reads this Mac's account lists, its usage or its pool is a finding unless
 * it is listed below with the reason it is about THIS Mac's accounts only and
 * the NUMBER of such reads it holds: a new read in a listed file turns the
 * test red as surely as a new file does (and a read taken away asks for the
 * count to come down, so the list never holds slack).
 *
 * What it reads as "this Mac's accounts": the stores' hooks and getters, the
 * label resolvers, the selected-account getter, the launch pool
 * (`accountForLaunch`), the usage caches, and any renamed or namespace
 * import of the three stores (the road an alias or a computed key takes).
 *
 * What it still cannot see: a read through a module that re-exports those
 * helpers under another name, a dynamic `import()`, a file that receives a
 * session's account id without naming `claudeProfileId`, `codexAccountId` or
 * `sessionAccountId` (a prop, a generic record), and a wrong read inside a
 * listed file that stays within its count by replacing another.
 */
const ROOT = resolve(__dirname, '../../../..')
const SCANNED = ['src/renderer/src', 'plugins/chat-view/src']

const SESSION_ACCOUNT_ID = /\b(claudeProfileId|codexAccountId|sessionAccountId)\b/
const LOCAL_READ = new RegExp(
  [
    '\\b(useClaudeAccountsUsage|useCodexAccountsUsage|accountsUsageFor|claudeUsageStore|codexUsageStore)\\b',
    '\\b(getClaudeProfile|getCodexAccount|getSelectedClaudeProfile|useClaudeProfileStore|useCodexAccountStore)\\b',
    '\\b(resolveClaudeProfile|resolveCodexAccount|accountForLaunch)\\b'
  ].join('|'),
  'g'
)
/** A renamed or namespace import of one of this Mac's account stores. */
const ALIASED_STORE_IMPORT =
  /import\s*(\*\s*as\s+\w+|\{[^}]*\bas\b[^}]*\})\s*from\s*'[^']*\/(claude-profile-store|codex-account-store|usage-store)'/g

const ALLOWED: Record<string, { reason: string; reads: number }> = {
  'src/renderer/src/lib/session-accounts.ts': { reason: 'the seam itself', reads: 16 },
  'src/renderer/src/lib/switch-account.ts': {
    reason: 'the pool of a LAUNCH on this Mac; every session reader in it goes through the seam',
    reads: 23
  },
  'src/renderer/src/lib/account-policy.ts': {
    reason: 'subscribes to this Mac’s stores to wake the policy; reads a tab through the seam',
    reads: 8
  },
  'src/renderer/src/store/claude-profile-store.ts': { reason: 'this Mac’s list', reads: 10 },
  'src/renderer/src/store/codex-account-store.ts': { reason: 'this Mac’s list', reads: 7 },
  'src/renderer/src/components/layout/SidebarFooter.tsx': {
    reason: 'this Mac’s launcher pick and local tabs; a server tab goes through the seam',
    reads: 14
  },
  'src/renderer/src/components/layout/SessionLauncher.tsx': {
    reason: 'a launch on this Mac',
    reads: 10
  },
  'src/renderer/src/components/onboarding/Onboarding.tsx': {
    reason: 'a launch on this Mac',
    reads: 4
  },
  'src/renderer/src/lib/launch-session.ts': { reason: 'a launch on this Mac', reads: 3 },
  'src/renderer/src/store/pinned-store.ts': { reason: 'a .clave launch on this Mac', reads: 4 },
  'src/renderer/src/store/triage-store.ts': { reason: 'a launch on this Mac', reads: 6 },
  'src/renderer/src/lib/session-history.ts': {
    reason: 'a resume from this Mac’s history',
    reads: 4
  }
}

/** How many reads of this Mac's accounts a file holds, its comments aside. */
export function localReads(source: string): number {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  return (text.match(LOCAL_READ) ?? []).length + (text.match(ALIASED_STORE_IMPORT) ?? []).length
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
    const seen = SCANNED.flatMap((dir) => files(join(ROOT, dir)))
      .map((path) => ({ rel: relative(ROOT, path), text: readFileSync(path, 'utf8') }))
      .filter(({ text }) => SESSION_ACCOUNT_ID.test(text))
      .map(({ rel, text }) => ({ rel, reads: localReads(text) }))
    const mismatched = seen
      .filter(({ rel, reads }) => reads !== (ALLOWED[rel]?.reads ?? 0))
      .map(({ rel, reads }) => `${rel}: ${reads} reads, ${ALLOWED[rel]?.reads ?? 0} allowed`)
    expect(mismatched).toEqual([])
  })

  it('sees the roads a new reader would take', () => {
    expect(localReads('resolveClaudeProfile(profiles, ref)')).toBe(1)
    expect(localReads('getSelectedClaudeProfile()')).toBe(1)
    expect(localReads("accountForLaunch('claude')")).toBe(1)
    expect(localReads("import { useClaudeAccountsUsage as u } from '../store/usage-store'")).toBe(2)
    expect(localReads("import * as accounts from '../store/claude-profile-store'")).toBe(1)
  })

  it('the stores no longer answer for a session’s account', () => {
    for (const store of ['claude-profile-store.ts', 'codex-account-store.ts']) {
      const text = readFileSync(join(ROOT, 'src/renderer/src/store', store), 'utf8')
      expect(text).not.toMatch(/export function session(Codex)?Account\b/)
    }
  })
})
