import Foundation

/// A parsed JSON document, typed the way JavaScript sees one, so the shape
/// checks ported from the prototype (`typeof x === 'string'`, a boolean is
/// not a number) read the same here. Serialization follows JSON.stringify's
/// escaping, which the owner namespace hashes byte for byte.
enum JSONValue: Equatable, Sendable, Decodable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: JSONValue].self))
    }
  }

  /// The document in the bytes, or nil when they are not JSON.
  static func parse(_ data: Data) -> JSONValue? {
    guard !data.isEmpty else { return nil }
    return try? JSONDecoder().decode(JSONValue.self, from: data)
  }

  static func parse(_ text: String) -> JSONValue? { parse(Data(text.utf8)) }

  subscript(key: String) -> JSONValue? {
    if case .object(let members) = self { return members[key] }
    return nil
  }

  var stringValue: String? {
    if case .string(let value) = self { return value }
    return nil
  }

  var numberValue: Double? {
    if case .number(let value) = self { return value }
    return nil
  }

  var boolValue: Bool? {
    if case .bool(let value) = self { return value }
    return nil
  }

  var isObject: Bool {
    if case .object = self { return true }
    return false
  }

  /// Compact JSON; object keys sorted so the output is stable.
  func serialized() -> String {
    switch self {
    case .null: return "null"
    case .bool(let value): return value ? "true" : "false"
    case .number(let value):
      if value.isFinite, value == value.rounded(), abs(value) < 1e15 { return String(Int64(value)) }
      return value.isFinite ? "\(value)" : "null"
    case .string(let value): return JSONValue.quote(value)
    case .array(let items): return "[" + items.map { $0.serialized() }.joined(separator: ",") + "]"
    case .object(let members):
      return "{" + members.keys.sorted().map { JSONValue.quote($0) + ":" + members[$0]!.serialized() }
        .joined(separator: ",") + "}"
    }
  }

  /// A JSON string literal escaped exactly as JSON.stringify escapes it.
  static func quote(_ text: String) -> String {
    var out = "\""
    for scalar in text.unicodeScalars {
      switch scalar.value {
      case 0x22: out += "\\\""
      case 0x5c: out += "\\\\"
      case 0x08: out += "\\b"
      case 0x0c: out += "\\f"
      case 0x0a: out += "\\n"
      case 0x0d: out += "\\r"
      case 0x09: out += "\\t"
      case 0..<0x20: out += String(format: "\\u%04x", scalar.value)
      default: out.unicodeScalars.append(scalar)
      }
    }
    return out + "\""
  }
}
