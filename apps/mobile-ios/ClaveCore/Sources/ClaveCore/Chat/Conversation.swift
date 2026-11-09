import Foundation

// The conversation reducer of the chat, ported from the prototype's
// `apps/mobile/src/chat/reducer.ts`, itself the desktop's
// `apps/plugins/chat-view/src/reducer.ts` (Clave, MIT) with the semantics
// unchanged: assistant deltas joined until `final`, a tool call paired with
// its result by id, the permission cards and what the kernel's state does to
// them, the pages of the past put in front. The desktop's file is the
// original: a change there is a change here.

/// One message the person (or another tab) wrote.
public struct UserTurn: Sendable, Equatable {
  /// The item's key for good: only a page of the past moves `Conversation.first`, never this.
  public var ordinal: Int
  public var text: String
  public var attachments: [Attachment]
  public var clientMessageId: String?
  public var parent: String?
  /// Epoch milliseconds.
  public var at: Double
  /// The reader stopped the turn this message started (`turn_interrupted`).
  public var interrupted: Bool
  /// Taken back before the agent answered anything; undone if an answer arrives.
  public var withdrawn: Bool
}

/// The agent's words, joined from deltas until the closing frame.
public struct AssistantTurn: Sendable, Equatable {
  public var ordinal: Int
  public var text: String
  public var final: Bool
  public var parent: String?
  public var at: Double
}

/// A tool call and, once it arrived, its result.
public struct ToolCall: Sendable, Equatable {
  public var ordinal: Int
  public var id: String
  public var name: String?
  public var input: JSONValue?
  public var output: JSONValue?
  public var complete: Bool
  /// The adapter's word that this call failed, never a guess read off the output; nil when it said nothing.
  public var failed: Bool?
  public var parent: String?
  public var at: Double

  public init(ordinal: Int = 0, id: String, name: String? = nil, input: JSONValue? = nil, output: JSONValue? = nil, complete: Bool = false, failed: Bool? = nil, parent: String? = nil, at: Double = 0) {
    self.ordinal = ordinal
    self.id = id
    self.name = name
    self.input = input
    self.output = output
    self.complete = complete
    self.failed = failed
    self.parent = parent
    self.at = at
  }
}

/// Where a permission card stands.
public enum PermissionCardState: Sendable, Equatable {
  /// The agent waits on the person.
  case pending
  /// Answered from this phone with this option.
  case answered(optionId: String)
  /// The kernel left `blocked` while the request was open: another client answered it, or the
  /// adapter no longer holds it. A later `blocked` reopens it.
  case answeredElsewhere
  /// Withdrawn for good by the provider; a later `blocked` cannot reopen it.
  case withdrawn
}

/// A permission prompt in the transcript.
public struct PermissionCard: Sendable, Equatable {
  public var ordinal: Int
  public var request: PermissionRequestEvent
  public var state: PermissionCardState
  /// The questions' answers sent with the option, when it asked questions.
  public var answers: [String: String]?
  public var at: Double

  public init(ordinal: Int = 0, request: PermissionRequestEvent, state: PermissionCardState = .pending, answers: [String: String]? = nil, at: Double = 0) {
    self.ordinal = ordinal
    self.request = request
    self.state = state
    self.answers = answers
    self.at = at
  }

  /// The option answered from here, if any.
  public var answer: String? {
    if case .answered(let optionId) = state { return optionId }
    return nil
  }

  /// Nothing answered it yet and the kernel still waits on it.
  public var isOpen: Bool { state == .pending }
}

/// An error the stream carried.
public struct ErrorItem: Sendable, Equatable {
  public var ordinal: Int
  public var message: String
  public var fatal: Bool
  public var at: Double
}

/// One item of the transcript, keyed for good by its ordinal.
public enum ConversationItem: Sendable, Equatable, Identifiable {
  case user(UserTurn)
  case assistant(AssistantTurn)
  case tool(ToolCall)
  case permission(PermissionCard)
  case error(ErrorItem)
  /// A document the agent presented for review (`clave_open_side_panel`), paired with its result like a tool.
  case document(ToolCall)

  /// The ordinal, stable while the item lives: `first + index` when it was made.
  public var id: Int { ordinal }

  /// The ordinal the item was made with.
  public var ordinal: Int {
    switch self {
    case .user(let v): return v.ordinal
    case .assistant(let v): return v.ordinal
    case .tool(let v): return v.ordinal
    case .permission(let v): return v.ordinal
    case .error(let v): return v.ordinal
    case .document(let v): return v.ordinal
    }
  }

  func withOrdinal(_ ordinal: Int) -> ConversationItem {
    switch self {
    case .user(var v): v.ordinal = ordinal; return .user(v)
    case .assistant(var v): v.ordinal = ordinal; return .assistant(v)
    case .tool(var v): v.ordinal = ordinal; return .tool(v)
    case .permission(var v): v.ordinal = ordinal; return .permission(v)
    case .error(var v): v.ordinal = ordinal; return .error(v)
    case .document(var v): v.ordinal = ordinal; return .document(v)
    }
  }

