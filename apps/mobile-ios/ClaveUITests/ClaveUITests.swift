import XCTest

final class ClaveUITests: XCTestCase {
  @MainActor
  func testLaunches() {
    let app = XCUIApplication()
    app.launch()
    XCTAssertTrue(app.staticTexts["app.placeholder"].waitForExistence(timeout: 10))
  }
}
