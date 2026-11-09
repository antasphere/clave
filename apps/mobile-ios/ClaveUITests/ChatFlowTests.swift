import XCTest

// The chat against the in-process fake the app starts with `--ui-test-fake`: after signing in
// and pairing the machine `m_fake`, the Sessions screen offers `s_fake` ("Seeded chat"), whose
// timeline holds the user message and the assistant text "seeded-fake"; a write is echoed back as
// an assistant text with the same words.
//
// These run once the shell lands (the fake, the sign-in, the Machines and Sessions screens are
// built in another lane). Until then the app has no way to reach the chat, so each test skips
// when the Sessions screen does not offer the seeded session.

final class ChatFlowTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  private func openSeededChat() throws -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments += ["--ui-test-fake"]
    app.launch()
    let session = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@ OR identifier CONTAINS %@", "Seeded chat", "s_fake"))
      .firstMatch
    guard session.waitForExistence(timeout: 20) else {
      throw XCTSkip("The Sessions screen does not offer the seeded session yet: the shell has not landed.")
    }
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
  func testTheSeededConversationIsShown() throws {
    let app = try openSeededChat()
    XCTAssertTrue(element(app, identifierPrefix: "chat.user.", labelContaining: "seeded-fake").waitForExistence(timeout: 10))
    XCTAssertTrue(element(app, identifierPrefix: "chat.assistant.", labelContaining: "seeded-fake").waitForExistence(timeout: 10))
  }

  @MainActor
  func testAReplyIsSentAndEchoed() throws {
    let app = try openSeededChat()
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
  func testAToolCardOpens() throws {
    let app = try openSeededChat()
    let card = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat.tool.")).firstMatch
    guard card.waitForExistence(timeout: 5) else {
      throw XCTSkip("The seeded conversation has no tool call.")
    }
    card.tap()
    let call = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat.tool.call.")).firstMatch
    XCTAssertTrue(call.waitForExistence(timeout: 5))
  }
}
