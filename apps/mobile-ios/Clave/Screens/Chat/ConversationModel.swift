import ClaveCore
import Foundation
import Observation

/// One open conversation: its ordered transcript, the composer's draft and files, and every write
/// the screen makes. Built from explicit parts so a test, a preview or the app shell can make one
/// without an app model. Nothing here logs a message's text: the person's words stay on the screen.
@Observable
@MainActor
final class ConversationModel {
  let machineId: String
  /// The session as last acknowledged by the server.
  private(set) var session: Session
  /// The title shown, kept apart because a rename arrives as an event, not as a new record.
  private(set) var title: String

  /// What the transcript shows.
  private(set) var state: TimelineState = .loading
  /// The last conversation a snapshot or a live frame produced; kept while a refresh is in flight.
  private(set) var conversation: Conversation?
  /// Retention dropped earlier events: this is recent history only.
  private(set) var truncated = false
  /// A page of the past exists and none is being read.
  private(set) var canLoadOlder = false
  private(set) var loadingOlder = false
  /// Loaded once per model; nil until it answered (pictures then travel as files).
  private(set) var capabilities: SessionCapabilities?

  /// The composer's text, kept on the device on every edit.
  var draft: String = "" {
    didSet {
      guard draft != oldValue, !restoringDraft else { return }
      draftTouched = true
      deliveryNotice = nil
      saveDraft(draft)
    }
  }

  /// Files picked for the next message, admitted by the attachment policy.
  private(set) var pendingFiles: [PickedFile] = []
  /// What the composer says about the last pick: a refusal, or how a file will travel.
  private(set) var attachNotice: String?
  /// What the composer shows above a draft whose last send did not land.
  private(set) var deliveryMark: DeliveryMark?
  private(set) var sending = false
  /// The sentence of the last send that did not land (rejected or failed).
  private(set) var sendError: String?
  /// The sentence of the last other write that failed (an answer, an interrupt, an older page).
  private(set) var actionError: String?
  /// What the composer says about a send of unknown outcome that was delivered while the person
  /// was not driving it: by a reconnection, or before a choice on the bar could act. Cleared by the
  /// next edit of the draft and the next send.
  private(set) var deliveryNotice: String?

  /// Whether the machine's server takes files from the phone. The Mac app's own server has no
  /// files route; until the machine list says which kind of server this is, a refusal from the
  /// server itself is what tells.
  var filesRoute = true

  private let client: ClaveServerClient
  /// The push client, for the subscriptions and the socket's start; its frames come through `events`.
  private let push: PushClient
  /// A fresh stream of the push channel's frames. The client's own stream has one reader, the
  /// machine's connection, which fans the frames out to every screen that asks.
  private let events: @MainActor () -> AsyncStream<PushEvent>
  private let now: @Sendable () -> Date
  private let drafts: Drafts
  private let attachmentDrafts: AttachmentDrafts
  private let delivery: DeliveryController
  private let sleep: @Sendable (_ milliseconds: Double) async throws -> Void

  private var sync: TimelineSync?
  private var tasks: [Task<Void, Never>] = []
  private var draftTouched = false
  private var restoringDraft = false
  private var draftSave: Task<Void, Never>?
  private var dropped = false
  private var pickedImages: [String: Bool] = [:]
  /// What the send of unknown outcome the bar names carried, so its later delivery clears only that.
  private var carried: Carried?
  /// The sends this model is settling itself right now (its own send, a choice on the bar): a mark
  /// that changes for one of them is not news from a pass.
  private var settlingHere: Set<String> = []
  private var markRefresh: Task<Void, Never>?

  private struct Carried: Equatable {
    let clientMessageId: String
    /// The draft as the person left it when it was sent.
    let draftText: String
    let files: [PickedFile]
  }

  /// A conversation over its machine's delivery parts: the one controller, drafts and attachment
  /// drafts every conversation of the machine shares, so a reconnection pass knows each send a
  /// composer is driving and the person's choices wait for a pass reconciling the same send.
  init(
    machineId: String,
    session: Session,
    client: ClaveServerClient,
    push: PushClient,
    events: @escaping @MainActor () -> AsyncStream<PushEvent>,
    delivery: DeliveryController,
    drafts: Drafts,
    attachmentDrafts: AttachmentDrafts,
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.machineId = machineId
    self.session = session
    self.title = session.title
    self.client = client
    self.push = push
    self.events = events
    self.now = now
    self.drafts = drafts
    self.attachmentDrafts = attachmentDrafts
    self.delivery = delivery
    sleep = { try await Task.sleep(nanoseconds: UInt64(max(0, $0) * 1_000_000)) }
  }

