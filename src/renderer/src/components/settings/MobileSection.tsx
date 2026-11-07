import { useEffect, useState, type ReactElement } from 'react'
import type { DevicePlatform } from '../../../../shared/mobile-types'
import { loadMobile, useMobileStore } from '../../store/mobile-store'
import {
  loadAntasphereAccount,
  useAntasphereAccountStore
} from '../../store/antasphere-account-store'
import { useSessionStore } from '../../store/session-store'
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsCallout
} from './primitives'

const PLATFORM_LABEL: Record<DevicePlatform, string> = { ios: 'iPhone', android: 'Android' }

function platformLabel(platform: DevicePlatform): string {
  return PLATFORM_LABEL[platform] ?? platform
}

/** A time of day, hours and minutes. */
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** When a phone last reached this Mac: the time today, the date before today. */
function lastSeen(ms: number | null): string {
  if (ms === null) return 'never seen'
  const seen = new Date(ms)
  const today = seen.toDateString() === new Date().toDateString()
  return `last seen ${today ? clock(ms) : seen.toLocaleDateString()}`
}

/** Whose phones these are: the Antasphere account this Clave is signed in with. */
function OwnerSection(): ReactElement {
  const status = useAntasphereAccountStore((s) => s.status)
  const phase = status?.phase ?? 'signed-out'
  const who = status?.account?.name || status?.account?.email || null
  return (
    <SettingsSection title="Your Antasphere account">
      <SettingsCard data-mobile-owner data-mobile-owner-phase={phase}>
        {phase === 'signed-in' ? (
          <SettingsRow
            label={
              <span className="flex items-center gap-2 min-w-0">
                <span className="truncate">{who ? `Signed in as ${who}` : 'Signed in'}</span>
                <span className="badge badge-muted flex-shrink-0">Signed in</span>
              </span>
            }
            description="A phone signed in with the same account can ask to pair with this Mac."
          />
        ) : (
          <SettingsRow
            label="Not signed in"
            description="Sign in with your Antasphere account first: a phone proves it is yours with the same account."
          >
            <button
              onClick={() => useSessionStore.getState().setSettingsSection('accounts')}
              className="btn-secondary"
              data-mobile-open-accounts
            >
              Open Accounts
            </button>
          </SettingsRow>
        )}
      </SettingsCard>
    </SettingsSection>
  )
}

function PendingSection(): ReactElement {
  const pending = useMobileStore((s) => s.pending)
  const inFlight = useMobileStore((s) => s.inFlight)
  const approve = useMobileStore((s) => s.approve)
  const refuse = useMobileStore((s) => s.refuse)
  return (
    <SettingsSection
      title="Phones asking to pair"
      description="A phone that signed in with your account and asked for this Mac. Nothing is issued until you approve it."
    >
      <SettingsCard data-mobile-pending>
        {pending.length === 0 ? (
          <div className="settings-row" data-mobile-pending-empty>
            <p className="settings-row-description">No phone is asking right now.</p>
          </div>
        ) : (
          pending.map((pairing) => (
            <div className="settings-row" key={pairing.id} data-mobile-pending-row={pairing.id}>
              <div className="min-w-0">
                <p className="settings-row-title">{pairing.name}</p>
                <p className="settings-row-description">
                  {platformLabel(pairing.platform)} · Clave {pairing.appVersion} · asked at{' '}
                  {clock(pairing.requestedAt)}, waits until {clock(pairing.expiresAt)}
                </p>
              </div>
              <div className="settings-row-controls">
                <button
                  onClick={() => void refuse(pairing.id)}
                  disabled={inFlight[`refuse:${pairing.id}`]}
                  className="btn-secondary"
                  data-mobile-refuse
                >
                  Refuse
                </button>
                <button
                  onClick={() => void approve(pairing.id)}
                  disabled={inFlight[`approve:${pairing.id}`]}
                  className="btn-primary"
                  data-mobile-approve
                >
                  Approve
                </button>
              </div>
            </div>
          ))
        )}
      </SettingsCard>
    </SettingsSection>
  )
}

