import XCTest
@testable import ClaveCore

private let send = UnknownSend(machineId: "m-1", sessionId: "s-1", clientMessageId: "message-0001", text: "hello", at: 1)

/// The pass's ports over one store, with a write port that counts and a fake clock.
private final class Harness: @unchecked Sendable {
  let kv = InMemoryKeyValueStore()
  let writes = Box<[UnknownSend]>([])
  let refreshed = Box<[String]>([])
  let time = Box<Double>(0)
  let sleeps = Box<[Double]>([])
  let statuses = Box<[WriteStatus]>([WriteStatus(status: .unknown)])
  let writeFails = Box(false)
  let statusFails = Box(false)
  let requestsFail = Box(false)
  lazy var sends = UnknownSends(store: kv)
  lazy var marks = DeliveryMarks(store: kv)
  lazy var drafts = Drafts(store: kv)

  var ports: ReconnectPorts {
    ReconnectPorts(
      sends: sends, marks: marks, drafts: drafts,
      status: { [self] _ in
        if statusFails.value { throw ServerError(.protocol, "Not found", status: 404) }
        // The last status answers every further ask.
        return statuses.mutate { $0.count > 1 ? $0.removeFirst() : $0[0] }
      },
      write: { [self] s in
        writes.mutate { $0.append(s) }
        if writeFails.value { throw ServerError(.network, "Connection lost") }
        return WriteAnswer(status: .accepted)
      },
      sleep: { [self] ms in sleeps.mutate { $0.append(ms) }; time.mutate { $0 += ms } },
      now: { [self] in time.value },
      refreshRequests: { [self] id in
        if requestsFail.value { throw ServerError(.network, "offline") }
        refreshed.mutate { $0.append("requests:\(id)") }
      },
      refreshHistory: { [self] m, s in refreshed.mutate { $0.append("history:\(m):\(s)") } })
  }

  func setUp() async throws {
    try await recordUnknownSend(send, reason: "Connection lost", sends: sends, marks: marks)
    try await Drafts(store: kv).set("m-1", "s-1", "hello")
  }

  func run() async throws -> ReconnectReport {
    try await reconnectPass(machineId: "m-1", openConversations: ["s-1"], ports: ports)
  }
}

final class ChatReconnectTests: XCTestCase {
  private func harness() async throws -> Harness {
    let h = Harness()
    try await h.setUp()
    return h
  }

  func testAcceptedRemovesTheMatchingDraftAndRecordWithoutSending() async throws {
    let h = try await harness()
    h.statuses.value = [WriteStatus(status: .accepted, at: 5)]
    let report = try await h.run()
    XCTAssertEqual(report.outcomes.first?.outcome, .sent(clientMessageId: send.clientMessageId, reconciled: true))
    XCTAssertEqual(h.writes.value, [])
    let list = try await h.sends.list()
    XCTAssertEqual(list, [])
    let draft = try await h.drafts.get("m-1", "s-1")
    XCTAssertEqual(draft, "")
    let mark = try await h.marks.get("m-1", "s-1")
    XCTAssertNil(mark)
  }

  func testAcceptedPreservesTextEditedSinceTheLostSend() async throws {
    let h = try await harness()
    try await h.drafts.set("m-1", "s-1", "new draft")
    h.statuses.value = [WriteStatus(status: .accepted)]
    _ = try await h.run()
    let draft = try await h.drafts.get("m-1", "s-1")
    XCTAssertEqual(draft, "new draft")
  }

  func testPendingWaitsWithBackoffUpToTheBudgetThenMarksUnknown() async throws {
    let h = try await harness()
    h.statuses.value = [WriteStatus(status: .pending)]
    let report = try await h.run()
    guard case .unknown? = report.outcomes.first?.outcome else { return XCTFail() }
    XCTAssertEqual(h.time.value, 60_000)
    XCTAssertEqual(Array(h.sleeps.value.prefix(4)), [1_000, 2_000, 4_000, 8_000])
    XCTAssertEqual(h.sleeps.value.max(), 8_000)
    let draft = try await h.drafts.get("m-1", "s-1")
    XCTAssertEqual(draft, "hello")
    XCTAssertEqual(h.writes.value, [])
    let mark = try await h.marks.get("m-1", "s-1")
    XCTAssertEqual(mark?.kind, .unknown)
  }

