import Foundation

// The ordered loading of one conversation, ported from the prototype's
// `openChat`, `refreshOpenHistory` and `loadOlder` in
// `apps/mobile/src/state/store.ts` (`docs/mobile-timeline.md`): subscribe
// and wait for the acknowledgement, buffer the live events while the
// snapshot is in flight, replace the conversation from the snapshot, apply
// the buffered events above its watermark in sequence order, then the live
// ones as they come. A repeated position is dropped, never a repeated text;
// another generation, or a gap, takes a fresh snapshot.

/// What the conversation screen shows.
public enum TimelineState: Sendable, Equatable {
  /// The first snapshot is on its way.
  case loading
  /// The conversation, the page cursor of its past, and whether retention dropped earlier events.
  case ready(Conversation, cursor: HistoryCursor, truncated: Bool)
  /// The conversation could not be loaded; the sentence says why.
  case failed(String)
}

/// The sentence shown for a server that keeps no ordered timeline (an older Mac app).
public let noOrderedHistoryMessage = "This Mac's Clave keeps no ordered history, so this conversation cannot be shown on the phone. Update Clave on the Mac."

/// The ordered loading of one conversation over its ports.
public actor TimelineSync {
  /// `GET /sessions/timeline` with an optional `before` and `limit`.
  public typealias FetchTimeline = @Sendable (_ before: Int?, _ limit: Int?) async throws -> TimelinePage

  private let fetchTimeline: FetchTimeline
  private let subscribe: @Sendable () async throws -> Void
  private let unsubscribe: @Sendable () async -> Void
  private let now: @Sendable () -> Double
  /// How many snapshots in a row a changing timeline may cost before the error state.
  private let attempts = 3

  /// What the screen shows now.
  public private(set) var current: TimelineState = .loading
  private var conversation = Conversation.empty
  private var cursor = HistoryCursor.fresh
  private var active = true
  private var buffering = false
  private var buffered: [BufferedItem] = []
  private var watermark: SessionPosition?
  private var exitCode: Int?
  private var inFlight: Task<Void, Never>?
  private var listeners: [UUID: AsyncStream<TimelineState>.Continuation] = [:]

  /// - Parameters:
  ///   - fetchTimeline: one page of the timeline.
  ///   - subscribe: subscribes to the session's stream; returns once the server acknowledged it.
  ///   - unsubscribe: ends the subscription.
  ///   - now: the clock stamped on live events, in epoch milliseconds.
  public init(
    fetchTimeline: @escaping FetchTimeline,
    subscribe: @escaping @Sendable () async throws -> Void,
    unsubscribe: @escaping @Sendable () async -> Void = {},
    now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }
  ) {
    self.fetchTimeline = fetchTimeline
    self.subscribe = subscribe
    self.unsubscribe = unsubscribe
    self.now = now
  }

  /// The states as they change, starting with the current one.
  public func states() -> AsyncStream<TimelineState> {
    let (stream, continuation) = AsyncStream<TimelineState>.makeStream(bufferingPolicy: .bufferingNewest(16))
    let id = UUID()
    listeners[id] = continuation
    continuation.yield(current)
    continuation.onTermination = { [weak self] _ in
      Task { await self?.dropListener(id) }
    }
    return stream
  }

  private func dropListener(_ id: UUID) { listeners.removeValue(forKey: id) }

  /// Subscribes, waits for the acknowledgement, then takes the first snapshot.
  public func start() async {
    await refresh(subscribing: true).value
  }

  /// The socket reopened: subscribe again and take a fresh snapshot, even over a loaded conversation.
  public func reconnect() async {
    if let inFlight { await inFlight.value }
    await refresh(subscribing: true).value
  }

  /// Ends the subscription; nothing published after.
  public func close() async {
    guard active else { return }
    active = false
    inFlight?.cancel()
    await unsubscribe()
    for continuation in listeners.values { continuation.finish() }
    listeners = [:]
  }

  /// One frame of the session's stream, in the order the socket delivered it.
  public func receive(_ stream: SessionStream) {
    guard active, case .event(let event, let position) = stream else { return }
    let item = BufferedItem(event: event, at: now(), position: position)
    if buffering {
      // A buffer of one generation only: frames of an earlier one cannot be merged with the next snapshot.
      if let latest = buffered.last(where: { $0.position != nil })?.position, let position, latest.generation != position.generation {
        buffered = []
      }
      buffered.append(item)
      return
    }
    if let position {
      if watermark == nil || position.generation != watermark!.generation || position.sequence > watermark!.sequence + 1 {
        _ = refresh(subscribing: false)
        buffered.append(item)
        return
      }
      if position.sequence <= watermark!.sequence { return }
      watermark = position
    }
    conversation = reduceConversation(conversation, .event(event, at: item.at))
    publishConversation()
  }

  /// The session's process ended with this code.
  public func exit(_ code: Int) {
    guard active else { return }
    exitCode = code
    conversation = reduceConversation(conversation, .exit(code))
    publishConversation()
  }

  /// A change the screen makes itself: a permission answered from here, a message taken back.
  public func apply(_ action: ConversationAction) {
    guard active else { return }
    conversation = reduceConversation(conversation, action)
    publishConversation()
  }

  /// The page before the oldest one shown, in the same generation; a page of another generation is
  /// discarded and a fresh snapshot taken. Throws what the fetch threw, the cursor left as it was.
  public func loadOlder() async throws {
    guard active, case .ready = current, shouldLoadOlder(cursor), let before = cursor.before else { return }
    let position = watermark
    cursor.loading = true
    publishConversation()
    let page: TimelinePage
    do {
      page = try await fetchTimeline(before, nil)
    } catch {
      if active && cursor.before == before {
        cursor.loading = false
        publishConversation()
      }
      throw error
    }
    guard active else { return }
    if page.cursor.generation != position?.generation {
      cursor.loading = false
      await refresh(subscribing: false).value
      return
    }
    // A snapshot taken meanwhile already replaced the page and its cursor.
    guard cursor.before == before else { return }
    let applied = applyOlderPage(conversation, HistoryChunk(page))
    conversation = applied.conversation
    cursor = applied.cursor
    publishConversation()
  }

  @discardableResult
  private func refresh(subscribing: Bool) -> Task<Void, Never> {
    if let inFlight { return inFlight }
    // Set before any suspension, so a frame that arrives next is buffered for this snapshot.
    buffering = true
    buffered = []
    let task = Task { await self.runRefresh(subscribing: subscribing) }
    inFlight = task
    return task
  }

  private func runRefresh(subscribing: Bool) async {
    defer {
      buffering = false
      buffered = []
      inFlight = nil
    }
    guard active else { return }
    do {
      // The acknowledgement means the server bound its listeners before the snapshot is taken.
      if subscribing { try await subscribe() }
      var attempt = 0
      while attempt < attempts && active {
        let page = try await fetchTimeline(nil, nil)
        guard active else { return }
        do {
          let joined = try mergeBufferedHistory(page: page, buffered: buffered)
          let applied = applyFirstPage(.empty, joined)
          watermark = buffered.reduce(page.cursor) { position, item in
            if let p = item.position, p.sequence > position.sequence { return p }
            return position
          }
          conversation = exitCode.map { reduceConversation(applied.conversation, .exit($0)) } ?? applied.conversation
          cursor = applied.cursor
          publishConversation(force: true)
          return
        } catch let changed as TimelineChanged {
          if attempt == attempts - 1 { throw changed }
          // The next snapshot starts after every frame buffered so far.
          buffered = []
        }
        attempt += 1
      }
    } catch {
      if active { publish(.failed(timelineFailureMessage(error))) }
    }
  }

  private func publishConversation(force: Bool = false) {
    // A failed screen stays failed until a snapshot lands; live frames still update what it would show.
    if !force, case .failed = current { return }
    if !force, case .loading = current { return }
    publish(.ready(conversation, cursor: cursor, truncated: cursor.truncated))
  }

  private func publish(_ state: TimelineState) {
    current = state
    for continuation in listeners.values { continuation.yield(state) }
  }
}

/// The sentence the screen shows for a failed load: a server without the ordered timeline (404, or
/// a refused CapabilityUnavailable) is said to keep none, never guessed around; any other failure
/// carries its own sentence.
public func timelineFailureMessage(_ error: Error) -> String {
  if let error = error as? ServerError {
    if error.kind == .notFound || (error.kind == .refused && error.failure?.tag == "CapabilityUnavailable") {
      return noOrderedHistoryMessage
    }
    return error.message
  }
  return reasonOf(error)
}
