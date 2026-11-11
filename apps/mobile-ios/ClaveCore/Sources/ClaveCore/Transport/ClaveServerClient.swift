import Foundation

/// The phone's client of one Clave server over HTTP: the routes of the wire
/// contract the phone speaks. Queries are GETs with the payload in the query
/// string, commands POSTs with a JSON body, every call under
/// `Authorization: Bearer`. The client is handed a supplier of its bearer and
/// never stores it: the credential store owns that.
public struct ClaveServerClient: Sendable {
  /// The ordinary deadline of a call.
  public static let defaultTimeout: TimeInterval = 10
  /// The deadline of a page of the past (history or timeline).
  public static let historyTimeout: TimeInterval = 60

  /// The server's base URL without a trailing slash: a relay road or a direct address.
  public let baseURL: String
  private let bearer: @Sendable () async throws -> String
  private let transport: any HTTPTransport
  private let timeout: TimeInterval
  private let pageTimeout: TimeInterval

  /// A client of the server at `baseURL`; throws `TransportPolicyError` when
  /// this build sends no credential there, before any request is made.
  public init(
    baseURL: String,
    bearer: @escaping @Sendable () async throws -> String,
    transport: any HTTPTransport,
    build: BuildKind = .release,
    timeout: TimeInterval = ClaveServerClient.defaultTimeout,
    historyTimeout: TimeInterval = ClaveServerClient.historyTimeout
  ) throws {
    var base = baseURL
    while base.hasSuffix("/") { base.removeLast() }
    try assertCredentialMayTravelTo(base, build: build)
    self.baseURL = base
    self.bearer = bearer
    self.transport = transport
    self.timeout = timeout
    self.pageTimeout = historyTimeout
  }

  /// A client holding a fixed credential, the way a paired machine is reached.
  public init(credential: Credential, transport: any HTTPTransport, build: BuildKind = .release) throws {
    let token = credential.bearer
    try self.init(baseURL: credential.serverUrl, bearer: { token }, transport: transport, build: build)
  }

  // MARK: namespaces

  /// The sessions routes.
  public var sessions: Sessions { Sessions(client: self) }
  /// The pending requests and their answers.
  public var requests: Requests { Requests(client: self) }
  /// The workspaces of the server.
  public var workspaces: Workspaces { Workspaces(client: self) }
  /// The launch profiles the server keeps.
  public var launchProfiles: LaunchProfiles { LaunchProfiles(client: self) }
  /// Reading files and preparing attachments.
  public var files: Files { Files(client: self) }
  /// The phone's own device routes.
  public var devices: Devices { Devices(client: self) }

  /// `/sessions/*`.
  public struct Sessions: Sendable {
    let client: ClaveServerClient

    /// `GET /sessions`, optionally those of one window.
    public func list(windowKey: String? = nil) async throws -> [Session] {
      try await client.query("/sessions", [("windowKey", windowKey)], [Session].self)
    }

    /// `GET /sessions/by-id`.
    public func get(_ id: String) async throws -> Session {
      try await client.query("/sessions/by-id", [("id", id)], Session.self)
    }

    /// `POST /sessions/start`.
    public func start(_ input: StartSessionInput) async throws -> SessionInfo {
      try await client.command("/sessions/start", input, SessionInfo.self)
    }

    /// `POST /sessions/stop`.
    public func stop(_ id: String) async throws {
      try await client.command("/sessions/stop", IdBody(id: id))
    }

    /// `POST /sessions/restart`, on the session's own account.
    public func restart(_ id: String) async throws -> SessionInfo {
      try await client.command("/sessions/restart", RestartBody(id: id), SessionInfo.self)
    }

    /// `POST /sessions/write`; the message's `clientMessageId` travels in the body as the contract encodes it.
    public func write(_ id: String, _ input: SessionWriteInput) async throws -> WriteAnswer {
      try await client.command("/sessions/write", WriteSessionInput(id: id, input: input), WriteAnswer.self)
    }

    /// `GET /sessions/capabilities`.
    public func capabilities(_ id: String) async throws -> SessionCapabilities {
      try await client.query("/sessions/capabilities", [("id", id)], SessionCapabilities.self)
    }

    /// `GET /sessions/history`: a page ending at `before`, under the long deadline.
    public func history(_ id: String, before: Int? = nil, limit: Int? = nil) async throws -> HistoryPage {
      try await client.query("/sessions/history", [("id", id), ("before", before.map(String.init)), ("limit", limit.map(String.init))],
        HistoryPage.self, timeout: client.pageTimeout)
    }

    /// `GET /sessions/timeline`: an ordered page before an exclusive sequence, under the long deadline.
    public func timeline(_ id: String, before: Int? = nil, limit: Int? = nil) async throws -> TimelinePage {
      try await client.query("/sessions/timeline", [("id", id), ("before", before.map(String.init)), ("limit", limit.map(String.init))],
        TimelinePage.self, timeout: client.pageTimeout)
    }

    /// `GET /sessions/writes`: what the server knows of a write by the id the phone minted.
    public func writeStatus(_ id: String, clientMessageId: String) async throws -> WriteStatus {
      try await client.query("/sessions/writes", [("id", id), ("clientMessageId", clientMessageId)], WriteStatus.self)
    }
  }

  /// `/requests/*`.
  public struct Requests: Sendable {
    let client: ClaveServerClient

    /// `GET /requests/pending`.
    public func pending() async throws -> RequestSnapshot {
      try await client.query("/requests/pending", [], RequestSnapshot.self)
    }

