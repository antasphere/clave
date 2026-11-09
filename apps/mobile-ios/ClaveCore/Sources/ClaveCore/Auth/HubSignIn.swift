import Foundation

// Signing in on the phone with the Antasphere account: Authorization Code
// with PKCE S256 in the platform's authentication session, the port of the
// prototype's `sign-in.ts`. The platform comes in at the wiring (the
// authentication session, the Keychain, URLSession), so the whole flow runs
// under `swift test` against a scripted hub.
//
// The flow: the stored registration for this issuer, or a new one (the hub
// purges an anonymous client unused for thirty days, so a refresh refused as
// `invalid_client` registers again at once and the person signs in again;
// the family of tokens belonged to the purged client); a verifier, a state
// and a nonce; the authorization URL handed to the authentication session,
// which comes back with `clave-ios://oauth/callback?code=…&state=…`; the
// state checked, exactly one and the one sent; the code exchanged with the
// verifier; the ID token decoded and checked by shape (IdToken.swift); the
// tokens kept. The hub rotates the refresh token on every use with no grace
// for a public client, so a refresh runs one at a time (a second ask joins
// the first) and the rotated token is written before the new access token
// is, so a crash in between loses nothing the hub still honours. A refresh
// refused as `invalid_grant` drops the whole family: the person is signed out.
//
// Renewal is lazy, on use: `accessToken()` and `idToken()` refresh when what
// they hold is within a minute of its end. A phone's process is suspended for
// hours at a time and the token is asked for when the app is in front, which
// is when it matters.
//
// The actor's suspension points play the part of the prototype's awaits: any
// state may change across one, so every answer that arrives after an await
// is checked against the epoch it started under, and a sign-out or a new
// sign-in bumps the epoch so a late answer writes nothing.

/// Where the sign-in stands.
public enum AuthPhase: String, Sendable, Equatable {
  case signedOut = "signed-out"
  case signingIn = "signing-in"
  case signedIn = "signed-in"
}

/// Why the last sign-in or renewal did not succeed.
public enum AuthFailure: String, Sendable, Equatable {
  case cancelled
  case denied
  case network
  case timeout
  case invalidResponse = "invalid-response"
  case registration
  case storage
  case configuration
  case expired
  case clientPurged = "client-purged"
}

/// What the app shows of the sign-in.
public struct AuthStatus: Sendable, Equatable {
  public let phase: AuthPhase
  public let account: StoredAccount?
  public let clientId: String?
  /// When the verified identity lapses (the ID token's `exp`); nil when signed out.
  public let expiresAt: Date?
  public let renewable: Bool
  public let issuer: String
  public let lastFailure: AuthFailure?
}

/// A sign-in operation that failed, by failure; the message never carries a token.
public struct AuthError: Error, Equatable, CustomStringConvertible {
  public let failure: AuthFailure
  public let message: String

  /// A failure with a person-readable message.
  public init(_ failure: AuthFailure, _ message: String) {
    self.failure = failure
    self.message = message
  }

  public var description: String { message }
}

/// Opens the platform's authentication session on `url` and answers the
/// redirect it came back with, or nil when the person dismissed it. A thrown
/// error is the platform's own failure.
public protocol AuthenticationSessionOpener: Sendable {
  /// The redirect URL, or nil when dismissed.
  func open(_ url: URL, callbackScheme: String) async throws -> URL?
}

private final class HubSession {
  let clientId: String
  let account: StoredAccount
  let signedInAt: Double
  var access: StoredToken?
  var id: StoredToken?
  var refreshToken: String?

  init(clientId: String, account: StoredAccount, signedInAt: Double, access: StoredToken?, id: StoredToken?, refreshToken: String?) {
    self.clientId = clientId
    self.account = account
    self.signedInAt = signedInAt
    self.access = access
    self.id = id
    self.refreshToken = refreshToken
  }
}

