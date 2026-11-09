import CryptoKit
import Foundation

/// The namespace of one owner's records: "clave.owner." and the lowercase
/// hex SHA-256 of the prototype's exact JSON, `["<issuer>",{"subject":"<subject>"}]`
/// or `["<issuer>",null]` when signed out, so the phone files an owner's
/// records under the same name the prototype did.
public func ownerNamespace(issuer: String, subject: String?) -> String {
  let owner = subject.map { "{\"subject\":\(JSONValue.quote($0))}" } ?? "null"
  let json = "[\(JSONValue.quote(issuer)),\(owner)]"
  let digest = SHA256.hash(data: Data(json.utf8))
  return "clave.owner." + digest.map { String(format: "%02x", $0) }.joined()
}

/// A secure store seen through one owner's namespace (keys "<namespace>.<key>").
/// Immutable once made: an asynchronous operation that started under one
/// owner keeps writing into that owner's namespace after a sign-out, never
/// into the next account's.
public struct OwnerScopedSecureStore: SecureStore {
  public let base: any SecureStore
  public let namespace: String

  /// `base` scoped to `namespace`.
  public init(base: any SecureStore, namespace: String) {
    self.base = base
    self.namespace = namespace
  }

  private func scoped(_ key: String) -> String { "\(namespace).\(key)" }

  public func get(_ key: String) async throws -> String? { try await base.get(scoped(key)) }
  public func set(_ key: String, _ value: String) async throws { try await base.set(scoped(key), value) }
  public func delete(_ key: String) async throws { try await base.delete(scoped(key)) }
}

/// A key-value store seen through one owner's namespace (keys "<namespace>:<key>"),
/// immutable once made for the same reason as `OwnerScopedSecureStore`.
public struct OwnerScopedKeyValueStore: KeyValueStore {
  public let base: any KeyValueStore
  public let namespace: String

  /// `base` scoped to `namespace`.
  public init(base: any KeyValueStore, namespace: String) {
    self.base = base
    self.namespace = namespace
  }

  private func scoped(_ key: String) -> String { "\(namespace):\(key)" }

  public func get(_ key: String) async throws -> String? { try await base.get(scoped(key)) }
  public func set(_ key: String, _ value: String) async throws { try await base.set(scoped(key), value) }
  public func remove(_ key: String) async throws { try await base.remove(scoped(key)) }
}
