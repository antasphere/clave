import Foundation
import XCTest
@testable import ClaveCore

/// A JSON object from Swift values, for tool inputs and outputs.
func json(_ members: [String: JSONValue]) -> JSONValue { .object(members) }

func play(_ events: [SessionEvent], from start: Conversation = .empty) -> Conversation {
  events.reduce(start) { reduceConversation($0, .event($1, at: 1)) }
}

func permissionEvent(_ id: String, description: String = "Allow?", options: [PermissionOption] = [], toolName: String? = nil, questions: [AgentQuestion]? = nil) -> SessionEvent {
  .permissionRequest(PermissionRequestEvent(id: id, description: description, options: options, toolName: toolName, questions: questions))
}

func card(_ item: ConversationItem?) -> PermissionCard? {
  if case .permission(let card)? = item { return card }
  return nil
}

func kinds(_ items: [ConversationItem]) -> [String] {
  items.map { item in
    switch item {
    case .user: return "user"
    case .assistant: return "assistant"
    case .tool: return "tool"
    case .permission: return "permission"
    case .error: return "error"
    case .document: return "document"
    }
  }
}

/// Text of the transcript's user and assistant items, joined.
func transcriptText(_ conversation: Conversation) -> String {
  conversation.items.map { item -> String in
    switch item {
    case .user(let turn): return turn.text
    case .assistant(let turn): return turn.text
    default: return ""
    }
  }.joined()
}

/// Polls until `condition` holds, failing the test after two seconds.
func eventually(_ message: String = "condition", file: StaticString = #filePath, line: UInt = #line, _ condition: @Sendable () async -> Bool) async {
  let deadline = Date().addingTimeInterval(2)
  while Date() < deadline {
    if await condition() { return }
    try? await Task.sleep(nanoseconds: 1_000_000)
  }
  XCTFail("Timed out waiting for \(message)", file: file, line: line)
}

/// Mutable state shared with `@Sendable` port closures in a test.
final class Box<T>: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: T
  init(_ value: T) { stored = value }
  var value: T {
    get { lock.lock(); defer { lock.unlock() }; return stored }
    set { lock.lock(); defer { lock.unlock() }; stored = newValue }
  }
  func mutate<R>(_ change: (inout T) -> R) -> R {
    lock.lock(); defer { lock.unlock() }
    return change(&stored)
  }
}

/// A key-value store that, once told, holds the next read of one key after the value was read,
/// until released: a read-modify-write held there writes back what it read before.
actor ReadHoldingStore: KeyValueStore {
  private let inner: any KeyValueStore
  private var holding: String?
  private var held: [CheckedContinuation<Void, Never>] = []
  /// Every key read, in order.
  private(set) var reads: [String] = []

  init(_ inner: any KeyValueStore = InMemoryKeyValueStore()) {
    self.inner = inner
  }

  /// Holds the next read of `key`, once.
  func holdNextRead(of key: String) { holding = key }
  /// How many reads wait.
  var waiting: Int { held.count }
  /// Lets the waiting reads go on.
  func release() {
    let waiting = held
    held = []
    for read in waiting { read.resume() }
  }

  func get(_ key: String) async throws -> String? {
    reads.append(key)
    let value = try await inner.get(key)
    if key == holding {
      holding = nil
      await withCheckedContinuation { held.append($0) }
    }
    return value
  }

  func set(_ key: String, _ value: String) async throws { try await inner.set(key, value) }
  func remove(_ key: String) async throws { try await inner.remove(key) }
}
