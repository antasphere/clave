import Foundation

// What a photo, a screenshot or a file is on its way into a message and
// whether it may go, ported from the prototype's `apps/mobile/src/attachments/types.ts`
// and `policy.ts` (decision 11 of the spec). The limits are the desktop
// chat's (ten records per message, pictures of 5 MiB at most and 20 MiB
// together) and the files route's (an upload of 5 MiB at most). A picture in
// a format the provider takes goes as a picture; a HEIC photo, a video or
// any other file goes as a file the agent reads with its own tools, with a
// sentence saying so; what cannot go is refused with a sentence, never
// dropped in silence.

/// Records per message.
public let maxAttachments = 10
/// One picture's bytes.
public let maxImageBytes = 5 * 1024 * 1024
/// The pictures of one message together.
public let maxTotalImageBytes = 20 * 1024 * 1024
/// The formats a provider takes as image content; anything else travels as a file.
public let imageMimeTypes: Set<String> = ["image/png", "image/jpeg", "image/gif", "image/webp"]

/// What the picker says a file is.
public enum PickedKind: String, Sendable, Equatable {
  case image, video, file
}

/// A file the platform's picker handed over, before anything is read.
public struct PickedFile: Sendable, Equatable {
  public var uri: String
  public var name: String
  public var mimeType: String
  /// Bytes, when the picker knew.
  public var size: Int?
  public var kind: PickedKind

  public init(uri: String, name: String, mimeType: String, size: Int?, kind: PickedKind) {
    self.uri = uri
    self.name = name
    self.mimeType = mimeType
    self.size = size
    self.kind = kind
  }
}

private let mimeByExtension: [String: String] = [
  "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
  "heic": "image/heic", "heif": "image/heif", "mp4": "video/mp4", "mov": "video/quicktime",
  "pdf": "application/pdf", "txt": "text/plain", "md": "text/markdown", "json": "application/json",
  "csv": "text/csv", "zip": "application/zip",
]

/// The media type a file's name says it is (the server re-types every upload by name anyway).
public func mimeTypeOf(_ name: String) -> String {
  let base = name.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? name
  guard let dot = base.lastIndex(of: "."), dot != base.startIndex else { return "application/octet-stream" }
  return mimeByExtension[base[base.index(after: dot)...].lowercased()] ?? "application/octet-stream"
}

/// The picker kind of a media type.
public func kindOf(_ mimeType: String) -> PickedKind {
  mimeType.hasPrefix("image/") ? .image : mimeType.hasPrefix("video/") ? .video : .file
}

/// What the message already holds and what the session and machine can take.
public struct AdmissionContext: Sendable, Equatable {
  /// Records already on the message.
  public var count: Int
  /// Bytes of the pictures already on the message.
  public var imageBytes: Int
  /// The session's provider takes images (`GET /sessions/capabilities`).
  public var imagesSupported: Bool
  /// The machine's server has the files route (a standalone server; the Mac app's own has none).
  public var filesRoute: Bool

  public init(count: Int = 0, imageBytes: Int = 0, imagesSupported: Bool, filesRoute: Bool) {
    self.count = count
    self.imageBytes = imageBytes
    self.imagesSupported = imagesSupported
    self.filesRoute = filesRoute
  }

  /// The context of a session from its capabilities.
  public init(count: Int = 0, imageBytes: Int = 0, capabilities: SessionCapabilities, filesRoute: Bool) {
    self.init(count: count, imageBytes: imageBytes, imagesSupported: capabilities.images, filesRoute: filesRoute)
  }
}

/// Whether a picked file may go, and how.
public enum Admission: Sendable, Equatable {
  /// It goes: as a picture (`image: true` on the prepare) or as a file, with what the composer says beside it.
  case accepted(image: Bool, note: String?)
  /// It does not, and the sentence says why.
  case refused(reason: String)
}

/// The sentence for a machine whose server cannot take files from the phone.
public let noFilesRouteReason = "This machine cannot take files from the phone: its server has no files route (a standalone server has one, the Mac app’s own server does not)."

private func mib(_ bytes: Int) -> String { "\(Int((Double(bytes) / (1024 * 1024)).rounded())) MiB" }

/// The policy for one picked file against what the message already holds.
public func admit(_ file: PickedFile, _ context: AdmissionContext) -> Admission {
  if !context.filesRoute { return .refused(reason: noFilesRouteReason) }
  if context.count >= maxAttachments { return .refused(reason: "Attach up to \(maxAttachments) files per message.") }
  guard let size = file.size, size >= 0 else { return .refused(reason: "The size of \(file.name) is not known, so it cannot be sent.") }
  if size == 0 { return .refused(reason: "\(file.name) is empty and cannot be sent.") }
  if size > maxTransferBytes {
    return .refused(reason: "\(file.name) is \(mib(size)); the beta sends files of \(mib(maxTransferBytes)) at most.")
  }
  let picture = imageMimeTypes.contains(file.mimeType)
  if picture && context.imagesSupported {
    if size > maxImageBytes { return .refused(reason: "\(file.name) is \(mib(size)); a picture is \(mib(maxImageBytes)) at most.") }
    if context.imageBytes + size > maxTotalImageBytes {
      return .refused(reason: "Pictures in one message must total \(mib(maxTotalImageBytes)) or less.")
    }
    return .accepted(image: true, note: nil)
  }
  if picture { return .accepted(image: false, note: "Sent as a file, not as a picture: this agent does not take pictures directly.") }
  if file.kind == .image { return .accepted(image: false, note: "Sent as a file, not as a picture: this format cannot be shown to the agent directly.") }
  if file.kind == .video { return .accepted(image: false, note: "Sent as a file: the agent reads it with its own tools.") }
  return .accepted(image: false, note: nil)
}
