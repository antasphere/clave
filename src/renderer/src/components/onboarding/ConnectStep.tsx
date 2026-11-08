import { useEffect, useState } from 'react'
import { CheckIcon, ArrowTopRightOnSquareIcon } from '@heroicons/react/20/solid'
import type { OnboardingAgent, OnboardingAgentId } from '../../../../shared/onboarding'
import { ClaudeLogo, CodexLogo } from '../icons/cli-logos'
import { useAccountLoginStore, loginKey } from '../../store/account-login-store'
import { DEFAULT_CLAUDE_PROFILE_ID, useClaudeProfileStore } from '../../store/claude-profile-store'
import { DEFAULT_CODEX_ACCOUNT_ID, useCodexAccountStore } from '../../store/codex-account-store'
import { claudeUsageStore } from '../../store/usage-store'
import { useConnections } from './connections'

const PROVIDERS: Record<
  OnboardingAgentId,
  { name: string; maker: string; blurb: string; Logo: typeof ClaudeLogo }
> = {
  claude: {
    name: 'Claude',
    maker: 'Anthropic',
    blurb: 'Use your Claude subscription.',
    Logo: ClaudeLogo
  },
  codex: {
    name: 'ChatGPT',
    maker: 'OpenAI',
    blurb: 'Use your ChatGPT subscription, through Codex.',
    Logo: CodexLogo
  }
}

function Spinner(): React.JSX.Element {
  return <span className="onb-spinner" aria-hidden="true" />
}

