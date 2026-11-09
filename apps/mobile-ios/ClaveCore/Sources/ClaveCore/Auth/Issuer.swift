import Foundation

// The issuer the phone signs in at: the hub, or a loopback provider named for
// a test. The rule is the Mac's (`resolveAntasphereIssuer`) and the
// prototype's: an override is a bare origin, https, or plain http to the
// literal 127.0.0.1 and nothing else, and a refused override does NOT fall
// back to the hub, so a build told to use a test provider never reaches
// production because the value had a typo. The scopes, the grants and the
// redirect are fixed here: the identity and the one scope that renews it,
// and the custom scheme the hub's consent page accepts (a non-empty host).

/// The hub's origin, used when no override is set.
public let defaultIssuer = "https://account.antasphere.com"
/// The scopes every authorization and registration names.
public let hubScope = "openid profile email offline_access"
/// The phone's registered redirect.
public let redirectURI = "clave-ios://oauth/callback"
/// The scheme the authentication session listens for.
public let callbackScheme = "clave-ios"
/// The name the phone registers itself under at the hub.
public let clientName = "Clave iOS"

/// A resolved issuer.
public struct IssuerConfig: Sendable, Equatable {
  /// The issuer's origin, no trailing slash: `https://account.antasphere.com`.
  public let origin: String
  /// Plain HTTP, allowed for the literal loopback test target and nothing else.
  public let insecure: Bool

  /// A resolved issuer; use `resolveIssuer` rather than building one by hand.
  public init(origin: String, insecure: Bool) {
    self.origin = origin
    self.insecure = insecure
  }
}

/// The outcome of reading an issuer override.
public enum IssuerResolution: Sendable, Equatable {
  case ok(IssuerConfig)
  case refused(reason: String)
}

/// The issuer an override names; empty or nil is the hub.
public func resolveIssuer(_ raw: String?) -> IssuerResolution {
  let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  if trimmed.isEmpty { return .ok(IssuerConfig(origin: defaultIssuer, insecure: false)) }
  guard let url = URLComponents(string: trimmed), let scheme = url.scheme?.lowercased() else {
    return .refused(reason: "not a URL")
  }
  // WHATWG URL refuses a special scheme without a host; URLComponents does not.
  if WebURL.specialSchemes.contains(scheme), (url.percentEncodedHost ?? "").isEmpty {
    return .refused(reason: "not a URL")
  }
  if !(url.user ?? "").isEmpty || !(url.password ?? "").isEmpty
    || !(url.percentEncodedQuery ?? "").isEmpty || !(url.percentEncodedFragment ?? "").isEmpty
    || !WebURL.isRootPath(url.percentEncodedPath, scheme: scheme)
  {
    return .refused(reason: "not a bare origin")
  }
  if scheme == "https", let origin = WebURL.origin(of: url) {
    return .ok(IssuerConfig(origin: origin, insecure: false))
  }
  if scheme == "http", url.percentEncodedHost == "127.0.0.1", let origin = WebURL.origin(of: url) {
    return .ok(IssuerConfig(origin: origin, insecure: true))
  }
  return .refused(reason: "plain http is only accepted for 127.0.0.1")
}

/// The few WHATWG URL behaviours the prototype leans on (`URL.origin`,
/// `URLSearchParams`), rebuilt over URLComponents so the phone compares and
/// serializes exactly as the prototype did.
enum WebURL {
  static let specialSchemes: Set<String> = ["http", "https", "ws", "wss", "ftp", "file"]

  /// A special scheme's empty path reads as "/" in WHATWG URL.
  static func isRootPath(_ path: String, scheme: String) -> Bool {
    path == "/" || (path.isEmpty && specialSchemes.contains(scheme))
  }

  /// `scheme://host[:port]`, the default port dropped, as `URL.origin` gives it.
  static func origin(of components: URLComponents) -> String? {
    guard let scheme = components.scheme?.lowercased(),
      let host = components.percentEncodedHost?.lowercased(), !host.isEmpty
    else { return nil }
    var origin = "\(scheme)://\(host)"
    if let port = components.port {
      let isDefault = (scheme == "https" && port == 443) || (scheme == "http" && port == 80)
      if !isDefault { origin += ":\(port)" }
    }
    return origin
  }

  static func origin(of string: String) -> String? {
    URLComponents(string: string).flatMap(origin(of:))
  }

  /// `application/x-www-form-urlencoded` as URLSearchParams serializes it.
  static func formEncode(_ pairs: [(String, String)]) -> String {
    pairs.map { formEscape($0.0) + "=" + formEscape($0.1) }.joined(separator: "&")
  }

  private static func formEscape(_ text: String) -> String {
    var out = ""
    for byte in text.utf8 {
      switch byte {
      case 0x20: out.append("+")
      case UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "A")...UInt8(ascii: "Z"),
        UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "*"), UInt8(ascii: "-"),
        UInt8(ascii: "."), UInt8(ascii: "_"):
        out.unicodeScalars.append(Unicode.Scalar(byte))
      default: out += String(format: "%%%02X", byte)
      }
    }
    return out
  }

  /// The pairs of a query as URLSearchParams parses it: `+` is a space.
  static func formDecode(_ query: String?) -> [(String, String)] {
    guard let query, !query.isEmpty else { return [] }
    return query.split(separator: "&", omittingEmptySubsequences: true).map { part in
      let piece = String(part)
      if let eq = piece.firstIndex(of: "=") {
        return (formUnescape(String(piece[..<eq])), formUnescape(String(piece[piece.index(after: eq)...])))
      }
      return (formUnescape(piece), "")
    }
  }

  private static func formUnescape(_ text: String) -> String {
    let bytes = Array(text.utf8)
    var out: [UInt8] = []
    var i = 0
    while i < bytes.count {
      let byte = bytes[i]
      if byte == UInt8(ascii: "+") {
        out.append(0x20)
      } else if byte == UInt8(ascii: "%"), i + 2 < bytes.count,
        let value = UInt8(String(decoding: bytes[(i + 1)...(i + 2)], as: UTF8.self), radix: 16)
      {
        out.append(value)
        i += 2
      } else {
        out.append(byte)
      }
      i += 1
    }
    return String(decoding: out, as: UTF8.self)
  }
}
