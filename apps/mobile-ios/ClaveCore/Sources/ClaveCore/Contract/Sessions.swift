import Foundation

// The shapes of `packages/contract/src/sessions.ts` the phone speaks, one to
// one with the prototype's mirror (`apps/mobile/src/contract/types.ts`): a
// session, what it writes, and every event of a session's stream.

public enum AgentState: String, Codable, Sendable, CaseIterable {
  case idle, working, blocked, done, ended
}

public enum SessionTransport: String, Codable, Sendable, CaseIterable {
  case pty, events
}

public struct Session: Codable, Sendable, Equatable, Hashable, Identifiable {
  public let id: String
  public let provider: String
  public let transport: SessionTransport
  public let cwd: String
  public let windowKey: String
  /// The host record's workspace stamp, absent on an unstamped or older session.
  public let workspaceId: String?
  public let groupId: String?
  public let state: AgentState
  /// Epoch milliseconds, the server's clock.
  public let createdAt: Double
  public let adapterId: String
  public let title: String
  public let viewId: String?

  public init(id: String, provider: String, transport: SessionTransport, cwd: String, windowKey: String, workspaceId: String? = nil, groupId: String? = nil, state: AgentState, createdAt: Double, adapterId: String, title: String, viewId: String? = nil) {
    self.id = id
    self.provider = provider
    self.transport = transport
    self.cwd = cwd
    self.windowKey = windowKey
    self.workspaceId = workspaceId
    self.groupId = groupId
    self.state = state
    self.createdAt = createdAt
    self.adapterId = adapterId
    self.title = title
    self.viewId = viewId
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    id = try c.decodeNonEmpty("id")
    provider = try c.decodeNonEmpty("provider")
    transport = try c.decodeLiteral("transport", SessionTransport.self)
    cwd = try c.decodeString("cwd")
    windowKey = try c.decodeString("windowKey")
    workspaceId = try c.decodeOptionalString("workspaceId")
    groupId = try c.decodeOptionalString("groupId")
    state = try c.decodeLiteral("state", AgentState.self)
    createdAt = try c.decodeDouble("createdAt")
    adapterId = try c.decodeNonEmpty("adapterId")
    title = try c.decodeString("title")
    viewId = try c.decodeOptionalString("viewId")
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(id, key: "id")
    try c.encode(provider, key: "provider")
    try c.encode(transport, key: "transport")
    try c.encode(cwd, key: "cwd")
    try c.encode(windowKey, key: "windowKey")
    try c.encodeIfPresent(workspaceId, key: "workspaceId")
    try c.encodeIfPresent(groupId, key: "groupId")
    try c.encode(state, key: "state")
    try c.encode(createdAt, key: "createdAt")
    try c.encode(adapterId, key: "adapterId")
    try c.encode(title, key: "title")
    try c.encodeIfPresent(viewId, key: "viewId")
  }
}

public enum FileDelivery: String, Codable, Sendable, CaseIterable {
  case reference, image, folder
}

/// A file or folder attached to a message, as the server's file service
/// prepared it (`files.ts`' FileAttachment, with the label a message adds).
public struct FileAttachment: Codable, Sendable, Equatable, Hashable, Identifiable {
  public let id: String
  public let label: String?
  public let path: String
  public let name: String
  public let mimeType: String
  public let size: Int
  public let delivery: FileDelivery
  /// A folder's top-level item count; folders only.
  public let entries: Int?

  public init(id: String, label: String? = nil, path: String, name: String, mimeType: String, size: Int, delivery: FileDelivery, entries: Int? = nil) {
    self.id = id
    self.label = label
    self.path = path
    self.name = name
    self.mimeType = mimeType
    self.size = size
    self.delivery = delivery
    self.entries = entries
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    id = try c.decodeNonEmpty("id")
    label = try c.decodeOptionalString("label")
    path = try c.decodeNonEmpty("path")
    name = try c.decodeNonEmpty("name")
    mimeType = try c.decodeNonEmpty("mimeType")
    size = try c.decodeNonNegativeInt("size")
    delivery = try c.decodeLiteral("delivery", FileDelivery.self)
    entries = try c.contains(AnyKey("entries")) ? c.decodeNonNegativeInt("entries") : nil
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(id, key: "id")
    try c.encodeIfPresent(label, key: "label")
    try c.encode(path, key: "path")
    try c.encode(name, key: "name")
    try c.encode(mimeType, key: "mimeType")
    try c.encode(size, key: "size")
    try c.encode(delivery, key: "delivery")
    try c.encodeIfPresent(entries, key: "entries")
  }
}