  /// The tool call under a tool or a document item.
  public var toolCall: ToolCall? {
    switch self {
    case .tool(let call), .document(let call): return call
    default: return nil
    }
  }

  var isUser: Bool { if case .user = self { return true } else { return false } }
}

/// The permission modes a provider offers and the current one.
public struct PermissionModeState: Sendable, Equatable {
  public var mode: String
  public var modes: [PermissionOption]
}

/// How full the main conversation's context is.
public struct ContextUsage: Sendable, Equatable {
  public var used: Double
  public var window: Double?
}

/// A conversation: the transcript and what the stream says about the session around it.
public struct Conversation: Sendable, Equatable {
  public var items: [ConversationItem]
  /// The ordinal of `items[0]`; only a page of the past moves it, so no item on screen changes key.
  public var first: Int
  public var state: AgentState
  public var model: String?
  public var effort: String?
  public var permissionMode: PermissionModeState?
  /// The main conversation's last `context_usage`; a subagent's is not the conversation's.
  public var contextUsage: ContextUsage?
  /// Each subagent's model, by its parent tool call.
  public var subagentModels: [String: String]
  /// The provider's background tasks as last listed.
  public var backgroundTasks: [BackgroundTask]
  public var exitCode: Int?
  /// The last fatal error the stream carried, for the phone's `error` state.
  public var fatal: String?

  public init(items: [ConversationItem] = [], first: Int = 0, state: AgentState = .idle, model: String? = nil, effort: String? = nil, permissionMode: PermissionModeState? = nil, contextUsage: ContextUsage? = nil, subagentModels: [String: String] = [:], backgroundTasks: [BackgroundTask] = [], exitCode: Int? = nil, fatal: String? = nil) {
    self.items = items
    self.first = first
    self.state = state
    self.model = model
    self.effort = effort
    self.permissionMode = permissionMode
    self.contextUsage = contextUsage
    self.subagentModels = subagentModels
    self.backgroundTasks = backgroundTasks
    self.exitCode = exitCode
    self.fatal = fatal
  }

  /// The conversation before anything arrived.
  public static let empty = Conversation()

  /// The requests the agent still waits on, oldest first.
  public var openRequests: [PermissionRequestEvent] {
    items.compactMap { item in
      if case .permission(let card) = item, card.isOpen { return card.request }
      return nil
    }
  }
}

/// What changes a conversation.
public enum ConversationAction: Sendable, Equatable {
  /// The conversation rebuilt from a first page (oldest first).
  case sync([HistoryItem])
  /// A page of the past, oldest first, in front of what is here.
  case prepend([HistoryItem])
  /// One live event; `at` in epoch milliseconds, now when nil.
  case event(SessionEvent, at: Double?)
  /// The person answered a permission card from here.
  case permissionAnswered(id: String, optionId: String, answers: [String: String]? = nil)
  /// The session's process ended with this code.
  case exit(Int)
  /// The person took back the last message before the agent answered it.
  case withdraw
}

/// Whether anything but the person's own words came after their last message.
public func answeredSince(_ items: [ConversationItem]) -> Bool {
  let last = items.lastIndex(where: { $0.isUser }) ?? -1
  return items[(last + 1)...].contains { item in
    switch item {
    case .user: return false
    case .assistant(let turn): return !turn.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    default: return true
    }
  }
}

private func nowMilliseconds() -> Double { Date().timeIntervalSince1970 * 1000 }

private func reduceItem(_ state: Conversation, _ item: HistoryItem) -> Conversation {
  reduceConversation(state, .event(item.event, at: item.at))
}

/// The next conversation after one action, exactly as the prototype's reducer.
public func reduceConversation(_ conversation: Conversation, _ action: ConversationAction) -> Conversation {
  var state = conversation
  switch action {
  case .exit(let code):
    state.state = .ended
    state.exitCode = code
    return state
  case .withdraw:
    if answeredSince(state.items) { return state }
    guard let last = state.items.lastIndex(where: { $0.isUser }), case .user(var message) = state.items[last] else {
      return state
    }
    message.withdrawn = true
    state.items[last] = .user(message)
    return state
  case .sync(let items):
    if items.isEmpty { return state }
    state.items = []
    state.first = 0
    return items.reduce(state, reduceItem)
  case .prepend(let items):
    if items.isEmpty { return state }
    let past = items.reduce(Conversation.empty, reduceItem).items
    let first = state.first - past.count
    state.items = past.enumerated().map { $0.element.withOrdinal(first + $0.offset) } + state.items
    state.first = first
    return state
  case .permissionAnswered(let id, let optionId, let answers):
    state.items = state.items.map { item in
      guard case .permission(var card) = item, card.request.id == id else { return item }
      card.state = .answered(optionId: optionId)
      if let answers { card.answers = answers }
      return .permission(card)
    }
    let waiting = state.items.contains { if case .permission(let card) = $0 { return card.isOpen } else { return false } }
    if state.state == .blocked && !waiting { state.state = .working }
    return state
  case .event(let event, let given):
    return reduceEvent(state, event, at: given ?? nowMilliseconds())
  }
}

