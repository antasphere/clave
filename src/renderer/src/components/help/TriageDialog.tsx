import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@clave/ui/components'
import { useTriageStore } from '../../store/triage-store'
import { SettingsSelect } from '../settings/primitives'

export function TriageDialog(): React.JSX.Element {
  const state = useTriageStore()
  const { prepared, selection, choices } = state
  const busy = state.preparing || state.launchState !== 'ready'
  const profiles = choices?.profiles.filter((p) => p.family === selection.provider) ?? []
  const accounts = choices?.accounts[selection.provider] ?? []
  const partial =
    prepared && (!prepared.snapshot.reconciliation.complete || prepared.warnings.length > 0)
  return (
    <Dialog
      open={state.open}
      onOpenChange={(open) => {
        if (!open) state.closeDialog()
      }}
    >
      <DialogContent className="w-[560px] max-w-[calc(100vw-32px)] max-h-[90vh] overflow-y-auto p-6">
        <DialogTitle>Debug Clave</DialogTitle>
        <DialogDescription className="mt-1.5">
          Start a support conversation about this running app. Your other sessions keep running.
        </DialogDescription>
        {state.preparing && (
          <p role="status" className="text-xs text-text-secondary mt-4">
            Preparing context…
          </p>
        )}
        {prepared && (
          <>
            <p className="text-[11px] text-text-secondary mt-4" data-testid="triage-summary">
              {partial ? 'Partial context' : 'Context captured'} · {prepared.summary.windows}{' '}
              windows · {prepared.summary.sessions ?? 'Unknown'} sessions · {prepared.summary.mode}
            </p>
            <p className="text-[11px] text-text-tertiary break-all mt-1">
              {prepared.generatedAt} · Instance {prepared.origin.instanceId} · Window{' '}
              {prepared.origin.windowId ?? 'unknown'}
            </p>
            {prepared.warnings.length > 0 && (
              <ul className="text-[11px] text-text-secondary list-disc pl-4 mt-2">
                {prepared.warnings.map((warning, i) => (
                  <li key={i}>{warning}</li>
                ))}
              </ul>
            )}
            <details className="mt-3 text-xs text-text-secondary">
              <summary className="cursor-pointer">Preview context</summary>
              <pre
                aria-label="Context preview"
                className="whitespace-pre-wrap break-words max-h-40 overflow-auto text-[11px] mt-2 select-text"
              >
                {prepared.contextMarkdown.slice(0, 24_000)}
              </pre>
              {prepared.contextMarkdown.length > 24_000 && (
                <p>Preview shortened. Copy context includes the full bounded capture.</p>
              )}
            </details>
          </>
        )}
        <div className="grid grid-cols-2 gap-3 mt-4">
          <div>
            <span className="field-label">Provider</span>
            <SettingsSelect
              ariaLabel="Triage provider"
              value={selection.provider}
              disabled={busy}
              options={[
                { value: 'claude', label: 'Claude Code' },
                { value: 'codex', label: 'Codex' }
              ]}
              onChange={(provider) => state.select({ provider })}
              className="w-full"
            />
          </div>
          <div>
            <span className="field-label">Launch profile</span>
            <SettingsSelect
              ariaLabel="Triage launch profile"
              value={selection.profileId}
              disabled={busy || !choices}
              options={profiles.map((p) => ({ value: p.id, label: p.name }))}
              placeholder="Profile unavailable"
              onChange={(profileId) => state.select({ profileId })}
              className="w-full"
            />
          </div>
          <div className="col-span-2">
            <span className="field-label">Account</span>
            <SettingsSelect
              ariaLabel="Triage account"
              value={selection.accountId}
              disabled={busy || !choices}
              options={accounts.map((a) => ({
                value: a.id,
                label: a.usable ? a.label : `${a.label} · needs login`
              }))}
              placeholder="Account unavailable"
              onChange={(accountId) => state.select({ accountId })}
              className="w-full"
            />
          </div>
        </div>
        <p className="text-[11px] text-text-tertiary mt-2">
          Uses the selected profile&apos;s permissions
          {selection.dangerousMode ? ' and your current skip-permissions selection' : ''}. Defaults
          stay unchanged. Account availability comes from Clave&apos;s account list; the provider
          reports login and startup errors in its tab.
        </p>
        {selection.dangerousMode && state.launchState === 'ready' && (
          <button
            className="btn-secondary mt-2"
            onClick={() => state.select({ dangerousMode: false })}
          >
            Use profile permissions only
          </button>
        )}
        <label htmlFor="triage-problem" className="field-label block mt-3">
          What went wrong? <span className="text-text-tertiary">Optional</span>
        </label>
        <textarea
          id="triage-problem"
          className="textarea-field w-full"
          rows={2}
          maxLength={2000}
          value={state.problem}
          disabled={state.launchState !== 'ready'}
          onChange={(e) => state.setProblem(e.target.value)}
        />
        {prepared?.agentLaunch === 'external-only' && (
          <p className="text-xs text-text-secondary mt-3">
            This app is attached to a server whose filesystem may be elsewhere. Copy context, or run
            the external command on this Mac. In-app launch is unavailable for this capture.
          </p>
        )}
        {state.choicesError && (
          <p role="alert" className="text-xs text-text-secondary mt-3">
            {state.choicesError}
          </p>
        )}
        {state.error && (
          <p role="alert" className="text-xs text-text-secondary mt-3">
            {state.error}
          </p>
        )}
        {state.launchState === 'started' && (
          <p role="status" className="text-xs text-text-secondary mt-3">
            Support tab created. It uses this capture. Check the tab for provider startup or login
            errors.
          </p>
        )}
        <div className="flex flex-wrap gap-2 mt-4">
          <button
            className="btn-secondary"
            disabled={!prepared}
            onClick={() => void state.copy('context')}
          >
            Copy context
          </button>
          <button
            className="btn-secondary"
            disabled={!prepared}
            onClick={() => void state.copy('prompt')}
          >
            Copy support prompt
          </button>
          <button
            className="btn-secondary"
            disabled={!prepared?.externalCommands}
            onClick={() => void state.copy('external')}
          >
            Copy external command
          </button>
        </div>
        {prepared?.externalCommands && (
          <details className="text-[11px] text-text-secondary mt-2">
            <summary className="cursor-pointer">Same-machine external command</summary>
            <pre
              aria-label="External command"
              className="whitespace-pre-wrap break-all select-text mt-1"
            >
              {prepared.externalCommands[selection.provider]}
            </pre>
            <p className="mt-1">
              Uses this Mac&apos;s CLI settings and login. Paste the support prompt to include your
              problem.
            </p>
          </details>
        )}
        {state.copyStatus && (
          <p role="status" className="text-[11px] text-text-secondary mt-2">
            {state.copyStatus}
          </p>
        )}
        <div className="flex justify-end gap-2 mt-5">
          <button
            className="btn-dialog"
            disabled={state.preparing || state.launchState === 'launching'}
            onClick={() =>
              void (state.launchState === 'ready' ? state.refresh() : state.checkSupport())
            }
          >
            {state.launchState === 'ready' ? 'Capture again' : 'Check support tab'}
          </button>
          <button className="btn-dialog" onClick={state.closeDialog}>
            {state.launchState === 'ready' ? 'Cancel' : 'Close'}
          </button>
          <button
            className="btn-primary"
            disabled={busy || !choices || !prepared?.bundle || prepared.agentLaunch !== 'in-app'}
            onClick={() => void state.start()}
          >
            {state.launchState === 'launching'
              ? 'Starting…'
              : state.launchState === 'started'
                ? 'Support tab created'
                : state.launchState === 'uncertain'
                  ? 'Check existing tabs'
                  : 'Start support conversation'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
