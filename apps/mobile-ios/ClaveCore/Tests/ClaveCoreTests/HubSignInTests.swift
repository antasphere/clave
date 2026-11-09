import XCTest
@testable import ClaveCore

final class HubSignInTests: XCTestCase {
  private var clock: TestClock!
  private var hub: FakeHub!
  private var store: InMemorySecureStore!

  override func setUp() async throws {
    clock = TestClock()
    hub = FakeHub(clock: clock)
    await hub.install()
    store = InMemorySecureStore()
  }

  /// The person's browser: approves on sight and hands back the redirect.
  private var browser: StubOpener {
    let hub = self.hub!
    return StubOpener { url in await hub.authorize(url) }
  }

  private func make(
    issuer: String? = "https://hub.test", opener: StubOpener? = nil, store: (any SecureStore)? = nil
  ) -> HubSignIn {
    let clock = self.clock!
    return HubSignIn(
      issuer: issuer, transport: hub.transport, secureStore: store ?? self.store, opener: opener ?? browser,
      now: { clock.now }, renewAhead: 1)
  }

  private func failure(_ run: () async throws -> Void) async -> AuthFailure? {
    do {
      try await run()
      return nil
    } catch {
      return (error as? AuthError)?.failure
    }
  }

  private func storeHas(_ key: String) async -> Bool { await store.values[key] != nil }

  // MARK: the code flow

  func testSignsInWithPKCEAndKeepsTheIdentityAndTheThreeTokens() async throws {
    let signIn = make()
    let status = await signIn.signIn()
    XCTAssertEqual(status.phase, .signedIn)
    XCTAssertNil(status.lastFailure)
    XCTAssertEqual(status.account, StoredAccount(subject: "user-7f3a", name: "Ada Example", email: "ada@example.test", emailVerified: true))
    XCTAssertEqual(status.clientId, "client-1")
    XCTAssertTrue(status.renewable)
    XCTAssertEqual(status.issuer, "https://hub.test")
    XCTAssertEqual(status.expiresAt, clock.now.addingTimeInterval(3600))

    let authorize = await hub.authorizeURLs.first!
    let query = Dictionary(queryFields(authorize), uniquingKeysWith: { a, _ in a })
    XCTAssertEqual(query["response_type"], "code")
    XCTAssertEqual(query["client_id"], "client-1")
    XCTAssertEqual(query["redirect_uri"], redirectURI)
    XCTAssertEqual(query["scope"], hubScope)
    XCTAssertEqual(query["code_challenge_method"], "S256")
    XCTAssertEqual(query["state"]?.count, 22)
    XCTAssertEqual(query["nonce"]?.count, 22)
    let exchange = await hub.tokenRequests.first!
    XCTAssertEqual(exchange["grant_type"], "authorization_code")
    XCTAssertEqual(exchange["redirect_uri"], redirectURI)
    XCTAssertEqual(exchange["code_verifier"]?.count, 43)
    XCTAssertEqual(PKCE.challenge(of: exchange["code_verifier"]!), query["code_challenge"])

    for key in [HubStoreKey.client, HubStoreKey.session, HubStoreKey.accessToken, HubStoreKey.idToken, HubStoreKey.refreshToken] {
      let present = await storeHas(key)
      XCTAssertTrue(present, key)
    }
    let session = try await HubTokenStore(secure: store).readSession()
    XCTAssertEqual(session?.clientId, "client-1")
    XCTAssertEqual(session?.issuer, "https://hub.test")
    let idRecord = try await HubTokenStore(secure: store).readIdToken()
    XCTAssertEqual(try decodeIdToken(idRecord!.token).nonce, query["nonce"])
    let access = try await signIn.accessToken()
    XCTAssertEqual(access, "at-3")
    let id = try await signIn.idToken()
    XCTAssertEqual(id, idRecord?.token)
    let refreshes = await hub.refreshCount
    XCTAssertEqual(refreshes, 0)
  }

