import Foundation

// The reconnection pass, ported from the prototype's
// `apps/mobile/src/reconnect/pass.ts` and `controller.ts` (decision 10 of the
// spec, the write-status seam of 29 October 2026): when a machine is
// reachable again, the phone asks the server about every send whose outcome
// it does not know and applies the table, then refreshes the pending
// requests and the history of the open conversations. Nothing is sent
// merely because the connection came back; `unknown` sends nothing.

/// What a pass reaches: the ledger, the marks, the drafts and the server.
public struct ReconnectPorts: Sendable {
  public var sends: UnknownSends
  public var marks: DeliveryMarks
  public var drafts: Drafts
  /// `GET /sessions/writes` for this send; throws on failure.
  public var status: @Sendable (UnknownSend) async throws -> WriteStatus
  /// The same message under the same id; throws a `ServerError` on failure.
  public var write: @Sendable (UnknownSend) async throws -> WriteAnswer
  public var sleep: @Sendable (_ milliseconds: Double) async throws -> Void
  public var now: @Sendable () -> Double
  public var refreshRequests: @Sendable (_ machineId: String) async throws -> Void
  public var refreshHistory: @Sendable (_ machineId: String, _ sessionId: String) async throws -> Void
  /// Clears the attachment draft a landed send carried.
  public var clearAttachments: (@Sendable (UnknownSend) async throws -> Void)?
  /// A send the composer is still driving: the pass leaves it to the composer.
  public var isActive: (@Sendable (UnknownSend) async -> Bool)?

  public init(
    sends: UnknownSends,
    marks: DeliveryMarks,
    drafts: Drafts,
    status: @escaping @Sendable (UnknownSend) async throws -> WriteStatus,
    write: @escaping @Sendable (UnknownSend) async throws -> WriteAnswer,
    sleep: @escaping @Sendable (_ milliseconds: Double) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64(max(0, $0) * 1_000_000)) },
    now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 },
    refreshRequests: @escaping @Sendable (_ machineId: String) async throws -> Void,
    refreshHistory: @escaping @Sendable (_ machineId: String, _ sessionId: String) async throws -> Void,
    clearAttachments: (@Sendable (UnknownSend) async throws -> Void)? = nil,
    isActive: (@Sendable (UnknownSend) async -> Bool)? = nil
  ) {
    self.sends = sends
    self.marks = marks
    self.drafts = drafts
    self.status = status
    self.write = write
    self.sleep = sleep
    self.now = now
    self.refreshRequests = refreshRequests
    self.refreshHistory = refreshHistory
    self.clearAttachments = clearAttachments
    self.isActive = isActive
  }
}

/// What one pass did.
public struct ReconnectReport: Sendable, Equatable {
  public struct Settled: Sendable, Equatable {
    public let send: UnknownSend
    public let outcome: SendOutcome
  }

  public let outcomes: [Settled]
  public let requestsRefreshed: Bool
  /// The sessions whose history was refreshed.
  public let historyRefreshed: [String]
  public let refreshFailures: [String]
}

/// One pass over a machine: every unknown send of it asked about and settled, then the pending
/// requests and the open conversations' history refreshed, one failure never skipping the rest.
public func reconnectPass(machineId: String, openConversations: [String], ports: ReconnectPorts, options: SendOptions = SendOptions()) async throws -> ReconnectReport {
  var outcomes: [ReconnectReport.Settled] = []
  for send in try await ports.sends.forMachine(machineId) {
    if let isActive = ports.isActive, await isActive(send) { continue }
    let outcome = await reconcile(
      send.clientMessageId,
      ports: SendPorts(
        write: { _ in try await ports.write(send) },
        status: { _ in try await ports.status(send) },
        sleep: ports.sleep,
        now: ports.now),
      options: options,
      mayRetry: true)
    outcomes.append(.init(send: send, outcome: outcome))
    try await settleSend(send, outcome, sends: ports.sends, marks: ports.marks, drafts: ports.drafts, now: ports.now, clearAttachments: ports.clearAttachments)
  }
  var refreshFailures: [String] = []
  var requestsRefreshed = false
  do {
    try await ports.refreshRequests(machineId)
    requestsRefreshed = true
  } catch {
    refreshFailures.append("requests: \(reasonOf(error))")
  }
  var historyRefreshed: [String] = []
  for sessionId in openConversations {
    do {
      try await ports.refreshHistory(machineId, sessionId)
      historyRefreshed.append(sessionId)
    } catch {
      refreshFailures.append("history \(sessionId): \(reasonOf(error))")
    }
  }
  return ReconnectReport(outcomes: outcomes, requestsRefreshed: requestsRefreshed, historyRefreshed: historyRefreshed, refreshFailures: refreshFailures)
}

