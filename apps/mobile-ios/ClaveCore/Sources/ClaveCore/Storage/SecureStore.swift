import Foundation

/// A store for secrets (tokens, device bearers): the Keychain on the phone,
/// memory in the tests. Keys are plain strings; values are never logged.
public protocol SecureStore: Sendable {
  /// The value under `key`, or nil when there is none.
  func get(_ key: String) async throws -> String?
  /// Writes `value` under `key`, replacing what was there.
  func set(_ key: String, _ value: String) async throws
  /// Removes `key`; removing a missing key is not an error.
  func delete(_ key: String) async throws
}

/// A secure store in memory, which also records the order of its writes so
/// a test can assert which key was written first.
public actor InMemorySecureStore: SecureStore {
  /// What the store holds.
  public private(set) var values: [String: String]
  /// Every key `set` was called with, in order.
  public private(set) var writes: [String] = []

  /// An empty store, or one seeded with `values`.
  public init(_ values: [String: String] = [:]) {
    self.values = values
  }

  public func get(_ key: String) async throws -> String? { values[key] }

  public func set(_ key: String, _ value: String) async throws {
    writes.append(key)
    values[key] = value
  }

  public func delete(_ key: String) async throws {
    values.removeValue(forKey: key)
  }
}
