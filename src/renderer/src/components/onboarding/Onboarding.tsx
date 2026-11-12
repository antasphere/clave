import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckIcon, FolderIcon } from '@heroicons/react/20/solid'
import type {
  OnboardingAgent,
  OnboardingAgentId,
  OnboardingState
} from '../../../../shared/onboarding'
import { OnboardingDrawing } from './OnboardingDrawing'
import { ConnectStep } from './ConnectStep'
import { useConnections } from './connections'
import { CHAT_VIEWS, FIRST_MESSAGE, SETUP_LINE_HINT, folderPreview, folderTarget } from './content'
import { ClaudeLogo, CodexLogo } from '../icons/cli-logos'
import { loadAccountLogins } from '../../store/account-login-store'
import { loadClaudeProfiles, useClaudeProfileStore } from '../../store/claude-profile-store'
import { loadCodexAccounts, useCodexAccountStore } from '../../store/codex-account-store'
import { addWorkspace, isUnderRoot, setActiveWorkspace } from '../../lib/workspace-actions'
import { launchSession } from '../../lib/launch-session'
import { setPendingChatView } from '../../lib/pending-chat-view'
import { selectedChatProfile } from '../../store/launch-profile-store'
import { CHAT_PROFILE_IDS } from '../../../../shared/open-session-modes'
import { useWorkspaceStore } from '../../store/workspace-store'
import { useLaunchSettingsStore } from '../../store/launch-settings-store'
import type { InteractionMode } from '../../../../shared/harness'
import { skinAction, useSkinStore } from '../../lib/skin'
import './onboarding.css'

/**
 * The first-run walk: four steps and a door, in the hand of the tool
 * template's "New workspace" walk (the ring drawing that closes one seat per
 * step, the step marks under the title, each step sliding in from the side
 * it comes from, its parts arriving one after the other).
 *
 *   1. What Clave is, in plain words.
 *   2. An assistant: Claude or ChatGPT, installed in one click when missing,
 *      signed in through the browser (`ConnectStep.tsx`).
 *   3. The kind of chat the reader prefers: Chat, Enclave, Folio or the
 *      terminal. It is the interaction mode (PRDCT-4425): how every new
 *      conversation opens.
 *   4. A workspace: a name and where its folder goes (or a folder they
 *      already have). It opens with a session already on it, the first
 *      message sent, so the agent is answering by the time the door opens.
 *
 * Generic on purpose: Clave is public, so nothing here names a team, a
 * server or a company. A setup line someone handed the reader is pasted into
 * the last step and sent as the session's first message instead.
 *
 * Shown once, on a first install (`onboarding` in main's preferences), and
 * again from Help → Welcome to Clave…; skipping counts as done.
 */

type Step = 1 | 2 | 3 | 4 | 5 | 'done'
const STEPS = 5

const CAPTIONS: Record<Step, string> = {
  1: 'Your assistants, side by side',
  2: 'Like the rest of your Mac',
  3: 'One account is all it takes',
  4: 'Change it any time, per tab',
  5: 'A home for your work',
  done: 'Ready'
}

