import ClaveCore
import Foundation
import Observation
import UIKit

/// One machine as the Machines screen lists it.
struct MachineRow: Identifiable, Equatable, Sendable {
  let machine: Machine
  /// A credential is kept for it (and, for a relay machine, the pairing's record).
  let paired: Bool
  let record: EnrollmentRecord?
  /// Listed by the developer connection rather than the relay.
  let isDeveloper: Bool

  var id: String { machine.id }
  var online: Bool { machine.online }
}

/// The machines of one owner: the relay they are listed by, the list, the
/// pairing of this phone with one of them, and forgetting one. Built for one
/// namespace and never moved to another.
@Observable @MainActor final class MachinesModel {
  /// The key the relay address is kept under in the owner's key-value store.
  static let relayKey = "relay.url"
  /// The machine the person opened last: a cold launch opens its workspaces.
  static let lastMachineKey = "clave.last-machine"

  let namespace: String
  let credentials: SecureCredentialStore
  let records: EnrollmentRecords
  let keyValueStore: OwnerScopedKeyValueStore

  /// The relay the machines are listed by, as saved (or as the launch overrode it).
  private(set) var relayURL: String = ""
  /// Why the relay address last entered was refused, under the field.
  private(set) var relayRefusal: String?
  private(set) var rows: [MachineRow] = []
  private(set) var isLoading = false
  /// The last listing failure as a sentence; nil when the list is current.
  private(set) var listError: String?
  /// True when the relay refused the sign-in: the person signs in again.
  private(set) var needsSignIn = false
  private(set) var mainMachineId: String?
  /// The pairing the Pairing screen shows, and the machine it is about.
  private(set) var pairingState: PairingState?
  private(set) var pairingMachineId: String?
  #if DEBUG
    private(set) var developerError: String?
  #endif

  var machines: [MachineRow] { rows }

  @ObservationIgnored private let environment: AppEnvironment
  @ObservationIgnored private let accessToken: @Sendable () async throws -> String
  @ObservationIgnored private let idToken: @Sendable () async throws -> String
  @ObservationIgnored private let clientId: @MainActor () -> String?
  @ObservationIgnored private let accountGuard: @Sendable () async throws -> Void
  @ObservationIgnored private var pairingTask: Task<Void, Never>?
  @ObservationIgnored private var loaded = false
  /// Told when a machine's pairing is kept or forgotten.
  @ObservationIgnored var onPaired: ((String) -> Void)?
  @ObservationIgnored var onForget: ((String) -> Void)?

  init(
    namespace: String, environment: AppEnvironment, secureStore: OwnerScopedSecureStore,
    keyValueStore: OwnerScopedKeyValueStore,
    accessToken: @escaping @Sendable () async throws -> String,
    idToken: @escaping @Sendable () async throws -> String,
    clientId: @escaping @MainActor () -> String?,
    accountGuard: @escaping @Sendable () async throws -> Void = {}
  ) {
    self.namespace = namespace
    self.environment = environment
    self.keyValueStore = keyValueStore
    credentials = SecureCredentialStore(secureStore)
    records = EnrollmentRecords(store: keyValueStore)
    self.accessToken = accessToken
    self.idToken = idToken
    self.clientId = clientId
    self.accountGuard = accountGuard
  }

  /// Reads the relay kept for this owner, then lists. Runs once; `refresh()` after.
  func load() async {
    guard !loaded else { return }
    loaded = true
    if let override = environment.relayOverride {
      relayURL = override
    } else {
      relayURL = (try? await keyValueStore.get(Self.relayKey)) ?? ""
    }
    await refresh()
  }

