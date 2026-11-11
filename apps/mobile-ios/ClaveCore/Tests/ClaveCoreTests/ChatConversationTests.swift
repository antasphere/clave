import XCTest
@testable import ClaveCore

final class ChatConversationTests: XCTestCase {
  func testNeverReopensAWithdrawnRequestWhenADifferentRequestBlocks() {
    let c = play([
      permissionEvent("old", description: "Old"),
      .permissionWithdrawn(id: "old"),
      .stateChange(.working),
      permissionEvent("new", description: "Old"),
      .stateChange(.blocked),
    ])
    XCTAssertEqual(card(c.items[0])?.state, .withdrawn)
    XCTAssertEqual(card(c.items[1])?.request.id, "new")
    XCTAssertEqual(c.items.compactMap { card($0) }.filter(\.isOpen).count, 1)
    XCTAssertEqual(c.state, .blocked)
  }

  func testKeepsSubagentMessagesTextAndResultsOutOfTheMainConversation() {
    let c = play([
      .userMessage(UserMessage(text: "main")),
      .userMessage(UserMessage(text: "brief", parent: "p")),
      .assistantText(delta: "nested", final: true, parent: "p"),
      .toolResult(id: "nested", output: .string("private"), error: nil, parent: "p"),
      .assistantText(delta: "answer", final: true, parent: nil),
    ])
    XCTAssertEqual(kinds(c.items), ["user", "assistant"])
    guard case .assistant(let answer) = c.items[1] else { return XCTFail() }
    XCTAssertEqual(answer.text, "answer")
  }

  func testJoinsAssistantDeltasUntilFinalAndTheClosingFrameClosesTheOpenAnswer() {
    let c = play([
      .assistantText(delta: "Hel", final: false, parent: nil),
      .assistantText(delta: "lo", final: false, parent: nil),
      .toolCall(id: "t", name: "Read", input: json([:]), parent: nil),
      .assistantText(delta: "", final: true, parent: nil),
    ])
    XCTAssertEqual(kinds(c.items), ["assistant", "tool"])
    guard case .assistant(let answer) = c.items[0] else { return XCTFail() }
    XCTAssertEqual(answer.text, "Hello")
    XCTAssertTrue(answer.final)
  }

  func testPairsAToolCallWithItsResultByIdTheFailureFlagCarried() {
    let c = play([
      .toolCall(id: "t1", name: "Bash", input: json(["command": .string("ls")]), parent: nil),
      .toolCall(id: "t2", name: "Read", input: json(["path": .string("/x")]), parent: nil),
      .toolResult(id: "t1", output: .string("a b"), error: true, parent: nil),
      .toolResult(id: "t2", output: .string("text"), error: nil, parent: nil),
    ])
    XCTAssertEqual(c.items.count, 2)
    let first = c.items[0].toolCall
    XCTAssertEqual(first?.id, "t1")
    XCTAssertEqual(first?.complete, true)
    XCTAssertEqual(first?.failed, true)
    XCTAssertEqual(first?.output, .string("a b"))
    XCTAssertEqual(c.items[1].toolCall?.complete, true)
    XCTAssertNil(c.items[1].toolCall?.failed)
  }

  func testAPermissionBlocksTheAnswerUnblocksTheKernelsWordClosesACard() {
    let request = permissionEvent("r1", description: "Run?", options: [PermissionOption(id: "allow-once", label: "Allow")])
    var c = play([request])
    XCTAssertEqual(c.state, .blocked)
    let answered = reduceConversation(c, .permissionAnswered(id: "r1", optionId: "allow-once"))
    XCTAssertEqual(answered.state, .working)
    XCTAssertEqual(card(answered.items[0])?.state, .answered(optionId: "allow-once"))
    c = play([.stateChange(.working)], from: c)
    XCTAssertEqual(card(c.items[0])?.state, .answeredElsewhere)
    c = play([.stateChange(.blocked)], from: c)
    XCTAssertEqual(card(c.items[0])?.state, .pending)
  }

  func testAnAnswerCarriesTheQuestionsAnswersAndKeepsBlockedWhileAnotherWaits() {
    var c = play([permissionEvent("a"), permissionEvent("b")])
    c = reduceConversation(c, .permissionAnswered(id: "a", optionId: "answer", answers: ["q": "yes"]))
    XCTAssertEqual(card(c.items[0])?.answers, ["q": "yes"])
    XCTAssertEqual(c.state, .blocked)
    XCTAssertEqual(c.openRequests.map(\.id), ["b"])
  }

  func testAFatalErrorEndsTheConversationAndIsKeptForTheErrorState() {
    let c = play([.error(message: "account limit reached", fatal: true)])
    XCTAssertEqual(c.state, .ended)
    XCTAssertEqual(c.fatal, "account limit reached")
    let soft = play([.error(message: "retrying", fatal: false)])
    XCTAssertEqual(soft.state, .idle)
    XCTAssertNil(soft.fatal)
    guard case .error(let item) = soft.items[0] else { return XCTFail() }
    XCTAssertFalse(item.fatal)
  }

