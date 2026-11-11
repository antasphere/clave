import XCTest
@testable import ClaveCore

final class ChatHistoryTests: XCTestCase {
  private let delta = SessionEvent.assistantText(delta: "a", final: false, parent: nil)

  private func item(_ sequence: Int, _ generation: String = "g") -> TimelineItem {
    TimelineItem(event: delta, position: SessionPosition(generation: generation, sequence: sequence))
  }

  func testTheFirstPageSetsTheCursorAndTheConversation() {
    let applied = applyFirstPage(.empty, HistoryChunk(items: [HistoryItem(event: .userMessage(UserMessage(text: "latest")))], before: 200))
    XCTAssertEqual(applied.conversation.items.count, 1)
    XCTAssertEqual(applied.cursor, HistoryCursor(before: 200, loaded: true, loading: false))
    XCTAssertTrue(applied.cursor.hasMore)
    XCTAssertTrue(shouldLoadOlder(applied.cursor))
    var loading = applied.cursor
    loading.loading = true
    XCTAssertFalse(shouldLoadOlder(loading))
  }

  func testAnOlderPageGoesInFrontAndTheCursorMovesBackUntilNil() {
    let first = applyFirstPage(.empty, HistoryChunk(items: [HistoryItem(event: .userMessage(UserMessage(text: "latest")))], before: 200))
    let older = applyOlderPage(first.conversation, HistoryChunk(items: [HistoryItem(event: .userMessage(UserMessage(text: "earlier")))], before: nil))
    XCTAssertEqual(older.conversation.items.map { item -> String in
      if case .user(let turn) = item { return turn.text }
      return ""
    }, ["earlier", "latest"])
    XCTAssertEqual(older.conversation.first, -1)
    XCTAssertFalse(older.cursor.hasMore)
  }

  func testNothingLoadsBeforeTheFirstPage() {
    XCTAssertFalse(HistoryCursor.fresh.hasMore)
    XCTAssertFalse(shouldLoadOlder(.fresh))
  }

  func testATimelinePageCarriesItsTruncation() {
    let page = TimelinePage(items: [item(1)], before: 0, cursor: SessionPosition(generation: "g", sequence: 1), truncated: true)
    XCTAssertTrue(applyFirstPage(.empty, HistoryChunk(page)).cursor.truncated)
  }

  func testKeepsANewIdenticalDeltaBeyondTheSnapshotWatermark() throws {
    let page = TimelinePage(items: [item(1)], before: nil, cursor: SessionPosition(generation: "g", sequence: 1), truncated: false)
    let joined = try mergeBufferedHistory(page: page, buffered: [BufferedItem(item(2))])
    let applied = applyFirstPage(.empty, joined)
    XCTAssertEqual(transcriptText(applied.conversation), "aa")
  }

  func testDeduplicatesPositionsOnlyAndAppendsUnorderedItemsAfter() throws {
    let page = TimelinePage(items: [item(4)], before: nil, cursor: SessionPosition(generation: "g", sequence: 4), truncated: true)
    let replay = BufferedItem(event: .userMessage(UserMessage(text: "replayed prompt")))
    let merged = try mergeBufferedHistory(page: page, buffered: [BufferedItem(item(4)), replay, BufferedItem(item(6)), BufferedItem(item(5)), BufferedItem(item(5))])
    XCTAssertEqual(merged.items.count, 4)
    XCTAssertEqual(merged.items.last?.event, replay.event)
    XCTAssertTrue(merged.truncated)
  }

  func testAGenerationChangeThrows() {
    let page = TimelinePage(items: [item(4)], before: nil, cursor: SessionPosition(generation: "g", sequence: 4), truncated: false)
    XCTAssertThrowsError(try mergeBufferedHistory(page: page, buffered: [BufferedItem(item(5, "new"))])) { error in
      XCTAssertTrue(error is TimelineChanged)
    }
  }

  func testAGapInTheSequenceThrows() {
    let page = TimelinePage(items: [item(4)], before: nil, cursor: SessionPosition(generation: "g", sequence: 4), truncated: false)
    XCTAssertThrowsError(try mergeBufferedHistory(page: page, buffered: [BufferedItem(item(6))])) { error in
      XCTAssertTrue(error is TimelineChanged)
    }
  }
}
