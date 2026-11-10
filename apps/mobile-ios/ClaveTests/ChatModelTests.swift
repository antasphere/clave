import ClaveCore
import SwiftUI
import XCTest
@testable import Clave

// The chat's model driven against a server played in process: the HTTP routes the chat calls and
// the push socket, both answering from memory. Nothing here opens a connection.

/// One socket of the fake push channel: the test feeds it frames, it answers the client's.
final class FakeChatSocket: WebSocketConnection, @unchecked Sendable {
  private let lock = NSLock()
  private var queue: [WebSocketMessage] = []
  private var waiter: CheckedContinuation<WebSocketMessage, Error>?
  private var closedWith: Int?
  private weak var server: FakeChatServer?

  init(server: FakeChatServer) {
    self.server = server
  }

  func feed(_ message: WebSocketMessage) {
    lock.lock()
    if let waiter {
      self.waiter = nil
      lock.unlock()
      waiter.resume(returning: message)
    } else {
      queue.append(message)
      lock.unlock()
    }
  }

  func feed(_ text: String) { feed(.text(text)) }

  func send(_ text: String) async throws {
    if lock.withLock({ closedWith != nil }) { throw URLError(.networkConnectionLost) }
    server?.answer(text, on: self)
  }

  func receive() async throws -> WebSocketMessage {
    try await withCheckedThrowingContinuation { continuation in
      lock.lock()
      if !queue.isEmpty {
        let message = queue.removeFirst()
        lock.unlock()
        continuation.resume(returning: message)
      } else if let code = closedWith {
        lock.unlock()
        continuation.resume(returning: .closed(code: code, reason: "closed"))
      } else {
        waiter = continuation
        lock.unlock()
      }
    }
  }

  func close(code: Int) {
    lock.lock()
    closedWith = code
    let waiter = self.waiter
    self.waiter = nil
    lock.unlock()
    waiter?.resume(returning: .closed(code: code, reason: "closed"))
  }
}

/// The server one chat talks to, in memory: the timeline, the write route and its status route,
/// the capabilities, the file reader and the push channel.
final class FakeChatServer: HTTPTransport, WebSocketTransport, @unchecked Sendable {
  enum WriteAnswerScript: Sendable {
    case accept
    /// The answer never arrives: the client sees the network fail.
    case lose
    case forbid(String)
  }

  static let sessionJSON =
    #"{"id":"s1","provider":"claude","transport":"events","cwd":"/tmp/scratch","windowKey":"server","state":"idle","createdAt":1,"adapterId":"claude-chat","title":"Seeded chat"}"#

  private let lock = NSLock()
  private var items: [String] = [
    #"{"event":{"type":"user_message","text":"hello there","clientMessageId":"m-seed-1"},"at":1,"position":{"generation":"g1","sequence":1}}"#,
    #"{"event":{"type":"assistant_text","delta":"Hello, how can I help?","final":true},"at":2,"position":{"generation":"g1","sequence":2}}"#,
  ]
  private var sequence = 2
  private var writeScript: [WriteAnswerScript] = []
  private var statusScript: [String] = []
  private var _writes: [[String: Any]] = []
  private var _paths: [String] = []
  private var _sockets: [FakeChatSocket] = []

  var sockets: [FakeChatSocket] { lock.withLock { _sockets } }
  /// Every write body's `input`, in order.
  var writes: [[String: Any]] { lock.withLock { _writes } }
  /// The path of every HTTP request, in order.
  var paths: [String] { lock.withLock { _paths } }
  var timelineFetches: Int { paths.filter { $0 == "/sessions/timeline" }.count }
  var statusAsks: Int { paths.filter { $0 == "/sessions/writes" }.count }

  func scriptWrites(_ answers: WriteAnswerScript...) { lock.withLock { writeScript.append(contentsOf: answers) } }
  func scriptStatuses(_ statuses: String...) { lock.withLock { statusScript.append(contentsOf: statuses) } }

  /// The next position's stream frame of an event, as the server would push it.
  func streamFrame(_ eventJSON: String, sequence: Int) -> String {
    #"{"_tag":"stream","sessionId":"s1","stream":{"kind":"event","event":\#(eventJSON),"position":{"generation":"g1","sequence":\#(sequence)}}}"#
  }