  func testSyncRebuildsAndPrependPutsThePastInFrontTheKeysStable() {
    let page = [
      HistoryItem(event: .userMessage(UserMessage(text: "second")), at: 2),
      HistoryItem(event: .assistantText(delta: "two", final: true, parent: nil), at: 2),
    ]
    let synced = reduceConversation(.empty, .sync(page))
    XCTAssertEqual(kinds(synced.items), ["user", "assistant"])
    XCTAssertEqual(synced.first, 0)
    let keys = synced.items.map(\.id)
    let older = [
      HistoryItem(event: .userMessage(UserMessage(text: "first")), at: 1),
      HistoryItem(event: .toolCall(id: "t", name: "Read", input: json([:]), parent: nil), at: 1),
      HistoryItem(event: .toolResult(id: "t", output: .string("x"), error: nil, parent: nil), at: 1),
    ]
    let whole = reduceConversation(synced, .prepend(older))
    XCTAssertEqual(kinds(whole.items), ["user", "tool", "user", "assistant"])
    XCTAssertEqual(whole.first, -2)
    XCTAssertEqual(whole.items.map(\.id), [-2, -1] + keys)
    XCTAssertEqual(reduceConversation(whole, .prepend([])), whole)
  }

  func testAnInterruptedTurnMutesTheMessageAndClosesTheOpenAnswer() {
    let c = play([
      .userMessage(UserMessage(text: "go")),
      .assistantText(delta: "half", final: false, parent: nil),
      .turnInterrupted,
    ])
    guard case .user(let message) = c.items[0], case .assistant(let answer) = c.items[1] else { return XCTFail() }
    XCTAssertTrue(message.interrupted)
    XCTAssertTrue(answer.final)
  }

  func testSessionMetaEffortAndPermissionModeLandOnTheConversationProviderEventsNowhere() {
    let c = play([
      .sessionMeta(model: "echo-1", providerSessionId: nil),
      .effort("low"),
      .permissionMode(mode: "default", modes: [PermissionOption(id: "default", label: "Default")]),
      .providerEvent(provider: "codex", payload: json([:])),
      .contextUsage(used: 1, window: 2, parent: nil),
      .contextUsage(used: 9, window: 9, parent: "sub"),
      .subagentModel(parent: "sub", model: "small"),
    ])
    XCTAssertEqual(c.model, "echo-1")
    XCTAssertEqual(c.effort, "low")
    XCTAssertEqual(c.permissionMode?.mode, "default")
    XCTAssertEqual(c.contextUsage, ContextUsage(used: 1, window: 2))
    XCTAssertEqual(c.subagentModels, ["sub": "small"])
    XCTAssertTrue(c.items.isEmpty)
  }

  func testExitEndsTheConversationWithItsCode() {
    let c = reduceConversation(.empty, .exit(1))
    XCTAssertEqual(c.state, .ended)
    XCTAssertEqual(c.exitCode, 1)
  }

  func testAUserTurnKeepsItsIdAttachmentsAndTime() {
    let file = Attachment.file(FileAttachment(id: "f", label: "Image #1", path: "/p", name: "p.png", mimeType: "image/png", size: 3, delivery: .image))
    let c = reduceConversation(.empty, .event(.userMessage(UserMessage(clientMessageId: "m-12345678", text: "look", attachments: [file])), at: 42))
    guard case .user(let turn) = c.items[0] else { return XCTFail() }
    XCTAssertEqual(turn.clientMessageId, "m-12345678")
    XCTAssertEqual(turn.attachments, [file])
    XCTAssertEqual(turn.at, 42)
  }

  func testAWithdrawnMessageIsUndoneWhenAnAnswerArrives() {
    var c = play([.userMessage(UserMessage(text: "oops"))])
    c = reduceConversation(c, .withdraw)
    guard case .user(let taken) = c.items[0] else { return XCTFail() }
    XCTAssertTrue(taken.withdrawn)
    c = play([.assistantText(delta: "on it", final: false, parent: nil)], from: c)
    guard case .user(let back) = c.items[0] else { return XCTFail() }
    XCTAssertFalse(back.withdrawn)
    XCTAssertEqual(reduceConversation(c, .withdraw), c)
  }

  func testASidePanelCallIsADocumentCardPairedWithItsResult() {
    let c = play([
      .toolResult(id: "d", output: .string("opened"), error: nil, parent: nil),
      .toolCall(id: "d", name: "mcp__clave__clave_open_side_panel", input: json(["path": .string("/w/plan.md")]), parent: nil),
      .toolCall(id: "t", name: "Read", input: json([:]), parent: nil),
    ])
    XCTAssertEqual(kinds(c.items), ["document", "tool"])
    XCTAssertEqual(c.items[0].toolCall?.output, .string("opened"))
    XCTAssertEqual(c.items[0].toolCall?.complete, true)
  }
}
