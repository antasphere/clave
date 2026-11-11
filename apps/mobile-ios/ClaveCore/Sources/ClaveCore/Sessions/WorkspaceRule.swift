import Foundation

// Which sessions a workspace lists and the state a phone shows for each,
// ported from the prototype's `apps/mobile/src/state/session-state.ts` and
// `ui/status.ts`. Only the host's explicit stamp identifies a workspace: an
// unstamped session, including one from an older server, stays visible in
// every workspace, and a working folder is never workspace identity (the
// prototype's code and its test, "filters only by the stamp, never by a
// contradictory or nested cwd").

/// The workspace a session belongs to: its stamp, or nil when unstamped (every workspace lists it).
public func workspaceOfSession(_ session: Session) -> String? {
  session.workspaceId
}

/// The sessions a workspace lists: those stamped with it and every unstamped one, chats first,
/// then terminals, each group newest first. `workspaces` is the machine's list, kept for the
/// signature the screens call; a stamp naming a deleted workspace still keeps its session out of the others.
public func sessions(in workspace: WorkspaceView, of sessions: [Session], workspaces: [WorkspaceView]) -> [Session] {
  orderSessions(sessions.filter { session in
    guard let home = workspaceOfSession(session) else { return true }
    return home == workspace.id
  })
}

/// Chats (the events transport) first, then terminals, each group by creation, newest first.
public func orderSessions(_ sessions: [Session]) -> [Session] {
  sessions.sorted { a, b in
    let rankA = a.transport == .events ? 0 : 1
    let rankB = b.transport == .events ? 0 : 1
    if rankA != rankB { return rankA < rankB }
    return a.createdAt > b.createdAt
  }
}

/// The five states the phone shows, mapped from the server's: `error` is the last fatal error the
/// stream carried, which the server's own state never says.
public enum PhoneSessionState: String, Sendable, Equatable, CaseIterable {
  case working, waiting, idle, finished, error

  /// The state of a session from the server's and the last fatal error, if any.
  public init(_ server: AgentState, fatalError: String? = nil) {
    if let fatalError, !fatalError.isEmpty {
      self = .error
      return
    }
    switch server {
    case .working: self = .working
    case .blocked: self = .waiting
    case .idle: self = .idle
    case .done, .ended: self = .finished
    }
  }

  /// The state in words.
  public var label: String {
    switch self {
    case .working: return "Working"
    case .waiting: return "Waiting for you"
    case .idle: return "Idle"
    case .finished: return "Finished"
    case .error: return "Error"
    }
  }

  /// The sidebar's status glyph for the state.
  public var status: SessionStatus {
    switch self {
    case .working: return .working
    case .waiting: return .waiting
    case .idle: return .ready
    case .finished, .error: return .inactive
    }
  }
}

/// The sidebar's status glyph of a session.
public enum SessionStatus: String, Sendable, Equatable, CaseIterable {
  case working, ready, waiting, inactive

  /// The status of a session from the server's state and the last fatal error.
  public init(_ server: AgentState, fatalError: String? = nil) {
    self = PhoneSessionState(server, fatalError: fatalError).status
  }

  /// The status in words, for accessibility.
  public var label: String {
    switch self {
    case .working: return "Working"
    case .ready: return "Ready"
    case .waiting: return "Waiting for you"
    case .inactive: return "Inactive"
    }
  }
}
