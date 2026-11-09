import Foundation

/// Where a notification takes the app: a conversation, the machine's
/// requests (on one of them when it is named), the machine's workspaces, or
/// the machines list with the reason the notification could not go further.
public enum NotificationDestination: Sendable, Equatable, Codable {
  case chat(machineId: String, sessionId: String, title: String)
  case requests(machineId: String, requestId: String?)
  case workspaces(machineId: String)
  case machines(reason: String)

  /// The URL form, for the two places a URL can name.
  public var deepLink: DeepLink? {
    switch self {
    case .chat(let machineId, let sessionId, _): return .chat(machineId: machineId, sessionId: sessionId)
    case .requests(let machineId, let requestId?): return .request(machineId: machineId, requestId: requestId)
    default: return nil
    }
  }
}

/// Which screen a notification opens on when nothing stops it.
public enum NotificationTarget: Sendable, Equatable {
  case conversation, request
}

/// What the person did on a notification, as the payload allows it.
public enum NotificationIntent: Sendable, Equatable {
  case allow(NotificationPayload)
  case deny(NotificationPayload)
  case reply(NotificationPayload, text: String)
  case open(NotificationPayload)

  /// The payload the intent is about.
  public var payload: NotificationPayload {
    switch self {
    case .allow(let p), .deny(let p), .open(let p), .reply(let p, _): return p
    }
  }
}

/// The intent of a tapped notification. An action the payload did not
/// offer, or a reply without text, is a plain open: the server decides which
/// buttons may answer, never the phone.
public func interpretNotification(_ payload: NotificationPayload, actionIdentifier: String, userText: String?) -> NotificationIntent {
  switch NotificationAction(identifier: actionIdentifier) {
  case .allow?: return payload.actions.contains(.allow) ? .allow(payload) : .open(payload)
  case .deny?: return payload.actions.contains(.deny) ? .deny(payload) : .open(payload)
  case .reply?:
    let text = userText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return payload.actions.contains(.reply) && !text.isEmpty ? .reply(payload, text: text) : .open(payload)
  case .open?, nil:
    return .open(payload)
  }
}

/// The server's rule for which option ids are an allow and a deny, the same words here.
private func isAllowOption(_ id: String) -> Bool {
  ["allow", "allow-once", "approve", "accept", "yes", "ok"].contains(id.lowercased())
}

private func isDenyOption(_ id: String) -> Bool {
  ["deny", "decline", "reject", "cancel", "no"].contains(id.lowercased())
}

/// The option id to answer with: the request's own when it is known, else the
/// Claude adapter's `allow-once` and `deny`. Several allows give the narrower `allow-once`.
public func permissionOptionId(_ options: [PermissionOption]?, allow: Bool) -> String {
  if allow, let once = options?.first(where: { $0.id == "allow-once" }) { return once.id }
  let own = options?.first { allow ? isAllowOption($0.id) : isDenyOption($0.id) }
  return own?.id ?? (allow ? "allow-once" : "deny")
}

/// A permission's answer from the request's own options.
public func permissionResponse(_ request: PendingRequest?, allow: Bool) -> RequestResponse {
  .permission(optionId: permissionOptionId(request?.options, allow: allow), answers: nil)
}

// The key a question's answer is filed under is `questionKey(_:)` of Requests/Answers.swift.

/// A typed reply to the one question of a request, keyed by its answer key;
/// nil when the request asks several questions or none, which the app answers.
/// A request held under a provider id answers as a permission with `answer`.
public func replyResponse(_ request: PendingRequest, text: String) -> RequestResponse? {
  guard let questions = request.questions, questions.count == 1 else { return nil }
  let answers = [questionKey(questions[0]): text]
  if request.kind == .permission || request.providerRequestId != nil {
    return .permission(optionId: "answer", answers: answers)
  }
  return .clarification(answers: answers)
}

/// What answering from the notification came to.
public enum SettleOutcome: Sendable, Equatable {
  case settled
  /// Somebody else answered first, or the request is gone.
  case alreadySettled
  /// The notification cannot settle this: the app opens on it.
  case openApp(reason: String)
  case failed(reason: String)
}

/// What answering a notification needs of a machine's server.
public protocol NotificationServer: Sendable {
  func pendingRequests() async throws -> RequestSnapshot
  func resolve(_ requestId: String, _ response: RequestResponse) async throws -> ResolveOutcome
  func write(_ sessionId: String, _ input: SessionWriteInput) async throws -> WriteAnswer
  func session(_ id: String) async throws -> Session
}

extension ClaveServerClient: NotificationServer {
  public func pendingRequests() async throws -> RequestSnapshot { try await requests.pending() }
  public func resolve(_ requestId: String, _ response: RequestResponse) async throws -> ResolveOutcome {
    try await requests.resolve(requestId, response)
  }
  public func write(_ sessionId: String, _ input: SessionWriteInput) async throws -> WriteAnswer {
    try await sessions.write(sessionId, input)
  }
  public func session(_ id: String) async throws -> Session { try await sessions.get(id) }
}

private func reason(_ error: Error) -> String {
  (error as? ServerError)?.message ?? "\(error)"
}

