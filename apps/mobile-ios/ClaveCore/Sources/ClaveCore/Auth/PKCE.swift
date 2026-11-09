import CryptoKit
import Foundation
import Security

/// Where the sign-in's random bytes come from; a test pins them.
public protocol RandomSource: Sendable {
  /// `count` bytes from the generator.
  func bytes(_ count: Int) -> [UInt8]
}

/// The platform's generator: SecRandomCopyBytes, and the system generator
/// should the Security call ever fail, so a verifier is never all zeroes.
public struct SystemRandomSource: RandomSource {
  /// The platform's generator.
  public init() {}

  public func bytes(_ count: Int) -> [UInt8] {
    var out = [UInt8](repeating: 0, count: count)
    let status = out.withUnsafeMutableBytes { buffer -> OSStatus in
      guard let base = buffer.baseAddress else { return errSecSuccess }
      return SecRandomCopyBytes(kSecRandomDefault, count, base)
    }
    if status != errSecSuccess {
      var generator = SystemRandomNumberGenerator()
      for index in out.indices { out[index] = UInt8.random(in: .min ... .max, using: &generator) }
    }
    return out
  }
}

/// PKCE (RFC 7636, S256) and the two random values of an authorization
/// request. The hub requires S256 for a public native client and for any
/// request that asks for `offline_access`.
public enum PKCE {
  /// 32 random bytes as base64url: 43 characters, within RFC 7636's 43 to 128.
  public static func makeVerifier(using random: any RandomSource = SystemRandomSource()) -> String {
    Base64URL.encode(random.bytes(32))
  }

  /// A `state` or a `nonce`: random bytes (16 unless told otherwise) as base64url.
  public static func randomValue(bytes: Int = 16, using random: any RandomSource = SystemRandomSource()) -> String {
    Base64URL.encode(random.bytes(bytes))
  }

  /// The S256 challenge of a verifier: base64url of the SHA-256 of its bytes.
  public static func challenge(of verifier: String) -> String {
    Base64URL.encode(Array(SHA256.hash(data: Data(verifier.utf8))))
  }
}
