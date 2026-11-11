import Foundation

/// Why a base64url text was refused.
public enum Base64URLError: Error, Equatable, Sendable {
  /// A length no byte sequence encodes to (one more than a multiple of four).
  case impossibleLength
  /// A character outside the URL-safe alphabet, padding included.
  case invalidCharacter
}

/// Base64url (RFC 4648 section 5) without padding, for the PKCE challenge and
/// the JWT segments. Written by hand rather than over Foundation's base64 so
/// the decoder refuses exactly what the prototype's `encoding.ts` refuses:
/// padding, the standard alphabet's `+` and `/`, and impossible lengths.
public enum Base64URL {
  private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf8)

  private static let valueOf: [UInt8: UInt32] = {
    var table: [UInt8: UInt32] = [:]
    for (index, char) in alphabet.enumerated() { table[char] = UInt32(index) }
    return table
  }()

  /// The unpadded base64url text of the bytes.
  public static func encode(_ data: Data) -> String { encode(Array(data)) }

  /// The unpadded base64url text of the bytes.
  public static func encode(_ bytes: [UInt8]) -> String {
    var out: [UInt8] = []
    out.reserveCapacity((bytes.count * 4 + 2) / 3)
    var i = 0
    while i + 2 < bytes.count {
      let n = UInt32(bytes[i]) << 16 | UInt32(bytes[i + 1]) << 8 | UInt32(bytes[i + 2])
      out.append(alphabet[Int((n >> 18) & 63)])
      out.append(alphabet[Int((n >> 12) & 63)])
      out.append(alphabet[Int((n >> 6) & 63)])
      out.append(alphabet[Int(n & 63)])
      i += 3
    }
    if i < bytes.count {
      let second: UInt32 = i + 1 < bytes.count ? UInt32(bytes[i + 1]) : 0
      let n = UInt32(bytes[i]) << 16 | second << 8
      out.append(alphabet[Int((n >> 18) & 63)])
      out.append(alphabet[Int((n >> 12) & 63)])
      if i + 1 < bytes.count { out.append(alphabet[Int((n >> 6) & 63)]) }
    }
    return String(decoding: out, as: UTF8.self)
  }

  /// The bytes of a base64url text; throws on any character outside the
  /// alphabet, on padding, and on a length no byte sequence encodes to.
  public static func decode(_ text: String) throws -> Data {
    let chars = Array(text.utf8)
    if chars.count % 4 == 1 { throw Base64URLError.impossibleLength }
    var out = Data()
    out.reserveCapacity(chars.count * 3 / 4)
    var buffer: UInt32 = 0
    var bits = 0
    for char in chars {
      guard let value = valueOf[char] else { throw Base64URLError.invalidCharacter }
      buffer = ((buffer << 6) | value) & 0xffff
      bits += 6
      if bits >= 8 {
        bits -= 8
        out.append(UInt8((buffer >> UInt32(bits)) & 0xff))
      }
    }
    return out
  }
}