/// Another session attached to a message.
public struct SessionAttachment: Codable, Sendable, Equatable, Hashable, Identifiable {
  public let id: String
  public let label: String?
  public let sessionId: String
  public let name: String
  public let agent: String
  public let cwd: String

  public init(id: String, label: String? = nil, sessionId: String, name: String, agent: String, cwd: String) {
    self.id = id
    self.label = label
    self.sessionId = sessionId
    self.name = name
    self.agent = agent
    self.cwd = cwd
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    id = try c.decodeNonEmpty("id")
    label = try c.decodeOptionalString("label")
    sessionId = try c.decodeNonEmpty("sessionId")
    name = try c.decodeNonEmpty("name")
    agent = try c.decodeNonEmpty("agent")
    cwd = try c.decodeString("cwd")
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(id, key: "id")
    try c.encodeIfPresent(label, key: "label")
    try c.encode("session", key: "delivery")
    try c.encode(sessionId, key: "sessionId")
    try c.encode(name, key: "name")
    try c.encode(agent, key: "agent")
    try c.encode(cwd, key: "cwd")
  }
}

/// An attachment of a message: a file (or folder) the server prepared, or a session.
public enum Attachment: Codable, Sendable, Equatable, Hashable {
  case file(FileAttachment)
  case session(SessionAttachment)

  public var id: String {
    switch self {
    case .file(let file): return file.id
    case .session(let session): return session.id
    }
  }

  public var label: String? {
    switch self {
    case .file(let file): return file.label
    case .session(let session): return session.label
    }
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    let delivery = try c.decodeString("delivery")
    if delivery == "session" {
      self = .session(try SessionAttachment(from: decoder))
    } else {
      self = .file(try FileAttachment(from: decoder))
    }
  }

  public func encode(to encoder: Encoder) throws {
    switch self {
    case .file(let file): try file.encode(to: encoder)
    case .session(let session): try session.encode(to: encoder)
    }
  }
}

/// A message a person writes to a session, with the id the phone minted so
/// the server honours it once (8 to 64 characters of letters, digits, dot,
/// underscore, colon and dash).
public struct UserMessage: Codable, Sendable, Equatable, Hashable {
  public let clientMessageId: String?
  public let text: String
  public let attachments: [Attachment]?
  public let parent: String?

  public init(clientMessageId: String? = nil, text: String, attachments: [Attachment]? = nil, parent: String? = nil) {
    self.clientMessageId = clientMessageId
    self.text = text
    self.attachments = attachments
    self.parent = parent
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    let type = try c.decodeString("type")
    guard type == "user_message" else {
      throw DecodingError.dataCorruptedError(forKey: AnyKey("type"), in: c, debugDescription: "user_message")
    }
    clientMessageId = try c.decodeOptionalString("clientMessageId")
    text = try c.decodeString("text")
    attachments = try c.decodeIfPresent("attachments", [Attachment].self)
    parent = try c.decodeOptionalString("parent")
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode("user_message", key: "type")
    try c.encodeIfPresent(clientMessageId, key: "clientMessageId")
    try c.encode(text, key: "text")
    try c.encodeIfPresent(attachments, key: "attachments")
    try c.encodeIfPresent(parent, key: "parent")
  }
}

/// The answer to a permission prompt through the write route.
public struct PermissionResponse: Codable, Sendable, Equatable, Hashable {
  public let id: String
  public let optionId: String
  public let answers: [String: String]?

  public init(id: String, optionId: String, answers: [String: String]? = nil) {
    self.id = id
    self.optionId = optionId
    self.answers = answers
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    id = try c.decodeString("id")
    optionId = try c.decodeString("optionId")
    answers = try c.decodeIfPresent("answers", [String: String].self)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode("permission_response", key: "type")
    try c.encode(id, key: "id")
    try c.encode(optionId, key: "optionId")
    try c.encodeIfPresent(answers, key: "answers")
  }
}

