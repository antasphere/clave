import Foundation
import XCTest
@testable import ClaveCore

/// Answers requests by (method, path) script, the query left out, and
/// records every request it was handed. An unscripted route answers 404.
actor ScriptedTransport: HTTPTransport {
  typealias Handler = @Sendable (URLRequest) async throws -> HTTPAnswer

  private var routes: [String: Handler] = [:]
  private(set) var requests: [URLRequest] = []

  func on(_ method: String, _ path: String, _ handler: @escaping Handler) {
    routes["\(method) \(path)"] = handler
  }

  func onJSON(_ method: String, _ path: String, status: Int = 200, _ body: String) {
    on(method, path) { _ in HTTPAnswer(status: status, headers: ["Content-Type": "application/json"], body: Data(body.utf8)) }
  }

  func perform(_ request: URLRequest) async throws -> HTTPAnswer {
    requests.append(request)
    let path = request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.percentEncodedPath } ?? ""
    guard let handler = routes["\(request.httpMethod ?? "GET") \(path)"] else { return HTTPAnswer(status: 404) }
    return try await handler(request)
  }

  /// The path and query of every request, in order.
  var targets: [String] {
    requests.map { request in
      let components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
      return components.percentEncodedPath + (components.percentEncodedQuery.map { "?\($0)" } ?? "")
    }
  }
}

/// Counts the calls of a closure, safely across tasks.
final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0

  func next() -> Int { lock.withLock { value += 1; return value } }
  var count: Int { lock.withLock { value } }
}

/// A bearer supplier that counts how often it was asked.
func countingBearer(_ token: String, _ counter: Counter) -> @Sendable () async throws -> String {
  { _ = counter.next(); return token }
}

func bodyJSON(_ request: URLRequest) -> JSONValue? {
  request.httpBody.flatMap { try? ContractJSON.decode(JSONValue.self, from: $0) }
}

func json(_ text: String) -> JSONValue {
  try! ContractJSON.decode(JSONValue.self, from: text)
}

/// A clock for sleepers a test moves by hand: `sleep` suspends until
/// `advance` passes its deadline, and a cancelled sleeper throws at once.
final class ManualClock: @unchecked Sendable {
  private struct Sleeper {
    let id: Int
    let deadline: Double
    let continuation: CheckedContinuation<Void, Error>
  }

  private let lock = NSLock()
  private var current: Double = 0
  private var sleepers: [Sleeper] = []
  private var cancelled: Set<Int> = []
  private var counter = 0

  var now: Double { lock.withLock { current } }
  /// The deadlines of the sleepers waiting now.
  var deadlines: [Double] { lock.withLock { sleepers.map(\.deadline).sorted() } }

  func sleep(_ seconds: TimeInterval) async throws {
    let id = lock.withLock { counter += 1; return counter }
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        lock.lock()
        if cancelled.remove(id) != nil {
          lock.unlock()
          continuation.resume(throwing: CancellationError())
          return
        }
        sleepers.append(Sleeper(id: id, deadline: current + seconds, continuation: continuation))
        lock.unlock()
      }
    } onCancel: {
      lock.lock()
      if let index = sleepers.firstIndex(where: { $0.id == id }) {
        let sleeper = sleepers.remove(at: index)
        lock.unlock()
        sleeper.continuation.resume(throwing: CancellationError())
      } else {
        cancelled.insert(id)
        lock.unlock()
      }
    }
  }

  func advance(_ seconds: Double) {
    lock.lock()
    current += seconds
    let due = sleepers.filter { $0.deadline <= current + 1e-9 }
    sleepers.removeAll { $0.deadline <= current + 1e-9 }
    lock.unlock()
    for sleeper in due { sleeper.continuation.resume() }
  }
}

/// Polls `condition` until it holds, failing after `timeout` real seconds.
func until(
  _ what: String = "the condition", timeout: TimeInterval = 3, file: StaticString = #filePath, line: UInt = #line,
  _ condition: @Sendable () async -> Bool
) async {
  let start = Date()
  while Date().timeIntervalSince(start) < timeout {
    if await condition() { return }
    try? await Task.sleep(nanoseconds: 2_000_000)
  }
  XCTFail("Timed out waiting for \(what)", file: file, line: line)
}

/// One scripted socket: the test feeds it messages, it records what was sent.
final class ScriptedConnection: WebSocketConnection, @unchecked Sendable {
  private let lock = NSLock()
  private var queue: [WebSocketMessage] = []
  private var waiter: CheckedContinuation<WebSocketMessage, Error>?
  private var _sent: [String] = []
  private var _closedWith: Int?
  private let server: FakePushServer

  init(server: FakePushServer) {
    self.server = server
  }

