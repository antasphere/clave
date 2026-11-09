import XCTest

// The chat against the in-process fake the app starts with `--ui-test-fake`: after signing in
// and pairing the machine `m_fake`, the Sessions screen of the workspace `scratch` offers `s_fake`
// ("Seeded chat"), whose timeline holds the user message and the assistant text "seeded-fake" and
// one completed tool call; a write is echoed back as an assistant text with the same words.

final class ChatFlowTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  private func openSeededChat() -> XCUIApplication {
    let app = signInAndPair()
    app.buttons["workspaces.row.scratch"].tap()
    let session = app.buttons["sessions.row.s_fake"]
    XCTAssertTrue(session.waitForExistence(timeout: 10))
    session.tap()
    XCTAssertTrue(app.textViews["chat.composer.field"].waitForExistence(timeout: 10)
      || app.textFields["chat.composer.field"].waitForExistence(timeout: 1))
    return app
  }

  @MainActor
  private func element(_ app: XCUIApplication, identifierPrefix prefix: String, labelContaining text: String) -> XCUIElement {
    app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", prefix, text))
      .firstMatch
  }

  @MainActor
  private func composerField(_ app: XCUIApplication) -> XCUIElement {
    let view = app.textViews["chat.composer.field"]
    return view.exists ? view : app.textFields["chat.composer.field"]
  }

  @MainActor
  func testTheSeededConversationIsShown() {
    let app = openSeededChat()
    XCTAssertTrue(element(app, identifierPrefix: "chat.user.", labelContaining: "seeded-fake").waitForExistence(timeout: 10))
    XCTAssertTrue(element(app, identifierPrefix: "chat.assistant.", labelContaining: "seeded-fake").waitForExistence(timeout: 10))
  }

  @MainActor
  func testAReplyIsSentAndEchoed() {
    let app = openSeededChat()
    let reply = "ui-reply-\(Int(Date().timeIntervalSince1970))"
    let field = composerField(app)
    field.tap()
    field.typeText(reply)
    let send = app.buttons["chat.composer.send"]
    XCTAssertTrue(send.waitForExistence(timeout: 5))
    XCTAssertTrue(send.isEnabled)
    send.tap()
    XCTAssertTrue(element(app, identifierPrefix: "chat.assistant.", labelContaining: reply).waitForExistence(timeout: 15))
    // The draft is cleared once the server accepted the message.
    XCTAssertFalse(app.buttons["chat.composer.send"].isEnabled)
  }

  @MainActor
  func testAToolCardOpens() {
    let app = openSeededChat()
    // The fake seeds one completed read, `t_fake`: its run is the card `chat.tool.t_fake`.
    let card = app.buttons["chat.tool.t_fake"]
    XCTAssertTrue(card.waitForExistence(timeout: 10))
    XCTAssertTrue(card.label.contains("README.md"), card.label)
    card.tap()
    XCTAssertTrue(element(app, "chat.tool.call.t_fake").waitForExistence(timeout: 5))
  }
}
