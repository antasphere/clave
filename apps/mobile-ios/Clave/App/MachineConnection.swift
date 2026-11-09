import ClaveCore
import Foundation
import Observation

/// One paired machine, reached: its server client, its push channel, and
/// what the screens read of it (the workspaces, the sessions, the pending
/// requests), kept current from the channel's events. One per machine,
/// created on demand by `AppModel` and stopped when its owner signs out or
/// the machine is forgotten.
@Observable @MainActor final class MachineConnection {
  enum State: Equatable, Sendable {
    case connecting
    case connected
    /// Unreachable for now; the push channel keeps trying on its own.
    case offline(reason: String)
    /// The machine no longer accepts this phone: the person pairs again.
    case unpaired(reason: String)
  }

  let machineId: String
  /// The machine as last listed, when it was.
  private(set) var machine: Machine?
  /// What the pairing kept: the server's id and name.
  private(set) var record: EnrollmentRecord?
  let client: ClaveServerClient
  let push: PushClient
  let ownerKeyValueStore: OwnerScopedKeyValueStore

  private(set) var state: State = .connecting
  private(set) var workspaces: WorkspaceStateView?
  private(set) var sessions: [Session] = []
  private(set) var requests: [PendingRequest] = []
  /// The last call that failed, as the server or the network said it.
  private(set) var lastError: String?
  /// The server keeps no request list (`CapabilityUnavailable` on the read); cleared by a read that succeeds.
  private(set) var requestsUnavailable = false

  /// The machine's name for a title: the listing's, else the pairing's.
  var name: String { machine?.name ?? record.map { $0.serverName.isEmpty ? machineId : $0.serverName } ?? machineId }

  /// Called after every foreground resume and every reconnection, for the
  /// conversations to catch up on what they missed.
  @ObservationIgnored var onResume: [() async -> Void] = []
  /// Told when the machine stopped accepting this phone.
  @ObservationIgnored var onUnpaired: ((String) -> Void)?

  @ObservationIgnored private let credentials: any CredentialStore
  @ObservationIgnored private let records: EnrollmentRecords
  @ObservationIgnored private var consumer: Task<Void, Never>?
  @ObservationIgnored private var listeners: [UUID: AsyncStream<PushEvent>.Continuation] = [:]
  @ObservationIgnored private var started = false
  @ObservationIgnored private var stopped = false
  @ObservationIgnored private var sawDisconnect = false
  @ObservationIgnored private var requestsRevision: Double = -1

  /// A connection over `credential`; throws `TransportPolicyError` when this
  /// build sends no credential to its address.
  init(
    machineId: String, credential: Credential, machine: Machine?, record: EnrollmentRecord?,
    environment: AppEnvironment, credentials: any CredentialStore, records: EnrollmentRecords,
    ownerKeyValueStore: OwnerScopedKeyValueStore
  ) throws {
    self.machineId = machineId
    self.machine = machine
    self.record = record
    self.credentials = credentials
    self.records = records
    self.ownerKeyValueStore = ownerKeyValueStore
    client = try ClaveServerClient(credential: credential, transport: environment.transport, build: environment.buildKind)
    let bearer = credential.bearer
    push = try PushClient(
      url: machine?.pushUrl ?? pushURL(of: credential.serverUrl), bearer: { bearer },
      transport: environment.webSocketTransport, build: environment.buildKind)
  }

  func update(machine: Machine?, record: EnrollmentRecord?) {
    if let machine { self.machine = machine }
    if let record { self.record = record }
  }

  // MARK: lifecycle

  /// Opens the push channel and loads the machine's state; a second call does nothing.
  func start() async {
    guard !started, !stopped else { return }
    started = true
    state = .connecting
    let events = push.events
    consumer = Task { [weak self] in
      for await event in events {
        guard let self else { return }
        await self.handle(event)
      }
    }
    await push.start()
    await reload()
  }

  /// Ends the channel; the connection is done and a new one is made to reach the machine again.
  func stop() {
    guard !stopped else { return }
    stopped = true
    consumer?.cancel()
    consumer = nil
    let push = self.push
    Task { await push.stop() }
    for listener in listeners.values { listener.finish() }
    listeners.removeAll()
  }

  /// The app came back to the foreground: a fresh read of everything, and
  /// the conversations told to catch up. A suspended socket is reopened by
  /// the push client itself.
  func resume() async {
    guard started, !stopped, !isUnpaired else { return }
    await push.start()
    await reload()
    await runResumeHooks()
  }

  var isUnpaired: Bool {
    if case .unpaired = state { return true }
    return false
  }

  /// Every push event from now on, for a screen that needs the frames
  /// themselves (a conversation's stream). Finished when the connection stops.
  func events() -> AsyncStream<PushEvent> {
    let (stream, continuation) = AsyncStream.makeStream(of: PushEvent.self, bufferingPolicy: .unbounded)
    guard !stopped else {
      continuation.finish()
      return stream
    }
    let id = UUID()
    listeners[id] = continuation
    continuation.onTermination = { [weak self] _ in
      Task { @MainActor in self?.listeners.removeValue(forKey: id) }
    }
    return stream
  }

  // MARK: reads

  func reload() async {
    async let workspaces: Void = reloadWorkspaces()
    async let sessions: Void = reloadSessions()
    async let requests: Void = reloadRequests()
    _ = await (workspaces, sessions, requests)
  }

  func reloadWorkspaces() async {
    if let value = await call({ try await $0.workspaces.load() }) { workspaces = value }
  }

