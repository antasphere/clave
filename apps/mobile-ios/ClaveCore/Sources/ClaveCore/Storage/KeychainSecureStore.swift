import Foundation
import Security

/// A Keychain call that failed, with the Security framework's status.
public struct KeychainError: Error, Equatable, CustomStringConvertible {
  public let status: OSStatus

  /// The failure of one Keychain call.
  public init(status: OSStatus) {
    self.status = status
  }

  public var description: String {
    let text = SecCopyErrorMessageString(status, nil) as String? ?? "unknown"
    return "Keychain error \(status): \(text)"
  }
}

/// The secure store over the Keychain: one generic-password item per key,
/// under the app's own service. Readable after the first unlock so a refresh
/// can run while the phone is locked in a pocket; never synchronized and
/// bound to this device, so a backup restored elsewhere carries no tokens.
/// No access group: only this app reads its items.
public struct KeychainSecureStore: SecureStore {
  /// The item service every key is filed under.
  public let service: String

  /// A store under `service`.
  public init(service: String = "com.clave.ios.dev.credentials") {
    self.service = service
  }

  private func query(_ key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
      kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
      // The macOS build (tests, Catalyst) uses the same keychain the phone
      // does rather than the legacy file keychain.
      kSecUseDataProtectionKeychain as String: kCFBooleanTrue as Any,
    ]
  }

  public func get(_ key: String) async throws -> String? {
    var request = query(key)
    request[kSecReturnData as String] = kCFBooleanTrue
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(request as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw KeychainError(status: status) }
    guard let data = result as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  public func set(_ key: String, _ value: String) async throws {
    let data = Data(value.utf8)
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let updated = SecItemUpdate(query(key) as CFDictionary, attributes as CFDictionary)
    if updated == errSecSuccess { return }
    guard updated == errSecItemNotFound else { throw KeychainError(status: updated) }
    var item = query(key)
    item.merge(attributes) { _, new in new }
    let added = SecItemAdd(item as CFDictionary, nil)
    guard added == errSecSuccess else { throw KeychainError(status: added) }
  }

  public func delete(_ key: String) async throws {
    let status = SecItemDelete(query(key) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
  }
}
