import Foundation

/// Any JSON value, for the fields the contract leaves open (a tool call's
/// input, a tool result's output, a provider event's payload, a request's
/// input): kept as it came, shown by the screens as text, never interpreted.
public indirect enum JSONValue: Sendable, Equatable, Hashable, Codable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public init(from decoder: Decoder) throws {
    let single = try decoder.singleValueContainer()
    if single.decodeNil() {
      self = .null
    } else if let value = try? single.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? single.decode(Double.self) {
      self = .number(value)
    } else if let value = try? single.decode(String.self) {
      self = .string(value)
    } else if let value = try? single.decode([JSONValue].self) {
      self = .array(value)
    } else if let value = try? single.decode([String: JSONValue].self) {
      self = .object(value)
    } else {
      throw DecodingError.dataCorruptedError(in: single, debugDescription: "a JSON value")
    }
  }

  public func encode(to encoder: Encoder) throws {
    var single = encoder.singleValueContainer()
    switch self {
    case .null: try single.encodeNil()
    case .bool(let value): try single.encode(value)
    case .number(let value): try single.encode(value)
    case .string(let value): try single.encode(value)
    case .array(let value): try single.encode(value)
    case .object(let value): try single.encode(value)
    }
  }

  /// The string when the value is one.
  public var stringValue: String? {
    if case .string(let value) = self { return value }
    return nil
  }

  /// The object's members when the value is one.
  public var objectValue: [String: JSONValue]? {
    if case .object(let value) = self { return value }
    return nil
  }

  /// A member of an object by key, or nil.
  public subscript(key: String) -> JSONValue? {
    objectValue?[key]
  }

  /// The value as pretty-printed JSON text, for a card that shows a tool's input or output.
  public var prettyPrinted: String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(self), let text = String(data: data, encoding: .utf8) else {
      return ""
    }
    return text
  }
}
