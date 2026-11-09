#if DEBUG
  import ClaveCore
  import Foundation

  // The UI tests' world, answered inside the app's own process: the hub, the
  // relay, one machine behind it and its push channel. No socket is opened,
  // no process started, no browser shown; every answer is data in this file,
  // so a run is the same every time. A development build selects it with the
  // launch argument `--ui-test-fake` alone, and a release build carries none
  // of it (scripts/check-release-binary.sh proves both).

  /// The fake's state: the pairing's reads, the pending requests, the sockets.
  nonisolated final class UITestFakeServer: @unchecked Sendable {
    static let hubOrigin = "https://hub.fake"
    static let relayOrigin = "https://relay.fake"
    static let machineId = "m_fake"
    static let machineName = "Fake Mac"
    static let serverId = "srv_fake"
    static let clientId = "fake-client"
    static let accessToken = "fake-access-token"
    static let deviceToken = "fake-device-token"
    static let sessionId = "s_fake"
    static let workspaceId = "scratch"
    static let generation = "g_fake"
    static let forbiddenSentence = "A phone may not do this."

    private let lock = NSLock()
    private var pairingReads = 0
    private var requestsPending = true
    private var requestsRevision = 1.0
    private var sequence = UITestFakeServer.seeded.count
    private var eventSeq = 0.0
    private var sockets: [UITestFakeSocket] = []

    private func locked<T>(_ run: () -> T) -> T {
      lock.lock()
      defer { lock.unlock() }
      return run()
    }

    var now: Double { Date().timeIntervalSince1970 * 1000 }

    // MARK: HTTP

    func answer(_ request: URLRequest) -> HTTPAnswer {
      guard let url = request.url, let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
        let host = components.host
      else { return HTTPAnswer(status: 400) }
      let method = request.httpMethod ?? "GET"
      let path = components.path
      let query = Dictionary((components.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
      let bearer = request.value(forHTTPHeaderField: "Authorization")?.replacingOccurrences(of: "Bearer ", with: "")
      switch host {
      case "hub.fake": return hub(method, path, body: request.httpBody)
      case "relay.fake": return relay(method, path, query: query, bearer: bearer, body: request.httpBody)
      default: return HTTPAnswer(status: 404)
      }
    }

    private func hub(_ method: String, _ path: String, body: Data?) -> HTTPAnswer {
      let origin = Self.hubOrigin
      switch (method, path) {
      case ("GET", "/.well-known/openid-configuration"):
        return json([
          "issuer": origin, "authorization_endpoint": "\(origin)/authorize", "token_endpoint": "\(origin)/token",
          "registration_endpoint": "\(origin)/register", "jwks_uri": "\(origin)/jwks",
        ])
      case ("POST", "/register"):
        return json([
          "client_id": Self.clientId, "token_endpoint_auth_method": "none",
          "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"],
        ])
      case ("POST", "/token"):
        let form = Dictionary(
          (URLComponents(string: "?" + String(decoding: body ?? Data(), as: UTF8.self))?.queryItems ?? [])
            .map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        // The opener put the nonce in the code; the token echoes it as the hub would.
        let nonce: String? = form["grant_type"] == "authorization_code" ? form["code"]?.replacingOccurrences(of: "fake-code.", with: "") : nil
        return json([
          "access_token": Self.accessToken, "token_type": "Bearer", "expires_in": 3600,
          "refresh_token": "fake-refresh-token", "scope": hubScope,
          "id_token": idToken(clientId: form["client_id"] ?? Self.clientId, nonce: nonce),
        ])
      default:
        return HTTPAnswer(status: 404)
      }
    }

    /// An RS256-shaped token: the phone checks the shape and the claims, never the signature.
    private func idToken(clientId: String, nonce: String?) -> String {
      let seconds = Int(Date().timeIntervalSince1970)
      var claims: [String: Any] = [
        "iss": Self.hubOrigin, "sub": "fake-person", "aud": clientId, "exp": seconds + 3600, "iat": seconds,
        "name": "Fake Person", "email": "fake.person@example.com", "email_verified": true,
      ]
      if let nonce { claims["nonce"] = nonce }
      let header = Self.base64URL(Data(#"{"alg":"RS256","typ":"JWT","kid":"fake"}"#.utf8))
      let payload = Self.base64URL((try? JSONSerialization.data(withJSONObject: claims, options: [.sortedKeys])) ?? Data())
      return "\(header).\(payload).\(Self.base64URL(Data("fake-signature".utf8)))"
    }

    private func relay(_ method: String, _ path: String, query: [String: String], bearer: String?, body: Data?) -> HTTPAnswer {
      if method == "GET", path == "/machines" {
        guard bearer == Self.accessToken else { return HTTPAnswer(status: 401) }
        return json([
          "machines": [
            [
              "id": Self.machineId, "name": Self.machineName, "platform": "macos", "version": "0.0.0-fake",
              "online": true, "lastSeen": now, "direct": [],
            ]
          ]
        ])
      }
      let prefix = "/m/\(Self.machineId)"
      guard path.hasPrefix(prefix) else { return HTTPAnswer(status: 404) }
      return machine(method, String(path.dropFirst(prefix.count)), query: query, bearer: bearer, body: body)
    }

    private func machine(_ method: String, _ route: String, query: [String: String], bearer: String?, body: Data?) -> HTTPAnswer {
      // Pairing carries its proof in the body, not a bearer.
      if route == "/devices/pair" {
        if method == "POST" { return json(["pairingId": "p_fake", "expiresAt": now + 300_000]) }
        let read = locked { () -> Int in
          pairingReads += 1
          return pairingReads
        }
        if read < 2 { return json(["status": "pending"]) }
        if read == 2 {
          return json([
            "status": "approved",
            "deviceSession": [
              "token": Self.deviceToken, "deviceId": "d_fake", "serverId": Self.serverId, "serverName": Self.machineName,
            ],
          ])
        }
        return json(["status": "approved"])
      }
      guard bearer == Self.deviceToken else { return HTTPAnswer(status: 401) }
      switch (method, route) {
      case ("GET", "/devices/me"):
        return json([
          "id": "d_fake", "name": "Fake iPhone", "platform": "ios", "appVersion": ClaveCoreInfo.version,
          "createdAt": now, "lastSeenAt": now,
        ])
      case ("POST", "/devices/me/push-token"), ("POST", "/devices/me/push-token/clear"):
        return HTTPAnswer(status: 204)
      case ("GET", "/workspaces"):
        return encoded(
          WorkspaceStateView(
            workspaces: [WorkspaceView(id: Self.workspaceId, name: "scratch", rootDir: "/fake/scratch", createdAt: 0)],
            lastActiveWorkspaceId: Self.workspaceId, activeWorkspaceId: Self.workspaceId, pins: [], pinsMigrated: true,
            revision: 1, instance: "fake"))
      case ("GET", "/sessions"):
        return encoded([Self.session()])
      case ("GET", "/sessions/by-id"):
        guard query["id"] == Self.sessionId else {
          return json(["_tag": "SessionNotFound", "message": "There is no such conversation.", "id": query["id"] ?? ""], status: 422)
        }
        return encoded(Self.session())
      case ("GET", "/sessions/timeline"):
        return encoded(timeline())
      case ("GET", "/sessions/history"):
        return encoded(HistoryPage(items: Self.seeded.map { HistoryItem(event: $0, at: 0) }, before: nil))
      case ("GET", "/sessions/capabilities"):
        return json(["images": false])
      case ("GET", "/sessions/writes"):
        return json(["status": "accepted", "at": now])
      case ("GET", "/launch-profiles"):
        return json(["version": 1, "customProfiles": [], "globalDefaults": [:], "workspaceOverrides": [:]])
      case ("GET", "/requests/pending"):
        let (pending, revision) = locked { (requestsPending, requestsRevision) }
        return encoded(RequestSnapshot(revision: revision, pending: pending ? [Self.clarification()] : []))
      case ("POST", "/requests/resolve"):
        // Only the seeded request is this device's to answer.
        guard Self.field("requestId", of: body) == Self.clarification().id else {
          return json(["message": Self.forbiddenSentence], status: 403)
        }
        let revision = locked { () -> Double in
          requestsPending = false
          requestsRevision += 1
          return requestsRevision
        }
        broadcast(event: .requestsChanged(revision: revision))
        return json(["accepted": true])
      case ("POST", "/sessions/write"):
        let text = Self.writtenText(body)
        echo(text)
        return json(["status": "accepted", "at": now])
      default:
        return json(["message": Self.forbiddenSentence], status: 403)
      }
    }

    // MARK: the push channel

    func open(_ socket: UITestFakeSocket) {
      locked { sockets.append(socket) }
    }

    func close(_ socket: UITestFakeSocket) {
      locked { sockets.removeAll { $0 === socket } }
    }

    /// The answer to one frame the phone sent on a socket.
    func reply(to text: String) -> [String] {
      guard let frame = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any],
        let tag = frame["_tag"] as? String
      else { return [] }
      switch tag {
      case "hello":
        guard frame["token"] as? String == Self.deviceToken else { return [] }
        return [Self.frame(["_tag": "welcome", "protocol": pushProtocol, "serverId": Self.serverId, "version": "fake"])]
      case "subscribe":
        let id = frame["sessionId"] as? String ?? ""
        guard id == Self.sessionId else {
          return [Self.frame(["_tag": "error", "sessionId": id, "message": "There is no such conversation."])]
        }
        return [Self.frame(["_tag": "subscribed", "sessionId": id, "session": Self.object(Self.session())])]
      case "unsubscribe":
        return [Self.frame(["_tag": "unsubscribed", "sessionId": frame["sessionId"] as? String ?? ""])]
      case "ping":
        return [Self.frame(["_tag": "pong"])]
      default:
        return []
      }
    }

    /// A write comes back as the stream would carry it: the person's message, then Echo's reply.
    private func echo(_ text: String) {
      for event in [SessionEvent.userMessage(UserMessage(text: text)), .assistantText(delta: text, final: true, parent: nil)] {
        let position = locked { () -> Int in
          sequence += 1
          return sequence
        }
        let stream = SessionStream.event(event, position: SessionPosition(generation: Self.generation, sequence: position))
        send(Self.frame(["_tag": "stream", "sessionId": Self.sessionId, "stream": Self.object(stream)]))
      }
    }

    private func broadcast(event: ServerEvent) {
      let seq = locked { () -> Double in
        eventSeq += 1
        return eventSeq
      }
      let envelope = ServerEventEnvelope(id: "e\(Int(seq))", seq: seq, at: now, event: event)
      var frame = Self.object(envelope)
      frame["_tag"] = "event"
      send(Self.frame(frame))
    }

    private func send(_ text: String) {
      for socket in locked({ sockets }) { socket.deliver(.text(text)) }
    }

    // MARK: data

    static func session() -> Session {
      Session(
        id: sessionId, provider: "echo", transport: .events, cwd: "/fake/scratch", windowKey: "server",
        workspaceId: workspaceId, state: .idle, createdAt: 0, adapterId: "echo", title: "Seeded chat")
    }

    /// The seeded conversation: the person's message, Echo's reply, and one completed tool call
    /// (a read of the workspace's README) for the transcript's tool card.
    static let seeded: [SessionEvent] = [
      .userMessage(UserMessage(text: "seeded-fake")),
      .assistantText(delta: "seeded-fake", final: true, parent: nil),
      .toolCall(id: "t_fake", name: "Read", input: .object(["file_path": .string("/fake/scratch/README.md")]), parent: nil),
      .toolResult(id: "t_fake", output: .string("# Scratch"), error: false, parent: nil),
    ]

    static func clarification() -> PendingRequest {
      PendingRequest(
        id: "r_fake", sessionId: sessionId, kind: .clarification, description: "Echo has a question.", createdAt: 0,
        questions: [
          AgentQuestion(id: "q_fake", question: "Which file should Echo read?", options: [AgentQuestionOption(label: "README.md")])
        ])
    }

    private func timeline() -> TimelinePage {
      let top = locked { sequence }
      return TimelinePage(
        items: Self.seeded.enumerated().map { index, event in
          TimelineItem(event: event, at: 0, position: SessionPosition(generation: Self.generation, sequence: index + 1))
        }, before: nil, cursor: SessionPosition(generation: Self.generation, sequence: top), truncated: false)
    }

    private static func field(_ name: String, of body: Data?) -> String? {
      guard let body, let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { return nil }
      return object[name] as? String
    }

    private static func writtenText(_ body: Data?) -> String {
      guard let body, let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
        let input = object["input"] as? [String: Any], let text = input["text"] as? String
      else { return "" }
      return text
    }

    private func json(_ object: Any, status: Int = 200) -> HTTPAnswer {
      let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
      return HTTPAnswer(status: status, headers: ["Content-Type": "application/json"], body: data)
    }

    private func encoded<T: Encodable>(_ value: T) -> HTTPAnswer {
      HTTPAnswer(status: 200, headers: ["Content-Type": "application/json"], body: (try? ContractJSON.encode(value)) ?? Data())
    }

    private static func object<T: Encodable>(_ value: T) -> [String: Any] {
      guard let data = try? ContractJSON.encode(value) else { return [:] }
      return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any]) ?? [:]
    }

    private static func frame(_ object: [String: Any]) -> String {
      String(decoding: (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data(), as: UTF8.self)
    }

    static func base64URL(_ data: Data) -> String {
      data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
    }
  }

  /// Every HTTP call of the app, answered by the fake.
  nonisolated struct UITestFakeTransport: HTTPTransport {
    let server: UITestFakeServer

    func perform(_ request: URLRequest) async throws -> HTTPAnswer {
      try Task.checkCancellation()
      return server.answer(request)
    }
  }

  /// The push channel's sockets, opened in memory against the fake.
  nonisolated struct UITestFakeWebSocketTransport: WebSocketTransport {
    let server: UITestFakeServer

    func connect(_ url: URL, headers: [String: String]) async throws -> any WebSocketConnection {
      guard url.host == "relay.fake", url.path == "/m/\(UITestFakeServer.machineId)/push" else {
        throw URLError(.cannotConnectToHost)
      }
      let socket = UITestFakeSocket(server: server)
      server.open(socket)
      return socket
    }
  }

  /// One socket: what the phone sends is answered into its inbox.
  nonisolated final class UITestFakeSocket: WebSocketConnection, @unchecked Sendable {
    private let server: UITestFakeServer
    private let lock = NSLock()
    private var inbox: [WebSocketMessage] = []
    private var waiter: CheckedContinuation<WebSocketMessage, Never>?
    private var closed = false

    init(server: UITestFakeServer) {
      self.server = server
    }

    func send(_ text: String) async throws {
      for reply in server.reply(to: text) { deliver(.text(reply)) }
    }

    func receive() async throws -> WebSocketMessage {
      await withCheckedContinuation { continuation in
        lock.lock()
        if !inbox.isEmpty {
          let next = inbox.removeFirst()
          lock.unlock()
          continuation.resume(returning: next)
        } else if closed {
          lock.unlock()
          continuation.resume(returning: .closed(code: 1000, reason: ""))
        } else {
          waiter = continuation
          lock.unlock()
        }
      }
    }

    func deliver(_ message: WebSocketMessage) {
      lock.lock()
      if let waiter {
        self.waiter = nil
        lock.unlock()
        waiter.resume(returning: message)
      } else {
        inbox.append(message)
        lock.unlock()
      }
    }

    func close(code: Int) {
      lock.lock()
      closed = true
      let waiter = self.waiter
      self.waiter = nil
      lock.unlock()
      server.close(self)
      waiter?.resume(returning: .closed(code: code, reason: ""))
    }
  }

  /// The browser, skipped: the hub "approves" at once and the redirect comes
  /// back with the state the authorization URL carried, and the nonce folded
  /// into the code so the token endpoint can echo it.
  nonisolated struct UITestFakeOpener: AuthenticationSessionOpener {
    func open(_ url: URL, callbackScheme: String) async throws -> URL? {
      let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
      let state = items.first { $0.name == "state" }?.value ?? ""
      let nonce = items.first { $0.name == "nonce" }?.value ?? ""
      var callback = URLComponents(string: redirectURI)
      callback?.queryItems = [
        URLQueryItem(name: "code", value: "fake-code.\(nonce)"), URLQueryItem(name: "state", value: state),
        URLQueryItem(name: "iss", value: UITestFakeServer.hubOrigin),
      ]
      return callback?.url
    }
  }
#endif
