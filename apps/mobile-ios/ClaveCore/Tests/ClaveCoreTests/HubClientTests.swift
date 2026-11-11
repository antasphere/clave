import XCTest
@testable import ClaveCore

final class HubClientTests: XCTestCase {
  private let issuer = IssuerConfig(origin: "https://hub.test", insecure: false)

  private func metadata(_ changes: [String: JSValue] = [:]) -> String {
    JSValue.object([
      "issuer": .string("https://hub.test"),
      "authorization_endpoint": .string("https://hub.test/authorize"),
      "token_endpoint": .string("https://hub.test/token"),
      "registration_endpoint": .string("https://hub.test/register"),
      "jwks_uri": .string("https://hub.test/jwks"),
    ].merging(changes) { _, new in new }).serialized()
  }

  private func client(_ metadata: String? = nil) async -> (HubClient, StubTransport) {
    let transport = StubTransport()
    await transport.onJSON("GET", "https://hub.test/.well-known/openid-configuration", metadata ?? self.metadata())
    return (HubClient(issuer: issuer, transport: transport), transport)
  }

  private func kind(_ run: () async throws -> Void) async -> HubError.Kind? {
    do {
      try await run()
      return nil
    } catch {
      return (error as? HubError)?.kind
    }
  }

  func testReadsTheMetadataOnce() async throws {
    let (hub, transport) = await client()
    let first = try await hub.metadata()
    _ = try await hub.metadata()
    XCTAssertEqual(first.tokenEndpoint, "https://hub.test/token")
    XCTAssertNil(first.userinfoEndpoint)
    let count = await transport.requests.count
    XCTAssertEqual(count, 1)
  }

  func testRefusesAnEndpointOffTheIssuerAndAnotherIssuer() async {
    for changes: [String: JSValue] in [
      ["token_endpoint": .string("http://127.0.0.1:1/token")],
      ["authorization_endpoint": .string("https://evil.test/authorize")],
      ["userinfo_endpoint": .string("https://hub.test.evil/userinfo")],
      ["jwks_uri": .number(1)],
    ] {
      let (hub, _) = await client(metadata(changes))
      let result = await kind { _ = try await hub.metadata() }
      XCTAssertEqual(result, .invalidResponse, "\(changes)")
    }
    let (other, _) = await client(metadata(["issuer": .string("https://evil.test")]))
    let result = await kind { _ = try await other.metadata() }
    XCTAssertEqual(result, .invalidResponse)
    var missing = JSValue.parse(metadata())!
    if case .object(var members) = missing {
      members.removeValue(forKey: "jwks_uri")
      missing = .object(members)
    }
    let (noJwks, _) = await client(missing.serialized())
    let missingResult = await kind { _ = try await noJwks.metadata() }
    XCTAssertEqual(missingResult, .invalidResponse)
  }

  func testRefusesARequestThatWouldLeaveTheOriginBeforeSendingIt() async {
    let transport = StubTransport()
    let hub = HubClient(issuer: IssuerConfig(origin: "https://hub.test", insecure: false), transport: transport)
    // The metadata URL is built from the origin; a registration endpoint off
    // it is refused at discovery, so nothing beyond the one GET is ever sent.
    await transport.onJSON("GET", "https://hub.test/.well-known/openid-configuration", metadata(["registration_endpoint": .string("https://evil.test/register")]))
    let result = await kind { _ = try await hub.register() }
    XCTAssertEqual(result, .invalidResponse)
    let urls = await transport.requests.map { $0.url!.absoluteString }
    XCTAssertEqual(urls, ["https://hub.test/.well-known/openid-configuration"])
  }

