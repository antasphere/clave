import Foundation

/// One HTTP exchange as the core sees it: the status, the headers (names
/// lowercased) and the body. Nothing in the core reads a URLResponse.
public struct HTTPAnswer: Sendable, Equatable {
  public let status: Int
  public let headers: [String: String]
  public let body: Data

  public init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
    self.status = status
    self.headers = headers.reduce(into: [:]) { $0[$1.key.lowercased()] = $1.value }
    self.body = body
  }
}

/// How the core reaches the network: one request, one answer, or a thrown
/// error when no answer came (the network gone, the deadline passed: a
/// `URLError` with `.timedOut` for the deadline). The app hands in a
/// URLSession; a test hands in a stub that answers by script. The caller sets
/// the deadline on the request (`timeoutInterval`).
public protocol HTTPTransport: Sendable {
  func perform(_ request: URLRequest) async throws -> HTTPAnswer
}

/// The platform's URLSession behind the protocol.
public struct URLSessionTransport: HTTPTransport {
  private let session: URLSession

  public init(session: URLSession = .shared) {
    self.session = session
  }

  public func perform(_ request: URLRequest) async throws -> HTTPAnswer {
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw URLError(.badServerResponse)
    }
    var headers: [String: String] = [:]
    for (key, value) in http.allHeaderFields {
      if let name = key as? String, let text = value as? String { headers[name] = text }
    }
    return HTTPAnswer(status: http.statusCode, headers: headers, body: data)
  }
}
