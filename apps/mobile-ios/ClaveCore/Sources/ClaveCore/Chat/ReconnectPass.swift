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
  /// Takes the files a landed send carried off its conversation's attachment draft.
  public var clearAttachments: (@Sendable (UnknownSend) async throws -> Void)?
  /// A send the composer is still driving: the pass leaves it to the composer.
  public var isActive: (@Sendable (UnknownSend) async -> Bool)?
  /// Holds the send while the pass reconciles and settles it, so a choice the person makes on the
  /// bar meanwhile waits for the pass; false when the send is no longer the pass's to settle.
  public var claim: (@Sendable (UnknownSend) async -> Bool)?
  /// Lets go of a send the claim held.
  public var release: (@Sendable (UnknownSend) async -> Void)?
  /// Whether the person has made a choice on the send (discard, send again) that waits for it.
  public var choiceRecorded: (@Sendable (UnknownSend) async -> Bool)?
  /// The choice a run that has ended left in the send's ledger record, with no action of this run
  /// driving it; nil when there is none, or when the person's choice is being made now.
  public var leftoverChoice: (@Sendable (UnknownSend) async -> PendingChoice?)?
  /// Carries out a choice an ended run left: the send out of the ledger, its mark cleared when the
  /// mark names it. Nothing reaches the server.
  public var carryOutChoice: (@Sendable (UnknownSend) async throws -> Void)?

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
    isActive: (@Sendable (UnknownSend) async -> Bool)? = nil,
    claim: (@Sendable (UnknownSend) async -> Bool)? = nil,
    release: (@Sendable (UnknownSend) async -> Void)? = nil,
    choiceRecorded: (@Sendable (UnknownSend) async -> Bool)? = nil,
    leftoverChoice: (@Sendable (UnknownSend) async -> PendingChoice?)? = nil,
    carryOutChoice: (@Sendable (UnknownSend) async throws -> Void)? = nil
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
    self.claim = claim
    self.release = release
    self.choiceRecorded = choiceRecorded
    self.leftoverChoice = leftoverChoice
    self.carryOutChoice = carryOutChoice
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
    // The ledger was read before this send's turn: the claim reads it again, and a person's
    // choice on the bar waits until the send is settled and let go.
    var held = false
    if let claim = ports.claim {
      guard await claim(send) else { continue }
      held = true
    }
    do {
      // A choice a run that has ended left in the ledger: the pass may read the send's status, never
      // write it.
      let leftover = await ports.leftoverChoice?(send)
      // The person's choice, read before each step: once one is recorded, the pass sends nothing
      // more for this send unless its same-id write is already under way, and settles only a
      // delivery it learned of; the send stays in the ledger for the choice. A write already
      // issued is never withdrawn: its answer settles the send as the table says.
      let step = PassStep()
      let chosen: @Sendable () async -> Bool = { await ports.choiceRecorded?(send) ?? false }
      let outcome = await reconcile(
        send.clientMessageId,
        ports: SendPorts(
          write: { _ in
            if leftover != nil {
              step.stop()
              throw ChoiceRecorded()
            }
            if await chosen() {
              step.stop()
              throw ChoiceRecorded()
            }
            step.issue()
            return try await ports.write(send)
          },
          status: { _ in
            if leftover == nil, !step.issued, await chosen() {
              step.stop()
              throw ChoiceRecorded()
            }
            return try await ports.status(send)
          },
          sleep: ports.sleep,
          now: ports.now),
        options: options,
        mayRetry: true)
      if leftover != nil {
        // A delivery the pass learned of settles as delivered, and a send nobody can tell yet stays
        // marked unknown with its choice for the next pass; refused, or never received (the write
        // stopped), the send is the choice's, carried out with nothing written.
        var refused = false
        if case .rejected = outcome { refused = true }
        if refused || step.stopped {
          try await ports.carryOutChoice?(send)
        } else {
          outcomes.append(.init(send: send, outcome: outcome))
          try await settleSend(send, outcome, sends: ports.sends, marks: ports.marks, drafts: ports.drafts, now: ports.now, clearAttachments: ports.clearAttachments)
        }
      } else {
        var yielded = !step.issued && step.stopped
        if !yielded, !step.issued, outcome.reason != nil {
          // Not delivered, nothing written: a choice recorded during the last read takes the send.
          yielded = await chosen()
        }
        if !yielded {
          outcomes.append(.init(send: send, outcome: outcome))
          try await settleSend(send, outcome, sends: ports.sends, marks: ports.marks, drafts: ports.drafts, now: ports.now, clearAttachments: ports.clearAttachments)
        }
      }
    } catch {
      if held { await ports.release?(send) }
      throw error
    }
    if held { await ports.release?(send) }
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

/// Thrown by a pass's port when the person's choice stopped it before a request.
private struct ChoiceRecorded: Error {}

/// What one send's reconciliation in a pass did so far, set and read from its port closures.
private final class PassStep: @unchecked Sendable {
  private let lock = NSLock()
  private var wrote = false
  private var halted = false

