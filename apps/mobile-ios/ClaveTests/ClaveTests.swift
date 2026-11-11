import XCTest
@testable import Clave

final class ClaveTests: XCTestCase {
  func testHostLoads() {
    XCTAssertNotNil(Bundle.main.bundleIdentifier)
  }
}
