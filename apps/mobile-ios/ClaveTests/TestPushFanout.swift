import ClaveCore
import Foundation

/// The tests' one reader of a push client's event stream, standing in for the fan-out the app's
/// `MachineConnection` does (`events()`), for a conversation built without a connection.
///
/// `PushClient.events` is a single AsyncStream: two readers split its frames between them, and a
/// reader whose task is cancelled finishes the stream for everyone after it. A chat that is left
/// and opened again would then hear nothing. So the stream is read once, by a task nobody
/// cancels, and each listener gets its own stream it may drop whenever it likes.
@MainActor
final class TestPushFanout {
  private static var hubs: [ObjectIdentifier: TestPushFanout] = [:]

  /// The fan-out of this client, made on first use and kept until the client's stream ends.
  static func shared(for push: PushClient) -> TestPushFanout {
    let key = ObjectIdentifier(push)
    if let hub = hubs[key] { return hub }
    let hub = TestPushFanout(push: push)
    hubs[key] = hub
    return hub
  }

  private var listeners: [UUID: AsyncStream<PushEvent>.Continuation] = [:]
  private var finished = false

  private init(push: PushClient) {
    let key = ObjectIdentifier(push)
    Task { [weak self] in
      for await event in push.events {
        self?.deliver(event)
      }
      self?.finish()
      Self.hubs.removeValue(forKey: key)
    }
  }

  /// The events from now on, until the client ends or the reader stops.
  func stream() -> AsyncStream<PushEvent> {
    let (stream, continuation) = AsyncStream<PushEvent>.makeStream(bufferingPolicy: .unbounded)
    if finished {
      continuation.finish()
      return stream
    }
    let id = UUID()
    listeners[id] = continuation
    continuation.onTermination = { [weak self] _ in
      Task { @MainActor in self?.listeners.removeValue(forKey: id) }
    }
    return stream
  }

  private func deliver(_ event: PushEvent) {
    for continuation in listeners.values { continuation.yield(event) }
  }

  private func finish() {
    finished = true
    for continuation in listeners.values { continuation.finish() }
    listeners = [:]
  }
}