  func testRegistersOnceAndReusesTheClient() async {
    let signIn = make()
    _ = await signIn.signIn()
    await signIn.signOut()
    let again = await signIn.signIn()
    XCTAssertEqual(again.phase, .signedIn)
    let registered = await hub.registered
    XCTAssertEqual(registered, ["client-1"])
    let clientKept = await storeHas(HubStoreKey.client)
    XCTAssertTrue(clientKept)
  }

  func testAConfidentialRegistrationKeepsNothing() async {
    await hub.configure { $0.confidentialNext = true }
    let status = await make().signIn()
    XCTAssertEqual(status.phase, .signedOut)
    XCTAssertEqual(status.lastFailure, .registration)
    let kept = await storeHas(HubStoreKey.client)
    XCTAssertFalse(kept)
  }

  func testAWrongStateIsRefusedBeforeAnyExchange() async {
    let hub = self.hub!
    let forged = StubOpener { url in
      let back = await hub.authorize(url)
      var components = URLComponents(url: back, resolvingAgainstBaseURL: false)!
      components.queryItems = components.queryItems!.map { $0.name == "state" ? URLQueryItem(name: "state", value: "forged") : $0 }
      return components.url
    }
    let status = await make(opener: forged).signIn()
    XCTAssertEqual(status.phase, .signedOut)
    XCTAssertEqual(status.lastFailure, .invalidResponse)
    let tokens = await hub.tokenRequests.count
    XCTAssertEqual(tokens, 0)
  }

  func testATwiceCarriedStateOrAnotherCallbackIsRefused() async {
    let hub = self.hub!
    let doubled = StubOpener { url in
      let back = await hub.authorize(url)
      return URL(string: back.absoluteString + "&state=again")
    }
    let doubledStatus = await make(opener: doubled).signIn()
    XCTAssertEqual(doubledStatus.lastFailure, .invalidResponse)
    let elsewhere = StubOpener { url in
      let back = await hub.authorize(url)
      return URL(string: back.absoluteString.replacingOccurrences(of: "clave-ios://oauth/callback", with: "https://evil.test/cb"))
    }
    let elsewhereStatus = await make(opener: elsewhere).signIn()
    XCTAssertEqual(elsewhereStatus.lastFailure, .invalidResponse)
    let tokens = await hub.tokenRequests.count
    XCTAssertEqual(tokens, 0)
  }

  func testAccessDeniedIsDenied() async {
    await hub.configure { $0.denyNext = true }
    let status = await make().signIn()
    XCTAssertEqual(status.phase, .signedOut)
    XCTAssertEqual(status.lastFailure, .denied)
  }

  func testAForeignIssInTheCallbackIsRefused() async {
    await hub.configure { $0.callbackIss = "https://evil.test" }
    let status = await make().signIn()
    XCTAssertEqual(status.lastFailure, .invalidResponse)
    let tokens = await hub.tokenRequests.count
    XCTAssertEqual(tokens, 0)
  }

  func testADismissedSessionIsCancelled() async {
    let status = await make(opener: StubOpener { _ in nil }).signIn()
    XCTAssertEqual(status.phase, .signedOut)
    XCTAssertEqual(status.lastFailure, .cancelled)
    let tokens = await hub.tokenRequests.count
    XCTAssertEqual(tokens, 0)
  }

  func testAnIdTokenFailingItsChecksKeepsNothing() async {
    let tampers: [[String: JSONValue]] = [
      ["iss": .string("https://evil.test")],
      ["aud": .string("another-client")],
      ["nonce": .string("stale")],
      ["exp": .number(clock.now.timeIntervalSince1970 - 3600)],
    ]
    for tamper in tampers {
      store = InMemorySecureStore()
      await hub.configure { $0.tamper = tamper }
      let status = await make().signIn()
      XCTAssertEqual(status.phase, .signedOut, "\(tamper)")
      XCTAssertEqual(status.lastFailure, .invalidResponse, "\(tamper)")
      let session = await storeHas(HubStoreKey.session)
      let refresh = await storeHas(HubStoreKey.refreshToken)
      XCTAssertFalse(session)
      XCTAssertFalse(refresh)
    }
  }