private func reduceEvent(_ conversation: Conversation, _ event: SessionEvent, at: Double) -> Conversation {
  var state = conversation
  switch event {
  case .stateChange(let next):
    let marks = next == .working || next == .done || next == .idle
    let clears = next == .blocked
    state.items = state.items.map { item in
      guard case .permission(var card) = item else { return item }
      if marks && card.state == .pending {
        card.state = .answeredElsewhere
      } else if clears && card.state == .answeredElsewhere {
        card.state = .pending
      }
      return .permission(card)
    }
    state.state = next
    return state
  case .permissionWithdrawn(let id):
    state.items = state.items.map { item in
      guard case .permission(var card) = item, card.request.id == id,
            card.state == .pending || card.state == .answeredElsewhere else { return item }
      card.state = .withdrawn
      return .permission(card)
    }
    return state
  case .subagentModel(let parent, let model):
    // The prototype drops this frame; kept by parent so a tool card can name the subagent's model.
    state.subagentModels[parent] = model
    return state
  default:
    break
  }
  // These events belong to the subagent's transcript, as on desktop.
  if let parent = parentOf(event), !parent.isEmpty { return state }
  var items = state.items
  let next = state.first + items.count
  switch event {
  case .userMessage(let message):
    items.append(.user(UserTurn(ordinal: next, text: message.text, attachments: message.attachments ?? [], clientMessageId: message.clientMessageId, parent: message.parent, at: at, interrupted: false, withdrawn: false)))
  case .assistantText(let delta, let final, let parent):
    if case .assistant(var last)? = items.last, !last.final {
      last.text += delta
      last.final = final
      items[items.count - 1] = .assistant(last)
    } else if delta.isEmpty && final {
      if let open = items.lastIndex(where: { if case .assistant(let t) = $0 { return !t.final } else { return false } }),
         case .assistant(var answer) = items[open] {
        answer.final = true
        items[open] = .assistant(answer)
      }
    } else {
      items.append(.assistant(AssistantTurn(ordinal: next, text: delta, final: final, parent: parent, at: at)))
    }
  case .toolCall(let id, let name, let input, let parent):
    let index = items.firstIndex(where: { $0.toolCall?.id == id })
    var call = index.flatMap { items[$0].toolCall } ?? ToolCall(ordinal: next, id: id, parent: parent, at: at)
    call.name = name
    call.input = input
    let item: ConversationItem = isDocumentTool(name) ? .document(call) : .tool(call)
    if let index { items[index] = item } else { items.append(item) }
  case .toolResult(let id, let output, let error, let parent):
    let index = items.firstIndex(where: { $0.toolCall?.id == id })
    var call = index.flatMap { items[$0].toolCall } ?? ToolCall(ordinal: next, id: id, parent: parent, at: at)
    call.output = output
    call.complete = true
    call.failed = error
    let item: ConversationItem = isDocumentTool(call.name) ? .document(call) : .tool(call)
    if let index { items[index] = item } else { items.append(item) }
  case .permissionRequest(let request):
    let known = items.contains { if case .permission(let card) = $0 { return card.request.id == request.id } else { return false } }
    if !known { items.append(.permission(PermissionCard(ordinal: next, request: request, at: at))) }
    state.items = items
    state.state = .blocked
    return state
  case .sessionMeta(let model, _):
    state.model = model
    return state
  case .effort(let effort):
    state.effort = effort
    return state
  case .permissionMode(let mode, let modes):
    state.permissionMode = PermissionModeState(mode: mode, modes: modes)
    return state
  case .error(let message, let fatal):
    items.append(.error(ErrorItem(ordinal: next, message: message, fatal: fatal, at: at)))
    state.items = items
    if fatal {
      state.state = .ended
      state.fatal = message
    }
    return state
  case .turnInterrupted:
    if let started = items.lastIndex(where: { $0.isUser }), case .user(var message) = items[started] {
      message.interrupted = true
      items[started] = .user(message)
    }
    if let open = items.lastIndex(where: { if case .assistant(let t) = $0 { return !t.final } else { return false } }),
       case .assistant(var answer) = items[open] {
      answer.final = true
      items[open] = .assistant(answer)
    }
  case .contextUsage(let used, let window, _):
    state.contextUsage = ContextUsage(used: used, window: window)
    return state
  case .backgroundTasks(let tasks):
    state.backgroundTasks = tasks
    return state
  case .providerEvent, .unknown, .stateChange, .permissionWithdrawn, .subagentModel:
    break
  }
  if let taken = items.lastIndex(where: { $0.isUser }), case .user(var message) = items[taken],
     message.withdrawn, answeredSince(items) {
    message.withdrawn = false
    items[taken] = .user(message)
  }
  state.items = items
  return state
}

private func parentOf(_ event: SessionEvent) -> String? {
  switch event {
  case .userMessage(let message): return message.parent
  case .assistantText(_, _, let parent): return parent
  case .toolCall(_, _, _, let parent): return parent
  case .toolResult(_, _, _, let parent): return parent
  case .contextUsage(_, _, let parent): return parent
  default: return nil
  }
}