/// What the phone writes to a session: a message, an answer to a prompt, or an interrupt.
public enum SessionWriteInput: Encodable, Sendable, Equatable {
  case userMessage(UserMessage)
  case permissionResponse(PermissionResponse)
  case interrupt

  public func encode(to encoder: Encoder) throws {
    switch self {
    case .userMessage(let message):
      try message.encode(to: encoder)
    case .permissionResponse(let response):
      try response.encode(to: encoder)
    case .interrupt:
      var c = encoder.container(keyedBy: AnyKey.self)
      try c.encode("interrupt", key: "type")
    }
  }
}

/// `POST /sessions/write`'s body: the session and what is written.
public struct WriteSessionInput: Encodable, Sendable, Equatable {
  public let id: String
  public let input: SessionWriteInput

  public init(id: String, input: SessionWriteInput) {
    self.id = id
    self.input = input
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(id, key: "id")
    try c.encode(input, key: "input")
  }
}

public struct PermissionOption: Codable, Sendable, Equatable, Hashable, Identifiable {
  public let id: String
  public let label: String

  public init(id: String, label: String) {
    self.id = id
    self.label = label
  }
}

public struct AgentQuestionOption: Codable, Sendable, Equatable, Hashable {
  public let label: String
  public let description: String?

  public init(label: String, description: String? = nil) {
    self.label = label
    self.description = description
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    label = try c.decodeString("label")
    description = try c.decodeOptionalString("description")
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(label, key: "label")
    try c.encodeIfPresent(description, key: "description")
  }
}

/// A question an agent asks. Its answer is keyed by `id` when it has one,
/// else by the question's text (`docs/server-requests.md`).
public struct AgentQuestion: Codable, Sendable, Equatable, Hashable {
  public let id: String?
  public let question: String
  public let header: String?
  public let options: [AgentQuestionOption]
  public let multiSelect: Bool?

  public init(id: String? = nil, question: String, header: String? = nil, options: [AgentQuestionOption], multiSelect: Bool? = nil) {
    self.id = id
    self.question = question
    self.header = header
    self.options = options
    self.multiSelect = multiSelect
  }

  /// The key an answer is recorded under: the id, else the text.
  public var answerKey: String { id ?? question }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    id = try c.contains(AnyKey("id")) ? c.decodeNonEmpty("id") : nil
    question = try c.decodeString("question")
    header = try c.decodeOptionalString("header")
    options = try c.decodeValue("options", [AgentQuestionOption].self)
    multiSelect = try c.decodeIfPresent("multiSelect", Bool.self)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encodeIfPresent(id, key: "id")
    try c.encode(question, key: "question")
    try c.encodeIfPresent(header, key: "header")
    try c.encode(options, key: "options")
    try c.encodeIfPresent(multiSelect, key: "multiSelect")
  }
}

public enum BackgroundTaskKind: String, Codable, Sendable, CaseIterable {
  case shell, agent, other
}

public struct BackgroundTask: Codable, Sendable, Equatable, Hashable, Identifiable {
  public let id: String
  public let kind: BackgroundTaskKind
  public let description: String
  public let command: String?
  public let toolUseId: String?
  public let startedAt: Double
  public let outputFile: String?
  public let model: String?

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    id = try c.decodeString("id")
    kind = try c.decodeLiteral("kind", BackgroundTaskKind.self)
    description = try c.decodeString("description")
    command = try c.decodeOptionalString("command")
    toolUseId = try c.decodeOptionalString("toolUseId")
    startedAt = try c.decodeDouble("startedAt")
    outputFile = try c.decodeOptionalString("outputFile")
    model = try c.decodeOptionalString("model")
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(id, key: "id")
    try c.encode(kind, key: "kind")
    try c.encode(description, key: "description")
    try c.encodeIfPresent(command, key: "command")
    try c.encodeIfPresent(toolUseId, key: "toolUseId")
    try c.encode(startedAt, key: "startedAt")
    try c.encodeIfPresent(outputFile, key: "outputFile")
    try c.encodeIfPresent(model, key: "model")
  }
}

/// A permission prompt in a session's stream (the in-process server's shape of a request).
public struct PermissionRequestEvent: Codable, Sendable, Equatable, Hashable {
  public let id: String
  public let description: String
  public let options: [PermissionOption]
  public let toolName: String?
  public let input: JSONValue?
  public let detail: String?
  public let questions: [AgentQuestion]?