/// The ledger, the draft and the mark after one send's outcome: sent clears all three (the draft
/// only when it is still the text sent); rejected leaves the ledger and marks the reason; unknown
/// stays in the ledger, marked; failed waits for the next pass.
public func settleSend(
  _ send: UnknownSend,
  _ outcome: SendOutcome,
  sends: UnknownSends,
  marks: DeliveryMarks,
  drafts: Drafts,
  now: @Sendable () -> Double,
  clearAttachments: (@Sendable (UnknownSend) async throws -> Void)? = nil
) async throws {
  switch outcome {
  case .sent:
    try await sends.remove(send.clientMessageId)
    if try await drafts.get(send.machineId, send.sessionId) == (send.draftText ?? send.text) {
      try await drafts.clear(send.machineId, send.sessionId)
    }
    try await clearAttachments?(send)
    try await marks.clear(send.machineId, send.sessionId)
  case .rejected(_, let reason):
    try await sends.remove(send.clientMessageId)
    try await marks.set(send.machineId, send.sessionId, DeliveryMark(kind: .rejected, clientMessageId: send.clientMessageId, reason: reason, at: now()))
  case .unknown(_, let reason):
    try await marks.set(send.machineId, send.sessionId, DeliveryMark(kind: .unknown, clientMessageId: send.clientMessageId, reason: reason, at: now()))
  case .failed:
    // The machine is not reachable after all: the send waits for the next pass.
    break
  }
}

/// What the composer records when a send's outcome was not seen: the ledger entry and the mark,
/// so a restart finds both.
public func recordUnknownSend(_ send: UnknownSend, reason: String, sends: UnknownSends, marks: DeliveryMarks) async throws {
  try await sends.add(send)
  try await marks.set(send.machineId, send.sessionId, DeliveryMark(kind: .unknown, clientMessageId: send.clientMessageId, reason: reason, at: send.at))
}

/// The person chose to discard a send of unknown outcome: it leaves the ledger and the mark.
public func discardUnknownSend(machineId: String, sessionId: String, clientMessageId: String, sends: UnknownSends, marks: DeliveryMarks) async throws {
  try await sends.remove(clientMessageId)
  try await marks.clear(machineId, sessionId)
}

/// The composer's and the reconnection's one owner of the ledger: a send is recorded before it is
/// dispatched, settled when it ends, and skipped by a pass while it is still in flight; one pass
/// per machine runs at a time, a second request joining the one running.
public actor DeliveryController {
  public let sends: UnknownSends
  public let marks: DeliveryMarks
  private let drafts: Drafts
  private let attachmentDrafts: AttachmentDrafts
  private let now: @Sendable () -> Double
  private var active: Set<String> = []
  private var reconnecting: [String: Task<Void, Error>] = [:]

  /// The controller over one owner's ledger, marks and drafts. Pass the composer's own `Drafts`:
  /// each instance caches, so a second one over the same store would not see the composer's edits.
  public init(sends: UnknownSends, marks: DeliveryMarks, drafts: Drafts, attachmentDrafts: AttachmentDrafts, now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
    self.sends = sends
    self.marks = marks
    self.drafts = drafts
    self.attachmentDrafts = attachmentDrafts
    self.now = now
  }

  /// Whether a send is still in flight from the composer.
  public func isActive(_ clientMessageId: String) -> Bool { active.contains(clientMessageId) }

  /// Before the write leaves: the send in the ledger and marked, so a crash mid-send is found again.
  public func begin(_ send: UnknownSend) async throws {
    active.insert(send.clientMessageId)
    do {
      try await recordUnknownSend(send, reason: "Delivery has not been confirmed.", sends: sends, marks: marks)
    } catch {
      active.remove(send.clientMessageId)
      throw error
    }
  }

  /// After the send ended: settled as the table says; a plain failure leaves no trace, since the
  /// composer keeps its draft and the person sends again.
  public func finish(_ send: UnknownSend, _ outcome: SendOutcome) async throws {
    defer { active.remove(send.clientMessageId) }
    let attachments = attachmentDrafts
    try await settleSend(send, outcome, sends: sends, marks: marks, drafts: drafts, now: now, clearAttachments: { send in
      try await attachments.clearIfUnchanged(send.machineId, send.sessionId, sent: send.attachments ?? [])
    })
    if case .failed = outcome {
      try await sends.remove(send.clientMessageId)
      try await marks.clear(send.machineId, send.sessionId)
    }
  }

  /// The pass for a machine reachable again; while one runs for it, a second call joins it.
  public func reconnect(
    machineId: String,
    openConversations: [String],
    status: @escaping @Sendable (UnknownSend) async throws -> WriteStatus,
    write: @escaping @Sendable (UnknownSend) async throws -> WriteAnswer,
    refreshRequests: @escaping @Sendable (_ machineId: String) async throws -> Void,
    refreshHistory: @escaping @Sendable (_ machineId: String, _ sessionId: String) async throws -> Void,
    sleep: @escaping @Sendable (_ milliseconds: Double) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64(max(0, $0) * 1_000_000)) },
    options: SendOptions = SendOptions()
  ) async throws {
    if let running = reconnecting[machineId] {
      try await running.value
      return
    }
    let attachments = attachmentDrafts
    let ports = ReconnectPorts(
      sends: sends, marks: marks, drafts: drafts,
      status: status, write: write, sleep: sleep, now: now,
      refreshRequests: refreshRequests, refreshHistory: refreshHistory,
      clearAttachments: { send in
        try await attachments.clearIfUnchanged(send.machineId, send.sessionId, sent: send.attachments ?? [])
      },
      isActive: { [weak self] send in await self?.isActive(send.clientMessageId) ?? false })
    let run = Task<Void, Error> {
      _ = try await reconnectPass(machineId: machineId, openConversations: openConversations, ports: ports, options: options)
    }
    reconnecting[machineId] = run
    defer { reconnecting[machineId] = nil }
    try await run.value
  }
}