    /// `POST /requests/resolve`.
    public func resolve(_ requestId: String, _ response: RequestResponse) async throws -> ResolveOutcome {
      try await client.command(
        "/requests/resolve", ResolveRequestInput(requestId: requestId, response: response), ResolveOutcome.self)
    }
  }

  /// `/workspaces`.
  public struct Workspaces: Sendable {
    let client: ClaveServerClient

    /// `GET /workspaces`.
    public func load() async throws -> WorkspaceStateView {
      try await client.query("/workspaces", [], WorkspaceStateView.self)
    }
  }

  /// `/launch-profiles`.
  public struct LaunchProfiles: Sendable {
    let client: ClaveServerClient

    /// `GET /launch-profiles`.
    public func list() async throws -> LaunchProfilePreferencesView {
      try await client.query("/launch-profiles", [], LaunchProfilePreferencesView.self)
    }
  }

  /// `/files/*`.
  public struct Files: Sendable {
    let client: ClaveServerClient

    /// `GET /files/read`: the text of a file bounded by `root`.
    public func read(root: String, path: String) async throws -> FileText {
      try await client.query("/files/read", [("root", root), ("path", path)], FileText.self)
    }

    /// `POST /files/attachments/prepare`.
    public func prepareAttachment(_ input: PrepareFileAttachmentInput) async throws -> FileAttachment {
      try await client.command("/files/attachments/prepare", input, FileAttachment.self)
    }
  }

  /// `/devices/me*`.
  public struct Devices: Sendable {
    let client: ClaveServerClient

    /// `GET /devices/me`: the phone's own record.
    public func me() async throws -> DeviceView {
      try await client.query("/devices/me", [], DeviceView.self)
    }

    /// `POST /devices/me/push-token`.
    public func setPushToken(_ token: String, platform: DevicePlatform = .ios) async throws {
      try await client.command("/devices/me/push-token", PushTokenInput(token: token, platform: platform))
    }

    /// `POST /devices/me/push-token/clear`.
    public func clearPushToken() async throws {
      try await client.command("/devices/me/push-token/clear", EmptyBody())
    }
  }

  // MARK: the wire

  private struct IdBody: Encodable { let id: String }
  private struct EmptyBody: Encodable {}
  private struct RestartBody: Encodable {
    let id: String
    let account = EmptyBody()
  }

  func query<T: Decodable>(_ path: String, _ params: [(String, String?)], _ type: T.Type, timeout: TimeInterval? = nil) async throws -> T {
    // An absent parameter is left out, not sent empty: the server reads "" as a value.
    let pairs = params.compactMap { key, value in value.map { (key, $0) } }
    let target = pairs.isEmpty ? path : "\(path)?\(WebURL.formEncode(pairs))"
    let body = try await send("GET", target, path: path, body: nil, timeout: timeout ?? self.timeout)
    return try decode(type, body, path: path)
  }

  func command<T: Decodable, Body: Encodable>(_ path: String, _ input: Body, _ type: T.Type) async throws -> T {
    let body = try await send("POST", path, path: path, body: try ContractJSON.encode(input), timeout: timeout)
    return try decode(type, body, path: path)
  }

  func command<Body: Encodable>(_ path: String, _ input: Body) async throws {
    _ = try await send("POST", path, path: path, body: try ContractJSON.encode(input), timeout: timeout)
  }

  private func decode<T: Decodable>(_ type: T.Type, _ body: Data, path: String) throws -> T {
    guard !body.isEmpty else {
      throw ServerError(.protocol, "The server's answer to \(path) is empty.")
    }
    do {
      return try ContractJSON.decode(type, from: body, path: "body")
    } catch {
      throw ServerError(.protocol, "The server's answer to \(path) does not have the expected shape: \(error)")
    }
  }

  private func send(_ method: String, _ target: String, path: String, body: Data?, timeout: TimeInterval) async throws -> Data {
    guard let url = URL(string: baseURL + target) else {
      throw ServerError(.protocol, "\(path) does not make an address on this server.")
    }
    let token = try await bearer()
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = timeout
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = body
    }
    let answer: HTTPAnswer
    do {
      answer = try await transport.perform(request)
    } catch let error as URLError where error.code == .timedOut {
      throw ServerError(.timeout, "The server did not answer within \(Int(timeout)) s.")
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw ServerError(.network, "The server could not be reached.")
    }
    try Self.check(answer)
    return answer.body
  }

  /// The status mapping every route shares. A 403 is the device session's
  /// scope speaking: it is said in the server's words and never retried.
  static func check(_ answer: HTTPAnswer) throws {
    let status = answer.status
    if (200..<300).contains(status) { return }
    switch status {
    case 401:
      throw ServerError(.unauthenticated, "The server refused the token.", status: status)
    case 403:
      let message = (try? JSONDecoder().decode(MessageBody.self, from: answer.body))?.message
      throw ServerError(.forbidden, message.flatMap { $0.isEmpty ? nil : $0 } ?? "The server refused this call.", status: status)
    case 404:
      throw ServerError(.notFound, "The server has no such route.", status: status)
    case 422:
      guard let failure = try? ContractJSON.decode(ServerFailure.self, from: answer.body) else {
        throw ServerError(.protocol, "The server refused (422) without a readable reason.", status: status)
      }
      throw ServerError(.refused, failure.message, status: status, failure: failure)
    default:
      throw ServerError(.protocol, "The server answered \(status).", status: status)
    }
  }

  private struct MessageBody: Decodable { let message: String? }
}

extension ServerError {
  /// True when the server said it lacks the part (`CapabilityUnavailable`).
  public var capabilityUnavailable: Bool { failure?.tag == "CapabilityUnavailable" }
}
