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

  /// Files picked for the next message, admitted by the attachment policy; kept on the device on
  /// every change, like the draft.
  private(set) var pendingFiles: [PickedFile] = [] {
    didSet {
      guard pendingFiles != oldValue, !restoringFiles else { return }
      filesTouched = true
      saveFiles(pendingFiles)
    }
  }
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
  /// was not driving it (by a reconnection, or before a choice on the bar could act), or whose
  /// record the phone lost before the person's choice. Cleared by the next edit of the draft and the
  /// next send.
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
  /// The machine's delivery parts, shared by every conversation of the machine (read by tests).
  let drafts: Drafts
  let attachmentDrafts: AttachmentDrafts
  let delivery: DeliveryController
  private let sleep: @Sendable (_ milliseconds: Double) async throws -> Void

  private var sync: TimelineSync?
  private var tasks: [Task<Void, Never>] = []
  private var draftTouched = false
  private var restoringDraft = false
  private var draftSave: Task<Void, Never>?
  private var filesTouched = false
  private var restoringFiles = false
  private var filesSave: Task<Void, Never>?
  private var dropped = false
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
    await loadFiles()
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

  /// Waits until every edit of the draft and of the picked files so far is on the device.
  func flushDraft() async {
    await draftSave?.value
    await filesSave?.value
  }

  private func loadFiles() async {
    let stored = (try? await attachmentDrafts.get(machineId, sessionId)) ?? []
    // What the person picked or removed while the read was in flight wins over what the store held.
    if !filesTouched {
      restoringFiles = true
      pendingFiles = stored
      restoringFiles = false
    }
  }

  private func saveFiles(_ files: [PickedFile]) {
    let previous = filesSave
    let attachmentDrafts = self.attachmentDrafts
    let machineId = self.machineId
    let sessionId = self.sessionId
    // Chained so the store sees the changes in the order they were made.
    filesSave = Task {
      await previous?.value
      try? await attachmentDrafts.set(machineId, sessionId, files)
    }
  }

  // MARK: - Attachments

  /// Puts picked files on the next message, each through the attachment policy; a refusal is
  /// said in the composer and the file left out.
  func attach(_ files: [PickedFile]) {
    let imagesSupported = capabilities?.images ?? false
    for file in files {
      // A picked file travels as a picture by the policy's own rule, so a list read back from the
      // device needs nothing beside it.
      let imageBytes = pendingFiles.reduce(0) { sum, picked in
        imageMimeTypes.contains(picked.mimeType) && imagesSupported ? sum + (picked.size ?? 0) : sum
      }
      let context = AdmissionContext(
        count: pendingFiles.count, imageBytes: imageBytes, imagesSupported: imagesSupported, filesRoute: filesRoute)
      switch admit(file, context) {
      case .accepted(_, let note):
        pendingFiles.append(file)
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
    pendingFiles.remove(at: index)
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
      attachments: records.isEmpty ? nil : records, files: picked.isEmpty ? nil : picked)
    // The draft must be on the device before the ledger compares against it.
    await flushDraft()
    settlingHere.insert(clientMessageId)
    do {
      try await delivery.begin(record)
    } catch is SendRecordedWithoutMark {
      // The record stays, so a pass may still complete the send: it shows as unknown, never as not
      // sent, and the draft and the files stay with it.
      carried = Carried(clientMessageId: clientMessageId, draftText: draftText, files: picked)
      await refreshMark()
      settlingHere.remove(clientMessageId)
      return
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
      // Only what was sent is cleared: text typed and files picked during the send stay, as the
      // settle left them on the device.
      let kept = draftAfterDelivery(draft, sent: draftText)
      if kept != draft { draft = kept }
      pendingFiles.removeAll { file in picked.contains { $0.uri == file.uri } }
      attachNotice = nil
    case .rejected(_, let reason), .failed(_, let reason):
      sendError = reason
    case .unknown, .writeRefused:
      // Still not known, a refused completion included: the bar shows, and what the send carried is
      // remembered for its later delivery.
      carried = Carried(clientMessageId: clientMessageId, draftText: draftText, files: picked)
    }
    await refreshMark()
    settlingHere.remove(clientMessageId)
  }

  /// What the composer says when the phone could not write the person's choice down: the choice
  /// claimed nothing, and the bar stays for it.
  static let choiceNotKept = "This phone could not keep your choice, so nothing changed."
  /// What the composer says after Discard on a send whose record the phone lost (it left the ledger
  /// while the mark still said its outcome was unknown): nothing here can tell whether it arrived,
  /// and the draft it keeps may hold a text the server already accepted.
  static let lostTrack = "This phone lost its record of this message, so it cannot tell whether it was delivered. Check the conversation before you send it again."
  /// The same after Send again on such a send: nothing was sent, under the old id or a new one.
  static let lostTrackNotSent = "This phone lost its record of this message, so it cannot tell whether it was delivered, and did not send it again. Check the conversation before you send it."
  /// The bar of a send whose record the phone kept but whose mark it could not write: shown from the
  /// record, never written.
  static let recordedWithoutMark = "This phone kept this message but could not finish recording it, so it may still be sent when the connection comes back."

  /// The person's choice on the bar's send, through the machine's controller; nil when it failed. A
  /// choice the phone could not write down is said in the composer, and the bar stays.
  private func choose(_ choice: PendingChoice, on id: String) async -> PendingResolution? {
    do {
      return try await delivery.discardPending(
        machineId: machineId, sessionId: sessionId, clientMessageId: id, choice: choice)
    } catch is ChoiceNotKept {
      sendError = Self.choiceNotKept
      return nil
    } catch {
      return nil
    }
  }

  /// The person chose to send again after an unknown outcome: a new id, which may duplicate. The
  /// first send is discarded once a pass reconciling it has let go; when that pass settled it
  /// meanwhile (it landed, or was refused), nothing is sent and the mark says what happened; when the
  /// phone lost its record of the send, nothing is sent and the composer says it cannot tell.
  func resendUnderNewId() async {
    if let mark = deliveryMark, mark.kind == .unknown {
      let id = mark.clientMessageId
      settlingHere.insert(id)
      defer { settlingHere.remove(id) }
      let resolution = await choose(.sendAgain, on: id)
      switch resolution {
      case .discarded?:
        break
      case .settledMeanwhile?:
        await resync(id)
        deliveryNotice = "This message had already been delivered, so it was not sent again."
        await refreshMark()
        return
      case .outcomeUnknown?:
        // Nobody can tell whether it arrived: nothing goes out by itself, and the draft and the
        // picked files stay for the person to check and send.
        deliveryMark = nil
        carried = nil
        deliveryNotice = Self.lostTrackNotSent
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
  /// reconciling the send finishes first; when it settled the send meanwhile, the mark says how; when
  /// the phone lost its record of the send, the bar goes and the composer says it cannot tell.
  func discardUnknownSend() async {
    guard let mark = deliveryMark else { return }
    let id = mark.clientMessageId
    settlingHere.insert(id)
    defer { settlingHere.remove(id) }
    let resolution = await choose(.discard, on: id)
    switch resolution {
    case .discarded?:
      deliveryMark = nil
      sendError = nil
    case .settledMeanwhile?:
      await resync(id)
      deliveryNotice = "This message was delivered before it could be discarded."
    case .outcomeUnknown?:
      // Not known to be delivered: the draft and the picked files stay exactly as they are.
      deliveryMark = nil
      sendError = nil
      carried = nil
      deliveryNotice = Self.lostTrack
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
    // No mark stored: a record of this conversation kept without its mark still shows as unknown.
    var current = stored
    if current == nil { current = await recordWithoutMark() }
    deliveryMark = current
    if let current, current.kind == .unknown, carried?.clientMessageId != current.clientMessageId {
      await loadCarried(current.clientMessageId)
    }
    guard let shown, shown.kind == .unknown, current == nil, !settlingHere.contains(shown.clientMessageId) else { return }
    // Gone from the ledger with its mark: discarded, delivered, or its record lost (a pass that
    // refuses a send leaves a rejected mark).
    let listed = (try? await delivery.sends.list().contains { $0.clientMessageId == shown.clientMessageId }) ?? true
    guard !listed else { return }
    // Taken out by the person's choice (here, or one an ended run left that a pass carried out):
    // nothing was delivered, and the draft and the files stay as a Discard leaves them.
    if await delivery.wasDiscarded(shown.clientMessageId) {
      carried = nil
      return
    }
    // Said delivered only when this run saw the server accept it: a mark that went otherwise
    // leaves the draft and the files as they are, and says nothing.
    guard await delivery.wasDelivered(shown.clientMessageId) else {
      carried = nil
      return
    }
    await resync(shown.clientMessageId)
    deliveryNotice = "This message was delivered when the connection came back."
  }

  /// The bar of a send this conversation's ledger holds without a mark (its mark write failed, or the
  /// process ended between the two writes): the newest such record that carries no choice and that no
  /// composer is sending, shown as unknown and never written.
  private func recordWithoutMark() async -> DeliveryMark? {
    guard let records = try? await delivery.sends.forSession(machineId, sessionId) else { return nil }
    var newest: UnknownSend?
    for record in records where record.choice == nil {
      if await delivery.isActive(record.clientMessageId) { continue }
      if let found = newest, found.at > record.at { continue }
      newest = record
    }
    guard let newest else { return nil }
    return DeliveryMark(kind: .unknown, clientMessageId: newest.clientMessageId, reason: Self.recordedWithoutMark, at: newest.at)
  }

  /// What a send of unknown outcome carried, read back from the ledger (after a restart, or for a
  /// mark this model did not set).
  private func loadCarried(_ clientMessageId: String) async {
    guard let record = try? await delivery.sends.list().first(where: { $0.clientMessageId == clientMessageId }) else { return }
    // The send's first mark wakes this read while the send is still out; a send of this model
    // that records what it carried meanwhile, its picked files with it, keeps that record.
    guard carried?.clientMessageId != clientMessageId else { return }
    carried = Carried(clientMessageId: clientMessageId, draftText: record.draftText ?? record.text, files: record.files ?? [])
  }

  /// After a send was delivered: the field keeps only what was added after the text sent, and the
  /// picked files lose the ones the send carried, so anything typed or picked since stays. Both are
  /// saved as they change, as the settle did to the stores.
  private func resync(_ clientMessageId: String) async {
    guard let sent = carried, sent.clientMessageId == clientMessageId else { return }
    let kept = draftAfterDelivery(draft, sent: sent.draftText)
    if kept != draft { draft = kept }
    let before = pendingFiles
    pendingFiles.removeAll { file in sent.files.contains { $0.uri == file.uri } }
    if pendingFiles != before, pendingFiles.isEmpty { attachNotice = nil }
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
