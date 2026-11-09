import Foundation

/// Where a pairing stands, every state a screen renders.
public enum PairingState: Sendable, Equatable {
  case requesting
  /// Waiting for the owner's word on the Mac; `polls` is how many reads were made so far.
  case waiting(pairingId: String, expiresAt: Double, polls: Int)
  case approved(EnrollmentRecord)
  case refused
  case expired
  case cancelled
  case failed(EnrollmentError)

  /// True for the states a pairing ends in.
  public var isFinal: Bool {
    switch self {
    case .requesting, .waiting: return false
    default: return true
    }
  }
}

/// What a pairing asks with: the machine (its id and its road), the hub's ID
/// token for the phone's own client, that client id, and how the phone names itself.
public struct PairingInput: Sendable, Equatable {
  public let machineId: String
  public let machineBaseUrl: String
  public let idToken: String
  public let clientId: String
  public let device: DeviceDescription

  public init(machineId: String, machineBaseUrl: String, idToken: String, clientId: String, device: DeviceDescription) {
    self.machineId = machineId
    self.machineBaseUrl = machineBaseUrl
    self.idToken = idToken
    self.clientId = clientId
    self.device = device
  }

  /// The input for `machine`.
  public init(machine: Machine, idToken: String, clientId: String, device: DeviceDescription) {
    self.init(machineId: machine.id, machineBaseUrl: machine.baseUrl, idToken: idToken, clientId: clientId, device: device)
  }
}

/// What a pairing runs over, so every branch runs against a stub of the routes.
public struct PairingPorts: Sendable {
  public var client: any PairingRoutes
  public var credentials: any CredentialStore
  public var records: EnrollmentRecords
  /// Commits the approval within the owner's current lifecycle; false means cancelled. Replaces the two stores when set.
  public var persist: (@Sendable (EnrollmentRecord, Credential) async throws -> Bool)?
  public var sleep: @Sendable (TimeInterval) async throws -> Void
  /// Epoch milliseconds, the clock the server's deadline is read against.
  public var now: @Sendable () -> Double
  /// Every state as it happens, for the screen.
  public var onState: (@Sendable (PairingState) -> Void)?
  /// The person left the screen: the pairing stops at the next step.
  public var cancelled: (@Sendable () -> Bool)?

  public init(
    client: any PairingRoutes,
    credentials: any CredentialStore,
    records: EnrollmentRecords,
    persist: (@Sendable (EnrollmentRecord, Credential) async throws -> Bool)? = nil,
    sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) },
    now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 },
    onState: (@Sendable (PairingState) -> Void)? = nil,
    cancelled: (@Sendable () -> Bool)? = nil
  ) {
    self.client = client
    self.credentials = credentials
    self.records = records
    self.persist = persist
    self.sleep = sleep
    self.now = now
    self.onState = onState
    self.cancelled = cancelled
  }
}

/// The pairing's two figures.
public struct PairingOptions: Sendable, Equatable {
  /// Between two reads of the pairing.
  public var pollInterval: TimeInterval
  /// Past the server's own deadline, how long a still-pending answer is
  /// believed before the pairing is read as lapsed here (milliseconds).
  public var graceMs: Double

  public init(pollInterval: TimeInterval = 2, graceMs: Double = 60_000) {
    self.pollInterval = pollInterval
    self.graceMs = graceMs
  }
}

/// Pairs the phone with a machine: asks, polls every two seconds while the
/// owner decides on the Mac, and on the approval keeps the device session it
/// is handed once, under the machine id, with the machine's road as the
/// server URL. A refusal, a lapse and a failure end as states; nothing is retried on its own.
public func pair(_ input: PairingInput, ports: PairingPorts, options: PairingOptions = PairingOptions()) async -> PairingState {
  @discardableResult
  func emit(_ state: PairingState) -> PairingState {
    ports.onState?(state)
    return state
  }
  func cancelled() -> Bool { ports.cancelled?() == true || Task.isCancelled }
  func failed(_ error: Error) -> PairingState {
    if let error = error as? EnrollmentError { return .failed(error) }
    if let error = error as? TransportPolicyError { return .failed(EnrollmentError(.protocol, error.message)) }
    return .failed(EnrollmentError(.protocol, "\(error)"))
  }
  func transient(_ error: Error) -> Bool {
    guard let error = error as? EnrollmentError else { return false }
    return error.kind == .network || error.kind == .timeout
  }

  emit(.requesting)
  if cancelled() { return emit(.cancelled) }
  let ticket: PairingTicket
  do {
    ticket = try await ports.client.requestPairing(
      PairingRequestInput(idToken: input.idToken, clientId: input.clientId, device: input.device))
  } catch {
    return emit(failed(error))
  }
  if cancelled() { return emit(.cancelled) }
  var polls = 0
  let waiting = { PairingState.waiting(pairingId: ticket.pairingId, expiresAt: ticket.expiresAt, polls: polls) }
  emit(waiting())
  while true {
    if cancelled() { return emit(.cancelled) }
    do {
      try await ports.sleep(options.pollInterval)
    } catch {
      return emit(.cancelled)
    }
    if cancelled() { return emit(.cancelled) }
    polls += 1
    let read: PairingRead
    do {
      read = try await ports.client.readPairing(ticket.pairingId)
    } catch {
      // The network, not the server: the owner may still be about to answer,
      // so the wait goes on until the server's own deadline and the grace.
      if transient(error) && ports.now() <= ticket.expiresAt + options.graceMs {
        emit(waiting())
        continue
      }
      return emit(failed(error))
    }
    if cancelled() { return emit(.cancelled) }
    switch read.status {
    case .pending:
      if ports.now() > ticket.expiresAt + options.graceMs { return emit(.expired) }
      emit(waiting())
    case .refused:
      return emit(.refused)
    case .expired:
      return emit(.expired)
    case .approved:
      guard let session = read.deviceSession else {
        return emit(.failed(EnrollmentError(.consumed, "The approval was already handed out and cannot be read again. Pair again.")))
      }
      let record = EnrollmentRecord(
        machineId: input.machineId, deviceId: session.deviceId, serverId: session.serverId,
        serverName: session.serverName, pairedAt: ports.now())
      let credential = Credential(serverUrl: input.machineBaseUrl, bearer: session.token)
      if cancelled() { return emit(.cancelled) }
      do {
        if let persist = ports.persist {
          let kept = try await persist(record, credential)
          if !kept || cancelled() { return emit(.cancelled) }
        } else {
          try await ports.credentials.set(input.machineId, credential)
          try await ports.records.set(record)
        }
      } catch {
        return emit(.failed(EnrollmentError(.protocol, "The pairing could not be kept on this phone.")))
      }
      return emit(.approved(record))
    }
  }
}
