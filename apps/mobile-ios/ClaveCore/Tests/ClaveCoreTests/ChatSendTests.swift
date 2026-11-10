import XCTest
@testable import ClaveCore

private enum WriteStep { case ok, pending, network, timeout, refused, unauthenticated, forbidden }
private enum StatusStep { case answer(WriteStatus), network, notFound }

/// Ports over scripts that count every write and every ask, with a fake clock.
private final class Script: @unchecked Sendable {
  private let lock = NSLock()
  private var writeSteps: [WriteStep]
  private var statusSteps: [StatusStep]
  private(set) var writes: [String] = []
  private(set) var asks = 0
  private(set) var slept: [Double] = []
  private var clock: Double = 0

  init(writes: [WriteStep], statuses: [StatusStep]) {
    writeSteps = writes
    statusSteps = statuses
  }

  private func locked<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }

  var ports: SendPorts {
    SendPorts(
      write: { id in
        let step = self.locked { () -> WriteStep in
          self.writes.append(id)
          return self.writeSteps.isEmpty ? .ok : self.writeSteps.removeFirst()
        }
        switch step {
        case .ok: return WriteAnswer(status: .accepted)
        case .pending: return WriteAnswer(status: .pending)
        case .network: throw ServerError(.network, "The server could not be reached.")
        case .timeout: throw ServerError(.timeout, "The server did not answer within 10 s.")
        case .refused: throw ServerError(.refused, "The provider refused the message.", status: 422, failure: ServerFailure(tag: "SessionWriteRefused", message: "The provider refused the message."))
        case .unauthenticated: throw ServerError(.unauthenticated, "The server refused the token.", status: 401)
        case .forbidden: throw ServerError(.forbidden, "A phone may not do this.", status: 403)
        }
      },
      status: { _ in
        let step = self.locked { () -> StatusStep in
          self.asks += 1
          return self.statusSteps.isEmpty ? .network : self.statusSteps.removeFirst()
        }
        switch step {
        case .answer(let status): return status
        case .network: throw ServerError(.network, "The server could not be reached.")
        case .notFound: throw ServerError(.protocol, "The server answered 404.", status: 404)
        }
      },
      sleep: { ms in self.locked { self.slept.append(ms); self.clock += ms } },
      now: { self.locked { self.clock } })
  }
}

private func pending(_ n: Int) -> [StatusStep] { Array(repeating: .answer(WriteStatus(status: .pending)), count: n) }

final class ChatSendTests: XCTestCase {
  func testAWriteThatAnswersIsSentNothingAsked() async {
    let s = Script(writes: [.ok], statuses: [])
    let outcome = await sendMessage("m-1", ports: s.ports)
    XCTAssertEqual(outcome, .sent(clientMessageId: "m-1", reconciled: false))
    XCTAssertEqual(s.asks, 0)
  }

  func testARefusalKeepsTheDraftWithTheReasonAndNeverAsks() async {
    let s = Script(writes: [.refused], statuses: [])
    let outcome = await sendMessage("m-1", ports: s.ports)
    XCTAssertEqual(outcome, .rejected(clientMessageId: "m-1", reason: "The provider refused the message."))
    XCTAssertEqual(s.asks, 0)
  }

  func testSessionNotFoundIsRejectedAndSessionWriteUnknownIsUnknown() async {
    for (tag, rejected) in [("SessionNotFound", true), ("SessionWriteUnknown", false), ("GatewayFailed", false)] {
      let error = ServerError(.refused, "Refused.", status: 422, failure: ServerFailure(tag: tag, message: "Refused."))
      let outcome = await sendMessage("message-123", ports: SendPorts(write: { _ in throw error }, status: { _ in XCTFail("asked"); return WriteStatus(status: .unknown) }))
      if rejected {
        XCTAssertEqual(outcome, .rejected(clientMessageId: "message-123", reason: "Refused."), tag)
      } else {
        XCTAssertEqual(outcome, .unknown(clientMessageId: "message-123", reason: "Refused."), tag)
      }
    }
  }

  func testARefusedTokenIsAFailureNotAReconciliation() async {
    let s = Script(writes: [.unauthenticated], statuses: [])
    let outcome = await sendMessage("m-1", ports: s.ports)
    XCTAssertEqual(outcome, .failed(clientMessageId: "m-1", reason: "The server refused the token."))
    XCTAssertEqual(s.asks, 0)
  }

  /// A 403 on the write itself is the device session's scope speaking: the send fails in the
  /// server's words, it is never asked about, and the ledger keeps nothing of it.
  func testAForbiddenWriteFailsInTheServersWordsAndIsNeverAskedAbout() async throws {
    let kv = InMemoryKeyValueStore()
    let delivery = DeliveryController(
      sends: UnknownSends(store: kv, machineId: "m"), marks: DeliveryMarks(store: kv), drafts: Drafts(store: kv),
      attachmentDrafts: AttachmentDrafts(store: kv), now: { 1 })
    let send = UnknownSend(machineId: "m", sessionId: "s", clientMessageId: "m-1", text: "Not allowed.", at: 1)
    try await delivery.begin(send)
    let s = Script(writes: [.forbidden], statuses: [])
    let outcome = await sendMessage("m-1", ports: s.ports)
    try await delivery.finish(send, outcome)
    XCTAssertEqual(outcome, .failed(clientMessageId: "m-1", reason: "A phone may not do this."))
    XCTAssertEqual(s.writes, ["m-1"], "one write")
    XCTAssertEqual(s.asks, 0, "no status read")
    let ledger = try await delivery.sends.list()
    XCTAssertEqual(ledger, [], "nothing left in the ledger")
    let mark = try await delivery.marks.get("m", "s")
    XCTAssertNil(mark, "nothing marked unknown")
  }