/** The little picture of each chat style, drawn with boxes and lines. */
function ChatPreview({
  kind
}: {
  kind: (typeof CHAT_VIEWS)[number]['preview']
}): React.JSX.Element {
  return (
    <svg viewBox="0 0 120 72" className="onb-drawing onb-chat-preview" aria-hidden="true">
      <rect className="bx" x="1" y="1" width="118" height="70" rx="8" />
      {kind === 'chat' && (
        <>
          <rect className="bx bx--front" x="62" y="10" width="48" height="12" rx="6" />
          <line className="ln ln--thin" x1="12" y1="32" x2="78" y2="32" />
          <line className="ln ln--thin" x1="12" y1="40" x2="66" y2="40" />
          <rect className="bx bx--front" x="70" y="48" width="40" height="12" rx="6" />
          <circle className="dot dot--c" cx="102" cy="54" r="2" />
        </>
      )}
      {kind === 'enclave' && (
        <>
          <line className="ln ln--thin" x1="14" y1="12" x2="14" y2="62" />
          {[14, 26, 38, 50].map((y, i) => (
            <g key={y}>
              <circle className={i === 3 ? 'dot dot--c' : 'dot dot--seat'} cx="14" cy={y} r="2" />
              <line className="ln ln--thin" x1="22" y1={y} x2={92 - i * 9} y2={y} />
            </g>
          ))}
        </>
      )}
      {kind === 'terminal' && (
        <>
          {/* the agent's own screen: a dark block, a prompt line, the cursor */}
          <rect
            x="10"
            y="10"
            width="100"
            height="52"
            rx="4"
            style={{ fill: 'color-mix(in oklab, var(--ink) 82%, transparent)' }}
          />
          <path className="ln" d="M18,22 L23,26 L18,30" style={{ stroke: 'var(--paper)' }} />
          <line
            className="ln ln--thin"
            x1="28"
            y1="26"
            x2="74"
            y2="26"
            style={{ stroke: 'var(--paper)' }}
          />
          <rect className="dot dot--c" x="18" y="40" width="5" height="8" rx="1" />
        </>
      )}
      {kind === 'lab' && (
        <>
          {/* the strip of pages, the one being read in the accent */}
          {[0, 1, 2, 3].map((i) => (
            <line
              key={i}
              className={i === 2 ? 'ln ln--c' : 'ln ln--thin'}
              x1={46 + i * 9}
              y1="9"
              x2={46 + i * 9}
              y2={i === 2 ? 17 : 13 + (i % 2) * 2}
            />
          ))}
          {/* the page: its title, the answer written as a document */}
          <rect className="bx bx--front" x="16" y="22" width="62" height="42" rx="4" />
          <line className="ln" x1="24" y1="31" x2="56" y2="31" />
          <line className="ln ln--thin" x1="24" y1="40" x2="70" y2="40" />
          <line className="ln ln--thin" x1="24" y1="47" x2="66" y2="47" />
          <line className="ln ln--thin" x1="24" y1="54" x2="58" y2="54" />
          {/* the margin: what the agent did, beside the paragraph it led to */}
          <path className="ln ln--soft" d="M80,40 L86,40" />
          <rect className="bx" x="88" y="35" width="22" height="10" rx="3" />
          <path className="ln ln--soft" d="M80,54 L86,54" />
          <circle className="dot dot--seat" cx="92" cy="54" r="2" />
          <line className="ln ln--thin" x1="97" y1="54" x2="108" y2="54" />
        </>
      )}
    </svg>
  )
}

/** Charcoal on a dark Mac, Light on a light one. */
function deviceSkinId(): string {
  return typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'charcoal'
    : 'light'
}

