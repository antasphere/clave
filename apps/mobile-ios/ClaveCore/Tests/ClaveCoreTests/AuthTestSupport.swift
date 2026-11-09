import Foundation
@testable import ClaveCore

/// Answers requests by (method, URL without its query) script, and records
/// every request it was handed.
actor StubTransport: HTTPTransport {
  typealias Handler = @Sendable (URLRequest) async throws -> HTTPAnswer

  private var routes: [String: Handler] = [:]
  private(set) var requests: [URLRequest] = []

  static func key(_ method: String, _ url: URL) -> String {
    var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
    components.query = nil
    components.fragment = nil
    return "\(method) \(components.string!)"
  }

  func on(_ method: String, _ url: String, _ handler: @escaping Handler) {
    routes[Self.key(method, URL(string: url)!)] = handler
  }

  func onJSON(_ method: String, _ url: String, status: Int = 200, _ body: String) {
    on(method, url) { _ in HTTPAnswer(status: status, headers: ["Content-Type": "application/json"], body: Data(body.utf8)) }
  }

  func perform(_ request: URLRequest) async throws -> HTTPAnswer {
    requests.append(request)
    guard let handler = routes[Self.key(request.httpMethod ?? "GET", request.url!)] else {
      return HTTPAnswer(status: 404)
    }
    return try await handler(request)
  }
}

/// A one-shot latch: `wait()` returns once `open()` has been called.
actor Gate {
  private var isOpen = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    if isOpen { return }
    await withCheckedContinuation { waiters.append($0) }
  }

  func open() {
    isOpen = true
    for waiter in waiters { waiter.resume() }
    waiters = []
  }
}

/// A clock a test moves by hand.
final class TestClock: @unchecked Sendable {
  private let lock = NSLock()
  private var current: Date

  init(_ start: Date = Date(timeIntervalSince1970: 1_900_000_000)) {
    current = start
  }

  var now: Date { lock.withLock { current } }
  func advance(_ seconds: TimeInterval) { lock.withLock { current = current.addingTimeInterval(seconds) } }
}

/// The authentication session, played by a closure.
struct StubOpener: AuthenticationSessionOpener {
  let respond: @Sendable (URL) async throws -> URL?
  func open(_ url: URL, callbackScheme: String) async throws -> URL? { try await respond(url) }
}

/// Pins random bytes: every call answers `count` copies of the next byte.
final class CountingRandom: RandomSource, @unchecked Sendable {
  private let lock = NSLock()
  private var next: UInt8 = 1
  func bytes(_ count: Int) -> [UInt8] {
    lock.withLock {
      defer { next &+= 1 }
      return [UInt8](repeating: next, count: count)
    }
  }
}

func formFields(_ request: URLRequest) -> [String: String] {
  let body = request.httpBody.map { String(decoding: $0, as: UTF8.self) } ?? ""
  return Dictionary(WebURL.formDecode(body), uniquingKeysWith: { first, _ in first })
}

func queryFields(_ url: URL) -> [(String, String)] {
  WebURL.formDecode(URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery)
}

func makeIdToken(header: [String: JSValue] = ["alg": .string("RS256"), "typ": .string("JWT")], payload: [String: JSValue]) -> String {
  let segment = { (value: [String: JSValue]) in Base64URL.encode(Data(JSValue.object(value).serialized().utf8)) }
  return "\(segment(header)).\(segment(payload)).\(Base64URL.encode([1, 2, 3, 4]))"
}