/** One provider: install it when missing, then sign in through the browser. */
function ProviderCard({
  agent,
  connected,
  onInstall,
  installError
}: {
  agent: OnboardingAgent
  connected: boolean
  onInstall: () => void
  installError: string | null
}): React.JSX.Element {
  const { name, maker, blurb, Logo } = PROVIDERS[agent.id]
  const provider = agent.id
  const addProfile = useClaudeProfileStore((s) => s.addProfile)
  const profiles = useClaudeProfileStore((s) => s.profiles)
  const setSelectedProfile = useClaudeProfileStore((s) => s.setSelectedProfile)
  const setSelectedCodex = useCodexAccountStore((s) => s.setSelectedAccount)
  const start = useAccountLoginStore((s) => s.start)
  const cancel = useAccountLoginStore((s) => s.cancel)
  const sendCode = useAccountLoginStore((s) => s.sendCode)
  const [accountId, setAccountId] = useState<string | null>(null)
  const job = useAccountLoginStore((s) =>
    accountId ? s.jobs[loginKey(provider, accountId)] : undefined
  )
  const [code, setCode] = useState('')

  // The account that just signed in becomes the one new sessions start on.
  useEffect(() => {
    if (job?.status !== 'done' || !accountId) return
    if (provider === 'claude') setSelectedProfile(accountId)
    else setSelectedCodex(accountId)
  }, [job?.status, accountId, provider, setSelectedProfile, setSelectedCodex])

  const signIn = async (): Promise<void> => {
    if (provider === 'codex') {
      // The Mac's own Codex home: a plain `codex` in a terminal works after it too.
      setAccountId(DEFAULT_CODEX_ACCOUNT_ID)
      await start('codex', DEFAULT_CODEX_ACCOUNT_ID)
      return
    }
    // Claude signs in on an account of its own (the Mac's login is the CLI's).
    // An attempt left without a token is taken up again, never doubled.
    const left = profiles.find(
      (p) => p.id !== DEFAULT_CLAUDE_PROFILE_ID && !p.hasToken && p.label === 'Claude'
    )
    const target = left ?? (await addProfile('Claude'))
    if (!target) return
    setAccountId(target.id)
    await start('claude', target.id)
  }

  const running = job?.status === 'running'
  let state: React.ReactNode
  let action: React.ReactNode = null
  if (connected) {
    state = (
      <span className="onb-provider-ok">
        <CheckIcon className="w-3.5 h-3.5" /> Connected
      </span>
    )
  } else if (agent.installing) {
    state = (
      <span className="onb-provider-busy">
        <Spinner /> Installing {name === 'ChatGPT' ? 'Codex' : 'Claude Code'}… about a minute
      </span>
    )
  } else if (!agent.installed) {
    state = (
      <span>
        {provider === 'claude' ? 'Claude Code' : 'Codex'} isn’t on this Mac yet.
        {installError && <span className="onb-provider-error">{installError}</span>}
      </span>
    )
    action = agent.installCommand ? (
      <button type="button" className="btn-secondary" onClick={onInstall}>
        Install
      </button>
    ) : agent.helpUrl ? (
      <button
        type="button"
        className="btn-secondary"
        onClick={() => void window.electronAPI.openExternal(agent.helpUrl!)}
      >
        How to install
        <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
      </button>
    ) : null
  } else if (running) {
    state = (
      <span className="onb-provider-busy">
        <Spinner /> Finish signing in in your browser.
        {job?.url && (
          <button
            type="button"
            className="onb-link"
            onClick={() => void window.electronAPI.openExternal(job.url!)}
          >
            Open the page again
          </button>
        )}
      </span>
    )
    action = (
      <button
        type="button"
        className="btn-secondary"
        onClick={() => accountId && void cancel(provider, accountId)}
      >
        Cancel
      </button>
    )
  } else {
    state = (
      <span>
        {job?.status === 'failed' ? (
          <span className="onb-provider-error">{job.message ?? 'The sign-in failed.'}</span>
        ) : (
          blurb
        )}
      </span>
    )
    action = (
      <button type="button" className="btn-primary" onClick={() => void signIn()}>
        {job?.status === 'failed' ? 'Try again' : 'Sign in'}
      </button>
    )
  }

  return (
    <div
      className={connected ? 'onb-provider is-connected' : 'onb-provider'}
      data-onboarding-provider={provider}
      data-stagger-item
    >
      <div className="onb-provider-logo">
        <Logo className="w-5 h-5" />
      </div>
      <div className="onb-provider-text">
        <strong>
          {name} <span className="onb-provider-maker">by {maker}</span>
        </strong>
        <span className="onb-provider-state">{state}</span>
        {!agent.installed && !agent.installing && agent.installCommand && !connected && (
          <code className="onb-provider-command">{agent.installCommand}</code>
        )}
        {running && job?.awaitingCode && (
          <div className="onb-code">
            <input
              className="input-compact"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Paste the code from the browser"
              aria-label="Sign-in code"
            />
            <button
              type="button"
              className="btn-secondary"
              disabled={!code.trim()}
              onClick={() => {
                if (accountId) void sendCode(provider, accountId, code)
                setCode('')
              }}
            >
              Send
            </button>
          </div>
        )}
      </div>
      {action && <div className="onb-provider-action">{action}</div>}
    </div>
  )
}

export function ConnectStep({
  agents,
  installErrors,
  onInstall,
  onCheckAgain
}: {
  agents: OnboardingAgent[] | null
  installErrors: Partial<Record<OnboardingAgentId, string>>
  onInstall: (id: OnboardingAgentId) => void
  onCheckAgain: () => void
}): React.JSX.Element {
  const connections = useConnections()
  const claudeInstalled = agents?.find((a) => a.id === 'claude')?.installed === true
  // The Mac's own Claude login counts once the CLI is there: its usage read says so.
  useEffect(() => {
    if (claudeInstalled) void claudeUsageStore(DEFAULT_CLAUDE_PROFILE_ID).getState().load()
  }, [claudeInstalled])
  if (!agents) {
    return (
      <div className="onb-providers onb-providers--loading">
        <Spinner /> Looking for the assistants on this Mac…
      </div>
    )
  }
  return (
    <div className="onb-providers" data-stagger>
      {agents.map((agent) => (
        <ProviderCard
          key={agent.id}
          agent={agent}
          connected={connections[agent.id] !== null}
          installError={installErrors[agent.id] ?? null}
          onInstall={() => onInstall(agent.id)}
        />
      ))}
      <p className="onb-footnote" data-stagger-item>
        One is enough; you can add more accounts later in Settings → Accounts.{' '}
        <button type="button" className="onb-link" onClick={onCheckAgain}>
          Check again
        </button>
      </p>
    </div>
  )
}