/// Answers a notification's action. The answer is shaped from the pending
/// request fetched by its id, never from the payload: the option ids are the
/// adapter's and a question's key is not in the payload's bounded text. A
/// server without the requests port (the Mac app's in-process server) holds
/// the prompt as a stream frame, and allow and deny go through the write route.
public func settleFromNotification(_ intent: NotificationIntent, server: any NotificationServer) async -> SettleOutcome {
  let payload = intent.payload
  if case .open = intent { return .openApp(reason: "The notification was opened.") }
  guard let requestId = payload.requestId, !requestId.isEmpty else {
    return .openApp(reason: "The notification names no request to answer.")
  }
  let snapshot: RequestSnapshot
  do {
    snapshot = try await server.pendingRequests()
  } catch let error as ServerError where error.capabilityUnavailable {
    return await settleInChat(intent, requestId: requestId, server: server)
  } catch {
    return .failed(reason: reason(error))
  }
  guard let request = snapshot.pending.first(where: { $0.id == requestId }) else { return .alreadySettled }
  guard request.sessionId == payload.sessionId else {
    return .openApp(reason: "The notification no longer matches this conversation.")
  }
  let response: RequestResponse
  switch intent {
  case .reply(_, let text):
    guard let reply = replyResponse(request, text: text) else {
      return .openApp(reason: "This question needs the app to be answered.")
    }
    response = reply
  case .allow, .deny:
    guard request.kind == .permission else { return .openApp(reason: "This request needs the app.") }
    let allow: Bool
    if case .allow = intent { allow = true } else { allow = false }
    let optionId = permissionOptionId(request.options, allow: allow)
    // A request that offers only a permanent grant is never granted from a lock screen.
    if let options = request.options, !options.isEmpty, !options.contains(where: { $0.id == optionId }) {
      return .openApp(reason: "Choose the permission in the app.")
    }
    response = .permission(optionId: optionId, answers: nil)
  case .open:
    return .openApp(reason: "The notification was opened.")
  }
  do {
    return try await server.resolve(request.id, response).accepted ? .settled : .alreadySettled
  } catch {
    return .failed(reason: reason(error))
  }
}

private func settleInChat(_ intent: NotificationIntent, requestId: String, server: any NotificationServer) async -> SettleOutcome {
  let allow: Bool
  switch intent {
  case .allow: allow = true
  case .deny: allow = false
  default: return .openApp(reason: "This question needs the app to be answered.")
  }
  let sessionId = intent.payload.sessionId
  guard !sessionId.isEmpty else { return .openApp(reason: "The notification names no conversation to answer in.") }
  do {
    let answer = try await server.write(
      sessionId,
      .permissionResponse(PermissionResponse(id: requestId, optionId: permissionOptionId(nil, allow: allow))))
    return answer.status == .pending ? .openApp(reason: "The answer is still pending. Check it in the app.") : .settled
  } catch let error as ServerError where error.kind == .refused {
    return .alreadySettled
  } catch {
    return .failed(reason: reason(error))
  }
}

/// Where a payload takes the app, given the machine its server is reached through.
public func notificationDestination(_ payload: NotificationPayload, machineId: String?, target: NotificationTarget = .conversation) -> NotificationDestination {
  guard let machineId else {
    let name = payload.serverName.isEmpty ? "That machine" : payload.serverName
    return .machines(reason: "\(name) is not paired with this phone.")
  }
  if target == .request, let requestId = payload.requestId, !requestId.isEmpty {
    return .requests(machineId: machineId, requestId: requestId)
  }
  if !payload.sessionId.isEmpty {
    return .chat(machineId: machineId, sessionId: payload.sessionId, title: payload.sessionTitle)
  }
  return .workspaces(machineId: machineId)
}

/// What the app does after a notification was handled.
public enum NotificationOutcome: Sendable, Equatable {
  /// Not Clave's push.
  case ignored
  /// Answered from the notification; nothing to open.
  case settled
  /// Open the app here.
  case open(NotificationDestination)
}

/// Handles a tapped notification end to end: the machine resolved from the
/// payload's server, that machine's own credential (never another's), the
/// action settled through its server, and where the app opens otherwise.
/// When the conversation is gone on the server, the app opens on the
/// machine's requests instead of an empty chat.
public func respondToNotification(
  _ payload: NotificationPayload?,
  actionIdentifier: String,
  userText: String?,
  machines: any MachineResolver,
  credentials: any CredentialStore,
  server: @Sendable (Credential) throws -> any NotificationServer
) async -> NotificationOutcome {
  guard let payload else { return .ignored }
  let intent = interpretNotification(payload, actionIdentifier: actionIdentifier, userText: userText)
  guard let machineId = try? await machines.machineId(forServer: payload.serverId) else {
    return .open(notificationDestination(payload, machineId: nil))
  }
  guard let credential = try? await credentials.get(machineId), let client = try? server(credential) else {
    return .open(.machines(reason: "Pair this phone again."))
  }
  if case .open = intent {
    // A button the payload did not offer still meant "answer this": open on the request.
    let pressedAnAnswer = [NotificationAction.allow, .deny, .reply].map(\.identifier).contains(actionIdentifier)
    let destination = notificationDestination(payload, machineId: machineId, target: pressedAnAnswer ? .request : .conversation)
    guard case .chat(_, let sessionId, _) = destination else { return .open(destination) }
    do {
      _ = try await client.session(sessionId)
    } catch let error as ServerError where error.kind == .notFound || error.failure?.tag == "SessionNotFound" {
      return .open(.requests(machineId: machineId, requestId: payload.requestId))
    } catch {
      // Unreachable is not gone: the conversation screen says the machine is offline.
    }
    return .open(destination)
  }
  switch await settleFromNotification(intent, server: client) {
  case .settled, .alreadySettled:
    return .settled
  case .openApp, .failed:
    return .open(notificationDestination(payload, machineId: machineId, target: .request))
  }
}
