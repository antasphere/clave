import Foundation

// The page cursor of a conversation's past and the joining of a snapshot with
// the live events buffered while it was in flight, ported from the
// prototype's `apps/mobile/src/chat/history.ts` (`docs/mobile-timeline.md`).
// The first page replaces what the phone holds (`sync`), every further page
// goes in front (`prepend`), one at a time. Only the server's positions
// establish identity: identical text can be new.

/// Where the paging of a conversation's past stands.
public struct HistoryCursor: Sendable, Equatable {
  /// Where the next older page ends; nil when the past is all here.
  public var before: Int?
  /// The first page has landed.
  public var loaded: Bool
  /// A page is on its way.
  public var loading: Bool
  /// Server retention removed earlier events: this is recent history, not a full transcript.
  public var truncated: Bool

  public init(before: Int? = nil, loaded: Bool = false, loading: Bool = false, truncated: Bool = false) {
    self.before = before
    self.loaded = loaded
    self.loading = loading
    self.truncated = truncated
  }

  /// Nothing loaded yet.
  public static let fresh = HistoryCursor()

  /// The first page is here and the past is not all here.
  public var hasMore: Bool { loaded && before != nil }
}

/// A page as the reducer takes it: the items oldest first, where the page before it ends, and
/// whether retention dropped events.
public struct HistoryChunk: Sendable, Equatable {
  public var items: [HistoryItem]
  public var before: Int?
  public var truncated: Bool

  public init(items: [HistoryItem], before: Int?, truncated: Bool = false) {
    self.items = items
    self.before = before
    self.truncated = truncated
  }

  /// A page of the legacy history route.
  public init(_ page: HistoryPage) {
    self.init(items: page.items, before: page.before, truncated: false)
  }

  /// A page of the ordered timeline.
  public init(_ page: TimelinePage) {
    self.init(items: page.items.map { HistoryItem(event: $0.event, at: $0.at) }, before: page.before, truncated: page.truncated)
  }
}

/// The first page: the conversation rebuilt from it, the cursor set.
public func applyFirstPage(_ conversation: Conversation, _ page: HistoryChunk) -> (conversation: Conversation, cursor: HistoryCursor) {
  (
    page.items.isEmpty ? conversation : reduceConversation(conversation, .sync(page.items)),
    HistoryCursor(before: page.before, loaded: true, loading: false, truncated: page.truncated)
  )
}

/// A further page, in front of what is here; the cursor moves back.
public func applyOlderPage(_ conversation: Conversation, _ page: HistoryChunk) -> (conversation: Conversation, cursor: HistoryCursor) {
  (
    page.items.isEmpty ? conversation : reduceConversation(conversation, .prepend(page.items)),
    HistoryCursor(before: page.before, loaded: true, loading: false, truncated: page.truncated)
  )
}

/// Whether to ask for the page before the oldest one shown: the first page is here, the past is
/// not all here, and no page is on its way.
public func shouldLoadOlder(_ cursor: HistoryCursor) -> Bool {
  cursor.hasMore && !cursor.loading
}

/// A live event held while a snapshot was in flight, with the position its frame carried.
public struct BufferedItem: Sendable, Equatable {
  public let event: SessionEvent
  public let at: Double?
  /// Absent on an older server's frame and on a synthetic replay: no ordered identity.
  public let position: SessionPosition?

  public init(event: SessionEvent, at: Double? = nil, position: SessionPosition? = nil) {
    self.event = event
    self.at = at
    self.position = position
  }

  /// A timeline item, buffered.
  public init(_ item: TimelineItem) {
    self.init(event: item.event, at: item.at, position: item.position)
  }

  var historyItem: HistoryItem { HistoryItem(event: event, at: at) }
}

/// The conversation changed while its history was loading: the snapshot must be taken again.
public struct TimelineChanged: Error, Sendable, Equatable, CustomStringConvertible {
  public init() {}
  public let message = "The conversation changed while history was loading. Refresh it again."
  public var description: String { message }
}

/// The snapshot followed by the buffered events above its watermark, in sequence order, then those
/// without a position. A repeated position is dropped, never a repeated text; a buffered event of
/// another generation, or a gap in the sequence, throws `TimelineChanged`.
public func mergeBufferedHistory(page: TimelinePage, buffered: [BufferedItem]) throws -> HistoryChunk {
  var seen = Set<Int>()
  var newer: [BufferedItem] = []
  for item in buffered {
    guard let position = item.position else {
      newer.append(item)
      continue
    }
    if position.generation != page.cursor.generation { throw TimelineChanged() }
    if position.sequence <= page.cursor.sequence || seen.contains(position.sequence) { continue }
    seen.insert(position.sequence)
    newer.append(item)
  }
  let ordered = newer.filter { $0.position != nil }.sorted { $0.position!.sequence < $1.position!.sequence }
  var next = page.cursor.sequence + 1
  for item in ordered {
    if item.position!.sequence != next { throw TimelineChanged() }
    next += 1
  }
  let items = page.items.map { HistoryItem(event: $0.event, at: $0.at) }
    + ordered.map(\.historyItem)
    + newer.filter { $0.position == nil }.map(\.historyItem)
  return HistoryChunk(items: items, before: page.before, truncated: page.truncated)
}
