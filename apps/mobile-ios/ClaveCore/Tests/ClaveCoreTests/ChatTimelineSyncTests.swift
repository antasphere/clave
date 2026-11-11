import XCTest
@testable import ClaveCore

/// A timeline route whose answers the test hands over one by one.
private actor FakeTimeline {
  private(set) var requests: [Int?] = []
  private var waiting: [CheckedContinuation<TimelinePage, Error>] = []

  func fetch(_ before: Int?) async throws -> TimelinePage {
    requests.append(before)
    return try await withCheckedThrowingContinuation { waiting.append($0) }
  }

  func answer(_ page: TimelinePage) {
    waiting.removeFirst().resume(returning: page)
  }

  func fail(_ error: Error) {
    waiting.removeFirst().resume(throwing: error)
  }

  var count: Int { requests.count }
}

/// Subscription acknowledgements the test can hold.
private actor Acks {
  private(set) var subscribed = 0
  private var holding = false
  private var held: [CheckedContinuation<Void, Never>] = []

  func hold() { holding = true }

  func subscribe() async {
    subscribed += 1
    if holding { await withCheckedContinuation { held.append($0) } }
  }

  func release() {
    holding = false
    for continuation in held { continuation.resume() }
    held = []
  }

  var pending: Int { held.count }
}

private func item(_ delta: String, _ sequence: Int, _ generation: String = "g") -> SessionStream {
  .event(.assistantText(delta: delta, final: false, parent: nil), position: SessionPosition(generation: generation, sequence: sequence))
}

private func timelineItem(_ delta: String, _ sequence: Int, _ generation: String = "g") -> TimelineItem {
  TimelineItem(event: .assistantText(delta: delta, final: false, parent: nil), position: SessionPosition(generation: generation, sequence: sequence))
}

private func page(_ delta: String, _ sequence: Int = 1, _ generation: String = "g", before: Int? = nil) -> TimelinePage {
  TimelinePage(items: [timelineItem(delta, sequence, generation)], before: before, cursor: SessionPosition(generation: generation, sequence: sequence), truncated: false)
}

private func text(_ sync: TimelineSync) async -> String {
  if case .ready(let conversation, _, _) = await sync.current { return transcriptText(conversation) }
  return ""
}

final class ChatTimelineSyncTests: XCTestCase {
  private func make() -> (TimelineSync, FakeTimeline, Acks) {
    let server = FakeTimeline()
    let acks = Acks()
    let sync = TimelineSync(fetchTimeline: { before, _ in try await server.fetch(before) }, subscribe: { await acks.subscribe() }, now: { 1 })
    return (sync, server, acks)
  }

  func testEventsDuringTheSnapshotAreBufferedThenAppliedOnceIdenticalTextKept() async {
    let (sync, server, acks) = make()
    let start = Task { await sync.start() }
    await eventually { await server.count == 1 }
    let subscribed = await acks.subscribed
    XCTAssertEqual(subscribed, 1)
    await sync.receive(item("a", 1))
    await sync.receive(item("a", 2))
    await sync.receive(item("a", 2))
    await server.answer(page("a"))
    await start.value
    let first = await text(sync)
    XCTAssertEqual(first, "aa")
    await sync.receive(item("a", 2))
    await sync.receive(item("a", 3))
    let after = await text(sync)
    XCTAssertEqual(after, "aaa")
  }

  func testTheSnapshotWaitsForTheSubscriptionAcknowledgement() async {
    let (sync, server, acks) = make()
    await acks.hold()
    let start = Task { await sync.start() }
    await eventually { await acks.pending == 1 }
    let before = await server.count
    XCTAssertEqual(before, 0)
    await acks.release()
    await eventually { await server.count == 1 }
    await server.answer(page("x"))
    await start.value
  }

  func testReconnectTakesAFreshSnapshotAfterTheNewAcknowledgement() async {
    let (sync, server, acks) = make()
    let start = Task { await sync.start() }
    await eventually { await server.count == 1 }
    await server.answer(page("before"))
    await start.value
    await acks.hold()
    let reconnect = Task { await sync.reconnect() }
    await eventually { await acks.pending == 1 }
    let held = await server.count
    XCTAssertEqual(held, 1)
    await acks.release()
    await eventually { await server.count == 2 }
    await sync.receive(item("after reconnect", 3))
    await server.answer(page("after reconnect", 2))
    await reconnect.value
    let shown = await text(sync)
    XCTAssertEqual(shown, "after reconnectafter reconnect")
    let subscriptions = await acks.subscribed
    XCTAssertEqual(subscriptions, 2)
  }

