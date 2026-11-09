import Foundation

/// The notifications of one owner on their way to the navigator. A response
/// can arrive before the screens exist (a cold launch from a tap, an action
/// answered in the background): the destination is kept in the owner's
/// key-value store until the app opens on it, and consumed once.
public actor NotificationInbox {
  /// The key-value key the pending destination is kept under.
  public static let pendingKey = "clave.pending-notification"

  private let store: any KeyValueStore
  private var seen: [String] = []
  private var queued: NotificationDestination?
  private var navigate: (@Sendable (NotificationDestination) -> Void)?
  private var closed = false
  private var tail: Task<Void, Never>?

  /// An inbox over `store`, already scoped to one owner by the caller.
  public init(store: any KeyValueStore) {
    self.store = store
  }

  /// Handles one response once: `respond` runs for a response key not seen
  /// before (the notification's identifier, its date and the action), and its
  /// destination is kept, then handed to the navigator when there is one.
  public func receive(key: String, respond: @escaping @Sendable () async -> NotificationDestination?) async {
    await serialized {
      guard await !self.isClosed, await !self.hasSeen(key) else { return }
      let destination = await respond()
      await self.accept(key: key, destination)
    }
  }

  /// The destination a cold launch opens on, consumed: a later launch does
  /// not open it again. An explicit deep link the platform launched with wins,
  /// as it does without notifications, and the stored one is dropped.
  public func launchDestination(explicitURL: URL? = nil) async -> NotificationDestination? {
    await serialized {
      let stored = await self.takeQueuedOrStored()
      if let url = explicitURL, DeepLink.parse(url) != nil { return nil }
      return stored
    }
  }

  /// The navigator is mounted: what is queued goes to it now, later ones as they come.
  public func ready(navigate: @escaping @Sendable (NotificationDestination) -> Void) async {
    self.navigate = navigate
    await serialized { await self.flush() }
  }

  /// The owner's screens are gone: nothing is navigated any more.
  public func close() {
    closed = true
    navigate = nil
  }

  /// Waits until every response handed in so far is handled.
  public func idle() async {
    await tail?.value
  }

  // MARK: internals

  private var isClosed: Bool { closed }
  private func hasSeen(_ key: String) -> Bool { seen.contains(key) }

  private func accept(key: String, _ destination: NotificationDestination?) async {
    if let destination {
      if let encoded = try? ContractJSON.encodeToString(destination) {
        try? await store.set(Self.pendingKey, encoded)
      }
      queued = destination
    }
    seen.append(key)
    if seen.count > 64 { seen.removeFirst() }
    await flush()
  }

  private func takeQueuedOrStored() async -> NotificationDestination? {
    let raw = try? await store.get(Self.pendingKey)
    let destination = queued ?? Self.decode(raw ?? nil)
    queued = nil
    if raw ?? nil != nil { try? await store.remove(Self.pendingKey) }
    return destination
  }

  private func flush() async {
    guard !closed, let navigate, let destination = queued else { return }
    queued = nil
    navigate(destination)
    try? await store.remove(Self.pendingKey)
  }

  /// A damaged pending destination never stops the account opening.
  static func decode(_ raw: String?) -> NotificationDestination? {
    guard let raw else { return nil }
    return try? JSONDecoder().decode(NotificationDestination.self, from: Data(raw.utf8))
  }

  private func serialized<T: Sendable>(_ run: @escaping @Sendable () async -> T) async -> T {
    let previous = tail
    let task = Task {
      await previous?.value
      return await run()
    }
    tail = Task { _ = await task.value }
    return await task.value
  }
}

/// The routes a push-token registration calls on a machine.
public protocol PushTokenRoutes: Sendable {
  func setPushToken(_ token: String, platform: DevicePlatform) async throws
  func clearPushToken() async throws
}

extension ClaveServerClient: PushTokenRoutes {
  public func setPushToken(_ token: String, platform: DevicePlatform) async throws {
    try await devices.setPushToken(token, platform: platform)
  }
  public func clearPushToken() async throws { try await devices.clearPushToken() }
}

/// What registering the token with one machine came to.
public enum TokenRegistration: Sendable, Equatable {
  case registered(token: String)
  /// The machine already holds this token: nothing was sent.
  case unchanged
  /// The machine could not be told; a retry is recorded.
  case failed(reason: String)
}

/// How a sign-out's clearing went.
public struct PushCleanupResult: Sendable, Equatable {
  /// How many machines still hold the token and are retried later.
  public let pending: Int
}

/// The APNs device token, as the hex string the server registers.
public func apnsTokenString(_ token: Data) -> String {
  token.map { String(format: "%02x", $0) }.joined()
}

