import Foundation

/// One message off a socket: text, bytes, or the close with its code.
public enum WebSocketMessage: Sendable, Equatable {
  case text(String)
  case data(Data)
  case closed(code: Int, reason: String)
}

/// One open socket. `receive` answers `.closed` once the peer has closed it.
public protocol WebSocketConnection: Sendable {
  /// Sends one text frame.
  func send(_ text: String) async throws
  /// The next message, or `.closed(code:reason:)` once the socket is gone.
  func receive() async throws -> WebSocketMessage
  /// Closes the socket with `code`; further receives answer or throw at once.
  func close(code: Int)
}

/// How the core opens a socket: the platform's URLSession on the phone, a script in the tests.
public protocol WebSocketTransport: Sendable {
  /// Opens a socket to `url` with extra handshake `headers`.
  func connect(_ url: URL, headers: [String: String]) async throws -> any WebSocketConnection
}

/// The platform's URLSessionWebSocketTask behind the protocol.
public struct URLSessionWebSocketTransport: WebSocketTransport {
  private let session: URLSession

  /// Sockets opened on `session`.
  public init(session: URLSession = .shared) {
    self.session = session
  }

  public func connect(_ url: URL, headers: [String: String]) async throws -> any WebSocketConnection {
    var request = URLRequest(url: url)
    for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
    let task = session.webSocketTask(with: request)
    task.resume()
    return URLSessionWebSocketConnection(task: task)
  }
}

/// One URLSessionWebSocketTask. The task is thread-safe; the wrapper holds nothing else.
final class URLSessionWebSocketConnection: WebSocketConnection, @unchecked Sendable {
  private let task: URLSessionWebSocketTask

  init(task: URLSessionWebSocketTask) {
    self.task = task
  }

  func send(_ text: String) async throws {
    try await task.send(.string(text))
  }

  func receive() async throws -> WebSocketMessage {
    do {
      switch try await task.receive() {
      case .string(let text): return .text(text)
      case .data(let data): return .data(data)
      @unknown default: return .data(Data())
      }
    } catch {
      // A receive fails once the socket is closed; the close code the peer
      // sent is on the task, and that code is what the caller acts on.
      if task.closeCode != .invalid {
        let reason = task.closeReason.map { String(decoding: $0, as: UTF8.self) } ?? ""
        return .closed(code: task.closeCode.rawValue, reason: reason)
      }
      throw error
    }
  }

  func close(code: Int) {
    let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure
    task.cancel(with: closeCode, reason: nil)
  }
}
