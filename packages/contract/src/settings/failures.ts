/**
 * The two declared failures of the settings domains.
 *
 * `SettingsRefused` is a manager saying no to a command, with the sentence
 * meant for the person: a value that is not a token, a reserved profile id,
 * an unknown account, OS encryption unavailable. Every settings command
 * declares it (a 422 on the wire, thrown by the client as this tagged error
 * with the sentence as its message), so the Accounts form shows the reason
 * the way it did over IPC, never a generic server error.
 *
 * `CapabilityUnavailable` (shared, `../errors.ts`) is a command the server
 * that answered cannot carry. The server running inside the app carries
 * every settings command; the server running on its own (the standalone
 * entry under Bun) has no PTY for the two logins that run a provider's own
 * login command and no Dock for the app icon, and says so with this failure
 * (a 422 on the wire, thrown by the client as this tagged error) rather than
 * a 500 or a silent no-op. Wave 3's Node process beside the standalone
 * server is what takes the three on.
 */
import { Schema } from 'effect'
import { CapabilityUnavailable } from '../errors'

// The shared failure (`../errors.ts`, lane A's), re-exported so the settings
// module names everything a settings command can answer.
export { CapabilityUnavailable }

export class SettingsRefused extends Schema.TaggedError<SettingsRefused>()('SettingsRefused', {
  /** Why, in the words shown to the user. */
  message: Schema.String
}) {}

/** What a command the server may lack declares: refused here, or not carried here. */
export const RefusedOrUnavailable = Schema.Union(SettingsRefused, CapabilityUnavailable)
