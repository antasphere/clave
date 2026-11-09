import Foundation

// The composer's drafts, ported from the prototype's `apps/mobile/src/chat/drafts.ts`
// and `attachments/drafts.ts`: one text draft and one list of prepared
// attachments per session per machine, kept on the device until sent,
// through a restart and through being offline, never sent by themselves.

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

/// The attachments prepared for a conversation's next message, one JSON list per machine and session.
public actor AttachmentDrafts {
  private let store: any KeyValueStore

  /// The attachment drafts over `store`.
  public init(store: any KeyValueStore) {
    self.store = store
  }

  /// The prepared attachments; an unreadable list is an empty one.
  public func get(_ machineId: String, _ sessionId: String) async throws -> [Attachment] {
    guard let raw = try await store.get(attachmentDraftKey(machineId, sessionId)) else { return [] }
    return (try? JSONDecoder().decode([Attachment].self, from: Data(raw.utf8))) ?? []
  }

  /// Keeps the list; an empty list removes it.
  public func set(_ machineId: String, _ sessionId: String, _ attachments: [Attachment]) async throws {
    let key = attachmentDraftKey(machineId, sessionId)
    if attachments.isEmpty {
      try await store.remove(key)
    } else {
      try await store.set(key, encodeStored(attachments))
    }
  }

  /// Removes the list.
  public func clear(_ machineId: String, _ sessionId: String) async throws {
    try await store.remove(attachmentDraftKey(machineId, sessionId))
  }

  /// Removes the list only when it is still the one a send carried, so files attached since stay.
  public func clearIfUnchanged(_ machineId: String, _ sessionId: String, sent: [Attachment]) async throws {
    let key = attachmentDraftKey(machineId, sessionId)
    guard let raw = try await store.get(key) else { return }
    let current = (try? JSONDecoder().decode([Attachment].self, from: Data(raw.utf8))) ?? []
    if current == sent { try await store.remove(key) }
  }
}
