import Foundation

// What the phone keeps about sends whose outcome it never saw, ported from
// the prototype's `apps/mobile/src/reconnect/ledger.ts`: the id the phone
// minted, the session, and the text sent under it, so a reconnection asks
// the server about exactly that id and, when the server says it never
// arrived, completes the same send with the same bytes. Beside it, one
// delivery mark per conversation says what the composer shows above the
// draft. Both live in the key-value store, so they survive a restart as the
// drafts do.

/// A send whose outcome the phone has not seen.
public struct UnknownSend: Codable, Sendable, Equatable {
  public let machineId: String
  public let sessionId: String
  public let clientMessageId: String
  /// The text as sent, so a resend the server asks for is the same bytes.
  public let text: String
  /// Epoch milliseconds.
  public let at: Double
  /// The draft as the person left it (untrimmed), when it differs from the text sent.
  public let draftText: String?
  public let attachments: [Attachment]?
  /// The files the person picked for the message, so a delivery takes exactly these off the
  /// composer's attachment draft and files picked since stay.
  public let files: [PickedFile]?
  /// The person's choice on the bar (discard, send again), written before anything waits for the
  /// send, so a choice whose action ended before it could take the send out is still found.
  public let choice: PendingChoice?

  public init(
    machineId: String, sessionId: String, clientMessageId: String, text: String, at: Double, draftText: String? = nil,
    attachments: [Attachment]? = nil, files: [PickedFile]? = nil, choice: PendingChoice? = nil
  ) {
    self.machineId = machineId
    self.sessionId = sessionId
    self.clientMessageId = clientMessageId
    self.text = text
    self.at = at
    self.draftText = draftText
    self.attachments = attachments
    self.files = files
    self.choice = choice
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    machineId = try c.decodeString("machineId")
    sessionId = try c.decodeString("sessionId")
    clientMessageId = try c.decodeString("clientMessageId")
    text = try c.decodeString("text")
    // A record without a readable time is still a send to ask about.
    at = (try? c.decodeIfPresent("at", Double.self)) ?? 0
    draftText = try? c.decodeIfPresent("draftText", String.self)
    attachments = try? c.decodeIfPresent("attachments", [Attachment].self)
    files = try? c.decodeIfPresent("files", [PickedFile].self)
    // A choice this build cannot read is no choice: the send is asked about as before.
    choice = try? c.decodeIfPresent("choice", PendingChoice.self)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(machineId, key: "machineId")
    try c.encode(sessionId, key: "sessionId")
    try c.encode(clientMessageId, key: "clientMessageId")
    try c.encode(text, key: "text")
    try c.encode(at, key: "at")
    try c.encodeIfPresent(draftText, key: "draftText")
    try c.encodeIfPresent(attachments, key: "attachments")
    try c.encodeIfPresent(files, key: "files")
    try c.encodeIfPresent(choice, key: "choice")
  }

  /// The same send with the person's choice on it.
  public func with(choice: PendingChoice?) -> UnknownSend {
    UnknownSend(
      machineId: machineId, sessionId: sessionId, clientMessageId: clientMessageId, text: text, at: at,
      draftText: draftText, attachments: attachments, files: files, choice: choice)
  }
}

/// A list element that decodes to nil instead of failing the whole list.
struct Lenient<T: Decodable>: Decodable {
  let value: T?
  init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

func encodeStored<T: Encodable>(_ value: T) throws -> String {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
  return String(decoding: try encoder.encode(value), as: UTF8.self)
}

/// Runs bodies one after another, each started only once the previous one ended, so two
/// read-modify-writes never interleave across the store's suspension points.
struct SerialQueue {
  private var tail: Task<Void, Never>?