  func testRegistersWith200Or201AndSendsTheNativeRegistration() async throws {
    for status in [200, 201] {
      let (hub, transport) = await client()
      await transport.onJSON("POST", "https://hub.test/register", status: status,
        #"{"client_id":"c-1","token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"]}"#)
      let clientId = try await hub.register()
      XCTAssertEqual(clientId, "c-1")
      let sent = await transport.requests.last!
      XCTAssertEqual(sent.value(forHTTPHeaderField: "Content-Type"), "application/json")
      XCTAssertEqual(sent.timeoutInterval, 15)
      let body = JSValue.parse(sent.httpBody!)!
      XCTAssertEqual(body["client_name"], .string("Clave iOS"))
      XCTAssertEqual(body["type"], .string("native"))
      XCTAssertEqual(body["application_type"], .string("native"))
      XCTAssertEqual(body["redirect_uris"], .array([.string("clave-ios://oauth/callback")]))
      XCTAssertEqual(body["token_endpoint_auth_method"], .string("none"))
      XCTAssertEqual(body["grant_types"], .array([.string("authorization_code"), .string("refresh_token")]))
      XCTAssertEqual(body["response_types"], .array([.string("code")]))
      XCTAssertEqual(body["scope"], .string("openid profile email offline_access"))
    }
  }

  func testRefusesAConfidentialOrCodelessRegistration() async {
    for answer in [
      #"{"client_id":"c-1","client_secret":"s","grant_types":["authorization_code"]}"#,
      #"{"client_id":"c-1","token_endpoint_auth_method":"client_secret_basic","grant_types":["authorization_code"]}"#,
      #"{"client_id":"c-1","grant_types":["refresh_token"]}"#,
      #"{"client_id":"c-1"}"#,
      #"{"client_id":"","grant_types":["authorization_code"]}"#,
    ] {
      let (hub, transport) = await client()
      await transport.onJSON("POST", "https://hub.test/register", status: 201, answer)
      let result = await kind { _ = try await hub.register() }
      XCTAssertEqual(result, .registration, answer)
    }
    let (hub, transport) = await client()
    await transport.onJSON("POST", "https://hub.test/register", status: 400, #"{"error":"invalid_client_metadata"}"#)
    let refused = await kind { _ = try await hub.register() }
    XCTAssertEqual(refused, .registration)
  }

  func testBuildsTheAuthorizationURL() async throws {
    let (hub, _) = await client(metadata(["authorization_endpoint": .string("https://hub.test/authorize?prompt=login&state=old")]))
    let url = try await hub.authorizationURL(clientId: "c 1", codeChallenge: "ch", state: "st", nonce: "no")
    let fields = queryFields(url)
    XCTAssertEqual(fields.map(\.0), ["prompt", "state", "response_type", "client_id", "redirect_uri", "scope", "code_challenge", "code_challenge_method", "nonce"])
    let values = Dictionary(fields, uniquingKeysWith: { a, _ in a })
    XCTAssertEqual(values["state"], "st")
    XCTAssertEqual(values["client_id"], "c 1")
    XCTAssertEqual(values["redirect_uri"], "clave-ios://oauth/callback")
    XCTAssertEqual(values["scope"], "openid profile email offline_access")
    XCTAssertEqual(values["code_challenge_method"], "S256")
    XCTAssertTrue(url.absoluteString.contains("scope=openid+profile+email+offline_access"))
    XCTAssertTrue(url.absoluteString.contains("redirect_uri=clave-ios%3A%2F%2Foauth%2Fcallback"))
  }

  func testMapsTokenEndpointRefusals() async throws {
    let cases: [(Int, String, HubError.Kind)] = [
      (400, #"{"error":"invalid_grant"}"#, .invalidGrant),
      (401, #"{"error":"invalid_client"}"#, .invalidClient),
      (400, #"{"error":"invalid_request"}"#, .invalidResponse),
      (500, "oops", .invalidResponse),
      (200, #"{"token_type":"Bearer"}"#, .invalidResponse),
    ]
    for (status, body, expected) in cases {
      let (hub, transport) = await client()
      await transport.onJSON("POST", "https://hub.test/token", status: status, body)
      let result = await kind { _ = try await hub.refresh(clientId: "c", refreshToken: "r") }
      XCTAssertEqual(result, expected, body)
    }
  }

  func testReadsATokenAnswerAndFormEncodesTheRequest() async throws {
    let (hub, transport) = await client()
    await transport.onJSON("POST", "https://hub.test/token",
      #"{"access_token":"at","expires_in":300,"id_token":"","refresh_token":"rt","scope":"openid"}"#)
    let answer = try await hub.exchangeCode(clientId: "c", code: "a b+c", verifier: "v")
    XCTAssertEqual(answer, TokenResponse(accessToken: "at", tokenType: "Bearer", expiresIn: 300, idToken: nil, refreshToken: "rt", scope: "openid"))
    let sent = await transport.requests.last!
    XCTAssertEqual(sent.value(forHTTPHeaderField: "Content-Type"), "application/x-www-form-urlencoded")
    XCTAssertEqual(
      String(decoding: sent.httpBody!, as: UTF8.self),
      "grant_type=authorization_code&client_id=c&code=a+b%2Bc&redirect_uri=clave-ios%3A%2F%2Foauth%2Fcallback&code_verifier=v")
  }

  func testMapsTransportFailures() async {
    let (hub, transport) = await client()
    await transport.on("POST", "https://hub.test/token") { _ in throw URLError(.timedOut) }
    let timedOut = await kind { _ = try await hub.refresh(clientId: "c", refreshToken: "r") }
    XCTAssertEqual(timedOut, .timeout)
    await transport.on("POST", "https://hub.test/token") { _ in throw URLError(.notConnectedToInternet) }
    let offline = await kind { _ = try await hub.refresh(clientId: "c", refreshToken: "r") }
    XCTAssertEqual(offline, .network)
  }

  func testEnforcesTheWholeRequestDeadline() async {
    let transport = StubTransport()
    await transport.on("GET", "https://hub.test/.well-known/openid-configuration") { _ in
      try await Task.sleep(for: .seconds(10))
      return HTTPAnswer(status: 200)
    }
    let hub = HubClient(issuer: issuer, transport: transport, timeout: .milliseconds(50))
    let started = Date()
    let result = await kind { _ = try await hub.metadata() }
    XCTAssertEqual(result, .timeout)
    XCTAssertLessThan(Date().timeIntervalSince(started), 5)
  }
}
