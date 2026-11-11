import Foundation

/// What a call to a Clave server (or to the relay) can fail with, as the
/// screens and the send table read it. One vocabulary for every route:
///
/// - `network`: no answer came (the machine unreachable, the socket reset).
/// - `timeout`: the deadline passed before an answer.
/// - `protocol`: an answer that is not the contract's (a 5xx, an unreadable
///   body, an unexpected status).
/// - `unauthenticated`: 401, the credential is not accepted any more (a
///   device session revoked, a hub token refused).
/// - `forbidden`: 403, the device session's scope refuses this route ("A phone
///   may not do this."); surfaced to the person as the server said it and
///   NEVER retried with another credential.
/// - `notFound`: 404, the route does not exist on this server (an older
///   server without it).
/// - `refused`: 422, a failure the server declared, carried in `failure`.
public struct ServerError: Error, Sendable, Equatable, CustomStringConvertible {
  public enum Kind: String, Sendable, Equatable {
    case network, timeout, `protocol`, unauthenticated, forbidden, notFound, refused
  }

  public let kind: Kind
  public let message: String
  public let status: Int?
  public let failure: ServerFailure?

  public init(_ kind: Kind, _ message: String, status: Int? = nil, failure: ServerFailure? = nil) {
    self.kind = kind
    self.message = message
    self.status = status
    self.failure = failure
  }

  public var description: String { message }

  /// The write's outcome was not seen: nobody can say whether it landed.
  public var outcomeLost: Bool {
    kind == .network || kind == .timeout || kind == .protocol
  }
}
