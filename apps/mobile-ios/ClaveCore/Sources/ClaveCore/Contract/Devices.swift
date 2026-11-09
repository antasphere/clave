import Foundation

// The devices domain (`devices.ts`, `docs/mobile-pairing.md`): how a phone
// asks to pair, reads the owner's answer, and keeps the server told of its
// push token. The pairing routes take no bearer: the proof is in the body.

public enum DevicePlatform: String, Codable, Sendable, CaseIterable {
  case ios, android
}

/// How a phone names itself when it asks to pair.
public struct DeviceDescription: Codable, Sendable, Equatable {
  public let name: String
  public let platform: DevicePlatform
  public let appVersion: String

  public init(name: String, platform: DevicePlatform = .ios, appVersion: String) {
    self.name = name
    self.platform = platform
    self.appVersion = appVersion
  }
}

/// A paired phone as the owner and the phone itself read it: never its tokens.
public struct DeviceView: Codable, Sendable, Equatable, Identifiable {
  public let id: String
  public let name: String
  public let platform: DevicePlatform
  public let appVersion: String
  public let createdAt: Double
  public let lastSeenAt: Double?

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    id = try c.decodeNonEmpty("id")
    name = try c.decodeNonEmpty("name")
    platform = try c.decodeLiteral("platform", DevicePlatform.self)
    appVersion = try c.decodeNonEmpty("appVersion")
    createdAt = try c.decodeDouble("createdAt")
    lastSeenAt = try c.decodeNullable("lastSeenAt", Double.self)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(id, key: "id")
    try c.encode(name, key: "name")
    try c.encode(platform, key: "platform")
    try c.encode(appVersion, key: "appVersion")
    try c.encode(createdAt, key: "createdAt")
    try c.encodeNullable(lastSeenAt, key: "lastSeenAt")
  }
}

public enum PairingStatus: String, Codable, Sendable, CaseIterable {
  case pending, approved, refused, expired
}

/// The credential a phone gets once, in the one answer that carries it.
public struct DeviceSessionView: Codable, Sendable, Equatable {
  public let token: String
  public let deviceId: String
  public let serverId: String
  public let serverName: String

  public init(token: String, deviceId: String, serverId: String, serverName: String) {
    self.token = token
    self.deviceId = deviceId
    self.serverId = serverId
    self.serverName = serverName
  }
}

/// `POST /devices/pair`'s body: the hub's ID token for the phone's own client, and how it names itself.
public struct PairingRequestInput: Codable, Sendable, Equatable {
  public let idToken: String
  public let clientId: String
  public let device: DeviceDescription

  public init(idToken: String, clientId: String, device: DeviceDescription) {
    self.idToken = idToken
    self.clientId = clientId
    self.device = device
  }
}

/// `POST /devices/pair`'s answer: the pairing to poll; nothing is issued here.
public struct PairingTicket: Codable, Sendable, Equatable {
  public let pairingId: String
  public let expiresAt: Double

  public init(pairingId: String, expiresAt: Double) {
    self.pairingId = pairingId
    self.expiresAt = expiresAt
  }
}

/// `GET /devices/pair?id=`: where the pairing stands; on `approved` the session, exactly once.
public struct PairingRead: Codable, Sendable, Equatable {
  public let status: PairingStatus
  public let deviceSession: DeviceSessionView?

  public init(status: PairingStatus, deviceSession: DeviceSessionView? = nil) {
    self.status = status
    self.deviceSession = deviceSession
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    status = try c.decodeLiteral("status", PairingStatus.self)
    deviceSession = try c.decodeIfPresent("deviceSession", DeviceSessionView.self)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(status, key: "status")
    try c.encodeIfPresent(deviceSession, key: "deviceSession")
  }
}

/// `POST /devices/me/push-token`'s body.
public struct PushTokenInput: Codable, Sendable, Equatable {
  public let token: String
  public let platform: DevicePlatform

  public init(token: String, platform: DevicePlatform = .ios) {
    self.token = token
    self.platform = platform
  }
}

/// The WebSocket close code a phone's socket gets when its session is revoked.
public let closeDeviceRevoked = 4011