  func testPendingLaterAcceptedClearsWithoutARetry() async throws {
    let h = try await harness()
    h.statuses.value = [WriteStatus(status: .pending), WriteStatus(status: .accepted)]
    let report = try await h.run()
    guard case .sent? = report.outcomes.first?.outcome else { return XCTFail() }
    XCTAssertEqual(h.writes.value, [])
  }

  func testRejectedRetainsTheTextAndTheReasonAndLeavesTheLedger() async throws {
    let h = try await harness()
    h.statuses.value = [WriteStatus(status: .rejected, reason: "server restarted before dispatch")]
    _ = try await h.run()
    let draft = try await h.drafts.get("m-1", "s-1")
    XCTAssertEqual(draft, "hello")
    let mark = try await h.marks.get("m-1", "s-1")
    XCTAssertEqual(mark?.kind, .rejected)
    XCTAssertEqual(mark?.reason, "server restarted before dispatch")
    let list = try await h.sends.list()
    XCTAssertEqual(list, [])
    XCTAssertEqual(h.writes.value, [])
  }

  func testAbsentCompletesTheSameBytesAndIdOnce() async throws {
    let h = try await harness()
    h.statuses.value = [WriteStatus(status: .absent)]
    let report = try await h.run()
    guard case .sent? = report.outcomes.first?.outcome else { return XCTFail() }
    XCTAssertEqual(h.writes.value, [send])
    let list = try await h.sends.list()
    XCTAssertEqual(list, [])
  }

  func testASecondLostAbsentWriteIsUnknownAndCannotRetryAgain() async throws {
    let h = try await harness()
    h.statuses.value = [WriteStatus(status: .absent)]
    h.writeFails.value = true
    let report = try await h.run()
    guard case .unknown? = report.outcomes.first?.outcome else { return XCTFail() }
    XCTAssertEqual(h.writes.value, [send])
    let list = try await h.sends.list()
    XCTAssertEqual(list, [send])
  }

  func testUnknownSendsNothingAcrossARestartOrRepeatedReconnections() async throws {
    let h = try await harness()
    _ = try await h.run()
    // A restart: new stores over the same key-value store.
    let restarted = Harness()
    let fresh = ReconnectPorts(
      sends: UnknownSends(store: h.kv), marks: DeliveryMarks(store: h.kv), drafts: Drafts(store: h.kv),
      status: { _ in WriteStatus(status: .unknown) },
      write: { s in restarted.writes.mutate { $0.append(s) }; return WriteAnswer(status: .accepted) },
      refreshRequests: { _ in }, refreshHistory: { _, _ in })
    _ = try await reconnectPass(machineId: "m-1", openConversations: ["s-1"], ports: fresh)
    XCTAssertEqual(h.writes.value, [])
    XCTAssertEqual(restarted.writes.value, [])
    let list = try await h.sends.list()
    XCTAssertEqual(list, [send])
    let draft = try await Drafts(store: h.kv).get("m-1", "s-1")
    XCTAssertEqual(draft, "hello")
    let mark = try await h.marks.get("m-1", "s-1")
    XCTAssertEqual(mark?.kind, .unknown)
  }

  func testAnUnavailableStatusRouteNeverBecomesPermissionToRetry() async throws {
    let h = try await harness()
    h.statusFails.value = true
    let report = try await h.run()
    XCTAssertEqual(report.outcomes.first?.outcome, .unknown(clientMessageId: send.clientMessageId, reason: "This server cannot say whether the message arrived."))
    XCTAssertEqual(h.writes.value, [])
  }

