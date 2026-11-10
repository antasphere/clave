import ClaveCore
import Foundation
import Observation
import SwiftUI
import UIKit
import UserNotifications

/// Every place the navigation stack can hold, over the Machines screen at its root.
enum Route: Hashable, Sendable {
  case machines
  case pairing(machineId: String)
  case workspaces(machineId: String)
  case sessions(machineId: String, workspaceId: String)
  case chat(machineId: String, sessionId: String)
  case requests(machineId: String)
  case launch(machineId: String, workspaceId: String)
  case appearance
}

/// What the app needs of a tapped notification, taken out of the platform's
/// response on whichever thread it arrived on.
nonisolated struct NotificationResponseInput: Sendable {
  /// The notification's identifier, its date and the action: one response, handled once.
  let key: String
  let payload: NotificationPayload?
  let actionIdentifier: String
  let userText: String?

  init(key: String, payload: NotificationPayload?, actionIdentifier: String, userText: String?) {
    self.key = key
    self.payload = payload
    self.actionIdentifier = actionIdentifier
    self.userText = userText
  }

  init(response: UNNotificationResponse) {
    let notification = response.notification
    key = "\(notification.request.identifier)|\(notification.date.timeIntervalSince1970)|\(response.actionIdentifier)"
    payload = notificationPayload(from: notification.request.content.userInfo)
    // The platform's default action is a plain tap: the payload's own open.
    actionIdentifier = response.actionIdentifier == UNNotificationDefaultActionIdentifier ? "" : response.actionIdentifier
    userText = (response as? UNTextInputNotificationResponse)?.userText
  }
}

/// The root of the app: the account, the owner's machines and connections,
/// the navigation, the notifications and the push token.
@Observable @MainActor final class AppModel {
  let environment: AppEnvironment
  let appearance: AppearanceStore
  let account: AccountModel
  /// The signed-in owner's machines; nil when nobody is signed in.
  private(set) var machines: MachinesModel?
  private(set) var connections: [String: MachineConnection] = [:]
  /// The open conversations, by "<machineId>/<sessionId>": one model per conversation, kept while
  /// its machine's connection lives, so going back and in again keeps the draft and the transcript.
  private(set) var conversations: [String: ConversationModel] = [:]
  var path: [Route] = []
  /// A sentence for the Machines screen when a notification could not go further.
  var notice: String?
  /// A deep link that could not open yet: nobody is signed in, or its machine has no credential
  /// on this phone. It opens once the owner's machines load with it paired, or at its pairing.
  private(set) var pendingLink: DeepLink?
  /// What Machines says while a link waits.
  nonisolated static let pendingLinkNotice = "Sign in and pair this machine to open the conversation."
  /// True once the launch has read the sign-in and chosen the first screen.
  private(set) var isReady = false

  @ObservationIgnored private var inbox: NotificationInbox?
  @ObservationIgnored private var pushRegistry: PushTokenRegistry?
  @ObservationIgnored private var apnsToken: String?
  @ObservationIgnored private var launchURL: URL?
  /// The move of each owner's shared ledger to its machines' own, by owner namespace: one task,
  /// which every connection of that owner waits for before it is built.
  @ObservationIgnored private var ledgerMoves: [String: Task<Void, Never>] = [:]
  /// The connection being made for a machine, at most one at a time: a caller arriving meanwhile
  /// waits for it rather than making a second one that would replace it.
  @ObservationIgnored private var connecting: [String: Task<MachineConnection?, Never>] = [:]
  /// Each machine's delivery parts by owner, kept for the app's life: a connection made again for a
  /// machine (after the same owner signs in again, or in place of an unpaired one) works through the
  /// controller and ledger the actions of the one before may still be using, so no two ledgers ever
  /// write one machine's key.
  @ObservationIgnored private var deliveryParts: [String: MachineConnection.DeliveryParts] = [:]
  @ObservationIgnored private var starting = false
  @ObservationIgnored private var started = false
  @ObservationIgnored private var askedForRemoteNotifications = false

  init(environment: AppEnvironment) {
    self.environment = environment
    appearance = AppearanceStore(defaults: environment.appearanceDefaults)
    account = AccountModel(environment: environment)
    account.onOwnerChange = { [weak self] namespace in self?.ownerChanged(namespace) }
    account.beforeSignOut = { [weak self] in await self?.clearPushRegistrations() }
  }

  // MARK: launch

