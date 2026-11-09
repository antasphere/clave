import Foundation

// The relay's directory as a phone reads it (`relay.ts`, `docs/mobile-relay.md`):
// `GET <relay>/machines` with the hub's bearer lists the subject's machines;
// `<relay>/m/<machineId>/<path>` is the road to one of them.

public let relayMachinesPath = "/machines"
public let relayMachinePrefix = "/m/"
public let relayPushPath = "/push"

public enum MachinePlatform: String, Codable, Sendable, CaseIterable {
  case macos, linux, unknown
}

public struct DirectAddress: Codable, Sendable, Equatable, Hashable {
  public let url: String

  public init(url: String) { self.url = url }
}

/// One row of `GET /machines`. The platform and the version are read
/// leniently (a later relay may add a platform; the phone shows what it can),
/// the id is required.
public struct MachineView: Codable, Sendable, Equatable, Hashable, Identifiable {
  public let id: String
  public let name: String
  public let platform: MachinePlatform
  public let version: String
  public let online: Bool
  /// Epoch milliseconds of the last time the relay heard the machine; nil when never.
  public let lastSeen: Double?
  public let direct: [DirectAddress]

  public init(id: String, name: String, platform: MachinePlatform, version: String, online: Bool, lastSeen: Double?, direct: [DirectAddress]) {
    self.id = id
    self.name = name
    self.platform = platform
    self.version = version
    self.online = online
    self.lastSeen = lastSeen
    self.direct = direct
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    id = try c.decodeNonEmpty("id")
    let name = try c.decodeOptionalString("name") ?? ""
    self.name = name.isEmpty ? id : name
    platform = MachinePlatform(rawValue: (try? c.decodeOptionalString("platform")) ?? "") ?? .unknown
    version = (try? c.decodeOptionalString("version")) ?? ""
    online = (try? c.decodeIfPresent("online", Bool.self)) ?? false
    if let number = try? c.decodeIfPresent("lastSeen", Double.self) {
      lastSeen = number
    } else if let text = try? c.decodeOptionalString("lastSeen"), let date = ISO8601DateFormatter().date(from: text) {
      lastSeen = date.timeIntervalSince1970 * 1000
    } else {
      lastSeen = nil
    }
    direct = (try? c.decodeIfPresent("direct", [DirectAddress].self)) ?? []
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(id, key: "id")
    try c.encode(name, key: "name")
    try c.encode(platform, key: "platform")
    try c.encode(version, key: "version")
    try c.encode(online, key: "online")
    try c.encodeNullable(lastSeen, key: "lastSeen")
    try c.encode(direct, key: "direct")
  }
}

public struct MachineList: Codable, Sendable, Equatable {
  public let machines: [MachineView]

  public init(machines: [MachineView]) { self.machines = machines }
}

/// `<relay>/m/<machineId>`, the base of every call to one machine through the relay.
public func machineBaseURL(relay: String, machineId: String) -> String {
  var base = relay
  while base.hasSuffix("/") { base.removeLast() }
  let id = machineId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? machineId
  return "\(base)\(relayMachinePrefix)\(id)"
}

/// `<relay>/m/<machineId>/push`, the machine's push channel through the relay.
public func machinePushURL(relay: String, machineId: String) -> String {
  machineBaseURL(relay: relay, machineId: machineId) + relayPushPath
}