  func testDoesNotReconcileAnotherMachineOrSendAPlainUnsentDraft() async throws {
    let h = try await harness()
    try await h.sends.add(UnknownSend(machineId: "other", sessionId: "s-1", clientMessageId: "other-message", text: "x", at: 1))
    try await h.drafts.set("m-1", "unsent", "do not send")
    _ = try await h.run()
    XCTAssertEqual(h.writes.value, [])
    let other = try await h.sends.forMachine("other")
    XCTAssertEqual(other.count, 1)
    let draft = try await h.drafts.get("m-1", "unsent")
    XCTAssertEqual(draft, "do not send")
    XCTAssertEqual(h.refreshed.value, ["requests:m-1", "history:m-1:s-1"])
  }

  func testRefreshesRequestsAndOpenHistoryEvenWhenDeliveryStaysUnknownAndOneFailureSkipsNothing() async throws {
    let h = try await harness()
    let report = try await h.run()
    XCTAssertTrue(report.requestsRefreshed)
    XCTAssertEqual(report.historyRefreshed, ["s-1"])
    XCTAssertEqual(report.refreshFailures, [])
    h.requestsFail.value = true
    let failed = try await h.run()
    XCTAssertFalse(failed.requestsRefreshed)
    XCTAssertEqual(failed.historyRefreshed, ["s-1"])
    XCTAssertEqual(failed.refreshFailures, ["requests: offline"])
  }

  func testAnExplicitDiscardRemovesTheTrackingAndTheMark() async throws {
    let h = try await harness()
    try await discardUnknownSend(machineId: send.machineId, sessionId: send.sessionId, clientMessageId: send.clientMessageId, sends: h.sends, marks: h.marks)
    let list = try await h.sends.list()
    XCTAssertEqual(list, [])
    let mark = try await h.marks.get("m-1", "s-1")
    XCTAssertNil(mark)
    XCTAssertEqual(h.writes.value, [])
  }

  func testConcurrentAddsNeverDropAnId() async throws {
    let sends = UnknownSends(store: InMemoryKeyValueStore())
    try await withThrowingTaskGroup(of: Void.self) { group in
      for index in 0..<20 {
        group.addTask { try await sends.add(UnknownSend(machineId: "m", sessionId: "s", clientMessageId: "parallel-\(index)", text: "t", at: 1)) }
      }
      try await group.waitForAll()
    }
    let ids = Set(try await sends.list().map(\.clientMessageId))
    XCTAssertEqual(ids, Set((0..<20).map { "parallel-\($0)" }))
    try await sends.add(UnknownSend(machineId: "m", sessionId: "s", clientMessageId: "parallel-3", text: "replaced", at: 2))
    let replaced = try await sends.list().filter { $0.clientMessageId == "parallel-3" }
    XCTAssertEqual(replaced.map(\.text), ["replaced"])
  }

  func testAnUnreadableLedgerOrMarkIsEmpty() async throws {
    let kv = InMemoryKeyValueStore([UnknownSends.key: "not json", deliveryMarkKey("m", "s"): "{\"kind\":\"other\"}"])
    let list = try await UnknownSends(store: kv).list()
    XCTAssertEqual(list, [])
    let mark = try await DeliveryMarks(store: kv).get("m", "s")
    XCTAssertNil(mark)
    let mixed = InMemoryKeyValueStore([UnknownSends.key: "[{\"machineId\":\"m\",\"sessionId\":\"s\",\"clientMessageId\":\"message-1\",\"text\":\"t\"},{\"bad\":1}]"])
    let kept = try await UnknownSends(store: mixed).list()
    XCTAssertEqual(kept, [UnknownSend(machineId: "m", sessionId: "s", clientMessageId: "message-1", text: "t", at: 0)])
  }

  func testTheMarksStreamSaysWhenAMarkChanged() async throws {
    let marks = DeliveryMarks(store: InMemoryKeyValueStore())
    let changes = await marks.changes()
    try await marks.set("m", "s", DeliveryMark(kind: .unknown, clientMessageId: "message-1", reason: "r", at: 1))
    var iterator = changes.makeAsyncIterator()
    let first: Void? = await iterator.next()
    XCTAssertNotNil(first)
  }
}