/// A scripted hub at https://hub.test over a StubTransport: discovery,
/// registration, authorize (played by `authorize`), and the token endpoint
/// with PKCE, rotation and the two refusals.
actor FakeHub {
  let issuer = "https://hub.test"
  let clock: TestClock
  let transport = StubTransport()

  var registered: [String] = []
  var knownClients: Set<String> = []
  var refreshTokens: Set<String> = []
  var tokenRequests: [[String: String]] = []
  var authorizeURLs: [URL] = []
  var codes: [String: (clientId: String, nonce: String, challenge: String)] = [:]
  var counter = 0

  var subject = "user-7f3a"
  var accessTTL: Double = 10
  var idTTL: Double = 3600
  var confidentialNext = false
  var grantTypesOverride: [String]?
  var registrationStatus = 201
  var denyNext = false
  var callbackIss: String?
  var tamper: [String: JSValue] = [:]
  var refreshNetworkDown = false
  var exchangeEntered: Gate?
  var exchangeRelease: Gate?

  init(clock: TestClock) {
    self.clock = clock
  }

  func configure(_ change: @Sendable (isolated FakeHub) -> Void) { change(self) }

  var refreshCount: Int { tokenRequests.filter { $0["grant_type"] == "refresh_token" }.count }

  func install(tokenEndpoint: String? = nil) async {
    let issuer = self.issuer
    await transport.onJSON(
      "GET", "\(issuer)/.well-known/openid-configuration",
      JSValue.object([
        "issuer": .string(issuer),
        "authorization_endpoint": .string("\(issuer)/authorize"),
        "token_endpoint": .string(tokenEndpoint ?? "\(issuer)/token"),
        "registration_endpoint": .string("\(issuer)/register"),
        "jwks_uri": .string("\(issuer)/jwks"),
      ]).serialized())
    await transport.on("POST", "\(issuer)/register") { [unowned self] request in await self.register(request) }
    await transport.on("POST", "\(issuer)/token") { [unowned self] request in try await self.token(request) }
  }

  private func json(_ status: Int, _ value: JSValue) -> HTTPAnswer {
    HTTPAnswer(status: status, headers: ["content-type": "application/json"], body: Data(value.serialized().utf8))
  }

  private func register(_ request: URLRequest) -> HTTPAnswer {
    counter += 1
    let clientId = "client-\(counter)"
    registered.append(clientId)
    knownClients.insert(clientId)
    var answer: [String: JSValue] = [
      "client_id": .string(clientId),
      "token_endpoint_auth_method": .string("none"),
      "grant_types": .array((grantTypesOverride ?? ["authorization_code", "refresh_token"]).map(JSValue.string)),
    ]
    if confidentialNext {
      confidentialNext = false
      answer["client_secret"] = .string("s3cret")
    }
    return json(registrationStatus, .object(answer))
  }

  /// The person's browser at the authorization endpoint: approves on sight
  /// and answers the redirect.
  func authorize(_ url: URL) -> URL {
    authorizeURLs.append(url)
    let query = Dictionary(queryFields(url), uniquingKeysWith: { a, _ in a })
    let state = query["state"] ?? ""
    var callback = URLComponents(string: query["redirect_uri"] ?? "")!
    var items = [URLQueryItem(name: "state", value: state), URLQueryItem(name: "iss", value: callbackIss ?? issuer)]
    if denyNext {
      denyNext = false
      items.insert(URLQueryItem(name: "error", value: "access_denied"), at: 0)
    } else {
      counter += 1
      let code = "code-\(counter)"
      codes[code] = (query["client_id"] ?? "", query["nonce"] ?? "", query["code_challenge"] ?? "")
      items.insert(URLQueryItem(name: "code", value: code), at: 0)
    }
    callback.queryItems = items
    return callback.url!
  }

  private func token(_ request: URLRequest) async throws -> HTTPAnswer {
    let form = formFields(request)
    tokenRequests.append(form)
    let clientId = form["client_id"] ?? ""
    if form["grant_type"] == "authorization_code" {
      if let entered = exchangeEntered, let release = exchangeRelease {
        await entered.open()
        await release.wait()
      }
      guard let code = form["code"], let grant = codes.removeValue(forKey: code), grant.clientId == clientId,
        PKCE.challenge(of: form["code_verifier"] ?? "") == grant.challenge
      else { return json(400, .object(["error": .string("invalid_grant")])) }
      return issue(clientId: clientId, nonce: grant.nonce)
    }
    if refreshNetworkDown { throw URLError(.notConnectedToInternet) }
    guard knownClients.contains(clientId) else { return json(401, .object(["error": .string("invalid_client")])) }
    guard let presented = form["refresh_token"], refreshTokens.remove(presented) != nil else {
      return json(400, .object(["error": .string("invalid_grant")]))
    }
    return issue(clientId: clientId, nonce: nil)
  }

  private func issue(clientId: String, nonce: String?) -> HTTPAnswer {
    counter += 1
    let now = clock.now.timeIntervalSince1970.rounded(.down)
    var payload: [String: JSValue] = [
      "iss": .string(issuer), "sub": .string(subject), "aud": .string(clientId),
      "exp": .number(now + idTTL), "iat": .number(now),
      "name": .string("Ada Example"), "email": .string("ada@example.test"), "email_verified": .bool(true),
    ]
    if let nonce { payload["nonce"] = .string(nonce) }
    payload.merge(tamper) { _, new in new }
    let refresh = "rt-\(counter)"
    refreshTokens.insert(refresh)
    return json(200, .object([
      "access_token": .string("at-\(counter)"), "token_type": .string("Bearer"),
      "expires_in": .number(accessTTL), "id_token": .string(makeIdToken(payload: payload)),
      "refresh_token": .string(refresh), "scope": .string(hubScope),
    ]))
  }
}

/// A secure store whose writes of one key wait on a gate.
actor GatedSecureStore: SecureStore {
  let inner = InMemorySecureStore()
  let key: String
  let entered = Gate()
  let release = Gate()

  init(holding key: String) {
    self.key = key
  }

  func get(_ key: String) async throws -> String? { try await inner.get(key) }
  func set(_ key: String, _ value: String) async throws {
    if key == self.key {
      await entered.open()
      await release.wait()
    }
    try await inner.set(key, value)
  }
  func delete(_ key: String) async throws { try await inner.delete(key) }
}
