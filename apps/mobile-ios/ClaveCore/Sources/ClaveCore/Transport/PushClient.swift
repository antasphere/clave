import Foundation

/// What the push channel tells the app, in the order the socket delivered it.
public enum PushEvent: Sendable, Equatable {
  /// The server accepted the hello and named itself.
  case welcome(serverId: String, version: String?)
  /// A subscription was acknowledged, with the session's record.
  case subscribed(sessionId: String, session: Session)
  case unsubscribed(sessionId: String)
  case stream(sessionId: String, stream: SessionStream)
  case exit(sessionId: String, code: Int)
  case event(ServerEventEnvelope)
  /// The server's refusal, about one session or about the channel.
  case error(sessionId: String?, message: String)
  /// The socket dropped; the client reopens it on its own.
  case disconnected(reason: String)
  /// The device session was revoked (close 4011): the client has ended.
  case revoked
  /// The server refused the token (close 4001): the client has ended.
  case unauthorized
}

/// Where the push client stands.
public enum PushStatus: String, Sendable, Equatable {
  case idle, connecting, open, reconnecting, closed
}

/// Why a subscription did not resolve.
public struct PushClientError: Error, Sendable, Equatable, CustomStringConvertible {
  public let message: String

  public init(_ message: String) {
    self.message = message
  }

  public var description: String { message }
}

/// The close code this client uses when the liveness deadline passes.
public let closeLiveness = 4000

/// The socket URL of a server: the base or the push URL, https becoming wss
/// and http ws, `/push` added when the path does not end with it.
public func pushURL(of url: String) -> String {
  guard var components = URLComponents(string: url) else { return url }
  let scheme = components.scheme?.lowercased()
  components.scheme = (scheme == "https" || scheme == "wss") ? "wss" : "ws"
  var path = components.percentEncodedPath
  if path.isEmpty || path == "/" {
    path = pushPath
  } else if !path.hasSuffix(pushPath) {
    while path.hasSuffix("/") { path.removeLast() }
    path += pushPath
  }
  components.percentEncodedPath = path
  return components.string ?? url
}

