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
  var path: [Route] = []
  /// A sentence for the Machines screen when a notification could not go further.
  var notice: String?
  /// True once the launch has read the sign-in and chosen the first screen.
  private(set) var isReady = false

  @ObservationIgnored private var inbox: NotificationInbox?
  @ObservationIgnored private var pushRegistry: PushTokenRegistry?
  @ObservationIgnored private var apnsToken: String?
  @ObservationIgnored private var launchURL: URL?
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
    if let explicit, let link = DeepLink.parse(explicit) { path = Self.path(for: link) }
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
    path = Self.path(for: link)
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
    if case .pairing? = path.last { path.removeLast() }
    open(machineId: machineId)
  }

  // MARK: connections

  /// The connection of a paired machine, made and started on first use; nil
  /// when this phone keeps no credential for it.
  func connection(for machineId: String) async -> MachineConnection? {
    if let existing = connections[machineId], !existing.isUnpaired { return existing }
    guard let machines, let owner = account.ownerKeyValueStore,
      let credential = try? await machines.credentials.get(machineId)
    else { return nil }
    // The owner may have changed while the credential was read.
    guard self.machines === machines else { return nil }
    if let existing = connections[machineId], !existing.isUnpaired { return existing }
    let row = machines.row(machineId)
    var record = row?.record
    if record == nil { record = try? await machines.records.get(machineId) }
    guard let connection = try? MachineConnection(
      machineId: machineId, credential: credential, machine: row?.machine, record: record,
      environment: environment, credentials: machines.credentials, records: machines.records, ownerKeyValueStore: owner)
    else { return nil }
    connection.onUnpaired = { [weak self] _ in
      Task { await self?.machines?.refresh() }
    }
    connections[machineId]?.stop()
    connections[machineId] = connection
    await connection.start()
    return connection
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
    for connection in connections.values { connection.stop() }
    connections = [:]
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
        if let inbox { await self?.readyInbox(inbox) }
        await self?.registerForRemoteNotificationsIfPaired()
      }
    }
  }

  nonisolated deinit {}
}