  /// The machines of the relay and, in a development build, the developer's.
  func refresh() async {
    isLoading = true
    defer { isLoading = false }
    mainMachineId = try? await credentials.mainMachineId()
    var listed: [Machine] = []
    var failure: String?
    var signInAgain = false
    if !relayURL.isEmpty {
      do {
        let source = try RelayMachineSource(
          relayURL: relayURL, token: accessToken, transport: environment.transport, build: environment.buildKind)
        listed = try await source.list()
      } catch let error as ServerError where error.kind == .unauthenticated {
        signInAgain = true
        failure = "Sign in again: the relay refused the sign-in."
      } catch let error as AuthError {
        signInAgain = error.failure != .cancelled
        failure = "Sign in again: \(error.message)"
      } catch let error as ServerError {
        failure = "\(error.message) Pull to refresh when the connection is back."
      } catch let error as TransportPolicyError {
        failure = error.message
      } catch {
        failure = "The machines could not be listed. Pull to refresh."
      }
    }
    var developer: [Machine] = []
    #if DEBUG
      if environment.offersDeveloperConnection {
        developer = (try? await developerSource().list()) ?? []
      }
    #endif
    let kept = (try? await records.list()) ?? []
    let paired = Set((try? await credentials.known()) ?? [])
    // A paired machine the relay did not list this time (it failed, or it
    // dropped the row) stays on the screen, offline, so it can still be opened.
    let listedIds = Set(listed.map(\.id))
    for record in kept where !listedIds.contains(record.machineId) && paired.contains(record.machineId) {
      let base = relayURL.isEmpty ? "" : machineBaseURL(relay: relayURL, machineId: record.machineId)
      listed.append(
        Machine(
          id: record.machineId, name: record.serverName.isEmpty ? record.machineId : record.serverName,
          platform: .unknown, version: "", online: false, lastSeen: nil, baseUrl: base, pushUrl: pushURL(of: base)))
    }
    rows = listed.map { machine in
      let record = kept.first { $0.machineId == machine.id }
      return MachineRow(machine: machine, paired: paired.contains(machine.id) && record != nil, record: record, isDeveloper: false)
    } + developer.map { MachineRow(machine: $0, paired: paired.contains($0.id), record: nil, isDeveloper: true) }
    listError = failure
    needsSignIn = signInAgain
    AppLog.event(failure == nil ? "machines.listed" : "machines.list.failed")
  }

  /// Keeps a new relay address, refused before anything is sent when this
  /// build sends no credential there (a release build over plain http).
  @discardableResult
  func saveRelay(_ text: String) async -> Bool {
    var address = text.trimmingCharacters(in: .whitespacesAndNewlines)
    while address.hasSuffix("/") { address.removeLast() }
    if address.isEmpty {
      relayRefusal = "Enter the address of your team's relay."
      return false
    }
    if case .refused(let reason) = credentialMayTravelTo(address, build: environment.buildKind) {
      relayRefusal = reason
      return false
    }
    relayRefusal = nil
    do {
      try await keyValueStore.set(Self.relayKey, address)
    } catch {
      relayRefusal = "The relay address could not be kept on this phone."
      return false
    }
    if environment.relayOverride == nil { relayURL = address }
    await refresh()
    return true
  }

  func row(_ machineId: String) -> MachineRow? {
    rows.first { $0.id == machineId }
  }

  // MARK: pairing

  /// Pairs this phone with `machine`, polling every two seconds while the
  /// owner decides on the Mac. A second call while one runs restarts it.
  func pair(_ machine: Machine) {
    pairingTask?.cancel()
    pairingMachineId = machine.id
    pairingState = .requesting
    let environment = self.environment
    let credentials = self.credentials
    let records = self.records
    let idToken = self.idToken
    let accountGuard = self.accountGuard
    let clientId = self.clientId()
    let device = DeviceDescription(name: UIDevice.current.name, platform: .ios, appVersion: ClaveCoreInfo.version)
    let (states, sink) = AsyncStream.makeStream(of: PairingState.self, bufferingPolicy: .unbounded)
    pairingTask = Task { [weak self] in
      // The states arrive on the pairing's own executor; they are shown in order here.
      let shown = Task { @MainActor [weak self] in
        for await state in states {
          guard let self, self.pairingMachineId == machine.id else { continue }
          self.pairingState = state
        }
      }
      let final: PairingState
      do {
        guard let clientId else { throw AuthError(.expired, "Sign in again to pair a machine.") }
        let token = try await idToken()
        let client = try EnrollmentClient(baseURL: machine.baseUrl, transport: environment.transport, build: environment.buildKind)
        let ports = PairingPorts(
          client: client, credentials: credentials, records: records,
          persist: { record, credential in
            // The approval belongs to the account that asked; a sign-out in between keeps nothing.
            try await accountGuard()
            try await credentials.set(record.machineId, credential)
            try await records.set(record)
            return true
          },
          onState: { sink.yield($0) })
        final = await ClaveCore.pair(
          PairingInput(machine: machine, idToken: token, clientId: clientId, device: device), ports: ports)
      } catch let error as AuthError {
        final = .failed(EnrollmentError(.protocol, error.message))
      } catch let error as TransportPolicyError {
        final = .failed(EnrollmentError(.protocol, error.message))
      } catch {
        final = .failed(EnrollmentError(.protocol, "The pairing could not start."))
      }
      sink.finish()
      await shown.value
      guard let self, self.pairingMachineId == machine.id else { return }
      self.pairingState = final
      AppLog.event("pairing.\(Self.code(final))")
      if case .approved = final {
        await self.refresh()
        self.onPaired?(machine.id)
      }
    }
  }

