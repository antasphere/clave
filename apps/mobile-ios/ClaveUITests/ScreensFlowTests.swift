import XCTest

/// The screens over a paired machine, against the in-process fake (`--ui-test-fake`): the
/// workspaces, a workspace's sessions, the requests, and the launch of a new session.
final class ScreensFlowTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testTheMachineReadsConnectedOnWorkspaces() {
    let app = signInAndPair()
    let state = element(app, "machine.state")
    XCTAssertTrue(state.waitForExistence(timeout: 5))
    expectation(for: NSPredicate(format: "label == 'Connected'"), evaluatedWith: state)
    waitForExpectations(timeout: 10)
  }

  @MainActor
  func testAWorkspaceListsItsSessions() {
    let app = signInAndPair()
    app.buttons["workspaces.row.scratch"].tap()
    let row = app.buttons["sessions.row.s_fake"]
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    XCTAssertEqual(row.label, "Seeded chat")
    let state = element(app, "sessions.state.s_fake")
    XCTAssertTrue(state.exists)
    XCTAssertEqual(state.label, "Idle")
  }

  @MainActor
  func testAQuestionIsAnsweredFromRequests() {
    let app = signInAndPair()
    let badge = element(app, "workspaces.requests.badge")
    XCTAssertTrue(badge.waitForExistence(timeout: 10))
    XCTAssertEqual(badge.label, "1")
    let inbox = app.buttons["workspaces.requests"]
    XCTAssertEqual(inbox.label, "Requests, 1 pending")
    inbox.tap()

    XCTAssertTrue(app.staticTexts["Echo has a question."].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Which file should Echo read?"].exists)
    let option = app.buttons["chat.permission.r_fake.question.0.option.0"]
    XCTAssertTrue(option.exists)
    XCTAssertEqual(option.label, "Option 1 of 1")
    XCTAssertEqual(option.value as? String, "README.md")
    option.tap()
    expectation(for: NSPredicate(format: "isSelected == true"), evaluatedWith: option)
    waitForExpectations(timeout: 5)

    app.buttons["requests.answer.r_fake"].tap()
    XCTAssertTrue(element(app, "requests.empty").waitForExistence(timeout: 10))
    XCTAssertFalse(app.staticTexts["Echo has a question."].exists)
  }

  @MainActor
  func testANewSessionOffersTheSavedProfiles() {
    let app = signInAndPair()
    app.buttons["workspaces.row.scratch"].tap()
    let new = app.buttons["sessions.new"]
    XCTAssertTrue(new.waitForExistence(timeout: 10))
    XCTAssertEqual(new.label, "New session")
    new.tap()
    // The fake keeps no saved profile.
    let empty = element(app, "launch.empty")
    XCTAssertTrue(empty.waitForExistence(timeout: 10))
    XCTAssertTrue(empty.label.contains("No saved profile"), empty.label)
    XCTAssertTrue(app.staticTexts["Start a session"].exists)
  }
}
