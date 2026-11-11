import Foundation

/// A server reached by the address and the token a developer pasted, kept so
/// a development build can work against a local standalone server.
public struct DeveloperMachineRecord: Sendable, Equatable, Codable {
  public let id: String
  public let name: String
  public let serverUrl: String
  /// Epoch milliseconds.
  public let addedAt: Double

  public init(id: String, name: String, serverUrl: String, addedAt: Double) {
    self.id = id
    self.name = name
    self.serverUrl = serverUrl
    self.addedAt = addedAt
  }
}

/// Why a pasted address cannot be a developer machine.
public struct DeveloperConnectionError: Error, Sendable, Equatable, CustomStringConvertible {
  public let message: String

  public init(_ message: String) {
    self.message = message
  }

  public var description: String { message }
}

/// `http://127.0.0.1:43201/` and `127.0.0.1:43201` both become `http://127.0.0.1:43201`.
public func normalizeServerURL(_ input: String) throws -> String {
  let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
  let hasScheme = trimmed.range(of: "^[A-Za-z]+://", options: .regularExpression) != nil
  let withScheme = hasScheme ? trimmed : "http://\(trimmed)"
  guard let components = URLComponents(string: withScheme), let scheme = components.scheme?.lowercased(),
    let host = components.percentEncodedHost, !host.isEmpty
  else {
    throw DeveloperConnectionError("\"\(input)\" is not an address.")
  }
  guard scheme == "http" || scheme == "https" else {
    throw DeveloperConnectionError("The address must start with http:// or https://")
  }
  var path = components.percentEncodedPath
  while path.hasSuffix("/") { path.removeLast() }
  let port = components.port.map { ":\($0)" } ?? ""
  return "\(scheme)://\(host.lowercased())\(port)\(path)"
}

/// `dev:<host>:<port>`, a stable id per address, safe as a store key.
public func developerMachineId(_ serverURL: String) -> String {
  let components = URLComponents(string: serverURL)
  let host = components?.percentEncodedHost ?? serverURL
  let hostPort = components?.port.map { "\(host):\($0)" } ?? host
  let safe = hostPort.unicodeScalars.map { scalar -> String in
    let allowed = CharacterSet.alphanumerics.contains(scalar) && scalar.isASCII || ".:-".unicodeScalars.contains(scalar)
    return allowed ? String(scalar) : "-"
  }.joined()
  return "dev:\(safe)"
}

/// The developer's machines, for a development build only (the app shows the
/// screen under DEBUG): the list in the key-value store, each token in the
/// credential store under the machine's id. The transport policy applies with
/// the build the source is given: a development build may reach the loopback
/// over plain http, a release build never sends the token over plain http.
public struct DeveloperMachineSource: MachineSource {
  /// The key-value key of the list.
  public static let listKey = "clave.developer-machines"

  private let store: any KeyValueStore
  private let credentials: any CredentialStore
  private let build: BuildKind
  private let now: @Sendable () -> Double

  /// A source over `store` (the list) and `credentials` (the tokens), for `build`: the build
  /// decides where a token may travel, so it has no default.
  public init(store: any KeyValueStore, credentials: any CredentialStore, build: BuildKind, now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
    self.store = store
    self.credentials = credentials
    self.build = build
    self.now = now
  }

  /// The kept records; a damaged list reads as none.
  public func records() async throws -> [DeveloperMachineRecord] {
    guard let raw = try await store.get(Self.listKey) else { return [] }
    return (try? JSONDecoder().decode([DeveloperMachineRecord].self, from: Data(raw.utf8))) ?? []
  }

  public func list() async throws -> [Machine] {
    try await records().map(Self.machine)
  }

  /// Adds a server: the token is tried once against `GET /launch-profiles`
  /// (a 401 is the server refusing it), then kept under the machine's id.
  public func add(serverURL: String, token: String, name: String = "Developer machine", transport: any HTTPTransport) async throws -> Machine {
    let normalized = try normalizeServerURL(serverURL)
    let client = try ClaveServerClient(baseURL: normalized, bearer: { token }, transport: transport, build: build)
    _ = try await client.launchProfiles.list()
    let id = developerMachineId(normalized)
    var kept = try await records().filter { $0.id != id }
    let record = DeveloperMachineRecord(id: id, name: name, serverUrl: normalized, addedAt: now())
    kept.append(record)
    try await save(kept)
    try await credentials.set(id, Credential(serverUrl: normalized, bearer: token))
    return Self.machine(record)
  }

  /// Forgets a developer machine and its token.
  public func remove(_ id: String) async throws {
    try await save(try await records().filter { $0.id != id })
    try await credentials.remove(id)
  }

  private func save(_ records: [DeveloperMachineRecord]) async throws {
    try await store.set(Self.listKey, String(decoding: try JSONEncoder().encode(records), as: UTF8.self))
  }

  private static func machine(_ record: DeveloperMachineRecord) -> Machine {
    Machine(
      id: record.id, name: record.name, platform: .unknown, version: "", online: true, lastSeen: nil,
      baseUrl: record.serverUrl, pushUrl: pushURL(of: record.serverUrl))
  }
}