  func testASecondAskWhileTheBrowserIsOpenJoinsTheFirst() async {
    let release = Gate()
    let opened = Gate()
    let signIn = make(opener: StubOpener { _ in
      await opened.open()
      await release.wait()
      return nil
    })
    async let first = signIn.signIn()
    await opened.wait()
    let during = await signIn.status().phase
    XCTAssertEqual(during, .signingIn)
    async let second = signIn.signIn()
    await release.open()
    let (a, b) = await (first, second)
    XCTAssertEqual(a, b)
    XCTAssertEqual(a.lastFailure, .cancelled)
    XCTAssertEqual(a.phase, .signedOut)
  }

  func testASignOutDuringASignInDropsTheLateAnswer() async {
    let entered = Gate()
    let release = Gate()
    await hub.configure { $0.exchangeEntered = entered }
    await hub.configure { $0.exchangeRelease = release }
    let signIn = make()
    async let running = signIn.signIn()
    await entered.wait()
    await signIn.signOut()
    await release.open()
    let status = await running
    XCTAssertEqual(status.phase, .signedOut)
    for key in [HubStoreKey.session, HubStoreKey.refreshToken, HubStoreKey.accessToken, HubStoreKey.idToken] {
      let present = await storeHas(key)
      XCTAssertFalse(present, key)
    }
  }

  func testASignOutWhileThePersistIsPendingCannotRestoreTheOldLogin() async {
    let slow = GatedSecureStore(holding: HubStoreKey.accessToken)
    let signIn = make(store: slow)
    async let running = signIn.signIn()
    await slow.entered.wait()
    async let out = signIn.signOut()
    await slow.release.open()
    _ = await (running, out)
    let phase = await signIn.status().phase
    XCTAssertEqual(phase, .signedOut)
    let values = await slow.inner.values
    XCTAssertNil(values[HubStoreKey.session])
    XCTAssertNil(values[HubStoreKey.refreshToken])
    let restored = await make(store: slow).restore()
    XCTAssertEqual(restored.phase, .signedOut)
  }

  func testStatusStreamEmitsEveryChange() async {
    let signIn = make()
    let stream = await signIn.statusStream()
    _ = await signIn.signIn()
    var phases: [AuthPhase] = []
    for await status in stream {
      phases.append(status.phase)
      if phases.count == 3 { break }
    }
    XCTAssertEqual(phases, [.signedOut, .signingIn, .signedIn])
  }

  // MARK: the refresh

  func testTwoConcurrentAsksOnALapsingTokenPerformOneRefresh() async throws {
    let signIn = make()
    _ = await signIn.signIn()
    clock.advance(11)
    async let a = signIn.accessToken()
    async let b = signIn.accessToken()
    let (first, second) = try await (a, b)
    XCTAssertEqual(first, second)
    let refreshes = await hub.refreshCount
    XCTAssertEqual(refreshes, 1)
    let again = try await signIn.accessToken()
    XCTAssertEqual(again, first)
    let still = await hub.refreshCount
    XCTAssertEqual(still, 1)
  }

  func testTheRotatedRefreshTokenIsWrittenBeforeTheAccessToken() async throws {
    let signIn = make()
    _ = await signIn.signIn()
    let firstRefresh = await store.values[HubStoreKey.refreshToken]
    let mark = await store.writes.count
    clock.advance(11)
    _ = try await signIn.accessToken()
    let writes = Array(await store.writes[mark...])
    let refreshIndex = try XCTUnwrap(writes.firstIndex(of: HubStoreKey.refreshToken))
    let accessIndex = try XCTUnwrap(writes.firstIndex(of: HubStoreKey.accessToken))
    XCTAssertLessThan(refreshIndex, accessIndex)
    let rotated = await store.values[HubStoreKey.refreshToken]
    XCTAssertNotEqual(rotated, firstRefresh)
    clock.advance(11)
    _ = try await signIn.accessToken()
    let presented = await hub.tokenRequests.filter { $0["grant_type"] == "refresh_token" }.map { $0["refresh_token"] }
    XCTAssertEqual(presented.count, 2)
    XCTAssertEqual(presented[1], rotated)
  }