/// The device token registered with every paired machine, so its server can
/// push to this phone: once per token value per machine, again when the
/// platform hands a new one, a retry recorded for a machine that was
/// unreachable. On sign-out each machine is told to forget the token with
/// the credential captured before the pairing is forgotten, so a later
/// account's pairing can never be used to clear (or keep) the earlier one's.
public actor PushTokenRegistry {
  /// The key-value key of the token last registered with a machine.
  public static func tokenKey(_ machineId: String) -> String { "clave.push-token:\(machineId)" }
  /// The machines a registration is owed to.
  public static let retryKey = "clave.push-token.retry"
  /// The opaque references of the clears owed after a sign-out.
  public static let cleanupKey = "clave.pending-push-cleanup"

  private let store: any KeyValueStore
  private let platform: DevicePlatform

  /// A registry over the owner's key-value store.
  public init(store: any KeyValueStore, platform: DevicePlatform = .ios) {
    self.store = store
    self.platform = platform
  }

  /// Registers `token` with one machine, unless it already holds it.
  public func register(_ token: String, machineId: String, routes: any PushTokenRoutes) async -> TokenRegistration {
    if (try? await store.get(Self.tokenKey(machineId))) == token {
      await forgetRetry(machineId)
      return .unchanged
    }
    do {
      try await routes.setPushToken(token, platform: platform)
    } catch {
      await recordRetry(machineId)
      return .failed(reason: (error as? ServerError)?.message ?? "\(error)")
    }
    try? await store.set(Self.tokenKey(machineId), token)
    await forgetRetry(machineId)
    return .registered(token: token)
  }

  /// Registers `token` with every machine of `machineIds`, through each machine's own credential.
  public func registerEverywhere(
    _ token: String, machineIds: [String], credentials: any CredentialStore,
    routes: @Sendable (Credential) throws -> any PushTokenRoutes
  ) async -> [String: TokenRegistration] {
    var outcomes: [String: TokenRegistration] = [:]
    for machineId in machineIds {
      guard let credential = try? await credentials.get(machineId), let client = try? routes(credential) else {
        outcomes[machineId] = .failed(reason: "No credential is kept for this machine.")
        continue
      }
      outcomes[machineId] = await register(token, machineId: machineId, routes: client)
    }
    return outcomes
  }

  /// The machines a registration is still owed to.
  public func retries() async -> [String] {
    await readList(Self.retryKey)
  }

  /// Tells one machine to forget the token, and forgets it here.
  public func clear(machineId: String, routes: any PushTokenRoutes) async throws {
    try await routes.clearPushToken()
    try? await store.remove(Self.tokenKey(machineId))
    await forgetRetry(machineId)
  }

  /// The sign-out's clearing. The credentials of `machineIds` are first copied
  /// into `cleanupCredentials` under opaque references, before any pairing
  /// is forgotten; only the references enter the key-value store. Then every
  /// owed clear is tried; the ones that fail stay owed, the others are dropped
  /// with their copied credential. Called again with no machines, it retries.
  public func clearRegistrations(
    _ machineIds: [String], credentials: any CredentialStore, cleanupCredentials: any CredentialStore,
    routes: @Sendable (Credential) throws -> any PushTokenRoutes
  ) async throws -> PushCleanupResult {
    var refs = await readList(Self.cleanupKey)
    for machineId in machineIds {
      guard let credential = try await credentials.get(machineId) else { continue }
      var retained = false
      for ref in refs where try await cleanupCredentials.get(ref) == credential { retained = true }
      if !retained {
        let ref = "push-cleanup-\(UUID().uuidString.lowercased())"
        try await cleanupCredentials.set(ref, credential)
        refs.append(ref)
      }
    }
    try await writeList(Self.cleanupKey, refs)
    // A later pairing or a same-owner sign-in must register again.
    for machineId in machineIds {
      try? await store.remove(Self.tokenKey(machineId))
      await forgetRetry(machineId)
    }
    var pending: [String] = []
    var cleared: [String] = []
    for ref in refs {
      do {
        guard let credential = try await cleanupCredentials.get(ref) else { continue }
        try await routes(credential).clearPushToken()
        cleared.append(ref)
      } catch {
        pending.append(ref)
      }
    }
    // The owed list is written before the copies are dropped, so a crash in between owes too much, never too little.
    try await writeList(Self.cleanupKey, pending)
    for ref in cleared { try? await cleanupCredentials.remove(ref) }
    return PushCleanupResult(pending: pending.count)
  }

  private func recordRetry(_ machineId: String) async {
    var ids = await readList(Self.retryKey)
    if !ids.contains(machineId) {
      ids.append(machineId)
      try? await writeList(Self.retryKey, ids)
    }
  }

  private func forgetRetry(_ machineId: String) async {
    let ids = await readList(Self.retryKey)
    if ids.contains(machineId) { try? await writeList(Self.retryKey, ids.filter { $0 != machineId }) }
  }

  private func readList(_ key: String) async -> [String] {
    guard let raw = try? await store.get(key) else { return [] }
    return (try? JSONDecoder().decode([String].self, from: Data(raw.utf8))) ?? []
  }

  private func writeList(_ key: String, _ values: [String]) async throws {
    if values.isEmpty {
      try await store.remove(key)
    } else {
      try await store.set(key, String(decoding: try JSONEncoder().encode(values), as: UTF8.self))
    }
  }
}
