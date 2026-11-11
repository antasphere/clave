import Foundation

/// The credential store over a secure store the caller has already scoped to
/// one owner: `machine.<id>` holds the credential as JSON, `machines.main`
/// the main machine, and `machines.index` the ids kept, since a Keychain
/// cannot be listed by prefix cheaply. Nothing here is ever logged.
public actor SecureCredentialStore: CredentialStore {
  private let secure: any SecureStore

  static let mainKey = "machines.main"
  static let indexKey = "machines.index"
  static func key(_ machineId: String) -> String { "machine.\(machineId)" }

  /// A store over `secure`.
  public init(_ secure: any SecureStore) {
    self.secure = secure
  }

  public func get(_ machineId: String) async throws -> Credential? {
    guard let raw = try await secure.get(Self.key(machineId)) else { return nil }
    // An unreadable entry is no credential.
    return try? ContractJSON.decode(Credential.self, from: raw)
  }

  public func set(_ machineId: String, _ credential: Credential) async throws {
    try await secure.set(Self.key(machineId), try ContractJSON.encodeToString(credential))
    var ids = try await known()
    if !ids.contains(machineId) {
      ids.append(machineId)
      try await writeIndex(ids)
    }
    if try await mainMachineId() == nil { try await setMainMachineId(machineId) }
  }

  public func remove(_ machineId: String) async throws {
    try await secure.delete(Self.key(machineId))
    let ids = try await known()
    if ids.contains(machineId) { try await writeIndex(ids.filter { $0 != machineId }) }
    if try await mainMachineId() == machineId { try await setMainMachineId(nil) }
  }

  public func mainMachineId() async throws -> String? {
    guard let id = try await secure.get(Self.mainKey), !id.isEmpty else { return nil }
    return id
  }

  public func setMainMachineId(_ machineId: String?) async throws {
    if let machineId {
      try await secure.set(Self.mainKey, machineId)
    } else {
      try await secure.delete(Self.mainKey)
    }
  }

  /// The machine ids a credential is kept for, in the order they were first kept.
  public func known() async throws -> [String] {
    guard let raw = try await secure.get(Self.indexKey) else { return [] }
    return (try? JSONDecoder().decode([String].self, from: Data(raw.utf8))) ?? []
  }

  private func writeIndex(_ ids: [String]) async throws {
    if ids.isEmpty {
      try await secure.delete(Self.indexKey)
    } else {
      try await secure.set(Self.indexKey, String(decoding: try JSONEncoder().encode(ids), as: UTF8.self))
    }
  }
}
