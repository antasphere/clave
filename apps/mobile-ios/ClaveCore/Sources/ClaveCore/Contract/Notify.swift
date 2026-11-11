import Foundation

// The notify domain as the phone reads a push (`notify.ts`,
// `docs/mobile-push.md`): the categories, the actions and the payload under
// the `clave` key of an APNs alert. Never a secret, a token or an answer.

public enum NotificationCategory: String, Codable, Sendable, CaseIterable {
  case question, permission, secret, finished, failed
  case accountLimit = "account_limit"
  case test

  /// The action category the phone registers its buttons under (`aps.category`).
  public var categoryId: String { "clave.\(rawValue)" }
}

public enum NotificationAction: String, Codable, Sendable, CaseIterable {
  case allow, deny, reply, open
}

public struct NotificationPayload: Codable, Sendable, Equatable {
  public let category: NotificationCategory
  public let serverId: String
  /// The machine's name as the server knows it (its hostname).
  public let serverName: String
  /// Empty on an account limit and a test, which are about no conversation.
  public let sessionId: String
  public let sessionTitle: String
  public let workspaceName: String?
  /// The id the phone resolves the request with on that server.
  public let requestId: String?
  public let text: String
  /// The actions the phone may offer; a value this build does not know is dropped.
  public let actions: [NotificationAction]

  public init(category: NotificationCategory, serverId: String, serverName: String, sessionId: String, sessionTitle: String, workspaceName: String? = nil, requestId: String? = nil, text: String, actions: [NotificationAction]) {
    self.category = category
    self.serverId = serverId
    self.serverName = serverName
    self.sessionId = sessionId
    self.sessionTitle = sessionTitle
    self.workspaceName = workspaceName
    self.requestId = requestId
    self.text = text
    self.actions = actions
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    category = try c.decodeLiteral("category", NotificationCategory.self)
    serverId = try c.decodeString("serverId")
    serverName = try c.decodeString("serverName")
    sessionId = try c.decodeString("sessionId")
    sessionTitle = try c.decodeString("sessionTitle")
    workspaceName = try c.decodeOptionalString("workspaceName")
    requestId = try c.decodeOptionalString("requestId")
    text = try c.decodeString("text")
    actions = try c.decodeValue("actions", [String].self).compactMap(NotificationAction.init(rawValue:))
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(category, key: "category")
    try c.encode(serverId, key: "serverId")
    try c.encode(serverName, key: "serverName")
    try c.encode(sessionId, key: "sessionId")
    try c.encode(sessionTitle, key: "sessionTitle")
    try c.encodeIfPresent(workspaceName, key: "workspaceName")
    try c.encodeIfPresent(requestId, key: "requestId")
    try c.encode(text, key: "text")
    try c.encode(actions, key: "actions")
  }
}
