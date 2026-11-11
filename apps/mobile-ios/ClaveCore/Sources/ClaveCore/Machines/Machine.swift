import Foundation

/// A machine the phone may reach, whatever lists it: the relay of the team,
/// or a server a developer pasted the address of.
public struct Machine: Sendable, Equatable, Hashable, Identifiable, Codable {
  public let id: String
  public let name: String
  public let platform: MachinePlatform
  public let version: String
  public let online: Bool
  /// Epoch milliseconds of the last time the relay heard the machine; nil when never.
  public let lastSeen: Double?
  /// Where the machine's API is reached from the phone.
  public let baseUrl: String
  /// Where its push channel is reached.
  public let pushUrl: String

  public init(id: String, name: String, platform: MachinePlatform, version: String, online: Bool, lastSeen: Double?, baseUrl: String, pushUrl: String) {
    self.id = id
    self.name = name
    self.platform = platform
    self.version = version
    self.online = online
    self.lastSeen = lastSeen
    self.baseUrl = baseUrl
    self.pushUrl = pushUrl
  }
}

/// Anything that lists machines.
public protocol MachineSource: Sendable {
  /// The machines, as the source knows them now.
  func list() async throws -> [Machine]
}

/// What a machine is reached with: its API's base URL and the bearer the
/// phone holds for it (a device session, or a server token on a developer
/// machine). Its description never shows the bearer.
public struct Credential: Sendable, Equatable, Codable, CustomStringConvertible, CustomDebugStringConvertible {
  public let serverUrl: String
  public let bearer: String

  public init(serverUrl: String, bearer: String) {
    self.serverUrl = serverUrl
    self.bearer = bearer
  }

  public var description: String { "Credential(\(serverUrl), bearer redacted)" }
  public var debugDescription: String { description }
}

/// The credentials of the machines, one per machine id, and which machine is the main one.
public protocol CredentialStore: Sendable {
  /// The credential kept for `machineId`, nil when there is none.
  func get(_ machineId: String) async throws -> Credential?
  /// Keeps `credential` for `machineId`; the first one kept becomes the main machine.
  func set(_ machineId: String, _ credential: Credential) async throws
  /// Forgets the credential of `machineId`, and the main mark when it was that one.
  func remove(_ machineId: String) async throws
  /// The machine whose saved profiles the launch form lists: the first paired, or the one marked main.
  func mainMachineId() async throws -> String?
  /// Marks a machine as the main one, or clears the mark.
  func setMainMachineId(_ machineId: String?) async throws
}