  /// The person left the Pairing screen: the pairing stops at its next step.
  func cancelPairing() {
    pairingTask?.cancel()
    pairingTask = nil
    if let state = pairingState, !state.isFinal { pairingState = .cancelled }
  }

  /// Forgets a machine on this phone: its credential and its record. The
  /// Mac keeps its own list; revoking the phone there is the Mac's act.
  func forget(_ machineId: String) async {
    try? await credentials.remove(machineId)
    try? await records.remove(machineId)
    #if DEBUG
      if machineId.hasPrefix("dev:") { try? await developerSource().remove(machineId) }
    #endif
    if (try? await keyValueStore.get(Self.lastMachineKey)) == machineId {
      try? await keyValueStore.remove(Self.lastMachineKey)
    }
    AppLog.event("machine.forgotten")
    onForget?(machineId)
    await refresh()
  }

  /// The machine a cold launch opens: the last one opened while it is still
  /// paired, else the main one, else none.
  func currentMachineId() async -> String? {
    let paired = (try? await credentials.known()) ?? []
    let last = try? await keyValueStore.get(Self.lastMachineKey)
    let main = try? await credentials.mainMachineId()
    return Self.currentMachine(last: last ?? nil, main: main ?? nil, paired: paired)
  }

  nonisolated static func currentMachine(last: String?, main: String?, paired: [String]) -> String? {
    if let last, paired.contains(last) { return last }
    if let main, paired.contains(main) { return main }
    return paired.first
  }

  func rememberOpened(_ machineId: String) async {
    try? await keyValueStore.set(Self.lastMachineKey, machineId)
  }

  private nonisolated static func code(_ state: PairingState) -> String {
    switch state {
    case .requesting: "requesting"
    case .waiting: "waiting"
    case .approved: "approved"
    case .refused: "refused"
    case .expired: "expired"
    case .cancelled: "cancelled"
    case .failed: "failed"
    }
  }

  // MARK: developer connection

  #if DEBUG
    private func developerSource() -> DeveloperMachineSource {
      DeveloperMachineSource(store: keyValueStore, credentials: credentials)
    }

    /// Adds a standalone server by its address and token; the token is tried once before it is kept.
    @discardableResult
    func addDeveloperServer(url: String, token: String) async -> Bool {
      developerError = nil
      let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else {
        developerError = "Paste the server's token."
        return false
      }
      do {
        _ = try await developerSource().add(serverURL: url, token: trimmed, transport: environment.transport)
      } catch let error as ServerError {
        developerError = error.kind == .unauthenticated ? "The server refused this token." : error.message
        return false
      } catch let error as DeveloperConnectionError {
        developerError = error.message
        return false
      } catch let error as TransportPolicyError {
        developerError = error.message
        return false
      } catch {
        developerError = "The server could not be added."
        return false
      }
      AppLog.event("developer.added")
      await refresh()
      return true
    }
  #endif

  nonisolated deinit {}
}
