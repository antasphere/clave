import { useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useLocationStore } from '../../store/location-store'
import {
  XMarkIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  ArrowPathIcon
} from '@heroicons/react/24/outline'
import { Toggle } from './primitives'

type Step = 'credentials' | 'test' | 'summary'
const STEPS: { id: Step; label: string }[] = [
  { id: 'credentials', label: 'Connection' },
  { id: 'test', label: 'Test' },
  { id: 'summary', label: 'Done' }
]
const AUTH_METHODS = [
  { id: 'key', label: 'SSH key' },
  { id: 'password', label: 'Password' },
  { id: 'agent', label: 'SSH agent' }
] as const

interface AddLocationDialogProps {
  onClose: () => void
}

/**
 * The three-step remote location dialog, on the app's own modal: the
 * `.modal-card` surface, the title block every dialog opens with, a
 * `.segmented` step rail, the system's fields and labels, the switch for the
 * one boolean, and the `.btn-dialog` footer pair the other modals end with.
 */
export function AddLocationDialog({ onClose }: AddLocationDialogProps): React.JSX.Element {
  const addLocation = useLocationStore((s) => s.addLocation)

  const [step, setStep] = useState<Step>('credentials')
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('')
  const [authMethod, setAuthMethod] = useState<'key' | 'password' | 'agent'>('key')
  const [privateKeyPath, setPrivateKeyPath] = useState('~/.ssh/id_ed25519')
  const [password, setPassword] = useState('')
  const [autoConnect, setAutoConnect] = useState(true)

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{
    success: boolean
    error?: string
    openclawVersion?: string
    openclawPort?: number
    openclawToken?: string
  } | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)

  const [createdLocationId, setCreatedLocationId] = useState<string | null>(null)

  const handleTest = useCallback(async () => {
    setTesting(true)
    setTestResult(null)

    // Create location first so we have credentials stored for test
    const loc = await addLocation(
      {
        name: name || host,
        type: 'remote',
        host,
        port: parseInt(port) || 22,
        username,
        authMethod,
        privateKeyPath: authMethod === 'key' ? privateKeyPath : undefined,
        autoConnect
      },
      authMethod === 'password' ? password : undefined
    )
    setCreatedLocationId(loc.id)

    const result = await window.electronAPI.locationTestConnection(loc.id)
    setTestResult(result)
    // Save detected OpenClaw config to location
    if (result.success && (result.openclawPort || result.openclawToken)) {
      await window.electronAPI.locationUpdate(loc.id, {
        openclawVersion: result.openclawVersion,
        openclawPort: result.openclawPort,
        openclawToken: result.openclawToken
      })
    }
    setTesting(false)
  }, [name, host, port, username, authMethod, privateKeyPath, password, autoConnect, addLocation])

  const handleInstallPlugin = useCallback(async () => {
    if (!createdLocationId) return
    setInstalling(true)
    setInstallError(null)
    const installResult = await window.electronAPI.locationInstallPlugin(createdLocationId)
    setInstalling(false)
    if (!installResult.success) {
      setInstallError(installResult.error || 'Installation failed')
      return
    }
    // Re-test to detect openclaw
    const result = await window.electronAPI.locationTestConnection(createdLocationId)
    setTestResult(result)
  }, [createdLocationId])

  const handleFinish = useCallback(async () => {
    // Update autoConnect setting
    if (createdLocationId) {
      await window.electronAPI.locationUpdate(createdLocationId, { autoConnect })
      // Connect immediately if autoConnect is enabled
      if (autoConnect) {
        try {
          await window.electronAPI.sshConnect(createdLocationId)
          // Connect OpenClaw if detected
          if (testResult?.openclawPort) {
            try {
              await window.electronAPI.agentConnect(createdLocationId)
              await window.electronAPI.agentList(createdLocationId)
            } catch {
              /* ok */
            }
          }
        } catch {
          /* will show as error in locations list */
        }
        // Reload locations to reflect connected status
        useLocationStore.getState().loadLocations()
      }
    }
    onClose()
  }, [onClose, createdLocationId, autoConnect, testResult])

  const handleRemoveOnCancel = useCallback(async () => {
    if (createdLocationId) {
      await window.electronAPI.locationRemove(createdLocationId)
      // Reload locations to reflect removal
      useLocationStore.getState().loadLocations()
    }
    onClose()
  }, [createdLocationId, onClose])

  const credentialsValid = host.trim() && username.trim()
  const stepIndex = STEPS.findIndex((s) => s.id === step)

  // Portal to body so the overlay escapes the main content's z-10 stacking
  // context. Otherwise it cannot cover the z-[45] git side panel.
  return createPortal(
    <div
      className="modal-scrim scrim-mount z-50 flex items-center justify-center"
      onClick={handleRemoveOnCancel}
    >
      <div
        className="modal-card menu-pop-mount w-full max-w-md mx-4"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="add-location-title"
      >
        <div className="px-4 pt-4 pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 id="add-location-title" className="text-control font-semibold text-text-primary">
                Add remote location
              </h3>
              <p className="mt-1 text-xs text-text-secondary">
                A machine reached over SSH that terminals and agents can run on.
              </p>
            </div>
            <button
              onClick={handleRemoveOnCancel}
              className="btn-icon btn-icon-sm"
              title="Close"
              aria-label="Close"
            >
              <XMarkIcon className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* The step rail: the same segmented control as every other mode
              switch, read-only here (the footer moves the step). */}
          <div className="segmented mt-3" aria-label="Steps" aria-hidden>
            {STEPS.map((s, i) => (
              <span
                key={s.id}
                className="segmented-item"
                data-active={step === s.id ? 'true' : undefined}
                data-step-done={i < stepIndex ? 'true' : undefined}
              >
                {i + 1}. {s.label}
              </span>
            ))}
          </div>
        </div>

        <div className="px-4 pb-4 space-y-3">
          {step === 'credentials' && (
            <>
              <div>
                <label className="field-label" htmlFor="add-location-name">
                  Name
                </label>
                <input
                  id="add-location-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Mac mini"
                  className="input-compact"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="field-label" htmlFor="add-location-host">
                    Host
                  </label>
                  <input
                    id="add-location-host"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="100.x.x.x or hostname"
                    className="input-compact"
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="add-location-port">
                    Port
                  </label>
                  <input
                    id="add-location-port"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    className="input-compact tabular-nums"
                  />
                </div>
              </div>
              <div>
                <label className="field-label" htmlFor="add-location-user">
                  Username
                </label>
                <input
                  id="add-location-user"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin"
                  className="input-compact"
                />
              </div>
              <div>
                <span className="field-label">Sign in with</span>
                <div className="segmented">
                  {AUTH_METHODS.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setAuthMethod(m.id)}
                      className="segmented-item"
                      data-active={authMethod === m.id ? 'true' : undefined}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
              {authMethod === 'key' && (
                <div>
                  <label className="field-label" htmlFor="add-location-key">
                    Private key
                  </label>
                  <input
                    id="add-location-key"
                    value={privateKeyPath}
                    onChange={(e) => setPrivateKeyPath(e.target.value)}
                    className="input-compact font-mono"
                  />
                </div>
              )}
              {authMethod === 'password' && (
                <div>
                  <label className="field-label" htmlFor="add-location-password">
                    Password
                  </label>
                  <input
                    id="add-location-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="input-compact"
                  />
                </div>
              )}
            </>
          )}

          {step === 'test' && (
            <div className="flex flex-col items-center gap-2 py-4 text-center">
              {testing ? (
                <>
                  <ArrowPathIcon className="w-6 h-6 text-text-tertiary animate-spin" />
                  <p className="text-control text-text-secondary">Testing the connection…</p>
                </>
              ) : testResult ? (
                testResult.success ? (
                  <>
                    <CheckCircleIcon className="w-6 h-6 text-success" />
                    <p className="text-control font-medium text-text-primary">Connected</p>
                    {testResult.openclawVersion ? (
                      <p className="text-xs text-text-secondary">
                        OpenClaw {testResult.openclawVersion} on port {testResult.openclawPort}
                      </p>
                    ) : (
                      <>
                        <p className="text-xs text-text-tertiary">
                          OpenClaw is not installed, so agents cannot run there yet.
                        </p>
                        <button
                          onClick={handleInstallPlugin}
                          disabled={installing}
                          className="btn-secondary mt-1"
                        >
                          {installing ? 'Installing…' : 'Install the Clave channel plugin'}
                        </button>
                        {installError && <p className="text-xs text-destructive">{installError}</p>}
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <ExclamationCircleIcon className="w-6 h-6 text-destructive" />
                    <p className="text-control font-medium text-text-primary">Could not connect</p>
                    <p className="text-xs text-text-tertiary break-words">{testResult.error}</p>
                  </>
                )
              ) : (
                <p className="text-control text-text-secondary">Test the connection to go on.</p>
              )}
            </div>
          )}

          {step === 'summary' && (
            <>
              <div className="flex items-center gap-3">
                <CheckCircleIcon className="w-5 h-5 text-success flex-shrink-0" />
                <div className="min-w-0">
                  <p className="text-control font-medium text-text-primary truncate">
                    {name || host}
                  </p>
                  <p className="text-xs text-text-tertiary truncate">
                    {username}@{host}:{port}
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-control text-text-secondary">Connect when Clave starts</span>
                <Toggle
                  checked={autoConnect}
                  onChange={setAutoConnect}
                  ariaLabel="Connect when Clave starts"
                />
              </div>
            </>
          )}
        </div>

        <div className="border-t border-border-subtle flex">
          <button
            type="button"
            onClick={
              step === 'credentials'
                ? handleRemoveOnCancel
                : () => setStep(step === 'test' ? 'credentials' : 'test')
            }
            className="btn-dialog text-text-secondary hover:text-text-primary border-r border-border-subtle"
          >
            {step === 'credentials' ? 'Cancel' : 'Back'}
          </button>
          {step === 'credentials' && (
            <button
              type="button"
              onClick={() => {
                handleTest()
                setStep('test')
              }}
              disabled={!credentialsValid}
              className="btn-dialog text-action disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Test connection
            </button>
          )}
          {step === 'test' && (
            <button
              type="button"
              onClick={() => setStep('summary')}
              disabled={!testResult?.success}
              className="btn-dialog text-action disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Continue
            </button>
          )}
          {step === 'summary' && (
            <button type="button" onClick={handleFinish} className="btn-dialog text-action">
              Done
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
