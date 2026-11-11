import Foundation

/// What the phone keeps of a pairing beside the credential: the device id the
/// server gave it, the server's id and name, and when. It lets a
/// notification, which names a server, find the machine it came through.
public struct EnrollmentRecord: Sendable, Equatable, Codable {
  public let machineId: String
  public let deviceId: String
  public let serverId: String
  public let serverName: String
  /// Epoch milliseconds.
  public let pairedAt: Double

  public init(machineId: String, deviceId: String, serverId: String, serverName: String, pairedAt: Double) {
    self.machineId = machineId
    self.deviceId = deviceId
    self.serverId = serverId
    self.serverName = serverName
    self.pairedAt = pairedAt
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    machineId = try c.decodeString("machineId")
    deviceId = try c.decodeString("deviceId")
    serverId = try c.decodeString("serverId")
    serverName = (try? c.decodeOptionalString("serverName")) ?? ""
    pairedAt = (try? c.decodeIfPresent("pairedAt", Double.self)) ?? 0
  }
}

/// Maps a server named by a notification to the machine the phone reaches it through.
public protocol MachineResolver: Sendable {
  /// The machine id of the server `serverId`, nil when this phone is not paired with it.
  func machineId(forServer serverId: String) async throws -> String?
}

/// The enrollment records, one JSON list in the key-value store under
/// `clave.enrollments`. The actor serializes the read-modify-write, so two
/// approvals landing together keep both records.
public actor EnrollmentRecords: MachineResolver {
  /// The key-value key of the list.
  public static let key = "clave.enrollments"

  private let store: any KeyValueStore
  private var tail: Task<Void, Never>?

  /// The records kept in `store`, scoped to one owner by the caller.
  public init(store: any KeyValueStore) {
    self.store = store
  }

  /// Every record; a damaged list or entry reads as absent.
  public func list() async throws -> [EnrollmentRecord] {
    guard let raw = try await store.get(Self.key),
      let values = try? JSONDecoder().decode([JSONValue].self, from: Data(raw.utf8))
    else { return [] }
    return values.compactMap { value in
      (try? ContractJSON.encode(value)).flatMap { try? ContractJSON.decode(EnrollmentRecord.self, from: $0) }
    }
  }

  /// The record of a machine.
  public func get(_ machineId: String) async throws -> EnrollmentRecord? {
    try await list().first { $0.machineId == machineId }
  }

  /// The machine a server is reached through; the latest pairing wins when two machines name one server.
  public func byServerId(_ serverId: String) async throws -> EnrollmentRecord? {
    try await list().filter { $0.serverId == serverId }.max { $0.pairedAt < $1.pairedAt }
  }

  public func machineId(forServer serverId: String) async throws -> String? {
    try await byServerId(serverId)?.machineId
  }

  /// Keeps the record, replacing the one of the same machine.
  public func set(_ record: EnrollmentRecord) async throws {
    try await serialized { try await self.write { $0.filter { $0.machineId != record.machineId } + [record] } }
  }

  /// Forgets the record of a machine.
  public func remove(_ machineId: String) async throws {
    try await serialized { try await self.write { $0.filter { $0.machineId != machineId } } }
  }

  private func write(_ change: @Sendable ([EnrollmentRecord]) -> [EnrollmentRecord]) async throws {
    let next = change(try await list())
    if next.isEmpty {
      try await store.remove(Self.key)
    } else {
      try await store.set(Self.key, try ContractJSON.encodeToString(next))
    }
  }

  /// The actor is reentrant at every await: a write waits for the one before
  /// it so its read sees what that one wrote.
  private func serialized(_ run: @escaping @Sendable () async throws -> Void) async throws {
    let previous = tail
    let task = Task {
      await previous?.value
      try await run()
    }
    tail = Task { _ = try? await task.value }
    try await task.value
  }
}