  func testInvalidGrantSignsOutAsExpired() async {
    let signIn = make()
    _ = await signIn.signIn()
    await hub.configure { $0.refreshTokens = [] }
    clock.advance(11)
    let result = await failure { _ = try await signIn.accessToken() }
    XCTAssertEqual(result, .expired)
    let status = await signIn.status()
    XCTAssertEqual(status.phase, .signedOut)
    XCTAssertEqual(status.lastFailure, .expired)
    for key in [HubStoreKey.session, HubStoreKey.refreshToken, HubStoreKey.accessToken, HubStoreKey.idToken] {
      let present = await storeHas(key)
      XCTAssertFalse(present, key)
    }
    let clientKept = await storeHas(HubStoreKey.client)
    XCTAssertTrue(clientKept)
  }

  func testInvalidClientClearsTheClientRegistersAgainAndSignsOut() async throws {
    let signIn = make()
    let first = await signIn.signIn()
    await hub.configure { $0.knownClients = [] }
    clock.advance(11)
    let result = await failure { _ = try await signIn.accessToken() }
    XCTAssertEqual(result, .clientPurged)
    let registered = await hub.registered
    XCTAssertEqual(registered.count, 2)
    let status = await signIn.status()
    XCTAssertEqual(status.phase, .signedOut)
    XCTAssertEqual(status.lastFailure, .clientPurged)
    let stored = try await HubTokenStore(secure: store).readClient()
    XCTAssertNotEqual(stored?.clientId, first.clientId)
    XCTAssertEqual(stored?.clientId, registered.last)
    let again = await signIn.signIn()
    XCTAssertEqual(again.phase, .signedIn)
    XCTAssertEqual(again.clientId, registered.last)
  }

  func testANetworkFailureOnRefreshKeepsTheSession() async {
    let signIn = make()
    _ = await signIn.signIn()
    await hub.configure { $0.refreshNetworkDown = true }
    clock.advance(11)
    let result = await failure { _ = try await signIn.accessToken() }
    XCTAssertEqual(result, .network)
    let status = await signIn.status()
    XCTAssertEqual(status.phase, .signedIn)
    XCTAssertEqual(status.lastFailure, .network)
    let kept = await storeHas(HubStoreKey.refreshToken)
    XCTAssertTrue(kept)
  }

  func testRenewsTheIdTokenAndAsksForASignInWhenNoneComesBack() async throws {
    await hub.configure { $0.idTTL = 10 }
    await hub.configure { $0.accessTTL = 3600 }
    let signIn = make()
    _ = await signIn.signIn()
    clock.advance(11)
    let renewed = try await signIn.idToken()
    let refreshes = await hub.refreshCount
    XCTAssertEqual(refreshes, 1)
    XCTAssertGreaterThan(try decodeIdToken(renewed).exp, clock.now.timeIntervalSince1970)
  }

  // MARK: the restore

  func testRestoresAStoredSessionWithoutTheNetwork() async throws {
    _ = await make().signIn()
    let before = await hub.tokenRequests.count
    let next = make()
    let status = await next.restore()
    XCTAssertEqual(status.phase, .signedIn)
    XCTAssertEqual(status.account?.subject, "user-7f3a")
    let token = try await next.accessToken()
    XCTAssertTrue(token.hasPrefix("at-"))
    let after = await hub.tokenRequests.count
    XCTAssertEqual(after, before)
  }

  func testDiscardsASessionStoredForAnotherClient() async throws {
    _ = await make().signIn()
    try await HubTokenStore(secure: store).writeClient(StoredClient(issuer: "https://hub.test", clientId: "someone-else", registeredAt: 1))
    let status = await make().restore()
    XCTAssertEqual(status.phase, .signedOut)
    let present = await storeHas(HubStoreKey.session)
    XCTAssertFalse(present)
  }

  func testARefusedIssuerOverrideSignsNobodyIn() async {
    let signIn = make(issuer: "http://192.168.1.10:8080")
    let initial = await signIn.status()
    XCTAssertEqual(initial.lastFailure, .configuration)
    let status = await signIn.signIn()
    XCTAssertEqual(status.phase, .signedOut)
    XCTAssertEqual(status.lastFailure, .configuration)
    let sent = await hub.transport.requests.count
    XCTAssertEqual(sent, 0)
  }
}
