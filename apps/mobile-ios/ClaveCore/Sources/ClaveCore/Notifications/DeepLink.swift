import Foundation

/// The app's own URL scheme, the target of a notification's tap.
public let deepLinkScheme = "clave-ios"

/// A place in the app a URL names: a conversation, or a pending request,
/// each on one machine. `clave-ios://chat/<machineId>/<sessionId>` and
/// `clave-ios://requests/<machineId>/<requestId>`, the ids percent-encoded.
public enum DeepLink: Sendable, Equatable, Hashable {
  case chat(machineId: String, sessionId: String)
  case request(machineId: String, requestId: String)

  // Everything but the unreserved characters is encoded, so an id holding
  // a slash, a colon or a space stays one path segment.
  private static let segmentAllowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

  private static func encode(_ segment: String) -> String {
    segment.addingPercentEncoding(withAllowedCharacters: segmentAllowed) ?? segment
  }

  /// The URL of this place.
  public var url: URL {
    let (host, machineId, id): (String, String, String)
    switch self {
    case .chat(let machine, let session): (host, machineId, id) = ("chat", machine, session)
    case .request(let machine, let request): (host, machineId, id) = ("requests", machine, request)
    }
    return URL(string: "\(deepLinkScheme)://\(host)/\(Self.encode(machineId))/\(Self.encode(id))")!
  }

  /// The place a URL names, nil when it is not one of the app's.
  public static func parse(_ url: URL) -> DeepLink? {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      components.scheme?.lowercased() == deepLinkScheme, let host = components.host
    else { return nil }
    let segments = components.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
    guard segments.count == 2 else { return nil }
    let decoded = segments.compactMap { String($0).removingPercentEncoding }
    guard decoded.count == 2, !decoded[0].isEmpty, !decoded[1].isEmpty else { return nil }
    switch host {
    case "chat": return .chat(machineId: decoded[0], sessionId: decoded[1])
    case "requests": return .request(machineId: decoded[0], requestId: decoded[1])
    default: return nil
    }
  }
}
