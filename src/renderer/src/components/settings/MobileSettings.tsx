import { useCallback, useEffect, useRef, useState } from 'react'
import type { MobileRelayStatus } from '../../../../shared/mobile-relay-types'
import { RELAY_STATE_LABELS, relayStateSentence, relayStateTone } from '../../lib/mobile-relay'
import { SettingsCard, SettingsPage, SettingsRow, SettingsSection } from './primitives'

/** How often the open page asks the server where its relay client stands. */
const STATUS_POLL_MS = 2_000

/** The server's refusal as a sentence: a tagged error keeps its message across the bridge. */
const messageOf = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']+': /, '').replace(/^\w+Error: /, '')
}

/**
 * Settings → Mobile (issue #407): the relay this Mac's server reaches a phone
 * through, from any network. The owner sets or clears the address (kept in
 * the server's `mobileRelayUrl` preference, empty by default) and sees where
 * the relay client stands, asked of the server every two seconds while the
 * page is open: off, signed out, claiming, connecting, connected, waiting or
 * refused, with the client's last error. Pairing a phone is not on this page.
 */
export function MobileSettings(): React.JSX.Element {
  const [saved, setSaved] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [status, setStatus] = useState<MobileRelayStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const edited = useRef(false)

  const readStatus = useCallback(async () => {
    try {
      setStatus(await window.electronAPI.mobileRelayStatus())
      setStatusError(null)
    } catch (error) {
      setStatusError(messageOf(error))
    }
  }, [])

  useEffect(() => {
    let live = true
    void window.electronAPI
      .mobileRelayRead()
      .then((url) => {
        if (!live) return
        setSaved(url)
        if (!edited.current) setDraft(url)
      })
      .catch((error: unknown) => {
        if (live) setStatusError(messageOf(error))
      })
    void readStatus()
    const timer = setInterval(() => void readStatus(), STATUS_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [readStatus])

  const save = async (url: string): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    try {
      const kept = await window.electronAPI.mobileRelaySet(url)
      setSaved(kept)
      setDraft(kept)
      edited.current = false
      void readStatus()
    } catch (error) {
      setSaveError(messageOf(error))
    } finally {
      setSaving(false)
    }
  }

  const trimmed = draft.trim()
  const dirty = saved !== null && trimmed !== saved
  const state = status?.state ?? null

  return (
    <SettingsPage
      title="Mobile"
      description="How your phones reach this Mac when they are not on its private network."
      testId="mobile"
    >
      <SettingsSection
        title="Relay"
        description="This Mac keeps one connection to the relay, signed in as you, and your phones reach it through the relay from any network. Leave it empty to keep phones on this Mac's private address only."
      >
        <SettingsCard data-mobile-relay>
          <SettingsRow
            label="Relay address"
            description={
              <span>
                An https address, such as https://relay.antasphere.com.
                {saveError && (
                  <span
                    className="status-text block break-words"
                    data-status="error"
                    data-mobile-relay-save-error
                  >
                    {saveError}
                  </span>
                )}
              </span>
            }
          >
            <input
              className="input-field w-72"
              type="url"
              spellCheck={false}
              placeholder="https://relay.example.com"
              value={draft}
              disabled={saved === null}
              onChange={(event) => {
                edited.current = true
                setDraft(event.target.value)
                setSaveError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && dirty && !saving) void save(trimmed)
              }}
              aria-label="Relay address"
              data-mobile-relay-input
            />
            <button
              className="btn-primary"
              disabled={!dirty || saving}
              onClick={() => void save(trimmed)}
              data-mobile-relay-save
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            {saved ? (
              <button
                className="btn-secondary"
                disabled={saving}
                onClick={() => void save('')}
                data-mobile-relay-clear
              >
                Clear
              </button>
            ) : null}
          </SettingsRow>
          <SettingsRow
            label="Connection"
            description={
              <span data-mobile-relay-state={state ?? 'unknown'}>
                {status
                  ? relayStateSentence(status, saved ?? '')
                  : statusError
                    ? 'Clave could not ask this Mac’s server where the relay stands.'
                    : 'Asking this Mac’s server…'}
                {status?.lastFailure && state !== 'connected' && (
                  <span
                    className="status-text block break-words"
                    data-status="error"
                    data-mobile-relay-failure
                  >
                    Last error: {status.lastFailure}
                  </span>
                )}
                {statusError && (
                  <span className="status-text block break-words" data-status="error">
                    {statusError}
                  </span>
                )}
              </span>
            }
          >
            {state && (
              <span className="status-text" data-status={relayStateTone(state)}>
                {RELAY_STATE_LABELS[state]}
              </span>
            )}
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </SettingsPage>
  )
}
