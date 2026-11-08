import { useState, type ReactElement } from 'react'
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline'
import type { AccountLoginJob } from '../../../../preload/index.d'
import { useAccountLoginStore, loginKey, type LoginProvider } from '../../store/account-login-store'
import {
  useClaudeAccountsUsage,
  useCodexAccountsUsage,
  headroomLabel
} from '../../store/usage-store'
import { SettingsCallout } from './primitives'

/**
 * A login in flight, under the account's row (ADR 0002): what the hidden
 * terminal is doing, the sign-in link when the browser did not open on its
 * own, the code field when Claude asks for one, and the outcome — proven
 * by the account's first usage read.
 */
export function LoginFlow({
  provider,
  accountId,
  label
}: {
  provider: LoginProvider
  accountId: string
  label: string
}): ReactElement | null {
  const job = useAccountLoginStore((s) => s.jobs[loginKey(provider, accountId)])
  const cancel = useAccountLoginStore((s) => s.cancel)
  const dismiss = useAccountLoginStore((s) => s.dismiss)
  const sendCode = useAccountLoginStore((s) => s.sendCode)
  const claudeSummary = useClaudeAccountsUsage((s) => s.byAccount[accountId])
  const codexSummary = useCodexAccountsUsage((s) => s.byAccount[accountId])
  const [code, setCode] = useState('')
  if (!job) return null
  const summary = provider === 'codex' ? codexSummary : claudeSummary
  const headroom = headroomLabel(summary)
  const text = describe(job, provider, headroom)
  const running = job.status === 'running'
  return (
    <div data-account-login={loginKey(provider, accountId)} data-account-login-status={job.status}>
      <SettingsCallout
        inset
        tone={job.status === 'failed' ? 'danger' : 'accent'}
        title={
          running
            ? `Signing in to ${label}`
            : job.status === 'done'
              ? `Signed in to ${label}`
              : label
        }
        text={
          <>
            {text}
            {running && job.url && (
              <>
                {' '}
                <button
                  className="text-accent hover:underline"
                  onClick={() => void window.electronAPI.openExternal(job.url!)}
                  data-account-login-link
                >
                  Open the sign-in page
                  <ArrowTopRightOnSquareIcon className="w-3 h-3 inline-block ml-0.5 align-[-1px]" />
                </button>
              </>
            )}
            {running && job.awaitingCode && (
              <div className="flex items-center gap-2 mt-2">
                <input
                  className="input-compact flex-1 max-w-72"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Paste the code from the browser"
                  aria-label="Sign-in code"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && code.trim()) {
                      void sendCode(provider, accountId, code)
                      setCode('')
                    }
                  }}
                />
                <button
                  className="btn-secondary"
                  disabled={!code.trim()}
                  onClick={() => {
                    void sendCode(provider, accountId, code)
                    setCode('')
                  }}
                >
                  Send code
                </button>
              </div>
            )}
          </>
        }
        actions={
          running ? (
            <button className="btn-secondary" onClick={() => void cancel(provider, accountId)}>
              Cancel
            </button>
          ) : (
            <button className="btn-secondary" onClick={() => dismiss(provider, accountId)}>
              {job.status === 'done' ? 'Done' : 'Dismiss'}
            </button>
          )
        }
      />
    </div>
  )
}

function describe(job: AccountLoginJob, provider: LoginProvider, headroom: string | null): string {
  if (job.status === 'running') {
    if (job.awaitingCode)
      return 'The browser could not reach the terminal: paste the code it shows.'
    return provider === 'claude'
      ? 'A browser window is signing in to Claude. Sign in with the account you want this to be, then come back: the token is stored here, encrypted, the moment it is printed.'
      : 'A browser window is signing in to ChatGPT. Sign in with the account you want this to be, then come back: Codex writes its credential to this account’s own home.'
  }
  if (job.status === 'done') {
    return headroom ? `Signed in · ${headroom}.` : 'Signed in. Reading its usage…'
  }
  if (job.status === 'cancelled') return 'The login was cancelled.'
  return job.message ?? 'The login failed.'
}
