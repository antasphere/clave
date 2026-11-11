import Foundation

// From a picked file to a record on the message, and the message itself,
// ported from the prototype's `apps/mobile/src/attachments/compose.ts`: the
// policy, the bytes read through the platform's file port, the upload, the
// label and its marker. The labels and markers are the desktop composer's:
// every record is `Image #n`, `File #n` or `Folder #n`, numbered per kind in
// the order attached, and written into the text as `[Image #1]` so the agent
// knows where each belongs. The desktop puts the marker at the caret; the
// phone appends it, one space apart, where a thumb was.

/// The kind a record is labelled by: what it is to the agent.
public enum AttachmentKind: String, Sendable, Equatable {
  case image = "Image", file = "File", folder = "Folder"
}

/// The label kind of a prepared record, by its delivery.
public func attachmentKind(_ record: FileAttachment) -> AttachmentKind {
  switch record.delivery {
  case .folder: return .folder
  case .image: return .image
  case .reference: return .file
  }
}

private let labelPattern = try! NSRegularExpression(pattern: "^(Image|File|Folder|Session) #(\\d+)$")

/// The next label of a kind: one past the highest number that kind holds, so a label removed from
/// the message is never issued twice.
public func nextLabel(_ kind: AttachmentKind, _ current: [Attachment]) -> String {
  var highest = 0
  for attachment in current {
    guard let label = attachment.label else { continue }
    let ns = label as NSString
    guard let match = labelPattern.firstMatch(in: label, range: NSRange(location: 0, length: ns.length)),
          ns.substring(with: match.range(at: 1)) == kind.rawValue,
          let number = Int(ns.substring(with: match.range(at: 2))) else { continue }
    highest = max(highest, number)
  }
  return "\(kind.rawValue) #\(highest + 1)"
}

/// The marker a record is written into the text as: "[Image #1]"; nil without a label.
public func markerOf(_ attachment: Attachment) -> String? {
  attachment.label.map { "[\($0)]" }
}

/// The record with its label, numbered after what the message already holds.
public func labelled(_ record: FileAttachment, _ current: [Attachment]) -> FileAttachment {
  FileAttachment(id: record.id, label: nextLabel(attachmentKind(record), current), path: record.path, name: record.name, mimeType: record.mimeType, size: record.size, delivery: record.delivery, entries: record.entries)
}

/// The text with every record's marker in it: those it lacks appended, one space apart, in order.
public func textWithMarkers(_ text: String, _ attachments: [Attachment]) -> String {
  var out = text
  for attachment in attachments {
    guard let marker = markerOf(attachment), !out.contains(marker) else { continue }
    out = out.isEmpty || out.last!.isWhitespace ? out + marker : "\(out) \(marker)"
  }
  return out
}

/// A message holds more records than it may.
public struct TooManyAttachments: Error, Sendable, Equatable, CustomStringConvertible {
  public var description: String { "Attach up to \(maxAttachments) files per message." }
}

/// The user message a send writes: the text with its markers, the records (never bytes), the id.
public func buildUserMessage(_ text: String, _ attachments: [Attachment], clientMessageId: String? = nil) throws -> UserMessage {
  if attachments.count > maxAttachments { throw TooManyAttachments() }
  return UserMessage(clientMessageId: clientMessageId, text: textWithMarkers(text, attachments), attachments: attachments.isEmpty ? nil : attachments)
}

/// The bytes a base64 text decodes to.
public func base64Bytes(_ base64: String) -> Int {
  let padding = base64.hasSuffix("==") ? 2 : base64.hasSuffix("=") ? 1 : 0
  return base64.utf8.count * 3 / 4 - padding
}

/// A picked file on the message, or the sentence that says why not.
public enum PreparedAttachment: Sendable, Equatable {
  case prepared(FileAttachment, note: String?)
  case refused(reason: String)
}

/// One picked file onto the message: admitted by the policy, read, admitted again on the bytes
/// actually read (the picker's size was a promise), uploaded, labelled. A server's refusal carries
/// the server's sentence.
public func prepareAttachment(
  _ file: PickedFile,
  sessionId: String,
  current: [Attachment],
  readBase64: @Sendable (_ uri: String) async throws -> String,
  prepareUpload: @Sendable (_ sessionId: String, _ name: String, _ base64: String, _ image: Bool) async throws -> FileAttachment,
  imagesSupported: Bool,
  filesRoute: Bool
) async -> PreparedAttachment {
  let imageBytes = current.reduce(0) { sum, attachment in
    if case .file(let record) = attachment, record.delivery == .image { return sum + record.size }
    return sum
  }
  let context = AdmissionContext(count: current.count, imageBytes: imageBytes, imagesSupported: imagesSupported, filesRoute: filesRoute)
  if case .refused(let reason) = admit(file, context) { return .refused(reason: reason) }
  let base64: String
  do {
    base64 = try await readBase64(file.uri)
  } catch {
    return .refused(reason: "\(file.name) could not be read: \(reasonOf(error))")
  }
  var read = file
  read.size = base64Bytes(base64)
  let admission = admit(read, context)
  guard case .accepted(let image, let note) = admission else {
    if case .refused(let reason) = admission { return .refused(reason: reason) }
    return .refused(reason: "\(file.name) was not sent.")
  }
  do {
    let record = try await prepareUpload(sessionId, file.name, base64, image)
    return .prepared(labelled(record, current), note: note)
  } catch {
    if let error = error as? ServerError, error.failure?.tag == "CapabilityUnavailable" {
      return .refused(reason: noFilesRouteReason)
    }
    return .refused(reason: "\(file.name) was not sent: \(reasonOf(error))")
  }
}