  func testAGenerationChangeTakesAnotherSnapshot() async {
    let (sync, server, _) = make()
    let start = Task { await sync.start() }
    await eventually { await server.count == 1 }
    await sync.receive(item("fresh", 1, "new"))
    await server.answer(page("old"))
    await eventually { await server.count == 2 }
    await server.answer(page("fresh", 1, "new"))
    await start.value
    let fresh = await text(sync)
    XCTAssertEqual(fresh, "fresh")
    await sync.receive(item("second", 1, "third"))
    await eventually { await server.count == 3 }
    await server.answer(page("second", 1, "third"))
    await eventually { await text(sync) == "second" }
  }

  func testAMissedSequenceRefreshesRatherThanOmittingTheMissingEvent() async {
    let (sync, server, _) = make()
    let start = Task { await sync.start() }
    await eventually { await server.count == 1 }
    await server.answer(page("a"))
    await start.value
    await sync.receive(item("c", 3))
    await eventually { await server.count == 2 }
    await server.answer(TimelinePage(items: [timelineItem("a", 1), timelineItem("b", 2), timelineItem("c", 3)], before: nil, cursor: SessionPosition(generation: "g", sequence: 3), truncated: false))
    await eventually { await text(sync) == "abc" }
  }

  func testThreeChangesInARowEndInTheErrorState() async {
    let (sync, server, _) = make()
    let start = Task { await sync.start() }
    for attempt in 1...3 {
      await eventually { await server.count == attempt }
      await sync.receive(item("moving", 1, "gen-\(attempt)"))
      await server.answer(page("stale", 1, "old"))
    }
    await start.value
    let state = await sync.current
    XCTAssertEqual(state, .failed(TimelineChanged().message))
    let count = await server.count
    XCTAssertEqual(count, 3)
  }

  func testAnOlderServerIsTheErrorStateAndNothingIsGuessed() async {
    for error in [
      ServerError(.notFound, "The server answered 404.", status: 404),
      ServerError(.refused, "No timeline here.", status: 422, failure: ServerFailure(tag: "CapabilityUnavailable", message: "No timeline here.", capability: "timeline")),
    ] {
      let (sync, server, _) = make()
      let start = Task { await sync.start() }
      await eventually { await server.count == 1 }
      await server.fail(error)
      await start.value
      let state = await sync.current
      XCTAssertEqual(state, .failed(noOrderedHistoryMessage))
      let count = await server.count
      XCTAssertEqual(count, 1)
    }
  }

  func testAnotherFailureCarriesItsOwnSentence() async {
    let (sync, server, _) = make()
    let start = Task { await sync.start() }
    await eventually { await server.count == 1 }
    await server.fail(ServerError(.network, "The server could not be reached."))
    await start.value
    let state = await sync.current
    XCTAssertEqual(state, .failed("The server could not be reached."))
  }

  func testLoadOlderFollowsBeforeInTheSameGenerationAndDiscardsAnotherOne() async throws {
    let (sync, server, _) = make()
    let start = Task { await sync.start() }
    await eventually { await server.count == 1 }
    await server.answer(page("new", 5, before: 5))
    await start.value
    let older = Task { try await sync.loadOlder() }
    await eventually { await server.count == 2 }
    let asked = await server.requests
    XCTAssertEqual(asked, [nil, 5])
    await server.answer(TimelinePage(items: [timelineItem("old", 4)], before: nil, cursor: SessionPosition(generation: "g", sequence: 5), truncated: false))
    try await older.value
    let joined = await text(sync)
    XCTAssertEqual(joined, "oldnew")
    guard case .ready(let conversation, let cursor, _) = await sync.current else { return XCTFail() }
    XCTAssertEqual(conversation.first, -1)
    XCTAssertFalse(cursor.hasMore)

    let (other, otherServer, _) = make()
    let otherStart = Task { await other.start() }
    await eventually { await otherServer.count == 1 }
    await otherServer.answer(page("kept", 5, before: 5))
    await otherStart.value
    let stale = Task { try await other.loadOlder() }
    await eventually { await otherServer.count == 2 }
    await otherServer.answer(TimelinePage(items: [timelineItem("foreign", 4, "gone")], before: nil, cursor: SessionPosition(generation: "gone", sequence: 5), truncated: false))
    await eventually { await otherServer.count == 3 }
    await otherServer.answer(page("fresh", 1, "now"))
    try await stale.value
    let shown = await text(other)
    XCTAssertEqual(shown, "fresh")
  }

  func testTheStatesStreamPublishesTheChanges() async {
    let (sync, server, _) = make()
    let stream = await sync.states()
    let start = Task { await sync.start() }
    await eventually { await server.count == 1 }
    await server.answer(page("hello"))
    await start.value
    var seen: [TimelineState] = []
    for await state in stream {
      seen.append(state)
      if case .ready = state { break }
    }
    XCTAssertEqual(seen.first, .loading)
    guard case .ready(let conversation, _, _)? = seen.last else { return XCTFail() }
    XCTAssertEqual(transcriptText(conversation), "hello")
    await sync.close()
  }
}