export function Onboarding(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<OnboardingState | null>(null)
  const [step, setStep] = useState<Step>(1)
  const [direction, setDirection] = useState<1 | -1>(1)
  const [agents, setAgents] = useState<OnboardingAgent[] | null>(null)
  const [installErrors, setInstallErrors] = useState<Partial<Record<OnboardingAgentId, string>>>({})
  const [mode, setMode] = useState<InteractionMode>(CHAT_VIEWS[0].mode)
  const [name, setName] = useState('My workspace')
  const [parent, setParent] = useState<string | null>(null)
  const [existing, setExisting] = useState<string | null>(null)
  const [setupLine, setSetupLine] = useState('')
  const [talkTo, setTalkTo] = useState<OnboardingAgentId | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [made, setMade] = useState<{ id: string; name: string; root: string } | null>(null)
  const [opened, setOpened] = useState<{ name: string; agent: OnboardingAgentId | null } | null>(
    null
  )
  const primary = useRef<HTMLButtonElement>(null)
  const connections = useConnections()

  const skins = useSkinStore((s) => s.skins)
  const activeSkinId = useSkinStore((s) => s.activeId)
  // The skin matching the Mac's own appearance: Charcoal for dark, Light for light.
  const deviceSkin = deviceSkinId()
  const pickSkin = (id: string): void => {
    void skinAction(() => window.electronAPI.skinsActivate(id))
  }

  const begin = useCallback((next: OnboardingState) => {
    // Nobody chose a skin yet: start on the Mac's own appearance, so the
    // walk is already drawn the way the reader's screen looks.
    if (next.skin === null) {
      const id = deviceSkinId()
      void skinAction(() => window.electronAPI.skinsActivate(id))
    }
    setState(next)
    setStep(1)
    setDirection(1)
    setError(null)
    setOpened(null)
    setMade(null)
    setParent((p) => p ?? next.home)
    setOpen(true)
    void loadAccountLogins()
    if (!useClaudeProfileStore.getState().loaded) void loadClaudeProfiles()
    if (!useCodexAccountStore.getState().loaded) void loadCodexAccounts()
    // The step starts on the interaction mode already set (Settings →
    // General, or an earlier walk).
    const settings = useLaunchSettingsStore.getState()
    void (settings.loaded ? Promise.resolve() : settings.load()).then(() =>
      setMode(useLaunchSettingsStore.getState().interactionMode)
    )
    void window.electronAPI.onboardingAgents(true).then(setAgents)
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.electronAPI?.onboardingGetState?.().then((s) => {
      if (!cancelled && s.show) begin(s)
    })
    const off = window.electronAPI?.onOpenOnboarding?.(() => {
      void window.electronAPI.onboardingGetState().then((s) => begin({ ...s, show: true }))
    })
    return () => {
      cancelled = true
      off?.()
    }
  }, [begin])

  // The keyboard lands on each step's way forward.
  useEffect(() => {
    if (open) requestAnimationFrame(() => primary.current?.focus({ preventScroll: true }))
  }, [open, step])

  // The agent the first session talks to: the one connected, Claude first.
  const available: OnboardingAgentId[] = (['claude', 'codex'] as const).filter(
    (id) => connections[id] !== null
  )
  const agent = talkTo && available.includes(talkTo) ? talkTo : (available[0] ?? null)

  const go = (next: Step): void => {
    const order = (s: Step): number => (s === 'done' ? 6 : s)
    setDirection(order(next) >= order(step) ? 1 : -1)
    setError(null)
    setStep(next)
  }

  const finish = (): void => {
    void window.electronAPI.onboardingComplete()
    setOpen(false)
  }

  const install = async (id: OnboardingAgentId): Promise<void> => {
    setInstallErrors((e) => ({ ...e, [id]: undefined }))
    setAgents((list) => list?.map((a) => (a.id === id ? { ...a, installing: true } : a)) ?? list)
    const result = await window.electronAPI.onboardingInstall(id).catch((err: unknown) => ({
      ok: false,
      message: err instanceof Error ? err.message : 'The install failed.',
      agents: null
    }))
    if (result.agents) setAgents(result.agents)
    else
      setAgents((list) => list?.map((a) => (a.id === id ? { ...a, installing: false } : a)) ?? list)
    if (!result.ok)
      setInstallErrors((e) => ({ ...e, [id]: result.message ?? 'The install failed.' }))
  }

  const chooseFolder = async (): Promise<void> => {
    const picked = await window.electronAPI.openFolderDialog(parent ?? state?.home)
    if (picked) setParent(picked)
  }
  const chooseExisting = async (): Promise<void> => {
    const picked = await window.electronAPI.openFolderDialog(state?.home)
    if (!picked) return
    setExisting(picked)
    const base = picked.split('/').filter(Boolean).pop() ?? ''
    if (base) setName(base.charAt(0).toUpperCase() + base.slice(1))
  }

  const createWorkspace = async (): Promise<void> => {
    if (!state || busy) return
    setBusy(true)
    setError(null)
    try {
      // A workspace made by an earlier try whose session failed is taken up
      // again, never made twice: only the session is retried.
      let ws = made
      if (!ws) {
        const root = existing ?? folderTarget(parent ?? state.home, name)
        if (!root) {
          setError('Give the workspace a name.')
          return
        }
        // Refused before anything is made on disk.
        const clash = useWorkspaceStore
          .getState()
          .workspaces.find((w) => isUnderRoot(w.rootDir, root) || isUnderRoot(root, w.rootDir))
        if (clash) {
          setError(`That folder is inside ${clash.name}, or holds it. Pick another place.`)
          return
        }
        const folder =
          existing ?? (await window.electronAPI.onboardingCreateFolder(parent ?? state.home, name))
        const added = await addWorkspace(folder, null, name)
        if (!added) {
          setError(
            'That folder is inside a workspace you already have, or holds one. Pick another.'
          )
          return
        }
        ws = { id: added.id, name: added.name, root: added.rootDir }
        setMade(ws)
      }
      if (useWorkspaceStore.getState().activeWorkspaceId !== ws.id) await setActiveWorkspace(ws.id)
      if (agent) {
        const accountId = connections[agent]!
        // The way just picked: a chat on the chat launch profile the launcher
        // would open in this workspace (the built-in one by default), or,
        // for the terminal, the workspace's terminal profile (none named).
        const terminal = mode === 'terminal'
        await launchSession({
          setup:
            agent === 'claude'
              ? {
                  kind: 'claude',
                  dangerousMode: false,
                  claudeProfileId: accountId,
                  launchProfileId: terminal
                    ? undefined
                    : (selectedChatProfile('claude', ws.id) ?? CHAT_PROFILE_IDS.claude)
                }
              : {
                  kind: 'codex',
                  dangerousMode: false,
                  codexAccountId: accountId,
                  launchProfileId: terminal
                    ? undefined
                    : (selectedChatProfile('codex', ws.id) ?? CHAT_PROFILE_IDS.codex)
                },
          cwd: { kind: 'path', path: ws.root },
          workspaceId: ws.id,
          initialPrompt: setupLine.trim() || FIRST_MESSAGE,
          remember: true,
          throwOnError: true
        })
      }
      setOpened({ name: ws.name, agent })
      go('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the workspace.')
    } finally {
      setBusy(false)
    }
  }

  if (!open || !state) return null

  // seats behind the reader: none on the first step, all of them at the door
  const behind = step === 'done' ? STEPS : step - 1
  const variants = {
    enter: (d: number) => ({ opacity: 0, x: 28 * d }),
    center: { opacity: 1, x: 0 },
    exit: (d: number) => ({ opacity: 0, x: -20 * d })
  }
  const transition = { duration: 0.36, ease: [0.22, 1, 0.36, 1] as const }
  const anyConnected = available.length > 0
  const Logo = opened?.agent === 'codex' ? CodexLogo : opened?.agent ? ClaudeLogo : CheckIcon

  let eyebrow = step === 'done' ? 'All set' : `Step ${step} of ${STEPS}`
  let title = ''
  let description = ''
  let body: React.ReactNode = null
  let footer: React.ReactNode = null

  if (step === 1) {
    title = 'Welcome to Clave'
    description =
      'Clave is where you work with AI assistants. Each tab is a conversation with one of them, working on something for you, and you can run several side by side.'
    body = (
      <ul className="onb-points" data-stagger>
        <li data-stagger-item>
          <span className="onb-point-mark" />
          <span>
            <strong>Ask in plain words.</strong> The assistant reads your files, writes, runs what
            is needed, and asks before anything important.
          </span>
        </li>
        <li data-stagger-item>
          <span className="onb-point-mark" />
          <span>
            <strong>Keep things together.</strong> A workspace is a folder on your Mac with its own
            tabs, so each project stays in its place.
          </span>
        </li>
        <li data-stagger-item>
          <span className="onb-point-mark" />
          <span>
            <strong>Show, don’t describe.</strong> Drop a file or another tab into a conversation to
            share it.
          </span>
        </li>
      </ul>
    )
    footer = (
      <button ref={primary} type="button" className="btn-primary" onClick={() => go(2)}>
        Get started
      </button>
    )
  } else if (step === 2) {
    title = 'Pick a look'
    description =
      'Clave starts the way your Mac looks, dark or light. Pick another if you like; it changes right away, and Settings can change it later.'
    body = (
      <div className="onb-looks" role="radiogroup" aria-label="Appearance" data-stagger>
        {skins.map((skin) => (
          <button
            key={skin.id}
            type="button"
            role="radio"
            aria-checked={activeSkinId === skin.id}
            className={
              activeSkinId === skin.id ? 'onb-choice onb-look is-on' : 'onb-choice onb-look'
            }
            onClick={() => pickSkin(skin.id)}
            data-onboarding-skin={skin.id}
            data-stagger-item
          >
            <span className="theme-swatch-preview onb-look-preview" data-theme={skin.skin.base}>
              <span className="theme-swatch-line w-10 mb-2" style={{ opacity: 0.7 }} />
              <span className="flex gap-1">
                <span className="theme-swatch-tile" />
                <span className="theme-swatch-tile" />
              </span>
              <span className="theme-swatch-line w-14 mt-2" style={{ opacity: 0.4 }} />
            </span>
            <span className="onb-choice-title">
              {skin.name}

              <span className="onb-choice-check">
                <CheckIcon className="w-3 h-3" />
              </span>
            </span>
            <span className="onb-choice-hint onb-look-hint">
              {skin.id === deviceSkin ? 'Your Mac' : '\u00a0'}
            </span>
          </button>
        ))}
      </div>
    )
    footer = (
      <>
        <button type="button" className="btn-secondary" onClick={() => go(1)}>
          Back
        </button>
        <button ref={primary} type="button" className="btn-primary" onClick={() => go(3)}>
          Continue
        </button>
      </>
    )
  } else if (step === 3) {
    title = 'Connect your assistant'
    description =
      'Clave works with the subscription you already have. Pick one; your browser opens to sign in, and you come right back.'
    body = (
      <ConnectStep
        agents={agents}
        installErrors={installErrors}
        onInstall={(id) => void install(id)}
        onCheckAgain={() => {
          setAgents(null)
          void window.electronAPI.onboardingAgents(true).then(setAgents)
        }}
      />
    )
    footer = (
      <>
        <button type="button" className="btn-secondary" onClick={() => go(2)}>
          Back
        </button>
        <button
          ref={primary}
          type="button"
          className={anyConnected ? 'btn-primary' : 'btn-secondary'}
          onClick={() => go(4)}
        >
          {anyConnected ? 'Continue' : 'Skip for now'}
        </button>
      </>
    )
  } else if (step === 4) {
    title = 'What kind of chat do you prefer?'
    description = 'Every new conversation opens this way. Each tab can switch from its header.'
    body = (
      <div className="onb-choices" role="radiogroup" aria-label="Chat style" data-stagger>
        {CHAT_VIEWS.map((view) => (
          <button
            key={view.id}
            type="button"
            role="radio"
            aria-checked={mode === view.mode}
            className={mode === view.mode ? 'onb-choice is-on' : 'onb-choice'}
            onClick={() => setMode(view.mode)}
            data-onboarding-chat-view={view.id}
            data-stagger-item
          >
            <ChatPreview kind={view.preview} />
            <span className="onb-choice-title">
              {view.title}
              {view.preview === 'lab' && <span className="onb-tag">New</span>}
              <span className="onb-choice-check">
                <CheckIcon className="w-3 h-3" />
              </span>
            </span>
            <span className="onb-choice-hint">{view.tagline}</span>
          </button>
        ))}
      </div>
    )
    footer = (
      <>
        <button type="button" className="btn-secondary" onClick={() => go(3)}>
          Back
        </button>
        <button
          ref={primary}
          type="button"
          className="btn-primary"
          onClick={() => {
            // The one setting (PRDCT-4425); the first chat also carries its
            // view to a separate server that has not heard it yet.
            void useLaunchSettingsStore.getState().setInteractionMode(mode)
            setPendingChatView(
              mode === 'terminal'
                ? null
                : (CHAT_VIEWS.find((view) => view.mode === mode)?.id ?? null)
            )
            go(5)
          }}
        >
          Continue
        </button>
      </>
    )
  } else if (step === 5) {
    title = 'Make your first workspace'
    description = anyConnected
      ? 'A folder for your work. It opens with a conversation already started, so you can ask what comes next.'
      : 'A folder for your work. Connect an assistant later and start a conversation in it.'
    body = (
      <div className="onb-form" data-stagger>
        <label className="onb-field" data-stagger-item>
          <span className="onb-label">Name</span>
          <input
            className="input-compact"
            value={made?.name ?? name}
            onChange={(e) => setName(e.target.value)}
            disabled={made !== null}
            maxLength={120}
            aria-label="Workspace name"
          />
        </label>
        <div className="onb-field" data-stagger-item>
          <span className="onb-label">Folder</span>
          <div className="onb-folder">
            <FolderIcon className="w-4 h-4" />
            <span className="onb-folder-path">
              {made?.root ?? existing ?? folderPreview(state.home, parent ?? state.home, name)}
            </span>
            {made ? null : existing ? (
              <button type="button" className="onb-link" onClick={() => setExisting(null)}>
                Make a new one instead
              </button>
            ) : (
              <button type="button" className="onb-link" onClick={() => void chooseFolder()}>
                Change…
              </button>
            )}
          </div>
          {made && (
            <p className="onb-footnote">
              The workspace is made. Trying again only starts its conversation.
            </p>
          )}
          {!existing && !made && (
            <button
              type="button"
              className="onb-link onb-link--quiet"
              onClick={() => void chooseExisting()}
            >
              Or use a folder you already have
            </button>
          )}
        </div>
        {available.length > 1 && (
          <div className="onb-field" data-stagger-item>
            <span className="onb-label">Talk to</span>
            <div className="segmented" role="radiogroup" aria-label="Assistant">
              {available.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={agent === id}
                  className="segmented-item"
                  data-active={agent === id ? 'true' : undefined}
                  onClick={() => setTalkTo(id)}
                >
                  {id === 'claude' ? (
                    <ClaudeLogo className="w-3.5 h-3.5" />
                  ) : (
                    <CodexLogo className="w-3.5 h-3.5" />
                  )}
                  {id === 'claude' ? 'Claude' : 'ChatGPT'}
                </button>
              ))}
            </div>
          </div>
        )}
        {anyConnected && (
          <label className="onb-field" data-stagger-item>
            <span className="onb-label">{SETUP_LINE_HINT}</span>
            <textarea
              className="input-compact onb-setup-line"
              value={setupLine}
              onChange={(e) => setSetupLine(e.target.value)}
              rows={2}
              placeholder="Optional. Otherwise the assistant starts by asking what you want to do."
              aria-label="Setup line"
              data-onboarding-setup-line
            />
          </label>
        )}
        {error && (
          <p className="onb-error" role="alert">
            {error}
          </p>
        )}
      </div>
    )
    footer = (
      <>
        <button type="button" className="btn-secondary" onClick={() => go(4)} disabled={busy}>
          Back
        </button>
        <button
          ref={primary}
          type="button"
          className="btn-primary"
          disabled={busy || (!existing && !name.trim())}
          onClick={() => void createWorkspace()}
          data-onboarding-create
        >
          {busy ? 'Opening…' : anyConnected ? 'Create and start' : 'Create the workspace'}
        </button>
      </>
    )
  } else {
    eyebrow = 'All set'
    title = opened ? `${opened.name} is ready` : 'You’re ready'
    description = opened?.agent
      ? `${opened.agent === 'codex' ? 'ChatGPT' : 'Claude'} is already reading your first message. Ask it anything, including what to do next.`
      : 'Connect an assistant in Settings → Accounts whenever you like, then open a conversation from the sidebar.'
    footer = (
      <button ref={primary} type="button" className="btn-primary" onClick={finish}>
        {opened?.agent ? 'Open the conversation' : 'Start using Clave'}
      </button>
    )
  }

  return (
    <div
      className="onb"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Clave"
      data-testid="onboarding"
    >
      <div className="onb-card">
        <aside className="onb-aside">
          <div className="onb-door">
            <OnboardingDrawing steps={STEPS} done={behind} />
            {step === 'done' && (
              <div className="onb-bloom" aria-hidden="true">
                <span className="onb-bloom-wash" />
                <span className="onb-bloom-ring onb-bloom-ring--1" />
                <span className="onb-bloom-ring onb-bloom-ring--2" />
                <span className="onb-bloom-ring onb-bloom-ring--3" />
                <span className="onb-bloom-tile">
                  <Logo className="w-9 h-9" />
                </span>
              </div>
            )}
          </div>
          <div className="onb-aside-words">
            <p className="onb-eyebrow">Clave</p>
            <p className="onb-caption">{CAPTIONS[step]}</p>
          </div>
        </aside>
        <section className="onb-main">
          {step !== 'done' && (
            <button type="button" className="onb-skip" onClick={finish}>
              Skip
            </button>
          )}
          <motion.div layout transition={transition} className="onb-sheet">
            <AnimatePresence mode="wait" custom={direction} initial={false}>
              <motion.div
                key={String(step)}
                custom={direction}
                variants={variants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={transition}
              >
                <p className="onb-eyebrow">{eyebrow}</p>
                <h1 className="onb-title">{title}</h1>
                <p className="onb-description">{description}</p>
                {step !== 'done' && (
                  <ol className="onb-steps" aria-hidden="true">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <li
                        key={n}
                        className={n === step ? 'on' : n < (step as number) ? 'past' : ''}
                      />
                    ))}
                  </ol>
                )}
                {body && <div className="onb-body">{body}</div>}
                <div className="onb-footer">{footer}</div>
              </motion.div>
            </AnimatePresence>
          </motion.div>
        </section>
      </div>
    </div>
  )
}
