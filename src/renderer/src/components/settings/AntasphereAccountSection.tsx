import { useEffect, type ReactElement } from 'react'
import { ArrowRightStartOnRectangleIcon } from '@heroicons/react/24/outline'
import {
  useAntasphereAccountStore,
  loadAntasphereAccount,
  describeAntasphereFailure
} from '../../store/antasphere-account-store'
import { SettingsSection, SettingsCard, SettingsRow, SettingsCallout } from './primitives'

/**
 * Settings → Accounts, the first section: the Antasphere account this Clave
 * is signed in with (PRDCT-3259). Signed out, one button that opens the
 * browser at the hub; signing in, a line and a way to cancel or to open the
 * page again; signed in, who, and a sign-out that is local to Clave.
 * Optional throughout: nothing in the app waits on it. The words stay
 * plain: how the login works is for docs/antasphere-account.md, not here.
 *
 * Each button is disabled by its own ask alone: a sign-in waits on the
 * issuer for as long as discovery and the page take, and Cancel must stay
 * live the whole time (the store drops the sign-in's answer if it lands
 * after the cancel).
 */
export function AntasphereAccountSection(): ReactElement {
  const status = useAntasphereAccountStore((s) => s.status)
  const loaded = useAntasphereAccountStore((s) => s.loaded)
  const inFlight = useAntasphereAccountStore((s) => s.inFlight)
  const transportFailed = useAntasphereAccountStore((s) => s.transportFailed)
  const signIn = useAntasphereAccountStore((s) => s.signIn)
  const cancel = useAntasphereAccountStore((s) => s.cancel)
  const signOut = useAntasphereAccountStore((s) => s.signOut)
  const dismissFailure = useAntasphereAccountStore((s) => s.dismissFailure)

  useEffect(() => {
    void loadAntasphereAccount()
  }, [])

  const host = status?.issuerHost || 'account.antasphere.com'
  const phase = status?.phase ?? 'signed-out'
  const canSignIn =
    status !== null && status.secureStorage && status.lastFailure !== 'configuration'

  return (
    <SettingsSection
      title="Antasphere account"
      description="Sign in to Clave with your Antasphere account."
    >
      <SettingsCard data-antasphere-account data-antasphere-phase={phase}>
        {phase === 'signed-in' && status?.account && (
          <SettingsRow
            label={
              <span className="flex items-center gap-2 min-w-0">
                <span className="truncate" data-antasphere-name>
                  {status.account.name ?? status.account.email ?? 'Signed in'}
                </span>
                <span className="badge badge-muted flex-shrink-0">Signed in</span>
              </span>
            }
            description={
              <span data-antasphere-email>
                {status.account.email
                  ? `${status.account.email}${status.account.emailVerified ? '' : ' (unverified)'} · ${host}`
                  : host}
              </span>
            }
          >
            <button
              onClick={() => void signOut()}
              disabled={inFlight['sign-out']}
              className="btn-secondary"
              data-antasphere-sign-out
            >
              <ArrowRightStartOnRectangleIcon className="w-3.5 h-3.5" />
              Sign out
            </button>
          </SettingsRow>
        )}

        {phase === 'signing-in' && (
          <div data-antasphere-login>
            <SettingsCallout
              inset
              tone="accent"
              title="Signing in"
              text={`Finish signing in in your browser at ${host}, then return to Clave.`}
              actions={
                <>
                  <button
                    onClick={() => void cancel()}
                    disabled={inFlight.cancel}
                    className="btn-secondary"
                    data-antasphere-cancel
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => void signIn()}
                    disabled={inFlight['sign-in']}
                    className="btn-secondary"
                    data-antasphere-reopen
                  >
                    Open the page again
                  </button>
                </>
              }
            />
          </div>
        )}

        {phase === 'signed-out' && (
          <SettingsRow
            label="Not signed in"
            description={
              !loaded
                ? 'Reading…'
                : status === null
                  ? 'The account could not be read.'
                  : !status.secureStorage
                    ? 'Clave cannot securely save your sign-in on this device.'
                    : `Opens ${host} in your browser.`
            }
          >
            <button
              onClick={() => void signIn()}
              disabled={inFlight['sign-in'] || !canSignIn}
              className="btn-primary"
              data-antasphere-sign-in
            >
              Sign in with Antasphere
            </button>
          </SettingsRow>
        )}

        {phase === 'signed-out' && status?.lastFailure && (
          <div data-antasphere-failure={status.lastFailure}>
            <SettingsCallout
              inset
              tone={status.lastFailure === 'cancelled' ? 'accent' : 'danger'}
              role="status"
              title={status.lastFailure === 'cancelled' ? 'Sign-in cancelled' : 'Could not sign in'}
              text={describeAntasphereFailure(status.lastFailure)}
              actions={
                status.lastFailure !== 'configuration' ? (
                  <button
                    onClick={() => void dismissFailure()}
                    disabled={inFlight.dismiss}
                    className="btn-secondary"
                    data-antasphere-dismiss
                  >
                    Dismiss
                  </button>
                ) : undefined
              }
            />
          </div>
        )}

        {transportFailed && (
          <div data-antasphere-transport-failed>
            <SettingsCallout
              inset
              tone="danger"
              role="alert"
              title="Clave could not complete that"
              text="The request did not reach the app. Try again."
              actions={
                <button
                  onClick={() => void loadAntasphereAccount()}
                  disabled={inFlight.get}
                  className="btn-secondary"
                  data-antasphere-retry
                >
                  Retry
                </button>
              }
            />
          </div>
        )}
      </SettingsCard>
    </SettingsSection>
  )
}