  /// The cold launch: the sign-in read back, then Machines and, when a
  /// machine is paired, its Workspaces; a notification or a deep link the
  /// process was launched with opens its conversation instead.
  func start() async {
    guard !starting else { return }
    starting = true
    #if DEBUG
      // A development launch may name a URL to open, as if the platform had opened the app with it.
      if launchURL == nil, let url = environment.openURLAtLaunch { launchURL = url }
    #endif
    // The owner read back here is set up by the launch itself, below.
    await account.restore()
    started = true
    let explicit = launchURL
    if let machines {
      await machines.load()
      path = Self.coldLaunchPath(currentMachine: await machines.currentMachineId())
      if let inbox, let destination = await inbox.launchDestination(explicitURL: explicit) {
        navigate(to: destination)
      }
    }
    if let explicit, let link = DeepLink.parse(explicit) { open(link) }
    launchURL = nil
    isReady = true
    if let inbox { await readyInbox(inbox) }
    await registerForRemoteNotificationsIfPaired()
  }

  /// A new process opens Machines, then the Workspaces of the current machine
  /// with no machine picker in between; with no machine paired, Machines alone.
  nonisolated static func coldLaunchPath(currentMachine: String?) -> [Route] {
    currentMachine.map { [.workspaces(machineId: $0)] } ?? []
  }

  /// The stack a deep link opens: back from the conversation is its machine's workspaces.
  nonisolated static func path(for link: DeepLink) -> [Route] {
    switch link {
    case .chat(let machineId, let sessionId):
      [.workspaces(machineId: machineId), .chat(machineId: machineId, sessionId: sessionId)]
    case .request(let machineId, _):
      [.workspaces(machineId: machineId), .requests(machineId: machineId)]
    }
  }

  nonisolated static func path(for destination: NotificationDestination) -> [Route] {
    switch destination {
    case .chat(let machineId, let sessionId, _):
      path(for: .chat(machineId: machineId, sessionId: sessionId))
    case .requests(let machineId, _):
      [.workspaces(machineId: machineId), .requests(machineId: machineId)]
    case .workspaces(let machineId):
      [.workspaces(machineId: machineId)]
    case .machines:
      []
    }
  }

  /// The navigator is mounted: queued notifications open now, later ones as they come.
  private func readyInbox(_ inbox: NotificationInbox) async {
    await inbox.ready { destination in
      Task { @MainActor [weak self] in self?.navigate(to: destination) }
    }
  }

  // MARK: navigation

  /// A URL the platform opened the app with, warm or cold.
  func handle(url: URL) {
    guard let link = DeepLink.parse(url) else { return }
    guard isReady else {
      // The launch is still reading the sign-in; it opens this when done.
      launchURL = url
      return
    }
    AppLog.event("deeplink.opened")
    open(link)
  }

  /// The one way a deep link opens: at once when someone is signed in and the link's machine has a
  /// credential, else kept (a second link replaces the first) with Machines saying why.
  private func open(_ link: DeepLink) {
    if canOpen(link) {
      path = Self.path(for: link)
      pendingLink = nil
      clearPendingLinkNotice()
    } else {
      pendingLink = link
      path = []
      notice = Self.pendingLinkNotice
    }
  }

  /// Someone is signed in and the link's machine is paired: its row is kept paired after the
  /// machines load, the relay reached or not (MachinesModel.refresh keeps every record that has a
  /// credential).
  private func canOpen(_ link: DeepLink) -> Bool {
    guard account.isSignedIn, let machines else { return false }
    return machines.row(link.machineId)?.paired == true
  }

  /// The kept link opens once its machine is paired.
  private func openPendingLinkIfPaired() {
    if let link = pendingLink, canOpen(link) { open(link) }
  }

  private func clearPendingLinkNotice() {
    if notice == Self.pendingLinkNotice { notice = nil }
  }

  func navigate(to destination: NotificationDestination) {
    if case .machines(let reason) = destination { notice = reason }
    path = Self.path(for: destination)
  }

  /// Opens a machine's workspaces and makes it the one a cold launch opens.
  func open(machineId: String) {
    path.append(.workspaces(machineId: machineId))
    if let machines { Task { await machines.rememberOpened(machineId) } }
  }

  /// Leaves the Pairing screen for the paired machine's workspaces.
  func continueAfterPairing(machineId: String) {
    if let link = pendingLink, link.machineId == machineId {
      // The link that waited for this pairing opens now.
      path = Self.path(for: link)
      pendingLink = nil
      clearPendingLinkNotice()
      return
    }
    if case .pairing? = path.last { path.removeLast() }
    open(machineId: machineId)
  }

  // MARK: connections

  /// The connection of a paired machine, made and started on first use; nil
  /// when this phone keeps no credential for it. Two callers while it is being made get the same one.
  func connection(for machineId: String) async -> MachineConnection? {
    if let existing = connections[machineId], !existing.isUnpaired { return existing }
    if let making = connecting[machineId] { return await making.value }
    let making = Task { await self.makeConnection(for: machineId) }
    connecting[machineId] = making
    let made = await making.value
    if connecting[machineId] == making { connecting[machineId] = nil }
    return made
  }

