import Foundation

// A send and what the phone does when its outcome is not seen, ported from
// the prototype's `apps/mobile/src/chat/send.ts` (decision 10 of the spec and
// the write-status seam of 29 October 2026). The message goes out under an
// id the phone minted; when the write's answer is lost the phone asks the
// server what it knows of that id and applies the table:
//
// - accepted: the message counts as sent.
// - pending: asked again with backoff for at most the budget, then unknown.
// - rejected: the draft stays with the reason; a resend is a new id.
// - absent: the same send is completed once with the same id; a second loss is unknown, and a
//   completion the server refuses (401, 403) is writeRefused: still unknown, never written again by
//   itself.
// - unknown: nothing is sent by itself; the person chooses.
//
// Pure over its ports, so every branch runs in a test.

/// What a send reaches the server through.
public struct SendPorts: Sendable {
  /// Performs the write under this id; throws a `ServerError` on failure.
  public var write: @Sendable (_ clientMessageId: String) async throws -> WriteAnswer
  /// Asks the server what it knows of the id; throws on failure.
  public var status: @Sendable (_ clientMessageId: String) async throws -> WriteStatus
  /// Waits this many milliseconds.
  public var sleep: @Sendable (_ milliseconds: Double) async throws -> Void
  /// The clock, in milliseconds.
  public var now: @Sendable () -> Double

  public init(
    write: @escaping @Sendable (_ clientMessageId: String) async throws -> WriteAnswer,
    status: @escaping @Sendable (_ clientMessageId: String) async throws -> WriteStatus,
    sleep: @escaping @Sendable (_ milliseconds: Double) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64(max(0, $0) * 1_000_000)) },
    now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }
  ) {
    self.write = write
    self.status = status
    self.sleep = sleep
    self.now = now
  }
}

/// How one send ended.
public enum SendOutcome: Sendable, Equatable {
  /// The message landed: at once, or found accepted on reconciliation.
  case sent(clientMessageId: String, reconciled: Bool)
  /// The server refused the write or recorded it rejected: the draft stays.
  case rejected(clientMessageId: String, reason: String)
  /// Nobody can tell: the draft stays, nothing was sent by itself.
  case unknown(clientMessageId: String, reason: String)
  /// Another kind of failure (the token refused, a scope that forbids it): the draft stays.
  case failed(clientMessageId: String, reason: String)
  /// The outcome is still not known: the server refused this phone's attempt to complete the send
  /// under the same id (401 or 403), and no write of it happens again by itself; its status may still
  /// be read.
  case writeRefused(clientMessageId: String, reason: String)

  /// The id the send went out under.
  public var clientMessageId: String {
    switch self {
    case .sent(let id, _), .rejected(let id, _), .unknown(let id, _), .failed(let id, _), .writeRefused(let id, _): return id
    }
  }

  /// The sentence a send that did not land carries.
  public var reason: String? {
    switch self {
    case .sent: return nil
    case .rejected(_, let reason), .unknown(_, let reason), .failed(_, let reason), .writeRefused(_, let reason): return reason
    }
  }
}

/// The bounds of the reconciliation.
public struct SendOptions: Sendable, Equatable {
  /// How long `pending` is asked again before it counts as unknown, in milliseconds.
  public var pendingBudget: Double
  /// The first wait between two status asks, doubling up to `maxBackoff`, in milliseconds.
  public var backoff: Double
  public var maxBackoff: Double

  public init(pendingBudget: Double = 60_000, backoff: Double = 1_000, maxBackoff: Double = 8_000) {
    self.pendingBudget = pendingBudget
    self.backoff = backoff
    self.maxBackoff = maxBackoff
  }
}

/// Whether the write's outcome went unseen: no answer came back, or the write was cancelled after it
/// may have left the phone.
private func lost(_ error: Error) -> Bool {
  if error is CancellationError { return true }
  return (error as? ServerError)?.outcomeLost ?? false
}

/// The sentence an error carries: a server's own message, else the error as text.
func reasonOf(_ error: Error) -> String {
  if let error = error as? ServerError { return error.message }
  if let error = error as? LocalizedError, let description = error.errorDescription { return description }
  return String(describing: error)
}

/// One send: the write, then the table when the answer was lost.
public func sendMessage(_ clientMessageId: String, ports: SendPorts, options: SendOptions = SendOptions()) async -> SendOutcome {
  do {
    let answer = try await ports.write(clientMessageId)
    if answer.status == .accepted { return .sent(clientMessageId: clientMessageId, reconciled: false) }
  } catch {
    if !lost(error) { return refusal(clientMessageId, error) }
  }
  return await reconcile(clientMessageId, ports: ports, options: options, mayRetry: true)
}