  public init(id: String, description: String, options: [PermissionOption], toolName: String? = nil, input: JSONValue? = nil, detail: String? = nil, questions: [AgentQuestion]? = nil) {
    self.id = id
    self.description = description
    self.options = options
    self.toolName = toolName
    self.input = input
    self.detail = detail
    self.questions = questions
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    id = try c.decodeString("id")
    description = try c.decodeString("description")
    options = try c.decodeValue("options", [PermissionOption].self)
    toolName = try c.decodeOptionalString("toolName")
    input = try c.decodeIfPresent("input", JSONValue.self)
    detail = try c.decodeOptionalString("detail")
    questions = try c.decodeIfPresent("questions", [AgentQuestion].self)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode("permission_request", key: "type")
    try c.encode(id, key: "id")
    try c.encode(description, key: "description")
    try c.encode(options, key: "options")
    try c.encodeIfPresent(toolName, key: "toolName")
    try c.encodeIfPresent(input, key: "input")
    try c.encodeIfPresent(detail, key: "detail")
    try c.encodeIfPresent(questions, key: "questions")
  }
}

/// One event of a session's stream, keyed by `type`. A type this file does
/// not know is carried through by its name and ignored by the reducer, the
/// rule the prototype's mirror states for what it does not read.
public enum SessionEvent: Codable, Sendable, Equatable, Hashable {
  case userMessage(UserMessage)
  case assistantText(delta: String, final: Bool, parent: String?)
  case toolCall(id: String, name: String, input: JSONValue?, parent: String?)
  case toolResult(id: String, output: JSONValue?, error: Bool?, parent: String?)
  case permissionRequest(PermissionRequestEvent)
  case stateChange(AgentState)
  case sessionMeta(model: String?, providerSessionId: String?)
  case effort(String?)
  case error(message: String, fatal: Bool)
  case turnInterrupted
  case permissionWithdrawn(id: String)
  case contextUsage(used: Double, window: Double?, parent: String?)
  case subagentModel(parent: String, model: String)
  case permissionMode(mode: String, modes: [PermissionOption])
  case backgroundTasks([BackgroundTask])
  case providerEvent(provider: String, payload: JSONValue?)
  case unknown(type: String)

  /// The wire name of the event's type.
  public var typeName: String {
    switch self {
    case .userMessage: return "user_message"
    case .assistantText: return "assistant_text"
    case .toolCall: return "tool_call"
    case .toolResult: return "tool_result"
    case .permissionRequest: return "permission_request"
    case .stateChange: return "state_change"
    case .sessionMeta: return "session_meta"
    case .effort: return "effort"
    case .error: return "error"
    case .turnInterrupted: return "turn_interrupted"
    case .permissionWithdrawn: return "permission_withdrawn"
    case .contextUsage: return "context_usage"
    case .subagentModel: return "subagent_model"
    case .permissionMode: return "permission_mode"
    case .backgroundTasks: return "background_tasks"
    case .providerEvent: return "provider_event"
    case .unknown(let type): return type
    }
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    let type = try c.decodeString("type")
    switch type {
    case "user_message":
      self = .userMessage(try UserMessage(from: decoder))
    case "assistant_text":
      self = .assistantText(delta: try c.decodeString("delta"), final: try c.decodeBool("final"), parent: try c.decodeOptionalString("parent"))
    case "tool_call":
      self = .toolCall(id: try c.decodeString("id"), name: try c.decodeString("name"), input: try c.decodeIfPresent("input", JSONValue.self), parent: try c.decodeOptionalString("parent"))
    case "tool_result":
      self = .toolResult(id: try c.decodeString("id"), output: try c.decodeIfPresent("output", JSONValue.self), error: try c.decodeIfPresent("error", Bool.self), parent: try c.decodeOptionalString("parent"))
    case "permission_request":
      self = .permissionRequest(try PermissionRequestEvent(from: decoder))
    case "state_change":
      self = .stateChange(try c.decodeLiteral("state", AgentState.self))
    case "session_meta":
      self = .sessionMeta(model: try c.decodeNullableString("model"), providerSessionId: try c.decodeNullableString("providerSessionId"))
    case "effort":
      self = .effort(try c.decodeNullableString("effort"))
    case "error":
      self = .error(message: try c.decodeString("message"), fatal: try c.decodeBool("fatal"))
    case "turn_interrupted":
      self = .turnInterrupted
    case "permission_withdrawn":
      self = .permissionWithdrawn(id: try c.decodeString("id"))
    case "context_usage":
      self = .contextUsage(used: try c.decodeDouble("used"), window: try c.decodeNullable("window", Double.self), parent: try c.decodeOptionalString("parent"))
    case "subagent_model":
      self = .subagentModel(parent: try c.decodeString("parent"), model: try c.decodeString("model"))
    case "permission_mode":
      self = .permissionMode(mode: try c.decodeString("mode"), modes: try c.decodeValue("modes", [PermissionOption].self))
    case "background_tasks":
      self = .backgroundTasks(try c.decodeValue("tasks", [BackgroundTask].self))
    case "provider_event":
      self = .providerEvent(provider: try c.decodeString("provider"), payload: try c.decodeIfPresent("payload", JSONValue.self))
    default:
      self = .unknown(type: type)
    }
  }

