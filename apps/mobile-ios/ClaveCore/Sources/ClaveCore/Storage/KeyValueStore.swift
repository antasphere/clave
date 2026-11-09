import Foundation

/// A store for ordinary app state (drafts, the machine list): nothing secret.
public protocol KeyValueStore: Sendable {
  /// The value under `key`, or nil when there is none.
  func get(_ key: String) async throws -> String?
  /// Writes `value` under `key`, replacing what was there.
  func set(_ key: String, _ value: String) async throws
  /// Removes `key`; removing a missing key is not an error.
  func remove(_ key: String) async throws
}

/// A key-value store in memory, for tests and previews.
public actor InMemoryKeyValueStore: KeyValueStore {
  /// What the store holds.
  public private(set) var values: [String: String]

  /// An empty store, or one seeded with `values`.
  public init(_ values: [String: String] = [:]) {
    self.values = values
  }

  public func get(_ key: String) async throws -> String? { values[key] }
  public func set(_ key: String, _ value: String) async throws { values[key] = value }
  public func remove(_ key: String) async throws { values.removeValue(forKey: key) }
}

/// A key-value store kept as one JSON object in one file, rewritten
/// atomically on every change, so a crash mid-write leaves the previous
/// file whole. The actor serializes the writes; the file is read once.
public actor FileKeyValueStore: KeyValueStore {
  /// The file the store lives in.
  public nonisolated let fileURL: URL
  private var cache: [String: String]?

  /// A store in `directory` (created when missing), in the file `fileName`.
  public init(directory: URL, fileName: String = "clave-state.json") {
    self.fileURL = directory.appendingPathComponent(fileName, isDirectory: false)
  }

  public func get(_ key: String) async throws -> String? {
    try load()[key]
  }

  public func set(_ key: String, _ value: String) async throws {
    var values = try load()
    values[key] = value
    try save(values)
  }

  public func remove(_ key: String) async throws {
    var values = try load()
    guard values.removeValue(forKey: key) != nil else { return }
    try save(values)
  }

  private func load() throws -> [String: String] {
    if let cache { return cache }
    let values: [String: String]
    if let data = try? Data(contentsOf: fileURL) {
      // A file that no longer parses is app state, not a secret: starting
      // empty beats a store that refuses every read until reinstalled.
      values = (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
    } else {
      values = [:]
    }
    cache = values
    return values
  }

  private func save(_ values: [String: String]) throws {
    try FileManager.default.createDirectory(
      at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(values)
    #if os(iOS)
      try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    #else
      try data.write(to: fileURL, options: [.atomic])
    #endif
    cache = values
  }
}