  /// Every session of the server; the prototype asks for no window's alone.
  func reloadSessions() async {
    if let value = await call({ try await $0.sessions.list() }) { sessions = value }
  }

  func reloadRequests() async {
    var unavailable = false
    let snapshot = await call({ try await $0.requests.pending() }) { error in
      // A server without the list is not a failure to show everywhere: the Requests screen says it.
      unavailable = (error as? ServerError)?.capabilityUnavailable == true
      return unavailable
    }
    if let snapshot {
      requestsUnavailable = false
      requestsRevision = snapshot.revision
      requests = snapshot.pending
    } else if unavailable {
      requestsUnavailable = true
    }
  }

  // MARK: writes

  /// Answers a pending request. A refusal of the device's scope (403) is
  /// shown in the server's words and never retried with another credential.
  @discardableResult
  func resolve(requestId: String, response: RequestResponse) async throws -> ResolveOutcome {
    do {
      let outcome = try await client.requests.resolve(requestId, response)
      lastError = nil
      await reloadRequests()
      return outcome
    } catch {
      noteFailure(error)
      throw error
    }
  }

  /// Starts a session and answers its record, listed with the others.
  func startSession(_ input: StartSessionInput) async throws -> Session {
    do {
      let info = try await client.sessions.start(input)
      let session = try await client.sessions.get(info.id)
      upsert(session)
      lastError = nil
      return session
    } catch {
      noteFailure(error)
      throw error
    }
  }

  // MARK: internals

  /// One read; `handled` may take a failure for itself, else it is noted as the last error.
  private func call<T: Sendable>(
    _ run: @Sendable (ClaveServerClient) async throws -> T, handled: (Error) -> Bool = { _ in false }
  ) async -> T? {
    guard !stopped else { return nil }
    do {
      let value = try await run(client)
      if case .offline = state, !sawDisconnect { state = .connected }
      return value
    } catch {
      if !handled(error) { noteFailure(error) }
      return nil
    }
  }

  private func noteFailure(_ error: Error) {
    if error is CancellationError { return }
    guard let error = error as? ServerError else {
      lastError = "\(error)"
      return
    }
    lastError = error.message
    switch error.kind {
    case .unauthenticated:
      unpair("This machine no longer accepts this phone. Pair it again.")
    case .network, .timeout:
      if !isUnpaired { state = .offline(reason: "\(name) is offline. \(error.message)") }
    default:
      break
    }
  }

  private func handle(_ event: PushEvent) async {
    for listener in listeners.values { listener.yield(event) }
    switch event {
    case .welcome:
      state = .connected
      if sawDisconnect {
        sawDisconnect = false
        await reload()
        await runResumeHooks()
      }
    case .disconnected(let reason):
      sawDisconnect = true
      if !isUnpaired { state = .offline(reason: reason) }
    case .revoked:
      unpair("This phone was revoked on \(name). Pair it again.")
    case .unauthorized:
      unpair("This machine no longer accepts this phone. Pair it again.")
    case .event(let envelope):
      apply(envelope.event)
    default:
      break
    }
  }

  private func apply(_ event: ServerEvent) {
    switch event {
    case .requestsChanged(let revision):
      guard revision != requestsRevision else { return }
      Task { await reloadRequests() }
    case .sessionStateChanged(let id, let newState):
      replace(id) { $0.with(state: newState) }
    case .sessionTitleChanged(let id, let title):
      replace(id) { $0.with(title: title) }
    case .sessionRenamed(let id, let name):
      replace(id) { $0.with(title: name) }
    case .workspacesStateChanged(let views, let revision, let instance):
      let previous = workspaces
      workspaces = WorkspaceStateView(
        workspaces: views, lastActiveWorkspaceId: previous?.lastActiveWorkspaceId,
        activeWorkspaceId: previous?.activeWorkspaceId, pins: previous?.pins ?? [],
        pinsMigrated: previous?.pinsMigrated ?? true, revision: revision, instance: instance)
    case .devicesChanged, .unknown:
      break
    }
  }

  private func replace(_ id: String, _ change: (Session) -> Session) {
    guard let index = sessions.firstIndex(where: { $0.id == id }) else {
      // A session this phone has not listed yet: the list is read again.
      Task { await reloadSessions() }
      return
    }
    sessions[index] = change(sessions[index])
  }

  private func upsert(_ session: Session) {
    if let index = sessions.firstIndex(where: { $0.id == session.id }) {
      sessions[index] = session
    } else {
      sessions.append(session)
    }
  }

  private func unpair(_ reason: String) {
    guard !isUnpaired else { return }
    state = .unpaired(reason: reason)
    AppLog.event("connection.unpaired")
    let credentials = self.credentials
    let records = self.records
    let machineId = self.machineId
    Task {
      try? await credentials.remove(machineId)
      try? await records.remove(machineId)
    }
    onUnpaired?(machineId)
  }

  private func runResumeHooks() async {
    for hook in onResume { await hook() }
  }

  nonisolated deinit {}
}

extension Session {
  nonisolated func with(state: AgentState? = nil, title: String? = nil) -> Session {
    Session(
      id: id, provider: provider, transport: transport, cwd: cwd, windowKey: windowKey, workspaceId: workspaceId,
      groupId: groupId, state: state ?? self.state, createdAt: createdAt, adapterId: adapterId,
      title: title ?? self.title, viewId: viewId)
  }
}
