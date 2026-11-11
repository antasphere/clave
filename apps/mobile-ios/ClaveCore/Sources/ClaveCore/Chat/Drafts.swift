import Foundation

// The composer's drafts, ported from the prototype's `apps/mobile/src/chat/drafts.ts`
// and `attachments/drafts.ts`: one text draft and one list of the files picked
// for it per session per machine, kept on the device until sent, through a
// restart and through being offline, never sent by themselves.

/// The store key of a conversation's text draft.
public func draftKey(_ machineId: String, _ sessionId: String) -> String {
  "clave.draft:\(machineId):\(sessionId)"
}

/// The store key of a conversation's attachment draft.
public func attachmentDraftKey(_ machineId: String, _ sessionId: String) -> String {
  "clave.attachment-draft:\(machineId):\(sessionId)"
}

/// One text draft per machine and session.
public actor Drafts {
  private let store: any KeyValueStore
  private var cache: [String: String] = [:]

  /// The drafts over `store`.
  public init(store: any KeyValueStore) {
    self.store = store
  }

  /// The draft kept for this session, "" when none.
  public func get(_ machineId: String, _ sessionId: String) async throws -> String {
    let key = draftKey(machineId, sessionId)
    if let cached = cache[key] { return cached }
    let stored = try await store.get(key) ?? ""
    // A set that ran while the read was suspended wins over what the read found.
    if let cached = cache[key] { return cached }
    cache[key] = stored
    return stored
  }

  /// Keeps the text; an empty text removes the draft.
  public func set(_ machineId: String, _ sessionId: String, _ text: String) async throws {
    let key = draftKey(machineId, sessionId)
    cache[key] = text
    if text.isEmpty {
      try await store.remove(key)
    } else {
      try await store.set(key, text)
    }
  }

  /// Removes the draft.
  public func clear(_ machineId: String, _ sessionId: String) async throws {
    try await set(machineId, sessionId, "")
  }
}

/// What stays in a conversation's field once a send it carried was delivered: nothing when the field
/// is still the text sent; what was added after it when the field starts with that text, without
/// the spaces or line breaks that set the addition apart; the field as it is otherwise (it was
/// replaced, or no text of it was sent).
public func draftAfterDelivery(_ current: String, sent: String) -> String {
  if current == sent { return "" }
  guard !sent.isEmpty, current.hasPrefix(sent) else { return current }
  return String(current.dropFirst(sent.count).drop(while: \.isWhitespace))
}

/// The files picked for a conversation's next message, one JSON list per machine and session. The
/// writes run one after another: an actor takes other calls at each of its suspensions, and a
/// composer's save must never be lost under a delivery's read-modify-write.
public actor AttachmentDrafts {
  private let store: any KeyValueStore
  private var queue = SerialQueue()

  /// The attachment drafts over `store`.
  public init(store: any KeyValueStore) {
    self.store = store
  }

  /// The picked files; an unreadable list is an empty one.
  public func get(_ machineId: String, _ sessionId: String) async throws -> [PickedFile] {
    guard let raw = try await store.get(attachmentDraftKey(machineId, sessionId)) else { return [] }
    return (try? JSONDecoder().decode([PickedFile].self, from: Data(raw.utf8))) ?? []
  }

  /// Keeps the list; an empty list removes it.
  public func set(_ machineId: String, _ sessionId: String, _ files: [PickedFile]) async throws {
    try await queue.enqueue { [self] in
      try await write(machineId, sessionId, files)
    }.value
  }

  /// Removes the list.
  public func clear(_ machineId: String, _ sessionId: String) async throws {
    try await set(machineId, sessionId, [])
  }

  /// Takes the files a delivered send carried off the list, by their address, so files picked since
  /// stay; the list removed when nothing is left.
  public func removeSent(_ machineId: String, _ sessionId: String, files sent: [PickedFile]) async throws {
    try await queue.enqueue { [self] in
      let current = try await get(machineId, sessionId)
      let rest = current.filter { file in !sent.contains { $0.uri == file.uri } }
      if rest != current { try await write(machineId, sessionId, rest) }
    }.value
  }

  private func write(_ machineId: String, _ sessionId: String, _ files: [PickedFile]) async throws {
    let key = attachmentDraftKey(machineId, sessionId)
    if files.isEmpty {
      try await store.remove(key)
    } else {
      try await store.set(key, encodeStored(files))
    }
  }
}