  public func encode(to encoder: Encoder) throws {
    switch self {
    case .userMessage(let message):
      try message.encode(to: encoder)
      return
    case .permissionRequest(let request):
      try request.encode(to: encoder)
      return
    default:
      break
    }
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(typeName, key: "type")
    switch self {
    case .assistantText(let delta, let final, let parent):
      try c.encode(delta, key: "delta")
      try c.encode(final, key: "final")
      try c.encodeIfPresent(parent, key: "parent")
    case .toolCall(let id, let name, let input, let parent):
      try c.encode(id, key: "id")
      try c.encode(name, key: "name")
      try c.encodeIfPresent(input, key: "input")
      try c.encodeIfPresent(parent, key: "parent")
    case .toolResult(let id, let output, let error, let parent):
      try c.encode(id, key: "id")
      try c.encodeIfPresent(output, key: "output")
      try c.encodeIfPresent(error, key: "error")
      try c.encodeIfPresent(parent, key: "parent")
    case .stateChange(let state):
      try c.encode(state, key: "state")
    case .sessionMeta(let model, let providerSessionId):
      try c.encodeNullable(model, key: "model")
      try c.encodeNullable(providerSessionId, key: "providerSessionId")
    case .effort(let effort):
      try c.encodeNullable(effort, key: "effort")
    case .error(let message, let fatal):
      try c.encode(message, key: "message")
      try c.encode(fatal, key: "fatal")
    case .permissionWithdrawn(let id):
      try c.encode(id, key: "id")
    case .contextUsage(let used, let window, let parent):
      try c.encode(used, key: "used")
      try c.encodeNullable(window, key: "window")
      try c.encodeIfPresent(parent, key: "parent")
    case .subagentModel(let parent, let model):
      try c.encode(parent, key: "parent")
      try c.encode(model, key: "model")
    case .permissionMode(let mode, let modes):
      try c.encode(mode, key: "mode")
      try c.encode(modes, key: "modes")
    case .backgroundTasks(let tasks):
      try c.encode(tasks, key: "tasks")
    case .providerEvent(let provider, let payload):
      try c.encode(provider, key: "provider")
      try c.encodeIfPresent(payload, key: "payload")
    case .userMessage, .permissionRequest, .turnInterrupted, .unknown:
      break
    }
  }
}

/// One frame of a session's stream: terminal bytes (base64, unused on a
/// phone) or an event with the position the ordered timeline gives it.
public enum SessionStream: Codable, Sendable, Equatable {
  case pty(data: String)
  case event(SessionEvent, position: SessionPosition?)

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    let kind = try c.decodeString("kind")
    switch kind {
    case "pty":
      self = .pty(data: try c.decodeString("data"))
    case "event":
      self = .event(try c.decodeValue("event", SessionEvent.self), position: try c.decodeIfPresent("position", SessionPosition.self))
    default:
      throw DecodingError.dataCorruptedError(forKey: AnyKey("kind"), in: c, debugDescription: "pty or event")
    }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    switch self {
    case .pty(let data):
      try c.encode("pty", key: "kind")
      try c.encode(data, key: "data")
    case .event(let event, let position):
      try c.encode("event", key: "kind")
      try c.encode(event, key: "event")
      try c.encodeIfPresent(position, key: "position")
    }
  }
}