/// The phone's client of a Clave server's push channel: one WebSocket, the
/// token in the first frame, the sessions subscribed on the app's behalf, the
/// socket reopened with a jittered backoff when it drops and every
/// subscription asked again, so a screen that was listening keeps listening
/// without knowing the socket changed. A refused token (4001) and a revoked
/// device (4011) are final.
public actor PushClient {
  /// Every frame and every change of the channel, until the client ends.
  public nonisolated let events: AsyncStream<PushEvent>
  /// The socket URL the client opens.
  public nonisolated let url: URL

  private let continuation: AsyncStream<PushEvent>.Continuation
  private let bearer: @Sendable () async throws -> String
  private let transport: any WebSocketTransport
  private let clientName: String
  private let sleep: @Sendable (TimeInterval) async throws -> Void
  private let random: @Sendable () -> Double
  private let pingInterval: TimeInterval
  private let pongTimeout: TimeInterval
  private let backoffBase: TimeInterval
  private let backoffMax: TimeInterval
  private let subscribeTimeout: TimeInterval

  private struct Subscription {
    var acked: Session?
    var ended = false
    var waiters: [Int: CheckedContinuation<Session, Error>] = [:]
  }

  public private(set) var status: PushStatus = .idle
  /// The server named in the last welcome, nil before one.
  public private(set) var serverId: String?
  public private(set) var serverVersion: String?
  /// How many sockets were opened and greeted; a reconnection adds one.
  public private(set) var connections = 0
  /// How many pings went out.
  public private(set) var pings = 0

  private var connection: (any WebSocketConnection)?
  private var generation = 0
  private var attempts = 0
  private var stopped = false
  private var subscriptions: [String: Subscription] = [:]
  private var nextWaiter = 0
  private var connectTask: Task<Void, Never>?
  private var receiveTask: Task<Void, Never>?
  private var livenessTask: Task<Void, Never>?
  private var reconnectTask: Task<Void, Never>?
  private var sendTail: Task<Void, Never>?

  /// A client of the push channel at `url` (a base URL or a push URL; https
  /// is read as wss). Throws `TransportPolicyError` when this build sends no
  /// credential there: wss always, ws only to a loopback in development.
  public init(
    url: String,
    bearer: @escaping @Sendable () async throws -> String,
    transport: any WebSocketTransport,
    build: BuildKind = .release,
    clientName: String = "Clave iOS",
    pingInterval: TimeInterval = 20,
    pongTimeout: TimeInterval = 10,
    backoffBase: TimeInterval = 1,
    backoffMax: TimeInterval = 30,
    subscribeTimeout: TimeInterval = 10,
    sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) },
    random: @escaping @Sendable () -> Double = { Double.random(in: 0..<1) }
  ) throws {
    let socketURL = pushURL(of: url)
    try assertCredentialMayTravelTo(socketURL, build: build)
    guard let parsed = URL(string: socketURL) else {
      throw TransportPolicyError(message: "\"\(url)\" is not an address.", url: url)
    }
    self.url = parsed
    self.bearer = bearer
    self.transport = transport
    self.clientName = clientName
    self.pingInterval = pingInterval
    self.pongTimeout = pongTimeout
    self.backoffBase = backoffBase
    self.backoffMax = backoffMax
    self.subscribeTimeout = subscribeTimeout
    self.sleep = sleep
    self.random = random
    (events, continuation) = AsyncStream.makeStream(of: PushEvent.self, bufferingPolicy: .unbounded)
  }

  // MARK: the app's side

  /// Opens the channel; a second call while it is open or opening does nothing.
  public func start() {
    guard !stopped, connection == nil, connectTask == nil, reconnectTask == nil else { return }
    open(status == .idle ? .connecting : .reconnecting)
  }

  /// Ends the client: the socket closed, the waiters failed, the event stream finished.
  public func stop() {
    guard !stopped else { return }
    end(status: .closed, event: nil, closeCode: 1000)
  }

  /// Subscribes to a session and answers its record once the server has
  /// acknowledged it: the ordered-history contract needs that barrier
  /// before a snapshot is read. Re-asked on every new socket.
  public func subscribe(_ sessionId: String) async throws -> Session {
    guard !stopped else { throw PushClientError("This push client was closed.") }
    let existing = subscriptions[sessionId]
    let fresh = existing == nil || existing!.ended
    var subscription = existing ?? Subscription()
    if fresh { subscription.acked = nil }
    subscription.ended = false
    subscriptions[sessionId] = subscription
    if fresh && status == .open { send(.subscribe(sessionId: sessionId)) }
    return try await acknowledged(sessionId)
  }

  /// The record of a subscribed session once this socket acknowledged it,
  /// bounded by the subscribe timeout.
  public func acknowledged(_ sessionId: String) async throws -> Session {
    guard let subscription = subscriptions[sessionId] else {
      throw PushClientError("Not subscribed to \(sessionId).")
    }
    if let acked = subscription.acked { return acked }
    guard !stopped else { throw PushClientError("This push client was closed.") }
    nextWaiter += 1
    let id = nextWaiter
    let timeout = subscribeTimeout
    let sleep = self.sleep
    let timer = Task { [weak self] in
      guard (try? await sleep(timeout)) != nil else { return }
      await self?.failWaiter(sessionId, id, PushClientError("The server did not acknowledge the conversation subscription."))
    }
    defer { timer.cancel() }
    return try await withCheckedThrowingContinuation { continuation in
      subscriptions[sessionId]?.waiters[id] = continuation
    }
  }

  /// Stops listening to a session.
  public func unsubscribe(_ sessionId: String) {
    guard let subscription = subscriptions.removeValue(forKey: sessionId) else { return }
    fail(subscription, PushClientError("Unsubscribed before the server answered."))
    if status == .open { send(.unsubscribe(sessionId: sessionId)) }
  }

  // MARK: the socket

  private func open(_ next: PushStatus) {
    generation += 1
    let current = generation
    status = next
    connectTask = Task { await self.connect(current) }
  }

  private func connect(_ current: Int) async {
    defer { if generation == current { connectTask = nil } }
    let socket: any WebSocketConnection
    let token: String
    do {
      token = try await bearer()
      socket = try await transport.connect(url, headers: [:])
    } catch {
      guard generation == current, !stopped else { return }
      scheduleReconnect(reason: "The server could not be reached.")
      return
    }
    guard generation == current, !stopped else {
      socket.close(code: 1000)
      return
    }
    connection = socket
    connections += 1
    send(.hello(token: token, client: clientName))
    // The welcome is held to the pong deadline: a server that greets nothing is as dead as one that answers no ping.
    armDeadline(current)
    receiveTask = Task { await self.receiveLoop(socket, current) }
  }

  private func receiveLoop(_ socket: any WebSocketConnection, _ current: Int) async {
    while true {
      let message: WebSocketMessage
      do {
        message = try await socket.receive()
      } catch {
        closed(current, code: nil, reason: "The connection was lost.")
        return
      }
      guard generation == current, !stopped else { return }
      switch message {
      case .text(let text): handle(text)
      case .data(let data): handle(String(decoding: data, as: UTF8.self))
      case .closed(let code, let reason):
        closed(current, code: code, reason: reason)
        return
      }
    }
  }

  private func closed(_ current: Int, code: Int?, reason: String) {
    guard generation == current, !stopped else { return }
    connection = nil
    livenessTask?.cancel()
    livenessTask = nil
    if code == closeDeviceRevoked {
      end(status: .closed, event: .revoked, closeCode: nil)
      return
    }
    if code == closeUnauthorized {
      end(status: .closed, event: .unauthorized, closeCode: nil)
      return
    }
    let said = reason.isEmpty ? code.map { "The socket closed (\($0))." } ?? "The connection was lost." : reason
    continuation.yield(.disconnected(reason: said))
    scheduleReconnect(reason: said)
  }

  private func scheduleReconnect(reason: String) {
    for key in subscriptions.keys { subscriptions[key]?.acked = nil }
    attempts += 1
    let delay = min(backoffMax, backoffBase * pow(2, Double(min(attempts - 1, 10)))) * (0.5 + random() * 0.5)
    status = .reconnecting
    let sleep = self.sleep
    reconnectTask?.cancel()
    reconnectTask = Task { [weak self] in
      guard (try? await sleep(delay)) != nil, !Task.isCancelled else { return }
      await self?.reopen()
    }
  }

  private func reopen() {
    reconnectTask = nil
    guard !stopped, connection == nil else { return }
    open(.reconnecting)
  }

  private func end(status final: PushStatus, event: PushEvent?, closeCode: Int?) {
    stopped = true
    generation += 1
    status = final
    connectTask?.cancel()
    reconnectTask?.cancel()
    livenessTask?.cancel()
    receiveTask?.cancel()
    connectTask = nil
    reconnectTask = nil
    livenessTask = nil
    receiveTask = nil
    if let closeCode { connection?.close(code: closeCode) }
    connection = nil
    let reason = event == nil ? "This push client was closed." : "The server ended this push channel."
    for subscription in subscriptions.values { fail(subscription, PushClientError(reason)) }
    subscriptions.removeAll()
    if let event { continuation.yield(event) }
    continuation.finish()
  }

  // MARK: liveness

  /// Any frame proves the socket alive: the next ping is scheduled from now.
  private func armPing() {
    livenessTask?.cancel()
    let current = generation
    let sleep = self.sleep
    let interval = pingInterval
    livenessTask = Task { [weak self] in
      guard (try? await sleep(interval)) != nil, !Task.isCancelled else { return }
      await self?.ping(current)
    }
  }

  private func ping(_ current: Int) {
    guard generation == current, status == .open, connection != nil else { return }
    pings += 1
    send(.ping)
    armDeadline(current)
  }

  private func armDeadline(_ current: Int) {
    livenessTask?.cancel()
    let sleep = self.sleep
    let timeout = pongTimeout
    livenessTask = Task { [weak self] in
      guard (try? await sleep(timeout)) != nil, !Task.isCancelled else { return }
      await self?.livenessExpired(current)
    }
  }

  private func livenessExpired(_ current: Int) {
    guard generation == current, !stopped, let socket = connection else { return }
    // Nothing came back: the socket is dead under us. It is dropped here
    // rather than waiting for a close that a dead network never delivers.
    generation += 1
    connection = nil
    livenessTask = nil
    socket.close(code: closeLiveness)
    continuation.yield(.disconnected(reason: "The server stopped answering."))
    scheduleReconnect(reason: "no pong")
  }

  // MARK: frames

  private func handle(_ text: String) {
    // An unreadable frame is dropped and the socket kept: a later server's business.
    guard let frame = ServerFrame.parse(text) else { return }
    if status == .open { armPing() }
    switch frame {
    case .welcome(let id, let version):
      attempts = 0
      serverId = id
      serverVersion = version
      // The previous socket's acknowledgements are void before anyone reads a snapshot.
      for key in subscriptions.keys {
        subscriptions[key]?.acked = nil
        subscriptions[key]?.ended = false
      }
      status = .open
      armPing()
      continuation.yield(.welcome(serverId: id, version: version))
      for key in subscriptions.keys.sorted() { send(.subscribe(sessionId: key)) }
    case .subscribed(let sessionId, let session):
      if var subscription = subscriptions[sessionId] {
        subscription.acked = session
        let waiters = subscription.waiters
        subscription.waiters = [:]
        subscriptions[sessionId] = subscription
        for waiter in waiters.values { waiter.resume(returning: session) }
      }
      continuation.yield(.subscribed(sessionId: sessionId, session: session))
    case .unsubscribed(let sessionId):
      continuation.yield(.unsubscribed(sessionId: sessionId))
    case .stream(let sessionId, let stream):
      continuation.yield(.stream(sessionId: sessionId, stream: stream))
    case .exit(let sessionId, let code):
      subscriptions[sessionId]?.ended = true
      continuation.yield(.exit(sessionId: sessionId, code: code))
    case .event(let envelope):
      continuation.yield(.event(envelope))
    case .error(let sessionId, let message):
      if let sessionId, let subscription = subscriptions[sessionId] {
        subscriptions[sessionId]?.waiters = [:]
        fail(subscription, PushClientError(message))
      }
      continuation.yield(.error(sessionId: sessionId, message: message))
    case .pong, .other:
      break
    }
  }

  /// Sends in call order: each frame waits for the one before it.
  private func send(_ frame: ClientFrame) {
    guard let socket = connection, let text = try? ContractJSON.encodeToString(frame) else { return }
    let previous = sendTail
    sendTail = Task {
      await previous?.value
      try? await socket.send(text)
    }
  }

  private func fail(_ subscription: Subscription, _ error: Error) {
    for waiter in subscription.waiters.values { waiter.resume(throwing: error) }
  }

  private func failWaiter(_ sessionId: String, _ id: Int, _ error: Error) {
    guard let waiter = subscriptions[sessionId]?.waiters.removeValue(forKey: id) else { return }
    waiter.resume(throwing: error)
  }
}