/// The server answered the write with a refusal: the message did not land, or nobody can say.
private func refusal(_ clientMessageId: String, _ error: Error) -> SendOutcome {
  if let error = error as? ServerError {
    if error.failure?.tag == "SessionWriteUnknown" { return .unknown(clientMessageId: clientMessageId, reason: error.message) }
    if error.kind == .refused {
      let tag = error.failure?.tag
      // Only these two tags prove the message did not land; any other refusal proves nothing.
      if tag == "SessionWriteRefused" || tag == "SessionNotFound" { return .rejected(clientMessageId: clientMessageId, reason: error.message) }
      return .unknown(clientMessageId: clientMessageId, reason: error.message)
    }
  }
  return .failed(clientMessageId: clientMessageId, reason: reasonOf(error))
}

/// The table, for a send whose outcome was not seen. `mayRetry` is the one same-id retry `absent`
/// permits; the first `absent` spends it, so a send lost twice ends unknown.
public func reconcile(_ clientMessageId: String, ports: SendPorts, options: SendOptions = SendOptions(), mayRetry: Bool = true) async -> SendOutcome {
  let budget = options.pendingBudget
  var backoff = options.backoff
  let started = ports.now()
  while true {
    let status: WriteStatus
    do {
      status = try await ports.status(clientMessageId)
    } catch {
      // A server without the route (404), or one we cannot reach: it cannot tell, and neither can the phone.
      let reason = (error as? ServerError)?.status == 404
        ? "This server cannot say whether the message arrived."
        : "The server could not be asked whether the message arrived (\(reasonOf(error)))."
      return .unknown(clientMessageId: clientMessageId, reason: reason)
    }
    switch status.status {
    case .accepted:
      return .sent(clientMessageId: clientMessageId, reconciled: true)
    case .rejected:
      return .rejected(clientMessageId: clientMessageId, reason: status.reason ?? "The server refused the message.")
    case .unknown:
      return .unknown(clientMessageId: clientMessageId, reason: status.reason ?? "The server cannot say whether the message arrived.")
    case .absent:
      if !mayRetry {
        return .unknown(clientMessageId: clientMessageId, reason: "The message was sent again once and its outcome is still not known.")
      }
      do {
        let answer = try await ports.write(clientMessageId)
        if answer.status == .accepted { return .sent(clientMessageId: clientMessageId, reconciled: true) }
        return await reconcile(clientMessageId, ports: ports, options: options, mayRetry: false)
      } catch {
        // A 401 or 403 proves only that this attempt was refused: the first write may still land.
        if let refused = error as? ServerError, refused.kind == .unauthenticated || refused.kind == .forbidden {
          return .writeRefused(clientMessageId: clientMessageId, reason: refused.message)
        }
        if !lost(error) { return refusal(clientMessageId, error) }
        return await reconcile(clientMessageId, ports: ports, options: options, mayRetry: false)
      }
    case .pending:
      if ports.now() - started >= budget {
        return .unknown(clientMessageId: clientMessageId, reason: "The server is still working on the message after a minute.")
      }
      do {
        try await ports.sleep(min(backoff, max(0, budget - (ports.now() - started))))
      } catch {
        return .unknown(clientMessageId: clientMessageId, reason: "The server cannot say whether the message arrived.")
      }
      backoff = min(options.maxBackoff, backoff * 2)
    }
  }
}

private let messageIdAlphabet = Array("0123456789abcdef")

/// The id the phone mints for a message: "m-" and 24 hex digits, within the server's 8 to 64
/// characters of letters, digits, dot, underscore, colon and dash.
public func mintClientMessageId() -> String {
  var generator = SystemRandomNumberGenerator()
  return mintClientMessageId(using: &generator)
}

/// The same, with the randomness given (a test's seeded generator).
public func mintClientMessageId<G: RandomNumberGenerator>(using generator: inout G) -> String {
  "m-" + String((0..<24).map { _ in messageIdAlphabet.randomElement(using: &generator)! })
}

/// Whether an id is one the server honours: 8 to 64 characters of letters, digits, dot, underscore, colon and dash.
public func isValidClientMessageId(_ id: String) -> Bool {
  (8...64).contains(id.count) && id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || ".:_-".contains($0)) }
}
