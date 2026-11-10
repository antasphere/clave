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
    /// A message starting with this is answered only after an interrupt, or after 20 s.
    static let slowPrefix = "slow:"
    /// A message of exactly this closes every socket and refuses new ones for `offlineSeconds`.
    static let offlineCommand = "offline:"
    /// Long enough for a UI test to come back to the state line before the push client's backoff
    /// reaches a socket the fake accepts again.
    static let offlineSeconds = 5.0
    /// A message starting with this: the fake keeps the write (its turn and Echo's reply appear),
    /// loses the write's answer, and answers accepted when asked about it. The first write of
    /// each text only; a later write of the same text is an ordinary one.
    static let ackLostPrefix = "ack-lost:"
    /// A message starting with this: the fake does not keep the write, loses its answer and fails
    /// every status read for its id; `unknownDropDelay` later it closes every socket and refuses
    /// new ones for `unknownOfflineSeconds`, and once a socket is accepted again it answers absent
    /// for that id, so the reconnection's same-id write lands. The first write of each text only.
    static let unknownPrefix = "unknown:"
    static let unknownDropDelay = 3.0
    static let unknownOfflineSeconds = 4.0
    /// The line the timeline keeps once a socket is accepted again after an `unknown:` drop: what a
    /// UI test waits on to know the reconnection's fresh snapshot has landed.
    static let backAfterUnknown = "The fake machine is back."
    /// The last seeded reply: GitHub-flavoured Markdown, its image a data: URL so nothing is fetched.
    static let markdownReply = """
      ## Evidence heading

      A paragraph with a [link to Clave](https://example.com/clave).

      ```swift
      let greeting = "hello"
      let count = 3
      print(greeting, count)
      ```

      | Name | Value |
      | --- | --- |
      | alpha | 1 |
      | beta | 2 |

      ![A tiny strip](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAACCAIAAADej8umAAAAPklEQVR42mPQqDhhUnHAoWKHT8WGiIoVKRULCipm1FRM6KjomFLRsKCiYk1FwY6KjCMVCRcqIu5UBDCQqgEANIkwweYaurwAAAAASUVORK5CYII=)
      """

    private let lock = NSLock()
    private var pairingReads = 0
    private var requestsPending = true
    private var requestsRevision = 1.0
    private var sequence = UITestFakeServer.seeded.count
    private var eventSeq = 0.0
    private var sockets: [UITestFakeSocket] = []
    /// The reply a `slow:` message holds back until an interrupt arrives, or 20 s pass.
    private var heldReply: (id: Int, text: String)?
    private var heldCount = 0
    /// Until when a new socket's hello is answered by closing it (after an `offline:` message).
    private var refusingUntil: Date?
    /// The texts whose first write a delivery behaviour already took.
    private var deliveryTexts: Set<String> = []
    /// The ids of `unknown:` writes, and what a status read about each gets.
    private var unknownWrites: [String: UnknownWrite] = [:]
    /// An `unknown:` drop happened and no socket has been accepted since.
    private var awaitingReturn = false
    /// What the timeline holds beyond the seeded events: the delivery behaviours' messages, so a
    /// fresh snapshot after a reconnection still shows them.
    private var kept: [TimelineItem] = []

    private enum UnknownWrite { case unreadable, absent, landed }

    private func locked<T>(_ run: () -> T) -> T {
      lock.lock()
      defer { lock.unlock() }
      return run()
    }

    var now: Double { Date().timeIntervalSince1970 * 1000 }

    // MARK: HTTP

    /// The answer to one call; one whose answer a delivery behaviour loses reads as a 503 here.
    func answer(_ request: URLRequest) -> HTTPAnswer {
      (try? respond(request)) ?? HTTPAnswer(status: 503)
    }

    /// The answer to one call, or its loss: a delivery behaviour may take a write and lose the
    /// answer, or fail a status read.
    func respond(_ request: URLRequest) throws -> HTTPAnswer {
      guard let url = request.url, let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
        let host = components.host
      else { return HTTPAnswer(status: 400) }
      let method = request.httpMethod ?? "GET"
      let path = components.path
      let query = Dictionary((components.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
      let bearer = request.value(forHTTPHeaderField: "Authorization")?.replacingOccurrences(of: "Bearer ", with: "")
      switch host {
      case "hub.fake": return hub(method, path, body: request.httpBody)
      case "relay.fake": return try relay(method, path, query: query, bearer: bearer, body: request.httpBody)
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

    private func relay(_ method: String, _ path: String, query: [String: String], bearer: String?, body: Data?) throws -> HTTPAnswer {
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
      return try machine(method, String(path.dropFirst(prefix.count)), query: query, bearer: bearer, body: body)
    }

    private func machine(_ method: String, _ route: String, query: [String: String], bearer: String?, body: Data?) throws -> HTTPAnswer {
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
        return encoded([Self.session()] + Self.stateSessions)
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
        return try writeStatus(query["clientMessageId"] ?? "")
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
        if Self.writtenType(body) == "interrupt" {
          releaseHeldReply()
          return json(["status": "accepted", "at": now])
        }
        let text = Self.writtenText(body)
        if let answer = try deliveryWrite(text, id: Self.writtenId(body)) { return answer }
        if text == Self.offlineCommand {
          dropSockets()
        } else if text.hasPrefix(Self.slowPrefix) {
          hold(text)
        } else {
          echo(text)
        }
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

    /// Whether this frame is a hello the fake refuses by closing the socket: for `offlineSeconds`
    /// after an `offline:` message, the machine is gone.
    func refuses(_ text: String) -> Bool {
      guard let frame = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any],
        frame["_tag"] as? String == "hello"
      else { return false }
      return locked { refusingUntil.map { Date() < $0 } ?? false }
    }

    /// The answer to one frame the phone sent on a socket.
    func reply(to text: String) -> [String] {
      guard let frame = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any],
        let tag = frame["_tag"] as? String
      else { return [] }
      switch tag {
      case "hello":
        guard frame["token"] as? String == Self.deviceToken else { return [] }
        acceptedAgain()
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
      stream([.userMessage(UserMessage(text: text)), .assistantText(delta: text, final: true, parent: nil)])
    }

    /// The session's next events on its stream, each at the next position of the one generation;
    /// `keep` puts them in the timeline too.
    private func stream(_ events: [SessionEvent], keep: Bool = false) {
      for event in events {
        let position = locked { () -> Int in
          sequence += 1
          if keep { kept.append(TimelineItem(event: event, at: now, position: SessionPosition(generation: Self.generation, sequence: sequence))) }
          return sequence
        }
        let stream = SessionStream.event(event, position: SessionPosition(generation: Self.generation, sequence: position))
        send(Self.frame(["_tag": "stream", "sessionId": Self.sessionId, "stream": Self.object(stream)]))
      }
    }

    /// A `slow:` message: the person's message at once, the agent working, and the reply held
    /// until an interrupt arrives or 20 s pass.
    private func hold(_ text: String) {
      let id = locked { () -> Int in
        heldCount += 1
        heldReply = (heldCount, text)
        return heldCount
      }
      stream([.userMessage(UserMessage(text: text)), .stateChange(.working)])
      broadcast(event: .sessionStateChanged(id: Self.sessionId, state: .working))
      DispatchQueue.global().asyncAfter(deadline: .now() + 20) { [weak self] in self?.releaseHeldReply(id) }
    }

    /// The held reply streamed now and the agent idle again; `id` releases only that hold.
    private func releaseHeldReply(_ id: Int? = nil) {
      let held = locked { () -> (id: Int, text: String)? in
        guard let held = heldReply, id == nil || held.id == id else { return nil }
        heldReply = nil
        return held
      }
      guard let held else { return }
      stream([.assistantText(delta: held.text, final: true, parent: nil), .stateChange(.idle)])
      broadcast(event: .sessionStateChanged(id: Self.sessionId, state: .idle))
    }

    // MARK: delivery behaviours

    /// The delivery behaviours of a message whose text carries their prefix; nil for any other
    /// text, which the fake answers as before.
    private func deliveryWrite(_ text: String, id: String) throws -> HTTPAnswer? {
      guard text.hasPrefix(Self.ackLostPrefix) || text.hasPrefix(Self.unknownPrefix) else { return nil }
      let first = locked { deliveryTexts.insert(text).inserted }
      if first, text.hasPrefix(Self.ackLostPrefix) {
        keepAndEcho(text, id: id)
        throw URLError(.networkConnectionLost)
      }
      if first {
        locked { unknownWrites[id] = .unreadable }
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.unknownDropDelay) { [weak self] in self?.dropAfterUnknown() }
        throw URLError(.networkConnectionLost)
      }
      // A later write of the same text (the reconnection's same-id write, or a new id): an
      // ordinary message, kept and answered.
      locked {
        if unknownWrites[id] != nil { unknownWrites[id] = .landed }
      }
      keepAndEcho(text, id: id)
      return json(["status": "accepted", "at": now])
    }

    /// What the status route says about an id: an `unknown:` write's status cannot be read until
    /// a socket is accepted again after its drop, then it reads absent; anything else is accepted.
    private func writeStatus(_ id: String) throws -> HTTPAnswer {
      switch locked({ unknownWrites[id] }) {
      case .unreadable?: throw URLError(.networkConnectionLost)
      case .absent?: return json(["status": "absent"])
      case .landed?, nil: return json(["status": "accepted", "at": now])
      }
    }

    /// A message the machine keeps: in the timeline, and on the stream as the person's message,
    /// under its id, and Echo's reply.
    private func keepAndEcho(_ text: String, id: String) {
      stream(
        [.userMessage(UserMessage(clientMessageId: id.isEmpty ? nil : id, text: text)), .assistantText(delta: text, final: true, parent: nil)],
        keep: true)
    }

    /// `unknownDropDelay` after an `unknown:` write: every socket closed, new ones refused for
    /// `unknownOfflineSeconds`.
    private func dropAfterUnknown() {
      let open = locked { () -> [UITestFakeSocket] in
        refusingUntil = Date().addingTimeInterval(Self.unknownOfflineSeconds)
        awaitingReturn = true
        return sockets
      }
      for socket in open { socket.close(code: 1001, reason: "The fake machine went away.") }
    }

    /// The first socket accepted after an `unknown:` drop: the ids it left unreadable now read
    /// absent, and the timeline keeps a line saying the machine is back (not pushed: the fresh
    /// snapshot the reconnection takes carries it).
    private func acceptedAgain() {
      locked {
        guard awaitingReturn else { return }
        awaitingReturn = false
        for (id, state) in unknownWrites where state == .unreadable { unknownWrites[id] = .absent }
        sequence += 1
        kept.append(
          TimelineItem(
            event: .assistantText(delta: Self.backAfterUnknown, final: true, parent: nil), at: now,
            position: SessionPosition(generation: Self.generation, sequence: sequence)))
      }
    }

    /// An `offline:` message: every open socket closed by the machine, and new ones refused for a while.
    private func dropSockets() {
      let open = locked { () -> [UITestFakeSocket] in
        refusingUntil = Date().addingTimeInterval(Self.offlineSeconds)
        return sockets
      }
      for socket in open { socket.close(code: 1001, reason: "The fake machine went away.") }
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

    /// Two more chats in the workspace, only listed: one working, one waiting for the person, so
    /// the Sessions screen shows those states' words. Older than the seeded chat, so they list
    /// after it.
    static let stateSessions: [Session] = [
      Session(
        id: "s_working", provider: "echo", transport: .events, cwd: "/fake/scratch", windowKey: "server",
        workspaceId: workspaceId, state: .working, createdAt: -1, adapterId: "echo", title: "Working chat"),
      Session(
        id: "s_waiting", provider: "echo", transport: .events, cwd: "/fake/scratch", windowKey: "server",
        workspaceId: workspaceId, state: .blocked, createdAt: -2, adapterId: "echo", title: "Waiting chat"),
    ]

    /// The seeded conversation: the person's message, Echo's reply, one completed tool call
    /// (a read of the workspace's README) for the transcript's tool card, and a final reply in
    /// GitHub-flavoured Markdown (a heading, a link, a fenced block, a table and an image), then a
    /// tool call that failed, so the transcript shows a failure's words.
    static let seeded: [SessionEvent] = [
      .userMessage(UserMessage(text: "seeded-fake")),
      .assistantText(delta: "seeded-fake", final: true, parent: nil),
      .toolCall(id: "t_fake", name: "Read", input: .object(["file_path": .string("/fake/scratch/README.md")]), parent: nil),
      .toolResult(id: "t_fake", output: .string("# Scratch"), error: false, parent: nil),
      .assistantText(delta: markdownReply, final: true, parent: nil),
      .toolCall(id: "t_failed", name: "Bash", input: .object(["command": .string("make check")]), parent: nil),
      .toolResult(id: "t_failed", output: .string("make: *** [check] Error 1"), error: true, parent: nil),
    ]

    static func clarification() -> PendingRequest {
      PendingRequest(
        id: "r_fake", sessionId: sessionId, kind: .clarification, description: "Echo has a question.", createdAt: 0,
        questions: [
          AgentQuestion(id: "q_fake", question: "Which file should Echo read?", options: [AgentQuestionOption(label: "README.md")])
        ])
    }

    private func timeline() -> TimelinePage {
      let (top, extra) = locked { (sequence, kept) }
      return TimelinePage(
        items: Self.seeded.enumerated().map { index, event in
          TimelineItem(event: event, at: 0, position: SessionPosition(generation: Self.generation, sequence: index + 1))
        } + extra, before: nil, cursor: SessionPosition(generation: Self.generation, sequence: top), truncated: false)
    }

    private static func field(_ name: String, of body: Data?) -> String? {
      guard let body, let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { return nil }
      return object[name] as? String
    }

    private static func writtenType(_ body: Data?) -> String? {
      guard let body, let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
        let input = object["input"] as? [String: Any]
      else { return nil }
      return input["type"] as? String
    }

    private static func writtenId(_ body: Data?) -> String {
      guard let body, let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
        let input = object["input"] as? [String: Any], let id = input["clientMessageId"] as? String
      else { return "" }
      return id
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
      return try server.respond(request)
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
    private var closeCode = 1000
    private var closeReason = ""

    init(server: UITestFakeServer) {
      self.server = server
    }

    func send(_ text: String) async throws {
      if server.refuses(text) {
        close(code: 1001, reason: "The fake machine is not answering.")
        return
      }
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
          let (code, reason) = (closeCode, closeReason)
          lock.unlock()
          continuation.resume(returning: .closed(code: code, reason: reason))
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
      close(code: code, reason: "")
    }

    /// Closed by either end: a pending receive answers the close, later ones too.
    func close(code: Int, reason: String) {
      lock.lock()
      closed = true
      closeCode = code
      closeReason = reason
      let waiter = self.waiter
      self.waiter = nil
      lock.unlock()
      server.close(self)
      waiter?.resume(returning: .closed(code: code, reason: reason))
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