  var sent: [String] { lock.withLock { _sent } }
  /// The tags of the frames sent, in order.
  var sentTags: [String] {
    sent.compactMap { text in
      guard case .object(let object)? = try? ContractJSON.decode(JSONValue.self, from: text),
        case .string(let tag)? = object["_tag"]
      else { return nil }
      return tag
    }
  }
  var closedWith: Int? { lock.withLock { _closedWith } }

  /// Delivers a message to the client.
  func feed(_ message: WebSocketMessage) {
    lock.lock()
    if let waiter {
      self.waiter = nil
      lock.unlock()
      waiter.resume(returning: message)
    } else {
      queue.append(message)
      lock.unlock()
    }
  }

  func feed(_ text: String) { feed(.text(text)) }

  /// The server closes the socket with `code`.
  func serverClose(_ code: Int, _ reason: String = "") { feed(.closed(code: code, reason: reason)) }

  func send(_ text: String) async throws {
    let closed = lock.withLock { () -> Bool in
      if _closedWith != nil { return true }
      _sent.append(text)
      return false
    }
    if closed { throw URLError(.networkConnectionLost) }
    server.answer(text, on: self)
  }

  func receive() async throws -> WebSocketMessage {
    try await withCheckedThrowingContinuation { continuation in
      lock.lock()
      if !queue.isEmpty {
        let message = queue.removeFirst()
        lock.unlock()
        continuation.resume(returning: message)
      } else if let code = _closedWith {
        lock.unlock()
        continuation.resume(returning: .closed(code: code, reason: "closed by the client"))
      } else {
        waiter = continuation
        lock.unlock()
      }
    }
  }

  func close(code: Int) {
    lock.lock()
    _closedWith = code
    let waiter = self.waiter
    self.waiter = nil
    lock.unlock()
    waiter?.resume(returning: .closed(code: code, reason: "closed by the client"))
  }
}

/// A push server played in memory: welcomes a hello, acknowledges a
/// subscription of a known session, answers a ping; each switchable.
final class FakePushServer: WebSocketTransport, @unchecked Sendable {
  private let lock = NSLock()
  private var _connections: [ScriptedConnection] = []
  private var _urls: [URL] = []
  var welcome = true
  var answerPings = true
  var answerSubscriptions = true
  var refuseConnect = false

  static let sessionJSON =
    #"{"id":"s1","provider":"echo","transport":"events","cwd":"/tmp/scratch","windowKey":"server","state":"idle","createdAt":1,"adapterId":"echo","title":"Echo"}"#

  var connections: [ScriptedConnection] { lock.withLock { _connections } }
  var urls: [URL] { lock.withLock { _urls } }
  var last: ScriptedConnection? { connections.last }

  func set(_ change: (FakePushServer) -> Void) { lock.withLock { change(self) } }

  func connect(_ url: URL, headers: [String: String]) async throws -> any WebSocketConnection {
    if lock.withLock({ refuseConnect }) { throw URLError(.cannotConnectToHost) }
    let connection = ScriptedConnection(server: self)
    lock.withLock {
      _connections.append(connection)
      _urls.append(url)
    }
    return connection
  }

  func answer(_ text: String, on connection: ScriptedConnection) {
    guard case .object(let frame)? = try? ContractJSON.decode(JSONValue.self, from: text),
      case .string(let tag)? = frame["_tag"]
    else { return }
    let (welcome, pings, subscriptions) = lock.withLock { (self.welcome, answerPings, answerSubscriptions) }
    switch tag {
    case "hello" where welcome:
      connection.feed(#"{"_tag":"welcome","serverId":"srv","protocol":1,"version":"2.4.0"}"#)
    case "ping" where pings:
      connection.feed(#"{"_tag":"pong"}"#)
    case "subscribe" where subscriptions:
      guard case .string(let id)? = frame["sessionId"] else { return }
      if id == "s1" {
        connection.feed(#"{"_tag":"subscribed","sessionId":"s1","session":\#(Self.sessionJSON)}"#)
      } else {
        connection.feed(#"{"_tag":"error","sessionId":"\#(id)","message":"Unknown session"}"#)
      }
    default:
      break
    }
  }
}

/// Collects a push client's events as they arrive.
final class EventLog: @unchecked Sendable {
  private let lock = NSLock()
  private var _events: [PushEvent] = []
  private var _finished = false

  init(_ stream: AsyncStream<PushEvent>) {
    Task {
      for await event in stream { self.lock.withLock { self._events.append(event) } }
      self.lock.withLock { self._finished = true }
    }
  }

  var events: [PushEvent] { lock.withLock { _events } }
  var finished: Bool { lock.withLock { _finished } }
  func count(_ match: (PushEvent) -> Bool) -> Int { events.filter(match).count }
}