private func controllerOver(_ kv: InMemoryKeyValueStore) -> DeliveryController {
  DeliveryController(sends: UnknownSends(store: kv), marks: DeliveryMarks(store: kv), drafts: Drafts(store: kv), attachmentDrafts: AttachmentDrafts(store: kv))
}

final class ChatDeliveryControllerTests: XCTestCase {
  private let draft = "  original bytes  "

  private func sendOf(_ id: String) -> UnknownSend {
    UnknownSend(machineId: "m", sessionId: "s", clientMessageId: id, text: "original bytes", at: 1, draftText: draft)
  }

  func testRecordsTheOriginalBytesBeforeDispatchAndRestoresTheWarningAfterARestart() async throws {
    let kv = InMemoryKeyValueStore()
    let controller = controllerOver(kv)
    try await Drafts(store: kv).set("m", "s", draft)
    let s = sendOf("message-1000")
    try await controller.begin(s)
    let recorded = try await controller.sends.list()
    XCTAssertEqual(recorded, [s])
    try await controller.finish(s, .unknown(clientMessageId: s.clientMessageId, reason: "The server cannot say whether the message arrived."))
    let restored = controllerOver(kv)
    let list = try await restored.sends.list()
    XCTAssertEqual(list.count, 1)
    let mark = try await restored.marks.get("m", "s")
    XCTAssertEqual(mark?.kind, .unknown)
    XCTAssertEqual(mark?.clientMessageId, "message-1000")
    let kept = try await Drafts(store: kv).get("m", "s")
    XCTAssertEqual(kept, draft)
  }

  func testAPendingWriteNeverClearsTheDraftUntilStatusProvesAcceptance() async throws {
    let kv = InMemoryKeyValueStore()
    let drafts = Drafts(store: kv)
    let attachments = AttachmentDrafts(store: kv)
    // One drafts instance for the composer and the controller, as the app wires it: each caches.
    let controller = DeliveryController(sends: UnknownSends(store: kv), marks: DeliveryMarks(store: kv), drafts: drafts, attachmentDrafts: attachments)
    try await drafts.set("m", "s", draft)
    try await attachments.set("m", "s", [])
    let s = sendOf("message-1001")
    try await controller.begin(s)
    let clock = Box<Double>(0)
    let asks = Box(0)
    let outcome = await sendMessage(s.clientMessageId, ports: SendPorts(
      write: { _ in WriteAnswer(status: .pending) },
      status: { _ in asks.mutate { $0 += 1; return $0 } < 3 ? WriteStatus(status: .pending) : WriteStatus(status: .accepted) },
      sleep: { ms in clock.mutate { $0 += ms } },
      now: { clock.value }))
    let midway = try await drafts.get("m", "s")
    XCTAssertEqual(midway, draft, "nothing is cleared before finish")
    XCTAssertEqual(outcome, .sent(clientMessageId: s.clientMessageId, reconciled: true))
    try await controller.finish(s, outcome)
    let cleared = try await drafts.get("m", "s")
    XCTAssertEqual(cleared, "")
    let list = try await controller.sends.list()
    XCTAssertEqual(list, [])
  }