/// The phone's sign-in with the Antasphere account.
public actor HubSignIn {
  private let issuer: IssuerConfig?
  private let hub: HubClient?
  private let store: HubTokenStore
  private let opener: any AuthenticationSessionOpener
  private let random: any RandomSource
  private let now: @Sendable () -> Date
  private let renewAhead: TimeInterval
  private let log: @Sendable (String, [String: String]) -> Void

  private var listeners: [UUID: AsyncStream<AuthStatus>.Continuation] = [:]
  private var session: HubSession?
  private var clientId: String?
  private var lastFailure: AuthFailure?
  private var signingIn: Task<AuthStatus, Never>?
  private var refreshing: Task<Void, any Error>?
  private var restored: Task<AuthStatus, Never>?
  /// Bumped by every sign-out and new sign-in: an answer from before writes nothing.
  private var epoch = 0
  private var storageBusy = false
  private var storageWaiters: [CheckedContinuation<Void, Never>] = []

  /// A sign-in at the issuer `issuer` names (nil or empty is the hub); a
  /// refused override leaves sign-in off with the failure `configuration`.
  public init(
    issuer rawIssuer: String? = nil,
    transport: any HTTPTransport = URLSessionTransport(),
    secureStore: any SecureStore,
    opener: any AuthenticationSessionOpener,
    random: any RandomSource = SystemRandomSource(),
    now: @escaping @Sendable () -> Date = { Date() },
    renewAhead: TimeInterval = 60,
    log: @escaping @Sendable (String, [String: String]) -> Void = { _, _ in }
  ) {
    switch resolveIssuer(rawIssuer) {
    case .ok(let config):
      issuer = config
      hub = HubClient(issuer: config, transport: transport)
      lastFailure = nil
    case .refused(let reason):
      issuer = nil
      hub = nil
      lastFailure = .configuration
      log("hub.config.refused", ["reason": reason])
    }
    store = HubTokenStore(secure: secureStore)
    self.opener = opener
    self.random = random
    self.now = now
    self.renewAhead = renewAhead
    self.log = log
  }

  private var nowMs: Double { now().timeIntervalSince1970 * 1000 }

  /// Where the sign-in stands now.
  public func status() -> AuthStatus {
    let expiresAt = session?.id?.expiresAt ?? session?.access?.expiresAt
    return AuthStatus(
      phase: signingIn != nil ? .signingIn : session != nil ? .signedIn : .signedOut,
      account: session?.account,
      clientId: clientId,
      expiresAt: expiresAt.map { Date(timeIntervalSince1970: $0 / 1000) },
      renewable: session?.refreshToken != nil,
      issuer: issuer?.origin ?? "",
      lastFailure: lastFailure
    )
  }

  /// Every change of status, starting with the current one.
  public func statusStream() -> AsyncStream<AuthStatus> {
    let (stream, continuation) = AsyncStream.makeStream(of: AuthStatus.self, bufferingPolicy: .unbounded)
    let id = UUID()
    listeners[id] = continuation
    continuation.onTermination = { [weak self] _ in
      Task { await self?.removeListener(id) }
    }
    continuation.yield(status())
    return stream
  }

  private func removeListener(_ id: UUID) {
    listeners.removeValue(forKey: id)
  }

  private func emit() {
    let snapshot = status()
    for continuation in listeners.values { continuation.yield(snapshot) }
  }

  /// Takes the store to itself until `releaseStorage()`: the prototype
  /// chained its writes on one promise so a sign-out's clear always lands
  /// after a persist that started before it. Waiters are served in order.
  private func acquireStorage() async {
    if storageBusy {
      await withCheckedContinuation { storageWaiters.append($0) }
    } else {
      storageBusy = true
    }
  }

  private func releaseStorage() {
    if storageWaiters.isEmpty { storageBusy = false } else { storageWaiters.removeFirst().resume() }
  }

  /// Reads what the store holds at boot: the registration, and the session
  /// when it belongs to this issuer and this client. Runs once; never throws.
  public func restore() async -> AuthStatus {
    if let restored { return await restored.value }
    let task = Task { await self.doRestore() }
    restored = task
    return await task.value
  }

  private func doRestore() async -> AuthStatus {
    let epoch = self.epoch
    guard let issuer else { return status() }
    do {
      if let client = try await store.readClient(), client.issuer == issuer.origin { clientId = client.clientId }
      // A sign-in that ran before the restore already holds the session.
      if session != nil { return status() }
      guard let stored = try await store.readSession() else { return status() }
      if stored.issuer != issuer.origin || stored.clientId != clientId {
        log("hub.session.discarded", ["reason": "binding"])
        await acquireStorage()
        defer { releaseStorage() }
        try await store.clearSession()
        return status()
      }
      let restored = HubSession(
        clientId: stored.clientId, account: stored.account, signedInAt: stored.signedInAt,
        access: try await store.readAccessToken(), id: try await store.readIdToken(),
        refreshToken: try await store.readRefreshToken())
      if epoch != self.epoch { return status() }
      session = restored
      log("hub.session.restored", ["renewable": String(restored.refreshToken != nil)])
    } catch {
      lastFailure = .storage
      log("hub.restore.failed", [:])
    }
    emit()
    return status()
  }

  /// The client id the app registered, registering when there is none.
  public func ensureClient() async throws -> String {
    do {
      return try await obtainClient()
    } catch {
      throw AuthError(Self.classify(error), Self.message(of: error))
    }
  }

  private func obtainClient() async throws -> String {
    guard let hub, let issuer else { throw AuthError(.configuration, "The issuer is refused.") }
    if let clientId { return clientId }
    if let stored = try await store.readClient(), stored.issuer == issuer.origin {
      clientId = stored.clientId
      return stored.clientId
    }
    let registered = try await hub.register()
    try await store.writeClient(StoredClient(issuer: issuer.origin, clientId: registered, registeredAt: nowMs))
    clientId = registered
    log("hub.client.registered", [:])
    return registered
  }

  /// Signs in; one at a time, a second ask while one waits on the browser joins it.
  @discardableResult
  public func signIn() async -> AuthStatus {
    if let signingIn { return await signingIn.value }
    let task = Task { await self.runSignIn() }
    signingIn = task
    emit()
    return await task.value
  }

  private func runSignIn() async -> AuthStatus {
    await doSignIn()
    // The flag is cleared before the status is read, so the answer says where
    // the sign-in ended, never that it is still running.
    signingIn = nil
    emit()
    return status()
  }

  private func doSignIn() async {
    epoch += 1
    let epoch = self.epoch
    lastFailure = nil
    do {
      guard let hub, let issuer else { throw AuthError(.configuration, "The issuer is refused.") }
      let clientId = try await obtainClient()
      let verifier = PKCE.makeVerifier(using: random)
      let state = PKCE.randomValue(using: random)
      let nonce = PKCE.randomValue(using: random)
      let url = try await hub.authorizationURL(
        clientId: clientId, codeChallenge: PKCE.challenge(of: verifier), state: state, nonce: nonce)
      let redirect = try await opener.open(url, callbackScheme: callbackScheme)
      if self.epoch != epoch { throw AuthError(.cancelled, "The sign-in was replaced.") }
      guard let redirect else { throw AuthError(.cancelled, "The sign-in was dismissed.") }
      let code = try readCallback(redirect, state: state, issuer: issuer)
      let tokens = try await hub.exchangeCode(clientId: clientId, code: code, verifier: verifier)
      guard let idToken = tokens.idToken else { throw AuthError(.invalidResponse, "No ID token came back.") }
      let claims = try decodeIdToken(idToken)
      try checkIdToken(claims, expected: ExpectedIdToken(issuer: issuer.origin, clientId: clientId, nonce: nonce, now: now()))
      if self.epoch != epoch { throw AuthError(.cancelled, "The sign-in was replaced.") }
      let session = HubSession(
        clientId: clientId, account: Self.account(of: claims), signedInAt: nowMs,
        access: StoredToken(token: tokens.accessToken, expiresAt: accessExpiry(tokens.expiresIn, claims)),
        id: StoredToken(token: idToken, expiresAt: claims.exp * 1000),
        refreshToken: tokens.refreshToken)
      await acquireStorage()
      do {
        defer { releaseStorage() }
        if self.epoch == epoch { try await persist(session, issuer: issuer) }
      }
      if self.epoch != epoch { return }
      self.session = session
      lastFailure = nil
      log("hub.sign-in.ok", ["renewable": String(session.refreshToken != nil)])
    } catch {
      let failure = Self.classify(error)
      if self.epoch == epoch {
        lastFailure = failure
        log("hub.sign-in.failed", ["reason": failure.rawValue])
      } else {
        log("hub.sign-in.dropped", ["reason": failure.rawValue])
      }
    }
  }

  /// The code of the redirect the authentication session came back with: the
  /// redirect URI itself, exactly one `state` and the one sent, an `iss`
  /// naming this issuer when present, and no error.
  private func readCallback(_ redirect: URL, state: String, issuer: IssuerConfig) throws -> String {
    guard let url = URLComponents(url: redirect, resolvingAgainstBaseURL: false),
      let back = URLComponents(string: redirectURI)
    else { throw AuthError(.invalidResponse, "The sign-in came back with no readable address.") }
    guard url.scheme?.lowercased() == back.scheme?.lowercased(),
      url.percentEncodedHost == back.percentEncodedHost, url.port == back.port,
      url.percentEncodedPath == back.percentEncodedPath
    else { throw AuthError(.invalidResponse, "The sign-in came back somewhere else.") }
    let params = WebURL.formDecode(url.percentEncodedQuery)
    let states = params.filter { $0.0 == "state" }.map(\.1)
    guard states.count == 1, states[0] == state else {
      throw AuthError(.invalidResponse, "The sign-in came back with another state.")
    }
    if let iss = params.first(where: { $0.0 == "iss" })?.1, iss != issuer.origin {
      throw AuthError(.invalidResponse, "The sign-in came back from another issuer.")
    }
    if let error = params.first(where: { $0.0 == "error" })?.1 {
      if error == "access_denied" { throw AuthError(.denied, "The sign-in was refused.") }
      throw AuthError(.invalidResponse, "The issuer answered \(error).")
    }
    guard let code = params.first(where: { $0.0 == "code" })?.1, !code.isEmpty else {
      throw AuthError(.invalidResponse, "The sign-in came back without a code.")
    }
    return code
  }

  private func accessExpiry(_ expiresIn: Int?, _ claims: IdTokenClaims?) -> Double {
    var ends: [Double] = []
    if let expiresIn { ends.append(nowMs + Double(expiresIn) * 1000) }
    if let claims { ends.append(claims.exp * 1000) }
    return ends.min() ?? nowMs
  }

  /// The refresh token first, so a crash after it loses nothing the hub
  /// still honours; then the rest.
  private func persist(_ session: HubSession, issuer: IssuerConfig) async throws {
    do {
      if let refreshToken = session.refreshToken { try await store.writeRefreshToken(refreshToken) }
      if let access = session.access { try await store.writeAccessToken(access) }
      if let id = session.id { try await store.writeIdToken(id) }
      try await store.writeSession(
        StoredSession(issuer: issuer.origin, clientId: session.clientId, account: session.account, signedInAt: session.signedInAt))
    } catch {
      throw AuthError(.storage, "The sign-in could not be kept on this phone.")
    }
  }

  /// Forgets the login here; the hub's own session is not touched.
  @discardableResult
  public func signOut() async -> AuthStatus {
    epoch += 1
    session = nil
    lastFailure = nil
    do {
      await acquireStorage()
      defer { releaseStorage() }
      try await store.clearSession()
    } catch {
      lastFailure = .storage
    }
    log("hub.signed-out", [:])
    emit()
    return status()
  }

  /// A valid access token for the relay, renewed when within `renewAhead` of its end.
  public func accessToken() async throws -> String {
    let epoch = self.epoch
    _ = await restore()
    try assertEpoch(epoch)
    let session = try requireSession()
    if let access = session.access, !lapsing(access) { return access.token }
    try await refresh()
    try assertEpoch(epoch)
    guard let access = try requireSession().access else { throw AuthError(.expired, "Sign in again.") }
    return access.token
  }

  /// A valid ID token for pairing, renewed when within `renewAhead` of its
  /// end; a refresh that brings no ID token means a new sign-in.
  public func idToken() async throws -> String {
    let epoch = self.epoch
    _ = await restore()
    try assertEpoch(epoch)
    let session = try requireSession()
    if let id = session.id, !lapsing(id) { return id.token }
    try await refresh()
    try assertEpoch(epoch)
    guard let id = try requireSession().id, !lapsing(id) else {
      throw AuthError(.expired, "Sign in again to pair a machine.")
    }
    return id.token
  }

  /// A check captured with an owner's stores: old work cannot start a
  /// credential read after another account signs in, even when it awaited
  /// unrelated storage first.
  public func guardAccount() -> @Sendable () async throws -> Void {
    let epoch = self.epoch
    let subject = session?.account.subject
    return { [weak self] in
      guard let self else { throw AuthError(.cancelled, "The account changed.") }
      try await self.checkAccount(epoch: epoch, subject: subject)
    }
  }

  private func checkAccount(epoch: Int, subject: String?) throws {
    try assertEpoch(epoch)
    if session?.account.subject != subject { throw AuthError(.cancelled, "The account changed.") }
  }

  private func assertEpoch(_ epoch: Int) throws {
    if epoch != self.epoch { throw AuthError(.cancelled, "The account changed.") }
  }

  private func requireSession() throws -> HubSession {
    guard let session else { throw AuthError(lastFailure ?? .expired, "Sign in with your Antasphere account.") }
    return session
  }

  private func lapsing(_ token: StoredToken) -> Bool {
    token.expiresAt - renewAhead * 1000 <= nowMs
  }

  /// One refresh at a time; a second ask joins the first.
  private func refresh() async throws {
    if let refreshing { return try await refreshing.value }
    let task = Task { try await self.runRefresh() }
    refreshing = task
    try await task.value
  }

  private func runRefresh() async throws {
    defer { refreshing = nil }
    try await doRefresh()
  }

  private func doRefresh() async throws {
    let epoch = self.epoch
    guard let session, let hub, let issuer else { return }
    guard let presented = session.refreshToken else {
      await endSession(.expired)
      throw AuthError(.expired, "Your sign-in expired.")
    }
    do {
      let tokens = try await hub.refresh(clientId: session.clientId, refreshToken: presented)
      if !isCurrent(epoch, session) {
        log("hub.refresh.dropped", ["reason": "epoch"])
        return
      }
      var claims: IdTokenClaims?
      if let idToken = tokens.idToken {
        let decoded = try decodeIdToken(idToken)
        try checkIdToken(decoded, expected: ExpectedIdToken(issuer: issuer.origin, clientId: session.clientId, now: now()))
        if decoded.sub != session.account.subject {
          throw AuthError(.invalidResponse, "The renewed token names another person.")
        }
        claims = decoded
      }
      await acquireStorage()
      do {
        defer { releaseStorage() }
        if !isCurrent(epoch, session) { return }
        // The rotated token is kept before anything else is touched: the hub
        // has already retired the one this refresh presented.
        if let rotated = tokens.refreshToken {
          try await store.writeRefreshToken(rotated)
          session.refreshToken = rotated
        }
        let access = StoredToken(token: tokens.accessToken, expiresAt: accessExpiry(tokens.expiresIn, claims))
        session.access = access
        try await store.writeAccessToken(access)
        if let idToken = tokens.idToken, let claims {
          let id = StoredToken(token: idToken, expiresAt: claims.exp * 1000)
          session.id = id
          try await store.writeIdToken(id)
        }
      }
      if !isCurrent(epoch, session) { return }
      lastFailure = nil
      log("hub.refresh.ok", ["idToken": String(tokens.idToken != nil)])
      emit()
    } catch {
      let failure = Self.classify(error)
      if self.epoch != epoch {
        log("hub.refresh.dropped", ["reason": failure.rawValue])
        return
      }
      log("hub.refresh.failed", ["reason": failure.rawValue])
      switch failure {
      case .expired:
        // invalid_grant: the family is gone on the hub's side; drop it here too.
        await endSession(.expired)
        throw AuthError(.expired, "Your sign-in expired. Sign in again.")
      case .clientPurged:
        // invalid_client: the hub purged the registration; register again so
        // the next sign-in has a client, and sign the person out, since the
        // tokens belonged to the purged client.
        await endSession(.clientPurged)
        clientId = nil
        do {
          try await store.clearClient()
        } catch {
          log("hub.client.clear.failed", [:])
        }
        do {
          _ = try await obtainClient()
        } catch {
          log("hub.client.re-register.failed", ["reason": Self.classify(error).rawValue])
        }
        emit()
        throw AuthError(.clientPurged, "The hub forgot this app. Sign in again.")
      default:
        // The network's failures keep the session: the tokens may still be
        // good once the hub is reachable again.
        lastFailure = failure
        emit()
        throw AuthError(failure, "The sign-in could not be renewed.")
      }
    }
  }

  /// Whether an answer that started under `epoch` for `session` may still land.
  private func isCurrent(_ epoch: Int, _ session: HubSession) -> Bool {
    guard epoch == self.epoch else { return false }
    return self.session === session
  }

  private func endSession(_ failure: AuthFailure) async {
    session = nil
    lastFailure = failure
    do {
      await acquireStorage()
      defer { releaseStorage() }
      try await store.clearSession()
    } catch {
      lastFailure = .storage
    }
    emit()
  }

  private static func classify(_ error: any Error) -> AuthFailure {
    if let error = error as? AuthError { return error.failure }
    if let error = error as? HubError {
      switch error.kind {
      case .network: return .network
      case .timeout: return .timeout
      case .registration: return .registration
      case .invalidResponse: return .invalidResponse
      case .invalidGrant: return .expired
      case .invalidClient: return .clientPurged
      }
    }
    return .invalidResponse
  }

  private static func message(of error: any Error) -> String {
    if let error = error as? AuthError { return error.message }
    if let error = error as? HubError { return error.message }
    if let error = error as? IdTokenRefused { return error.description }
    return "The sign-in failed."
  }

  private static func account(of claims: IdTokenClaims) -> StoredAccount {
    StoredAccount(
      subject: claims.sub, name: claims.name, email: claims.email,
      emailVerified: claims.email != nil ? claims.emailVerified == true : false)
  }
}