  /// A same-id write was issued.
  var issued: Bool { lock.withLock { wrote } }
  /// A recorded choice stopped the reconciliation before a request.
  var stopped: Bool { lock.withLock { halted } }

  func issue() { lock.withLock { wrote = true } }
  func stop() { lock.withLock { halted = true } }
}

/// The ledger, the draft and the mark after one send's outcome: sent takes the send out of the
/// ledger, keeps in the draft only what was added after the text sent, takes the files it carried
/// off the attachment draft and clears the mark; rejected leaves the ledger and marks the reason;
/// unknown stays in the ledger, marked; failed waits for the next pass.
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
    let stored = try await drafts.get(send.machineId, send.sessionId)
    let kept = draftAfterDelivery(stored, sent: send.draftText ?? send.text)
    if kept != stored { try await drafts.set(send.machineId, send.sessionId, kept) }
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

/// The person chose to discard a send of unknown outcome: it leaves the ledger and the mark. This
/// does not wait for a pass reconciling the send; the app goes through
/// `DeliveryController.discardPending`, which does.
public func discardUnknownSend(machineId: String, sessionId: String, clientMessageId: String, sends: UnknownSends, marks: DeliveryMarks) async throws {
  try await sends.remove(clientMessageId)
  try await marks.clear(machineId, sessionId)
}

/// The person's explicit choice on a send of unknown outcome, recorded before anything waits: in
/// memory for a pass running now, and in the send's ledger record for one that runs after a reload.
public enum PendingChoice: String, Codable, Sendable, Equatable {
  case discard = "discard", sendAgain = "send-again"
}

/// The person's choice could not be written to the ledger, so it claimed nothing and changed
/// nothing: the send and its mark are as they were.
public struct ChoiceNotKept: Error, Sendable, Equatable, CustomStringConvertible {
  /// What the store said.
  public let reason: String

  public init(reason: String) {
    self.reason = reason
  }

  public var description: String { "The choice could not be kept: \(reason)" }
}

/// How the person's explicit choice on a send of unknown outcome ended.
public enum PendingResolution: Sendable, Equatable {
  /// The send left the ledger and its mark was cleared, or a pass had refused it and its refusal
  /// mark was cleared: nothing writes it again.
  case discarded
  /// The send was delivered while the choice waited: the original had already been accepted, or a
  /// pass's same-id write, under way before the choice was made, landed. Nothing was changed. A
  /// send leaves the ledger otherwise only when the person discards it or a pass refuses it, and
  /// both answer `discarded`.
  case settledMeanwhile
}

