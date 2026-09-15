import { useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useLocationStore } from '../../store/location-store'
import {
  XMarkIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  ArrowPathIcon
} from '@heroicons/react/24/outline'

type Step = 'credentials' | 'test' | 'summary'

interface AddLocationDialogProps {
  onClose: () => void
}

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
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
          <h3 className="text-base font-semibold text-text-primary">Add Remote Location</h3>
          <button onClick={handleRemoveOnCancel} className="btn-icon btn-icon-sm">
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-2 px-6 py-3 bg-surface-100/50">
          {(['credentials', 'test', 'summary'] as Step[]).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium ${
                  step === s
                    ? 'bg-accent text-white'
                    : i < ['credentials', 'test', 'summary'].indexOf(step)
                      ? 'bg-success text-white'
                      : 'bg-surface-200 text-text-tertiary'
                }`}
              >
                {i + 1}
              </div>
              {i < 2 && <div className="w-8 h-px bg-border-subtle" />}
            </div>
          ))}
        </div>

        {/* Content */}
        <div className="px-6 py-5 space-y-4">
          {step === 'credentials' && (
            <>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Mac Mini"
                  className="input-field"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-text-secondary mb-1.5">
                    Host
                  </label>
                  <input
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="100.x.x.x or hostname"
                    className="input-field"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1.5">
                    Port
                  </label>
                  <input
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    className="input-field"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">
                  Username
                </label>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin"
                  className="input-field"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">
                  Auth Method
                </label>
                <div className="flex gap-2">
                  {(['key', 'password', 'agent'] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setAuthMethod(m)}
                      className={`flex-1 text-xs font-medium py-2 rounded-lg border transition-colors ${
                        authMethod === m
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-border-subtle bg-surface-100 text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      {m === 'key' ? 'SSH Key' : m === 'password' ? 'Password' : 'SSH Agent'}
                    </button>
                  ))}
                </div>
              </div>
              {authMethod === 'key' && (
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1.5">
                    Private Key Path
                  </label>
                  <input
                    value={privateKeyPath}
                    onChange={(e) => setPrivateKeyPath(e.target.value)}
                    className="input-field"
                  />
                </div>
              )}
              {authMethod === 'password' && (
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1.5">
                    Password
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="input-field"
                  />
                </div>
              )}
            </>
          )}

          {step === 'test' && (
            <div className="text-center py-4">
              {testing ? (
                <div className="flex flex-col items-center gap-3">
                  <ArrowPathIcon className="w-8 h-8 text-accent animate-spin" />
                  <p className="text-sm text-text-secondary">Testing connection...</p>
                </div>
              ) : testResult ? (
                <div className="flex flex-col items-center gap-3">
                  {testResult.success ? (
                    <>
                      <CheckCircleIcon className="w-10 h-10 text-green-500" />
                      <p className="text-sm font-medium text-text-primary">
                        Connection successful!
                      </p>
                      {testResult.openclawVersion ? (
                        <p className="text-xs text-text-secondary">
                          {testResult.openclawVersion} detected (port {testResult.openclawPort})
                        </p>
                      ) : (
                        <div className="space-y-2">
                          <p className="text-xs text-text-tertiary">OpenClaw not detected</p>
                          <button
                            onClick={handleInstallPlugin}
                            disabled={installing}
                            className="btn-primary"
                          >
                            {installing ? 'Installing...' : 'Install Clave Channel Plugin'}
                          </button>
                          {installError && (
                            <p className="text-xs text-destructive mt-1">{installError}</p>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <ExclamationCircleIcon className="w-10 h-10 text-destructive" />
                      <p className="text-sm font-medium text-text-primary">Connection failed</p>
                      <p className="text-xs text-text-tertiary">{testResult.error}</p>
                    </>
                  )}
                </div>
              ) : (
                <p className="text-sm text-text-secondary">Click below to test the connection</p>
              )}
            </div>
          )}

          {step === 'summary' && (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <CheckCircleIcon className="w-6 h-6 text-green-500 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-text-primary">{name || host}</p>
                  <p className="text-xs text-text-tertiary">
                    {username}@{host}:{port}
                  </p>
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoConnect}
                  onChange={(e) => setAutoConnect(e.target.checked)}
                  className="rounded border-border-subtle"
                />
                <span className="text-sm text-text-secondary">Auto-connect on app launch</span>
              </label>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border-subtle bg-surface-100/30">
          <button
            onClick={
              step === 'credentials'
                ? handleRemoveOnCancel
                : () => setStep(step === 'test' ? 'credentials' : 'test')
            }
            className="text-sm text-text-secondary hover:text-text-primary transition-colors"
          >
            {step === 'credentials' ? 'Cancel' : 'Back'}
          </button>
          {step === 'credentials' && (
            <button
              onClick={() => {
                handleTest()
                setStep('test')
              }}
              disabled={!credentialsValid}
              className="btn-primary h-auto py-2 px-4 text-sm"
            >
              Test Connection
            </button>
          )}
          {step === 'test' && (
            <button
              onClick={() => setStep('summary')}
              disabled={!testResult?.success}
              className="btn-primary h-auto py-2 px-4 text-sm"
            >
              Continue
            </button>
          )}
          {step === 'summary' && (
            <button onClick={handleFinish} className="btn-primary h-auto py-2 px-4 text-sm">
              Done
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
