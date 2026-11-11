import Foundation

// The files domain a phone touches (`files.ts`): reading a text for a
// document card, and preparing an attachment for a message. The device
// session's scope grants `GET` under `/files/` and exactly
// `POST /files/attachments/prepare`; nothing else here is callable by a phone.

/// The server's one transfer bound, 5 MiB.
public let maxTransferBytes = 5 * 1024 * 1024

public struct FileLocation: Codable, Sendable, Equatable, Hashable {
  public let root: String
  public let path: String

  public init(root: String, path: String) {
    self.root = root
    self.path = path
  }
}

public struct FileText: Codable, Sendable, Equatable {
  public let content: String
  public let truncated: Bool
  public let size: Int
  public let binary: Bool

  public init(content: String, truncated: Bool, size: Int, binary: Bool) {
    self.content = content
    self.truncated = truncated
    self.size = size
    self.binary = binary
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    content = try c.decodeString("content")
    truncated = try c.decodeBool("truncated")
    size = try c.decodeNonNegativeInt("size")
    binary = try c.decodeBool("binary")
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(content, key: "content")
    try c.encode(truncated, key: "truncated")
    try c.encode(size, key: "size")
    try c.encode(binary, key: "binary")
  }
}

/// Where an attachment's bytes come from: a file on the server, or an upload
/// from the phone (base64, flagged as an image when it should travel as one).
public enum AttachmentSource: Codable, Sendable, Equatable {
  case file(root: String, path: String)
  case upload(name: String, base64: String, image: Bool)

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    let kind = try c.decodeString("kind")
    switch kind {
    case "file":
      self = .file(root: try c.decodeString("root"), path: try c.decodeString("path"))
    case "upload":
      self = .upload(name: try c.decodeString("name"), base64: try c.decodeString("base64"), image: try c.decodeBool("image"))
    default:
      throw DecodingError.dataCorruptedError(forKey: AnyKey("kind"), in: c, debugDescription: "file or upload")
    }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    switch self {
    case .file(let root, let path):
      try c.encode("file", key: "kind")
      try c.encode(root, key: "root")
      try c.encode(path, key: "path")
    case .upload(let name, let base64, let image):
      try c.encode("upload", key: "kind")
      try c.encode(name, key: "name")
      try c.encode(base64, key: "base64")
      try c.encode(image, key: "image")
    }
  }
}

/// `POST /files/attachments/prepare`'s body.
public struct PrepareFileAttachmentInput: Codable, Sendable, Equatable {
  public let sessionId: String
  public let source: AttachmentSource

  public init(sessionId: String, source: AttachmentSource) {
    self.sessionId = sessionId
    self.source = source
  }
}