/// One machine's owner of the ledger, shared by every conversation of the machine: a send is
/// recorded before it is dispatched, settled when it ends, and skipped by a pass while it is
/// still in flight; one pass per machine runs at a time, a second request joining the one
/// running; and a send of unknown outcome is held by one party at a time (a pass reconciling it,
/// or the person's choice on the bar), in the order they asked.
public actor DeliveryController {
  public let sends: UnknownSends
  public let marks: DeliveryMarks
  private let drafts: Drafts
  private let attachmentDrafts: AttachmentDrafts
  private let now: @Sendable () -> Double
  private var active: Set<String> = []
  private var reconnecting: [String: Task<Void, Error>] = [:]
  private var claimed: Set<String> = []
  private var waiters: [String: [CheckedContinuation<Void, Never>]] = [:]
  private var choices: [String: [PendingChoice]] = [:]
  private var discarded: Set<String> = []

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

  /// Holds the send of this id once nobody else does; those who asked before are served first.
  public func claim(_ id: String) async {
    guard claimed.contains(id) else {
      claimed.insert(id)
      return
    }
    // Handed over by release(), which keeps the id held for this waiter.
    await withCheckedContinuation { waiters[id, default: []].append($0) }
  }

  /// Hands the send to the next one waiting for it, else frees it.
  public func release(_ id: String) {
    guard var queue = waiters[id], !queue.isEmpty else {
      claimed.remove(id)
      return
    }
    let next = queue.removeFirst()
    waiters[id] = queue.isEmpty ? nil : queue
    next.resume()
  }

  /// Records the person's choice on a send at once, before anything waits; kept until the action
  /// that recorded it ends. A pass holding the send reads it before each step of its reconciliation.
  func recordChoice(_ id: String, _ choice: PendingChoice) {
    choices[id, default: []].append(choice)
  }

  /// Whether a choice on the send of this id is recorded.
  func hasChoice(_ id: String) -> Bool { !(choices[id] ?? []).isEmpty }

  private func endChoice(_ id: String, _ choice: PendingChoice) {
    guard var recorded = choices[id], let index = recorded.firstIndex(of: choice) else { return }
    recorded.remove(at: index)
    choices[id] = recorded.isEmpty ? nil : recorded
  }

  /// Whether a pass runs for this machine now: a reconnection arriving meanwhile joins it.
  func isReconnecting(_ machineId: String) -> Bool { reconnecting[machineId] != nil }

  /// Whether the send of this id is held, and how many wait for it.
  func claimState(_ id: String) -> (held: Bool, waiting: Int) {
    (claimed.contains(id), waiters[id]?.count ?? 0)
  }

  /// A pass's claim: false, the hold let go, when the send left the ledger meanwhile or the
  /// composer is driving it.
  func claimForPass(_ send: UnknownSend) async -> Bool {
    await claim(send.clientMessageId)
    let listed = (try? await sends.list().contains { $0.clientMessageId == send.clientMessageId }) ?? false
    if !listed || active.contains(send.clientMessageId) {
      release(send.clientMessageId)
      return false
    }
    return true
  }

  /// The person chose to discard a send of unknown outcome, or to send its text again under a new
  /// id. The choice is recorded first, in memory and then in the send's ledger record, so a pass
  /// holding the send stops before its next request unless its same-id write is already under way,
  /// and a pass after a reload finds the choice; once the send is held here, its mark is cleared and
  /// it leaves the ledger, unless it was delivered meanwhile. A choice the ledger cannot keep throws
  /// `ChoiceNotKept` before anything waits, with nothing changed.
  public func discardPending(
    machineId: String, sessionId: String, clientMessageId: String, choice: PendingChoice
  ) async throws -> PendingResolution {
    recordChoice(clientMessageId, choice)
    defer { endChoice(clientMessageId, choice) }
    do {
      try await sends.recordChoice(clientMessageId, choice)
    } catch {
      throw ChoiceNotKept(reason: reasonOf(error))
    }
    await claim(clientMessageId)
    defer { release(clientMessageId) }
    if try await sends.list().contains(where: { $0.clientMessageId == clientMessageId }) {
      try await takeOut(clientMessageId, machineId: machineId, sessionId: sessionId)
      return .discarded
    }
    // Out of the ledger: delivered, unless an earlier choice discarded it or a pass refused it.
    if discarded.contains(clientMessageId) { return .discarded }
    if let mark = try await marks.get(machineId, sessionId), mark.kind == .rejected, mark.clientMessageId == clientMessageId {
      try await marks.clear(machineId, sessionId)
      return .discarded
    }
    return .settledMeanwhile
  }

  /// Whether the person's choice took the send of this id out of the ledger: a choice made here, or
  /// one an ended run left that a pass carried out. A composer that sees such a send's mark go does
  /// not take it for delivered.
  public func wasDiscarded(_ clientMessageId: String) -> Bool { discarded.contains(clientMessageId) }

  /// The choice an ended run left on this send: the one in its ledger record, when no action of this
  /// run holds a choice on it (a choice made now is followed as it is made).
  func leftoverChoice(_ send: UnknownSend) async -> PendingChoice? {
    guard !hasChoice(send.clientMessageId) else { return nil }
    let stored = (try? await sends.list())?.first { $0.clientMessageId == send.clientMessageId }?.choice
    return hasChoice(send.clientMessageId) ? nil : stored
  }

  /// A pass carries out a choice an ended run left on a send it holds.
  func carryOutChoice(_ send: UnknownSend) async throws {
    try await takeOut(send.clientMessageId, machineId: send.machineId, sessionId: send.sessionId)
  }

  /// The person's choice carried out on a send held here: the mark cleared first (only when it
  /// names this send), then the record taken out of the ledger. The choice, the mark and the ledger
  /// are separate writes; between these two, a reload finds no mark and the record with its choice,
  /// which the next pass carries out without writing. The send counts as discarded from the first
  /// write, so a composer reading the stores between the two never takes it for delivered.
  private func takeOut(_ clientMessageId: String, machineId: String, sessionId: String) async throws {
    let inserted = discarded.insert(clientMessageId).inserted
    do {
      if let mark = try await marks.get(machineId, sessionId), mark.clientMessageId == clientMessageId {
        try await marks.clear(machineId, sessionId)
      }
    } catch {
      // The mark is as it was, so the send is too: a pass that delivers it later says so.
      if inserted { discarded.remove(clientMessageId) }
      throw error
    }
    try await sends.remove(clientMessageId)
  }

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
      try await attachments.removeSent(send.machineId, send.sessionId, files: send.files ?? [])
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
        try await attachments.removeSent(send.machineId, send.sessionId, files: send.files ?? [])
      },
      isActive: { [weak self] send in await self?.isActive(send.clientMessageId) ?? false },
      claim: { [weak self] send in await self?.claimForPass(send) ?? false },
      release: { [weak self] send in await self?.release(send.clientMessageId) },
      choiceRecorded: { [weak self] send in await self?.hasChoice(send.clientMessageId) ?? false },
      leftoverChoice: { [weak self] send in await self?.leftoverChoice(send) },
      carryOutChoice: { [weak self] send in try await self?.carryOutChoice(send) })
    let run = Task<Void, Error> {
      _ = try await reconnectPass(machineId: machineId, openConversations: openConversations, ports: ports, options: options)
    }
    reconnecting[machineId] = run
    defer { reconnecting[machineId] = nil }
    try await run.value
  }
}
