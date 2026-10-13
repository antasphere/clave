/**
 * The failures every domain may declare, shared so a client learns one
 * vocabulary. A domain's own failures (a `SessionNotFound`) live in that
 * domain's module; what is here is what any command of any domain can
 * answer, whatever the domain.
 */
import { Schema } from 'effect'

/**
 * The server this call reached cannot do what it was asked, by what it is
 * rather than by what it was given: a standalone server with no terminal
 * process cannot start a session; a server with no secret store cannot seal
 * a token. Declared on the command, so the client gets a 422 with a message
 * it can show, never a 500. `capability` names the missing part in the
 * domain's own words (`sessions`, `terminals`, `secrets`); `message` is the
 * sentence the reader sees.
 */
export class CapabilityUnavailable extends Schema.TaggedError<CapabilityUnavailable>()(
  'CapabilityUnavailable',
  {
    capability: Schema.NonEmptyString,
    message: Schema.NonEmptyString
  }
) {}
