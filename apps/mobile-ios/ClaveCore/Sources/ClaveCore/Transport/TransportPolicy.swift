import Foundation

// Where a credential may travel (decision 4 of the spec, the rule of 29
// October 2026): the relay over HTTPS is the road, and a direct address is
// used only over https with a certificate the platform validates. A release
// build never sends a device session, or any credential, to a plain-HTTP
// address: out in town, a private address on a public network can name
// someone else's machine. Plain HTTP to the loopback stays in the developer
// connection of development builds, where a standalone server on this very
// machine is the point.

/// Which build this is: decides the addresses a credential may go to.
public enum BuildKind: String, Sendable, Equatable, CaseIterable {
  case development, release
}

/// Whether a credential may be sent to an address, and why not when it may not.
public enum TransportVerdict: Sendable, Equatable {
  case allowed
  case refused(reason: String)

  /// True when the credential may travel.
  public var isAllowed: Bool { self == .allowed }
}

/// An address this build sends no credential to, refused before any request.
public struct TransportPolicyError: Error, Sendable, Equatable, CustomStringConvertible {
  public let message: String
  public let url: String

  public init(message: String, url: String) {
    self.message = message
    self.url = url
  }

  public var description: String { message }
}

private let loopbackHosts: Set<String> = ["127.0.0.1", "localhost", "[::1]", "::1"]

/// True for the loopback names a development build may reach over plain http.
public func isLoopbackHost(_ hostname: String) -> Bool {
  loopbackHosts.contains(hostname.lowercased())
}

/// Whether a credential may be sent to `url` (http(s) or ws(s)) in this build.
public func credentialMayTravelTo(_ url: String, build: BuildKind) -> TransportVerdict {
  guard let components = URLComponents(string: url), let scheme = components.scheme?.lowercased(),
    let host = components.percentEncodedHost, !host.isEmpty
  else {
    return .refused(reason: "\"\(url)\" is not an address.")
  }
  if scheme == "https" || scheme == "wss" { return .allowed }
  if scheme == "http" || scheme == "ws" {
    if build == .development && isLoopbackHost(host) { return .allowed }
    let shown = components.port.map { "\(host):\($0)" } ?? host
    return .refused(
      reason: build == .development
        ? "Plain \(scheme) is allowed to 127.0.0.1 only in a development build; use https for \(shown)."
        : "A credential never travels over plain \(scheme) (\(shown)); only https is used.")
  }
  return .refused(reason: "\"\(scheme):\" is not a scheme a credential travels over.")
}

/// The same verdict as a thrown `TransportPolicyError`, for an initializer.
public func assertCredentialMayTravelTo(_ url: String, build: BuildKind) throws {
  if case .refused(let reason) = credentialMayTravelTo(url, build: build) {
    throw TransportPolicyError(message: reason, url: url)
  }
}
