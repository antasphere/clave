import Foundation

// The push channel (`push.ts`) and the server events a phone hears
// (`events.ts`, `devices.ts`): one WebSocket beside the HTTP API, every frame
// one JSON object keyed by `_tag`.

public let pushPath = "/push"
public let pushProtocol = 1
public let helloTimeoutMs = 5_000
public let closeUnauthorized = 4001
public let closeMalformed = 4002
public let closeHelloTimeout = 4008
public let closeServerStopping = 4010

/// What the phone sends on the channel.
public enum ClientFrame: Encodable, Sendable, Equatable {
  case hello(token: String, client: String?)
  case subscribe(sessionId: String)
  case unsubscribe(sessionId: String)
  case ping

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    switch self {
    case .hello(let token, let client):
      try c.encode("hello", key: "_tag")
      try c.encode(token, key: "token")
      try c.encodeIfPresent(client, key: "client")
    case .subscribe(let sessionId):
      try c.encode("subscribe", key: "_tag")
      try c.encode(sessionId, key: "sessionId")
    case .unsubscribe(let sessionId):
      try c.encode("unsubscribe", key: "_tag")
      try c.encode(sessionId, key: "sessionId")
    case .ping:
      try c.encode("ping", key: "_tag")
    }
  }
}

/// A server event the phone reads; every other member of the server's union
/// is carried by its tag and read by nobody here.
public enum ServerEvent: Codable, Sendable, Equatable {
  case requestsChanged(revision: Double)
  case sessionStateChanged(id: String, state: AgentState)
  case sessionTitleChanged(id: String, title: String)
  case sessionRenamed(id: String, name: String)
  case workspacesStateChanged(workspaces: [WorkspaceView], revision: Double, instance: String)
  case devicesChanged(revision: Double)
  case unknown(tag: String)

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    let tag = try c.decodeNonEmpty("_tag")
    switch tag {
    case "requests.changed":
      self = .requestsChanged(revision: try c.decodeDouble("revision"))
    case "session.state_changed":
      self = .sessionStateChanged(id: try c.decodeString("id"), state: try c.decodeLiteral("state", AgentState.self))
    case "session.title_changed":
      self = .sessionTitleChanged(id: try c.decodeString("id"), title: try c.decodeString("title"))
    case "session.renamed":
      self = .sessionRenamed(id: try c.decodeString("id"), name: try c.decodeString("name"))
    case "workspaces.state_changed":
      self = .workspacesStateChanged(workspaces: try c.decodeValue("workspaces", [WorkspaceView].self), revision: try c.decodeDouble("revision"), instance: try c.decodeString("instance"))
    case "devices.changed":
      self = .devicesChanged(revision: try c.decodeDouble("revision"))
    default:
      self = .unknown(tag: tag)
    }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    switch self {
    case .requestsChanged(let revision):
      try c.encode("requests.changed", key: "_tag")
      try c.encode(revision, key: "revision")
    case .sessionStateChanged(let id, let state):
      try c.encode("session.state_changed", key: "_tag")
      try c.encode(id, key: "id")
      try c.encode(state, key: "state")
    case .sessionTitleChanged(let id, let title):
      try c.encode("session.title_changed", key: "_tag")
      try c.encode(id, key: "id")
      try c.encode(title, key: "title")
    case .sessionRenamed(let id, let name):
      try c.encode("session.renamed", key: "_tag")
      try c.encode(id, key: "id")
      try c.encode(name, key: "name")
    case .workspacesStateChanged(let workspaces, let revision, let instance):
      try c.encode("workspaces.state_changed", key: "_tag")
      try c.encode(workspaces, key: "workspaces")
      try c.encode(revision, key: "revision")
      try c.encode(instance, key: "instance")
    case .devicesChanged(let revision):
      try c.encode("devices.changed", key: "_tag")
      try c.encode(revision, key: "revision")
    case .unknown(let tag):
      try c.encode(tag, key: "_tag")
    }
  }
}

/// The envelope every server event travels in.
public struct ServerEventEnvelope: Codable, Sendable, Equatable {
  public let id: String
  public let seq: Double
  public let at: Double
  public let event: ServerEvent

  public init(id: String, seq: Double, at: Double, event: ServerEvent) {
    self.id = id
    self.seq = seq
    self.at = at
    self.event = event
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    id = try c.decodeString("id")
    seq = try c.decodeDouble("seq")
    at = try c.decodeDouble("at")
    event = try c.decodeValue("event", ServerEvent.self)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(id, key: "id")
    try c.encode(seq, key: "seq")
    try c.encode(at, key: "at")
    try c.encode(event, key: "event")
  }
}

/// What the server sends on the channel. A frame of a tag this file does not
/// know (the desktop's view requests, a later server's additions) is `other`
/// and ignored.
public enum ServerFrame: Decodable, Sendable, Equatable {
  case welcome(serverId: String, version: String?)
  case subscribed(sessionId: String, session: Session)
  case unsubscribed(sessionId: String)
  case stream(sessionId: String, stream: SessionStream)
  case exit(sessionId: String, code: Int)
  case event(ServerEventEnvelope)
  case error(sessionId: String?, message: String)
  case pong
  case other(tag: String)

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    let tag = try c.decodeNonEmpty("_tag")
    switch tag {
    case "welcome":
      let protocolNumber = try c.decodeDouble("protocol")
      guard protocolNumber == Double(pushProtocol) else {
        throw DecodingError.dataCorruptedError(forKey: AnyKey("protocol"), in: c, debugDescription: "\(pushProtocol)")
      }
      self = .welcome(serverId: try c.decodeString("serverId"), version: try c.decodeOptionalString("version"))
    case "subscribed":
      self = .subscribed(sessionId: try c.decodeString("sessionId"), session: try c.decodeValue("session", Session.self))
    case "unsubscribed":
      self = .unsubscribed(sessionId: try c.decodeString("sessionId"))
    case "stream":
      self = .stream(sessionId: try c.decodeString("sessionId"), stream: try c.decodeValue("stream", SessionStream.self))
    case "exit":
      self = .exit(sessionId: try c.decodeString("sessionId"), code: Int(try c.decodeDouble("code")))
    case "event":
      self = .event(try ServerEventEnvelope(from: decoder))
    case "error":
      self = .error(sessionId: try c.decodeOptionalString("sessionId"), message: try c.decodeString("message"))
    case "pong":
      self = .pong
    default:
      self = .other(tag: tag)
    }
  }

  /// A frame from the text of a message; nil when the text is not JSON or
  /// not a frame (the socket stays open: an unknown frame is a later
  /// server's business, an unreadable one is dropped).
  public static func parse(_ text: String) -> ServerFrame? {
    try? ContractJSON.decode(ServerFrame.self, from: text)
  }
}