  mutating func enqueue<T: Sendable>(_ body: @escaping @Sendable () async throws -> T) -> Task<T, Error> {
    let previous = tail
    let task = Task<T, Error> {
      await previous?.value
      return try await body()
    }
    tail = Task { _ = await task.result }
    return task
  }
}

/// One machine's ledger of sends of unknown outcome: one JSON list under
/// "clave.unknown-sends:<machineId>". Its writes are serialized, and two machines' ledgers are two
/// keys, so the ledgers that two machines' connections build never rewrite one list.
public actor UnknownSends {
  /// The store key a machine's list lives under.
  public static func key(for machineId: String) -> String { "clave.unknown-sends:\(machineId)" }

  /// The machine whose sends this ledger keeps.
  public nonisolated let machineId: String
  private let store: any KeyValueStore
  private var queue = SerialQueue()

  /// The ledger of `machineId` over `store` (an owner-scoped store keeps two owners' ledgers apart).
  public init(store: any KeyValueStore, machineId: String) {
    self.store = store
    self.machineId = machineId
  }

  private var key: String { Self.key(for: machineId) }

  /// Every send in this machine's ledger; an unreadable list is an empty one.
  public func list() async throws -> [UnknownSend] {
    guard let raw = try await store.get(key) else { return [] }
    return decodeLedger(raw)
  }

  /// The sends of one machine.
  public func forMachine(_ machineId: String) async throws -> [UnknownSend] {
    try await list().filter { $0.machineId == machineId }
  }

  /// The sends of one conversation.
  public func forSession(_ machineId: String, _ sessionId: String) async throws -> [UnknownSend] {
    try await list().filter { $0.machineId == machineId && $0.sessionId == sessionId }
  }

  /// Keeps the send, replacing one of the same id.
  public func add(_ send: UnknownSend) async throws {
    try await queue.enqueue { [self] in
      let others = try await list().filter { $0.clientMessageId != send.clientMessageId }
      try await write(others + [send])
    }.value
  }

  /// Takes the send of this id out of the ledger.
  public func remove(_ clientMessageId: String) async throws {
    try await queue.enqueue { [self] in
      try await write(list().filter { $0.clientMessageId != clientMessageId })
    }.value
  }

  /// Writes the person's choice into the record of this id, in its place in the list; false, with
  /// nothing written, when the ledger holds no send of this id.
  @discardableResult
  public func recordChoice(_ clientMessageId: String, _ choice: PendingChoice) async throws -> Bool {
    try await queue.enqueue { [self] in
      var sends = try await list()
      guard let index = sends.firstIndex(where: { $0.clientMessageId == clientMessageId }) else { return false }
      sends[index] = sends[index].with(choice: choice)
      try await write(sends)
      return true
    }.value
  }

  /// Keeps each of `sends` whose id the ledger does not hold yet; one the ledger holds stays as it
  /// is.
  func addMissing(_ sends: [UnknownSend]) async throws {
    try await queue.enqueue { [self] in
      let current = try await list()
      let missing = sends.filter { send in !current.contains { $0.clientMessageId == send.clientMessageId } }
      if !missing.isEmpty { try await write(current + missing) }
    }.value
  }

  private func write(_ sends: [UnknownSend]) async throws {
    if sends.isEmpty {
      try await store.remove(key)
    } else {
      try await store.set(key, encodeStored(sends))
    }
  }
}

/// A ledger list as stored; an unreadable list is an empty one, an unreadable record is left out.
private func decodeLedger(_ raw: String) -> [UnknownSend] {
  guard !raw.isEmpty, let parsed = try? JSONDecoder().decode([Lenient<UnknownSend>].self, from: Data(raw.utf8)) else { return [] }
  return parsed.compactMap(\.value)
}

/// The key every machine of an owner kept its sends of unknown outcome under, in one list, before
/// each machine had a ledger of its own.
public let legacyUnknownSendsKey = "clave.unknown-sends"

/// Moves the records of the list every machine of an owner once shared to their machine's own
/// ledger: each record under its machine's key unless a record of its id is already there, none
/// copied to another machine and none dropped, then the old list removed. Run once per owner store
/// before its first connection, while nothing else writes these ledgers; once the old list is gone,
/// a run changes nothing.
public func migrateLegacyUnknownSends(_ store: any KeyValueStore) async throws {
  guard let raw = try await store.get(legacyUnknownSendsKey) else { return }
  var machines: [String] = []
  var records: [String: [UnknownSend]] = [:]
  for record in decodeLedger(raw) {
    if records[record.machineId] == nil { machines.append(record.machineId) }
    records[record.machineId, default: []].append(record)
  }
  for machineId in machines {
    try await UnknownSends(store: store, machineId: machineId).addMissing(records[machineId] ?? [])
  }
  try await store.remove(legacyUnknownSendsKey)
}

/// What the composer shows above a draft whose last send did not land.
public struct DeliveryMark: Codable, Sendable, Equatable {
  public enum Kind: String, Codable, Sendable {
    case unknown, rejected
  }

  public let kind: Kind
  public let clientMessageId: String
  public let reason: String
  /// Epoch milliseconds.
  public let at: Double

  public init(kind: Kind, clientMessageId: String, reason: String, at: Double) {
    self.kind = kind
    self.clientMessageId = clientMessageId
    self.reason = reason
    self.at = at
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    kind = try c.decodeValue("kind", Kind.self)
    clientMessageId = try c.decodeString("clientMessageId")
    reason = (try? c.decodeIfPresent("reason", String.self)) ?? ""
    at = (try? c.decodeIfPresent("at", Double.self)) ?? 0
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(kind, key: "kind")
    try c.encode(clientMessageId, key: "clientMessageId")
    try c.encode(reason, key: "reason")
    try c.encode(at, key: "at")
  }
}

/// The store key of a conversation's delivery mark.
public func deliveryMarkKey(_ machineId: String, _ sessionId: String) -> String {
  "clave.delivery:\(machineId):\(sessionId)"
}

/// One delivery mark per conversation, with a stream that says when any of them changed.
public actor DeliveryMarks {
  private let store: any KeyValueStore
  private var listeners: [UUID: AsyncStream<Void>.Continuation] = [:]

  /// The marks over `store`.
  public init(store: any KeyValueStore) {
    self.store = store
  }

  /// The conversation's mark; an unreadable one is no mark.
  public func get(_ machineId: String, _ sessionId: String) async throws -> DeliveryMark? {
    guard let raw = try await store.get(deliveryMarkKey(machineId, sessionId)) else { return nil }
    return try? JSONDecoder().decode(DeliveryMark.self, from: Data(raw.utf8))
  }

  /// Sets the conversation's mark.
  public func set(_ machineId: String, _ sessionId: String, _ mark: DeliveryMark) async throws {
    try await store.set(deliveryMarkKey(machineId, sessionId), encodeStored(mark))
    changed()
  }

  /// Clears the conversation's mark.
  public func clear(_ machineId: String, _ sessionId: String) async throws {
    try await store.remove(deliveryMarkKey(machineId, sessionId))
    changed()
  }

  /// A stream that yields once per change of any mark, until the consumer stops reading.
  public func changes() -> AsyncStream<Void> {
    let (stream, continuation) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
    let id = UUID()
    listeners[id] = continuation
    continuation.onTermination = { [weak self] _ in
      Task { await self?.drop(id) }
    }
    return stream
  }

  private func drop(_ id: UUID) { listeners.removeValue(forKey: id) }

  private func changed() {
    for continuation in listeners.values { continuation.yield(()) }
  }
}
