import Foundation

// The ID token's claims, read on the phone: the decode and the shape checks,
// nothing more. The phone does NOT verify the signature. The token comes
// straight from the hub's token endpoint over TLS, in answer to a code only
// this app holds the verifier for, and the server verifies the signature
// against the hub's keys when the phone presents the token to pair. What the
// phone checks is that the token it was handed is the one it asked for:
// three base64url segments, a JOSE header naming RS256 or ES256, this
// issuer, this client as the audience, a lifetime that has not passed, and
// the nonce the phone minted. A token failing any check is refused by the
// name of the check, never with the token in the message; the names are the
// words the server's refusal uses, so a log reads the same on both sides.

/// The claims the phone reads from an ID token.
public struct IdTokenClaims: Sendable, Equatable {
  public let iss: String
  public let sub: String
  public let aud: [String]
  /// Seconds since the epoch.
  public let exp: TimeInterval
  /// Seconds since the epoch.
  public let iat: TimeInterval
  public let nonce: String?
  public let azp: String?
  public let name: String?
  public let email: String?
  public let emailVerified: Bool?

  /// Claims as read; built by `decodeIdToken`, or by hand in a test.
  public init(
    iss: String, sub: String, aud: [String], exp: TimeInterval, iat: TimeInterval,
    nonce: String? = nil, azp: String? = nil, name: String? = nil, email: String? = nil,
    emailVerified: Bool? = nil
  ) {
    self.iss = iss
    self.sub = sub
    self.aud = aud
    self.exp = exp
    self.iat = iat
    self.nonce = nonce
    self.azp = azp
    self.name = name
    self.email = email
    self.emailVerified = emailVerified
  }
}

/// The check an ID token failed, named as the server names it.
public enum IdTokenRefusal: String, Sendable, Equatable {
  case format
  case algorithm
  case issuer
  case audience
  case authorizedParty = "authorized-party"
  case expired
  case notYetValid = "not-yet-valid"
  case nonce
  case subject
}

/// An ID token refused by one named check.
public struct IdTokenRefused: Error, Equatable, CustomStringConvertible {
  public let check: IdTokenRefusal
  public var description: String { "The ID token was refused by the \(check.rawValue) check." }
}

/// What the phone asked for, against which a token's claims are checked.
public struct ExpectedIdToken: Sendable {
  public let issuer: String
  public let clientId: String
  /// The nonce the request carried; a token from a refresh carries none.
  public let nonce: String?
  public let now: Date
  /// The clock skew the lifetime checks tolerate, the server's own figure.
  public let skew: TimeInterval

  /// The expectation for one token.
  public init(issuer: String, clientId: String, nonce: String? = nil, now: Date, skew: TimeInterval = 60) {
    self.issuer = issuer
    self.clientId = clientId
    self.nonce = nonce
    self.now = now
    self.skew = skew
  }
}

private func refuse(_ check: IdTokenRefusal) -> IdTokenRefused { IdTokenRefused(check: check) }

private func segmentJSON(_ segment: Substring) throws -> [String: JSONValue] {
  guard !segment.isEmpty,
    let bytes = try? Base64URL.decode(String(segment)),
    let text = String(data: bytes, encoding: .utf8),
    case .object(let members)? = JSONValue.parse(text)
  else { throw refuse(.format) }
  return members
}

private func optionalString(_ value: JSONValue?) throws -> String? {
  guard let value else { return nil }
  guard let text = value.stringValue else { throw refuse(.format) }
  return text
}

/// The claims of a compact JWS, by shape alone; throws `IdTokenRefused`.
public func decodeIdToken(_ token: String) throws -> IdTokenClaims {
  let parts = token.split(separator: ".", omittingEmptySubsequences: false)
  guard parts.count == 3 else { throw refuse(.format) }
  guard !parts[2].isEmpty, (try? Base64URL.decode(String(parts[2]))) != nil else { throw refuse(.format) }
  let header = try segmentJSON(parts[0])
  if let typ = header["typ"], typ.stringValue != "JWT" { throw refuse(.format) }
  // RS256 is the hub's; ES256 is accepted for a provider keyed on P-256.
  // Anything else, `none` above all, is refused before the payload is read.
  guard let alg = header["alg"]?.stringValue, alg == "RS256" || alg == "ES256" else { throw refuse(.algorithm) }
  let payload = try segmentJSON(parts[1])
  guard let iss = payload["iss"]?.stringValue, !iss.isEmpty else { throw refuse(.format) }
  guard let sub = payload["sub"]?.stringValue, !sub.isEmpty else { throw refuse(.subject) }
  let aud: [String]
  switch payload["aud"] {
  case .string(let one)?: aud = [one]
  case .array(let items)?:
    let strings = items.compactMap(\.stringValue)
    guard strings.count == items.count else { throw refuse(.format) }
    aud = strings
  default: throw refuse(.format)
  }
  if aud.isEmpty { throw refuse(.format) }
  guard let exp = payload["exp"]?.numberValue, exp.isFinite else { throw refuse(.format) }
  guard let iat = payload["iat"]?.numberValue, iat.isFinite else { throw refuse(.format) }
  var emailVerified: Bool?
  if let value = payload["email_verified"] {
    guard let flag = value.boolValue else { throw refuse(.format) }
    emailVerified = flag
  }
  return IdTokenClaims(
    iss: iss, sub: sub, aud: aud, exp: exp, iat: iat,
    nonce: try optionalString(payload["nonce"]),
    azp: try optionalString(payload["azp"]),
    name: try optionalString(payload["name"]),
    email: try optionalString(payload["email"]),
    emailVerified: emailVerified
  )
}

/// The claims against what the phone asked for; throws `IdTokenRefused`.
public func checkIdToken(_ claims: IdTokenClaims, expected: ExpectedIdToken) throws {
  let now = expected.now.timeIntervalSince1970
  if claims.iss != expected.issuer { throw refuse(.issuer) }
  if !claims.aud.contains(expected.clientId) { throw refuse(.audience) }
  if let azp = claims.azp, azp != expected.clientId { throw refuse(.authorizedParty) }
  if claims.exp + expected.skew <= now { throw refuse(.expired) }
  if claims.iat - expected.skew > now { throw refuse(.notYetValid) }
  if let nonce = expected.nonce, claims.nonce != nonce { throw refuse(.nonce) }
}