  func testAReconnectQueriesUnknownSendsPreservesEditsAndSendsNoOrdinaryDraft() async throws {
    let kv = InMemoryKeyValueStore()
    let drafts = Drafts(store: kv)
    let controller = DeliveryController(sends: UnknownSends(store: kv), marks: DeliveryMarks(store: kv), drafts: drafts, attachmentDrafts: AttachmentDrafts(store: kv))
    let s = sendOf("message-1002")
    try await controller.begin(s)
    try await controller.finish(s, .unknown(clientMessageId: s.clientMessageId, reason: "unknown"))
    try await drafts.set("m", "s", "edited after dispatch")
    try await drafts.set("m", "plain", "unsent offline draft")
    let writes = Box(0)
    let refreshes = Box<[String]>([])
    try await controller.reconnect(
      machineId: "m", openConversations: ["s"],
      status: { _ in WriteStatus(status: .accepted) },
      write: { _ in writes.mutate { $0 += 1 }; return WriteAnswer(status: .accepted) },
      refreshRequests: { _ in refreshes.mutate { $0.append("requests") } },
      refreshHistory: { _, _ in refreshes.mutate { $0.append("history") } })
    XCTAssertEqual(writes.value, 0)
    let edited = try await drafts.get("m", "s")
    XCTAssertEqual(edited, "edited after dispatch")
    let plain = try await drafts.get("m", "plain")
    XCTAssertEqual(plain, "unsent offline draft")
    let mark = try await controller.marks.get("m", "s")
    XCTAssertNil(mark)
    XCTAssertEqual(refreshes.value, ["requests", "history"])
  }

  func testAnActiveSendIsSkippedByThePassAndOnePassRunsPerMachine() async throws {
    let kv = InMemoryKeyValueStore()
    let controller = controllerOver(kv)
    let active = sendOf("message-active")
    try await controller.begin(active)
    let asked = Box<[String]>([])
    let refreshes = Box(0)
    let gate = Box<CheckedContinuation<Void, Never>?>(nil)
    let first = Task {
      try await controller.reconnect(
        machineId: "m", openConversations: [],
        status: { s in asked.mutate { $0.append(s.clientMessageId) }; return WriteStatus(status: .unknown) },
        write: { _ in WriteAnswer(status: .accepted) },
        refreshRequests: { _ in
          refreshes.mutate { $0 += 1 }
          await withCheckedContinuation { gate.value = $0 }
        },
        refreshHistory: { _, _ in })
    }
    await eventually { gate.value != nil }
    let second = Task {
      try await controller.reconnect(
        machineId: "m", openConversations: [],
        status: { _ in WriteStatus(status: .unknown) }, write: { _ in WriteAnswer(status: .accepted) },
        refreshRequests: { _ in refreshes.mutate { $0 += 1 } }, refreshHistory: { _, _ in })
    }
    try await Task.sleep(nanoseconds: 20_000_000)
    gate.value?.resume()
    try await first.value
    try await second.value
    XCTAssertEqual(asked.value, [], "the composer's own send is not the pass's")
    XCTAssertEqual(refreshes.value, 1, "the second call joined the running pass")
  }

  func testAPlainFailureLeavesNoTrace() async throws {
    let kv = InMemoryKeyValueStore()
    let controller = controllerOver(kv)
    let s = sendOf("message-1003")
    try await controller.begin(s)
    try await controller.finish(s, .failed(clientMessageId: s.clientMessageId, reason: "The server refused the token."))
    let list = try await controller.sends.list()
    XCTAssertEqual(list, [])
    let mark = try await controller.marks.get("m", "s")
    XCTAssertNil(mark)
    let isActive = await controller.isActive(s.clientMessageId)
    XCTAssertFalse(isActive)
  }

  // MARK: the claim

  /// A send is held by one party at a time and handed on in the order they asked; another send's
  /// claim is not held up by it.
  func testTheClaimIsHeldByOneAtATimeAndHandedOnInTheOrderAsked() async throws {
    let controller = controllerOver(InMemoryKeyValueStore())
    await controller.claim("message-1")
    let order = Box<[Int]>([])
    var waiting: [Task<Void, Never>] = []
    for n in 1...3 {
      waiting.append(Task {
        await controller.claim("message-1")
        order.mutate { $0.append(n) }
      })
      await eventually("waiter \(n) queued") { await controller.claimState("message-1").waiting == n }
    }
    await controller.claim("message-2")
    XCTAssertEqual(order.value, [], "nobody has it while it is held")
    for n in 1...3 {
      await controller.release("message-1")
      await eventually("waiter \(n) served") { order.value.count == n }
      XCTAssertEqual(order.value, Array(1...n), "in the order they asked")
    }
    for task in waiting { await task.value }
    await controller.release("message-1")
    let state = await controller.claimState("message-1")
    XCTAssertEqual(state.held, false)
    XCTAssertEqual(state.waiting, 0)
  }