  /// Makes and starts the connection of a paired machine, replacing one that no longer pairs; nil
  /// when this phone keeps no credential for it, or the owner changed meanwhile.
  private func makeConnection(for machineId: String) async -> MachineConnection? {
    guard let machines, let owner = account.ownerKeyValueStore else { return nil }
    await moveSharedLedger(of: owner)
    guard let credential = try? await machines.credentials.get(machineId) else { return nil }
    // The owner may have changed while the ledger moved or the credential was read.
    guard self.machines === machines else { return nil }
    if let existing = connections[machineId], !existing.isUnpaired { return existing }
    let row = machines.row(machineId)
    var record = row?.record
    if record == nil { record = try? await machines.records.get(machineId) }
    let partsKey = "\(owner.namespace)/\(machineId)"
    let parts = deliveryParts[partsKey] ?? MachineConnection.DeliveryParts(machineId: machineId, store: owner)
    deliveryParts[partsKey] = parts
    guard let connection = try? MachineConnection(
      machineId: machineId, credential: credential, machine: row?.machine, record: record,
      environment: environment, credentials: machines.credentials, records: machines.records, ownerKeyValueStore: owner,
      deliveryParts: parts)
    else { return nil }
    connection.onUnpaired = { [weak self] _ in
      Task { await self?.machines?.refresh() }
    }
    if let previous = connections[machineId] {
      previous.stop()
      dropConversations(of: machineId)
    }
    connections[machineId] = connection
    await connection.start()
    return connection
  }

  /// Moves the sends of unknown outcome every machine of this owner once kept under one key to each
  /// machine's own, once per owner: a caller arriving while the move runs waits for the same move,
  /// and one arriving later finds it done. A move that fails leaves the records under the old key,
  /// none dropped, for the next launch to move.
  private func moveSharedLedger(of owner: OwnerScopedKeyValueStore) async {
    if let move = ledgerMoves[owner.namespace] {
      await move.value
      return
    }
    let move = Task {
      do {
        try await migrateLegacyUnknownSends(owner)
      } catch {
        AppLog.event("ledger.move.failed")
      }
    }
    ledgerMoves[owner.namespace] = move
    await move.value
  }

  /// The conversation of a session on a machine, made on first use over that machine's
  /// connection and reused after; nil when the machine has no such session.
  func conversation(for machineId: String, sessionId: String, in connection: MachineConnection) async -> ConversationModel? {
    let key = Self.conversationKey(machineId, sessionId)
    if let existing = conversations[key] { return existing }
    var found = connection.sessions.first { $0.id == sessionId }
    if found == nil { found = try? await connection.client.sessions.get(sessionId) }
    guard let session = found else { return nil }
    // Made while the session was read: the first one stays.
    if let existing = conversations[key] { return existing }
    let model = ConversationModel(
      machineId: machineId, session: session, client: connection.client, push: connection.push,
      events: { connection.events() }, delivery: connection.delivery, drafts: connection.drafts,
      attachmentDrafts: connection.attachmentDrafts)
    // A conversation never outlives its connection: one made over a connection already replaced is not kept.
    if connections[machineId] === connection { conversations[key] = model }
    return model
  }

  nonisolated static func conversationKey(_ machineId: String, _ sessionId: String) -> String {
    "\(machineId)/\(sessionId)"
  }

  private func dropConversations(of machineId: String) {
    let prefix = "\(machineId)/"
    for key in conversations.keys where key.hasPrefix(prefix) {
      conversations[key]?.disappear()
      conversations[key] = nil
    }
  }

  // MARK: notifications

  func handleNotification(response: NotificationResponseInput) async {
    guard let inbox, let machines else { return }
    let records = machines.records
    let credentials = machines.credentials
    let transport = environment.transport
    let build = environment.buildKind
    await inbox.receive(key: response.key) {
      let outcome = await respondToNotification(
        response.payload, actionIdentifier: response.actionIdentifier, userText: response.userText,
        machines: records, credentials: credentials,
        server: { try ClaveServerClient(credential: $0, transport: transport, build: build) })
      if case .open(let destination) = outcome { return destination }
      return nil
    }
  }

  // MARK: push token

  /// Asks for the alert permission and an APNs token once a machine is paired:
  /// before that there is nobody to push.
  func registerForRemoteNotificationsIfPaired() async {
    guard environment.usesRemoteNotifications, !askedForRemoteNotifications, let machines else { return }
    guard let paired = try? await machines.credentials.known(), !paired.isEmpty else { return }
    askedForRemoteNotifications = true
    _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
    UIApplication.shared.registerForRemoteNotifications()
  }

