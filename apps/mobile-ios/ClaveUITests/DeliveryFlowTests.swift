import XCTest

/// The delivery bar through the Composer, against the in-process fake's delivery behaviours
/// (`ack-lost:` and `unknown:`, in Clave/Testing/UITestFake.swift): while a send's outcome is
/// unknown no second message leaves, and the reconnection settles the first under its own id.
final class DeliveryFlowTests: XCTestCase {
  /// What the fake's timeline carries once it accepts a socket again after an `unknown:` drop.
  private let backLine = "The fake machine is back."

  override func setUp() {
    continueAfterFailure = false
  }

  /// The person's turns whose text contains `text`; one element per turn.
  @MainActor
  private func userTurns(_ app: XCUIApplication, containing text: String) -> XCUIElementQuery {
    app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH 'chat.user.' AND label CONTAINS %@", text))
  }

  @MainActor
  private func machineIsBack(_ app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", backLine)).firstMatch
  }

  @MainActor
  private func fieldText(_ app: XCUIApplication) -> String {
    chatComposerField(app).value as? String ?? ""
  }

  /// Signs in, pairs, opens the seeded chat, types `text` and taps the Send arrow.
  @MainActor
  private func openChatAndSend(_ text: String) -> XCUIApplication {
    let app = signInAndPair()
    openSeededChat(app)
    let field = chatComposerField(app)
    XCTAssertTrue(field.waitForExistence(timeout: 10), "no composer field")
    field.tap()
    field.typeText(text)
    let send = app.buttons["chat.composer.send"]
    XCTAssertTrue(send.isEnabled, "the Send arrow is off with a draft typed")
    send.tap()
    return app
  }

  @MainActor
  private func waitUntilGone(_ target: XCUIElement, timeout: TimeInterval, _ message: String) {
    let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: target)
    XCTAssertEqual(XCTWaiter().wait(for: [gone], timeout: timeout), .completed, message)
  }

  /// The reconnection after the fake's drop: its line in the fresh snapshot, then time for the
  /// pass that runs right after that snapshot.
  @MainActor
  private func waitPastTheReconnection(_ app: XCUIApplication) {
    XCTAssertTrue(machineIsBack(app).waitForExistence(timeout: 45), "the machine never came back")
    Thread.sleep(forTimeInterval: 4)
  }

  private func stamp() -> Int { Int(Date().timeIntervalSince1970) }

  // MARK: U1

  /// `ack-lost:`: the machine kept the message and the answer was lost; the status read says
  /// accepted. One turn, no bar, the field emptied.
  @MainActor
  func testAKeptMessageWhoseAnswerWasLostShowsOnceWithNoBar() {
    let text = "ack-lost: \(stamp())"
    let app = openChatAndSend(text)
    XCTAssertTrue(userTurns(app, containing: text).firstMatch.waitForExistence(timeout: 15), "the message is not shown")
    let off = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isEnabled == false"), object: app.buttons["chat.composer.send"])
    XCTAssertEqual(XCTWaiter().wait(for: [off], timeout: 10), .completed, "the draft was not cleared")
    let value = fieldText(app)
    XCTAssertTrue(value.isEmpty || value == "Message", "the field still holds \(value)")
    XCTAssertFalse(element(app, "chat.delivery.reason").exists, "a delivery bar shows")
    XCTAssertEqual(userTurns(app, containing: text).count, 1, "not exactly one turn")
  }

  // MARK: U2

  /// `unknown:`: the bar shows, the Send arrow is off, the field keeps the text and a tap on the
  /// arrow changes nothing; after the reconnection the message is there once and the bar gone.
  @MainActor
  func testWhileTheOutcomeIsUnknownTheArrowIsOffAndTheReconnectionDeliversOnce() {
    let text = "unknown: \(stamp())"
    let app = openChatAndSend(text)
    let bar = element(app, "chat.delivery.reason")
    XCTAssertTrue(bar.waitForExistence(timeout: 10), "no delivery bar")
    let send = app.buttons["chat.composer.send"]
    XCTAssertFalse(send.isEnabled, "the Send arrow is on while the bar shows")
    XCTAssertEqual(fieldText(app), text)
    send.tap()
    XCTAssertEqual(userTurns(app, containing: text).count, 0, "the tap sent something")
    XCTAssertTrue(bar.exists, "the tap took the bar away")
    XCTAssertEqual(fieldText(app), text, "the tap changed the field")
    XCTAssertTrue(machineIsBack(app).waitForExistence(timeout: 45), "the machine never came back")
    XCTAssertTrue(userTurns(app, containing: text).firstMatch.waitForExistence(timeout: 15), "the reconnection did not deliver it")
    waitUntilGone(bar, timeout: 10, "the bar is still there")
    Thread.sleep(forTimeInterval: 3)
    XCTAssertEqual(userTurns(app, containing: text).count, 1, "delivered more than once")
  }

  // MARK: U3

  /// `unknown:`, then Discard before the reconnection: the message never arrives.
  @MainActor
  func testDiscardBeforeTheReconnectionAndTheMessageNeverArrives() {
    let text = "unknown: \(stamp())"
    let app = openChatAndSend(text)
    let bar = element(app, "chat.delivery.reason")
    XCTAssertTrue(bar.waitForExistence(timeout: 10), "no delivery bar")
    app.buttons["chat.delivery.discard"].tap()
    waitUntilGone(bar, timeout: 5, "Discard left the bar")
    XCTAssertEqual(fieldText(app), text, "the draft stays to edit")
    XCTAssertTrue(app.buttons["chat.composer.send"].isEnabled, "the Send arrow is not back")
    waitPastTheReconnection(app)
    XCTAssertEqual(userTurns(app, containing: text).count, 0, "the discarded message arrived")
  }

  // MARK: U4

  /// `unknown:`, then "Send again" before the reconnection: one message, under the new id; the
  /// old id is never written (it would be a second turn).
  @MainActor
  func testSendAgainBeforeTheReconnectionDeliversOneMessage() {
    let text = "unknown: \(stamp())"
    let app = openChatAndSend(text)
    let bar = element(app, "chat.delivery.reason")
    XCTAssertTrue(bar.waitForExistence(timeout: 10), "no delivery bar")
    app.buttons["chat.delivery.resend"].tap()
    waitUntilGone(bar, timeout: 10, "Send again left the bar")
    waitPastTheReconnection(app)
    XCTAssertEqual(userTurns(app, containing: text).count, 1, "not exactly one message")
  }
}