  /// A pass whose settling throws still lets go of the send, so the person's choice never waits
  /// for ever: the error reaches the caller and the send is free.
  func testThePassLetsGoOfASendWhoseSettlingThrows() async throws {
    let kv = InMemoryKeyValueStore()
    let marks = FailingMarkStore(kv)
    let controller = DeliveryController(
      sends: UnknownSends(store: kv), marks: DeliveryMarks(store: marks), drafts: Drafts(store: kv),
      attachmentDrafts: AttachmentDrafts(store: kv))
    let s = sendOf("message-2000")
    try await recordUnknownSend(s, reason: "lost", sends: controller.sends, marks: DeliveryMarks(store: kv))
    await marks.failFromNowOn()
    do {
      try await controller.reconnect(
        machineId: "m", openConversations: [],
        status: { _ in WriteStatus(status: .unknown) }, write: { _ in WriteAnswer(status: .accepted) },
        refreshRequests: { _ in }, refreshHistory: { _, _ in }, sleep: { _ in })
      XCTFail("the settle did not throw")
    } catch is MarkWriteFailed {}
    let state = await controller.claimState(s.clientMessageId)
    XCTAssertEqual(state.held, false, "let go on the throwing path")
    let resolution = try await controller.discardPending(machineId: "m", sessionId: "s", clientMessageId: s.clientMessageId)
    XCTAssertEqual(resolution, .discarded)
  }

  /// A discard asked while a pass holds the send waits for it; the pass found it absent and wrote
  /// it once under its id, so the discard finds it settled and changes nothing.
  func testADiscardWaitsForThePassHoldingTheSendAndFindsItSettled() async throws {
    let kv = InMemoryKeyValueStore()
    let controller = controllerOver(kv)
    let s = sendOf("message-2001")
    try await recordUnknownSend(s, reason: "lost", sends: controller.sends, marks: controller.marks)
    let entered = Gate()
    let release = Gate()
    let writes = Box<[String]>([])
    let pass = Task {
      try await controller.reconnect(
        machineId: "m", openConversations: [],
        status: { _ in
          await entered.open()
          await release.wait()
          return WriteStatus(status: .absent)
        },
        write: { send in
          writes.mutate { $0.append(send.clientMessageId) }
          return WriteAnswer(status: .accepted)
        },
        refreshRequests: { _ in }, refreshHistory: { _, _ in }, sleep: { _ in })
    }
    await entered.wait()
    let discard = Task { try await controller.discardPending(machineId: "m", sessionId: "s", clientMessageId: s.clientMessageId) }
    await eventually("the discard waits for the pass") { await controller.claimState(s.clientMessageId).waiting == 1 }
    XCTAssertEqual(writes.value, [], "nothing written while the pass holds the send")
    await release.open()
    try await pass.value
    let resolution = try await discard.value
    XCTAssertEqual(resolution, .settledMeanwhile)
    XCTAssertEqual(writes.value, [s.clientMessageId], "the old id once, by the pass")
    let list = try await controller.sends.list()
    XCTAssertEqual(list, [])
  }
}

private struct MarkWriteFailed: Error {}

/// A key-value store whose writes of delivery marks fail once told to.
private actor FailingMarkStore: KeyValueStore {
  private let inner: InMemoryKeyValueStore
  private var failing = false

  init(_ inner: InMemoryKeyValueStore) { self.inner = inner }

  func failFromNowOn() { failing = true }

  func get(_ key: String) async throws -> String? { try await inner.get(key) }

  func set(_ key: String, _ value: String) async throws {
    if failing { throw MarkWriteFailed() }
    try await inner.set(key, value)
  }

  func remove(_ key: String) async throws { try await inner.remove(key) }
}