  func testAcceptedTheLostAnswerIsFoundLanded() async {
    let s = Script(writes: [.network], statuses: [.answer(WriteStatus(status: .accepted, at: 5))])
    let outcome = await sendMessage("m-1", ports: s.ports)
    XCTAssertEqual(outcome, .sent(clientMessageId: "m-1", reconciled: true))
    XCTAssertEqual(s.writes, ["m-1"])
  }

  func testPendingIsAskedAgainWithBackoffThenAccepted() async {
    let s = Script(writes: [.timeout], statuses: pending(2) + [.answer(WriteStatus(status: .accepted))])
    let outcome = await sendMessage("m-1", ports: s.ports, options: SendOptions(backoff: 1_000))
    XCTAssertEqual(outcome, .sent(clientMessageId: "m-1", reconciled: true))
    XCTAssertEqual(s.slept, [1_000, 2_000])
    XCTAssertEqual(s.asks, 3)
  }

  func testAPendingWriteAnswerGoesToTheTable() async {
    let s = Script(writes: [.pending], statuses: [.answer(WriteStatus(status: .accepted))])
    let outcome = await sendMessage("m-1", ports: s.ports)
    XCTAssertEqual(outcome, .sent(clientMessageId: "m-1", reconciled: true))
    XCTAssertEqual(s.writes, ["m-1"])
  }

  func testPendingPastTheBudgetIsUnknownAndSendsNothing() async {
    let s = Script(writes: [.network], statuses: pending(50))
    let outcome = await sendMessage("m-1", ports: s.ports, options: SendOptions(pendingBudget: 60_000, backoff: 1_000, maxBackoff: 8_000))
    XCTAssertEqual(outcome, .unknown(clientMessageId: "m-1", reason: "The server is still working on the message after a minute."))
    XCTAssertEqual(s.writes, ["m-1"])
    XCTAssertLessThanOrEqual(s.slept.reduce(0, +), 60_000)
    XCTAssertEqual(s.slept.reduce(0, +), 60_000)
    XCTAssertEqual(Array(s.slept.prefix(4)), [1_000, 2_000, 4_000, 8_000])
    XCTAssertLessThanOrEqual(s.slept.max() ?? 0, 8_000)
  }

  func testRejectedOnTheLedgerKeepsTheRecordedReason() async {
    let s = Script(writes: [.network], statuses: [.answer(WriteStatus(status: .rejected, reason: "server restarted before dispatch"))])
    let outcome = await sendMessage("m-1", ports: s.ports)
    XCTAssertEqual(outcome, .rejected(clientMessageId: "m-1", reason: "server restarted before dispatch"))
    XCTAssertEqual(s.writes, ["m-1"])
  }

  func testAbsentCompletesTheSameSendOnceWithTheSameId() async {
    let s = Script(writes: [.network, .ok], statuses: [.answer(WriteStatus(status: .absent))])
    let outcome = await sendMessage("m-1", ports: s.ports)
    XCTAssertEqual(outcome, .sent(clientMessageId: "m-1", reconciled: true))
    XCTAssertEqual(s.writes, ["m-1", "m-1"])
  }

  func testAbsentTwiceSpendsTheOneRetryAndTheSecondLossIsUnknown() async {
    let s = Script(writes: [.network, .network], statuses: [.answer(WriteStatus(status: .absent)), .answer(WriteStatus(status: .absent))])
    let outcome = await sendMessage("m-1", ports: s.ports)
    XCTAssertEqual(outcome, .unknown(clientMessageId: "m-1", reason: "The message was sent again once and its outcome is still not known."))
    XCTAssertEqual(s.writes, ["m-1", "m-1"])
    XCTAssertEqual(s.asks, 2)
  }

  func testUnknownSendsNothingByItself() async {
    let s = Script(writes: [.network], statuses: [.answer(WriteStatus(status: .unknown))])
    let outcome = await sendMessage("m-1", ports: s.ports)
    XCTAssertEqual(outcome, .unknown(clientMessageId: "m-1", reason: "The server cannot say whether the message arrived."))
    XCTAssertEqual(s.writes, ["m-1"])
    let again = Script(writes: [], statuses: [.answer(WriteStatus(status: .unknown))])
    let later = await reconcile("m-1", ports: again.ports)
    XCTAssertEqual(later.clientMessageId, "m-1")
    XCTAssertEqual(again.writes, [])
  }

  func testAServerWithoutTheStatusRouteCannotTell() async {
    let s = Script(writes: [.timeout], statuses: [.notFound])
    let outcome = await sendMessage("m-1", ports: s.ports)
    XCTAssertEqual(outcome, .unknown(clientMessageId: "m-1", reason: "This server cannot say whether the message arrived."))
    XCTAssertEqual(s.writes, ["m-1"])
  }

  func testAStatusAskThatFailsIsUnknownNothingSent() async {
    let s = Script(writes: [.network], statuses: [.network])
    let outcome = await sendMessage("m-1", ports: s.ports)
    guard case .unknown = outcome else { return XCTFail("\(outcome)") }
    XCTAssertEqual(s.writes, ["m-1"])
  }

  func testMintedIdsFitTheServersRule() {
    for _ in 0..<50 {
      let id = mintClientMessageId()
      XCTAssertTrue(isValidClientMessageId(id), id)
      XCTAssertTrue((8...64).contains(id.count))
    }
    XCTAssertNotEqual(mintClientMessageId(), mintClientMessageId())
    XCTAssertFalse(isValidClientMessageId("short"))
    XCTAssertFalse(isValidClientMessageId("has space in it"))
    XCTAssertTrue(isValidClientMessageId("message-1000"))
  }
}