  /// Appends an event to the timeline and pushes it on the open socket.
  @discardableResult
  func emit(_ eventJSON: String) -> String {
    let frame: String = lock.withLock {
      sequence += 1
      items.append(#"{"event":\#(eventJSON),"at":\#(sequence),"position":{"generation":"g1","sequence":\#(sequence)}}"#)
      return streamFrame(eventJSON, sequence: sequence)
    }
    sockets.last?.feed(frame)
    return frame
  }

  // MARK: HTTP

  func perform(_ request: URLRequest) async throws -> HTTPAnswer {
    let components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
    let path = components.path
    lock.withLock { _paths.append(path) }
    switch (request.httpMethod ?? "GET", path) {
    case ("GET", "/sessions/timeline"):
      let body: String = lock.withLock {
        #"{"items":[\#(items.joined(separator: ","))],"before":null,"cursor":{"generation":"g1","sequence":\#(sequence)},"truncated":false}"#
      }
      return ok(body)
    case ("POST", "/sessions/write"):
      return try write(request)
    case ("GET", "/sessions/writes"):
      let status = lock.withLock { statusScript.isEmpty ? "unknown" : statusScript.removeFirst() }
      return ok(#"{"status":"\#(status)"}"#)
    case ("GET", "/sessions/capabilities"):
      return ok(#"{"images":true}"#)
    case ("GET", "/files/read"):
      return ok(##"{"content":"# The plan","truncated":false,"size":10,"binary":false}"##)
    default:
      return HTTPAnswer(status: 404)
    }
  }

  private func write(_ request: URLRequest) throws -> HTTPAnswer {
    let body = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any] ?? [:]
    let input = body["input"] as? [String: Any] ?? [:]
    let script = lock.withLock { () -> WriteAnswerScript in
      _writes.append(input)
      return writeScript.isEmpty ? .accept : writeScript.removeFirst()
    }
    switch script {
    case .lose:
      throw URLError(.networkConnectionLost)
    case .forbid(let message):
      return HTTPAnswer(status: 403, headers: ["Content-Type": "application/json"], body: Data(#"{"message":"\#(message)"}"#.utf8))
    case .accept:
      if input["type"] as? String == "user_message" {
        let text = input["text"] as? String ?? ""
        let id = input["clientMessageId"] as? String ?? ""
        let event = #"{"type":"user_message","text":\#(jsonString(text)),"clientMessageId":"\#(id)"}"#
        emit(event)
      }
      return ok(#"{"status":"accepted"}"#)
    }
  }

  private func ok(_ body: String) -> HTTPAnswer {
    HTTPAnswer(status: 200, headers: ["Content-Type": "application/json"], body: Data(body.utf8))
  }

  private func jsonString(_ text: String) -> String {
    let data = try! JSONSerialization.data(withJSONObject: [text])
    let array = String(decoding: data, as: UTF8.self)
    return String(array.dropFirst().dropLast())
  }

  // MARK: push

  func connect(_ url: URL, headers: [String: String]) async throws -> any WebSocketConnection {
    let socket = FakeChatSocket(server: self)
    lock.withLock { _sockets.append(socket) }
    return socket
  }

  func answer(_ text: String, on socket: FakeChatSocket) {
    guard let frame = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any],
      let tag = frame["_tag"] as? String
    else { return }
    switch tag {
    case "hello":
      socket.feed(#"{"_tag":"welcome","serverId":"fake","protocol":1,"version":"1.0.0"}"#)
    case "subscribe":
      socket.feed(#"{"_tag":"subscribed","sessionId":"s1","session":\#(Self.sessionJSON)}"#)
    case "ping":
      socket.feed(#"{"_tag":"pong"}"#)
    default:
      break
    }
  }
}

/// One machine's delivery parts over a store, as `MachineConnection` makes them: every
/// conversation of the machine shares them.
struct MachineDeliveryParts {
  let delivery: DeliveryController
  let drafts: Drafts
  let attachmentDrafts: AttachmentDrafts

  init(store: any KeyValueStore) {
    drafts = Drafts(store: store)
    attachmentDrafts = AttachmentDrafts(store: store)
    delivery = DeliveryController(
      sends: UnknownSends(store: store), marks: DeliveryMarks(store: store), drafts: drafts,
      attachmentDrafts: attachmentDrafts)
  }
}

@MainActor
final class ChatModelTests: XCTestCase {
  private var server: FakeChatServer!
  private var push: PushClient!
  private var store: InMemoryKeyValueStore!
  private var parts: MachineDeliveryParts!
  private var models: [ConversationModel] = []

  private let session = Session(
    id: "s1", provider: "claude", transport: .events, cwd: "/tmp/scratch", windowKey: "server", state: .idle,
    createdAt: 1, adapterId: "claude-chat", title: "Seeded chat")

  override func setUp() async throws {
    server = FakeChatServer()
    store = InMemoryKeyValueStore()
    parts = MachineDeliveryParts(store: store)
    // A reconnection's backoff (a second at most) passes at once; the liveness timers are real
    // and far longer than any test.
    push = try PushClient(
      url: "https://fake.invalid", bearer: { "device-token" }, transport: server,
      sleep: { seconds in
        if seconds <= 1 { return }
        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
      })
  }

  override func tearDown() async throws {
    for model in models { model.disappear() }
    models = []
    await push.stop()
  }

  private func makeModel() throws -> ConversationModel {
    let client = try ClaveServerClient(baseURL: "https://fake.invalid", bearer: { "device-token" }, transport: server)
    let push: PushClient = self.push
    let model = ConversationModel(
      machineId: "m1", session: session, client: client, push: push,
      events: { TestPushFanout.shared(for: push).stream() }, delivery: parts.delivery, drafts: parts.drafts,
      attachmentDrafts: parts.attachmentDrafts)
    models.append(model)
    return model
  }

  private func until(_ what: String, timeout: TimeInterval = 5, _ condition: () -> Bool) async {
    let start = Date()
    while Date().timeIntervalSince(start) < timeout {
      if condition() { return }
      try? await Task.sleep(nanoseconds: 5_000_000)
    }
    XCTFail("Timed out waiting for \(what)")
  }

  private func texts(_ model: ConversationModel) -> [String] {
    (model.conversation?.items ?? []).compactMap { item in
      switch item {
      case .user(let turn): return "user:\(turn.text)"
      case .assistant(let turn): return "assistant:\(turn.text)"
      default: return nil
      }
    }
  }

  // MARK: - Loading

  func testAppearLoadsTheConversationInOrder() async throws {
    let model = try makeModel()
    await model.appear()
    await until("the snapshot") { model.conversation != nil }
    XCTAssertEqual(texts(model), ["user:hello there", "assistant:Hello, how can I help?"])
    XCTAssertEqual(server.timelineFetches, 1)
    XCTAssertFalse(model.truncated)
    XCTAssertFalse(model.canLoadOlder)
    await until("the capabilities") { model.capabilities != nil }
    XCTAssertEqual(model.capabilities, SessionCapabilities(images: true))
  }

  func testALiveStreamFrameAppendsOnce() async throws {
    let model = try makeModel()
    await model.appear()
    await until("the snapshot") { model.conversation?.items.count == 2 }
    let frame = server.emit(#"{"type":"assistant_text","delta":"A live answer.","final":true}"#)
    // The same position delivered twice is one event.
    server.sockets.last?.feed(frame)
    await until("the live frame") { model.conversation?.items.count == 3 }
    try? await Task.sleep(nanoseconds: 100_000_000)
    XCTAssertEqual(texts(model).last, "assistant:A live answer.")
    XCTAssertEqual(model.conversation?.items.count, 3)
  }

  func testAReconnectTakesAFreshSnapshot() async throws {
    let model = try makeModel()
    await model.appear()
    await until("the snapshot") { model.conversation != nil }
    XCTAssertEqual(server.timelineFetches, 1)
    server.sockets.last?.feed(.closed(code: 1006, reason: "gone"))
    await until("the second socket") { server.sockets.count == 2 }
    await until("a fresh snapshot") { server.timelineFetches == 2 }
    XCTAssertEqual(texts(model).count, 2)
  }

  // MARK: - Sending

  func testSendClearsTheDraftOnAccepted() async throws {
    let model = try makeModel()
    await model.appear()
    model.draft = "Please add a test."
    await model.send()
    XCTAssertEqual(model.draft, "")
    XCTAssertNil(model.sendError)
    XCTAssertNil(model.deliveryMark)
    XCTAssertEqual(server.writes.count, 1)
    XCTAssertEqual(server.writes.first?["type"] as? String, "user_message")
    XCTAssertEqual(server.writes.first?["text"] as? String, "Please add a test.")
    await until("the echo") { self.texts(model).last == "user:Please add a test." }
    await model.flushDraft()
    let stored = try await store.get(draftKey("m1", "s1"))
    XCTAssertNil(stored)
  }

  func testALostAnswerThenAbsentRetriesOnceWithTheSameId() async throws {
    let model = try makeModel()
    await model.appear()
    server.scriptWrites(.lose, .accept)
    server.scriptStatuses("absent")
    model.draft = "Lost once."
    await model.send()
    XCTAssertEqual(server.writes.count, 2)
    let ids = server.writes.compactMap { $0["clientMessageId"] as? String }
    XCTAssertEqual(ids.count, 2)
    XCTAssertEqual(ids[0], ids[1])
    XCTAssertEqual(model.draft, "")
    XCTAssertNil(model.deliveryMark)
  }

  func testALostAnswerThenUnknownSendsNothingMoreAndOffersTwoChoices() async throws {
    let model = try makeModel()
    await model.appear()
    server.scriptWrites(.lose)
    server.scriptStatuses("unknown")
    model.draft = "Did it land?"
    await model.send()
    XCTAssertEqual(server.writes.count, 1)
    XCTAssertEqual(server.statusAsks, 1)
    XCTAssertEqual(model.draft, "Did it land?")
    XCTAssertEqual(model.deliveryMark?.kind, .unknown)
    XCTAssertEqual(model.deliveryMark?.clientMessageId, server.writes.first?["clientMessageId"] as? String)
    XCTAssertNil(model.sendError)
  }

  func testResendUnderNewIdUsesANewId() async throws {
    let model = try makeModel()
    await model.appear()
    server.scriptWrites(.lose, .accept)
    server.scriptStatuses("unknown")
    model.draft = "Twice maybe."
    await model.send()
    XCTAssertEqual(model.deliveryMark?.kind, .unknown)
    await model.resendUnderNewId()
    XCTAssertEqual(server.writes.count, 2)
    let ids = server.writes.compactMap { $0["clientMessageId"] as? String }
    XCTAssertEqual(ids.count, 2)
    XCTAssertNotEqual(ids[0], ids[1])
    XCTAssertNil(model.deliveryMark)
    XCTAssertEqual(model.draft, "")
    let ledger = try await UnknownSends(store: store).list()
    XCTAssertEqual(ledger, [])
  }

  func testDiscardUnknownSendClearsTheMark() async throws {
    let model = try makeModel()
    await model.appear()
    server.scriptWrites(.lose)
    server.scriptStatuses("unknown")
    model.draft = "Forget it."
    await model.send()
    XCTAssertNotNil(model.deliveryMark)
    await model.discardUnknownSend()
    XCTAssertNil(model.deliveryMark)
    XCTAssertEqual(model.draft, "Forget it.")
    XCTAssertEqual(server.writes.count, 1)
    let ledger = try await UnknownSends(store: store).list()
    XCTAssertEqual(ledger, [])
    let mark = try await DeliveryMarks(store: store).get("m1", "s1")
    XCTAssertNil(mark)
  }

  func testAForbiddenWriteSurfacesTheServersSentenceWithOneRequest() async throws {
    let model = try makeModel()
    await model.appear()
    server.scriptWrites(.forbid("A phone may not do this."))
    model.draft = "Not allowed."
    await model.send()
    XCTAssertEqual(model.sendError, "A phone may not do this.")
    XCTAssertEqual(server.paths.filter { $0 == "/sessions/write" }.count, 1)
    XCTAssertEqual(server.statusAsks, 0)
    XCTAssertEqual(model.draft, "Not allowed.")
    XCTAssertNil(model.deliveryMark)
  }

  // MARK: - Other writes

  func testAPermissionResponseCarriesTheOptionAndTheAnswers() async throws {
    let model = try makeModel()
    await model.appear()
    server.emit(#"{"type":"permission_request","id":"p1","description":"Which theme?","options":[{"id":"answer","label":"Answer"},{"id":"cancel","label":"Skip"}],"questions":[{"id":"theme","question":"Which theme?","options":[{"label":"Dark"},{"label":"Light"}]}]}"#)
    await until("the permission card") {
      model.conversation?.items.contains { if case .permission = $0 { return true } else { return false } } ?? false
    }
    guard case .permission(let card)? = model.conversation?.items.last else { return XCTFail("no card") }
    await model.answerPermission(card, optionId: "answer", answers: ["theme": "Dark"])
    let write = try XCTUnwrap(server.writes.last)
    XCTAssertEqual(write["type"] as? String, "permission_response")
    XCTAssertEqual(write["id"] as? String, "p1")
    XCTAssertEqual(write["optionId"] as? String, "answer")
    XCTAssertEqual(write["answers"] as? [String: String], ["theme": "Dark"])
    await until("the card answered") {
      if case .permission(let card)? = model.conversation?.items.last { return card.state == .answered(optionId: "answer") }
      return false
    }
  }

  func testInterruptWritesAnInterrupt() async throws {
    let model = try makeModel()
    await model.appear()
    await model.interrupt()
    XCTAssertEqual(server.writes.last?["type"] as? String, "interrupt")
    XCTAssertNil(model.actionError)
  }

  func testOpenDocumentReadsTheFileUnderItsFolder() async throws {
    let model = try makeModel()
    let call = ToolCall(id: "t1", name: "clave_open_side_panel", input: .object(["path": .string("/Users/me/plan.md")]))
    let file = try await model.openDocument(documentCard(call))
    XCTAssertEqual(file.content, "# The plan")
  }

  // MARK: - Drafts and attachments

  func testTheDraftSurvivesAModelRebuild() async throws {
    let first = try makeModel()
    await first.appear()
    first.draft = "Half a thought"
    await first.flushDraft()
    first.disappear()
    let second = try makeModel()
    await second.appear()
    XCTAssertEqual(second.draft, "Half a thought")
  }

  func testAttachSaysWhyAFileIsRefused() async throws {
    let model = try makeModel()
    model.attach(PickedFile(uri: "file:///tmp/empty.txt", name: "empty.txt", mimeType: "text/plain", size: 0, kind: .file))
    XCTAssertEqual(model.pendingFiles, [])
    XCTAssertEqual(model.attachNotice, "empty.txt is empty and cannot be sent.")
    model.attach(PickedFile(uri: "file:///tmp/a.txt", name: "a.txt", mimeType: "text/plain", size: 3, kind: .file))
    XCTAssertEqual(model.pendingFiles.count, 1)
    model.removeFile(at: 0)
    XCTAssertEqual(model.pendingFiles, [])
  }

  // MARK: - Markdown

  func testTheMarkdownMappingOfAGFMSample() {
    let sample = """
      # Title

      Some **bold** text and `code`.

      | Name | Value |
      | ---- | ----: |
      | a | 1 |
      | b | 2 |

      ```swift
      let x = 1
      ```

      - one
      - two
        - nested
      - three
      """
    let blocks = MarkdownRenderer(theme: Theme(.dark)).render(sample)
    guard case .text(let title, let level) = blocks.first else { return XCTFail("no heading") }
    XCTAssertEqual(String(title.characters), "Title")
    XCTAssertEqual(level, 1)
    guard case .text(let paragraph, nil) = blocks[1] else { return XCTFail("no paragraph") }
    XCTAssertEqual(String(paragraph.characters), "Some bold text and code.")

    let table = blocks.compactMap { block -> (header: [AttributedString], rows: [[AttributedString]])? in
      if case .table(let header, _, let rows) = block { return (header, rows) }
      return nil
    }.first
    XCTAssertEqual(table?.header.map { String($0.characters) }, ["Name", "Value"])
    XCTAssertEqual(table?.rows.map { $0.map { String($0.characters) } }, [["a", "1"], ["b", "2"]])

    let code = blocks.compactMap { block -> (String?, String)? in
      if case .code(let language, let text) = block { return (language, String(text.characters)) }
      return nil
    }.first
    XCTAssertEqual(code?.0, "swift")
    XCTAssertEqual(code?.1, "let x = 1")

    let list = blocks.compactMap { block -> [[RenderedBlock]]? in
      if case .list(false, _, let items) = block { return items }
      return nil
    }.first
    XCTAssertEqual(list?.count, 3)
    let nested = list?[1].contains { if case .list(_, _, let items) = $0 { return items.count == 1 } else { return false } }
    XCTAssertEqual(nested, true)
  }

  func testStatusKindOfEveryAgentState() {
    XCTAssertEqual(statusKind(.idle), .ready)
    XCTAssertEqual(statusKind(.working), .working)
    XCTAssertEqual(statusKind(.blocked), .waiting)
    XCTAssertEqual(statusKind(.done), .inactive)
    XCTAssertEqual(statusKind(.ended), .inactive)
  }
}