  func didRegisterForRemoteNotifications(deviceToken: Data) async {
    apnsToken = apnsTokenString(deviceToken)
    AppLog.event("push.token.received")
    await registerPushToken()
  }

  func didFailToRegisterForRemoteNotifications() {
    AppLog.event("push.token.failed")
  }

  /// The token registered with every paired machine; each one is told once
  /// per token value, again when the platform hands a new one.
  private func registerPushToken() async {
    guard let token = apnsToken, let registry = pushRegistry, let machines else { return }
    let ids = (try? await machines.credentials.known()) ?? []
    let transport = environment.transport
    let build = environment.buildKind
    _ = await registry.registerEverywhere(
      token, machineIds: ids, credentials: machines.credentials,
      routes: { try ClaveServerClient(credential: $0, transport: transport, build: build) })
  }

  /// Before the login ends: every machine that holds the token is told to
  /// forget it, through the credential this owner paired with.
  private func clearPushRegistrations() async {
    guard let registry = pushRegistry, let machines, let owner = account.ownerSecureStore else { return }
    var holding: [String] = []
    for id in (try? await machines.credentials.known()) ?? [] {
      let registered = (try? await machines.keyValueStore.get(PushTokenRegistry.tokenKey(id))) ?? nil
      if registered != nil { holding.append(id) }
    }
    let cleanup = SecureCredentialStore(OwnerScopedSecureStore(base: owner, namespace: "push-cleanup"))
    let transport = environment.transport
    let build = environment.buildKind
    _ = try? await registry.clearRegistrations(
      holding, credentials: machines.credentials, cleanupCredentials: cleanup,
      routes: { try ClaveServerClient(credential: $0, transport: transport, build: build) })
  }

  // MARK: scene phase

  /// Backgrounding tears nothing down; coming back reloads every started connection.
  func scenePhaseChanged(_ phase: ScenePhase) {
    guard phase == .active else { return }
    for connection in connections.values {
      Task { await connection.resume() }
    }
  }

  // MARK: owner

  /// Another person (or nobody) is signed in: everything built for the
  /// previous owner is dropped, never handed over.
  private func ownerChanged(_ namespace: String?) {
    if namespace == nil {
      // A sign-out drops the link that waited, and what Machines said about it.
      pendingLink = nil
      clearPendingLinkNotice()
    }
    for connection in connections.values { connection.stop() }
    connections = [:]
    // A connection still being made for the previous owner finds the owner changed and makes none.
    connecting = [:]
    for conversation in conversations.values { conversation.disappear() }
    conversations = [:]
    if let inbox { Task { await inbox.close() } }
    inbox = nil
    pushRegistry = nil
    askedForRemoteNotifications = false
    machines = nil
    if started { path = [] }
    guard let namespace, let secure = account.ownerSecureStore, let kv = account.ownerKeyValueStore else {
      AppLog.event("owner.none")
      return
    }
    AppLog.event("owner.changed")
    let hub = account.hub
    let model = MachinesModel(
      namespace: namespace, environment: environment, secureStore: secure, keyValueStore: kv,
      accessToken: { try await hub.accessToken() },
      idToken: { try await hub.idToken() },
      clientId: { [weak self] in self?.account.status?.clientId },
      accountGuard: { [weak self] in
        let current = await MainActor.run { self?.account.ownerNamespace }
        if current != namespace { throw AuthError(.cancelled, "The account changed.") }
      })
    model.onForget = { [weak self] id in
      self?.connections[id]?.stop()
      self?.connections[id] = nil
      self?.dropConversations(of: id)
    }
    model.onPaired = { [weak self] _ in
      guard let self else { return }
      Task {
        await self.registerForRemoteNotificationsIfPaired()
        await self.registerPushToken()
      }
    }
    machines = model
    inbox = NotificationInbox(store: kv)
    pushRegistry = PushTokenRegistry(store: kv)
    if started {
      let inbox = self.inbox
      Task { [weak self] in
        await model.load()
        // The owner may have changed while the machines loaded.
        if self?.machines === model { self?.openPendingLinkIfPaired() }
        if let inbox { await self?.readyInbox(inbox) }
        await self?.registerForRemoteNotificationsIfPaired()
      }
    }
  }

  nonisolated deinit {}
}

extension DeepLink {
  /// The machine the link's place is on.
  nonisolated var machineId: String {
    switch self {
    case .chat(let machineId, _), .request(let machineId, _): machineId
    }
  }
}