  private var sessionId: String { session.id }
  private var milliseconds: Double { now().timeIntervalSince1970 * 1000 }

  /// The agent's state as the transcript last said it, else as the session record said it.
  var agentState: AgentState { conversation?.state ?? session.state }

  /// Whether a send has anything to carry and may go. Never while a send's outcome is unknown: the
  /// person chooses on the bar first (send again, or discard).
  var canSend: Bool {
    !sending && deliveryMark?.kind != .unknown
      && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingFiles.isEmpty)
  }

  /// The sentence the composer shows for a send that did not land, a stored rejection included.
  var sendNotice: String? {
    if let sendError { return sendError }
    if let deliveryMark, deliveryMark.kind == .rejected { return deliveryMark.reason }
    return nil
  }

  // MARK: - Lifecycle

  /// Loads the draft and the delivery mark, starts listening, and waits for the first snapshot.
  func appear() async {
    guard sync == nil else { return }
    let sessionId = self.sessionId
    let client = self.client
    let push = self.push
    let milliseconds: @Sendable () -> Double = { [now] in now().timeIntervalSince1970 * 1000 }
    let sync = TimelineSync(
      fetchTimeline: { before, limit in try await client.sessions.timeline(sessionId, before: before, limit: limit) },
      subscribe: { _ = try await push.subscribe(sessionId) },
      unsubscribe: { await push.unsubscribe(sessionId) },
      now: milliseconds)
    self.sync = sync
    dropped = false

    // Subscribed before the socket opens, so the first frame of the first socket is heard.
    let events = self.events()
    let states = await sync.states()
    let marks = await delivery.marks.changes()
    tasks.append(Task { [weak self] in
      for await event in events {
        guard let self else { return }
        await self.handle(event, sync: sync)
      }
    })
    tasks.append(Task { [weak self] in
      for await state in states {
        guard let self else { return }
        self.publish(state)
      }
    })
    // Any conversation's pass may settle this conversation's send: every change of a mark is read
    // again here, and the refresh tells this conversation's own from the others'.
    tasks.append(Task { [weak self] in
      for await _ in marks {
        guard let self else { return }
        await self.refreshMark()
      }
    })

    await loadDraft()
    await refreshMark()
    await push.start()
    if capabilities == nil {
      tasks.append(Task { [weak self] in await self?.loadCapabilities() })
    }
    await sync.start()
  }

  /// Stops listening; the draft and the ledger stay on the device.
  func disappear() {
    for task in tasks { task.cancel() }
    tasks = []
    if let sync {
      self.sync = nil
      Task { await sync.close() }
    }
  }

  private func handle(_ event: PushEvent, sync: TimelineSync) async {
    switch event {
    case .stream(let id, let stream) where id == sessionId:
      await sync.receive(stream)
    case .exit(let id, let code) where id == sessionId:
      await sync.exit(code)
    case .subscribed(let id, let record) where id == sessionId:
      session = record
      title = record.title
    case .event(let envelope):
      switch envelope.event {
      case .sessionTitleChanged(let id, let next) where id == sessionId: title = next
      case .sessionRenamed(let id, let next) where id == sessionId: title = next
      default: break
      }
    case .disconnected:
      // The push client reopens the socket by itself; the transcript stays as it was meanwhile.
      dropped = true
    case .welcome:
      guard dropped else { return }
      dropped = false
      // Not awaited here: frames that arrive during the fresh snapshot must reach the sync,
      // which buffers them for it.
      Task { [weak self] in
        await sync.reconnect()
        await self?.reconcileAfterReconnect()
      }
    case .revoked, .unauthorized:
      actionError = "This phone is no longer allowed on this machine. Pair it again from the Machines screen."
    default:
      break
    }
  }

  private func publish(_ next: TimelineState) {
    state = next
    switch next {
    case .ready(let conversation, let cursor, let truncated):
      self.conversation = conversation
      self.truncated = truncated
      canLoadOlder = shouldLoadOlder(cursor)
      loadingOlder = cursor.loading
    case .loading, .failed:
      break
    }
  }

  private func loadCapabilities() async {
    do {
      capabilities = try await client.sessions.capabilities(sessionId)
    } catch {
      // An older server without the route: pictures travel as files, which the policy says.
      capabilities = nil
    }
  }

  // MARK: - Draft

  private func loadDraft() async {
    let stored = (try? await drafts.get(machineId, sessionId)) ?? ""
    // What the person typed while the read was in flight wins over what the store held.
    if !draftTouched {
      restoringDraft = true
      draft = stored
      restoringDraft = false
    }
  }

  private func saveDraft(_ text: String) {
    let previous = draftSave
    let drafts = self.drafts
    let machineId = self.machineId
    let sessionId = self.sessionId
    // Chained so the store sees the edits in the order they were made.
    draftSave = Task {
      await previous?.value
      try? await drafts.set(machineId, sessionId, text)
    }
  }

  /// Waits until every draft edit so far is on the device.
  func flushDraft() async {
    await draftSave?.value
  }

  // MARK: - Attachments

  /// Puts picked files on the next message, each through the attachment policy; a refusal is
  /// said in the composer and the file left out.
  func attach(_ files: [PickedFile]) {
    for file in files {
      let imageBytes = pendingFiles.reduce(0) { sum, picked in
        pickedImages[picked.uri] == true ? sum + (picked.size ?? 0) : sum
      }
      let context = AdmissionContext(
        count: pendingFiles.count, imageBytes: imageBytes,
        imagesSupported: capabilities?.images ?? false, filesRoute: filesRoute)
      switch admit(file, context) {
      case .accepted(let image, let note):
        pendingFiles.append(file)
        pickedImages[file.uri] = image
        attachNotice = note
      case .refused(let reason):
        attachNotice = reason
      }
    }
  }

  func attach(_ file: PickedFile) { attach([file]) }

  /// Takes a picked file off the next message.
  func removeFile(at index: Int) {
    guard pendingFiles.indices.contains(index) else { return }
    let removed = pendingFiles.remove(at: index)
    pickedImages.removeValue(forKey: removed.uri)
    attachNotice = nil
  }

  // MARK: - Sending

  /// Sends the draft and the picked files under a new id, applying the send table when the
  /// answer is lost. While a send's outcome is unknown it sends nothing: a second message would
  /// leave the first in the ledger, and the next reconnection would deliver it again by itself.
  func send() async {
    guard canSend else { return }
    // The check above and this set must stay with no suspension point between them: canSend
    // includes !sending, so a second send() that runs at any later suspension of this one returns
    // at the guard before it mints an id. An await in between would let both mint and write.
    sending = true
    sendError = nil
    deliveryNotice = nil
    defer { sending = false }
    // The stored mark, which the one in memory may not have caught up with yet. It is shown, and
    // only the person's choice on the bar takes it away; nothing is discarded here.
    if let stored = try? await delivery.marks.get(machineId, sessionId), stored.kind == .unknown {
      deliveryMark = stored
      if carried?.clientMessageId != stored.clientMessageId { await loadCarried(stored.clientMessageId) }
      return
    }
    let picked = pendingFiles

    let sessionId = self.sessionId
    let client = self.client
    var records: [Attachment] = []
    for file in pendingFiles {
      let result = await prepareAttachment(
        file, sessionId: sessionId, current: records,
        readBase64: { uri in try readPickedFile(uri).base64EncodedString() },
        prepareUpload: { sessionId, name, base64, image in
          try await client.files.prepareAttachment(
            PrepareFileAttachmentInput(sessionId: sessionId, source: .upload(name: name, base64: base64, image: image)))
        },
        imagesSupported: capabilities?.images ?? false,
        filesRoute: filesRoute)
      switch result {
      case .prepared(let record, _):
        records.append(.file(record))
      case .refused(let reason):
        sendError = reason
        return
      }
    }

    let draftText = draft
    let clientMessageId = mintClientMessageId()
    let message: UserMessage
    do {
      message = try buildUserMessage(
        draftText.trimmingCharacters(in: .whitespacesAndNewlines), records, clientMessageId: clientMessageId)
    } catch {
      sendError = String(describing: error)
      return
    }
    let record = UnknownSend(
      machineId: machineId, sessionId: sessionId, clientMessageId: clientMessageId, text: message.text,
      at: milliseconds, draftText: draftText == message.text ? nil : draftText,
      attachments: records.isEmpty ? nil : records)
    // The draft must be on the device before the ledger compares against it.
    await flushDraft()
    settlingHere.insert(clientMessageId)
    do {
      try await delivery.begin(record)
    } catch {
      settlingHere.remove(clientMessageId)
      sendError = "This phone could not keep a record of the message, so it was not sent."
      return
    }

    let ports = SendPorts(
      write: { _ in try await client.sessions.write(sessionId, .userMessage(message)) },
      status: { id in try await client.sessions.writeStatus(sessionId, clientMessageId: id) },
      sleep: sleep,
      now: { [now] in now().timeIntervalSince1970 * 1000 })
    let outcome = await sendMessage(clientMessageId, ports: ports)
    try? await delivery.finish(record, outcome)

    switch outcome {
    case .sent:
      // Only what was sent is cleared: text typed during the send stays.
      if draft == draftText { draft = "" }
      pendingFiles = []
      pickedImages = [:]
      attachNotice = nil
    case .rejected(_, let reason), .failed(_, let reason):
      sendError = reason
    case .unknown:
      carried = Carried(clientMessageId: clientMessageId, draftText: draftText, files: picked)
    }
    await refreshMark()
    settlingHere.remove(clientMessageId)
  }

  /// The person chose to send again after an unknown outcome: a new id, which may duplicate. The
  /// first send is discarded once a pass reconciling it has let go; when that pass settled it
  /// meanwhile (it landed, or was refused), nothing is sent and the mark says what happened.
  func resendUnderNewId() async {
    if let mark = deliveryMark, mark.kind == .unknown {
      let id = mark.clientMessageId
      settlingHere.insert(id)
      defer { settlingHere.remove(id) }
      let resolution = try? await delivery.discardPending(
        machineId: machineId, sessionId: sessionId, clientMessageId: id, choice: .sendAgain)
      switch resolution {
      case .discarded?:
        break
      case .settledMeanwhile?:
        await resync(id)
        deliveryNotice = "This message had already been delivered, so it was not sent again."
        await refreshMark()
        return
      case nil:
        await refreshMark()
        return
      }
    }
    deliveryMark = nil
    await send()
  }

  /// The person chose to give up on a send of unknown outcome; the draft stays to edit. A pass
  /// reconciling the send finishes first; when it settled the send meanwhile, the mark says how.
  func discardUnknownSend() async {
    guard let mark = deliveryMark else { return }
    let id = mark.clientMessageId
    settlingHere.insert(id)
    defer { settlingHere.remove(id) }
    let resolution = try? await delivery.discardPending(
      machineId: machineId, sessionId: sessionId, clientMessageId: id, choice: .discard)
    switch resolution {
    case .discarded?:
      deliveryMark = nil
      sendError = nil
    case .settledMeanwhile?:
      await resync(id)
      deliveryNotice = "This message was delivered before it could be discarded."
    case nil:
      break
    }
    await refreshMark()
  }

  /// Reads the conversation's mark again, one read at a time and in order. When the bar named a
  /// send of unknown outcome and a pass this model did not drive delivered it, the composer follows
  /// the stores and says so.
  private func refreshMark() async {
    let previous = markRefresh
    let refresh = Task { [weak self] in
      await previous?.value
      await self?.readMark()
    }
    markRefresh = refresh
    await refresh.value
  }

  private func readMark() async {
    let shown = deliveryMark
    let stored = try? await delivery.marks.get(machineId, sessionId)
    deliveryMark = stored
    if let stored, stored.kind == .unknown, carried?.clientMessageId != stored.clientMessageId {
      await loadCarried(stored.clientMessageId)
    }
    guard let shown, shown.kind == .unknown, stored == nil, !settlingHere.contains(shown.clientMessageId) else { return }
    // Gone from the ledger with its mark: delivered (a discard is this model's own act, and a pass
    // that refuses a send leaves a rejected mark).
    let listed = (try? await delivery.sends.list().contains { $0.clientMessageId == shown.clientMessageId }) ?? true
    guard !listed else { return }
    await resync(shown.clientMessageId)
    deliveryNotice = "This message was delivered when the connection came back."
  }

  /// What a send of unknown outcome carried, read back from the ledger (after a restart, or for a
  /// mark this model did not set).
  private func loadCarried(_ clientMessageId: String) async {
    guard let record = try? await delivery.sends.list().first(where: { $0.clientMessageId == clientMessageId }) else { return }
    carried = Carried(clientMessageId: clientMessageId, draftText: record.draftText ?? record.text, files: [])
  }

  /// After a send was delivered: the field and the picked files follow the stores, which the
  /// settle cleared when they still held what was sent. Either is cleared here only when the store
  /// is empty and it still equals what the send carried, so anything typed or picked since stays,
  /// and a draft the settle kept is never cleared.
  private func resync(_ clientMessageId: String) async {
    let storedDraft = (try? await drafts.get(machineId, sessionId)) ?? ""
    let storedFiles = (try? await attachmentDrafts.get(machineId, sessionId)) ?? []
    guard let sent = carried, sent.clientMessageId == clientMessageId else { return }
    if storedDraft.isEmpty, !draft.isEmpty, draft == sent.draftText {
      draft = ""
    }
    if storedFiles.isEmpty, !pendingFiles.isEmpty, pendingFiles == sent.files {
      pendingFiles = []
      pickedImages = [:]
      attachNotice = nil
    }
    carried = nil
  }

  private func reconcileAfterReconnect() async {
    let client = self.client
    try? await delivery.reconnect(
      machineId: machineId,
      openConversations: [],
      status: { send in try await client.sessions.writeStatus(send.sessionId, clientMessageId: send.clientMessageId) },
      write: { send in
        try await client.sessions.write(
          send.sessionId,
          .userMessage(UserMessage(clientMessageId: send.clientMessageId, text: send.text, attachments: send.attachments)))
      },
      // The open conversation took its own fresh snapshot; the requests are the inbox's to refresh.
      refreshRequests: { _ in },
      refreshHistory: { _, _ in },
      sleep: sleep)
    // The pass may have delivered this conversation's send: the mark, the field and the picked
    // files follow the stores through the one refresh the marks listener runs too.
    await refreshMark()
  }

  // MARK: - Other writes

  /// Answers a permission card from here: the option, and the questions' answers when it asked any.
  func answerPermission(_ card: PermissionCard, optionId: String, answers: [String: String]?) async {
    actionError = nil
    do {
      _ = try await client.sessions.write(
        sessionId, .permissionResponse(PermissionResponse(id: card.request.id, optionId: optionId, answers: answers)))
      await sync?.apply(.permissionAnswered(id: card.request.id, optionId: optionId, answers: answers))
    } catch {
      actionError = sentence(error)
    }
  }

  /// Asks the agent to stop the turn it is on.
  func interrupt() async {
    actionError = nil
    do {
      _ = try await client.sessions.write(sessionId, .interrupt)
    } catch {
      actionError = sentence(error)
    }
  }

  /// Reads the page before the oldest one shown.
  func loadOlder() async {
    actionError = nil
    do {
      try await sync?.loadOlder()
    } catch {
      actionError = sentence(error)
    }
  }

  /// The text of a document the agent presented, read from the Mac.
  func openDocument(_ card: DocumentCard) async throws -> FileText {
    guard let path = card.path, let root = card.root else {
      throw ServerError(.protocol, "This document names no file to read.")
    }
    return try await client.files.read(root: root, path: path)
  }

  func dismissActionError() { actionError = nil }

  private func sentence(_ error: Error) -> String {
    if let error = error as? ServerError { return error.message }
    return String(describing: error)
  }
}

/// The bytes of a picked file the composer copied into the app's own folder.
nonisolated func readPickedFile(_ uri: String) throws -> Data {
  guard let url = URL(string: uri), url.isFileURL else {
    throw CocoaError(.fileReadInvalidFileName)
  }
  return try Data(contentsOf: url)
}