/// One item of the legacy history route: the event and when it happened.
public struct HistoryItem: Codable, Sendable, Equatable {
  public let event: SessionEvent
  public let at: Double?

  public init(event: SessionEvent, at: Double? = nil) {
    self.event = event
    self.at = at
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    event = try c.decodeValue("event", SessionEvent.self)
    at = try c.decodeIfPresent("at", Double.self)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(event, key: "event")
    try c.encodeIfPresent(at, key: "at")
  }
}

/// `GET /sessions/history`: the newest page first, `before` the offset of the page before it.
public struct HistoryPage: Codable, Sendable, Equatable {
  public let items: [HistoryItem]
  public let before: Int?

  public init(items: [HistoryItem], before: Int?) {
    self.items = items
    self.before = before
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    items = try c.decodeValue("items", [HistoryItem].self)
    before = try c.decodeNullable("before", Int.self)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(items, key: "items")
    try c.encodeNullable(before, key: "before")
  }
}

/// `POST /sessions/write`'s answer: landed, or a duplicate still pending.
public struct WriteAnswer: Codable, Sendable, Equatable {
  public enum Status: String, Codable, Sendable, CaseIterable {
    case accepted, pending
  }

  public let status: Status
  public let at: Double?

  public init(status: Status, at: Double? = nil) {
    self.status = status
    self.at = at
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    status = try c.decodeLiteral("status", Status.self)
    at = try c.decodeIfPresent("at", Double.self)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(status, key: "status")
    try c.encodeIfPresent(at, key: "at")
  }
}

/// `GET /sessions/writes?id=&clientMessageId=`: what the server knows of a
/// send whose outcome the phone did not see (the write-status seam).
public struct WriteStatus: Codable, Sendable, Equatable {
  public enum Kind: String, Codable, Sendable, CaseIterable {
    case accepted, pending, rejected, absent, unknown
  }

  public let status: Kind
  public let at: Double?
  public let reason: String?

  public init(status: Kind, at: Double? = nil, reason: String? = nil) {
    self.status = status
    self.at = at
    self.reason = reason
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    status = try c.decodeLiteral("status", Kind.self)
    at = try c.decodeIfPresent("at", Double.self)
    reason = try c.decodeOptionalString("reason")
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(status, key: "status")
    try c.encodeIfPresent(at, key: "at")
    try c.encodeIfPresent(reason, key: "reason")
  }
}

public struct SessionInfo: Codable, Sendable, Equatable {
  public let id: String
  public let cwd: String
  public let folderName: String
  public let alive: Bool
  public let claudeSessionId: String?
  public let piSessionId: String?
  public let launchProfileId: String?
  public let model: String?
  public let piProvider: String?
  public let piThinking: String?

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    id = try c.decodeNonEmpty("id")
    cwd = try c.decodeString("cwd")
    folderName = try c.decodeString("folderName")
    alive = try c.decodeBool("alive")
    claudeSessionId = try c.decodeNullableString("claudeSessionId")
    piSessionId = try c.decodeNullableString("piSessionId")
    launchProfileId = try c.decodeOptionalString("launchProfileId")
    model = try c.decodeOptionalString("model")
    piProvider = try c.decodeOptionalString("piProvider")
    piThinking = try c.decodeOptionalString("piThinking")
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(id, key: "id")
    try c.encode(cwd, key: "cwd")
    try c.encode(folderName, key: "folderName")
    try c.encode(alive, key: "alive")
    try c.encodeNullable(claudeSessionId, key: "claudeSessionId")
    try c.encodeNullable(piSessionId, key: "piSessionId")
    try c.encodeIfPresent(launchProfileId, key: "launchProfileId")
    try c.encodeIfPresent(model, key: "model")
    try c.encodeIfPresent(piProvider, key: "piProvider")
    try c.encodeIfPresent(piThinking, key: "piThinking")
  }
}

public struct SessionCapabilities: Codable, Sendable, Equatable {
  public let images: Bool

  public init(images: Bool) { self.images = images }
}
