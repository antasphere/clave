import Foundation

/// Process-local, per-adoption ordering (`session-position.ts`): a generation
/// and a sequence. Compare sequences within one generation only; a provider
/// reattach or a server restart starts a new generation.
public struct SessionPosition: Codable, Sendable, Equatable, Hashable, Comparable {
  public let generation: String
  public let sequence: Int

  public init(generation: String, sequence: Int) {
    self.generation = generation
    self.sequence = sequence
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    generation = try c.decodeNonEmpty("generation")
    sequence = try c.decodeNonNegativeInt("sequence")
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(generation, key: "generation")
    try c.encode(sequence, key: "sequence")
  }

  /// Within one generation only; across generations the order is undefined and this answers false both ways.
  public static func < (lhs: SessionPosition, rhs: SessionPosition) -> Bool {
    lhs.generation == rhs.generation && lhs.sequence < rhs.sequence
  }
}

/// One item of the ordered timeline: the event, when it happened, where it sits.
public struct TimelineItem: Codable, Sendable, Equatable {
  public let event: SessionEvent
  public let at: Double?
  public let position: SessionPosition

  public init(event: SessionEvent, at: Double? = nil, position: SessionPosition) {
    self.event = event
    self.at = at
    self.position = position
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    event = try c.decodeValue("event", SessionEvent.self)
    at = try c.decodeIfPresent("at", Double.self)
    position = try c.decodeValue("position", SessionPosition.self)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(event, key: "event")
    try c.encodeIfPresent(at, key: "at")
    try c.encode(position, key: "position")
  }
}

/// `GET /sessions/timeline?id=&before=&limit=` (`docs/mobile-timeline.md`):
/// the items oldest first, every one in the cursor's generation, strictly
/// increasing and at or below the cursor's watermark, or the page is refused.
public struct TimelinePage: Codable, Sendable, Equatable {
  public let items: [TimelineItem]
  /// Exclusive sequence boundary of the older page, in the cursor's generation; null when none is retained.
  public let before: Int?
  /// The highest position captured when the snapshot was taken, including events outside this page.
  public let cursor: SessionPosition
  /// Retention dropped events: this is recent history, not a complete transcript.
  public let truncated: Bool

  public init(items: [TimelineItem], before: Int?, cursor: SessionPosition, truncated: Bool) {
    self.items = items
    self.before = before
    self.cursor = cursor
    self.truncated = truncated
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    let cursor = try c.decodeValue("cursor", SessionPosition.self)
    let items = try c.decodeValue("items", [TimelineItem].self)
    var previous = -1
    for item in items {
      if item.position.generation != cursor.generation || item.position.sequence <= previous || item.position.sequence > cursor.sequence {
        throw DecodingError.dataCorruptedError(forKey: AnyKey("items"), in: c, debugDescription: "ordered items in the cursor generation at or below its watermark")
      }
      previous = item.position.sequence
    }
    self.items = items
    self.cursor = cursor
    if try c.decodeNil(forKey: AnyKey("before")) {
      before = nil
    } else {
      before = try c.decodeNonNegativeInt("before")
    }
    truncated = try c.decodeBool("truncated")
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(items, key: "items")
    try c.encodeNullable(before, key: "before")
    try c.encode(cursor, key: "cursor")
    try c.encode(truncated, key: "truncated")
  }
}
