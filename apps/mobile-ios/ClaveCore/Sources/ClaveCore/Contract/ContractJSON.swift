import Foundation

/// A wire value that does not have the shape the contract names: the path
/// to the field and what was expected, never the value read (a token may
/// sit beside it).
public struct DecodeError: Error, Equatable, Sendable, CustomStringConvertible {
  public let path: String
  public let expected: String

  public init(path: String, expected: String) {
    self.path = path
    self.expected = expected
  }

  public var description: String { "\(path): expected \(expected)" }
}

/// The one decoder and encoder of the wire: JSON as the server writes it,
/// a `DecodeError` naming the path on any mismatch.
public enum ContractJSON {
  public static func decode<T: Decodable>(_ type: T.Type, from data: Data, path: String = "body") throws -> T {
    let decoder = JSONDecoder()
    do {
      return try decoder.decode(type, from: data)
    } catch let error as DecodingError {
      throw DecodeError(decodingError: error, root: path)
    } catch let error as DecodeError {
      throw error
    }
  }

  public static func decode<T: Decodable>(_ type: T.Type, from text: String, path: String = "body") throws -> T {
    try decode(type, from: Data(text.utf8), path: path)
  }

  public static func encode<T: Encodable>(_ value: T) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes, .sortedKeys]
    return try encoder.encode(value)
  }

  public static func encodeToString<T: Encodable>(_ value: T) throws -> String {
    String(decoding: try encode(value), as: UTF8.self)
  }
}

extension DecodeError {
  init(decodingError: DecodingError, root: String) {
    func render(_ codingPath: [CodingKey]) -> String {
      codingPath.reduce(root) { partial, key in
        if let index = key.intValue { return "\(partial)[\(index)]" }
        return "\(partial).\(key.stringValue)"
      }
    }
    switch decodingError {
    case .typeMismatch(let type, let context):
      self.init(path: render(context.codingPath), expected: context.debugDescription.isEmpty ? "\(type)" : context.debugDescription)
    case .valueNotFound(let type, let context):
      self.init(path: render(context.codingPath), expected: "a \(type), not null")
    case .keyNotFound(let key, let context):
      self.init(path: render(context.codingPath + [key]), expected: "a value")
    case .dataCorrupted(let context):
      self.init(path: render(context.codingPath), expected: context.debugDescription)
    @unknown default:
      self.init(path: root, expected: "a decodable value")
    }
  }
}

/// A key of any name, for unions keyed by a string the schema names.
struct AnyKey: CodingKey {
  var stringValue: String
  var intValue: Int? { nil }
  init(_ string: String) { stringValue = string }
  init?(stringValue: String) { self.stringValue = stringValue }
  init?(intValue: Int) { nil }
}

extension KeyedDecodingContainer where K == AnyKey {
  func decodeString(_ key: String) throws -> String {
    try decode(String.self, forKey: AnyKey(key))
  }

  func decodeNonEmpty(_ key: String) throws -> String {
    let value = try decode(String.self, forKey: AnyKey(key))
    guard !value.isEmpty else {
      throw DecodingError.dataCorruptedError(forKey: AnyKey(key), in: self, debugDescription: "a non-empty string")
    }
    return value
  }

  func decodeOptionalString(_ key: String) throws -> String? {
    try decodeIfPresent(String.self, forKey: AnyKey(key))
  }

  func decodeDouble(_ key: String) throws -> Double {
    try decode(Double.self, forKey: AnyKey(key))
  }

  func decodeBool(_ key: String) throws -> Bool {
    try decode(Bool.self, forKey: AnyKey(key))
  }

  /// A nonnegative safe integer, the shape of a sequence or a byte count.
  func decodeNonNegativeInt(_ key: String) throws -> Int {
    let value = try decode(Double.self, forKey: AnyKey(key))
    guard value >= 0, value <= 9_007_199_254_740_991, value.rounded() == value else {
      throw DecodingError.dataCorruptedError(forKey: AnyKey(key), in: self, debugDescription: "a nonnegative safe integer")
    }
    return Int(value)
  }

  func decodeLiteral<T: RawRepresentable>(_ key: String, _ type: T.Type) throws -> T where T.RawValue == String, T: CaseIterable {
    let raw = try decode(String.self, forKey: AnyKey(key))
    guard let value = T(rawValue: raw) else {
      let names = T.allCases.map { "\($0.rawValue)" }.joined(separator: ", ")
      throw DecodingError.dataCorruptedError(forKey: AnyKey(key), in: self, debugDescription: "one of \(names)")
    }
    return value
  }

  func decodeIfPresent<T: Decodable>(_ key: String, _ type: T.Type) throws -> T? {
    try decodeIfPresent(type, forKey: AnyKey(key))
  }

  func decodeValue<T: Decodable>(_ key: String, _ type: T.Type) throws -> T {
    try decode(type, forKey: AnyKey(key))
  }

  /// A field that may be absent or null, read as nil either way.
  func decodeNullable<T: Decodable>(_ key: String, _ type: T.Type) throws -> T? {
    guard contains(AnyKey(key)) else { return nil }
    if try decodeNil(forKey: AnyKey(key)) { return nil }
    return try decode(type, forKey: AnyKey(key))
  }

  /// A field the shape says is present, string or null.
  func decodeNullableString(_ key: String) throws -> String? {
    if try decodeNil(forKey: AnyKey(key)) { return nil }
    return try decode(String.self, forKey: AnyKey(key))
  }
}

extension KeyedEncodingContainer where K == AnyKey {
  mutating func encode<T: Encodable>(_ value: T, key: String) throws {
    try encode(value, forKey: AnyKey(key))
  }

  mutating func encodeIfPresent<T: Encodable>(_ value: T?, key: String) throws {
    if let value { try encode(value, forKey: AnyKey(key)) }
  }

  mutating func encodeNullable<T: Encodable>(_ value: T?, key: String) throws {
    if let value { try encode(value, forKey: AnyKey(key)) } else { try encodeNil(forKey: AnyKey(key)) }
  }
}