function DevicesSection(): ReactElement {
  const devices = useMobileStore((s) => s.devices)
  const inFlight = useMobileStore((s) => s.inFlight)
  const revoke = useMobileStore((s) => s.revoke)
  return (
    <SettingsSection
      title="Paired phones"
      description="The phones that reach this Mac. Revoke one that is lost or that you no longer use: its next call is refused and it is signed out of this Mac at once."
    >
      <SettingsCard data-mobile-devices>
        {devices.length === 0 ? (
          <div className="settings-row" data-mobile-devices-empty>
            <p className="settings-row-description">No phone yet.</p>
          </div>
        ) : (
          devices.map((device) => (
            <div className="settings-row" key={device.id} data-mobile-device-row={device.id}>
              <div className="min-w-0">
                <p className="settings-row-title">{device.name}</p>
                <p className="settings-row-description">
                  {platformLabel(device.platform)} · Clave {device.appVersion} ·{' '}
                  {lastSeen(device.lastSeenAt)}
                </p>
              </div>
              <div className="settings-row-controls">
                <button
                  onClick={() => void revoke(device.id)}
                  disabled={inFlight[`revoke:${device.id}`]}
                  className="btn-secondary"
                  data-mobile-revoke
                >
                  Revoke
                </button>
              </div>
            </div>
          ))
        )}
      </SettingsCard>
    </SettingsSection>
  )
}

function RelaySection(): ReactElement {
  const relayUrl = useMobileStore((s) => s.relayUrl)
  const relayError = useMobileStore((s) => s.relayError)
  const saving = useMobileStore((s) => s.inFlight.relay === true)
  const saveRelay = useMobileStore((s) => s.saveRelay)
  // The draft starts over from the stored address whenever that changes (a
  // load, a save, another window's save), adjusted while rendering: React's
  // own pattern for state that follows a value from outside. A draft the
  // owner edited since the last seed is theirs and is not overwritten.
  const [draft, setDraft] = useState(relayUrl)
  const [seeded, setSeeded] = useState(relayUrl)
  if (seeded !== relayUrl) {
    setSeeded(relayUrl)
    if (draft === seeded) setDraft(relayUrl)
  }

  const save = async (): Promise<void> => {
    const sent = draft
    await saveRelay(sent)
    // A save the server normalises to the address it already held leaves the
    // store as it was: the field shows what is stored all the same, unless
    // the owner typed on while the save was out.
    const { relayUrl: stored, relayError: refused } = useMobileStore.getState()
    if (refused === null) setDraft((current) => (current === sent ? stored : current))
  }

  return (
    <SettingsSection
      title="Relay address"
      description="Where your phone reaches this Mac from outside your home network: the team's relay, as an address such as https://relay.example.com. Leave it empty to use none."
    >
      <SettingsCard data-mobile-relay>
        <div className="settings-row">
          <div className="min-w-0 flex-1">
            <label className="field-label">
              Relay address
              <input
                className="input-field w-full"
                aria-label="Relay address"
                placeholder="https://relay.antasphere.com"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                data-mobile-relay-input
              />
            </label>
            <div className="flex justify-end">
              <button
                onClick={() => void save()}
                disabled={draft === relayUrl || saving}
                className="btn-primary"
                data-mobile-relay-save
              >
                Save
              </button>
            </div>
          </div>
        </div>
      </SettingsCard>
      {relayError && (
        <div data-mobile-relay-error>
          <SettingsCallout tone="danger" role="alert" text={relayError} />
        </div>
      )}
    </SettingsSection>
  )
}

/**
 * Settings → Mobile (mobile wave, lane A): the phones paired with this Mac
 * as its owner's. Who the owner is (the Antasphere account a phone must sign
 * in with too), the phones asking to pair with their Approve and Refuse, the
 * paired phones with their Revoke, and the relay address a phone uses from
 * outside the home network. Each button is disabled by its own ask alone; a
 * call that does not complete says so under the sections, with a Retry.
 */
export function MobileSection(): ReactElement {
  const transportFailed = useMobileStore((s) => s.transportFailed)
  const failureText = useMobileStore((s) => s.failureText)
  const listing = useMobileStore((s) => s.inFlight.list === true)

  useEffect(() => {
    void loadMobile()
    void loadAntasphereAccount()
  }, [])

  return (
    <SettingsPage
      title="Mobile"
      testId="mobile"
      description="Your phone, paired with this Mac through your Antasphere account: it follows your sessions, answers your agents and starts work from your saved profiles. Approve a phone here when it asks; revoke it here when it is lost."
    >
      <OwnerSection />
      <PendingSection />
      <DevicesSection />
      <RelaySection />
      {transportFailed && (
        <div data-mobile-transport-failed>
          <SettingsCallout
            tone="danger"
            role="alert"
            title="Clave could not complete that"
            text={failureText ?? 'The request did not reach the server. Try again.'}
            actions={
              <button
                onClick={() => void loadMobile()}
                disabled={listing}
                className="btn-secondary"
                data-mobile-retry
              >
                Retry
              </button>
            }
          />
        </div>
      )}
    </SettingsPage>
  )
}
