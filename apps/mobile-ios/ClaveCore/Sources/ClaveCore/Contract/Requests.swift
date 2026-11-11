import Foundation

// The requests domain (`requests.ts`, `docs/server-requests.md`): the pending
// requests of a server and the answers a phone sends. A secret's value
// travels in the resolve body and nowhere else.

public enum RequestKind: String, Codable, Sendable, CaseIterable {
  case permission, clarification, secret
}

/// What a resolved secret does on the owning server: a run with the value in
/// an environment variable, or a line written in an env file.
public enum SecretAction: Codable, Sendable, Equatable, Hashable {
  case run(command: String, cwd: String, envVar: String)
  case envFile(file: String, key: String)

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    let type = try c.decodeString("type")
    switch type {
    case "run":
      self = .run(command: try c.decodeNonEmpty("command"), cwd: try c.decodeNonEmpty("cwd"), envVar: try c.decodeNonEmpty("envVar"))
    case "env-file":
      self = .envFile(file: try c.decodeNonEmpty("file"), key: try c.decodeNonEmpty("key"))
    default:
      throw DecodingError.dataCorruptedError(forKey: AnyKey("type"), in: c, debugDescription: "run or env-file")
    }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    switch self {
    case .run(let command, let cwd, let envVar):
      try c.encode("run", key: "type")
      try c.encode(command, key: "command")
      try c.encode(cwd, key: "cwd")
      try c.encode(envVar, key: "envVar")
    case .envFile(let file, let key):
      try c.encode("env-file", key: "type")
      try c.encode(file, key: "file")
      try c.encode(key, key: "key")
    }
  }
}

public struct PendingRequest: Codable, Sendable, Equatable, Hashable, Identifiable {
  public let id: String
  public let sessionId: String
  public let kind: RequestKind
  public let description: String
  public let createdAt: Double
  public let providerRequestId: String?
  public let options: [PermissionOption]?
  public let questions: [AgentQuestion]?
  /// Canonical question keys (id, or legacy text) whose inputs must be masked.
  public let secretQuestions: [String]?
  public let toolName: String?
  public let detail: String?
  public let input: JSONValue?
  public let action: SecretAction?

  public init(id: String, sessionId: String, kind: RequestKind, description: String, createdAt: Double, providerRequestId: String? = nil, options: [PermissionOption]? = nil, questions: [AgentQuestion]? = nil, secretQuestions: [String]? = nil, toolName: String? = nil, detail: String? = nil, input: JSONValue? = nil, action: SecretAction? = nil) {
    self.id = id
    self.sessionId = sessionId
    self.kind = kind
    self.description = description
    self.createdAt = createdAt
    self.providerRequestId = providerRequestId
    self.options = options
    self.questions = questions
    self.secretQuestions = secretQuestions
    self.toolName = toolName
    self.detail = detail
    self.input = input
    self.action = action
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    id = try c.decodeNonEmpty("id")
    sessionId = try c.decodeNonEmpty("sessionId")
    kind = try c.decodeLiteral("kind", RequestKind.self)
    description = try c.decodeNonEmpty("description")
    createdAt = try c.decodeDouble("createdAt")
    providerRequestId = try c.contains(AnyKey("providerRequestId")) ? c.decodeNonEmpty("providerRequestId") : nil
    options = try c.decodeIfPresent("options", [PermissionOption].self)
    questions = try c.decodeIfPresent("questions", [AgentQuestion].self)
    secretQuestions = try c.decodeIfPresent("secretQuestions", [String].self)
    toolName = try c.contains(AnyKey("toolName")) ? c.decodeNonEmpty("toolName") : nil
    detail = try c.contains(AnyKey("detail")) ? c.decodeNonEmpty("detail") : nil
    input = try c.decodeIfPresent("input", JSONValue.self)
    action = try c.decodeIfPresent("action", SecretAction.self)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(id, key: "id")
    try c.encode(sessionId, key: "sessionId")
    try c.encode(kind, key: "kind")
    try c.encode(description, key: "description")
    try c.encode(createdAt, key: "createdAt")
    try c.encodeIfPresent(providerRequestId, key: "providerRequestId")
    try c.encodeIfPresent(options, key: "options")
    try c.encodeIfPresent(questions, key: "questions")
    try c.encodeIfPresent(secretQuestions, key: "secretQuestions")
    try c.encodeIfPresent(toolName, key: "toolName")
    try c.encodeIfPresent(detail, key: "detail")
    try c.encodeIfPresent(input, key: "input")
    try c.encodeIfPresent(action, key: "action")
  }
}

/// `GET /requests/pending`.
public struct RequestSnapshot: Codable, Sendable, Equatable {
  public let revision: Double
  public let pending: [PendingRequest]

  public init(revision: Double, pending: [PendingRequest]) {
    self.revision = revision
    self.pending = pending
  }
}

/// The answer to a pending request: a permission's option (with the answers
/// of its questions), a clarification's answers, a secret's value, a dismissal.
public enum RequestResponse: Codable, Sendable, Equatable {
  case permission(optionId: String, answers: [String: String]?)
  case clarification(answers: [String: String])
  case secret(value: String)
  case dismiss

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    let type = try c.decodeString("type")
    switch type {
    case "permission":
      self = .permission(optionId: try c.decodeString("optionId"), answers: try c.decodeIfPresent("answers", [String: String].self))
    case "clarification":
      self = .clarification(answers: try c.decodeValue("answers", [String: String].self))
    case "secret":
      self = .secret(value: try c.decodeString("value"))
    case "dismiss":
      self = .dismiss
    default:
      throw DecodingError.dataCorruptedError(forKey: AnyKey("type"), in: c, debugDescription: "permission, clarification, secret or dismiss")
    }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    switch self {
    case .permission(let optionId, let answers):
      try c.encode("permission", key: "type")
      try c.encode(optionId, key: "optionId")
      try c.encodeIfPresent(answers, key: "answers")
    case .clarification(let answers):
      try c.encode("clarification", key: "type")
      try c.encode(answers, key: "answers")
    case .secret(let value):
      try c.encode("secret", key: "type")
      try c.encode(value, key: "value")
    case .dismiss:
      try c.encode("dismiss", key: "type")
    }
  }
}

/// `POST /requests/resolve`'s body.
public struct ResolveRequestInput: Codable, Sendable, Equatable {
  public let requestId: String
  public let response: RequestResponse

  public init(requestId: String, response: RequestResponse) {
    self.requestId = requestId
    self.response = response
  }
}

public struct ResolveOutcome: Codable, Sendable, Equatable {
  public let accepted: Bool

  public init(accepted: Bool) { self.accepted = accepted }
}
